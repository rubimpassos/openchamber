import { expect, mock, test } from 'bun:test';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { Window } from 'happy-dom';
import { create } from 'zustand';
import { ThemeSystemProvider } from '@/contexts/ThemeSystemContext';
import { I18nProvider } from '@/lib/i18n';
import { useUIStore } from '@/stores/useUIStore';
import { useServerBrowserPanelTabs } from '@/lib/browser/serverBrowser/panelTabs';
import { wasBrowserTabOpenedWithAddress } from '@/lib/browser/devServerWait';
import type { ServerBrowserScope, ServerBrowserState } from '@/lib/browser/serverBrowser/types';

const directory = '/browser-link-fixture';
const scopeId = JSON.stringify([directory, 'chat']);
const blankScope: ServerBrowserScope = {
  id: scopeId, directory, sessionId: 'chat', profile: null, signIn: false,
  selected: true, url: 'about:blank', title: '', isLoading: false,
  canGoBack: false, canGoForward: false, viewport: null, zoomLevel: 0,
  problems: { errors: 0, warnings: 0 },
  tabs: [{ id: 'chrome-1', url: 'about:blank', title: '', isLoading: false, active: true }],
};
const connection = create<{ scope: ServerBrowserScope; error: string | null }>(() => ({ scope: blankScope, error: null }));
const navigations: string[] = [];
let failNavigation = false;
const navigate = async (url: string) => {
  navigations.push(url);
  const scope = connection.getState().scope;
  const next = { ...scope, url, tabs: scope.tabs.map((tab) => tab.active ? { ...tab, url } : tab) };
  connection.setState({ scope: next, error: failNavigation ? 'Navigation failed' : null });
  if (failNavigation) return null;
  const state: ServerBrowserState = {
    controller: 'none', viewerInControl: false, selectedScopeId: scopeId, generation: 1,
    help: null, chrome: { status: 'ready', message: '' }, scopes: [next],
  };
  return state;
};
mock.module('@/lib/browser/serverBrowser/useServerBrowserConnection', () => ({
  useServerBrowserConnection: () => {
    const { scope, error } = connection();
    return {
      scope, error, state: null, sessionId: 'chat', loading: false, navigate,
      reload: () => navigate(connection.getState().scope.url),
      selectTab: async (id: string) => {
        const current = connection.getState().scope;
        connection.setState({ scope: { ...current, tabs: current.tabs.map((tab) => ({ ...tab, active: tab.id === id })) }, error: null });
        return null;
      },
    };
  },
}));
mock.module('./ServerBrowserCanvas', () => ({ ServerBrowserCanvas: () => null }));
mock.module('./BrowserEmptyState', () => ({ BrowserEmptyState: () => null }));
mock.module('@/hooks/useRuntimeAPIs', () => ({ useRuntimeAPIs: () => ({ files: { downloadFile: async () => undefined } }) }));

const { ServerBrowserView } = await import('./ServerBrowserView');

test('opens a chat link through the server browser and receives another click on its existing tab', async () => {
  const dom = new Window({ url: 'http://localhost/' });
  const globals = {
    window: dom, document: dom.document, navigator: dom.navigator, localStorage: dom.localStorage,
    Element: dom.Element, HTMLElement: dom.HTMLElement, ResizeObserver: dom.ResizeObserver,
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const descriptors = Object.getOwnPropertyDescriptors(globalThis);
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  const previous = useUIStore.getState().contextPanelByDirectory;
  useUIStore.setState({ contextPanelByDirectory: {} });
  useServerBrowserPanelTabs.setState({ claims: {}, failedNavigations: new Set() });
  connection.setState({ scope: blankScope, error: null });
  navigations.length = 0;
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const url = 'https://example.com/chat-link';
  const renderView = (tabID: string) => root.render(
    <I18nProvider><ThemeSystemProvider>
      <ServerBrowserView guestId="browser" directory={directory} tabID={tabID} />
    </ThemeSystemProvider></I18nProvider>,
  );
  try {
    // Given a link opened before the browser view mounts.
    useUIStore.getState().openContextPreview(directory, url);
    // A second click before mounting queues a request for the same new tab.
    useUIStore.getState().openContextPreview(directory, url);
    const tabID = useUIStore.getState().contextPanelByDirectory[directory]?.activeTabId;
    expect(tabID).toBeTruthy();
    if (!tabID) throw new Error('Browser tab was not opened');
    // When the server browser pairs that panel tab with its first Chrome tab.
    await act(async () => renderView(tabID));
    // Then the requested address reaches the service instead of being erased by about:blank.
    expect(navigations).toEqual([url]);
    expect(useUIStore.getState().contextPanelByDirectory[directory]?.tabs.find((tab) => tab.id === tabID)?.targetPath).toBe(url);
    expect(wasBrowserTabOpenedWithAddress(directory, tabID)).toBe(false);
    await act(async () => useUIStore.getState().openContextPreview(directory, url));
    expect(navigations).toEqual([url]);

    // Given the browser is still open but its previous navigation failed.
    failNavigation = true;
    await act(async () => connection.setState({ scope: blankScope, error: 'Navigation failed' }));
    // When the same chat link is clicked again.
    await act(async () => useUIStore.getState().openContextPreview(directory, url));
    // Then that existing tab receives a fresh navigation.
    expect(navigations).toEqual([url, url]);
    // Selecting a tab clears connection-command errors, but not its failed page.
    await act(async () => connection.setState({ error: null }));
    failNavigation = false;
    await act(async () => useUIStore.getState().openContextPreview(directory, url));
    expect(navigations).toEqual([url, url, url]);

    // A successful toolbar reload also recovers a failed page.
    failNavigation = true;
    await act(async () => connection.setState({ scope: blankScope, error: 'Navigation failed' }));
    await act(async () => useUIStore.getState().openContextPreview(directory, url));
    failNavigation = false;
    const reload = host.querySelector<HTMLButtonElement>('button[aria-label="Reload"]');
    if (!reload) throw new Error('Reload button is missing');
    await act(async () => reload.click());
    expect(navigations).toHaveLength(5);
    await act(async () => useUIStore.getState().openContextPreview(directory, url));
    expect(navigations).toHaveLength(5);

    // Mirroring an agent-opened Chrome page must not reload that page.
    const current = connection.getState().scope;
    await act(async () => connection.setState({ scope: { ...current, tabs: [...current.tabs, {
      id: 'agent-tab', url: 'https://example.com/agent', title: 'Agent page', isLoading: false, active: false,
    }] } }));
    const mirrored = useUIStore.getState().contextPanelByDirectory[directory]?.tabs.find((tab) => tab.targetPath === 'https://example.com/agent');
    expect(mirrored).toBeDefined();
    if (!mirrored) throw new Error('Agent page was not mirrored');
    await act(async () => renderView(mirrored.id));
    expect(navigations).toHaveLength(5);
    expect(wasBrowserTabOpenedWithAddress(directory, mirrored.id)).toBe(false);
  } finally {
    await act(async () => root.unmount());
    useUIStore.setState({ contextPanelByDirectory: previous });
    useServerBrowserPanelTabs.setState({ claims: {}, failedNavigations: new Set() });
    failNavigation = false;
    await dom.happyDOM.close();
    for (const key of Object.keys(globals)) {
      const descriptor = descriptors[key];
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
