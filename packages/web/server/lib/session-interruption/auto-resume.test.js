import { describe, expect, it, vi } from 'vitest';

import {
  buildResumeMessage,
  createAutoResumeRuntime,
  RESUME_MEMORY_DEADLINE_MS,
  RESUME_MEMORY_POLL_MS,
} from './auto-resume.js';

const AT = 1_000;

const isPlainObject = (value) => Object.prototype.toString.call(value) === '[object Object]';

/** An in-memory metadata store that applies merge patches like the real one. */
const createStore = (initial) => {
  const records = new Map(Object.entries(initial));
  const merge = (target, patch) => {
    const result = { ...target };
    for (const [key, value] of Object.entries(patch)) {
      if (value === null) delete result[key];
      else if (isPlainObject(value)) result[key] = merge(result[key] ?? {}, value);
      else result[key] = value;
    }
    return result;
  };
  const updateMetadata = vi.fn(async (sessionId, decide) => {
    const current = records.get(sessionId) ?? {};
    const patch = decide(current);
    if (!patch) return { metadata: current, changed: false };
    const next = merge(current, patch);
    records.set(sessionId, next);
    return { metadata: next, changed: true };
  });
  return { records, updateMetadata, resumeOf: (id) => records.get(id)?.openchamber?.interruption?.resume };
};

const restartRecord = (extra = {}) => ({
  openchamber: {
    priority: { at: 1 },
    interruption: { reason: 'opencode-restart', at: AT, cause: 'health-timeout', tool: { name: 'shell', input: 'bun run build' }, resume: null, ...extra },
  },
});

const session = (sessionId, extra = {}) => ({
  sessionId, directory: '/repo', title: null, recorded: true, priority: true, at: AT, cause: 'health-timeout',
  tool: { name: 'shell', input: 'bun run build' }, ...extra,
});

const memory = (fullAvg60, high = 10) => ({ events: { high, max: 0, oomKill: 0 }, pressure: { fullAvg60 } });

/** A clock that jumps forward on every sleep, so waits take no real time. */
const fakeClock = () => {
  let time = 50_000;
  return { now: () => time, sleep: vi.fn(async (ms) => { time += ms; }) };
};

