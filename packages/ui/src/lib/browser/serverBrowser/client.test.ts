import { describe, expect, mock, test } from 'bun:test';

const proxied: Array<{ guestId: string; request: unknown; viewerId: string | undefined }> = [];
let nextResponse: { ok: true; result: { status: number; body: string } } | { ok: false; code: string; message: string } = {
  ok: true,
  result: { status: 200, body: JSON.stringify({ scopes: [], controller: 'none', viewerInControl: false, selectedScopeId: null, generation: 0, help: null, chrome: { status: 'ready', message: '' } }) },
};

mock.module('@/lib/guests/service', () => ({
  proxyGuestServiceRequest: mock(async (guestId: string, request: unknown, viewerId: string | undefined) => {
    proxied.push({ guestId, request, viewerId });
    return nextResponse;
  }),
}));

const {
  getServerBrowserMemory,
  getServerBrowserState,
  navigateServerBrowser,
  parseServerBrowserState,
  serverBrowserMemorySchema,
  setServerBrowserDevTools,
} = await import('./client');

describe('server browser client', () => {
  test('reads state and attaches the viewer id to the proxied request', async () => {
    proxied.length = 0;
    const result = await getServerBrowserState('openchamber-builtin-server-browser', 'viewer-1');
    expect(result.ok).toBe(true);
    expect(proxied).toHaveLength(1);
    expect(proxied[0]?.guestId).toBe('openchamber-builtin-server-browser');
    expect(proxied[0]?.viewerId).toBe('viewer-1');
    expect(proxied[0]?.request).toMatchObject({ method: 'GET', path: '/browser/state' });
  });

  test('sends the body and reports the server error on a non-2xx status', async () => {
    nextResponse = { ok: true, result: { status: 409, body: JSON.stringify({ ok: false, error: 'The browser view changed before the dock command ran' }) } };
    const result = await navigateServerBrowser('guest', 'viewer-1', { url: 'https://example.com', generation: 3 });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe('The browser view changed before the dock command ran');
      expect(result.status).toBe(409);
    }
  });

  test('reports a transport failure from the host proxy', async () => {
    nextResponse = { ok: false, code: 'HOST_UNAVAILABLE', message: 'Request failed.' };
    const result = await getServerBrowserState('guest', undefined);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe('Request failed.');
  });

  test('parseServerBrowserState rejects a value with no scopes array', () => {
    expect(parseServerBrowserState({ foo: 'bar' })).toBeNull();
    expect(parseServerBrowserState(null)).toBeNull();
    expect(parseServerBrowserState({ scopes: [] })).not.toBeNull();
  });

  test('a memory reading keeps measured browsers and leaves out the ones the service could not measure', () => {
    const memory = serverBrowserMemorySchema.parse({
      sampledAt: 1_700_000_000_000,
      scopes: [
        { scopeId: 'measured', memoryBytes: 734_003_200 },
        { scopeId: 'unmeasured', memoryBytes: null },
        { scopeId: 'zero', memoryBytes: 0 },
        { scopeId: 'text', memoryBytes: '12' },
        { memoryBytes: 5 },
      ],
    });
    expect(memory.sampledAt).toBe(1_700_000_000_000);
    expect([...memory.bytesByScope]).toEqual([['measured', 734_003_200]]);
  });

  test('a reply that is no memory reading is refused', () => {
    expect(serverBrowserMemorySchema.safeParse({ ok: false, error: 'not-found' }).success).toBe(false);
    expect(serverBrowserMemorySchema.safeParse({ scopes: [] }).success).toBe(false);
    expect(serverBrowserMemorySchema.safeParse(null).success).toBe(false);
  });

  test('reads memory from its own route and reports a provider that lacks it by status', async () => {
    proxied.length = 0;
    nextResponse = { ok: true, result: { status: 200, body: JSON.stringify({ sampledAt: 5, scopes: [{ scopeId: 'a', memoryBytes: 2048 }] }) } };
    const measured = await getServerBrowserMemory('guest', 'viewer-1');
    expect(proxied[0]?.request).toEqual({ method: 'GET', path: '/browser/memory' });
    expect(measured.ok && measured.data.bytesByScope.get('a')).toBe(2048);

    nextResponse = { ok: true, result: { status: 404, body: JSON.stringify({ ok: false, error: 'not-found' }) } };
    const missing = await getServerBrowserMemory('guest', 'viewer-1');
    expect(missing).toMatchObject({ ok: false, status: 404 });
  });

  test('DevTools sends only open and the generation, which is all the service accepts', async () => {
    proxied.length = 0;
    nextResponse = { ok: true, result: { status: 200, body: JSON.stringify({ scopes: [{ id: 's', devtools: true }], generation: 8 }) } };
    const result = await setServerBrowserDevTools('guest', 'viewer-1', { open: true, generation: 7 });
    expect(proxied[0]?.request).toEqual({ method: 'POST', path: '/browser/devtools', body: JSON.stringify({ open: true, generation: 7 }) });
    expect(result.ok && result.data.scopes[0]?.devtools).toBe(true);
  });
});
