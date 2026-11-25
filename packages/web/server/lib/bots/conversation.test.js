import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { botItemSchema, createBotItem } from './schema.js';
import { createBotDriver } from './runtime.test-support.js';
import { createBotExecutionStore } from './execution-store.js';
import { createBotConversationSessions } from './conversation-sessions.js';
import { conversationCaptureSchema } from './conversation-contract.js';
import { assertBotLeadControl } from '../session-lead/bot-guidance.js';

const roots = [];
afterEach(async () => { for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }); });
const fixture = async (options = {}) => {
  const root = await fs.mkdtemp('/tmp/opencode/bot-conversation-'); roots.push(root);
  return createBotDriver(root, { held: ['investigation'], ...options });
};

it('retains a conversation independently of stage sessions and reads older usage as zero', () => {
  const original = createBotItem({ botId: 'bot', source: { kind: 'manual', id: 'source' }, title: 'Defect' });
  const { conversation: _usage, ...legacyTokens } = original.tokens;
  const conversation = { sessionId: 'ses_conversation', directory: '/project', createdAt: 100 };
  const parsed = botItemSchema.parse({ ...original, tokens: legacyTokens, conversation });
  expect(parsed.conversation).toEqual(conversation);
  expect(parsed.sessions).toEqual({});
  expect(parsed.tokens.conversation).toBe(0);
});

it('refuses replacing a persisted conversation and preserves its original address', async () => {
  const f = await fixture();
  const item = await f.admit();
  await expect(f.store.update('project', (snapshot) => ({ snapshot: { ...snapshot,
    items: snapshot.items.map((entry) => ({ ...entry, conversation: { ...entry.conversation, sessionId: 'ses_replacement' } })),
  } }))).rejects.toThrow('Bot conversation is immutable');
  expect((await f.store.read('project')).items[0].conversation).toEqual(item.conversation);
});

it('keeps one root lead through concurrent opens, coordinator restart, Stop and archive after definition removal', async () => {
  const f = await fixture();
  const admitted = await f.admit();
  const conversation = admitted.conversation;
  const opened = await Promise.all(Array.from({ length: 4 }, () => f.runtime.ensureConversation('project', admitted.id)));
  expect(opened.map((entry) => entry.conversation)).toEqual(Array(4).fill(conversation));
  const info = f.sessions.get(conversation.sessionId);
  expect(info.parentID).toBeUndefined();
  expect(info.location.directory).toBe(f.project.path);
  expect(info.metadata.openchamber).toMatchObject({ lead: { at: conversation.createdAt },
    automation: { source: 'bot', projectId: 'project', botId: 'bugs', itemId: admitted.id, role: 'conversation' } });
  await f.runtime.pump('project');
  const before = (await f.runtime.detail('project', admitted.id)).item;
  expect(Object.values(before.sessions)).not.toContain(conversation.sessionId);
  expect(before.worktree).not.toBe(conversation.directory);
  const restarted = f.restart();
  await restarted.start();
  expect((await restarted.ensureConversation('project', admitted.id)).conversation).toEqual(conversation);
  await restarted.stopItem('project', admitted.id);
  expect(new Set(f.calls.interrupts)).toEqual(new Set([conversation.sessionId, ...Object.values(before.sessions)]));
  await f.store.archive('project', { before: Number.MAX_SAFE_INTEGER });
  await f.config.update('project', { definitions: [] });
  expect((await restarted.ensureConversation('project', admitted.id)).conversation).toEqual(conversation);
  expect(f.calls.sessions.filter((session) => session.metadata.openchamber.automation.role === 'conversation')).toHaveLength(1);
  await restarted.stop();
});

it('reconciles an uncertain creation from its recorded session without creating a second lead', async () => {
  const f = await fixture();
  const admitted = await f.admit();
  const journal = createBotExecutionStore({ store: f.store });
  const saved = await journal.read('project', admitted.id);
  const capture = conversationCaptureSchema.parse(saved.data.conversationCapture);
  const original = f.client.session.create;
  f.client.session.create = async (input) => { await original(input); throw new Error('Lost response'); };
  const target = { ...capture, itemId: 'second', conversation: { ...capture.conversation, sessionId: 'ses_uncertain' } };
  const execution = createBotConversationSessions({ dataDir: path.join(f.project.path, 'other-owner'), clientFor: () => f.client,
    readTokens: async () => 0, knowledge: { sync: async () => true },
    activity: { fetchActiveSessionStatuses: async () => ({}), hasWorkingDescendants: async () => false } });
  await expect(execution.ensure(target)).rejects.toThrow('Lost response');
  f.client.session.create = original;
  expect(await execution.ensure(target)).toEqual(target.conversation);
  expect(f.calls.sessions.filter((session) => session.id === 'ses_uncertain')).toHaveLength(1);
  f.sessions.get('ses_uncertain').metadata.openchamber.automation.itemId = 'other';
  await expect(execution.read(target)).rejects.toMatchObject({ code: 'BOT_CONVERSATION_SESSION_MISMATCH' });
});

