import type { SourceControlAPI, SourceControlReadContext, SourceControlMutationContext } from '@openchamber/ui/lib/api/types';
import {
  pullStackResultSchema, restackRunSchema, stackRegistrationSchema, stackRetargetSchema, stackMergeSchema,
} from '@openchamber/ui/lib/api/pull-stacks';
import type { RuntimeFetchOptions } from '@openchamber/ui/lib/runtime-fetch';
import { z } from 'zod';

type StackFetch = (input: string, init?: RuntimeFetchOptions) => Promise<Response>;
type StackAPI = Pick<SourceControlAPI,
  | 'githubPullStack' | 'githubPullStackRegister' | 'githubPullStackRetarget' | 'githubPullStackMerge'
  | 'prStackRestack' | 'prStackRestackGet' | 'prStackRestackContinue' | 'prStackRestackAbort' | 'prStackRestackAskSession'>;
type StackBody = Parameters<StackAPI['prStackRestack']>[0] | Parameters<StackAPI['githubPullStack']>[1]
  | Parameters<StackAPI['githubPullStackRetarget']>[1] | Parameters<StackAPI['githubPullStackMerge']>[1] | SourceControlMutationContext;

const pullBody = ({ owner, repo, number }: Parameters<StackAPI['githubPullStack']>[1]) => ({ owner, repo, number });

const contextQuery = (context: SourceControlReadContext) => new URLSearchParams({
  directory: context.directory, instance: context.instance, repositoryId: context.repositoryId,
  accountId: context.accountId, bindingRevision: String(context.bindingRevision), primaryRemote: context.primaryRemote,
});

const errorSchema = z.object({ error: z.string(), code: z.string().optional() });

class PullStackRequestError extends Error {
  constructor(message: string, readonly code?: string) { super(message); }
}

export function createWebPullStackAPI(fetch: StackFetch): StackAPI {
  const request = async <T extends z.ZodType>(path: string, schema: T, options?: RuntimeFetchOptions): Promise<z.output<T>> => {
    const response = await fetch(path, options);
    const payload: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      const failure = errorSchema.safeParse(payload);
      throw new PullStackRequestError(failure.success ? failure.data.error : response.statusText, failure.success ? failure.data.code : undefined);
    }
    return schema.parse(payload);
  };
  const post = (body?: StackBody): RuntimeFetchOptions => ({
    method: 'POST', headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const stackPath = '/api/source-control/github/pulls/stack';
  const restackPath = '/api/pr-stacks/restack';
  const mutate = async <T extends z.ZodType>(path: string, schema: T,
    context: Parameters<StackAPI['githubPullStackRegister']>[0], options: RuntimeFetchOptions): Promise<z.output<T>> => {
    const receipt = await request(path, z.object({
      status: z.literal('succeeded'), replayed: z.boolean(), result: z.unknown(),
      actor: z.object({ provider: z.literal('github'), instance: z.literal('github.com'), providerAccountId: z.string().regex(/^github\.com#\d+$/) }),
      target: z.object({ repositoryId: z.literal(context.repositoryId), bindingRevision: z.literal(context.bindingRevision),
        primaryRemote: z.literal(context.primaryRemote), number: z.literal(context.target.number), headSha: z.literal(context.target.headSha),
        project: z.object({ id: z.literal(`${context.target.project.owner}/${context.target.project.name}`),
          owner: z.literal(context.target.project.owner), name: z.literal(context.target.project.name) }),
      }),
    }), options);
    return schema.parse(receipt.result);
  };
  return {
    githubPullStack: (context, pull) => {
      const query = contextQuery(context);
      query.set('owner', pull.owner); query.set('repo', pull.repo); query.set('number', String(pull.number));
      return request(stackPath, pullStackResultSchema, { query, headers: { Accept: 'application/json' } });
    },
    githubPullStackRegister: (context, pull) => mutate(`${stackPath}/register`, stackRegistrationSchema, context, post({ ...context, ...pullBody(pull) })),
    githubPullStackRetarget: (context, pull) => mutate(`${stackPath}/retarget`, stackRetargetSchema, context, post({ ...context, ...pullBody(pull), base: pull.base })),
    githubPullStackMerge: (context, pull) => mutate(`${stackPath}/merge`, stackMergeSchema, context, post({ ...context, ...pullBody(pull), method: pull.method })),
    prStackRestack: (input) => request(restackPath, restackRunSchema, post(input)),
    prStackRestackGet: (directory) => request(restackPath, z.object({ run: restackRunSchema.nullable() }), { query: new URLSearchParams({ directory }) }),
    prStackRestackContinue: (id) => request(`${restackPath}/${encodeURIComponent(id)}/continue`, restackRunSchema, post()),
    prStackRestackAbort: (id) => request(`${restackPath}/${encodeURIComponent(id)}/abort`, restackRunSchema, post()),
    prStackRestackAskSession: (id) => request(`${restackPath}/${encodeURIComponent(id)}/ask-session`, restackRunSchema, post()),
  };
}
