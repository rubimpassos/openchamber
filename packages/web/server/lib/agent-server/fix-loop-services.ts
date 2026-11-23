import { z } from 'zod';
import { readBoundedBody } from './agent-upstream.js';
import type { createAgentUpstream } from './agent-upstream.js';
import type { FixLoopInput, FixLoopOperation, FixLoopReply } from './fix-loop-contract.js';
import type { LoopIdentity } from '../pr-fix-loop/contracts.js';
import { errorCode, errorField } from '../pr-fix-loop/errors.js';
import { FIX_LOOP_BYTES, FIX_LOOP_INPUT_BYTES, FIX_LOOP_OPERATIONS, FIX_LOOP_SERVICE_ROUTE, FIX_LOOP_TIMEOUT_MS,
  fixLoopServiceError, projectDirectorySchema } from './fix-loop-contract.js';

const codeSchema = z.enum(['agent_fix_loop_invalid_request', 'agent_fix_loop_invalid_response', 'agent_fix_loop_operation_failed',
  'agent_fix_loop_account_unavailable', 'agent_project_unregistered', 'agent_directory_invalid', 'agent_response_too_large',
  'agent_fix_loop_unrelated_result', 'agent_unreachable', 'agent_login_failed', 'agent_session_expired', 'agent_redirected']);
const hostSession = z.object({ data: z.object({ id: z.string().regex(/^ses_[A-Za-z0-9]{1,128}$/),
  location: z.object({ directory: projectDirectorySchema }) }) });
type AccountHandle = { readonly accountId: string };
type ProviderRead<Operation extends 'feedback' | 'author-permission' | 'failed-checks'> =
  Omit<FixLoopInput<Operation>, 'accountId'> & { readonly octokit?: AccountHandle | null | undefined };
type Loop = Pick<LoopIdentity, 'owner' | 'repo' | 'number' | 'readContext'>;
type ReviewInput = { readonly loop: Loop;
  readonly receipt: { readonly commit: string; readonly destination: { readonly ref: string } };
  readonly operation: FixLoopInput<'review-operation'>['operation']; readonly replayOnly?: boolean };
const coordinates = (loop: Loop) => ({ owner: loop.owner, repo: loop.repo, number: loop.number });
const accountIdSchema = z.string().min(1);

