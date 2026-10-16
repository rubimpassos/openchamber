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
      { openchamber: { interruption: { reason: 'inactivity', at: 1234 } } },
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
      { openchamber: { interruption: { reason: 'user', at: 5 } } },
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
});
