import { describe, expect, test } from 'bun:test';
import { restackEventSchema, pullStackResultSchema } from '@/lib/api/pull-stacks';
import { latestRestackRun, restackBelongsToStack, restackPublicationPlan } from './restackState';
import { restackFixture, stackFixture, stackMember } from './pullStack.test-support';

describe('restack state', () => {
  test('keeps newer event state when an earlier GET or control reply arrives', () => {
    const live = restackFixture({ status: 'paused', updatedAt: 30 });
    const chosen = latestRestackRun(live, restackFixture({ status: 'running', updatedAt: 20 }));
    expect(chosen).toBe(live);
  });
  test('preserves terminal or paused states when timestamp resolution ties', () => {
    const done = restackFixture();
    const paused = restackFixture({ status: 'paused' });
    expect(latestRestackRun(done, restackFixture({ status: 'running' }))).toBe(done);
    expect(latestRestackRun(paused, restackFixture({ status: 'running' }))).toBe(paused);
  });
  test('accepts a newer run but ignores broadcasts from a preceding run', () => {
    const newer = restackFixture({ id: 'restack-2', createdAt: 30, updatedAt: 40 });
    expect(latestRestackRun(restackFixture(), newer)).toBe(newer);
    expect(latestRestackRun(newer, restackFixture())).toBe(newer);
  });
  test('matches the local run to its actual chain', () => {
    expect(restackBelongsToStack(restackFixture(), stackFixture())).toBe(true);
    expect(restackBelongsToStack(restackFixture({ trunk: 'release' }), stackFixture())).toBe(false);
    expect(restackBelongsToStack(restackFixture(), { ...stackFixture(), members: [stackMember(9)] })).toBe(false);
  });
  test('publishes changed branches bottom-up with the captured GitHub heads', () => {
    const heads = new Map([['branch-1', 'c'.repeat(40)], ['branch-2', 'd'.repeat(40)], ['branch-3', 'e'.repeat(40)]]);
    const plan = restackPublicationPlan(restackFixture(), stackFixture(), heads);
    expect(plan.publish).toEqual([
      { branch: 'branch-1', expectedRemoteSha: 'c'.repeat(40) },
      { branch: 'branch-2', expectedRemoteSha: 'd'.repeat(40) },
      { branch: 'branch-3', expectedRemoteSha: 'e'.repeat(40) },
    ]);
    expect(plan.blocked).toEqual([]);
  });
  test('skips unchanged branches and already-published remote heads', () => {
    const run = restackFixture();
    run.steps[0] = { branch: 'branch-1', onto: 'main', status: 'unchanged', before: 'a', after: 'a' };
    const stack = stackFixture();
    stack.members[1] = stackMember(2, { headSha: 'b'.repeat(40) });
    const plan = restackPublicationPlan(run, stack);
    expect(plan.publish).toEqual([{ branch: 'branch-3', expectedRemoteSha: 'a'.repeat(40) }]);
  });
  test('blocks a restored branch when its remote advanced beyond the known pre-rebase head', () => {
    const stack = { ...stackFixture(), members: [stackMember(1, { headSha: 'c'.repeat(40) }), stackMember(2), stackMember(3)] };
    const plan = restackPublicationPlan(restackFixture(), stack);
    expect(plan.blocked).toEqual(['branch-1']);
    expect(plan.publish.map((entry) => entry.branch)).toEqual(['branch-2', 'branch-3']);
  });
  test('never publishes paused, failed, aborted or running runs', () => {
    for (const status of ['running', 'paused', 'waitingForSession', 'failed', 'aborted'] as const) {
      expect(restackPublicationPlan(restackFixture({ status }), stackFixture())).toEqual({ publish: [], blocked: [] });
    }
  });
  test('retains explicit unknown summaries and distinguishes null stacks from malformed responses', () => {
    const result = pullStackResultSchema.parse({ connected: true, stack: stackFixture() });
    expect(result.connected && result.stack?.members[0]?.summary).toBe('unknown');
    expect(pullStackResultSchema.parse({ connected: true, stack: null })).toEqual({ connected: true, stack: null });
    expect(pullStackResultSchema.safeParse({ connected: true }).success).toBe(false);
    expect(restackEventSchema.safeParse({ type: 'openchamber:pr-stack.restack', properties: { run: {} } }).success).toBe(false);
  });
});
