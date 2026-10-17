import { describe, expect, test } from 'bun:test';
import { createWebPullStackAPI } from '../../../../web/src/api/pull-stacks';
import type { SourceControlReadContext } from './types';
import type { RuntimeFetchOptions } from '../runtime-fetch';
import { restackFixture, stackFixture } from '../source-control/pullStack.test-support';

const context: SourceControlReadContext = { provider: 'github', instance: 'github.com', directory: '/repo', repositoryId: 'repo-id', accountId: 'account-id', bindingRevision: 4, primaryRemote: 'origin' };
const pull = { owner: 'acme', repo: 'app', number: 2 };
const mutationContext = { ...context, idempotencyKey: 'stack-request',
  target: { project: { owner: pull.owner, name: pull.repo }, number: pull.number, headSha: 'head-2' },
};
const receipt = <T,>(result: T) => ({ status: 'succeeded', replayed: false,
  actor: { provider: 'github', instance: 'github.com', providerAccountId: 'github.com#1' },
  target: { repositoryId: context.repositoryId, bindingRevision: context.bindingRevision, primaryRemote: context.primaryRemote,
    project: { id: 'acme/app', owner: 'acme', name: 'app' }, number: pull.number, headSha: mutationContext.target.headSha }, result,
});

describe('pull stack runtime adapter', () => {
  test('sends the exact bound read context and PR in the query', async () => {
    const requests: Array<{ path: string; options?: RuntimeFetchOptions }> = [];
    const api = createWebPullStackAPI(async (path, options) => { requests.push({ path, options }); return Response.json({ connected: true, stack: stackFixture() }); });
    const answer = await api.githubPullStack(context, pull);
    expect(answer.connected).toBe(true);
    expect(requests[0]?.path).toBe('/api/source-control/github/pulls/stack');
    const query = requests[0]?.options?.query;
    if (!(query instanceof URLSearchParams)) throw new Error('Expected a bound URLSearchParams query');
    expect(Object.fromEntries(query)).toEqual({
      directory: '/repo', instance: 'github.com', repositoryId: 'repo-id', accountId: 'account-id', bindingRevision: '4', primaryRemote: 'origin',
      owner: 'acme', repo: 'app', number: '2',
    });
  });
  test('keeps a refused native registration as a successful inferred-stack result', async () => {
    let body: BodyInit | null | undefined;
    const api = createWebPullStackAPI(async (_path, options) => { body = options?.body; return Response.json(receipt({ ok: true, registered: false, nativeNumber: null })); });
    const withDisplayFields = { ...pull, source: 'origin' };
    const answer = await api.githubPullStackRegister(mutationContext, withDisplayFields);
    expect(answer.registered).toBe(false);
    expect(body).toBe(JSON.stringify({ ...mutationContext, ...pull }));
  });
  for (const payload of [
    { ok: true, status: 'merged', merged: true, retargeted: 3 },
    { ok: true, status: 'enqueued', merged: false, retargeted: null },
    { ok: true, status: 'pending', merged: false, retargeted: null },
  ]) test(`preserves the accepted merge outcome when the server returns ${payload.status}`, async () => {
    // Given
    const api = createWebPullStackAPI(async () => Response.json(receipt(payload)));

    // When
    const answer = await api.githubPullStackMerge(mutationContext, { ...pull, method: 'squash' });

    // Then
    expect(answer).toEqual(payload);
  });
  for (const payload of [
    { status: 'merged', merged: false, retargeted: null },
    { status: 'pending', merged: true, retargeted: null },
    { status: 'enqueued', merged: true, retargeted: null },
    { status: 'pending', merged: false, retargeted: 3 },
    { status: 'enqueued', merged: false, retargeted: 3 },
    { status: 'failed', merged: true, retargeted: null },
    { merged: true, retargeted: null },
  ]) test(`rejects an inconsistent merge outcome ${JSON.stringify(payload)}`, async () => {
    // Given
    const api = createWebPullStackAPI(async () => Response.json(receipt({ ok: true, ...payload })));

    // When / Then
    await expect(api.githubPullStackMerge(mutationContext, { ...pull, method: 'squash' })).rejects.toThrow();
  });
  test('rejects failed and malformed reads without converting either to an empty stack', async () => {
    const failed = createWebPullStackAPI(async () => Response.json({ error: 'Binding changed', code: 'STALE_BINDING' }, { status: 409 }));
    const malformed = createWebPullStackAPI(async () => Response.json({ connected: true, stack: {} }));
    await expect(failed.githubPullStack(context, pull)).rejects.toThrow('Binding changed');
    await expect(malformed.githubPullStack(context, pull)).rejects.toThrow();
  });
  for (const target of [
    { repositoryId: 'other-repository' }, { bindingRevision: 5 }, { number: 99 }, { headSha: 'different-head' },
  ]) test(`rejects a stack mutation receipt for another target ${JSON.stringify(target)}`, async () => {
    const payload = receipt({ ok: true, merged: true, status: 'merged', retargeted: null });
    const api = createWebPullStackAPI(async () => Response.json({ ...payload, target: { ...payload.target, ...target } }));
    await expect(api.githubPullStackMerge(mutationContext, { ...pull, method: 'squash' })).rejects.toThrow();
  });
  test('serializes local restack input without introducing a network operation on the server', async () => {
    const requests: Array<{ path: string; options?: RuntimeFetchOptions }> = [];
    const api = createWebPullStackAPI(async (path, options) => { requests.push({ path, options }); return Response.json(restackFixture()); });
    const input = { directory: '/repo', sessionId: null, remote: 'origin', trunk: 'main', branches: ['branch-1', 'branch-2'] };
    await api.prStackRestack(input);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.path).toBe('/api/pr-stacks/restack');
    expect(requests[0]?.options?.method).toBe('POST');
    expect(requests[0]?.options?.body).toBe(JSON.stringify(input));
  });
  test('uses the exact run ID for each paused-run control', async () => {
    const paths: string[] = [];
    const api = createWebPullStackAPI(async (path) => { paths.push(path); return Response.json(restackFixture()); });
    await api.prStackRestackContinue('run/1');
    await api.prStackRestackAbort('run/1');
    await api.prStackRestackAskSession('run/1');
    expect(paths).toEqual(['/api/pr-stacks/restack/run%2F1/continue', '/api/pr-stacks/restack/run%2F1/abort', '/api/pr-stacks/restack/run%2F1/ask-session']);
  });
  test('gives VS Code stable unsupported answers for every stack operation', async () => {
    const previous = Object.getOwnPropertyDescriptor(globalThis, 'window');
    Object.defineProperty(globalThis, 'window', { configurable: true, value: new EventTarget() });
    try {
    const { createVSCodeSourceControlAPI, VSCODE_SOURCE_CONTROL_UNSUPPORTED_MESSAGE } = await import('../../../../vscode/webview/api/source-control');
    const api = createVSCodeSourceControlAPI();
    await expect(api.githubPullStack(context, pull)).rejects.toThrow(VSCODE_SOURCE_CONTROL_UNSUPPORTED_MESSAGE);
    await expect(api.githubPullStackRegister(mutationContext, pull)).rejects.toThrow(VSCODE_SOURCE_CONTROL_UNSUPPORTED_MESSAGE);
    await expect(api.githubPullStackRetarget(mutationContext, { ...pull, base: 'main' })).rejects.toThrow(VSCODE_SOURCE_CONTROL_UNSUPPORTED_MESSAGE);
    await expect(api.githubPullStackMerge(mutationContext, { ...pull, method: 'squash' })).rejects.toThrow(VSCODE_SOURCE_CONTROL_UNSUPPORTED_MESSAGE);
    await expect(api.prStackRestackGet('/repo')).rejects.toThrow(VSCODE_SOURCE_CONTROL_UNSUPPORTED_MESSAGE);
    await expect(api.prStackRestack({ directory: '/repo', sessionId: null, remote: 'origin', trunk: 'main', branches: [] })).rejects.toThrow(VSCODE_SOURCE_CONTROL_UNSUPPORTED_MESSAGE);
    await expect(api.prStackRestackContinue('id')).rejects.toThrow(VSCODE_SOURCE_CONTROL_UNSUPPORTED_MESSAGE);
    await expect(api.prStackRestackAbort('id')).rejects.toThrow(VSCODE_SOURCE_CONTROL_UNSUPPORTED_MESSAGE);
    await expect(api.prStackRestackAskSession('id')).rejects.toThrow(VSCODE_SOURCE_CONTROL_UNSUPPORTED_MESSAGE);
    } finally {
      if (previous) Object.defineProperty(globalThis, 'window', previous);
      else Reflect.deleteProperty(globalThis, 'window');
    }
  });
});
