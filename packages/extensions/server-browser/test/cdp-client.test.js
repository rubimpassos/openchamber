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

for (const firstMethod of ['Page.captureScreenshot', 'Emulation.setDeviceMetricsOverride']) {
  for (const rejected of [false, true]) {
    test(`serializes viewport changes and captures in one session after ${firstMethod} ${rejected ? 'fails' : 'succeeds'}`, async (context) => {
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
      const secondMethod = firstMethod === 'Page.captureScreenshot' ? 'Emulation.setDeviceMetricsOverride' : 'Page.captureScreenshot';
      const second = cdp.sendSession('page', secondMethod);
      context.after(async () => {
        cdp.close();
        await Promise.allSettled([firstOutcome, second]);
      });
      await cdp.sendSession('other-page', secondMethod);
      await cdp.sendSession('page', 'Runtime.evaluate');
      assert.deepEqual(messages.map(({ sessionId, method }) => [sessionId, method]), [
        ['page', firstMethod], ['other-page', secondMethod], ['page', 'Runtime.evaluate'],
      ]);
      peer.send(JSON.stringify({
        id: held.id, sessionId: held.sessionId,
        ...(rejected ? { error: { message: 'fixture refusal' } } : { result: {} }),
      }));
      await firstOutcome;
      await second;
      assert.equal(messages.at(-1).sessionId, 'page');
      assert.equal(messages.at(-1).method, secondMethod);
    });
  }
}

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
