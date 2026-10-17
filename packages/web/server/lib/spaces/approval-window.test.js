import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { startApprovalGatekeeper } from './approval-test-support.js';

const KEY = 'disposable-key-held-only-by-the-gatekeeper';
const OPENAI = { id: 'openai', upstream: 'https://api.openai.com/v1', header: 'authorization', secret: KEY, model: { providerID: 'openai', modelID: 'gpt-4.1' } };

describe('approval model window', () => {
  let directory;
  let gatekeeper;
  beforeEach(async () => {
    gatekeeper = null;
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'approval-window-'));
    gatekeeper = await startApprovalGatekeeper({ directory });
  });
  afterEach(async () => {
    await gatekeeper?.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const grant = (body = OPENAI) => gatekeeper.request({ method: 'POST', path: '/grants', body });
  const model = (options = {}) => gatekeeper.request({ listener: 'window', method: 'POST', path: '/model/openai/responses', body: { model: 'gpt-4.1', input: 'Hello', store: false }, ...options });

  it.each([
    ['GET', '/models', undefined],
    ['POST', '/responses', { model: 'gpt-4.1', input: 'Olá 世界', tools: [{ type: 'function', name: 'shell', parameters: { type: 'object', properties: {} } }] }],
  ])('allows a normal model workflow using %s %s', async (method, target, body) => {
    // Given a host-selected API key.
    expect((await grant()).status).toBe(200);
    // When a catalog read or a function-tool turn crosses the window.
    const answer = await model({ method, path: `/model/openai${target}`, body });
    // Then the permitted operation reaches the upstream and the body stays unchanged.
    expect(answer.status).toBe(200);
    expect(gatekeeper.seen[0]).toMatchObject({ method, path: `/v1${target}` });
    if (body) expect(JSON.parse(gatekeeper.seen[0].body)).toEqual(body);
  });

  it.each([
    [OPENAI, '/model/openai/responses', '/v1/responses'],
    [{ ...OPENAI, upstream: 'https://chatgpt.com/backend-api/codex', model: { providerID: 'openai', modelID: 'gpt-5.3-codex' } }, '/model/openai/responses', '/backend-api/codex/responses'],
    [{ id: 'anthropic', upstream: 'https://api.anthropic.com/v1', header: 'x-api-key', secret: KEY, model: { providerID: 'anthropic', modelID: 'claude-sonnet-4-6' } }, '/model/anthropic/messages', '/v1/messages'],
    [{ ...OPENAI, id: 'github-copilot', upstream: 'https://api.githubcopilot.com', model: { providerID: 'github-copilot', modelID: 'gpt-5.4' } }, '/model/github-copilot/chat/completions', '/chat/completions'],
    [{ ...OPENAI, id: 'github-copilot', upstream: 'https://api.individual.githubcopilot.com', model: { providerID: 'github-copilot', modelID: 'gpt-5.4' } }, '/model/github-copilot/chat/completions', '/chat/completions'],
  ])('allows model inference with the hidden credential for %j', async (credential, target, expectedPath) => {
    // Given a working controlled TLS upstream and a host-selected supported grant.
    expect((await grant(credential)).status).toBe(200);
    // When a model request crosses the real window listener.
    const body = target.endsWith('/responses') ? { model: credential.model.modelID, input: 'Hello' } : { model: credential.model.modelID, messages: [{ role: 'user', content: 'Hello' }] };
    const answer = await model({ path: target, body, headers: { authorization: 'attacker', 'x-http-method-override': 'DELETE', 'x-original-url': '/repos/a/b', 'x-api-key': 'attacker' } });
    // Then only the permitted model operation reaches that upstream with the real credential.
    expect(answer.status).toBe(200);
    expect(gatekeeper.seen).toEqual([expect.objectContaining({ path: expectedPath, method: 'POST', headers: expect.objectContaining({ [credential.header]: credential.header === 'authorization' ? `Bearer ${KEY}` : KEY }) })]);
    expect(gatekeeper.seen[0].headers).not.toHaveProperty('x-http-method-override');
    expect(gatekeeper.seen[0].headers).not.toHaveProperty('x-original-url');
    expect(JSON.stringify(answer)).not.toContain(KEY);
  });

  it.each([
    { mode: 'open', domains: [] },
    { mode: 'allowlist', domains: ['api.github.com'] },
    { mode: 'allowlist', domains: ['api.openai.com'] },
  ])('rejects network expansion %j and still serves the model', async (network) => {
    // Given an allowed model grant.
    expect((await grant()).status).toBe(200);
    // When a generic network mutation tries to expand access.
    const refused = await gatekeeper.request({ method: 'POST', path: '/network', body: network });
    // Then the mutation fails, CONNECT stays refused, and inference remains usable.
    expect(refused.status).toBe(400);
    expect(await gatekeeper.connect()).toMatch(/^HTTP\/1\.1 403/);
    expect((await model()).status).toBe(200);
    expect(JSON.parse((await gatekeeper.request({ path: '/policy' })).body)).toMatchObject({ mode: 'allowlist', domains: [] });
  });

  it.each([
    { id: 'domain', upstream: 'https://api.github.com' },
    { ...OPENAI, upstream: 'https://api.github.com/repos/a/b/git' },
    { ...OPENAI, upstream: 'https://api.openai.com/v1/../repos' },
    { ...OPENAI, upstream: 'https://api.openai.com/v1?url=https://api.github.com' },
    { ...OPENAI, upstream: 'https://user:password@api.openai.com/v1' },
    { ...OPENAI, headers: { 'x-publish-token': 'unsafe' } },
    { ...OPENAI, id: 'github-copilot', upstream: 'https://api.github.com' },
    { id: 'google', upstream: 'https://generativelanguage.googleapis.com/v1beta', header: 'x-goog-api-key', secret: KEY },
  ])('refuses unsafe grants without disrupting inference %j', async (unsafe) => {
    // Given a supported grant already in use.
    expect((await grant()).status).toBe(200);
    // When a generic grant tries to add a publishing capability or unknown protocol.
    const answer = await grant(unsafe);
    // Then the grant is refused before use and the allowed grant survives.
    expect(answer.status).toBe(400);
    expect((await model()).status).toBe(200);
    expect(gatekeeper.seen).toHaveLength(1);
  });

  it.each([
    ['POST', '/model/openai/repos/a/b/git/refs'],
    ['POST', '/model/openai/git-receive-pack'],
    ['DELETE', '/model/openai/responses'],
    ['POST', '/model/openai/responses?path=/repos'],
    ['POST', '/model/openai/%72esponses'],
    ['POST', '/model/openai/responses/../repos'],
    ['POST', '/model/openai/responses%252f..%252frepos'],
    ['GET', '/model/openai/responses'],
    ['CONNECT', 'api.github.com:443'],
  ])('refuses %s %s at the window', async (method, target) => {
    // Given a positive model control on the same live listener.
    expect((await grant()).status).toBe(200);
    expect((await model()).status).toBe(200);
    // When the caller requests publishing or a path/method outside the model protocol.
    const answer = await model({ method, path: target });
    // Then no additional operation reaches the upstream.
    expect(answer.status).toBe(403);
    expect(gatekeeper.seen).toHaveLength(1);
    const journal = await gatekeeper.request({ path: '/journal' });
    expect(journal.status).toBe(200);
    expect(JSON.parse(journal.body).records.some((entry) => entry.listener === 'window' && entry.decision.startsWith('deny:'))).toBe(true);
  });

  it.each([
    { tools: [{ type: 'mcp', server_url: 'https://api.github.com' }] },
    { mcp_servers: [{ url: 'https://api.github.com' }] },
    { previous_response_id: 'resp_with_remote_tools' },
    { input: [{ type: 'input_image', image_url: 'https://publisher.test/hook' }] },
  ])('refuses model-delegated network work %j', async (unsafe) => {
    // Given an allowed model grant and inference control.
    expect((await grant()).status).toBe(200);
    expect((await model()).status).toBe(200);
    // When the body asks the provider to perform remote work.
    const answer = await model({ body: { model: 'gpt-4.1', input: 'Hello', ...unsafe } });
    // Then the body never reaches the upstream.
    expect(answer.status).toBe(403);
    expect(gatekeeper.seen).toHaveLength(1);
  });

  it('suppresses redirects instead of forwarding a publishing destination', async () => {
    // Given a TLS model upstream that issues a redirect on this request.
    expect((await grant()).status).toBe(200);
    // When the window receives that redirect.
    const answer = await model({ headers: { 'x-request-id': 'redirect' } });
    // Then the client receives a failure with no redirect destination.
    expect(answer.status).toBe(502);
    expect(answer.headers).not.toHaveProperty('location');
    expect(gatekeeper.seen).toHaveLength(1);
  });

  it('keeps ordinary spaces able to grant general window access', async () => {
    // Given a separate ordinary gatekeeper using the same program.
    const ordinaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinary-window-'));
    const ordinary = await startApprovalGatekeeper({ directory: ordinaryDirectory, purpose: 'general' });
    try {
      expect((await ordinary.request({ method: 'POST', path: '/grants', body: { id: 'domain', upstream: 'https://api.openai.com/v1' } })).status).toBe(200);
      // When an ordinary domain window requests a path outside model inference.
      const answer = await ordinary.request({ listener: 'window', method: 'POST', path: '/model/domain/repos/a/b/git/refs', body: {} });
      // Then its existing general window behavior remains available.
      expect(answer.status).toBe(200);
    } finally {
      await ordinary.close();
      fs.rmSync(ordinaryDirectory, { recursive: true, force: true });
    }
  });
});
