import { describe, expect, test } from 'bun:test';
import { effectiveGrants, guestGrantScope } from './grant-scope.js';
import { resolveLoopbackTarget } from './loopback-target.js';

const loopback = {
  port: 8123, env: 'OC_TEST_LOOPBACK_PORT',
  routes: [{ path: '/sessions/*', methods: ['POST', 'GET'] }, { path: '/state', methods: ['GET'] }],
};

describe('resolveLoopbackTarget', () => {
  test.each([undefined, ''])('uses the declared default when the override is %s', (value) => {
    // Given an unset or empty server override.
    const env = { OC_TEST_LOOPBACK_PORT: value };
    // When resolving the parsed declaration.
    const target = resolveLoopbackTarget(loopback, env);
    // Then the approval records the default and a canonical permission set.
    expect(target).toEqual({ status: 'ready', scope: {
      port: 8123, env: 'OC_TEST_LOOPBACK_PORT', resolvedPort: 8123,
      routes: ['GET /sessions/*', 'GET /state', 'POST /sessions/*'],
    } });
  });

  test.each(['1024', '9124', '65535'])('uses the actual target when the override is %s', (value) => {
    // Given a valid server override distinct from the default.
    const env = { OC_TEST_LOOPBACK_PORT: value };
    // When resolving it.
    const target = resolveLoopbackTarget(loopback, env);
    // Then no browser or default port replaces the server's selection.
    expect(target).toMatchObject({ status: 'ready', scope: { port: 8123, resolvedPort: Number(value) } });
  });

  test.each(['8123junk', '8123.5', '8e3', '0x2000', '+8123', ' 8123', '8123 ', ' ', '0', '1023', '65536', '-8123', 'secret-value'])
  ('fails closed without exposing the raw override when it is %s', (value) => {
    // Given a nonempty invalid value.
    const env = { OC_TEST_LOOPBACK_PORT: value };
    // When resolving it.
    const target = resolveLoopbackTarget(loopback, env);
    // Then there is neither a fallback port nor leaked environment content.
    expect(target).toEqual({ status: 'config-invalid' });
  });

  test('drops approval when only the resolved environment port changes', () => {
    // Given an approval for one server-local process.
    const guest = { loopback };
    const approved = guestGrantScope(guest, resolveLoopbackTarget(loopback, { OC_TEST_LOOPBACK_PORT: '9124' }));
    const current = guestGrantScope(guest, resolveLoopbackTarget(loopback, { OC_TEST_LOOPBACK_PORT: '9125' }));
    // When evaluating the new target.
    const grants = effectiveGrants(['loopback'], approved, current);
    // Then the previous approval cannot reach it.
    expect(grants).toEqual([]);
  });

  test('drops approval when the environment becomes invalid', () => {
    // Given an approved default port and an invalid override.
    const guest = { loopback };
    const approved = guestGrantScope(guest, resolveLoopbackTarget(loopback, {}));
    const current = guestGrantScope(guest, resolveLoopbackTarget(loopback, { OC_TEST_LOOPBACK_PORT: 'invalid' }));
    // When evaluating the configuration failure.
    const grants = effectiveGrants(['loopback'], approved, current);
    // Then no effective loopback grant survives.
    expect(grants).toEqual([]);
  });
});
