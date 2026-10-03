import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { createLoopbackFixture, listen } from './loopback.fixture.js';

let fixture;
beforeEach(async () => { fixture = await createLoopbackFixture(); });
afterEach(async () => { await fixture.dispose(); });

test('proxies JSON with safe headers when the route is approved', async () => {
  // Given a service that reports the exact incoming request.
  fixture.respond((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Set-Cookie': 'upstream=secret', Location: '/elsewhere' });
    res.end(JSON.stringify({ url: req.url, headers: req.headers }));
  });
  // When a parent supplies sensitive headers and reserved query fields.
  const response = await fixture.read('/panel/st%61te?locale=en&oc_url_token=discard&%6fc_extra=secret&oc_client_token=discard', {
    headers: { Accept: 'application/json', Authorization: 'Bearer never-forward', Origin: 'null',
      Referer: 'https://secret.invalid', Forwarded: 'for=secret', 'X-Forwarded-Host': `127.0.0.1:${fixture.serverPort}`,
      'X-Forwarded-For': '192.0.2.1', Connection: 'x-custom-hop', 'X-Custom-Hop': 'secret' },
  });
  // Then only the canonical target and allowlisted headers reach the service.
  expect(response.status).toBe(200);
  const body = JSON.parse(response.text);
  expect(body.url).toBe('/panel/state?locale=en');
  expect(body.headers).toEqual({ host: `127.0.0.1:${fixture.port}`, accept: 'application/json', connection: 'close' });
  expect(response.headers).toMatchObject({ 'access-control-allow-origin': 'null',
    'x-content-type-options': 'nosniff', 'content-security-policy': "sandbox; frame-ancestors 'none'" });
  expect(response.headers).not.toHaveProperty('set-cookie');
  expect(response.headers).not.toHaveProperty('location');
  expect(response.headers).not.toHaveProperty('access-control-allow-credentials');
});

test('serializes a consumed JSON body once when the parent writes with a UI cookie', async () => {
  // Given the fixture's global parser and a real receiving service.
  fixture.respond(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ body: Buffer.concat(chunks).toString(), headers: req.headers }));
  });
  // When the parent writes JSON through its authenticated session.
  const result = await fixture.read('/sessions/a%20b/enabled', { method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: `http://127.0.0.1:${fixture.serverPort}` },
    body: '{ "enabled" : false }' });
  // Then the upstream receives exactly one JSON document and no credentials.
  expect(result.status).toBe(200);
  expect(JSON.parse(result.text).body).toBe('{"enabled":false}');
  expect(JSON.parse(result.text).headers['content-type']).toBe('application/json');
  expect(JSON.parse(result.text).headers).not.toHaveProperty('cookie');
  expect(JSON.parse(result.text).headers).not.toHaveProperty('origin');
});

test.each(['/panel/../panel/state', '/panel/%2e%2e/state', '/panel/%252e%252e/state',
  '/panel%2fstate', '/panel%5cstate', '/panel//state', '/panel/%', '/panel/%00state', '/panel/state#fragment'])
('refuses malformed paths when requesting %s', async (target) => {
  // Given an approved guest and raw HTTP path bytes.
  // When traversal or malformed encodings are supplied without URL normalization.
  const result = await fixture.read(target);
  // Then the request never reaches either upstream or static serving.
  expect(result.status).toBe(400);
  expect(JSON.parse(result.text).error).toBe('BAD_PATH');
  expect(fixture.requests).toHaveLength(0);
});

test('does not fall through to static files when the route is not declared', async () => {
  // Given a real package file at a loopback-looking path.
  await fs.mkdir(path.join(fixture.root, 'package/loopback'));
  await fs.writeFile(path.join(fixture.root, 'package/loopback/private.json'), '{"leak":true}');
  // When the static-looking path is requested under loopback.
  const result = await fixture.read('/private.json');
  // Then the proxy denies it instead of serving the file.
  expect(result.status).toBe(403);
  expect(JSON.parse(result.text).error).toBe('NOT_GRANTED');
  expect(fixture.requests).toHaveLength(0);
});

