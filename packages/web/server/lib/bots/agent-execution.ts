import { botMigrationPathSchema, transferSourceSchema } from '../spaces/transfer-bundle.js';
import { botBoundaryError } from '../agent-server/bot-service-contract.js';
import type { BotServiceOperation, BotServiceReply } from '../agent-server/bot-service-contract.js';
import { checkedBotServiceReply, parseBotServiceInput } from '../agent-server/bot-service-codec.js';
import { createBotExecutionOwner, fail } from './agent-execution-owner.js';
import { createBotExecutionHandlers } from './agent-execution-handlers.js';
import type { CallOptions, ExecutionDependencies, ExecutionScope } from './agent-execution.types.js';
import { assertBotLeadAction } from '../session-lead/bot-guidance.js';

export function createBotExecutionServices(deps: ExecutionDependencies) {
  const owner = createBotExecutionOwner(deps);
  const { gateway, inbox, registeredProject, registeredScope, watchScope, trustRetainedCheckout, worktreesFor } = owner;
  const handlers = createBotExecutionHandlers(owner);
  let stopping = false;
  let shutdown: Promise<void> | null = null;
  const activeProofs = new Map<AbortController, Promise<unknown>>();
  const cleanupTimeoutMs = deps.proofCleanupTimeoutMs ?? 30_000;
  if (!Number.isSafeInteger(cleanupTimeoutMs) || cleanupTimeoutMs < 1 || cleanupTimeoutMs > 60_000) throw new TypeError('Proof cleanup needs a bounded deadline');
  const perform = async <Operation extends BotServiceOperation, Input>(operation: Operation, raw: Input, { signal }: CallOptions = {}): Promise<BotServiceReply<Operation>> => {
    const captured = parseBotServiceInput(operation, raw);
    const allowMissingCheckout = operation === 'worktree-remove' || operation === 'worktree-read-publication'
      || operation === 'worktree-reconcile' && 'operation' in captured && captured.operation === 'remove';
    if ('scope' in captured) await registeredScope(captured.scope, allowMissingCheckout);
    else if ('project' in captured) await registeredProject(captured.project);
    if ('authority' in captured) {
      await registeredProject(captured.authority.project);
      watchScope(captured.authority, 'trustedMigrationPath' in captured ? captured.trustedMigrationPath : undefined,
        'expectedDirectory' in captured ? captured.expectedDirectory : undefined);
    }
    return checkedBotServiceReply(operation, captured, await handlers[operation](captured, { signal }));
  };
  const execute = <Operation extends BotServiceOperation, Input>(operation: Operation, raw: Input, { signal }: CallOptions = {}): Promise<BotServiceReply<Operation>> => {
    if (stopping) return Promise.reject(botBoundaryError('BOT_EXECUTION_STOPPED', 503));
    if (operation !== 'proof') return perform(operation, raw, { signal });
    const controller = new AbortController();
    const cancellation = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    const running = perform(operation, raw, { signal: cancellation });
    activeProofs.set(controller, running);
    void running.then(() => activeProofs.delete(controller), () => activeProofs.delete(controller));
    return running;
  };
  const resolveTransferSource = async <Input>(value: Input, { trustedMigrationPath }: { readonly trustedMigrationPath?: ExecutionScope['trustedMigrationPath'] } = {}) => {
    if (stopping) throw botBoundaryError('BOT_EXECUTION_STOPPED', 503);
    const source = transferSourceSchema.parse(value);
    if (source.kind !== 'bot-checkout') fail('BOT_EXECUTION_CHECKOUT_MISMATCH');
    const project = await registeredProject({ id: source.projectId, path: source.projectDirectory });
    const captured = trustedMigrationPath === undefined ? undefined : botMigrationPathSchema.parse(trustedMigrationPath);
    if (captured && (captured.projectId !== source.projectId || captured.itemId !== source.itemId)) fail('BOT_MIGRATION_PATH_AUTHORITY_MISMATCH');
    const scope = await trustRetainedCheckout({ project, bot: { id: source.botId }, item: { id: source.itemId, botId: source.botId },
      checkoutKey: source.checkoutKey, trustedMigrationPath: captured });
    return worktreesFor(scope).resolveTransferSource(source, { trustedMigrationPath: captured });
  };
  const stop = () => {
    if (shutdown) return shutdown;
    stopping = true;
    for (const controller of activeProofs.keys()) controller.abort();
    const pending = [...activeProofs.values(), Promise.resolve().then(() => gateway.stop())];
    const cleanup = (async () => {
      const deadline = AbortSignal.timeout(cleanupTimeoutMs);
      const { promise: expired, reject } = Promise.withResolvers<never>();
      const expire = () => reject(botBoundaryError('BOT_PROOF_CLEANUP_TIMEOUT', 503));
      deadline.addEventListener('abort', expire, { once: true });
      try {
        const settled = await Promise.race([Promise.allSettled(pending), expired]);
        const failures = settled.filter((result) => result.status === 'rejected').map((result) => result.reason);
        if (failures.length) throw new AggregateError(failures, 'Bot execution cleanup failed');
      } finally { deadline.removeEventListener('abort', expire); }
    })();
    shutdown = Promise.allSettled([cleanup, owner.artifacts.capture.flush()]).then((settled) => {
      const failures: unknown[] = settled.filter((result) => result.status === 'rejected').map((result) => result.reason);
      if (failures.length === 1) throw failures[0];
      if (failures.length) throw new AggregateError(failures, 'Bot execution shutdown could not fully drain');
    });
    return shutdown;
  };
  return Object.freeze({ agentServer: true as const, execute, worktrees: Object.freeze({ resolveTransferSource }),
    artifacts: owner.artifacts,
    assertConversationControlTarget: async (action: string, sessionId: string | undefined) => {
      if (sessionId && (await owner.resolveArtifactBinding(sessionId))?.producer.role === 'conversation') assertBotLeadAction(action);
    },
    handleTool: <Input>(request: Input, options?: Parameters<typeof inbox.request>[1]) => stopping ? Promise.reject(botBoundaryError('BOT_EXECUTION_STOPPED', 503)) : inbox.request(request, options), stop });
}
