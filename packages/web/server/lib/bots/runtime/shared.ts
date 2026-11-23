import { botInputDigest } from '../effects.js';
import { evaluateRepositoryPolicy } from '../repository-policy.js';
import { TERMINAL_ITEM_STATES } from '../schema.js';
import { projectSchema } from './input-contracts.js';
import { humanStates } from './item-state.js';
import { runtimeError as error } from './errors.js';
import type { BotDefinition } from '../config.js';
import type { BotEffect, BotItem } from '../schema.js';
import type { RuntimeContext } from './context.js';
import type { RuntimeProject, RuntimeSnapshot } from './input-contracts.js';

export const mergeEvidence = (left: readonly BotItem['evidence'][number][], right: readonly BotItem['evidence'][number][]) => [...new Map([...left, ...right].map((entry) => [botInputDigest(entry), entry])).values()];
export const localAuthority = (service: BotEffect['authority']['service'], projectId: string, itemId: string) => ({ service, identityId: 'openchamber', revision: 1, target: `${projectId}:${itemId}` });

export const createRuntimeShared = ({ config, store, sources, resolveProject, readPolicy, now, journal, itemFor, transition }: RuntimeContext) => {
  const { saveData } = journal;
  const projectFor = async (projectId: string) => {
    const project = projectSchema.parse(await resolveProject(projectId));
    if (project.id !== projectId) throw error('BOT_PROJECT_MISMATCH');
    return project;
  };
  const needsYou = async (projectId: string, itemId: string, reason: string) => {
    const item = await itemFor(projectId, itemId);
    if (TERMINAL_ITEM_STATES.includes(item.state)) return item;
    if (item.state !== 'needs-you') {
      const execution = await journal.read(projectId, itemId);
      const question = execution.data.pendingQuestion ? execution.data.questions?.[execution.data.pendingQuestion] : undefined;
      await saveData(projectId, itemId, { resumeState: question?.input.resumeState ?? item.state });
    }
    return transition(projectId, itemId, 'needs-you', { wait: { reason, since: now(), channel: 'ui', people: [] } });
  };
  const policyFor = async (projectId: string, project: RuntimeProject, snapshot: RuntimeSnapshot) => {
    const policy = await readPolicy(project.path, (await config.read(projectId)).approvals);
    return { policy, evaluation: evaluateRepositoryPolicy(policy, snapshot.changes) };
  };
  const checkBudgets = async (projectId: string, bot: BotDefinition, items: readonly BotItem[], item: BotItem | null) => {
    const day = new Date(now()).toISOString().slice(0, 10);
    const archived = await store.readArchive(projectId);
    const discovery = sources.usage ? await sources.usage({ projectId, botId: bot.id, day }) : { dailyTotal: 0, complete: true };
    if (bot.limits.dailyTokens !== null && !discovery.complete) return 'BOT_SOURCE_USAGE_UNAVAILABLE';
    const usage = discovery.dailyTotal + [...items, ...archived].filter((entry) => entry.botId === bot.id).reduce((sum, entry) => sum + (entry.tokens.byDay[day] ?? 0), 0);
    if (bot.limits.dailyTokens !== null && usage >= bot.limits.dailyTokens) return 'BOT_DAILY_TOKEN_BUDGET';
    if (item && bot.goalTokenBudget !== null && item.tokens.total >= bot.goalTokenBudget) return 'BOT_GOAL_TOKEN_BUDGET';
    if (item?.state === 'queued' && bot.limits.maxPendingHuman !== null && items.filter((entry) => entry.botId === bot.id && humanStates.has(entry.state)).length >= bot.limits.maxPendingHuman) return 'BOT_PENDING_HUMAN_LIMIT';
    return null;
  };
  return { projectFor, needsYou, policyFor, checkBudgets };
};
