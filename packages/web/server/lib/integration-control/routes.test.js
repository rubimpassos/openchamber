import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createNativeFailureFixture } from './native-failure-fixture.js';
import { MAX_BODY_BYTES, parseResponse } from './contract.js';
import { createTestApp, requestBody } from './test-app.js';

let fixture;
let logs;
beforeEach(async () => {
  logs = ['log', 'warn', 'error'].map((method) => vi.spyOn(console, method).mockImplementation(() => {}));
  fixture = await createTestApp();
});
afterEach(async () => {
  expect(JSON.stringify(logs.map((log) => log.mock.calls)).includes(fixture.token)).toBe(false);
  await fixture.close();
  vi.restoreAllMocks();
});
const send = (body) => fixture.request.post('/api/openchamber/integration/control')
  .set('Authorization', `Bearer ${fixture.token}`).send(body);

describe('integration route through production bootstrap and native control service', () => {
  it.each([
    ['projects.list', {}, { projects: [{ id: 'alpha', label: 'Alpha' }] }],
    ['session.list', { projectId: 'alpha', limit: 1 }, { sessions: [{ id: 'human', title: 'Human' }] }],
    ['session.create', { projectId: 'alpha', prompt: 'Hello' }, { sessionId: 'created', promptDispatched: true }],
    ['session.send', { projectId: 'alpha', sessionId: 'human', prompt: 'Hello' }, { sessionId: 'human', promptDispatched: true }],
    ['session.fork', { projectId: 'alpha', sessionId: 'human', prompt: 'Hello' }, { sessionId: 'forked', sourceSessionId: 'human', promptDispatched: true }],
    ['session.status', { projectId: 'alpha', sessionId: 'human' }, { sessionId: 'human', sessionStatus: { type: 'idle' } }],
    ['session.messages', { projectId: 'alpha', sessionId: 'human', lastAssistant: true }, { sessionId: 'human', sessionStatus: { type: 'idle' }, messages: [{ id: 'msg', role: 'assistant', text: 'Hello' }] }],
  ])('%s executes native control and projects only contracted fields', async (action, input, data) => {
    const body = requestBody(action, input);
    const response = await send(body);
    expect(response.status).toBe(200);
    expect(parseResponse(response.text).success).toBe(true);
    expect(response.body).toEqual({ ...body, input: undefined, domainId: 'alpha', ok: true, data });
    expect(fixture.execute).toHaveBeenCalledTimes(1);
    const [, controlInput, , options] = fixture.execute.mock.calls[0];
    expect(controlInput).not.toHaveProperty('projectId');
    expect(options.signal).toBeInstanceOf(AbortSignal);
    expect(options.signal.aborted).toBe(false);
    expect(response.text.includes(fixture.root)).toBe(false);
  });

  it.each([
    ['session.create', { projectId: 'beta' }, 403, 'PROJECT_DENIED'],
    ['session.send', { projectId: 'alpha', sessionId: 'foreign', prompt: 'No' }, 404, 'SESSION_NOT_FOUND'],
    ['session.status', { projectId: 'alpha', sessionId: 'missing' }, 404, 'SESSION_NOT_FOUND'],
    ['browser.open', {}, 400, 'INVALID_REQUEST'],
    ['memory.read', {}, 400, 'INVALID_REQUEST'],
    ['schedule.list', {}, 400, 'INVALID_REQUEST'],
    ['session.create', { projectId: 'alpha', directory: '/tmp' }, 400, 'INVALID_REQUEST'],
  ])('%s rejects disallowed input without dispatch', async (action, input, status, code) => {
    const response = await send(requestBody(action, input));
    expect(response.status).toBe(status);
    expect(response.body.error.code).toBe(code);
    expect(fixture.execute).not.toHaveBeenCalled();
  });

  it('reloads revoked policy and denies action grants before execute', async () => {
    fixture.policy.credentials[0].actions = ['projects.list'];
    await fixture.savePolicy();
    const denied = await send(requestBody('session.create', { projectId: 'alpha' }));
    expect(denied.status).toBe(403);
    expect(denied.body.error.code).toBe('ACTION_DENIED');
    expect(fixture.execute).not.toHaveBeenCalled();
    fixture.policy.credentials[0].enabled = false;
    await fixture.savePolicy();
    expect((await send(requestBody())).status).toBe(401);
    expect(fixture.execute).not.toHaveBeenCalled();
  });

  it('fails closed when policy cannot be loaded', async () => {
    vi.stubEnv('OPENCHAMBER_INTEGRATION_POLICY_FILE', `${fixture.root}/missing.json`);
    const response = await send(requestBody());
    expect(response.status).toBe(503);
    expect(response.body.error.code).toBe('POLICY_UNAVAILABLE');
    expect(fixture.execute).not.toHaveBeenCalled();
  });

  it.each([['malformed', '{'], ['oversized', ' '.repeat(MAX_BODY_BYTES + 1)]])('rejects %s raw body without dispatch', async (_name, raw) => {
    const response = await fixture.request.post('/api/openchamber/integration/control')
      .set('Content-Type', 'application/json').set('Authorization', `Bearer ${fixture.token}`).send(raw);
    expect(response.status).toBe(raw.length > MAX_BODY_BYTES ? 413 : 400);
    expect(response.body.error.code).toBe('INVALID_REQUEST');
    expect(fixture.execute).not.toHaveBeenCalled();
  });

  it('retains sanitized partial creation errors', async () => {
    const native = await createNativeFailureFixture();
    let response;
    try {
      response = await native.request.post('/api/openchamber/integration/control')
        .set('Authorization', `Bearer ${native.token}`)
        .send(requestBody('session.create', { projectId: 'alpha', prompt: 'private-prompt' }));
      expect(native.calls).toEqual({ creates: 1, dispatches: 1 });
    } finally {
      await native.close();
    }
    expect(response.status).toBe(500);
    expect(parseResponse(response.text).success).toBe(true);
    expect(response.body.error).toEqual({ code: 'INVALID_REQUEST', message: 'Invalid integration request.', partial: true, sessionId: 'created' });
    expect(response.text.includes('Upstream')).toBe(false);
    expect(response.text.includes(fixture.token)).toBe(false);
    expect(response.text.includes(fixture.root)).toBe(false);
    expect(response.text).not.toContain('private-upstream-conversation');
  });

  it.each(['success', 'unauthorized', 'policy', 'scope', 'failure', 'malformed', 'oversized'])('audits %s once with metadata only', async (kind) => {
    // Given sensitive input/output and an outcome at each receiver boundary.
    const body = requestBody('session.create', { projectId: 'alpha', prompt: 'private-prompt' });
    let status = 200;
    if (kind === 'unauthorized') { fixture.policy.credentials[0].enabled = false; await fixture.savePolicy(); status = 401; }
    if (kind === 'policy') { vi.stubEnv('OPENCHAMBER_INTEGRATION_POLICY_FILE', `${fixture.root}/missing`); status = 503; }
    if (kind === 'scope') { body.input.projectId = 'beta'; status = 403; }
    if (kind === 'failure') { fixture.sessionService.create.mockRejectedValueOnce(new Error('private-conversation')); status = 500; }
    const raw = kind === 'malformed' ? '{' : kind === 'oversized' ? ' '.repeat(MAX_BODY_BYTES + 1) : JSON.stringify(body);
    if (kind === 'malformed') status = 400;
    if (kind === 'oversized') status = 413;
    logs[0].mockClear();
    // When the HTTP response finishes.
    const response = await fixture.request.post('/api/openchamber/integration/control')
      .set('Content-Type', 'application/json').set('Authorization', `Bearer ${fixture.token}`).send(raw);
    // Then exactly one closed JSON projection is emitted, never request or response contents.
    expect(response.status).toBe(status);
    expect(logs[0]).toHaveBeenCalledTimes(1);
    const text = logs[0].mock.calls[0][0];
    const event = JSON.parse(text);
    expect(event).toEqual({
      event: 'integration_control_request',
      requestId: ['malformed', 'oversized'].includes(kind) ? null : body.requestId,
      domainId: ['unauthorized', 'policy', 'malformed', 'oversized'].includes(kind) ? null : 'alpha',
      action: ['malformed', 'oversized'].includes(kind) ? null : 'session.create',
      ok: status === 200, statusCode: status, durationMs: expect.any(Number),
    });
    expect(event.durationMs).toBeGreaterThanOrEqual(0);
    for (const sensitive of [fixture.token, 'private-prompt', 'private-conversation', 'Authorization', fixture.root]) {
      expect(text).not.toContain(sensitive);
    }
  });

  it('aborts the native control signal on client disconnect', async () => {
    let entered;
    const started = new Promise((resolve) => { entered = resolve; });
    let release;
    fixture.sessionService.create.mockImplementationOnce(() => {
      entered();
      return new Promise((resolve) => { release = resolve; });
    });
    const pending = send(requestBody('session.create', { projectId: 'alpha' }));
    pending.end(() => {});
    await started;
    const signal = fixture.execute.mock.calls[0][3].signal;
    const aborted = new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }));
    pending.abort();
    await aborted;
    expect(signal.aborted).toBe(true);
    release({ sessionId: 'created', promptDispatched: false });
  });
});
