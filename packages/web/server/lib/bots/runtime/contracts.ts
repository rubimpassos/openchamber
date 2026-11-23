import type { z } from 'zod';
import type { BotDefinition } from '../config.js';
import type { BotItem, BotItemState } from '../schema.js';
import type { createBotsConfig } from '../config.js';
import type { createBotStore } from '../store.js';
import type { BotStageAdapter } from '../stage-sessions.js';
import type { createBotServiceContext } from '../service-context.js';
import type { createBotScheduler } from '../scheduler.js';
import type { createBotAttention } from '../attention.js';
import type { createBotNotices } from '../notices.js';
import type { createBotEvents } from '../events.js';
import type { createBotSources } from '../sources.js';
import type { readRepositoryPolicy } from '../repository-policy.js';
import type { createBotProofRunner } from '../proof.js';
import type { createProductionBotWorktrees } from '../production-worktrees.js';
import type { createProductionBotPullRequests } from '../production-pull-requests.js';
import type { BotServices } from '../services.js';
import type { JsonValue } from '../../shared/json-values.js';
import type { checkoutRequestSchema, cleanupRequestSchema, dataSchema, runSchema, serviceRequestSchema, cloneRun } from './journal.js';
import type { RuntimeProject } from './input-contracts.js';

export type RuntimeBot = BotDefinition | ({ readonly id: string; readonly enabled: false }
  & { readonly [Field in Exclude<keyof BotDefinition, 'id' | 'enabled'>]?: never });
export type RuntimeRun = z.output<typeof runSchema>;
export type RuntimeStageContext = Parameters<typeof cloneRun>[0]['context'];
export type RuntimeData = z.output<typeof dataSchema>;
export type RuntimeServiceRequest = z.output<typeof serviceRequestSchema>;
export type RuntimeToolCall = { readonly sessionId: string; readonly action: string; readonly input: JsonValue };
type Worktrees = ReturnType<typeof createProductionBotWorktrees>;
type CheckoutRequest = z.output<typeof checkoutRequestSchema>;
type CleanupRequest = z.output<typeof cleanupRequestSchema>;
type QuestionScope = { readonly project: RuntimeProject; readonly bot: BotDefinition; readonly itemId: string };
export type RuntimeQuestionRequest = QuestionScope & {
  readonly eventId: string; readonly questions: readonly string[]; readonly people?: readonly string[];
  readonly requestedRole?: string; readonly resumeState: BotItemState;
};
export type RuntimeQuestionDraft = { -readonly [Field in keyof RuntimeQuestionRequest]: RuntimeQuestionRequest[Field] };
export type RuntimeOptions = {
  readonly config: ReturnType<typeof createBotsConfig>;
  readonly store: ReturnType<typeof createBotStore>;
  readonly resolveProject: (projectId: string) => Promise<RuntimeProject>;
  readonly listProjects: () => Promise<readonly RuntimeProject[]>;
  readonly stages: BotStageAdapter;
  readonly worktrees: Pick<Worktrees, 'inspect' | 'acceptPublished' | 'bindPublication'> & {
    create(request: CheckoutRequest): ReturnType<Worktrees['create']>;
    reconcile(request: CheckoutRequest | (CleanupRequest & { readonly operation: 'remove' })): ReturnType<Worktrees['reconcile']>;
    remove(request: CleanupRequest): ReturnType<Worktrees['remove']>;
  };
  readonly services: BotServices;
  readonly serviceContext: ReturnType<typeof createBotServiceContext>['serviceContext'];
  readonly runProof: (input: Parameters<ReturnType<typeof createBotProofRunner>['run']>[0] & {
    readonly testFiles: readonly string[]; readonly item: BotItem;
  }, options: { readonly signal: AbortSignal }) => ReturnType<ReturnType<typeof createBotProofRunner>['run']>;
  readonly pullRequests: Omit<ReturnType<typeof createProductionBotPullRequests>['pullRequests'], 'stop'> & {
    stop(request: { readonly project: RuntimeProject; readonly bot: Pick<BotDefinition, 'id'>; readonly item: BotItem }): Promise<void>;
  };
  readonly sources: ReturnType<typeof createBotSources> & { usage?: (request: { readonly projectId: string; readonly botId: string; readonly day: string }) => Promise<{ readonly dailyTotal: number; readonly complete: boolean }> };
  readonly attention: ReturnType<typeof createBotAttention>;
  readonly notices: ReturnType<typeof createBotNotices>;
  readonly questions: {
    ask(request: RuntimeQuestionRequest): Promise<{ readonly item: BotItem; readonly question: JsonValue }>;
    retry(request: QuestionScope): Promise<{ readonly item: BotItem; readonly question: JsonValue } | void>;
    answered(request: { readonly projectId: string; readonly itemId: string }): Promise<void>;
  };
  readonly scheduler: ReturnType<typeof createBotScheduler>;
  readonly events: ReturnType<typeof createBotEvents>;
  readonly readPolicy?: typeof readRepositoryPolicy;
  readonly now?: () => number;
};
