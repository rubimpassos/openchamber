import fs from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { fixture, identity, answer } from './page-recovery.test-support.js';

describe('stranded render awaits', () => {
  it('recovers the original running/idle call over HTTP and keeps its answer through restart', async () => {
    const env = await fixture();
    const recovered = await env.recover();
    expect(recovered.body).toEqual({ page: { sessionID: identity.sessionId, callID: identity.callId, source: 'recovered-await', status: 'open' } });
    expect(recovered.status).toBe(200);

    const restarted = env.make();
    await restarted.submit().expect(200, { answered: true });
    await restarted.deliver();
    expect(env.posts).toHaveLength(1);
    expect(env.posts[0]).toMatchObject({ delivery: 'steer', resume: true, metadata: { callId: identity.callId, outcome: 'answered' } });
    expect(JSON.parse(env.posts[0].text.split('\n')[2])).toEqual({ title: 'Color', page: 'Which color?', summary: 'Blue', data: { color: 'blue' } });
    await restarted.submit().expect(404);
    const again = await env.make().recover().expect(200);
    expect(again.body.page).toMatchObject({ status: 'answered', summary: 'Blue' });
  });

  it.each(['opencode-restart', 'inactivity'])('recovers an aborted await with an exact %s record', async (reason) => {
    const env = await fixture();
    env.interrupt(reason);
    const recovered = await env.recover().expect(200);
    expect(recovered.body.page).toMatchObject({ status: 'open', source: 'recovered-await' });
    await env.submit().expect(200);
    await env.deliver();
    expect(env.posts).toHaveLength(1);
  });

  it('keeps inactivity evidence when an older cut-turn record has no tool identity', async () => {
    const env = await fixture();
    env.interrupt('inactivity');
    env.state.session.metadata.openchamber.restartCutTurn = {
      messageID: identity.messageId, callID: null, toolName: null, at: 200,
    };
    const recovered = await env.recover().expect(200);
    expect(recovered.body.page).toMatchObject({ status: 'open', source: 'recovered-await' });
  });

  it.each([{ declined: true }, { notDrawn: ['invalid form'] }])('persists a terminal disposition %j across recovery and restart', async (disposition) => {
    const env = await fixture();
    await env.recover().expect(200);
    await env.submit({ ...identity, ...disposition }).expect(200, { answered: false });
    const restarted = env.make();
    const recovered = await restarted.recover().expect(200);
    expect(recovered.body.page.status).toBe(disposition.declined ? 'declined' : 'ui-not-drawn');
    await restarted.submit().expect(404);
    expect(env.posts).toHaveLength(0);
  });

  it('serializes concurrent recovery and accepts only one concurrent submission', async () => {
    const env = await fixture();
    const results = await Promise.all([env.recover(), env.recover(), env.recover()]);
    expect(results.map((result) => result.status)).toEqual([200, 200, 200]);
    expect(env.laterPages.snapshot().pages).toHaveLength(1);
    const submissions = await Promise.all([env.submit(), env.submit()]);
    expect(submissions.map((result) => result.status).sort()).toEqual([200, 404]);
    await env.deliver();
    expect(env.posts).toHaveLength(1);
  });

  it('retries a delivery across restart with the same synthetic id', async () => {
    const env = await fixture();
    await env.recover().expect(200);
    await env.submit().expect(200);
    env.state.status = 500;
    await env.deliver();
    expect(env.laterPages.snapshot().pages[0]).toMatchObject({ status: 'answered', undelivered: true });
    const restarted = env.make();
    restarted.laterPages.start(null);
    await restarted.laterPages.load();
    env.state.status = 409;
    await restarted.deliver();
    expect(env.posts).toHaveLength(2);
    expect(env.posts[1].id).toBe(env.posts[0].id);
  });

  it('does not promote a live waiter, including one opened during the authoritative read', async () => {
    const env = await fixture();
    let started;
    env.state.beforeRead = async (route) => {
      if (!route.endsWith('/message') || started) return;
      const waiting = new Promise((resolve) => { env.state.onWait = resolve; });
      started = env.service.execute('render.page', { html: '<p>Live?</p>', awaitAnswer: true }, '/recovery-project', {
        contextSessionId: identity.sessionId, contextCallId: identity.callId,
      });
      await waiting;
    };
    await env.recover().expect(200, { page: null });
    expect(env.laterPages.snapshot().pages).toEqual([]);
    await env.recover().expect(200, { page: null });
    await env.submit().expect(200);
    await expect(started).resolves.toMatchObject({ answer: { answered: true } });
    expect(env.posts).toHaveLength(0);
  });

  it('revalidates recovered answers and keeps closed pages closed after restart', async () => {
    const env = await fixture();
    await env.recover().expect(200);
    env.state.records.unshift({ id: 'msg_chat', type: 'user', time: { created: 300 }, text: 'Do something else' });
    await env.submit().expect(404);
    env.state.records.shift();
    const response = await env.make().recover().expect(200);
    expect(response.body.page.status).toBe('closed');
    expect(env.posts).toHaveLength(0);
  });

  it.each([
    { type: 'session.status', properties: { sessionID: identity.sessionId, status: { type: 'busy' } } },
    { type: 'message.updated', properties: { info: { sessionID: identity.sessionId, role: 'user', id: 'msg_chat' } } },
    { type: 'session.idle', properties: { sessionID: identity.sessionId, aborted: true, reason: 'user' } },
  ])('closes recovered awaits on progress while preserving answerLater: $type', async (event) => {
    const env = await fixture();
    await env.recover().expect(200);
    await env.laterPages.open({ sessionId: identity.sessionId, callId: 'call_later', title: 'Later' });
    env.laterPages.processPayload(event);
    await env.laterPages.flush();
    const recovered = await env.make().recover().expect(200);
    expect(recovered.body.page.status).toBe('closed');
    await env.submit().expect(404);
    await env.submit({ ...answer, callId: 'call_later' }).expect(200);
  });

  it.each(['recovery', 'answer'])('rolls back a failed atomic %s write', async (stage) => {
    const env = await fixture();
    if (stage === 'answer') await env.recover().expect(200);
    else await env.laterPages.load();
    const file = `${env.dataDir}/render-later-pages.json`;
    if (stage === 'answer') await fs.rename(file, `${file}.saved`);
    await fs.mkdir(file);
    await (stage === 'answer' ? env.submit() : env.recover()).expect(500);
    expect(env.laterPages.snapshot().pages).toEqual(stage === 'answer'
      ? [expect.objectContaining({ status: 'open' })] : []);
    await fs.rmdir(file);
    if (stage === 'answer') await fs.rename(`${file}.saved`, file);
    await env.recover().expect(200);
    await env.submit().expect(200);
  });

  it('retains recovered terminal dispositions when delivered answerLater pages make room at capacity', async () => {
    const env = await fixture();
    await env.recover().expect(200);
    await env.submit({ ...identity, declined: true }).expect(200);
    await env.deliver();
    const file = `${env.dataDir}/render-later-pages.json`;
    const stored = JSON.parse(await fs.readFile(file, 'utf8'));
    const { source, messageId, ...later } = stored.pages[0];
    stored.pages.push(...Array.from({ length: 499 }, (_, index) => ({ ...later, callId: `later_${index}` })));
    await fs.writeFile(file, JSON.stringify(stored));
    const restarted = env.make();
    await restarted.laterPages.open({ sessionId: identity.sessionId, callId: 'new_later', title: 'New page' });
    const result = await restarted.recover().expect(200);
    expect(result.body.page.status).toBe('declined');
    await restarted.submit().expect(404);
  });
});
