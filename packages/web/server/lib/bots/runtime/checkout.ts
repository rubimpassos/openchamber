import { z } from 'zod';
import { buildBotPullRequestBody } from '../prompts.js';
import { botPublicationBranch, botPushInput } from '../publication.js';
import { checkoutSchema, contextSchema, text } from './input-contracts.js';
import { checkoutRequestSchema, cleanupRequestSchema, serviceRequestSchema } from './journal.js';
import { requireCheckout, requirePullRequest, isRefused } from './invariants.js';
import { runtimeError as error } from './errors.js';
import { localAuthority } from './shared.js';
import type { BotDefinition } from '../config.js';
import type { BotItem } from '../schema.js';
import type { RuntimeBot, RuntimeOptions } from './contracts.js';
import type { RuntimeContext } from './context.js';
import type { RuntimeProject, RuntimeSnapshot } from './input-contracts.js';
import type { createRuntimeMergeAdmission } from './merge-admission.js';
import type { createRuntimePublication } from './publication.js';
import type { createRuntimeServiceEffects } from './service-effects.js';

export const createRuntimeCheckout = (
  { journal, mutate, transition, now, effects, worktrees, pullRequests, serviceContext }: RuntimeContext,
  { external, publication, mergeAdmission: { nextJudgeRound, admissionFor } }: {
    readonly external: ReturnType<typeof createRuntimeServiceEffects>;
    readonly publication: ReturnType<typeof createRuntimePublication>;
    readonly mergeAdmission: ReturnType<typeof createRuntimeMergeAdmission>;
  },
) => {
  const { saveData } = journal;
  const ensureCheckout = async (projectId: string, project: RuntimeProject, bot: BotDefinition, item: BotItem) => {
    const key = `${item.id}:worktree`;
    if (!item.effects.some((effect) => effect.key === key)) {
      const context = contextSchema.parse(await serviceContext({ project, bot, item, service: 'github', operation: 'github.checkout' }));
      if (!context.github) throw error('BOT_IDENTITY_REQUIRED');
    }
    const captured = (await journal.read(projectId, item.id)).operations[key];
    const request = checkoutRequestSchema.parse(captured ?? { project, bot, item: { id: item.id, botId: item.botId, source: item.source }, key });
    const record = async (result: Awaited<ReturnType<RuntimeOptions['worktrees']['create']>> | { readonly id: string }) => {
      const checkout = checkoutSchema.parse(result);
      if (checkout.branch !== `bot/${item.id}`) throw error('BOT_WORKTREE_BRANCH_MISMATCH');
      await saveData(projectId, item.id, { checkout });
      return { id: checkout.directory, sha: checkout.baseSha };
    };
    await effects.run({ projectId, itemId: item.id, key, kind: 'worktree.create', authority: localAuthority('git', projectId, item.id), request: captured ?? request,
      execute: async () => record(await worktrees.create(request)),
      reconcile: async () => {
        const result = await worktrees.reconcile(request);
        return result.state === 'succeeded' ? { state: 'succeeded', result: await record(result.result) } : result;
      },
    });
    const checkout = checkoutSchema.parse((await journal.read(projectId, item.id)).data.checkout);
    if (item.worktree !== checkout.directory) return mutate(projectId, item.id, (current) => ({ ...current, worktree: checkout.directory, branch: checkout.branch }));
    return item;
  };

  const publishPullRequest = async (projectId: string, project: RuntimeProject, bot: BotDefinition, item: BotItem, snapshot: RuntimeSnapshot, tool = false) => {
    requireCheckout(item);
    const key = `${item.id}:push:${snapshot.headSha}`;
    publication.assertRemote(item, snapshot, key);
    const pendingPush = item.effects.some((effect) => effect.key === key && effect.kind === 'git.push' && effect.state !== 'succeeded');
    if (snapshot.remoteSha !== snapshot.headSha || pendingPush) {
      const pushed = await external(projectId, project, bot, item, key, 'git.push', botPushInput(item, snapshot), { tool });
      if (pushed.sha !== snapshot.headSha) {
        const result = (await journal.read(projectId, item.id)).data.serviceResults?.[key];
        await worktrees.acceptPublished({ project, bot, item, snapshot, result });
        await nextJudgeRound(projectId, item);
        return null;
      }
    }
    const receipt = await external(projectId, project, bot, item, `${item.id}:pr`, 'pr.open', {
      branch: botPublicationBranch(item), base: snapshot.baseBranch, headSha: snapshot.headSha, title: item.title,
      body: buildBotPullRequestBody(item, (await journal.read(projectId, item.id)).data.fixing?.summary ?? item.description), draft: false,
    }, { tool });
    const number = Number(receipt.id);
    const url = receipt.url;
    if (!Number.isSafeInteger(number) || number < 1 || !url) throw error('BOT_PR_RECEIPT_INVALID');
    item = await mutate(projectId, item.id, (current) => ({ ...current, pr: { number, url, headSha: snapshot.headSha, baseSha: snapshot.baseSha } }));
    await pullRequests.ensureLoop({ project, bot, item });
    return item;
  };

  const cleanup = async (projectId: string, project: RuntimeProject, bot: RuntimeBot, item: BotItem) => {
    const key = `${item.id}:cleanup`;
    const execution = await journal.read(projectId, item.id);
    const captured = execution.operations[key];
    const request = cleanupRequestSchema.parse(captured ?? { project, bot,
      item: { id: item.id, worktree: item.worktree, branch: item.branch }, checkout: checkoutSchema.parse(execution.data.checkout) });
    return effects.run({ projectId, itemId: item.id, key, kind: 'worktree.remove', authority: localAuthority('git', projectId, item.id), request: captured ?? request,
      execute: async (captured) => { await worktrees.remove(cleanupRequestSchema.parse(captured)); return { id: item.id }; },
      reconcile: (captured) => worktrees.reconcile({ ...cleanupRequestSchema.parse(captured), operation: 'remove' }),
    });
  };

  const close = async (projectId: string, project: RuntimeProject, bot: BotDefinition, item: BotItem) => {
    requirePullRequest(item);
    const admission = await admissionFor(projectId, item);
    const admitted = admission && item.effects.find((effect) => effect.key === admission.key);
    if (admitted?.state === 'prepared') {
      await mutate(projectId, item.id, (current) => ({ ...current, effects: current.effects.map((effect) => effect.key === admitted.key
        ? { ...effect, state: 'refused', code: 'BOT_ADMISSION_REVOKED', updatedAt: now() } : effect) }));
    } else if (admitted && ['dispatching', 'outcome-unknown'].includes(admitted.state)) {
      const request = serviceRequestSchema.parse((await journal.read(projectId, item.id)).operations[admission.key]);
      try { await external(projectId, project, bot, item, admission.key, 'pr.auto-merge', request.input, { binding: admission.binding }); }
      catch (failure) { if (!isRefused(failure)) throw failure; }
    }
    await pullRequests.stop({ project, bot, item });
    if (item.source.kind === 'jira') {
      await external(projectId, project, bot, item, `${item.id}:jira:comment`, 'jira.comment', { body: buildBotPullRequestBody(item, `Merged: ${item.pr.url}`) });
      const key = `${item.id}:jira:transition`;
      const rawCaptured = (await journal.read(projectId, item.id)).operations[key];
      const captured = rawCaptured ? serviceRequestSchema.parse(rawCaptured) : undefined;
      if (captured || bot.jira?.doneTransition) {
        let input = captured?.input;
        if (!captured) {
          const binding = contextSchema.parse(await serviceContext({ project, bot, item, service: 'jira', operation: 'jira.transition' })).jira;
          if (!binding?.expectedStatusId) throw error('BOT_JIRA_STATUS_REQUIRED');
          input = { transitionId: text.parse(bot.jira?.doneTransition), expectedStatusId: binding.expectedStatusId };
        }
        await external(projectId, project, bot, item, key, 'jira.transition', z.json().parse(input));
      }
    }
    await cleanup(projectId, project, bot, item);
    return transition(projectId, item.id, 'done');
  };

  return { ensureCheckout, publishPullRequest, cleanup, close };
};
