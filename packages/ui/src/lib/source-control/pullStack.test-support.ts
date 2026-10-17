import type { PullStack, PullStackMember, RestackRun } from '@/lib/api/types';

export const stackMember = (number: number, overrides: Partial<PullStackMember> = {}): PullStackMember => ({
  number, title: `Change ${number}`, url: `https://github.com/acme/app/pull/${number}`,
  state: 'open', draft: false, head: `branch-${number}`, base: number === 1 ? 'main' : `branch-${number - 1}`,
  headSha: 'a'.repeat(40), checks: null, mergeable: null, mergeableState: null, summary: 'unknown',
  behindBase: null, retargetTo: null, mergedParent: null, ...overrides,
});

export const stackFixture = (): PullStack => ({
  source: 'inferred', nativeNumber: null, trunk: 'main', members: [stackMember(1), stackMember(2), stackMember(3)],
  current: 2, branches: [], nativeUnavailable: false,
});

export const restackFixture = (overrides: Partial<RestackRun> = {}): RestackRun => ({
  id: 'restack-1', directory: '/repo', sessionId: 'session-1', remote: 'origin', trunk: 'main',
  status: 'done', conflictMode: 'pause', createdAt: 10, updatedAt: 20,
  steps: [1, 2, 3].map((number) => ({ branch: `branch-${number}`, onto: number === 1 ? 'main' : `branch-${number - 1}`,
    status: 'done', before: 'a'.repeat(40), after: 'b'.repeat(40),
  })), ...overrides,
});
