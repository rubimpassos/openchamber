import crypto from 'node:crypto';
import defaultFs from 'node:fs';
import defaultPath from 'node:path';
import type { FSWatcher } from 'node:fs';
import { z } from 'zod';

type WatchFile = { readonly path: string; readonly absolute: string };
type WatchEvent = { readonly guestId: string; readonly watchId: string; readonly paths: string[] };
type FileWatchOptions = {
  readonly emit: (event: WatchEvent) => void;
  readonly fs?: Pick<typeof defaultFs, 'watch'>;
  readonly nodePath?: typeof defaultPath;
  readonly now?: () => number;
  readonly leaseMs?: number;
  readonly debounceMs?: number;
};
type FileWatch = {
  readonly guestId: string;
  readonly byDirectory: Map<string, WatchFile[]>;
  readonly watchers: Map<string, FSWatcher>;
  readonly pending: Set<string>;
  timer: ReturnType<typeof setTimeout> | null;
  expiresAt: number;
};
type WatchRequest = {
  readonly guestId: string;
  readonly files: readonly WatchFile[];
  readonly watchId?: string | undefined;
};
type UnwatchRequest = { readonly guestId: string; readonly watchId: string };
export type GuestFileWatchRegistry = {
  readonly watch: (request: WatchRequest) => string | null;
  readonly unwatch: (request: UnwatchRequest) => boolean;
  readonly closeGuest: (guestId: string) => void;
  readonly size: () => number;
  readonly stop: () => void;
};

export const GUEST_FILE_WATCH_PATHS_MAX = 16;
export const GUEST_FILE_WATCH_LEASE_MS = 60_000;
const WATCHES_PER_GUEST_MAX = 16;
const DEBOUNCE_MS = 120;
const watchPathsSchema = z.array(z.string().min(1));

export const resolveWatchPaths = (projectDirectory: string, paths: readonly unknown[], nodePath = defaultPath): WatchFile[] | null => {
  const root = nodePath.resolve(projectDirectory);
  const parsed = watchPathsSchema.safeParse(paths);
  if (!parsed.success) return null;
  const resolved: WatchFile[] = [];
  for (const raw of parsed.data) {
    if (raw.startsWith('/') || raw.startsWith('~') || nodePath.isAbsolute(raw)) return null;
    const absolute = nodePath.resolve(root, raw);
    if (absolute !== root && !absolute.startsWith(root + nodePath.sep)) return null;
    resolved.push({ path: raw, absolute });
  }
  return resolved;
};

export const createGuestFileWatchRegistry = ({
  emit,
  fs = defaultFs,
  nodePath = defaultPath,
  now = Date.now,
  leaseMs = GUEST_FILE_WATCH_LEASE_MS,
  debounceMs = DEBOUNCE_MS,
}: FileWatchOptions): GuestFileWatchRegistry => {
  const watches = new Map<string, FileWatch>();

  const close = (watchId: string) => {
    const watch = watches.get(watchId);
    if (!watch) return false;
    for (const watcher of watch.watchers.values()) {
      try { watcher.close(); } catch { continue; }
    }
    if (watch.timer) clearTimeout(watch.timer);
    watches.delete(watchId);
    return true;
  };

  const flush = (watchId: string) => {
    const watch = watches.get(watchId);
    if (!watch) return;
    watch.timer = null;
    const paths = [...watch.pending];
    watch.pending.clear();
    if (paths.length > 0) emit({ guestId: watch.guestId, watchId, paths });
  };

  const attach = (watchId: string) => {
    const watch = watches.get(watchId);
    if (!watch) return;
    for (const [directory, files] of watch.byDirectory) {
      if (watch.watchers.has(directory)) continue;
      try {
        const watcher = fs.watch(directory, { persistent: false }, (_event, filename) => {
          const name = filename ? String(filename) : '';
          const hits = name ? files.filter((file) => nodePath.basename(file.absolute) === name) : files;
          if (hits.length === 0) return;
          for (const file of hits) watch.pending.add(file.path);
          if (!watch.timer) {
            watch.timer = setTimeout(() => flush(watchId), debounceMs);
            watch.timer.unref?.();
          }
        });
        watcher.on?.('error', () => {
          watch.watchers.delete(directory);
          try { watcher.close(); } catch { return; }
        });
        watch.watchers.set(directory, watcher);
      } catch { continue; }
    }
  };

  const sweep = () => {
    const current = now();
    for (const [watchId, watch] of watches) {
      if (watch.expiresAt <= current) close(watchId);
    }
  };
  const sweeper = setInterval(sweep, Math.max(1_000, Math.floor(leaseMs / 2)));
  sweeper.unref?.();

  return {
    watch: ({ guestId, files, watchId }) => {
      sweep();
      const existing = watchId ? watches.get(watchId) : undefined;
      if (watchId && existing && existing.guestId === guestId) {
        existing.expiresAt = now() + leaseMs;
        attach(watchId);
        return watchId;
      }
      const held = [...watches.values()].filter((watch) => watch.guestId === guestId).length;
      if (held >= WATCHES_PER_GUEST_MAX) return null;
      const id = `fw_${crypto.randomUUID()}`;
      const byDirectory = new Map<string, WatchFile[]>();
      for (const file of files) {
        const directory = nodePath.dirname(file.absolute);
        byDirectory.set(directory, [...(byDirectory.get(directory) ?? []), file]);
      }
      watches.set(id, { guestId, byDirectory, watchers: new Map(), pending: new Set(), timer: null, expiresAt: now() + leaseMs });
      attach(id);
      return id;
    },
    unwatch: ({ guestId, watchId }) => {
      const watch = watches.get(watchId);
      if (!watch || watch.guestId !== guestId) return false;
      return close(watchId);
    },
    closeGuest: (guestId) => {
      for (const [watchId, watch] of watches) if (watch.guestId === guestId) close(watchId);
    },
    size: () => watches.size,
    stop: () => {
      clearInterval(sweeper);
      for (const watchId of [...watches.keys()]) close(watchId);
    },
  };
};
