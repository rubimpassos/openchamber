import { afterEach, beforeEach, expect, test } from 'bun:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { createSpaceRecords } from '../spaces/space-records.js';
import { createSpaceWorker } from './space-worker.js';

const spaceId = 'aabbccddeeff';
const purpose = 'pr-fix-loop-approval';
const head = 'a'.repeat(40);
// OpenCode 2.0.29 GET /api/session/:id/message returns newest first.
const idle = { id: 'msg_14544e414001YJbNd55i4mVbiu', type: 'idle', time: { created: 1792163505172 } };
const assistant = { id: 'msg_14544d33e0018CMjlERpaKel5l', type: 'assistant',
  time: { created: 1792163500908, streamed: 1792163505147, completed: 1792163505166 },
  content: [{ type: 'text', text: 'current result' }] };
const user = { id: 'msg_14544c7c5002mUraHhXf0R05Co', type: 'user', time: { created: 1792163500841 }, text: 'current request' };
const page = (data, next) => ({ data, cursor: next ? { next } : {} });
const steps = (start) => Array.from({ length: 100 }, (_, index) => ({ ...assistant, id: `msg_step_${start - index}`,
  time: { created: start - index, completed: start - index }, finish: 'tool-calls' }));
const longTurnTop = () => [
  { ...idle, time: { created: 10002 } }, { ...assistant, time: { created: 10001, completed: 10001 } }, ...steps(10000).slice(0, 98),
];
const worker = { spaceId, parentSessionId: 'ses_host', directory: '/repo', model: { providerID: 'openai', modelID: 'gpt-4.1' }, sessionId: null, spacePath: null };
let directory;
let records;
let calls;
let creates;
let fetched;
let replies;
let currentHost;
let gitCommands;
beforeEach(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'space-worker-'));
  records = createSpaceRecords({ dataDir: directory }); calls = []; creates = []; fetched = []; replies = []; gitCommands = [];
  records.write(spaceId, { purpose, approvalModel: worker.model, repository: '/repo', spacePath: `/spaces/${spaceId}/repo`, network: { mode: 'allowlist', domains: [] },
    grants: [{ kind: 'model', id: 'openai', provider: 'openai', upstream: 'https://api.openai.com/v1', header: 'authorization', source: { kind: 'env', name: 'TEST_KEY' } }] });
  currentHost = {
    journey: { listSpaces: async () => [{ id: spaceId, purpose, state: 'running', access: 'granted', needsAccess: [] }],
      createSpace: async (request) => { creates.push(request); return { id: spaceId }; } },
    manager: { verify: async () => [], execArgv: async () => ['docker', 'exec', spaceId],
      exec: async (_id, args) => { calls.push(args); return { code: 0 }; } },
    dispatcher: { requestInside: async (id, request) => {
      calls.push({ id, request }); const response = Readable.from([Buffer.from(JSON.stringify(replies.shift()))]); response.statusCode = 200; return response;
    } },
  };
});
afterEach(async () => { await fs.rm(directory, { recursive: true, force: true }); });
const make = () => createSpaceWorker({ dataDir: directory, getHost: () => currentHost,
  git: { output: async (_where, args) => { gitCommands.push(args); return ''; } },
  gitServices: () => ({ fetchHead: async (...args) => { fetched.push(args); } }),
  readHostSession: async () => ({ id: 'ses_host', location: { directory: '/repo' } }),
});

test('prepares a new permanently restricted space without creating grants or enabling Spaces', async () => {
  // Given / When
  const prepared = await make().prepare({ parentSessionId: 'ses_host', directory: '/repo', model: worker.model, name: 'PR worker' });
  // Then
  expect(creates).toEqual([{ projectDirectory: '/repo', name: 'PR worker', placeId: undefined,
    start: 'clean', purpose, approvalModel: worker.model, network: { mode: 'allowlist', domains: [] }, setupCommands: [] }]);
  expect(prepared.parentSessionId).toBe('ses_host'); expect(calls).toEqual([]);
});

