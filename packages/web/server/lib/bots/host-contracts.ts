import type { createBotsConfig, BotDefinition } from './config.js';
import type { createBotStore } from './store.js';
import type { createBotIdentityStore } from './identities.js';
import type { BotServices, BotServicesOptions } from './services.js';
import type { BotBindingContext } from './service-context.js';
import type { createBotHostSessions } from './host-sessions.js';
import type { createBotHostTools } from './host-tools.js';
import type { createBotIsolatedStages } from './isolated-stages.js';
import type { createBotStageSessions } from './stage-sessions.js';
import type { BotStageAdapter } from './stage-sessions.js';
import type { createBotPlacement } from './placement.js';
import type { createBotProviderRuntime } from './provider-runtime.js';
import type { createBotProofRunner } from './proof.js';
import type { createBotQuestions } from './questions.js';
import type { createBotScheduler } from './scheduler.js';
import type { createBotAttention } from './attention.js';
import type { createProductionBotPullRequests } from './production-pull-requests.js';
import type { createProductionBotWorktrees } from './production-worktrees.js';
import type { RuntimeOptions } from './runtime/contracts.js';
import type { BotItem } from './schema.js';
import type { BotServiceReply } from '../agent-server/bot-service-contract.js';
import type { SessionActivityOptions } from '../opencode/session-activity.js';
import type { createTokenSnapshotReader } from '../pr-fix-loop/token-usage.js';
import type { KnowledgeCollector } from '../session-knowledge/contracts.js';

