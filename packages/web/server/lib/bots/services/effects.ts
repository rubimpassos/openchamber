import { z } from 'zod';
import { digestMutationInput } from '../../source-control/mutation-executor.js';
import { BotServiceError, operations, parse, questionAuthoritySchema } from './contracts.js';
import type { BotOperation, BotOperationInput, BotOperationPayload, BotOperationTarget, BotQuestionAuthority, BotService, BotServiceEffect, BotServiceRequest } from './contracts.js';

const operationParser = <Operation extends BotOperation, Service extends BotService, Target, Input>(
  operation: Operation, contract: { readonly service: Service; readonly target: z.ZodType<Target>; readonly input: z.ZodType<Input> },
) => (value: Pick<BotServiceRequest, 'target' | 'input'>) => {
  const parsedTarget = parse(contract.target.safeParse(value.target));
  const input = parse(contract.input.safeParse(value.input));
  return { operation, service: contract.service, target: parsedTarget, input, call: [operation, input] as const };
};

const parsers = {
  'git.push': operationParser('git.push', operations['git.push']),
  'pr.open': operationParser('pr.open', operations['pr.open']),
  'pr.comment': operationParser('pr.comment', operations['pr.comment']),
  'pr.auto-merge': operationParser('pr.auto-merge', operations['pr.auto-merge']),
  'pr.disable-auto-merge': operationParser('pr.disable-auto-merge', operations['pr.disable-auto-merge']),
  'pr.dequeue': operationParser('pr.dequeue', operations['pr.dequeue']),
  'jira.comment': operationParser('jira.comment', operations['jira.comment']),
  'jira.question': operationParser('jira.question', operations['jira.question']),
  'jira.transition': operationParser('jira.transition', operations['jira.transition']),
  'discord.send': operationParser('discord.send', operations['discord.send']),
  'discord.question': operationParser('discord.question', operations['discord.question']),
} satisfies { readonly [Operation in BotOperation]: (value: Pick<BotServiceRequest, 'target' | 'input'>) => BotOperationPayload<Operation> & {
  readonly service: typeof operations[Operation]['service']; readonly call: readonly [Operation, BotOperationInput<Operation>];
} };

export function parseBotPayload<Operation extends BotOperation>(value: Pick<BotServiceRequest, 'target' | 'input'> & { readonly operation: Operation }): ReturnType<typeof parsers[Operation]>;
export function parseBotPayload(value: Pick<BotServiceRequest, 'operation' | 'target' | 'input'>) { return parsers[value.operation](value); }
export type BotParsedPayload = ReturnType<typeof parseBotPayload>;
type EffectIdentity = Pick<BotServiceEffect, 'key' | 'operation' | 'botId' | 'itemId' | 'authority' | 'target' | 'publicationBranch'>;
export const payloadDigest = (effect: EffectIdentity, input: BotParsedPayload['input']) => {
  const value = { key: effect.key, operation: effect.operation, botId: effect.botId, itemId: effect.itemId,
    authority: effect.authority, target: effect.target, input };
  return digestMutationInput(effect.publicationBranch === undefined ? value : { ...value, publicationBranch: effect.publicationBranch });
};
export const sourceKey = (effect: Pick<BotServiceEffect, 'botId' | 'itemId' | 'key'>) => `bot:${effect.botId}:${effect.itemId}:${effect.key}`;

const errorFields = (value: unknown): value is { readonly state?: unknown; readonly code?: unknown; readonly status?: unknown } => value != null;
export const isDispatchOutcomeUnknown = (error: unknown): error is { readonly state: 'outcome-unknown' } => errorFields(error) && error.state === 'outcome-unknown';
export const isUnknownOutcome = (error: unknown): error is { readonly state: 'outcome-unknown' } | { readonly code: 'SOURCE_CONTROL_MUTATION_OUTCOME_UNKNOWN' } => isDispatchOutcomeUnknown(error)
  || errorFields(error) && error.code === 'SOURCE_CONTROL_MUTATION_OUTCOME_UNKNOWN';
export const convertError = <Failure>(error: Failure) => {
  if (errorFields(error) && error.state === 'refused') return error;
  if (error instanceof BotServiceError) return error;
  if (errorFields(error) && error.code === 'SOURCE_CONTROL_MUTATION_OUTCOME_UNKNOWN') return new BotServiceError(error.code,
    'The bot operation outcome is unknown. Reconcile the original effect without submitting a new key.', 'outcome-unknown');
  const parsedCode = z.string().safeParse(errorFields(error) ? error.code : undefined);
  const parsedStatus = z.number().safeParse(errorFields(error) ? error.status : undefined);
  const code = parsedCode.success && parsedCode.data.startsWith('SOURCE_CONTROL_') ? parsedCode.data : 'BOT_SERVICE_FAILED';
  return new BotServiceError(code, 'The bot service operation could not complete.', 'needs-you',
    parsedStatus.success ? parsedStatus.data : 500);
};

type QuestionEffect = Pick<BotServiceEffect, 'key' | 'operation'> & {
  readonly target: BotOperationTarget<BotOperation>;
  readonly authority?: Pick<BotServiceEffect['authority'], 'identityId' | 'identityRevision'>;
  readonly identityId?: string;
  readonly identityRevision?: number;
};
export const assertBotQuestionAuthority = (effect: QuestionEffect, input: BotOperationInput<'jira.question' | 'discord.question'>, value: BotQuestionAuthority | null) => {
  let service;
  switch (effect.operation) {
  case 'jira.question': service = 'jira' as const; break;
  case 'discord.question': service = 'discord' as const; break;
  default: return;
  }
  const result = questionAuthoritySchema.safeParse(value);
  if (!result.success) throw new BotServiceError('BOT_QUESTION_AUTHORITY_REQUIRED', 'The question needs its current approved policy and selected recipients.');
  const { policy, question } = result.data; const { route } = question;
  const identity = effect.authority ?? effect;
  const captured = { operation: route.operation, target: route.binding.target, identityId: route.binding.identityId,
    identityRevision: route.binding.identityRevision, input: route.input };
  const requested = { operation: effect.operation, target: effect.target, identityId: identity.identityId,
    identityRevision: identity.identityRevision, input };
  if (question.key !== effect.key || route.service !== service || policy.fingerprint !== input.policyFingerprint
    || route.policyFingerprint !== input.policyFingerprint || digestMutationInput(captured) !== digestMutationInput(requested)
    || digestMutationInput(route.recipients) !== digestMutationInput(input.recipients)
    || input.recipients.some((recipient) => !policy.people.people.some((person) => person.id === recipient.personId && person[service] === recipient.serviceId))
    || service === 'discord' && 'guildId' in effect.target && effect.target.guildId === 'dm'
      && (input.recipients.length !== 1 || input.recipients[0]?.serviceId !== effect.target.recipientId)) {
    throw new BotServiceError('BOT_QUESTION_RECIPIENT_DENIED', 'The question differs from its approved recipient selection or policy.');
  }
};
