import { act } from 'react';
import { expect, test } from 'bun:test';
import { createRoot } from 'react-dom/client';
import type { ServerResponse } from 'node:http';
import { z } from 'zod';
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

for (const { name, viewId, sessionId, operation, retries } of [
  { name: 'another chat', viewId: 'other-chat-view', sessionId: 'other-session', operation: 'navigate', retries: false },
  { name: 'another Chrome tab', viewId: 'other-tab-view', sessionId: 'activity-session', operation: 'navigate', retries: false },
  { name: 'a newer generation of the original view', viewId: 'activity-view', sessionId: 'activity-session', operation: 'navigate', retries: true },
  { name: 'an explicitly selected tab across views', viewId: 'other-tab-view', sessionId: 'activity-session', operation: 'selectTab', retries: true },
] as const) {
  test(`a pending command preserves its target after ${name} is refreshed`, async () => {
    let current = snapshot(60_000);
    const commands: Array<{ generation: number; url?: string; tabId?: string }> = [];
    let receiveFirstCommand: (response: ServerResponse) => void = () => { throw new Error('Command barrier is not initialized'); };
    const firstCommand = new Promise<ServerResponse>((resolve) => { receiveFirstCommand = resolve; });
    const requestSchema = z.object({ path: z.string(), body: z.string().optional() });
    const commandSchema = z.object({ generation: z.number(), url: z.string().optional(), tabId: z.string().optional() });
    const server = await serveTestHttp((request, response) => {
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => {
        const proxied = requestSchema.parse(JSON.parse(Buffer.concat(chunks).toString()));
        response.setHeader('Content-Type', 'application/json');
        if (proxied.path !== '/browser/state') {
          commands.push(commandSchema.parse(JSON.parse(proxied.body ?? '{}')));
          if (commands.length === 1) {
            receiveFirstCommand(response);
            return;
          }
        }
        response.end(JSON.stringify({ status: 200, body: JSON.stringify(current) }));
      });
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

      let result: ServerBrowserState | null = null;
      await act(async () => {
        const pending = operation === 'navigate'
          ? connection().navigate('https://example.com/requested-by-A')
          : connection().selectTab('explicit-tab-A');
        const response = await firstCommand;
        current = {
          ...current, generation: 2, version: 'next-material-version', viewId,
          scopes: current.scopes.map((scope) => ({ ...scope, sessionId })),
        };
        response.end(JSON.stringify({
          status: 409,
          body: JSON.stringify({ error: 'The browser view changed before the dock command ran' }),
        }));
        result = await pending;
      });

      const target = operation === 'navigate'
        ? { url: 'https://example.com/requested-by-A' }
        : { tabId: 'explicit-tab-A' };
      expect(commands).toEqual(retries
        ? [{ ...target, generation: 1 }, { ...target, generation: 2 }]
        : [{ ...target, generation: 1 }]);
      expect(result).toEqual(retries ? current : null);
    } finally {
      await act(async () => root.unmount());
      useServerBrowserSharedState.getState().clear(GUEST);
      useSessionUIStore.setState({ currentSessionId: previousSession });
      setRuntimeUrlResolver(previousResolver);
      dom.restore();
      server.close();
    }
  });
}

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