test.each(['PUT', 'DELETE', 'PATCH', 'OPTIONS'])('refuses the verb when it is %s', async (method) => {
  // Given an authenticated parent.
  // When requesting a globally unsupported verb.
  const result = await fixture.read('/panel/state', { method });
  // Then no local socket opens.
  expect(result.status).toBe(405);
  expect(result.headers.allow).toBe('GET, HEAD, POST');
  expect(fixture.requests).toHaveLength(0);
});

test.each([
  ['/panel/events', { method: 'HEAD' }, 403],
  ['/panel/state', { method: 'POST', body: '{}', type: 'application/json' }, 403],
  ['/sessions/a/b/enabled', { method: 'POST', body: '{}', type: 'application/json' }, 403],
  ['/sessions/a/enabled', { method: 'POST', body: '{}', type: 'text/plain' }, 400],
  ['/sessions/a/enabled', { method: 'POST', body: JSON.stringify('x'.repeat(65536)), type: 'application/json' }, 413],
  ['/panel/state', { method: 'GET', body: '{}', type: 'application/json' }, 400],
  [`/panel/state?q=${'x'.repeat(2049)}`, { method: 'GET' }, 400],
  ['/panel/state?q=%ZZ', { method: 'GET' }, 400],
])('enforces request bounds for %s %j', async (target, request, status) => {
  // Given a request outside the declaration or body/query contract.
  const { method, body, type } = request;
  const headers = type ? { 'Content-Type': type, 'Content-Length': Buffer.byteLength(body) } : {};
  // When it reaches the proxy.
  const result = await fixture.read(target, { method, headers, body });
  // Then it fails without upstream traffic.
  expect(result.status).toBe(status);
  expect(fixture.requests).toHaveLength(0);
});

test.each(['text/html', 'text/javascript', 'application/javascript', 'application/octet-stream'])
('refuses the response when its type is %s', async (type) => {
  // Given an upstream response that could become executable host content.
  fixture.respond((_req, res) => { res.setHeader('Content-Type', type); res.end('<script>bad()</script>'); });
  // When reading through the proxy.
  const result = await fixture.read('/panel/state');
  // Then it returns a typed failure instead of upstream bytes.
  expect(result.status).toBe(502);
  expect(JSON.parse(result.text).error).toBe('HOST_REJECTED');
});

test('never follows redirects when upstream supplies a Location', async () => {
  // Given a real redirect sink with an observable request count.
  let sinkRequests = 0;
  const sink = await listen((_req, res) => { sinkRequests += 1; res.end(); });
  fixture.respond((_req, res) => { res.writeHead(302, { Location: `http://127.0.0.1:${sink.address().port}/secret` }); res.end(); });
  try {
    // When an approved endpoint redirects to the sink.
    const result = await fixture.read('/panel/state');
    // Then only the original request was issued.
    expect(result.status).toBe(502);
    expect(sinkRequests).toBe(0);
    expect(result.headers).not.toHaveProperty('location');
  } finally { await new Promise((resolve) => sink.close(resolve)); }
});

test('preserves application errors when upstream answers plain text', async () => {
  // Given a service-level control error, not a proxy failure.
  fixture.respond((_req, res) => { res.writeHead(409, { 'Content-Type': 'text/plain' }); res.end('state conflict'); });
  // When the caller reads its response.
  const result = await fixture.read('/panel/state');
  // Then both status and application text survive.
  expect(result.status).toBe(409);
  expect(result.text).toBe('state conflict');
});

test('bounds finite responses when upstream exceeds 16 MiB', async () => {
  // Given a service with an oversized response.
  fixture.respond((_req, res) => { res.setHeader('Content-Type', 'text/plain'); res.end(Buffer.alloc(16 * 1024 * 1024 + 1)); });
  // When the finite response crosses the limit.
  const result = await fixture.read('/panel/state');
  // Then no partial upstream body is exposed as success.
  expect(result.status).toBe(502);
  expect(JSON.parse(result.text).error).toBe('HOST_REJECTED');
});
