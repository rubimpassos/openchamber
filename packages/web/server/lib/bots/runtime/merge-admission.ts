import { botInputDigest } from '../effects.js';
import { botPublicationBranch } from '../publication.js';
import { operations } from '../services/contracts.js';
import { hasSourceControlStringCode as hasSourceControlErrorCode } from '../../source-control/input-guards.js';
import { admissionSchema, authorizationSchema, contextSchema, prStatusSchema, snapshotSchema } from './input-contracts.js';
import { serviceRequestSchema } from './journal.js';
import { requireCheckout, requireDefinition, requireJudgment, requirePullRequest, isRefused } from './invariants.js';
import { runtimeError as error } from './errors.js';
import type { BotDefinition } from '../config.js';
import type { BotItem } from '../schema.js';
import type { RuntimeBot, RuntimeData } from './contracts.js';
import type { RuntimeContext } from './context.js';
import type { RuntimeAdmission, RuntimeProject, RuntimePullRequestStatus, RuntimeSnapshot } from './input-contracts.js';
import type { createRuntimeServiceEffects } from './service-effects.js';
import type { createRuntimeShared } from './shared.js';

const remoteWarning = 'Remote auto-merge may still be active';
const MAX_REVOCATION_ATTEMPTS = 10;

export const createRuntimeMergeAdmission = (
  { journal, itemFor, mutate, transition, now, worktrees, services, serviceContext, pullRequests, config }: RuntimeContext,
  { external, shared: { needsYou, policyFor } }: { readonly external: ReturnType<typeof createRuntimeServiceEffects>; readonly shared: ReturnType<typeof createRuntimeShared> },
) => {
  const { saveData } = journal;
  const freshAdmission = async (projectId: string, project: RuntimeProject, bot: RuntimeBot, item: BotItem) => {
    const snapshot = snapshotSchema.parse(await worktrees.inspect({ project, bot: requireDefinition(bot), item }));
    const { evaluation } = await policyFor(projectId, project, snapshot);
    const judgment = item.judgment;
    if (!judgment || judgment.headSha !== snapshot.headSha || judgment.baseSha !== snapshot.baseSha || judgment.policyFingerprint !== evaluation.policyFingerprint) return null;
    if (evaluation.level === 'human' && judgment.decision === 'auto') return null;
    return snapshot;
  };

  const admissionFor = async (projectId: string, item: BotItem) => {
    const execution = await journal.read(projectId, item.id);
    if (execution.data.admission) return admissionSchema.parse(execution.data.admission);
    const effect = item.effects.findLast((entry) => entry.kind === 'pr.auto-merge');
    if (!effect || !item.pr) return null;
    const captured = execution.operations[effect.key];
    if (!captured) throw error('BOT_EFFECT_REQUEST_MISSING');
    const request = serviceRequestSchema.parse(captured);
    const input = operations['pr.auto-merge'].input.parse(request.input);
    const admission = admissionSchema.parse({ state: 'revoking', action: execution.data.stopRequested ? 'stop' : 'judge',
      key: effect.key, number: input.number, branch: input.branch ?? `bot/${item.id}`, round: execution.data.round ?? 0, headSha: input.headSha,
      baseSha: item.judgment?.baseSha ?? item.pr.baseSha, policyFingerprint: item.judgment?.policyFingerprint ?? 'legacy',
      mode: input.mode, binding: { identityId: request.prepared.authority.identityId,
        identityRevision: request.prepared.authority.identityRevision, target: request.prepared.target } });
    await saveData(projectId, item.id, { admission });
    return admission;
  };
  const requestRevocation = async (projectId: string, item: BotItem, action: 'stop' | 'judge' | 'disabled') => {
    let admission = await admissionFor(projectId, item);
    if (admission && !['revoked', 'merged'].includes(admission.state)) {
      admission = admissionSchema.parse({ ...admission, state: 'revoking', action });
      const update: Partial<RuntimeData> = { admission };
      if (action === 'stop') update.stopRequested = true;
      await saveData(projectId, item.id, update);
    } else if (action === 'stop') await saveData(projectId, item.id, { stopRequested: true });
    return admission;
  };
  const readAuthorization = async (admission: RuntimeAdmission, scope: { readonly project: RuntimeProject; readonly bot: RuntimeBot; readonly item: BotItem }) => authorizationSchema.parse(await services.read({
    ...admission.binding, ...{ scope }, operation: 'github.authorization', input: { number: admission.number, branch: admission.branch },
  }));
  const finishJudgeRound = async (projectId: string, item: BotItem, round: number) => {
    await saveData(projectId, item.id, { round });
    return transition(projectId, item.id, 'judging', { judgment: undefined, proof: { status: 'absent', reason: 'Head, base or repository policy changed; admission requires a new verdict' } });
  };
  const settleRevocation = async (projectId: string, project: RuntimeProject, bot: RuntimeBot, item: BotItem, admission: Extract<RuntimeAdmission, { state: 'revoking' }>) => {
    try {
      let original = item.effects.find((effect) => effect.key === admission.key);
      if (original?.state === 'prepared') {
        const originalKey = original.key;
        await mutate(projectId, item.id, (current) => ({ ...current, effects: current.effects.map((effect) => effect.key === originalKey
          ? { ...effect, state: 'refused', code: 'BOT_ADMISSION_REVOKED', updatedAt: now() } : effect) }));
      }
      if (original && ['dispatching', 'outcome-unknown'].includes(original.state)) {
        const request = serviceRequestSchema.parse((await journal.read(projectId, item.id)).operations[admission.key]);
        await external(projectId, project, bot, item, admission.key, 'pr.auto-merge', request.input, { binding: admission.binding }).catch(() => null);
      }
      for (const operation of ['pr.disable-auto-merge', 'pr.dequeue'] as const) {
        const attempts = (await itemFor(projectId, item.id)).effects;
        const base = `${admission.key}:${operation === 'pr.dequeue' ? 'dequeue' : 'disable'}`;
        let key = base;
        for (let attempt = 1; attempt < MAX_REVOCATION_ATTEMPTS && attempts.some((effect) => effect.key === key && effect.state === 'refused'); attempt += 1) key = `${base}:${attempt}`;
        await external(projectId, project, bot, item, key, operation, { number: admission.number, branch: admission.branch }, { binding: admission.binding });
      }
      const status = await readAuthorization(admission, { project, bot, item });
      if (status.merged) {
        await saveData(projectId, item.id, { admission: { ...admissionFieldsOf(admission), state: 'merged' }, mergedObservation: status });
        if (admission.action === 'judge' && ['merging', 'in-review'].includes(item.state)) {
          if (item.state === 'in-review') await transition(projectId, item.id, 'merging');
          await transition(projectId, item.id, 'closing');
          return true;
        }
        await needsYou(projectId, item.id, 'GitHub merged before revocation was confirmed');
        return false;
      }
      if (status.autoMerge || status.queued) throw error('BOT_REMOTE_AUTHORIZATION_ACTIVE');
      original = (await itemFor(projectId, item.id)).effects.find((effect) => effect.key === admission.key);
      if (original && ['dispatching', 'outcome-unknown'].includes(original.state)) throw error('BOT_ADMISSION_OUTCOME_UNKNOWN');
      if (admission.action === 'judge') {
        await pullRequests.stop({ project, bot, item });
        await finishJudgeRound(projectId, item, admission.round + 1);
      }
      else if (admission.action === 'disabled') await needsYou(projectId, item.id, 'BOT_NOT_ENABLED');
      await saveData(projectId, item.id, { round: admission.round + 1, admission: { ...admissionFieldsOf(admission), state: 'revoked' } });
      return true;
    } catch (failure) {
      await needsYou(projectId, item.id, `${remoteWarning}: ${hasSourceControlErrorCode(failure) ? failure.code : 'BOT_REVOCATION_UNCONFIRMED'}`);
      return false;
    }
  };
  const admissionFieldsOf = (admission: RuntimeAdmission) => {
    const { state: _state, ...fields } = admission;
    if ('action' in fields) { const { action: _action, ...rest } = fields; return rest; }
    return fields;
  };

  const authorizeMerge = async (projectId: string, project: RuntimeProject, bot: BotDefinition, item: BotItem, snapshot: RuntimeSnapshot, status: RuntimePullRequestStatus) => {
    requirePullRequest(item);
    requireJudgment(item);
    requireCheckout(item);
    let admission = await admissionFor(projectId, item);
    if (!admission || admission.state === 'revoked') {
      const round = (await journal.read(projectId, item.id)).data.round ?? 0;
      if (item.branch !== `bot/${item.id}`) throw error('BOT_WORKTREE_BRANCH_MISMATCH');
      const tuple = { number: item.pr.number, branch: botPublicationBranch(item), round, headSha: snapshot.headSha, baseSha: snapshot.baseSha,
        policyFingerprint: item.judgment.policyFingerprint, mode: status.mergeMode };
      const binding = contextSchema.parse(await serviceContext({ project, bot, item, service: 'github', operation: 'pr.auto-merge' })).github;
      if (!binding) throw error('BOT_IDENTITY_REQUIRED');
      admission = admissionSchema.parse({ ...tuple, key: `${item.id}:merge:${botInputDigest(tuple)}`, binding, state: 'active' });
      await saveData(projectId, item.id, { admission });
    }
    if (admission.state !== 'active') throw error('BOT_ADMISSION_REVOKED');
    const admitted = item.effects.find((effect) => effect.key === admission.key);
    if (admitted?.state === 'refused') { await nextJudgeRound(projectId, item); return true; }
    const beforeDispatch = async () => {
      const current = await itemFor(projectId, item.id);
      const execution = await journal.read(projectId, item.id);
      const enabled = (await config.read(projectId)).definitions.some((definition) => definition.id === bot.id && definition.enabled);
      const local = await freshAdmission(projectId, project, bot, current);
      const remote = prStatusSchema.parse(await pullRequests.read({ project, bot, item: current }));
      requireCheckout(current);
      if (!enabled || execution.data.stopRequested || execution.data.admission?.state !== 'active'
        || execution.data.admission.key !== admission.key || (execution.data.round ?? 0) !== admission.round
        || !['merging', 'in-review'].includes(current.state) || !local || local.headSha !== admission.headSha
        || current.pr?.number !== admission.number || botPublicationBranch(current) !== admission.branch
        || local.baseSha !== admission.baseSha || current.judgment?.policyFingerprint !== admission.policyFingerprint
        || remote.headSha !== admission.headSha || remote.baseSha !== admission.baseSha || remote.mergeMode !== admission.mode
        || remote.merged || current.judgment?.decision !== 'auto' && !remote.approved) {
        await requestRevocation(projectId, current, execution.data.stopRequested ? 'stop' : !enabled ? 'disabled' : 'judge');
        throw Object.assign(error('BOT_ADMISSION_STALE'), { state: 'refused' });
      }
    };
    try {
      await external(projectId, project, bot, item, admission.key, 'pr.auto-merge', { number: item.pr.number,
        headSha: admission.headSha, baseSha: admission.baseSha, branch: admission.branch, mode: admission.mode, mergeMethod: 'SQUASH' },
      { binding: admission.binding, beforeDispatch });
    } catch (failure) {
      if (!admitted || admitted.state === 'prepared' || !isRefused(failure)) throw failure;
      await nextJudgeRound(projectId, item);
      return true;
    }
  };

  const nextJudgeRound = async (projectId: string, item: BotItem) => {
    const execution = await journal.read(projectId, item.id);
    const admission = await requestRevocation(projectId, item, 'judge');
    if (admission?.state === 'revoking') return;
    return finishJudgeRound(projectId, item, (execution.data.round ?? 0) + 1);
  };

  return { freshAdmission, admissionFor, requestRevocation, settleRevocation, admissionFieldsOf, authorizeMerge, nextJudgeRound };
};
