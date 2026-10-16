import path from 'node:path';
import { z } from 'zod';

const issueTitleSchema = z.object({ title: z.string().trim().min(1) });
const cursorSchema = z.string().nullable().optional();
const issuePageSchema = z.object({ items: z.array(issueTitleSchema), hasMore: z.boolean(), cursor: cursorSchema });
const linearPageSchema = z.object({
  connected: z.literal(true),
  issues: z.array(issueTitleSchema.extend({
    team: z.object({ id: z.string() }).nullish(),
    state: z.object({ type: z.string() }).nullish(),
  })),
  hasMore: z.boolean(),
  cursor: cursorSchema,
});

const MAX_PAGES = 10;
const loadGitHub = async () => ({
  ...await import('../github/octokit.js'),
  ...await import('../github/repo/index.js'),
  ...await import('../github/reference-search.js'),
});
const loadGitLab = async () => ({
  ...await import('../gitlab/client.js'),
  ...await import('../gitlab/resources.js'),
});
const loadLinear = () => import('../linear/index.js');

/** Read only explicitly bound repositories and the current workspace's mapped Linear issues.
 * Warnings distinguish an incomplete list from an authoritative empty result.
 */
export function createProjectOpenIssuesReader({
  getBindingService,
  readSourceControlAccount,
  loadGitHubLibraries = loadGitHub,
  loadGitLabLibraries = loadGitLab,
  loadLinearLibraries = loadLinear,
}) {
  return async function readProjectOpenIssues(directory) {
    const titles = new Set();
    const warnings = [];
    const warn = (provider, kind, reason) => warnings.push({
      provider, kind, message: `${provider} open issue deduplication ${reason}.`,
    });
    const addTitles = (items) => {
      for (const item of items) titles.add(item.title);
    };

    try {
      const bindingService = getBindingService();
      if (!bindingService) throw new Error('Source control is not ready');
      const read = await bindingService.get(directory);
      for (const provider of read.binding?.providers ?? []) {
        if (provider.readiness !== 'ready') {
          warn(provider.provider, 'unavailable', 'is unavailable because its project binding needs attention');
          continue;
        }
        let pagesRead = 0;
        try {
          const context = {
            directory,
            repositoryId: read.repository.repositoryId,
            bindingRevision: read.revision,
            provider: provider.provider,
            instance: provider.instance,
            accountId: provider.accountId,
            primaryRemote: provider.primaryRemote,
          };
          // Validate before credential lookup, and again before every subsequent page.
          const trusted = await bindingService.validateReadContext(context);
          let readPage;
          if (trusted.provider === 'github') {
            const { getOctokitForAccountId, resolveGitHubRepoFromDirectory, searchGitHubReferences } = await loadGitHubLibraries();
            const account = await getOctokitForAccountId(trusted.accountId, {
              onUnauthorized: (identity) => bindingService.accountUnavailable(identity),
            });
            if (!account?.octokit) throw new Error('Bound GitHub account is unavailable');
            const { repo } = await resolveGitHubRepoFromDirectory(directory, trusted.primaryRemote);
            if (!repo) throw new Error('Bound GitHub repository is unavailable');
            // The bound repository alone owns this project's issue backlog.
            readPage = (cursor) => searchGitHubReferences({
              octokit: account.octokit, repos: [{ ...repo, source: 'origin' }],
              kind: 'issue', state: 'open', people: 'any', text: '', cursor,
            });
          } else if (trusted.provider === 'gitlab') {
            const account = await readSourceControlAccount(trusted);
            if (!account?.token) throw new Error('Bound GitLab account is unavailable');
            const { createGitLabClient, createGitLabResourceService } = await loadGitLabLibraries();
            const service = createGitLabResourceService({
              origin: trusted.instance,
              client: createGitLabClient({
                origin: trusted.instance, token: account.token,
                tokenType: account.source === 'pat' ? 'token' : 'oauth',
              }),
              canonicalReads: true,
            });
            readPage = (_cursor, page) => service.listIssues(directory, {
              remote: trusted.primaryRemote, state: 'open', people: 'any', page,
            });
          } else {
            throw new Error('Unsupported bound provider');
          }
          let cursor = null;
          for (let page = 1; page <= MAX_PAGES; page += 1) {
            if (page > 1) await bindingService.validateReadContext(context);
            const result = issuePageSchema.parse(await readPage(cursor, page));
            addTitles(result.items);
            pagesRead += 1;
            if (!result.hasMore) break;
            if (page === MAX_PAGES) {
              warn(provider.provider, 'partial', `was truncated after ${MAX_PAGES} pages`);
              break;
            }
            if (trusted.provider === 'github' && (!result.cursor || result.cursor === cursor)) throw new Error('Invalid issue cursor');
            cursor = result.cursor;
          }
        } catch {
          warn(provider.provider, pagesRead ? 'partial' : 'unavailable', 'could not read all bound project issues');
        }
      }
    } catch {
      warn('source-control', 'unavailable', 'could not read the project binding');
    }

    let linearPagesRead = 0;
    try {
      const linear = await loadLinearLibraries();
      const workspaceId = linear.getLinearAuth()?.workspaceId;
      if (!workspaceId) return { titles: [...titles], warnings };
      const mapping = linear.readStoredLinearMapping();
      const matchesProject = (mappedPath) => Boolean(mappedPath) && path.resolve(mappedPath) === path.resolve(directory);
      if (!matchesProject(mapping.defaultProjectPath)
        && !Object.values(mapping.teamProjectPaths).some(matchesProject)) return { titles: [...titles], warnings };
      let cursor = null;
      for (let page = 1; page <= MAX_PAGES; page += 1) {
        // Existing list and mapping APIs both select the current workspace.
        // Refuse a switched workspace before using any response with this mapping.
        if (linear.getLinearAuth()?.workspaceId !== workspaceId) throw new Error('Linear workspace changed');
        const result = linearPageSchema.parse(await linear.listLinearIssues({ status: 'open', assignee: 'any', cursor }));
        if (linear.getLinearAuth()?.workspaceId !== workspaceId) throw new Error('Linear workspace changed');
        addTitles(result.issues.filter((issue) => matchesProject(mapping.teamProjectPaths[issue.team?.id] || mapping.defaultProjectPath)
          && !['completed', 'canceled', 'cancelled', 'duplicate'].includes(issue.state?.type)));
        linearPagesRead += 1;
        if (!result.hasMore) break;
        if (page === MAX_PAGES) {
          warn('linear', 'partial', `was truncated after ${MAX_PAGES} pages`);
          break;
        }
        if (!result.cursor || result.cursor === cursor) throw new Error('Invalid Linear cursor');
        cursor = result.cursor;
      }
    } catch {
      warn('linear', linearPagesRead ? 'partial' : 'unavailable', 'could not read all mapped project issues');
    }
    return { titles: [...titles], warnings };
  };
}
