import express from 'express';
import { z } from 'zod';

const continueSchema = z.object({
  directory: z.string().max(4_096).optional(),
  at: z.number().int(),
});

const STATUS_BY_OUTCOME = { sent: 200, conflict: 409, 'send-failed': 502 };

/**
 * `POST /api/openchamber/sessions/:sessionId/restart-resume`: the restart
 * notice's Continue. Registered before the OpenCode proxy.
 */
export const registerSessionInterruptionRoutes = (app, { autoResumeRuntime }) => {
  app.post('/api/openchamber/sessions/:sessionId/restart-resume', express.json({ limit: '16kb' }), async (req, res) => {
    const body = continueSchema.safeParse(req.body ?? {});
    if (!body.success) return res.status(400).json({ error: 'Expected { at, directory? }' });
    try {
      const outcome = await autoResumeRuntime.continueManually({
        sessionId: req.params.sessionId,
        directory: body.data.directory ?? '',
        at: body.data.at,
      });
      return res.status(STATUS_BY_OUTCOME[outcome]).json({ outcome });
    } catch (error) {
      console.error('[session-interruption] continue failed:', error);
      return res.status(500).json({ error: 'Could not continue the session' });
    }
  });
};