export function createAgentFixLoopServices(upstream: Pick<ReturnType<typeof createAgentUpstream>, 'request' | 'json'>) {
  type ContextRequest = (Omit<FixLoopInput<'fetch-head'>, 'context'> | Omit<FixLoopInput<'review-operation'>, 'context'>)
    & { readonly context: Loop['readContext'] };
  type ServiceRequest = FixLoopInput<FixLoopOperation> | ReturnType<typeof readInput> | ContextRequest;
  function call<Operation extends FixLoopOperation>(operation: Operation, value: ServiceRequest): Promise<FixLoopReply<Operation>>;
  async function call(operation: FixLoopOperation, value: ServiceRequest): Promise<FixLoopReply<FixLoopOperation>> {
    const contract = FIX_LOOP_OPERATIONS[operation];
    const input = contract.input.safeParse(value);
    if (!input.success) throw fixLoopServiceError('agent_fix_loop_invalid_request', 400);
    const body = JSON.stringify(input.data);
    if (Buffer.byteLength(body) > FIX_LOOP_INPUT_BYTES) throw fixLoopServiceError('agent_fix_loop_invalid_request', 400);
    try {
      const response = await upstream.request({ path: `${FIX_LOOP_SERVICE_ROUTE}/${operation}`, method: 'POST', body,
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        timeoutMs: ['fetch-head', 'publish', 'failed-checks'].includes(operation) ? 600_000 : FIX_LOOP_TIMEOUT_MS });
      let reply: unknown;
      try { reply = JSON.parse(await readBoundedBody(response, FIX_LOOP_BYTES)); }
      catch (error) { throw fixLoopServiceError(errorCode(error) === 'agent_response_too_large' ? 'agent_response_too_large' : 'agent_fix_loop_invalid_response'); }
      const code = codeSchema.safeParse(errorCode(reply));
      if (response.statusCode !== 200) throw fixLoopServiceError(code.success ? code.data : 'agent_fix_loop_operation_failed',
        response.statusCode >= 400 && response.statusCode <= 599 ? response.statusCode : 502,
        operation === 'review-operation' && errorField(reply, 'reviewNotDispatched') === true ? { fixLoopReviewNotDispatched: true } : {});
      const parsed = contract.reply.safeParse(reply);
      if (!parsed.success) throw fixLoopServiceError('agent_fix_loop_invalid_response');
      return parsed.data;
    } catch (error) {
      if (codeSchema.safeParse(errorCode(error)).success) throw error;
      throw fixLoopServiceError('agent_fix_loop_operation_failed');
    }
  }
  const requireIdentity = (valid: boolean) => { if (!valid) throw fixLoopServiceError('agent_fix_loop_invalid_response'); };
  const readInput = ({ octokit, ...input }: ProviderRead<'feedback'> | ProviderRead<'author-permission'>
    | Omit<ProviderRead<'failed-checks'>, 'contexts'> & { readonly contexts: readonly unknown[] }) => ({ ...input, accountId: octokit?.accountId });
  return {
    getOctokit: async (accountId: string | null | undefined) => { const parsed = accountIdSchema.safeParse(accountId); return parsed.success ? { accountId: parsed.data } : null; },
    readFeedback: (input: ProviderRead<'feedback'>) => call('feedback', readInput(input)),
    readAuthorPermission: async (input: ProviderRead<'author-permission'>) => (await call('author-permission', readInput(input))).permitted,
    readFailedChecks: (input: Omit<ProviderRead<'failed-checks'>, 'contexts'> & { readonly contexts: readonly unknown[] }) => call('failed-checks', readInput(input)),
    readBinding: (directory: string) => call('read-binding', { directory }),
    admit: async (input: FixLoopInput<'admit'>) => {
      const result = await call('admit', input);
      requireIdentity(JSON.stringify(result.context) === JSON.stringify(FIX_LOOP_OPERATIONS.admit.input.parse(input).context)
        && result.pull.owner.toLowerCase() === input.owner.toLowerCase() && result.pull.repo.toLowerCase() === input.repo.toLowerCase()
        && result.pull.number === input.number && result.pull.snapshot.state === 'open'
        && result.pull.branch === result.pull.snapshot.branch);
      return result;
    },
    fetchHead: async (loop: Loop, snapshot: { readonly headSha: string }) => {
      const result = await call('fetch-head', { context: loop.readContext, ...coordinates(loop), head: snapshot.headSha });
      requireIdentity(result.head === snapshot.headSha);
    },
    captureRef: async (input: FixLoopInput<'capture-ref'>) => {
      const result = await call('capture-ref', input);
      requireIdentity(result.commit === input.commit && result.localRef === input.localRef);
    },
    publish: (input: FixLoopInput<'publish'>['input'], commit: string) => call('publish', { input, commit }),
    applyReviewOperation: ({ loop, receipt, operation, replayOnly = false }: ReviewInput) => call('review-operation', {
      context: loop.readContext, ...coordinates(loop), commit: receipt.commit, ref: receipt.destination.ref, operation, replayOnly,
    }),
    readHead: async (input: FixLoopInput<'head-metadata'>) => {
      const result = await call('head-metadata', input);
      requireIdentity(result.head === input.head);
      return result;
    },
    readHostSession: async (sessionId: string) => {
      if (!/^ses_[A-Za-z0-9]{1,128}$/.test(sessionId)) throw fixLoopServiceError('agent_fix_loop_invalid_request', 400);
      try {
        const result = hostSession.parse(await upstream.json(`/api/session/${encodeURIComponent(sessionId)}`)).data;
        requireIdentity(result.id === sessionId);
        return result;
      } catch (error) {
        if (codeSchema.safeParse(errorCode(error)).success) throw error;
        throw fixLoopServiceError('agent_fix_loop_invalid_response');
      }
    },
  };
}
