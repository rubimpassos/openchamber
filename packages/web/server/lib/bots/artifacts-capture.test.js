import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createBotArtifactCapture } from './artifacts-capture.js';
import { botArtifactBindingFromSession } from './artifacts-contract.js';
import { createBotArtifacts } from './artifacts-owner.js';
import { createPageAnswers, createRenderPageAction } from '../openchamber-control/render-page.js';

let root;
let binding;
let owner;
let capture;
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==', 'base64');
const context = () => ({ sessionId: binding.sessionId, callId: 'call_first', directory: binding.directory });
beforeEach(async () => {
  root = await fs.mkdtemp('/tmp/opencode/bot-artifact-capture-');
  binding = { projectId: 'project', botId: 'bot', itemId: 'item', sessionId: 'ses_bot',
    directory: path.join(root, 'worktree'), producer: { role: 'stage', stage: 'fixing' } };
  await fs.mkdir(binding.directory);
  owner = createBotArtifacts({ dataDir: path.join(root, 'owner'), resolveBinding: async () => binding, assertReadScope: async () => {} });
  capture = createBotArtifactCapture({ dataDir: path.join(root, 'execution'), resolveSession: async () => binding,
    onCaptured: async () => {}, publish: (manifest, bytes) => owner.publish(binding, manifest, bytes), now: () => 1234 });
});
afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });

