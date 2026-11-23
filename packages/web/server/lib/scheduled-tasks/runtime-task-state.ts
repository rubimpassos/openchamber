import type { ScheduledTask, ScheduledTaskState } from '../projects/contracts.js';
import type { BotScheduledTask } from '../bots/owner-config.js';
import { isNumber } from '../shared/object-guards.js';

export type ScheduledRuntimeTask = ScheduledTask | BotScheduledTask;

export const isProjectTask = (task: ScheduledRuntimeTask): task is ScheduledTask => !task.botId;

export const patchTaskState = (task: ScheduledRuntimeTask, patch: Partial<ScheduledTaskState>): ScheduledRuntimeTask => isProjectTask(task)
  ? { ...task, state: { ...task.state, ...patch } }
  : { ...task, state: { ...task.state, ...patch } };

export const persistedNextRunAt = (task: ScheduledRuntimeTask) => {
  const value = task.state?.nextRunAt;
  return isNumber(value) && Number.isFinite(value) ? value : undefined;
};
