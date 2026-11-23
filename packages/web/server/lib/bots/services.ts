import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { createMutationExecutor, digestMutationInput } from '../source-control/mutation-executor.js';
import { createMutationStore } from '../source-control/mutation-storage.js';
import { createSourceControlAuditStore } from '../source-control/audit-storage.js';
import { createBotIdentityStore } from './identities.js';
import { BotServiceError, effectSchema, parse, requestSchema } from './services/contracts.js';
import { createJiraOAuthHttp, createProviderHttp } from './services/http.js';
import { createCredentialResolver } from './services/credentials.js';
import { createBotPublicationAuthority } from './services/publication-authority.js';
import { assertBotQuestionAuthority, convertError, isDispatchOutcomeUnknown, isUnknownOutcome, parseBotPayload, payloadDigest, sourceKey } from './services/effects.js';
import { createBotProviderResolver, preflightProvider } from './services/provider.js';
import { createBotReader } from './services/reads.js';
import type { BotOperation, BotOperationInputWire, BotOperationTarget, BotQuestionAuthority, BotServiceEffect, BotServiceRequest } from './services/contracts.js';
import type { BotServiceReadRequest } from './services/reads.js';
import type { JiraCommentPage } from './services/jira.js';
import type { ProviderHttpOptions } from './services/http.js';
import type { BotParsedPayload } from './services/effects.js';
import type { BotGitOverrides, BotResolvedProvider, DispatchCallbacks } from './services/provider.js';
import type { MutationClaim } from '../source-control/mutation-storage.js';
import type { JsonValue } from '../shared/json-values.js';

export { BotServiceError } from './services/contracts.js';
export { assertBotQuestionAuthority } from './services/effects.js';
export type BotServicesOptions = ProviderHttpOptions & {
  readonly dataDir?: string;
  readonly identities?: Parameters<typeof createCredentialResolver>[0]['identities'];
  readonly runtimeIdentity?: Parameters<typeof createMutationExecutor>[0]['runtimeIdentity'];
  readonly mutationStore?: ReturnType<typeof createMutationStore>;
  readonly auditStore?: ReturnType<typeof createSourceControlAuditStore>;
  readonly git?: BotGitOverrides;
  readonly approvedDiscordPeople?: (effect: BotServiceEffect) => Promise<readonly string[]>;
  readonly resolveQuestionAuthority?: (key: Pick<BotServiceEffect, 'botId' | 'itemId' | 'key'>) => Promise<BotQuestionAuthority | null>;
  readonly resolvePublication?: Parameters<typeof createBotPublicationAuthority>[0]['resolvePublication'];
  readonly ownerAuthorityChecked?: boolean;
};
const githubKinds = { 'git.push': 'bot-git-push', 'pr.open': 'change-request-create',
  'pr.comment': 'change-request-comment', 'pr.auto-merge': 'change-request-merge',
  'pr.disable-auto-merge': 'change-request-merge', 'pr.dequeue': 'change-request-merge' } as const;

const mutationRecord = (effect: BotServiceEffect, context: Extract<BotResolvedProvider, { service: 'github' }>): MutationClaim => {
  const { target } = context.payload; const { authority } = effect; const { input } = context.payload;
  const authorityFields = { botId: effect.botId, itemId: effect.itemId,
    identityId: authority.identityId, identityRevision: authority.identityRevision, credentialRevision: authority.credentialRevision };
  const botAuthority = effect.publicationBranch === undefined ? authorityFields : { ...authorityFields, publicationBranch: effect.publicationBranch };
  const record: MutationClaim = { key: sourceKey(effect), inputDigest: effect.inputDigest, kind: githubKinds[context.payload.operation],
    actor: { provider: 'github', instance: 'github.com', accountId: authority.credentialId },
    target: { repositoryId: target.repositoryId,
      botAuthority,
      project: { id: `${target.owner}/${target.repo}`, owner: target.owner, name: target.repo },
    },
  };
  if ('number' in input && input.number) record.target.number = input.number;
  if ('branch' in input && input.branch) record.target.head = input.branch;
  if ('base' in input && input.base) record.target.base = input.base;
  if ('headSha' in input && input.headSha) record.target.headSha = input.headSha;
  return record;
};

