import express from 'express';
import type { Application } from '../shared/http-contracts.js';
import { z } from 'zod';
import { NOTIFICATION_CENTER_LIMIT } from './center.js';
import type { NotificationCenterRuntime } from './center.js';

const readBodySchema = z.union([
  z.object({ ids: z.array(z.string().min(1)).min(1).max(NOTIFICATION_CENTER_LIMIT) }).strict(),
  z.object({ sessionId: z.string().min(1) }).strict(),
  z.object({ all: z.literal(true) }).strict(),
]);

const removeBodySchema = z.object({ ids: z.array(z.string().min(1)).min(1).max(NOTIFICATION_CENTER_LIMIT) }).strict();

export function registerNotificationCenterRoutes(app: Pick<Application, 'get' | 'post' | 'delete'>, { notificationCenter }: { notificationCenter: NotificationCenterRuntime }) {
  const json = express.json({ limit: '64kb' });

  app.get('/api/notification-center', async (req, res) => {
    res.json({ entries: await notificationCenter.list({ allKinds: req.query.version === '2' }) });
  });

  app.post('/api/notification-center/read', json, async (req, res) => {
    const body = readBodySchema.safeParse(req.body);
    if (!body.success) {
      return res.status(400).json({ error: 'Send ids, a sessionId, or all: true' });
    }
    return res.json(await notificationCenter.markRead(body.data));
  });

  app.post('/api/notification-center/remove', json, async (req, res) => {
    const body = removeBodySchema.safeParse(req.body);
    if (!body.success) {
      return res.status(400).json({ error: 'Send the ids to remove' });
    }
    return res.json({ ids: await notificationCenter.remove(body.data.ids) });
  });

  app.delete('/api/notification-center', async (_req, res) => {
    await notificationCenter.clear();
    res.json({ ok: true });
  });
}
