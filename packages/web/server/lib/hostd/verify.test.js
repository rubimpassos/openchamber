import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { layout } from './state.js';
import { names, targetProperties } from './units.js';
import { verifySpace } from './verify.js';

const record = { id: '123456abcdef', place: 'host', toolsKey: '1234567890abcdef', memoryBytes: 1024 ** 3, startConfig: null, subnet: 0 };
const calls = ['read', 'write', 'execve', 'mmap'];

describe('hostd interpreted unit verification', () => {
  let root;
  let paths;
  let inspected;
  let commands;
  let system;
  let network;
  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'hostd-verify-'));
    paths = layout(root);
    for (const directory of [paths.state, paths.metadata, paths.pins, path.join(paths.pins, record.id)]) await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    inspected = Object.fromEntries(['gatekeeper', 'space'].map((target) => [names(record.id)[target], {
      ...Object.fromEntries(targetProperties({ record, paths, target })),
      BindReadOnlyPaths: targetProperties({ record, paths, target }).filter(([key]) => key === 'BindReadOnlyPaths').map(([, value]) => value).join(' '),
      LoadState: 'loaded', FragmentPath: path.join(paths.units, names(record.id)[target]),
      SystemCallFilter: calls.join(' '),
    }]));
    inspected[names(record.id).slice] = { MemoryMax: String(record.memoryBytes), MemorySwapMax: '0', TasksMax: '512' };
    inspected[names(record.id).net] = { User: `openchamber-net-${record.id}`, CapabilityBoundingSet: '', AmbientCapabilities: '', NoNewPrivileges: 'yes', ActiveState: 'active' };
    commands = [];
    network = { links: [{ ifname: 'lo', addr_info: [] }, { ifname: `vs-${record.id}`, addr_info: [{ local: '10.233.0.2', prefixlen: 30 }] }], routes: [], forwarding: '0\n' };
    system = { run: async (file, args) => {
      commands.push([file, ...args]);
      let stdout;
      if (file === '/usr/bin/systemd-analyze') stdout = `@system-service\n @base\n@base\n${calls.map((call) => ` ${call}`).join('\n')}\n`;
      else if (file === '/usr/bin/systemctl') stdout = Object.entries(inspected[args[2]]).map(([key, value]) => `${key}=${value}`).join('\n');
      else if (file === '/usr/bin/nsenter') stdout = args.includes('address') ? JSON.stringify(network.links) : args.includes('route') ? JSON.stringify(network.routes) : network.forwarding;
      else throw new Error(`Unexpected command ${file}`);
      return { code: 0, stdout, stderr: '' };
    } };
  });
  afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });

  // Filesystem ownership is observed for real, independently of the command fixtures.
  const permissionChecks = async (files) => {
    const violations = [];
    for (const file of files) {
      const stat = await fs.stat(file);
      if (stat.uid !== 0 || (stat.mode & 0o077) !== 0) violations.push({ check: 'state_permissions', message: `${file} is not private root-owned state` });
    }
    return violations;
  };

  it('checks interpreted units before returning without network inspection', async () => {
    // Given loaded units and no expected network.
    const expected = await permissionChecks([paths.state, paths.metadata, paths.pins]);
    // When verification runs before network startup.
    const violations = await verifySpace({ system, paths, record, ipPath: '/usr/bin/ip' });
    // Then unit checks retain their order and do not enter a namespace.
    expect(violations).toEqual(expected);
    expect(commands).toEqual([
      ['/usr/bin/systemd-analyze', 'syscall-filter'],
      ...['gatekeeper', 'space', 'slice', 'net'].map((target) => ['/usr/bin/systemctl', 'show', '--all', names(record.id)[target]]),
    ]);
  });

  it('reports missing units before inspecting their authority properties', async () => {
    // Given a missing gatekeeper and a space with unexpected identity and namespaces.
    inspected[names(record.id).gatekeeper] = { LoadState: 'not-found' };
    inspected[names(record.id).space].User = 'unexpected';
    delete inspected[names(record.id).space].RestrictNamespaces;
    // When verification inspects the units.
    const violations = await verifySpace({ system, paths, record, ipPath: '/usr/bin/ip' });
    // Then the missing-unit return and subsequent checks preserve their order.
    expect(violations.filter(({ check }) => check !== 'state_permissions').map(({ check }) => check)).toEqual(['gatekeeper_missing', 'namespaces', 'user']);
  });

  it('accepts the private veth network and stopped-space default', async () => {
    // Given the expected private network, without a running space.
    const expected = await permissionChecks([paths.state, paths.metadata, paths.pins, path.join(paths.pins, record.id)]);
    // When the caller explicitly requests network verification.
    const violations = await verifySpace({ system, paths, record, ipPath: '/usr/bin/ip', networkExpected: true });
    // Then the address, route and forwarding checks run after unit inspection.
    expect(violations).toEqual(expected);
    expect(commands.slice(-3)).toEqual([
      ['/usr/bin/nsenter', `--net=/run/netns/ocs-${record.id}`, '--', '/usr/bin/ip', '-j', 'address', 'show'],
      ['/usr/bin/nsenter', `--net=/run/netns/ocs-${record.id}`, '--', '/usr/bin/ip', '-j', 'route', 'show'],
      ['/usr/bin/nsenter', `--net=${paths.pins}/${record.id}/net`, '--', '/bin/cat', '/proc/sys/net/ipv4/ip_forward'],
    ]);
  });

  it('reports network and stopped-egress violations in their existing order', async () => {
    // Given an invalid network and stopped egress while the space is running.
    network.links = [];
    network.routes = [{ dst: 'default', gateway: '10.233.0.1' }];
    network.forwarding = '1\n';
    inspected[names(record.id).net].ActiveState = 'inactive';
    // When running implies that network verification is required.
    const violations = await verifySpace({ system, paths, record, ipPath: '/usr/bin/ip', running: true });
    // Then each existing refusal remains observable in the same order.
    expect(violations.filter(({ check }) => check !== 'state_permissions').map(({ check }) => check)).toEqual(['space_network', 'space_route', 'gatekeeper_forwarding', 'slirp_missing']);
  });
});
