import { connectHost, type GuestPlanAnnotation } from '@openchamber/sdk';

// A plan provider without a panel. The host lists `.plan-shelf/**/*.md` in
// the worktree and asks this frame to describe each file. The plan format is
// this example's own, not one the host knows:
//
//   # Title
//   status: draft | running | blocked | done
//   - [ ] open task
//   - [x] finished task
//
// Progress counts every task line; `status: done` hides Run and Resume.

const host = connectHost();

const TONES = { draft: 'neutral', running: 'info', blocked: 'warning', done: 'success' } as const;
type Status = keyof typeof TONES;
const isStatus = (value: string): value is Status => value in TONES;

const describePlan = (path: string, text: string): GuestPlanAnnotation => {
  const title = /^#\s+(.+)$/m.exec(text)?.[1]?.trim();
  const status = /^status:\s*(\S+)/im.exec(text)?.[1]?.toLowerCase() ?? 'draft';
  const done = (text.match(/^\s*-\s\[[xX]\]\s/gm) ?? []).length;
  const open = (text.match(/^\s*-\s\[\s\]\s/gm) ?? []).length;
  const annotation: GuestPlanAnnotation = { path, progress: { done, total: done + open } };
  if (title) annotation.title = title;
  if (isStatus(status)) annotation.status = { label: status, tone: TONES[status] };
  annotation.actions = status === 'done' ? ['review'] : ['review', 'execute', 'resume'];
  return annotation;
};

host.onPlans(async (request) => {
  const annotations: GuestPlanAnnotation[] = [];
  for (const plan of request.plans) {
    try {
      const { content } = await host.readPlan(request.provider, plan.path);
      annotations.push(describePlan(plan.path, content));
    } catch {
      // A plan this frame cannot read stays listed by its file name.
    }
  }
  return annotations;
});
