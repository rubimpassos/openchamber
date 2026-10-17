import { describe, expect, test } from 'bun:test';

import type { Metadata, Session } from '@/lib/opencode/model';
import { isSessionPriority, withSessionPriority } from './sessionPriority';

const session = (metadata: Metadata): Session => ({
  id: 'ses_1', projectID: 'project', directory: '/repo', title: 'A', cost: 0,
  time: { created: 1, updated: 1 },
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  metadata,
});

describe('session priority', () => {
  test('reads the mark', () => {
    expect(isSessionPriority(session({ openchamber: { priority: { at: 5 } } }))).toBe(true);
    expect(isSessionPriority(session({ openchamber: { priority: true } }))).toBe(false);
    expect(isSessionPriority(session({}))).toBe(false);
    expect(isSessionPriority(null)).toBe(false);
  });

  test('sets and clears the mark and keeps the rest of the namespace', () => {
    const metadata = { other: 1, openchamber: { work: { state: 'open' } } };
    const on = withSessionPriority(metadata, true, 42);

    expect(on).toEqual({ other: 1, openchamber: { work: { state: 'open' }, priority: { at: 42 } } });
    expect(withSessionPriority(on, true, 99)).toBe(on);
    expect(withSessionPriority(on, false, 99)).toEqual(metadata);
    expect(withSessionPriority(metadata, false, 99)).toBe(metadata);
  });
});
