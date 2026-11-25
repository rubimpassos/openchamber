import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { createHostFixture } from './host.test-support.js';
import { createBotStore } from './store.js';
import { createOpenChamberControlService } from '../openchamber-control/service.js';
import { botConversationDeliveryFetch } from './conversation-delivery.js';
import express from 'express';
import request from 'supertest';

const fixtures = [];
afterEach(async () => { for (const fixture of fixtures.splice(0)) await fixture.close(); });
const fixture = async () => {
  const f = await createHostFixture(); fixtures.push(f);
  await f.host.start();
  await f.host.runtime.saveConfig('project', { definitions: [{ id: 'bot', name: 'Bot', mission: 'Explain evidence' }] });
  const item = await f.host.runtime.admit('project', 'bot', { source: { kind: 'manual', id: 'capture' }, title: 'Evidence' });
  const control = createOpenChamberControlService({
    buildOpenCodeUrl: (route) => `http://unused.invalid${route}`, getOpenCodeAuthHeaders: () => ({}),
    readSettingsFromDiskMigrated: async () => ({}), sanitizeProjects: () => [],
    sessionService: {}, scheduledTaskService: {},
    createClient: () => ({ session: { get: async ({ sessionID }) => f.records.get(sessionID) } }),
    artifacts: f.host.artifacts.local.capture,
    assertConversationControlTarget: f.host.assertConversationControlTarget,
  });
  return { ...f, item, control };
};

it('captures through the production control service and publishes retained bytes through owner routes', async () => {
  const f = await fixture();
  const image = path.join(f.project.path, 'evidence.png');
  const bytes = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
  await fs.writeFile(image, bytes);
  const rendered = await f.control.execute('render.page', { html: `<img src="${image}">`, title: 'Proof' },
    f.item.conversation.directory, { contextSessionId: f.item.conversation.sessionId, contextCallId: 'call_proof', contextMessageId: 'msg_proof' });
  expect(rendered.artifact.publication).toBe('published');
  await fs.rm(image);
  const listed = await f.request(`/items/${f.item.id}/artifacts`);
  expect(listed.status).toBe(200);
  expect(listed.body.artifacts.map((entry) => entry.id)).toEqual([rendered.artifact.id]);
  const saved = await f.request(`/items/${f.item.id}/artifacts/${rendered.artifact.id}`);
  expect(saved.body.payload.assets).toEqual([{ source: image, status: 'ready', mime: 'image/png', data: bytes.toString('base64') }]);
  expect(saved.body.artifact.source).toMatchObject({ messageId: 'msg_proof', sessionId: f.item.conversation.sessionId, callId: 'call_proof' });

  await f.host.runtime.stopItem('project', f.item.id);
  const store = createBotStore({ projectsDirPath: path.join(f.dataDir, 'projects') });
  await store.archive('project', { before: Date.now() + 1000, itemIds: [f.item.id] });
  await f.projectConfigRuntime.updateBotsSection('project', () => ({ definitions: [] }));
  const fresh = f.buildHost();
  try {
    const retained = await fresh.artifacts.artifacts.read({ projectId: 'project', itemId: f.item.id }, rendered.artifact.id);
    expect(retained.payload.assets[0].data).toBe(bytes.toString('base64'));
    expect(await fresh.artifacts.bindings.resolve(f.item.conversation.sessionId)).toMatchObject({
      projectId: 'project', botId: 'bot', itemId: f.item.id, producer: { role: 'conversation' },
    });
  } finally { await fresh.stop(); }
});

it('refuses a producer claiming another recorded conversation and leaves publication unchanged', async () => {
  const f = await fixture();
  const canonical = f.records.get(f.item.conversation.sessionId);
  f.records.set('ses_forged', { ...canonical, id: 'ses_forged' });
  await expect(f.control.execute('render.page', { ui: 'root = Text("Forged")' }, canonical.location.directory,
    { contextSessionId: 'ses_forged', contextCallId: 'call_forged' })).rejects.toMatchObject({ statusCode: 403 });
  expect((await f.request(`/items/${f.item.id}/artifacts`)).body.artifacts).toEqual([]);
});

