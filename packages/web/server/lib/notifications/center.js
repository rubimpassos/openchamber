/**
 * The notification center: every notification this server raised, kept on
 * this machine so a client can list what it missed and mark it read. See
 * "Notification center" in DOCUMENTATION.md.
 */
import crypto from 'node:crypto';
import fsPromises from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';

const FILE_NAME = 'notification-center.json';
const VERSION = 1;
export const NOTIFICATION_CENTER_LIMIT = 500;
export const NOTIFICATION_CENTER_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const SAVE_DELAY_MS = 1_000;
const TITLE_MAX = 200;
const BODY_MAX = 500;

const NOTIFICATION_KINDS = ['ready', 'error', 'question', 'permission', 'goal', 'browser-help', 'plugin'];
const NOTIFICATION_PRIORITIES = ['high', 'normal', 'low'];
/**
 * What happened to the alert: `delivered` went out on the channels the user
 * has on, `focused` raised none because the app was in front, `quiet` raised
 * none because Jev ranked the finished turn low.
 */
const NOTIFICATION_DELIVERIES = ['delivered', 'focused', 'quiet'];
/** Jev's reading of a finished turn; null when Jev was not asked or did not answer. */
const TURN_VERDICTS = ['review', 'stopped-midway', 'looks-done', 'trivial'];

const optionalText = z.string().trim().min(1).nullable().catch(null);

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
  readAt: z.number().finite().nullable().catch(null),
});

const fileSchema = z.object({ version: z.literal(VERSION), entries: z.array(z.unknown()) });

const clip = (value, max) => {
  const text = String(value ?? '').trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
};

const textOrNull = (value) => {
  const text = String(value ?? '').trim();
  return text.length > 0 ? text : null;
};

/**
 * Entries live in `notification-center.json` in the data directory. A missing
 * file is an empty center; an unreadable or malformed one is logged and also
 * starts empty, since nothing else depends on it. Single entries that do not
 * parse are dropped, the rest load.
 */
export function createNotificationCenterPersistence({ dataDir, fs = fsPromises }) {
  const filePath = path.join(dataDir, FILE_NAME);
  return {
    async load() {
      let raw;
      try {
        raw = await fs.readFile(filePath, 'utf8');
      } catch (error) {
        if (error?.code === 'ENOENT') return [];
        throw error;
      }
      const file = fileSchema.safeParse(JSON.parse(raw));
      if (!file.success) return [];
      return file.data.entries.flatMap((candidate) => {
        const entry = entrySchema.safeParse(candidate);
        return entry.success ? [entry.data] : [];
      });
    },
    async save(entries) {
      // Temp file in the same directory, so the rename is atomic on one device.
      const tmpPath = `${filePath}.${process.pid}.tmp`;
      await fs.writeFile(tmpPath, JSON.stringify({ version: VERSION, entries }), { encoding: 'utf8', mode: 0o600 });
      await fs.rename(tmpPath, filePath);
    },
  };
}

/**
 * Entries are kept oldest first in memory; `list` answers newest first.
 * Every change is broadcast as `openchamber:notification-center.changed`:
 * `{ change: 'added', entry }`, `{ change: 'read', ids, readAt }` or
 * `{ change: 'cleared' }`. A client that reconnects lists again.
 */
export function createNotificationCenterRuntime({
  persistence,
  broadcast = () => {},
  now = Date.now,
  createId = () => crypto.randomUUID(),
  saveDelayMs = SAVE_DELAY_MS,
}) {
  let entries = [];
  let saveTimer = null;
  let stopped = false;

  const prune = (list) => {
    const cutoff = now() - NOTIFICATION_CENTER_TTL_MS;
    const kept = list.filter((entry) => entry.createdAt >= cutoff);
    return kept.length > NOTIFICATION_CENTER_LIMIT ? kept.slice(kept.length - NOTIFICATION_CENTER_LIMIT) : kept;
  };

  const loaded = (async () => {
    try {
      entries = prune((await persistence.load()).sort((a, b) => a.createdAt - b.createdAt));
    } catch (error) {
      console.warn('[notification-center] could not read saved notifications:', error?.message ?? error);
      entries = [];
    }
  })();

  const save = async () => {
    saveTimer = null;
    try {
      await persistence.save(entries);
    } catch (error) {
      console.warn('[notification-center] could not save notifications:', error?.message ?? error);
    }
  };

  const scheduleSave = () => {
    if (stopped || saveTimer) return;
    saveTimer = setTimeout(() => { void save(); }, saveDelayMs);
    saveTimer.unref?.();
  };

  const emit = (properties) => broadcast({ type: 'openchamber:notification-center.changed', properties });

  const list = async () => {
    await loaded;
    return entries.slice().reverse();
  };

  /** Records one notification and answers with the stored entry. */
  const record = async ({ kind, priority, delivery, verdict = null, title, body, sessionId, directory, sessionName }) => {
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
      readAt: null,
    };
    const parsed = entrySchema.parse(entry);
    entries = prune([...entries, parsed]);
    scheduleSave();
    emit({ change: 'added', entry: parsed });
    return parsed;
  };

  /**
   * Marks unread entries read: the listed ids, every entry of one session, or
   * all of them. Answers with the ids that changed; nothing is broadcast when
   * none did.
   */
  const markRead = async ({ ids = null, sessionId = null, all = false }) => {
    await loaded;
    const wanted = ids ? new Set(ids) : null;
    const readAt = now();
    const changed = [];
    entries = entries.map((entry) => {
      if (entry.readAt !== null) return entry;
      const matches = all || (wanted ? wanted.has(entry.id) : entry.sessionId === sessionId);
      if (!matches) return entry;
      changed.push(entry.id);
      return { ...entry, readAt };
    });
    if (changed.length > 0) {
      scheduleSave();
      emit({ change: 'read', ids: changed, readAt });
    }
    return { ids: changed, readAt };
  };

  const clear = async () => {
    await loaded;
    entries = [];
    scheduleSave();
    emit({ change: 'cleared' });
  };

  /** Writes what is pending now; later changes are not saved. */
  const stop = async () => {
    stopped = true;
    if (saveTimer) {
      clearTimeout(saveTimer);
      await save();
    }
  };

  return { ready: () => loaded, list, record, markRead, clear, stop };
}
