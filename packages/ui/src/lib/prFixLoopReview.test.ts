import { describe, expect, test } from 'bun:test';
import { DEFAULT_PR_FIX_LOOP_CONFIG, fixLoopSchema, isFixLoopConfigLocked } from './prFixLoop';

const legacy = {
  id: 'loop-review', sessionId: 'ses_host', directory: '/repo', owner: 'owner', repo: 'repo', number: 12,
  url: 'https://github.com/owner/repo/pull/12', title: 'Fix review', branch: 'fix', status: 'waitingForPush',
  statusReason: null, config: { ...DEFAULT_PR_FIX_LOOP_CONFIG, pushMode: 'approval' }, iterations: 1, tokensUsed: 0,
  ci: null, unresolvedThreads: null, changesRequested: null,
  lastCheckedAt: null, lastError: null, createdAt: 1, updatedAt: 1,
};
const review = {
  state: 'awaitingPublication', actions: [
    { kind: 'thread', id: 'PRRT_thread', body: '  <script>untrusted()</script>\nKeep this exact text.  ', resolve: true },
    { kind: 'review', id: 17, body: 'Review reply' },
    { kind: 'comment', id: 18, body: 'Comment reply' },
  ], completed: 0, total: 4, lastError: null,
};

describe('host review projection boundary', () => {
  test('preserves exact frozen bodies and targets when the host provides a bounded plan', () => {
    // Given
    const input = { ...legacy, review };
    // When
    const parsed = fixLoopSchema.parse(input);
    // Then
    expect(parsed.review).toEqual(review);
  });

  test('accepts omitted review only as legacy absence', () => {
    // Given a legacy loop without a review field
    // When
    const parsed = fixLoopSchema.parse(legacy);
    // Then
    expect(parsed.review).toBeNull();
  });

  for (const state of ['pending', 'blocked', 'complete']) {
    test(`preserves authoritative ${state} progress and its error`, () => {
      // Given
      const progress = { ...review, state, completed: state === 'complete' ? 4 : 1, lastError: state === 'blocked' ? 'Write permission refused' : null };
      // When
      const parsed = fixLoopSchema.parse({ ...legacy, review: progress });
      // Then
      expect(parsed.review).toEqual(progress);
    });
  }

  for (const [state, locked] of [['awaitingPublication', false], ['pending', true], ['blocked', true], ['complete', false]] as const) {
    test(`configuration lock follows authoritative ${state} work`, () => {
      // Given
      const loop = fixLoopSchema.parse({ ...legacy, review: { ...review, state } });
      // When
      const result = isFixLoopConfigLocked(loop);
      // Then
      expect(result).toBe(locked);
    });
  }

  const malformed = [
    {}, { ...review, state: 'unknown' }, { ...review, lastError: undefined },
    { ...review, completed: -1 }, { ...review, completed: 0.5 }, { ...review, completed: 5 },
    { ...review, total: 3 }, { ...review, total: 5 },
    { ...review, actions: [{ kind: 'thread', id: 1, body: 'Reply', resolve: true }] },
    { ...review, actions: [{ kind: 'thread', id: 'thread', body: 'Reply' }] },
    { ...review, actions: [{ kind: 'thread', id: 'thread', body: 'Reply', resolve: 'yes' }] },
    { ...review, actions: [{ kind: 'review', id: '17', body: 'Reply' }] },
    { ...review, actions: [{ kind: 'comment', id: 0, body: 'Reply' }] },
    { ...review, actions: [{ kind: 'comment', id: 18, body: 'Reply', url: 'https://other.example' }] },
    { ...review, actions: [{ kind: 'comment', id: 18, body: ' ' }], total: 1 },
    { ...review, actions: [{ kind: 'comment', id: 18, body: 'x'.repeat(4_001) }], total: 1 },
    { ...review, actions: [{ kind: 'comment', id: 18, body: 'Reply' }, { kind: 'comment', id: 18, body: 'Duplicate' }], total: 2 },
    { ...review, actions: Array.from({ length: 201 }, (_, id) => ({ kind: 'comment', id: id + 1, body: 'Reply' })), total: 201 },
  ];
  for (const [index, invalid] of malformed.entries()) {
    test(`rejects malformed review ${index} without treating it as absent`, () => {
      // Given
      const input = { ...legacy, review: invalid };
      // When
      const parsed = fixLoopSchema.safeParse(input);
      // Then
      expect(parsed.success).toBe(false);
    });
  }
});
