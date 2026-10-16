import { beforeEach, describe, expect, test } from 'bun:test';

import { notificationCenterChangeSchema, type NotificationCenterEntry } from '@/lib/notificationCenter';
import { selectNotificationCenterUnread, useNotificationCenterStore } from './useNotificationCenterStore';

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
  readAt: null,
  ...overrides,
});

beforeEach(() => {
  useNotificationCenterStore.setState({ status: 'ready', entries: [] });
});

describe('notification center store', () => {
  test('applies added, read and cleared changes and counts unread', () => {
    const { applyChange } = useNotificationCenterStore.getState();
    applyChange({ change: 'added', entry: entry('n1') });
    applyChange({ change: 'added', entry: entry('n2') });
    applyChange({ change: 'added', entry: entry('n2') });
    expect(useNotificationCenterStore.getState().entries.map((item) => item.id)).toEqual(['n2', 'n1']);
    expect(selectNotificationCenterUnread(useNotificationCenterStore.getState())).toBe(2);

    applyChange({ change: 'read', ids: ['n1'], readAt: 5 });
    expect(useNotificationCenterStore.getState().entries.find((item) => item.id === 'n1')?.readAt).toBe(5);
    expect(selectNotificationCenterUnread(useNotificationCenterStore.getState())).toBe(1);

    applyChange({ change: 'cleared' });
    expect(useNotificationCenterStore.getState().entries).toEqual([]);
  });

  test('a runtime switch drops the previous server\'s entries', () => {
    useNotificationCenterStore.setState({ entries: [entry('n1')] });
    useNotificationCenterStore.getState().resetForRuntime();
    expect(useNotificationCenterStore.getState()).toMatchObject({ status: 'idle', entries: [] });
  });

  test('parses the broadcast change and rejects an unknown one', () => {
    expect(notificationCenterChangeSchema.safeParse({ change: 'added', entry: entry('n1') }).success).toBe(true);
    expect(notificationCenterChangeSchema.safeParse({ change: 'added', entry: { id: 'n1' } }).success).toBe(false);
    expect(notificationCenterChangeSchema.safeParse({ change: 'deleted' }).success).toBe(false);
  });
});
