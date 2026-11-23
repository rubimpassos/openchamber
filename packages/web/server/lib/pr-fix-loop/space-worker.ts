import crypto from 'node:crypto';
import { z } from 'zod';
import { createCodeOut } from '../spaces/code-out.js';
import { buildExtUrl, createTransferSession } from '../spaces/code-transfer.js';
import { IMAGE_GIT, requireSpaceProjectPath } from '../spaces/layout.js';
import { createSpaceRecords } from '../spaces/space-records.js';
import { requireApprovalModel } from '../spaces/approval-profile.js';
import { createTokenSnapshotReader } from './token-usage.js';
import { approvalError, commitSchema, workerModelSchema } from './approval-contract.js';
import { completedTurnResult, RECENT_MESSAGE_LIMIT } from './completed-turn.js';
import type { Worker } from './approval-contract.js';
import type { GitServices, HeadSnapshot, IterationItem, WorkerLoop, WorkerLoopInput, WorkerPreparation } from './contracts.js';
import type { HeadTransferTarget } from './agent-head-transfer.js';
import type { HostGit } from '../spaces/code-transfer.js';
import type { CodeOutPlace } from '../spaces/code-out-contracts.js';
import type { InsideRequest, InsideResponse } from '../spaces/dispatcher.js';
import type { createAgentUpstream } from '../agent-server/agent-upstream.js';

type WorkerHost = {
  readonly dispatcher: { requestInside(id: string, request: InsideRequest): Promise<InsideResponse> };
  readonly manager: CodeOutPlace & { verify(id: string): Promise<readonly unknown[]> };
  readonly journey: {
    createSpace(input: { readonly projectDirectory: string; readonly name: string | undefined; readonly placeId: string | undefined;
      readonly start: 'clean'; readonly purpose: 'pr-fix-loop-approval'; readonly approvalModel: { readonly providerID: string; readonly modelID: string };
      readonly network: { readonly mode: 'allowlist'; readonly domains: string[] }; readonly setupCommands: string[] }): Promise<{ readonly id: string }>;
    listSpaces(options: { readonly access: boolean }): Promise<readonly { readonly id: string; readonly purpose?: string | undefined;
      readonly damaged?: boolean; readonly state: string; readonly access: string | null; readonly needsAccess: readonly string[] }[]>;
    stopSpace(id: string): Promise<unknown>; startSpace(id: string): Promise<unknown>;
  };
};
type SpaceWorkerOptions = { readonly dataDir: string; readonly getHost: () => WorkerHost | null;
  readonly git: HostGit | null; readonly gitServices: () => Pick<GitServices, 'fetchHead'>;
  readonly readHostSession: (id: string) => Promise<unknown>;
  readonly seedHead?: ((loop: WorkerLoop, snapshot: HeadSnapshot, target: HeadTransferTarget) => Promise<unknown>) | null;
  readonly upstream?: ReturnType<typeof createAgentUpstream> | null };

const PURPOSE = 'pr-fix-loop-approval';
const sessionSchema = z.object({ data: z.object({ id: z.string().regex(/^ses_[A-Za-z0-9]{1,64}$/) }) });
const queueSchema = z.object({ sessions: z.array(z.object({
  sessionId: z.string(), items: z.array(z.object({ id: z.string() })), sendingId: z.string().nullable(),
})) });
const activeSchema = z.object({ data: z.record(z.string(), z.object({ type: z.enum(['busy', 'retry', 'idle']) })) });

function requireWorker(loop: WorkerLoopInput): asserts loop is WorkerLoop {
  if (!loop.worker) throw approvalError('A protected worker is required.');
}

