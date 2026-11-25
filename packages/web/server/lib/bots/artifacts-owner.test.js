import fs from 'node:fs/promises';
import path from 'node:path';
import express from 'express';
import supertest from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createBotArtifactCapture } from './artifacts-capture.js';
import { createBotArtifacts } from './artifacts-owner.js';
import { registerBotArtifactRoutes } from './artifacts-routes.js';
import { createBotArtifactStore } from './artifacts-store.js';
import { BotArtifactError } from './artifacts-contract.js';
import { botArtifactListSchema, botArtifactReadSchema } from '@/lib/bots/artifacts';

let root;
let binding;
let source;
let manifests;
let owner;
beforeEach(async () => {
  root = await fs.mkdtemp('/tmp/opencode/bot-artifact-owner-');
  binding = { projectId: 'project', botId: 'bot', itemId: 'item', sessionId: 'ses_worker', directory: root,
    producer: { role: 'stage', stage: 'fixing' } };
  manifests = [];
  source = createBotArtifactCapture({ dataDir: root, resolveSession: async () => binding, now: () => 100,
    onCaptured: async (manifest) => { manifests.push(manifest); } });
  owner = createBotArtifacts({ dataDir: path.join(root, 'owner'), resolveBinding: async () => binding,
    assertReadScope: async (scope) => { if (scope.projectId !== binding.projectId || scope.itemId !== binding.itemId) throw new BotArtifactError('BOT_ITEM_NOT_FOUND', 404); } });
});
afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });
async function captured(callId = 'call_1', awaitAnswer = false) {
  await source.capture({ body: { format: 'ui', content: 'root = Text("Opaque proof")' }, title: callId, awaitAnswer },
    { sessionId: binding.sessionId, callId, directory: root });
  const manifest = manifests.at(-1);
  const store = createBotArtifactStore({ directory: path.join(root, 'bots', 'artifact-captures') });
  return { manifest, bytes: (await store.payload(manifest)).bytes };
}

