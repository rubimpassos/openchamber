import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { destinationFingerprint } from './definitions.js';
import { createOAuth } from './oauth.js';
import { openStore, parseOperation } from './store.js';

const cleanups = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
async function setup(options = {}) {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pmcp-persistence-'));
  cleanups.push(() => fs.rm(stateDir, { recursive: true, force: true }));
  const store = await openStore({ stateDir, ...options });
  cleanups.push(store.close);
  const { connection } = await store.apply(parseOperation({ kind: 'create', definition: {
    name: 'fixture', transport: 'http', http: { url: 'https://example.test/mcp', headers: { Authorization: { secret: 'token' } } },
  }, secrets: { token: 'synthetic-private' } }));
  return { store, stateDir, id: connection.id, stateFile: path.join(stateDir, 'state.json') };
}

it('round-trips subjects and credentials without placing secrets in the shared snapshot', async () => {
  // Given synthetic credentials and an explicitly allowed connection.
  const f = await setup();
  await f.store.setSubject('agent', [f.id, f.id]);
  await f.store.close();
  // When a new owner opens the persisted version-1 files.
  const reopened = await openStore({ stateDir: f.stateDir });
  cleanups.push(reopened.close);
  // Then grants and private credentials survive while shared views remain redacted.
  expect(reopened.subjectAllows('agent', f.id)).toBe(true);
  expect(reopened.subjects()).toEqual([{ subject: 'agent', connections: [f.id] }]);
  expect(reopened.credentialsFor(reopened.get(f.id)).secrets.token).toBe('synthetic-private');
  expect(JSON.stringify(reopened.adminViews())).not.toContain('synthetic-private');
  const snapshot = await fs.readFile(f.stateFile, 'utf8');
  expect(snapshot).not.toContain('synthetic-private');
  expect(JSON.parse(snapshot)).toMatchObject({ version: 1, subjects: [{ subject: 'agent', connections: [f.id] }] });
  expect((await fs.stat(f.stateFile)).mode & 0o777).toBe(0o600);
  expect((await fs.stat(path.join(f.stateDir, 'credentials', `${f.id}.json`))).mode & 0o777).toBe(0o600);
});

it.each(['set', 'remove', 'connection-remove'])('preserves authority when %s cannot replace the snapshot', async (action) => {
  // Given a valid grant and a directory occupying the snapshot's filename.
  const onSubjectChange = vi.fn();
  const onChange = vi.fn();
  const f = await setup({ onSubjectChange, onChange });
  await f.store.setSubject('agent', [f.id]);
  onSubjectChange.mockClear();
  onChange.mockClear();
  await fs.rename(f.stateFile, `${f.stateFile}.saved`);
  await fs.mkdir(f.stateFile);
  // When a mutation cannot rename its replacement into place.
  const change = action === 'set' ? f.store.setSubject('agent', [])
    : action === 'remove' ? f.store.removeSubject('agent')
      : f.store.apply({ kind: 'remove', id: f.id, expectedRevision: 1 });
  // Then the previous authority survives and no observer receives a commit.
  await expect(change).rejects.toBeInstanceOf(Error);
  expect(f.store.subjectAllows('agent', f.id)).toBe(true);
  expect(f.store.get(f.id).revision).toBe(1);
  expect(onSubjectChange).not.toHaveBeenCalled();
  expect(onChange).not.toHaveBeenCalled();
});

