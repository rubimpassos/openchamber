import { createServer } from 'node:net';
import express from 'express';
import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { registerCiLoopRoutes } from './routes.js';

afterEach(() => vi.unstubAllEnvs());

async function withoutPlugin() {
  const listener = createServer();
  await new Promise((resolve) => listener.listen(0, '127.0.0.1', resolve));
  const port = listener.address().port;
  await new Promise((resolve, reject) => listener.close((error) => error ? reject(error) : resolve()));
  vi.stubEnv('OPENCHAMBER_CI_LOOP_PORT', String(port));
  const app = express();
  registerCiLoopRoutes(app);
  return app;
}

describe('CI loop without the v1 plugin', () => {
  it('reports unavailable instead of crashing when the plugin is absent', async () => {
    const app = await withoutPlugin();
    const response = await request(app).get('/api/ci-loop/session/session-v2');
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ available: false });
  });

  it('returns a controlled failure for a toggle when the plugin is absent', async () => {
    const app = await withoutPlugin();
    const response = await request(app).post('/api/ci-loop/session/session-v2/enabled').send({ enabled: true });
    expect(response.status).toBe(502);
    expect(response.body).toHaveProperty('error');
  });
});
