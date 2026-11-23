import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';

const revokedSessionsSchema = z.object({
  version: z.literal(1),
  revoked: z.array(z.object({
    digest: z.string().regex(/^[a-f0-9]{64}$/),
    expiresAt: z.number().finite(),
  })),
});

type Revocation = z.infer<typeof revokedSessionsSchema>['revoked'][number];

const digestOf = (token: string) => crypto.createHash('sha256').update(token).digest('hex');
const isMissingFile = (error: unknown): error is NodeJS.ErrnoException =>
  error instanceof Error && 'code' in error && error.code === 'ENOENT';

export const createRevokedSessions = (file: string) => {
  let entries: Revocation[] = [];
  let loadFailed = false;
  try {
    const saved = revokedSessionsSchema.parse(JSON.parse(fs.readFileSync(file, 'utf8')));
    entries = saved.revoked.filter((entry) => entry.expiresAt > Date.now());
  } catch (error) {
    if (!isMissingFile(error)) {
      loadFailed = true;
    }
  }
  let quarantineNeeded = loadFailed;
  const quarantine = () => {
    if (!quarantineNeeded) return;
    quarantineNeeded = false;
    try {
      fs.renameSync(file, `${file}.unreadable-${new Date().toISOString()}`);
    } catch {
      // Quarantine is best effort; clearing remains available if the rename fails.
    }
  };
  let digests = new Set(entries.map((entry) => entry.digest));
  let pending = Promise.resolve();

  const update = (change: (current: Revocation[]) => Revocation[], mergeDisk = true) => {
    const operation = pending.then(async () => {
      let saved: Revocation[] = [];
      if (mergeDisk) {
        try {
          saved = revokedSessionsSchema.parse(JSON.parse(await fs.promises.readFile(file, 'utf8'))).revoked;
        } catch (error) {
          if (!isMissingFile(error)) throw error;
        }
      }
      const live = [...entries, ...saved].filter((entry) => entry.expiresAt > Date.now());
      const current = [...new Map(live.map((entry) => [entry.digest, entry])).values()];
      const next = change(current).filter((entry) => entry.expiresAt > Date.now());
      const temporary = `${file}.${crypto.randomBytes(12).toString('hex')}.tmp`;
      try {
        await fs.promises.mkdir(path.dirname(file), { recursive: true });
        const handle = await fs.promises.open(temporary, 'wx', 0o600);
        try {
          await handle.writeFile(JSON.stringify({ version: 1, revoked: next }));
          await handle.sync();
        } finally {
          await handle.close();
        }
        await fs.promises.rename(temporary, file);
        const directory = await fs.promises.open(path.dirname(file), 'r');
        try {
          await directory.sync();
        } finally {
          await directory.close();
        }
        entries = next;
        digests = new Set(next.map((entry) => entry.digest));
      } finally {
        await fs.promises.rm(temporary, { force: true });
      }
    });
    pending = operation.catch(() => {});
    return operation;
  };

  return {
    loadFailed,
    quarantine,
    has: (token: string) => digests.has(digestOf(token)),
    revoke: (token: string, expiresAt: number) => update((current) => {
      const digest = digestOf(token);
      return current.some((entry) => entry.digest === digest) ? current : [...current, { digest, expiresAt }];
    }),
    clear: () => {
      quarantine();
      return update(() => [], false);
    },
  };
};
