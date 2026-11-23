import type { RepositoryPolicyPerson, RepositoryPolicyAreaRule } from './repository-policy.js';
import type { createBotsConfig } from './config.js';

export type RepositoryPolicyApprovals = Readonly<Record<string, string | undefined>>;
type ApprovalStatus = 'approved' | 'changed' | 'unapproved';
export type RepositoryPolicyArea = Readonly<RepositoryPolicyAreaRule> & {
  readonly file: string;
  readonly fingerprint: string;
  readonly status: ApprovalStatus;
  readonly body: string;
};
export type RepositoryPolicyIssue = { readonly file: string; readonly error: string };
export type RepositoryPolicyPeople =
  | { readonly file: string; readonly status: 'missing'; readonly people: readonly [] }
  | { readonly file: string; readonly status: 'invalid'; readonly people: readonly []; readonly error: string }
  | { readonly file: string; readonly status: ApprovalStatus; readonly fingerprint: string;
      readonly content: string; readonly people: readonly RepositoryPolicyPerson[] };
export type RepositoryPolicy = {
  readonly areas: readonly RepositoryPolicyArea[];
  readonly people: RepositoryPolicyPeople;
  readonly issues: readonly RepositoryPolicyIssue[];
  readonly fingerprint: string;
};
export type PolicyService = 'github' | 'jira' | 'discord';
export type PolicyServicePerson<Service extends PolicyService> = Service extends PolicyService
  ? RepositoryPolicyPerson & Readonly<Record<Service, string>> : never;
export type PolicyPeopleResolution<Service extends PolicyService> =
  | { readonly status: 'ask'; readonly reason: string; readonly people: readonly [] }
  | { readonly status: 'resolved'; readonly people: readonly PolicyServicePerson<Service>[] };
export type RepositoryPolicyApproval = {
  readonly config: Pick<ReturnType<typeof createBotsConfig>, 'setApproval'>;
  readonly projectId: string;
  readonly projectPath: string;
  readonly file: string;
  readonly fingerprint: string;
  readonly readPolicy?: (projectPath: string, approvals?: RepositoryPolicyApprovals) => Promise<RepositoryPolicy>;
};
