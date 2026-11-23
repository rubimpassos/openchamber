import { z } from 'zod';
import { jiraOrigin } from './services/contracts.js';
import { sourceCandidateSchema } from './prompts.js';
import type { BotDefinition } from './config.js';
import type { createBotDiscovery } from './discovery.js';
import type { createBotProviderRuntime } from './provider-runtime.js';
import type { BotServiceReadValue } from './services.js';

type SourceScope = {
  readonly project: { readonly id: string; readonly path: string };
  readonly bot: BotDefinition;
};
type JiraSourceRequest = SourceScope & { readonly jql: string; readonly maxItems: number };
type JiraSearchInput = { readonly jql: string; readonly maxResults: number; nextPageToken?: string };
type SourceOptions = {
  readonly resolveJiraContext: (scope: SourceScope) => ReturnType<ReturnType<typeof createBotProviderRuntime>['resolveJiraContext']>;
  readonly discover: ReturnType<typeof createBotDiscovery>['discover'];
  readonly services: {
    readonly read: (request: {
      readonly identityId: string;
      readonly identityRevision: number;
      readonly operation: 'jira.search';
      readonly scope: SourceScope & { readonly item: {
        readonly id: string; readonly botId: string;
        readonly source: { readonly kind: 'investigation'; readonly id: 'jira-search' };
        readonly sessions: Readonly<Record<string, never>>;
      } };
      readonly target: Readonly<Record<string, never>>;
      readonly input: JiraSearchInput;
    }) => Promise<BotServiceReadValue>;
  };
};

const contextSchema = z.object({ identityId: z.string().min(1), identityRevision: z.number().int().positive(), site: z.string() }).strict();
const pageSchema = z.object({ issues: z.array(z.object({ key: z.string().regex(/^[A-Z][A-Z0-9_]{0,63}-[1-9][0-9]*$/), summary: z.string().min(1), description: z.string() })), nextPageToken: z.string().nullable() });

/** JQL admission spends no model tokens. Discovery owns its read-only session. */
export const createBotSources = ({ services, resolveJiraContext, discover }: SourceOptions) => {
  if (!(services?.read instanceof Function) || !(resolveJiraContext instanceof Function) || !(discover instanceof Function)) throw new TypeError('Bot sources require provider reads, exact Jira context and read-only discovery');
  return {
    async jira({ project, bot, jql, maxItems }: JiraSourceRequest) {
      z.number().int().positive().parse(maxItems);
      z.string().min(1).parse(jql);
      const context = contextSchema.parse(await resolveJiraContext({ project, bot }));
      const site = jiraOrigin(context.site);
      const candidates = new Map<string, z.output<typeof sourceCandidateSchema>>();
      const cursors = new Set<string>();
      let nextPageToken: string | null | undefined;
      do {
        const input: JiraSearchInput = { jql, maxResults: Math.min(100, maxItems - candidates.size) };
        if (nextPageToken) input.nextPageToken = nextPageToken;
        const page = pageSchema.parse(await services.read({ identityId: context.identityId, identityRevision: context.identityRevision,
          scope: { project, bot, item: { id: `discovery_jira_${bot.id}`, botId: bot.id,
            source: { kind: 'investigation', id: 'jira-search' }, sessions: {} } },
          operation: 'jira.search', target: {},
          input,
        }));
        for (const issue of page.issues) {
          candidates.set(issue.key, sourceCandidateSchema.parse({ source: { kind: 'jira', id: issue.key, url: `${site}/browse/${encodeURIComponent(issue.key)}` }, title: issue.summary, description: issue.description,
            evidence: [{ source: issue.key, summary: issue.summary, url: `${site}/browse/${encodeURIComponent(issue.key)}` }] }));
          if (candidates.size === maxItems) break;
        }
        nextPageToken = page.nextPageToken;
        if (nextPageToken && cursors.has(nextPageToken)) throw new Error('Jira repeated a pagination cursor');
        if (nextPageToken) cursors.add(nextPageToken);
      } while (nextPageToken && candidates.size < maxItems);
      return [...candidates.values()];
    },
    async investigate(request: Parameters<SourceOptions['discover']>[0]) { return z.array(sourceCandidateSchema).parse(await discover(request)); },
  };
};
