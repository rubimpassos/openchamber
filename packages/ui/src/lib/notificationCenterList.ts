/**
 * What the notification center lists for each filter, and how finished turns
 * of one session fold into one row. The center lists what is still open;
 * resolved entries (a finished turn that was seen, an answered question) live
 * in the history.
 */
import type { NotificationCenterEntry } from '@/lib/notificationCenter';
import { needsAttention, type AttentionSources } from '@/lib/notificationCenterAttention';

export type NotificationCenterFilter = 'all' | 'unread' | 'attention' | 'history';

export const matchesNotificationFilter = (
  entry: NotificationCenterEntry,
  filter: NotificationCenterFilter,
  sources: AttentionSources,
): boolean => {
  if (filter === 'history') return entry.resolvedAt !== null;
  if (entry.resolvedAt !== null) return false;
  if (filter === 'unread') return entry.readAt === null;
  if (filter === 'attention') return needsAttention(entry, sources);
  return true;
};

/** One row: the newest entry, plus every entry it stands for. */
export type NotificationRowGroup = { entry: NotificationCenterEntry; ids: string[] };

/**
 * Folds the finished turns of one session into the row of the newest one,
 * keeping the list's order. Every other kind keeps its own row.
 */
export const groupNotificationEntries = (entries: readonly NotificationCenterEntry[]): NotificationRowGroup[] => {
  const rows: NotificationRowGroup[] = [];
  const turnRowBySession = new Map<string, NotificationRowGroup>();
  for (const entry of entries) {
    if (entry.kind !== 'ready' || !entry.sessionId) {
      rows.push({ entry, ids: [entry.id] });
      continue;
    }
    const existing = turnRowBySession.get(entry.sessionId);
    if (existing) {
      existing.ids.push(entry.id);
      continue;
    }
    const row = { entry, ids: [entry.id] };
    turnRowBySession.set(entry.sessionId, row);
    rows.push(row);
  }
  return rows;
};

/** The filter the center opens on: "Needs you" when something waits, else everything open. */
export const initialNotificationFilter = (
  entries: readonly NotificationCenterEntry[],
  sources: AttentionSources,
): NotificationCenterFilter => (
  entries.some((entry) => matchesNotificationFilter(entry, 'attention', sources)) ? 'attention' : 'all'
);
