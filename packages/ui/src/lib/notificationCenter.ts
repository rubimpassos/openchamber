/**
 * Client for the notification center routes
 * (`packages/web/server/lib/notifications/center-routes.js`). The server keeps
 * every notification it raised; this module speaks HTTP and parses what comes
 * back. Every function throws on failure; a server without the center answers
 * 404, reported as `NotificationCenterUnsupportedError`.
 */
import { z } from 'zod';
import { runtimeFetch } from '@/lib/runtime-fetch';

const notificationCenterEntrySchema = z.object({
  id: z.string().min(1),
  createdAt: z.number(),
  kind: z.enum(['ready', 'error', 'question', 'permission', 'goal', 'browser-help', 'plugin']),
  priority: z.enum(['high', 'normal', 'low']),
  delivery: z.enum(['delivered', 'focused', 'quiet']),
  verdict: z.enum(['review', 'stopped-midway', 'looks-done', 'trivial']).nullable(),
  title: z.string(),
  body: z.string(),
  sessionId: z.string().nullable(),
  directory: z.string().nullable(),
  sessionName: z.string().nullable(),
  readAt: z.number().nullable(),
});

export type NotificationCenterEntry = z.infer<typeof notificationCenterEntrySchema>;
export type NotificationCenterKind = NotificationCenterEntry['kind'];
export type NotificationCenterVerdict = NonNullable<NotificationCenterEntry['verdict']>;

/** One change broadcast as `openchamber:notification-center.changed`. */
export const notificationCenterChangeSchema = z.discriminatedUnion('change', [
  z.object({ change: z.literal('added'), entry: notificationCenterEntrySchema }),
  z.object({ change: z.literal('read'), ids: z.array(z.string()), readAt: z.number() }),
  z.object({ change: z.literal('cleared') }),
]);

export type NotificationCenterChange = z.infer<typeof notificationCenterChangeSchema>;

export type NotificationCenterReadTarget = { ids: string[] } | { sessionId: string } | { all: true };

export class NotificationCenterUnsupportedError extends Error {
  constructor() {
    super('This server has no notification center');
    this.name = 'NotificationCenterUnsupportedError';
  }
}

const failure = async (response: Response, action: string): Promise<Error> => {
  if (response.status === 404) return new NotificationCenterUnsupportedError();
  const text = await response.text().catch(() => '');
  return new Error(`Could not ${action} notifications (${response.status})${text ? `: ${text}` : ''}`);
};

const listResponseSchema = z.object({ entries: z.array(notificationCenterEntrySchema) });
const readResponseSchema = z.object({ ids: z.array(z.string()), readAt: z.number() });

/** Every kept notification, newest first. */
export const fetchNotificationCenter = async (): Promise<NotificationCenterEntry[]> => {
  const response = await runtimeFetch('/api/notification-center');
  if (!response.ok) throw await failure(response, 'load');
  return listResponseSchema.parse(await response.json()).entries;
};

export const markNotificationCenterRead = async (
  target: NotificationCenterReadTarget,
): Promise<z.infer<typeof readResponseSchema>> => {
  const response = await runtimeFetch('/api/notification-center/read', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(target),
  });
  if (!response.ok) throw await failure(response, 'mark read');
  return readResponseSchema.parse(await response.json());
};

export const clearNotificationCenter = async (): Promise<void> => {
  const response = await runtimeFetch('/api/notification-center', { method: 'DELETE' });
  if (!response.ok) throw await failure(response, 'clear');
};
