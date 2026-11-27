import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { isSessionNotFoundError, type SessionSwitchModelInput } from '@opencode/client';
import { createBotAdapterState } from './adapter-state.js';
import { botConversationSchema } from './schema.js';
import { conversationSelectionSchema } from './conversation-contract.js';
import { BotServiceError } from './services/contracts.js';
import { unwrapOpenCodeResponse } from '../opencode/response-envelope.js';
import { botNoticeIds } from '../message-queue/bot-notice.js';
import type { SessionClient } from '../openchamber-sessions/opencode-client-contract.js';
import type { createSessionKnowledgeRuntime } from '../session-knowledge/runtime.js';

const text = z.string().min(1).max(100_000);
const captureSchema = z.object({ botId: text, session: botConversationSchema, selection: conversationSelectionSchema, title: text }).strict();
const recordSchema = z.object({ capture: captureSchema, state: z.enum(['allocating', 'ready']) }).strict();
const infoSchema = z.object({
  id: z.string(), parentID: z.string().nullish(), location: z.object({ directory: z.string() }),
  time: z.object({ archived: z.number().nullish() }).optional(),
  metadata: z.object({ openchamber: z.object({ lead: z.object({ at: z.number() }),
    automation: z.object({ source: z.literal('bot'), role: z.literal('main'), botId: z.string() }) }) }),
});
export type BotMainSession = z.output<typeof botConversationSchema>;

const permissions = [
  { action: '*', resource: '*', effect: 'deny' },
  { action: 'question', resource: '*', effect: 'allow' },
  { action: 'openchamber', resource: '*', effect: 'allow' },
  { action: 'openchamber_render', resource: '*', effect: 'allow' },
  { action: 'openchamber_bot', resource: '*', effect: 'allow' },
] as const;

type Options = {
  readonly dataDir: string;
  readonly clientFor: (directory: string) => { readonly session: Pick<SessionClient['session'], 'create' | 'get' | 'update' | 'synthetic'> };
  readonly knowledge: Pick<ReturnType<typeof createSessionKnowledgeRuntime>, 'sync'>;
  readonly now?: () => number;
};

export function createBotMainSessions({ dataDir, clientFor, knowledge, now = Date.now }: Options) {
  const records = createBotAdapterState({ dataDir, name: 'main-sessions', schema: recordSchema });
  const refuse = (code: string): never => { throw new BotServiceError(code, 'The bot main chat could not be verified.'); };
  const verify = async (capture: z.output<typeof captureSchema>) => {
    const info = infoSchema.parse(unwrapOpenCodeResponse(await clientFor(capture.session.directory).session.get({ sessionID: capture.session.sessionId })));
    if (info.parentID || info.id !== capture.session.sessionId || info.location.directory !== capture.session.directory
      || info.metadata.openchamber.automation.botId !== capture.botId || info.metadata.openchamber.lead.at !== capture.session.createdAt) refuse('BOT_MAIN_SESSION_MISMATCH');
    return { archived: Boolean(info.time?.archived) };
  };
  const allocate = async (botId: string, prepare: () => Promise<{ readonly selection: z.input<typeof conversationSelectionSchema>; readonly title: string }>) => {
    const directory = path.join(dataDir, 'bots', 'home', createHash('sha256').update(botId).digest('hex').slice(0, 32));
    const { selection, title } = await prepare();
    const createdAt = now();
    const capture = captureSchema.parse({ botId, selection, title, session: { directory, createdAt,
      sessionId: `ses_${createHash('sha256').update(JSON.stringify(['bot-main', botId, createdAt])).digest('hex').slice(0, 32)}` } });
    await records.write({ botId }, { capture, state: 'allocating' });
    return capture;
  };
  const ensure = (botId: string, prepare: () => Promise<{ readonly selection: z.input<typeof conversationSelectionSchema>; readonly title: string }>) => records.own({ botId }, async () => {
    const previous = await records.read({ botId });
    let capture = previous?.capture ?? await allocate(botId, prepare);
    let state = previous?.state ?? 'allocating';
    await fs.mkdir(capture.session.directory, { recursive: true, mode: 0o700 });
    let create = !previous;
    if (previous) {
      let gone = false;
      let archived = false;
      try { archived = (await verify(capture)).archived; gone = archived; }
      catch (failure) {
        if (!isSessionNotFoundError(failure) || failure.sessionID !== capture.session.sessionId) throw failure;
        gone = true;
      }
      if (archived || gone && previous.state === 'ready') {
        capture = await allocate(botId, prepare);
        state = 'allocating';
      }
      create = gone;
    }
    const client = clientFor(capture.session.directory).session;
    if (create) {
      const { selection, session } = capture;
      let model: SessionSwitchModelInput['model'] = { providerID: selection.providerID, id: selection.modelID };
      if (selection.variant) model = { ...model, variant: selection.variant };
      await client.create({ id: session.sessionId, title: capture.title, location: { directory: session.directory },
        agent: selection.agent, model,
        permissions: [...permissions],
        metadata: { openchamber: { lead: { at: session.createdAt }, automation: { source: 'bot', role: 'main', botId, notify: 'attention' } } } });
    }
    await verify(capture);
    await client.update({ sessionID: capture.session.sessionId, permissions: [...permissions] });
    await knowledge.sync(capture.session.sessionId, capture.session.directory, { includeMemorySaveRule: false });
    if (state !== 'ready') await records.write({ botId }, { capture, state: 'ready' });
    return capture.session;
  });
  const read = async (botId: string) => (await records.read({ botId }))?.capture.session ?? null;
  return {
    ensure, read,
    botFor: async (sessionId: string) => (await records.list()).find((record) => record.capture.session.sessionId === sessionId)?.capture.botId ?? null,
    notice: async (botId: string, notice: { readonly eventId: string; readonly text: string }) => {
      const record = await records.read({ botId });
      if (record?.state !== 'ready') return;
      const { session } = record.capture;
      const metadata = { source: 'openchamber-notice', kind: 'bot', projectId: 'bot-main', itemId: botId, eventId: notice.eventId } as const;
      try {
        await clientFor(session.directory).session.synthetic({ sessionID: session.sessionId, id: botNoticeIds(metadata).messageId,
          text: notice.text, metadata, resume: false });
      } catch (failure) {
        if (z.object({ status: z.literal(409) }).safeParse(failure).success) return;
        throw failure;
      }
    },
  };
}
