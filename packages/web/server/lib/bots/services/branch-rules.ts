import { z } from 'zod';
import { BotServiceError, branch, githubTarget, parse, providerResult, revision, text } from './contracts.js';
import type { ResolvedBotCredential } from './credentials.js';

export type GitHubBranchRulesCredential = {
  readonly request: ResolvedBotCredential<'github'>['request'];
};

const ruleSchema = z.object({
  type: text, parameters: z.record(z.string(), z.json()).optional(),
  ruleset_id: revision.optional(), ruleset_source: text.optional(),
  ruleset_source_type: z.enum(['Repository', 'Organization', 'Enterprise']).optional(),
  ruleset_enforcement_mode: z.literal('active').optional(),
});
const pageSchema = z.array(ruleSchema).max(100);
const ruleCount = z.object({ totalCount: z.number().int().nonnegative(), pageInfo: z.object({ hasNextPage: z.boolean() }) });
export type GitHubBranchRule = Readonly<z.output<typeof ruleSchema>>;
const ruleOwnersEnvelope = z.object({ errors: z.unknown().optional(), data: z.unknown().optional() });

/** Includes active inherited rules for a proposed name, even before the ref exists. */
export async function readGitHubBranchRules(credential: GitHubBranchRulesCredential, target: unknown, name: string): Promise<readonly GitHubBranchRule[]> {
  const repository = parse(githubTarget.safeParse(target));
  parse(branch.safeParse(name));
  const rules: GitHubBranchRule[] = [];
  for (let page = 1; page <= 10; page += 1) {
    let values;
    try {
      values = providerResult(pageSchema.safeParse(await credential.request({
        path: `/repos/${repository.owner}/${repository.repo}/rules/branches/${encodeURIComponent(name)}?per_page=100&page=${page}`,
      })));
    } catch (error) {
      if (page !== 1 || !(error instanceof BotServiceError) || error.code !== 'BOT_SERVICE_AUTH_REQUIRED' || error.status !== 403) throw error;
      // Private Free repositories refuse REST rules reads even with repository access.
      // Only complete, authorized absence of both rule owners establishes emptiness.
      const response = providerResult(ruleOwnersEnvelope.safeParse(await credential.request({ path: '/graphql', method: 'POST', readOnly: true, body: {
        query: `query BotRepositoryRuleOwners($owner:String!,$repo:String!) { repository(owner:$owner,name:$repo) {
          rulesets(first:1,includeParents:true) { totalCount pageInfo { hasNextPage } }
          branchProtectionRules(first:1) { totalCount pageInfo { hasNextPage } }
        } }`, variables: { owner: repository.owner, repo: repository.repo },
      } })));
      const errors = response.errors;
      if (typeof errors === 'string' && errors.length
        || errors !== null && (typeof errors === 'object' || typeof errors === 'function') && 'length' in errors && errors.length) throw error;
      const data = providerResult(z.object({ repository: z.unknown().optional() }).safeParse(response.data));
      const owners = providerResult(z.object({ rulesets: ruleCount, branchProtectionRules: ruleCount }).safeParse(data.repository));
      if ([owners.rulesets, owners.branchProtectionRules].every((owner) => owner.totalCount === 0 && !owner.pageInfo.hasNextPage)) return [];
      throw error;
    }
    rules.push(...values);
    if (values.length < 100) return rules;
  }
  throw new BotServiceError('BOT_GITHUB_RULES_INCOMPLETE', 'The effective project rules exceed the complete-read limit.');
}
