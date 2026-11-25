import type { z } from 'zod';
import type { AgentUpstream } from './agent-upstream.js';
import type { BotServiceInput, BotServiceOperation, botScopeSchema } from './bot-service-contract.js';
import type { BotDefinition } from '../bots/config.js';
import type { createBotStore } from '../bots/store.js';
import type { createBotsConfig } from '../bots/config.js';
import type { createBotStageSessions } from '../bots/stage-sessions.js';
import type { createOwnerBotGateway } from './bot-owner-gateway.js';
import type { BotServiceRequest } from '../bots/services/contracts.js';
import type { BotServiceReadRequest } from '../bots/services/reads.js';
import type { createBotServices } from '../bots/services.js';
import type { BotServiceDescriptor } from '../bots/services.js';
import type { DispatchCallbacks } from '../bots/services/provider.js';
import type { createSessionKnowledgeRuntime } from '../session-knowledge/runtime.js';

export type Scope = BotServiceInput<'worktree-create'>['scope'];
export type Project = Scope['project'];
export type ScopeLookup = {
  readonly scope?: z.input<typeof botScopeSchema> | undefined;
  readonly project?: Project | undefined;
  readonly bot?: (Partial<z.input<typeof botScopeSchema>['bot']> & { readonly id: string }) | undefined;
  readonly item?: (Omit<Partial<z.input<typeof botScopeSchema>['item']>, 'botId' | 'effects' | 'pr'> & {
    readonly id: string;
    readonly botId?: string | undefined;
    readonly pr?: object | undefined;
    readonly effects?: readonly Scope['item']['effects'][number][] | undefined;
  }) | undefined;
  readonly projectId?: string | undefined;
  readonly botId?: string | undefined;
  readonly itemId?: string | undefined;
  readonly checkoutKey?: string | undefined;
};
export type BotServiceOwners = {
  readonly dataDir: string;
  readonly resolveProject: (id: string) => Promise<Project | null>;
  readonly listProjects: () => Promise<readonly Project[]>;
  readonly store: Pick<ReturnType<typeof createBotStore>, 'read' | 'readArchive'>;
  readonly config: Pick<ReturnType<typeof createBotsConfig>, 'read'>;
};
export type AgentBotServicesOptions = Partial<Pick<BotServiceOwners, 'dataDir' | 'resolveProject' | 'listProjects'>> & {
  readonly readItem?: ((projectId: string, itemId: string) => Promise<Scope['item'] | null | undefined>) | undefined;
  readonly readBot?: ((projectId: string, botId: string) => Promise<BotDefinition | null | undefined>) | undefined;
  readonly resolveScope?: ((input: ScopeLookup) => Promise<z.input<typeof botScopeSchema> | null | undefined>) | undefined;
  readonly listItems?: ((projectId: string) => Promise<readonly Scope['item'][]>) | undefined;
};
export type BotUpstream = Pick<AgentUpstream, 'request'>;
export type CallOptions = { readonly signal?: AbortSignal | undefined };
export type StageRequest = Parameters<ReturnType<typeof createBotStageSessions>['create']>[0] & { readonly project?: Project };
export type SessionEntry = ScopeLookup & {
  readonly projectId: string; readonly botId: string; readonly itemId: string;
  readonly stage: keyof Scope['item']['sessions']; readonly directory: string; readonly sessionId: string;
};
export type StageSessionEntry = ScopeLookup & {
  readonly projectId?: string | undefined; readonly botId?: string | undefined; readonly itemId?: string | undefined;
  readonly stage?: keyof Scope['item']['sessions'] | undefined; readonly directory: string; readonly sessionId?: string | undefined;
};
export type SessionOperation = 'session' | 'activity' | 'tokens' | 'knowledge-sync' | 'synthetic-deliver' | 'tools-pull' | 'tools-settle' | 'stage-stop' | 'stage-resume';
export type StageOperation = 'stage-create' | 'stage-dispatch' | 'stage-outcome' | 'stage-reconcile';
export type SessionExtra = Partial<Omit<BotServiceInput<SessionOperation>, 'scope' | 'sessionId'>>;
export type StageExtra = Partial<Omit<BotServiceInput<StageOperation>, 'scope' | 'request'>>;
export type EffectOperation = 'service-preflight' | 'service-execute' | 'service-reconcile';
export type ScopedEffect = BotServiceDescriptor & Pick<ScopeLookup, 'scope'>;
export type EffectOptions = Pick<ScopeLookup, 'scope'> & DispatchCallbacks;
export type PreparedRequest = BotServiceRequest & ScopeLookup;
export type ReadRequest = BotServiceReadRequest & ScopeLookup;
export type WatchAuthority = BotServiceInput<'pull-feedback'>['authority'];
export type WatchHandle = { readonly botAuthority: WatchAuthority };
export type WatchReference = WatchAuthority | WatchHandle | { readonly authority: WatchAuthority };
export type WatchInput = {
  readonly octokit?: WatchReference; readonly authority?: WatchReference;
  readonly owner?: string; readonly repo?: string;
};
export type WatchFeedbackInput = WatchInput & Pick<BotServiceInput<'pull-feedback'>, 'number' | 'headSha' | 'mentionText'> & { readonly branch?: string };
export type GatewayOptions = Omit<Parameters<typeof createOwnerBotGateway>[0], 'call' | 'scope'> & { readonly project: Project; readonly bot: BotDefinition };
type NativeExecutionReply = Awaited<ReturnType<ReturnType<typeof createBotServices>['execute' | 'reconcile']>>
  | Awaited<ReturnType<ReturnType<typeof createSessionKnowledgeRuntime>['collect']>>;
export type BotExecutionResult = NativeExecutionReply | null | undefined | boolean | number | string
  | readonly BotExecutionResult[] | { readonly [key: string]: BotExecutionResult };
export type OperationHandlers = { readonly [Operation in BotServiceOperation]:
  (input: BotServiceInput<Operation>, options: CallOptions) => Promise<BotExecutionResult> };
