import { createHash, randomBytes } from 'node:crypto';
import defaultFs from 'node:fs/promises';
import defaultPath from 'node:path';

import {
  GUEST_PLAN_CONTENT_MAX,
  GUEST_PLAN_DEPTH_MAX,
  GUEST_PLANS_MAX,
  isGuestPlanPathOf,
  requestedGuestCapabilities,
} from '@openchamber/sdk';

/**
 * Plan providers (`contributes.plans`). The server is the authority for which
 * plan files exist and for every read and write of them: the extension only
 * describes the files the host found. A plan is addressed by its provider and
 * its worktree-relative path; every check runs on canonical paths, so neither
 * `..` nor a symlink can reach a file outside the provider's root, and the root
 * itself has to stay inside the worktree.
 *
 * Writes are compare-and-replace on the SHA-256 of the bytes the editor
 * loaded. A per-file lock orders this server's own writes; a writer outside
 * OpenChamber that lands between the final comparison and the rename is not
 * detected, which is the same window every editor without OS-level locking has.
 */

const failure = (code, message, extra = {}) => ({ ok: false, code, message, ...extra });

export const hashPlanBytes = (bytes) => createHash('sha256').update(bytes).digest('hex');

const isInside = (candidate, root, nodePath) => (
  candidate === root || candidate.startsWith(root.endsWith(nodePath.sep) ? root : `${root}${nodePath.sep}`)
);

const toPosix = (value, nodePath) => (nodePath.sep === '/' ? value : value.split(nodePath.sep).join('/'));

/**
 * The guest may serve plans only while it is installed, enabled, fully
 * approved, holds the `plans` grant for its current declarations, and
 * declares `providerId`.
 */
export const authorizeGuestPlanProvider = (guest, providerId, { disabled }) => {
  if (disabled) {
    return failure('DISABLED', `${guest.name} is disabled in Settings → Extensions.`);
  }
  const grants = guest.capabilityGrants ?? [];
  if (!requestedGuestCapabilities(guest).every((capability) => grants.includes(capability)) || !grants.includes('plans')) {
    return failure('NOT_GRANTED', `${guest.name} has not been allowed to show plans. Review it in Settings → Extensions.`);
  }
  const provider = (guest.plans ?? []).find((entry) => entry.id === providerId);
  if (!provider) {
    return failure('NOT_FOUND', 'This extension declares no such plan provider.');
  }
  return { ok: true, provider };
};

const mapFsError = (error) => {
  const code = error?.code;
  if (code === 'ENOENT' || code === 'ENOTDIR') return failure('NOT_FOUND', 'No plan at that path.');
  if (code === 'EACCES' || code === 'EPERM') return failure('DENIED', 'The operating system refused access to that plan.');
  if (code === 'EISDIR') return failure('BAD_PATH', 'That path is a folder.');
  return null;
};

/** Canonical worktree and provider root. A root that does not exist yet is `missing`, not an error. */
const resolveRoot = async ({ provider, directory, fsPromises, nodePath }) => {
  let worktree;
  try {
    worktree = await fsPromises.realpath(directory);
  } catch {
    return failure('NO_DIRECTORY', 'The worktree is not available.');
  }
  let root;
  try {
    root = await fsPromises.realpath(nodePath.resolve(worktree, provider.root));
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return { ok: true, worktree, root: null };
    throw error;
  }
  if (!isInside(root, worktree, nodePath) || root === worktree) {
    return failure('BAD_PATH', 'The plan folder leaves the worktree.');
  }
  const stat = await fsPromises.stat(root);
  if (!stat.isDirectory()) return failure('BAD_PATH', 'The plan folder is not a folder.');
  return { ok: true, worktree, root };
};

