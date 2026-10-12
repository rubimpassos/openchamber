import { describe, expect, test } from 'bun:test';

import { nextMachineStatsState, type ServerMachineStatsState } from './useServerMachineStats';
import { parseServerMachineSample, worstMachinePressure, type ServerMachineSample } from '@/lib/serverMachineStats';

const sample = (overrides: { cpu?: number | null; memory?: number; disk?: number | null } = {}): ServerMachineSample => {
  const parsed = parseServerMachineSample({
    collectedAt: '2026-10-12T00:00:00.000Z',
    hostname: 'srv-1',
    osName: 'Ubuntu 24.04',
    platform: 'linux',
    arch: 'x64',
    uptimeSec: 100,
    openchamberVersion: '1.24.7',
    openCodeRunning: true,
    cpu: { usagePercent: overrides.cpu === undefined ? 20 : overrides.cpu, cores: 4, model: null, loadAverage: [1, 1, 1] },
    memory: { totalBytes: 100, availableBytes: 50, usedPercent: overrides.memory ?? 50 },
    disk: overrides.disk === null ? null : { path: '/home/dev', totalBytes: 100, availableBytes: 40, usedPercent: overrides.disk ?? 60 },
    process: { rssBytes: 10, cpuPercent: 1, uptimeSec: 10 },
  });
  if (!parsed) throw new Error('fixture does not match the schema');
  return parsed;
};

const ready = (state: ServerMachineStatsState) => {
  if (state.kind !== 'ready') throw new Error(`expected ready, got ${state.kind}`);
  return state;
};

describe('nextMachineStatsState', () => {
  test('first sample hides latency because it includes the CPU baseline wait', () => {
    const first = ready(nextMachineStatsState({ kind: 'loading' }, { kind: 'sample', sample: sample(), latencyMs: 300 }, 1_000));
    expect(first.latencyMs).toBeNull();
    const second = ready(nextMachineStatsState(first, { kind: 'sample', sample: sample({ cpu: 30 }), latencyMs: 40 }, 6_000));
    expect(second.latencyMs).toBe(40);
    expect(second.cpuHistory).toEqual([20, 30]);
    expect(second.memoryHistory).toEqual([50, 50]);
  });

  test('a long gap hides latency again', () => {
    const first = ready(nextMachineStatsState({ kind: 'loading' }, { kind: 'sample', sample: sample(), latencyMs: 300 }, 1_000));
    const later = ready(nextMachineStatsState(first, { kind: 'sample', sample: sample(), latencyMs: 300 }, 70_000));
    expect(later.latencyMs).toBeNull();
  });

  test('keeps the last reading when a known server stops answering, and recovers', () => {
    const first = ready(nextMachineStatsState({ kind: 'loading' }, { kind: 'sample', sample: sample(), latencyMs: 0 }, 1_000));
    const failing = ready(nextMachineStatsState(first, { kind: 'failed' }, 6_000));
    expect(failing.failingSince).toBe(6_000);
    expect(failing.sample).toBe(first.sample);
    const stillFailing = ready(nextMachineStatsState(failing, { kind: 'unsupported' }, 11_000));
    expect(stillFailing.failingSince).toBe(6_000);
    expect(stillFailing.checkedAt).toBe(11_000);
    const recovered = ready(nextMachineStatsState(stillFailing, { kind: 'sample', sample: sample(), latencyMs: 0 }, 16_000));
    expect(recovered.failingSince).toBeNull();
  });

  test('distinguishes an old server from an unreachable one before any reading', () => {
    expect(nextMachineStatsState({ kind: 'loading' }, { kind: 'unsupported' }, 1).kind).toBe('unsupported');
    expect(nextMachineStatsState({ kind: 'loading' }, { kind: 'failed' }, 1)).toEqual({ kind: 'unavailable', checkedAt: 1 });
  });

  test('caps history at 60 samples', () => {
    let state: ServerMachineStatsState = { kind: 'loading' };
    for (let i = 0; i < 70; i += 1) {
      state = nextMachineStatsState(state, { kind: 'sample', sample: sample({ cpu: i }), latencyMs: 0 }, i * 5_000);
    }
    const final = ready(state);
    expect(final.cpuHistory).toHaveLength(60);
    expect(final.cpuHistory[0]).toBe(10);
    expect(final.cpuHistory[59]).toBe(69);
  });
});

describe('worstMachinePressure', () => {
  test('is null when everything is under the thresholds', () => {
    expect(worstMachinePressure(sample())).toBeNull();
  });

  test('prefers a critical resource over a warning one', () => {
    expect(worstMachinePressure(sample({ disk: 90, memory: 97 }))).toEqual({ resource: 'memory', level: 'critical', percent: 97 });
  });

  test('puts disk first among equal levels and skips unknown values', () => {
    expect(worstMachinePressure(sample({ disk: 88, memory: 90, cpu: null }))).toEqual({ resource: 'disk', level: 'warning', percent: 88 });
    expect(worstMachinePressure(sample({ disk: null, cpu: 85 }))).toEqual({ resource: 'cpu', level: 'warning', percent: 85 });
  });
});

describe('parseServerMachineSample', () => {
  test('rejects payloads that are not a stats sample', () => {
    expect(parseServerMachineSample(JSON.parse('{"data":[]}'))).toBeNull();
  });
});
