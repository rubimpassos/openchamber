import { z } from 'zod';
import { normalizeConfig, registerFixLoopRoutes, sendFixLoopCreateError } from '../pr-fix-loop/runtime.js';
import { agentFixLoopSchema } from './fix-loop-event-schema.js';
import { FIX_LOOP_BYTES, FIX_LOOP_ROUTE, fixLoopServiceError, readContextSchema, targetSchema } from './fix-loop-contract.js';
import { readBoundedBody } from './agent-upstream.js';
import { stripCredentialQuery } from '../spaces/dispatcher.js';
import { isAgentPayloadAllowed } from './session-boundary.js';
import type { Request, Response, Router } from '../shared/http-contracts.js';
import type { createFixLoopRuntime } from '../pr-fix-loop/runtime.js';
import type { Config, PublicLoop } from '../pr-fix-loop/contracts.js';
import type { OutgoingHttpHeaders } from 'node:http';
import type { AgentFixLoop } from './fix-loop-event-schema.js';
import type { createAgentFixLoopServices } from './fix-loop-services.js';
import type { createAgentUpstream } from './agent-upstream.js';
import { errorCode, errorField } from '../pr-fix-loop/errors.js';

type FrontDoorRuntime = Pick<ReturnType<typeof createFixLoopRuntime>, 'load' | 'list' | 'ownsIdentity' | 'ownsLoop' | 'create' | 'prepareWorker'
  | 'listPreparedWorkers' | 'forgetPreparedWorker' | 'update' | 'stopLoop' | 'refresh' | 'resume' | 'approve' | 'remove'>;
type AgentLoopBoundary = { readonly runtime: Pick<FrontDoorRuntime, 'ownsIdentity'>;
  readonly isSpaceSession: (id: string) => boolean; readonly logger?: Pick<Console, 'warn'> };
type Upstream = Pick<ReturnType<typeof createAgentUpstream>, 'request' | 'json'>;
type WithCreation = <Result>(work: () => Result | PromiseLike<Result>) => Promise<Result>;
export type FrontDoorFixLoopRoutesOptions = {
  readonly runtime: FrontDoorRuntime; readonly services: Pick<ReturnType<typeof createAgentFixLoopServices>, 'admit'>;
  readonly upstream: Upstream; readonly readDefaults: () => Promise<Partial<Config>>;
  readonly listProjectDirectories: () => Promise<readonly string[]>;
  readonly isSpaceSession?: (id: string) => boolean;
  readonly logger?: Pick<Console, 'warn'>; readonly withCreation?: WithCreation;
};

const agentList = z.object({ loops: z.array(z.unknown()).max(100) });
const ok = z.object({ ok: z.literal(true) });
const TERMINAL = new Set(['ready', 'stopped', 'closed', 'limitReached', 'budgetReached', 'error']);
const reserves = (loop: AgentFixLoop | PublicLoop) => !TERMINAL.has(loop.status) || Boolean(loop.pendingApproval)
  || Boolean(loop.review && loop.review.state !== 'complete');
const cleanAgentLoops = (raw: z.infer<typeof agentList>, { runtime, isSpaceSession, logger = console }: AgentLoopBoundary) => {
  const parsed = raw.loops.map((value) => agentFixLoopSchema.safeParse(value).data ?? null);
  const counts = new Map<string, number>();
  for (const loop of parsed) if (loop) counts.set(loop.id, (counts.get(loop.id) ?? 0) + 1);
  const loops = parsed.filter((loop): loop is AgentFixLoop => loop !== null && counts.get(loop.id) === 1 && !runtime.ownsIdentity(loop.id)
    && isAgentPayloadAllowed(loop, isSpaceSession));
  if (loops.length < parsed.length) logger.warn?.(`[pr-fix-loop] ${parsed.length - loops.length} fix loops of the agent server were left out of the list`);
  return loops;
};