/** Logical path → canonical file inside the canonical root, or a refusal. */
const resolvePlanFile = async ({ provider, directory, path, fsPromises, nodePath }) => {
  if (typeof path !== 'string' || !isGuestPlanPathOf(provider, path)) {
    return failure('BAD_PATH', 'That path is not a plan of this provider.');
  }
  const resolved = await resolveRoot({ provider, directory, fsPromises, nodePath });
  if (!resolved.ok) return resolved;
  if (!resolved.root) return failure('NOT_FOUND', 'No plan at that path.');
  const real = await fsPromises.realpath(nodePath.resolve(resolved.worktree, path));
  if (!isInside(real, resolved.root, nodePath) || real === resolved.root) {
    return failure('BAD_PATH', 'That plan leaves the plan folder.');
  }
  const stat = await fsPromises.lstat(real);
  if (!stat.isFile()) return failure('BAD_PATH', 'That plan is not a regular file.');
  return { ok: true, real, stat };
};

const withFsErrors = async (run) => {
  try {
    return await run();
  } catch (error) {
    const mapped = mapFsError(error);
    if (mapped) return mapped;
    throw error;
  }
};

/**
 * Every file under the provider's root (at most `GUEST_PLAN_DEPTH_MAX`
 * folders deep) whose worktree-relative path is a plan of the provider,
 * sorted by path, at most `GUEST_PLANS_MAX`. Symlinked folders are not
 * followed; a symlinked file counts only when it resolves inside the root.
 */
export const listGuestPlans = ({ provider, directory, fsPromises = defaultFs, nodePath = defaultPath }) => withFsErrors(async () => {
  const resolved = await resolveRoot({ provider, directory, fsPromises, nodePath });
  if (!resolved.ok) return resolved;
  if (!resolved.root) return { ok: true, result: { plans: [], truncated: false } };
  const plans = [];
  let truncated = false;
  const queue = [{ absolute: resolved.root, logical: provider.root, depth: 0 }];
  while (queue.length > 0) {
    const current = queue.shift();
    let entries;
    try {
      entries = await fsPromises.readdir(current.absolute, { withFileTypes: true });
    } catch (error) {
      // A folder removed while walking is simply gone; anything else is a failure.
      if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') continue;
      throw error;
    }
    entries.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
    for (const entry of entries) {
      const absolute = nodePath.join(current.absolute, entry.name);
      const logical = `${current.logical}/${entry.name}`;
      if (entry.isDirectory()) {
        if (current.depth < GUEST_PLAN_DEPTH_MAX) queue.push({ absolute, logical, depth: current.depth + 1 });
        continue;
      }
      if (!isGuestPlanPathOf(provider, logical)) continue;
      let stat;
      try {
        const real = entry.isSymbolicLink() ? await fsPromises.realpath(absolute) : absolute;
        if (!isInside(real, resolved.root, nodePath)) continue;
        stat = await fsPromises.stat(real);
      } catch (error) {
        if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') continue;
        throw error;
      }
      if (!stat.isFile()) continue;
      if (plans.length >= GUEST_PLANS_MAX) {
        truncated = true;
        break;
      }
      plans.push({ path: toPosix(logical, nodePath), size: stat.size, mtime: Math.floor(stat.mtimeMs) });
    }
    if (truncated) break;
  }
  plans.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
  return { ok: true, result: { plans, truncated } };
});

const decodeUtf8 = (bytes) => {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
};

const readBytes = async (resolved, fsPromises) => {
  if (resolved.stat.size > GUEST_PLAN_CONTENT_MAX * 4) {
    return failure('FILE_TOO_LARGE', `Plan is over ${GUEST_PLAN_CONTENT_MAX} characters.`);
  }
  const bytes = await fsPromises.readFile(resolved.real);
  const content = decodeUtf8(bytes);
  if (content === null) return failure('HOST_REJECTED', 'The plan is not UTF-8 text.');
  if (content.length > GUEST_PLAN_CONTENT_MAX) {
    return failure('FILE_TOO_LARGE', `Plan is over ${GUEST_PLAN_CONTENT_MAX} characters.`);
  }
  return { ok: true, bytes, content };
};

/** The plan's text and the SHA-256 of its bytes. */
export const readGuestPlan = ({ provider, directory, path, fsPromises = defaultFs, nodePath = defaultPath }) => withFsErrors(async () => {
  const resolved = await resolvePlanFile({ provider, directory, path, fsPromises, nodePath });
  if (!resolved.ok) return resolved;
  const read = await readBytes(resolved, fsPromises);
  if (!read.ok) return read;
  return { ok: true, result: { content: read.content, hash: hashPlanBytes(read.bytes), mtime: Math.floor(resolved.stat.mtimeMs) } };
});

