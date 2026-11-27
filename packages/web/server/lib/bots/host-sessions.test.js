import { afterEach, expect, it } from 'vitest';
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createBotHostSessions } from './host-sessions.js';
import { createBotNotices } from './notices.js';
import { createBotStore } from './store.js';
import { createBotItem } from './schema.js';
import { botDefinitionSchema } from './config.js';

const fixtures = [];
afterEach(async () => { for (const close of fixtures.splice(0)) await close(); });

it.each([
  { enveloped: false, archivedAt: undefined, archived: true },
  { enveloped: true, archivedAt: 10, archived: false },
])('reads the captured host placement and archive state when enveloped=$enveloped', async ({ enveloped, archivedAt, archived }) => {
  // Given a captured host item whose bot now requests isolation.
  const bot = botDefinitionSchema.parse({ id: 'bot', name: 'Bot', mission: 'Fix', isolated: true });
  const item = { ...createBotItem({ id: 'item', botId: bot.id, title: 'Bug', source: { kind: 'manual', id: 'one' } }),
    worktree: '/captured/checkout', sessions: { fixing: 'ses_captured' } };
  const metadata = { openchamber: { automation: { source: 'bot', projectId: 'project', botId: bot.id, itemId: item.id, stage: 'fixing' } } };
  const sessions = createBotHostSessions({ resolvePlacement: async () => ({ isolated: false }),
    clientFor: (directory) => ({ session: { get: async ({ sessionID }) => {
      const info = { id: sessionID, location: { directory }, time: { archived: archivedAt }, metadata };
      return enveloped ? { data: info } : info;
    } } }), isSessionArchived: async () => archived });

  // When the notice owner reads the recorded session.
  const session = await sessions.readSession({ projectId: 'project', item, bot, sessionId: 'ses_captured' });

  // Then it retains host routing, metadata and both archive sources.
  expect(session).toEqual({ id: 'ses_captured', directory: item.worktree, isolated: false, archived: true, metadata });
});

it('reads conversation usage with the exact recorded project scope when the registry adds fields', async () => {
  // Given a conversation and a project registry entry with display fields.
  const bot = botDefinitionSchema.parse({ id: 'bot', name: 'Bot', mission: 'Fix' });
  const conversation = { sessionId: 'ses_conversation', directory: '/project', createdAt: 1 };
  const item = { ...createBotItem({ id: 'item', botId: bot.id, title: 'Bug', source: { kind: 'manual', id: 'one' } }), conversation };
  const targets = [];
  const sessions = createBotHostSessions({ resolvePlacement: async () => ({ isolated: false }),
    resolveProject: async (id) => ({ id, path: '/project', label: 'Project', icon: null }),
    conversations: { tokens: async (target) => { targets.push(target); return 42; } } });
  await sessions.trackItem('project', item, bot);

  // When the usage owner reads it after an assistant turn.
  const total = await sessions.tokenSnapshot(conversation.sessionId, conversation.directory);

  // Then the target carries only the captured scope.
  expect(total).toBe(42);
  expect(targets).toEqual([{ project: { id: 'project', path: '/project' }, botId: 'bot', itemId: 'item', conversation }]);
});

