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
  getServerBrowserState,
  navigateServerBrowser,
  parseServerBrowserState,
} = await import('./client');

describe('server browser client', () => {
  test('reads state and attaches the viewer id to the proxied request', async () => {
    proxied.length = 0;
    const result = await getServerBrowserState('openchamber-builtin-server-browser', 'viewer-1');
    expect(result.ok).toBe(true);
    expect(proxied).toHaveLength(1);
    expect(proxied[0]?.guestId).toBe('openchamber-builtin-server-browser');
    expect(proxied[0]?.viewerId).toBe('viewer-1');
    expect((proxied[0]?.request as { method: string; path: string }).method).toBe('GET');
    expect((proxied[0]?.request as { method: string; path: string }).path).toBe('/browser/state');
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
});
