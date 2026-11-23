import fs from 'node:fs/promises';
import { afterEach, expect, it } from 'vitest';
import { createBotHostTools } from './host-tools.js';
import { createBotAdapterState } from './adapter-state.js';
import { isolatedBotToolReceiptSchema } from './isolated-tools.js';
import { digestMutationInput } from '../source-control/mutation-executor.js';

const roots = [];
afterEach(async () => { for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }); });
const setup = async () => {
  const dataDir = await fs.mkdtemp('/tmp/opencode/host-tools-'); roots.push(dataDir);
  const entry = { projectId: 'p', botId: 'b', itemId: 'i', sessionId: 'ses_fix', directory: '/fixture/checkout', isolated: false, stage: 'fixing' };
  const request = { sessionId: entry.sessionId, callId: 'call', action: 'jira.comment', input: { operationId: 'same', body: 'reply' } };
  const pending = { id: digestMutationInput({ sessionId: request.sessionId, callId: request.callId }), request };
  const session = { id: entry.sessionId, directory: entry.directory, metadata: { openchamber: { automation: {
    source: 'bot', projectId: entry.projectId, botId: entry.botId, itemId: entry.itemId, stage: 'fixing',
  } } } };
  const page = { requests: [pending] }; const settlements = []; const calls = [];
  const execution = { readSession: async () => session, pullTools: async () => page,
    settleTool: async (_entry, value) => { settlements.push(value); return { settled: true }; } };
  const receipts = createBotAdapterState({ dataDir, name: 'host-tool-receipts', schema: isolatedBotToolReceiptSchema });
  const key = { projectId: entry.projectId, itemId: entry.itemId, sessionId: entry.sessionId, id: pending.id };
  const build = (options = {}) => createBotHostTools({ dataDir, execution,
    handleTool: async (input) => { calls.push(input); return { receipt: { id: 'comment' } }; }, ...options });
  return { entry, pending, session, page, settlements, calls, receipts, key, build };
};

it('recovers an interrupted dispatch from its recorded outcome without executing again', async () => {
  // Given
  const fixture = await setup(); const reads = [];
  await fixture.receipts.write(fixture.key, { ...fixture.pending, state: 'dispatching' });
  const result = { receipt: { id: 'original-comment' } };
  const host = fixture.build({ readToolOutcome: async (request) => { reads.push(request); return { state: 'succeeded', result }; } });
  // When
  const forwarded = await host.forward(fixture.entry);
  // Then
  expect(forwarded).toEqual({ forwarded: 1 });
  expect(reads).toEqual([fixture.pending.request]);
  expect(fixture.calls).toEqual([]);
  expect(fixture.settlements).toEqual([{ ...fixture.pending, reply: { ok: true, result } }]);
});

it('keeps an unresolved dispatch durable without executing or settling it', async () => {
  // Given
  const fixture = await setup();
  const receipt = { ...fixture.pending, state: 'dispatching' };
  await fixture.receipts.write(fixture.key, receipt);
  // When
  const forwarding = fixture.build().forward(fixture.entry);
  // Then
  await expect(forwarding).rejects.toMatchObject({ code: 'BOT_HOST_TOOL_OUTCOME_UNKNOWN' });
  expect(await fixture.receipts.read(fixture.key)).toEqual(receipt);
  expect(fixture.calls).toEqual([]);
  expect(fixture.settlements).toEqual([]);
});

it('checks the entire page before forwarding any request', async () => {
  // Given
  const fixture = await setup();
  fixture.page.requests.push({ ...fixture.pending, request: { ...fixture.pending.request, sessionId: 'ses_other' } });
  // When
  const forwarding = fixture.build().forward(fixture.entry);
  // Then
  await expect(forwarding).rejects.toMatchObject({ code: 'BOT_HOST_TOOL_CHANGED' });
  expect(fixture.calls).toEqual([]);
  expect(await fixture.receipts.list()).toEqual([]);
});

it('refuses changed captured input after a receipt already settled', async () => {
  // Given
  const fixture = await setup();
  await fixture.receipts.write(fixture.key, { ...fixture.pending, state: 'settled', reply: { ok: true, result: {} } });
  fixture.pending.request.input.body = 'changed';
  // When
  const forwarding = fixture.build().forward(fixture.entry);
  // Then
  await expect(forwarding).rejects.toMatchObject({ code: 'BOT_HOST_TOOL_CHANGED' });
  expect(fixture.calls).toEqual([]);
  expect(fixture.settlements).toEqual([]);
});

it.each([
  [{ code: 'BOT_OPERATION_FAILED', status: 503, state: 'failed', body: 'private' }, { code: 'BOT_OPERATION_FAILED', status: 503, state: 'failed' }],
  [{ code: 'enterprise_mode', status: 403, state: 'refused' }, { code: 'enterprise_mode', status: 403, state: 'refused' }],
  [new Error('private upstream message'), { code: 'BOT_HOST_TOOL_REFUSED', status: 409, state: 'needs-you' }],
])('settles only the public error receipt when tool execution rejects with %j', async (failure, error) => {
  // Given
  const fixture = await setup();
  const host = fixture.build({ handleTool: async () => { throw failure; } });
  // When
  await host.forward(fixture.entry);
  // Then
  expect(fixture.settlements).toEqual([{ ...fixture.pending, reply: { ok: false, error } }]);
  expect(await fixture.receipts.read(fixture.key)).toEqual({ ...fixture.pending, state: 'settled', reply: { ok: false, error } });
});

it('retains dispatching when a coercible but invalid error status cannot be persisted', async () => {
  // Given
  const fixture = await setup();
  const host = fixture.build({ handleTool: async () => { throw { code: 'BOT_FAILURE', status: '409', state: 'failed' }; } });
  // When
  const forwarding = host.forward(fixture.entry);
  // Then
  await expect(forwarding).rejects.toMatchObject({ name: 'ZodError' });
  expect(await fixture.receipts.read(fixture.key)).toEqual({ ...fixture.pending, state: 'dispatching' });
  expect(fixture.settlements).toEqual([]);
});
