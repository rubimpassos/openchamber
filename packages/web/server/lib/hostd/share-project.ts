// Gives the agent account access to one of the human's projects, and takes it back. Runs as root,
// in hostd and in the root command. The agent writes into the project afterwards, so every check
// assumes it may already be able to change what is inside: the walk never follows a symbolic link,
// never acts on one, stays on the project's own filesystem, and leaves alone a file that is also
// reachable from elsewhere through a hard link.
import fs from 'node:fs/promises';
import path from 'node:path';
import type { Dirent } from 'node:fs';
import type { RunCommand } from '../spaces/command-contracts.js';
import { spaceErrorProperty } from '../spaces/errors.js';

// allow: SIZE_OK — keep the existing physical walk and ACL sequencing together during the type-only port.
type Account = { readonly name: string; readonly uid: number; readonly gid: number; readonly home: string };
type ShareRecord = {
  readonly path: string; readonly device: number; readonly inode: number;
  readonly ancestors: readonly string[]; readonly status: 'shared' | 'partial'; readonly at: string;
};
type ShareDetails = { readonly links?: readonly { readonly link: string; readonly target: string }[]; readonly mounts?: readonly string[] };
type SkippedEntries = { links: number; otherDevice: string[]; hardLinked: string[] };
type ProjectSharingOptions = {
  readonly human: Account; readonly agent: Account; readonly run: RunCommand; readonly statePath: string;
  readonly readMountInfo?: (() => Promise<string>) | undefined;
};

const SETFACL = '/usr/bin/setfacl';
// Folders of the human's home that hold what their own account runs or authenticates with.
const PRIVATE_HOME_ENTRIES = ['.ssh', '.config', '.local', '.gnupg', '.docker', '.cache', '.opencode', '.bun', '.npm', '.pki', '.kube', '.aws', '.azure'];
// Where the human's own programs and shell look for configuration, read one level deep.
const CONFIG_LINK_PLACES = ['', '.config', '.local/bin'];
const LOCAL_FILESYSTEMS = new Set(['ext2', 'ext3', 'ext4', 'xfs', 'btrfs', 'zfs', 'f2fs', 'tmpfs', 'overlay', 'bcachefs']);
// setfacl takes this many paths per call: far below ARG_MAX with long paths.
const BATCH = 200;
const MAX_REPORTED = 50;

export class ShareProjectError extends Error {
  readonly code: string;
  readonly details: ShareDetails;
  constructor(code: string, message: string, details: ShareDetails = {}) {
    super(message);
    this.code = code;
    this.details = details;
  }
}

const refuse: (code: string, message: string, details?: ShareDetails) => never = (code, message, details) => {
  throw new ShareProjectError(code, message, details);
};

const isInside = (child: string, parent: string) => child === parent || child.startsWith(parent === '/' ? '/' : `${parent}/`);

/** The mounts of this machine, from mountinfo: mount point and filesystem type. */
const parseMountInfo = (text: string) => text.split('\n').filter(Boolean).map((line) => {
  const [before, after] = line.split(' - ');
  const fields = (before ?? '').split(' ');
  const decode = (value: string) => value.replace(/\\([0-7]{3})/g, (_match: string, octal: string) => String.fromCharCode(Number.parseInt(octal, 8)));
  return { mountPoint: decode(fields[4] ?? ''), type: (after ?? '').split(' ')[0] ?? '' };
});

/**
 * `human` and `agent` are `{ name, uid, gid, home }` read from the system by the caller, never from
 * a request. `run(file, args)` resolves `{ code, stdout, stderr }`. `readMountInfo()` answers the text
 * of `/proc/self/mountinfo`. `statePath` holds the shares, root-only.
 */
