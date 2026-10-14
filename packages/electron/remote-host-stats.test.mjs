import assert from 'node:assert/strict';
import test from 'node:test';
import { fetchRemoteHostStats } from './remote-host-stats.mjs';

const response = (status, payload = null) => ({
  status,
  ok: status >= 200 && status < 300,
  json: async () => payload,
});

test('reads the stats route with the saved token and headers', async () => {
  const calls = [];
  const result = await fetchRemoteHostStats({
    url: 'https://host.example/base/?ignored=1',
    clientToken: ' secret-token ',
    requestHeaders: { 'X-Instance': 'remote', Authorization: 'attacker' },
    chromiumFetch: async (url, options) => {
      calls.push({ url, options });
      return response(200, { hostname: 'srv-1' });
    },
  });

  assert.deepEqual(result, { status: 'ok', sample: { hostname: 'srv-1' } });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://host.example/base/api/system/stats');
  assert.equal(calls[0].options.method, 'GET');
  assert.equal(calls[0].options.redirect, 'manual');
  assert.equal(calls[0].options.headers.Authorization, 'Bearer secret-token');
  assert.equal(calls[0].options.headers['X-Instance'], 'remote');
});

for (const [name, reply, expected] of [
  ['refused token', response(401), { status: 'auth' }],
  ['forbidden token', response(403), { status: 'auth' }],
  ['server without the route', response(404), { status: 'unsupported' }],
  ['server error', response(500, { error: 'boom' }), { status: 'failed' }],
  ['web page instead of JSON', { status: 200, ok: true, json: async () => { throw new SyntaxError('Unexpected token <'); } }, { status: 'unsupported' }],
]) {
  test(`classifies ${name}`, async () => {
    const result = await fetchRemoteHostStats({ url: 'https://host.example', chromiumFetch: async () => reply });
    assert.deepEqual(result, expected);
  });
}

test('fails without a request for non-HTTP addresses', async () => {
  let called = false;
  const result = await fetchRemoteHostStats({ url: 'relay://abc', chromiumFetch: async () => { called = true; return response(200, {}); } });
  assert.deepEqual(result, { status: 'failed' });
  assert.equal(called, false);
});

test('fails when the host does not answer', async () => {
  const result = await fetchRemoteHostStats({ url: 'https://host.example', chromiumFetch: async () => { throw new TypeError('fetch failed'); } });
  assert.deepEqual(result, { status: 'failed' });
});
