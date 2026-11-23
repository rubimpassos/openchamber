import { z } from 'zod';

/**
 * Account choices for the limit failover, stored in
 * `limit-failover/session-accounts.json` under the data directory so a restart
 * keeps them:
 *
 * - per session: the account a session pinned itself to, and whether hitting
 *   its limit may still move the session (preferred) or fails the turn
 *   instead (fixed). Sessions following the global settings have no record.
 * - per provider: the account the global "preferred" mode returns to once its
 *   limit lifts. A provider without one switches without a preference.
 */

const FILE_NAME = 'session-accounts.json';
const MAX_SESSIONS = 500;

const id = z.string().min(1).max(200);
const entrySchema = z.object({
  sessionID: id,
  providerID: id,
  mode: z.enum(['preferred', 'fixed']),
  credentialID: id,
  updatedAt: z.number().finite().nonnegative(),
});
const providerEntrySchema = z.object({
  providerID: id,
  credentialID: id,
  updatedAt: z.number().finite().nonnegative(),
});
const storeSchema = z.object({
  version: z.literal(1),
  sessions: z.array(entrySchema),
  // Files written before the global preferred account existed have no list.
  providers: z.array(providerEntrySchema).default([]),
});

type AccountStore = z.output<typeof storeSchema>;
type SessionAccountInput = Omit<z.input<typeof entrySchema>, 'updatedAt'>;
interface SessionAccountDependencies {
  readonly fsPromises: typeof import('node:fs/promises');
  readonly path: typeof import('node:path');
  readonly dataDir: string | null;
  readonly now?: () => number;
}

export const createSessionAccountStore = ({ fsPromises, path, dataDir, now = Date.now }: SessionAccountDependencies) => {
  const filePath = dataDir ? path.join(dataDir, 'limit-failover', FILE_NAME) : null;

  let loaded: Promise<AccountStore> | null = null;
  let writing: Promise<unknown> = Promise.resolve();
  const serialize = <Result>(task: () => Promise<Result>) => {
    const pending = writing.then(task, task);
    writing = pending.then(() => undefined, () => undefined);
    return pending;
  };

  const readStore = () => serialize(async (): Promise<AccountStore> => {
    if (filePath === null) return { version: 1, sessions: [], providers: [] };
    const raw = await fsPromises.readFile(filePath, 'utf8').catch((error) => {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return null;
      throw error;
    });
    if (raw === null) return { version: 1, sessions: [], providers: [] };
    const parsed = storeSchema.safeParse(JSON.parse(raw));
    // A file that is not a store is a failure, never an empty list: dropping
    // every pin silently would turn pinned sessions into global ones.
    if (!parsed.success) throw new Error('Stored session accounts are malformed');
    return parsed.data;
  });

  const store = () => {
    if (loaded === null) loaded = readStore();
    return loaded;
  };

  const persist = (next: AccountStore) => serialize(async () => {
    if (filePath === null) return;
    await fsPromises.mkdir(path.dirname(filePath), { recursive: true });
    const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
    try {
      await fsPromises.writeFile(tmp, JSON.stringify(next, null, 2), 'utf8');
      await fsPromises.rename(tmp, filePath);
    } catch (error) {
      await fsPromises.unlink(tmp).catch(() => {});
      throw error;
    }
  });

  // Pins and the preferred accounts share one file: each change reads and
  // writes it as one step, so two changes at once cannot drop each other.
  let changing: Promise<unknown> = Promise.resolve();
  const change = <Result>(task: () => Promise<Result>) => {
    const pending = changing.then(task, task);
    changing = pending.then(() => undefined, () => undefined);
    return pending;
  };

  const replace = async (next: AccountStore) => {
    loaded = Promise.resolve(next);
    await persist(next);
  };

  return {
    /** The session's pin, or null when it follows the global settings. */
    get: async (sessionID: string) => {
      const { sessions } = await store();
      return sessions.find((entry) => entry.sessionID === sessionID) ?? null;
    },
    /** Upserts one session's pin; the oldest entries fall off the cap. */
    set: (input: SessionAccountInput) => change(async () => {
      const parsed = entrySchema.safeParse({ ...input, updatedAt: now() });
      if (!parsed.success) throw new Error('Invalid session account');
      const entry = parsed.data;
      const current = await store();
      const kept = current.sessions.filter((existing) => existing.sessionID !== entry.sessionID);
      kept.push(entry);
      kept.sort((a, b) => b.updatedAt - a.updatedAt);
      await replace({ ...current, sessions: kept.slice(0, MAX_SESSIONS) });
      return entry;
    }),
    /** Removes the session's pin; false when there was none. */
    clear: (sessionID: string) => change(async () => {
      const current = await store();
      if (!current.sessions.some((entry) => entry.sessionID === sessionID)) return false;
      await replace({ ...current, sessions: current.sessions.filter((entry) => entry.sessionID !== sessionID) });
      return true;
    }),
    /** The provider's global preferred account, or null. */
    getPreferred: async (providerID: string) => {
      const { providers } = await store();
      return providers.find((entry) => entry.providerID === providerID) ?? null;
    },
    /** Sets the provider's global preferred account; null clears it. */
    setPreferred: (providerID: string, credentialID: string | null) => change(async () => {
      const current = await store();
      const others = current.providers.filter((entry) => entry.providerID !== providerID);
      if (credentialID === null) {
        if (others.length === current.providers.length) return null;
        await replace({ ...current, providers: others });
        return null;
      }
      const parsed = providerEntrySchema.safeParse({ providerID, credentialID, updatedAt: now() });
      if (!parsed.success) throw new Error('Invalid provider account');
      await replace({ ...current, providers: [...others, parsed.data] });
      return parsed.data;
    }),
  };
};
