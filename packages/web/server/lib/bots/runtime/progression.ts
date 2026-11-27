import { admitBotJudgment } from '../judge-policy.js';
import { prStatusSchema, snapshotSchema, pendingToolSchema, text } from './input-contracts.js';
import { requireCheckout } from './invariants.js';
import { runtimeError as error } from './errors.js';
import type { BotItem } from '../schema.js';
import type { RuntimeBot, RuntimeQuestionDraft } from './contracts.js';
import type { BotDefinition } from '../config.js';
import type { RuntimeContext } from './context.js';
import type { RuntimeProject } from './input-contracts.js';
import type { createRuntimeCheckout } from './checkout.js';
import type { createRuntimeControls } from './controls.js';
import type { createRuntimeFeedback } from './feedback.js';
import type { createRuntimeMergeAdmission } from './merge-admission.js';
import type { createRuntimePublication } from './publication.js';
import type { createRuntimeStageRunner } from './stages.js';
import type { createRuntimeShared } from './shared.js';

export const createRuntimeProgression = (
  { journal, itemFor, mutate, transition, worktrees, pullRequests, questions, runProof, activeProofs, isStopped, presentedArtifacts }: RuntimeContext,
  { shared: { needsYou, policyFor }, runStage, publication, mergeAdmission: { admissionFor, requestRevocation, settleRevocation, freshAdmission, nextJudgeRound, admissionFieldsOf, authorizeMerge },
    checkout: { ensureCheckout, publishPullRequest, close, cleanup, isLocalCheckout }, feedback: { finishQuestionAnswer }, controls: { finishStop } }: {
    readonly shared: ReturnType<typeof createRuntimeShared>;
    readonly runStage: ReturnType<typeof createRuntimeStageRunner>;
    readonly publication: ReturnType<typeof createRuntimePublication>;
    readonly mergeAdmission: ReturnType<typeof createRuntimeMergeAdmission>;
    readonly checkout: ReturnType<typeof createRuntimeCheckout>;
    readonly feedback: ReturnType<typeof createRuntimeFeedback>;
    readonly controls: ReturnType<typeof createRuntimeControls>;
  },
) => {
  const { saveData } = journal;
  const requiredArtifacts = async (projectId: string, bot: BotDefinition, item: BotItem) => {
    if (!bot.artifacts.length) return { presented: [] };
    const execution = await journal.read(projectId, item.id);
    const producer = Object.values(execution.data.runs ?? {}).filter((run) => run.stage !== 'judge').at(-1);
    const presented = (await presentedArtifacts(projectId, item.id)).filter((entry) => !producer || entry.createdAt >= producer.dispatchedAt);
    const missing = bot.artifacts.filter((required) => !presented.some((entry) => entry.requirement === required.id));
    return missing.length ? { missing } : { presented };
  };
  const askForArtifacts = async (projectId: string, item: BotItem, missing: BotDefinition['artifacts'], stage: 'investigating' | 'fixing') => {
    const execution = await journal.read(projectId, item.id);
    const round = execution.data.round ?? 0;
    if (execution.data.artifactsRequested === round) { await needsYou(projectId, item.id, 'BOT_ARTIFACTS_MISSING'); return; }
    const eventId = `artifacts:${round}`;
    const text = `Present these required artifacts with openchamber_render and artifactFor before the work counts as done: ${missing.map((entry) => `${entry.id} (${entry.label})`).join('; ')}.`;
    await saveData(projectId, item.id, { round: round + 1, artifactsRequested: round + 1, feedback: { ...execution.data.feedback, [eventId]: { eventId, text } } });
    await transition(projectId, item.id, stage);
    return true;
  };
  return async (projectId: string, project: RuntimeProject, bot: RuntimeBot, initial: BotItem): Promise<boolean | void> => {
    let item = initial;
    const access = bot.enabled ? bot.projects[projectId] : undefined;
    let admission = await admissionFor(projectId, item);
    const execution = await journal.read(projectId, item.id);
    if (admission?.state === 'merged' && execution.data.stopRequested) return;
    if (admission?.state === 'active' && item.state !== 'closing') {
      if (execution.data.stopRequested || !bot.enabled || access !== 'merge' || !['merging', 'in-review', 'needs-you'].includes(item.state)) {
        admission = await requestRevocation(projectId, item, execution.data.stopRequested ? 'stop' : !bot.enabled || access !== 'merge' ? 'disabled' : 'judge');
      } else if (item.state === 'needs-you') {
        const status = prStatusSchema.parse(await pullRequests.read({ project, bot, item }));
        const snapshot = await freshAdmission(projectId, project, bot, item);
        if (!snapshot || snapshot.headSha !== status.headSha || snapshot.baseSha !== status.baseSha
          || snapshot.headSha !== admission.headSha || snapshot.baseSha !== admission.baseSha
          || item.judgment?.policyFingerprint !== admission.policyFingerprint || status.mergeMode !== admission.mode) {
          admission = await requestRevocation(projectId, item, 'judge');
        }
      }
    }
    if (admission?.state === 'revoking') {
      if (!await settleRevocation(projectId, project, bot, item, admission)) return;
      item = await itemFor(projectId, item.id);
      if (item.state === 'closing') return true;
    }
    if (execution.data.stopRequested) { await finishStop(projectId, project, bot, item); return; }
    if (execution.data.questionAnswer && !execution.data.pendingQuestion) return finishQuestionAnswer(projectId, project, bot, item.id);
    if (execution.data.pendingTool) {
      const request = pendingToolSchema.parse(execution.data.pendingTool);
      const pendingEffect = item.effects.find((entry) => entry.key === request.key);
      await needsYou(projectId, item.id, pendingEffect && 'code' in pendingEffect ? pendingEffect.code : 'BOT_TOOL_OPERATION_PENDING');
      return;
    }
    if (execution.data.pendingQuestion) {
      if (bot.enabled && ['investigating', 'fixing', 'judging'].includes(item.state)) await questions.retry({ project, bot, itemId: item.id });
      return;
    }
    if (!bot.enabled || ['needs-you', 'waiting-answer'].includes(item.state)) return;
    if (item.state === 'queued') item = await transition(projectId, item.id, 'investigating');
    if (access === 'read' && ['fixing', 'proving', 'judging'].includes(item.state)) {
      if ('missing' in await requiredArtifacts(projectId, bot, item)) { await needsYou(projectId, item.id, 'BOT_ARTIFACTS_MISSING'); return; }
      if (item.worktree) await cleanup(projectId, project, bot, item);
      await transition(projectId, item.id, 'done');
      return;
    }
    if (item.state === 'investigating') {
      item = await ensureCheckout(projectId, project, bot, item);
      requireCheckout(item);
      const round = (await journal.read(projectId, item.id)).data.round ?? 0;
      const repositoryRules = await publication.repositoryContext({ project, bot, item, stage: 'investigation', round });
      const investigation = await runStage(projectId, bot, item, 'investigation', { repositoryRules });
      if (!investigation) return;
      await saveData(projectId, item.id, { investigation });
      if (investigation.questions.length) {
        const round = (await journal.read(projectId, item.id)).data.round ?? 0;
        const namingAnswer = !investigation.publicationBranch && repositoryRules?.rules.some((rule) => rule.type === 'branch_name_pattern');
        const request: RuntimeQuestionDraft = { project, bot, itemId: item.id, eventId: `investigation:${round}`, questions: investigation.questions,
          resumeState: namingAnswer ? 'investigating' : 'fixing' };
        if (investigation.requestedRole) request.requestedRole = investigation.requestedRole;
        await questions.ask(request);
        return;
      }
      if (access === 'read') {
        const check = await requiredArtifacts(projectId, bot, item);
        if ('missing' in check) return askForArtifacts(projectId, item, check.missing, 'investigating');
        await cleanup(projectId, project, bot, item);
        await transition(projectId, item.id, 'done');
        return;
      }
      item = await transition(projectId, item.id, 'fixing');
    }
    if (item.state === 'fixing') {
      const execution = await journal.read(projectId, item.id);
      requireCheckout(item);
      if (!await isLocalCheckout(projectId, item)) item = await publication.bind({ project, bot, item, investigation: execution.data.investigation });
      requireCheckout(item);
      const repositoryRules = await publication.repositoryContext({ project, bot, item, stage: 'fixing', round: execution.data.round ?? 0 });
      const fixing = await runStage(projectId, bot, item, 'fixing', { investigation: execution.data.investigation, repositoryRules });
      if (!fixing) return;
      await saveData(projectId, item.id, { fixing });
      item = await transition(projectId, item.id, 'proving');
    }
    if (item.state === 'proving') {
      const snapshot = snapshotSchema.parse(await worktrees.inspect({ project, bot, item }));
      await saveData(projectId, item.id, { snapshot });
      let proof: BotItem['proof'] = { status: 'absent', reason: 'No server proof command configured' };
      if (bot.proof && snapshot.testSha && snapshot.fixSha && snapshot.testFiles?.length) {
        const key = JSON.stringify([projectId, item.id]);
        const controller = new AbortController();
        activeProofs.set(key, controller);
        try {
          if (isStopped() || (await journal.read(projectId, item.id)).data.stopRequested) controller.abort();
          proof = await runProof({
            directory: text.parse(item.worktree), testSha: snapshot.testSha, fixSha: snapshot.fixSha, testFiles: snapshot.testFiles,
            command: bot.proof.command, args: bot.proof.args, isolated: bot.isolated, item,
          }, { signal: controller.signal });
          if (controller.signal.aborted) {
            await mutate(projectId, item.id, (current) => ({ ...current, proof }));
            return !isStopped();
          }
        } finally { activeProofs.delete(key); }
      }
      else if (bot.proof) proof = { status: 'absent', reason: 'The server did not observe separate regression and fix commits with test files' };
      item = await transition(projectId, item.id, 'judging', { proof });
    }
    if (item.state === 'judging') {
      const snapshot = snapshotSchema.parse(await worktrees.inspect({ project, bot, item }));
      if (item.proof.status !== 'absent' && item.proof.fixSha !== snapshot.headSha) item = await mutate(projectId, item.id, (current) => ({ ...current, proof: { status: 'absent', reason: 'The observed head differs from the server proof head' } }));
      const { policy, evaluation } = await policyFor(projectId, project, snapshot);
      const check = await requiredArtifacts(projectId, bot, item);
      if ('missing' in check) return askForArtifacts(projectId, item, check.missing, 'fixing');
      const artifacts = check.presented;
      const judgeContext = { snapshot, policy: { ...evaluation, people: policy.people } };
      const output = await runStage(projectId, bot, item, 'judge', artifacts.length ? { ...judgeContext, artifacts } : judgeContext);
      if (!output) return;
      const execution = await journal.read(projectId, item.id);
      const captured = execution.data.runs?.[`judge:${execution.data.round ?? 0}`]?.context;
      if (!captured?.snapshot || !captured.policy) throw error('BOT_STAGE_CONTEXT_REQUIRED');
      if (captured.snapshot.headSha !== snapshot.headSha || captured.snapshot.baseSha !== snapshot.baseSha || captured.policy.policyFingerprint !== evaluation.policyFingerprint) {
        await nextJudgeRound(projectId, item); return true;
      }
      const { judgment, requiresAnswer } = admitBotJudgment({ output, policy, evaluation, snapshot, required: bot.artifacts });
      const { decision } = judgment;
      item = await mutate(projectId, item.id, (current) => ({ ...current, judgment }));
      if (requiresAnswer) {
        const round = (await journal.read(projectId, item.id)).data.round ?? 0;
        const request: RuntimeQuestionDraft = { project, bot, itemId: item.id, eventId: `judge:${round}`, questions: judgment.questions.length ? judgment.questions : [judgment.reason], people: output.reviewers, resumeState: 'judging' };
        if (output.requestedRole) request.requestedRole = output.requestedRole;
        await questions.ask(request);
        return;
      }
      if (await isLocalCheckout(projectId, item)) {
        await cleanup(projectId, project, bot, item);
        await transition(projectId, item.id, 'done');
        return;
      }
      const published = await publishPullRequest(projectId, project, bot, await itemFor(projectId, item.id), snapshot);
      if (published === null) return true;
      item = published;
      item = await transition(projectId, item.id, decision === 'auto' && access === 'merge' ? 'merging' : 'in-review');
    }
    if (item.state === 'in-review' || item.state === 'merging') {
      const status = prStatusSchema.parse(await pullRequests.read({ project, bot, item }));
      if (status.merged) {
        if (admission?.state === 'active') await saveData(projectId, item.id, {
          admission: { ...admissionFieldsOf(admission), state: 'merged' }, mergedObservation: status,
        });
        if (item.state === 'in-review') item = await transition(projectId, item.id, 'merging');
        item = await transition(projectId, item.id, 'closing');
      } else {
        const snapshot = await freshAdmission(projectId, project, bot, item);
        const admission = await admissionFor(projectId, item);
        if (!snapshot || status.headSha !== snapshot.headSha || status.baseSha !== snapshot.baseSha
          || admission?.state === 'active' && (admission.headSha !== snapshot.headSha || admission.baseSha !== snapshot.baseSha
            || admission.policyFingerprint !== item.judgment?.policyFingerprint || admission.mode !== status.mergeMode)) {
          await nextJudgeRound(projectId, item); return true;
        }
        if (access !== 'merge') {
          if (item.state === 'merging') await transition(projectId, item.id, 'in-review');
          return;
        }
        if (item.state === 'in-review' && !status.approved) return;
        if (item.state === 'in-review') item = await transition(projectId, item.id, 'merging');
        return authorizeMerge(projectId, project, bot, item, snapshot, status);
      }
    }
    if (item.state === 'closing') await close(projectId, project, bot, item);
  };
};
