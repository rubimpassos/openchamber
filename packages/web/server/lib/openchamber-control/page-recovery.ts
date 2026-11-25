import { z } from 'zod';
import { isOperatorChildSession } from '../session-lineage.js';
import { OpenChamberControlError } from './error.js';
import { isAgentPrompt, renderPageQuestion, renderPageTitleFromHtml, RENDER_PAGE_MAX_HTML_LENGTH, RENDER_PAGE_MAX_TITLE_LENGTH } from './render-page.js';
import type { createPageAnswers, PageAnswerInput } from './render-page.js';
import type { createLaterPages, LaterPageInput } from './later-pages.js';
import type { ControlClient } from './opencode-client.js';
import type { SessionInfo, SessionMessageInfo } from '@opencode/client';

const text = z.string().trim().min(1);
const identitySchema = z.object({ sessionId: text, messageId: text, callId: text });
export type PageRecoveryIdentity = Readonly<z.infer<typeof identitySchema>>;
export type RecoveredPageInput = LaterPageInput & PageRecoveryIdentity & { readonly source: 'recovered-await' };
export type ReadRecoveredPage = (identity: PageRecoveryIdentity) => Promise<RecoveredPageInput | null>;
export interface PageRecoveryValidation {
  readonly read: ReadRecoveredPage;
  readonly isWaiting: (identity: PageRecoveryIdentity) => boolean;
}

const fieldsSchema = z.object({
  html: z.string().max(RENDER_PAGE_MAX_HTML_LENGTH).optional(),
  ui: z.string().max(RENDER_PAGE_MAX_HTML_LENGTH).optional(),
  title: z.string().trim().max(RENDER_PAGE_MAX_TITLE_LENGTH).optional(),
  awaitAnswer: z.union([z.boolean(), z.enum(['true', 'false'])]).optional(),
  answerLater: z.union([z.boolean(), z.enum(['true', 'false'])]).optional(),
  share: z.unknown().optional(),
});
const callSchema = z.object({ action: z.string().optional(), parameters: z.record(z.string(), z.unknown()).optional() }).passthrough();
const metadataSchema = z.object({
  openchamber: z.object({
    interruption: z.object({ reason: text, at: z.number() }).nullish(),
    restartCutTurn: z.object({ messageID: text, callID: text.nullable(), toolName: text.nullable(), at: z.number() }).nullish(),
  }),
});
const settledMetadataSchema = z.object({
  openchamber: z.object({ ok: z.boolean().optional(), answer: z.unknown().optional() })
    .refine((value) => value.ok !== undefined || Object.hasOwn(value, 'answer')),
});
const MARKERS = new Set(['idle', 'agent-switched', 'model-switched', 'location-switched']);
const READ_TIMEOUT_MS = 15_000;

const progressSchema = z.union([
  z.object({ type: z.literal('session.status'), properties: z.object({ sessionID: text, status: z.object({ type: z.enum(['busy', 'retry']) }) }) })
    .transform(({ properties }) => ({ sessionId: properties.sessionID, messageId: null })),
  z.object({ type: z.literal('session.idle'), properties: z.object({ sessionID: text, aborted: z.literal(true), reason: z.enum(['user', 'superseded']) }) })
    .transform(({ properties }) => ({ sessionId: properties.sessionID, messageId: null })),
  z.object({ type: z.literal('message.updated'), properties: z.object({ info: z.object({ sessionID: text, id: text, role: z.enum(['user', 'assistant']) }) }) })
    .transform(({ properties: { info } }) => ({ sessionId: info.sessionID, messageId: info.role === 'assistant' ? info.id : null })),
]);
export const readRecoveredPageProgress = (payload: unknown) => progressSchema.safeParse(payload).data;

const readInput = (value: unknown) => {
  const call = callSchema.safeParse(value);
  if (!call.success) return null;
  let spilled: unknown;
  if (call.data.action?.trim().startsWith('{')) {
    try {
      spilled = JSON.parse(call.data.action);
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
      return null;
    }
  }
  const revived = callSchema.safeParse(spilled).data;
  const input = fieldsSchema.safeParse({ ...revived, ...revived?.parameters, ...call.data, ...call.data.parameters });
  if (!input.success) return null;
  const fields = input.data;
  if ((fields.awaitAnswer !== true && fields.awaitAnswer !== 'true') || fields.answerLater === true || fields.answerLater === 'true' || fields.share != null) return null;
  const html = fields.html?.trim() ?? '';
  const ui = fields.ui?.trim() ?? '';
  if (Boolean(html) === Boolean(ui)) return null;
  return {
    title: fields.title || renderPageTitleFromHtml(html) || 'Page',
    ...renderPageQuestion(ui ? 'ui' : 'html', ui || html),
  };
};

