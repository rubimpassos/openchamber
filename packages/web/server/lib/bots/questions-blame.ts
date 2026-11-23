import { z } from 'zod';
import { botGit } from './production-git.js';
import { BotServiceError, providerResult, revision, sha, text } from './services/contracts.js';
import type { BotDefinition } from './config.js';
import type { BotItem } from './schema.js';
import type { ResolvedBotCredential } from './services/credentials.js';

type BlameScope = {
  readonly project: { readonly id: string; readonly path: string };
  readonly bot: BotDefinition;
};
type BlameRequest = BlameScope & {
  readonly item: Pick<BotItem, 'id' | 'botId' | 'worktree'>;
  readonly snapshot: {
    readonly baseSha: string;
    readonly headSha: string;
    readonly changes: readonly { readonly oldPath?: string | null | undefined }[];
  };
};
type BlameContext = {
  readonly github: (scope: BlameScope) => Promise<{
    readonly binding: { readonly target: { readonly owner: string; readonly repo: string } };
    readonly credential: Pick<ResolvedBotCredential<'github'>, 'request'>;
  }>;
};
type BlameAuthor = {
  readonly sha: string;
  readonly github: string;
  readonly githubId: number;
  readonly committedAt: string;
  readonly files: readonly string[];
};

const commitSchema = z.object({ sha, author: z.object({ login: text, id: revision, type: z.enum(['User', 'Bot']) }).nullable(),
  commit: z.object({ committer: z.object({ date: z.iso.datetime() }) }) });

export function createBotQuestionBlame({ context }: { readonly context: BlameContext }) {
  if (!(context?.github instanceof Function)) throw new TypeError('Question blame requires the GitHub credential owner');
  return async ({ project, bot, item, snapshot }: BlameRequest): Promise<BlameAuthor[]> => {
    sha.parse(snapshot.baseSha);
    sha.parse(snapshot.headSha);
    const files = [...new Set(snapshot.changes.flatMap((change) => change.oldPath ? [change.oldPath] : []))].sort();
    if (!files.length) return [];
    if (files.length > 20) throw new BotServiceError('BOT_QUESTION_BLAME_LIMIT', 'Question attribution exceeds 20 changed files.');
    const directory = item.worktree;
    if (directory === undefined) throw new BotServiceError('BOT_GIT_LOCAL_FAILED', 'The bot Git operation failed; retained work requires inspection.');
    const ancestor = sha.parse((await botGit(directory, ['merge-base', snapshot.baseSha, snapshot.headSha])).trim());
    const commits = new Map<string, Set<string>>();
    for (const file of files) {
      const output = await botGit(directory, ['--literal-pathspecs', 'blame', '--line-porcelain', '--no-textconv', ancestor, '--', file]);
      for (const match of output.matchAll(/^([a-f0-9]{40}) [0-9]+ [0-9]+(?: [0-9]+)?$/gm)) {
        const commit = match[1];
        if (commit === undefined) continue;
        const paths = commits.get(commit) ?? new Set<string>();
        paths.add(file); commits.set(commit, paths);
      }
      if (commits.size > 100) throw new BotServiceError('BOT_QUESTION_BLAME_LIMIT', 'Question attribution exceeds 100 commits.');
    }
    if (!commits.size) return [];
    const { binding, credential } = await context.github({ project, bot });
    const authors: BlameAuthor[] = [];
    for (const [commit, paths] of commits) {
      const result = providerResult(commitSchema.safeParse(await credential.request({
        path: `/repos/${binding.target.owner}/${binding.target.repo}/commits/${commit}`,
      })));
      if (result.sha !== commit) throw new BotServiceError('BOT_QUESTION_COMMIT_MISMATCH', 'GitHub returned another commit.');
      if (result.author?.type === 'User') authors.push({ sha: commit, github: result.author.login,
        githubId: result.author.id, committedAt: result.commit.committer.date, files: [...paths] });
    }
    return authors.sort((left, right) => right.committedAt.localeCompare(left.committedAt) || left.sha.localeCompare(right.sha));
  };
}
