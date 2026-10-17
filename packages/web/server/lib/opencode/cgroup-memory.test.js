import { describe, expect, it } from 'vitest';

import { classifyRestartCause, MEMORY_PRESSURE_FULL_AVG60_THRESHOLD, readCgroupMemory } from './cgroup-memory.js';

const EVENTS = 'low 0\nhigh 78404552\nmax 3\noom 0\noom_kill 1\noom_group_kill 0\nsock_throttled 97066\n';
const PRESSURE = 'some avg10=4.10 avg60=22.50 avg300=9.00 total=9800930720\nfull avg10=3.00 avg60=17.25 avg300=8.00 total=8785281761\n';

const files = (entries) => (file) => {
  if (!(file in entries)) throw Object.assign(new Error(`ENOENT: ${file}`), { code: 'ENOENT' });
  return entries[file];
};

describe('readCgroupMemory', () => {
  it('reads the counters and pressure of the server\'s own cgroup', () => {
    const readFile = files({
      '/proc/self/cgroup': '0::/system.slice/openchamber.service\n',
      '/sys/fs/cgroup/system.slice/openchamber.service/memory.events': EVENTS,
      '/sys/fs/cgroup/system.slice/openchamber.service/memory.pressure': PRESSURE,
    });

    expect(readCgroupMemory({ platform: 'linux', readFile })).toEqual({
      events: { high: 78404552, max: 3, oomKill: 1 },
      pressure: { fullAvg60: 17.25 },
    });
  });

  it('keeps what it could read when one file is missing', () => {
    const readFile = files({
      '/proc/self/cgroup': '0::/user.slice\n',
      '/sys/fs/cgroup/user.slice/memory.events': EVENTS,
    });

    expect(readCgroupMemory({ platform: 'linux', readFile })).toEqual({
      events: { high: 78404552, max: 3, oomKill: 1 },
      pressure: null,
    });
  });

  it('answers null when nothing is readable, outside cgroup v2, or off Linux', () => {
    expect(readCgroupMemory({ platform: 'linux', readFile: files({}) })).toBeNull();
    expect(readCgroupMemory({ platform: 'linux', readFile: files({ '/proc/self/cgroup': '12:memory:/legacy\n' }) })).toBeNull();
    expect(readCgroupMemory({
      platform: 'linux',
      readFile: files({ '/proc/self/cgroup': '0::/a\n', '/sys/fs/cgroup/a/memory.events': 'garbage', '/sys/fs/cgroup/a/memory.pressure': 'nothing' }),
    })).toBeNull();
    expect(readCgroupMemory({ platform: 'darwin', readFile: () => { throw new Error('must not read'); } })).toBeNull();
    expect(readCgroupMemory({ platform: 'win32', readFile: () => { throw new Error('must not read'); } })).toBeNull();
  });
});

describe('classifyRestartCause', () => {
  const at = (high, max = 0, fullAvg60 = 0) => ({ events: { high, max, oomKill: 0 }, pressure: { fullAvg60 } });

  it('blames memory when the high or max counter rose during the failures', () => {
    expect(classifyRestartCause({ trigger: 'health-failure', healthFailureClass: 'timeout', baseline: at(10), current: at(11) }))
      .toBe('memory-pressure');
    expect(classifyRestartCause({ trigger: 'health-failure', healthFailureClass: 'timeout', baseline: at(10, 0), current: at(10, 1) }))
      .toBe('memory-pressure');
  });

  it('blames memory when tasks stalled on memory for most of the last minute', () => {
    expect(classifyRestartCause({ trigger: 'process-exited', current: at(0, 0, MEMORY_PRESSURE_FULL_AVG60_THRESHOLD) }))
      .toBe('memory-pressure');
  });

  it('falls back to what the lifecycle knows when memory was calm or unreadable', () => {
    expect(classifyRestartCause({ trigger: 'health-failure', healthFailureClass: 'timeout', baseline: at(10), current: at(10, 0, 1) }))
      .toBe('health-timeout');
    expect(classifyRestartCause({ trigger: 'health-failure', healthFailureClass: 'timeout' })).toBe('health-timeout');
    expect(classifyRestartCause({ trigger: 'health-failure', healthFailureClass: 'connection_refused' })).toBe('unknown');
    expect(classifyRestartCause({ trigger: 'process-exited', baseline: null, current: null })).toBe('process-exited');
  });

  it('never blames memory for a restart someone asked for', () => {
    expect(classifyRestartCause({ trigger: null, baseline: at(1), current: at(99, 9, 90) })).toBe('unknown');
  });
});