export function createBotServices({
  dataDir = process.env.OPENCHAMBER_DATA_DIR || path.join(os.homedir(), '.config', 'openchamber'),
  identities = createBotIdentityStore({ dataDir }),
  runtimeIdentity = { id: `bot-runtime-${randomUUID()}`, platform: process.platform },
  policyOptions, fetchImpl, mutationStore = createMutationStore({ filePath: path.join(dataDir, 'source-control-mutations.json') }),
  auditStore = createSourceControlAuditStore({ filePath: path.join(dataDir, 'source-control-audit.json') }),
  git = {}, approvedDiscordPeople = async () => [], resolveQuestionAuthority = async () => null,
  resolvePublication = async () => null, ownerAuthorityChecked = false,
}: BotServicesOptions = {}) {
  const resolve = createCredentialResolver({ identities, http: createProviderHttp({ fetchImpl, policyOptions }),
    jiraOAuthHttp: createJiraOAuthHttp({ fetchImpl, policyOptions }) });
  const mutations = createMutationExecutor({ store: mutationStore, auditStore, runtimeIdentity });
  const publication = createBotPublicationAuthority({ resolvePublication });
  const resolveProvider = createBotProviderResolver({ resolve, policyOptions, git });
  const validateQuestion = async (effect: Parameters<typeof assertBotQuestionAuthority>[0] & Pick<BotServiceEffect, 'botId' | 'itemId'>, payload: BotParsedPayload) => {
    if (ownerAuthorityChecked) return;
    switch (payload.operation) {
    case 'jira.question':
    case 'discord.question':
      assertBotQuestionAuthority(effect, payload.input, await resolveQuestionAuthority({ botId: effect.botId, itemId: effect.itemId, key: effect.key }));
      break;
    default: break;
    }
  };
  const validateEffect = (value: JsonValue, rawInput: BotOperationInputWire<BotOperation>) => {
    const captured = parse(effectSchema.safeParse(value));
    const payload = parseBotPayload({ ...captured, input: rawInput });
    const effect = { ...captured, target: payload.target };
    publication.validate(effect, payload.input);
    if (payload.service !== effect.authority.service || payloadDigest(effect, payload.input) !== effect.inputDigest) {
      throw new BotServiceError('BOT_EFFECT_CHANGED', 'The bot effect differs from its durable authority or input.');
    }
    return { effect, payload };
  };
  const resolveEffect = async ({ effect, payload }: ReturnType<typeof validateEffect>, callbacks: DispatchCallbacks = {}) => {
    if (!ownerAuthorityChecked && effect.authority.service === 'discord' && payload.service === 'discord' && payload.target.guildId === 'dm'
      && !(await approvedDiscordPeople(effect)).includes(payload.target.recipientId ?? '')) {
      throw new BotServiceError('BOT_DISCORD_PERSON_DENIED', 'The Discord recipient is absent from the approved people directory.');
    }
    const context = await resolveProvider(payload, effect.authority, { ...callbacks,
      beforeQuestionWrite: () => validateQuestion(effect, payload), ownedBranch: effect.publicationBranch });
    if (digestMutationInput(context.credential.authority) !== digestMutationInput(effect.authority)) {
      throw new BotServiceError('BOT_AUTHORITY_CHANGED', 'The selected bot identity changed after the effect was prepared.');
    }
    await publication.assertCurrent({ ...effect, ...context.destination }, payload.input);
    return context;
  };
  const preflight = (effect: BotServiceEffect, context: BotResolvedProvider) => preflightProvider(context, {
    hasMutation: async () => Boolean(await mutations.read(sourceKey(effect))), policyOptions,
  });
  return Object.freeze({
    async prepare(value: BotServiceRequest) {
      const request = parse(requestSchema.safeParse(value));
      const payload = parseBotPayload(request);
      await validateQuestion({ ...request, target: payload.target }, payload);
      const context = await resolveProvider(payload, request);
      const effect = await publication.prepare({ key: request.key, botId: request.botId, itemId: request.itemId,
        ...context.destination }, payload.input);
      return { ...effect, inputDigest: payloadDigest(effect, payload.input) };
    },
    async preflight(value: JsonValue, rawInput: BotOperationInputWire<BotOperation>) {
      const validated = validateEffect(value, rawInput);
      try {
        await validateQuestion(validated.effect, validated.payload);
        const context = await resolveEffect(validated);
        await preflight(validated.effect, context);
        return { inputDigest: validated.effect.inputDigest };
      } catch (error) { throw convertError(error); }
    },
    async execute(value: JsonValue, rawInput: BotOperationInputWire<BotOperation>, { beforeAdmission, beforeDispatch }: DispatchCallbacks = {}) {
      const validated = validateEffect(value, rawInput); const { effect, payload } = validated;
      try {
        await validateQuestion(effect, payload);
        const context = await resolveEffect(validated, { beforeAdmission });
        await preflight(effect, context);
        await beforeDispatch?.();
        switch (context.service) {
        case 'github': {
          const completed = await mutations.execute({ record: mutationRecord(effect, context),
            providerAccountId: context.credential.authority.providerAccountId, perform: context.perform, reconcile: context.reconcile,
            classifyError: (error) => isDispatchOutcomeUnknown(error) ? 'outcome-unknown' : 'failed' });
          return { status: 'succeeded' as const, ...context.destination, result: completed.record.result, replayed: completed.replayed };
        }
        case 'jira':
          return { status: 'succeeded' as const, ...context.destination, result: await context.perform(), replayed: false };
        case 'discord':
          return { status: 'succeeded' as const, ...context.destination, result: await context.perform(), replayed: false };
        default: context satisfies never; throw new BotServiceError('BOT_SERVICE_UNSUPPORTED', 'This bot provider is unsupported.', 'failed', 400);
        }
      } catch (error) { throw convertError(error); }
    },
    async reconcile(value: JsonValue, rawInput: BotOperationInputWire<BotOperation>) {
      const validated = validateEffect(value, rawInput); const { effect } = validated;
      try {
        const context = await resolveEffect(validated);
        if (context.service === 'github') {
          const existing = await mutations.read(sourceKey(effect));
          if (existing) {
            if (existing.inputDigest !== effect.inputDigest) throw new BotServiceError('BOT_EFFECT_CHANGED', 'The source-control journal has different effect authority.');
            if (existing.state === 'failed') {
              const code = existing.result?.failureCode;
              if (/^BOT_|^enterprise_mode$/.test(code ?? '')) return { state: 'refused' as const, code };
              throw new BotServiceError(code ?? 'BOT_SERVICE_REJECTED',
                'The original bot operation was refused. It cannot be dispatched again.', 'needs-you', existing.result?.failureStatus ?? 409);
            }
            const result = await mutations.reconcile({ record: mutationRecord(effect, context),
              providerAccountId: context.credential.authority.providerAccountId, reconcile: context.reconcile });
            return { state: 'succeeded' as const, result: result.record.result };
          }
        }
        return await context.reconcile();
      } catch (error) {
        if (isUnknownOutcome(error)) return { state: 'outcome-unknown' as const };
        throw convertError(error);
      }
    },
    read: createBotReader(resolve),
  });
}