test('refuses preparation while Spaces is off without probing a runtime', async () => {
  currentHost = null;
  await expect(make().prepare({ parentSessionId: 'ses_host', directory: '/repo', model: worker.model, name: 'PR worker' })).rejects.toThrow();
  expect(creates).toEqual([]); expect(calls).toEqual([]);
});

test('rejects unreviewed model pairs and a worker model differing from the permanent profile', async () => {
  await expect(make().prepare({ parentSessionId: 'ses_host', directory: '/repo',
    model: { providerID: 'openai', modelID: 'unreviewed-search-model' }, name: 'PR worker' })).rejects.toThrow();
  expect(creates).toEqual([]);
  await expect(make().validate({ ...worker, model: { providerID: 'openai', modelID: 'gpt-5.4' } })).rejects.toThrow();
  expect(calls).toEqual([]);
});

test('refuses an ordinary user space before any request or command inside it', async () => {
  records.remove(spaceId); records.write(spaceId, { repository: '/repo', network: { mode: 'allowlist', domains: [] } });
  await expect(make().validate(worker)).rejects.toThrow();
  expect(calls).toEqual([]);
});

test('refuses a protected worker until its selected model has an explicit grant', async () => {
  records.update(spaceId, { grants: [] });
  await expect(make().validate(worker)).rejects.toThrow();
  expect(calls).toEqual([]);
});

test('fetches and seeds the exact PR object before creating the worker session', async () => {
  // Given
  replies.push({ data: { id: 'ses_worker', executable: 'host command' } });
  const loop = { id: 'fixloop_test', worker, directory: '/repo', sessionId: 'ses_host', number: 7 };
  // When
  const initialized = await make().initialize(loop, { headSha: head });
  // Then
  expect(fetched).toHaveLength(1);
  expect(gitCommands[0].at(-1)).toBe(`${head}:refs/heads/openchamber-fix-loop`);
  expect(initialized.sessionId).toBe('ses_worker');
  expect(calls.at(-1).id).toBe(spaceId);
  expect(calls.at(-1).request.path).toBe('/api/session');
});

test('polls the space queue and live status without treating host-id claims as host activity', async () => {
  replies.push({ sessions: [] }, { data: { ses_host: { type: 'busy' } } });
  const busy = await make().working({ worker: { ...worker, sessionId: 'ses_worker', spacePath: `/spaces/${spaceId}/repo` } });
  expect(busy).toBe(true);
  expect(calls.map((call) => call.id)).toEqual([spaceId, spaceId]);
});

test('an incomplete worker status response never grants idle authority', async () => {
  replies.push({ sessions: [] }, {});
  await expect(make().working({ worker: { ...worker, sessionId: 'ses_worker' } })).rejects.toThrow();
  expect(gitCommands).toEqual([]);
});

test('reads completed assistant text as untrusted data through the worker channel', async () => {
  replies.push(page([{ ...assistant, content: [
    { type: 'reasoning', text: 'private' }, { type: 'text', text: 'structured result' },
  ] }, user]));
  expect(await make().reviewResult({ worker: { ...worker, sessionId: 'ses_worker' } })).toBe('structured result');
  expect(calls[0].id).toBe(spaceId);
  replies.push(page([{ ...assistant, time: { created: assistant.time.created }, content: [{ type: 'text', text: 'unfinished' }] }, user]));
  await expect(make().reviewResult({ worker: { ...worker, sessionId: 'ses_worker' } })).rejects.toThrow();
});

test('reads the current completed assistant behind the real idle-first wire shape', async () => {
  // Given
  replies.push(page([idle, assistant, user]));
  // When
  const result = await make().reviewResult({ worker: { ...worker, sessionId: 'ses_worker' } });
  // Then
  expect(result).toBe('current result');
  expect(calls[0].request.path).toBe('/api/session/ses_worker/message?limit=100');
  expect(calls).toHaveLength(1);
});

test.each(['reviewResult', 'working'])('accepts nullable terminal cursors through %s', async (method) => {
  // Given a settled current turn and the nullable cursor envelope from a real space.
  if (method === 'working') replies.push({ sessions: [] }, { data: {} });
  replies.push({ data: [idle, assistant, user], cursor: { previous: null, next: null } });
  // When readiness or result extraction reads the complete turn.
  const result = await make()[method]({ worker: { ...worker, sessionId: 'ses_worker' } });
  // Then the terminal cursors do not discard the completed result or invent activity.
  expect(result).toBe(method === 'working' ? false : 'current result');
});

