import express from 'express';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { Router } from '../shared/http-contracts.js';
import type { createFixLoopGitServices } from '../source-control/fix-loop-git.js';
import type { readPullFeedback, readFeedbackAuthorPermission, readFailedChecks as readGitHubFailedChecks } from '../github/pr-feedback.js';
import type { FixLoopInput, FixLoopOperation, FixLoopReply } from './fix-loop-contract.js';
import type { ReadTransferProjectSettings } from './registered-transfer-project.js';
import { errorCode, errorField } from '../pr-fix-loop/errors.js';
import { registeredTransferDirectory } from './registered-transfer-project.js';
import { createAgentFixLoopProject } from './fix-loop-project.js';
import { fitFeedback } from './fix-loop-feedback-contract.js';
import { FIX_LOOP_BYTES, FIX_LOOP_INPUT_BYTES, FIX_LOOP_OPERATIONS, FIX_LOOP_SERVICE_ROUTE,
  fixLoopServiceError, headInputSchema } from './fix-loop-contract.js';
import { streamBundle, withBundleDirectory } from '../spaces/transfer-bundle.js';

type Input = FixLoopInput<FixLoopOperation>;
type Reply = FixLoopReply<FixLoopOperation>;
type FailureReply = { readonly code: string; reviewNotDispatched?: boolean };
type ProjectOptions = Parameters<typeof createAgentFixLoopProject>[0];
export type FixLoopServiceRoutesOptions = ProjectOptions & {
  readonly agentServer: boolean;
  readonly readSettings: ReadTransferProjectSettings;
  readonly gitServices: () => ReturnType<typeof createFixLoopGitServices>;
  readonly getOctokit: (accountId: string) => Promise<Parameters<typeof readPullFeedback>[0]['octokit'] | null>;
  readonly readFeedback: typeof readPullFeedback;
  readonly readAuthorPermission: typeof readFeedbackAuthorPermission;
  readonly readFailedChecks: typeof readGitHubFailedChecks;
  readonly projectServices?: ReturnType<typeof createAgentFixLoopProject>;
};

