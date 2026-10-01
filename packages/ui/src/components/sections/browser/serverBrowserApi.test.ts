import { describe, expect, mock, test } from 'bun:test';

type GuestRequest = { method: string; path: string; query?: Record<string, string>; body?: string };
type ProxyResult =
  | { ok: true; result: { status: number; body: string } }
  | { ok: false; code: string; message: string };

const calls: GuestRequest[] = [];
let nextResult: ProxyResult = { ok: true, result: { status: 200, body: '{}' } };

mock.module('@/lib/guests/service', () => ({
  proxyGuestServiceRequest: async (_guestId: string, request: GuestRequest) => {
    calls.push(request);
    return nextResult;
  },
}));

const {
  SERVER_BROWSER_GUEST_ID,
  getBrowserState,
  getChromeStatus,
  createProfile,
  revokeAllProfiles,
  getProfileSites,
  isServerBrowserUnavailable,
  isDockAccessError,
  isStaleProfileError,
} = await import('./serverBrowserApi');

describe('serverBrowserApi', () => {
  test('exposes the built-in extension id from the contract', () => {
    expect(SERVER_BROWSER_GUEST_ID).toBe('openchamber-builtin-server-browser');
  });

  test('getBrowserState parses a 200 JSON body into value', async () => {
    nextResult = { ok: true, result: { status: 200, body: JSON.stringify({ generation: 3, scopes: [] }) } };
    const result = await getBrowserState();
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.generation).toBe(3);
    }
    expect(calls.at(-1)).toMatchObject({ method: 'GET', path: '/browser/state' });
  });

  test('a host-proxy failure (extension not installed) reports kind "unavailable"', async () => {
    nextResult = { ok: false, code: 'NO_SERVICE', message: 'No service for this extension.' };
    const result = await getChromeStatus();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.kind).toBe('unavailable');
      expect(isServerBrowserUnavailable(result)).toBe(true);
    }
  });

  test('a non-2xx response from the service reports kind "http" with the error message', async () => {
    nextResult = { ok: true, result: { status: 400, body: JSON.stringify({ error: 'A profile named "Work" already exists' }) } };
    const result = await createProfile('Work');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.kind).toBe('http');
      expect(result.message).toContain('already exists');
      expect(isServerBrowserUnavailable(result)).toBe(false);
    }
    expect(calls.at(-1)).toMatchObject({ method: 'POST', path: '/profiles/create', body: JSON.stringify({ name: 'Work' }) });
  });

  test('revokeAllProfiles sends the literal confirmation the service expects', async () => {
    nextResult = { ok: true, result: { status: 200, body: JSON.stringify({ ok: true, profiles: [], state: {} }) } };
    await revokeAllProfiles();
    expect(calls.at(-1)).toMatchObject({ method: 'POST', path: '/profiles/revoke-all', body: JSON.stringify({ confirm: 'REVOKE' }) });
  });

  test('getProfileSites sends the profile id as a query param, not in the path', async () => {
    nextResult = { ok: true, result: { status: 200, body: JSON.stringify({ ok: true, sites: [] }) } };
    await getProfileSites('abc123');
    expect(calls.at(-1)).toMatchObject({ method: 'GET', path: '/profiles/sites', query: { id: 'abc123' } });
  });

  test('isDockAccessError matches the shared-surface busy message', () => {
    expect(isDockAccessError('Dock controls are available only while the shared surface is idle or to the viewer in control')).toBe(true);
    expect(isDockAccessError('That profile no longer exists')).toBe(false);
  });

  test('isStaleProfileError matches a save refused over a newer version', () => {
    expect(isStaleProfileError('An agent saved this profile while you were signing in, so your sign-in was not saved over it.')).toBe(true);
    expect(isStaleProfileError('Could not save the sign-in.')).toBe(false);
  });
});
