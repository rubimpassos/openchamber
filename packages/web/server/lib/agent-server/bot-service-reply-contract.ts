import type { z } from 'zod';
import type { BotServiceInput, BotServiceOperation, BotServiceReply, botPublicIdentitySchema } from './bot-service-contract.js';
import { assertBotEffectInput, botBoundaryError } from './bot-service-contract.js';

type ReplyArguments = { [Operation in BotServiceOperation]: readonly [Operation, BotServiceInput<Operation>, BotServiceReply<Operation>] }[BotServiceOperation];
function refuse(): never { throw botBoundaryError('BOT_EXECUTION_UNRELATED_REPLY'); }
type Binding = Omit<NonNullable<BotServiceReply<'context'>['github']>, 'target'> & {
  readonly target: NonNullable<BotServiceReply<'context'>['github' | 'jira' | 'discord']>['target'];
};
function assertBinding(returned: Binding | undefined, identity: z.output<typeof botPublicIdentitySchema> | null, target: Binding['target']) {
  if (!returned || !identity || returned.identityId !== identity.id || returned.identityRevision !== identity.revision
    || JSON.stringify(returned.target) !== JSON.stringify(target)
    || identity.kind === 'github-account' && (returned.accountId !== identity.accountId
      || returned.credentialRevision !== identity.credentialRevision)) refuse();
}

