import { z } from 'zod';
import { sha } from './services/contracts.js';
import { botGit } from './production-git.js';
import { botNoticeIds } from '../message-queue/bot-notice.js';
import { readPullFeedback, readFeedbackAuthorPermission, readFailedChecks } from '../github/pr-feedback.js';
import { fitFeedback } from '../agent-server/fix-loop-feedback-contract.js';
import { BOT_SERVICE_BYTES, assertBotEffectInput, botBoundaryError } from '../agent-server/bot-service-contract.js';
import type { BotServiceInput } from '../agent-server/bot-service-contract.js';
import type { OperationHandlers } from '../agent-server/bot-services.types.js';
import type { BotServiceReadRequest } from './services/reads.js';
import { readRepositoryPolicyFiles } from './repository-policy.js';
import { fail, same } from './agent-execution-owner.js';
import type { createBotExecutionOwner } from './agent-execution-owner.js';
import { createBotExecutionStages } from './agent-execution-stages.js';
import type { createProductionBotWorktrees } from './production-worktrees.js';

type ReadInput = NonNullable<BotServiceReadRequest['input']>;
type ReadInputDraft = { -readonly [Key in keyof ReadInput]: ReadInput[Key] };
type RemovalRequest = Parameters<ReturnType<typeof createProductionBotWorktrees>['remove']>[0];
type RemovalDraft = { -readonly [Key in keyof RemovalRequest]: RemovalRequest[Key] };
const ok = () => ({ ok: true });
const withAccountRevision = <Binding extends object>(binding: Binding, identity: BotServiceInput<'context'>['expectedIdentity']) => {
  const result: Binding & { accountId?: string; credentialRevision?: number } = { ...binding };
  if (identity?.kind === 'github-account') {
    if (identity.accountId !== undefined) result.accountId = identity.accountId;
    if (identity.credentialRevision !== undefined) result.credentialRevision = identity.credentialRevision;
  }
  return result;
};
const localReadRequest = (request: BotServiceInput<'service-read'>['request']): BotServiceReadRequest => {
  const { input } = request;
  const local: ReadInputDraft = {};
  if ('branch' in input && input.branch !== undefined) local.branch = input.branch;
  if ('number' in input && input.number !== undefined) local.number = input.number;
  if ('headSha' in input && input.headSha !== undefined) local.headSha = input.headSha;
  if ('startAt' in input && input.startAt !== undefined) local.startAt = input.startAt;
  if ('jql' in input && input.jql !== undefined) local.jql = input.jql;
  if ('nextPageToken' in input && input.nextPageToken !== undefined) local.nextPageToken = input.nextPageToken;
  if ('maxResults' in input && input.maxResults !== undefined) local.maxResults = input.maxResults;
  return { ...request, input: local };
};