it('owns isolated queue transport, persistence, trusted events and cache-inclusive usage without host fallback', async () => {
  const root = await fs.mkdtemp('/tmp/opencode/bot-host-session-');
  const directory = '/spaces/a1b2c3d4e5f6/repo';
  const sessionId = 'ses_bot_recorded';
  const bot = botDefinitionSchema.parse({ id: 'bot', name: 'Bot', mission: 'Fix', isolated: true });
  const store = createBotStore({ projectsDirPath: path.join(root, 'projects') });
  await store.update('project', (snapshot) => ({ snapshot: { ...snapshot, items: [createBotItem({ id: 'item', botId: 'bot', title: 'Bug', source: { kind: 'manual', id: 'one' } })] } }));
  await store.update('project', (snapshot) => ({ snapshot: { ...snapshot, items: snapshot.items.map((item) => ({ ...item,
    state: 'investigating', worktree: '/owned/checkout', sessions: { fixing: sessionId } })) } }));
  const item = (await store.read('project')).items[0];
  const info = { id: sessionId, location: { directory }, metadata: { openchamber: { automation: { source: 'bot', projectId: 'project', botId: 'bot', itemId: 'item', stage: 'fixing' } } } };
  const binding = { spaceId: 'a1b2c3d4e5f6', projectId: 'project', itemId: 'item', botId: 'bot', hostDirectory: item.worktree, directory };
  const calls = { host: 0, isolated: 0, sent: [], knowledge: [] };
  let accepted;
  const acceptance = new Promise((resolve) => { accepted = resolve; });
  let available = true;
  const inside = http.createServer(async (req, res) => {
    res.setHeader('content-type', 'application/json');
    const url = new URL(req.url, 'http://inside');
    if (url.pathname === '/api/session/active') return res.end(JSON.stringify({ data: {} }));
    if (url.pathname === '/api/session') return res.end(JSON.stringify({ data: [], cursor: {} }));
    if (url.pathname.endsWith('/message')) return res.end(JSON.stringify({ data: [], cursor: {} }));
    if (url.pathname.endsWith('/synthetic')) {
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      calls.sent.push(JSON.parse(Buffer.concat(chunks)));
      res.end(JSON.stringify({ data: { id: calls.sent.at(-1).id } })); accepted(); return;
    }
    res.end(JSON.stringify({ data: info }));
  });
  await new Promise((resolve) => inside.listen(0, '127.0.0.1', resolve));
  let notices;
  const sessions = createBotHostSessions({ dataDir: root,
    resolvePlacement: async () => ({ isolated: true }),
    isolated: { sessionOwner: async () => {
      if (!available) throw new Error('Space is unavailable');
      return { binding, info, client: { session: { instructions: { entry: { put: async () => {} } } } },
        tokens: async () => 15, probe: { fetchActiveSessionStatuses: async () => ({}), hasWorkingDescendants: async () => false },
        fetchImpl: async (input, init) => {
          calls.isolated++;
          const url = new URL(input instanceof Request ? input.url : input);
          return fetch(`http://127.0.0.1:${inside.address().port}${url.pathname}${url.search}`, init);
        } };
    } },
    clientFor: () => { calls.host++; throw new Error('Host session access is forbidden'); },
    hostQueue: { enqueue: async () => { calls.host++; throw new Error('Host queue is forbidden'); } },
    readHostTokens: async () => { calls.host++; throw new Error('Host usage is forbidden'); },
    isSessionArchived: async () => false,
    assertDispatch: (input) => notices.assertDispatch(input), broadcast: () => {},
    sessionKnowledgeRuntime: { collect: async (...args) => { calls.knowledge.push(args); return { notes: [], plans: [], memory: { global: [], project: [] } }; } },
  });
  fixtures.push(async () => { await sessions.stop(); inside.closeAllConnections(); await new Promise((resolve) => inside.close(resolve)); await fs.rm(root, { recursive: true, force: true }); });
  await sessions.trackItem('project', item, bot);
  notices = createBotNotices({ store, config: { read: async () => ({ definitions: [bot] }) }, readSession: sessions.readSession, queueFor: sessions.queueFor });
  await sessions.restore(async (_entry, error) => { throw error; });
  const notice = { projectId: 'project', item, eventId: 'review:1', text: 'Please address this review.' };
  await notices.deliver(notice);
  await Promise.race([acceptance, new Promise((_resolve, reject) => setTimeout(() => reject(new Error('Isolated synthetic was not delivered')), 5_000).unref())]);
  expect(calls.sent).toEqual([expect.objectContaining({ text: notice.text, delivery: 'steer', resume: true,
    metadata: { source: 'openchamber-notice', kind: 'bot', projectId: 'project', itemId: 'item', eventId: 'review:1' } })]);
  expect(await sessions.isWorking(sessionId)).toBe(false);
  expect(await sessions.tokenSnapshot(sessionId, directory)).toBe(15);
  expect(calls.host).toBe(0);
  const queueFile = path.join(root, 'bots', 'isolated-queues', binding.spaceId, sessionId, 'message-queue.json');
  expect(JSON.parse(await fs.readFile(queueFile, 'utf8')).version).toBe(1);
  available = false;
  await expect(sessions.readSession({ projectId: 'project', item, bot, sessionId })).rejects.toThrow('Space is unavailable');
  await expect(sessions.isWorking(sessionId)).rejects.toThrow('Space is unavailable');
  expect(calls.host).toBe(0);
});
