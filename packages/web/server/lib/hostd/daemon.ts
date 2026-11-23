import fs from 'node:fs/promises';
import path from 'node:path';
import { SpaceError, spaceErrorProperty } from '../spaces/errors.js';
import { createState, layout, writeJson } from './state.js';
import { createSystem, checkRequirements, showUnit } from './system.js';
import { createNetwork } from './network.js';
import { createExecutor } from './exec.js';
import { createTools } from './tools.js';
import { createLifecycle } from './lifecycle.js';
import { isRootRequest, createRootOps } from './root-ops.js';
import { names } from './units.js';
import type { HostdPlace, ParsedHostdRequest } from './contracts.js';
import type { HostdServerIO } from './server.js';
import type { StatePaths, StateRecord } from './state.js';
import type { HostdSystem } from './system.js';

type DaemonOptions = {
  readonly paths?: StatePaths;
  readonly system?: HostdSystem;
  readonly rootOps?: Pick<ReturnType<typeof createRootOps>, 'handle' | 'authorize' | 'separation'> | null;
};

export async function createDaemon({ paths = layout(), system = createSystem(), rootOps = null }: DaemonOptions = {}) {
  const state = createState(paths);
  await state.initialize();
  const tools = createTools({ system, paths, state });
  const executor = createExecutor({ system, paths, state });
  const root = rootOps ?? createRootOps({ paths, state, run: system.run });
  const lifecycle = async () => {
    const ipPath = await system.ipPath();
    const network = createNetwork({ system, paths, ipPath });
    return createLifecycle({ system, paths, state, tools, network, executor, ipPath, authorizeRoot: root.authorize });
  };
  let pending = Promise.resolve();
  const serialized = <Result>(operation: () => Result | Promise<Result>) => {
    const result = pending.then(operation);
    pending = result.then(() => undefined, () => undefined);
    return result;
  };
  const records = async (): Promise<StateRecord[]> => (await state.list()).map((record) => {
    if (!record) throw new SpaceError('space_record_missing', 'A host space record disappeared while listing records');
    return record;
  });
  const list = async (place: HostdPlace) => {
    const result = [];
    for (const record of (await records()).filter((entry) => entry.place === place)) {
      const unit = names(record.id);
      const space = await showUnit(system, unit.space);
      const guard = await showUnit(system, unit.gatekeeper);
      const running = space.ActiveState === 'active';
      const missing = [];
      for (const name of ['home', 'work']) if (!await fs.stat(path.join(paths.privateState, record.id, name)).then(() => true, () => false)) missing.push(name);
      if (running && guard.ActiveState !== 'active') missing.push(unit.gatekeeper);
      const entry = {
        id: record.id, name: record.name, project: record.project, created: record.created,
        state: missing.includes('home') || missing.includes('work') ? 'missing' : running ? 'running' : 'exited',
        stoppedIdle: !running && record.lastExit?.code === 'exited' && record.lastExit?.status === '75',
        gatekeeperRunning: guard.ActiveState === 'active', orphans: [], damaged: missing.length > 0, missing,
        purpose: record.purpose,
      };
      result.push(entry);
    }
    return result;
  };
  const disk = async (place: HostdPlace) => {
    const size = async (directory: string) => {
      const result = await system.run('/usr/bin/du', ['--bytes', '--summarize', '--', directory]);
      if (result.code !== 0) throw new SpaceError('disk_unreadable', result.stderr.slice(-2000));
      return Number(result.stdout.split(/\s+/)[0]);
    };
    const snapshot = await records();
    const used = new Set(snapshot.map((record) => record.toolsKey));
    const bytesBySpace: Record<string, number> = {};
    for (const record of snapshot.filter((entry) => entry.place === place)) bytesBySpace[record.id] = await size(path.join(paths.privateState, record.id));
    let toolsBytes = 0;
    let freeBytes = 0;
    for (const key of await fs.readdir(paths.tools)) if (/^[0-9a-f]{16}$/.test(key)) {
      const bytes = await size(path.join(paths.tools, key));
      toolsBytes += bytes;
      if (!used.has(key)) freeBytes += bytes;
    }
    return { imageBytes: 0, imagePulling: false, imageFailure: null, toolsBytes, spacesBytes: Object.values(bytesBySpace).reduce((sum, value) => sum + value, 0), bytesBySpace, freeBytes, freesImage: false };
  };
  const request = async (value: ParsedHostdRequest, io: HostdServerIO) => {
    if (isRootRequest(value)) return root.handle(value);
    switch (value.op) {
      case 'check': return checkRequirements(system);
      case 'list': return list(value.place);
      case 'disk': return disk(value.place);
      case 'tools-ensure': {
        const result = await tools.ensure(value.key, io.input);
        await writeJson(path.join(paths.state, 'current-tools.json'), { key: value.key });
        return result;
      }
      case 'tools-prune': return serialized(() => tools.prune(value.keep));
      case 'exec': case 'attach':
        if (value.place === 'host-root' && !await root.separation()) {
          throw new SpaceError('agent_separation_missing', 'A root space is reached only while OpenChamber runs with its agent on an account of its own');
        }
        return executor.run(value, io);
      case 'create': return serialized(async () => { await (await lifecycle()).create(value); return null; });
      case 'start': return serialized(async () => {
        const record = await state.requireRecord(value.place, value.id);
        await (await lifecycle()).start(record, { assertion: value.assertion ?? null });
        return null;
      });
      case 'stop': return serialized(async () => { await (await lifecycle()).stop(await state.requireRecord(value.place, value.id)); return null; });
      case 'verify': return (await lifecycle()).verify(await state.requireRecord(value.place, value.id));
      case 'remove': return serialized(async () => {
        const record = await state.read(value.id);
        if (!record || record.place !== value.place) return { removed: [], failed: [] };
        try { return await (await lifecycle()).remove(record); }
        catch (error) {
          const message = spaceErrorProperty(error, 'message');
          return { removed: [], failed: [{ kind: 'space', name: value.id, message: typeof message === 'string' ? message : undefined }] };
        }
      });
      default: throw new SpaceError('invalid_request', 'Unknown hostd operation');
    }
  };
  return { request, state, executor, paths, system };
}
