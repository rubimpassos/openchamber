import fs from 'node:fs/promises';
import path from 'node:path';
import express from 'express';
import supertest from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createBotArtifactCapture } from './artifacts-capture.js';
import { createBotArtifacts } from './artifacts-owner.js';
import { createBotArtifactService, createBotArtifactTransport, registerBotArtifactServiceRoutes } from '../agent-server/bot-artifact-services.js';
import { BOT_ARTIFACT_CHUNK_BYTES, artifactHash } from './artifacts-contract.js';
import { BOT_ARTIFACT_AGENT_ROUTE, BOT_ARTIFACT_SPACE_ROUTE } from '../agent-server/bot-artifact-service-contract.js';

let root;
let binding;
let source;
let owner;
beforeEach(async () => {
  root = await fs.mkdtemp('/tmp/opencode/bot-artifact-transfer-');
  binding = { projectId: 'project', botId: 'bot', itemId: 'item', sessionId: 'ses_space', directory: root,
    producer: { role: 'stage', stage: 'fixing' } };
  source = createBotArtifactCapture({ dataDir: path.join(root, 'source'), resolveSession: async () => binding, onCaptured: async () => {} });
  owner = createBotArtifacts({ dataDir: path.join(root, 'owner'), resolveBinding: async () => binding, assertReadScope: async () => {} });
});
afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });
const context = (callId = 'call_1') => ({ sessionId: binding.sessionId, callId, directory: root });
const resolveBinding = async () => binding;
function httpTransport(placement) {
  const app = express();
  app.use((req, res, next) => req.get('authorization') === 'Bearer executor' ? next() : res.sendStatus(401));
  registerBotArtifactServiceRoutes(app, {
    service: createBotArtifactService({ capture: source, resolveBinding }), placement, isAllowed: () => true,
  });
  const api = supertest(app);
  const prefix = placement === 'space' ? BOT_ARTIFACT_SPACE_ROUTE : BOT_ARTIFACT_AGENT_ROUTE;
  const responseSizes = [];
  const transport = createBotArtifactTransport({ request: async (operation, body, signal) => {
    signal.throwIfAborted();
    const response = await api.post(`${prefix}/${operation}`).set('authorization', 'Bearer executor').set('Content-Type', 'application/json').send(body).expect(200);
    responseSizes.push(Buffer.byteLength(response.text));
    return response.body;
  } });
  return { transport, api, prefix, responseSizes };
}

