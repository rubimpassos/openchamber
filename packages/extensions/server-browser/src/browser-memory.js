import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const linuxProcessTable = async () => {
  const { stdout } = await execute('ps', ['-e', '-o', 'pid=,ppid=,stat='], {
    timeout: 5_000,
    maxBuffer: 8 * 1024 * 1024,
    env: { ...process.env, LC_ALL: 'C' },
  });
  return stdout;
};
const running = (child) => child && Number.isSafeInteger(child.pid) && child.pid > 0
  && child.exitCode === null && child.signalCode === null;

export const readBrowserMemory = async (browserProcesses, {
  platform = process.platform,
  readProcessTable = linuxProcessTable,
  files = fs,
} = {}) => {
  const unavailable = browserProcesses.map(() => null);
  if (platform !== 'linux' || !browserProcesses.some(running)) return unavailable;
  let output;
  try {
    output = await readProcessTable();
  } catch (error) {
    if (error instanceof Error) return unavailable;
    throw error;
  }
  const processes = new Map();
  const children = new Map();
  for (const line of output.trim().split(/\r?\n/)) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\S+)\s*$/.exec(line);
    if (!match) return unavailable;
    const [, rawPid, rawParent, state] = match;
    const pid = Number(rawPid);
    const parent = Number(rawParent);
    if (![pid, parent].every(Number.isSafeInteger) || pid < 1 || processes.has(pid)) return unavailable;
    processes.set(pid, { state });
    const siblings = children.get(parent);
    if (siblings) siblings.push(pid);
    else children.set(parent, [pid]);
  }
  return Promise.all(browserProcesses.map(async (child) => {
    if (!running(child)) return null;
    const root = processes.get(child.pid);
    if (!root || /^[ZX]/.test(root.state)) return null;
    const pending = [child.pid];
    const visited = new Set();
    let bytes = 0;
    for (const pid of pending) {
      if (visited.has(pid)) return null;
      visited.add(pid);
      pending.push(...(children.get(pid) ?? []));
      let rollup;
      try {
        rollup = await files.readFile(`/proc/${pid}/smaps_rollup`, 'utf8');
      } catch (error) {
        if (!(error instanceof Error)) throw error;
        if (error.code === 'ENOENT' && pid !== child.pid) continue;
        return null;
      }
      const pss = /^Pss:\s+(\d+)\s+kB$/m.exec(rollup);
      if (!pss) return null;
      bytes += Number(pss[1]) * 1024;
    }
    return running(child) && Number.isSafeInteger(bytes) && bytes > 0 ? bytes : null;
  }));
};