type LocalBotServices = ReturnType<typeof createBotServices>;
export type BotPreparedEffect = Awaited<ReturnType<LocalBotServices['prepare']>>;
export type BotServiceExecutionResult = Awaited<ReturnType<LocalBotServices['execute']>>;
export type BotServiceReconciliationResult = Awaited<ReturnType<LocalBotServices['reconcile']>>;
export type BotServiceReadResult = Awaited<ReturnType<LocalBotServices['read']>>;
export type BotServiceReadValue = BotServiceReadResult;
export type BotServiceDescriptor = Omit<BotServiceEffect, 'authority' | 'target'> & {
  readonly authority: Pick<BotServiceEffect['authority'], 'service' | 'identityId' | 'identityRevision'>;
  readonly target: BotOperationTarget<BotOperation>;
};
export interface BotServices {
  prepare(request: BotServiceRequest): Promise<Omit<BotServiceEffect, 'target'> & { readonly target: BotOperationTarget<BotOperation> }>;
  preflight(effect: BotServiceDescriptor, input: BotOperationInputWire<BotOperation>): Promise<{ readonly inputDigest: string } | { readonly ok: true }>;
  execute(effect: BotServiceDescriptor, input: BotOperationInputWire<BotOperation>, options?: DispatchCallbacks): Promise<{ readonly result: unknown }>;
  reconcile(effect: BotServiceDescriptor, input: BotOperationInputWire<BotOperation>): Promise<
    | { readonly state: 'succeeded'; readonly result: unknown }
    | { readonly state: 'outcome-unknown' }
    | { readonly state: 'refused'; readonly code?: string | undefined }>;
  read(request: BotServiceReadRequest & { readonly operation: 'jira.comments' }): Promise<JiraCommentPage>;
  read(request: BotServiceReadRequest): Promise<BotServiceReadValue>;
}
