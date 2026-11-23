import { z } from 'zod';
import { BotServiceError, githubTarget, jiraTarget, discordTarget, opaqueId, parse, revision, branch, sha } from './contracts.js';
import { createGitHubAdapter } from './github.js';
import { createJiraAdapter, searchJiraIssues } from './jira.js';
import { createDiscordAdapter } from './discord.js';
import { publishBotGit } from './git.js';
import type { createCredentialResolver } from './credentials.js';
import type { JiraCommentPage } from './jira.js';

export type BotServiceReadRequest = {
  readonly identityId: string;
  readonly identityRevision: number;
  readonly operation: string;
  readonly target: unknown;
  readonly input?: { readonly startAt?: number | undefined; readonly branch?: string; readonly number?: number; readonly headSha?: string;
    readonly jql?: string; readonly nextPageToken?: string; readonly maxResults?: number };
};
const githubRead = (operation: string, rawInput: NonNullable<BotServiceReadRequest['input']>) => {
  switch (operation) {
  case 'github.rules':
  case 'github.branch':
  case 'github.branch-rules': return [operation, parse(z.object({ branch }).strict().safeParse(rawInput))] as const;
  case 'github.pull': return [operation, parse(z.object({ number: revision, headSha: sha.optional() }).strict().safeParse(rawInput))] as const;
  case 'github.authorization': return [operation, parse(z.object({ number: revision, branch }).strict().safeParse(rawInput))] as const;
  default: return null;
  }
};

type ReadResult = Awaited<ReturnType<ReturnType<typeof createGitHubAdapter>['read'] | ReturnType<typeof createJiraAdapter>['read'] | ReturnType<typeof createDiscordAdapter>['read'] | typeof searchJiraIssues>>;

export function createBotReader(resolve: ReturnType<typeof createCredentialResolver>) {
  function read(request: BotServiceReadRequest & { readonly operation: 'jira.comments' }): Promise<JiraCommentPage>;
  function read(request: BotServiceReadRequest): Promise<ReadResult>;
  async function read({
    identityId, identityRevision, operation, target: rawTarget, input: rawInput = {},
  }: BotServiceReadRequest): Promise<ReadResult> {
    parse(opaqueId.safeParse(identityId)); parse(revision.safeParse(identityRevision));
    const service = operation.startsWith('github.') ? 'github' : operation.startsWith('jira.') ? 'jira'
      : operation.startsWith('discord.') ? 'discord' : null;
    if (!service) throw new BotServiceError('BOT_SERVICE_UNSUPPORTED', 'This bot provider read is unsupported.', 'failed', 400);
    if (operation === 'jira.search') {
      const target = parse(z.object({}).strict().safeParse(rawTarget));
      const credential = await resolve({ identityId, identityRevision, service: 'jira', target });
      return searchJiraIssues(credential, rawInput);
    }
    switch (service) {
    case 'github': {
      const target = parse(githubTarget.safeParse(rawTarget));
      const call = githubRead(operation, rawInput);
      const credential = await resolve({ identityId, identityRevision, service, target });
      if (!call) throw new BotServiceError('BOT_SERVICE_UNSUPPORTED', 'This GitHub read is unsupported.', 'failed', 400);
      return createGitHubAdapter(credential, target, { publishGit: publishBotGit }).read(...call);
    }
    case 'jira': {
      const target = parse(jiraTarget.safeParse(rawTarget));
      const credential = await resolve({ identityId, identityRevision, service, target });
      return createJiraAdapter(credential, target).read(operation, rawInput);
    }
    case 'discord': {
      const target = parse(discordTarget.safeParse(rawTarget));
      const credential = await resolve({ identityId, identityRevision, service, target });
      return createDiscordAdapter(credential, target).read(operation);
    }
    default: service satisfies never; throw new BotServiceError('BOT_SERVICE_UNSUPPORTED', 'This bot provider read is unsupported.', 'failed', 400);
    }
  }
  return read;
}