const interruptedAt = (session: SessionInfo, message: Extract<SessionMessageInfo, { type: 'assistant' }>, callId: string) => {
  const metadata = metadataSchema.safeParse(session.metadata).data?.openchamber;
  const minimum = Math.max(message.time.created, session.time.idle ?? 0, session.time.busy ?? 0);
  const interruption = metadata?.interruption;
  if (interruption && interruption.at >= minimum && interruption.reason !== 'inactivity' && interruption.reason !== 'opencode-restart') return null;
  const cut = metadata?.restartCutTurn;
  if (cut && cut.messageID === message.id && cut.callID === callId && cut.toolName === 'openchamber_render' && cut.at >= minimum) return cut.at;
  return interruption?.reason === 'inactivity' && interruption.at >= minimum ? interruption.at : null;
};

const latestContent = async (client: ControlClient, sessionID: string, signal: AbortSignal) => {
  let cursor: string | undefined;
  let idle: Extract<SessionMessageInfo, { type: 'idle' }> | undefined;
  const seen = new Set<string>();
  for (;;) {
    const page = await client.message.list({ sessionID, limit: 30, ...(cursor ? { cursor } : { order: 'desc' as const }) }, { signal });
    for (const message of page.data) {
      if (message.type === 'idle' && !idle) idle = message;
      if (!MARKERS.has(message.type)) return { message, idle };
    }
    const next = page.cursor?.next;
    if (!next || page.data.length === 0) return null;
    if (seen.has(next)) throw new OpenChamberControlError('OpenCode repeated the history cursor during page recovery', 502);
    seen.add(next);
    cursor = next;
  }
};

interface PageRecoveryOptions {
  readonly getClient: (directory?: string | null) => Promise<ControlClient>;
  readonly pageAnswers: ReturnType<typeof createPageAnswers>;
  readonly laterPages: ReturnType<typeof createLaterPages> | null;
}

export const createPageRecovery = ({ getClient, pageAnswers, laterPages }: PageRecoveryOptions) => {
  const read: ReadRecoveredPage = async (identity) => {
    const { sessionId, messageId, callId } = identity;
    if (pageAnswers.has(sessionId, callId)) return null;
    const options = { signal: AbortSignal.timeout(READ_TIMEOUT_MS) };
    const session = await (await getClient()).session.get({ sessionID: sessionId }, options);
    if (session.id !== sessionId || isOperatorChildSession(session) || session.revert) return null;
    const directory = session.location.directory;
    const client = await getClient(directory);
    const [active, forms, inbox, latest] = await Promise.all([
      client.session.active(options),
      client.session.form.list({ sessionID: sessionId }, options),
      client.session.inbox.list({ sessionID: sessionId }, options),
      latestContent(client, sessionId, options.signal),
    ]);
    if (active[sessionId] || forms.length || pageAnswers.has(sessionId, callId)) return null;
    if (inbox.some((item) => item.type === 'user' && !isAgentPrompt(item.payload.metadata))) return null;
    const message = latest?.message;
    if (message?.type !== 'assistant' || message.id !== messageId) return null;
    const tool = message.content.find((part) => part.type === 'tool' && part.id === callId);
    if (tool?.type !== 'tool' || tool.name !== 'openchamber_render') return null;
    const at = interruptedAt(session, message, callId);
    const { state } = tool;
    switch (state.status) {
      case 'streaming':
      case 'completed':
        return null;
      case 'error':
        if (state.error.type !== 'aborted' || at === null || at < (tool.time.completed ?? 0)) return null;
        break;
      case 'running':
        if ((session.outcome === 'interrupted' || latest?.idle?.outcome === 'interrupted') && at === null) return null;
        break;
      default: {
        const exhaustive: never = state;
        throw new TypeError(`Unknown tool state: ${exhaustive}`);
      }
    }
    const interruption = metadataSchema.safeParse(session.metadata).data?.openchamber.interruption;
    if (interruption && interruption.at >= message.time.created && interruption.reason !== 'inactivity' && interruption.reason !== 'opencode-restart') return null;
    if (settledMetadataSchema.safeParse(state.metadata).success) return null;
    const page = readInput(state.input);
    return page ? { ...identity, ...page, directory, source: 'recovered-await' } : null;
  };

  const recover = async (input: unknown) => {
    const parsed = identitySchema.safeParse(input);
    if (!parsed.success) throw new OpenChamberControlError('sessionId, messageId and callId are required', 400);
    if (!laterPages) throw new OpenChamberControlError('Page recovery is not available on this server', 503);
    return { page: await laterPages.recover(parsed.data, validation) };
  };
  const validation: PageRecoveryValidation = { read, isWaiting: ({ sessionId, callId }) => pageAnswers.has(sessionId, callId) };
  const answer = (input: PageAnswerInput) => {
    try {
      return pageAnswers.answer(input);
    } catch (error) {
      if (!(error instanceof OpenChamberControlError) || error.statusCode !== 404 || !laterPages) throw error;
      return laterPages.answer(input, validation);
    }
  };
  return { recover, answer };
};
