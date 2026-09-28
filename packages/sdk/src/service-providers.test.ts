import { describe, expect, test } from 'bun:test';

import { browserProviderResultSchema } from './service-provider-schemas.ts';
import { BROWSER_CONTROL_ACTIONS, isBrowserControlAction, readBrowserProviderRequest } from './service-providers.ts';

describe('browser provider contract', () => {
  test('reads the body the host posts and refuses anything else', () => {
    const body = JSON.stringify({ requestId: 'req-1', action: 'browser.click', parameters: { selector: '#save' } });
    expect(readBrowserProviderRequest(body)).toEqual({
      requestId: 'req-1',
      action: 'browser.click',
      parameters: { selector: '#save' },
      context: { directory: null, sessionId: null },
    });
    const scoped = JSON.stringify({ requestId: 'req-2', action: 'browser.back', parameters: {}, context: { directory: '/repo', sessionId: 'ses_1' } });
    expect(readBrowserProviderRequest(scoped)?.context).toEqual({ directory: '/repo', sessionId: 'ses_1' });
    const halfScoped = JSON.stringify({ requestId: 'req-3', action: 'browser.back', parameters: {}, context: { directory: '', sessionId: 7 } });
    expect(readBrowserProviderRequest(halfScoped)?.context).toEqual({ directory: null, sessionId: null });

    expect(readBrowserProviderRequest('not json')).toBeNull();
    expect(readBrowserProviderRequest('null')).toBeNull();
    expect(readBrowserProviderRequest(JSON.stringify({ requestId: '', action: 'browser.click', parameters: {} }))).toBeNull();
    expect(readBrowserProviderRequest(JSON.stringify({ requestId: 'r', action: 'browser.explode', parameters: {} }))).toBeNull();
    expect(readBrowserProviderRequest(JSON.stringify({ requestId: 'r', action: 'browser.back' }))).toBeNull();
  });

  test('the action list is the tool\'s eleven browser actions', () => {
    expect(BROWSER_CONTROL_ACTIONS).toHaveLength(11);
    expect(isBrowserControlAction('browser.snapshot')).toBe(true);
    expect(isBrowserControlAction('browser.requestHelp')).toBe(true);
    expect(isBrowserControlAction('projects.list')).toBe(false);
  });

  test('reads a browser.requestHelp request', () => {
    const body = JSON.stringify({
      requestId: 'req-4',
      action: 'browser.requestHelp',
      parameters: { reason: 'Sign in with your Google account to continue', timeoutSeconds: 300 },
    });
    expect(readBrowserProviderRequest(body)).toEqual({
      requestId: 'req-4',
      action: 'browser.requestHelp',
      parameters: { reason: 'Sign in with your Google account to continue', timeoutSeconds: 300 },
      context: { directory: null, sessionId: null },
    });
  });

  test('the host accepts ok/data and ok/error answers only', () => {
    expect(browserProviderResultSchema.safeParse({ ok: true, data: { url: 'http://a/' } }).success).toBe(true);
    expect(browserProviderResultSchema.safeParse({ ok: false, error: 'No element matches #x' }).success).toBe(true);
    expect(browserProviderResultSchema.safeParse({ ok: true }).success).toBe(false);
    expect(browserProviderResultSchema.safeParse({ ok: false, error: '' }).success).toBe(false);
    expect(browserProviderResultSchema.safeParse({ data: {} }).success).toBe(false);
  });

  test('the host accepts a browser.requestHelp outcome', () => {
    expect(browserProviderResultSchema.safeParse({
      ok: true,
      data: { outcome: 'timeout', url: 'http://a/', title: 'A', waitedSeconds: 300 },
    }).success).toBe(true);
    expect(browserProviderResultSchema.safeParse({
      ok: true,
      data: { outcome: 'handed-back', tabId: 'tab-1', url: 'http://a/', title: 'A', waitedSeconds: 42 },
    }).success).toBe(true);
  });
});
