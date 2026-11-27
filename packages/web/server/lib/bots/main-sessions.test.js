import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { OpenCode } from '@opencode/client';
import { createBotMainSessions } from './main-sessions.js';

const roots = [];
afterEach(async () => { for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }); });

const fixture = async () => {
  const root = await fs.mkdtemp('/tmp/opencode/bot-main-'); roots.push(root);
  const sessions = new Map();
  const created = [];
  const client = { session: {
    get: OpenCode.make({ baseUrl: 'http://opencode.invalid', fetch: async (url) => {
      const sessionID = new URL(url).pathname.split('/').pop();
      const info = sessions.get(sessionID);
      return info ? Response.json({ data: info })
        : Response.json({ _tag: 'SessionNotFoundError', sessionID, message: 'Session not found' }, { status: 404 });
    } }).session.get,
    create: async (input) => { created.push(input.id); sessions.set(input.id, { ...input, id: input.id }); return input; },
    update: async () => {}, synthetic: async () => {},
  } };
  let clock = 1;
  const main = createBotMainSessions({ dataDir: root, clientFor: () => client, knowledge: { sync: async () => true }, now: () => clock++ });
  const prepare = async () => ({ selection: { providerID: 'provider', modelID: 'model' }, title: 'Bot' });
  return { main, sessions, created, prepare, root };
};

it('opens one main chat per bot in its own folder and keeps it across calls', async () => {
  // Given a bot. When its main chat is opened twice.
  const f = await fixture();
  const first = await f.main.ensure('bot', f.prepare);
  const second = await f.main.ensure('bot', f.prepare);

  // Then one root lead exists outside any project, marked as the bot's main chat.
  expect(second).toEqual(first);
  expect(f.created).toEqual([first.sessionId]);
  expect(first.directory.startsWith(path.join(f.root, 'bots', 'home'))).toBe(true);
  expect(f.sessions.get(first.sessionId).metadata.openchamber).toEqual({ lead: { at: first.createdAt },
    automation: { source: 'bot', role: 'main', botId: 'bot', notify: 'attention' } });
  expect(await f.main.botFor(first.sessionId)).toBe('bot');
});

it.each([['deleted', (info, sessions) => sessions.delete(info.id)], ['archived', (info) => { info.time = { archived: 5 }; }]])(
  'opens a new main chat when the previous one was %s', async (_label, remove) => {
    // Given a main chat the user then removed.
    const f = await fixture();
    const first = await f.main.ensure('bot', f.prepare);
    remove(f.sessions.get(first.sessionId), f.sessions);

    // When the main chat is opened again.
    const next = await f.main.ensure('bot', f.prepare);

    // Then a new session replaces it, and the old one no longer belongs to the bot.
    expect(next.sessionId).not.toBe(first.sessionId);
    expect(f.created).toEqual([first.sessionId, next.sessionId]);
    expect(await f.main.botFor(first.sessionId)).toBeNull();
    expect(await f.main.ensure('bot', f.prepare)).toEqual(next);
  });
