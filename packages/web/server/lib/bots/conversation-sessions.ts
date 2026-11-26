import { z } from 'zod';
import { createBotAdapterState } from './adapter-state.js';
import { conversationCaptureSchema } from './conversation-contract.js';
import type { BotConversationExecution, ConversationCapture, ConversationTarget, ConversationSelection } from './conversation-contract.js';
import { scanPermissions } from '../suggested-tasks/runtime.js';
import { unwrapOpenCodeResponse } from '../opencode/response-envelope.js';
import { botNoticeIds } from '../message-queue/bot-notice.js';
import { BotServiceError } from './services/contracts.js';
import type { SessionClient } from '../openchamber-sessions/opencode-client-contract.js';
import type { createSessionActivityProbe } from '../opencode/session-activity.js';
import type { createTokenSnapshotReader } from '../pr-fix-loop/token-usage.js';
import type { createSessionKnowledgeRuntime } from '../session-knowledge/runtime.js';
import { createBotConversationDispatch } from './conversation-dispatch.js';
import type { BotArtifactBinding } from './artifacts-contract.js';
import { isSessionNotFoundError, type SessionSwitchModelInput } from '@opencode/client';

const recordSchema = z.object({ capture: conversationCaptureSchema, state: z.enum(['allocating', 'ready']) }).strict();
const infoSchema = z.object({
  id: z.string(), parentID: z.string().nullish(), location: z.object({ directory: z.string() }),
  agent: z.string().nullish(), model: z.object({ providerID: z.string(), id: z.string(), variant: z.string().optional() }).nullish(),
  time: z.object({ archived: z.number().nullish() }).optional(),
  metadata: z.object({ openchamber: z.object({ lead: z.object({ at: z.number() }), automation: z.object({
    source: z.literal('bot'), role: z.literal('conversation'), projectId: z.string(), botId: z.string(), itemId: z.string(),
  }) }) }),
});
type Options = {
  readonly dataDir: string;
  readonly clientFor: (directory: string) => {
    readonly session: Pick<SessionClient['session'], 'create' | 'get' | 'update' | 'interrupt' | 'synthetic' | 'prompt' | 'command' | 'switchModel' | 'switchAgent'>;
  };
  readonly activity: Pick<ReturnType<typeof createSessionActivityProbe>, 'fetchActiveSessionStatuses' | 'hasWorkingDescendants'>;
  readonly readTokens: ReturnType<typeof createTokenSnapshotReader>;
  readonly knowledge: Pick<ReturnType<typeof createSessionKnowledgeRuntime>, 'sync'>;
};
const refuse: (code: string) => never = (code) => {
  throw new BotServiceError(code, 'The recorded Bot conversation could not be verified.');
};
const leadPermissions = ({ bot }: ConversationCapture) => bot.isolated ? scanPermissions(false) : scanPermissions(bot.web, bot.mcp);
const keyFor = (input: ConversationTarget) => ({ projectId: input.project.id, botId: input.botId, itemId: input.itemId });

