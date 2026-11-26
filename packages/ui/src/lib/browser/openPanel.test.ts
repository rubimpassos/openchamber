import { expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import { connectMobileWorkspaceOpener } from '@/lib/mobileWorkspaceTabs';
import { useUIStore } from '@/stores/useUIStore';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { browserPanelAvailable, openBrowserPanel } from './openPanel';

test('a phone link opens the selected chat Browser and a missing shell leaves no hidden tab', async () => {
  const dom = new Window({ url: 'http://localhost/mobile.html' });
  Object.defineProperty(dom, '__OPENCHAMBER_SURFACE__', { value: 'mobile', configurable: true });
  const globals = { window: dom, document: dom.document, navigator: dom.navigator };
  const descriptors = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  const original = useUIStore.getState();
  const selected = useSessionUIStore.getState().currentSessionId;
  let opened: string | null = null;
  const disconnect = connectMobileWorkspaceOpener((request) => { opened = request.tab; });
  try {
    useUIStore.setState({ browserProvider: 'openchamber-builtin-server-browser', contextPanelByDirectory: {}, browserSessionContext: null });
    useSessionUIStore.setState({ currentSessionId: 'chat-a' });

    expect(openBrowserPanel('/repo', 'https://example.com/')).toBe(true);

    const panel = useUIStore.getState().contextPanelByDirectory['/repo'];
    expect(opened).toBe('preview');
    expect(panel.tabs.map((tab) => [tab.targetPath, tab.ownerSessionId])).toEqual([['https://example.com/', 'chat-a']]);
    disconnect();
    const panels = useUIStore.getState().contextPanelByDirectory;
    expect(openBrowserPanel('/repo', 'https://elsewhere.example/')).toBe(false);
    expect(useUIStore.getState().contextPanelByDirectory).toBe(panels);
    useUIStore.setState({ browserProvider: 'builtin' });
    expect(browserPanelAvailable()).toBe(false);
  } finally {
    disconnect();
    useUIStore.setState(original, true);
    useSessionUIStore.setState({ currentSessionId: selected });
    await dom.happyDOM.close();
    for (const [key, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
