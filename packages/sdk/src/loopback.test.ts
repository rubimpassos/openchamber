import { describe, expect, test } from 'bun:test';
import { canonicalizeLoopbackPath, canonicalizeLoopbackRoutePath, matchLoopbackRoute, type LoopbackContribution } from './loopback.ts';
import { requestedGuestCapabilities } from './manifest.ts';
import { loopbackContributionSchema } from './loopback-schemas.ts';
import { parseManifestJson } from './parse.ts';

const loopback: LoopbackContribution = {
  port: 4517, env: 'PLUGIN_PORT',
  routes: [{ path: '/sessions/*', methods: ['GET', 'HEAD'] }, { path: '/sessions/*/enabled', methods: ['POST'] }],
};
const panel = { id: 'fixture', name: 'Fixture', icon: 'window', entry: 'panel/index.html' };

describe('loopback paths', () => {
  test.each([
    ['/', '/'], ['/panel/events', '/panel/events'], ['/sessions/a%20b', '/sessions/a%20b'],
    ['/sessions/%61', '/sessions/a'], ['/sessions/caf%c3%a9', '/sessions/caf%C3%A9'],
    ['/sessions/café', '/sessions/caf%C3%A9'], ['/sessions/a.b', '/sessions/a.b'],
    ['/sessions/a:b', '/sessions/a%3Ab'], ['/sessions/a+b', '/sessions/a%2Bb'],
  ])('canonicalizes %s when every segment is safe', (input, expected) => {
    // Given a path supplied independently of a query.
    // When decoded once and encoded canonically.
    const path = canonicalizeLoopbackPath(input);
    // Then the forwardable path has one stable spelling.
    expect(path).toBe(expected);
  });

  test.each([
    '', 'relative', 'https://example.com/x', '//example.com/x', '/a//b', '/a/', '/a\\b',
    '/a?x=1', '/a#hash', '/a\0b', '/a\nb', '/a\u007fb', '/a\u0085b', '/.', '/..', '/a/../b',
    '/a/./b', '/%2e', '/%2E%2e', '/a/.%2e/b', '/%2f', '/%2Fadmin', '/%5c', '/%00', '/%0A',
    '/%7f', '/%3f', '/%23', '/%252e%252e', '/%252f', '/%25', '/%', '/%GG', '/%C0%AF',
    '/%ED%A0%80', '/\ud800', '/a/*', '/a/a*', '/a/**', '/%2a', `/${'x'.repeat(256)}`,
  ])('rejects %j when the request path could change meaning', (input) => {
    // Given a hostile or malformed pathname.
    // When admitted without URL normalization.
    const path = canonicalizeLoopbackPath(input);
    // Then no path can be forwarded.
    expect(path).toBeNull();
  });

  test.each(['/sessions/**', '/sessions/a*', '/sessions/%2a', '/sessions/*?x=1'])('rejects %s when a declaration is not a segment wildcard', (path) => {
    // Given a glob other than a whole literal '*'.
    // When parsed as a route.
    const parsed = canonicalizeLoopbackRoutePath(path);
    // Then it cannot widen permission.
    expect(parsed).toBeNull();
  });

  test.each([
    ['/sessions/one', 'GET', '/sessions/one'], ['/sessions/%6fne', 'HEAD', '/sessions/one'],
    ['/sessions/one/enabled', 'POST', '/sessions/one/enabled'], ['/sessions', 'GET', null],
    ['/sessions/', 'GET', null], ['/sessions/one/two', 'GET', null], ['/sessions/one', 'POST', null],
    ['/sessions/one/enabled', 'GET', null], ['/sessions/%2f', 'GET', null],
  ] as const)('matches %s with %s only when depth and method are granted', (path, method, expected) => {
    // Given the declared two-route grant.
    // When admission combines the verb and canonical pathname.
    const matched = matchLoopbackRoute(loopback.routes, path, method);
    // Then matching yields the exact path to forward, or a refusal.
    expect(matched).toBe(expected);
  });

  test('matches root only when explicitly declared', () => {
    // Given an exact root grant and a wildcard grant.
    const routes = [{ path: '/', methods: ['GET'] }, { path: '/*', methods: ['POST'] }] as const;
    // When requesting the root.
    const results = ['GET', 'POST'].map((method) => matchLoopbackRoute(routes, '/', method === 'GET' ? 'GET' : 'POST'));
    // Then the wildcard never matches an empty segment.
    expect(results).toEqual(['/', null]);
  });
});

