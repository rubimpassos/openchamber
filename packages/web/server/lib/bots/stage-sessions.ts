import { z } from 'zod';
import { readDispatchOutcome } from '../dispatch-results/runtime.js';
import { scanPermissions } from '../suggested-tasks/runtime.js';
import { mcpToolAliasName } from '../agent-tool/mcp-alias.js';
import { unwrapOpenCodeResponse } from '../opencode/response-envelope.js';
import type { DispatchOutcome } from '../dispatch-results/runtime.js';
import type { createOpenChamberSessionService } from '../openchamber-sessions/routes.js';
import type { SessionActivityProbe } from '../opencode/session-activity.js';
import type { PermissionAutoAcceptRuntime } from '../permission-auto-accept/runtime.js';
import type { createSessionKnowledgeRuntime } from '../session-knowledge/runtime.js';
import type { createTokenSnapshotReader } from '../pr-fix-loop/token-usage.js';
import type { SessionClient } from '../openchamber-sessions/opencode-client-contract.js';
import type { BotDefinition } from './config.js';
import type { JsonValue } from '../shared/json-values.js';

const selectionSchema = z.object({ providerID: z.string().min(1), modelID: z.string().min(1), variant: z.string().optional(), agent: z.string().optional() });
export const stageExecutionSelectionSchema = selectionSchema.passthrough();
export const stageProviderSelectionSchema = selectionSchema.pick({ providerID: true }).passthrough();
const pageSchema = z.object({ data: z.array(z.json()) });
const sessionIdSchema = z.string().min(1);
const createdSchema = z.object({ sessionId: sessionIdSchema, directory: z.string().min(1) });
const recoverySchema = z.object({ metadata: z.object({ openchamber: z.object({ automation: z.object({
  source: z.literal('bot'), itemId: z.string(), stage: z.string(), botId: z.string(),
}) }) }) });

type Stage = keyof BotDefinition['models'];
export type BotStageSelectionInput = JsonValue | BotDefinition['models'][Stage] | z.output<typeof selectionSchema> | undefined;
type Created = z.output<typeof createdSchema>;
type Receipt = { readonly id: string; readonly sessionId: string };
type StageOutcome = Readonly<Pick<DispatchOutcome, 'state' | 'text'>> & { readonly errorMessage?: string | undefined; readonly tokens?: number | undefined };
type StageRequest = {
  readonly projectId: string;
  readonly itemId: string;
  readonly bot: BotDefinition;
  readonly stage: Stage;
  readonly directory: string;
  readonly selection?: BotStageSelectionInput;
  readonly prompt: string;
  readonly dispatchedAt: number;
  readonly afterIdleId?: string | null | undefined;
  readonly sessionId?: string | undefined;
};
type RunningRequest = StageRequest & { readonly sessionId: string };
type OutcomeRequest = Omit<StageRequest, 'selection' | 'prompt'>;
type ReconcileRequest = OutcomeRequest & { readonly prompt?: string | undefined };
type CreateRequest = ReconcileRequest & Pick<StageRequest, 'selection'>;
type ResumeRequest = Pick<StageRequest, 'projectId' | 'itemId' | 'directory' | 'bot' | 'stage'> & {
  readonly sessionId: string;
  readonly selection?: BotStageSelectionInput;
};
type SessionRequest = Pick<StageRequest, 'directory' | 'sessionId'> & {
  readonly bot: { readonly id: string; readonly isolated?: boolean };
};
type ReconcileArgs = [kind: 'session.create' | 'session.prompt', request: ReconcileRequest, recordedSessionId?: string];
type Reconciliation = { readonly state: 'succeeded'; readonly result: Receipt } | { readonly state: 'outcome-unknown' };
type OnCreated = (created: Created) => Promise<void>;
type StagePrompt = {
  readonly directory: string;
  readonly prompt: string;
  readonly model: string;
  agent?: string;
  variant?: string;
  goal?: boolean;
  goalTokenBudget?: number;
};
type StageSessionsOptions = {
  readonly sessionService: Pick<ReturnType<typeof createOpenChamberSessionService>, 'create' | 'send'>;
  readonly clientFor: (directory: string) => {
    readonly session: Pick<SessionClient['session'], 'update' | 'get' | 'interrupt'>;
    readonly message: Pick<SessionClient['message'], 'list'>;
  };
  readonly permissionAutoAcceptRuntime: Pick<PermissionAutoAcceptRuntime, 'setSessionPolicy'>;
  readonly sessionKnowledgeRuntime: Pick<ReturnType<typeof createSessionKnowledgeRuntime>, 'sync'>;
  readonly activityProbe: Pick<SessionActivityProbe, 'fetchActiveSessionStatuses' | 'hasWorkingChildren'>;
  readonly readSessionDefaults: (projectId: string) => Promise<JsonValue | undefined>;
  readonly readTokenSnapshot: ReturnType<typeof createTokenSnapshotReader>;
  readonly isolated: {
    readonly create: (request: Omit<CreateRequest, 'selection'> & { readonly selection: z.output<typeof stageProviderSelectionSchema> }, onCreated: OnCreated) => Promise<Created>;
    readonly dispatch: (request: StageRequest & { readonly selection: z.output<typeof stageExecutionSelectionSchema> }) => Promise<Receipt>;
    readonly outcome: (request: OutcomeRequest) => Promise<StageOutcome | null>;
    readonly reconcile: (...args: ReconcileArgs) => Promise<Reconciliation>;
    readonly stop: (request: SessionRequest) => Promise<void>;
    readonly resume?: (request: Omit<ResumeRequest, 'selection'> & { readonly selection: z.output<typeof stageProviderSelectionSchema> }) => Promise<void>;
  };
};

