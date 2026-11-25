import { z } from 'zod';
import type { ControlClient } from './opencode-client.js';
import type { createPageAnswers } from './render-page.js';
import type { createLaterPages } from './later-pages.js';
import { controlErrorFields } from './error.js';

export const renderedPageProjectionSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('answered'), summary: z.string(), data: z.json(), undelivered: z.literal(true).optional() }).strict(),
  z.object({ kind: z.literal('waiting'), later: z.literal(true).optional() }).strict(),
  z.object({ kind: z.enum(['declined', 'not-drawn']), undelivered: z.literal(true).optional() }).strict(),
  z.object({ kind: z.enum(['show', 'unanswered', 'answered-in-chat', 'chat-sent-earlier', 'later']) }).strict(),
]);
export type RenderedPageProjection = z.output<typeof renderedPageProjectionSchema>;
export type RenderedPageOrigin = {
  readonly sessionId: string; readonly callId: string; readonly messageId?: string | undefined; readonly directory: string;
};
type Options = {
  readonly getClient: (directory: string) => Promise<ControlClient>;
  readonly pageAnswers: ReturnType<typeof createPageAnswers>;
  readonly laterPages: ReturnType<typeof createLaterPages> | null;
};
const resultSchema = z.object({ openchamber: z.object({ ok: z.literal(true), answer: z.discriminatedUnion('answered', [
  z.object({ answered: z.literal(true), summary: z.string(), data: z.json() }),
  z.object({ answered: z.literal(false), reason: z.string().optional() }),
]).optional() }) });

export function createRenderedPageProjection({ getClient, pageAnswers, laterPages }: Options) {
  return async (origin: RenderedPageOrigin): Promise<RenderedPageProjection | null> => {
    const { sessionId, callId, messageId, directory } = origin;
    const later = await laterPages?.find(sessionId, callId);
    if (later) {
      const undelivered = later.undelivered ? { undelivered: true as const } : {};
      switch (later.status) {
        case 'open': return { kind: 'waiting', later: true };
        case 'answered': return { kind: 'answered', ...z.object({ summary: z.string(), data: z.json() }).parse(later), ...undelivered };
        case 'declined': return { kind: 'declined', ...undelivered };
        case 'ui-not-drawn': return { kind: 'not-drawn', ...undelivered };
        case 'closed': return { kind: 'unanswered' };
        default: return assertNever(later.status);
      }
    }
    if (pageAnswers.has(sessionId, callId)) return { kind: 'waiting' };
    if (!messageId) return null;
    let message;
    try {
      message = await (await getClient(directory)).session.message.get({ sessionID: sessionId, messageID: messageId },
        { signal: AbortSignal.timeout(15_000) });
    } catch (error) {
      if (controlErrorFields(error)?._tag === 'MessageNotFoundError' || controlErrorFields(error)?._tag === 'SessionNotFoundError') return null;
      throw error;
    }
    if (message.id !== messageId || message.type !== 'assistant') return null;
    const tool = message.content.find((part) => part.type === 'tool' && part.id === callId);
    if (tool?.type !== 'tool' || tool.name !== 'openchamber_render') return null;
    switch (tool.state.status) {
      case 'streaming': case 'running': case 'error': return { kind: 'unanswered' };
      case 'completed': {
        const result = resultSchema.safeParse(tool.state.metadata);
        if (!result.success) return { kind: 'unanswered' };
        const answer = result.data.openchamber.answer;
        if (!answer) return { kind: 'show' };
        if (answer.answered) return { kind: 'answered', summary: answer.summary, data: answer.data };
        switch (answer.reason) {
          case 'declined': return { kind: 'declined' };
          case 'ui-not-drawn': return { kind: 'not-drawn' };
          case 'chat-sent-earlier': return { kind: 'chat-sent-earlier' };
          default: return { kind: 'answered-in-chat' };
        }
      }
      default: return assertNever(tool.state);
    }
  };
}
function assertNever(value: never): never { throw new TypeError(`Unknown rendered page state: ${String(value)}`); }