/** Only the space id selects transport. Responses from inside never select host auth or a host operation. */
export function createSpaceWorker({ dataDir, getHost, git, gitServices, readHostSession, seedHead = null, upstream = null }: SpaceWorkerOptions) {
  const records = createSpaceRecords({ dataDir });
  const host = () => {
    const current = getHost();
    if (!current) throw approvalError('Enable isolated spaces explicitly before preparing an approval worker.');
    return current;
  };
  const request = async (worker: Worker, requestPath: string, { method = 'GET', body }: { readonly method?: string; readonly body?: unknown } = {}): Promise<unknown> => {
    const headers: Record<string, string> = { accept: 'application/json' };
    if (body) headers['content-type'] = 'application/json';
    const response = await host().dispatcher.requestInside(worker.spaceId, {
      method, path: requestPath, timeoutMs: 15_000,
      headers,
      body: body === undefined ? null : JSON.stringify(body),
    });
    const deadline = setTimeout(() => response.destroy(approvalError('The worker response timed out.')), 15_000);
    try {
      let size = 0;
      const chunks: Buffer[] = [];
      for await (const chunk of response) {
        size += chunk.length;
        if (size > 8 * 1024 * 1024) throw approvalError('The worker response exceeded its limit.');
        chunks.push(chunk);
      }
      if (response.statusCode < 200 || response.statusCode >= 300) throw approvalError(`Worker request failed with status ${response.statusCode}.`);
      const text = Buffer.concat(chunks).toString('utf8');
      return text === '' ? null : JSON.parse(text);
    } finally { clearTimeout(deadline); response.destroy(); }
  };
  const validate = async (worker: Worker, { running = true, access = true, checkParent = false } = {}) => {
    const current = host();
    if (checkParent) {
      const parent = z.object({ id: z.string(), location: z.object({ directory: z.string() }) }).parse(await readHostSession(worker.parentSessionId));
      if (parent.id !== worker.parentSessionId || parent.location.directory !== worker.directory) {
        throw approvalError('The original host session moved or is unavailable.');
      }
    }
    const { record } = records.read(worker.spaceId);
    const selectedModel = workerModelSchema.parse(requireApprovalModel(PURPOSE, { providerID: worker.model.providerID, modelID: worker.model.modelID }));
    if (!record || record.purpose !== PURPOSE || record.repository !== worker.directory
      || record.approvalModel?.providerID !== selectedModel.providerID || record.approvalModel?.modelID !== selectedModel.modelID
      || record.network.mode !== 'allowlist' || record.network.domains.length !== 0) {
      throw approvalError('A freshly prepared protected approval worker is required.');
    }
    const listed = (await current.journey.listSpaces({ access })).find((space) => space.id === worker.spaceId);
    if (!listed || listed.purpose !== PURPOSE || listed.damaged || (running && listed.state !== 'running')) {
      throw approvalError('The protected worker is unavailable. Start or repair its space before resuming.');
    }
    if ((await current.manager.verify(worker.spaceId)).length !== 0) throw approvalError('The worker isolation could not be verified.');
    const selectedGrant = record.grants.find((grant) => 'provider' in grant && grant.provider === worker.model.providerID);
    if (access && (!selectedGrant || !['granted', 'needs_access'].includes(listed.access ?? '')
      || listed.needsAccess.includes(selectedGrant.id))) {
      throw approvalError('Explicitly grant the selected model to this worker before activation.');
    }
    return record;
  };
  const readTurn = (worker: Worker) => completedTurnResult((cursor) => request(worker,
    `/api/session/${worker.sessionId}/message?limit=${RECENT_MESSAGE_LIMIT}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`));
  return {
    async prepare({ parentSessionId, directory, model, name, placeId }: WorkerPreparation): Promise<Worker> {
      const parsed = workerModelSchema.safeParse(model);
      if (!parsed.success) throw approvalError('Select an explicit provider and model for the worker.', 400);
      const selected = parsed.data;
      let approvalModel;
      try { approvalModel = workerModelSchema.parse(requireApprovalModel(PURPOSE, { providerID: selected.providerID, modelID: selected.modelID })); }
      catch (error) { throw approvalError(error instanceof Error ? error.message : String(error), 400); }
      const parent = z.object({ id: z.string(), location: z.object({ directory: z.string() }) }).parse(await readHostSession(parentSessionId));
      if (parent.id !== parentSessionId || parent.location.directory !== directory || directory.startsWith('/spaces/')) {
        throw approvalError('Prepare the worker from its original host session and directory.');
      }
      const space = await host().journey.createSpace({ projectDirectory: directory, name, placeId,
        start: 'clean', purpose: PURPOSE, approvalModel, network: { mode: 'allowlist', domains: [] }, setupCommands: [] });
      return { id: crypto.randomUUID(), spaceId: space.id, parentSessionId, directory, model: selected, sessionId: null, spacePath: null };
    },
    validate,
    async initialize(loop: WorkerLoopInput, snapshot: HeadSnapshot) {
      requireWorker(loop);
      const worker = loop.worker;
      const record = await validate(worker);
      if (worker.sessionId) return worker;
      const spacePath = requireSpaceProjectPath(worker.spaceId, record.spacePath);
      const head = commitSchema.parse(snapshot.headSha);
      // Fetch the provider-resolved PR head even when this checkout has no local branch or object.
      if (seedHead) await seedHead(loop, snapshot, { manager: host().manager, spaceId: worker.spaceId, spacePath });
      else {
        if (!git) throw approvalError('Local approval worker Git is unavailable.');
        const { withHostGit } = createTransferSession({ git, temporaryDirectory: dataDir, name: 'approval worker' });
        await gitServices().fetchHead(loop, snapshot);
        await withHostGit('approval_seed_failed', async (g) => {
          const url = buildExtUrl([...(await host().manager.execArgv(worker.spaceId)), IMAGE_GIT, 'receive-pack', spacePath]);
          await g.output(worker.directory, ['-c', 'protocol.ext.allow=always', 'push', '--no-verify', '--', url,
            `${head}:refs/heads/openchamber-fix-loop`], { timeoutMs: 300_000, killTree: true });
        });
      }
      const checkout = await host().manager.exec(worker.spaceId, [IMAGE_GIT, '-C', spacePath, 'checkout', '--force', '--detach', head], { timeoutMs: 60_000 });
      if (checkout.code !== 0) throw approvalError('The PR head could not be checked out inside the worker.');
      const created = sessionSchema.parse(await request(worker, '/api/session', { method: 'POST', body: {
        title: `Fix loop #${loop.number}`, location: { directory: spacePath },
        metadata: { openchamber: { fixLoop: { loopId: loop.id, hostSessionId: loop.sessionId, spaceId: worker.spaceId } } },
      } }));
      if (created.data.id === loop.sessionId) throw approvalError('The worker returned an invalid session identity.');
      return { ...worker, sessionId: created.data.id, spacePath };
    },
    async enqueue(loop: WorkerLoopInput, item: IterationItem) {
      requireWorker(loop);
      await validate(loop.worker);
      // The worker's turn stays an ordinary message: its turn reader uses the latest user message as the boundary.
      const { origin: _origin, notice: _notice, ...message } = item;
      const response = await request(loop.worker, `/api/message-queue/sessions/${loop.worker.sessionId}/items`, {
        method: 'POST', body: { directory: loop.worker.spacePath, item: { ...message, sendConfig: loop.worker.model } },
      });
      z.object({ itemId: z.string().min(1) }).parse(response);
    },
    async working(loop: WorkerLoopInput) {
      requireWorker(loop);
      await validate(loop.worker);
      const queue = queueSchema.parse(await request(loop.worker, '/api/message-queue'));
      if (queue.sessions.some((session) => session.items.length > 0 || session.sendingId !== null)) return true;
      const active = activeSchema.parse(await request(loop.worker, '/api/session/active'));
      if (Object.values(active.data).some((status) => status.type !== 'idle')) return true;
      return await readTurn(loop.worker) === null;
    },
    async usage(loop: WorkerLoopInput) {
      requireWorker(loop);
      const reader = createTokenSnapshotReader({
        buildOpenCodeUrl: (pathname) => `http://worker.invalid${pathname}`,
        getOpenCodeAuthHeaders: () => ({}),
        fetchImpl: async (url, { signal }) => {
          signal.throwIfAborted();
          const parsed = new URL(url);
          const body = await request(loop.worker, `${parsed.pathname}${parsed.search}`);
          signal.throwIfAborted();
          return Response.json(body);
        },
      });
      return reader(String(loop.worker.sessionId), loop.worker.spacePath, { since: loop.createdAt });
    },
    async export(loop: WorkerLoopInput) {
      requireWorker(loop);
      const record = await validate(loop.worker);
      return createCodeOut({ git, place: host().manager, temporaryDirectory: dataDir, upstream: upstream ?? undefined, dataDir }).bringCodeOut({
        repository: loop.worker.directory, spaceId: loop.worker.spaceId, spacePath: requireSpaceProjectPath(loop.worker.spaceId, record.spacePath),
      });
    },
    async reviewResult(loop: WorkerLoopInput) {
      requireWorker(loop);
      const assistant = await readTurn(loop.worker);
      if (!assistant) throw approvalError('The worker assistant result has not completed.');
      return assistant.content.filter((part) => part.type === 'text').map((part) => part.text).join('\n');
    },
    async stop(loop: WorkerLoopInput) {
      requireWorker(loop);
      // Stop both containers from the trusted manager, even when the server inside lies or is dead.
      await host().journey.stopSpace(loop.worker.spaceId);
    },
    async resume(loop: WorkerLoopInput) {
      requireWorker(loop);
      await validate(loop.worker, { running: false, access: false, checkParent: true });
      await host().journey.startSpace(loop.worker.spaceId);
      await validate(loop.worker);
    },
  };
}
