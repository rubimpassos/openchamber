import crypto from 'node:crypto';
import fsPromises from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { hasErrorMessage, isMissingFile } from './inputs.js';
import type { JsonValue } from './contracts.js';

const FILE_NAME = 'notification-center.json';
const VERSION = 1;
export const NOTIFICATION_CENTER_LIMIT = 200;
export const NOTIFICATION_CENTER_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const SAVE_DELAY_MS = 1_000;
const TITLE_MAX = 200;
const BODY_MAX = 500;

const V1_NOTIFICATION_KINDS = ['ready', 'error', 'question', 'permission', 'goal', 'browser-help', 'plugin'] as const;
const NOTIFICATION_KINDS = [
  ...V1_NOTIFICATION_KINDS,
  'restart', 'fix-loop', 'restack', 'update', 'opencode-update', 'scheduled-task', 'bot',
] as const;
const NOTIFICATION_PRIORITIES = ['high', 'normal', 'low'] as const;
const NOTIFICATION_DELIVERIES = ['delivered', 'focused', 'quiet'] as const;
const TURN_VERDICTS = ['review', 'stopped-midway', 'looks-done', 'trivial'] as const;

const optionalText = z.string().trim().min(1).nullable().catch(null);

const actionSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('sessions'),
    sessions: z.array(z.object({
      sessionId: z.string().min(1),
      directory: optionalText,
      title: optionalText,
    })).min(1).max(50),
  }),
  z.object({ type: z.literal('openchamber-update'), version: optionalText }),
  z.object({ type: z.literal('opencode-update'), version: optionalText }),
  z.object({ type: z.literal('scheduled-tasks'), projectId: z.string().min(1) }),
  z.object({ type: z.literal('bots'), projectId: z.string().min(1), itemId: z.string().min(1) }),
]);

const entrySchema = z.object({
  id: z.string().min(1),
  createdAt: z.number().finite(),
  kind: z.enum(NOTIFICATION_KINDS),
  priority: z.enum(NOTIFICATION_PRIORITIES),
  delivery: z.enum(NOTIFICATION_DELIVERIES),
  verdict: z.enum(TURN_VERDICTS).nullable().catch(null),
  title: z.string(),
  body: z.string(),
  sessionId: optionalText,
  directory: optionalText,
  sessionName: optionalText,
  requestId: optionalText,
  action: actionSchema.nullable().catch(null),
  readAt: z.number().finite().nullable().catch(null),
  resolvedAt: z.number().finite().nullable().catch(null),
  botState: z.enum(['needs-you', 'waiting-answer']).optional(),
});

export type NotificationCenterEntry = z.infer<typeof entrySchema>;
export type NotificationCenterRecord = Pick<NotificationCenterEntry, 'kind' | 'priority' | 'delivery'> & {
  readonly title?: JsonValue | undefined;
  readonly body?: JsonValue | undefined;
  readonly verdict?: NotificationCenterEntry['verdict'] | undefined;
  readonly sessionId?: string | null | undefined;
  readonly directory?: string | null | undefined;
  readonly sessionName?: string | null | undefined;
  readonly requestId?: string | null;
  readonly action?: NotificationCenterEntry['action'];
};
type CenterChange =
  | { change: 'added'; entry: NotificationCenterEntry }
  | { change: 'read'; ids: string[]; readAt: number }
  | { change: 'resolved'; ids: string[]; resolvedAt: number }
  | { change: 'removed'; ids: string[] }
  | { change: 'cleared' };
interface CenterPersistence {
  load: () => Promise<NotificationCenterEntry[]>;
  save: (entries: readonly NotificationCenterEntry[]) => Promise<void>;
}
interface CenterRuntimeOptions {
  persistence: CenterPersistence;
  broadcast?: (event: { type: 'openchamber:notification-center.changed'; properties: CenterChange }) => void;
  now?: () => number;
  createId?: () => string;
  saveDelayMs?: number;
}
interface BotIdentity {
  readonly projectId: string;
  readonly itemId: string;
}
interface BotAttention extends BotIdentity {
  readonly title: string;
  readonly body: string;
  readonly botState?: NotificationCenterEntry['botState'];
  readonly sessionId?: string | null;
  readonly directory?: string | null;
}
interface CenterStorageOptions {
  dataDir: string;
  fs?: Pick<typeof fsPromises, 'readFile' | 'writeFile' | 'rename'>;
}
const RESOLVED_ON_READ = new Set<NotificationCenterEntry['kind']>(['ready']);
const isPendingBot = (entry: NotificationCenterEntry) => entry.kind === 'bot' && entry.resolvedAt === null;

