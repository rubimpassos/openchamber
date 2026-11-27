import { BotServiceError } from './services/contracts.js';
import type { BotDefinition } from './config.js';
import type { BotEffect, BotItem } from './schema.js';
import type { BotStage, BotStageReport } from './prompts.js';
import type { BotOperationInput, BotOperationTarget } from './services/contracts.js';
import type { GitHubBranchRule } from './services/branch-rules.js';
import type { BotServiceReadValue } from './services.js';

type PublicationItem = BotItem & { readonly branch: string; readonly worktree: string };
type PublicationScope = {
  readonly project: { readonly id: string; readonly path: string };
  readonly bot: BotDefinition;
  readonly item: PublicationItem;
};
type PublicationSnapshot = {
  readonly headSha: string;
  readonly baseSha: string;
  readonly remoteSha: string | null;
  readonly baseBranch: string;
};
type RepositoryContext = {
  readonly branch: string;
  readonly rules: readonly GitHubBranchRule[];
  readonly sourceIssue?: unknown;
};
// The coordinator owns these captured run contexts and operation descriptors.
type PublicationExecution = {
  readonly data: { readonly runs?: Readonly<Record<string, {
    readonly stage: BotStage;
    readonly context?: { readonly repositoryRules?: RepositoryContext };
  }>> };
  readonly operations: Readonly<Record<string, { readonly prepared?: { readonly operation: string } }>>;
};
type PublicationBinding<Operation extends 'git.push' | 'jira.comment'> = {
  readonly identityId: string;
  readonly identityRevision: number;
  readonly target: BotOperationTarget<Operation>;
};
type RepositoryRequest = PublicationScope & { readonly stage: BotStage; readonly round: number };
type PublicationOptions = {
  readonly worktrees: {
    bindPublication(request: PublicationScope & { readonly branch: string }): Promise<{ readonly publicationBranch: string }>;
  };
  readonly services: {
    read(request: PublicationBinding<'git.push'> & { readonly scope: PublicationScope; readonly operation: 'github.branch-rules';
      readonly input: { readonly branch: string } }): Promise<readonly GitHubBranchRule[]>;
    read(request: PublicationBinding<'jira.comment'> & { readonly scope: PublicationScope; readonly operation: 'jira.issue' }): Promise<BotServiceReadValue>;
  };
  readonly serviceContext: (request: PublicationScope & (
    | { readonly service: 'github'; readonly operation: 'github.branch-rules' }
    | { readonly service: 'jira'; readonly operation: 'jira.issue' }
  )) => Promise<{ readonly github?: PublicationBinding<'git.push'>; readonly jira?: PublicationBinding<'jira.comment'> }>;
  readonly journal: { read(projectId: string, itemId: string): Promise<PublicationExecution> };
  readonly mutate: (projectId: string, itemId: string, change: (item: BotItem) => BotItem) => Promise<BotItem>;
};

const publicationKinds = new Set<string | undefined>(['git.push', 'pr.open', 'pr.comment', 'pr.auto-merge', 'pr.disable-auto-merge', 'pr.dequeue']);
export const botPublicationBranch = (item: Pick<PublicationItem, 'publicationBranch' | 'branch'>) => item.publicationBranch ?? item.branch;
export const botPushInput = (item: Pick<PublicationItem, 'publicationBranch' | 'branch' | 'worktree'>, snapshot: PublicationSnapshot): BotOperationInput<'git.push'> => {
  const input: BotOperationInput<'git.push'> = { directory: item.worktree, branch: botPublicationBranch(item), headSha: snapshot.headSha,
    baseSha: snapshot.remoteSha ?? snapshot.baseSha, expectedRemoteSha: snapshot.remoteSha, base: snapshot.baseBranch };
  if (item.publicationBranch !== undefined) input.localBranch = item.branch;
  return input;
};
const hasLegacyFixing = (item: BotItem, execution: PublicationExecution) => item.publicationBranch === undefined
  && Object.values(execution.data.runs ?? {}).some((run) => run.stage === 'fixing' && run.context?.repositoryRules === undefined);

/** Stage context is historical; only the private checkout owner can reserve a name. */
export function createBotPublication({ worktrees, services, serviceContext, journal, mutate }: PublicationOptions) {
  const repositoryContext = async ({ project, bot, item, stage, round }: RepositoryRequest): Promise<RepositoryContext | undefined> => {
    const execution = await journal.read(project.id, item.id);
    const captured = execution.data.runs?.[`${stage}:${round}`];
    if (captured) return captured.context?.repositoryRules;
    if (stage === 'fixing' && hasLegacyFixing(item, execution)) return undefined;
    const binding = (await serviceContext({ project, bot, item, service: 'github', operation: 'github.branch-rules' })).github;
    if (!binding) return undefined;
    const branch = botPublicationBranch(item);
    const rules = await services.read({ ...binding, scope: { project, bot, item }, operation: 'github.branch-rules', input: { branch } });
    if (stage === 'investigation' && item.source.kind === 'jira' && bot.identity.jira) {
      const jira = (await serviceContext({ project, bot, item, service: 'jira', operation: 'jira.issue' })).jira;
      if (!jira) throw new BotServiceError('BOT_IDENTITY_REQUIRED', 'Select the source issue identity before investigating its conventions.');
      const sourceIssue = await services.read({ ...jira, scope: { project, bot, item }, operation: 'jira.issue' });
      return { branch, rules, sourceIssue };
    }
    return { branch, rules };
  };
  return {
    repositoryContext,
    assertRemote(item: BotItem, snapshot: Pick<PublicationSnapshot, 'remoteSha'>, key: string) {
      if (item.publicationBranch === undefined || item.effects.some((effect) => effect.key === key && effect.kind === 'git.push')) return;
      const published = item.effects.findLast((effect): effect is Extract<BotEffect, { state: 'succeeded' }> => effect.kind === 'git.push' && effect.state === 'succeeded');
      if (snapshot.remoteSha !== (published?.receipt.sha ?? null)) {
        throw new BotServiceError('BOT_GIT_REMOTE_CHANGED', 'The reserved remote branch changed outside this item publication.');
      }
    },
    async bind({ project, bot, item, investigation }: PublicationScope & {
      readonly investigation?: Pick<BotStageReport['investigation'], 'publicationBranch'> | undefined;
    }) {
      // Captured operations keep their historical destination and digests.
      const execution = await journal.read(project.id, item.id);
      if (hasLegacyFixing(item, execution)) return item;
      if (item.publicationBranch === undefined && (item.pr || item.effects.some((effect) => publicationKinds.has(effect.kind))
        || Object.values(execution.operations).some((request) => publicationKinds.has(request.prepared?.operation)))) return item;
      let branch = item.publicationBranch ?? investigation?.publicationBranch;
      if (!branch) {
        const context = await repositoryContext({ project, bot, item, stage: 'investigation', round: 0 });
        if (context?.rules.some((rule) => rule.type === 'branch_name_pattern')) {
          throw new BotServiceError('BOT_PUBLICATION_BRANCH_REQUIRED', 'The project naming rules require a compliant publication branch proposal.');
        }
        branch = item.branch;
      }
      const owned = await worktrees.bindPublication({ project, bot, item, branch });
      if (item.publicationBranch !== undefined && item.publicationBranch !== owned.publicationBranch) {
        throw new BotServiceError('BOT_PUBLICATION_BRANCH_CHANGED', 'The reserved publication branch differs from the item.');
      }
      if (item.publicationBranch === owned.publicationBranch) return item;
      return mutate(project.id, item.id, (current) => ({ ...current, publicationBranch: owned.publicationBranch }));
    },
  };
}
