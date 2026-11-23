import type { Destination, Receipt, Worker } from './approval-contract.js';
import type { ReviewAction, ReviewJob, ReviewOperation, ReviewTurn } from './review-actions.js';
import type { createAutomationAdmission } from '../session-automation/runtime.js';
import type { CachedTrackedState, TrackedItem, TrackedThread } from '../tracked-items/contracts.js';
import type { ProviderReadContext } from '../source-control/provider-contract.js';
import type { HostGit } from '../spaces/code-transfer.js';
import type { CodeOutSummary } from '../spaces/code-out-contracts.js';

export type Config = {
  watch: boolean; maxIterations: number; tokenBudget: number | null; triggers: 'both' | 'ci' | 'review';
  ignoreSelf: boolean; ignoreBots: boolean; allowAuthors: string[]; blockAuthors: string[];
  mentionOnly: boolean; mentionText: string; pushMode: 'auto' | 'approval';
};
export type Author = { readonly login: string; readonly bot: boolean };
export type FeedbackEntry = { readonly id: number | null; readonly body: string; readonly url: string;
  readonly createdAt?: string | null; readonly author: Author };
export type Review = FeedbackEntry & { readonly state: string };
export type Thread = { readonly id: string; readonly resolved: boolean; readonly path?: string | null;
  readonly line?: number | null; readonly comments: readonly FeedbackEntry[] };
export type HeadSnapshot = { readonly state: 'open' | 'closed' | 'merged'; readonly branch: string;
  readonly headSha: string; readonly headRepo?: Destination['headRepo'] | null | undefined };
export type CiState = 'success' | 'failure' | 'pending' | 'unknown';
export type FeedbackSnapshot = HeadSnapshot & { readonly viewer: string; readonly title: string; readonly url: string;
  readonly reviewDecision: string | null; readonly ci: { readonly state: CiState; readonly total: number; readonly contexts: readonly unknown[] };
  readonly threads: readonly Thread[]; readonly reviews: readonly Review[]; readonly comments: readonly FeedbackEntry[] };
export type Feedback = { threads: (Thread & { readonly fresh: ReadonlySet<number | null> })[];
  reviews: Review[]; comments: FeedbackEntry[]; seen: string[] };
export type FailedCheck = { readonly name: string; readonly url?: string | null; readonly summary?: string | null;
  readonly steps: readonly { readonly name: string; readonly conclusion: string }[];
  readonly annotations: readonly { readonly level?: string | null; readonly path?: string | null; readonly line?: number | null; readonly message: string }[];
  readonly log?: string | null; readonly missing?: readonly string[] | undefined };
export type Failures = { readonly headSha: string; readonly runs: readonly FailedCheck[] };
export type BotAuthority = { readonly project: { readonly id: string; readonly path: string }; readonly botId: string;
  readonly itemId: string; readonly identityId: string; readonly identityRevision: number; readonly publicationBranch?: string | undefined;
  readonly target: { readonly repositoryId: string; readonly owner: string; readonly repo: string } };
