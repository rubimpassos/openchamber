import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';
import { createTestApp, requestBody } from './test-app.js';

let fixture;
beforeEach(async () => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  fixture = await createTestApp();
});
afterEach(async () => {
  await fixture.close();
  vi.restoreAllMocks();
});

const endpoint = '/api/openchamber/integration/control';
const commonRoutes = [
  ['post', '/api/openchamber/control', { action: 'projects.list' }],
  ['get', '/api/session'],
  ['get', '/api/global/event/ws'],
  ['get', '/api/terminal/sessions'],
  ['get', '/api/fs/home'],
  ['get', '/api/config/settings'],
  ['post', '/api/openchamber/control', { action: 'browser.snapshot' }],
  ['get', '/api/agent-memory?scope=global'],
  ['get', '/api/openchamber/scheduled-tasks/status'],
  ['post', '/api/openchamber/agent-tool', { input: { action: 'projects.list' } }],
  ['post', '/auth/url-token'],
  ['get', '/api/version'],
];

describe('credential isolation at production bootstrap gates', () => {
  it.each(commonRoutes)('integration credential cannot access %s %s, with or without UI cookie', async (method, url, body) => {
    for (const withCookie of [false, true]) {
      let request = fixture.request[method](url).set('Authorization', `Bearer ${fixture.token}`);
      if (withCookie) request = request.set('Cookie', fixture.cookie);
      const response = await request.send(body);
      expect(response.status).toBe(401);
      expect(response.body.error.code).toBe('UNAUTHORIZED');
      expect(response.text.includes(fixture.token)).toBe(false);
    }
    expect(fixture.execute).not.toHaveBeenCalled();
  });

  it.each(['missing', 'invalid', 'client', 'agent'])('%s credential never falls back to UI on integration endpoint', async (kind) => {
    const token = { invalid: 'oc_integration_invalid', client: fixture.commonToken, agent: fixture.agentToken }[kind];
    for (const withCookie of [false, true]) {
      let request = fixture.request.post(endpoint);
      if (token) request = request.set('Authorization', `Bearer ${token}`);
      if (withCookie) request = request.set('Cookie', fixture.cookie);
      const response = await request.send(requestBody());
      expect(response.status).toBe(401);
      expect(response.body.error.code).toBe('UNAUTHORIZED');
    }
    expect(fixture.execute).not.toHaveBeenCalled();
  });

  it('human UI and native client still use the ordinary control route', async () => {
    expect(fixture.cookie).toBeTruthy();
    const body = { action: 'projects.list', input: {} };
    expect((await fixture.request.post('/api/openchamber/control').send(body)).status).toBe(401);
    const ui = await fixture.request.post('/api/openchamber/control').set('Cookie', fixture.cookie).send(body);
    const client = await fixture.request.post('/api/openchamber/control').set('Authorization', `Bearer ${fixture.commonToken}`).send(body);
    expect(ui.status).toBe(200);
    expect(client.status).toBe(200);
    expect(ui.body.projects).toHaveLength(2);
    expect(client.body).toEqual(ui.body);
  });

  it('unsupported integration methods and subpaths never reach fallback', async () => {
    for (const url of [endpoint, `${endpoint}/other`]) {
      const response = await fixture.request.get(url).set('Cookie', fixture.cookie);
      expect(response.status).toBe(401);
    }
    expect(fixture.execute).not.toHaveBeenCalled();
  });

  it('rejects integration namespace even on password-less servers', async () => {
    await fixture.close();
    fixture = await createTestApp({ password: '' });
    const human = await fixture.request.post('/api/openchamber/control').send({ action: 'projects.list' });
    expect(human.status).toBe(200);
    fixture.execute.mockClear();
    for (const [method, url, body] of commonRoutes) {
      const response = await fixture.request[method](url).set('Authorization', `Bearer ${fixture.token}`).send(body);
      expect(response.status).toBe(401);
    }
    expect(fixture.execute).not.toHaveBeenCalled();
  });

  it.each(['/api/global/event/ws', '/api/event/ws', '/api/terminal/ws', endpoint])('rejects actual WebSocket upgrade at %s with valid UI cookie', async (url) => {
    const status = await new Promise((resolve, reject) => {
      const socket = new WebSocket(`ws://127.0.0.1:${fixture.server.address().port}${url}`, {
        headers: { Authorization: `Bearer ${fixture.token}`, Cookie: fixture.cookie },
      });
      socket.on('unexpected-response', (_req, res) => { res.resume(); socket.terminate(); resolve(res.statusCode); });
      socket.on('open', () => { socket.close(); reject(new Error('Unexpected integration WebSocket')); });
      socket.on('error', () => {});
    });
    expect(status).toBe(401);
    expect(fixture.execute).not.toHaveBeenCalled();
  });
});