it('keeps a committed grant when directory durability cannot be confirmed', async () => {
  // Given a synthetic failure at the OS directory flush, after replacement.
  const onSubjectChange = vi.fn();
  const f = await setup({ onSubjectChange });
  const open = fs.open;
  vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
    const handle = await open(...args);
    if (args[0] === f.stateDir && args[1] === 'r') {
      vi.spyOn(handle, 'sync').mockRejectedValueOnce(Object.assign(new Error('synthetic fsync failure'), { code: 'EIO' }));
    }
    return handle;
  });
  // When the snapshot commits and its subsequent flush fails.
  const change = f.store.setSubject('agent', [f.id]);
  // Then both live and persisted authority reflect the commit, with the durability error.
  await expect(change).rejects.toMatchObject({ code: 'state_durability_unverified' });
  expect(f.store.subjectAllows('agent', f.id)).toBe(true);
  expect(onSubjectChange).toHaveBeenCalledWith('agent', [f.id]);
  expect(JSON.parse(await fs.readFile(f.stateFile, 'utf8')).subjects).toEqual([{ subject: 'agent', connections: [f.id] }]);
});

it('serializes a grant removal with its connection deletion in the same snapshot', async () => {
  // Given one connection allowed by two subjects.
  const f = await setup();
  await f.store.setSubject('agent', [f.id]);
  await f.store.setSubject('space-0123456789ab', [f.id]);
  // When the connection is removed.
  await f.store.apply({ kind: 'remove', id: f.id, expectedRevision: 1 });
  // Then the complete snapshot removes it from both grants and definitions.
  expect(JSON.parse(await fs.readFile(f.stateFile, 'utf8'))).toEqual({
    version: 1, connections: [], subjects: [
      { subject: 'agent', connections: [] }, { subject: 'space-0123456789ab', connections: [] },
    ],
  });
});

it('drops a stale OAuth write while retaining the accepted opaque payload', async () => {
  // Given a grant written by the private OAuth owner, including extension data.
  const f = await setup();
  const fingerprint = destinationFingerprint(f.store.get(f.id));
  const oauth = { tokens: { accessToken: 'synthetic-oauth' }, extension: { retained: true } };
  await f.store.updateOAuth(f.id, fingerprint, () => oauth);
  // When a later queued write expects a grant that is no longer current.
  const accepted = await f.store.updateOAuth(f.id, fingerprint, () => null, { expect: (current) => current !== oauth });
  // Then the exact accepted object survives and never reaches an admin view.
  expect(accepted).toBe(false);
  expect(f.store.credentialsFor(f.store.get(f.id)).oauth).toBe(oauth);
  expect(JSON.stringify(f.store.adminViews())).not.toContain('synthetic-oauth');
});

it('round-trips partial OAuth metadata and extension data without replacing the loaded grant', async () => {
  // Given an opaque persisted grant with no refresh metadata.
  const f = await setup();
  const oauth = { tokens: { accessToken: 'synthetic-persisted', expiresAt: null }, extension: { retained: true } };
  await f.store.updateOAuth(f.id, destinationFingerprint(f.store.get(f.id)), () => oauth);
  await f.store.close();
  // When a new owner loads the persisted JSON and requests the fresh grant.
  const reopened = await openStore({ stateDir: f.stateDir });
  cleanups.push(reopened.close);
  const definition = reopened.get(f.id);
  const loaded = reopened.credentialsFor(definition).oauth;
  const tokens = await createOAuth({ store: reopened }).tokensFor(definition);
  // Then extension data survives and the caller receives the loaded token object itself.
  expect(loaded).toEqual(oauth);
  expect(tokens).toBe(loaded.tokens);
  expect(JSON.stringify(reopened.adminViews())).not.toContain('synthetic-persisted');
});

it('processes a valid grant after a refused unknown connection', async () => {
  // Given a refusal queued before a valid update.
  const f = await setup();
  const refused = f.store.setSubject('agent', ['pmcp_ffffffffffffffff']);
  const accepted = f.store.setSubject('agent', [f.id]);
  // When both queued operations settle.
  const results = await Promise.allSettled([refused, accepted]);
  // Then the refusal is isolated and the next operation commits.
  expect(results[0]).toMatchObject({ status: 'rejected', reason: { code: 'unknown_connection' } });
  expect(results[1]).toEqual({ status: 'fulfilled', value: { subject: 'agent', connections: [f.id] } });
});
