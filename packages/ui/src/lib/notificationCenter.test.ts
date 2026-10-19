import { afterEach, describe, expect, test } from 'bun:test';

import { fetchNotificationCenter } from './notificationCenter';

const previousFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = previousFetch;
});

type StoredEntry = { id: string; kind: string; requestId?: string | null; action?: object | null };

const stored = (overrides: Partial<StoredEntry> = {}) => ({
  id: 'n1',
  createdAt: 1,
  kind: 'ready',
  priority: 'normal',
  delivery: 'delivered',
  verdict: null,
  title: 'Build agent is ready',
  body: '',
  sessionId: 'ses_1',
  directory: null,
  sessionName: null,
  readAt: null,
  ...overrides,
});

describe('fetchNotificationCenter', () => {
  test('asks for every kind and keeps the entries it can read when a newer server sends one it cannot', async () => {
    const urls: string[] = [];
    globalThis.fetch = Object.assign(async (input: RequestInfo | URL) => {
      urls.push(String(input));
      return Response.json({
        entries: [
          stored({ id: 'old' }),
          stored({ id: 'restart', kind: 'restart', requestId: null, action: { type: 'sessions', sessions: [{ sessionId: 'ses_2', directory: null, title: 'Two' }] } }),
          stored({ id: 'future', kind: 'something-new' }),
        ],
      });
    }, previousFetch);

    const entries = await fetchNotificationCenter();

    expect(urls[0]).toContain('/api/notification-center?version=2');
    expect(entries.map((entry) => entry.id)).toEqual(['old', 'restart']);
    // A server before v2 sends neither field.
    expect(entries[0]).toMatchObject({ requestId: null, action: null });
    expect(entries[1].action).toEqual({ type: 'sessions', sessions: [{ sessionId: 'ses_2', directory: null, title: 'Two' }] });
  });
});