describe('loopback manifest', () => {
  test.each([1024, 65535])('accepts boundary port %s when the declaration is valid', (port) => {
    // Given a valid declaration at a port boundary.
    // When parsed.
    const result = loopbackContributionSchema.parse({ ...loopback, port });
    // Then the value is preserved.
    expect(result.port).toBe(port);
  });

  test.each([
    { port: 1023 }, { port: 65536 }, { port: 4517.1 }, { port: '4517' }, { port: NaN },
    { env: '' }, { env: '_PORT' }, { env: '1PORT' }, { env: 'port' }, { env: 'PORT-NAME' },
    { env: ' PORT' }, { env: 'PORT\n' }, { env: 'A'.repeat(129) },
    { routes: [] }, { routes: Array.from({ length: 33 }, (_, id) => ({ path: `/${id}`, methods: ['GET'] })) },
    { routes: [{ path: '/', methods: [] }] }, { routes: [{ path: '/', methods: ['PUT'] }] },
    { routes: [{ path: '/', methods: ['GET', 'GET'] }] }, { routes: [{ path: '/', methods: ['get'] }] },
    { routes: [{ path: '/a', methods: ['GET'] }, { path: '/%61', methods: ['POST'] }] },
    { host: 'example.com' }, { url: 'http://example.com' }, { executable: '/bin/sh' },
    { routes: [{ path: '/', methods: ['GET'], redirect: true }] },
  ])('fails closed when a declaration has %j', (invalid) => {
    // Given a malformed contribution inside a valid runtime manifest.
    const document = { apiVersion: 1, contributes: { panel, loopback: { ...loopback, ...invalid } } };
    // When parsed at the manifest boundary.
    const result = parseManifestJson(JSON.stringify(document));
    // Then it is a loopback-specific failure, not a stripped declaration.
    expect(result).toMatchObject({ ok: false, code: 'invalid-loopback' });
  });

  test('derives loopback when a valid declaration is parsed', () => {
    // Given a canonicalizable route, a longest valid env, and a visible frame.
    const document = { apiVersion: 1, contributes: { panel, loopback: { ...loopback, env: 'A'.repeat(128), routes: [{ path: '/%61', methods: ['GET'] }] } } };
    // When the manifest is admitted.
    const result = parseManifestJson(JSON.stringify(document));
    // Then approval covers loopback with canonical routes.
    if (!result.ok) throw new Error(result.code);
    expect(result.manifest.contributes.loopback?.routes).toEqual([{ path: '/a', methods: ['GET'] }]);
    expect(requestedGuestCapabilities(result.manifest.contributes)).toEqual(['loopback']);
  });

  test('does not derive loopback when a typed declaration has an invalid port', () => {
    // Given a caller that has not parsed its typed manifest yet.
    // When deriving its grants.
    const requested = requestedGuestCapabilities({ loopback: { ...loopback, port: 1 } });
    // Then it has no valid loopback request.
    expect(requested).toEqual([]);
  });

  test('refuses bare loopback when listed as a declared capability', () => {
    // Given no loopback target or routes.
    const document = { apiVersion: 1, contributes: { panel, capabilities: ['loopback'] } };
    // When the manifest is admitted.
    const result = parseManifestJson(JSON.stringify(document));
    // Then no meaningless grant is accepted.
    expect(result).toMatchObject({ ok: false, code: 'invalid-capabilities' });
  });

  test.each([
    { background: { entry: 'background/index.html' } },
    { statusSection: { entry: 'status/index.html' } },
    { fileEditors: [{ id: 'editor', title: 'Editor', entry: 'editor/index.html', match: ['*.txt'] }] },
  ])('accepts loopback when an independent runtime frame exists: %j', (frame) => {
    // Given no visible panel entry, but a real guest runtime page.
    const document = { apiVersion: 1, contributes: { panel: { id: 'fixture', name: 'Fixture', icon: 'window' }, ...frame, loopback } };
    // When admitted.
    const result = parseManifestJson(JSON.stringify(document));
    // Then loopback is available to that runtime.
    expect(result.ok).toBe(true);
  });

  test('refuses loopback when the manifest has no guest runtime page', () => {
    // Given identity only, even alongside a host-spawned service.
    const document = { apiVersion: 1, contributes: { panel: { id: 'fixture', name: 'Fixture', icon: 'window' }, service: { entry: 'service.js', runtime: 'host', provides: ['browser'] }, loopback } };
    // When parsed.
    const result = parseManifestJson(JSON.stringify(document));
    // Then a service is not mistaken for a guest page.
    expect(result).toMatchObject({ ok: false, code: 'invalid-panel' });
  });

  test('preserves legacy output when lifecycle fields are omitted', () => {
    // Given a legacy background manifest.
    const document = { apiVersion: 1, contributes: { panel, background: { entry: 'background/index.html' } } };
    // When parsed by the extended SDK.
    const result = parseManifestJson(JSON.stringify(document));
    // Then implicit unread/on-demand behavior needs no stored-shape migration.
    expect(result).toEqual({ ok: true, manifest: document });
  });

  test.each(['on-demand', 'automatic'])('preserves %s when background lifecycle is explicit', (start) => {
    // Given opt-in lifecycle and count badge fields.
    const document = { apiVersion: 1, contributes: { panel: { ...panel, badge: 'count' }, background: { entry: 'background/index.html', start } } };
    // When parsed.
    const result = parseManifestJson(JSON.stringify(document));
    // Then both choices survive admission unchanged.
    expect(result).toEqual({ ok: true, manifest: document });
  });

  test.each([
    [{ panel: { ...panel, badge: 'other' } }, 'invalid-panel'],
    [{ panel, background: { entry: 'background/index.html', start: 'always' } }, 'invalid-background'],
  ])('refuses invalid lifecycle fields when supplied: %j', (contributes, code) => {
    // Given unknown lifecycle variants.
    // When parsed.
    const result = parseManifestJson(JSON.stringify({ apiVersion: 1, contributes }));
    // Then they fail closed rather than silently changing lifetime.
    expect(result).toMatchObject({ ok: false, code });
  });
});
