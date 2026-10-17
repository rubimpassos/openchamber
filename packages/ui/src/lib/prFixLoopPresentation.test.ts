import { describe, expect, test } from 'bun:test';
import { DEFAULT_PR_FIX_LOOP_CONFIG, type FixLoop } from './prFixLoop';
import { fixLoopCiState } from './prFixLoopPresentation';

const loop: FixLoop = {
  id: '1', sessionId: 'session', directory: '/repo', owner: 'owner', repo: 'repo', number: 12,
  url: 'https://github.com/owner/repo/pull/12', title: 'Fix CI', branch: 'fix-ci', status: 'ready',
  statusReason: null, config: DEFAULT_PR_FIX_LOOP_CONFIG, iterations: 1, tokensUsed: 100,
  ci: { state: 'success', headSha: 'abc' }, unresolvedThreads: 0, changesRequested: false,
  worker: null, pendingApproval: null, review: null, lastCheckedAt: 1, lastError: null, createdAt: 1, updatedAt: 1,
};

describe('fix-loop CI presentation', () => {
  test('shows unknown after a GitHub read fails despite a retained green sample', () => {
    // Given
    const failed = { ...loop, lastError: 'network failure' };
    // When
    const state = fixLoopCiState(failed, false);
    // Then
    expect(state).toBe('unknown');
  });

  test('shows unknown when the projection cannot be refreshed', () => {
    // Given a last-known green loop
    // When
    const state = fixLoopCiState(loop, true);
    // Then
    expect(state).toBe('unknown');
  });

  test('shows unknown before the server has checked CI', () => {
    // Given
    const unchecked = { ...loop, ci: null };
    // When
    const state = fixLoopCiState(unchecked, false);
    // Then
    expect(state).toBe('unknown');
  });

  test('shows green only after an authoritative successful read', () => {
    // Given a checked loop with no read error
    // When
    const state = fixLoopCiState(loop, false);
    // Then
    expect(state).toBe('success');
  });
});
