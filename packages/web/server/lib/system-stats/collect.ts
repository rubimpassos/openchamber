const CPU_BASELINE_MAX_AGE_MS = 60_000;
const CPU_BASELINE_WAIT_MS = 250;

type CpuReading = { readonly at: number; readonly idle: number; readonly total: number };
type ProcessReading = { readonly at: number; readonly usage: NodeJS.CpuUsage };
type CollectorDependencies = {
  readonly os: Pick<typeof import('node:os'), 'arch' | 'cpus' | 'freemem' | 'homedir' | 'hostname' | 'loadavg' | 'platform' | 'release' | 'totalmem' | 'type' | 'uptime'>;
  readonly fsPromises: {
    readFile(path: string, encoding: 'utf8'): Promise<string>;
    statfs(path: string): Promise<Pick<import('node:fs').StatsFs, 'bsize' | 'blocks' | 'bavail' | 'bfree'>>;
  };
  readonly process: Pick<NodeJS.Process, 'cpuUsage' | 'memoryUsage' | 'uptime'>;
  readonly diskPath?: string;
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
};

const sumCpuTimes = (cpus: readonly import('node:os').CpuInfo[]) => {
  let idle = 0;
  let total = 0;
  for (const cpu of cpus) {
    const { user, nice, sys, idle: cpuIdle, irq } = cpu.times;
    idle += cpuIdle;
    total += user + nice + sys + cpuIdle + irq;
  }
  return { idle, total };
};

const clampPercent = (value: number) => Math.min(100, Math.max(0, value));

const parseMemAvailableBytes = (meminfo: string) => {
  const match = /^MemAvailable:\s+(\d+)\s+kB$/m.exec(meminfo);
  return match ? Number(match[1]) * 1024 : null;
};

const parseOsPrettyName = (osRelease: string) => {
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
  sleep = (ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
}: CollectorDependencies) => {
  let cpuBaseline: CpuReading | null = null;
  let processBaseline: ProcessReading | null = null;
  let osNamePromise: Promise<string> | null = null;

  const readCpuTimes = () => ({ at: now(), ...sumCpuTimes(os.cpus()) });

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
