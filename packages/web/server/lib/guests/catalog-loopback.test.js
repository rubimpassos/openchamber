import { afterEach, beforeEach, expect, test } from 'bun:test';
import fs from 'node:fs/promises';
import path from 'node:path';
import express from 'express';
import request from 'supertest';
import { invalidateGuestCatalog, listInstalledGuests, toPublicGuest } from './catalog.js';
import { readExtensionStore, setCapabilityGrants, writeExtensionPaths } from './persist.js';
import { registerGuestRoutes } from './routes.js';

const envName = 'OC_CATALOG_LOOPBACK_TEST_PORT';
const originalEnv = process.env[envName];
const loopback = { port: 8123, env: envName, routes: [{ path: '/st%61te', methods: ['HEAD', 'GET'] }, { path: '/sessions/*', methods: ['POST'] }] };
let root;
let packageRoot;
let persistPath;
let app;
let pkg;
beforeEach(async () => {
  root = await fs.mkdtemp('/tmp/opencode/oc-loopback-catalog-');
  packageRoot = path.join(root, 'package');
  persistPath = path.join(root, 'extensions.json');
  await fs.mkdir(packageRoot);
  await fs.writeFile(path.join(packageRoot, 'index.html'), '<p>Local API</p>');
  pkg = { version: '1.0.0', openchamber: { apiVersion: 1, contributes: {
    panel: { id: 'local-api', name: 'Local API', icon: 'plug', entry: 'index.html', badge: 'count' },
    background: { entry: 'index.html', start: 'automatic' }, loopback,
  } } };
  await fs.writeFile(path.join(packageRoot, 'package.json'), JSON.stringify(pkg));
  await writeExtensionPaths([packageRoot], persistPath);
  process.env[envName] = '9123';
  app = express();
  registerGuestRoutes(app, { openchamberDataDir: root });
});
afterEach(async () => {
  if (originalEnv === undefined) delete process.env[envName];
  else process.env[envName] = originalEnv;
  invalidateGuestCatalog(persistPath);
  await fs.rm(root, { recursive: true, force: true });
});

test('persists the actual target when the approval route receives loopback', async () => {
  // Given an installed manifest with a non-default server override.
  // When approving through the real HTTP handler.
  const response = await request(app).put('/api/guests/local-api/capabilities').send({ granted: ['loopback'] }).expect(200);
  // Then manifest parsing, approval storage and the catalog agree.
  expect(response.body.guest).toMatchObject({
    panelBadge: 'count', backgroundStart: 'automatic',
    loopback: { port: 8123, env: envName, status: 'ready', resolvedPort: 9123, routes: [
      { path: '/state', methods: ['HEAD', 'GET'] }, { path: '/sessions/*', methods: ['POST'] },
    ] },
    capabilities: { requested: ['loopback'], granted: ['loopback'] },
  });
  expect((await readExtensionStore(persistPath)).capabilityScopes['local-api']).toEqual({ loopback: {
    port: 8123, env: envName, resolvedPort: 9123, routes: ['GET /state', 'HEAD /state', 'POST /sessions/*'],
  } });
});

test.each(['9124', 'invalid-secret'])('invalidates cached approval when server env becomes %s', async (override) => {
  // Given approval and a warm catalog cache.
  await request(app).put('/api/guests/local-api/capabilities').send({ granted: ['loopback'] }).expect(200);
  await listInstalledGuests({ persistPath });
  process.env[envName] = override;
  // When listing without cache invalidation or waiting for the TTL.
  const [guest] = await listInstalledGuests({ persistPath });
  const row = toPublicGuest(guest);
  // Then the effective grant is removed immediately and config errors expose no raw value.
  expect(row.capabilities).toEqual({ requested: ['loopback'], granted: [] });
  expect(row.loopback).toMatchObject(override === '9124' ? { status: 'ready', resolvedPort: 9124 } : { status: 'config-invalid' });
  if (override === 'invalid-secret') {
    expect(row.loopback).not.toHaveProperty('resolvedPort');
    expect(JSON.stringify(row)).not.toContain(override);
  }
});

test('rejects approval when the server configuration is invalid', async () => {
  // Given a bad server-side port override.
  process.env[envName] = '9123junk';
  // When the user tries to approve it.
  const response = await request(app).put('/api/guests/local-api/capabilities').send({ granted: ['loopback'] }).expect(400);
  // Then no approval is persisted.
  expect(response.body.error).toBe('config-invalid');
  expect((await readExtensionStore(persistPath)).capabilityGrants).toEqual({});
});

test('allows withdrawal when the port configuration has become invalid', async () => {
  // Given an existing approval whose environment broke.
  await request(app).put('/api/guests/local-api/capabilities').send({ granted: ['loopback'] }).expect(200);
  process.env[envName] = 'broken';
  // When withdrawing approval.
  const response = await request(app).put('/api/guests/local-api/capabilities').send({ granted: [] }).expect(200);
  // Then the grant is removed even though the target cannot resolve.
  expect(response.body.guest.capabilities.granted).toEqual([]);
  expect((await readExtensionStore(persistPath)).capabilityScopes).toEqual({});
});

test('requires review when an old stored loopback grant has no scope', async () => {
  // Given a pre-scope store.
  await setCapabilityGrants('local-api', persistPath, ['loopback']);
  // When reading the installed guest.
  const [guest] = await listInstalledGuests({ persistPath });
  // Then it stays visible but inactive, awaiting explicit review in Settings.
  expect(toPublicGuest(guest).capabilities).toEqual({ requested: ['loopback'], granted: [] });
});

test.each([
  ['version and order', false],
  ['route', true],
  ['method', true],
  ['port', true],
  ['env', true],
])('compares stored scope when a package changes %s', async (change, revoked) => {
  // Given an approved package.
  await request(app).put('/api/guests/local-api/capabilities').send({ granted: ['loopback'] }).expect(200);
  pkg.version = '2.0.0';
  const next = { ...loopback, routes: [...loopback.routes].reverse().map((route) => ({ ...route, methods: [...route.methods].reverse() })) };
  if (change === 'route') next.routes.push({ path: '/more', methods: ['GET'] });
  if (change === 'method') next.routes[0].methods = ['GET'];
  if (change === 'port') next.port = 8124;
  if (change === 'env') next.env = `${envName}_OTHER`;
  pkg.openchamber.contributes.loopback = next;
  await fs.writeFile(path.join(packageRoot, 'package.json'), JSON.stringify(pkg));
  invalidateGuestCatalog(persistPath);
  // When the catalog loads the updated package.
  const [guest] = await listInstalledGuests({ persistPath });
  // Then only a changed permission set requires reapproval.
  expect(guest.capabilityGrants).toEqual(revoked ? [] : ['loopback']);
});
