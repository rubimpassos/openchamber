import fs from 'node:fs/promises';
import express from 'express';
import request from 'supertest';
import { afterEach, expect, vi } from 'vitest';
import { createLaterPages } from './later-pages.js';
import { createOpenChamberControlService } from './service.js';
import { registerOpenChamberControlRoutes } from './routes.js';

export const identity = { sessionId: 'ses_recovery', messageId: 'msg_question', callId: 'call_question' };
export const answer = { sessionId: identity.sessionId, callId: identity.callId, summary: 'Blue', data: { color: 'blue' } };
export const original = () => ({
  id: identity.messageId, type: 'assistant', time: { created: 100 },
  content: [{
    type: 'tool', id: identity.callId, name: 'openchamber_render', time: { created: 100 },
    state: { status: 'running', input: { parameters: { html: '<title>Color</title><p>Which color?</p>', awaitAnswer: true } }, metadata: {} },
  }],
});
const directories = [];
afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(directories.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

export const fixture = async () => {
  const dataDir = await fs.mkdtemp('/tmp/opencode/question-recovery-');
  directories.push(dataDir);
  const state = {
    session: { id: identity.sessionId, location: { directory: '/recovery-project' }, time: { created: 1, idle: 200 } },
    records: [original()], nextPage: null, active: {}, forms: [], inbox: [], fail: '', beforeRead: null, onWait: () => {}, status: 200,
  };
  const posts = [];
  const transport = async (input, init) => {
    const req = new Request(input, init);
    const url = new URL(req.url);
    if (state.beforeRead) await state.beforeRead(url.pathname);
    if (url.pathname === state.fail) return Response.json({ message: 'unavailable' }, { status: 503 });
    if (req.method === 'POST') {
      posts.push(await req.json());
      return Response.json({}, { status: state.status });
    }
    if (url.pathname.endsWith('/active')) return Response.json({ data: state.active });
    if (url.pathname.endsWith('/form')) return Response.json({ data: state.forms });
    if (url.pathname.endsWith('/inbox')) return Response.json({ data: state.inbox });
    if (url.pathname.endsWith('/message')) {
      if (url.searchParams.has('cursor')) {
        if (url.searchParams.has('order')) throw new Error('OpenCode refuses order with a cursor');
        return Response.json({ data: state.nextPage, cursor: {} });
      }
      return Response.json({ data: state.records, cursor: state.nextPage ? { next: 'older' } : {} });
    }
    if (url.pathname.endsWith(`/${identity.sessionId}`)) return Response.json({ data: state.session });
    throw new Error(`Unexpected request: ${req.url}`);
  };
  vi.stubGlobal('fetch', transport);
  const make = () => {
    const timers = [];
    let onBroadcast = () => {};
    const laterPages = createLaterPages({
      dataDir, buildOpenCodeUrl: (route) => `http://recovery.test${route}`,
      getOpenCodeAuthHeaders: () => ({}), fetchImpl: transport,
      broadcastUiEvent: () => onBroadcast(),
      timers: {
        setTimeout: (fn) => { const timer = { fn, cleared: false, unref() {} }; timers.push(timer); return timer; },
        clearTimeout: (timer) => { timer.cleared = true; },
      },
      warn: () => {},
    });
    const service = createOpenChamberControlService({
      readSettingsFromDiskMigrated: async () => ({}), sanitizeProjects: () => [],
      buildOpenCodeUrl: (route) => `http://recovery.test${route}`, getOpenCodeAuthHeaders: () => ({}),
      sessionService: {}, scheduledTaskService: {}, laterPages,
      onPageWaitChange: (change) => { if (change.type === 'waiting') state.onWait(change); },
    });
    const app = express();
    registerOpenChamberControlRoutes(app, { controlService: service, laterPages });
    return {
      service, laterPages, app,
      recover: () => request(app).post('/api/openchamber/render/recover').send(identity),
      submit: (body = answer) => request(app).post('/api/openchamber/render/answer').send(body),
      deliver: async () => {
        const timer = timers.splice(0).find((entry) => !entry.cleared);
        expect(timer).toBeDefined();
        const finished = new Promise((resolve) => { onBroadcast = resolve; });
        timer.fn();
        await finished;
        await laterPages.flush();
        onBroadcast = () => {};
      },
    };
  };
  const interrupt = (reason) => {
    state.records[0].content[0].state.status = 'error';
    state.records[0].content[0].state.error = { type: 'aborted', message: 'Tool execution interrupted' };
    state.session.outcome = 'interrupted';
    state.session.metadata = { openchamber: {
      interruption: { reason, at: 210 },
      ...(reason === 'opencode-restart' && { restartCutTurn: { messageID: identity.messageId, callID: identity.callId, toolName: 'openchamber_render', at: 210 } }),
    } };
  };
  return { dataDir, state, posts, make, interrupt, ...make() };
};