export const botStagePermissions = (stage: Stage, bot: BotDefinition): ReturnType<typeof scanPermissions> => {
  if (stage !== 'fixing') return scanPermissions(bot.web, bot.mcp);
  const rules: ReturnType<typeof scanPermissions> = [
    { action: '*_*', resource: '*', effect: 'deny' },
    { action: 'apply_patch', resource: '*', effect: 'allow' },
    { action: 'openchamber_bot', resource: '*', effect: 'allow' },
  ];
  for (const { server, tools } of bot.correctionMcp) {
    for (const [tool, effect] of Object.entries(tools)) {
      const action = `${server.replace(/[^A-Za-z0-9_-]/g, '_')}_${tool.replace(/[^A-Za-z0-9_-]/g, '_')}`;
      if (!action.startsWith('openchamber_')) rules.push(
        { action, resource: '*', effect },
        { action: mcpToolAliasName(action), resource: '*', effect },
      );
    }
  }
  return [...rules,
    { action: 'shell', resource: 'gh *', effect: 'deny' },
    { action: 'shell', resource: 'git push*', effect: 'deny' },
  ];
};

function requireFunction(value: unknown, name: string): asserts value is (...args: never[]) => void {
  if (!(value instanceof Function)) throw new TypeError(`${name} is required`);
}

