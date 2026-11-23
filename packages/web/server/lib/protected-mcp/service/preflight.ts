import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import type { Stats } from 'node:fs';
import type { Enforcement, Finding } from './contract.js';
import type { createIntegrity } from './integrity.js';
import { isRecord } from '../../shared/guards.js';

type Integrity = ReturnType<typeof createIntegrity>;
type Engine = Parameters<typeof createIntegrity>[0]['engine'];
type UnitState = Readonly<Record<string, string>>;
export type PreflightOptions = {
  readonly integrity: Pick<Integrity, 'inspect' | 'inspectTree' | 'aclWriters'>;
  readonly engine: Engine;
  readonly engineUser: string;
  readonly engineUnit?: string | null;
  readonly adminSocket?: string | null;
  readonly trustedPaths: readonly string[];
  readonly trustedTrees?: readonly string[];
  readonly privateDirectories: readonly string[];
  readonly sockets?: readonly string[] | undefined;
  readonly socketOwners?: readonly number[] | undefined;
  readonly readGroups?: () => Promise<string>;
  readonly showUnit?: (unit: string) => Promise<UnitState | null>;
  readonly now?: () => number;
};
export type PreflightResult = Enforcement & { readonly administration: 'shared' | 'separate' };

const errorCode = <Failure>(error: Failure) => isRecord(error) ? error.code : undefined;

export const ROOT_EQUIVALENT_SOCKETS = [
  '/var/run/docker.sock', '/run/docker.sock', '/run/containerd/containerd.sock', '/var/run/containerd/containerd.sock',
  '/run/podman/podman.sock', '/var/run/crio/crio.sock', '/run/buildkit/buildkitd.sock', '/var/run/libvirt/libvirt-sock',
  '/var/snap/lxd/common/lxd/unix.socket', '/var/lib/lxd/unix.socket', '/var/lib/incus/unix.socket',
] as const;
const ROOT_EQUIVALENT_GROUPS = new Set(['disk', 'root']);
const ESCALATION_GROUPS = new Set(['sudo', 'wheel', 'admin']);
const CONTAINER_GROUPS = new Set(['docker', 'lxd', 'incus', 'libvirt']);

const parseGroups = (text: string) => {
  const byGid = new Map<number, string>();
  for (const line of text.split('\n')) {
    const [name, , gid] = line.split(':');
    if (name && /^\d+$/.test(gid ?? '')) byGid.set(Number(gid), name);
  }
  return byGid;
};

const canConnect = (stats: Stats, engine: Engine) => {
  if (stats.uid === engine.uid) return (stats.mode & 0o200) !== 0;
  if (engine.gids.includes(stats.gid)) return (stats.mode & 0o020) !== 0;
  return (stats.mode & 0o002) !== 0;
};

const systemctlShow = (unit: string) => new Promise<UnitState | null>((resolve) => {
  execFile('systemctl', ['show', unit, '--property=NoNewPrivileges', '--property=User', '--property=ActiveState'], { timeout: 5000 }, (error, stdout) => {
    if (error) return resolve(null);
    resolve(Object.fromEntries(stdout.trim().split('\n').map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)])));
  });
});

function enforcementStatus(findings: readonly Finding[]): Enforcement['status'] {
  if (findings.some((finding) => finding.level === 'error')) return 'unprotected';
  if (findings.some((finding) => finding.level === 'unknown')) return 'unverified';
  return 'protected';
}

export async function runPreflight({ integrity, engine, engineUser, engineUnit = null, adminSocket = null, trustedPaths, trustedTrees = [], privateDirectories, sockets = ROOT_EQUIVALENT_SOCKETS, socketOwners = [0], readGroups = () => fs.readFile('/etc/group', 'utf8'), showUnit = systemctlShow, now = Date.now }: PreflightOptions): Promise<PreflightResult> {
  const findings: Finding[] = [];
  const add = (code: string, level: Finding['level'], subject?: string) => findings.push(subject === undefined ? { code, level } : { code, level, subject });
  if (engine.uid === 0) add('engine_is_root', 'error');

  for (const [target, check] of [...trustedPaths.map((target) => [target, integrity.inspect] as const), ...trustedTrees.map((target) => [target, integrity.inspectTree] as const)]) {
    const { findings: pathFindings, aclInspected } = await check(target);
    for (const finding of pathFindings) add(finding.code, finding.code === 'acl_unreadable' ? 'unknown' : 'error', finding.subject);
    if (!aclInspected) add('acl_not_inspected', 'unknown', target);
  }
  for (const directory of privateDirectories) {
    try {
      const stats = await fs.stat(directory);
      if ((stats.mode & 0o077) !== 0) add('private_directory_open', 'error', directory);
    } catch {
      add('path_missing', 'error', directory);
    }
  }

  for (const socket of sockets) {
    let stats;
    try {
      stats = await fs.stat(socket);
    } catch (error) {
      const code = errorCode(error);
      if (code !== 'ENOENT' && code !== 'ENOTDIR') add('socket_not_inspected', 'unknown', socket);
      continue;
    }
    if (!stats.isSocket() || !socketOwners.includes(stats.uid)) continue;
    if (canConnect(stats, engine)) {
      add('root_equivalent_socket', 'error', socket);
      continue;
    }
    let writers;
    try {
      writers = await integrity.aclWriters(socket);
    } catch (error) {
      if (errorCode(error) !== 'acl_unreadable') throw error;
      add('acl_unreadable', 'unknown', socket);
      continue;
    }
    if (writers === null) add('acl_not_inspected', 'unknown', socket);
    else if (writers.length > 0) add('root_equivalent_socket', 'error', socket);
  }

  let groupNames = new Map<number, string>();
  try {
    groupNames = parseGroups(await readGroups());
  } catch {
    add('groups_unreadable', 'unknown');
  }
  const unit = engineUnit ? await showUnit(engineUnit) : null;
  const unitBlocksEscalation = Boolean(unit && unit.NoNewPrivileges === 'yes' && unit.User === engineUser);
  if (engineUnit && !unit) add('engine_unit_unreadable', 'unknown', engineUnit);
  for (const gid of engine.gids) {
    const name = groupNames.get(gid);
    if (!name) continue;
    if (ROOT_EQUIVALENT_GROUPS.has(name)) add('root_equivalent_group', 'error', name);
    else if (ESCALATION_GROUPS.has(name)) {
      add(unitBlocksEscalation ? 'engine_account_can_administer' : 'engine_can_escalate', unitBlocksEscalation ? 'warning' : 'unknown', name);
    } else if (CONTAINER_GROUPS.has(name)) add('container_group_member', 'warning', name);
  }
  let administration: PreflightResult['administration'] = 'shared';
  if (adminSocket !== null) {
    try {
      const stats = await fs.stat(adminSocket);
      if (stats.isSocket() && !canConnect(stats, engine)) {
        const writers = await integrity.aclWriters(adminSocket);
        if (writers !== null && writers.length === 0) administration = 'separate';
      }
    } catch { administration = 'shared'; }
  }
  return { status: enforcementStatus(findings), administration, checkedAt: now(), findings };
}
