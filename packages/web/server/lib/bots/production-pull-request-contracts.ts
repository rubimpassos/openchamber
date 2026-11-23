import type { BotDefinition } from './config.js';
import type { BotItem } from './schema.js';
import type { BotBindingContext, createBotServiceContext } from './service-context.js';
import type { createProductionBotWorktrees } from './production-worktrees.js';
import type { Author, BotAuthority, CreateLoop, PublicLoop } from '../pr-fix-loop/contracts.js';
import type { GitHubFeedbackReader } from '../github/pr-feedback-reader.js';
import type { BotServiceReadResult } from './services.js';
import type { BotServiceReply } from '../agent-server/bot-service-contract.js';

export type PullRequestRequest = {
  readonly project: BotAuthority['project']; readonly bot: BotDefinition;
  readonly item: Pick<BotItem, 'id' | 'botId' | 'worktree' | 'branch' | 'publicationBranch' | 'sessions' | 'pr'> & { readonly title?: string | undefined };
};
export type PullRequestStatus = {
  readonly headSha: string; readonly baseSha: string; readonly merged: boolean;
  readonly approved: boolean; readonly mergeMode: 'queue' | 'auto-merge';
};
type ReadBinding = Pick<BotAuthority, 'identityId' | 'identityRevision' | 'target'>;
type PullRequestServices = {
  read(input: ReadBinding & { readonly operation: 'github.pull'; readonly input: { readonly number: number } }):
    Promise<BotServiceReadResult | BotServiceReply<'service-read'>['value']>;
  read(input: ReadBinding & { readonly operation: 'github.rules'; readonly input: { readonly branch: string } }):
    Promise<BotServiceReadResult | BotServiceReply<'service-read'>['value']>;
};
type PullRequestExecution = {
  readonly getOctokit: (authority: BotAuthority) => Promise<GitHubFeedbackReader | { readonly botAuthority: BotAuthority }>;
  readonly authorizeApp: (authority: BotAuthority, author: Author, selected: { readonly slug: string; readonly appId: number }) => Promise<boolean>;
  readonly readStatus: (request: PullRequestRequest & { readonly authority: BotAuthority }) => Promise<{ readonly open: boolean; readonly status: PullRequestStatus }>;
};
export type PullRequestOptions = {
  readonly services: PullRequestServices;
  readonly getFixLoopRuntime: () => {
    readonly createBotWatch: (input: CreateLoop, authority: BotAuthority) => Promise<PublicLoop | null | void>;
    readonly stopBotWatch: (input: Pick<BotAuthority, 'botId' | 'itemId'> & { readonly projectId: string }) => Promise<void>;
  };
  readonly receiveFeedback: (projectId: string, itemId: string, event: { readonly eventId: string; readonly text: string }) =>
    Promise<{ readonly ignored: boolean } | { readonly duplicate: boolean } | { readonly delivered: boolean } | void>;
  readonly reviewApps: unknown;
  readonly resolvePublication?: ((query: { readonly repositoryId: string; readonly botId: string; readonly itemId: string }) => ReturnType<ReturnType<typeof createProductionBotWorktrees>['readPublication']>) | undefined;
  readonly withWatchAdmission?: (<Result>(work: () => Promise<Result>) => Promise<Result>) | undefined;
} & (
  | { readonly context: Pick<ReturnType<typeof createBotServiceContext>, 'github'>; readonly execution?: null | undefined }
  | { readonly context: Pick<BotBindingContext, 'github'>; readonly execution: PullRequestExecution }
);
export type LocalPullRequestOptions = Extract<PullRequestOptions, { readonly execution?: null | undefined }>;
export type RemotePullRequestOptions = Extract<PullRequestOptions, { readonly execution: PullRequestExecution }>;
