// A branch's own commits against a remote trunk, nearest first: what the
// create form's stack detection compares open PR heads with. Git only.

import { z } from 'zod';

const branchNameSchema = z.string().regex(/^(?!-)(?!.*\.\.)[A-Za-z0-9._/-]{1,255}$/);

export const isSafeBranchName = (value) => branchNameSchema.safeParse(value).success;

/**
 * `{ commits, capped }`, or null when the branch or `refs/remotes/<remote>/<trunk>`
 * does not exist locally. A failed rev-list throws.
 */
export async function listOwnCommits(runGit, directory, { branch, remote, trunk, limit }) {
  if (![branch, remote, trunk].every(isSafeBranchName)) return null;
  const head = `refs/heads/${branch}`;
  const trunkRef = `refs/remotes/${remote}/${trunk}`;
  for (const ref of [head, trunkRef]) {
    const verified = await runGit(directory, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
    if (!verified.success) return null;
  }
  const result = await runGit(directory, ['rev-list', '--topo-order', `--max-count=${limit + 1}`, head, '--not', trunkRef]);
  if (!result.success) throw new Error(result.message || 'git rev-list failed');
  const commits = result.stdout.split('\n').map((line) => line.trim()).filter(Boolean);
  return { commits: commits.slice(0, limit), capped: commits.length > limit };
}

/** The reflog's creation source as a branch name of `remote`, or null. */
export const normalizeCreatedFrom = (source, remote) => {
  const parsed = z.string().trim().min(1).safeParse(source);
  if (!parsed.success) return null;
  let name = parsed.data.replace(/^refs\/heads\//, '').replace(/^refs\/remotes\//, '');
  if (name.startsWith(`${remote}/`)) name = name.slice(remote.length + 1);
  return name || null;
};
