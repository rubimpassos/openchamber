import { expect, test } from 'bun:test';
import { OPENCHAMBER_SDK_CHANNEL } from './api-version.ts';
import { GUEST_LOOPBACK_BODY_BYTES, GUEST_LOOPBACK_RESPONSE_BYTES, type LoopbackRequest } from './loopback.ts';
import { answerUrl, createLoopbackFixture } from './loopback-fixture.test.ts';
import { HostRequestError } from './host.ts';

test('returns a scoped URL when the parent answers the matching request id', async () => {
  // Given a connected guest using noncanonical but safe segment encoding.
  const fixture = createLoopbackFixture();
  try {
    // When URL admission completes through the parent bridge.
    const pending = fixture.host.loopbackUrl({ path: '/%65vents', query: { locale: 'pt-BR' } });
    await answerUrl(fixture);
    const result = await pending;
    // Then the request uses the canonical path and the parent owns the URL.
    expect(fixture.latestCall()).toMatchObject({ type: 'loopback-url', payload: { path: '/events', query: { locale: 'pt-BR' } } });
    expect(new URL(result.url).searchParams.get('oc_url_token')).toBe('first');
    expect(result.expiresAt).toBe(123_456);
  } finally { fixture.host.dispose(); }
});

test.each(['GET', 'HEAD', 'POST'] as const)('returns upstream status and text when %s succeeds at the transport layer', async (method) => {
  // Given an approved request, including POST JSON when applicable.
  const fixture = createLoopbackFixture();
  const request: LoopbackRequest = method === 'POST' ? { path: '/', method, body: { enabled: true } } : { path: '/', method };
  try {
    // When the parent answers with an application-level conflict.
    const pending = fixture.host.loopbackRequest(request);
    fixture.send({ channel: OPENCHAMBER_SDK_CHANNEL, v: 1, type: 'result', id: fixture.latestCall().id, ok: true, payload: { status: 409, body: 'Conflict' } });
    // Then the client resolves rather than confusing HTTP status with transport rejection.
    await expect(pending).resolves.toEqual({ status: 409, body: 'Conflict' });
    expect(fixture.latestCall().payload).toEqual(request);
  } finally { fixture.host.dispose(); }
});

test.each([
  { path: '//host' }, { path: '/a/../b' }, { path: '/%252e' }, { path: '/events', query: { oc_url_token: 'secret' } },
  { path: '/events', query: { oc_future: 'x' } }, { path: '/events', query: { q: 'x'.repeat(2047) } },
])('rejects locally when a URL query or path is unsafe: %j', async (request) => {
  // Given a caller that would otherwise wait for a dropped bridge message.
  const fixture = createLoopbackFixture();
  try {
    // When admission runs in the guest.
    const pending = fixture.host.loopbackUrl(request);
    // Then rejection is typed and no request leaves the frame.
    await expect(pending).rejects.toMatchObject({ code: 'BAD_PATH' });
    expect(fixture.posted.map((message) => message.type)).toEqual(['hello']);
  } finally { fixture.host.dispose(); }
});

test('rejects locally when POST JSON exceeds the byte limit', async () => {
  // Given multibyte text smaller in characters than the byte bound.
  const fixture = createLoopbackFixture();
  try {
    // When sending a JSON document over 64 KiB.
    const pending = fixture.host.loopbackRequest({ method: 'POST', path: '/', body: 'é'.repeat(GUEST_LOOPBACK_BODY_BYTES / 2) });
    // Then it never becomes an unanswered host request.
    await expect(pending).rejects.toMatchObject({ code: 'HOST_REJECTED' });
    expect(fixture.posted.map((message) => message.type)).toEqual(['hello']);
  } finally { fixture.host.dispose(); }
});

test.each([
  { status: 600, body: '' }, { status: 200, body: 'é'.repeat(GUEST_LOOPBACK_RESPONSE_BYTES / 2 + 1) },
])('rejects when the parent response violates finite-response bounds', async (payload) => {
  // Given a parent whose response is not a valid loopback result.
  const fixture = createLoopbackFixture();
  try {
    // When the response arrives by the correct id.
    const pending = fixture.host.loopbackRequest({ method: 'GET', path: '/' });
    fixture.send({ channel: OPENCHAMBER_SDK_CHANNEL, v: 1, type: 'result', id: fixture.latestCall().id, ok: true, payload });
    // Then the per-call guard rejects before returning data to the application.
    await expect(pending).rejects.toMatchObject({ code: 'HOST_REJECTED' });
  } finally { fixture.host.dispose(); }
});

test('preserves typed refusals when the parent denies a URL', async () => {
  // Given a URL request awaiting approval.
  const fixture = createLoopbackFixture();
  try {
    const pending = fixture.host.loopbackUrl({ path: '/events' });
    // When the parent refuses it.
    fixture.send({ channel: OPENCHAMBER_SDK_CHANNEL, v: 1, type: 'result', id: fixture.latestCall().id, ok: false, code: 'NOT_GRANTED', error: 'Refused' });
    // Then the public error type remains the existing SDK error.
    await expect(pending).rejects.toBeInstanceOf(HostRequestError);
    await expect(pending).rejects.toMatchObject({ code: 'NOT_GRANTED' });
  } finally { fixture.host.dispose(); }
});

test('rejects in-flight RPCs when the host client is disposed', async () => {
  // Given a parent that has not answered.
  const fixture = createLoopbackFixture();
  const pending = fixture.host.loopbackUrl({ path: '/events' });
  // When the client is disposed.
  fixture.host.dispose();
  // Then the normal RPC lifetime handles loopback too.
  await expect(pending).rejects.toMatchObject({ code: 'HOST_UNAVAILABLE' });
});