const fileSchema = z.object({ version: z.literal(VERSION), entries: z.array(z.unknown()) });

const clip = (value: JsonValue | undefined, max: number) => {
  const text = String(value ?? '').trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
};

const textOrNull = (value: JsonValue | undefined) => {
  const text = String(value ?? '').trim();
  return text.length > 0 ? text : null;
};

export function createNotificationCenterPersistence({ dataDir, fs = fsPromises }: CenterStorageOptions): CenterPersistence {
  const filePath = path.join(dataDir, FILE_NAME);
  return {
    async load() {
      let raw;
      try {
        raw = await fs.readFile(filePath, 'utf8');
      } catch (error) {
        if (isMissingFile(error)) return [];
        throw error;
      }
      const file = fileSchema.safeParse(JSON.parse(raw));
      if (!file.success) throw new Error('Invalid notification center snapshot');
      return file.data.entries.flatMap((candidate) => {
        const entry = entrySchema.safeParse(candidate);
        return entry.success ? [entry.data] : [];
      });
    },
    async save(entries: readonly NotificationCenterEntry[]) {
      const tmpPath = `${filePath}.${process.pid}.tmp`;
      await fs.writeFile(tmpPath, JSON.stringify({ version: VERSION, entries }), { encoding: 'utf8', mode: 0o600 });
      await fs.rename(tmpPath, filePath);
    },
  };
}

