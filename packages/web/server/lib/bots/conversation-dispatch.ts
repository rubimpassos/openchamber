import { createHash } from 'node:crypto';
import { z } from 'zod';
import { createBotAdapterState } from './adapter-state.js';
import { conversationNativeReplySchema, conversationNativeSchema, conversationTargetSchema } from './conversation-contract.js';
import type { BotConversationExecution } from './conversation-contract.js';
import type { SessionClient } from '../openchamber-sessions/opencode-client-contract.js';
import type { SessionPromptInput, SessionSwitchModelInput } from '@opencode/client';
import { BotServiceError } from './services/contracts.js';

const mention = z.object({ start: z.number(), end: z.number(), text: z.string() });
const files = z.array(z.object({ uri: z.string(), name: z.string().optional(), description: z.string().optional(),
  source: z.union([z.object({ type: z.literal('inline') }), z.object({ type: z.literal('uri'), uri: z.string() })]).optional(),
  mention: mention.optional() }).passthrough().transform(({ name, description, source, mention, ...fields }) => {
    let file: NonNullable<SessionPromptInput['files']>[number] = fields;
    if (name !== undefined) file = { ...file, name };
    if (description !== undefined) file = { ...file, description };
    if (source !== undefined) file = { ...file, source };
    if (mention !== undefined) file = { ...file, mention };
    return file;
  }));
const common = { text: z.string(), files: files.optional(), agents: z.array(z.object({ name: z.string(), mention: mention.optional() }).passthrough()
  .transform(({ mention, ...fields }) => {
    let agent: NonNullable<SessionPromptInput['agents']>[number] = fields;
    if (mention !== undefined) agent = { ...agent, mention };
    return agent;
  })).optional(),
  skills: z.array(z.object({ id: z.string(), mention: mention.optional() }).passthrough()
    .transform(({ mention, ...fields }) => {
      let skill: NonNullable<SessionPromptInput['skills']>[number] = fields;
      if (mention !== undefined) skill = { ...skill, mention };
      return skill;
    })).optional(),
  delivery: z.enum(['steer', 'queue']).nullish() };
const prompt = z.object({ ...common, id: z.string().nullish(), metadata: z.record(z.string(), z.json()).optional(), resume: z.boolean().nullish() }).passthrough();
const command = z.object({ ...common, name: z.string() }).passthrough();
const synthetic = z.object({ text: z.string(), id: z.string().nullish(), description: z.string().nullish(),
  metadata: z.record(z.string(), z.json()).optional(), delivery: z.enum(['steer', 'queue']).nullish(), resume: z.boolean().nullish() }).passthrough();
const model = z.object({ model: z.object({ id: z.string(), providerID: z.string(), variant: z.string().optional() }).passthrough()
  .transform(({ variant, ...fields }) => {
    let model: SessionSwitchModelInput['model'] = fields;
    if (variant !== undefined) model = { ...model, variant };
    return model;
  }) });
const agent = z.object({ agent: z.string() });
const recordSchema = z.object({ target: conversationTargetSchema, request: conversationNativeSchema,
  state: z.enum(['dispatching', 'succeeded']), reply: conversationNativeReplySchema.optional() }).strict();
type Options = {
  readonly dataDir: string;
  readonly clientFor: (directory: string) => { readonly session: Pick<SessionClient['session'], 'prompt' | 'command' | 'synthetic' | 'switchModel' | 'switchAgent'> };
};
export function createBotConversationDispatch({ dataDir, clientFor }: Options): BotConversationExecution['dispatch'] {
  const records = createBotAdapterState({ dataDir, name: 'conversation-dispatch', schema: recordSchema });
  return (target, request) => {
    const key = { projectId: target.project.id, itemId: target.itemId, botId: target.botId,
      sessionId: target.conversation.sessionId, operationId: request.operationId };
    return records.own(key, async () => {
      const previous = await records.read(key);
      if (previous) {
        if (JSON.stringify(previous.target) !== JSON.stringify(target) || JSON.stringify(previous.request) !== JSON.stringify(request)) {
          throw new BotServiceError('BOT_CONVERSATION_MESSAGE_CHANGED', 'The captured conversation operation changed.');
        }
        if (previous.reply) return previous.reply;
        throw new BotServiceError('BOT_CONVERSATION_DISPATCH_UNKNOWN', 'The original conversation delivery is unconfirmed.', 'outcome-unknown');
      }
      const client = clientFor(target.conversation.directory).session;
      const sessionID = target.conversation.sessionId;
      const id = `msg_${createHash('sha256').update(JSON.stringify(key)).digest('hex').slice(0, 32)}`;
      const input = (() => {
        switch (request.operation) {
          case 'prompt': return { operation: request.operation, body: prompt.parse(request.body) };
          case 'command': return { operation: request.operation, body: command.parse(request.body) };
          case 'synthetic': return { operation: request.operation, body: synthetic.parse(request.body) };
          case 'model': return { operation: request.operation, body: model.parse(request.body) };
          case 'agent': return { operation: request.operation, body: agent.parse(request.body) };
          default: request.operation satisfies never; throw new TypeError('Unknown conversation operation');
        }
      })();
      await records.write(key, { target, request, state: 'dispatching' });
      if (input.operation === 'prompt' || input.operation === 'command' || input.operation === 'synthetic' && input.body.resume !== false) {
        const { providerID, modelID, agent: selectedAgent, variant } = request.selection;
        let selectedModel: SessionSwitchModelInput['model'] = { providerID, id: modelID };
        if (variant) selectedModel = { ...selectedModel, variant };
        await client.switchModel({ sessionID, model: selectedModel });
        if (selectedAgent) await client.switchAgent({ sessionID, agent: selectedAgent });
      }
      const reply = await (async () => {
        switch (input.operation) {
          case 'prompt': return { status: 200, data: z.json().parse(await client.prompt({ ...input.body, sessionID, id: input.body.id ?? id })) };
          case 'command': await client.command({ ...input.body, sessionID }); return { status: 204, data: null };
          case 'synthetic': return { status: 200, data: z.json().parse(await client.synthetic({ ...input.body, sessionID, id: input.body.id ?? id })) };
          case 'model': await client.switchModel({ ...input.body, sessionID }); return { status: 204, data: null };
          case 'agent': await client.switchAgent({ ...input.body, sessionID }); return { status: 204, data: null };
          default: input satisfies never; throw new TypeError('Unknown conversation operation');
        }
      })();
      const captured = conversationNativeReplySchema.parse(reply);
      await records.write(key, { target, request, state: 'succeeded', reply: captured });
      return captured;
    });
  };
}