export async function assertAgentBotWatchAvailable({ upstream, runtime, isSpaceSession = () => false, input }: {
  readonly upstream: Pick<Upstream, 'json'>; readonly runtime: AgentLoopBoundary['runtime'];
  readonly isSpaceSession?: (id: string) => boolean;
  readonly input: Pick<PublicLoop, 'sessionId' | 'owner' | 'repo' | 'number'>;
}) {
  const loops = cleanAgentLoops(agentList.parse(await upstream.json(FIX_LOOP_ROUTE)), { runtime, isSpaceSession });
  if (loops.some((loop) => reserves(loop) && (loop.sessionId === input.sessionId
    || loop.owner.toLowerCase() === input.owner.toLowerCase() && loop.repo.toLowerCase() === input.repo.toLowerCase() && loop.number === input.number))) {
    throw Object.assign(new Error('This session or pull request is owned by another automation.'), {
      code: 'fix_loop_automation_conflict', statusCode: 409,
    });
  }
}
const createBody = targetSchema.extend({ sessionId: z.string().regex(/^ses_[A-Za-z0-9]{1,128}$/),
  config: z.record(z.string(), z.unknown()).optional(), workerId: z.string().uuid().optional(),
  name: z.string().min(1).max(128).optional(), placeId: z.string().min(1).max(64).optional(),
  model: z.unknown().optional() }).strip();

export function createFrontDoorFixLoopAdmission() {
  let pending: Promise<unknown> = Promise.resolve();
  return <Result>(work: () => Result | PromiseLike<Result>): Promise<Result> => {
    const operation = pending.then(work);
    pending = operation.catch(() => {});
    return operation;
  };
}

