import type { FixLoop } from './prFixLoop';

export const fixLoopStatusKeys = {
  watching: 'prFixLoop.status.watching',
  working: 'prFixLoop.status.working',
  waitingForPush: 'prFixLoop.status.waitingForPush',
  ready: 'prFixLoop.status.ready',
  stopped: 'prFixLoop.status.stopped',
  closed: 'prFixLoop.status.closed',
  limitReached: 'prFixLoop.status.limitReached',
  budgetReached: 'prFixLoop.status.budgetReached',
  error: 'prFixLoop.status.error',
} as const satisfies Record<FixLoop['status'], string>;

/** A retained green sample cannot answer a failed read. */
export const fixLoopCiState = (loop: FixLoop, projectionFailed: boolean): NonNullable<FixLoop['ci']>['state'] => (
  loop.lastError || projectionFailed ? 'unknown' : loop.ci?.state ?? 'unknown'
);
