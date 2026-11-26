// allow: SIZE_OK: One HTTP connection ownership suite shares runtime, DOM and held-response fixtures.
import { act } from 'react';
import { expect, test } from 'bun:test';
import { createRoot } from 'react-dom/client';
import type { ServerResponse } from 'node:http';
import { z } from 'zod';
import { installHookTestDom } from '@/components/session/sidebar/test-utils/testDom';
import { configureRuntimeUrlResolver, getRuntimeUrlResolver, setRuntimeUrlResolver } from '@/lib/runtime-url';
import { getRuntimeApiBaseUrl, getRuntimeKey, switchRuntimeEndpoint } from '@/lib/runtime-switch';
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

for (const retirement of ['runtime switch', 'unmount'] as const) {
  for (const operation of ['navigate', 'refresh', 'viewer', 'retry'] as const) {
    test(`a held ${operation} cannot publish or retry after ${retirement}`, async () => {
      const previousRuntime = { apiBaseUrl: getRuntimeApiBaseUrl(), runtimeKey: getRuntimeKey() };
      const previousResolver = getRuntimeUrlResolver();
      const previousSession = useSessionUIStore.getState().currentSessionId;
      const dom = installHookTestDom();
      const root = createRoot(dom.container);
      let receiveHeld: (response: ServerResponse) => void = () => { throw new Error('Held response barrier is not initialized'); };
      const held = new Promise<ServerResponse>((resolve) => { receiveHeld = resolve; });
      let receiveConsumed: () => void = () => { throw new Error('Body consumption barrier is not initialized'); };
      const consumed = new Promise<void>((resolve) => { receiveConsumed = resolve; });
      const originalFetch = globalThis.fetch;
      // Observe consumption of the real HTTP body. The viewer effect has no public promise.
      globalThis.fetch = Object.assign(async (...args: Parameters<typeof fetch>) => {
        const response = await originalFetch(...args);
        if (response.headers.has('x-held-response')) {
          const json = response.json.bind(response);
          response.json = async () => {
            try { return await json(); }
            finally { setImmediate(receiveConsumed); }
          };
        }
        return response;
      }, originalFetch);
      let holdNext = false;
      const requests: string[] = [];
      const requestSchema = z.object({ path: z.string() });
      const serverA = await serveTestHttp(async (request, response) => {
        if (!request.url?.endsWith('/service/request')) { response.writeHead(404).end(); return; }
        let body = '';
        for await (const chunk of request) body += String(chunk);
        const { path } = requestSchema.parse(JSON.parse(body));
        requests.push(path);
        response.setHeader('Content-Type', 'application/json');
        if (holdNext && path === (operation === 'viewer' ? '/browser/viewer' : operation === 'refresh' ? '/browser/state' : '/browser/navigate')) {
          holdNext = false;
          response.setHeader('x-held-response', 'true');
          receiveHeld(response);
          return;
        }
        response.end(JSON.stringify({ status: 200, body: JSON.stringify(snapshot(60_000)) }));
      });
      const requestsB: string[] = [];
      const serverB = await serveTestHttp(async (request, response) => {
        if (!request.url?.endsWith('/service/request')) { response.writeHead(404).end(); return; }
        let body = '';
        for await (const chunk of request) body += String(chunk);
        requestsB.push(requestSchema.parse(JSON.parse(body)).path);
        response.end(JSON.stringify({ status: 200, body: JSON.stringify({ ...snapshot(240_000), generation: 2 }) }));
      });
      let shown: ReturnType<typeof useServerBrowserConnection> | null = null;
      const Probe = ({ viewer = false, enabled = viewer }: { viewer?: boolean; enabled?: boolean }) => {
        shown = useServerBrowserConnection(GUEST, DIRECTORY, viewer ? 'held-viewer' : undefined, enabled);
        return null;
      };
      const connection = () => {
        if (!shown) throw new Error('The Browser connection did not mount');
        return shown;
      };
      let pending: Promise<ServerBrowserState | null | void> = Promise.resolve();
      try {
        switchRuntimeEndpoint({ apiBaseUrl: serverA.url.toString(), runtimeKey: 'connection-a' });
        await act(async () => root.render(<Probe />));
        await act(async () => connection().refresh());
        const original = connection();
        holdNext = true;
        await act(async () => {
          if (operation === 'viewer') root.render(<Probe viewer />);
          else pending = operation === 'refresh' ? original.refresh() : original.navigate('https://example.com/held');
        });
        const response = await held;
        await act(async () => {
          if (retirement === 'runtime switch') {
            switchRuntimeEndpoint({ apiBaseUrl: serverB.url.toString(), runtimeKey: 'connection-b' });
            // Keep the viewer identity but stop live polling, so only the held callback can reach B.
            if (operation === 'viewer') root.render(<Probe viewer enabled={false} />);
          }
          else root.render(null);
        });
        const current = snapshot(180_000);
        useServerBrowserSharedState.getState().publish(GUEST, getRuntimeKey(), current);
        const requestCount = requests.length;
        let result: ServerBrowserState | null | void = undefined;
        await act(async () => {
          response.end(JSON.stringify(operation === 'retry'
            ? { status: 409, body: JSON.stringify({ error: 'The browser view changed before the dock command ran' }) }
            : { status: 200, body: JSON.stringify(snapshot(300_000)) }));
          result = await pending;
          await consumed;
        });
        expect(monitoredBrowsers(publishedServerBrowserState(useServerBrowserSharedState.getState(), GUEST, getRuntimeKey()), DIRECTORY)[0]?.lastActiveMinute).toBe(180_000);
        await act(async () => {
          await original.refresh();
          expect(await original.navigate('https://example.com/retired')).toBeNull();
        });
        expect(requestsB).toEqual([]);
        expect(requests.slice(requestCount)).toEqual([]);
        if (operation === 'navigate' || operation === 'retry') expect(result).toBeNull();
      } finally {
        holdNext = false;
        serverA.close();
        serverB.close();
        await pending;
        await act(async () => root.unmount());
        useServerBrowserSharedState.getState().clear(GUEST);
        useSessionUIStore.setState({ currentSessionId: previousSession });
        switchRuntimeEndpoint(previousRuntime);
        setRuntimeUrlResolver(previousResolver);
        globalThis.fetch = originalFetch;
        dom.restore();
      }
    });
  }
}