test('selects the newest assistant of the latest user turn without reading older turns', async () => {
  // Given
  const older = { ...assistant, id: 'msg_older', time: { created: user.time.created + 1, completed: user.time.created + 2 },
    content: [{ type: 'text', text: 'previous step' }], finish: 'tool-calls' };
  replies.push(page([{ ...idle, outcome: 'succeeded' }, assistant, older, user, { type: 'unknown-old-record' }]));
  // When
  const result = await make().reviewResult({ worker: { ...worker, sessionId: 'ses_worker' } });
  // Then
  expect(result).toBe('current result');
});

test.each([
  ['missing messages', []],
  ['missing assistant', [idle, user]],
  ['previous turn assistant', [idle, user, assistant]],
  ['previous idle boundary', [idle, { ...idle, id: 'msg_previous' }, assistant, user]],
  ['missing user boundary', [idle, assistant]],
  ['incomplete assistant', [idle, { ...assistant, time: { created: assistant.time.created } }, user, assistant]],
  ['failed idle', [{ ...idle, outcome: 'failed' }, assistant, user]],
  ['interrupted idle', [{ ...idle, outcome: 'interrupted' }, assistant, user]],
  ['idle error', [{ ...idle, error: { message: 'failed' } }, assistant, user]],
  ['assistant error', [idle, { ...assistant, error: { message: 'failed' } }, user]],
  ['assistant retry', [idle, { ...assistant, retry: { attempt: 1 } }, user]],
  ['failed finish', [idle, { ...assistant, finish: 'error' }, user]],
  ['unknown finish', [idle, { ...assistant, finish: 'unknown' }, user]],
  ['truncated finish', [idle, { ...assistant, finish: 'length' }, user]],
  ['filtered finish', [idle, { ...assistant, finish: 'content-filter' }, user]],
  ['tool continuation', [idle, { ...assistant, finish: 'tool-calls' }, user]],
  ['unknown tail', [{ ...idle, type: 'future-marker' }, assistant, user]],
  ['unknown current record', [idle, assistant, { ...idle, type: 'future-marker' }, user]],
  ['malformed time', [{ ...idle, time: {} }, assistant, user]],
  ['stale assistant', [idle, { ...assistant, time: { ...assistant.time, created: user.time.created - 1 } }, user]],
  ['reversed page', [user, assistant, idle]],
  ['unknown content', [idle, { ...assistant, content: [{ type: 'future-content' }] }, user]],
  ['unfinished tool', [idle, { ...assistant, content: [{ type: 'tool', state: { status: 'running' } }] }, user]],
  ['invalid completion time', [idle, { ...assistant, time: { ...assistant.time, completed: 1 } }, user]],
  ['completion after idle', [idle, { ...assistant, time: { ...assistant.time, completed: idle.time.created + 1 } }, user]],
  ['bounded page without turn boundary', [idle, ...Array.from({ length: 31 }, () => assistant)]],
])('rejects %s as completed review evidence', async (_name, data) => {
  // Given
  replies.push(page(data));
  // When / Then
  await expect(make().reviewResult({ worker: { ...worker, sessionId: 'ses_worker' } })).rejects.toThrow();
});

test.each([
  ['idle-first settled turn', [idle, assistant, user], false],
  ['ordinary settled turn', [assistant, user], false],
  ['pending user', [user, assistant], true],
  ['incomplete assistant', [{ ...assistant, time: { created: assistant.time.created } }, user], true],
])('reports working safely for %s', async (_name, data, expected) => {
  // Given
  replies.push({ sessions: [] }, { data: {} }, page(data));
  // When
  const result = await make().working({ worker: { ...worker, sessionId: 'ses_worker' } });
  // Then
  expect(result).toBe(expected);
});

