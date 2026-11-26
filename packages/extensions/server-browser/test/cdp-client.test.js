import assert from 'node:assert/strict';
import net from 'node:net';
import test from 'node:test';
import { createRequire } from 'node:module';
import { connectCdp } from '../src/cdp-client.js';

const require = createRequire(new URL('../../../web/package.json', import.meta.url));
const { WebSocketServer } = require('ws');

const listen = (server) => new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', () => resolve(server.address().port));
});

test('bounds a WebSocket peer that accepts TCP without completing the handshake', async (context) => {
  const sockets = new Set();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  const port = await listen(server);
  context.after(() => {
    for (const socket of sockets) socket.destroy();
    server.close();
  });

  await assert.rejects(
    connectCdp(`ws://127.0.0.1:${port}/devtools/browser/stalled`, { handshakeTimeoutMs: 25 }),
    /timed out|opening handshake/i,
  );
});

const captureMethod = 'Page.captureScreenshot';
const metricsMethod = 'Emulation.setDeviceMetricsOverride';
const navigationMethods = ['Page.navigate', 'Page.reload', 'Page.navigateToHistoryEntry'];
const independentMethods = [
  'Runtime.evaluate', 'Input.dispatchMouseEvent', 'Input.dispatchKeyEvent',
  'Page.screencastFrameAck', 'Page.stopLoading', 'Page.handleJavaScriptDialog',
];
const exclusivePairs = [
  [captureMethod, metricsMethod], [metricsMethod, captureMethod],
  ...navigationMethods.flatMap((method) => [[captureMethod, method], [method, captureMethod]]),
];
for (const [firstMethod, secondMethod] of exclusivePairs) {
  for (const rejected of [false, true]) {
    test(`${secondMethod} waits for ${firstMethod} to ${rejected ? 'reject' : 'succeed'} in one session`, async (context) => {
      const server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
      context.after(() => server.close());
      await new Promise((resolve) => server.once('listening', resolve));
      const receivedFirst = Promise.withResolvers();
      const messages = [];
      let peer;
      server.on('connection', (socket) => {
        peer = socket;
        socket.on('message', (data) => {
          const message = JSON.parse(String(data));
          messages.push(message);
          if (message.params.hold) receivedFirst.resolve(message);
          else socket.send(JSON.stringify({ id: message.id, sessionId: message.sessionId, result: {} }));
        });
      });
      const cdp = await connectCdp(`ws://127.0.0.1:${server.address().port}`);
      const first = cdp.sendSession('page', firstMethod, { hold: true });
      const firstOutcome = rejected ? assert.rejects(first, /fixture refusal/) : first;
      const held = await receivedFirst.promise;
      const second = cdp.sendSession('page', secondMethod);
      const third = cdp.sendSession('page', metricsMethod);
      context.after(async () => {
        cdp.close();
        await Promise.allSettled([firstOutcome, second, third]);
      });
      await cdp.sendSession('other-page', secondMethod);
      for (const method of independentMethods) await cdp.sendSession('page', method);
      assert.deepEqual(messages.map(({ sessionId, method }) => [sessionId, method]), [
        ['page', firstMethod], ['other-page', secondMethod],
        ...independentMethods.map((method) => ['page', method]),
      ]);
      peer.send(JSON.stringify({
        id: held.id, sessionId: held.sessionId,
        ...(rejected ? { error: { message: 'fixture refusal' } } : { result: {} }),
      }));
      await firstOutcome;
      await second;
      await third;
      assert.deepEqual(messages.slice(-2).map(({ sessionId, method }) => [sessionId, method]), [
        ['page', secondMethod], ['page', metricsMethod],
      ], 'queued commands are released in FIFO order on command settlement without waiting for page loading');
    });
  }
}

