import { createHash } from 'node:crypto';
import { z } from 'zod';

const identity = z.string().trim().min(1);
export const botNoticeSchema = z.object({
  source: z.literal('openchamber-notice'), kind: z.literal('bot'),
  projectId: identity, itemId: identity, eventId: identity,
}).strict();

type BotNotice = z.infer<typeof botNoticeSchema>;

export function requireBotNotice(value: BotNotice | undefined, itemId: string): BotNotice {
  if (!value || value.itemId !== itemId) throw new TypeError('invalid bot notice');
  if (JSON.stringify(value).length > 64 * 1024) throw new TypeError('bot notice is too large');
  return value;
}

export function botNoticeIds({ projectId, itemId, eventId }: Readonly<Pick<BotNotice, 'projectId' | 'itemId' | 'eventId'>>) {
  const digest = createHash('sha256').update(JSON.stringify([projectId, itemId, eventId])).digest('hex');
  return { itemId: `queued-bot-${digest}`, messageId: `msg_${digest}` };
}