describe('durable render capture', () => {
  it('drains captured writes for one producer without waiting on another producer', async () => {
    const firstStarted = Promise.withResolvers(); const secondStarted = Promise.withResolvers();
    const finishFirst = Promise.withResolvers(); const finishSecond = Promise.withResolvers();
    const source = createBotArtifactCapture({ dataDir: path.join(root, 'draining'),
      resolveSession: async (sessionId) => ({ ...binding, sessionId }),
      onCaptured: async ({ binding: captured }) => {
        if (captured.sessionId === binding.sessionId) { firstStarted.resolve(); await finishFirst.promise; }
        else { secondStarted.resolve(); await finishSecond.promise; }
      } });
    const input = { body: { format: 'ui', content: 'root = Text("Drain")' }, title: 'Drain' };
    const writes = [source.capture(input, context()), source.capture(input, { ...context(), sessionId: 'ses_other' })];
    const written = Promise.allSettled(writes);
    await Promise.all([firstStarted.promise, secondStarted.promise]);
    const order = [];
    const scoped = source.flush(binding.sessionId).then(() => order.push('scoped'));
    const all = source.flush().then(() => order.push('all'));
    try {
      finishFirst.resolve(); await writes[0];
      await new Promise(setImmediate);
      expect([...order]).toEqual(['scoped']);
      finishSecond.resolve(); await all;
      expect(order).toEqual(['scoped', 'all']);
    } finally {
      finishFirst.resolve(); finishSecond.resolve(); await written; await Promise.allSettled([scoped, all]);
    }
  });
  it.each([
    ['html', false, (image) => `<title>Proof</title><img src="${image}">`],
    ['html', true, (image) => `<title>Proof</title><img src="${image}">`],
    ['ui', false, (image) => `root = Image(${JSON.stringify(image)})`],
    ['ui', false, (image) => `root = Text(${JSON.stringify(`![plot](${image})`)})`],
    ['ui', false, (image) => `root = Text(${JSON.stringify(`![plot](<${image}> "Plot")`)})`],
    ['ui', false, (image) => `root = Text(${JSON.stringify(`![plot][proof]\n\n[proof]: <${image}>`)})`],
  ])('automatically captures the %s page and frozen image with symlink=%s', async (format, symbolic, document) => {
    const image = path.join(binding.directory, 'proof(plot).png');
    const target = symbolic ? path.join(binding.directory, 'target.png') : image;
    await fs.writeFile(target, png);
    if (symbolic) await fs.symlink(target, image, 'file');
    const render = createRenderPageAction({ isEnabled: async () => true, pageAnswers: createPageAnswers(),
      hasUnreadChat: async () => false, artifacts: capture });

    const content = document(image);
    const result = await render({ [format]: content, title: 'Proof', itemId: 'forged' }, context());
    await fs.rm(binding.directory, { recursive: true });
    const reopened = createBotArtifacts({ dataDir: path.join(root, 'owner'), resolveBinding: async () => null, assertReadScope: async () => {} });
    const page = await reopened.read(binding, result.artifact.id);

    expect(result.artifact).toMatchObject({ kind: 'evidence', title: 'Proof', publication: 'published',
      source: { sessionId: 'ses_bot', callId: 'call_first', producer: { role: 'stage', stage: 'fixing' } } });
    expect(page.payload.assets).toEqual([{ source: image, status: 'ready', mime: 'image/png', data: png.toString('base64') }]);
    expect(page.payload.body).toEqual({ format, content });
    expect((await reopened.list(binding)).artifacts).toEqual([page.artifact]);
  });

  it('replays a call without rereading deleted assets and refuses changed content', async () => {
    const image = path.join(binding.directory, 'proof.png');
    await fs.writeFile(image, png);
    const input = { body: { format: 'html', content: `<img src="${image}">` }, title: 'Snapshot', artifactKind: 'decision' };
    const first = await capture.capture(input, context());
    await fs.rm(image);

    const restarted = createBotArtifactCapture({ dataDir: path.join(root, 'execution'), resolveSession: async () => binding, onCaptured: async () => {} });
    expect(await restarted.capture(input, context())).toEqual({ ...first, publication: 'captured' });
    await expect(restarted.capture({ ...input, body: { format: 'html', content: '<p>Changed</p>' } }, context()))
      .rejects.toMatchObject({ code: 'BOT_ARTIFACT_CONTENT_CONFLICT' });
  });

  it.each(['html', 'ui'])('records missing, rejected, oversized and external images explicitly in %s', async (format) => {
    const bad = path.join(binding.directory, 'bad.png');
    const big = path.join(binding.directory, 'big.png');
    const missing = path.join(binding.directory, 'missing.png');
    const invalid = `${bad}/nested.png`;
    await fs.writeFile(bad, '<html>not an image</html>');
    await fs.writeFile(big, Buffer.alloc(10 * 1024 * 1024 + 1));
    const sources = [missing, bad, big, invalid, 'https://external.invalid/plot?version=1'];
    const content = format === 'html' ? sources.map((source) => `<img src="${source}">`).join('')
      : `root = Text(${JSON.stringify(sources.map((source) => `![plot](${source})`).join('\n'))})`;
    const input = { body: { format, content }, title: 'Incomplete' };

    const result = await capture.capture(input, context());

    expect(result.incompleteAssets).toEqual([{ source: missing, status: 'missing' }, { source: bad, status: 'rejected' },
      { source: big, status: 'rejected' }, { source: invalid, status: 'rejected' }, { source: 'https://external.invalid/plot?version=1', status: 'external' }]);
  });

  it('keeps literal Markdown and Image references in page order through the first image over 25 MiB', async () => {
    const sources = ['first', 'second', 'third', 'last'].map((name) => path.join(binding.directory, `${name}.png`));
    const large = Buffer.alloc(9 * 1024 * 1024); png.copy(large);
    for (const source of sources.slice(0, 3)) await fs.writeFile(source, large);
    await fs.writeFile(sources[3], png);
    const content = `root = Stack([Text(${JSON.stringify(`![first](${sources[0]})`)}), Image("${sources[1]}"), Text(${JSON.stringify(`![third](${sources[2]})\n![last](${sources[3]})`)})])`;
    const result = await capture.capture({ body: { format: 'ui', content }, title: 'Budget' }, context());
    await fs.rm(binding.directory, { recursive: true });
    const saved = await owner.read(binding, result.id);
    expect(saved.payload.assets.map(({ source, status }) => ({ source, status }))).toEqual([
      { source: sources[0], status: 'ready' }, { source: sources[1], status: 'ready' },
      { source: sources[2], status: 'too-heavy' }, { source: sources[3], status: 'too-heavy' },
    ]);
    for (const asset of saved.payload.assets.slice(0, 2)) expect(Buffer.from(asset.data, 'base64').equals(large)).toBe(true);
  });

  it('counts unique local and external Markdown destinations against the 256 reference limit', async () => {
    const sources = Array.from({ length: 256 }, (_, index) => `https://external.invalid/plot/${index}`);
    const input = (values) => ({ body: { format: 'ui', content: `root = Text(${JSON.stringify(values.map((source) => `![plot](${source})`).join('\n'))})` }, title: 'References' });
    const accepted = await capture.capture(input([...sources, sources[0]]), context());
    expect(accepted.incompleteAssets).toEqual(sources.map((source) => ({ source, status: 'external' })));
    await expect(capture.capture(input([...sources, '/repo/plot.png']), { ...context(), callId: 'call_overflow' }))
      .rejects.toMatchObject({ code: 'BOT_ARTIFACT_TOO_MANY_ASSETS', status: 413 });
  });

  it.each(['awaitAnswer', 'answerLater', 'share'])('refuses worker %s without creating an artifact', async (mode) => {
    await expect(capture.capture({ body: { format: 'ui', content: 'root = Text("proof")' }, title: 'Proof',
      [mode]: mode === 'share' ? { recipients: ['person'] } : true }, context())).rejects.toMatchObject({ code: 'BOT_ARTIFACT_WORKER_READONLY', status: 403 });
    await expect(capture.list(binding)).resolves.toEqual({ entries: [], nextOffset: null });
  });

  it('keeps the existing page answer owner in a persistent conversation', async () => {
    binding = { ...binding, producer: { role: 'conversation' } };
    const waiting = Promise.withResolvers();
    const answers = createPageAnswers({ onWaitChange: (change) => { if (change.type === 'waiting') waiting.resolve(change); } });
    const render = createRenderPageAction({ isEnabled: async () => true, pageAnswers: answers,
      hasUnreadChat: async () => false, artifacts: capture });
    const pending = render({ ui: 'root = Text("Choose")', title: 'Choice', artifactKind: 'decision', awaitAnswer: true }, context());
    const change = await waiting.promise;
    const metadata = (await owner.list(binding)).artifacts[0];

    answers.answer({ ...change, summary: 'Chosen', data: { choice: 'A' } });
    const result = await pending;

    expect(result.answer).toEqual({ answered: true, summary: 'Chosen', data: { choice: 'A' } });
    expect(result.artifact.id).toBe(metadata.id);
    expect(metadata).toMatchObject({ kind: 'decision', interaction: 'awaitAnswer', source: { producer: { role: 'conversation' } } });
    expect(metadata).not.toHaveProperty('answer');
  });

  it('leaves normal nonbot render results unchanged', async () => {
    const normal = createBotArtifactCapture({ dataDir: root, resolveSession: async () => null, onCaptured: async () => {} });
    const render = createRenderPageAction({ isEnabled: async () => true, pageAnswers: createPageAnswers(), hasUnreadChat: async () => false, artifacts: normal });
    const plain = createRenderPageAction({ isEnabled: async () => true, pageAnswers: createPageAnswers(), hasUnreadChat: async () => false });
    expect(await render({ html: '<p>Ordinary</p>' }, context())).toEqual(await plain({ html: '<p>Ordinary</p>' }, context()));
    await expect(render({ html: '<p>Ordinary</p>', artifactKind: 'evidence' }, context()))
      .rejects.toMatchObject({ code: 'BOT_ARTIFACT_BOT_SESSION_REQUIRED' });
  });

  it('reads conversation and legacy stage provenance only from canonical session records', () => {
    const session = { id: 'ses_canonical', location: { directory: '/execution' },
      metadata: { openchamber: { automation: { source: 'bot', projectId: 'p', botId: 'b', itemId: 'i', stage: 'judge' } } } };
    expect(botArtifactBindingFromSession(session)).toMatchObject({ sessionId: 'ses_canonical', producer: { role: 'stage', stage: 'judge' } });
    expect(botArtifactBindingFromSession({ ...session, metadata: { openchamber: { automation: { ...session.metadata.openchamber.automation, role: 'conversation' } } } }))
      .toMatchObject({ producer: { role: 'conversation' } });
    expect(botArtifactBindingFromSession({ id: 'ses_normal' })).toBeNull();
    expect(() => botArtifactBindingFromSession({ ...session, location: {} })).toThrow();
  });
});