describe('createAutoResumeRuntime', () => {
  it('sends one message to a priority session and marks the record sent first', async () => {
    const store = createStore({ ses_p: restartRecord() });
    const sent = [];
    const runtime = createAutoResumeRuntime({
      updateMetadata: store.updateMetadata,
      readMemory: () => null,
      sendPrompt: async (input) => {
        sent.push({ ...input, stateAtSend: store.resumeOf('ses_p')?.state });
      },
      ...fakeClock(),
    });

    expect(await runtime.resume([session('ses_p')])).toEqual({ ses_p: 'sent' });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ sessionId: 'ses_p', directory: '/repo', stateAtSend: 'sent' });
    expect(sent[0].text).toContain('`bun run build`');

    // The same restart again (a retry, a second announcement): nothing more goes out.
    expect(await runtime.resume([session('ses_p')])).toEqual({ ses_p: 'skipped' });
    expect(sent).toHaveLength(1);
  });

  it('leaves ordinary sessions, unrecorded ones and a switched-off priority alone', async () => {
    const store = createStore({
      ses_n: { openchamber: { interruption: restartRecord().openchamber.interruption } },
      ses_off: { openchamber: { interruption: restartRecord().openchamber.interruption } },
    });
    const sendPrompt = vi.fn();
    const runtime = createAutoResumeRuntime({ updateMetadata: store.updateMetadata, readMemory: () => null, sendPrompt, ...fakeClock() });

    const outcomes = await runtime.resume([
      session('ses_n', { priority: false }),
      session('ses_x', { recorded: false }),
      // Marked priority when the record was written, switched off since.
      session('ses_off'),
    ]);

    expect(outcomes).toEqual({ ses_off: 'skipped' });
    expect(sendPrompt).not.toHaveBeenCalled();
  });

  it('after a memory-pressure restart waits until the cgroup is calm, once for all sessions', async () => {
    const store = createStore({
      ses_a: restartRecord({ cause: 'memory-pressure' }),
      ses_b: restartRecord({ cause: 'memory-pressure' }),
    });
    const readings = [memory(40, 10), memory(30, 12), memory(1, 12)];
    const readMemory = vi.fn(() => readings.shift());
    const clock = fakeClock();
    const sendPrompt = vi.fn(async () => {});
    const runtime = createAutoResumeRuntime({ updateMetadata: store.updateMetadata, readMemory, sendPrompt, ...clock });

    const outcomes = await runtime.resume([
      session('ses_a', { cause: 'memory-pressure' }),
      session('ses_b', { cause: 'memory-pressure' }),
    ]);

    expect(outcomes).toEqual({ ses_a: 'sent', ses_b: 'sent' });
    expect(readMemory).toHaveBeenCalledTimes(3);
    expect(clock.sleep).toHaveBeenCalledTimes(2);
    expect(clock.sleep).toHaveBeenCalledWith(RESUME_MEMORY_POLL_MS, expect.anything());
    expect(sendPrompt.mock.calls[0][0].text).toContain('the server ran out of memory');
  });

  it('does not count a quiet pressure average while the high counter still climbs', async () => {
    const store = createStore({ ses_a: restartRecord({ cause: 'memory-pressure' }) });
    const readings = [memory(1, 10), memory(1, 20), memory(1, 20)];
    const runtime = createAutoResumeRuntime({
      updateMetadata: store.updateMetadata, readMemory: () => readings.shift(), sendPrompt: vi.fn(async () => {}), ...fakeClock(),
    });

    expect(await runtime.resume([session('ses_a', { cause: 'memory-pressure' })])).toEqual({ ses_a: 'sent' });
    expect(readings).toHaveLength(0);
  });

  it('hands the resume to the user when memory stays high past the deadline', async () => {
    const store = createStore({ ses_a: restartRecord({ cause: 'memory-pressure' }) });
    const clock = fakeClock();
    const sendPrompt = vi.fn();
    const runtime = createAutoResumeRuntime({ updateMetadata: store.updateMetadata, readMemory: () => memory(50), sendPrompt, ...clock });

    expect(await runtime.resume([session('ses_a', { cause: 'memory-pressure' })])).toEqual({ ses_a: 'manual' });
    expect(sendPrompt).not.toHaveBeenCalled();
    expect(store.resumeOf('ses_a')).toMatchObject({ state: 'manual', reason: 'memory-timeout' });
    expect(clock.sleep.mock.calls.length).toBe(RESUME_MEMORY_DEADLINE_MS / RESUME_MEMORY_POLL_MS);
  });

  it('hands the resume to the user when memory cannot be read', async () => {
    const store = createStore({ ses_a: restartRecord({ cause: 'memory-pressure' }) });
    const runtime = createAutoResumeRuntime({ updateMetadata: store.updateMetadata, readMemory: () => null, sendPrompt: vi.fn(), ...fakeClock() });

    expect(await runtime.resume([session('ses_a', { cause: 'memory-pressure' })])).toEqual({ ses_a: 'manual' });
    expect(store.resumeOf('ses_a')).toMatchObject({ state: 'manual', reason: 'memory-unreadable' });
  });

  it('sends nothing when the user answered while it waited', async () => {
    const store = createStore({ ses_a: restartRecord({ cause: 'memory-pressure' }) });
    const readings = [memory(40), memory(1)];
    const sendPrompt = vi.fn();
    const runtime = createAutoResumeRuntime({
      updateMetadata: store.updateMetadata,
      readMemory: () => {
        // The user sent a message during the wait: the UI deletes the record.
        if (readings.length === 1) store.records.set('ses_a', { openchamber: { priority: { at: 1 } } });
        return readings.shift();
      },
      sendPrompt,
      ...fakeClock(),
    });

    expect(await runtime.resume([session('ses_a', { cause: 'memory-pressure' })])).toEqual({ ses_a: 'skipped' });
    expect(sendPrompt).not.toHaveBeenCalled();
  });

  it('marks a failed send for the user without retrying, and keeps the other sessions going', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const store = createStore({ ses_bad: restartRecord(), ses_ok: restartRecord() });
    const sendPrompt = vi.fn(async ({ sessionId }) => {
      if (sessionId === 'ses_bad') throw new Error('OpenCode busy');
    });
    const runtime = createAutoResumeRuntime({ updateMetadata: store.updateMetadata, readMemory: () => null, sendPrompt, ...fakeClock() });

    expect(await runtime.resume([session('ses_bad'), session('ses_ok')])).toEqual({ ses_bad: 'manual', ses_ok: 'sent' });
    expect(store.resumeOf('ses_bad')).toMatchObject({ state: 'manual', reason: 'send-failed' });
    expect(sendPrompt).toHaveBeenCalledTimes(2);
    warn.mockRestore();
  });
});

describe('buildResumeMessage', () => {
  it('says what was cut off, why and when', () => {
    const text = buildResumeMessage({ at: Date.UTC(2026, 9, 16, 21, 17, 41), cause: 'health-timeout', tool: { name: 'shell', input: 'sleep 600' } });

    expect(text).toContain('2026-10-16T21:17:41.000Z because OpenCode stopped responding');
    expect(text).toContain('while `sleep 600` was running');
    expect(text).toContain('Before repeating that or any other command');
  });

  it('names no cause or command it does not know', () => {
    const text = buildResumeMessage({ at: 0, cause: 'unknown', tool: null });

    expect(text).toContain('OpenCode restarted at 1970-01-01T00:00:00.000Z and cut off your last turn.');
  });
});
