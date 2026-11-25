import { z } from 'zod';
import { conversationCaptureSchema, conversationTargetSchema, conversationNoticeSchema, conversationSelectionSchema,
  conversationNativeSchema, conversationNativeReplySchema } from '../bots/conversation-contract.js';
import { botConversationSchema } from '../bots/schema.js';

const success = z.object({ ok: z.literal(true) });
const target = z.object({ target: conversationTargetSchema }).strict();
export const BOT_CONVERSATION_OPERATIONS = {
  'conversation-ensure': { input: z.object({ capture: conversationCaptureSchema }).strict(), reply: botConversationSchema },
  'conversation-read': { input: target, reply: z.object({ selection: conversationSelectionSchema, archived: z.boolean() }) },
  'conversation-prepare': { input: target, reply: success },
  'conversation-tokens': { input: target, reply: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).nullable() },
  'conversation-stop': { input: target, reply: success },
  'conversation-notice': { input: target.extend({ notice: conversationNoticeSchema }).strict(), reply: success },
  'conversation-native': { input: target.extend({ request: conversationNativeSchema }).strict(), reply: conversationNativeReplySchema },
};
