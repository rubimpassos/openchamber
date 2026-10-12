import { describe, expect, it } from 'vitest';
import express from 'express';

import { createSystemStatsCollector } from './collect.js';
import { registerSystemStatsRoutes } from './routes.js';

const GB = 1024 ** 3;

const cpuTimes = (busy, idle) => ({ model: ' Test CPU ', times: { user: busy, nice: 0, sys: 0, idle, irq: 0 } });

const createFakes = ({ platform = 'linux', meminfo, osRelease, statfs } = {}) => {
  const clock = { ms: 1_000_000 };
  const cpuQueue = [];
  const fakeOs = {
    platform: () => platform,
    homedir: () => '/home/dev',
    cpus: () => cpuQueue[0] ?? [cpuTimes(0, 0), cpuTimes(0, 0)],
    totalmem: () => 16 * GB,
    freemem: () => 1 * GB,
    loadavg: () => [1.5, 1, 0.5],
    hostname: () => 'srv-1',
    type: () => 'Darwin',
    release: () => '24.0.0',
    arch: () => 'x64',
    uptime: () => 3600.4,
  };
  const files = {
    '/proc/meminfo': meminfo ?? 'MemTotal:       16777216 kB\nMemAvailable:    8388608 kB\n',
    '/etc/os-release': osRelease ?? 'NAME="Ubuntu"\nPRETTY_NAME="Ubuntu 24.04.1 LTS"\n',
  };
  const fakeFs = {
    readFile: async (path) => {
      if (!(path in files)) throw new Error('ENOENT');
      return files[path];
    },
    statfs: statfs ?? (async () => ({ bsize: 4096, blocks: 1000, bfree: 300, bavail: 200 })),
  };
  let cpuMicros = 0;
  const fakeProcess = {
    cpuUsage: () => ({ user: cpuMicros, system: 0 }),
    memoryUsage: () => ({ rss: 512 * 1024 * 1024 }),
    uptime: () => 60,
  };
  const sleeps = [];
  const collector = createSystemStatsCollector({
    os: fakeOs,
    fsPromises: fakeFs,
    process: fakeProcess,
    now: () => clock.ms,
    sleep: async (ms) => {
      sleeps.push(ms);
      clock.ms += ms;
      cpuQueue.shift();
    },
  });
  return {
    collector,
    sleeps,
    advance: (ms, { cpus, processMicros } = {}) => {
      clock.ms += ms;
      if (cpus) cpuQueue.unshift(cpus);
      if (processMicros !== undefined) cpuMicros = processMicros;
    },
    queueCpus: (...samples) => cpuQueue.push(...samples),
  };
};

describe('createSystemStatsCollector', () => {
  it('waits for a CPU baseline on the first poll, then reuses the previous reading', async () => {
    const fakes = createFakes();
    // baseline, then the reading after the wait: 3 of 4 elapsed ticks busy.
    fakes.queueCpus([cpuTimes(0, 0), cpuTimes(0, 0)], [cpuTimes(3, 1), cpuTimes(3, 1)]);
    const first = await fakes.collector.collect();
    expect(fakes.sleeps).toEqual([250]);
    expect(first.cpu.usagePercent).toBe(75);

    fakes.advance(5000, { cpus: [cpuTimes(4, 4), cpuTimes(4, 4)] });
    const second = await fakes.collector.collect();
    expect(fakes.sleeps).toEqual([250]);
    expect(second.cpu.usagePercent).toBe(25);
  });

  it('takes a fresh baseline when the previous reading is stale', async () => {
    const fakes = createFakes();
    await fakes.collector.collect();
    fakes.advance(61_000);
    await fakes.collector.collect();
    expect(fakes.sleeps).toEqual([250, 250]);
  });

  it('reports MemAvailable on Linux instead of free memory', async () => {
    const { collector } = createFakes();
    const stats = await collector.collect();
    expect(stats.memory).toEqual({ totalBytes: 16 * GB, availableBytes: 8 * GB, usedPercent: 50, source: 'available' });
  });

  it('falls back to free memory and uname naming off Linux, and hides Windows load average', async () => {
    const mac = await createFakes({ platform: 'darwin' }).collector.collect();
    expect(mac.memory.source).toBe('free');
    expect(mac.memory.availableBytes).toBe(1 * GB);
    expect(mac.osName).toBe('Darwin 24.0.0');
    expect(mac.cpu.loadAverage).toEqual([1.5, 1, 0.5]);

    const win = await createFakes({ platform: 'win32' }).collector.collect();
    expect(win.cpu.loadAverage).toBeNull();
  });

  it('computes disk usage the way df does', async () => {
    const stats = await createFakes().collector.collect();
    // used = 700 blocks, available = 200 blocks -> 700 / 900
    expect(stats.disk).toEqual({ path: '/home/dev', totalBytes: 4096 * 1000, availableBytes: 4096 * 200, usedPercent: (700 / 900) * 100 });
  });

  it('reports disk as unknown instead of failing the whole sample', async () => {
    const stats = await createFakes({ statfs: async () => { throw new Error('EACCES'); } }).collector.collect();
    expect(stats.disk).toBeNull();
    expect(stats.memory.totalBytes).toBe(16 * GB);
  });

  it('reads the OS pretty name and machine facts', async () => {
    const stats = await createFakes().collector.collect();
    expect(stats).toMatchObject({
      hostname: 'srv-1',
      osName: 'Ubuntu 24.04.1 LTS',
      platform: 'linux',
      arch: 'x64',
      uptimeSec: 3600,
      cpu: { cores: 2, model: 'Test CPU' },
      process: { rssBytes: 512 * 1024 * 1024, cpuPercent: null, uptimeSec: 60 },
    });
  });

  it('reports process CPU as a share of the whole machine', async () => {
    const fakes = createFakes();
    await fakes.collector.collect();
    // 1s of CPU time over 1s wall clock on a 2-core machine = 50%.
    fakes.advance(1000, { processMicros: 1_000_000 });
    const stats = await fakes.collector.collect();
    expect(stats.process.cpuPercent).toBe(50);
  });
});

describe('GET /api/system/stats', () => {
  const listen = async (collector) => {
    const app = express();
    registerSystemStatsRoutes(app, { collector, openchamberVersion: '9.9.9', isOpenCodeRunning: () => true });
    const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
    return { server, url: `http://127.0.0.1:${server.address().port}/api/system/stats` };
  };

  it('returns the sample with server facts and no caching', async () => {
    const { server, url } = await listen({ collect: async () => ({ hostname: 'srv-1' }) });
    try {
      const response = await fetch(url);
      expect(response.status).toBe(200);
      expect(response.headers.get('cache-control')).toBe('no-store');
      expect(await response.json()).toEqual({ hostname: 'srv-1', openchamberVersion: '9.9.9', openCodeRunning: true });
    } finally {
      server.close();
    }
  });

  it('answers 500 when collection fails', async () => {
    const { server, url } = await listen({ collect: async () => { throw new Error('boom'); } });
    try {
      const response = await fetch(url);
      expect(response.status).toBe(500);
    } finally {
      server.close();
    }
  });
});
