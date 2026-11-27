import express from 'express';
import { z } from 'zod';
import { sourceCandidateSchema } from './prompts.js';
import { botDefinitionsSchema } from './config.js';
import type { Request, RequestHandler, Router } from '../shared/http-contracts.js';
import type { createBotsRuntime } from './runtime.js';
import type { createBotIdentityStore } from './identities.js';
import type { createAgentBotServices } from '../agent-server/bot-services.js';

type BotRequest = Request<unknown, { projectId: string; botId: string; itemId: string; identityId: string }, { month?: string }>;
type BotHostRoutes = {
  chats(botId: string): Promise<object>;
  ensureMain(botId: string): Promise<object>;
  takeOver(projectId: string, itemId: string): Promise<object>;
};
type BotRoutesOptions = {
  readonly botsRuntime: ReturnType<typeof createBotsRuntime> & Partial<BotHostRoutes>;
  readonly identities: Pick<ReturnType<typeof createBotIdentityStore>, 'list' | 'create' | 'update' | 'remove'>
    | ReturnType<typeof createAgentBotServices>['identities'];
};
type Runtime = BotRoutesOptions['botsRuntime'];
type RouteMethod = 'getDefinitions' | 'saveDefinitions' | 'getProject' | 'getConfig' | 'saveConfig' | 'getItems' | 'detail' | 'getArchive' | 'answer' | 'resume' | 'stopItem' | 'runScheduled' | 'getPolicy' | 'approvePolicy' | 'ensureConversation';
type Identities = BotRoutesOptions['identities'];
type RouteReply = Awaited<ReturnType<Runtime[RouteMethod]>>
  | { readonly identities: Awaited<ReturnType<Identities['list']>> }
  | { readonly identity: Awaited<ReturnType<Identities['create']>> }
  | Awaited<ReturnType<Identities['remove']>>
  | object;
const failureSchema = z.object({ code: z.unknown().optional(), statusCode: z.unknown().optional(), status: z.unknown().optional(),
  message: z.unknown().optional(), pending: z.record(z.string(), z.unknown()).optional() });

