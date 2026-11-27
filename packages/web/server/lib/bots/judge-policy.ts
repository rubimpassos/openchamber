import { resolvePolicyPeople } from './repository-policy.js';
import type { readRepositoryPolicy, evaluateRepositoryPolicy } from './repository-policy.js';
import type { BotStageReport } from './prompts.js';
import type { BotItem } from './schema.js';

type JudgmentInput = {
  readonly output: BotStageReport['judge'];
  readonly policy: Awaited<ReturnType<typeof readRepositoryPolicy>>;
  readonly evaluation: ReturnType<typeof evaluateRepositoryPolicy>;
  readonly snapshot: Readonly<Pick<NonNullable<BotItem['judgment']>, 'headSha' | 'baseSha'>>;
  readonly required?: readonly { readonly id: string }[];
};

/** The model proposes a verdict; repository policy grants its authority. */
export const admitBotJudgment = ({ output, policy, evaluation, snapshot, required = [] }: JudgmentInput) => {
  const owners = [...new Set([...evaluation.owners, ...output.reviewers])];
  let reviewers: string[] = [];
  let unresolved: string | null = null;
  if (owners.length) {
    const people = resolvePolicyPeople(policy, { owners, service: 'github' });
    switch (people.status) {
      case 'resolved': reviewers = people.people.map((person) => person.github); break;
      case 'ask': unresolved = people.reason; break;
      default: people satisfies never;
    }
  }
  const unproven = required.flatMap(({ id }) => {
    const verdict = output.artifacts.find((entry) => entry.id === id);
    if (verdict?.proven) return [];
    return [{ id, reason: verdict?.reason ?? 'the judge gave no verdict for it' }];
  });
  const decision = evaluation.level === 'human' ? 'review' : unresolved ? 'ask'
    : unproven.length && output.decision === 'auto' ? 'review' : output.decision;
  const questions = [...output.questions, ...(unresolved ? [unresolved] : [])];
  const artifactReason = unproven.length ? ` Unproven artifacts: ${unproven.map((entry) => `${entry.id} (${entry.reason})`).join('; ')}.` : '';
  return {
    requiresAnswer: decision === 'ask' || Boolean(unresolved),
    judgment: { decision, reason: `${evaluation.level === 'human' ? `${evaluation.reason}. Judge: ${output.reason}` : unresolved ?? output.reason}${artifactReason}`,
      reviewers, questions, headSha: snapshot.headSha, baseSha: snapshot.baseSha, policyFingerprint: evaluation.policyFingerprint },
  };
};
