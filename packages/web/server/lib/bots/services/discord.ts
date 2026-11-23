import { z } from 'zod';
import { BotServiceError, providerResult, snowflake } from './contracts.js';
import type { BotOperationInput, BotOperationTarget, BotServiceAuthority } from './contracts.js';
import type { ResolvedBotCredential } from './credentials.js';

type DiscordOperation = 'discord.send' | 'discord.question';
type DiscordCall = { [Operation in DiscordOperation]: [operation: Operation, input: BotOperationInput<Operation>] }[DiscordOperation];
type DiscordCredential = {
  readonly authority: Pick<BotServiceAuthority, 'providerAccountId'>;
  readonly request: ResolvedBotCredential<'discord'>['request'];
};
type DiscordMessage = {
  readonly content: string;
  readonly allowed_mentions: { readonly parse: readonly string[]; readonly users?: readonly string[];
    readonly roles?: readonly string[]; readonly replied_user?: boolean };
};

export function createDiscordAdapter(credential: DiscordCredential, target: BotOperationTarget<'discord.send'>,
  { beforeQuestionWrite }: { readonly beforeQuestionWrite?: (() => void | Promise<void>) | undefined } = {}) {
  const readChannel = async () => {
    const channel = providerResult(z.object({ id: snowflake, type: z.number().int(), guild_id: snowflake.optional(),
      recipients: z.array(z.object({ id: snowflake })).optional() }).safeParse(
    await credential.request({ path: `/api/v10/channels/${target.channelId}` })));
    const allowed = channel.id === target.channelId && (target.guildId === 'dm'
      ? channel.type === 1 && !channel.guild_id && channel.recipients?.some((person) => person.id === target.recipientId)
        && channel.recipients.every((person) => [target.recipientId, credential.authority.providerAccountId].includes(person.id))
      : channel.guild_id === target.guildId && [0, 5, 10, 11, 12].includes(channel.type));
    if (!allowed) throw new BotServiceError('BOT_DISCORD_CHANNEL_DENIED', 'The Discord channel does not match the approved destination.');
    return { channelId: channel.id, guildId: target.guildId };
  };
  return {
    async perform(...[operation, input]: DiscordCall) {
      await readChannel();
      let body: DiscordMessage = { content: input.body, allowed_mentions: { parse: [] } };
      switch (operation) {
      case 'discord.send': break;
      case 'discord.question': {
        if (!(beforeQuestionWrite instanceof Function)) throw new BotServiceError('BOT_QUESTION_AUTHORITY_REQUIRED', 'Question mentions require service authorization.');
        const users = input.recipients.map((person) => person.serviceId);
        body = { content: `${users.map((id) => `<@${id}>`).join(' ')}\n\n${input.body}`,
          allowed_mentions: { parse: [], users, roles: [], replied_user: false } };
        await beforeQuestionWrite();
        break;
      }
      default: {
        operation satisfies never;
        throw new BotServiceError('BOT_SERVICE_UNSUPPORTED', 'This Discord operation is unsupported.', 'failed', 400);
      }
      }
      const result = providerResult(z.object({ id: snowflake, channel_id: snowflake }).safeParse(await credential.request({
        path: `/api/v10/channels/${target.channelId}/messages`, method: 'POST',
        body,
      })), true);
      if (result.channel_id !== target.channelId) throw new BotServiceError('BOT_SERVICE_RESPONSE_INVALID', 'The Discord receipt names another channel.', 'outcome-unknown');
      return { messageId: result.id, channelId: result.channel_id };
    },
    reconcile: async () => ({ state: 'outcome-unknown' as const }),
    async read(operation: string) {
      if (operation !== 'discord.channel') throw new BotServiceError('BOT_SERVICE_UNSUPPORTED', 'This Discord read is unsupported.', 'failed', 400);
      return readChannel();
    },
  };
}
