import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { fixture, identity } from './page-recovery.test-support.js';

describe('render recovery authority', () => {
  it.each([
    ['a running session', (env) => { env.state.active = { [identity.sessionId]: { type: 'running' } }; }],
    ['a canonical form', (env) => { env.state.forms = [{ id: 'form_live' }]; }],
    ['a queued chat message', (env) => { env.state.inbox = [{ type: 'user', delivery: 'queue', payload: { text: 'Stop asking' } }]; }],
    ['a newer user message', (env) => { env.state.records.unshift({ id: 'new', type: 'user', text: 'Continue' }); }],
    ['a newer assistant', (env) => { env.state.records.unshift({ id: 'new', type: 'assistant', content: [] }); }],
    ['a delivered answer', (env) => { env.state.records.unshift({ id: 'new', type: 'synthetic', metadata: { source: 'openchamber-page-answer', callId: identity.callId } }); }],
    ['a completed tool', (env) => { env.state.records[0].content[0].state.status = 'completed'; }],
    ['an already recorded decline', (env) => { env.state.records[0].content[0].state.metadata = { openchamber: { answer: { answered: false, reason: 'declined' } } }; }],
    ['a completed service response', (env) => { env.state.records[0].content[0].state.metadata = { openchamber: { ok: true } }; }],
    ['a refused service response', (env) => { env.state.records[0].content[0].state.metadata = { openchamber: { ok: false } }; }],
    ['a chat-ended call', (env) => { env.state.records[0].content[0].state.metadata = { openchamber: { answer: { answered: false, reason: 'chat-sent-earlier' } } }; }],
    ['a different message', (env) => { env.state.records[0].id = 'different'; }],
    ['a different call', (env) => { env.state.records[0].content[0].id = 'different'; }],
    ['a different tool', (env) => { env.state.records[0].content[0].name = 'question'; }],
    ['an incomplete input', (env) => { env.state.records[0].content[0].state = { status: 'streaming', input: '{' }; }],
    ['a shared page', (env) => { env.state.records[0].content[0].state.input.parameters.share = { recipients: ['Someone'] }; }],
    ['an answerLater page', (env) => { env.state.records[0].content[0].state.input.parameters.answerLater = true; }],
    ['a page that never awaited', (env) => { env.state.records[0].content[0].state.input.parameters.awaitAnswer = false; }],
    ['empty history', (env) => { env.state.records = []; }],
    ['a user Stop without a reason record', (env) => { env.state.records.unshift({ type: 'idle', outcome: 'interrupted' }); }],
    ['a user Stop over an earlier restart', (env) => { env.interrupt('opencode-restart'); env.state.session.metadata.openchamber.interruption = { reason: 'user', at: 220 }; }],
    ['an interrupted running call without proof', (env) => { env.state.session.outcome = 'interrupted'; }],
    ['an error without proof', (env) => { env.interrupt('inactivity'); delete env.state.session.metadata; }],
    ['a stale inactivity record', (env) => { env.interrupt('inactivity'); env.state.session.time.idle = 300; }],
    ['a restart naming another call', (env) => { env.interrupt('opencode-restart'); env.state.session.metadata.openchamber.restartCutTurn.callID = 'other'; }],
    ['a restart naming another message', (env) => { env.interrupt('opencode-restart'); env.state.session.metadata.openchamber.restartCutTurn.messageID = 'other'; }],
    ['an ordinary failure after a restart', (env) => { env.interrupt('opencode-restart'); env.state.records[0].content[0].state.error.type = 'validation'; }],
    ['a reverted turn', (env) => { env.state.session.revert = { messageID: identity.messageId }; }],
    ['an operator child', (env) => { env.state.session.metadata = { openchamber: { kind: 'operator-child', parentID: 'ses_parent' } }; }],
  ])('does not resurrect %s', async (_name, change) => {
    const env = await fixture();
    change(env);
    await env.recover().expect(200, { page: null });
    expect(env.laterPages.snapshot().pages).toEqual([]);
    expect(env.posts).toHaveLength(0);
  });

  it.each(['', '/active', '/form', '/inbox', '/message'])('fails an authoritative %s read without granting empty authority', async (suffix) => {
    const env = await fixture();
    await env.recover().expect(200);
    env.state.fail = suffix === '/active' ? '/api/session/active' : `/api/session/${identity.sessionId}${suffix}`;
    const result = await env.recover();
    expect(result.status).toBeGreaterThanOrEqual(500);
    expect(result.body).toHaveProperty('error');
    const submission = await env.submit();
    expect(submission.status).toBeGreaterThanOrEqual(500);
    expect(env.laterPages.snapshot().pages[0].status).toBe('open');
    expect(env.posts).toHaveLength(0);
  });

  it('rejects a missing recovery identity', async () => {
    const env = await fixture();
    await request(env.app).post('/api/openchamber/render/recover').send({ sessionId: identity.sessionId }).expect(400);
    expect(env.laterPages.snapshot().pages).toEqual([]);
  });

  it('ignores content-free markers and handles the tool input spellings the plugin accepts', async () => {
    const env = await fixture();
    env.state.records[0].content[0].state.input = {
      action: JSON.stringify({ parameters: { ui: 'root = Stack([Text("Choose")])', awaitAnswer: 'true' } }),
    };
    env.state.nextPage = env.state.records;
    env.state.records = [{ type: 'model-switched' }, { type: 'idle', outcome: 'succeeded' }];
    const result = await env.recover().expect(200);
    expect(result.body.page.status).toBe('open');
    await env.submit().expect(200);
    await env.deliver();
    expect(JSON.parse(env.posts[0].text.split('\n')[2])).toMatchObject({ page: 'root = Stack([Text("Choose")])' });
  });
});