for (const { name, viewId, sessionId, operation, retries } of [
  { name: 'another chat', viewId: 'other-chat-view', sessionId: 'other-session', operation: 'navigate', retries: false },
  { name: 'another Chrome tab', viewId: 'other-tab-view', sessionId: 'activity-session', operation: 'navigate', retries: false },
  { name: 'a newer generation of the original view', viewId: 'activity-view', sessionId: 'activity-session', operation: 'navigate', retries: true },
  { name: 'an explicitly selected tab across views', viewId: 'other-tab-view', sessionId: 'activity-session', operation: 'selectTab', retries: true },
  { name: 'another chat', viewId: 'other-chat-view', sessionId: 'other-session', operation: 'devtools', retries: false },
  { name: 'another Chrome tab', viewId: 'other-tab-view', sessionId: 'activity-session', operation: 'devtools', retries: false },
  { name: 'a newer generation of the original view', viewId: 'activity-view', sessionId: 'activity-session', operation: 'devtools', retries: true },
  { name: 'another chat', viewId: 'other-chat-view', sessionId: 'other-session', operation: 'back', retries: false },
  { name: 'a newer generation of the original view', viewId: 'activity-view', sessionId: 'activity-session', operation: 'back', retries: true },
] as const) {
  test(`pending ${operation} preserves its target after ${name} is refreshed`, async () => {
    let current = snapshot(60_000);
    const commands: Array<{ generation: number; url?: string; tabId?: string; open?: boolean }> = [];
    let receiveFirstCommand: (response: ServerResponse) => void = () => { throw new Error('Command barrier is not initialized'); };
    const firstCommand = new Promise<ServerResponse>((resolve) => { receiveFirstCommand = resolve; });
    const requestSchema = z.object({ path: z.string(), body: z.string().optional() });
    const commandSchema = z.object({ generation: z.number(), url: z.string().optional(), tabId: z.string().optional(), open: z.boolean().optional() });
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
        const pending = {
          navigate: () => connection().navigate('https://example.com/requested-by-A'),
          selectTab: () => connection().selectTab('explicit-tab-A'),
          devtools: () => connection().setDevTools(true),
          back: () => connection().back(),
        }[operation]();
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

      const target = {
        navigate: { url: 'https://example.com/requested-by-A' },
        selectTab: { tabId: 'explicit-tab-A' },
        devtools: { open: true },
        back: {},
      }[operation];
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
