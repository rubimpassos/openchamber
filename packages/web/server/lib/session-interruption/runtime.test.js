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
    const runtime = createSessionInterruptionRuntime({ persistMetadata, now: () => 1234 });

    runtime.processPayload(aborted('inactivity'), '/repo');
    await settle();

    expect(persistMetadata).toHaveBeenCalledWith(
      'ses_1',
      { openchamber: { interruption: { reason: 'inactivity', at: 1234, cause: null, tool: null, resume: null } } },
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
      { openchamber: { interruption: { reason: 'user', at: 5, cause: null, tool: null, resume: null } } },
      { directory: '' },
    );
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
          interruption: { reason: 'opencode-restart', at: 99, cause: 'memory-pressure', tool: { name: 'shell', input: 'sleep 600' }, resume: null },
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
      expect(written.get('ses_ok')).toEqual({ reason: 'opencode-restart', at: 7, cause: 'health-timeout', tool: { name: 'shell', input: 'sleep 600' }, resume: null });
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
