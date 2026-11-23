import { z } from 'zod';
import { BotServiceError, providerResult, sha, text } from './services/contracts.js';
import { botPublicationBranch } from './publication.js';
import type { ResolvedBotCredential } from './services/credentials.js';
import type { Author, BotAuthority, CreateLoop } from '../pr-fix-loop/contracts.js';
import type { GitHubFeedbackReader } from '../github/pr-feedback-reader.js';
import type { LocalPullRequestOptions, RemotePullRequestOptions, PullRequestOptions, PullRequestRequest, PullRequestStatus } from './production-pull-request-contracts.js';

type AuthorityDraft = { -readonly [Key in keyof BotAuthority]: BotAuthority[Key] };
type LoopDraft = { -readonly [Key in keyof CreateLoop]: CreateLoop[Key] };

function fail(code: string): never { throw new BotServiceError(code, 'The exact bot pull request authority could not be verified.'); }
const reviewAppsSchema = z.array(z.object({ slug: z.string().regex(/^[A-Za-z0-9_-]+$/), appId: z.number().int().positive() }).strict()).max(100);
const graphqlEnvelope = z.object({ errors: z.array(z.unknown()).nullish(), data: z.looseObject({ viewer: z.unknown(),
  repository: z.looseObject({ pullRequest: z.unknown() }).nullish(),
}).nullish() });
const feedbackPull = z.object({ headRefName: z.string(), headRepository: z.object({
  owner: z.object({ login: z.string() }).nullish(), name: z.string(),
}).nullish() });

const readerFor = (credential: ResolvedBotCredential<'github'>, authority: BotAuthority): GitHubFeedbackReader => {
  const get = (path: string) => credential.request({ path }).then((data) => ({ data }));
  return {
    graphql: async (query, variables) => {
      const response = providerResult(graphqlEnvelope.safeParse(await credential.request({ path: '/graphql', method: 'POST', readOnly: true, body: { query, variables } })));
      if (response.errors?.length || !response.data) fail('BOT_GITHUB_FEEDBACK_FAILED');
      const rawPull = response.data.repository?.pullRequest;
      const parsed = feedbackPull.safeParse(rawPull);
      if (rawPull && !parsed.success) fail('BOT_GITHUB_PULL_CHANGED');
      const pull = parsed.success ? parsed.data : null;
      if (pull && (pull.headRefName !== (authority.publicationBranch ?? `bot/${authority.itemId}`)
        || pull.headRepository?.owner?.login.toLowerCase() !== authority.target.owner.toLowerCase()
        || pull.headRepository?.name.toLowerCase() !== authority.target.repo.toLowerCase())) fail('BOT_GITHUB_PULL_CHANGED');
      return response.data;
    },
    rest: {
      repos: { getCollaboratorPermissionLevel: ({ owner, repo, username }) => get(`/repos/${owner}/${repo}/collaborators/${encodeURIComponent(username)}/permission`) },
      checks: { listAnnotations: ({ owner, repo, check_run_id, per_page }) => get(`/repos/${owner}/${repo}/check-runs/${check_run_id}/annotations?per_page=${per_page}`) },
      actions: {
        getJobForWorkflowRun: ({ owner, repo, job_id }) => get(`/repos/${owner}/${repo}/actions/jobs/${job_id}`),
        downloadJobLogsForWorkflowRun: ({ owner, repo, job_id }) => get(`/repos/${owner}/${repo}/actions/jobs/${job_id}/logs`),
      },
    },
  };
};

