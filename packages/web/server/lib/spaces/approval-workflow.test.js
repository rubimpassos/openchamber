import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { startApprovalGatekeeper } from './approval-test-support.js';

const SCHEMA = { type: 'object', properties: { container: { type: 'string' }, tools: { type: 'string' }, url: { type: 'string', default: 'https://example.com' } } };
const DATA = { container: 'worker', tools: [{ type: 'mcp', url: 'https://example.com' }] };
const OPENAI = { id: 'openai', upstream: 'https://api.openai.com/v1', header: 'authorization', secret: 'disposable', model: { providerID: 'openai', modelID: 'gpt-4.1' } };
const ANTHROPIC = { id: 'anthropic', upstream: 'https://api.anthropic.com/v1', header: 'x-api-key', secret: 'disposable', model: { providerID: 'anthropic', modelID: 'claude-sonnet-4-6' } };

describe('approval local function workflows', () => {
  let directory;
  let gatekeeper;
  beforeEach(async () => {
    gatekeeper = null;
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'approval-workflow-'));
    gatekeeper = await startApprovalGatekeeper({ directory });
  });
  afterEach(async () => {
    await gatekeeper?.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });

  it.each([null, { providerID: 'openai', modelID: 'gpt-5-search-api' }, { providerID: 'openai', modelID: 'unreviewed-model' }])('refuses an unreviewed first model binding %j', async (model) => {
    // Given a fresh protected gatekeeper with no model binding or grants.
    // When the host offers an implicit or unreviewed model as its first credential.
    const refused = await gatekeeper.request({ method: 'POST', path: '/grants', body: { ...OPENAI, model } });
    // Then the refusal leaves the gatekeeper available for a reviewed inference control.
    expect(refused.status).toBe(400);
    expect((await gatekeeper.request({ method: 'POST', path: '/grants', body: OPENAI })).status).toBe(200);
    expect((await gatekeeper.request({ listener: 'window', method: 'POST', path: '/model/openai/responses', body: { model: OPENAI.model.modelID, input: 'Hello' } })).status).toBe(200);
  });

  it.each([
    {
      endpoint: '/responses', grant: OPENAI,
      body: { model: 'gpt-4.1', input: [{ type: 'function_call', call_id: 'call-1', name: 'inspect_container', arguments: JSON.stringify(DATA) }, { type: 'function_call_output', call_id: 'call-1', output: JSON.stringify(DATA) }], tools: [{ type: 'function', name: 'inspect_container', parameters: SCHEMA }], text: { format: { type: 'json_schema', name: 'result', schema: SCHEMA } } },
    },
    {
      endpoint: '/chat/completions', grant: OPENAI,
      body: { model: 'gpt-4.1', messages: [{ role: 'assistant', content: null, tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'inspect_container', arguments: JSON.stringify(DATA) } }] }, { role: 'tool', tool_call_id: 'call-1', content: JSON.stringify(DATA) }], tools: [{ type: 'function', function: { name: 'inspect_container', parameters: SCHEMA } }], response_format: { type: 'json_schema', json_schema: { name: 'result', schema: SCHEMA } } },
    },
    {
      endpoint: '/messages', grant: ANTHROPIC,
      body: { model: 'claude-sonnet-4-6', max_tokens: 100, messages: [{ role: 'assistant', content: [{ type: 'tool_use', id: 'call-1', name: 'inspect_container', input: DATA }] }, { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call-1', content: JSON.stringify(DATA) }] }], tools: [{ name: 'inspect_container', input_schema: SCHEMA }] },
    },
  ])('preserves inert schemas and local tool data through $endpoint', async ({ endpoint, grant, body }) => {
    // Given the host-selected reviewed model and local function declarations for this protocol.
    expect((await gatekeeper.request({ method: 'POST', path: '/grants', body: grant })).status).toBe(200);
    // When a normal function-call continuation crosses the model window.
    const answer = await gatekeeper.request({ listener: 'window', method: 'POST', path: `/model/${grant.id}${endpoint}`, body });
    // Then data and schemas remain unchanged, despite containing operational-looking property names.
    expect(answer.status).toBe(200);
    expect(JSON.parse(gatekeeper.seen[0].body)).toEqual(body);
  });

  it('refuses a protocol the selected model has not been reviewed for', async () => {
    // Given a reviewed Responses-only model.
    const grant = { ...OPENAI, model: { providerID: 'openai', modelID: 'gpt-5.3-codex' } };
    expect((await gatekeeper.request({ method: 'POST', path: '/grants', body: grant })).status).toBe(200);
    expect((await gatekeeper.request({ listener: 'window', method: 'POST', path: '/model/openai/responses', body: { model: grant.model.modelID, input: 'Hello' } })).status).toBe(200);
    // When the caller substitutes Chat Completions for the reviewed endpoint format.
    const answer = await gatekeeper.request({ listener: 'window', method: 'POST', path: '/model/openai/chat/completions', body: { model: grant.model.modelID, messages: [{ role: 'user', content: 'Hello' }] } });
    // Then only the permitted inference control reaches the upstream.
    expect(answer.status).toBe(403);
    expect(gatekeeper.seen).toHaveLength(1);
  });
});
