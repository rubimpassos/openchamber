import type { OpenCode } from '@opencode/client';
import type { createProjectConfigRuntime } from '../projects/project-config.js';
import type { ScheduledTaskInput } from '../projects/contracts.js';
import type { createOpenChamberSessionService, SessionPayload } from '../openchamber-sessions/routes.js';
import type { createPermissionAutoAcceptRuntime } from '../permission-auto-accept/runtime.js';
import type { DispatchOutcome } from '../dispatch-results/runtime.js';
import type { Lens, SuggestedTasksConfig } from './config.js';
import type { Inbox, ScanRun, Suggestion, SuggestionStore } from './store.js';
import type { IssueRemote } from './issue-links.js';
import type { createProjectOpenIssuesReader } from './open-issues.js';

export type StopReason = 'budget' | 'timeout' | 'user';
export type RunnableLens = Omit<Lens, 'enabled'>;
export type Watch = { readonly projectId: string; readonly runId: string; readonly lensId: string; readonly startedAt: number };
export type Project = { readonly id: string; readonly path: string; readonly label?: string };
export type SessionSelection = { readonly providerID?: string | null; readonly modelID?: string | null; readonly variant?: string | null; readonly agent?: string | null };
export type CreatedSession = { readonly sessionId: string; readonly directory: string };
export type SessionCreateOptions = {
  metadata?: NonNullable<Parameters<ReturnType<typeof createOpenChamberSessionService>['create']>[1]>['metadata'];
  readonly onSessionCreated: (session: CreatedSession) => Promise<void>;
};
export type ApproveInput = {
  readonly action: string;
  readonly provider?: string | undefined;
  readonly botId?: string | undefined;
  readonly auto?: boolean;
};
export type ScanClient = {
  readonly session: {
    readonly create: (input: Parameters<ReturnType<typeof OpenCode.make>['session']['create']>[0]) => Promise<unknown>;
    readonly prompt: (input: { readonly sessionID: string; readonly text: string }, options: { readonly signal: AbortSignal }) => Promise<unknown>;
    readonly get: (input: { readonly sessionID: string }) => Promise<unknown>;
    readonly interrupt: (input: { readonly sessionID: string }) => Promise<unknown>;
    readonly inbox: {
      readonly list: (input: { readonly sessionID: string }) => Promise<unknown>;
      readonly cancel: (input: { readonly sessionID: string; readonly inboxID: string }) => Promise<unknown>;
    };
  };
};
export type SuggestedTasksDependencies = {
  readonly projectConfigRuntime: Pick<ReturnType<typeof createProjectConfigRuntime>, 'readSuggestedTasksSection' | 'updateSuggestedTasksSection' | 'listScheduledTasks' | 'upsertScheduledTask' | 'deleteScheduledTask'>;
  readonly scheduledTasksRuntime: {
    readonly syncProject: (projectId: string) => Promise<unknown>;
    readonly runNow: (projectId: string, taskId: string) => Promise<{ readonly running?: boolean; readonly queued?: boolean; readonly skipped?: boolean; readonly ok: boolean; readonly error?: unknown; readonly statusCode?: unknown }>;
  };
  readonly store: SuggestionStore;
  readonly listProjects: () => Promise<readonly Project[]>;
  readonly projectContextRuntime: {
    readonly readContext: (projectId: string) => Promise<{ readonly todos: readonly { readonly text: string; readonly completed: boolean }[] }>;
    readonly createTodo: (projectId: string, input: { readonly text: string }) => Promise<{ readonly todo: { readonly id: string } }>;
  };
  readonly sessionService: {
    readonly create: (payload: SessionPayload, options: SessionCreateOptions) => Promise<CreatedSession>;
    readonly archive: (payload: { readonly ids: string[] }) => Promise<unknown>;
  };
  readonly deliverSuggestionToBot?: (input: { readonly projectId: string; readonly botId: string; readonly suggestion: Suggestion }) => Promise<{ readonly itemId: string }>;
  readonly sessionKnowledgeRuntime: { readonly sync: (sessionId: string, directory: string, options: { readonly includeMemorySaveRule: boolean }) => Promise<unknown> };
  readonly permissionAutoAcceptRuntime: Pick<ReturnType<typeof createPermissionAutoAcceptRuntime>, 'setSessionPolicy'>;
  readonly readMcpServers?: (directory: string) => Promise<unknown>;
  readonly readSessionDefaults: (projectId: string) => SessionSelection | null | Promise<SessionSelection | null>;
  readonly globalEventHub: {
    readonly subscribeEvent: (listener: (event: { readonly translated?: () => readonly unknown[] }) => void) => () => void;
    readonly subscribeStatus: (listener: (status: { readonly type: string }) => void) => () => void;
  };
  readonly git: {
    readonly readScanCheckout: (directory: string) => Promise<{ readonly branch: string | null; readonly commit: string }>;
    readonly listChangedPathsSince: (directory: string, previous: string, commit: string) => Promise<string[] | null>;
    readonly addDetachedWorktree: (directory: string, worktree: string, branch: string) => Promise<unknown>;
    readonly removeDetachedWorktree: (directory: string, worktree: string) => Promise<unknown>;
    readonly getRepositoryRemoteUrls: (directory: string) => Promise<IssueRemote[]>;
  };
  readonly buildOpenCodeUrl: (route: string, query: string) => string | URL;
  readonly getOpenCodeAuthHeaders: () => Record<string, string>;
  readonly notify: (payload: { readonly title: string; readonly body: string; readonly tag: string; readonly directory: string }) => unknown;
  readonly broadcast: (payload: { readonly type: string; readonly properties: { readonly projectId: string } }) => unknown;
  readonly isLinearConnected?: () => boolean;
  readonly readProjectOpenIssues: ReturnType<typeof createProjectOpenIssuesReader>;
  readonly scanCheckoutsDir: string;
  readonly createClient?: ((directory: string) => ScanClient) | null;
  readonly fetchImpl?: typeof fetch;
  readonly now?: () => number;
  readonly logger?: Pick<Console, 'warn'>;
  readonly lensTimeoutMs?: number;
  readonly quietMs?: number;
  readonly settleRecheckMs?: number;
  readonly sweepIntervalMs?: number;
};

export type LensStart = { readonly projectId: string; readonly run: ScanRun; readonly lens: RunnableLens; readonly scanDirectory: string; readonly prompt: string };
export type LensCompletion = { readonly added: Suggestion[]; readonly finished: boolean; readonly action: Lens['action'] };
export type { DispatchOutcome, Inbox, ScheduledTaskInput, SuggestedTasksConfig };
