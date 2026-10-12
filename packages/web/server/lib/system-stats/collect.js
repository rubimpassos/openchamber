// Reads machine resource usage for the server-status panel in the instance
// menu. Everything here is a point-in-time sample of the host this server runs
// on; the client keeps history.

const CPU_BASELINE_MAX_AGE_MS = 60_000;
const CPU_BASELINE_WAIT_MS = 250;

const sumCpuTimes = (cpus) => {
  let idle = 0;
  let total = 0;
  for (const cpu of cpus) {
    const { user, nice, sys, idle: cpuIdle, irq } = cpu.times;
    idle += cpuIdle;
    total += user + nice + sys + cpuIdle + irq;
  }
  return { idle, total };
};

const clampPercent = (value) => Math.min(100, Math.max(0, value));

// MemAvailable is what the kernel can hand out without swapping. `freemem`
// counts page cache as used, which makes a healthy Linux box look full.
const parseMemAvailableBytes = (meminfo) => {
  const match = /^MemAvailable:\s+(\d+)\s+kB$/m.exec(meminfo);
  return match ? Number(match[1]) * 1024 : null;
};

const parseOsPrettyName = (osRelease) => {
  const match = /^PRETTY_NAME=(?:"([^"]*)"|(.*))$/m.exec(osRelease);
  const name = (match?.[1] ?? match?.[2] ?? '').trim();
  return name || null;
};

export const createSystemStatsCollector = ({
  os,
  fsPromises,
  process,
  diskPath = os.homedir(),
  now = Date.now,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
}) => {
  let cpuBaseline = null;
  let processBaseline = null;
  let osNamePromise = null;

  const readCpuTimes = () => ({ at: now(), ...sumCpuTimes(os.cpus()) });

  // CPU usage only exists as a delta between two readings. Polls reuse the
  // previous reading; the first poll (or one after a long gap) waits briefly
  // for a fresh baseline instead of reporting a meaningless number.
  const readCpuUsagePercent = async () => {
    if (!cpuBaseline || now() - cpuBaseline.at > CPU_BASELINE_MAX_AGE_MS) {
      cpuBaseline = readCpuTimes();
      await sleep(CPU_BASELINE_WAIT_MS);
    }
    const current = readCpuTimes();
    const totalDelta = current.total - cpuBaseline.total;
    const idleDelta = current.idle - cpuBaseline.idle;
    cpuBaseline = current;
    if (totalDelta <= 0) return null;
    return clampPercent(((totalDelta - idleDelta) / totalDelta) * 100);
  };

  // Percent of the whole machine, so it reads on the same scale as host CPU.
  const readProcessCpuPercent = () => {
    const at = now();
    const usage = process.cpuUsage();
    const previous = processBaseline;
    processBaseline = { at, usage };
    if (!previous || at <= previous.at) return null;
    const usedMicros = (usage.user - previous.usage.user) + (usage.system - previous.usage.system);
    const elapsedMicros = (at - previous.at) * 1000;
    const cores = Math.max(1, os.cpus().length);
    return clampPercent((usedMicros / (elapsedMicros * cores)) * 100);
  };

  const readMemory = async () => {
    const totalBytes = os.totalmem();
    let availableBytes = null;
    if (os.platform() === 'linux') {
      availableBytes = parseMemAvailableBytes(await fsPromises.readFile('/proc/meminfo', 'utf8').catch(() => ''));
    }
    const source = availableBytes === null ? 'free' : 'available';
    const available = Math.min(totalBytes, availableBytes ?? os.freemem());
    return {
      totalBytes,
      availableBytes: available,
      usedPercent: totalBytes > 0 ? clampPercent(((totalBytes - available) / totalBytes) * 100) : 0,
      source,
    };
  };

  // Matches `df`: used / (used + available to unprivileged users).
  const readDisk = async () => {
    try {
      const stats = await fsPromises.statfs(diskPath);
      const totalBytes = stats.blocks * stats.bsize;
      const availableBytes = stats.bavail * stats.bsize;
      const usedBytes = (stats.blocks - stats.bfree) * stats.bsize;
      const usable = usedBytes + availableBytes;
      return {
        path: diskPath,
        totalBytes,
        availableBytes,
        usedPercent: usable > 0 ? clampPercent((usedBytes / usable) * 100) : 0,
      };
    } catch {
      return null;
    }
  };

  const readOsName = () => {
    if (!osNamePromise) {
      osNamePromise = (os.platform() === 'linux'
        ? fsPromises.readFile('/etc/os-release', 'utf8').then(parseOsPrettyName).catch(() => null)
        : Promise.resolve(null)
      ).then((name) => name || `${os.type()} ${os.release()}`);
    }
    return osNamePromise;
  };

  const collect = async () => {
    const [cpuUsagePercent, memory, disk, osName] = await Promise.all([
      readCpuUsagePercent(),
      readMemory(),
      readDisk(),
      readOsName(),
    ]);
    const cpus = os.cpus();
    return {
      collectedAt: new Date(now()).toISOString(),
      hostname: os.hostname(),
      osName,
      platform: os.platform(),
      arch: os.arch(),
      uptimeSec: Math.round(os.uptime()),
      cpu: {
        usagePercent: cpuUsagePercent,
        cores: cpus.length,
        model: cpus[0]?.model?.trim() || null,
        // Windows reports zeros; absent is more honest than a fake idle box.
        loadAverage: os.platform() === 'win32' ? null : os.loadavg(),
      },
      memory,
      disk,
      process: {
        rssBytes: process.memoryUsage().rss,
        cpuPercent: readProcessCpuPercent(),
        uptimeSec: Math.round(process.uptime()),
      },
    };
  };

  return { collect };
};
