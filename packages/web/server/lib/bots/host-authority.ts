import { z } from 'zod';
import { BotServiceError, assertBotQuestionAuthority } from './services.js';
import { effectSchema, questionAuthoritySchema } from './services/contracts.js';
import { parseBotPayload } from './services/effects.js';
import type { BotServices, BotServicesOptions } from './services.js';
import type { BotServiceEffect, BotServiceRequest } from './services/contracts.js';
import type { RuntimeOptions } from './runtime/contracts.js';
import type { createBotExecutionStore } from './execution-store.js';
import type { readRepositoryPolicy } from './repository-policy.js';

type AuthorityOptions = Pick<RuntimeOptions, 'store' | 'config' | 'listProjects'> & {
  readonly journal: ReturnType<typeof createBotExecutionStore>;
  readonly readPolicy: typeof readRepositoryPolicy;
};
const questionsSchema = z.record(z.string(), z.json());
const pendingQuestionSchema = questionAuthoritySchema.pick({ question: true });

export function createHostAuthority({ store, config, listProjects, journal, readPolicy }: AuthorityOptions) {
  const resolveQuestionAuthority: NonNullable<BotServicesOptions['resolveQuestionAuthority']> = async ({ botId, itemId, key }) => {
    for (const project of await listProjects()) {
      const item = (await store.read(project.id)).items.find((entry) => entry.id === itemId && entry.botId === botId);
      if (!item) continue;
      if (item.state !== 'waiting-answer') return null;
      const execution = await journal.read(project.id, itemId);
      if (execution.data.pendingQuestion !== key) return null;
      const parsed = pendingQuestionSchema.safeParse({ question: questionsSchema.parse(execution.data.questions ?? {})[key] });
      if (!parsed.success) return null;
      const question = parsed.data.question;
      const settings = await config.read(project.id);
      const bot = settings.definitions.find((entry) => entry.id === botId && entry.enabled);
      if (!bot || bot.identity[question.route.service]?.identityId !== question.route.binding.identityId) return null;
      const authority = questionAuthoritySchema.safeParse({ policy: await readPolicy(project.path, settings.approvals), question });
      return authority.success ? authority.data : null;
    }
    return null;
  };
  const approvedDiscordPeople = async (effect: Pick<BotServiceEffect, 'botId' | 'itemId'>) => {
    for (const project of await listProjects()) {
      const item = (await store.read(project.id)).items.find((entry) => entry.id === effect.itemId && entry.botId === effect.botId);
      if (!item) continue;
      const policy = await readPolicy(project.path, (await config.read(project.id)).approvals);
      return policy.people.status === 'approved' ? policy.people.people.flatMap((person) => person.discord ? [person.discord] : []) : [];
    }
    return [];
  };
  const assertOwnerAuthority = async (effect: BotServiceRequest | BotServiceEffect, payload: ReturnType<typeof parseBotPayload>) => {
    switch (payload.operation) {
    case 'jira.question':
    case 'discord.question':
      assertBotQuestionAuthority({ ...effect, target: payload.target }, payload.input, await resolveQuestionAuthority({ botId: effect.botId, itemId: effect.itemId, key: effect.key }));
      break;
    default: break;
    }
    const service = 'authority' in effect ? effect.authority.service : effect.operation.startsWith('discord.') ? 'discord' : null;
    if (service === 'discord' && payload.service === 'discord' && payload.target.guildId === 'dm'
      && !(await approvedDiscordPeople(effect)).includes(payload.target.recipientId ?? '')) {
      throw new BotServiceError('BOT_DISCORD_PERSON_DENIED', 'The Discord recipient is absent from the approved people directory.');
    }
  };
  const guardServices = (services: BotServices): BotServices => ({ ...services,
    prepare: async (request) => { await assertOwnerAuthority(request, parseBotPayload(request)); return services.prepare(request); },
    execute: (prepared, input, options = {}) => services.execute(prepared, input, { ...options,
      beforeDispatch: async () => {
        const captured = effectSchema.parse(prepared);
        await assertOwnerAuthority(captured, parseBotPayload({ ...captured, input })); await options.beforeDispatch?.();
      } }),
  });
  return { resolveQuestionAuthority, approvedDiscordPeople, guardServices };
}
