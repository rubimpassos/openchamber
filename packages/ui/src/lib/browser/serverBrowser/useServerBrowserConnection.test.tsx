import { act } from 'react';
import { expect, test } from 'bun:test';
import { createRoot } from 'react-dom/client';
import { installHookTestDom } from '@/components/session/sidebar/test-utils/testDom';
import { configureRuntimeUrlResolver, getRuntimeUrlResolver, setRuntimeUrlResolver } from '@/lib/runtime-url';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { serveTestHttp } from '@/lib/test-http-server';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { monitoredBrowsers } from './monitoredBrowsers';
import { publishedServerBrowserState, useServerBrowserSharedState } from './sharedState';
import type { ServerBrowserState } from './types';
import { useServerBrowserConnection } from './useServerBrowserConnection';

const GUEST = 'activity-refresh-fixture';
const DIRECTORY = '/activity-project';
const snapshot = (lastActivityAt: number): ServerBrowserState => ({
  version: 'same-material-version',
  generation: 1,
  viewId: 'activity-view',
  controller: 'none',
  viewerInControl: false,
  selectedScopeId: 'scope',
  help: null,
  chrome: { status: 'ready', message: '' },
  scopes: [{
    id: 'scope', directory: DIRECTORY, sessionId: 'activity-session', profile: null,
    signIn: false, selected: true, url: 'https://example.com/', title: 'Example',
    isLoading: false, canGoBack: false, canGoForward: false, tabs: [],
    viewport: null, problems: { errors: 0, warnings: 0 }, zoomLevel: 0, lastActivityAt,
  }],
});

test('the Browser pane publishes fresh last-use times to Work Status without a material version change', async () => {
  let lastActivityAt = 60_000;
  const server = await serveTestHttp((_request, response) => {
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({ status: 200, body: JSON.stringify(snapshot(lastActivityAt)) }));
  });
  const previousResolver = getRuntimeUrlResolver();
  const previousSession = useSessionUIStore.getState().currentSessionId;
  const dom = installHookTestDom();
  const root = createRoot(dom.container);
  let shown: ReturnType<typeof useServerBrowserConnection> | null = null;
  const Probe = () => {
    shown = useServerBrowserConnection(GUEST, DIRECTORY, undefined, false);
    return null;
  };
  const connection = () => {
    if (!shown) throw new Error('The Browser connection did not mount');
    return shown;
  };
  try {
    configureRuntimeUrlResolver({ apiBaseUrl: server.url.toString() });
    useSessionUIStore.setState({ currentSessionId: 'activity-session' });
    await act(async () => root.render(<Probe />));
    await act(async () => connection().refresh());

    lastActivityAt = 180_000;
    await act(async () => connection().refresh());

    const published = publishedServerBrowserState(useServerBrowserSharedState.getState(), GUEST, getRuntimeKey());
    expect(monitoredBrowsers(published, DIRECTORY)[0]?.lastActiveMinute).toBe(180_000);
  } finally {
    await act(async () => root.unmount());
    useServerBrowserSharedState.getState().clear(GUEST);
    useSessionUIStore.setState({ currentSessionId: previousSession });
    setRuntimeUrlResolver(previousResolver);
    dom.restore();
    server.close();
  }
});