it('keeps registered capture provenance when the canonical metadata hint is missing', async () => {
  const f = await fixture();
  const record = f.records.get(f.item.conversation.sessionId);
  const original = record.metadata;
  record.metadata = {};
  try {
    const rendered = await f.control.execute('render.page', { ui: 'root = Text("Retained identity")' }, record.location.directory,
      { contextSessionId: record.id, contextCallId: 'call_registered' });
    expect(rendered.artifact).toMatchObject({ publication: 'published', source: { sessionId: record.id, producer: { role: 'conversation' } } });
  } finally { record.metadata = original; }
});

it.each(['agent', 'space'])('keeps local capture out of the private %s execution namespace', async (placement) => {
  const f = await fixture();
  const app = express();
  app.use((req, res, next) => req.get('authorization') === 'Bearer fixture' ? next() : res.sendStatus(401));
  f.host.artifacts.local.registerRoutes(app, placement);
  const prefix = placement === 'agent' ? '/api/openchamber/bot-services/artifacts' : '/api/openchamber/bots/artifacts';
  const binding = await f.host.artifacts.bindings.resolve(f.item.conversation.sessionId);
  expect(await f.host.artifacts.local.service.pull({ binding })).toEqual({ entries: [], nextOffset: null });
  const response = await request(app).post(`${prefix}/pull`).set('authorization', 'Bearer fixture').send({ binding }).expect(403);
  expect(response.body.code).toBe('BOT_ARTIFACT_EXECUTOR_REQUIRED');
});

it('admits deferred page-answer inference through owner budgets and retains it through refusal and Stop', async () => {
  const f = await fixture();
  const sessionId = f.item.conversation.sessionId;
  const body = { id: 'msg_renderdelivery1', text: 'The user chose A', resume: true,
    metadata: { source: 'openchamber-page-answer', callId: 'call_page', outcome: 'answered' } };
  const delivery = f.host.artifacts.local.delivery;
  const direct = [];
  const network = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
    direct.push(JSON.parse(init.body)); return Response.json({ data: {} });
  });
  const sourceFetch = botConversationDeliveryFetch(() => delivery);
  const post = (value) => sourceFetch(`http://source.invalid/api/session/${sessionId}/synthetic`,
    { method: 'POST', body: JSON.stringify(value) });
  try {
  await f.host.runtime.saveConfig('project', { definitions: [{ id: 'bot', name: 'Bot', mission: 'Explain evidence', limits: { dailyTokens: 1 } }] });
  await f.host.runtime.recordUsage({ sessionId, total: 1 });
  await expect(post(body)).rejects.toMatchObject({ code: 'BOT_CONVERSATION_DELIVERY_PENDING' });
  expect(direct).toEqual([]);
  await expect(f.host.artifacts.collect(sessionId)).rejects.toMatchObject({ code: 'BOT_DAILY_TOKEN_BUDGET' });
  expect(f.calls.synthetics.filter((entry) => entry.resume === true)).toEqual([]);
  await f.host.runtime.saveConfig('project', { definitions: [{ id: 'bot', name: 'Bot', mission: 'Explain evidence', limits: { dailyTokens: 100 } }] });
  await f.host.artifacts.collect(sessionId);
  expect(f.calls.synthetics.filter((entry) => entry.resume === true)).toEqual([{ ...body, sessionID: sessionId }]);
  expect(await (await post(body)).json()).toEqual({ data: { id: body.id } });
  const stopped = { ...body, id: 'msg_renderdelivery2' };
  await expect(delivery.request(sessionId, stopped)).rejects.toMatchObject({ code: 'BOT_CONVERSATION_DELIVERY_PENDING' });
  await f.host.runtime.stopItem('project', f.item.id);
  await expect(f.host.artifacts.collect(sessionId)).rejects.toMatchObject({ code: 'BOT_CONVERSATION_STOPPED' });
  expect(f.calls.synthetics.filter((entry) => entry.resume === true)).toHaveLength(1);
  const archived = { ...body, id: 'msg_archivedanswer' };
  const implicitResume = { id: 'msg_implicitresume', text: body.text, metadata: body.metadata };
  for (const requested of [archived, implicitResume]) {
    await expect(post(requested)).rejects.toMatchObject({ code: 'BOT_CONVERSATION_DELIVERY_PENDING' });
    await post({ ...requested, resume: false });
  }
  expect(direct).toEqual([archived, implicitResume].map((requested) => ({ ...requested, resume: false })));
  const binding = await f.host.artifacts.bindings.resolve(sessionId);
  expect((await delivery.pending(binding)).map((entry) => entry.id)).toEqual([stopped.id]);
  } finally { network.mockRestore(); }
});