test.each([
  ['empty page', []],
  ['unknown tail', [{ ...idle, type: 'future-marker' }]],
  ['idle without result', [idle, user, assistant]],
  ['failed turn', [{ ...idle, outcome: 'failed' }, assistant, user]],
  ['failed assistant', [{ ...assistant, error: { message: 'failed' } }, user]],
  ['truncated turn', [idle, assistant]],
])('never establishes idle authority from %s', async (_name, data) => {
  // Given
  replies.push({ sessions: [] }, { data: {} }, page(data));
  // When / Then
  await expect(make().working({ worker: { ...worker, sessionId: 'ses_worker' } })).rejects.toThrow();
});

test.each(['reviewResult', 'working'])('reads a completed long turn across cursor pages through %s', async (method) => {
  // Given
  if (method === 'working') replies.push({ sessions: [] }, { data: {} });
  replies.push(page(longTurnTop(), 'older /?&'), page(steps(9902), 'last'));
  replies.push(page([{ ...user, time: { created: 1 } }, { type: 'unknown-previous-turn' }], 'must-not-read'));
  // When
  const result = await make()[method]({ worker: { ...worker, sessionId: 'ses_worker' } });
  // Then
  expect(result).toBe(method === 'working' ? false : 'current result');
  const paths = calls.filter((call) => call.request.path.includes('/message?')).map((call) => call.request.path);
  expect(paths).toEqual(['/api/session/ses_worker/message?limit=100',
    '/api/session/ses_worker/message?limit=100&cursor=older%20%2F%3F%26', '/api/session/ses_worker/message?limit=100&cursor=last']);
});

test.each([
  ['missing cursor envelope', { data: steps(9902) }],
  ['missing next cursor', page(steps(9902))],
  ['empty next cursor', { data: steps(9902), cursor: { next: '' } }],
  ['repeated cursor', page(steps(9902), 'older')],
  ['overlapping page', page([longTurnTop().at(-1), { ...user, time: { created: 1 } }])],
  ['nonmonotonic page', page([{ ...assistant, id: 'msg_newer', time: { created: 10003, completed: 10003 } }, user])],
  ['empty terminal page', page([])],
  ['short terminal page', page(steps(9902).slice(0, 2), 'cannot-use')],
  ['prior turn boundary', page([{ ...idle, time: { created: 9902 } }, { ...user, time: { created: 1 } }])],
  ['unknown later record', page([{ type: 'future-marker' }])],
  ['malformed later record', page([{ ...assistant, time: {} }])],
])('refuses %s across pages without returning partial completion', async (_name, broken) => {
  // Given
  replies.push(page(longTurnTop(), 'older'), broken);
  // When / Then
  await expect(make().reviewResult({ worker: { ...worker, sessionId: 'ses_worker' } })).rejects.toThrow();
  expect(calls).toHaveLength(2);
});

test('refuses a cursor cycle before issuing another request', async () => {
  // Given
  replies.push(page(longTurnTop(), 'a'), page(steps(9902), 'b'), page(steps(9802), 'a'));
  // When / Then
  await expect(make().reviewResult({ worker: { ...worker, sessionId: 'ses_worker' } })).rejects.toThrow();
  expect(calls).toHaveLength(3);
});

test('blocks a turn beyond the finite transfer budget without requesting another page', async () => {
  // Given
  replies.push(page(longTurnTop(), 'older-0'));
  for (let index = 0; index < 31; index += 1) replies.push(page(steps(9902 - index * 100), `older-${index + 1}`));
  // When / Then
  await expect(make().reviewResult({ worker: { ...worker, sessionId: 'ses_worker' } })).rejects.toThrow(/limit/);
  expect(calls).toHaveLength(32);
});

test('accepts the user boundary on the last allowed page', async () => {
  // Given
  replies.push(page(longTurnTop(), 'older-0'));
  for (let index = 0; index < 30; index += 1) replies.push(page(steps(9902 - index * 100), `older-${index + 1}`));
  replies.push(page([...steps(6902).slice(0, 99), { ...user, time: { created: 1 } }], 'must-not-read'));
  // When
  const result = await make().reviewResult({ worker: { ...worker, sessionId: 'ses_worker' } });
  // Then
  expect(result).toBe('current result');
  expect(calls).toHaveLength(32);
});
