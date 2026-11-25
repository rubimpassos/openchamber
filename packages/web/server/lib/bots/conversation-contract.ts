import { z } from 'zod';
import { botConversationSchema } from './schema.js';
import { botDefinitionSchema } from './config.js';

const text = z.string().min(1).max(100_000);
export const conversationSelectionSchema = z.object({
  providerID: text, modelID: text, agent: text.optional(), variant: text.optional(),
});
export const conversationScopeSchema = z.object({
  project: z.object({ id: text, path: text }).strict(), botId: text, itemId: text,
}).strict();
export const conversationCaptureSchema = conversationScopeSchema.extend({
  conversation: botConversationSchema, bot: botDefinitionSchema,
  selection: conversationSelectionSchema, title: text,
}).strict().refine((value) => value.bot.id === value.botId && value.conversation.directory === value.project.path);
export const conversationTargetSchema = conversationScopeSchema.extend({ conversation: botConversationSchema }).strict()
  .refine((value) => value.conversation.directory === value.project.path);
export const conversationNoticeSchema = z.object({
  eventId: text, text: z.string().max(200_000), resume: z.literal(false),
}).strict();
export const conversationNativeSchema = z.object({
  operationId: text, operation: z.enum(['prompt', 'command', 'synthetic', 'model', 'agent']),
  body: z.record(z.string(), z.json()), selection: conversationSelectionSchema,
}).strict();
export const conversationNativeReplySchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal(200), data: z.json() }).strict(),
  z.object({ status: z.literal(204), data: z.null() }).strict(),
]);
export type ConversationScope = z.output<typeof conversationScopeSchema>;
export type ConversationCapture = z.output<typeof conversationCaptureSchema>;
export type ConversationTarget = z.output<typeof conversationTargetSchema>;
export type ConversationSelection = z.output<typeof conversationSelectionSchema>;
export type ConversationNotice = z.output<typeof conversationNoticeSchema>;
export type ConversationNative = z.output<typeof conversationNativeSchema>;
export type ConversationNativeReply = z.output<typeof conversationNativeReplySchema>;
export type BotConversationExecution = {
  ensure(input: ConversationCapture): Promise<ConversationTarget['conversation']>;
  read(input: ConversationTarget): Promise<{ readonly selection: ConversationSelection; readonly archived: boolean }>;
  prepare(input: ConversationTarget): Promise<void>;
  notice(input: ConversationTarget, notice: ConversationNotice): Promise<void>;
  tokens(input: ConversationTarget): Promise<number | null>;
  stop(input: ConversationTarget): Promise<void>;
  dispatch(input: ConversationTarget, request: ConversationNative): Promise<ConversationNativeReply>;
};
