import { describe, expect, test } from 'bun:test';

import { parseServerBrowserState } from './client';
import { browserMemoryKey, monitoredBrowsers } from './monitoredBrowsers';
import type { ServerBrowserScope, ServerBrowserState } from './types';
import { publishedServerBrowserState, useServerBrowserSharedState } from './sharedState';

const scope = (overrides: Partial<ServerBrowserScope> & Pick<ServerBrowserScope, 'id' | 'directory'>): ServerBrowserScope => ({
  sessionId: 'ses_1',
  profile: null,
  signIn: false,
  selected: false,
  url: 'https://example.com/',
  title: 'Example',
  isLoading: false,
  canGoBack: false,
  canGoForward: false,
  tabs: [],
  viewport: null,
  problems: { errors: 0, warnings: 0 },
  zoomLevel: 0,
  ...overrides,
});

const state = (scopes: ServerBrowserScope[], overrides: Partial<ServerBrowserState> = {}): ServerBrowserState => ({
  controller: 'none',
  viewerInControl: false,
  selectedScopeId: null,
  generation: 1,
  help: null,
  chrome: { status: 'ready', message: '' },
  scopes,
  ...overrides,
});

describe('monitored browsers', () => {
  test('lists the chats of the project on screen and leaves out other projects and sign-in browsers', () => {
    const browsers = monitoredBrowsers(state([
      scope({ id: 'mine', directory: '/work/app/' }),
      scope({ id: 'windows', directory: 'c:\\work\\app' }),
      scope({ id: 'other', directory: '/work/other' }),
      scope({ id: 'worktree', directory: '/work/app-feature' }),
      scope({ id: 'sign-in', directory: '/work/app', signIn: true }),
    ]), '/work/app');

    expect(browsers.map((browser) => browser.scopeId)).toEqual(['mine']);
    expect(monitoredBrowsers(null, '/work/app')).toEqual([]);
  });

  test('reports who acts in a browser from what the service says', () => {
    const [agent, person, quiet] = monitoredBrowsers(state([
      scope({ id: 'agent', directory: '/p', agentActive: true, lastError: 'Timed out waiting for the selector' }),
      scope({ id: 'person', directory: '/p' }),
      scope({ id: 'quiet', directory: '/p', isLoading: true }),
    ], {
      controller: 'user',
      selectedScopeId: 'person',
      help: { scopeId: 'agent', reason: 'Solve the captcha', tabId: null, since: 0 },
    }), '/p');

    expect(agent).toMatchObject({ agentActive: true, lastError: 'Timed out waiting for the selector', helpReason: 'Solve the captcha', control: 'none' });
    expect(person).toMatchObject({ control: 'other', helpReason: null });
    expect(quiet).toMatchObject({ loading: true, control: 'none' });
    expect(monitoredBrowsers(state([scope({ id: 'person', directory: '/p' })], {
      controller: 'user',
      selectedScopeId: 'person',
      viewerInControl: true,
    }), '/p')[0]?.control).toBe('viewer');
  });

  test('a provider that sends none of the newer fields still gives a row', () => {
    const received = parseServerBrowserState({
      controller: 'none',
      scopes: [{ id: 'old', directory: '/p', sessionId: 'ses_1', url: 'about:blank', title: '' }],
    });

    expect(monitoredBrowsers(received, '/p')[0]).toEqual({
      scopeId: 'old',
      sessionId: 'ses_1',
      url: 'about:blank',
      title: '',
      tabCount: 0,
      loading: false,
      agentActive: false,
      control: 'none',
      helpReason: null,
      lastError: null,
      lastActiveMinute: null,
      consoleErrors: 0,
      consoleWarnings: 0,
    });
  });

  test('activity inside one minute changes neither the row nor the memory key', () => {
    const at = (lastActivityAt: number) => monitoredBrowsers(state([scope({ id: 'a', directory: '/p', lastActivityAt })]), '/p');
    const first = at(1_700_000_045_000);
    const later = at(1_700_000_095_000);

    expect(later).toEqual(first);
    expect(browserMemoryKey(later)).toBe(browserMemoryKey(first));
    expect(at(1_700_000_105_000)[0]?.lastActiveMinute).not.toBe(first[0]?.lastActiveMinute);
  });

  test('a refreshed snapshot updates last use even when material state has the same version', () => {
    const store = useServerBrowserSharedState.getState();
    const guest = 'activity-fixture';
    try {
      store.publish(guest, 'runtime', state([scope({ id: 'a', directory: '/p', lastActivityAt: 60_000 })], { version: 'v1' }));
      store.publish(guest, 'runtime', state([scope({ id: 'a', directory: '/p', lastActivityAt: 180_000 })], { version: 'v1' }));

      const current = publishedServerBrowserState(useServerBrowserSharedState.getState(), guest, 'runtime');
      expect(monitoredBrowsers(current, '/p')[0]?.lastActiveMinute).toBe(180_000);
    } finally {
      store.clear(guest);
    }
  });

  test('the memory key follows what changes a browser\'s memory and is empty with no browser', () => {
    const key = (overrides: Partial<ServerBrowserScope>) => browserMemoryKey(
      monitoredBrowsers(state([scope({ id: 'a', directory: '/p', ...overrides })]), '/p'),
    );

    expect(browserMemoryKey([])).toBe('');
    expect(key({ url: 'https://example.com/next' })).not.toBe(key({}));
    expect(key({ isLoading: true })).not.toBe(key({}));
    expect(key({ agentActive: true })).not.toBe(key({}));
    expect(key({ title: 'Renamed' })).toBe(key({}));
  });
});
