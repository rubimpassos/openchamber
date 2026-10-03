import { afterEach, expect, test } from 'vitest';
import { createLoopbackFixture, readHttp } from './loopback.fixture.js';

let fixture;
afterEach(async () => { await fixture?.dispose(); });

test.each(['null', 'https://attacker.invalid'])('refuses writes in passwordless mode when Origin is %s', async (origin) => {
  // Given a passwordless host, whose auth middleware deliberately allows anonymous UI use.
  fixture = await createLoopbackFixture({ password: '' });
  // When a sandbox or foreign page attempts a write.
  const result = await fixture.read('/sessions/a/enabled', { method: 'POST',
    headers: { Origin: origin, 'Content-Type': 'application/json' }, body: '{}' });
  // Then passwordless mode does not weaken the origin boundary.
  expect(result.status).toBe(403);
  expect(fixture.requests).toHaveLength(0);
});

test('refuses URL-token writes when the host is passwordless', async () => {
  // Given a scoped token on a passwordless server.
  fixture = await createLoopbackFixture({ password: '' });
  const token = await fixture.mint();
  // When it is used for a write, even without an Origin.
  const result = await readHttp(fixture.serverPort, `${fixture.base}/sessions/a/enabled?oc_url_token=${token}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
  });
  // Then no write reaches the service.
  expect(result.status).toBe(403);
  expect(fixture.requests).toHaveLength(0);
});

test.each([['{broken', 400], [JSON.stringify('x'.repeat(65536)), 413]])
('returns a typed parser refusal when raw JSON is invalid or oversized', async (body, status) => {
  // Given the production route-owned parser, without a preceding test parser.
  fixture = await createLoopbackFixture({ globalParser: false });
  // When a malformed or oversized document arrives over a real socket.
  const result = await fixture.read('/sessions/a/enabled', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
  // Then body-parser's HTML error response never escapes.
  expect(result.status).toBe(status);
  expect(JSON.parse(result.text).error).toBe('HOST_REJECTED');
  expect(fixture.requests).toHaveLength(0);
});

test('accepts a parent write when the trusted packaged desktop origin is present', async () => {
  // Given the existing runtime origin policy and a valid session.
  fixture = await createLoopbackFixture();
  // When the native parent transport supplies its packaged UI origin.
  const result = await fixture.read('/sessions/a/enabled', { method: 'POST',
    headers: { Origin: 'openchamber-ui://app', 'Content-Type': 'application/json' }, body: '{}' });
  // Then the host accepts its parent, not an opaque guest.
  expect(result.status).toBe(200);
});
