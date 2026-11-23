import { execFile } from 'node:child_process';
import type { Stats } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { isRecord } from '../../shared/guards.js';
import { ProtectedMcpError } from './contract.js';

type Identity = { readonly uid: number; readonly gids: readonly number[] };
type RunResult = { readonly ok: true; readonly stdout: string } | { readonly ok: false; readonly code: string | number | null | undefined };
type Finding = { readonly code: string; readonly subject: string };
type ReadAcl = (target: string, identity: Identity) => Promise<readonly string[] | null>;
type IntegrityOptions = {
  readonly owners: readonly number[];
  readonly groups?: readonly number[];
  readonly engine: Identity;
  readonly readAcl?: ReadAcl;
};

const errorCode = <Failure>(error: Failure) => isRecord(error) ? error.code : undefined;

const ancestors = (target: string) => {
  const chain = [];
  let current = target;
  for (;;) {
    chain.push(current);
    const parent = path.dirname(current);
    if (parent === current) return chain;
    current = parent;
  }
};

const run = (command: string, args: readonly string[]) => new Promise<RunResult>((resolve) => {
  execFile(command, args, { timeout: 5000, maxBuffer: 1024 * 1024 }, (error, stdout) => {
    resolve(error ? { ok: false, code: error.code } : { ok: true, stdout });
  });
});

async function readAclWriters(target: string, engine: Identity) {
  const result = await run('getfacl', ['-cpn', '--', target]);
  if (!result.ok) {
    if (result.code === 'ENOENT') return null;
    throw new ProtectedMcpError('acl_unreadable', { status: 500, message: `acl_unreadable: ${target}` });
  }
  const mask = /^mask::(\S+)$/m.exec(result.stdout)?.[1] ?? 'rwx';
  const writers = [];
  for (const line of result.stdout.split('\n')) {
    const match = /^(user|group):(\d+):(\S+)/.exec(line.trim());
    if (!match?.[3]?.includes('w') || !mask.includes('w')) continue;
    const id = Number(match[2]);
    if ((match[1] === 'user' && id === engine.uid) || (match[1] === 'group' && engine.gids.includes(id))) writers.push(line.trim());
  }
  return writers;
}

async function resolutionPaths(target: string) {
  const visited = ['/'];
  let current = '/';
  const pending = (path.isAbsolute(target) ? target : `${process.cwd()}/${target}`).split('/');
  let hops = 0;
  for (let name = pending.shift(); name !== undefined; name = pending.shift()) {
    if (name === '' || name === '.') continue;
    if (name === '..') {
      current = path.dirname(current);
      continue;
    }
    const next = path.join(current, name);
    visited.push(next);
    let link;
    try {
      link = await fs.readlink(next);
    } catch (error) {
      if (errorCode(error) === 'EINVAL') {
        current = next;
        continue;
      }
      break;
    }
    hops += 1;
    if (hops > 40) break;
    if (path.isAbsolute(link)) current = '/';
    pending.unshift(...link.split('/'));
  }
  return visited;
}

export async function resolveIdentity(user: string) {
  const [uid, gids] = await Promise.all([run('id', ['-u', '--', user]), run('id', ['-G', '--', user])]);
  if (!uid.ok || !gids.ok) throw new ProtectedMcpError('unknown_account', { status: 500, message: `unknown_account: ${user}` });
  return { uid: Number(uid.stdout.trim()), gids: gids.stdout.trim().split(/\s+/).map(Number) };
}

export function createIntegrity({ owners, groups = [0], engine, readAcl = readAclWriters }: IntegrityOptions) {
  const checkAcl = async (element: string, findings: Finding[]) => {
    let writers;
    try {
      writers = await readAcl(element, engine);
    } catch (error) {
      if (errorCode(error) !== 'acl_unreadable') throw error;
      findings.push({ code: 'acl_unreadable', subject: element });
      return true;
    }
    if (writers === null) return false;
    if (writers.length > 0) findings.push({ code: 'acl_writable_by_engine', subject: element });
    return true;
  };

  const checkEntry = async (entry: { readonly path: string; readonly stats: Stats; readonly acl?: boolean }, findings: Finding[]) => {
    const { path: element, stats, acl = true } = entry;
    if (stats.uid === engine.uid) findings.push({ code: 'owned_by_engine', subject: element });
    else if (!owners.includes(stats.uid)) findings.push({ code: 'untrusted_owner', subject: element });
    if (stats.isSymbolicLink()) return true;
    if (stats.mode & 0o002) findings.push({ code: 'writable_by_others', subject: element });
    if (stats.mode & 0o020 && (engine.gids.includes(stats.gid) || !groups.includes(stats.gid))) {
      findings.push({ code: 'writable_by_group', subject: element });
    }
    return acl ? checkAcl(element, findings) : true;
  };

  const inspect = async (target: string, { acl = true, allowMissing = false } = {}) => {
    const findings: Finding[] = [];
    let real: string | null = null;
    try {
      real = await fs.realpath(target);
    } catch (error) {
      const code = errorCode(error);
      const absent = code === 'ENOENT' || code === 'ENOTDIR';
      if (!allowMissing || !absent) return { findings: [{ code: 'path_missing', subject: target }], aclInspected: false, real: null };
    }
    let aclInspected = acl;
    const way = await resolutionPaths(target);
    for (const element of new Set(real ? [...way, ...ancestors(real)] : way)) {
      let stats;
      try {
        stats = await fs.lstat(element);
      } catch (error) {
        const code = errorCode(error);
        if (!real && (code === 'ENOENT' || code === 'ENOTDIR')) break;
        findings.push({ code: 'path_missing', subject: element });
        continue;
      }
      if (!(await checkEntry({ path: element, stats, acl }, findings))) aclInspected = false;
    }
    return { findings, aclInspected, real };
  };

  const inspectTree = async (root: string) => {
    const top = await inspect(root);
    const findings = [...top.findings];
    let aclInspected = top.aclInspected;
    if (!top.real) return { findings, aclInspected };
    const walk = async (directory: string): Promise<void> => {
      for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
        const full = path.join(directory, entry.name);
        if (!(await checkEntry({ path: full, stats: await fs.lstat(full) }, findings))) aclInspected = false;
        if (entry.isDirectory()) await walk(full);
      }
    };
    await walk(top.real);
    return { findings, aclInspected };
  };

  return {
    inspect,
    inspectTree,
    aclWriters: (target: string) => readAcl(target, engine),
    async checkArgument(target: string) {
      const { findings } = await inspect(target, { allowMissing: true });
      const [first] = findings;
      if (first) throw new ProtectedMcpError('untrusted_argument', { status: 500, message: `untrusted_argument: ${first.code}` });
    },
    async checkExecutable(target: string) {
      const { findings, real } = await inspect(target);
      if (findings.length > 0 || !real) throw new ProtectedMcpError('untrusted_executable', { status: 500, message: `untrusted_executable: ${findings[0]?.code ?? 'missing'}` });
      const stats = await fs.stat(real);
      if (!stats.isFile() || (stats.mode & 0o111) === 0) throw new ProtectedMcpError('untrusted_executable', { status: 500, message: 'untrusted_executable: not_executable' });
      return real;
    },
  };
}
