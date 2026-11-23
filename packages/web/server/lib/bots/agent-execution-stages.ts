import { botSessionIdSchema } from '../agent-server/bot-service-contract.js';
import type { OperationHandlers } from '../agent-server/bot-services.types.js';
import type { createBotExecutionOwner } from './agent-execution-owner.js';
import { fail } from './agent-execution-owner.js';

type Owner = ReturnType<typeof createBotExecutionOwner>;

export function createBotExecutionStages(owner: Owner): Pick<OperationHandlers, 'stage-create' | 'stage-dispatch' | 'stage-outcome' | 'stage-reconcile'> {
  const { stageDirectory, runIdentity, runDigest, runs, stageOwners, verifySession } = owner;
  const assertRun: Owner['assertRun'] = owner.assertRun;
  return {
    'stage-create': async (input) => {
      const scope = input.scope;
      await stageDirectory(scope, input.request);
      const key = runIdentity(scope, input.request);
      return runs.own(key, async () => {
        const previous = await runs.read(key);
        if (previous) {
          assertRun(previous, input.request);
          if (!previous.sessionId) fail('BOT_EXECUTION_ALLOCATION_UNKNOWN');
          return { sessionId: previous.sessionId, directory: input.request.directory };
        }
        const record = { scope, request: input.request, digest: runDigest(input.request), state: 'allocating' };
        await runs.write(key, record);
        return stageOwners[input.request.stage].create(input.request, async (created) => {
          if (created.directory !== input.request.directory) fail('BOT_EXECUTION_SESSION_MISMATCH');
          await runs.write(key, { ...record, state: 'created', sessionId: created.sessionId });
        });
      });
    },
    'stage-dispatch': async (input) => {
      const scope = input.scope;
      await stageDirectory(scope, input.request);
      await verifySession(scope, botSessionIdSchema.parse(input.request.sessionId), input.request.stage);
      const key = runIdentity(scope, input.request);
      return runs.own(key, async () => {
        const record = await runs.read(key); assertRun(record, input.request);
        if (record.state === 'dispatched') return { id: record.sessionId, sessionId: record.sessionId };
        if (record.state !== 'created') fail('BOT_EXECUTION_DISPATCH_UNKNOWN');
        await runs.write(key, { ...record, state: 'dispatching' });
        const receipt = await stageOwners[input.request.stage].dispatch(input.request);
        await runs.write(key, { ...record, state: 'dispatched' });
        return receipt;
      });
    },
    'stage-outcome': async (input) => {
      const scope = input.scope;
      await stageDirectory(scope, input.request); await verifySession(scope, botSessionIdSchema.parse(input.request.sessionId), input.request.stage);
      const record = await runs.read(runIdentity(scope, input.request));
      if (record) assertRun(record, input.request);
      return stageOwners[input.request.stage].outcome(input.request);
    },
    'stage-reconcile': async (input) => {
      const scope = input.scope;
      await stageDirectory(scope, input.request);
      const record = await runs.read(runIdentity(scope, input.request));
      if (record) assertRun(record, input.request);
      const sessionId = input.sessionId ?? record?.sessionId ?? input.request.sessionId;
      if (!sessionId) return { state: 'outcome-unknown' };
      const sessionScope = { ...scope, item: { ...scope.item, sessions: { ...scope.item.sessions, [input.request.stage]: sessionId } } };
      await verifySession(sessionScope, sessionId, input.request.stage);
      if (input.kind === 'session.create' && (!record || !record.sessionId)) {
        const key = runIdentity(scope, input.request);
        await runs.own(key, async () => {
          const current = await runs.read(key);
          if (current) assertRun(current, input.request);
          if (!current?.sessionId) await runs.write(key, { scope, request: input.request, digest: runDigest(input.request), state: 'created', sessionId });
        });
      }
      return input.kind === 'session.create' ? { state: 'succeeded', result: { id: sessionId, sessionId } }
        : stageOwners[input.request.stage].reconcile(input.kind, { ...input.request, sessionId }, sessionId);
    },
  };
}
