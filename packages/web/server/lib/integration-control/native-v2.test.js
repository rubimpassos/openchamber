import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createNativeFailureFixture } from './native-failure-fixture.js';
import { parseResponse } from './contract.js';
import { requestBody } from './test-app.js';

let fixture;
beforeEach(async () => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  fixture = await createNativeFailureFixture({ dispatchStatus: 200 });
});
afterEach(async () => {
  await fixture.close();
  vi.restoreAllMocks();
});

describe('Hermes over native V2 HTTP services', () => {
  it.each([
    ['projects.list', {}, { projects: [{ id: 'alpha' }] }],
    ['session.list', { projectId: 'alpha' }, { sessions: [{ id: 'human', title: 'Human' }] }],
    ['session.create', { projectId: 'alpha', prompt: 'Hello' }, { sessionId: 'created', promptDispatched: true }],
    ['session.send', { projectId: 'alpha', sessionId: 'human', prompt: 'Hello' }, { sessionId: 'human', promptDispatched: true }],
    ['session.fork', { projectId: 'alpha', sessionId: 'human', prompt: 'Hello' }, { sessionId: 'forked', sourceSessionId: 'human', promptDispatched: true }],
    ['session.status', { projectId: 'alpha', sessionId: 'human' }, { sessionId: 'human', sessionStatus: { type: 'busy' } }],
    ['session.messages', { projectId: 'alpha', sessionId: 'human', lastAssistant: true }, {
      sessionId: 'human', sessionStatus: { type: 'busy' }, messages: [{ id: 'reply', role: 'assistant', text: 'Answer' }],
    }],
  ])('%s preserves wire V1 while using the V2 client', async (action, input, expected) => {
    // Given the real session/control services and a V2 HTTP upstream.
    const body = requestBody(action, input);
    // When Hermes calls the restricted route.
    const response = await fixture.request.post('/api/openchamber/integration/control')
      .set('Authorization', `Bearer ${fixture.token}`).send(body);
    // Then only the stable wire projection leaves the server.
    expect(response.status).toBe(200);
    expect(parseResponse(response.text).success).toBe(true);
    expect(response.body.data).toEqual(expected);
    expect(response.text).not.toContain(fixture.root);
    expect(response.text).not.toContain('private-reasoning');
    expect(fixture.requests.every(({ path }) => path.startsWith('/api/'))).toBe(true);
    if (input.prompt) {
      expect(fixture.calls.dispatches).toBe(1);
      const dispatch = fixture.requests.find(({ path }) => path.endsWith('/prompt'));
      expect(dispatch.directory).toBe(encodeURIComponent(fixture.root));
      expect(dispatch.method).toBe('POST');
    }
  });
});
