import express from 'express';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';

import { registerSessionInterruptionRoutes } from './routes.js';

const createApp = (continueManually) => {
  const app = express();
  registerSessionInterruptionRoutes(app, { autoResumeRuntime: { continueManually } });
  return app;
};

describe('restart-resume route', () => {
  it('continues the record it names', async () => {
    const continueManually = vi.fn(async () => 'sent');
    const response = await request(createApp(continueManually))
      .post('/api/openchamber/sessions/ses_1/restart-resume')
      .send({ at: 5, directory: '/repo' })
      .expect(200);

    expect(response.body).toEqual({ outcome: 'sent' });
    expect(continueManually).toHaveBeenCalledWith({ sessionId: 'ses_1', directory: '/repo', at: 5 });
  });

  it('answers 409 when the record changed and 502 when OpenCode did not take the message', async () => {
    await request(createApp(vi.fn(async () => 'conflict'))).post('/api/openchamber/sessions/ses_1/restart-resume').send({ at: 5 }).expect(409);
    await request(createApp(vi.fn(async () => 'send-failed'))).post('/api/openchamber/sessions/ses_1/restart-resume').send({ at: 5 }).expect(502);
  });

  it('rejects a body without the record time', async () => {
    const continueManually = vi.fn();
    await request(createApp(continueManually)).post('/api/openchamber/sessions/ses_1/restart-resume').send({}).expect(400);
    expect(continueManually).not.toHaveBeenCalled();
  });
});
