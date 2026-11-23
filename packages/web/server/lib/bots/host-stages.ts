import { z } from 'zod';
import { BotServiceError } from './services.js';
import { createBotStageSessions, stageExecutionSelectionSchema, stageProviderSelectionSchema } from './stage-sessions.js';
import type { HostExecution, HostIsolated, HostOptions, HostPlacement, HostSessions, HostStages } from './host-contracts.js';
import type { createSessionActivityProbe } from '../opencode/session-activity.js';
import type { createTokenSnapshotReader } from '../pr-fix-loop/token-usage.js';

type StageOptions = Pick<HostOptions, 'sessionService' | 'readOnlySessionService' | 'clientFor' | 'permissionAutoAcceptRuntime' | 'readSessionDefaults'> & {
  readonly sessionKnowledgeRuntime: HostOptions['sessionKnowledgeRuntime'];
  readonly isolated: HostIsolated; readonly placement: HostPlacement; readonly sessions: HostSessions;
  readonly execution: HostExecution | null;
  readonly activity: ReturnType<typeof createSessionActivityProbe> | null;
  readonly readTokens: ReturnType<typeof createTokenSnapshotReader> | null;
};
const scopeSchema = z.object({ projectId: z.string().optional(), itemId: z.string().optional(), bot: z.object({ id: z.string() }) });
type StageRequest = Parameters<HostStages['create']>[0];
type SessionRequest = Parameters<HostStages['stop']>[0];

export function createHostStages({ sessionService, readOnlySessionService, clientFor, permissionAutoAcceptRuntime,
  sessionKnowledgeRuntime, readSessionDefaults, isolated, placement, sessions, execution, activity, readTokens }: StageOptions): HostStages {
  const isolatedStages: Parameters<typeof createBotStageSessions>[0]['isolated'] = isolated;
  const base = (() => {
    if (execution) {
      const stages: HostStages = { ...execution.stages,
        select: async (projectId, bot, stage) => bot.models[stage].useDefaults ? readSessionDefaults(projectId) : bot.models[stage],
        create: (request, created) => request.bot.isolated ? isolatedStages.create({ ...request, selection: stageProviderSelectionSchema.parse(request.selection) }, created) : execution.stages.create(request, created),
        dispatch: (request) => request.bot.isolated ? isolatedStages.dispatch({ ...request, selection: stageExecutionSelectionSchema.parse(request.selection) }) : execution.stages.dispatch(request),
        reconcile: (...args) => (args[1].bot.isolated ? isolatedStages : execution.stages).reconcile(...args),
        stop: (request) => (request.bot.isolated ? isolatedStages : execution.stages).stop(request),
        resume: (request) => request.bot.isolated ? isolated.resume({ ...request, selection: stageProviderSelectionSchema.parse(request.selection) }) : execution.stages.resume(request),
        outcome: (request) => (request.bot.isolated ? isolatedStages : execution.stages).outcome(request),
      };
      return stages;
    }
    if (!activity || !readTokens) throw new BotServiceError('BOT_HOST_NOT_READY', 'Local stage owners are unavailable.');
    if (!sessionService || !readOnlySessionService || !permissionAutoAcceptRuntime || !sessionKnowledgeRuntime) throw new TypeError('Local bot stage owners are unavailable');
    return createBotStageSessions({ sessionService: { create: sessionService.create,
      send: (sessionId, payload) => (sessionId && sessions.get(sessionId)?.stage === 'fixing' ? sessionService : readOnlySessionService).send(sessionId, payload) },
      clientFor, permissionAutoAcceptRuntime, sessionKnowledgeRuntime, activityProbe: activity, readSessionDefaults, readTokenSnapshot: readTokens, isolated: isolatedStages });
  })();
  const stageRequest = async <Request extends SessionRequest>(request: Request) => {
    const scope = scopeSchema.parse(request);
    let projectId = scope.projectId; let itemId = scope.itemId;
    if (!projectId || !itemId) {
      const entry = request.sessionId ? sessions.get(request.sessionId) : undefined;
      if (!entry) throw new BotServiceError('BOT_PLACEMENT_MISMATCH', 'The session has no recorded execution placement.');
      projectId = entry.projectId; itemId = entry.itemId;
    }
    const captured = { ...request, projectId, itemId };
    const { sessionId, ...placementInput } = captured;
    const input = { ...placementInput, bot: { ...request.bot, id: scope.bot.id }, capturedRun: itemId.startsWith('discovery_') ? captured : undefined };
    const recorded = sessionId === undefined ? await placement.resolve(input) : await placement.resolve({ ...input, sessionId });
    return { ...captured, bot: { ...request.bot, isolated: recorded.isolated } };
  };
  const trackRun = (request: Pick<StageRequest, 'projectId' | 'itemId' | 'bot' | 'directory' | 'stage'>, sessionId: string) => sessions.track({ projectId: request.projectId, itemId: request.itemId,
    botId: request.bot.id, directory: request.directory, stage: request.stage, sessionId, isolated: request.bot.isolated });
  return { ...base,
    create: async (input, created) => {
      const request = await stageRequest(input);
      return base.create(request, async (result) => { trackRun(request, result.sessionId); await created(result); });
    },
    dispatch: async (request) => base.dispatch(await stageRequest(request)),
    reconcile: async (...args) => {
      const [kind, input, ...tail] = args;
      const request = await stageRequest(input);
      switch (kind) {
      case 'session.create': return base.reconcile(kind, request, ...tail);
      case 'session.prompt': return base.reconcile(kind, request, ...tail);
      }
    },
    stop: async (request) => base.stop(await stageRequest(request)),
    resume: async (request) => base.resume(await stageRequest(request)),
    outcome: async (input) => {
      const request = await stageRequest(input);
      if (!request.sessionId) throw new BotServiceError('BOT_PLACEMENT_MISMATCH', 'The stage has no recorded session.');
      trackRun(request, request.sessionId); return base.outcome(request);
    },
  };
}
