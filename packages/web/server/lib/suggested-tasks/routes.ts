import express from 'express';
import { z } from 'zod';
import type { Application, Request, Response } from '../shared/http-contracts.js';
import type { createSuggestedTasksRuntime } from './runtime.js';
import { hasProperties } from '../shared/object-guards.js';

const jsonBody = express.json({ limit: '256kb' });

const approveSchema = z.object({
  action: z.enum(['session', 'worktree', 'draft-pr', 'todo', 'issue', 'draft', 'bot']),
  botId: z.string().min(1).max(512).optional(),
  provider: z.enum(['github', 'gitlab', 'linear']).optional(),
});
const dismissSchema = z.object({ reason: z.string().max(2_000).optional() });
const snoozeSchema = z.object({ until: z.number().int() });
const runSchema = z.object({ lensIds: z.array(z.string().min(1).max(200)).max(50).optional() });
const repoLensSchema = z.object({ file: z.string().min(1).max(4_096), enabled: z.boolean() });

const send = (res: Response, error: unknown) => {
  const statusCode = hasProperties(error) && typeof error.statusCode === 'number' && Number.isInteger(error.statusCode) ? error.statusCode : (hasProperties(error) && typeof error.status === 'number' && Number.isInteger(error.status) ? error.status : 500);
  if (statusCode >= 500) console.error('[suggested-tasks]', error);
  return res.status(statusCode).json({ error: error instanceof Error ? error.message : 'Suggested tasks request failed' });
};

const parseBody = <Schema extends z.ZodType>(schema: Schema, body: unknown): z.output<Schema> => {
  const parsed = schema.safeParse(body ?? {});
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw Object.assign(new Error(`${issue?.path.join('.') || 'body'}: ${issue?.message}`), { statusCode: 400 });
  }
  return parsed.data;
};

/**
 * `/api/projects/:projectId/suggested-tasks/*` and the summary across projects.
 * Registered before the OpenCode proxy; bodies parse here, on these routes only.
 */
export const registerSuggestedTaskRoutes = (app: Application, { suggestedTasksRuntime }: { readonly suggestedTasksRuntime: ReturnType<typeof createSuggestedTasksRuntime> }) => {
  const base = '/api/projects/:projectId/suggested-tasks';
  const handle = (operation: (req: Request<unknown, { projectId: string; runId: string; suggestionId: string }>) => Promise<unknown>) => async (req: Request<unknown, { projectId: string; runId: string; suggestionId: string }>, res: Response) => {
    try {
      return res.json(await operation(req));
    } catch (error) {
      return send(res, error);
    }
  };

  app.get('/api/openchamber/suggested-tasks/summary', handle(async () => ({ projects: await suggestedTasksRuntime.getSummary() })));
  app.get(base, handle((req) => suggestedTasksRuntime.getInbox(req.params.projectId)));
  app.get(`${base}/settings`, handle((req) => suggestedTasksRuntime.getSettings(req.params.projectId)));
  app.put(`${base}/settings`, jsonBody, handle((req) => suggestedTasksRuntime.saveConfig(req.params.projectId, hasProperties(req.body) ? req.body.config : undefined)));
  app.post(`${base}/repo-lenses`, jsonBody, handle((req) => {
    const { file, enabled } = parseBody(repoLensSchema, req.body);
    return suggestedTasksRuntime.setRepoLensEnabled(req.params.projectId, file, enabled);
  }));
  app.post(`${base}/run`, jsonBody, handle((req) => suggestedTasksRuntime.runNow(req.params.projectId, parseBody(runSchema, req.body).lensIds)));
  app.post(`${base}/runs/:runId/stop`, handle(async (req) => {
    await suggestedTasksRuntime.stopRun(req.params.projectId, req.params.runId);
    return { ok: true };
  }));
  app.post(`${base}/items/:suggestionId/approve`, jsonBody, handle(async (req) => ({
    suggestion: await suggestedTasksRuntime.approve(req.params.projectId, req.params.suggestionId, parseBody(approveSchema, req.body)),
  })));
  app.post(`${base}/items/:suggestionId/dismiss`, jsonBody, handle(async (req) => ({
    suggestion: await suggestedTasksRuntime.dismiss(req.params.projectId, req.params.suggestionId, parseBody(dismissSchema, req.body).reason),
  })));
  app.post(`${base}/items/:suggestionId/snooze`, jsonBody, handle(async (req) => ({
    suggestion: await suggestedTasksRuntime.snooze(req.params.projectId, req.params.suggestionId, parseBody(snoozeSchema, req.body).until),
  })));
  app.post(`${base}/items/:suggestionId/restore`, handle(async (req) => ({
    suggestion: await suggestedTasksRuntime.restore(req.params.projectId, req.params.suggestionId),
  })));
};
