import { execFile } from 'node:child_process';
import http from 'node:http';
import net from 'node:net';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestApp, requestBody } from './test-app.js';

// The shipped server runs on Node. Bun 1.3's HTTP shim drops rejected upgrades
// and does not emit ServerResponse.close on disconnect. Run these real socket
// tests on Node under either runner, rather than skipping the transport gate.
if (process.versions.bun) {
  it('checks production Node upgrade rejection and disconnect cancellation', async () => {
    const webRoot = fileURLToPath(new URL('../../../', import.meta.url));
    const runner = fileURLToPath(new URL('../../../node_modules/vitest/vitest.mjs', import.meta.url));
    const result = await promisify(execFile)('node', [runner, 'run', 'server/lib/integration-control/transport.test.js'], {
      cwd: webRoot, timeout: 30_000,
    });
    expect(result.stderr).not.toContain('FAIL');
  }, 35_000);
} else {
  describe('production Node transport authentication', () => {
    let fixture;
    beforeEach(async () => {
      vi.spyOn(console, 'log').mockImplementation(() => {});
      fixture = await createTestApp();
    });
    afterEach(async () => {
      await fixture.close();
      vi.restoreAllMocks();
    });

    it('rejects a malformed upgrade target without an uncaught URL exception', async () => {
      const socket = { destroyed: false, write: vi.fn(), destroy: vi.fn(() => { socket.destroyed = true; }) };
      expect(() => fixture.server.emit('upgrade', {
        url: '//[', headers: { connection: 'Upgrade', upgrade: 'websocket' },
      }, socket, Buffer.alloc(0))).not.toThrow();
      expect(socket.write).toHaveBeenCalledWith(expect.stringContaining('HTTP/1.1 401'));
      expect(socket.destroy).toHaveBeenCalledTimes(1);
      expect(fixture.execute).not.toHaveBeenCalled();
      const status = await new Promise((resolve, reject) => {
        const request = http.request({
          host: '127.0.0.1', port: fixture.server.address().port, path: '//[',
          headers: { Connection: 'Upgrade', Upgrade: 'websocket' },
        });
        request.on('response', (res) => { res.resume(); resolve(res.statusCode); });
        request.on('error', reject);
        request.end();
      });
      expect(status).toBe(401);
    });

    it.each(['/api/global/event/ws', '/api/event/ws', '/api/terminal/ws', '/api/openchamber/integration/control'])(
      'rejects actual WebSocket upgrade at %s with valid UI cookie', async (url) => {
        const status = await new Promise((resolve, reject) => {
          const request = http.get(`http://127.0.0.1:${fixture.server.address().port}${url}`, {
            headers: {
              Authorization: `Bearer ${fixture.token}`, Cookie: fixture.cookie,
              Connection: 'Upgrade', Upgrade: 'websocket',
              'Sec-WebSocket-Version': '13', 'Sec-WebSocket-Key': 'c3ludGhldGljLWZpeHR1cmU=',
            },
          });
          request.on('response', (res) => { res.resume(); resolve(res.statusCode); });
          request.on('upgrade', (_res, socket) => { socket.destroy(); reject(new Error('Unexpected integration WebSocket')); });
          request.on('error', reject);
        });
        expect(status).toBe(401);
        expect(fixture.execute).not.toHaveBeenCalled();
      },
    );

    it('aborts the native control signal on client disconnect', async () => {
      let entered;
      const started = new Promise((resolve) => { entered = resolve; });
      let release;
      fixture.sessionService.create.mockImplementationOnce(() => {
        entered();
        return new Promise((resolve) => { release = resolve; });
      });
      const body = JSON.stringify(requestBody('session.create', { projectId: 'alpha' }));
      const pending = net.createConnection({ host: '127.0.0.1', port: fixture.server.address().port });
      pending.write(`POST /api/openchamber/integration/control HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer ${fixture.token}\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
      try {
        await started;
        const signal = fixture.execute.mock.calls[0][3].signal;
        const aborted = new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }));
        pending.destroy();
        await aborted;
        expect(signal.aborted).toBe(true);
      } finally {
        pending.destroy();
        release?.({ sessionId: 'created', promptDispatched: false });
      }
    });
  });
}