export function createNotificationCenterRuntime({
  persistence,
  broadcast = () => {},
  now = Date.now,
  createId = () => crypto.randomUUID(),
  saveDelayMs = SAVE_DELAY_MS,
}: CenterRuntimeOptions) {
  let entries: NotificationCenterEntry[] = [];
  let saveTimer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;
  let loadError: Error | null = null;
  let writes = Promise.resolve();
  let botChanges: Promise<unknown> = Promise.resolve();
  const serializeBot = <T>(change: () => Promise<T>) => {
    const result = botChanges.catch(() => {}).then(change);
    botChanges = result;
    return result;
  };

  const prune = (list: NotificationCenterEntry[]) => {
    const cutoff = now() - NOTIFICATION_CENTER_TTL_MS;
    const history = list.filter((entry) => !isPendingBot(entry) && entry.createdAt >= cutoff);
    const kept = new Set(history.slice(-NOTIFICATION_CENTER_LIMIT));
    return list.filter((entry) => isPendingBot(entry) || kept.has(entry));
  };

  const loaded = (async () => {
    try {
      entries = prune((await persistence.load())
        .map((entry) => (entry.resolvedAt === null && entry.readAt !== null && RESOLVED_ON_READ.has(entry.kind)
          ? { ...entry, resolvedAt: entry.readAt }
          : entry))
        .sort((a, b) => a.createdAt - b.createdAt));
    } catch (error) {
      loadError = error instanceof Error ? error : new Error('Could not load notification center', { cause: error });
      console.warn('[notification-center] could not read saved notifications:', hasErrorMessage(error) ? error.message ?? error : error);
      entries = [];
    }
  })();

  const persist = () => {
    if (loadError) return Promise.reject(loadError);
    const snapshot = entries;
    const write = writes.catch(() => {}).then(() => persistence.save(snapshot));
    writes = write;
    return write;
  };

  const save = async () => {
    saveTimer = null;
    try {
      await persist();
    } catch (error) {
      console.warn('[notification-center] could not save notifications:', hasErrorMessage(error) ? error.message ?? error : error);
    }
  };

  const scheduleSave = () => {
    if (stopped || saveTimer) return;
    saveTimer = setTimeout(() => { void save(); }, saveDelayMs);
    saveTimer.unref?.();
  };

  const emit = (properties: CenterChange) => broadcast({ type: 'openchamber:notification-center.changed', properties });

  const list = async ({ allKinds = false } = {}) => {
    await loaded;
    const visible = allKinds
      ? entries
      : entries.filter((entry) => V1_NOTIFICATION_KINDS.some((kind) => kind === entry.kind) && entry.resolvedAt === null);
    return visible.slice().reverse();
  };

  const record = async ({
    kind, priority, delivery, verdict = null, title, body, sessionId, directory, sessionName, requestId = null, action = null,
  }: NotificationCenterRecord) => {
    await loaded;
    const entry = {
      id: createId(),
      createdAt: now(),
      kind,
      priority,
      delivery,
      verdict: verdict ?? null,
      title: clip(title, TITLE_MAX),
      body: clip(body, BODY_MAX),
      sessionId: textOrNull(sessionId),
      directory: textOrNull(directory),
      sessionName: textOrNull(sessionName),
      requestId: textOrNull(requestId),
      action,
      readAt: null,
      resolvedAt: null,
    };
    const parsed = entrySchema.parse(entry);
    entries = prune([...entries, parsed]);
    scheduleSave();
    emit({ change: 'added', entry: parsed });
    return parsed;
  };

  const markRead = async ({ ids = null, sessionId = null, all = false }: { ids?: readonly string[] | null; sessionId?: string | null; all?: boolean }) => {
    await loaded;
    const wanted = ids ? new Set(ids) : null;
    const readAt = now();
    const changed: string[] = [];
    const resolved: string[] = [];
    entries = entries.map((entry) => {
      if (entry.readAt !== null) return entry;
      const matches = all || (wanted ? wanted.has(entry.id) : entry.sessionId === sessionId);
      if (!matches) return entry;
      changed.push(entry.id);
      if (!RESOLVED_ON_READ.has(entry.kind) || entry.resolvedAt !== null) return { ...entry, readAt };
      resolved.push(entry.id);
      return { ...entry, readAt, resolvedAt: readAt };
    });
    if (changed.length > 0) {
      scheduleSave();
      emit({ change: 'read', ids: changed, readAt });
      if (resolved.length > 0) emit({ change: 'resolved', ids: resolved, resolvedAt: readAt });
    }
    return { ids: changed, readAt };
  };

  const resolve = async ({ sessionId, kinds, requestId = null }: { sessionId: string; kinds: readonly NotificationCenterEntry['kind'][]; requestId?: string | null }) => {
    await loaded;
    if (!sessionId) return [];
    const wantedKinds = new Set(kinds);
    const at = now();
    const read: string[] = [];
    const resolved: string[] = [];
    entries = entries.map((entry) => {
      if (entry.resolvedAt !== null || entry.sessionId !== sessionId || !wantedKinds.has(entry.kind)) return entry;
      if (requestId && entry.requestId && entry.requestId !== requestId) return entry;
      resolved.push(entry.id);
      if (entry.readAt === null) read.push(entry.id);
      return { ...entry, readAt: entry.readAt ?? at, resolvedAt: at };
    });
    if (resolved.length > 0) {
      scheduleSave();
      if (read.length > 0) emit({ change: 'read', ids: read, readAt: at });
      emit({ change: 'resolved', ids: resolved, resolvedAt: at });
    }
    return resolved;
  };

  const remove = async (ids: readonly string[]) => {
    await loaded;
    const wanted = new Set(ids);
    const removed = entries.filter((entry) => wanted.has(entry.id) && !isPendingBot(entry)).map((entry) => entry.id);
    if (removed.length === 0) return [];
    entries = entries.filter((entry) => !wanted.has(entry.id) || isPendingBot(entry));
    scheduleSave();
    emit({ change: 'removed', ids: removed });
    return removed;
  };

  const clear = async () => {
    await loaded;
    const removed = entries.filter((entry) => !isPendingBot(entry)).map((entry) => entry.id);
    entries = entries.filter(isPendingBot);
    scheduleSave();
    emit(entries.length ? { change: 'removed', ids: removed } : { change: 'cleared' });
  };

  const recordOnce = async (entry: NotificationCenterRecord) => {
    await loaded;
    if (entry.requestId && entries.some((existing) => existing.kind === entry.kind && existing.requestId === entry.requestId)) {
      return null;
    }
    return record(entry);
  };

  const upsertBot = ({ projectId, itemId, title, body, botState = 'needs-you', sessionId = null, directory = null }: BotAttention) => serializeBot(async () => {
    await loaded;
    if (loadError) throw loadError;
    const action = actionSchema.parse({ type: 'bots', projectId, itemId });
    const existing = entries.find((entry) => isPendingBot(entry) && entry.requestId === itemId && entry.action && 'projectId' in entry.action && entry.action.projectId === projectId);
    const fields = { title: clip(title, TITLE_MAX), body: clip(body, BODY_MAX), botState, sessionId: textOrNull(sessionId), directory: textOrNull(directory) };
    const changed = !existing || (['title', 'body', 'botState', 'sessionId', 'directory'] as const).some((key) => existing[key] !== fields[key]);
    const entry = entrySchema.parse({
      ...existing, ...fields, id: existing?.id ?? createId(), createdAt: existing?.createdAt ?? now(),
      kind: 'bot', priority: 'high', delivery: 'quiet', verdict: null, sessionName: null,
      requestId: itemId, action, readAt: changed ? null : existing?.readAt ?? null, resolvedAt: null,
    });
    if (changed) entries = existing ? entries.map((candidate) => candidate === existing ? entry : candidate) : [...entries, entry];
    try {
      await persist();
    } catch (error) {
      if (changed) entries = entries.flatMap((candidate) => candidate === entry ? existing ? [existing] : [] : [candidate]);
      throw error;
    }
    if (changed) {
      if (existing) emit({ change: 'removed', ids: [existing.id] });
      emit({ change: 'added', entry });
    }
    return { entry, changed };
  });

  const resolveBot = ({ projectId, itemId }: BotIdentity) => serializeBot(async () => {
    await loaded;
    if (loadError) throw loadError;
    actionSchema.parse({ type: 'bots', projectId, itemId });
    const ids: string[] = [];
    const previous: NotificationCenterEntry[] = [];
    const at = now();
    entries = prune(entries.map((entry) => {
      if (!isPendingBot(entry) || entry.requestId !== itemId || !entry.action || !('projectId' in entry.action) || entry.action.projectId !== projectId) return entry;
      ids.push(entry.id);
      previous.push(entry);
      return { ...entry, readAt: entry.readAt ?? at, resolvedAt: at };
    }));
    try {
      await persist();
    } catch (error) {
      entries = [...entries.filter((entry) => !ids.includes(entry.id)), ...previous].sort((a, b) => a.createdAt - b.createdAt);
      throw error;
    }
    if (ids.length) {
      emit({ change: 'read', ids, readAt: at });
      emit({ change: 'resolved', ids, resolvedAt: at });
    }
    return ids;
  });

  const stop = async () => {
    await loaded;
    await botChanges.catch(() => {});
    stopped = true;
    if (saveTimer) {
      clearTimeout(saveTimer);
      await save();
    }
    await writes;
  };

  return { ready: () => loaded, list, record, recordOnce, upsertBot, resolveBot, markRead, resolve, remove, clear, stop };
}

export type NotificationCenterRuntime = ReturnType<typeof createNotificationCenterRuntime>;

export function createAppVersionMarker({ dataDir, fs = fsPromises }: CenterStorageOptions) {
  const filePath = path.join(dataDir, 'notification-center-version.json');
  const versionSchema = z.string().min(1);
  const markerSchema = z.object({ version: versionSchema });
  return {
    async noteVersion(current: string) {
      if (!versionSchema.safeParse(current).success) return null;
      let previous = null;
      try {
        previous = markerSchema.safeParse(JSON.parse(await fs.readFile(filePath, 'utf8'))).data?.version ?? null;
      } catch (error) {
        if (!isMissingFile(error)) {
          console.warn('[notification-center] could not read the last version:', hasErrorMessage(error) ? error.message ?? error : error);
          return null;
        }
      }
      if (previous === current) return null;
      try {
        await fs.writeFile(filePath, JSON.stringify({ version: current }), { encoding: 'utf8', mode: 0o600 });
      } catch (error) {
        console.warn('[notification-center] could not save the version:', hasErrorMessage(error) ? error.message ?? error : error);
        return null;
      }
      return previous;
    },
  };
}
