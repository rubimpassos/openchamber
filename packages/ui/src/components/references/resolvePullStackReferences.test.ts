import { describe, expect, test } from 'bun:test';
import type { ChangeRequestContext, SourceControlReadContext } from '@/lib/api/types';
import { stackFixture } from '@/lib/source-control/pullStack.test-support';
import { resolvePullStackReferences } from './resolvePullStackReferences';

const context: SourceControlReadContext = { provider: 'github', instance: 'github.com', directory: '/repo', repositoryId: 'repo-id', accountId: 'account', bindingRevision: 1, primaryRemote: 'origin' };
const project = { provider: 'github' as const, instance: 'github.com', id: 'acme/app', owner: 'acme', name: 'app', url: 'https://github.com/acme/app' };
const payload = (number: number): ChangeRequestContext => ({
  identity: context, project,
  changeRequest: { ...context, project, id: String(number), number, title: `Change ${number}`, url: `${project.url}/pull/${number}`, state: 'open', draft: false, head: `branch-${number}`, base: number === 1 ? 'main' : `branch-${number - 1}` },
  issueComments: [], reviewComments: [], files: [], diff: `patch-${number}`,
});

describe('whole-stack context', () => {
  test('attaches successes in stack order while naming every failed member', async () => {
    const calls: number[] = [];
    const result = await resolvePullStackReferences(stackFixture(), { owner: 'acme', repo: 'app' }, {
      context, isCurrent: () => true, sourceControl: { changeRequestContext: async (_context, number, options) => {
        calls.push(number);
        expect(options).toEqual({ includeDiff: true, includeCIDetails: true, project: { owner: 'acme', name: 'app' } });
        if (number === 2) throw new Error('Unavailable');
        return payload(number);
      } },
    });
    expect(calls).toEqual([1, 2, 3]);
    expect(result.references.map((reference) => reference.kind === 'change-request' ? reference.number : null)).toEqual([1, 3]);
    expect(result.failures).toEqual([{ number: 2, error: 'Unavailable' }]);
  });
  test('stops reading further members when the target runtime or session changes', async () => {
    let current = true;
    const calls: number[] = [];
    await resolvePullStackReferences(stackFixture(), { owner: 'acme', repo: 'app' }, {
      context, isCurrent: () => current, sourceControl: { changeRequestContext: async (_context, number) => { calls.push(number); current = false; return payload(number); } },
    });
    expect(calls).toEqual([1]);
  });
});