export type LoopStatus = 'watching' | 'working' | 'waitingForPush' | 'ready' | 'stopped' | 'closed' | 'limitReached' | 'budgetReached' | 'error';
export type PublicationAuthority = {
  readonly repositoryId: string; readonly bindingRevision: number; readonly configRevision: string;
  readonly remote: { readonly name: string; readonly endpoint: { readonly displayUrl: string; readonly fingerprint: string } };
  readonly transportMode: 'managed';
};
export type PendingPublication = { readonly receipt: Receipt; readonly authority: unknown };
/** Mutable state belongs to one runtime and is serialized by its persistence queue. */
export type Loop = {
  id: string; sessionId: string; directory: string; accountId?: string | null | undefined;
  owner: string; repo: string; number: number; url: string; title: string; branch: string;
  status: LoopStatus; statusReason: string | null; config: Config;
  readContext?: { [Key in keyof ProviderReadContext]?: ProviderReadContext[Key] | undefined } | undefined; botAuthority?: BotAuthority | undefined;
  worker: Worker | null; pendingApproval: Receipt | null;
  review: { state: 'awaitingPublication' | 'pending' | 'blocked' | 'complete'; actions: ReviewAction[];
    completed: number; total: number; lastError: string | null } | null;
  iterations: number; totalIterations: number; tokensUsed: number;
  ci: { state: CiState; headSha: string } | null; unresolvedThreads: number | null; changesRequested: boolean | null;
  lastCheckedAt: number | null; lastError: string | null; createdAt: number; updatedAt: number;
  internal: { seen: string[]; handled?: string[] | undefined; baselined?: boolean | undefined; failures?: number | undefined; workerFailures?: number | undefined;
    readyAnnounced?: boolean | undefined; feedbackTrustVersion?: number | undefined; tokenBaseline?: number | null | undefined;
    headSha?: string | undefined; headFirstSeenAt?: number | undefined; ciReportedSha?: string | undefined;
    turnWindows?: { start: number; end: number | null }[] | undefined;
    destination?: Destination | undefined; turnSnapshot?: HeadSnapshot | null | undefined; reviewTurn?: ReviewTurn | null | undefined;
    reviewJob?: ReviewJob | null | undefined; publication?: PendingPublication | null | undefined; publicationState?: 'publishing' | null | undefined };
};
export type PublicLoop = Omit<Loop, 'internal' | 'accountId' | 'readContext' | 'botAuthority'>;
export type LoopIdentity = Pick<Loop, 'directory' | 'owner' | 'repo' | 'number'> & Partial<Pick<Loop, 'id' | 'readContext'>>;
export type WorkerLoop = LoopIdentity & Pick<Loop, 'sessionId' | 'createdAt'> & { readonly id: string; worker: Worker };
export type WorkerLoopInput = Omit<WorkerLoop, 'worker'> & Pick<Loop, 'worker'>;
export type PrepareWorker = { readonly sessionId: string; readonly directory: string; readonly model: unknown;
  readonly name?: string | undefined; readonly placeId?: string | undefined };
export type WorkerPreparation = Omit<PrepareWorker, 'sessionId'> & { readonly parentSessionId: string };
export type IterationInput = { readonly failures: Failures | null; readonly feedback: Feedback | null };
export type IterationItem = { readonly content: string; readonly text: string; readonly notice: IterationNotice;
  readonly origin: { readonly kind: 'pr-fix-loop'; readonly id: string } };
export type IterationNotice = { readonly source: 'openchamber-notice'; readonly kind: 'fix-loop'; readonly loopId: string;
  readonly pr: Pick<Loop, 'owner' | 'repo' | 'number' | 'url' | 'title'>; readonly trigger: string; readonly iteration: number;
  readonly maxIterations: number; readonly headSha: string | null;
  readonly checks: readonly { readonly name: string; readonly url: string | null }[];
  readonly feedback: readonly { readonly type: string; readonly author: string; readonly url: string; readonly path?: string; readonly line?: number }[] };
export interface WorkerRuntime {
  prepare(input: WorkerPreparation): Promise<Worker>;
  validate(worker: Worker, options?: { readonly checkParent?: boolean }): Promise<unknown>;
  initialize(loop: Loop, snapshot: HeadSnapshot): Promise<Worker>;
  enqueue(loop: Loop, item: IterationItem): Promise<unknown>;
  working(loop: Loop): Promise<boolean | null>;
  usage(loop: Loop): Promise<number | null>;
  export(loop: Loop): Promise<CodeOutSummary>;
  reviewResult(loop: Loop): Promise<string>;
  stop(loop: Loop): Promise<unknown>;
  resume(loop: Loop): Promise<unknown>;
}
export interface Publication {
  validate(loop: LoopIdentity, snapshot: HeadSnapshot): Promise<unknown>;
  capture(loop: LoopIdentity, snapshot: HeadSnapshot, exported: CodeOutSummary): Promise<PendingPublication>;
  publish(loop: LoopIdentity, pending: PendingPublication, snapshot: HeadSnapshot): Promise<unknown>;
}
export interface Tracking {
  subscribeRefresh(listener: (states: readonly TrackingObservation[]) => void): () => void;
  setServerInterest(owner: string, items: Map<string, TrackedItem>): unknown;
  refresh(items: readonly TrackedThread[]): unknown;
}
export type TrackingObservation = { readonly key: string; readonly status: 'ok' | 'unavailable' | 'disconnected';
  readonly state: CachedTrackedState | null; readonly requestedAt: number };