export function createBotConversationSessions({ dataDir, clientFor, activity, readTokens, knowledge }: Options): BotConversationExecution & {
  readonly artifactBinding: (sessionId: string) => Promise<BotArtifactBinding | null>;
} {
  const records = createBotAdapterState({ dataDir, name: 'conversation-sessions', schema: recordSchema });
  const dispatch = createBotConversationDispatch({ dataDir, clientFor });
  const verify = async (input: ConversationTarget) => {
    const record = await records.read(keyFor(input));
    if (!record || JSON.stringify(record.capture.conversation) !== JSON.stringify(input.conversation)
      || JSON.stringify(record.capture.project) !== JSON.stringify(input.project)) refuse('BOT_CONVERSATION_SCOPE_MISMATCH');
    const info = infoSchema.parse(unwrapOpenCodeResponse(await clientFor(input.conversation.directory).session.get({ sessionID: input.conversation.sessionId })));
    const marker = info.metadata.openchamber.automation;
    if (info.parentID || info.id !== input.conversation.sessionId || info.location.directory !== input.conversation.directory
      || marker.projectId !== input.project.id || marker.itemId !== input.itemId || marker.botId !== input.botId
      || info.metadata.openchamber.lead.at !== input.conversation.createdAt) refuse('BOT_CONVERSATION_SESSION_MISMATCH');
    return { info, capture: record.capture };
  };
  const prepare = async (input: ConversationTarget) => {
    const { info, capture } = await verify(input);
    if (info.time?.archived) refuse('BOT_CONVERSATION_ARCHIVED');
    await clientFor(input.conversation.directory).session.update({ sessionID: info.id, permissions: [
      ...leadPermissions(capture),
      { action: 'openchamber', resource: '*', effect: 'allow' },
      { action: 'openchamber_render', resource: '*', effect: 'allow' },
    ] });
    await knowledge.sync(info.id, input.conversation.directory, { includeMemorySaveRule: false });
  };
  const ensure = (input: ConversationCapture) => records.own(keyFor(input), async () => {
    const previous = await records.read(keyFor(input));
    if (previous && JSON.stringify(previous.capture) !== JSON.stringify(input)) refuse('BOT_CONVERSATION_CAPTURE_CHANGED');
    if (!previous) await records.write(keyFor(input), { capture: input, state: 'allocating' });
    let shouldCreate = !previous;
    if (previous?.state === 'allocating') {
      try {
        await verify(input);
      } catch (error) {
        if (!isSessionNotFoundError(error) || error.sessionID !== input.conversation.sessionId
          || !Object.hasOwn(error, 'message') || typeof error.message !== 'string') throw error;
        shouldCreate = true;
      }
    }
    if (shouldCreate) {
      const { selection, conversation } = input;
      let model: SessionSwitchModelInput['model'] = { providerID: selection.providerID, id: selection.modelID };
      if (selection.variant) model = { ...model, variant: selection.variant };
      await clientFor(conversation.directory).session.create({
        id: conversation.sessionId, title: input.title, location: { directory: conversation.directory },
        agent: selection.agent, model,
        permissions: leadPermissions(input),
        metadata: { openchamber: { lead: { at: conversation.createdAt }, automation: {
          source: 'bot', projectId: input.project.id, botId: input.botId, itemId: input.itemId, role: 'conversation', notify: input.bot.notify,
        } } },
      });
    }
    await verify(input);
    await prepare(input);
    if (previous?.state !== 'ready') await records.write(keyFor(input), { capture: input, state: 'ready' });
    return input.conversation;
  });
  return {
    artifactBinding: async (sessionId) => {
      const record = (await records.list()).find((entry) => entry.capture.conversation.sessionId === sessionId);
      if (!record) return null;
      const { capture } = record;
      return { projectId: capture.project.id, botId: capture.botId, itemId: capture.itemId,
        sessionId, directory: capture.conversation.directory, producer: { role: 'conversation' } };
    },
    ensure, prepare,
    dispatch: async (target, request) => { await verify(target); return dispatch(target, request); },
    read: async (input) => {
      const { info, capture } = await verify(input);
      let selection: ConversationSelection = capture.selection;
      if (info.model) {
        selection = { providerID: info.model.providerID, modelID: info.model.id };
        if (info.model.variant) selection = { ...selection, variant: info.model.variant };
        if (info.agent) selection = { ...selection, agent: info.agent };
      }
      return { selection, archived: Boolean(info.time?.archived) };
    },
    notice: async (input, notice) => {
      await verify(input);
      const metadata = { source: 'openchamber-notice', kind: 'bot', projectId: input.project.id, itemId: input.itemId, eventId: notice.eventId } as const;
      try {
        await clientFor(input.conversation.directory).session.synthetic({ sessionID: input.conversation.sessionId,
          id: botNoticeIds(metadata).messageId, text: notice.text, metadata, resume: false });
      } catch (error) {
        if (z.object({ status: z.literal(409) }).safeParse(error).success) return;
        throw error;
      }
    },
    tokens: async (input) => { await verify(input); return readTokens(input.conversation.sessionId, input.conversation.directory, { since: 0 }); },
    stop: async (input) => {
      await verify(input);
      await clientFor(input.conversation.directory).session.interrupt({ sessionID: input.conversation.sessionId });
      const active = await activity.fetchActiveSessionStatuses();
      if (active === null || active[input.conversation.sessionId]
        || await activity.hasWorkingDescendants(input.conversation.sessionId, active) !== false) refuse('BOT_CONVERSATION_NOT_STOPPED');
    },
  };
}
