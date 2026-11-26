import { describe, expect, test } from 'bun:test';

import type { MonitoredBrowser } from '@/lib/browser/serverBrowser/monitoredBrowsers';
import {
  browserPage,
  browserRowStatus,
  formatBrowserMemory,
  orderBrowserRows,
  totalBrowserMemory,
} from './serverBrowserRows';

const browser = (overrides: Partial<MonitoredBrowser> = {}): MonitoredBrowser => ({
  scopeId: 'scope',
  sessionId: 'ses_1',
  url: 'https://example.com/',
  title: 'Example',
  tabCount: 1,
  loading: false,
  agentActive: false,
  control: 'none',
  helpReason: null,
  lastError: null,
  lastActiveMinute: null,
  consoleErrors: 0,
  consoleWarnings: 0,
  ...overrides,
});

describe('browser rows', () => {
  test('a row shows one state: a request for the person, then live work, then the last failure', () => {
    const everything = browser({ helpReason: 'Sign in', agentActive: true, lastError: 'boom', control: 'viewer', loading: true });

    expect(browserRowStatus(everything)).toBe('needsYou');
    expect(browserRowStatus({ ...everything, helpReason: null })).toBe('working');
    expect(browserRowStatus({ ...everything, helpReason: null, agentActive: false })).toBe('failed');
    expect(browserRowStatus(browser({ control: 'viewer', loading: true }))).toBe('youControl');
    expect(browserRowStatus(browser({ control: 'other' }))).toBe('otherControls');
    expect(browserRowStatus(browser({ loading: true }))).toBe('loading');
    expect(browserRowStatus(browser())).toBe('idle');
  });

  test('the chat on screen leads and the rest keep the service order', () => {
    const rows = [browser({ scopeId: 'a', sessionId: 'ses_a' }), browser({ scopeId: 'b', sessionId: 'ses_b' }), browser({ scopeId: 'c', sessionId: 'ses_c' })];

    expect(orderBrowserRows(rows, 'ses_b').map((row) => row.scopeId)).toEqual(['b', 'a', 'c']);
    expect(orderBrowserRows(rows, null).map((row) => row.scopeId)).toEqual(['a', 'b', 'c']);
  });

  test('a page is named by its title, else its address, and a blank page by neither', () => {
    expect(browserPage(browser())).toBe('Example');
    expect(browserPage(browser({ title: '  ' }))).toBe('https://example.com/');
    expect(browserPage(browser({ title: '', url: 'about:blank' }))).toBeNull();
  });

  test('the total counts measured browsers only and is unknown when none was measured', () => {
    const rows = [browser({ scopeId: 'a' }), browser({ scopeId: 'b' }), browser({ scopeId: 'c' })];
    const memory = { sampledAt: 1, bytesByScope: new Map([['a', 100], ['c', 50], ['another-project', 900]]) };

    expect(totalBrowserMemory(rows, memory)).toBe(150);
    expect(totalBrowserMemory(rows, { sampledAt: 1, bytesByScope: new Map() })).toBeNull();
    expect(totalBrowserMemory(rows, null)).toBeNull();
  });

  test('memory reads in whole megabytes below a gigabyte and in tenths of a gigabyte above', () => {
    expect(formatBrowserMemory(300 * 1024 ** 2, 'en-US')).toBe('300 MB');
    expect(formatBrowserMemory(200_000, 'en-US')).toBe('1 MB');
    expect(formatBrowserMemory(1024 ** 3, 'en-US')).toBe('1 GB');
    expect(formatBrowserMemory(1.55 * 1024 ** 3, 'de-DE')).toBe('1,6 GB');
  });
});