it('charges lead usage separately once and refuses normal chat after the shared daily budget is exhausted', async () => {
  const f = await fixture({ bot: { limits: { dailyTokens: 20 } } });
  const item = await f.admit();
  f.controls.conversationTokens = 12;
  const input = { sessionId: item.conversation.sessionId, directory: f.project.path,
    operationId: 'native-message', text: 'Explain the evidence', payload: { text: 'Explain the evidence', files: [{ uri: 'file:///project/evidence.txt' }] } };
  await f.runtime.admitConversationMessage(input);
  await f.runtime.admitConversationMessage(input);
  let current = (await f.runtime.detail('project', item.id)).item;
  expect(current.tokens).toMatchObject({ total: 12, conversation: 12, byStage: { investigation: 0, fixing: 0, judge: 0 } });
  expect(Object.values(current.tokens.byDay)).toEqual([12]);
  f.controls.conversationTokens = 20;
  await expect(f.runtime.admitConversationMessage({ ...input, operationId: 'next' })).rejects.toMatchObject({ code: 'BOT_DAILY_TOKEN_BUDGET' });
  current = (await f.runtime.detail('project', item.id)).item;
  // A queued item keeps waiting for budget like the coordinator's own admission gate.
  expect(current.state).toBe('queued');
  expect(current.tokens.total).toBe(20);
  expect(f.calls.interrupts).toContain(item.conversation.sessionId);
});

it('leaves the coordinator question pending on ordinary chat and accepts only its exact explicit answer', async () => {
  const f = await fixture({ held: [], questions: ['Which behavior?'] });
  const item = await f.admit();
  await f.runtime.pump('project');
  const waiting = await f.runtime.detail('project', item.id);
  expect(waiting.item.state).toBe('waiting-answer');
  await f.runtime.admitConversationMessage({ sessionId: item.conversation.sessionId,
    operationId: 'chat', text: 'Explain the options', payload: { text: 'Explain the options' } });
  expect((await f.runtime.detail('project', item.id)).questionKey).toBe(waiting.questionKey);
  await expect(f.runtime.answer('project', item.id, { eventId: 'missing-key', text: 'Do it' }, { explicit: true }))
    .rejects.toMatchObject({ code: 'BOT_QUESTION_KEY_REQUIRED' });
  await f.runtime.answer('project', item.id, { eventId: 'wrong-answer', text: 'Do it' }, { explicit: true, questionKey: 'stale-key' });
  expect((await f.runtime.detail('project', item.id)).item.state).toBe('waiting-answer');
  await f.runtime.answer('project', item.id, { eventId: 'exact-answer', text: 'Do it' }, { explicit: true, questionKey: waiting.questionKey });
  expect((await f.runtime.detail('project', item.id)).questionKey).toBeUndefined();
});

it('keeps lead control read-only while permitting its brief and digest', async () => {
  const f = await fixture();
  const item = await f.admit();
  const metadata = f.sessions.get(item.conversation.sessionId).metadata;
  for (const action of ['session.create', 'session.send', 'workflow.run', 'git.push', 'lead.handover']) {
    expect(() => assertBotLeadControl(metadata, action)).toThrow();
  }
  for (const action of ['lead.brief', 'lead.digest', 'session.messages', 'session.list']) {
    expect(() => assertBotLeadControl(metadata, action)).not.toThrow();
  }
});

it('interrupts the worker with a budgeted lead and keeps Resume explicit after budget repair', async () => {
  const f = await fixture({ bot: { limits: { dailyTokens: 20 } } });
  const item = await f.admit();
  await f.runtime.pump('project');
  const worker = (await f.runtime.detail('project', item.id)).item.sessions.investigation;
  f.controls.conversationTokens = 20;
  await f.runtime.recordUsage({ sessionId: item.conversation.sessionId, total: 20 });
  expect(new Set(f.calls.interrupts)).toEqual(new Set([worker, item.conversation.sessionId]));
  await f.config.update('project', { definitions: [{ id: 'bugs', name: 'Bug bot', mission: 'Fix verified bugs', limits: { dailyTokens: 100 } }] });
  await f.runtime.admitConversationMessage({ sessionId: item.conversation.sessionId, operationId: 'explain-budget',
    text: 'Explain the pause', payload: { text: 'Explain the pause' } });
  expect((await f.runtime.detail('project', item.id)).item.state).toBe('needs-you');
  await f.runtime.resume('project', item.id);
  const resumed = (await f.runtime.detail('project', item.id)).item;
  expect(resumed.conversation).toEqual(item.conversation);
  expect(resumed.sessions.investigation).not.toBe(worker);
});

it('delivers complete authoritative proof in bounded non-resuming notices with stable identities', async () => {
  const f = await fixture();
  const item = await f.admit();
  const summary = '\u{1f642}'.repeat(45_000);
  // Each stored summary obeys the item boundary; two records exceed one service message.
  await f.store.update('project', (snapshot) => ({ snapshot: { ...snapshot,
    items: snapshot.items.map((entry) => ({ ...entry, evidence: [
      { source: 'test', summary }, { source: 'second', summary },
    ] })),
  } }));
  await f.runtime.syncConversationProgress('project', item.id);
  const first = f.calls.conversationNotices.slice();
  await f.runtime.syncConversationProgress('project', item.id);
  expect(f.calls.conversationNotices).toHaveLength(first.length);
  await f.restart().syncConversationProgress('project', item.id);
  const second = f.calls.conversationNotices.slice(first.length);
  expect(second.map((notice) => notice.id)).toEqual(first.map((notice) => notice.id));
  expect(first.every((notice) => notice.resume === false && notice.text.length < 200_000)).toBe(true);
  const decoded = JSON.parse(first.map((notice) => notice.text.slice(notice.text.indexOf('\n') + 1)).join(''));
  expect(decoded.evidence).toEqual([
    { source: 'test', summary }, { source: 'second', summary },
  ]);
  expect(decoded.item.id).toBe(item.id);
});
