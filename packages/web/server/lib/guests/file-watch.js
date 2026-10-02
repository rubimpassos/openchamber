import crypto from 'node:crypto';
import defaultFs from 'node:fs';
import defaultPath from 'node:path';

/** Paths one watch may name; a guest watches its state files, not a tree. */
export const GUEST_FILE_WATCH_PATHS_MAX = 16;
/** A watch nobody renews is dropped after this long (the client renews at half). */
export const GUEST_FILE_WATCH_LEASE_MS = 60_000;
/** Watches one guest may hold at once (one per open frame, with headroom). */
const WATCHES_PER_GUEST_MAX = 16;
const DEBOUNCE_MS = 120;

/**
 * Project-relative paths a guest may watch: inside the project, no `..`
 * escapes, no absolute or home paths (those need the `filesystem` grant and
 * are not watchable).
 */
export const resolveWatchPaths = (projectDirectory, paths, nodePath = defaultPath) => {
  const root = nodePath.resolve(projectDirectory);
  const resolved = [];
  for (const raw of paths) {
    if (typeof raw !== 'string' || !raw || raw.startsWith('/') || raw.startsWith('~') || nodePath.isAbsolute(raw)) return null;
    const absolute = nodePath.resolve(root, raw);
    if (absolute !== root && !absolute.startsWith(root + nodePath.sep)) return null;
    resolved.push({ path: raw, absolute });
  }
  return resolved;
};

/**
 * Watches project files for guest frames and reports changes through `emit`
 * (`{ guestId, watchId, paths }`, `paths` as the guest named them). Each
 * watch holds one `fs.watch` per parent directory; a directory that does not
 * exist yet is tried again on every renew. Changes are debounced, and a watch
 * nobody renews within the lease is closed.
 */
export const createGuestFileWatchRegistry = ({
  emit,
  fs = defaultFs,
  nodePath = defaultPath,
  now = Date.now,
  leaseMs = GUEST_FILE_WATCH_LEASE_MS,
  debounceMs = DEBOUNCE_MS,
}) => {
  const watches = new Map();

  const close = (watchId) => {
    const watch = watches.get(watchId);
    if (!watch) return false;
    for (const watcher of watch.watchers.values()) {
      try { watcher.close(); } catch { /* already closed */ }
    }
    if (watch.timer) clearTimeout(watch.timer);
    watches.delete(watchId);
    return true;
  };

  const flush = (watchId) => {
    const watch = watches.get(watchId);
    if (!watch) return;
    watch.timer = null;
    const paths = [...watch.pending];
    watch.pending.clear();
    if (paths.length > 0) emit({ guestId: watch.guestId, watchId, paths });
  };

  const attach = (watchId) => {
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
          try { watcher.close(); } catch { /* gone */ }
        });
        watch.watchers.set(directory, watcher);
      } catch {
        // Directory missing (not created yet) or unwatchable: retried on renew.
      }
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
    /**
     * Starts a watch, or renews `watchId` when it is still held by this guest
     * (the same files). Returns the watch id, or `null` when the guest holds
     * too many watches.
     */
    watch: ({ guestId, files, watchId }) => {
      sweep();
      const existing = watchId ? watches.get(watchId) : undefined;
      if (existing && existing.guestId === guestId) {
        existing.expiresAt = now() + leaseMs;
        attach(watchId);
        return watchId;
      }
      const held = [...watches.values()].filter((watch) => watch.guestId === guestId).length;
      if (held >= WATCHES_PER_GUEST_MAX) return null;
      const id = `fw_${crypto.randomUUID()}`;
      const byDirectory = new Map();
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
    /** Every watch of a guest (it was paused or removed). */
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
