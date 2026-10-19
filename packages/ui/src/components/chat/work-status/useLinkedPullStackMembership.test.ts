import { describe, expect, test } from 'bun:test';
import { pullMembershipKey, shouldShowStackFollow } from './useLinkedPullStackMembership';

describe('follow whole stack visibility', () => {
  test('hides only for a PR known to be outside every stack', () => {
    expect(shouldShowStackFollow(false, false)).toBe(false);
    expect(shouldShowStackFollow(true, false)).toBe(true);
  });

  test('an unknown, failed or loading membership keeps the chip', () => {
    expect(shouldShowStackFollow(null, false)).toBe(true);
  });

  test('a stack the session already follows can always be unfollowed', () => {
    expect(shouldShowStackFollow(false, true)).toBe(true);
  });

  test('keys repositories case-insensitively', () => {
    expect(pullMembershipKey('Acme', 'App', 3)).toBe(pullMembershipKey('acme', 'app', 3));
  });
});
