import { runtimeError } from './errors.js';
import type { BotItem } from '../schema.js';
import type { BotDefinition } from '../config.js';
import type { RuntimeBot } from './contracts.js';
import { z } from 'zod';

export function requireDefinition(bot: RuntimeBot): BotDefinition {
  if ('models' in bot && bot.models !== undefined) return bot;
  throw runtimeError('BOT_DEFINITION_REQUIRED');
}
export function requireCheckout(item: BotItem): asserts item is BotItem & { worktree: string; branch: string } {
  if (!item.worktree || !item.branch) throw runtimeError('BOT_WORKTREE_REQUIRED');
}
export function requireJudgment(item: BotItem): asserts item is BotItem & { judgment: NonNullable<BotItem['judgment']> } {
  if (!item.judgment) throw runtimeError('BOT_JUDGMENT_REQUIRED');
}
export function requirePullRequest(item: BotItem): asserts item is BotItem & { pr: NonNullable<BotItem['pr']> } {
  if (!item.pr) throw runtimeError('BOT_PULL_REQUEST_REQUIRED');
}
const refusalSchema = z.object({ state: z.literal('refused') });
export const isRefused = (cause: unknown) => refusalSchema.safeParse(cause).success;