export function createProjectSharing({ human, agent, run, statePath, readMountInfo = () => fs.readFile('/proc/self/mountinfo', 'utf8') }: ProjectSharingOptions) {
  const readShares = async (): Promise<readonly ShareRecord[]> => {
    try {
      const value: { readonly shares?: readonly ShareRecord[] } | null = JSON.parse(await fs.readFile(statePath, 'utf8'));
      return Array.isArray(value?.shares) ? value.shares : [];
    } catch (error) {
      if (spaceErrorProperty(error, 'code') === 'ENOENT') return [];
      throw error;
    }
  };
  const writeShares = async (shares: readonly ShareRecord[]) => {
    await fs.mkdir(path.dirname(statePath), { recursive: true, mode: 0o700 });
    const temporary = `${statePath}.${process.pid}.tmp`;
    await fs.writeFile(temporary, `${JSON.stringify({ version: 1, shares }, null, 2)}\n`, { mode: 0o600 });
    await fs.rename(temporary, statePath);
  };

  const setfacl = async (args: readonly string[], targets: readonly string[]) => {
    const failed: string[] = [];
    for (let index = 0; index < targets.length; index += BATCH) {
      const batch = targets.slice(index, index + BATCH);
      // `-P`: a symbolic link among the targets is skipped, never followed.
      const result = await run(SETFACL, ['-P', ...args, '--', ...batch]);
      if (result.code !== 0) failed.push(...batch);
    }
    return failed;
  };

  /** The project as the request names it, after every refusal that does not need the walk. */
  const requireProject = async (requested: string) => {
    const text = String(requested ?? '');
    if (!path.isAbsolute(text) || path.normalize(text) !== text || text.length > 4096 || text.endsWith('/')) {
      refuse('share_project_invalid_path', 'A project is named by its absolute, normalized path');
    }
    let real;
    try {
      real = await fs.realpath(text);
    } catch {
      refuse('share_project_missing', `${text} does not exist`);
    }
    // A link anywhere on the way would let the path name something else by the time the walk runs.
    if (real !== text) refuse('share_project_through_link', `${text} goes through a symbolic link to ${real}; name the project by its real path`);
    const stats = await fs.lstat(text);
    if (!stats.isDirectory()) refuse('share_project_not_directory', `${text} is not a folder`);
    if (stats.uid !== human.uid) refuse('share_project_not_owned', `${text} does not belong to ${human.name}`);
    if (text === '/' || isInside(human.home, text)) refuse('share_project_too_wide', `${text} holds ${human.name}'s home folder`);
    for (const entry of PRIVATE_HOME_ENTRIES) {
      if (isInside(text, path.join(human.home, entry))) refuse('share_project_private_folder', `${text} is inside ${path.join(human.home, entry)}, which holds what ${human.name}'s own account runs or signs in with`);
    }
    return { path: text, device: stats.dev, inode: stats.ino };
  };

  /**
   * A project that holds what the human's own account runs is refused: a shell startup file in a
   * dotfiles repository, linked from the home folder, would run whatever the agent writes there the
   * next time the human signs in.
   */
  const requireNoOwnerConfiguration = async (project: string) => {
    const found = [];
    for (const place of CONFIG_LINK_PLACES) {
      const directory = path.join(human.home, place);
      let entries: Dirent[] = [];
      try {
        entries = await fs.readdir(directory, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (!entry.isSymbolicLink()) continue;
        const link = path.join(directory, entry.name);
        const target = await fs.realpath(link).catch(() => null);
        if (target && isInside(target, project)) found.push({ link, target });
      }
    }
    if (found.length > 0) {
      refuse('share_project_holds_owner_configuration', `${project} holds files ${human.name}'s own account runs: ${found.slice(0, MAX_REPORTED).map(({ link, target }) => `${link} -> ${target}`).join(', ')}`, { links: found.slice(0, MAX_REPORTED) });
    }
  };

  /** The project's filesystem must be a local one, with no other filesystem mounted inside it. */
  const requireLocalWithoutMounts = async (project: string) => {
    const mounts = parseMountInfo(await readMountInfo());
    const containing = mounts.filter((mount) => isInside(project, mount.mountPoint)).sort((a, b) => b.mountPoint.length - a.mountPoint.length)[0];
    if (!containing || !LOCAL_FILESYSTEMS.has(containing.type)) refuse('share_project_filesystem', `${project} is on a ${containing?.type || 'unknown'} filesystem; only local filesystems are shared`);
    const nested = mounts.filter((mount) => mount.mountPoint !== project && isInside(mount.mountPoint, project)).map((mount) => mount.mountPoint);
    if (nested.length > 0) refuse('share_project_nested_mount', `${project} has other filesystems mounted inside it: ${nested.slice(0, MAX_REPORTED).join(', ')}`, { mounts: nested.slice(0, MAX_REPORTED) });
  };

  /**
   * Every folder and file of the project the ACL may go on, by a walk that never follows a link:
   * links are left out, and so are entries on another device and regular files with more than one
   * link, which also exist outside the project.
   */
  const walk = async (root: string) => {
    const directories = [root];
    const files: string[] = [];
    const skipped: SkippedEntries = { links: 0, otherDevice: [], hardLinked: [] };
    const rootDevice = (await fs.lstat(root)).dev;
    for (const directory of directories) {
      let entries;
      try {
        entries = await fs.readdir(directory, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        const full = path.join(directory, entry.name);
        if (entry.isSymbolicLink()) {
          skipped.links += 1;
          continue;
        }
        let stats;
        try {
          stats = await fs.lstat(full);
        } catch {
          continue;
        }
        if (stats.isSymbolicLink()) {
          skipped.links += 1;
          continue;
        }
        if (stats.dev !== rootDevice) {
          skipped.otherDevice.push(full);
          continue;
        }
        if (stats.isDirectory()) directories.push(full);
        else if (stats.isFile() && stats.nlink > 1) skipped.hardLinked.push(full);
        else if (stats.isFile()) files.push(full);
      }
    }
    return { directories, files, skipped };
  };

  /**
   * The folders between `/` and the project that the agent cannot cross today: no execute bit for
   * others. The answer also lists, for those inside the human's home, what the agent can read in
   * them by name once it can cross them.
   */
  const ancestorsOf = async (project: string) => {
    const ancestors = [];
    for (let current = path.dirname(project); ; current = path.dirname(current)) {
      const stats = await fs.stat(current);
      if ((stats.mode & 0o001) === 0) ancestors.push(current);
      if (current === '/') break;
    }
    const exposed = [];
    for (const ancestor of ancestors.filter((candidate) => isInside(candidate, human.home))) {
      const entries = await fs.readdir(ancestor, { withFileTypes: true }).catch(() => []);
      for (const entry of entries) {
        const full = path.join(ancestor, entry.name);
        if (isInside(project, full) || isInside(full, project)) continue;
        const stats = await fs.lstat(full).catch(() => null);
        if (!stats || stats.isSymbolicLink()) continue;
        const readable = stats.isDirectory() ? (stats.mode & 0o005) === 0o005 : (stats.mode & 0o004) !== 0;
        if (readable) exposed.push(full);
      }
    }
    return { ancestors, exposed: exposed.slice(0, MAX_REPORTED) };
  };

  const share = async (requested: string) => {
    const project = await requireProject(requested);
    await requireNoOwnerConfiguration(project.path);
    await requireLocalWithoutMounts(project.path);
    const { directories, files, skipped } = await walk(project.path);
    const { ancestors, exposed } = await ancestorsOf(project.path);
    const failed = [
      ...await setfacl(['-m', `u:${agent.name}:rwX,d:u:${agent.name}:rwX,d:u:${human.name}:rwX`], directories),
      ...await setfacl(['-m', `u:${agent.name}:rwX`], files),
      ...await setfacl(['-m', `u:${agent.name}:--x`], ancestors),
    ];
    const record: ShareRecord = {
      path: project.path,
      device: project.device,
      inode: project.inode,
      ancestors,
      status: failed.length === 0 ? 'shared' : 'partial',
      at: new Date().toISOString(),
    };
    const shares = (await readShares()).filter((entry) => entry.path !== project.path);
    await writeShares([...shares, record]);
    return {
      ...record,
      failed: failed.slice(0, MAX_REPORTED),
      skipped: { links: skipped.links, otherDevice: skipped.otherDevice.slice(0, MAX_REPORTED), hardLinked: skipped.hardLinked.slice(0, MAX_REPORTED) },
      exposed,
    };
  };

  /**
   * Who owns a project folder: `agent` for one of the agent's own, which needs no share, `human` for
   * one a share can open, else `other`. A path through a link, or that is not a folder, is `other`.
   */
  const ownerOf = async (requested: string) => {
    const text = String(requested ?? '');
    if (!path.isAbsolute(text) || path.normalize(text) !== text) return 'other';
    const real = await fs.realpath(text).catch(() => null);
    const stats = real === text ? await fs.lstat(text).catch(() => null) : null;
    if (!stats?.isDirectory()) return 'other';
    if (stats.uid === agent.uid) return 'agent';
    return stats.uid === human.uid ? 'human' : 'other';
  };

  /** Takes the agent's entries off the project, and off the folders above it no other share needs. */
  const unshare = async (requested: string) => {
    const shares = await readShares();
    const record = shares.find((entry) => entry.path === requested);
    if (!record) refuse('share_project_not_shared', `${requested} is not shared with ${agent.name}`);
    const stats = await fs.lstat(record.path).catch(() => null);
    const failed = [];
    // A folder that is not the one shared, by device and inode, is left alone.
    if (stats?.isDirectory() && stats.dev === record.device && stats.ino === record.inode) {
      const { directories, files } = await walk(record.path);
      failed.push(...await setfacl(['-x', `u:${agent.name},d:u:${agent.name}`], directories));
      failed.push(...await setfacl(['-x', `u:${agent.name}`], files));
    }
    const remaining = shares.filter((entry) => entry !== record);
    const stillNeeded = new Set(remaining.flatMap((entry) => entry.ancestors));
    failed.push(...await setfacl(['-x', `u:${agent.name}`], record.ancestors.filter((ancestor) => !stillNeeded.has(ancestor))));
    await writeShares(remaining);
    return { path: record.path, status: failed.length === 0 ? 'unshared' : 'partial', failed: failed.slice(0, MAX_REPORTED) };
  };

  return { share, unshare, ownerOf, list: readShares };
}