const json = express.json({ limit: '256kb' });
const id = z.string().min(1).max(512);
const admission = sourceCandidateSchema.extend({ botId: id });
const answer = z.object({ text: z.string().min(1).max(100_000), eventId: id, questionKey: id.optional() }).strict();
const approval = z.object({ file: id, fingerprint: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
const run = z.object({ occurrence: id.optional() }).strict();
const edit = z.object({ config: z.json() }).strict();
const projectSettings = z.object({ concurrency: z.number().int().positive(), retentionDays: z.number().int().nonnegative() });
const definitionsEdit = z.object({ definitions: botDefinitionsSchema, expectedRevision: z.number().int().nonnegative() }).strict();
const identityEdit = z.object({ expectedRevision: z.number().int().positive(), definition: z.json() }).strict();
const identityDelete = z.object({ expectedRevision: z.number().int().positive() }).strict();
const parse = <Schema extends z.ZodType, Body>(schema: Schema, body: Body): z.output<Schema> => {
  const result = schema.safeParse(body ?? {});
  if (!result.success) throw Object.assign(new Error('Invalid bot request'), { status: 400, code: 'BOT_INVALID_REQUEST' });
  return result.data;
};

export const registerBotRoutes = (app: Router, { botsRuntime, identities }: BotRoutesOptions) => {
  for (const name of ['list', 'create', 'update', 'remove'] as const) if (!(identities?.[name] instanceof Function)) throw new TypeError(`identities.${name} is required`);
  const base = '/api/projects/:projectId/bots';
  const handle = (operation: (req: BotRequest) => Promise<RouteReply>): RequestHandler<unknown, BotRequest['params'], BotRequest['query']> => async (req, res) => {
    try { return res.json(await operation(req)); }
    catch (failure) {
      const parsed = failureSchema.safeParse(failure);
      const fields = parsed.success ? parsed.data : {};
      if (fields.code === 'BOT_DISCOVERY_PENDING' && fields.status === 202) {
        return res.status(202).json({ pending: true, ...fields.pending });
      }
      const candidate = fields.statusCode ?? fields.status;
      const statusCode = z.number().int().min(400).max(599).safeParse(candidate);
      const status = failure instanceof z.ZodError ? 400 : statusCode.success ? statusCode.data : 500;
      return res.status(status).json({ code: fields.code ?? (status === 400 ? 'BOT_INVALID_REQUEST' : 'BOT_REQUEST_FAILED'), error: status >= 500 ? 'Bot request failed. Existing state was preserved.' : failure instanceof z.ZodError ? 'Invalid bot request' : fields.message });
    }
  };
  app.get('/api/bots', handle(() => botsRuntime.getDefinitions()));
  app.put('/api/bots', json, handle((req) => {
    const { definitions, expectedRevision } = parse(definitionsEdit, req.body);
    return botsRuntime.saveDefinitions(definitions, expectedRevision);
  }));
  const unavailable = () => Object.assign(new Error('Unavailable bot route'), { status: 501, code: 'BOT_ROUTE_UNAVAILABLE' });
  const { chats, ensureMain, takeOver } = botsRuntime;
  app.get('/api/bots/:botId/chats', handle(async (req) => { if (!chats) throw unavailable(); return chats(req.params.botId); }));
  app.post('/api/bots/:botId/main', handle(async (req) => { if (!ensureMain) throw unavailable(); return ensureMain(req.params.botId); }));
  app.get(base, handle((req) => botsRuntime.getProject(req.params.projectId)));
  app.get(`${base}/config`, handle((req) => botsRuntime.getConfig(req.params.projectId)));
  app.put(`${base}/config`, json, handle((req) => botsRuntime.saveConfig(req.params.projectId, parse(projectSettings, parse(edit, req.body).config))));
  app.get(`${base}/items`, handle((req) => botsRuntime.getItems(req.params.projectId)));
  app.post(`${base}/items`, json, handle(async (req) => {
    const { botId, ...candidate } = parse(admission, req.body);
    const item = await botsRuntime.admit(req.params.projectId, botId, candidate);
    await botsRuntime.pump(req.params.projectId);
    return botsRuntime.detail(req.params.projectId, item.id);
  }));
  app.get(`${base}/archive`, handle((req) => botsRuntime.getArchive(req.params.projectId, req.query.month)));
  app.get(`${base}/items/:itemId`, handle((req) => botsRuntime.detail(req.params.projectId, req.params.itemId)));
  app.post(`${base}/items/:itemId/conversation`, handle((req) => botsRuntime.ensureConversation(req.params.projectId, req.params.itemId)));
  app.post(`${base}/items/:itemId/answer`, json, handle((req) => {
    const { questionKey, ...input } = parse(answer, req.body);
    let answerOptions: Parameters<Runtime['answer']>[3] = { explicit: true };
    if (questionKey !== undefined) answerOptions = { ...answerOptions, questionKey };
    return botsRuntime.answer(req.params.projectId, req.params.itemId, input, answerOptions);
  }));
  app.post(`${base}/items/:itemId/resume`, handle((req) => botsRuntime.resume(req.params.projectId, req.params.itemId)));
  app.post(`${base}/items/:itemId/stop`, handle((req) => botsRuntime.stopItem(req.params.projectId, req.params.itemId)));
  app.post(`${base}/items/:itemId/take-over`, handle(async (req) => { if (!takeOver) throw unavailable(); return takeOver(req.params.projectId, req.params.itemId); }));
  app.post(`${base}/:botId/run`, json, handle((req) => botsRuntime.runScheduled(req.params.projectId, req.params.botId, parse(run, req.body).occurrence ?? `manual:${Date.now()}`)));
  app.get(`${base}/policy`, handle((req) => botsRuntime.getPolicy(req.params.projectId)));
  app.post(`${base}/policy/approve`, json, handle((req) => botsRuntime.approvePolicy(req.params.projectId, parse(approval, req.body))));
  const checkProject = (req: BotRequest) => botsRuntime.getConfig(req.params.projectId);
  app.get(`${base}/identities`, handle(async (req) => { await checkProject(req); return { identities: await identities.list() }; }));
  app.post(`${base}/identities`, json, handle(async (req) => { await checkProject(req); return { identity: await identities.create(req.body) }; }));
  app.put(`${base}/identities/:identityId`, json, handle(async (req) => {
    await checkProject(req);
    const { expectedRevision, definition } = parse(identityEdit, req.body);
    return { identity: await identities.update(req.params.identityId, expectedRevision, definition) };
  }));
  app.delete(`${base}/identities/:identityId`, json, handle(async (req) => { await checkProject(req); return identities.remove(req.params.identityId, parse(identityDelete, req.body).expectedRevision); }));
};
