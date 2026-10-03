import { once } from 'node:events';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { createLoopbackClock, createLoopbackFixture } from './loopback.fixture.js';

let fixture;
let clock;
beforeEach(async () => { clock = createLoopbackClock(); fixture = await createLoopbackFixture({ clock }); });
afterEach(async () => { await fixture.dispose(); vi.unstubAllEnvs(); });

const streamFixture = async () => {
  const received = Promise.withResolvers();
  fixture.respond((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write('data: first\n\n');
    received.resolve(res);
  });
  const downstream = await fixture.open('/panel/events', { headers: { 'Accept-Encoding': 'gzip' } });
  const upstream = await received.promise;
  const upstreamClosed = once(upstream, 'close');
  const downstreamClosed = new Promise((resolve) => {
    downstream.once('close', resolve);
    downstream.once('error', resolve); // Aborted SSE deliberately reports ECONNRESET.
  });
  return { downstream, upstream, upstreamClosed, downstreamClosed };
};

test('streams incrementally when the service has not produced its second frame', async () => {
  // Given a service paused after writing the first event.
  const stream = await streamFixture();
  const reader = stream.downstream[Symbol.asyncIterator]();
  // When the client reads before permitting a second upstream write.
  const first = await reader.next();
  // Then the first event is already visible, without compression or accumulation.
  expect(first.value.toString()).toBe('data: first\n\n');
  expect(stream.downstream.headers).toMatchObject({ 'cache-control': 'no-cache, no-transform', 'x-accel-buffering': 'no' });
  expect(stream.downstream.headers).not.toHaveProperty('content-encoding');
  stream.upstream.end('data: second\n\n');
  const rest = [];
  for await (const chunk of reader) rest.push(chunk);
  expect(Buffer.concat(rest).toString()).toBe('data: second\n\n');
});

test('aborts the upstream when the downstream disconnects', async () => {
  // Given an active SSE connection.
  const stream = await streamFixture();
  // When the browser leaves.
  stream.downstream.destroy();
  // Then the real service observes its response socket closing.
  await stream.upstreamClosed;
  expect(stream.upstream.destroyed).toBe(true);
});

test.each(['revoke', 'disable', 'uninstall', 'scope'])('aborts a live stream when a store write changes %s', async (change) => {
  // Given a live approved stream.
  const stream = await streamFixture();
  switch (change) {
    case 'revoke': fixture.store.capabilityGrants = {}; break;
    case 'disable': fixture.store.disabledGuests = { 'local-api': true }; break;
    case 'uninstall': fixture.store.paths = []; break;
    case 'scope': fixture.store.capabilityScopes = {}; break;
    default: throw new Error('Unknown fixture change');
  }
  // When authority changes, without advancing the periodic clock.
  await fixture.saveStore();
  // Then both real sockets close immediately through the store listener.
  await Promise.all([stream.upstreamClosed, stream.downstreamClosed]);
  expect(stream.upstream.destroyed).toBe(true);
});

test.each(['manifest', 'enterprise', 'environment'])('reauthorizes fresh data when %s changes without a store write', async (change) => {
  // Given an active stream and a warm catalog from admission.
  const stream = await streamFixture();
  switch (change) {
    case 'manifest':
      fixture.manifest.openchamber.contributes.loopback.routes.push({ path: '/more', methods: ['GET'] });
      await fixture.saveManifest();
      break;
    case 'enterprise': vi.stubEnv('OPENCHAMBER_ENTERPRISE_MODE', '1'); vi.stubEnv('OPENCHAMBER_ALLOW_LOCAL_EXTENSIONS', ''); break;
    case 'environment': vi.stubEnv('OC_TRANSPORT_TEST_PORT', 'invalid'); break;
    default: throw new Error('Unknown fixture change');
  }
  // When the one-second check fires, before the five-second catalog TTL.
  await clock.advance(1_000);
  // Then the stale stream is closed.
  await Promise.all([stream.upstreamClosed, stream.downstreamClosed]);
  expect(stream.upstream.destroyed).toBe(true);
});

test('closes the lease when a stream reaches sixty seconds', async () => {
  // Given a healthy stream and an injected transport clock.
  const stream = await streamFixture();
  // When its lease expires without a network error or revocation.
  await clock.advance(60_000);
  // Then the caller must reconnect through fresh admission.
  await Promise.all([stream.upstreamClosed, stream.downstreamClosed]);
  expect(stream.upstream.destroyed).toBe(true);
});

test('bounds simultaneous streams when a guest already owns sixteen', async () => {
  // Given sixteen active streams for one guest.
  fixture.respond((_req, res) => { res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.write(': ready\n\n'); });
  const streams = await Promise.all(Array.from({ length: 16 }, () => fixture.open()));
  try {
    // When a seventeenth request arrives.
    const result = await fixture.read('/panel/events');
    // Then it is refused without opening another upstream request.
    expect(result.status).toBe(403);
    expect(JSON.parse(result.text).error).toBe('HOST_REJECTED');
    expect(fixture.requests).toHaveLength(16);
  } finally { for (const stream of streams) stream.destroy(); }
});

test('returns a typed timeout when upstream never sends headers', async () => {
  // Given a real listener that accepts the request but withholds headers.
  const received = Promise.withResolvers();
  fixture.respond((_req, res) => received.resolve(res));
  const pending = fixture.read('/panel/state');
  const upstream = await received.promise;
  const closed = once(upstream, 'close');
  // When the five-second deadline expires.
  await clock.advance(5_000);
  const result = await pending;
  // Then the client receives 504 and the service loses the connection.
  expect(result.status).toBe(504);
  expect(JSON.parse(result.text).error).toBe('HOST_TIMEOUT');
  await closed;
});

test('disposes active sockets when the runtime shuts down', async () => {
  // Given an active request owned by this host lifecycle.
  const stream = await streamFixture();
  // When the runtime disposer runs.
  fixture.runtime.dispose();
  // Then outstanding upstream and downstream sockets both close.
  await Promise.all([stream.upstreamClosed, stream.downstreamClosed]);
  expect(stream.upstream.destroyed).toBe(true);
});