export const createBotStageSessions = ({ sessionService, clientFor, permissionAutoAcceptRuntime, sessionKnowledgeRuntime, activityProbe, readSessionDefaults, readTokenSnapshot, isolated }: StageSessionsOptions) => {
  for (const [name, value] of Object.entries({ create: sessionService?.create, send: sessionService?.send, clientFor, setSessionPolicy: permissionAutoAcceptRuntime?.setSessionPolicy, sync: sessionKnowledgeRuntime?.sync, fetchActiveSessionStatuses: activityProbe?.fetchActiveSessionStatuses, hasWorkingChildren: activityProbe?.hasWorkingChildren, readSessionDefaults, readTokenSnapshot, isolatedCreate: isolated?.create, isolatedDispatch: isolated?.dispatch, isolatedOutcome: isolated?.outcome, isolatedReconcile: isolated?.reconcile, isolatedStop: isolated?.stop })) requireFunction(value, name);
  const select = async (projectId: string, bot: BotDefinition, stage: Stage) => selectionSchema.parse(bot.models[stage].useDefaults ? await readSessionDefaults(projectId) : bot.models[stage]);
  const configure = async ({ bot, stage, sessionId, directory }: Pick<RunningRequest, 'bot' | 'stage' | 'sessionId' | 'directory'>) => {
    await clientFor(directory).session.update({ sessionID: sessionId, permissions: botStagePermissions(stage, bot) });
    if (stage !== 'fixing' || bot.permissionMode !== 'default') await permissionAutoAcceptRuntime.setSessionPolicy(sessionId, stage === 'fixing' ? bot.permissionMode : 'ask', directory);
    await sessionKnowledgeRuntime.sync(sessionId, directory, { includeMemorySaveRule: stage === 'fixing' });
  };
  const create = async (request: CreateRequest, onCreated: OnCreated) => {
    if (request.bot.isolated) return isolated.create({ ...request, selection: stageProviderSelectionSchema.parse(request.selection) }, onCreated);
    const result = await sessionService.create({ directory: request.directory, title: `${request.bot.name}: ${request.stage}` }, {
      metadata: { openchamber: { kind: 'scheduled', automation: { source: 'bot', projectId: request.projectId, botId: request.bot.id, itemId: request.itemId, stage: request.stage, notify: request.bot.notify } } },
      onSessionCreated: async (created) => {
        const parsed = createdSchema.parse(created);
        await onCreated(parsed);
        await configure({ ...request, ...parsed });
      },
    });
    return createdSchema.parse(result);
  };
  const dispatch = async (request: StageRequest) => {
    if (request.bot.isolated) return isolated.dispatch({ ...request, selection: stageExecutionSelectionSchema.parse(request.selection) });
    const sessionId = sessionIdSchema.parse(request.sessionId);
    await configure({ ...request, sessionId });
    const { providerID, modelID, agent, variant } = selectionSchema.parse(request.selection);
    const input: StagePrompt = {
      directory: request.directory, prompt: request.prompt, model: `${providerID}/${modelID}` };
    if (agent) input.agent = agent;
    if (variant) input.variant = variant;
    if (request.stage === 'fixing' && request.bot.goalTokenBudget) {
      input.goal = true;
      input.goalTokenBudget = request.bot.goalTokenBudget;
    }
    const result = await sessionService.send(sessionId, input);
    if (!result.promptDispatched) throw new Error('Bot prompt admission was not confirmed');
    return { id: sessionId, sessionId };
  };
  const outcome = async (request: OutcomeRequest): Promise<StageOutcome | null> => {
    if (request.bot.isolated) return isolated.outcome(request);
    const sessionId = sessionIdSchema.parse(request.sessionId);
    const statuses = await activityProbe.fetchActiveSessionStatuses();
    if (statuses === null) throw new Error('Bot session activity is unavailable');
    if (statuses[sessionId]) return null;
    const children = await activityProbe.hasWorkingChildren(sessionId, statuses);
    if (children === null) throw new Error('Bot child session activity is unavailable');
    if (children) return null;
    const records = pageSchema.parse(await clientFor(request.directory).message.list({ sessionID: sessionId, limit: 100, order: 'desc' })).data;
    const result = readDispatchOutcome(records, request.dispatchedAt, request.afterIdleId);
    if (!result) return null;
    if (result.state !== 'completed') return result;
    const tokens = z.number().int().nonnegative().parse(await readTokenSnapshot(sessionId, request.directory, { since: 0 }));
    return { ...result, tokens };
  };
  const reconcile = async (...args: ReconcileArgs): Promise<Reconciliation> => {
    const [kind, request, recordedSessionId] = args;
    if (request.bot.isolated) return isolated.reconcile(...args);
    if (kind === 'session.create' && recordedSessionId) {
      const info = unwrapOpenCodeResponse(await clientFor(request.directory).session.get({ sessionID: recordedSessionId }));
      const marker = recoverySchema.safeParse(info).data?.metadata.openchamber.automation;
      if (marker?.source === 'bot' && marker.itemId === request.itemId && marker.stage === request.stage && marker.botId === request.bot.id) return { state: 'succeeded', result: { id: recordedSessionId, sessionId: recordedSessionId } };
    }
    if (kind === 'session.prompt') {
      const result = await outcome(request);
      if (result) {
        const sessionId = sessionIdSchema.parse(request.sessionId);
        return { state: 'succeeded', result: { id: sessionId, sessionId } };
      }
    }
    return { state: 'outcome-unknown' };
  };
  const stop = async (request: SessionRequest) => {
    if (request.bot.isolated) return isolated.stop(request);
    const sessionId = sessionIdSchema.parse(request.sessionId);
    await clientFor(request.directory).session.interrupt({ sessionID: sessionId });
    const statuses = await activityProbe.fetchActiveSessionStatuses();
    if (statuses === null || statuses[sessionId] || await activityProbe.hasWorkingChildren(sessionId, statuses) !== false) throw new Error('Bot session has not authoritatively stopped');
  };
  const resume = async (request: ResumeRequest) => {
    if (request.bot.isolated) {
      requireFunction(isolated.resume, 'isolatedResume');
      await isolated.resume({ ...request, selection: stageProviderSelectionSchema.parse(request.selection) });
    }
  };
  return { select, create, dispatch, outcome, reconcile, stop, resume };
};

type LocalStageAdapter = ReturnType<typeof createBotStageSessions>;
export type BotStageAdapter = Omit<LocalStageAdapter, 'select' | 'stop' | 'resume'> & {
  readonly select: (projectId: string, bot: BotDefinition, stage: Stage) => Promise<BotStageSelectionInput>;
  readonly stop: (request: Parameters<LocalStageAdapter['stop']>[0]) => Promise<void | { readonly ok: true }>;
  readonly resume: (request: Parameters<LocalStageAdapter['resume']>[0]) => Promise<void | { readonly ok: true }>;
};
