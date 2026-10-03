import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { createLoopbackFixture, readHttp } from './loopback.fixture.js';

let fixture;
beforeEach(async () => { fixture = await createLoopbackFixture(); });
afterEach(async () => { await fixture.dispose(); vi.unstubAllEnvs(); });

test.each(['GET', 'HEAD'])('accepts a scoped token when loopback uses %s', async (method) => {
  // Given a real UI login and scoped token.
  const token = await fixture.mint();
  // When the guest makes a credentialless read.
  const result = await readHttp(fixture.serverPort, `${fixture.base}/panel/state?oc_url_token=${token}`, { method });
  // Then the route is authenticated without forwarding the token.
  expect(result.status).toBe(200);
  expect(fixture.requests[0].url).toBe('/panel/state');
});

test('refuses a foreign guest when a scoped URL token is used', async () => {
  // Given a token bound to local-api.
  const token = await fixture.mint();
  // When another guest prefix is addressed.
  const result = await readHttp(fixture.serverPort, `/api/guests/other/loopback/panel/state?oc_url_token=${token}`);
  // Then no upstream request is admitted.
  expect(result.status).toBe(403);
  expect(JSON.parse(result.text).error).toBe('NOT_GRANTED');
  expect(fixture.requests).toHaveLength(0);
});

test('keeps other HEAD routes closed when a guest token is supplied', async () => {
  // Given the narrowly extended loopback HEAD allowance.
  const token = await fixture.mint();
  // When HEAD targets an existing asset instead of loopback.
  const result = await readHttp(fixture.serverPort, `/api/guests/local-api/index.html?oc_url_token=${token}`, { method: 'HEAD' });
  // Then the old non-loopback auth policy is unchanged.
  expect(result.status).toBe(401);
});

test('refuses a write when only a scoped URL token is supplied', async () => {
  // Given a read-only credential.
  const token = await fixture.mint();
  // When it is presented for a JSON write.
  const result = await readHttp(fixture.serverPort, `${fixture.base}/sessions/a/enabled?oc_url_token=${token}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"enabled":true}',
  });
  // Then authentication fails before any local service receives the write.
  expect(result.status).toBe(403);
  expect(JSON.parse(result.text).error).toBe('NOT_GRANTED');
  expect(fixture.requests).toHaveLength(0);
});

test.each([
  ['missing', 404, 'NOT_FOUND'], ['undeclared', 404, 'NOT_FOUND'],
  ['unapproved', 403, 'NOT_GRANTED'], ['old scope', 403, 'NOT_GRANTED'],
  ['scope changed', 403, 'NOT_GRANTED'], ['partial approval', 403, 'NOT_GRANTED'],
  ['env changed', 403, 'NOT_GRANTED'], ['env invalid', 400, 'HOST_REJECTED'],
  ['enterprise blocked', 403, 'NOT_GRANTED'], ['disabled', 403, 'DISABLED'],
])('refuses admission when %s', async (condition, status, code) => {
  // Given an installed guest whose authority/configuration changed.
  switch (condition) {
    case 'missing': fixture.store.paths = []; break;
    case 'undeclared': delete fixture.manifest.openchamber.contributes.loopback; break;
    case 'unapproved': fixture.store.capabilityGrants = {}; break;
    case 'old scope': fixture.store.capabilityScopes = {}; break;
    case 'scope changed': fixture.manifest.openchamber.contributes.loopback.routes.push({ path: '/extra', methods: ['GET'] }); break;
    case 'partial approval': fixture.manifest.openchamber.contributes.capabilities = ['files']; break;
    case 'env changed': vi.stubEnv('OC_TRANSPORT_TEST_PORT', String(fixture.port === 65535 ? 65534 : fixture.port + 1)); break;
    case 'env invalid': vi.stubEnv('OC_TRANSPORT_TEST_PORT', 'secret-invalid-port'); break;
    case 'enterprise blocked': vi.stubEnv('OPENCHAMBER_ENTERPRISE_MODE', '1'); vi.stubEnv('OPENCHAMBER_ALLOW_LOCAL_EXTENSIONS', ''); break;
    case 'disabled': fixture.store.disabledGuests = { 'local-api': true }; break;
    default: throw new Error('Unknown fixture condition');
  }
  await fixture.saveManifest();
  await fixture.saveStore();
  // When making a read.
  const result = await fixture.read('/panel/state');
  // Then authorization fails before opening an upstream socket.
  expect(result.status).toBe(status);
  expect(JSON.parse(result.text).error).toBe(code);
  expect(fixture.requests).toHaveLength(0);
});

test.each(['null', 'https://attacker.invalid'])('refuses a write when Origin is %s', async (origin) => {
  // Given a valid UI session, not just a guest token.
  // When the write comes from an opaque or foreign browser origin.
  const result = await fixture.read('/sessions/a/enabled', { method: 'POST',
    headers: { Origin: origin, 'Content-Type': 'application/json' }, body: '{}' });
  // Then the session cannot bypass the write-origin boundary.
  expect(result.status).toBe(403);
  expect(JSON.parse(result.text).error).toBe('DENIED');
  expect(fixture.requests).toHaveLength(0);
});

test('refuses cross-site metadata when Origin is absent', async () => {
  // Given a session credential and cross-site browser metadata.
  // When submitting JSON without an Origin.
  const result = await fixture.read('/sessions/a/enabled', { method: 'POST',
    headers: { 'Sec-Fetch-Site': 'cross-site', 'Content-Type': 'application/json' }, body: '{}' });
  // Then no write reaches loopback.
  expect(result.status).toBe(403);
  expect(fixture.requests).toHaveLength(0);
});
