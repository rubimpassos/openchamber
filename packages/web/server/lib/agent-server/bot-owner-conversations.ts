import type { BotServiceInput, BotServiceOperation, BotServiceReply } from './bot-service-contract.js';
import type { BotConversationExecution, ConversationTarget } from '../bots/conversation-contract.js';

type Options = {
  readonly call: <Operation extends BotServiceOperation>(operation: Operation, input: BotServiceInput<Operation>) => Promise<BotServiceReply<Operation>>;
  readonly target: (target: ConversationTarget, creating?: boolean) => Promise<ConversationTarget>;
};
export function createOwnerBotConversations({ call, target: checked }: Options): BotConversationExecution {
  return {
    ensure: async (capture) => { await checked(capture, true); return call('conversation-ensure', { capture }); },
    read: async (target) => call('conversation-read', { target: await checked(target) }),
    prepare: async (target) => { await call('conversation-prepare', { target: await checked(target) }); },
    tokens: async (target) => call('conversation-tokens', { target: await checked(target) }),
    stop: async (target) => { await call('conversation-stop', { target: await checked(target) }); },
    notice: async (target, notice) => { await call('conversation-notice', { target: await checked(target), notice }); },
    dispatch: async (target, request) => call('conversation-native', { target: await checked(target), request }),
  };
}
