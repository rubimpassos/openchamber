import { describe, expect, it, vi } from 'vitest';
import { createSessionInterruptionRuntime } from './runtime.js';

const aborted = (reason) => ({
  type: 'session.idle',
  properties: { sessionID: 'ses_1', aborted: true, reason, error: { name: 'MessageAbortedError' } },
});

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('createSessionInterruptionRuntime', () => {
  it('records the reason and time of an interrupted turn on the session', async () => {
    const persistMetadata = vi.fn(async () => ({}));
    const createClient = () => ({ message: { list: async () => ({ data: [] }) } });
    const runtime = createSessionInterruptionRuntime({ persistMetadata, createClient, now: () => 1234 });

    runtime.processPayload(aborted('inactivity'), '/repo');
    await settle();

    expect(persistMetadata).toHaveBeenCalledWith(
      'ses_1',
      { openchamber: { interruption: { reason: 'inactivity', at: 1234, cause: null, tool: null, resume: null }, pendingQuestion: null } },
      { directory: '/repo' },
    );
  });

  it('records a user stop the same way so it replaces an older inactivity record', async () => {
    const persistMetadata = vi.fn(async () => ({}));
    const runtime = createSessionInterruptionRuntime({ persistMetadata, now: () => 5 });

    runtime.processPayload(aborted('user'));
    await settle();

    expect(persistMetadata).toHaveBeenCalledWith(
      'ses_1',
      { openchamber: { interruption: { reason: 'user', at: 5, cause: null, tool: null, resume: null }, pendingQuestion: null } },
      { directory: '' },
    );
  });

  describe('a question the inactivity eviction cut off', () => {
    const questionPage = [
      { id: 'msg_idle', type: 'idle', outcome: 'interrupted' },
      {
        id: 'msg_q', type: 'assistant', time: { created: 1, completed: 2 },
        content: [{ type: 'tool', id: 'call_q', name: 'question', state: { status: 'error', input: { questions: [{ question: 'Color?' }] }, error: { type: 'aborted', message: 'Tool execution interrupted' } } }],
      },
      { type: 'user' },
    ];

    it('records the question as waiting for the user and announces it', async () => {
      const persistMetadata = vi.fn(async () => ({}));
      const onPendingQuestion = vi.fn();
      const createClient = () => ({ message: { list: async () => ({ data: questionPage }) } });
      const runtime = createSessionInterruptionRuntime({ persistMetadata, createClient, onPendingQuestion, now: () => 70 });

      runtime.processPayload(aborted('inactivity'), '/repo');
      await settle();

      expect(persistMetadata).toHaveBeenCalledWith('ses_1', {
        openchamber: {
          interruption: { reason: 'inactivity', at: 70, cause: null, tool: null, resume: null },
          pendingQuestion: { messageID: 'msg_q', callID: 'call_q', title: 'Color?', cause: 'inactivity', at: 70 },
        },
      }, { directory: '/repo' });
      expect(onPendingQuestion).toHaveBeenCalledWith({ sessionId: 'ses_1', directory: '/repo', sessionTitle: null, title: 'Color?' });
    });

    it('reads no messages for a user stop, and records no question when they cannot be read', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const list = vi.fn(async () => { throw new Error('down'); });
      const persistMetadata = vi.fn(async () => ({}));
      const runtime = createSessionInterruptionRuntime({ persistMetadata, createClient: () => ({ message: { list } }), now: () => 70 });

      runtime.processPayload(aborted('user'));
      await settle();
      expect(list).not.toHaveBeenCalled();

      runtime.processPayload(aborted('inactivity'));
      await settle();
      expect(persistMetadata).toHaveBeenLastCalledWith('ses_1', expect.objectContaining({
        openchamber: expect.objectContaining({ pendingQuestion: null }),
      }), { directory: '' });
      warn.mockRestore();
    });

    it('clears the question once the session runs again, but not a record written after that', async () => {
      let clock = 70;
      const records = new Map([['ses_1', {}]]);
      const updateMetadata = vi.fn(async (sessionID, decide) => {
        const patch = decide(records.get(sessionID));
        return { changed: Boolean(patch), patch };
      });
      const persistMetadata = vi.fn(async (sessionID, patch) => { records.set(sessionID, patch); });
      const createClient = () => ({ message: { list: async () => ({ data: questionPage }) } });
      const runtime = createSessionInterruptionRuntime({ persistMetadata, updateMetadata, createClient, now: () => clock });
      const busy = { type: 'session.status', properties: { sessionID: 'ses_1', status: { type: 'busy' } } };

      runtime.processPayload(aborted('inactivity'));
      await settle();
      clock = 90;
      runtime.processPayload(busy);
      await settle();
      expect(updateMetadata.mock.results[0].value).resolves.toMatchObject({ patch: { openchamber: { pendingQuestion: null } } });

      // A busy status for a session this server gave no question reads nothing.
      runtime.processPayload({ ...busy, properties: { ...busy.properties, sessionID: 'ses_other' } });
      await settle();
      expect(updateMetadata).toHaveBeenCalledTimes(1);

      // A record newer than the turn start is not the one the turn answered.
      expect(updateMetadata.mock.calls[0][1]({ openchamber: { pendingQuestion: { at: 100 } } })).toBeNull();
    });
  });

  it('ignores turns that ended without an interruption, and events without a reason', async () => {
    const persistMetadata = vi.fn(async () => ({}));
    const runtime = createSessionInterruptionRuntime({ persistMetadata });

    runtime.processPayload({ type: 'session.idle', properties: { sessionID: 'ses_1' } });
    runtime.processPayload({ type: 'session.idle', properties: { sessionID: 'ses_1', aborted: true } });
    runtime.processPayload({ type: 'session.status', properties: { sessionID: 'ses_1', status: { type: 'idle' } } });
    await settle();

    expect(persistMetadata).not.toHaveBeenCalled();
  });

  it('keeps going when the write fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const runtime = createSessionInterruptionRuntime({
      persistMetadata: vi.fn(async () => {
        throw new Error('opencode down');
      }),
    });

    expect(() => runtime.processPayload(aborted('inactivity'))).not.toThrow();
    await settle();

    expect(warn).toHaveBeenCalledWith('[session-interruption] could not record the interruption reason:', 'opencode down');
    warn.mockRestore();
  });

  describe('recordRestartInterruptions', () => {
    const shellAborted = {
      type: 'assistant',
      content: [{ type: 'tool', name: 'shell', state: { status: 'error', input: { command: 'sleep 600' }, error: { type: 'aborted', message: 'Tool execution interrupted: shell' } } }],
    };

    const fakeClient = ({ sessions = {}, messages = {} }) => ({
      session: {
        get: vi.fn(async ({ sessionID }) => {
          const session = sessions[sessionID];
          if (session instanceof Error) throw session;
          return session;
        }),
      },
      message: {
        list: vi.fn(async ({ sessionID }) => {
          const page = messages[sessionID];
          if (page instanceof Error) throw page;
          return { data: page ?? [] };
        }),
      },
    });

    it('records when, why and what was running on each interrupted session', async () => {
      const updateMetadata = vi.fn(async () => ({ metadata: { openchamber: { priority: { at: 1 } } }, changed: true }));
      const client = fakeClient({
        sessions: { ses_1: { id: 'ses_1', title: 'Migration', location: { directory: '/repo' } } },
        messages: { ses_1: [shellAborted, { type: 'user' }] },
      });
      const runtime = createSessionInterruptionRuntime({ persistMetadata: vi.fn(), updateMetadata, createClient: () => client, now: () => 99 });

      const sessions = await runtime.recordRestartInterruptions({ sessionIds: ['ses_1'], cause: 'memory-pressure' });

      expect(sessions).toEqual([{
        sessionId: 'ses_1', directory: '/repo', title: 'Migration', recorded: true, priority: true,
        at: 99, cause: 'memory-pressure', tool: { name: 'shell', input: 'sleep 600' },
      }]);
      expect(updateMetadata).toHaveBeenCalledWith('ses_1', expect.any(Function), { directory: '/repo' });
      const decide = updateMetadata.mock.calls[0][1];
      expect(decide({ openchamber: { work: { state: 'open' } } })).toEqual({
        openchamber: {
          interruption: { reason: 'opencode-restart', at: 99, cause: 'memory-pressure', tool: { name: 'shell', input: 'sleep 600', callID: null }, resume: null },
          restartCutTurn: null,
          pendingQuestion: null,
        },
      });
    });

    it('marks the open turn, and leaves a cut-off question to the user instead of resuming it', async () => {
      const updateMetadata = vi.fn(async () => ({ metadata: { openchamber: { priority: { at: 1 } } }, changed: true }));
      const question = {
        id: 'msg_q',
        type: 'assistant',
        time: { created: 1 },
        content: [{ type: 'tool', id: 'call_q', name: 'question', state: { status: 'running', input: { questions: [{ question: 'Color?' }] }, metadata: {} } }],
      };
      const client = fakeClient({
        sessions: { ses_q: { id: 'ses_q', title: 'Q', location: { directory: '/repo' } } },
        messages: { ses_q: [question, { type: 'user' }] },
      });
      const onPendingQuestion = vi.fn();
      const runtime = createSessionInterruptionRuntime({ persistMetadata: vi.fn(), updateMetadata, createClient: () => client, onPendingQuestion, now: () => 42 });

      await runtime.recordRestartInterruptions({ sessionIds: ['ses_q'], cause: 'process-exited' });

      expect(onPendingQuestion).toHaveBeenCalledWith({ sessionId: 'ses_q', directory: '/repo', sessionTitle: 'Q', title: 'Color?' });
      expect(updateMetadata.mock.calls[0][1]({})).toEqual({
        openchamber: {
          interruption: {
            reason: 'opencode-restart', at: 42, cause: 'process-exited',
            tool: { name: 'question', input: null, callID: 'call_q' },
            resume: { state: 'manual', at: 42, reason: 'question-pending' },
          },
          restartCutTurn: { messageID: 'msg_q', at: 42, callID: 'call_q', toolName: 'question' },
          pendingQuestion: { messageID: 'msg_q', callID: 'call_q', title: 'Color?', cause: 'opencode-restart', at: 42 },
        },
      });
    });

    it('records without a tool when the messages cannot be read, and keeps the other sessions going', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const written = new Map();
      const updateMetadata = vi.fn(async (sessionID, decide) => {
        if (sessionID === 'ses_bad_write') throw new Error('PATCH failed');
        written.set(sessionID, decide({}).openchamber.interruption);
        return { metadata: {}, changed: true };
      });
      const client = fakeClient({
        sessions: {
          ses_unreadable: new Error('session read failed'),
          ses_ok: { id: 'ses_ok', title: 'Fine', directory: '/ok' },
          ses_bad_write: { id: 'ses_bad_write', title: 'W', directory: '/w' },
        },
        messages: { ses_unreadable: new Error('message read failed'), ses_ok: [shellAborted], ses_bad_write: [shellAborted] },
      });
      const runtime = createSessionInterruptionRuntime({ persistMetadata: vi.fn(), updateMetadata, createClient: () => client, now: () => 7 });

      const sessions = await runtime.recordRestartInterruptions({
        sessionIds: ['ses_unreadable', 'ses_bad_write', 'ses_ok'],
        cause: 'health-timeout',
      });

      expect(sessions.map(({ sessionId, directory, title, recorded, priority }) => ({ sessionId, directory, title, recorded, priority }))).toEqual([
        { sessionId: 'ses_unreadable', directory: null, title: null, recorded: true, priority: false },
        { sessionId: 'ses_bad_write', directory: '/w', title: 'W', recorded: false, priority: false },
        { sessionId: 'ses_ok', directory: '/ok', title: 'Fine', recorded: true, priority: false },
      ]);
      expect(written.get('ses_unreadable')).toEqual({ reason: 'opencode-restart', at: 7, cause: 'health-timeout', tool: null, resume: null });
      expect(written.get('ses_ok')).toEqual({ reason: 'opencode-restart', at: 7, cause: 'health-timeout', tool: { name: 'shell', input: 'sleep 600', callID: null }, resume: null });
      expect(warn).toHaveBeenCalledWith('[session-interruption] could not record the restart on ses_bad_write:', 'PATCH failed');
      warn.mockRestore();
    });

    it('does nothing without interrupted sessions', async () => {
      const createClient = vi.fn();
      const runtime = createSessionInterruptionRuntime({ persistMetadata: vi.fn(), updateMetadata: vi.fn(), createClient });

      expect(await runtime.recordRestartInterruptions({ sessionIds: [], cause: 'unknown' })).toEqual([]);
      expect(createClient).not.toHaveBeenCalled();
    });
  });
});