const fileLocks = new Map();

const withFileLock = async (key, run) => {
  const previous = fileLocks.get(key) ?? Promise.resolve();
  let release;
  const current = new Promise((resolve) => { release = resolve; });
  const chained = previous.then(() => current);
  fileLocks.set(key, chained);
  await previous;
  try {
    return await run();
  } finally {
    release();
    if (fileLocks.get(key) === chained) fileLocks.delete(key);
  }
};

/**
 * Replace the plan's text when its bytes still hash to `expectedHash`, else
 * `CONFLICT` with the current hash. Never creates a plan: a missing file is
 * `NOT_FOUND`. The new text lands through an exclusive temporary file in the
 * same folder and a rename onto the canonical file, keeping its mode, so a
 * symlinked plan stays a symlink and a reader never sees half a file.
 */
export const writeGuestPlan = ({
  provider,
  directory,
  path,
  content,
  expectedHash,
  fsPromises = defaultFs,
  nodePath = defaultPath,
}) => withFsErrors(async () => {
  if (typeof content !== 'string' || content.length > GUEST_PLAN_CONTENT_MAX) {
    return failure('FILE_TOO_LARGE', `Plan is over ${GUEST_PLAN_CONTENT_MAX} characters.`);
  }
  if (typeof expectedHash !== 'string' || !/^[0-9a-f]{64}$/.test(expectedHash)) {
    return failure('HOST_REJECTED', 'A plan write needs the hash of the text it replaces.');
  }
  const first = await resolvePlanFile({ provider, directory, path, fsPromises, nodePath });
  if (!first.ok) return first;
  return withFileLock(first.real, async () => {
    // Resolved again under the lock: a rename or relink since the first
    // check must not redirect the write.
    const resolved = await resolvePlanFile({ provider, directory, path, fsPromises, nodePath });
    if (!resolved.ok) return resolved;
    if (resolved.real !== first.real) return failure('CONFLICT', 'The plan moved while it was being saved.', { hash: null });
    const current = await fsPromises.readFile(resolved.real);
    const currentHash = hashPlanBytes(current);
    if (currentHash !== expectedHash) {
      return failure('CONFLICT', 'The plan changed since it was opened.', { hash: currentHash });
    }
    const bytes = Buffer.from(content, 'utf8');
    const tmp = nodePath.join(
      nodePath.dirname(resolved.real),
      `.${nodePath.basename(resolved.real)}.openchamber-${process.pid}-${randomBytes(6).toString('hex')}.tmp`,
    );
    try {
      await fsPromises.writeFile(tmp, bytes, { flag: 'wx', mode: 0o600 });
      // The creation mode passes through the umask; set the plan's own mode explicitly.
      await fsPromises.chmod(tmp, resolved.stat.mode & 0o777);
      await fsPromises.rename(tmp, resolved.real);
    } catch (error) {
      await fsPromises.unlink(tmp).catch(() => {});
      throw error;
    }
    const stat = await fsPromises.stat(resolved.real);
    return { ok: true, result: { hash: hashPlanBytes(bytes), mtime: Math.floor(stat.mtimeMs) } };
  });
});

/**
 * Whether `directory` (already validated and canonical) is a registered
 * project or one of its Git worktrees. A guest frame and a plan request name
 * only directories the user has registered, never an arbitrary folder.
 */
export const createPlanDirectoryAuthorizer = ({ listProjectPaths, listWorktreePaths, fsPromises = defaultFs }) => {
  const canonical = async (value) => {
    try {
      return await fsPromises.realpath(value);
    } catch {
      return null;
    }
  };
  return async (directory) => {
    const target = await canonical(directory);
    if (!target) return false;
    const projects = new Set((await Promise.all((await listProjectPaths()).map(canonical))).filter(Boolean));
    if (projects.has(target)) return true;
    const worktrees = await listWorktreePaths(target);
    const canonicalWorktrees = (await Promise.all(worktrees.map(canonical))).filter(Boolean);
    return canonicalWorktrees.includes(target) && canonicalWorktrees.some((worktree) => projects.has(worktree));
  };
};
