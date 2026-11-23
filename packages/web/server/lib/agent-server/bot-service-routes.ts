import express from 'express';
import { z } from 'zod';
import type { Router } from '../shared/http-contracts.js';
import { isFunction } from '../shared/guards.js';
import type { BotServiceInput, BotServiceOperation, BotServiceReply } from './bot-service-contract.js';
import { BOT_SERVICE_BYTES, BOT_SERVICE_INPUT_BYTES, BOT_SERVICE_OPERATIONS, BOT_SERVICE_ROUTE,
  botBoundaryError, botReplySchema, botRequestAssociation, isBotServiceOperation } from './bot-service-contract.js';

export { createBotExecutionServices } from '../bots/agent-execution.js';

export interface BotServiceRoutesOptions {
  readonly agentServer?: boolean;
  readonly services: {
    readonly agentServer: true;
    readonly execute: <Operation extends BotServiceOperation>(operation: Operation, input: BotServiceInput<Operation>,
      options: { readonly signal: AbortSignal }) => Promise<BotServiceReply<Operation>>;
  } | null;
}

const failureFieldsSchema = z.object({ code: z.unknown(), state: z.unknown(), status: z.unknown(), statusCode: z.unknown() }).partial();
const publicFailureCodeSchema = z.string().regex(/^(?:BOT_[A-Z0-9_]+|SOURCE_CONTROL_[A-Z0-9_]+|agent_(?:project_unregistered|directory_invalid)|enterprise_mode)$/);
const failureStateSchema = z.enum(['needs-you', 'outcome-unknown', 'failed', 'refused']);
const failureStatusSchema = z.number().int().min(400).max(599);

export function registerBotServiceRoutes(app: Router, { services, agentServer }: BotServiceRoutesOptions) {
  if (agentServer === false) return;
  if (services?.agentServer !== true || !isFunction(services.execute)) throw new TypeError('Bot routes require agent execution services');
  app.use('/api/projects/:projectId/bots', (_req, res) => res.status(403).json({ code: 'BOT_OWNER_REQUIRED' }));
  const parse = express.json({ limit: BOT_SERVICE_INPUT_BYTES });
  app.post(`${BOT_SERVICE_ROUTE}/:operation`, (req, res, next) => {
    res.set('Cache-Control', 'no-store');
    parse(req, res, (error) => error ? res.status(400).json({ code: 'BOT_EXECUTION_INVALID_REQUEST', state: 'failed' }) : next());
  }, async (req, res) => {
    const operation = req.params.operation;
    if (operation === undefined || !isBotServiceOperation(operation)) return res.status(400).json({ code: 'BOT_EXECUTION_INVALID_REQUEST', state: 'failed' });
    const input = BOT_SERVICE_OPERATIONS[operation].input.safeParse(req.body);
    if (!input.success || new URL(req.originalUrl, 'http://agent').search
      || Buffer.byteLength(JSON.stringify(req.body)) > BOT_SERVICE_INPUT_BYTES) {
      return res.status(400).json({ code: 'BOT_EXECUTION_INVALID_REQUEST', state: 'failed' });
    }
    const controller = new AbortController();
    const abort = () => controller.abort();
    req.once('aborted', abort);
    const closed = () => { if (!res.writableEnded) abort(); };
    res.once('close', closed);
    try {
      const result = await services.execute(operation, input.data, { signal: controller.signal });
      const reply = botReplySchema(operation).safeParse({ association: botRequestAssociation(operation, input.data), result });
      if (!reply.success) throw botBoundaryError('BOT_EXECUTION_INVALID_RESPONSE');
      const body = JSON.stringify(reply.data);
      if (Buffer.byteLength(body) > BOT_SERVICE_BYTES) throw botBoundaryError('BOT_EXECUTION_RESPONSE_TOO_LARGE');
      return res.type('json').send(body);
    } catch (error) {
      const parsed = failureFieldsSchema.safeParse(error);
      const fields = parsed.success ? parsed.data : {};
      const code = publicFailureCodeSchema.safeParse(fields.code);
      const state = failureStateSchema.safeParse(fields.state);
      const status = failureStatusSchema.safeParse(fields.status ?? fields.statusCode);
      return res.status(code.success && code.data === 'agent_project_unregistered' ? 403 : status.success ? status.data : 502)
        .json({ code: code.success ? code.data : 'BOT_EXECUTION_FAILED', state: state.success ? state.data : 'needs-you' });
    } finally {
      req.removeListener('aborted', abort); res.removeListener('close', closed);
    }
  });
}
