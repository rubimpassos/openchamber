import type { PullStack, RestackRun } from '@/lib/api/types';

/** GET and control answers can arrive after a later broadcast of the same run. */
export function latestRestackRun(current: RestackRun | null, incoming: RestackRun): RestackRun {
  if (!current) return incoming;
  if (current.id !== incoming.id) return incoming.createdAt > current.createdAt ? incoming : current;
  if (incoming.updatedAt < current.updatedAt) return current;
  if (incoming.updatedAt === current.updatedAt) {
    const terminal = (run: RestackRun) => ['done', 'failed', 'aborted'].includes(run.status);
    if (terminal(current) || (current.status !== 'running' && incoming.status === 'running')) return current;
  }
  return incoming;
}

export const restackBelongsToStack = (run: RestackRun, stack: PullStack): boolean => {
  const branches = new Set(stack.members.map((member) => member.head));
  return run.trunk === stack.trunk && run.steps.length > 0 && run.steps.every((step) => branches.has(step.branch));
};

type RestackPublication = {
  readonly branch: string;
  readonly expectedRemoteSha: string;
};

/** A restored run can publish only against its old head, or skip an already-published new head. */
type RestackPublicationPlan = {
  publish: RestackPublication[];
  blocked: string[];
};

export function restackPublicationPlan(run: RestackRun, stack: PullStack, capturedHeads?: ReadonlyMap<string, string>): RestackPublicationPlan {
  const publish: RestackPublication[] = [];
  const blocked: string[] = [];
  if (run.status !== 'done') return { publish, blocked };
  const heads = new Map(stack.members.map((member) => [member.head, member.headSha]));
  for (const step of run.steps) {
    if (step.status !== 'done' || !step.after || !step.before || step.after === step.before) continue;
    const remoteHead = heads.get(step.branch);
    if (remoteHead === step.after) continue;
    const lease = capturedHeads?.get(step.branch) ?? (remoteHead === step.before ? remoteHead : undefined);
    if (lease) publish.push({ branch: step.branch, expectedRemoteSha: lease });
    else blocked.push(step.branch);
  }
  return { publish, blocked };
}
