import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { startApprovalGatekeeper } from './approval-test-support.js';

const MODEL = { providerID: 'openai', modelID: 'gpt-4.1' };
const GRANT = { id: 'openai', upstream: 'https://api.openai.com/v1', header: 'authorization', secret: 'disposable-model-key', model: MODEL };
const LIMITS = { maximum: 16 * 1024, total: 32 * 1024, tokens: 128 };

describe('protected model bodies', () => {
  let directory;
  let gatekeeper;
  const uploads = [];
  beforeEach(async () => {
    gatekeeper = null;
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'approval-bodies-'));
    gatekeeper = await startApprovalGatekeeper({ directory, bodyLimits: LIMITS });
    expect((await gatekeeper.request({ method: 'POST', path: '/grants', body: GRANT })).status).toBe(200);
  });
  afterEach(async () => {
    for (const upload of uploads.splice(0)) upload.abort();
    await gatekeeper?.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const inference = (body = { model: MODEL.modelID, input: 'Hello' }) => gatekeeper.request({ listener: 'window', method: 'POST', path: '/model/openai/responses', body });
  const chat = (body = { model: MODEL.modelID, messages: [{ role: 'user', content: 'Hello' }] }) => gatekeeper.request({ listener: 'window', method: 'POST', path: '/model/openai/chat/completions', body });
  const upload = (options) => { const opened = gatekeeper.openUpload(options); uploads.push(opened); return opened; };

  it.each([
    { model: 'gpt-5-search-api' },
    { model: 'gpt-5-search-api', web_search_options: {} },
    { model: 'unreviewed-inference-model' },
    { model: 'gpt-4.1-search-api' },
    { model: MODEL.modelID, web_search_options: {} },
  ])('refuses hosted or unreviewed model capabilities %j', async (unsafe) => {
    // Given a working host-selected inference model on the same upstream.
    expect((await chat()).status).toBe(200);
    // When a body substitutes a hosted-network model or adds hosted-search options.
    const answer = await chat({ messages: [{ role: 'user', content: 'Hello' }], ...unsafe });
    // Then no second request reaches the upstream.
    expect(answer.status).toBe(403);
    expect(gatekeeper.seen).toHaveLength(1);
  });

  it.each([null, { providerID: 'openai', modelID: 'gpt-5-search-api' }, { providerID: 'openai', modelID: 'unreviewed-model' }, { providerID: 'openai', modelID: 'gpt-4.1-search-api' }])('refuses an unreviewed model on the host control channel %j', async (model) => {
    // Given a working grant for the selected reviewed model.
    expect((await inference()).status).toBe(200);
    // When a generic host grant tries to select an implicit, hosted-search or unknown model.
    const answer = await gatekeeper.request({ method: 'POST', path: '/grants', body: { ...GRANT, model } });
    // Then the unsafe model cannot replace the working grant.
    expect(answer.status).toBe(400);
    expect((await inference()).status).toBe(200);
  });

  it('accepts inert JSON schemas and metadata without interpreting their property names', async () => {
    // Given a local function declaration whose schema uses ordinary application property names.
    const body = { model: MODEL.modelID, input: 'Inspect', tools: [{ type: 'function', name: 'inspect_container', parameters: { type: 'object', properties: { container: { type: 'string' }, tools: { type: 'string' }, url: { type: 'string', default: 'https://example.com' } } } }], metadata: { container: 'worker', tools: 'local' } };
    // When the model receives this local function schema.
    const answer = await inference(body);
    // Then the schema and inert data arrive unchanged.
    expect(answer.status).toBe(200);
    expect(JSON.parse(gatekeeper.seen[0].body)).toEqual(body);
  });

  it('keeps the selected model when another reviewed model is offered on the control channel', async () => {
    // Given the existing binding to GPT-4.1.
    expect((await inference()).status).toBe(200);
    // When a generic grant attempts to replace that binding with another reviewed model.
    const answer = await gatekeeper.request({ method: 'POST', path: '/grants', body: { ...GRANT, model: { ...MODEL, modelID: 'gpt-5.4' } } });
    // Then only the original selected model remains usable.
    expect(answer.status).toBe(400);
    expect((await inference()).status).toBe(200);
    expect((await inference({ model: 'gpt-5.4', input: 'Hello' })).status).toBe(403);
  });

  it('bounds aggregate stalled bodies and recovers inference after client aborts', async () => {
    // Given the production program with a constrained 32 KiB aggregate budget and an inference control.
    expect((await inference()).status).toBe(200);
    const baseline = await gatekeeper.resources();
    const outcomes = [];
    // When 20 accepted HTTP requests each send 15 KiB and stall before their last bytes.
    for (let index = 0; index < 20; index += 1) outcomes.push(await upload().observed);
    const resources = await gatekeeper.resources();
    process.stdout.write(`${JSON.stringify({ control: 'stalled-bodies', baseline: baseline.memory, saturated: resources.memory, bodies: resources.bodies })}\n`);
    // Then only two bodies are retained, excess requests are refused, and the process stays responsive.
    expect(outcomes.filter((outcome) => outcome.status === 503)).toHaveLength(18);
    expect(outcomes.filter((outcome) => outcome.received === 15 * 1024)).toHaveLength(2);
    expect(resources.bodies).toMatchObject({ active: 2, reservedBytes: LIMITS.total, bufferedBytes: 30 * 1024 });
    expect(resources.bodies.peakReservedBytes).toBeLessThanOrEqual(LIMITS.total);
    expect(resources.memory.external - baseline.memory.external).toBeLessThan(8 * 1024 * 1024);
    expect((await gatekeeper.request({ path: '/policy' })).status).toBe(200);
    for (const opened of uploads.splice(0)) opened.abort();
    await gatekeeper.bodiesIdle();
    expect((await inference()).status).toBe(200);
  });

  it('retains a reservation until upstream teardown and releases it when the caller leaves', async () => {
    // Given a complete allowed body whose controlled upstream deliberately keeps its answer open.
    const opened = upload({ hold: true });
    expect((await opened.observed).received).toBe(15 * 1024);
    opened.finish();
    await gatekeeper.upstreamReceived(1);
    expect((await gatekeeper.resources()).bodies).toMatchObject({ active: 1, reservedBytes: LIMITS.maximum, bufferedBytes: 0 });
    // When the caller aborts that exchange.
    opened.abort();
    await gatekeeper.bodiesIdle();
    // Then the reservation is reusable by a normal model turn.
    expect((await inference()).status).toBe(200);
  });

  it.each([
    { metadata: { rows: Array.from({ length: 100 }, () => ({})) } },
    { metadata: { nested: Array.from({ length: 40 }).reduce((nested) => ({ nested }), {}) } },
  ])('rejects excessive parsed structure before JSON allocation %j', async (extra) => {
    // Given a valid inference control and the parser's operation counter.
    expect((await inference()).status).toBe(200);
    const before = (await gatekeeper.resources()).bodies.parses;
    // When a body exceeds structural token or nesting limits while fitting the byte limit.
    const answer = await inference({ model: MODEL.modelID, input: 'Hello', ...extra });
    // Then no JSON parse or upstream work happens, and a following turn still works.
    expect(answer.status).toBe(413);
    expect((await gatekeeper.resources()).bodies.parses).toBe(before);
    expect(gatekeeper.seen).toHaveLength(1);
    expect((await inference()).status).toBe(200);
  });

  it('releases an oversized body without waiting for its missing end', async () => {
    // Given a working allowed model endpoint.
    expect((await inference()).status).toBe(200);
    // When the caller streams more than the per-body limit and never ends.
    const opened = upload({ bytes: LIMITS.maximum + 1024 });
    // Then it receives an immediate refusal and does not strand the aggregate budget.
    expect((await opened.answer).status).toBe(413);
    await gatekeeper.bodiesIdle();
    expect((await inference()).status).toBe(200);
  });

  it.each([
    { condition: 'semantic refusal', request: { body: { model: MODEL.modelID, input: 'Hello', tools: [{ type: 'web_search' }] }, headers: {} }, status: 403 },
    { condition: 'upstream redirect', request: { body: { model: MODEL.modelID, input: 'Hello' }, headers: { 'x-request-id': 'redirect' } }, status: 502 },
    { condition: 'upstream reset', request: { body: { model: MODEL.modelID, input: 'Hello' }, headers: { 'x-request-id': 'reset' } }, status: 502 },
    { condition: 'invalid JSON', request: { rawBody: '{"model":', headers: {} }, status: 403 },
  ])('releases a body after $condition', async ({ request, status }) => {
    // Given a successful normal request whose reservation has completed.
    expect((await inference()).status).toBe(200);
    await gatekeeper.bodiesIdle();
    // When an admitted request fails before or after reaching its upstream.
    const answer = await gatekeeper.request({ listener: 'window', method: 'POST', path: '/model/openai/responses', ...request });
    await gatekeeper.bodiesIdle();
    // Then the failure retains no reservation and does not prevent later inference.
    expect(answer.status).toBe(status);
    expect((await gatekeeper.resources()).bodies).toMatchObject({ active: 0, reservedBytes: 0, bufferedBytes: 0 });
    expect((await inference()).status).toBe(200);
  });

  it('ignores escaped quotes and structural-looking text inside strings', async () => {
    // Given a quoted prompt longer than the structural token budget.
    const body = { model: MODEL.modelID, input: '"\\[{,:}]'.repeat(100) };
    // When the lexical preflight encounters escaped quotes, brackets and separators in text.
    const answer = await inference(body);
    // Then text does not count as JSON nesting or structural tokens.
    expect(answer.status).toBe(200);
    expect(JSON.parse(gatekeeper.seen[0].body)).toEqual(body);
  });

  it('forwards only the validated value when JSON repeats an operational key', async () => {
    // Given a body whose repeated model key could be read differently by an upstream parser.
    const rawBody = '{"model":"gpt-5-search-api","model":"gpt-4.1","input":"Hello"}';
    // When the gatekeeper parses and validates the selected model.
    const answer = await gatekeeper.request({ listener: 'window', method: 'POST', path: '/model/openai/responses', rawBody });
    // Then the upstream receives one unambiguous reviewed selection.
    expect(answer.status).toBe(200);
    expect(gatekeeper.seen[0].body).not.toContain('gpt-5-search-api');
    expect(JSON.parse(gatekeeper.seen[0].body)).toEqual({ model: MODEL.modelID, input: 'Hello' });
  });

  it('ends a stalled body at the read deadline and frees the reservation', async () => {
    // Given the same program with a short read deadline and a working inference control.
    await gatekeeper.close();
    gatekeeper = await startApprovalGatekeeper({ directory, bodyLimits: { ...LIMITS, deadline: 500 } });
    expect((await gatekeeper.request({ method: 'POST', path: '/grants', body: GRANT })).status).toBe(200);
    expect((await inference()).status).toBe(200);
    // When an accepted partial request never supplies its ending bytes.
    const opened = upload();
    expect((await opened.observed).received).toBe(15 * 1024);
    // Then the deadline produces an HTTP refusal and normal inference can continue.
    expect((await opened.answer).status).toBe(408);
    await gatekeeper.bodiesIdle();
    expect((await inference()).status).toBe(200);
  });
});