export function createBotExecutionHandlers(owner: ReturnType<typeof createBotExecutionOwner>): OperationHandlers {
  const { deps, identities, gateway, context, expectedIdentity, servicesFor, registeredProject, checkout, verifySession,
    requestFor, worktreesFor, resolvePublicationFor, activity, readTokens, isWorking, proof, verifySelectedService,
    blame, prFor, watchReader, trustRetainedCheckout, watchScope, reviewApps, inbox } = owner;
  const { readSessionDefaults, sessionKnowledgeRuntime, clientFor } = deps;
  return {
    'conversation-ensure': async ({ capture }) => { await registeredProject(capture.project); return owner.conversations.ensure(capture); },
    'conversation-read': async ({ target }) => { await registeredProject(target.project); return owner.conversations.read(target); },
    'conversation-prepare': async ({ target }) => { await registeredProject(target.project); await owner.conversations.prepare(target); return ok(); },
    'conversation-tokens': async ({ target }) => { await registeredProject(target.project); return owner.conversations.tokens(target); },
    'conversation-stop': async ({ target }) => { await registeredProject(target.project); await owner.conversations.stop(target); return ok(); },
    'conversation-notice': async ({ target, notice }) => { await registeredProject(target.project); await owner.conversations.notice(target, notice); return ok(); },
    'conversation-native': async ({ target, request }) => { await registeredProject(target.project); return owner.conversations.dispatch(target, request); },
    ...createBotExecutionStages(owner),
    'identity-list': async () => identities.list(),
    'identity-create': async (input) => identities.create(input.definition),
    'identity-update': async (input) => identities.update(input.id, input.expectedRevision, input.definition),
    'identity-remove': async (input) => identities.remove(input.id, input.expectedRevision),
    'gateway-open': async (input, { signal }) => gateway.open(input, { signal }),
    'gateway-pull': async (input, { signal }) => gateway.pull(input, { signal }),
    'gateway-send': async (input) => gateway.send(input),
    'gateway-close': async (input) => gateway.close(input),
    repository: async (input) => context.repository(await registeredProject(input.project)),
    'github-binding': async (input) => {
      const identity = await expectedIdentity(input.expectedIdentity, input.bot, 'github');
      const request = input.bot ? input.binding ? { project: input.project, bot: input.bot, binding: input.binding } : { project: input.project, bot: input.bot }
        : input.binding ? { project: input.project, binding: input.binding } : fail('BOT_IDENTITY_REQUIRED');
      return { binding: withAccountRevision((await context.github(request)).binding, identity) };
    },
    context: async (input) => {
      const scope = input.scope; const request = requestFor(scope);
      const operationService = input.operation.startsWith('git.') || input.operation.startsWith('pr.') ? 'github' : input.operation.split('.')[0];
      if (operationService !== input.service) fail('BOT_SERVICE_UNSUPPORTED');
      const identity = await expectedIdentity(input.expectedIdentity, scope.bot, input.service);
      if (input.service !== 'discord') {
        const resolved = await context.serviceContext({ ...request, service: input.service, operation: input.operation });
        const binding = resolved[input.service];
        return binding ? { [input.service]: withAccountRevision(binding, identity) } : {};
      }
      const target = input.target ?? (scope.bot.discord.channels.length === 1 ? scope.bot.discord.channels[0] : null);
      if (!target) fail('BOT_DISCORD_DESTINATION_REQUIRED');
      if (!identity) fail('BOT_IDENTITY_REQUIRED');
      const binding = { identityId: identity.id, identityRevision: identity.revision, target };
      await servicesFor(scope).read({ ...binding, operation: 'discord.channel' }); return { discord: binding };
    },
    'policy-files': async (input) => (deps.readPolicyFiles ?? readRepositoryPolicyFiles)((await registeredProject(input.project)).path, { files: input.files }),
    defaults: async (input) => readSessionDefaults((await registeredProject(input.project)).id),
    knowledge: async ({ scope }) => sessionKnowledgeRuntime.collect(scope.item.worktree ? (await checkout(scope)).directory : scope.project.path),
    'knowledge-sync': async (input) => {
      const { directory } = await verifySession(input.scope, input.sessionId);
      await sessionKnowledgeRuntime.sync(input.sessionId, directory, { includeMemorySaveRule: input.includeMemorySaveRule }); return ok();
    },
    'worktree-create': async ({ scope, key }) => {
      if (key !== scope.checkoutKey) fail('BOT_EXECUTION_CHECKOUT_KEY_REQUIRED');
      return worktreesFor(scope).create({ ...requestFor(scope), key });
    },
    'worktree-reconcile': async (input) => worktreesFor(input.scope).reconcile({ ...requestFor(input.scope), key: input.scope.checkoutKey, operation: input.operation }),
    'worktree-inspect': async ({ scope }) => { await checkout(scope); return worktreesFor(scope).inspect(requestFor(scope)); },
    'worktree-bind-publication': async ({ scope, branch }) => { await checkout(scope); return worktreesFor(scope).bindPublication({ ...requestFor(scope), branch }); },
    'worktree-read-publication': async (input) => {
      const scope = input.scope;
      if ((await context.repository(scope.project)).target.repositoryId !== input.repositoryId) fail('BOT_DESTINATION_CHANGED');
      return resolvePublicationFor(scope)({ repositoryId: input.repositoryId, botId: scope.bot.id, itemId: scope.item.id });
    },
    'worktree-adopt-isolated': async (input) => worktreesFor(input.scope).adoptIsolated({ ...requestFor(input.scope), resultSha: input.resultSha, spaceId: input.spaceId }),
    'worktree-accept-published': async (input) => { await checkout(input.scope); return worktreesFor(input.scope).acceptPublished({ ...requestFor(input.scope), snapshot: input.snapshot, result: input.result }); },
    'worktree-remove': async (input) => {
      const request: RemovalDraft = { ...requestFor(input.scope), key: input.scope.checkoutKey };
      if (input.checkout) request.checkout = input.checkout;
      return worktreesFor(input.scope).remove(request);
    },
    'worktree-same-tree': async (input) => {
      const owned = await checkout(input.scope);
      const tree = async (commit: string) => sha.parse((await botGit(owned.directory, ['rev-parse', `${commit}^{tree}`])).trim());
      return { same: await tree(input.left) === await tree(input.right) };
    },
    'stage-stop': async (input) => {
      const { directory } = await verifySession(input.scope, input.sessionId);
      await clientFor(directory).session.interrupt({ sessionID: input.sessionId });
      const statuses = await activity.fetchActiveSessionStatuses();
      if (statuses === null || statuses[input.sessionId] || await activity.hasWorkingDescendants(input.sessionId, statuses) !== false) fail('BOT_EXECUTION_SESSION_NOT_STOPPED');
      return ok();
    },
    'stage-resume': async (input) => { await verifySession(input.scope, input.sessionId); return ok(); },
    session: async (input) => {
      const { info, directory } = await verifySession(input.scope, input.sessionId);
      return { id: info.id, directory, isolated: false, archived: Boolean(info.time?.archived) || Boolean(await deps.isSessionArchived?.(info.id)), metadata: info.metadata };
    },
    tokens: async (input) => {
      const { directory } = await verifySession(input.scope, input.sessionId);
      return readTokens(input.sessionId, directory, { since: input.since ?? 0 });
    },
    activity: async (input) => isWorking(input.scope, input.sessionId),
    proof: async (input, { signal }) => {
      const scope = input.scope;
      const owned = await checkout(scope);
      if (!scope.bot.proof || scope.bot.isolated) fail('BOT_EXECUTION_HOST_PROOF_REQUIRED');
      if (!scope.item.sessions.fixing) fail('BOT_EXECUTION_SESSION_MISMATCH');
      await verifySession(scope, scope.item.sessions.fixing, 'fixing');
      return proof.run({ directory: owned.directory, testSha: input.testSha, fixSha: input.fixSha,
        command: scope.bot.proof.command, args: scope.bot.proof.args, isolated: false }, { signal });
    },
    'service-prepare': async (input) => {
      await verifySelectedService(input.scope, input.request, input.request.input);
      return servicesFor(input.scope).prepare(input.request);
    },
    'service-read': async (input) => {
      await verifySelectedService(input.scope, input.request, input.request.input);
      return { operation: input.request.operation, value: await servicesFor(input.scope).read(localReadRequest(input.request)) };
    },
    'service-preflight': async (input) => {
      if (input.operation !== input.effect.operation) fail('BOT_EFFECT_CHANGED');
      assertBotEffectInput(input.effect, input.input);
      await verifySelectedService(input.scope, input.effect, input.input);
      await servicesFor(input.scope).preflight(input.effect, input.input); return ok();
    },
    'service-execute': async (input) => {
      if (input.operation !== input.effect.operation) fail('BOT_EFFECT_CHANGED');
      assertBotEffectInput(input.effect, input.input);
      await verifySelectedService(input.scope, input.effect, input.input);
      return servicesFor(input.scope).execute(input.effect, input.input);
    },
    'service-reconcile': async (input) => {
      if (input.operation !== input.effect.operation) fail('BOT_EFFECT_CHANGED');
      assertBotEffectInput(input.effect, input.input);
      await verifySelectedService(input.scope, input.effect, input.input);
      const result = await servicesFor(input.scope).reconcile(input.effect, input.input);
      return result.state === 'succeeded' ? { ...result, operation: input.operation } : result;
    },
    blame: async (input) => { await checkout(input.scope); return blame({ ...requestFor(input.scope), snapshot: input.snapshot }); },
    'pull-status': async (input) => {
      const scope = input.scope; const request = requestFor(scope);
      await checkout(scope);
      const binding = (await context.github(request)).binding;
      if (input.authority.project.id !== scope.project.id || input.authority.botId !== scope.bot.id || input.authority.itemId !== scope.item.id
        || !same(binding, { identityId: input.authority.identityId, identityRevision: input.authority.identityRevision, target: input.authority.target })
        || input.authority.publicationBranch !== scope.item.publicationBranch) fail('BOT_GITHUB_PULL_CHANGED');
      const status = await prFor(scope).pullRequests.read(request);
      if (!scope.item.pr) fail('BOT_PULL_REQUEST_REQUIRED');
      const pull = await servicesFor(scope).read({ ...binding, operation: 'github.pull', input: { number: scope.item.pr.number, headSha: status.headSha } });
      return { open: z.object({ state: z.string() }).parse(pull).state === 'open', status };
    },
    'pull-feedback': async (input) => {
      const snapshot = await (deps.readFeedback ?? readPullFeedback)({ octokit: await watchReader(input.authority, input.trustedMigrationPath, input.expectedDirectory),
        owner: input.authority.target.owner, repo: input.authority.target.repo, number: input.number });
      const result = fitFeedback(snapshot, { mentionText: input.mentionText, cap: BOT_SERVICE_BYTES - 1024 });
      if (!result) throw botBoundaryError('BOT_EXECUTION_RESPONSE_TOO_LARGE'); return result;
    },
    'pull-author-permission': async (input) => ({ permitted: await (deps.readAuthorPermission ?? readFeedbackAuthorPermission)({
      octokit: await watchReader(input.authority, input.trustedMigrationPath, input.expectedDirectory), owner: input.authority.target.owner, repo: input.authority.target.repo, username: input.username }) }),
    'pull-failed-checks': async (input) => (deps.readFailedChecks ?? readFailedChecks)({ octokit: await watchReader(input.authority, input.trustedMigrationPath, input.expectedDirectory),
      owner: input.authority.target.owner, repo: input.authority.target.repo, contexts: input.contexts }),
    'pull-review-app': async (input) => {
      const scope = await trustRetainedCheckout(watchScope(input.authority, input.trustedMigrationPath, input.expectedDirectory)); await checkout(scope);
      return { authorized: await prFor(scope, input.selectedApprovedApp ? [input.selectedApprovedApp] : reviewApps).botWatch.authorizeApp(input.authority, input.author) };
    },
    'tools-pull': async (input) => { await verifySession(input.scope, input.sessionId, 'fixing'); return inbox.pending(input.sessionId); },
    'tools-settle': async (input) => {
      await verifySession(input.scope, input.sessionId, 'fixing');
      if (input.settlement.request.sessionId !== input.sessionId) fail('BOT_EXECUTION_SESSION_MISMATCH');
      return inbox.settle(input.settlement);
    },
    'synthetic-deliver': async (input) => {
      const scope = input.scope;
      const { directory, info } = await verifySession(scope, input.sessionId);
      if (info.time?.archived || await deps.isSessionArchived?.(info.id)) fail('BOT_EXECUTION_SESSION_ARCHIVED');
      const notice = { source: 'openchamber-notice', kind: 'bot', projectId: scope.project.id, itemId: scope.item.id, eventId: input.eventId };
      if (botNoticeIds(notice).messageId !== input.messageId) fail('BOT_NOTICE_TARGET_CHANGED');
      try { await clientFor(directory).session.synthetic({ sessionID: input.sessionId, id: input.messageId, text: input.text,
        description: input.description ?? input.text, metadata: notice, delivery: 'steer', resume: true }); }
      catch (error) { if (z.object({ status: z.unknown() }).safeParse(error).data?.status !== 409) throw error; }
      return { messageId: input.messageId, sessionId: input.sessionId };
    },
  };
}
