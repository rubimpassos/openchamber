import { describe, expect, test } from 'bun:test';
import { HostRequestError, type LoopbackRequestResult, type LoopbackUrlResult } from '@openchamber/sdk';
import { guestMessageSchema } from '@openchamber/sdk/schemas';
import { createRuntimeUrlResolver } from '@/lib/runtime-url';
import type { RuntimeFetchOptions } from '@/lib/runtime-fetch';
import { createGuestLoopback } from './loopback';
import type { InstalledGuest } from './types';

const failure = async (operation: Promise<LoopbackRequestResult | LoopbackUrlResult>): Promise<HostRequestError> => {
  try { await operation; }
  catch (error) {
    if (error instanceof HostRequestError) return error;
    throw error;
  }
  throw new Error('Expected a typed host refusal');
};

const setup = () => {
  let guest: InstalledGuest | null = {
    id: 'fixture', name: 'Fixture', icon: 'window',
    capabilities: { requested: ['loopback'], granted: ['loopback'] },
    loopback: { status: 'ready', port: 5678, resolvedPort: 5678, routes: [
      { path: '/state/*', methods: ['GET', 'HEAD'] }, { path: '/toggle', methods: ['POST'] },
    ] },
  };
  let key = 'runtime-a';
  let current = true;
  let serial = 0;
  const calls: Array<{ path: string; options?: RuntimeFetchOptions }> = [];
  const minted: string[] = [];
  const owner = {
    guestId: 'fixture', currentGuest: () => guest, isCurrent: () => current,
    signal: new AbortController().signal, transport: 'url' as const,
  };
  const runtime: NonNullable<Parameters<typeof createGuestLoopback>[1]> = {
    key: () => key,
    resolver: () => createRuntimeUrlResolver({ apiBaseUrl: 'https://runtime.test' }),
    mint: async (id) => { minted.push(id); return { token: `scoped-${++serial}`, expiresAt: 100_000 }; },
    fetch: async (path, options) => { calls.push({ path: String(path), options }); return new Response('ok', { status: 202 }); },
  };
  return { owner, runtime, calls, minted,
    revoke: () => { if (guest) guest = { ...guest, capabilities: { requested: ['loopback'], granted: [] } }; },
    replaceGuest: () => { if (guest) guest = { ...guest, id: 'other' }; },
    switchRuntime: () => { key = 'runtime-b'; }, retire: () => { current = false; },
  };
};

