import { z } from 'zod';
import { createBotPublication } from '../publication.js';
import type { RuntimeOptions } from './contracts.js';
import type { createRuntimeJournal } from './journal.js';
import type { createRuntimeItemState } from './item-state.js';

type PublicationOptions = Parameters<typeof createBotPublication>[0];
type PublicationExecution = Awaited<ReturnType<PublicationOptions['journal']['read']>>;
type RepositoryRequest = Parameters<ReturnType<typeof createBotPublication>['repositoryContext']>[0];
type GitHubRequest = RepositoryRequest & { readonly identityId: string; readonly identityRevision: number;
  readonly target: { readonly repositoryId: string; readonly owner: string; readonly repo: string };
  readonly scope: Pick<RepositoryRequest, 'project' | 'bot' | 'item'>; readonly operation: 'github.branch-rules'; readonly input: { readonly branch: string } };
type JiraRequest = Parameters<PublicationOptions['services']['read']>[0];
const rulesSchema = z.array(z.object({ type: z.string() }).passthrough());
const operationSchema = z.object({ prepared: z.object({ operation: z.string() }).passthrough().optional() }).passthrough();

export function createRuntimePublication(options: Pick<RuntimeOptions, 'services' | 'worktrees' | 'serviceContext'> & {
  readonly journal: ReturnType<typeof createRuntimeJournal>;
  readonly mutate: ReturnType<typeof createRuntimeItemState>['mutate'];
}) {
  function read(request: Omit<GitHubRequest, 'stage' | 'round' | 'project' | 'bot' | 'item'>): Promise<z.output<typeof rulesSchema>>;
  function read(request: JiraRequest): ReturnType<PublicationOptions['services']['read']>;
  async function read(request: Omit<GitHubRequest, 'stage' | 'round' | 'project' | 'bot' | 'item'> | JiraRequest) {
    const result = await options.services.read(request);
    return request.operation === 'github.branch-rules' ? rulesSchema.parse(result) : result;
  }
  return createBotPublication({ ...options, services: { read }, journal: {
    async read(projectId: string, itemId: string) {
      const entry = await options.journal.read(projectId, itemId);
      const runs = Object.fromEntries(Object.entries(entry.data.runs ?? {}).map(([key, run]) => [key, {
        stage: run.stage, context: run.context?.repositoryRules ? { repositoryRules: {
          branch: run.context.repositoryRules.branch, rules: run.context.repositoryRules.rules,
          sourceIssue: run.context.repositoryRules.sourceIssue,
        } } : {},
      }]));
      const descriptors: Record<string, PublicationExecution['operations'][string]> = {};
      for (const [key, request] of Object.entries(z.record(z.string(), operationSchema).parse(entry.operations))) {
        descriptors[key] = request.prepared ? { prepared: { operation: request.prepared.operation } } : {};
      }
      return { data: { runs }, operations: descriptors };
    },
  } });
}
