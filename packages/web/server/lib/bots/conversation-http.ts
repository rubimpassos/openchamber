import express from 'express';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { RequestHandler } from '../shared/http-contracts.js';
import type { BotsRuntime } from './runtime.js';
import { runtimeError } from './runtime/errors.js';
import { registerMessageQueueRoutes } from '../message-queue/runtime.js';
import type { createMessageQueueRuntime } from '../message-queue/runtime.js';

const fields = z.object({ id: z.string().optional(), text: z.string().optional() }).passthrough();
const failure = z.object({ code: z.string(), status: z.number().optional(), statusCode: z.number().optional() });
type Owner = Pick<BotsRuntime, 'isConversationSession' | 'dispatchConversationNative' | 'stopConversationSession'>;
type Options = { readonly runtime: Owner; readonly assertStarted: () => void;
  readonly queue?: ReturnType<typeof createMessageQueueRuntime> | null | undefined };

export function createBotConversationHttpGuard({ runtime, assertStarted, queue }: Options): RequestHandler {
  const json = express.json({ limit: '4mb' });
  const queueRoutes = express();
  queueRoutes.use(express.json({ limit: '40mb' }));
  if (queue) registerMessageQueueRoutes(queueRoutes, queue);
  return async (req, res, next) => {
    const url = new URL(req.originalUrl || req.url, 'http://localhost');
    const queueMatch = /^\/api\/message-queue\/sessions\/([^/]+)(\/.*)?$/i.exec(url.pathname);
    const match = queueMatch ?? /^\/api\/(?:(?:experimental\/)?session|openchamber\/sessions)\/([^/]+)(\/.*)?$/i.exec(url.pathname);
    if (!match?.[1] || req.method === 'GET' || req.method === 'HEAD') return next();
    const sessionId = decodeURIComponent(match[1]);
    try {
      if (!await runtime.isConversationSession(sessionId)) return next();
      assertStarted();
      if (queueMatch) {
        if (!queue) throw runtimeError('BOT_CONVERSATION_QUEUE_UNAVAILABLE', 503);
        return queueRoutes(req, res, next);
      }
      const suffix = (match[2] ?? '').toLowerCase();
      if (suffix === '/interrupt' && req.method === 'POST') return res.json(await runtime.stopConversationSession(sessionId));
      if (!['/prompt', '/command', '/synthetic', '/model', '/agent'].includes(suffix) || req.method !== 'POST') {
        throw runtimeError('BOT_CONVERSATION_CONTROL_OWNED', 403);
      }
      await new Promise<void>((resolve, reject) => json(req, res, (error) => error ? reject(error) : resolve()));
      const body = fields.parse(req.body);
      const operationId = z.string().min(1).max(512).optional().parse(req.get('x-openchamber-operation-id')) ?? body.id ?? randomUUID();
      const encodedDirectory = req.get('x-opencode-directory');
      const directory = encodedDirectory === undefined ? url.searchParams.get('location[directory]') ?? url.searchParams.get('directory') ?? undefined
        : decodeURIComponent(encodedDirectory);
      const operation = z.enum(['prompt', 'command', 'synthetic', 'model', 'agent']).parse(suffix.slice(1));
      const reply = await runtime.dispatchConversationNative({ sessionId, directory, operationId, operation, payload: body, text: body.text });
      if (reply.status === 204) return res.status(204).end();
      return res.json({ data: reply.data });
    } catch (error) {
      const parsed = failure.safeParse(error);
      if (!parsed.success && !(error instanceof z.ZodError)) return next(error);
      const status = parsed.success ? parsed.data.status ?? parsed.data.statusCode ?? 409 : 400;
      return res.status(status).json({ code: parsed.success ? parsed.data.code : 'BOT_INVALID_REQUEST' });
    }
  };
}
