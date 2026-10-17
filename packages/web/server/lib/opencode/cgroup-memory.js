/**
 * Why a managed OpenCode restart happened, measured from the cgroup the
 * server runs in. OpenCode is our child, so it shares that cgroup: when the
 * kernel throttles or reclaims memory there, `memory.events` counts it and
 * `memory.pressure` reports how long tasks stalled for memory.
 *
 * Only Linux with cgroup v2 has these files. Everywhere else, and whenever a
 * file cannot be read, the snapshot is null and the cause falls back to what
 * the lifecycle already knows.
 */
import { readFileSync } from 'node:fs';

/**
 * Share of the last 60 seconds in which every task in the cgroup was stalled
 * waiting for memory (`full avg60`, percent). Above it the machine was
 * reclaiming memory instead of running OpenCode, so a health probe timing out
 * is the expected symptom.
 */
export const MEMORY_PRESSURE_FULL_AVG60_THRESHOLD = 10;

const CGROUP_ROOT = '/sys/fs/cgroup';

const parseEvents = (text) => {
  const counters = {};
  for (const line of String(text).split('\n')) {
    const [key, value] = line.trim().split(/\s+/);
    const number = Number(value);
    if (key && Number.isFinite(number)) counters[key] = number;
  }
  return Number.isFinite(counters.high) && Number.isFinite(counters.max)
    ? { high: counters.high, max: counters.max, oomKill: counters.oom_kill ?? 0 }
    : null;
};

const parsePressure = (text) => {
  const line = String(text).split('\n').find((entry) => entry.startsWith('full '));
  const match = line?.match(/\bavg60=([\d.]+)/);
  const fullAvg60 = match ? Number(match[1]) : Number.NaN;
  return Number.isFinite(fullAvg60) ? { fullAvg60 } : null;
};

/** `0::/system.slice/openchamber.service` → that path; null outside a v2 hierarchy. */
const ownCgroupPath = (procSelfCgroup) => {
  const line = String(procSelfCgroup).split('\n').find((entry) => entry.startsWith('0::'));
  const relative = line?.slice(3).trim();
  if (!relative || !relative.startsWith('/') || relative.includes('..')) return null;
  return relative;
};

/**
 * `{ events: { high, max, oomKill } | null, pressure: { fullAvg60 } | null }`
 * for the server's own cgroup, or null when neither file is readable.
 */
export const readCgroupMemory = ({ platform = process.platform, readFile = (file) => readFileSync(file, 'utf8') } = {}) => {
  if (platform !== 'linux') return null;
  const read = (file) => {
    try {
      return readFile(file);
    } catch {
      return null;
    }
  };
  const cgroup = ownCgroupPath(read('/proc/self/cgroup') ?? '');
  if (!cgroup) return null;
  const directory = cgroup === '/' ? CGROUP_ROOT : `${CGROUP_ROOT}${cgroup}`;
  const eventsText = read(`${directory}/memory.events`);
  const pressureText = read(`${directory}/memory.pressure`);
  const events = eventsText === null ? null : parseEvents(eventsText);
  const pressure = pressureText === null ? null : parsePressure(pressureText);
  return events || pressure ? { events, pressure } : null;
};

/** Whether the cgroup ran short of memory between `baseline` and `current`. */
const isMemoryPressure = ({ baseline, current }) => {
  if (!current) return false;
  if ((current.pressure?.fullAvg60 ?? 0) >= MEMORY_PRESSURE_FULL_AVG60_THRESHOLD) return true;
  if (!baseline?.events || !current.events) return false;
  return current.events.high > baseline.events.high || current.events.max > baseline.events.max;
};

/**
 * The cause recorded on interrupted sessions. `trigger` is what made the
 * lifecycle restart: `health-failure` (failed probes while the process was
 * alive), `process-exited`, or null for a restart someone asked for.
 */
export const classifyRestartCause = ({ trigger, healthFailureClass = null, baseline = null, current = null }) => {
  if (!trigger) return 'unknown';
  if (isMemoryPressure({ baseline, current })) return 'memory-pressure';
  if (trigger === 'process-exited') return 'process-exited';
  if (trigger === 'health-failure' && healthFailureClass === 'timeout') return 'health-timeout';
  return 'unknown';
};
