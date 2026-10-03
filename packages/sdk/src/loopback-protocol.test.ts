import { describe, expect, test } from 'bun:test';
import { OPENCHAMBER_SDK_CHANNEL } from './api-version.ts';
import { GUEST_LOOPBACK_BODY_BYTES, GUEST_LOOPBACK_RESPONSE_BYTES } from './loopback.ts';
import { guestMessageSchema, hostMessageSchema } from './protocol.ts';
import { loopbackRequestResultSchema } from './loopback-schemas.ts';

const envelope = { channel: OPENCHAMBER_SDK_CHANNEL, v: 1, id: 'request-1' };

describe('loopback wire admission', () => {
  test('accepts exact byte limits when request path, query and body meet their bounds', () => {
    // Given exact ASCII boundaries, including JSON string quotes in the body.
    const wire = { ...envelope, type: 'loopback-request', payload: {
      method: 'POST', path: `/${'x'.repeat(255)}`, query: { q: 'x'.repeat(2046) }, body: 'x'.repeat(GUEST_LOOPBACK_BODY_BYTES - 2),
    } };
    // When parsed.
    const result = guestMessageSchema.safeParse(wire);
    // Then inclusive limits remain usable.
    expect(result.success).toBe(true);
  });
  test.each([
    { type: 'loopback-url', payload: { path: '/sessions/a%20b', query: { locale: 'pt-BR' } } },
    { type: 'loopback-request', payload: { path: '/', method: 'GET' } },
    { type: 'loopback-request', payload: { path: '/', method: 'HEAD' } },
    { type: 'loopback-request', payload: { path: '/', method: 'POST', body: { enabled: false } } },
    { type: 'loopback-request', payload: { path: '/', method: 'POST', body: null } },
    { type: 'loopback-request', payload: { path: '/', method: 'POST' } },
  ])('round-trips a request with an id when its payload is valid: %j', (request) => {
    // Given one of the two loopback operations.
    const wire = { ...envelope, ...request };
    // When parsed at the host's boundary.
    const parsed = guestMessageSchema.parse(wire);
    // Then identity and operation data survive together.
    expect(parsed).toEqual(wire);
  });

  test.each([
    { path: '//host' }, { path: '/a/../b' }, { path: '/%252f' }, { path: '/a?b=1' },
    { path: '/', query: { oc_url_token: 'secret' } }, { path: '/', query: { oc_other: 'value' } },
    { path: '/', query: { q: 'x'.repeat(2047) } }, { path: '/', query: { q: 'é'.repeat(342) } },
    { path: '/', query: { q: 3 } }, { path: '/', host: '127.0.0.1' }, { path: '/', port: 4517 },
    { path: '/', guestId: 'other' }, { path: '/', headers: { authorization: 'secret' } },
  ])('rejects unsafe URL payloads when received from a guest: %j', (payload) => {
    // Given a malformed or authority-bearing payload.
    // When parsed.
    const result = guestMessageSchema.safeParse({ ...envelope, type: 'loopback-url', payload });
    // Then nothing crosses the bridge.
    expect(result.success).toBe(false);
  });

  test.each([
    { method: 'GET', body: null }, { method: 'HEAD', body: {} }, { method: 'PUT' },
    { method: 'POST', body: undefined, headers: { Accept: '*/*' } },
    { method: 'POST', body: NaN }, { method: 'POST', body: () => 'bad' },
    { method: 'POST', body: 'é'.repeat(GUEST_LOOPBACK_BODY_BYTES / 2) },
  ])('rejects a request when its method or JSON body is invalid: %j', (payload) => {
    // Given an unsupported verb/body combination.
    // When received by the host.
    const result = guestMessageSchema.safeParse({ ...envelope, type: 'loopback-request', payload: { path: '/', ...payload } });
    // Then it is not converted to a permitted request.
    expect(result.success).toBe(false);
  });

  test.each([{ id: '' }, { id: undefined }, { v: 2 }, { channel: 'other' }, { guestId: 'other' }])('rejects an envelope when its routing fields are invalid: %j', (fields) => {
    // Given an otherwise valid URL request.
    // When envelope validation runs.
    const result = guestMessageSchema.safeParse({ ...envelope, type: 'loopback-url', payload: { path: '/' }, ...fields });
    // Then malformed correlation/version/identity fields cannot be used.
    expect(result.success).toBe(false);
  });

  test.each([
    { url: 'https://host.test/api/guests/demo/loopback/events?oc_url_token=scoped', expiresAt: 123_456 },
    { status: 409, body: 'Conflict' }, { status: 204, body: '' },
  ])('round-trips a result when the parent answers by id: %j', (payload) => {
    // Given a parent response using the existing result envelope.
    const wire = { ...envelope, type: 'result', ok: true, payload };
    // When parsed.
    const result = hostMessageSchema.parse(wire);
    // Then status errors remain application results, not transport failures.
    expect(result).toEqual(wire);
  });

  test.each(['NOT_GRANTED', 'UNSUPPORTED', 'HOST_TIMEOUT'])('preserves %s when the parent refuses admission', (code) => {
    // Given a typed host refusal.
    const wire = { ...envelope, type: 'result', ok: false, code, error: 'Refused' };
    // When parsed.
    const result = hostMessageSchema.parse(wire);
    // Then the caller can decide whether to reconnect.
    expect(result).toEqual(wire);
  });

  test.each([
    { url: 'javascript:alert(1)', expiresAt: 1 }, { url: 'https://user:pass@host.test/', expiresAt: 1 },
    { url: 'https://host.test/', expiresAt: 0 }, { url: 'https://host.test/', expiresAt: 1.5 },
    { url: 'https://host.test/#token', expiresAt: 1 }, { url: 'https://host.test/' },
    { status: 600, body: '' }, { status: 200.5, body: '' }, { status: 200, body: {} },
  ])('rejects a result when the payload is malformed: %j', (payload) => {
    // Given a malformed host result.
    // When parsed by the host contract schema.
    const result = hostMessageSchema.safeParse({ ...envelope, type: 'result', ok: true, payload });
    // Then it is not mistaken for an ordinary response.
    expect(result.success).toBe(false);
  });

  test.each([GUEST_LOOPBACK_RESPONSE_BYTES, GUEST_LOOPBACK_RESPONSE_BYTES + 1])('bounds finite UTF-8 responses when there are %s bytes', (bytes) => {
    // Given an ASCII body at or beyond the finite-response limit.
    const payload = { status: 200, body: 'x'.repeat(bytes) };
    // When parsed.
    const result = loopbackRequestResultSchema.safeParse(payload);
    // Then 16 MiB is inclusive.
    expect(result.success).toBe(bytes === GUEST_LOOPBACK_RESPONSE_BYTES);
  });

  test('counts UTF-8 bytes when a finite response has multibyte text', () => {
    // Given fewer characters than the byte limit but more UTF-8 bytes.
    const payload = { status: 200, body: 'é'.repeat(GUEST_LOOPBACK_RESPONSE_BYTES / 2 + 1) };
    // When parsed.
    const result = loopbackRequestResultSchema.safeParse(payload);
    // Then character count cannot bypass the bound.
    expect(result.success).toBe(false);
  });
});
