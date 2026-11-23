import { z } from 'zod';
import { botInputDigest, createBotEffects } from './effects.js';
import { createBotExecutionStore } from './execution-store.js';
import { evaluateRepositoryPolicy, readRepositoryPolicy } from './repository-policy.js';
import { createBotQuestionBlame } from './questions-blame.js';
import { botServiceReceipt } from './service-receipts.js';
import { BotServiceError, botServiceAuthoritySchema, discordTarget, effectSchema, jiraTarget, opaqueId, operations, revision, sha, text } from './services/contracts.js';
import { parseBotPayload } from './services/effects.js';
import { hasSourceControlStringCode } from '../source-control/input-guards.js';
import type { BotDefinition } from './config.js';
import type { BotItem } from './schema.js';
import type { RuntimeOptions, RuntimeQuestionRequest } from './runtime/contracts.js';
import type { RepositoryPolicyPerson } from './repository-policy.js';

type QuestionScope = { readonly project: { readonly id: string; readonly path: string }; readonly bot: BotDefinition; readonly itemId: string };
type BlameContext = Parameters<typeof createBotQuestionBlame>[0]['context'];
type QuestionContext = { readonly serviceContext: RuntimeOptions['serviceContext'] };
type RemoteQuestionContext = QuestionContext & {
  readonly github: (request: Parameters<BlameContext['github']>[0]) => Promise<Pick<Awaited<ReturnType<BlameContext['github']>>, 'binding'>>;
};
type QuestionsOptions = Pick<RuntimeOptions, 'config' | 'store' | 'worktrees' | 'services' | 'attention' | 'events'> & {
  readonly readPolicy?: typeof readRepositoryPolicy;
  readonly now?: () => number;
} & (
  | { readonly context: QuestionContext & BlameContext; readonly readBlame?: undefined }
  | { readonly context: RemoteQuestionContext; readonly readBlame: ReturnType<typeof createBotQuestionBlame> }
);

const inputSchema = z.object({ eventId: text, questions: z.array(z.string().trim().min(1).max(20_000)).min(1).max(20),
  people: z.array(text).max(20).default([]), requestedRole: text.optional(), resumeState: z.enum(['investigating', 'fixing', 'judging']) }).strict();
const bindingSchema = z.object({ identityId: opaqueId, identityRevision: revision,
  target: z.union([jiraTarget, discordTarget]), expectedStatusId: text.optional() }).strict();
const recipientSchema = z.object({ personId: text, serviceId: text }).strict();
const routeInputSchema = z.union([operations['jira.question'].input, z.object({ body: z.string().min(1).max(60_000) }).strict()]);
const routeSchema = z.object({ service: z.enum(['jira', 'discord']), selection: z.enum(['owners', 'requested', 'role', 'blame']),
  baseSha: sha, headSha: sha,
  recipients: z.array(recipientSchema).min(1), policyFingerprint: text, binding: bindingSchema,
  operation: z.enum(['jira.comment', 'discord.send', 'jira.question', 'discord.question']),
  input: routeInputSchema,
  attribution: z.array(z.object({ sha, github: text, githubId: revision, committedAt: z.iso.datetime(), files: z.array(text) }).strict()) }).strict();
const recordSchema = z.object({ version: z.literal(1), key: opaqueId, input: inputSchema, digest: text,
  since: z.number().int().nonnegative(), route: routeSchema.nullable(), code: text.nullable() }).strict();
type QuestionRecord = z.output<typeof recordSchema>;
type QuestionRoute = z.output<typeof routeSchema>;
type RecipientCandidates = readonly (RepositoryPolicyPerson | undefined)[];
type RecipientTier = readonly [QuestionRoute['selection'], () => readonly RecipientCandidates[] | Promise<readonly RecipientCandidates[]>];
const descriptorSchema = z.object({ prepared: effectSchema.extend({
  authority: botServiceAuthoritySchema.pick({ service: true, identityId: true, identityRevision: true }).catchall(z.json()),
}), input: routeInputSchema }).passthrough();
const questionHistorySchema = z.record(z.string(), z.json());
function fail(code: string): never { throw new BotServiceError(code, 'The bot question remains available in the notification center.'); }