describe('bounded artifact snapshot transfer', () => {
  it('transfers a 25 MiB image snapshot through sub-megabyte chunks, then survives execution cleanup', async () => {
    const imagePaths = [];
    const hashes = [];
    for (const [index, size] of [10 * 1024 * 1024, 10 * 1024 * 1024, 5 * 1024 * 1024, 16].entries()) {
      const image = path.join(root, `proof-${index}.png`);
      const bytes = Buffer.alloc(size, index);
      Buffer.from('89504e470d0a1a0a', 'hex').copy(bytes);
      await fs.writeFile(image, bytes);
      imagePaths.push(image);
      hashes.push(artifactHash(bytes));
    }
    const reference = await source.capture({ body: { format: 'html', content: imagePaths.map((image) => `<img src="${image}">`).join('') }, title: 'Visual proof' }, context());
    for (const image of imagePaths) await fs.rm(image);
    const { transport, responseSizes } = httpTransport('space');

    await owner.collect(binding, transport);
    await fs.rm(path.join(root, 'source'), { recursive: true });
    const restarted = createBotArtifacts({ dataDir: path.join(root, 'owner'), resolveBinding: async () => null, assertReadScope: async () => {} });
    const saved = await restarted.read(binding, reference.id);

    expect(saved.payload.assets.filter((asset) => asset.status === 'ready').map((asset) => artifactHash(Buffer.from(asset.data, 'base64')))).toEqual(hashes.slice(0, 3));
    expect(saved.artifact.incompleteAssets).toEqual([{ source: imagePaths[3], status: 'too-heavy' }]);
    expect(responseSizes.every((size) => size < 1024 * 1024)).toBe(true);
    expect(saved.artifact.id).toBe(reference.id);
  });

  it.each(['agent', 'space'])('pulls only exact captured bindings through the %s route', async (placement) => {
    await source.capture({ body: { format: 'ui', content: 'root = Text("proof")' }, title: 'Proof' }, context());
    const { transport, api, prefix } = httpTransport(placement);

    await api.post(`${prefix}/pull`).send({ binding }).expect(401);
    const refused = await api.post(`${prefix}/pull`).set('authorization', 'Bearer executor').send({ binding: { ...binding, itemId: 'other' } }).expect(403);
    expect(refused.body.code).toBe('BOT_ARTIFACT_BINDING_REQUIRED');
    await api.post(`${prefix}/pull`).set('authorization', 'Bearer executor').send({ binding, path: '/etc/passwd' }).expect(400);
    await api.post(`${prefix}/pull?path=/etc/passwd`).set('authorization', 'Bearer executor').send({ binding }).expect(400);
    await owner.collect(binding, transport);
    expect((await owner.list(binding)).artifacts).toHaveLength(1);
  });

  it('leaves an interrupted transfer unpublished and recovers it from the captured snapshot after restart', async () => {
    const reference = await source.capture({ body: { format: 'ui', content: 'root = Text("restart")' }, title: 'Recovery' }, context());
    const service = createBotArtifactService({ capture: source, resolveBinding });
    const broken = { pull: service.pull, chunk: async () => { throw new Error('execution offline'); } };

    await expect(owner.collect(binding, broken)).rejects.toThrow('execution offline');
    expect((await owner.list(binding)).artifacts).toEqual([]);
    const restartedSource = createBotArtifactCapture({ dataDir: path.join(root, 'source'), resolveSession: async () => binding, onCaptured: async () => {} });
    await owner.collect(binding, createBotArtifactService({ capture: restartedSource, resolveBinding }));

    expect((await owner.read(binding, reference.id)).payload.body.content).toBe('root = Text("restart")');
  });

  it.each(['offset', 'digest', 'bytes', 'short'])('refuses a changed chunk %s without attaching the artifact', async (change) => {
    await source.capture({ body: { format: 'ui', content: 'root = Text("proof")' }, title: 'Integrity' }, context());
    const service = createBotArtifactService({ capture: source, resolveBinding });
    const transport = { pull: service.pull, chunk: async (input) => {
      const reply = await service.chunk(input);
      switch (change) {
        case 'offset': return { ...reply, offset: reply.offset + 1 };
        case 'digest': return { ...reply, payloadDigest: '0'.repeat(64) };
        case 'bytes': return { ...reply, data: Buffer.alloc(Buffer.from(reply.data, 'base64').length).toString('base64') };
        case 'short': return { ...reply, data: Buffer.from('a').toString('base64') };
        default: throw new Error('unknown test change');
      }
    } };
    await expect(owner.collect(binding, transport)).rejects.toMatchObject({ code: change === 'bytes' ? 'BOT_ARTIFACT_PAYLOAD_CHANGED' : 'BOT_ARTIFACT_CHUNK_MISMATCH' });
    expect((await owner.list(binding)).artifacts).toEqual([]);
  });

  it('replays an attached manifest without pulling its payload again', async () => {
    const reference = await source.capture({ body: { format: 'ui', content: 'root = Text("proof")' }, title: 'Replay' }, context());
    const service = createBotArtifactService({ capture: source, resolveBinding });
    await owner.collect(binding, service);

    await owner.collect(binding, { pull: service.pull, chunk: async () => { throw new Error('unexpected payload read'); } });

    expect((await owner.list(binding)).artifacts.map((entry) => entry.id)).toEqual([reference.id]);
  });

  it('rejects altered asset bytes even when their body, binding, sizes and metadata still match', async () => {
    const image = path.join(root, 'proof.png');
    await fs.writeFile(image, Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex'));
    await source.capture({ body: { format: 'html', content: `<img src="${image}">` }, title: 'Digest' }, context());
    const service = createBotArtifactService({ capture: source, resolveBinding });
    const altered = { pull: service.pull, chunk: async (input) => {
      const reply = await service.chunk(input);
      const payload = JSON.parse(Buffer.from(reply.data, 'base64').toString('utf8'));
      const bytes = Buffer.from(payload.assets[0].data, 'base64');
      bytes[bytes.length - 1] ^= 1;
      payload.assets[0].data = bytes.toString('base64');
      return { ...reply, data: Buffer.from(JSON.stringify(payload)).toString('base64') };
    } };

    await expect(owner.collect(binding, altered)).rejects.toMatchObject({ code: 'BOT_ARTIFACT_PAYLOAD_CHANGED' });

    expect((await owner.list(binding)).artifacts).toEqual([]);
  });

  it('holds flush until an admitted collection finishes and refuses invalid chunk selectors', async () => {
    const reference = await source.capture({ body: { format: 'ui', content: 'root = Text("proof")' }, title: 'Flush' }, context());
    const service = createBotArtifactService({ capture: source, resolveBinding });
    const started = Promise.withResolvers();
    const release = Promise.withResolvers();
    const collecting = owner.collect(binding, { pull: service.pull, chunk: async (input) => {
      started.resolve(); await release.promise; return service.chunk(input);
    } });
    await started.promise;
    let flushed = false;
    const flush = owner.flush().then(() => { flushed = true; });
    await Promise.resolve();
    expect(flushed).toBe(false);

    release.resolve();
    await Promise.all([collecting, flush]);

    expect(flushed).toBe(true);
    await expect(service.chunk({ binding, id: reference.id, callId: 'other', offset: 0 })).rejects.toMatchObject({ code: 'BOT_ARTIFACT_CHUNK_INVALID' });
    await expect(service.chunk({ binding, id: reference.id, callId: 'call_1', offset: BOT_ARTIFACT_CHUNK_BYTES })).rejects.toMatchObject({ code: 'BOT_ARTIFACT_CHUNK_INVALID' });
  });
});
