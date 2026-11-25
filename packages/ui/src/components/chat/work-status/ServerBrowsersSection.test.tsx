import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Window } from 'happy-dom';

import type { ServerBrowserResult } from '@/lib/browser/serverBrowser/client';
import type { MonitoredBrowser } from '@/lib/browser/serverBrowser/monitoredBrowsers';
import type { ServerBrowserMemory, ServerBrowserState } from '@/lib/browser/serverBrowser/types';
import type { ServerBrowserMonitorView } from '@/lib/browser/serverBrowser/useServerBrowserMonitor';
import { I18nProvider } from '@/lib/i18n';
import { browserStatusI18n } from '@/lib/i18n/messages/browser-status.i18n';
import { useGlobalSessionsStore } from '@/stores/useGlobalSessionsStore';
import { useUIStore } from '@/stores/useUIStore';

let ServerBrowsersList: typeof import('./ServerBrowsersList').ServerBrowsersList;

const copy = browserStatusI18n.en;

const browser = (overrides: Partial<MonitoredBrowser>): MonitoredBrowser => ({
  scopeId: 'scope',
  sessionId: null,
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

const REFUSED: ServerBrowserResult<ServerBrowserState> = {
  ok: false,
  status: 409,
  error: 'Dock controls are available only while the shared surface is idle or to the viewer in control',
};

describe('browsers in work status', () => {
  let win: Window;
  let root: Root;
  let container: HTMLElement;
  let restoreGlobals: () => void;
  let closed: string[];

  const monitor = (browsers: MonitoredBrowser[], overrides: Partial<ServerBrowserMonitorView> = {}): ServerBrowserMonitorView => ({
    browsers,
    memory: null,
    readFailed: false,
    refreshing: false,
    refresh: () => undefined,
    close: async (scopeId) => {
      closed.push(scopeId);
      return REFUSED;
    },
    ...overrides,
  });
  const render = (view: ServerBrowserMonitorView) => act(async () => root.render(
    <I18nProvider><ServerBrowsersList monitor={view} sessionId="ses_checkout" directory="/work/app" /></I18nProvider>,
  ));
  const closeButton = (name: string) => {
    const label = copy['chat.workStatus.browsers.close.aria'].replace('{name}', name);
    const button = container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
    if (!button) throw new Error(`No close button for ${name}`);
    return button;
  };
  const dialogButton = (text: string) => {
    const button = [...document.body.querySelectorAll('button')].find((candidate) => candidate.textContent === text);
    if (!button) throw new Error(`No dialog button ${text}`);
    return button;
  };

  beforeEach(async () => {
    win = new Window({ url: 'http://localhost' });
    const values = {
      window: win, document: win.document, navigator: win.navigator,
      Node: win.Node, Element: win.Element, HTMLElement: win.HTMLElement,
      HTMLButtonElement: win.HTMLButtonElement, HTMLInputElement: win.HTMLInputElement,
      HTMLIFrameElement: win.HTMLIFrameElement, SVGElement: win.SVGElement,
      Document: win.Document, DocumentFragment: win.DocumentFragment,
      DOMRect: win.DOMRect, Event: win.Event, CustomEvent: win.CustomEvent,
      MouseEvent: win.MouseEvent, KeyboardEvent: win.KeyboardEvent,
      MutationObserver: win.MutationObserver, ResizeObserver: win.ResizeObserver,
      localStorage: win.localStorage, getComputedStyle: win.getComputedStyle.bind(win),
      requestAnimationFrame: win.requestAnimationFrame.bind(win),
      cancelAnimationFrame: win.cancelAnimationFrame.bind(win), IS_REACT_ACT_ENVIRONMENT: true,
    };
    const previous = Object.keys(values).map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const);
    for (const [name, value] of Object.entries(values)) Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
    restoreGlobals = () => {
      for (const [name, descriptor] of previous) {
        if (descriptor) Object.defineProperty(globalThis, name, descriptor);
        else Reflect.deleteProperty(globalThis, name);
      }
    };
    ({ ServerBrowsersList } = await import('./ServerBrowsersList'));
    useGlobalSessionsStore.getState().upsertSession({
      id: 'ses_checkout', directory: '/work/app', projectID: 'project', title: 'Checkout flow', time: { created: 1, updated: 1 },
      cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    });
    closed = [];
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    useGlobalSessionsStore.getState().resetForRuntimeSwitch();
    await win.happyDOM.close();
    restoreGlobals();
  });

  test('names each browser by its chat and shows memory only where it was measured', async () => {
    const memory: ServerBrowserMemory = { sampledAt: 1_700_000_000_000, bytesByScope: new Map([['mine', 300 * 1024 ** 2]]) };
    await render(monitor([
      browser({ scopeId: 'other', sessionId: 'ses_unknown', agentActive: true }),
      browser({ scopeId: 'mine', sessionId: 'ses_checkout' }),
    ], { memory }));

    const rows = [...container.querySelectorAll<HTMLButtonElement>('button[aria-label]')]
      .filter((button) => button.getAttribute('aria-label') !== copy['chat.workStatus.browsers.refresh'])
      .map((button) => button.closest('.group\\/browser')?.textContent ?? '');
    expect(rows).toHaveLength(2);
    expect(rows[0]).toContain('Checkout flow');
    expect(rows[0]).toContain('Example');
    expect(rows[0]).toContain('300 MB');
    expect(rows[1]).toContain(copy['chat.workStatus.browsers.status.working']);
    expect(rows[1]).not.toContain('MB');
    expect(container.querySelector('[data-work-status-heading]')?.textContent).toContain('300 MB');
  });

  test('closing asks first, and a refused close leaves the browser listed', async () => {
    await render(monitor([browser({ scopeId: 'mine', sessionId: 'ses_checkout' })]));

    await act(async () => closeButton('Checkout flow').click());
    expect(document.body.textContent).toContain(copy['chat.workStatus.browsers.close.message'].replace('{name}', 'Checkout flow'));
    const cancel = [...document.body.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')]
      .find((button) => button.textContent !== copy['chat.workStatus.browsers.close'] && button.textContent);
    if (!cancel) throw new Error('No cancel button');
    await act(async () => cancel.click());
    expect(closed).toEqual([]);

    await act(async () => closeButton('Checkout flow').click());
    await act(async () => dialogButton(copy['chat.workStatus.browsers.close']).click());
    expect(closed).toEqual(['mine']);
    expect(closeButton('Checkout flow').disabled).toBe(false);
  });

  test('confirming a browser close after switching chats closes only the original chat tabs', async () => {
    const original = useUIStore.getState();
    try {
      useUIStore.setState({ contextPanelByDirectory: {}, browserSessionContext: null });
      const ui = useUIStore.getState();
      ui.showBrowserTabsOfSession('/work/app', 'ses_checkout');
      ui.openContextBrowser('/work/app', 'https://example.com/a');
      const closedState: ServerBrowserState = {
        controller: 'none', viewerInControl: false, selectedScopeId: null, generation: 2, viewId: null,
        help: null, chrome: { status: 'system', message: '' }, scopes: [],
      };
      await render(monitor([browser({ scopeId: 'mine', sessionId: 'ses_checkout' })], {
        close: async () => ({ ok: true, data: closedState }),
      }));
      await act(async () => closeButton('Checkout flow').click());
      await act(async () => {
        ui.showBrowserTabsOfSession('/work/app', 'ses_other');
        ui.openContextBrowser('/work/app', 'https://example.com/b');
      });
      const currentTab = useUIStore.getState().contextPanelByDirectory['/work/app'].activeTabId;

      await act(async () => dialogButton(copy['chat.workStatus.browsers.close']).click());

      const panel = useUIStore.getState().contextPanelByDirectory['/work/app'];
      expect(panel.tabs.map((tab) => tab.id)).toEqual([currentTab]);
      expect(panel.isOpen).toBe(true);
      expect(panel.parkedBrowserTabs).toBeUndefined();
    } finally {
      useUIStore.setState(original, true);
    }
  });

  test('a failed read is said under the last rows, and no browser means no section', async () => {
    await render(monitor([browser({ scopeId: 'mine', sessionId: 'ses_checkout' })], { readFailed: true }));
    expect(container.textContent).toContain(copy['chat.workStatus.browsers.readFailed']);
    expect(container.textContent).toContain('Checkout flow');

    await render(monitor([]));
    expect(container.innerHTML).toBe('');
  });
});
