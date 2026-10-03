import { describe, expect, test } from 'bun:test';

import { effectiveGrants, guestGrantScope, sameCredentialTarget } from './grant-scope.js';

const guest = {
  filesystem: ['~/notes/**', '~/.config/opencode/opencode.json'],
  integration: {
    name: 'Acme',
    description: 'Tasks',
    token: { apiOrigin: 'https://api.acme.example' },
  },
  service: {
    entry: 'service/main.js',
    runtime: 'host',
    permissions: { exec: ['docker'], sockets: [{ id: 'docker', candidatesByPlatform: {} }] },
  },
};

describe('loopback approval scope', () => {
  const loopback = { port: 8123, routes: [{ path: '/state', methods: ['GET', 'HEAD'] }, { path: '/sessions/*', methods: ['POST'] }] };

  test.each([
    ['port', { ...loopback, port: 8124 }],
    ['env', { ...loopback, env: 'OC_SCOPE_TEST_PORT' }],
    ['path', { ...loopback, routes: [{ path: '/other', methods: ['GET'] }] }],
    ['method', { ...loopback, routes: [{ path: '/state', methods: ['POST'] }] }],
    ['removal', undefined],
  ])('drops loopback when the %s changes', (_name, changed) => {
    // Given an approval for a different target or allowlist.
    const approved = guestGrantScope({ loopback });
    // When evaluating the changed declaration.
    const granted = effectiveGrants(['prompt', 'loopback'], approved, guestGrantScope({ loopback: changed }));
    // Then unrelated grants survive, but loopback does not.
    expect(granted).toEqual(['prompt']);
  });

  test('keeps loopback when only version and declaration order change', () => {
    // Given the original target and permissions.
    const approved = guestGrantScope({ loopback });
    const reordered = { ...loopback, routes: [...loopback.routes].reverse().map((route) => ({ ...route, methods: [...route.methods].reverse() })) };
    // When a newer version requests identical permissions.
    const granted = effectiveGrants(['loopback'], approved, guestGrantScope({ version: '2.0.0', loopback: reordered }));
    // Then approval still holds.
    expect(granted).toEqual(['loopback']);
  });

  test('drops loopback when the stored approval has no scope', () => {
    // Given a pre-scope approval.
    const current = guestGrantScope({ loopback });
    // When evaluating the old store.
    const granted = effectiveGrants(['loopback'], undefined, current);
    // Then no target has been approved.
    expect(granted).toEqual([]);
  });
});

describe('guestGrantScope', () => {
  test('captures sorted patterns, the API origin, and service permissions', () => {
    expect(guestGrantScope(guest)).toEqual({
      filesystem: ['~/.config/opencode/opencode.json', '~/notes/**'],
      apiOrigin: 'https://api.acme.example',
      service: { exec: ['docker'], sockets: ['docker'] },
    });
    expect(guestGrantScope({})).toEqual({});
    expect(guestGrantScope({ integration: { name: 'L', description: 'x', host: { provider: 'linear' } } }))
      .toEqual({ apiOrigin: 'https://api.linear.app' });
  });
});

describe('effectiveGrants', () => {
  const granted = ['prompt', 'filesystem', 'network', 'service'];

  test('keeps every grant while the scope is what the user approved', () => {
    const scope = guestGrantScope(guest);
    expect(effectiveGrants(granted, scope, scope)).toEqual(granted);
  });

  test('drops a scoped grant when the package widened it', () => {
    const approved = guestGrantScope(guest);
    const wider = guestGrantScope({ ...guest, filesystem: ['~/**'] });
    expect(effectiveGrants(granted, approved, wider)).toEqual(['prompt', 'network', 'service']);
    const moved = guestGrantScope({ ...guest, integration: { ...guest.integration, token: { apiOrigin: 'https://evil.example' } } });
    expect(effectiveGrants(granted, approved, moved)).toEqual(['prompt', 'filesystem', 'service']);
    const moreExec = guestGrantScope({ ...guest, service: { ...guest.service, permissions: { exec: ['docker', 'kubectl'], sockets: guest.service.permissions.sockets } } });
    expect(effectiveGrants(granted, approved, moreExec)).toEqual(['prompt', 'filesystem', 'network']);
  });

  test('an origin added in an update is not approved until the user approves the new list', () => {
    const approved = guestGrantScope({ origins: ['https://fonts.example.com'] });
    expect(approved).toEqual({ origins: ['https://fonts.example.com'] });
    expect(effectiveGrants(['origins'], approved, guestGrantScope({ origins: ['https://fonts.example.com'] }))).toEqual(['origins']);
    const added = guestGrantScope({ origins: ['https://fonts.example.com', 'https://collect.example.net'] });
    expect(effectiveGrants(['origins'], approved, added)).toEqual([]);
    expect(effectiveGrants(['origins'], undefined, approved)).toEqual([]);
  });

  test('never counts a scoped grant without a recorded scope', () => {
    expect(effectiveGrants(granted, undefined, guestGrantScope(guest))).toEqual(['prompt']);
  });
});

describe('oauth endpoints', () => {
  const oauthGuest = {
    integration: {
      name: 'Acme',
      description: 'Tasks',
      oauth: { authorizeUrl: 'https://acme.example/authorize', tokenUrl: 'https://acme.example/token', apiOrigin: 'https://api.acme.example' },
    },
  };

  test('a moved token endpoint drops the network grant and the credentials', () => {
    const approved = guestGrantScope(oauthGuest);
    expect(approved).toEqual({
      apiOrigin: 'https://api.acme.example',
      oauth: { authorizeUrl: 'https://acme.example/authorize', tokenUrl: 'https://acme.example/token' },
    });
    const moved = guestGrantScope({ integration: { ...oauthGuest.integration, oauth: { ...oauthGuest.integration.oauth, tokenUrl: 'https://evil.example/token' } } });
    expect(effectiveGrants(['network'], approved, moved)).toEqual([]);
    expect(sameCredentialTarget(approved, moved)).toBe(false);
    expect(sameCredentialTarget(approved, guestGrantScope(oauthGuest))).toBe(true);
  });
});
