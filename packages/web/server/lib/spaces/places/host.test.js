import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { createHostPlace } from './host.js';
import { createRegistryToolsSource, toolsContentKey } from '../tools.js';

const source = createRegistryToolsSource({ webVersion: '2.6.3', openCodeVersion: '2.2.5' });
const spec = { id: '123456abcdef', name: 'test', project: '1234567890abcdef', created: '2026-11-06T00:00:00.000Z', memoryBytes: 1024 ** 3 };
const available = { available: true, nodeVersion: 'v24.21.0', version: '252', os: 'linux', arch: 'x64', hostIsolation: true };

function fake() {
  let spaces = [];
  const hostd = {
    request: vi.fn(async (request) => {
      switch (request.op) {
        case 'check': return available;
        case 'list': return spaces;
        case 'create': spaces = [{ ...request.spec, state: 'running', stoppedIdle: false, gatekeeperRunning: true, orphans: [], damaged: false, missing: [] }]; return null;
        case 'stop': spaces = spaces.map((entry) => ({ ...entry, state: 'exited' })); return null;
        case 'remove': spaces = []; return { removed: [], failed: [] };
        case 'verify': return [];
        case 'start': return null;
        case 'root-activation-options': return { challenge: 'fixture-challenge', expiresAt: 42, credentials: [] };
        case 'tools-ensure': return { key: request.key, filled: false };
        default: throw new Error(`Unexpected request: ${request.op}`);
      }
    }),
    exec: vi.fn(async () => ({ code: 7, stdout: 'output', stderr: 'error' })),
    attach: vi.fn(async () => new PassThrough()),
  };
  return hostd;
}

