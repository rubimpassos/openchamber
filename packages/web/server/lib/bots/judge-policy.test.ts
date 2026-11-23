import { createHash } from 'node:crypto';
import { expect, expectTypeOf, it } from 'vitest';
import { admitBotJudgment } from './judge-policy.js';
import { evaluateRepositoryPolicy, parseRepositoryPolicyFiles, resolvePolicyPeople } from './repository-policy.js';
import type { BotItem } from './schema.js';

it('admits GitHub reviewers when the exact people bytes are approved', () => {
  // Given an approved directory with distinct person and service identities.
  const file = '.openchamber/people.json';
  const raw = JSON.stringify([{ id: 'lead', name: 'Lead', roles: [], github: 'lead-gh' }]);
  const policy = parseRepositoryPolicyFiles({ directory: 'missing', files: [{ file, status: 'present', raw }] },
    { [file]: createHash('sha256').update(raw).digest('hex') });
  const evaluation = evaluateRepositoryPolicy(policy, [{ newPath: 'src/main.ts' }]);

  // When the judge requests that person.
  const result = admitBotJudgment({ policy, evaluation, snapshot: { headSha: 'head', baseSha: 'base' },
    output: { decision: 'auto', reason: 'Safe', reviewers: ['lead'], questions: [] } });

  // Then admission uses the approved service identity and preserves its stored contract.
  expect(result).toEqual({ requiresAnswer: false, judgment: { decision: 'auto', reason: 'Safe',
    reviewers: ['lead-gh'], questions: [], headSha: 'head', baseSha: 'base', policyFingerprint: policy.fingerprint } });
  expectTypeOf(result.judgment).toExtend<NonNullable<BotItem['judgment']>>();
});

it('asks when an approved person has no identity for the requested service', () => {
  // Given an approved person whose only identity is Jira.
  const file = '.openchamber/people.json';
  const raw = JSON.stringify([{ id: 'lead', name: 'Lead', roles: [], jira: 'lead-jira' }]);
  const policy = parseRepositoryPolicyFiles({ directory: 'missing', files: [{ file, status: 'present', raw }] },
    { [file]: createHash('sha256').update(raw).digest('hex') });
  const evaluation = evaluateRepositoryPolicy(policy, [{ newPath: 'src/main.ts' }]);

  // When GitHub judgment admission requests that person.
  const result = admitBotJudgment({ policy, evaluation, snapshot: { headSha: 'head', baseSha: 'base' },
    output: { decision: 'auto', reason: 'Safe', reviewers: ['lead'], questions: [] } });

  // Then no account is guessed, while the available service still resolves.
  expect(result.requiresAnswer).toBe(true);
  expect(result.judgment).toMatchObject({ decision: 'ask', reviewers: [], questions: ['Person or service identity is unresolved'] });
  const people = resolvePolicyPeople(policy, { owners: ['lead'], service: 'jira' });
  switch (people.status) {
    case 'resolved': {
      for (const person of people.people) expectTypeOf(person.jira).toEqualTypeOf<string>();
      break;
    }
    case 'ask': return expect.unreachable('Approved Jira identity must resolve');
    default: people satisfies never;
  }
});

it('guarantees only the selected identity when the service type is a union', () => {
  // Given a GitHub-only person in an approved directory.
  const file = '.openchamber/people.json';
  const raw = JSON.stringify([{ id: 'lead', name: 'Lead', roles: [], github: 'lead-gh' }]);
  const policy = parseRepositoryPolicyFiles({ directory: 'missing', files: [{ file, status: 'present', raw }] },
    { [file]: createHash('sha256').update(raw).digest('hex') });

  // When a caller's service contract allows either GitHub or Jira.
  const result = resolvePolicyPeople<'github' | 'jira'>(policy, { owners: ['lead'], service: 'github' });

  // Then resolution does not claim the other service identity exists.
  switch (result.status) {
    case 'resolved': {
      const [person] = result.people;
      if (!person) throw new Error('Expected the selected person');
      expectTypeOf(person.jira).toEqualTypeOf<string | undefined>();
      expect(person.jira).toBeUndefined();
      break;
    }
    case 'ask': return expect.unreachable('Approved GitHub identity must resolve');
    default: result satisfies never;
  }
});