export function assertBotServiceReply(...[operation, input, result]: ReplyArguments): void {
  switch (operation) {
    case 'identity-update':
      if (result.id !== input.id || result.revision !== input.expectedRevision + 1) refuse();
      return;
    case 'identity-create':
      if (result.revision !== 1) refuse();
      return;
    case 'github-binding':
      assertBinding(result.binding, input.expectedIdentity, input.expectedTarget);
      if (input.binding && (result.binding.identityId !== input.binding.identityId || result.binding.identityRevision !== input.binding.identityRevision
        || JSON.stringify(result.binding.target) !== JSON.stringify(input.binding.target))) refuse();
      if (input.bot?.identity.github?.kind === 'app' && result.binding.identityId !== input.bot.identity.github.identityId) refuse();
      return;
    case 'context':
      if (Object.keys(result).some((key) => key !== input.service)) refuse();
      if (input.expectedTarget) assertBinding(result[input.service], input.expectedIdentity, input.expectedTarget);
      else if (Object.keys(result).length) refuse();
      return;
    case 'worktree-create':
      if (result.branch !== `bot/${input.scope.item.id}` || input.scope.item.worktree && result.directory !== input.scope.item.worktree) refuse();
      return;
    case 'worktree-reconcile':
      if (result.state === 'succeeded') {
        if (input.operation === 'remove' ? !('id' in result.result) || result.result.id !== input.scope.item.id
          : !('branch' in result.result) || result.result.branch !== `bot/${input.scope.item.id}`
            || input.scope.item.worktree && result.result.directory !== input.scope.item.worktree) refuse();
      }
      return;
    case 'worktree-inspect':
      if (result.fixSha && result.fixSha !== result.headSha) refuse();
      return;
    case 'worktree-bind-publication':
      if (result.publicationBranch !== input.branch) refuse();
      return;
    case 'worktree-adopt-isolated':
      if (result.headSha !== input.resultSha) refuse();
      return;
    case 'worktree-accept-published':
      if (result.headSha !== input.result.headSha) refuse();
      return;
    case 'worktree-remove':
      if (result.id !== input.scope.item.id) refuse();
      return;
    case 'worktree-read-publication':
      if (result && (result.localBranch !== `bot/${input.scope.item.id}`
        || input.scope.item.worktree && result.directory !== input.scope.item.worktree
        || input.scope.item.publicationBranch && result.publicationBranch !== input.scope.item.publicationBranch)) refuse();
      return;
    case 'stage-create':
      if (result.directory !== input.request.directory) refuse();
      return;
    case 'stage-dispatch':
      if (result.sessionId !== input.request.sessionId) refuse();
      return;
    case 'synthetic-deliver':
      if (result.sessionId !== input.sessionId) refuse();
      return;
    case 'session':
      if (result.id !== input.sessionId || result.directory !== input.scope.item.worktree
        || result.metadata.openchamber.automation.projectId !== input.scope.project.id
        || result.metadata.openchamber.automation.botId !== input.scope.bot.id
        || result.metadata.openchamber.automation.itemId !== input.scope.item.id) refuse();
      return;
    case 'proof':
      if (result.testSha !== input.testSha || result.fixSha !== input.fixSha) refuse();
      return;
    case 'service-prepare': {
      const requested = input.request;
      if (result.key !== requested.key || result.operation !== requested.operation || result.botId !== requested.botId || result.itemId !== requested.itemId
        || result.authority.identityId !== requested.identityId || result.authority.identityRevision !== requested.identityRevision
        || JSON.stringify(result.target) !== JSON.stringify(requested.target)) refuse();
      assertBotEffectInput(result, requested.input);
      return;
    }
    case 'service-read': {
      if (result.operation !== input.request.operation) refuse();
      const value = result.value; const requested = input.request;
      if ('number' in requested.input && requested.input.number && (!('number' in value) || value.number !== requested.input.number)
        || 'headSha' in requested.input && requested.input.headSha && (!('headSha' in value) || value.headSha !== requested.input.headSha)
        || requested.operation === 'github.rules' && (!('branch' in value) || !('branch' in requested.input) || value.branch !== requested.input.branch)
        || requested.operation === 'jira.issue' && (!('key' in value) || !('issueKey' in requested.target) || value.key !== requested.target.issueKey)
        || requested.operation === 'discord.channel' && (!('channelId' in value) || !('channelId' in requested.target)
          || value.channelId !== requested.target.channelId || value.guildId !== requested.target.guildId)) refuse();
      return;
    }
    case 'service-execute':
    case 'service-reconcile': {
      const effect = input.effect;
      if ('operation' in result && result.operation !== effect.operation) refuse();
      if ('authority' in result && (JSON.stringify(result.authority) !== JSON.stringify(effect.authority)
        || JSON.stringify(result.target) !== JSON.stringify(effect.target))) refuse();
      if ('result' in result) {
        const receipt = result.result;
        if ('number' in input.input && input.input.number && (!('number' in receipt) || receipt.number !== input.input.number)
          || 'issueKey' in receipt && receipt.issueKey && (!('issueKey' in effect.target) || receipt.issueKey !== effect.target.issueKey)
          || 'channelId' in receipt && receipt.channelId && (!('channelId' in effect.target) || receipt.channelId !== effect.target.channelId)) refuse();
        if (effect.operation === 'git.push') {
          if (!('sourceHeadSha' in receipt) || !('headSha' in input.input)) refuse();
          const commitMap = 'commitMap' in receipt ? receipt.commitMap : undefined;
          const last = commitMap?.at(-1);
          if (receipt.sourceHeadSha !== input.input.headSha || commitMap && (last?.sourceSha !== receipt.sourceHeadSha
            || last?.publishedSha !== receipt.headSha
            || new Set(commitMap.map((entry) => entry.sourceSha)).size !== commitMap.length
            || new Set(commitMap.map((entry) => entry.publishedSha)).size !== commitMap.length)
            || receipt.headSha !== receipt.sourceHeadSha && !commitMap) refuse();
        } else if ('headSha' in input.input && input.input.headSha && (!('headSha' in receipt) || receipt.headSha !== input.input.headSha)) refuse();
        if (effect.operation === 'pr.open' && (!('head' in receipt) || !('branch' in input.input) || !('base' in input.input)
          || receipt.head !== input.input.branch || receipt.base !== input.input.base)) refuse();
      }
      return;
    }
    case 'tools-pull':
      if (result.requests.some((entry) => entry.request.sessionId !== input.sessionId)) refuse();
      return;
    case 'blame':
      if (result.some((entry) => entry.files.some((file) => !input.snapshot.changes.some((change) => change.oldPath === file)))) refuse();
      return;
    case 'pull-feedback':
      if (result.branch !== input.branch || input.headSha && result.headSha !== input.headSha
        || result.headRepo && (result.headRepo.owner.toLowerCase() !== input.authority.target.owner.toLowerCase()
          || result.headRepo.repo.toLowerCase() !== input.authority.target.repo.toLowerCase())) refuse();
      return;
    case 'gateway-open':
      if (result.connectionId !== input.connectionId) refuse();
      return;
    case 'gateway-pull':
      if (result.connectionId !== input.connectionId || result.frames.some((entry, index) => entry.id <= (input.observed ?? input.after)
        || index > 0 && entry.id <= (result.frames[index - 1]?.id ?? Infinity))) refuse();
      return;
    case 'identity-list': case 'identity-remove': case 'repository': case 'policy-files': case 'defaults': case 'knowledge':
    case 'knowledge-sync': case 'worktree-same-tree': case 'stage-outcome': case 'stage-reconcile': case 'stage-stop': case 'stage-resume':
    case 'tokens': case 'activity': case 'service-preflight': case 'pull-status': case 'pull-author-permission': case 'pull-failed-checks':
    case 'pull-review-app': case 'tools-settle': case 'gateway-send': case 'gateway-close':
      return;
    default: {
      const exhaustive: never = operation;
      return exhaustive;
    }
  }
}
