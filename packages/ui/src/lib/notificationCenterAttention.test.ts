import { describe, expect, test } from 'bun:test';

import type { NotificationCenterEntry } from './notificationCenter';
import { needsAttention, type AttentionSources } from './notificationCenterAttention';

const entry = (overrides: Partial<NotificationCenterEntry> = {}): NotificationCenterEntry => ({
  id: 'n1',
  createdAt: 1,
  kind: 'question',
  priority: 'high',
  delivery: 'delivered',
  verdict: null,
  title: 'Input needed',
  body: '',
  sessionId: 'ses_1',
  directory: '/repo',
  sessionName: null,
  requestId: null,
  action: null,
  readAt: null,
  resolvedAt: null,
  ...overrides,
});

const READ = { readAt: 5 };

const sources = (overrides: Partial<AttentionSources> = {}): AttentionSources => ({
  blocking: { hostSeeded: true, bySession: new Map() },
  restartPendingSessionIds: new Set(),
  fixLoopsAwaitingApproval: new Set(),
  restack: { statusByRunId: new Map(), readDirectories: new Set() },
  availableUpdateVersion: '',
  ...overrides,
});

const pendingForm = (formId: string) => ({
  blocking: {
    hostSeeded: true,
    bySession: new Map([['ses_1', { directory: '/repo', permissions: [], forms: [{ id: formId, sessionID: 'ses_1', title: 'Pick' }], pages: [] }]]),
  },
});

describe('needsAttention', () => {
  test('a question stays while its form is pending, read or not, and leaves once answered', () => {
    const question = entry({ ...READ, requestId: 'frm_1' });
    expect(needsAttention(question, sources(pendingForm('frm_1')))).toBe(true);
    expect(needsAttention(question, sources(pendingForm('frm_2')))).toBe(false);
    expect(needsAttention(question, sources())).toBe(false);
  });

  test('an entry without a request id matches any pending request of its kind in the session', () => {
    expect(needsAttention(entry(READ), sources(pendingForm('frm_9')))).toBe(true);
    expect(needsAttention(entry({ ...READ, kind: 'permission' }), sources(pendingForm('frm_9')))).toBe(false);
  });

  test('a permission matches its request exactly', () => {
    const bySession = new Map([['ses_1', {
      directory: '/repo', forms: [], pages: [],
      permissions: [{ id: 'per_1', sessionID: 'ses_1', action: 'bash', resources: ['ls'], save: [] }],
    }]]);
    const blocking = { hostSeeded: true, bySession };
    expect(needsAttention(entry({ ...READ, kind: 'permission', requestId: 'per_1' }), sources({ blocking }))).toBe(true);
    expect(needsAttention(entry({ ...READ, kind: 'permission', requestId: 'per_2' }), sources({ blocking }))).toBe(false);
  });

  test('before the host list answered, a question counts while unread', () => {
    const blocking = { hostSeeded: false, bySession: new Map() };
    expect(needsAttention(entry(), sources({ blocking }))).toBe(true);
    expect(needsAttention(entry(READ), sources({ blocking }))).toBe(false);
  });

  test('errors, browser help, failed runs and the OpenCode update count while unread', () => {
    for (const kind of ['error', 'browser-help', 'scheduled-task', 'opencode-update'] as const) {
      expect(needsAttention(entry({ kind }), sources())).toBe(true);
      expect(needsAttention(entry({ kind, ...READ }), sources())).toBe(false);
    }
  });

  test('finished turns, goals and plugin notices never count', () => {
    for (const kind of ['ready', 'goal', 'plugin'] as const) expect(needsAttention(entry({ kind }), sources())).toBe(false);
  });

  test('a restart stays while any listed chat still has its record', () => {
    const restart = entry({
      ...READ,
      kind: 'restart',
      sessionId: null,
      action: { type: 'sessions', sessions: [{ sessionId: 'ses_a', directory: null, title: null }, { sessionId: 'ses_b', directory: null, title: null }] },
    });
    expect(needsAttention(restart, sources({ restartPendingSessionIds: new Set(['ses_b']) }))).toBe(true);
    expect(needsAttention(restart, sources({ restartPendingSessionIds: new Set() }))).toBe(false);
    expect(needsAttention(restart, sources({ restartPendingSessionIds: null }))).toBe(false);
    expect(needsAttention({ ...restart, readAt: null }, sources({ restartPendingSessionIds: null }))).toBe(true);
  });

  test('a fix loop waiting for approval stays until approved; a finished loop counts while unread', () => {
    const waiting = entry({ ...READ, kind: 'fix-loop', requestId: 'loop_1' });
    expect(needsAttention(waiting, sources({ fixLoopsAwaitingApproval: new Set(['loop_1']) }))).toBe(true);
    expect(needsAttention(waiting, sources())).toBe(false);
    expect(needsAttention(entry({ kind: 'fix-loop' }), sources())).toBe(true);
    expect(needsAttention(entry({ kind: 'fix-loop', ...READ }), sources())).toBe(false);
  });

  test('a restack stays while its run is paused, and a run missing from a read repository is finished', () => {
    const restack = entry({ ...READ, kind: 'restack', requestId: 'run_1' });
    expect(needsAttention(restack, sources({ restack: { statusByRunId: new Map([['run_1', 'paused']]), readDirectories: new Set() } }))).toBe(true);
    expect(needsAttention(restack, sources({ restack: { statusByRunId: new Map([['run_1', 'done']]), readDirectories: new Set() } }))).toBe(false);
    expect(needsAttention(restack, sources({ restack: { statusByRunId: new Map(), readDirectories: new Set(['/repo']) } }))).toBe(false);
    expect(needsAttention({ ...restack, readAt: null }, sources())).toBe(true);
  });

  test('an available update stays while the server still offers that version; "updated to" never counts', () => {
    const available = entry({ ...READ, kind: 'update', sessionId: null, requestId: '2.5.0' });
    expect(needsAttention(available, sources({ availableUpdateVersion: '2.5.0' }))).toBe(true);
    expect(needsAttention(available, sources({ availableUpdateVersion: '2.6.0' }))).toBe(false);
    expect(needsAttention(available, sources({ availableUpdateVersion: '' }))).toBe(false);
    expect(needsAttention({ ...available, readAt: null }, sources({ availableUpdateVersion: null }))).toBe(true);
    expect(needsAttention(entry({ kind: 'update', sessionId: null, priority: 'low' }), sources({ availableUpdateVersion: null }))).toBe(false);
  });
});
