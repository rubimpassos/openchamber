import { expect, it } from 'vitest';
import { createJiraOAuthHttp, createProviderHttp } from './http.js';

const destination = { service: 'github', origin: 'https://api.github.com', resource: 'acme/app', path: '/repos/acme/app' } as const;
const policyOptions = { env: {}, readFile: () => '{"enterpriseMode":true,"allowedBotDestinations":[]}' };
const fixture = (response: Response) => {
  const requests: { readonly url: string; readonly options: RequestInit }[] = [];
  return { requests, fetchImpl: async (url: string, options: RequestInit) => {
    requests.push({ url, options });
    return response;
  } };
};

it.each(['//other.example/secret', 'https://other.example/secret', '/resource#fragment', 'resource'])(
  'refuses a non-provider path %s before admission or transport', async (path: string) => {
    // Given
    const upstream = fixture(Response.json({}));
    const request = createProviderHttp(upstream);
    let admissions = 0;
    // When
    const result = request({ ...destination, path, method: 'POST', beforeWrite: () => { admissions += 1; } });
    // Then
    await expect(result).rejects.toMatchObject({ code: 'BOT_SERVICE_ORIGIN_INVALID' });
    expect(admissions).toBe(0);
    expect(upstream.requests).toEqual([]);
  });

it('reads current destination policy after admission when dispatching a write', async () => {
  // Given
  const upstream = fixture(Response.json({}));
  let allowed = true;
  const request = createProviderHttp({ ...upstream, policyOptions: { env: {}, readFile: () => JSON.stringify({ enterpriseMode: true,
    allowedBotDestinations: allowed ? [destination] : [] }) } });
  // When
  const result = request({ ...destination, method: 'POST', beforeWrite: () => { allowed = false; } });
  // Then
  await expect(result).rejects.toMatchObject({ code: 'enterprise_mode', status: 403 });
  expect(upstream.requests).toEqual([]);
});

it('allows an authorized write when the exact provider destination is granted', async () => {
  // Given
  const upstream = fixture(Response.json({ id: 7 }));
  const request = createProviderHttp({ ...upstream, policyOptions: { env: {}, readFile: () => JSON.stringify({ enterpriseMode: true,
    allowedBotDestinations: [destination] }) } });
  // When
  const result = await request({ ...destination, method: 'POST', authorization: 'Bearer fixture', body: { title: 'Fixture' } });
  // Then
  expect(result).toEqual({ id: 7 });
  expect(upstream.requests).toEqual([{ url: 'https://api.github.com/repos/acme/app', options: {
    method: 'POST', redirect: 'error', signal: expect.any(AbortSignal), body: '{"title":"Fixture"}',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'User-Agent': 'OpenChamber-Bots',
      Authorization: 'Bearer fixture', 'X-GitHub-Api-Version': '2026-03-10' },
  } }]);
});

it('permits a read-only GraphQL POST when enterprise content writes are refused', async () => {
  // Given
  const upstream = fixture(Response.json({ data: {} }));
  const request = createProviderHttp({ ...upstream, policyOptions });
  // When
  const result = await request({ ...destination, path: '/graphql', method: 'POST', readOnly: true, body: { query: 'query { viewer { id } }' } });
  // Then
  expect(result).toEqual({ data: {} });
  expect(upstream.requests).toHaveLength(1);
});

it.each([
  { method: 'GET', state: 'needs-you' },
  { method: 'POST', state: 'outcome-unknown' },
] as const)('bounds a $method provider response and retains $state on overflow', async ({ method, state }: { method: 'GET' | 'POST'; state: 'needs-you' | 'outcome-unknown' }) => {
    // Given
    const upstream = fixture(new Response('x'.repeat(2 * 1024 * 1024 + 1)));
    const request = createProviderHttp({ ...upstream, policyOptions: { env: {}, readFile: () => '{"enterpriseMode":false}' } });
    // When
    const result = request({ ...destination, method });
    // Then
    await expect(result).rejects.toMatchObject({ code: 'BOT_SERVICE_UNAVAILABLE', state, status: 502 });
    expect(upstream.requests).toHaveLength(1);
  });

it.each([401, 403, 500, 307])('sanitizes provider failure %s without retrying', async (status: number) => {
  // Given
  const upstream = fixture(Response.json({ token: 'private-upstream-value' }, { status }));
  const request = createProviderHttp({ ...upstream, policyOptions: { env: {}, readFile: () => '{"enterpriseMode":false}' } });
  // When
  const result = request({ ...destination, method: 'POST' });
  // Then
  await expect(result).rejects.toMatchObject({ state: status === 401 || status === 403 ? 'needs-you' : 'outcome-unknown' });
  await expect(result).rejects.not.toThrow('private-upstream-value');
  expect(upstream.requests).toHaveLength(1);
});

it('keeps Jira site policy authoritative when a gateway-only grant is supplied', async () => {
  // Given
  const upstream = fixture(Response.json({}));
  const request = createJiraOAuthHttp({ ...upstream, policyOptions: { env: {}, readFile: () => JSON.stringify({ enterpriseMode: true,
    allowedBotDestinations: [{ service: 'jira', origin: 'https://api.atlassian.com', resource: 'TEST' }] }) } });
  // When
  const result = request.request({ site: 'https://fixture.atlassian.net', cloudId: '11111111-1111-4111-8111-111111111111',
    resource: 'TEST', path: '/rest/api/3/issue/TEST-7/comment', method: 'POST', body: {} });
  // Then
  await expect(result).rejects.toMatchObject({ code: 'enterprise_mode' });
  expect(upstream.requests).toEqual([]);
});