function buildProductionBotPullRequests(options: PullRequestOptions) {
  const { context, services, getFixLoopRuntime, receiveFeedback, reviewApps, resolvePublication = async () => null,
    execution = null, withWatchAdmission = (work) => work() } = options;
  if (!context?.github || !services?.read || !getFixLoopRuntime || !receiveFeedback) throw new TypeError('Bot PR adapters require context, services and runtime callbacks');
  const approvedApps = reviewAppsSchema.parse(reviewApps);
  const validatePublication = async (authority: BotAuthority) => {
    if (authority.publicationBranch === undefined) return;
    const owned = await resolvePublication({ repositoryId: authority.target.repositoryId, botId: authority.botId, itemId: authority.itemId });
    if (!owned || owned.publicationBranch !== authority.publicationBranch || owned.identityId !== authority.identityId
      || owned.identityRevision !== authority.identityRevision || owned.localBranch !== `bot/${authority.itemId}`) fail('BOT_GITHUB_PULL_CHANGED');
  };
  const authorityFor = async ({ project, bot, item }: PullRequestRequest) => {
    if (!item.pr || item.branch !== `bot/${item.id}` || !item.worktree || !item.sessions.fixing || item.botId !== bot.id) fail('BOT_PULL_REQUEST_REQUIRED');
    const { binding } = await context.github({ project, bot });
    const authority: AuthorityDraft = {
      project: { id: project.id, path: project.path }, botId: bot.id, itemId: item.id, ...binding };
    if (item.publicationBranch !== undefined) authority.publicationBranch = item.publicationBranch;
    await validatePublication(authority);
    return { authority, pull: item.pr, sessionId: item.sessions.fixing, directory: item.worktree, branch: item.branch };
  };
  const credentialFor = async (authority: BotAuthority) => {
    await validatePublication(authority);
    if (options.execution) throw new TypeError('Separated Bot PR operations require their execution owner');
    const resolved = await options.context.github({ project: authority.project,
      binding: { identityId: authority.identityId, identityRevision: authority.identityRevision, target: authority.target } });
    return resolved.credential;
  };
  const localReader = async (authority: BotAuthority) => {
    await validatePublication(authority);
    return readerFor(await credentialFor(authority), authority);
  };
  const botWatch = Object.freeze({
    async getOctokit(authority: BotAuthority) {
      if (!execution) return localReader(authority);
      await validatePublication(authority);
      return execution.getOctokit(authority);
    },
    deliver: (authority: BotAuthority, event: Parameters<PullRequestOptions['receiveFeedback']>[2]) => receiveFeedback(authority.project.id, authority.itemId, event),
    async authorizeApp(authority: BotAuthority, author: Author) {
      const selected = approvedApps.find((entry) => `${entry.slug}[bot]`.toLowerCase() === author.login.toLowerCase());
      if (!author.bot || !selected) return false;
      if (execution) return execution.authorizeApp(authority, author, selected);
      const credential = await credentialFor(authority);
      const app = providerResult(z.object({ id: z.number().int().positive(), slug: text }).safeParse(
        await credential.request({ path: `/apps/${encodeURIComponent(selected.slug)}` })));
      const user = providerResult(z.object({ id: z.number().int().positive(), login: text, type: z.literal('Bot') }).safeParse(
        await credential.request({ path: `/users/${encodeURIComponent(author.login)}` })));
      if (app.id !== selected.appId || app.slug.toLowerCase() !== selected.slug.toLowerCase()
        || user.login.toLowerCase() !== author.login.toLowerCase()) fail('BOT_REVIEW_APP_CHANGED');
      return true;
    },
  });
  const readStatus = async (request: PullRequestRequest): Promise<{ readonly open: boolean; readonly status: PullRequestStatus }> => {
    const { authority, pull: requestedPull, branch } = await authorityFor(request);
    if (execution) return execution.readStatus({ ...request, authority });
    const credential = await credentialFor(authority);
    const { target } = authority;
    const pull = providerResult(z.object({ head: text, headSha: sha, base: text, state: z.enum(['open', 'closed']) }).safeParse(await services.read({ identityId: authority.identityId, identityRevision: authority.identityRevision,
      target, operation: 'github.pull', input: { number: requestedPull.number } })));
    if (pull.head !== botPublicationBranch({ ...request.item, branch })) fail('BOT_GITHUB_PULL_CHANGED');
    const response = providerResult(graphqlEnvelope.safeParse(await credential.request({ path: '/graphql', method: 'POST', readOnly: true, body: {
      query: `query BotPullAdmission($owner:String!,$repo:String!,$number:Int!) { repository(owner:$owner,name:$repo) {
        pullRequest(number:$number) { number headRefOid baseRefOid headRefName baseRefName merged reviewDecision
          headRepository { nameWithOwner } baseRepository { nameWithOwner } }
      } }`, variables: { owner: target.owner, repo: target.repo, number: requestedPull.number },
    } })));
    if (response.errors?.length) fail('BOT_GITHUB_FEEDBACK_FAILED');
    const status = providerResult(z.object({ number: z.number().int().positive(), headRefOid: sha, baseRefOid: sha,
      headRefName: text, baseRefName: text, merged: z.boolean(), reviewDecision: z.string().nullable(),
      headRepository: z.object({ nameWithOwner: text }), baseRepository: z.object({ nameWithOwner: text }),
    }).safeParse(response.data?.repository?.pullRequest));
    const repository = `${target.owner}/${target.repo}`.toLowerCase();
    if (status.number !== requestedPull.number || status.headRefName !== botPublicationBranch({ ...request.item, branch }) || status.headRefOid !== pull.headSha
      || status.baseRefName !== pull.base || status.headRepository.nameWithOwner.toLowerCase() !== repository
      || status.baseRepository.nameWithOwner.toLowerCase() !== repository) fail('BOT_GITHUB_PULL_CHANGED');
    const rules = providerResult(z.object({ headSha: sha, mergeQueue: z.boolean() }).safeParse(await services.read({ identityId: authority.identityId, identityRevision: authority.identityRevision,
      target, operation: 'github.rules', input: { branch: pull.base } })));
    return { open: pull.state === 'open', status: { headSha: status.headRefOid, baseSha: rules.headSha, merged: status.merged,
      approved: status.reviewDecision === 'APPROVED', mergeMode: rules.mergeQueue ? 'queue' : 'auto-merge' } };
  };
  const attach = async (request: PullRequestRequest) => {
    const { authority, pull, sessionId, directory, branch } = await authorityFor(request);
    const input: LoopDraft = { sessionId, directory,
      owner: authority.target.owner, repo: authority.target.repo, number: pull.number,
      branch: botPublicationBranch({ ...request.item, branch }), url: pull.url };
    if (request.item.title !== undefined) input.title = request.item.title;
    return withWatchAdmission(() => getFixLoopRuntime().createBotWatch(input, authority));
  };
  const pullRequests = Object.freeze({
    async ensureLoop(request: PullRequestRequest) {
      await readStatus(request);
      return attach(request);
    },
    async read(request: PullRequestRequest) {
      const { open, status } = await readStatus(request);
      if (open) await attach(request);
      return status;
    },
    async stop(request: { readonly project: PullRequestRequest['project']; readonly bot: Pick<PullRequestRequest['bot'], 'id'>; readonly item: Pick<PullRequestRequest['item'], 'id' | 'botId' | 'pr'> }) {
      if (!request.item.pr) return;
      if (request.item.botId !== request.bot.id) fail('BOT_PULL_REQUEST_REQUIRED');
      await getFixLoopRuntime().stopBotWatch({ projectId: request.project.id, botId: request.bot.id, itemId: request.item.id });
    },
  });
  if (execution) return { kind: 'separated', owners: Object.freeze({ pullRequests, botWatch }) } as const;
  return { kind: 'local', owners: Object.freeze({ pullRequests, botWatch: Object.freeze({ ...botWatch, getOctokit: localReader }) }) } as const;
}

type BuiltPullRequests = ReturnType<typeof buildProductionBotPullRequests>;
export type LocalBotPullRequests = Extract<BuiltPullRequests, { readonly kind: 'local' }>['owners'];
type RemoteBotPullRequests = Extract<BuiltPullRequests, { readonly kind: 'separated' }>['owners'];
export function createProductionBotPullRequests(options: LocalPullRequestOptions): LocalBotPullRequests;
export function createProductionBotPullRequests(options: RemotePullRequestOptions): RemoteBotPullRequests;
export function createProductionBotPullRequests(options: PullRequestOptions): LocalBotPullRequests | RemoteBotPullRequests;
export function createProductionBotPullRequests(options: PullRequestOptions): LocalBotPullRequests | RemoteBotPullRequests {
  return buildProductionBotPullRequests(options).owners;
}