test('loading cancels queued captures before dispatch but leaves a sent capture unresolved until Chrome replies', async (context) => {
  const server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  context.after(() => server.close());
  await new Promise((resolve) => server.once('listening', resolve));
  const received = Promise.withResolvers();
  const messages = [];
  let peer;
  server.on('connection', (socket) => {
    peer = socket;
    socket.on('message', (data) => {
      const message = JSON.parse(String(data));
      messages.push(message);
      if (message.params.hold) received.resolve(message);
      else socket.send(JSON.stringify({ id: message.id, sessionId: message.sessionId, result: {} }));
    });
  });
  const cdp = await connectCdp(`ws://127.0.0.1:${server.address().port}`);
  const document = new AbortController();
  cdp.onEvent(({ method }) => {
    if (method === 'Page.frameStartedLoading') document.abort();
  });
  let settled = false;
  const capture = cdp.sendSession('page', captureMethod, { hold: true }, document.signal)
    .then(() => { settled = true; });
  const held = await received.promise;
  const cancelled = [0, 1].map(() => assert.rejects(
    cdp.sendSession('page', captureMethod, {}, document.signal), { name: 'AbortError' },
  ));
  const metrics = cdp.sendSession('page', metricsMethod);
  context.after(async () => {
    cdp.close();
    await Promise.allSettled([capture, ...cancelled, metrics]);
  });
  peer.send(JSON.stringify({ sessionId: 'page', method: 'Page.frameStartedLoading', params: { frameId: 'main' } }));
  await cdp.sendSession('page', 'Runtime.evaluate');
  assert.equal(document.signal.aborted, true);
  assert.equal(settled, false, 'abort cannot settle a capture already sent to Chrome');
  assert.deepEqual(messages.map(({ method }) => method), [captureMethod, 'Runtime.evaluate']);
  peer.send(JSON.stringify({ id: held.id, sessionId: held.sessionId, result: {} }));
  await Promise.all([capture, ...cancelled, metrics]);
  assert.deepEqual(messages.map(({ method }) => method), [captureMethod, 'Runtime.evaluate', metricsMethod]);
  assert.equal(cdp.isOpen, true);
});

test('closes an uncertain viewport operation on timeout before queued metrics can reach Chrome', async (context) => {
  const server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  context.after(() => server.close());
  await new Promise((resolve) => server.once('listening', resolve));
  const received = Promise.withResolvers();
  const messages = [];
  server.on('connection', (socket) => {
    socket.on('message', (data) => {
      messages.push(JSON.parse(String(data)));
      received.resolve();
    });
  });
  const cdp = await connectCdp(`ws://127.0.0.1:${server.address().port}`, { commandTimeoutMs: 50 });
  context.after(() => cdp.close());
  const closed = Promise.withResolvers();
  cdp.onClose(closed.resolve);
  const capture = assert.rejects(cdp.sendSession('page', 'Page.captureScreenshot'), { code: 'timeout' });
  await received.promise;
  const metrics = assert.rejects(cdp.sendSession('page', 'Emulation.setDeviceMetricsOverride'), { code: 'closed' });
  await Promise.all([capture, metrics, closed.promise]);
  assert.equal(cdp.isOpen, false);
  assert.deepEqual(messages.map(({ method }) => method), ['Page.captureScreenshot']);
});

test('rejects an unscoped CDP session error without closing the connection', { timeout: 2000 }, async (context) => {
  const server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  context.after(() => server.close());
  await new Promise((resolve) => server.once('listening', resolve));
  server.on('connection', (socket) => {
    socket.on('message', (data) => {
      const message = JSON.parse(String(data));
      socket.send(JSON.stringify(message.method === 'Page.captureScreenshot'
        ? { id: message.id, error: { code: -32001, message: 'Session with given id not found.' } }
        : { id: message.id, result: {} }));
    });
  });
  const cdp = await connectCdp(`ws://127.0.0.1:${server.address().port}`);
  const rejected = assert.rejects(cdp.sendSession('missing-session', 'Page.captureScreenshot'), { code: 'protocol' });
  context.after(async () => {
    cdp.close();
    await Promise.allSettled([rejected]);
  });
  await rejected;
  assert.equal(cdp.isOpen, true);
  await cdp.send('Browser.getVersion');
});
