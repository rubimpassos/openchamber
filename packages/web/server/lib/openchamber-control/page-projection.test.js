import fs from 'node:fs/promises';
import { afterEach, expect, it, vi } from 'vitest';
import { createRenderedPageProjection } from './page-projection.js';
import { createPageAnswers } from './render-page.js';
import { createLaterPages } from './later-pages.js';

const roots = [];
afterEach(async () => {
  vi.clearAllTimers();
  vi.useRealTimers();
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});
const origin = { sessionId: 'ses_conversation', callId: 'call_page', messageId: 'msg_page', directory: '/project' };
const message = (overrides = {}) => ({
  id: origin.messageId, type: 'assistant',
  content: [{ type: 'tool', id: origin.callId, name: 'openchamber_render',
    state: { status: 'completed', metadata: { openchamber: { ok: true, answer: { answered: true, summary: 'Use A', data: { selected: 'A' } } } } } }],
  ...overrides,
});
const setup = (canonical = message(), laterPages = null) => {
  const reads = [];
  const pageAnswers = createPageAnswers();
  const read = createRenderedPageProjection({ pageAnswers, laterPages, getClient: async (directory) => ({
    message: { list: async () => { throw new Error('History scans are forbidden'); } },
    session: { message: { get: async (identity) => { reads.push({ directory, ...identity }); return canonical; } } },
  }) });
  return { read, pageAnswers, reads };
};

it('projects a settled ordinary await from its exact canonical tool call', async () => {
  const f = setup();
  expect(await f.read(origin)).toEqual({ kind: 'answered', summary: 'Use A', data: { selected: 'A' } });
  expect(f.reads).toEqual([{ directory: '/project', sessionID: 'ses_conversation', messageID: 'msg_page' }]);
});

it.each([
  { id: 'msg_other' }, { type: 'user' },
  { content: [{ type: 'tool', id: 'call_other', name: 'openchamber_render', state: { status: 'completed' } }] },
  { content: [{ type: 'tool', id: origin.callId, name: 'other_tool', state: { status: 'completed' } }] },
])('refuses a canonical record with a different origin %j', async (overrides) => {
  expect(await setup(message(overrides)).read(origin)).toBeNull();
});

it('keeps legacy origins readable without guessing a message or reviving a stale wait', async () => {
  const f = setup(message({ content: [{ type: 'tool', id: origin.callId, name: 'openchamber_render', state: { status: 'running' } }] }));
  expect(await f.read({ ...origin, messageId: undefined })).toBeNull();
  expect(f.reads).toEqual([]);
  expect(await f.read(origin)).toEqual({ kind: 'unanswered' });
});

it('reads live waits and the existing durable later owner without another answer lifecycle', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  const root = await fs.mkdtemp('/tmp/opencode/page-projection-'); roots.push(root);
  const laterPages = createLaterPages({ dataDir: root, buildOpenCodeUrl: () => 'http://unused.invalid',
    getOpenCodeAuthHeaders: () => ({}), readArchiveState: async () => 'archived',
    fetchImpl: async () => Response.json({}), warn() {} });
  const f = setup(message(), laterPages);
  const waiting = f.pageAnswers.wait({ ...origin, title: 'Choose' });
  expect(await f.read(origin)).toEqual({ kind: 'waiting' });
  f.pageAnswers.answer({ ...origin, summary: 'A', data: { selected: 'A' } });
  await waiting;
  await laterPages.open({ ...origin, title: 'Later' });
  expect(await f.read(origin)).toEqual({ kind: 'waiting', later: true });
  await laterPages.answer({ ...origin, summary: 'Later A', data: { later: true } });
  expect(await f.read(origin)).toMatchObject({ kind: 'answered', summary: 'Later A', data: { later: true } });
  expect(f.reads).toEqual([]);
  await laterPages.flush();
});