describe('bound guest loopback', () => {
  test('mints fresh own-guest GET URLs when the route is approved', async () => {
    // Given
    const fixture = setup();
    const client = createGuestLoopback(fixture.owner, fixture.runtime);
    // When
    const urls = await Promise.all([client.loopbackUrl({ path: '/state/a%20b', query: { locale: 'pt-BR' } }),
      client.loopbackUrl({ path: '/state/a%20b' })]);
    // Then
    expect(urls[0]).toEqual({ url: 'https://runtime.test/api/guests/fixture/loopback/state/a%20b?locale=pt-BR&oc_url_token=scoped-1', expiresAt: 100_000 });
    expect(urls[1]?.url).toContain('oc_url_token=scoped-2');
    expect(fixture.minted).toEqual(['fixture', 'fixture']);
  });

  for (const operation of ['loopbackUrl', 'loopbackRequest'] as const) {
    test(`${operation} refuses before transport when approval is absent`, async () => {
      // Given
      const fixture = setup();
      fixture.revoke();
      const client = createGuestLoopback(fixture.owner, fixture.runtime);
      // When / Then
      expect(await failure(client[operation]({ path: '/state/x', method: 'GET' }))).toMatchObject({ code: 'NOT_GRANTED' });
      expect(fixture.calls).toHaveLength(0);
      expect(fixture.minted).toHaveLength(0);
    });

    for (const change of ['revoke', 'switchRuntime', 'retire'] as const) {
      test(`${operation} discards completion when ${change} occurs during transport`, async () => {
        // Given
        const fixture = setup();
        const client = createGuestLoopback(fixture.owner, { ...fixture.runtime,
          mint: async () => { fixture[change](); return { token: 'retired', expiresAt: 100_000 }; },
          fetch: async () => { fixture[change](); return new Response('retired'); },
        });
        // When / Then
        expect(await failure(client[operation]({ path: '/state/x', method: 'GET' }))).toMatchObject({
          code: change === 'revoke' ? 'NOT_GRANTED' : 'HOST_UNAVAILABLE',
        });
      });
    }
  }

  test('refuses another guest returned by the owner without sending a request', async () => {
    // Given
    const fixture = setup();
    fixture.replaceGuest();
    const client = createGuestLoopback(fixture.owner, fixture.runtime);
    // When / Then
    expect(await failure(client.loopbackRequest({ method: 'GET', path: '/state/x' }))).toMatchObject({ code: 'NOT_GRANTED' });
    expect(fixture.calls).toHaveLength(0);
  });

  test('refuses URL tokens when only POST is declared', async () => {
    // Given
    const fixture = setup();
    const client = createGuestLoopback(fixture.owner, fixture.runtime);
    // When / Then
    expect(await failure(client.loopbackUrl({ path: '/toggle' }))).toMatchObject({ code: 'NOT_GRANTED' });
    expect(fixture.minted).toHaveLength(0);
  });

  test('refuses direct URLs when the frame is a relay document', async () => {
    // Given
    const fixture = setup();
    const client = createGuestLoopback({ ...fixture.owner, transport: 'document' }, fixture.runtime);
    // When / Then
    expect(await failure(client.loopbackUrl({ path: '/state/x' }))).toMatchObject({ code: 'UNSUPPORTED' });
    expect(fixture.minted).toHaveLength(0);
  });

  test('sends JSON through the parent when a relay frame requests POST', async () => {
    // Given
    const fixture = setup();
    const client = createGuestLoopback({ ...fixture.owner, transport: 'document' }, fixture.runtime);
    // When
    const result = await client.loopbackRequest({ method: 'POST', path: '/toggle', body: { enabled: false } });
    // Then
    expect(result).toEqual({ status: 202, body: 'ok' });
    expect(fixture.calls[0]).toMatchObject({ path: '/api/guests/fixture/loopback/toggle', options: {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"enabled":false}',
    } });
  });

  for (const method of ['GET', 'HEAD'] as const) {
    test(`forwards ${method} without a body or guest headers`, async () => {
      // Given
      const fixture = setup();
      const client = createGuestLoopback(fixture.owner, fixture.runtime);
      // When
      await client.loopbackRequest({ method, path: '/state/x', query: { locale: 'en' } });
      // Then
      expect(fixture.calls[0]?.options).toMatchObject({ method, query: { locale: 'en' } });
      expect(fixture.calls[0]?.options?.body).toBeUndefined();
      expect(fixture.calls[0]?.options?.headers).toBeUndefined();
    });
  }

  test('preserves application error text when it is not a proxy refusal', async () => {
    // Given
    const fixture = setup();
    const client = createGuestLoopback(fixture.owner, { ...fixture.runtime, fetch: async () => new Response('not enabled', { status: 409 }) });
    // When / Then
    expect(await client.loopbackRequest({ method: 'POST', path: '/toggle' })).toEqual({ status: 409, body: 'not enabled' });
  });

  test('returns a typed refusal when the proxy rejects the grant', async () => {
    // Given
    const fixture = setup();
    const client = createGuestLoopback(fixture.owner, { ...fixture.runtime,
      fetch: async () => Response.json({ error: 'NOT_GRANTED', message: 'Refused' }, { status: 403 }),
    });
    // When / Then
    expect(await failure(client.loopbackRequest({ method: 'GET', path: '/state/x' }))).toMatchObject({ code: 'NOT_GRANTED' });
  });

  test('redacts transport exceptions when the runtime request fails', async () => {
    // Given
    const fixture = setup();
    const client = createGuestLoopback(fixture.owner, { ...fixture.runtime, fetch: async () => { throw new TypeError('secret'); } });
    // When / Then
    expect(await failure(client.loopbackRequest({ method: 'GET', path: '/state/x' }))).toMatchObject({ code: 'DISCONNECTED', message: 'Loopback transport failed.' });
  });

  test('rejects guest-selected identity and headers at SDK admission', () => {
    // Given
    const message = { channel: 'openchamber.sdk', v: 1, type: 'loopback-request', id: 'x',
      payload: { method: 'GET', path: '/state/x', guestId: 'other', headers: { Authorization: 'stolen' } } };
    // When / Then
    expect(guestMessageSchema.safeParse(message).success).toBe(false);
  });

  test('discards response text when approval is revoked while reading the body', async () => {
    // Given
    const fixture = setup();
    const client = createGuestLoopback(fixture.owner, { ...fixture.runtime,
      fetch: async () => new Response(new ReadableStream<Uint8Array>({
        pull: (controller) => { fixture.revoke(); controller.enqueue(new TextEncoder().encode('private')); controller.close(); },
      }, { highWaterMark: 0 })),
    });
    // When / Then
    expect(await failure(client.loopbackRequest({ method: 'GET', path: '/state/x' }))).toMatchObject({ code: 'NOT_GRANTED' });
  });
});