export type Reading<Client> = { readonly octokit: Client; readonly directory: string; readonly owner: string; readonly repo: string };
export type RuntimeOptions<Client> = {
  readonly dataDir: string;
  readonly getOctokit: (accountId: string | null | undefined) => Promise<Client | null>;
  readonly readFeedback: (input: Reading<Client> & { readonly number: number; readonly mentionText?: string }) => Promise<FeedbackSnapshot>;
  readonly readAuthorPermission?: ((input: Reading<Client> & { readonly username: string }) => Promise<boolean>) | undefined;
  readonly readFailedChecks: (input: Reading<Client> & { readonly contexts: readonly unknown[] }) => Promise<FailedCheck[]>;
  readonly isRateLimited?: () => boolean; readonly noteRateLimit?: (error: unknown) => boolean;
  readonly isSessionWorking: (sessionId: string) => Promise<boolean | null>;
  readonly hasQueuedItem: (sessionId: string, loopId: string) => boolean | Promise<boolean>;
  readonly enqueue: (sessionId: string, directory: string, item: IterationItem) => Promise<unknown>;
  readonly readTokenSnapshot?: (sessionId: string, directory: string, options: { readonly since: number }) => Promise<number | null>;
  readonly workerRuntime?: WorkerRuntime | null; readonly publication?: Publication | null;
  readonly applyReviewOperation?: ((input: { readonly loop: Loop; readonly receipt: Receipt;
    readonly operation: ReviewOperation; readonly replayOnly: boolean }) => Promise<unknown>) | null;
  readonly notify?: (loop: PublicLoop & { readonly botAuthority?: BotAuthority }) => Promise<unknown>;
  readonly notifyAwaitingApproval?: (loop: PublicLoop) => Promise<unknown>;
  readonly resolveNotifications?: (loop: PublicLoop) => Promise<unknown>;
  readonly broadcast?: (event: { readonly type: 'openchamber:pr-fix-loop.updated';
    readonly properties: { readonly loop: PublicLoop } | { readonly id: string; readonly removed: true } }) => unknown;
  readonly readDefaults?: () => Promise<unknown>; readonly now?: () => number;
  readonly setTimer?: (fn: () => unknown, ms: number) => ReturnType<typeof setTimeout>;
  readonly clearTimer?: (timer: ReturnType<typeof setTimeout>) => void;
  readonly automation?: ReturnType<typeof createAutomationAdmission> | null;
  readonly approvalOnly?: boolean; readonly excludeBotWatches?: boolean;
  readonly assertBotWatchAvailable?: ((loop: PublicLoop, authority: BotAuthority) => Promise<unknown>) | null;
  readonly log?: { readonly warn?: (...values: unknown[]) => void };
  readonly botWatch?: { readonly getOctokit: (authority: BotAuthority) => Promise<Client | null>;
    readonly deliver: (authority: BotAuthority, item: { readonly eventId: string; readonly text: string }) => Promise<unknown>;
    readonly authorizeApp: (authority: BotAuthority, author: Author, client: Client) => Promise<boolean> } | null;
};
export type CreateLoop = Pick<Loop, 'sessionId' | 'directory' | 'owner' | 'repo' | 'number'> & {
  readonly accountId?: string | null | undefined; readonly title?: string; readonly url?: string; readonly branch?: string;
  readonly config?: unknown; readonly workerId?: string; readonly readContext?: Partial<ProviderReadContext> | undefined;
  readonly snapshot?: HeadSnapshot;
};
export type GitServices = {
  readBinding(directory: string): Promise<{ readonly repository: { readonly repositoryId: string; readonly configRevision: string;
    readonly remotes: readonly { readonly name: string; readonly push: PublicationAuthority['remote']['endpoint'] }[] };
    readonly revision: number; readonly binding?: { readonly remotes: readonly { readonly name: string; readonly readiness: string; readonly mode: string }[] } | null }>;
  publish(input: PublicationAuthority & { readonly directory: string; readonly operation: 'push'; readonly sourceRef: string;
    readonly destinationRef: string; readonly forceWithLease: { readonly expectedRemoteSha: string } }, commit: string): Promise<unknown>;
  fetchHead(loop: LoopIdentity, snapshot: Pick<HeadSnapshot, 'headSha'>): Promise<unknown>;
};
export type PublicationOptions = { readonly dataDir: string; readonly git: HostGit | null; readonly gitServices: () => GitServices;
  readonly captureRef?: ((input: { readonly directory: string; readonly commit: string; readonly expectedHead: string; readonly localRef: string }) => Promise<unknown>) | null };
