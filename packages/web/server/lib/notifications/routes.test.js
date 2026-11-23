import express from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { registerNotificationRoutes } from './routes.js';

const makeApp = (localOnly) => {
  const registrations = [];
  const app = express();
  app.use(express.json());
  registerNotificationRoutes(app, {
    getUiSessionTokenFromRequest: () => 'cookie-session',
    isLocalOnlyPushRequest: async () => localOnly,
    addOrUpdateApnsToken: async (...args) => { registrations.push(args); },
  });
  return { app, registrations };
};

describe('home-only push routes', () => {
  it('reports home-only delivery without storing a native push token', async () => {
    // Given a paired request whose policy keeps it on the home network.
    const { app, registrations } = makeApp(true);

    // When the native app attempts to register its device.
    const response = await request(app).post('/api/push/apns-token').send({ token: 'device', pushKey: 'key' });

    // Then no push registration can leave the server through this route.
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ ok: true, localOnly: true });
    expect(registrations).toEqual([]);
  });

  it('registers native push when the paired request permits remote delivery', async () => {
    // Given an ordinary pairing and its native push inputs.
    const { app, registrations } = makeApp(false);

    // When the native app registers.
    const response = await request(app).post('/api/push/apns-token').set('User-Agent', 'fixture')
      .send({ token: 'device', platform: 'android', environment: 'sandbox', pushKey: 'key' });

    // Then the upstream platform, environment and sealing key survive registration.
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ ok: true });
    expect(registrations).toEqual([['cookie-session', 'device', 'fixture', 'android', 'sandbox', 'key']]);
  });

  it.each([false, true])('reports localOnly=%s without caching the policy answer', async (localOnly) => {
    // Given the server's current paired-client policy.
    const { app } = makeApp(localOnly);

    // When the phone asks before requesting push permission.
    const response = await request(app).get('/api/push/delivery');

    // Then the permission decision uses the uncached server answer.
    expect(response.status).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.body).toEqual({ localOnly });
  });
});
