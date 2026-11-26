import React, { act } from 'react';
import { expect, test } from 'bun:test';
import { Window } from 'happy-dom';

import { useUIStore } from '@/stores/useUIStore';
import { useSessionUIStore } from '@/sync/session-ui-store';

import { openBrowserOfChatOnScreen, useMobileServerBrowserTabs } from './useMobileServerBrowserTabs';

const directory = '/mobile-browser-fixture';
const SERVER_BROWSER = 'openchamber-builtin-server-browser';

test('a chat gets a browser tab only when the person opens the Browser for it', async () => {
  const dom = new Window({ url: 'http://localhost/' });
  const globals = { window: dom, document: dom.document, navigator: dom.navigator, HTMLElement: dom.HTMLElement, Node: dom.Node, IS_REACT_ACT_ENVIRONMENT: true };
  const descriptors = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  const { createRoot } = await import('react-dom/client');
  const root = createRoot(document.body.appendChild(document.createElement('div')));
  const previousPanels = useUIStore.getState().contextPanelByDirectory;
  const previousSession = useSessionUIStore.getState().currentSessionId;
  const previousProvider = useUIStore.getState().browserProvider;
  let shown: ReturnType<typeof useMobileServerBrowserTabs> | null = null;
  const Probe: React.FC = () => {
    shown = useMobileServerBrowserTabs(directory, SERVER_BROWSER);
    return null;
  };
  const browser = () => {
    if (!shown) throw new Error('The hook did not mount');
    return shown;
  };
  const browserTabsInStore = () => {
    const panel = useUIStore.getState().contextPanelByDirectory[directory];
    return [...(panel?.tabs ?? []), ...(panel?.parkedBrowserTabs ?? [])].filter((tab) => tab.mode === 'browser');
  };
  try {
    useUIStore.setState({ contextPanelByDirectory: {}, browserProvider: SERVER_BROWSER });
    await act(async () => useSessionUIStore.setState({ currentSessionId: 'chat-a' }));
    await act(async () => root.render(<Probe />));
    expect(browser().activeId).toBeNull();
    expect(browserTabsInStore()).toEqual([]);

    await act(async () => openBrowserOfChatOnScreen(directory));
    const tabOfA = browser().activeId;
    expect(tabOfA).not.toBeNull();
    expect(browserTabsInStore().map((tab) => tab.ownerSessionId)).toEqual(['chat-a']);

    await act(async () => useSessionUIStore.setState({ currentSessionId: 'chat-b' }));
    expect(browser().activeId).toBeNull();
    expect(browser().tabs).toEqual([]);
    expect(browserTabsInStore().map((tab) => tab.ownerSessionId)).toEqual(['chat-a']);

    await act(async () => openBrowserOfChatOnScreen(directory));
    const tabOfB = browser().activeId;
    expect(tabOfB).not.toBeNull();
    expect(tabOfB).not.toBe(tabOfA);
    expect(browser().tabs.map((tab) => tab.ownerSessionId)).toEqual(['chat-b']);

    await act(async () => openBrowserOfChatOnScreen(directory));
    expect(browser().tabs.map((tab) => tab.id)).toEqual([tabOfB]);

    await act(async () => useSessionUIStore.setState({ currentSessionId: 'chat-a' }));
    expect(browser().activeId).toBe(tabOfA);
    expect(browser().tabs.map((tab) => tab.ownerSessionId)).toEqual(['chat-a']);
  } finally {
    await act(async () => root.unmount());
    useUIStore.setState({ contextPanelByDirectory: previousPanels, browserProvider: previousProvider });
    useSessionUIStore.setState({ currentSessionId: previousSession });
    await dom.happyDOM.close();
    for (const [key, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
