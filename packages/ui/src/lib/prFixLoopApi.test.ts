import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { DEFAULT_PR_FIX_LOOP_CONFIG, type FixLoop } from './prFixLoop';
import { prFixLoopApi } from './prFixLoopApi';
import { configureRuntimeUrlResolver, getRuntimeUrlResolver, setRuntimeUrlResolver } from './runtime-url';

const loop: FixLoop = {
  id: 'loop-1', sessionId: 'session-1', directory: '/repo', owner: 'owner', repo: 'repo', number: 12,
  url: 'https://github.com/owner/repo/pull/12', title: 'Fix CI', branch: 'fix-ci', status: 'watching',
  statusReason: null, config: DEFAULT_PR_FIX_LOOP_CONFIG, iterations: 0, tokensUsed: 0,
  ci: null, unresolvedThreads: null, changesRequested: null, worker: null, pendingApproval: null, review: null,
  lastCheckedAt: null, lastError: null, createdAt: 1, updatedAt: 1,
};

const ROOT = '/api/source-control/github/pr/fix-loops';
let reply: (request: Request) => Response | Promise<Response> = () => Response.json({ loops: [] });
let resolver = getRuntimeUrlResolver();
const originalFetch = globalThis.fetch;

beforeEach(() => {
  resolver = getRuntimeUrlResolver();
  configureRuntimeUrlResolver({ apiBaseUrl: 'http://127.0.0.1:1' });
  const fakeFetch = async (input: RequestInfo | URL, init?: RequestInit) => reply(new Request(input, init));
  globalThis.fetch = fakeFetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  setRuntimeUrlResolver(resolver);
});

describe('PR fix-loop HTTP contract', () => {
  test('passes the bound context as query fields and activation as JSON', async () => {
    // Given
    const context = {
      provider: 'github' as const, instance: 'https://github.example', directory: '/work/my repo',
      repositoryId: 'repository-1', accountId: 'account-1', bindingRevision: 8, primaryRemote: 'upstream',
    };
    const received: Array<{ method: string; path: string; query: Record<string, string>; body: string }> = [];
    reply = async (request) => {
      const url = new URL(request.url);
      received.push({ method: request.method, path: url.pathname, query: Object.fromEntries(url.searchParams), body: await request.text() });
      return Response.json({ loop });
    };
    // When
    await prFixLoopApi.create({ context, sessionId: loop.sessionId, owner: loop.owner, repo: loop.repo, number: loop.number, config: { pushMode: 'approval' }, workerId: 'prepared-worker' });
    // Then
    expect(received).toEqual([{
      method: 'POST', path: ROOT,
      query: { instance: context.instance, directory: context.directory, repositoryId: context.repositoryId, accountId: context.accountId, bindingRevision: '8', primaryRemote: context.primaryRemote },
      body: JSON.stringify({ sessionId: 'session-1', owner: 'owner', repo: 'repo', number: 12, config: { pushMode: 'approval' }, workerId: 'prepared-worker' }),
    }]);
  });

  test('accepts authoritative empty snapshots', async () => {
    // Given
    reply = () => Response.json({ loops: [] });
    // When
    const result = await prFixLoopApi.list();
    // Then
    expect(result).toEqual({ loops: [], rejectedIds: [] });
  });

  test('rejects a failed read instead of returning no loops', async () => {
    // Given
    reply = () => Response.json({ error: 'account unavailable', code: 'ACCOUNT_UNAVAILABLE' }, { status: 503 });
    // When
    const result = prFixLoopApi.list();
    // Then
    const error = await result.then(() => null, (reason) => reason);
    expect(error).toMatchObject({ status: 503, code: 'ACCOUNT_UNAVAILABLE', message: 'account unavailable' });
  });

  test('separates malformed entities from complete siblings at the HTTP boundary', async () => {
    // Given
    reply = () => Response.json({ loops: [loop, { ...loop, id: 'legacy-approval', pendingApproval: { commit: 'bad' } }] });
    // When
    const result = await prFixLoopApi.list();
    // Then
    expect(result).toEqual({ loops: [loop], rejectedIds: ['legacy-approval'] });
  });

  test('isolates malformed review authority while preserving a complete sibling', async () => {
    // Given
    reply = () => Response.json({ loops: [loop, { ...loop, id: 'bad-review', review: { state: 'blocked', actions: [] } }] });
    // When
    const result = await prFixLoopApi.list();
    // Then
    expect(result).toEqual({ loops: [loop], rejectedIds: ['bad-review'] });
  });

  test('sends an edit as a config patch without reactivation context', async () => {
    // Given
    const received: Array<{ method: string; url: string; body: string }> = [];
    reply = async (request) => {
      received.push({ method: request.method, url: new URL(request.url).pathname + new URL(request.url).search, body: await request.text() });
      return Response.json({ loop: { ...loop, config: { ...loop.config, maxIterations: 5 } } });
    };
    // When
    const updated = await prFixLoopApi.update(loop.id, { maxIterations: 5 });
    // Then
    expect(received).toEqual([{ method: 'PATCH', url: `${ROOT}/loop-1`, body: '{"config":{"maxIterations":5}}' }]);
    expect(updated.config.maxIterations).toBe(5);
  });

  test('prepares a worker with only the explicit model and place under the bound context', async () => {
    // Given
    const context = { provider: 'github' as const, instance: 'https://github.com', directory: '/repo', repositoryId: 'r1', accountId: 'a1', bindingRevision: 2, primaryRemote: 'upstream' };
    const model = { providerID: 'openai', modelID: 'gpt-test', variant: 'high' };
    const worker = { id: 'a95d2bca-d7b5-41c6-b52f-4f8a9623c76d', spaceId: '012345abcdef', parentSessionId: 'ses_host', directory: '/repo', model, sessionId: null, spacePath: null };
    const received: Request[] = [];
    reply = (request) => { received.push(request); return Response.json({ worker }, { status: 202 }); };
    // When
    const result = await prFixLoopApi.prepareWorker({ context, sessionId: 'ses_host', owner: 'owner', repo: 'repo', number: 12, name: 'pr-12', placeId: 'docker-ssh', model });
    // Then
    const request = received[0];
    expect(request?.method).toBe('POST');
    expect(new URL(request?.url ?? '').pathname).toBe(`${ROOT}/workers`);
    expect(new URL(request?.url ?? '').searchParams.get('repositoryId')).toBe('r1');
    expect(await request?.json()).toEqual({ sessionId: 'ses_host', owner: 'owner', repo: 'repo', number: 12, name: 'pr-12', placeId: 'docker-ssh', model });
    expect(result).toEqual(worker);
  });

  test('approves only the receipt identity without a branch, remote or mutable commit target', async () => {
    // Given
    const received: Request[] = [];
    reply = (request) => { received.push(request); return Response.json({ loop }); };
    // When
    await prFixLoopApi.approve(loop.id, 'receipt-captured');
    // Then
    expect(new URL(received[0]?.url ?? '').pathname).toBe(`${ROOT}/loop-1/approve`);
    expect(await received[0]?.json()).toEqual({ receiptId: 'receipt-captured' });
  });

  test('resumes the existing loop without changing its worker or execution mode', async () => {
    // Given
    const received: Request[] = [];
    reply = (request) => { received.push(request); return Response.json({ loop }); };
    // When
    await prFixLoopApi.resume(loop.id);
    // Then
    expect(new URL(received[0]?.url ?? '').pathname).toBe(`${ROOT}/loop-1/resume`);
    expect(await received[0]?.text()).toBe('');
  });
});
