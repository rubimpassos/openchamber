import { describe, expect, test } from 'bun:test';

import type { Metadata, Session } from '@/lib/opencode/model';
import { getRestartInterruption, withoutRestartInterruption } from './sessionRestartInterruption';

const session = (metadata: Metadata): Session => ({
  id: 'ses_1', projectID: 'project', directory: '/repo', title: 'A', cost: 0,
  time: { created: 1, updated: 1 },
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  metadata,
});

const restartRecord = {
  reason: 'opencode-restart', at: 1_700_000_000_000, cause: 'memory-pressure', tool: { name: 'shell', input: 'sleep 600' },
};

describe('getRestartInterruption', () => {
  test('reads the record a restart left', () => {
    expect(getRestartInterruption(session({ openchamber: { interruption: restartRecord } }))).toEqual({
      at: 1_700_000_000_000, cause: 'memory-pressure', tool: { name: 'shell', input: 'sleep 600' }, resume: null,
    });
  });

  test('reads a record without a tool and an unknown cause as unknown', () => {
    expect(getRestartInterruption(session({
      openchamber: { interruption: { reason: 'opencode-restart', at: 5, cause: 'disk-full', tool: null } },
    }))).toEqual({ at: 5, cause: 'unknown', tool: null, resume: null });
  });

  test('reads how the automatic resume went', () => {
    const sent = { openchamber: { interruption: { ...restartRecord, resume: { state: 'sent', at: 9 } } } };

    expect(getRestartInterruption(session(sent), 10)?.resume).toEqual({ state: 'sent', at: 9 });
  });

  test('reads a wait the server abandoned as manual', () => {
    const waiting = { openchamber: { interruption: { ...restartRecord, resume: { state: 'waiting', at: 0 } } } };

    expect(getRestartInterruption(session(waiting), 14 * 60_000)?.resume?.state).toBe('waiting');
    expect(getRestartInterruption(session(waiting), 16 * 60_000)?.resume?.state).toBe('manual');
  });

  test('ignores the inactivity and stop records that share the key', () => {
    expect(getRestartInterruption(session({ openchamber: { interruption: { reason: 'inactivity', at: 5, cause: null, tool: null } } }))).toBeNull();
    expect(getRestartInterruption(session({}))).toBeNull();
    expect(getRestartInterruption(null)).toBeNull();
  });
});

describe('withoutRestartInterruption', () => {
  test('drops only the restart record', () => {
    const metadata = { other: 1, openchamber: { work: { state: 'open' }, interruption: restartRecord } };

    expect(withoutRestartInterruption(metadata)).toEqual({ other: 1, openchamber: { work: { state: 'open' } } });
  });

  test('leaves any other interruption record alone', () => {
    const metadata = { openchamber: { interruption: { reason: 'inactivity', at: 5 } } };

    expect(withoutRestartInterruption(metadata)).toBe(metadata);
  });
});
