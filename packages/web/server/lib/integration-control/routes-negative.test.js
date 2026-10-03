import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestApp, requestBody } from './test-app.js';

let fixture;
beforeEach(async () => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  fixture = await createTestApp();
});
afterEach(async () => {
  await fixture.close();
  vi.restoreAllMocks();
});
const send = (body) => fixture.request.post('/api/openchamber/integration/control')
  .set('Authorization', `Bearer ${fixture.token}`).send(body);
const noDispatch = () => {
  expect(fixture.execute).not.toHaveBeenCalled();
  for (const operation of Object.values(fixture.sessionService)) expect(operation).not.toHaveBeenCalled();
};

describe('integration route fail-closed cases', () => {
  it('serves an authorized project even when an unrelated directory is unavailable', async () => {
    await fs.rm(fixture.beta, { recursive: true });
    const response = await send(requestBody('session.send', { projectId: 'alpha', sessionId: 'human', prompt: 'Hello' }));
    expect(response.status).toBe(200);
    expect(response.body.data).toEqual({ sessionId: 'human', promptDispatched: true });
    expect(fixture.sessionService.send).toHaveBeenCalledTimes(1);
  });

  it.each(['expired', 'revoked'])('reloads an %s token after a successful call', async (state) => {
    expect((await send(requestBody())).status).toBe(200);
    fixture.execute.mockClear();
    if (state === 'expired') fixture.policy.credentials[0].expiresAt = '2000-01-01T00:00:00Z';
    else fixture.policy.credentials = [];
    await fixture.savePolicy();
    const response = await send(requestBody('session.create', { projectId: 'alpha' }));
    expect(response.status).toBe(401);
    expect(response.body.error.code).toBe('UNAUTHORIZED');
    noDispatch();
  });

  it.each([
    ['session.fork', { projectId: 'alpha', sessionId: 'human' }],
    ['session.fork', { projectId: 'alpha', sessionId: 'human', prompt: 'Hello', directory: '/escape' }],
    ['session.create', { projectId: 'alpha', worktree: '../beta' }],
    ['session.create', { projectId: 'alpha', worktree: '/absolute' }],
    ['session.send', { projectId: 'alpha', sessionId: 'human', prompt: 'Hello', wait: true }],
  ])('rejects %s schema escapes before creating or dispatching', async (action, input) => {
    const response = await send(requestBody(action, input));
    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('INVALID_REQUEST');
    noDispatch();
  });

  it('rejects extra envelope fields', async () => {
    const response = await send({ ...requestBody(), passthrough: true });
    expect(response.status).toBe(400);
    noDispatch();
  });

  it.each(['neighbor', 'symlink', 'worktree'])('hides sessions in a foreign %s directory', async (kind) => {
    const outside = path.join(fixture.root, `outside-${kind}`);
    if (kind === 'symlink') await fs.symlink(fixture.beta, outside);
    else await fs.mkdir(outside);
    if (kind === 'worktree') {
      // A genuine linked-worktree identity, but owned by the ungranted project.
      const gitDir = path.join(fixture.beta, '.git');
      const linked = path.join(gitDir, 'worktrees', 'foreign');
      await Promise.all(['objects', 'refs', 'worktrees/foreign'].map((dir) => fs.mkdir(path.join(gitDir, dir), { recursive: true })));
      await Promise.all([
        fs.writeFile(path.join(gitDir, 'HEAD'), 'ref: refs/heads/main\n'),
        fs.writeFile(path.join(linked, 'HEAD'), 'ref: refs/heads/foreign\n'),
        fs.writeFile(path.join(linked, 'commondir'), '../..\n'),
        fs.writeFile(path.join(linked, 'gitdir'), `${outside}/.git\n`),
        fs.writeFile(path.join(outside, '.git'), `gitdir: ${linked}\n`),
      ]);
    }
    fixture.sessions.push({ id: 'outside', location: { directory: outside } });
    const response = await send(requestBody('session.fork', { projectId: 'alpha', sessionId: 'outside', prompt: 'Hello' }));
    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe('SESSION_NOT_FOUND');
    expect(response.text).not.toContain(outside);
    noDispatch();
  });
});