describe('host place adapter', () => {
  it('does nothing until an operation is called', () => {
    const hostd = fake();
    const place = createHostPlace({ hostd, toolsSource: source });
    expect(place.kind).toBe('host');
    expect(place.machine).toBeNull();
    expect(hostd.request).not.toHaveBeenCalled();
  });
  it('never advertises isolation for the root place', async () => {
    const place = createHostPlace({ id: 'host-root', hostd: fake(), toolsSource: source });
    expect(await place.check()).toMatchObject({ available: true, hostIsolation: false });
  });
  it('keys tools by the daemon node version and architecture and streams fill bytes', async () => {
    const hostd = fake();
    const place = createHostPlace({ hostd, toolsSource: source });
    await place.create(spec);
    const key = toolsContentKey(source, 'host:v24.21.0:x64');
    const ensure = hostd.request.mock.calls.find(([request]) => request.op === 'tools-ensure');
    expect(ensure[0]).toEqual({ op: 'tools-ensure', key, input: null });
    expect(ensure[1].input).toBeInstanceOf(Buffer);
    expect(JSON.parse(ensure[1].input.toString().split('\n')[0]).key).toBe(key);
    expect(hostd.request).toHaveBeenCalledWith({ op: 'create', place: 'host', spec, startConfig: null, toolsKey: key });
  });
  it('returns command exits and propagates runner failures with their codes', async () => {
    const hostd = fake();
    const place = createHostPlace({ hostd, toolsSource: source });
    expect(await place.exec(spec.id, ['id'])).toEqual({ code: 7, stdout: 'output', stderr: 'error' });
    hostd.exec.mockRejectedValueOnce(Object.assign(new Error('timeout'), { code: 'command_timeout' }));
    await expect(place.exec(spec.id, ['sleep', '99'])).rejects.toMatchObject({ code: 'command_timeout' });
    await expect(place.exec(spec.id, ['id'], { target: 'host' })).rejects.toMatchObject({ code: 'invalid_exec_target' });
  });
  it('checks running state before exposing an attach argv or stream', async () => {
    const hostd = fake();
    const place = createHostPlace({ hostd, toolsSource: source, clientScript: '/opt/root-owned/attach-client.js' });
    await place.create(spec);
    expect(await place.execArgv(spec.id)).toEqual([process.execPath, '/opt/root-owned/attach-client.js', 'attach', 'host', spec.id]);
    const stream = await place.connect(spec.id);
    expect(stream.bridge).toBe(true);
    expect(hostd.attach).toHaveBeenCalledWith({ op: 'attach', place: 'host', id: spec.id });
    stream.destroy();
    hostd.attach.mockClear();
    await place.stop(spec.id);
    await expect(place.connect(spec.id)).rejects.toMatchObject({ code: 'space_not_running' });
    await expect(place.execArgv(spec.id)).rejects.toMatchObject({ code: 'space_not_running' });
    expect(hostd.attach).not.toHaveBeenCalled();
    await place.remove(spec.id);
    await expect(place.execArgv(spec.id)).rejects.toMatchObject({ code: 'space_not_found' });
  });
  it('uses the configured daemon socket for attached git commands too', async () => {
    const hostd = { ...fake(), socketPath: '/run/custom/hostd.sock' };
    const place = createHostPlace({ hostd, toolsSource: source, clientScript: '/opt/root-owned/attach-client.js' });
    await place.create(spec);
    expect(await place.execArgv(spec.id)).toEqual([process.execPath, '/opt/root-owned/attach-client.js', '--socket', '/run/custom/hostd.sock', 'attach', 'host', spec.id]);
  });
  it('runs the packaged Electron helper as Node while keeping its asar script path', async () => {
    const hostd = fake();
    const clientScript = '/opt/OpenChamber/resources/app.asar/node_modules/@openchamber/web/server/lib/hostd/attach-client.js';
    const helperRuntime = { execPath: '/opt/OpenChamber/openchamber', versions: { electron: '42.0.0' } };
    const place = createHostPlace({ hostd, toolsSource: source, clientScript, helperRuntime });
    await place.create(spec);
    expect(await place.execArgv(spec.id)).toEqual(['/usr/bin/env', 'ELECTRON_RUN_AS_NODE=1', helperRuntime.execPath, clientScript, 'attach', 'host', spec.id]);
  });
  it.each(['hostd_missing', 'hostd_unreachable'])('reports %s explicitly without a fallback', async (code) => {
    const hostd = fake();
    hostd.request.mockRejectedValue(Object.assign(new Error('install hostd'), { code }));
    const place = createHostPlace({ hostd, toolsSource: source });
    expect(await place.check()).toEqual({ available: false, code, message: 'install hostd' });
  });
  it('keeps a daemon requirement failure unavailable when preparing tools', async () => {
    // Given a daemon that answers but cannot run spaces.
    const hostd = fake();
    const unavailable = { available: false, code: 'systemd_version', message: 'Upgrade systemd', extra: 'retained' };
    hostd.request.mockResolvedValue(unavailable);
    const place = createHostPlace({ hostd, toolsSource: source });
    // When tools preparation asks for availability.
    const preparation = place.pullImage();
    // Then the original requirement failure reaches the caller, without filling tools.
    await expect(preparation).rejects.toMatchObject({ code: unavailable.code, message: unavailable.message });
    expect(hostd.request.mock.calls.map(([request]) => request.op)).toEqual(['check']);
  });
  it.each([
    ['check', { available: 'yes', nodeVersion: 'v24.21.0', arch: 'x64' }],
    ['list', [{ ...spec, state: 'unknown' }]],
    ['readDisk', { toolsBytes: '100' }],
    ['verify', [{ check: 'unit' }]],
    ['remove', { removed: [], failed: null }],
  ])('rejects malformed %s answers at the adapter boundary', async (operation, answer) => {
    // Given an operation-specific malformed response in a successful envelope.
    const hostd = fake();
    hostd.request.mockResolvedValue(answer);
    const place = createHostPlace({ hostd, toolsSource: source });
    // When the public place operation consumes it.
    const result = place[operation](spec.id);
    // Then it fails explicitly rather than supplying authoritative place data.
    await expect(result).rejects.toMatchObject({ name: 'ZodError' });
  });
  it('reports reclaimed tools bytes after successful pruning', async () => {
    // Given two disk snapshots around a successful tools prune.
    const hostd = fake();
    const disk = { imageBytes: 0, toolsBytes: 100, spacesBytes: 20, bytesBySpace: { [spec.id]: 20 }, freeBytes: 60, freesImage: false, extra: 'retained' };
    hostd.request.mockResolvedValueOnce(disk).mockResolvedValueOnce({ removed: [{ kind: 'tools', name: '1234567890abcdef' }], failed: [] }).mockResolvedValueOnce({ ...disk, toolsBytes: 40 });
    const place = createHostPlace({ hostd, toolsSource: source });
    // When disk cleanup prunes unused tools.
    const result = await place.cleanUpDisk();
    // Then reclaimed bytes and failed removals keep the existing contract.
    expect(result).toEqual({ freedBytes: 60, kept: [], machine: { state: 'skipped' } });
    expect(hostd.request.mock.calls[1][0]).toEqual({ op: 'tools-prune', keep: [] });
  });
  it('preserves additional disk fields while overlaying adapter preparation state', async () => {
    // Given a complete disk answer with an additional daemon field.
    const hostd = fake();
    const disk = { imageBytes: 0, toolsBytes: 100, spacesBytes: 20, bytesBySpace: {}, freeBytes: 60, freesImage: false, extra: 'retained', imagePulling: true };
    hostd.request.mockResolvedValue(disk);
    const place = createHostPlace({ hostd, toolsSource: source });
    // When the place reads disk usage.
    const result = await place.readDisk();
    // Then daemon fields survive and local preparation state wins.
    expect(result).toEqual({ ...disk, imagePulling: false, imageFailure: null });
  });
  it.each(['http://localhost:11434/', 'http://127.1/', 'http://2130706433/', 'http://[::1]:9000/', 'http://[::ffff:127.0.0.1]:9000/', 'http://host.docker.internal:9000/'])('refuses an unavailable loopback window %s after URL normalization', (upstream) => {
    const place = createHostPlace({ hostd: fake(), toolsSource: source });
    expect(() => place.requireWindowUpstream(upstream)).toThrow(expect.objectContaining({ code: 'host_loopback_unavailable' }));
  });
  it('keeps explicitly granted private-network and public window upstreams allowed', () => {
    const place = createHostPlace({ hostd: fake(), toolsSource: source });
    expect(() => place.requireWindowUpstream('http://10.1.2.3:11434/')).not.toThrow();
    expect(() => place.requireWindowUpstream('https://api.openai.com/v1/')).not.toThrow();
  });
  it('carries a root confirmation to hostd only when one came, and asks hostd for root confirmations on the root place only', async () => {
    const hostd = fake();
    const assertion = { id: 'credential', type: 'public-key' };
    const root = createHostPlace({ id: 'host-root', hostd, toolsSource: source });
    await root.create(spec, { activation: assertion });
    await root.start(spec.id, { activation: assertion });
    await root.start(spec.id);
    const sent = hostd.request.mock.calls.map(([request]) => request).filter((request) => ['create', 'start'].includes(request.op));
    expect(sent.map((request) => [request.op, request.place, request.assertion])).toEqual([['create', 'host-root', assertion], ['start', 'host-root', assertion], ['start', 'host-root', undefined]]);
    expect(sent[2]).not.toHaveProperty('assertion');
    await root.rootActivationOptions({ op: 'create', spec: { id: spec.id, name: spec.name, project: spec.project, memoryBytes: spec.memoryBytes } });
    await root.rootActivationOptions({ op: 'start', id: spec.id });
    expect(hostd.request.mock.calls.slice(-2).map(([request]) => request)).toEqual([
      { op: 'root-activation-options', action: 'create', spec: { id: spec.id, name: spec.name, project: spec.project, memoryBytes: spec.memoryBytes } },
      { op: 'root-activation-options', action: 'start', id: spec.id },
    ]);
    const host = createHostPlace({ hostd: fake(), toolsSource: source });
    for (const name of ['rootStatus', 'rootApprovalChallenge', 'rootApprovalComplete', 'rootActivationOptions']) expect(host[name]).toBeUndefined();
  });
});
