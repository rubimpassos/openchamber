import { z } from 'zod';
import { approvalError } from './approval-contract.js';

export const RECENT_MESSAGE_LIMIT = 100;
// At 8 MiB per response, 32 pages match code-out's 256 MiB transfer ceiling.
const MAX_TURN_PAGES = 32;
const turnPageSchema = z.object({ data: z.array(z.unknown()).max(RECENT_MESSAGE_LIMIT),
  cursor: z.object({ next: z.string().min(1).nullable().optional(), previous: z.string().min(1).nullable().optional() }) });
const messageTime = z.object({ created: z.number(), completed: z.number().optional() });
const messageBase = z.object({ id: z.string().startsWith('msg_'), time: messageTime });
const recentMessageSchema = z.discriminatedUnion('type', [
  messageBase.extend({ type: z.literal('idle'), outcome: z.enum(['succeeded', 'failed', 'interrupted']).optional(), error: z.never().optional() }),
  messageBase.extend({ type: z.literal('user'), text: z.string() }),
  messageBase.extend({ type: z.literal('assistant'), error: z.never().optional(), retry: z.never().optional(),
    finish: z.enum(['stop', 'length', 'tool-calls', 'content-filter', 'error', 'unknown']).optional(),
    content: z.array(z.discriminatedUnion('type', [
      z.object({ type: z.literal('text'), text: z.string() }),
      z.object({ type: z.literal('reasoning'), text: z.string() }),
      z.object({ type: z.literal('tool'), state: z.object({ status: z.enum(['streaming', 'running', 'completed', 'error']) }) }),
    ])),
  }),
]);
type RecentMessage = z.infer<typeof recentMessageSchema>;

// Parse only the newest turn. A prior idle or user cannot supply a missing result.
export async function completedTurnResult(readPage: (cursor: string | undefined) => Promise<unknown>) {
  let assistant: Extract<RecentMessage, { type: 'assistant' }> | null = null;
  let idle: Extract<RecentMessage, { type: 'idle' }> | null = null;
  let previousCreated = Infinity;
  let cursor: string | undefined;
  const cursors = new Set<string>();
  const messages = new Set<string>();
  for (let index = 0; index < MAX_TURN_PAGES; index += 1) {
    const page = turnPageSchema.parse(await readPage(cursor));
    for (const raw of page.data) {
      const message = recentMessageSchema.parse(raw);
      if (messages.has(message.id) || message.time.created > previousCreated) throw approvalError('The worker history overlaps or is out of order.');
      messages.add(message.id);
      previousCreated = message.time.created;
      switch (message.type) {
        case 'idle':
          if (idle || assistant || (message.outcome !== undefined && message.outcome !== 'succeeded')) {
            throw approvalError('The worker turn did not complete successfully.');
          }
          idle = message;
          break;
        case 'assistant':
          if (!assistant) {
            if (message.time.completed === undefined) return null;
            if (message.time.completed < message.time.created || (idle && message.time.completed > idle.time.created)
              || (message.finish !== undefined && message.finish !== 'stop')
              || message.content.some((part) => part.type === 'tool' && part.state.status !== 'completed')) {
              throw approvalError('The worker assistant result is incomplete or failed.');
            }
            assistant = message;
          }
          break;
        case 'user':
          if (!assistant) {
            if (idle) throw approvalError('The worker turn has no completed assistant result.');
            return null;
          }
          return assistant;
        default: {
          const unsupported: never = message;
          throw approvalError(`The worker history contains an unsupported record: ${String(unsupported)}.`);
        }
      }
    }
    // The pinned server may emit next even on its last nonempty page.
    if (page.data.length < RECENT_MESSAGE_LIMIT) throw approvalError('The worker turn boundary has not been observed.');
    const next = page.cursor.next;
    if (!next || cursors.has(next)) throw approvalError('The worker history cursor is missing or repeated.');
    cursors.add(next);
    cursor = next;
  }
  throw approvalError('The worker turn exceeded its history read limit.');
}