export function registerFrontDoorFixLoopRoutes(app: Router, { runtime, services, upstream, readDefaults, listProjectDirectories,
  isSpaceSession = () => false, logger = console, withCreation = createFrontDoorFixLoopAdmission() }: FrontDoorFixLoopRoutesOptions) {
  type AgentRequest = Pick<Request, 'method' | 'originalUrl'> & { readonly body?: unknown };
  const requestAgent = async <Schema extends z.ZodType>({ method, originalUrl, body: payload }: AgentRequest, schema: Schema): Promise<z.output<Schema>> => {
    const url = new URL(originalUrl, 'http://front');
    stripCredentialQuery(url);
    const body = ['GET', 'HEAD', 'DELETE'].includes(method ?? '') ? undefined : JSON.stringify(payload ?? {});
    const headers: OutgoingHttpHeaders = { accept: 'application/json' };
    if (body) headers['content-type'] = 'application/json';
    const response = await upstream.request({ method, path: `${url.pathname}${url.search}`, body, headers, timeoutMs: 30_000 });
    let value: unknown;
    try { value = JSON.parse(await readBoundedBody(response, FIX_LOOP_BYTES)); }
    catch { throw fixLoopServiceError('agent_fix_loop_invalid_response'); }
    if (response.statusCode !== 200) throw fixLoopServiceError('agent_fix_loop_operation_failed',
      response.statusCode >= 400 && response.statusCode <= 599 ? response.statusCode : 502);
    const parsed = schema.safeParse(value);
    if (!parsed.success) throw fixLoopServiceError('agent_fix_loop_invalid_response');
    return parsed.data;
  };
  const agentLoops = async (req: AgentRequest = { method: 'GET', originalUrl: FIX_LOOP_ROUTE }) => {
    return cleanAgentLoops(await requestAgent(req, agentList), { runtime, isSpaceSession, logger });
  };
  const forward = async (req: Request, res: Response, suffix: string) => {
    const response = await requestAgent(req, req.method === 'DELETE' ? ok : z.object({ loop: agentFixLoopSchema }));
    const expectedId = suffix.split('/')[1];
    if ('loop' in response && (runtime.ownsIdentity(response.loop.id) || !isAgentPayloadAllowed(response.loop, isSpaceSession)
      || expectedId && response.loop.id !== expectedId)) {
      throw fixLoopServiceError('agent_fix_loop_invalid_response');
    }
    return res.json(response);
  };
  const createLocally = async (req: Request, { prepareWorker = false }: { readonly prepareWorker?: boolean } = {}) => {
    const parsedBody = createBody.safeParse(req.body);
    if (!parsedBody.success) throw fixLoopServiceError('agent_fix_loop_invalid_request', 400);
    const body = parsedBody.data;
    const query = new URL(req.originalUrl, 'http://front').searchParams;
    const allowed = ['directory', 'repositoryId', 'provider', 'instance', 'accountId', 'bindingRevision', 'primaryRemote', 'linked'];
    if ([...query.keys()].some((key) => !allowed.includes(key) || query.getAll(key).length !== 1)
      || query.has('linked') && query.get('linked') !== '1') throw fixLoopServiceError('agent_fix_loop_invalid_request', 400);
    type LinkedQuery = { linked?: true };
    const linked: LinkedQuery = {};
    if (query.get('linked') === '1') linked.linked = true;
    const contextInput = { provider: query.get('provider') ?? 'github', instance: query.get('instance') ?? 'github.com',
      accountId: query.get('accountId'), directory: query.get('directory'), repositoryId: query.get('repositoryId'),
       bindingRevision: query.has('bindingRevision') ? Number(query.get('bindingRevision')) : -1, primaryRemote: query.get('primaryRemote'), ...linked };
    const parsedContext = readContextSchema.safeParse(contextInput);
    if (!parsedContext.success) throw fixLoopServiceError('agent_fix_loop_invalid_request', 400);
    const context = parsedContext.data;
    if (!(await listProjectDirectories()).includes(context.directory)) throw fixLoopServiceError('agent_project_unregistered', 403);
    const admitted = await services.admit({ context, owner: body.owner, repo: body.repo, number: body.number });
    if (prepareWorker) return runtime.prepareWorker({ sessionId: body.sessionId, directory: context.directory,
      model: body.model, name: body.name, placeId: body.placeId });
    type WorkerSelection = { workerId?: string };
    const selectedWorker: WorkerSelection = {};
    if (body.workerId !== undefined) selectedWorker.workerId = body.workerId;
    return runtime.create({ ...admitted.pull, sessionId: body.sessionId, directory: context.directory, accountId: context.accountId,
      readContext: admitted.context, config: body.config, ...selectedWorker });
  };
  const create = async (req: Request, res: Response, target: z.infer<typeof createBody>) => {
    const samePull = (loop: Pick<PublicLoop, 'owner' | 'repo' | 'number'>) => loop.owner.toLowerCase() === target.owner.toLowerCase()
      && loop.repo.toLowerCase() === target.repo.toLowerCase() && loop.number === target.number;
    const local = await runtime.list();
    const existing = local.find((loop) => loop.sessionId === target.sessionId && samePull(loop));
    const mode = existing && reserves(existing) ? null : normalizeConfig(target.config, normalizeConfig(await readDefaults())).pushMode;
    const held = (loops: readonly (PublicLoop | AgentFixLoop)[]) => loops.some((loop) => reserves(loop) && (loop.sessionId === target.sessionId || samePull(loop)));
    if (mode !== null && held(mode === 'approval' ? await agentLoops() : local)) {
      return res.status(409).json({ code: 'fix_loop_automation_conflict', error: 'This session or pull request is owned by another automation.' });
    }
    if (mode !== 'auto') {
      try { return res.json({ loop: await createLocally(req) }); } catch (error) { return sendFixLoopCreateError(res, error); }
    }
    req.body = { ...target, config: { ...target.config, pushMode: 'auto' } };
    return forward(req, res, '');
  };
  app.use(FIX_LOOP_ROUTE, async (req, res, next) => {
    try {
      await runtime.load();
      const suffix = new URL(req.originalUrl, 'http://front').pathname.slice(FIX_LOOP_ROUTE.length).replace(/\/$/, '');
      if (/^\/workers(?:\/|$)/i.test(suffix)) return next();
      if (!suffix) {
        if (req.method === 'GET') return res.json({ loops: [...await runtime.list(), ...await agentLoops(req)] });
        if (req.method !== 'POST') return res.status(405).json({ code: 'fix_loop_method_refused' });
        const parsed = createBody.safeParse(req.body);
        if (!parsed.success || (parsed.data.config?.pushMode !== undefined && parsed.data.config.pushMode !== 'auto' && parsed.data.config.pushMode !== 'approval')) {
          throw fixLoopServiceError('agent_fix_loop_invalid_request', 400);
        }
        let left = false;
        res.once('close', () => { left = !res.writableFinished; });
        return await withCreation(() => (left ? undefined : create(req, res, parsed.data)));
      } else {
        const match = /^\/([^/]+)(?:\/(stop|resume|refresh|approve))?$/.exec(suffix);
        if (!match || match[1] === undefined) return res.status(404).json({ code: 'fix_loop_not_found' });
        if (runtime.ownsLoop(match[1])) return next();
        if (runtime.ownsIdentity(match[1]) || match[2] === 'approve') return res.status(404).json({ code: 'fix_loop_not_found' });
      }
      return await forward(req, res, suffix);
    } catch (error) { return res.status(errorField(error, 'statusCode') ?? 502).json({ code: errorCode(error) ?? 'agent_fix_loop_operation_failed' }); }
  });
  registerFixLoopRoutes(app, { runtime, createWithContext: createLocally });
}
