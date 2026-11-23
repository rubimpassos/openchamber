import { z } from 'zod';
import { buildBotPrompt, parseBotStageOutput } from '../prompts.js';
import { text } from './input-contracts.js';
import { cloneRun, executionRunSchema } from './journal.js';
import { requireCheckout } from './invariants.js';
import { runtimeError as error } from './errors.js';
import { localAuthority, mergeEvidence } from './shared.js';
import type { BotDefinition } from '../config.js';
import type { BotItem } from '../schema.js';
import type { BotStage, BotStageReport } from '../prompts.js';
import type { RuntimeStageContext } from './contracts.js';
import type { RuntimeContext } from './context.js';
import type { createRuntimeShared } from './shared.js';

export const createRuntimeStageRunner = ({ journal, itemFor, mutate, effects, stages, store, now }: RuntimeContext, { checkBudgets }: ReturnType<typeof createRuntimeShared>) => {
  const { saveData } = journal;
  async function runStage(projectId: string, bot: BotDefinition, item: BotItem, stage: 'investigation', context?: RuntimeStageContext): Promise<BotStageReport['investigation'] | null>;
  async function runStage(projectId: string, bot: BotDefinition, item: BotItem, stage: 'fixing', context?: RuntimeStageContext): Promise<BotStageReport['fixing'] | null>;
  async function runStage(projectId: string, bot: BotDefinition, item: BotItem, stage: 'judge', context?: RuntimeStageContext): Promise<BotStageReport['judge'] | null>;
  async function runStage(projectId: string, bot: BotDefinition, item: BotItem, stage: BotStage, context: RuntimeStageContext = {}): Promise<BotStageReport[BotStage] | null> {
    let execution = await journal.read(projectId, item.id);
    const round = execution.data.round ?? 0;
    const runId = `${stage}:${round}`;
    let run = execution.data.runs?.[runId];
    if (!run) {
      requireCheckout(item);
      run = cloneRun({ stage, projectId, itemId: item.id, directory: item.worktree, bot,
        selection: await stages.select(projectId, bot, stage),
        prompt: buildBotPrompt({ stage, bot, item, ...context, feedback: execution.data.feedback }), dispatchedAt: now(), afterIdleId: null,
        tokenBaseline: item.tokens, context,
      });
      await journal.saveRun(projectId, item.id, runId, run);
    }
    const capturedRun = execution.capturedRuns[runId] ?? run;
    const createKey = `${item.id}:${stage}:${round}:create`;
    await effects.run({ projectId, itemId: item.id, key: createKey, kind: 'session.create', authority: localAuthority('opencode', projectId, item.id), request: capturedRun,
      execute: async () => {
        const created = await stages.create(run, async ({ sessionId }) => {
          await mutate(projectId, item.id, (current) => ({ ...current, sessions: { ...current.sessions, [stage]: sessionId } }));
        });
        return { id: created.sessionId, sessionId: created.sessionId };
      },
      reconcile: async () => stages.reconcile('session.create', run, text.parse((await itemFor(projectId, item.id)).sessions[stage])),
    });
    item = await itemFor(projectId, item.id);
    const request = { ...run, sessionId: text.parse(item.sessions[stage]) };
    const promptKey = `${item.id}:${stage}:${round}:prompt`;
    if (!item.effects.some((effect) => effect.key === promptKey)) {
      const budget = await checkBudgets(projectId, bot, (await store.read(projectId)).items, item);
      if (budget) throw error(budget);
    }
    const capturedPrompt = { ...z.record(z.string(), z.json()).parse(capturedRun), sessionId: request.sessionId };
    await effects.run({ projectId, itemId: item.id, key: promptKey, kind: 'session.prompt', authority: localAuthority('opencode', projectId, item.id), request: capturedPrompt,
      execute: () => stages.dispatch({ ...executionRunSchema.parse(run), sessionId: request.sessionId }), reconcile: () => stages.reconcile('session.prompt', request, text.parse(item.sessions[stage])),
    });
    execution = await journal.read(projectId, item.id);
    let outcome = execution.data.outcomes?.[runId];
    if (!outcome) {
      const observed = await stages.outcome(request);
      if (!observed) return null;
      if (observed.state !== 'completed') throw error(observed.state === 'cancelled' ? 'BOT_STAGE_INTERRUPTED' : 'BOT_STAGE_FAILED');
      let output;
      try { output = parseBotStageOutput(stage, observed.text); }
      catch { throw error('BOT_STAGE_OUTPUT_INVALID'); }
      outcome = { ...observed, state: 'completed', output: z.json().parse(JSON.parse(JSON.stringify(output))) };
      await saveData(projectId, item.id, { outcomes: { ...execution.data.outcomes, [runId]: outcome } });
    }
    const output = parseBotStageOutput(stage, JSON.stringify(outcome.output));
    const usage = z.number().int().nonnegative().parse(outcome.tokens);
    const day = new Date(now()).toISOString().slice(0, 10);
    await mutate(projectId, item.id, (current) => {
      const stageTotal = Math.max(current.tokens.byStage[stage], z.number().parse(run.tokenBaseline?.byStage[stage]) + usage);
      const delta = stageTotal - current.tokens.byStage[stage];
      return { ...current, evidence: mergeEvidence(current.evidence, 'evidence' in output ? output.evidence : []), tokens: {
        total: current.tokens.total + delta,
        byStage: { ...current.tokens.byStage, [stage]: stageTotal },
        byDay: { ...current.tokens.byDay, [day]: (current.tokens.byDay[day] ?? 0) + delta },
      } };
    });
    return output;
  }
  return runStage;
};
