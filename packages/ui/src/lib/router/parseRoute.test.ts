import { describe, expect, test } from 'bun:test';

import { parseRoute } from './parseRoute';

describe('parseRoute session', () => {
  test('reads a session id including OpenCode underscores', () => {
    const route = parseRoute(new URLSearchParams('session=ses_abc123'));
    expect(route.sessionId).toBe('ses_abc123');
  });

  test('decodes a percent-encoded session id', () => {
    const route = parseRoute(new URLSearchParams('session=ses%5Fabc123'));
    expect(route.sessionId).toBe('ses_abc123');
  });

  test('ignores a blank session param', () => {
    const route = parseRoute(new URLSearchParams('session='));
    expect(route.sessionId).toBeNull();
  });
});

describe('parseRoute panel', () => {
  test('reads the guest id a browser-help deep link names', () => {
    const route = parseRoute(new URLSearchParams('session=ses_1&panel=server-chrome'));
    expect(route.guestPanelId).toBe('server-chrome');
  });

  test('ignores a missing or blank panel param', () => {
    expect(parseRoute(new URLSearchParams('session=ses_1')).guestPanelId).toBeNull();
    expect(parseRoute(new URLSearchParams('panel=')).guestPanelId).toBeNull();
  });
});