export function createBotQuestions({ config, store, worktrees, context, services, attention, events, readPolicy = readRepositoryPolicy, readBlame, now = Date.now }: QuestionsOptions) {
  const required = [config?.read, store?.read, store?.update, store?.filePathFor, worktrees?.inspect,
    context?.serviceContext, context?.github, services?.prepare, services?.execute, services?.reconcile, attention?.sync, events?.publish];
  if (required.some((value) => !(value instanceof Function))) throw new TypeError('Questions require the production policy, Git, service, attention and journal owners');
  const journal = createBotExecutionStore({ store });
  const effects = createBotEffects({ store, journal, now });
  const blame = readBlame ?? createBotQuestionBlame({ context });
  const itemFor = async (projectId: string, itemId: string) => {
    const item = (await store.read(projectId)).items.find((entry) => entry.id === itemId);
    if (!item) fail('BOT_ITEM_NOT_FOUND');
    return item;
  };
  const save = async (projectId: string, itemId: string, record: QuestionRecord) => journal.update(projectId, itemId, (entry) => ({ ...entry,
    data: { ...entry.data, pendingQuestion: record.key, questions: { ...questionHistorySchema.parse(entry.data.questions ?? {}), [record.key]: record }, resumeState: record.input.resumeState } }));
  const policyFor = async (project: QuestionScope['project']) => readPolicy(project.path, (await config.read(project.id)).approvals);
  const show = async (projectId: string, itemId: string, record: QuestionRecord) => {
    const snapshot = await store.update(projectId, (current) => ({ snapshot: { ...current, items: current.items.map((item) => {
      if (item.id !== itemId || !['investigating', 'fixing', 'judging', 'waiting-answer'].includes(item.state)) return item;
      return { ...item, state: 'waiting-answer', wait: { reason: [record.input.questions.join('\n'), record.code].filter(Boolean).join('\n'),
        since: record.since, channel: record.code || !record.route ? 'ui' : record.route.service,
        people: record.route?.recipients.map((person) => person.personId) ?? [] } };
    }) } }));
    const item = snapshot.items.find((entry) => entry.id === itemId);
    if (!item) fail('BOT_ITEM_NOT_FOUND');
    await attention.sync({ projectId, item });
    events.publish({ type: 'bot.item.changed', projectId, item });
    return item;
  };
  const recipientsFor = (people: readonly (RepositoryPolicyPerson | undefined)[], service: QuestionRoute['service']) => {
    if (!people.length || people.some((person) => !person?.[service])) return null;
    const recipients = people.flatMap((person) => person?.[service] ? [{ personId: person.id, serviceId: person[service] }] : []);
    if (new Set(recipients.map((person) => person.serviceId)).size !== recipients.length) return null;
    if (service === 'discord' && recipients.some((person) => !/^[1-9][0-9]{5,24}$/.test(person.serviceId))) return null;
    return recipients;
  };
  const routeFor = async ({ project, bot, item }: Omit<QuestionScope, 'itemId'> & { readonly item: BotItem }, input: z.output<typeof inputSchema>): Promise<QuestionRoute> => {
    const policy = await policyFor(project);
    if (policy.people.status !== 'approved') fail('BOT_QUESTION_PEOPLE_UNTRUSTED');
    const directory = policy.people.people;
    if (input.people.some((id) => !directory.some((person) => person.id === id))) fail('BOT_QUESTION_PERSON_UNAPPROVED');
    const snapshot = await worktrees.inspect({ project, bot, item });
    const evaluation = evaluateRepositoryPolicy(policy, snapshot.changes);
    const owners = [...new Set(evaluation.areas.filter((area) => area.status === 'approved').flatMap((area) => area.owners))];
    const servicesToTry: QuestionRoute['service'][] = item.source.kind === 'jira' && bot.identity?.jira ? ['jira', 'discord'] : ['discord'];
    let attribution: Awaited<ReturnType<typeof blame>> | null = null;
    const tiers: readonly RecipientTier[] = [
      ['owners', () => [owners.map((id) => directory.find((person) => person.id === id))]],
      ['requested', () => [[...new Set(input.people)].map((id) => directory.find((person) => person.id === id))]],
      ['role', () => [directory.filter((person) => input.requestedRole && person.roles.includes(input.requestedRole))]],
      ['blame', async () => {
        attribution = await blame({ project, bot, item, snapshot });
        return attribution.flatMap((author) => {
          const matches = directory.filter((person) => person.github?.toLowerCase() === author.github.toLowerCase());
          return matches.length === 1 ? [matches] : [];
        });
      }],
    ];
    let lastCode = 'BOT_QUESTION_RECIPIENT_UNRESOLVED';
    for (const [selection, select] of tiers) {
      for (const people of await select()) {
        for (const service of servicesToTry) {
          if (!bot.identity?.[service]) continue;
          const recipients = recipientsFor(people, service);
          if (!recipients) continue;
          try {
            const operation = service === 'jira' ? 'jira.question' : 'discord.question';
            const bindings = await context.serviceContext({ project, bot, item, service, operation });
            const binding = bindingSchema.parse(bindings[service]);
            if (service === 'jira' && jiraTarget.parse(binding.target).issueKey !== item.source.id) fail('BOT_QUESTION_TARGET_CHANGED');
            if (service === 'discord') {
              const target = discordTarget.parse(binding.target);
              if (target.guildId === 'dm' && (recipients.length !== 1 || recipients[0]?.serviceId !== target.recipientId)) continue;
            }
            const payload = operations[operation].input.safeParse({ body: input.questions.join('\n\n'), recipients, policyFingerprint: policy.fingerprint });
            if (!payload.success) fail('BOT_QUESTION_TOO_LONG');
            return routeSchema.parse({ service, selection, recipients, policyFingerprint: policy.fingerprint, binding, baseSha: snapshot.baseSha, headSha: snapshot.headSha,
              operation, input: payload.data, attribution: attribution ?? [] });
          } catch (failure) {
            if (!hasSourceControlStringCode(failure) || (failure.code !== 'BOT_DISCORD_DESTINATION_REQUIRED' && failure.code !== 'BOT_DISCORD_DESTINATION_AMBIGUOUS')) throw failure;
            lastCode = failure.code;
          }
        }
      }
    }
    fail(lastCode);
  };
  const dispatch = async ({ project, bot, itemId }: QuestionScope, record: QuestionRecord, route: QuestionRoute) => {
    const { key } = record;
    const execution = await journal.read(project.id, itemId);
    const saved = execution.operations[key];
    let request = saved ? descriptorSchema.parse(saved) : null;
    if (!request) request = { prepared: await services.prepare({ key, operation: route.operation, botId: bot.id, itemId,
      identityId: route.binding.identityId, identityRevision: route.binding.identityRevision, target: route.binding.target, input: route.input }), input: route.input };
    const wireRequest = saved ?? request;
    const authority = request.prepared.authority;
    const preparedReceipt = parseBotPayload({ ...request.prepared, input: request.input });
    const executable = { ...request.prepared, target: preparedReceipt.target };
    const validate = async () => {
      const item = await itemFor(project.id, itemId);
      if (item.effects.some((effect) => effect.key !== key && ['dispatching', 'outcome-unknown'].includes(effect.state))) fail('BOT_EFFECT_UNSETTLED');
      const settings = await config.read(project.id);
      const currentBot = settings.definitions.find((entry) => entry.id === bot.id && entry.enabled);
      if (!currentBot || item.state !== 'waiting-answer') fail('BOT_QUESTION_RESUME_REQUIRED');
      const policy = await policyFor(project);
      if (policy.fingerprint !== route.policyFingerprint || policy.people.status !== 'approved'
        || route.recipients.some((recipient) => !policy.people.people.some((person) => person.id === recipient.personId && person[route.service] === recipient.serviceId))) fail('BOT_QUESTION_POLICY_CHANGED');
      const bindings = await context.serviceContext({ project, bot: currentBot, item, service: route.service, operation: route.operation });
      const binding = bindingSchema.parse(bindings[route.service]);
      if (binding.identityId !== route.binding.identityId || binding.identityRevision !== route.binding.identityRevision
        || botInputDigest(binding.target) !== botInputDigest(route.binding.target)) fail('BOT_QUESTION_TARGET_CHANGED');
      const snapshot = await worktrees.inspect({ project, bot: currentBot, item });
      if (snapshot.baseSha !== route.baseSha || snapshot.headSha !== route.headSha) fail('BOT_QUESTION_SNAPSHOT_CHANGED');
    };
    return effects.run({ projectId: project.id, itemId, key, kind: route.operation, request: wireRequest,
      authority: { service: authority.service, identityId: authority.identityId, revision: authority.identityRevision, target: JSON.stringify(request.prepared.target) },
      beforeDispatch: validate,
      executePrepared: async (_request, claimDispatch) => botServiceReceipt(preparedReceipt,
        (await services.execute(executable, request.input, { beforeDispatch: async () => { await validate(); await claimDispatch(); } })).result),
      reconcile: async () => {
        const result = await services.reconcile(executable, request.input);
        return result.state === 'succeeded' ? { state: 'succeeded', result: botServiceReceipt(preparedReceipt, result.result) } : result;
      },
    });
  };
  const deliver = async (request: QuestionScope, record: QuestionRecord) => {
    const { project, bot, itemId } = request;
    let item = await show(project.id, itemId, record);
    if (item.state !== 'waiting-answer') return { item, question: record };
    try {
      if (!record.route) {
        record.route = await routeFor({ project, bot, item }, record.input);
        record.code = null;
        await save(project.id, itemId, record);
      }
      const receipt = await dispatch(request, record, record.route);
      record.code = null;
      await save(project.id, itemId, record);
      item = await show(project.id, itemId, record);
      return { item, question: record, receipt };
    } catch (failure) {
      record.code = hasSourceControlStringCode(failure) ? failure.code : 'BOT_QUESTION_UNDELIVERABLE';
      await save(project.id, itemId, record);
      return { item: await show(project.id, itemId, record), question: record };
    }
  };
  return Object.freeze({
    async ask({ project, bot, itemId, ...rawInput }: RuntimeQuestionRequest) {
      const input = inputSchema.parse(rawInput);
      const key = `question:${botInputDigest({ itemId, eventId: input.eventId })}`;
      const execution = await journal.read(project.id, itemId);
      if (execution.data.pendingQuestion && execution.data.pendingQuestion !== key) fail('BOT_QUESTION_PENDING');
      const item = await itemFor(project.id, itemId);
      if (item.botId !== bot.id) fail('BOT_QUESTION_RESUME_REQUIRED');
      const history = questionHistorySchema.parse(execution.data.questions ?? {});
      let record = history[key] ? recordSchema.parse(history[key]) : null;
      if (record && record.digest !== botInputDigest(input)) fail('BOT_QUESTION_INPUT_CHANGED');
      if (record && execution.data.pendingQuestion !== key) return { item, question: record, answered: true };
      if (!['investigating', 'fixing', 'judging', 'waiting-answer'].includes(item.state)) fail('BOT_QUESTION_RESUME_REQUIRED');
      if (!record) {
        if (item.state === 'waiting-answer') fail('BOT_QUESTION_PENDING');
        if (item.effects.some((effect) => ['dispatching', 'outcome-unknown'].includes(effect.state))) fail('BOT_EFFECT_UNSETTLED');
        record = { version: 1, key, input, digest: botInputDigest(input), since: now(), route: null, code: null };
        await save(project.id, itemId, record);
      }
      return deliver({ project, bot, itemId }, record);
    },
    async retry({ project, bot, itemId }: QuestionScope) {
      const execution = await journal.read(project.id, itemId);
      const history = questionHistorySchema.parse(execution.data.questions ?? {});
      const pending = z.string().nullish().parse(execution.data.pendingQuestion);
      const record = recordSchema.parse(pending ? history[pending] : undefined);
      if ((await itemFor(project.id, itemId)).botId !== bot.id) fail('BOT_QUESTION_RESUME_REQUIRED');
      return deliver({ project, bot, itemId }, record);
    },
    async answered({ projectId, itemId }: { readonly projectId: string; readonly itemId: string }) {
      const item = await itemFor(projectId, itemId);
      if (item.effects.some((effect) => ['prepared', 'dispatching', 'outcome-unknown'].includes(effect.state))) fail('BOT_EFFECT_UNSETTLED');
      await journal.update(projectId, itemId, (entry) => ({ ...entry, data: { ...entry.data, pendingQuestion: null } }));
    },
  });
}