export type HostSessions = ReturnType<typeof createBotHostSessions>;
export type HostEntry = NonNullable<ReturnType<HostSessions['get']>>;
export type HostStages = BotStageAdapter;
export type HostIsolated = ReturnType<typeof createBotIsolatedStages>;
export type HostPlacement = ReturnType<typeof createBotPlacement>;
type StageOptions = Parameters<typeof createBotStageSessions>[0];
type Worktrees = ReturnType<typeof createProductionBotWorktrees>;
type PullOptions = Parameters<typeof createProductionBotPullRequests>[0];
export type TreeRequest = { readonly project: { readonly id: string; readonly path: string }; readonly item: Pick<BotItem, 'id' | 'botId' | 'worktree'> };
export type HostWorktrees = Pick<Worktrees, 'create' | 'inspect' | 'remove' | 'reconcile' | 'adoptIsolated' | 'acceptPublished' | 'bindPublication'> & {
  readonly readPublication: NonNullable<BotServicesOptions['resolvePublication']>;
};
export type HostAttention = {
  readonly projectId?: string; readonly botId?: string; readonly itemId?: string;
  readonly occurrence?: string; readonly reason: string;
};
export type ReportHostAttention = (request: HostAttention) => Promise<BotItem | void>;
export type HostExecution = {
  readonly bindOwner: (owners: {
    readonly dataDir: string; readonly resolveProject: RuntimeOptions['resolveProject']; readonly listProjects: RuntimeOptions['listProjects'];
    readonly store: ReturnType<typeof createBotStore>; readonly config: ReturnType<typeof createBotsConfig>;
  }) => void;
  readonly identities: Pick<ReturnType<typeof createBotIdentityStore>, 'list' | 'create' | 'update' | 'remove'>;
  readonly services: BotServices;
  readonly context: BotBindingContext & {
    readonly identityFor: (bot: BotDefinition, service: 'discord') => Promise<{ readonly identityId: string; readonly identityRevision: number }>;
  };
  readonly worktrees: HostWorktrees & { readonly sameTree: (request: TreeRequest & { readonly left: string; readonly right: string }) => Promise<boolean> };
  readonly stages: HostStages;
  readonly hostSessions: NonNullable<Parameters<typeof createBotHostSessions>[0]['hostExecution']> & Parameters<typeof createBotHostTools>[0]['execution'];
  readonly sessionKnowledgeRuntime: KnowledgeCollector;
  readonly readSessionDefaults: StageOptions['readSessionDefaults'];
  readonly readPolicyFiles: (directory: string, options: { readonly files: readonly string[] }) => Promise<BotServiceReply<'policy-files'>>;
  readonly runProof: (input: Parameters<ReturnType<typeof createBotProofRunner>['run']>[0] & {
    readonly project: Awaited<ReturnType<RuntimeOptions['resolveProject']>>; readonly bot: BotDefinition;
  }, options?: Parameters<ReturnType<typeof createBotProofRunner>['run']>[1]) => ReturnType<ReturnType<typeof createBotProofRunner>['run']>;
  readonly pullRequests: NonNullable<PullOptions['execution']>;
  readonly blame: NonNullable<Parameters<typeof createBotQuestions>[0]['readBlame']>;
  readonly createGateway: NonNullable<Parameters<typeof createBotProviderRuntime>[0]['createGateway']>;
};
export type HostOptions<NotifyResult = void> = {
  readonly dataDir: string; readonly projectsDir: string;
  readonly projectConfigRuntime: Parameters<typeof createBotsConfig>[0]['projectConfigRuntime'] & Parameters<typeof createBotScheduler>[0]['projectConfigRuntime'];
  readonly scheduledTasksRuntime: Parameters<typeof createBotScheduler>[0]['scheduledTasksRuntime'];
  readonly listProjects: RuntimeOptions['listProjects']; readonly resolveProject: RuntimeOptions['resolveProject'];
  readonly sessionService: (StageOptions['sessionService'] & { readonly sessionArchive: { isArchived(sessionId: string): Promise<boolean> } }) | null;
  readonly readOnlySessionService: StageOptions['sessionService'] | null;
  readonly clientFor: StageOptions['clientFor'] & Parameters<typeof createBotHostSessions>[0]['clientFor'];
  readonly permissionAutoAcceptRuntime: StageOptions['permissionAutoAcceptRuntime'] | null;
  readonly sessionKnowledgeRuntime: (StageOptions['sessionKnowledgeRuntime'] & KnowledgeCollector) | null;
  readonly readSessionDefaults: StageOptions['readSessionDefaults'];
  readonly buildOpenCodeUrl: SessionActivityOptions['buildOpenCodeUrl'] & Parameters<typeof createTokenSnapshotReader>[0]['buildOpenCodeUrl'];
  readonly getOpenCodeAuthHeaders: SessionActivityOptions['getOpenCodeAuthHeaders'];
  readonly getSpacesHost: Parameters<typeof createBotIsolatedStages>[0]['getSpacesHost'];
  readonly getSpaceArchive: Parameters<typeof createBotPlacement>[0]['getSpaceArchive'];
  readonly messageQueueRuntime: Parameters<typeof createBotHostSessions>[0]['hostQueue'];
  readonly notificationCenter: Parameters<typeof createBotAttention>[0]['center'];
  readonly notify: (payload: Parameters<Parameters<typeof createBotAttention>[0]['notify']>[0]) => NotifyResult | Promise<NotifyResult>;
  readonly broadcast: Parameters<typeof createBotHostSessions>[0]['broadcast'] &
    ((event: { readonly type: 'openchamber:bots-changed'; readonly properties: { readonly projectId: string } }) => void);
  readonly getFixLoopRuntime: PullOptions['getFixLoopRuntime'];
  readonly disposeInstance?: Parameters<typeof createProductionBotWorktrees>[0]['disposeInstance'];
  readonly reviewApps?: PullOptions['reviewApps'];
  readonly logger?: Pick<Console, 'warn'>;
  readonly fetchImpl?: BotServicesOptions['fetchImpl'];
  readonly policyOptions?: BotServicesOptions['policyOptions'];
  readonly executionServices?: HostExecution | null;
  readonly withWatchAdmission?: PullOptions['withWatchAdmission'];
};
