import type { z } from 'zod';
import { BOT_SERVICE_OPERATIONS, assertBotServiceReply, botBoundaryError } from './bot-service-contract.js';
import type { BotServiceInput, BotServiceOperation, BotServiceReply } from './bot-service-contract.js';

type Codecs = { readonly [Operation in BotServiceOperation]: {
  readonly input: z.ZodType<BotServiceInput<Operation>>;
  readonly reply: z.ZodType<BotServiceReply<Operation>>;
} };
const codecs: Codecs = BOT_SERVICE_OPERATIONS;

export function parseBotServiceInput<Operation extends BotServiceOperation, Input>(operation: Operation, raw: Input): BotServiceInput<Operation> {
  const parsed = codecs[operation]?.input.safeParse(raw);
  if (!parsed?.success) throw botBoundaryError('BOT_EXECUTION_INVALID_REQUEST', 400, 'failed');
  return parsed.data;
}

export function checkedBotServiceReply<Operation extends BotServiceOperation, Reply>(operation: Operation, input: BotServiceInput<Operation>, raw: Reply): BotServiceReply<Operation> {
  const reply = codecs[operation].reply.safeParse(raw);
  if (!reply.success) throw botBoundaryError('BOT_EXECUTION_INVALID_RESPONSE');
  validators[operation](input, reply.data);
  return reply.data;
}

type Validators = { readonly [Operation in BotServiceOperation]: (input: BotServiceInput<Operation>, result: BotServiceReply<Operation>) => void };
const validators: Validators = {
  'identity-list': (i, r) => assertBotServiceReply('identity-list', i, r),
  'identity-create': (i, r) => assertBotServiceReply('identity-create', i, r),
  'identity-update': (i, r) => assertBotServiceReply('identity-update', i, r),
  'identity-remove': (i, r) => assertBotServiceReply('identity-remove', i, r),
  repository: (i, r) => assertBotServiceReply('repository', i, r),
  'github-binding': (i, r) => assertBotServiceReply('github-binding', i, r),
  context: (i, r) => assertBotServiceReply('context', i, r),
  'policy-files': (i, r) => assertBotServiceReply('policy-files', i, r),
  defaults: (i, r) => assertBotServiceReply('defaults', i, r),
  knowledge: (i, r) => assertBotServiceReply('knowledge', i, r),
  'knowledge-sync': (i, r) => assertBotServiceReply('knowledge-sync', i, r),
  'worktree-create': (i, r) => assertBotServiceReply('worktree-create', i, r),
  'worktree-reconcile': (i, r) => assertBotServiceReply('worktree-reconcile', i, r),
  'worktree-inspect': (i, r) => assertBotServiceReply('worktree-inspect', i, r),
  'worktree-bind-publication': (i, r) => assertBotServiceReply('worktree-bind-publication', i, r),
  'worktree-read-publication': (i, r) => assertBotServiceReply('worktree-read-publication', i, r),
  'worktree-adopt-isolated': (i, r) => assertBotServiceReply('worktree-adopt-isolated', i, r),
  'worktree-accept-published': (i, r) => assertBotServiceReply('worktree-accept-published', i, r),
  'worktree-remove': (i, r) => assertBotServiceReply('worktree-remove', i, r),
  'worktree-same-tree': (i, r) => assertBotServiceReply('worktree-same-tree', i, r),
  'stage-create': (i, r) => assertBotServiceReply('stage-create', i, r),
  'stage-dispatch': (i, r) => assertBotServiceReply('stage-dispatch', i, r),
  'stage-outcome': (i, r) => assertBotServiceReply('stage-outcome', i, r),
  'stage-reconcile': (i, r) => assertBotServiceReply('stage-reconcile', i, r),
  'stage-stop': (i, r) => assertBotServiceReply('stage-stop', i, r),
  'stage-resume': (i, r) => assertBotServiceReply('stage-resume', i, r),
  session: (i, r) => assertBotServiceReply('session', i, r),
  tokens: (i, r) => assertBotServiceReply('tokens', i, r),
  activity: (i, r) => assertBotServiceReply('activity', i, r),
  proof: (i, r) => assertBotServiceReply('proof', i, r),
  'service-prepare': (i, r) => assertBotServiceReply('service-prepare', i, r),
  'service-read': (i, r) => assertBotServiceReply('service-read', i, r),
  'service-preflight': (i, r) => assertBotServiceReply('service-preflight', i, r),
  'service-execute': (i, r) => assertBotServiceReply('service-execute', i, r),
  'service-reconcile': (i, r) => assertBotServiceReply('service-reconcile', i, r),
  blame: (i, r) => assertBotServiceReply('blame', i, r),
  'pull-status': (i, r) => assertBotServiceReply('pull-status', i, r),
  'pull-feedback': (i, r) => assertBotServiceReply('pull-feedback', i, r),
  'pull-author-permission': (i, r) => assertBotServiceReply('pull-author-permission', i, r),
  'pull-failed-checks': (i, r) => assertBotServiceReply('pull-failed-checks', i, r),
  'pull-review-app': (i, r) => assertBotServiceReply('pull-review-app', i, r),
  'tools-pull': (i, r) => assertBotServiceReply('tools-pull', i, r),
  'tools-settle': (i, r) => assertBotServiceReply('tools-settle', i, r),
  'synthetic-deliver': (i, r) => assertBotServiceReply('synthetic-deliver', i, r),
  'gateway-open': (i, r) => assertBotServiceReply('gateway-open', i, r),
  'gateway-pull': (i, r) => assertBotServiceReply('gateway-pull', i, r),
  'gateway-send': (i, r) => assertBotServiceReply('gateway-send', i, r),
  'gateway-close': (i, r) => assertBotServiceReply('gateway-close', i, r),
};
