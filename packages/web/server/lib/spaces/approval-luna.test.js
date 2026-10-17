import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { requireApprovalModel } from './approval-profile.js';
import { startApprovalGatekeeper } from './approval-test-support.js';

const MODEL = { providerID: 'openai', modelID: 'gpt-6-luna' };
const KEY = 'disposable-luna-window-control';
const HOSTED = ['web_search', 'file_search', 'image_generation', 'code_interpreter', 'hosted_shell', 'apply_patch', 'skills', 'computer_use', 'mcp', 'tool_search'];

describe.each([
  ['https://api.openai.com/v1', '/v1/responses'],
  ['https://chatgpt.com/backend-api/codex', '/backend-api/codex/responses'],
])('Luna protected inference through %s', (upstream, expectedPath) => {
  let directory;
  let gatekeeper;
  const credential = { id: 'openai', upstream, header: 'authorization', secret: KEY, model: MODEL };
  const request = (body, endpoint = '/responses') => gatekeeper.request({ listener: 'window', method: 'POST', path: `/model/openai${endpoint}`, body });
  const control = async () => {
    expect((await gatekeeper.request({ method: 'POST', path: '/grants', body: credential })).status).toBe(200);
    expect((await request({ model: MODEL.modelID, input: 'Hello' })).status).toBe(200);
  };
  beforeEach(async () => {
    gatekeeper = null;
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'approval-luna-'));
    gatekeeper = await startApprovalGatekeeper({ directory });
  });
  afterEach(async () => {
    await gatekeeper?.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });

  it('carries local function continuations and inert schemas with the hidden credential', async () => {
    // Given an explicitly selected model and a host-only disposable credential.
    expect(requireApprovalModel('pr-fix-loop-approval', MODEL)).toEqual(MODEL);
    expect((await gatekeeper.request({ method: 'POST', path: '/grants', body: credential })).status).toBe(200);
    const schema = { type: 'object', properties: { tools: { type: 'string' }, container: { type: 'string' } } };
    const data = JSON.stringify({ tools: ['mcp'], container: 'local', url: 'https://example.com' });
    const body = { model: MODEL.modelID, store: false, input: [
      { type: 'function_call', call_id: 'local-1', name: 'inspect', arguments: data },
      { type: 'function_call_output', call_id: 'local-1', output: data },
    ], tools: [{ type: 'function', name: 'inspect', parameters: schema }] };
    // When a local tool continuation crosses the actual window listener.
    const answer = await request(body);
    // Then only the selected inference path receives the unchanged data and credential.
    expect(answer.status).toBe(200);
    expect(gatekeeper.seen).toHaveLength(1);
    expect(gatekeeper.seen[0]).toMatchObject({ path: expectedPath, method: 'POST', headers: { authorization: `Bearer ${KEY}` } });
    expect(JSON.parse(gatekeeper.seen[0].body)).toEqual(body);
    expect(JSON.stringify(answer)).not.toContain(KEY);
  });

  it.each(HOSTED)('refuses hosted %s tools after successful inference', async (type) => {
    // Given a successful inference control against this same upstream.
    await control();
    // When the worker requests any documented provider-hosted tool.
    const answer = await request({ model: MODEL.modelID, input: 'Hello', tools: [{ type }] });
    // Then the attempted operation never reaches the upstream.
    expect(answer.status).toBe(403);
    expect(gatekeeper.seen).toHaveLength(1);
  });

  it.each([
    { previous_response_id: 'resp_hosted' }, { conversation: 'hosted-conversation' },
    { container: 'hosted-container' }, { prompt: { id: 'hosted-prompt' } },
    { background: true }, { store: true }, { future_operation: {} },
    { input: [{ role: 'user', content: [{ type: 'input_image', image_url: 'https://example.com' }] }] },
    { input: [{ type: 'mcp_call', server_label: 'publisher', name: 'publish', arguments: '{}' }] },
    { model: 'gpt-6-luna-latest' }, { model: 'gpt-5-search-api' },
  ])('refuses substituted or remote operations %j', async (operation) => {
    // Given a working model-only window.
    await control();
    // When its caller selects hosted state, another model or unknown operational fields.
    const answer = await request({ model: MODEL.modelID, input: 'Hello', ...operation });
    // Then the positive control is the only forwarded request.
    expect(answer.status).toBe(403);
    expect(gatekeeper.seen).toHaveLength(1);
  });

  it('refuses Chat Completions outside the reviewed format', async () => {
    // Given a successful Responses control for the selected model.
    await control();
    // When the caller substitutes the unreviewed Chat format.
    const answer = await request({ model: MODEL.modelID, messages: [{ role: 'user', content: 'Hello' }] }, '/chat/completions');
    // Then no Chat request crosses the window.
    expect(answer.status).toBe(403);
    expect(gatekeeper.seen).toHaveLength(1);
  });

  it('refuses model and provider rebinding without losing the original grant', async () => {
    // Given a working, immutable Luna binding.
    await control();
    // When a host grant tries to substitute another reviewed model or provider.
    for (const replacement of [
      { ...credential, model: { providerID: 'openai', modelID: 'gpt-5.4' } },
      { ...credential, id: 'github-copilot', upstream: 'https://api.githubcopilot.com', model: { providerID: 'github-copilot', modelID: 'gpt-5.4' } },
    ]) expect((await gatekeeper.request({ method: 'POST', path: '/grants', body: replacement })).status).toBe(400);
    // Then the original model remains the only usable inference authority.
    expect((await request({ model: MODEL.modelID, input: 'Still available' })).status).toBe(200);
    expect(gatekeeper.seen).toHaveLength(2);
  });
});
