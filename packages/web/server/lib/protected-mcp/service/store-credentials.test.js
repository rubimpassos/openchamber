import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { destinationFingerprint, parseDefinition } from './definitions.js';
import { openStore, parseOperation } from './store.js';

const cleanups = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const definition = { name: 'remote', transport: 'http', http: { url: 'https://example.test/mcp', headers: { Authorization: { secret: 'token' } } } };
async function setup() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pmcp-store-credentials-'));
  cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
  const store = await openStore({ stateDir: root });
  cleanups.push(store.close);
  await store.apply(parseOperation({ kind: 'create', definition, secrets: { token: 'synthetic-original' } }));
  return { store, id: store.adminViews()[0].id };
}

it.each([{}, { token: 'synthetic-replacement' }])('accepts a policy update after forget with secrets %j', async (secrets) => {
  // Given a connection whose credentials were forgotten.
  const { store, id } = await setup();
  await store.apply({ kind: 'revoke-credentials', id, expectedRevision: 1 });
  // When the destination stays unchanged.
  await store.apply(parseOperation({ kind: 'update', id, expectedRevision: 2, definition: { ...definition, policy: { denyTools: ['delete'] } }, secrets }));
  // Then the revision advances and only a typed value fills the slot.
  expect(store.adminView(id)).toMatchObject({ revision: 3, secrets: { token: { set: Boolean(secrets.token) } }, credential: secrets.token ? 'stored' : 'missing' });
  expect(store.credentialsFor(store.get(id))?.secrets ?? {}).toEqual(secrets);
});

it('still requires a secret when the destination changes after forget', async () => {
  // Given forgotten credentials.
  const { store, id } = await setup();
  await store.apply({ kind: 'revoke-credentials', id, expectedRevision: 1 });
  // When a new destination has no typed secret.
  const change = store.apply(parseOperation({ kind: 'update', id, expectedRevision: 2, definition: { ...definition, http: { ...definition.http, url: 'https://other.test/mcp' } }, secrets: {} }));
  // Then destination binding still refuses it.
  await expect(change).rejects.toMatchObject({ code: 'credential_rebind_required' });
  expect(store.adminView(id).revision).toBe(2);
});

it('still requires every secret on create', async () => {
  // Given an open store.
  const { store } = await setup();
  // When creation omits its secret.
  const create = store.apply({ kind: 'create', definition: parseDefinition({ ...definition, name: 'other' }), secrets: {} });
  // Then it fails before creating the connection.
  await expect(create).rejects.toMatchObject({ code: 'secret_missing' });
});

it('keeps a credential written with the pre-port destination fingerprint after reopening', async () => {
  // Given an existing normalized definition and credential file from the JS service.
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pmcp-existing-credentials-'));
  cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
  const id = 'pmcp_0123456789abcdef';
  await fs.mkdir(path.join(root, 'credentials'), { mode: 0o700 });
  await fs.writeFile(path.join(root, 'state.json'), JSON.stringify({ version: 1, connections: [{ ...definition, id, revision: 1, enabled: true, policy: {} }] }));
  await fs.writeFile(path.join(root, 'credentials', `${id}.json`), JSON.stringify({
    version: 1, fingerprint: 'b9e08c09c573b540cfffc0c73b6c2222b9445fd8e2e2149b2f6bc79117045f82', secrets: { token: 'synthetic-existing' }, oauth: null,
  }));
  // When the typed parsers reopen the stored destination.
  const store = await openStore({ stateDir: root });
  cleanups.push(store.close);
  // Then its credential remains usable and the public view stays redacted.
  expect(store.adminView(id)).toMatchObject({ credential: 'stored', secrets: { token: { set: true } } });
  expect(store.credentialsFor(store.get(id))?.secrets.token).toBe('synthetic-existing');
  expect(JSON.stringify(store.adminView(id))).not.toContain('synthetic-existing');
});

it.each(['remove', 'revoke-credentials'])('captures removed credentials inside the queue for %s', async (kind) => {
  // Given an OAuth write queued immediately before deletion.
  const { store, id } = await setup();
  const previous = store.get(id);
  const oauth = { tokens: { accessToken: 'synthetic-latest' } };
  const writing = store.updateOAuth(id, destinationFingerprint(previous), () => oauth);
  // When deletion follows that write without waiting outside the queue.
  const result = await store.apply({ kind, id, expectedRevision: 1 });
  await writing;
  // Then only the private result carries the exact removed snapshot.
  expect(result?.removedCredentials?.definition === previous).toBe(true);
  expect(result?.removedCredentials?.credentials?.oauth?.tokens === oauth.tokens).toBe(true);
  expect(result?.removedCredentials?.credentials?.secrets?.token === 'synthetic-original').toBe(true);
  expect(store.credentialsFor(previous)).toBeNull();
});
