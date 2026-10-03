import { afterEach, beforeEach, expect, test } from 'bun:test';
import fs from 'node:fs/promises';
import path from 'node:path';
import { effectiveGrants } from './grant-scope.js';
import { readExtensionStore, setCapabilityGrants } from './persist.js';

let root;
let persistPath;
beforeEach(async () => {
  root = await fs.mkdtemp('/tmp/opencode/oc-loopback-persist-');
  persistPath = path.join(root, 'extensions.json');
});
afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });

const scope = { loopback: { port: 8123, env: 'OC_TEST_PORT', resolvedPort: 9123, routes: ['GET /state', 'POST /sessions/*'] } };

test('round-trips and normalizes loopback scope when approval is persisted', async () => {
  // Given equivalent duplicate/reordered approval entries.
  await setCapabilityGrants('local-api', persistPath, ['loopback'], {
    loopback: { ...scope.loopback, routes: ['POST /sessions/*', 'GET /state', 'GET /state'] },
  });
  // When reading the on-disk store.
  const store = await readExtensionStore(persistPath);
  // Then approval retains the resolved target and normalized permission set.
  expect(store.capabilityScopes['local-api']).toEqual(scope);
  expect(effectiveGrants(store.capabilityGrants['local-api'], store.capabilityScopes['local-api'], scope)).toEqual(['loopback']);
});

test('keeps old stores readable but ungranted when loopback scope is missing', async () => {
  // Given a store written before scoped approval.
  await fs.writeFile(persistPath, JSON.stringify({ paths: ['/local-api'], capabilityGrants: { 'local-api': ['loopback'] } }));
  // When loading its approval.
  const store = await readExtensionStore(persistPath);
  // Then it remains installed, without an effective grant.
  expect(store.paths).toEqual(['/local-api']);
  expect(effectiveGrants(store.capabilityGrants['local-api'], store.capabilityScopes['local-api'], scope)).toEqual([]);
});

test.each([
  { ...scope.loopback, resolvedPort: 80 },
  { ...scope.loopback, env: 'bad-name' },
  { ...scope.loopback, routes: ['DELETE /state'] },
  { ...scope.loopback, routes: ['GET /../state'] },
  { ...scope.loopback, routes: ['GET /%73tate'] },
])('drops only malformed approval when scope is %j', async (loopback) => {
  // Given one broken approval beside an intact one.
  await fs.writeFile(persistPath, JSON.stringify({ paths: [], capabilityScopes: { bad: { loopback }, good: scope } }));
  // When parsing the store.
  const store = await readExtensionStore(persistPath);
  // Then the broken scope cannot authorize a target or hide its neighbor.
  expect(store.capabilityScopes).toEqual({ good: scope });
});
