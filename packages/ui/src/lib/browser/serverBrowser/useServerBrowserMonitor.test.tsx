import React, { act } from 'react';
import { afterEach, expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import { createRoot, type Root } from 'react-dom/client';
import { z } from 'zod';

import { getRuntimeApiBaseUrl, getRuntimeKey, switchRuntimeEndpoint } from '@/lib/runtime-switch';
import { serveTestHttp } from '@/lib/test-http-server';
import { useServerBrowserMonitor, type ServerBrowserMonitorView } from './useServerBrowserMonitor';

let root: Root | null = null;
let shown: ServerBrowserMonitorView | null = null;
const Monitor = ({ provider }: { provider: string }) => {
  shown = useServerBrowserMonitor(provider, '/project', true);
  return null;
};
const commandSchema = z.object({ path: z.string() });
const readShown = (): ServerBrowserMonitorView => {
  if (!shown) throw new Error('Monitor did not mount');
  return shown;
};

afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  shown = null;
});

for (const change of ['provider', 'runtime']) {
  test(`a pending confirmation cannot close a browser after the ${change} changes`, async () => {
    const previousRuntime = { apiBaseUrl: getRuntimeApiBaseUrl(), runtimeKey: getRuntimeKey() };
    const globals = ['window', 'document', 'CustomEvent', 'IS_REACT_ACT_ENVIRONMENT'];
    const descriptors = globals.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);
    const closes: string[] = [];
    const state = { generation: 1, viewId: null, controller: 'none', scopes: [], selectedScopeId: null, help: null, chrome: { status: 'ready' } };
    const server = await serveTestHttp(async (request, response) => {
      response.setHeader('Content-Type', 'application/json');
      if (request.url?.endsWith('/service/status')) {
        response.end(JSON.stringify({ status: 'stopped' }));
        return;
      }
      if (!request.url?.endsWith('/service/request') || request.method !== 'POST') {
        response.writeHead(404).end();
        return;
      }
      let body = '';
      for await (const chunk of request) body += String(chunk);
      const command = commandSchema.parse(JSON.parse(body));
      if (command.path === '/browser/close-scope') closes.push(request.url);
      response.end(JSON.stringify({ status: 200, body: JSON.stringify(state) }));
    });
    const win = new Window({ url: server.url.toString() });
    for (const [key, value] of Object.entries({
      window: win, document: win.document, CustomEvent: win.CustomEvent, IS_REACT_ACT_ENVIRONMENT: true,
    })) {
      Object.defineProperty(globalThis, key, { configurable: true, value });
    }
    try {
      switchRuntimeEndpoint({ apiBaseUrl: server.url.toString(), runtimeKey: 'monitor-a' });
      root = createRoot(document.createElement('div'));
      await act(async () => root?.render(<React.StrictMode><Monitor provider="browser-a" /></React.StrictMode>));
      const original = readShown();

      await act(async () => {
        if (change === 'runtime') switchRuntimeEndpoint({ apiBaseUrl: server.url.toString(), runtimeKey: 'monitor-b' });
        else root?.render(<React.StrictMode><Monitor provider="browser-b" /></React.StrictMode>);
      });
      const result = await original.close('scope');

      expect(result).toMatchObject({ ok: false });
      expect(closes).toEqual([]);
      const current = readShown();
      await act(async () => { expect((await current.close('scope')).ok).toBe(true); });
      expect(closes).toHaveLength(1);
    } finally {
      await act(async () => root?.unmount());
      root = null;
      switchRuntimeEndpoint(previousRuntime);
      for (const [key, descriptor] of descriptors) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else Reflect.deleteProperty(globalThis, key);
      }
      server.close();
    }
  });
}
