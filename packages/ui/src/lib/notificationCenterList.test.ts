import { describe, expect, test } from 'bun:test';

import type { NotificationCenterEntry } from './notificationCenter';
import type { AttentionSources } from './notificationCenterAttention';
import {
  groupNotificationEntries,
  initialNotificationFilter,
  matchesNotificationFilter,
  type NotificationCenterFilter,
} from './notificationCenterList';

const entry = (id: string, overrides: Partial<NotificationCenterEntry> = {}): NotificationCenterEntry => ({
  id,
  createdAt: 1,
  kind: 'ready',
  priority: 'normal',
  delivery: 'delivered',
  verdict: null,
  title: 'Build agent is ready',
  body: '',
  sessionId: 'ses_1',
  directory: '/repo',
  sessionName: null,
  requestId: null,
  action: null,
  readAt: null,
  resolvedAt: null,
  ...overrides,
});

const sources: AttentionSources = {
  blocking: { hostSeeded: true, bySession: new Map() },
  restartPendingSessionIds: new Set(),
  fixLoopsAwaitingApproval: new Set(),
  restack: { statusByRunId: new Map(), readDirectories: new Set() },
  availableUpdateVersion: '',
};

describe('notification center list', () => {
  test('a resolved entry shows only in the history', () => {
    const resolved = entry('a', { readAt: 2, resolvedAt: 2 });
    const openFilters: NotificationCenterFilter[] = ['all', 'unread', 'attention'];
    expect(openFilters.map((filter) => matchesNotificationFilter(resolved, filter, sources))).toEqual([false, false, false]);
    expect(matchesNotificationFilter(resolved, 'history', sources)).toBe(true);
    expect(matchesNotificationFilter(entry('b'), 'history', sources)).toBe(false);
    expect(matchesNotificationFilter(entry('b'), 'all', sources)).toBe(true);
  });

  test('folds finished turns of one session into the newest row and keeps the order', () => {
    const rows = groupNotificationEntries([
      entry('t3'),
      entry('err', { kind: 'error', priority: 'high' }),
      entry('t2'),
      entry('other', { sessionId: 'ses_2' }),
      entry('t1'),
    ]);
    expect(rows.map((row) => [row.entry.id, row.ids])).toEqual([
      ['t3', ['t3', 't2', 't1']],
      ['err', ['err']],
      ['other', ['other']],
    ]);
  });

  test('opens on "Needs you" only when something waits', () => {
    expect(initialNotificationFilter([entry('a')], sources)).toBe('all');
    expect(initialNotificationFilter([entry('a'), entry('e', { kind: 'error' })], sources)).toBe('attention');
    expect(initialNotificationFilter([entry('e', { kind: 'error', readAt: 2 })], sources)).toBe('all');
  });
});