describe('owner artifact catalog', () => {
  it.each(['projectId', 'botId', 'itemId', 'sessionId', 'directory', 'producer'])('refuses publication with a forged %s binding', async (field) => {
    const { manifest, bytes } = await captured();
    const wrong = { ...binding, [field]: field === 'producer' ? { role: 'conversation' } : 'other' };

    await expect(owner.publish(wrong, manifest, bytes)).rejects.toMatchObject({ code: 'BOT_ARTIFACT_BINDING_REQUIRED', status: 403 });

    expect((await owner.list(binding)).artifacts).toEqual([]);
  });

  it('requires an owner-recorded binding even when a producer claims valid bot metadata', async () => {
    const { manifest, bytes } = await captured();
    const unregistered = createBotArtifacts({ dataDir: path.join(root, 'unregistered'), resolveBinding: async () => null, assertReadScope: async () => {} });
    await expect(unregistered.publish(binding, manifest, bytes)).rejects.toMatchObject({ code: 'BOT_ARTIFACT_BINDING_REQUIRED' });
  });

  it('refuses interactive worker claims at owner publication even if the execution server was replaced', async () => {
    const { manifest, bytes } = await captured();
    await expect(owner.publish(binding, { ...manifest, metadata: { ...manifest.metadata, interaction: 'awaitAnswer' } }, bytes))
      .rejects.toMatchObject({ code: 'BOT_ARTIFACT_WORKER_READONLY' });
    expect((await owner.list(binding)).artifacts).toEqual([]);
  });

  it('persists immutable blobs before catalog attachment and recovers a failed atomic attach', async () => {
    const { manifest, bytes } = await captured();
    let failRename = true;
    const unreliable = createBotArtifacts({ dataDir: path.join(root, 'owner'), resolveBinding: async () => binding, assertReadScope: async () => {},
      fsImpl: { ...fs, rename: async (...args) => { if (failRename) throw new Error('attach failed'); return fs.rename(...args); } } });

    await expect(unreliable.publish(binding, manifest, bytes)).rejects.toThrow('attach failed');
    expect((await owner.list(binding)).artifacts).toEqual([]);
    failRename = false;
    await unreliable.publish(binding, manifest, bytes);

    expect((await owner.read(binding, manifest.metadata.id)).payload.body.content).toBe('root = Text("Opaque proof")');
  });

  it('rejects a failed blob write without attaching metadata', async () => {
    const { manifest, bytes } = await captured();
    const broken = createBotArtifacts({ dataDir: path.join(root, 'broken'), resolveBinding: async () => binding, assertReadScope: async () => {},
      fsImpl: { ...fs, link: async () => { throw new Error('blob failed'); } } });
    await expect(broken.publish(binding, manifest, bytes)).rejects.toThrow('blob failed');
    expect((await broken.list(binding)).artifacts).toEqual([]);
  });

  it('flushes admitted local publications through a failed write before transport shutdown', async () => {
    const first = await captured('call_first');
    const second = await captured('call_second');
    const firstStarted = Promise.withResolvers(); const secondStarted = Promise.withResolvers();
    const failFirst = Promise.withResolvers(); const finishSecond = Promise.withResolvers();
    const order = []; let links = 0;
    const publishing = createBotArtifacts({ dataDir: path.join(root, 'draining'), resolveBinding: async () => binding, assertReadScope: async () => {},
      fsImpl: { ...fs, link: async (...args) => {
        links += 1;
        if (links === 1) { firstStarted.resolve(); await failFirst.promise; throw new Error('First publication failed'); }
        secondStarted.resolve(); await finishSecond.promise; return fs.link(...args);
      } } });
    const writers = [first, second].map(({ manifest, bytes }) => publishing.publish(binding, manifest, bytes).then((result) => { order.push('published'); return result; }));
    const written = Promise.allSettled(writers);
    const flushing = publishing.flush().then(() => { order.push('flushed'); return null; }, (error) => { order.push('flushed'); return error; });
    try {
      await firstStarted.promise; failFirst.resolve();
      await secondStarted.promise;
      expect([...order]).toEqual([]);
      finishSecond.resolve();
      const failure = await flushing;
      expect(failure).toBeInstanceOf(AggregateError);
      expect(order).toEqual(['published', 'flushed']);
      expect((await written).map((result) => result.status).sort()).toEqual(['fulfilled', 'rejected']);
    } finally {
      failFirst.resolve(); finishSecond.resolve(); await written; await flushing;
    }
  });

  it('reuses one stable ID on replay and refuses payload or metadata changes', async () => {
    const { manifest, bytes } = await captured();
    await owner.publish(binding, manifest, bytes);

    expect((await owner.publish(binding, manifest, bytes)).id).toBe(manifest.metadata.id);
    await expect(owner.publish(binding, manifest, Buffer.from('{}'))).rejects.toMatchObject({ code: 'BOT_ARTIFACT_PAYLOAD_CHANGED' });
    await expect(owner.publish(binding, { ...manifest, metadata: { ...manifest.metadata, createdAt: 101 } }, bytes))
      .rejects.toMatchObject({ code: 'BOT_ARTIFACT_CONTENT_CONFLICT' });
    expect((await owner.list(binding)).artifacts).toHaveLength(1);
  });

  it('fails on an unreadable catalog and preserves its committed snapshot', async () => {
    const { manifest, bytes } = await captured();
    await owner.publish(binding, manifest, bytes);
    const directory = path.join(root, 'owner', 'bots', 'artifacts', 'catalogs');
    const catalog = (await fs.readdir(directory)).find((name) => name.endsWith('.json'));
    const file = path.join(directory, catalog);
    const original = await fs.readFile(file);
    await fs.writeFile(file, '{"version":2,"entries":[]}');

    await expect(owner.list(binding)).rejects.toThrow();
    await expect(owner.publish(binding, manifest, bytes)).rejects.toThrow();
    await fs.writeFile(file, original);

    expect((await owner.list(binding)).artifacts.map((entry) => entry.id)).toEqual([manifest.metadata.id]);
  });

  it('keeps the retained body readable when its canonical answer source is unavailable', async () => {
    binding = { ...binding, producer: { role: 'conversation' } };
    const { manifest, bytes } = await captured('call_answer', true);
    await owner.publish(binding, manifest, bytes);
    const offline = createBotArtifacts({ dataDir: path.join(root, 'owner'), resolveBinding: async () => binding,
      assertReadScope: async () => {}, readPage: async () => { throw new Error('Canonical source is offline'); } });
    const saved = botArtifactReadSchema.parse(await offline.read(binding, manifest.metadata.id));
    expect(saved.payload.body.content).toBe('root = Text("Opaque proof")');
    expect(saved.pageError).toBe('BOT_ARTIFACT_PAGE_UNAVAILABLE');
    expect(saved).not.toHaveProperty('page');
  });

  it('serves bounded metadata and one payload under owner authentication with no path selectors', async () => {
    for (const id of ['call_2', 'call_1']) {
      const { manifest, bytes } = await captured(id);
      await owner.publish(binding, manifest, bytes);
    }
    const app = express();
    app.use((req, res, next) => req.get('authorization') === 'Bearer owner' ? next() : res.sendStatus(401));
    registerBotArtifactRoutes(app, { artifacts: owner });
    const request = supertest(app);
    const url = '/api/projects/project/bots/items/item/artifacts';

    await request.get(url).expect(401);
    const first = await request.get(`${url}?limit=1`).set('authorization', 'Bearer owner').expect(200);
    const second = await request.get(`${url}?limit=1&offset=${first.body.nextOffset}`).set('authorization', 'Bearer owner').expect(200);
    const list = botArtifactListSchema.parse(first.body);
    expect(first.body).not.toHaveProperty('payload');
    expect(first.body.artifacts[0]).not.toHaveProperty('body');
    expect(new Set([list.artifacts[0].id, second.body.artifacts[0].id]).size).toBe(2);
    expect(second.body.nextOffset).toBeNull();
    const detail = await request.get(`${url}/${list.artifacts[0].id}`).set('authorization', 'Bearer owner').expect(200);
    expect(botArtifactReadSchema.parse(detail.body).payload.body).toEqual({ format: 'ui', content: 'root = Text("Opaque proof")' });
    await request.get(`${url}/${list.artifacts[0].id}?path=/etc/passwd`).set('authorization', 'Bearer owner').expect(400);
    await request.get(`${url}?limit=101`).set('authorization', 'Bearer owner').expect(400);
    await request.get(url.replace('/items/item/', '/items/other/')).set('authorization', 'Bearer owner').expect(404);
    await request.get(url.replace('/projects/project/', '/projects/other/')).set('authorization', 'Bearer owner').expect(404);
  });
});