export function registerFixLoopServiceRoutes(app: Router, { agentServer, readSettings, gitServices, getOctokit,
  readFeedback, readAuthorPermission, readFailedChecks, dataDir, resolveGitPath, environment, projectServices }: FixLoopServiceRoutesOptions) {
  if (!agentServer) return;
  const project = projectServices ?? createAgentFixLoopProject({ dataDir, resolveGitPath, environment });
  const parse = express.json({ limit: FIX_LOOP_INPUT_BYTES });
  const directoryOf = (input: Input) => 'directory' in input ? input.directory : 'context' in input ? input.context.directory : input.input.directory;
  const registered = async <Value extends Input>(input: Value): Promise<Value> => {
    const directory = await registeredTransferDirectory(directoryOf(input), readSettings);
    if ('context' in input) return { ...input, context: { ...input.context, directory } };
    if ('input' in input) return { ...input, input: { ...input.input, directory } };
    return { ...input, directory };
  };
  const clientFor = async (accountId: string) => {
    const client = await getOctokit(accountId);
    if (!client) throw fixLoopServiceError('agent_fix_loop_account_unavailable', 403);
    return client;
  };
  const operation = <Value extends Input, RawReply>(contract: { input: z.ZodType<Value>; reply: z.ZodType<Reply> }, execute: (input: Value) => Promise<RawReply>) =>
    (req: import('../shared/http-contracts.js').Request) => {
      const input = contract.input.safeParse(req.body);
      if (!input.success) return null;
      return async () => {
        const canonical = await registered(input.data);
        const result = contract.reply.safeParse(await execute(canonical));
        if (!result.success) throw fixLoopServiceError('agent_fix_loop_invalid_response');
        return { input: input.data, canonical, result: result.data };
      };
    };
  const operations = {
    admit: operation(FIX_LOOP_OPERATIONS.admit, async (input) => gitServices().admit(input)),
    feedback: operation(FIX_LOOP_OPERATIONS.feedback, async (input) => {
        const fitted = fitFeedback(await readFeedback({ ...input, octokit: await clientFor(input.accountId) }),
          { mentionText: input.mentionText, cap: FIX_LOOP_BYTES });
        if (!fitted) throw fixLoopServiceError('agent_response_too_large');
        return fitted;
    }),
    'author-permission': operation(FIX_LOOP_OPERATIONS['author-permission'], async (input) => ({ permitted: await readAuthorPermission({ ...input, octokit: await clientFor(input.accountId) }) })),
    'failed-checks': operation(FIX_LOOP_OPERATIONS['failed-checks'], async (input) => readFailedChecks({ ...input, octokit: await clientFor(input.accountId) })),
    'read-binding': operation(FIX_LOOP_OPERATIONS['read-binding'], async (input) => gitServices().readBinding(input.directory)),
    'fetch-head': operation(FIX_LOOP_OPERATIONS['fetch-head'], async (input) => {
        await gitServices().fetchHead({ ...input, directory: input.context.directory, readContext: input.context }, { headSha: input.head });
        return { head: input.head };
    }),
    'capture-ref': operation(FIX_LOOP_OPERATIONS['capture-ref'], async (input) => project.captureRef(input)),
    'head-metadata': operation(FIX_LOOP_OPERATIONS['head-metadata'], async (input) => project.readHead(input)),
    publish: operation(FIX_LOOP_OPERATIONS.publish, async (input) => {
        const result = await gitServices().publish(input.input, input.commit);
        if (result?.state !== 'succeeded') throw fixLoopServiceError('agent_fix_loop_operation_failed', 409);
        return { state: 'succeeded' };
    }),
    'review-operation': operation(FIX_LOOP_OPERATIONS['review-operation'], async (input) => {
        await gitServices().applyReviewOperation({ loop: { owner: input.owner, repo: input.repo, number: input.number, readContext: input.context },
          receipt: { commit: input.commit, destination: { ref: input.ref } }, operation: input.operation, replayOnly: input.replayOnly });
        return { ok: true };
    }),
  };
  const operationName = z.enum(['admit', 'feedback', 'author-permission', 'failed-checks', 'read-binding', 'fetch-head', 'capture-ref', 'head-metadata', 'publish', 'review-operation']);
  app.post(`${FIX_LOOP_SERVICE_ROUTE}/:operation`, (req, res, next) => {
    parse(req, res, (error) => error ? res.status(400).json({ code: 'agent_fix_loop_invalid_request' }) : next());
  }, async (req, res) => {
    res.set('Cache-Control', 'no-store');
    const name = operationName.safeParse(req.params.operation);
    const perform = name.success ? operations[name.data](req) : null;
    if (!perform || new URL(req.originalUrl, 'http://agent').search || Buffer.byteLength(JSON.stringify(req.body)) > FIX_LOOP_INPUT_BYTES) {
      return res.status(400).json({ code: 'agent_fix_loop_invalid_request' });
    }
    try {
      const { input, canonical, result } = await perform();
      if (req.params.operation === 'admit' && 'context' in result && 'context' in canonical && 'context' in input) {
        if (result.context.directory !== canonical.context.directory) throw fixLoopServiceError('agent_fix_loop_invalid_response');
        result.context.directory = input.context.directory;
      }
      const body = JSON.stringify(result);
      if (Buffer.byteLength(body) > FIX_LOOP_BYTES) throw fixLoopServiceError('agent_response_too_large');
      return res.type('json').send(body);
    } catch (error) {
      const parsedCode = z.enum(['agent_project_unregistered', 'agent_directory_invalid', 'agent_fix_loop_account_unavailable',
        'agent_fix_loop_invalid_response', 'agent_response_too_large', 'agent_fix_loop_unrelated_result']).safeParse(errorCode(error));
      const code = parsedCode.success ? parsedCode.data : 'agent_fix_loop_operation_failed';
      const status = errorField(errorField(error, 'sourceControlResponse'), 'status') ?? errorField(error, 'statusCode') ?? errorField(error, 'status');
      const reply: FailureReply = { code };
      if (req.params.operation === 'review-operation' && errorField(error, 'fixLoopReviewNotDispatched') === true) reply.reviewNotDispatched = true;
      const parsedStatus = z.number().int().min(400).max(599).safeParse(status);
      return res.status(code === 'agent_project_unregistered' || status === 401 ? 403 : parsedStatus.success ? parsedStatus.data : 502)
        .json(reply);
    }
  });
  app.get(`${FIX_LOOP_SERVICE_ROUTE}/head-bundle`, async (req, res) => {
    const query = new URL(req.originalUrl, 'http://agent').searchParams;
    const input = headInputSchema.safeParse(Object.fromEntries(query));
    if (!input.success || [...query.keys()].some((key) => query.getAll(key).length !== 1)) return res.status(400).json({ code: 'agent_fix_loop_invalid_request' });
    try {
      const canonical = await registered(input.data);
      await withBundleDirectory({ caps: project.caps, temporaryDirectory: path.join(dataDir, 'fix-loop-transfer') }, async ({ directory }) => {
        const file = path.join(directory, 'head.bundle');
        await project.exportHead(canonical, file);
        res.type('application/x-git-bundle');
        await streamBundle(createReadStream(file), res, project.caps);
      });
    } catch (error) {
      if (res.headersSent) return res.destroy();
      return res.status(errorCode(error) === 'agent_project_unregistered' ? 403 : 502)
        .json({ code: errorCode(error) === 'agent_project_unregistered' ? 'agent_project_unregistered' : 'agent_fix_loop_operation_failed' });
    }
  });
}
