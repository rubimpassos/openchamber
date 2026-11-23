import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LINTABLE_FILE = /\.(ts|tsx|js|jsx|mjs|cjs)$/;
const git = (args, root) => execFileSync('git', args, {
  cwd: root, env: { ...process.env, GIT_MASTER: '1' }, encoding: 'utf8',
  maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'],
});

export const readBases = (argv, root = REPO_ROOT) => {
  const refs = [];
  for (let index = 0; index < argv.length; index++) {
    if (argv[index] !== '--base') continue;
    const ref = argv[++index];
    if (!ref || ref.startsWith('-')) throw new Error('--base requires a commit reference');
    refs.push(ref);
  }
  if (refs.length === 0) refs.push(git(['merge-base', 'HEAD', 'origin/main'], root).trim());
  return [...new Set(refs.map((ref) => git(['rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`], root).trim()))];
};

/** Old path of every move, including a body moved behind a rewritten entry. */
export const parseRenames = (nameStatus) => {
  const renames = new Map();
  const entries = nameStatus.split(/\r?\n/).map((line) => line.split('\t'));
  const rewritten = new Set(entries.filter(([status]) => /^M\d+$/.test(status)).map(([, file]) => file));
  const copies = new Map();
  for (const [status, from] of entries) {
    if (status?.startsWith('C')) copies.set(from, (copies.get(from) ?? 0) + 1);
  }
  for (const [status, from, to] of entries) {
    if (from && to && (status?.startsWith('R') || (status?.startsWith('C') && rewritten.has(from) && copies.get(from) === 1))) {
      renames.set(to, from);
    }
  }
  return renames;
};

export const compareHistory = (base, root = REPO_ROOT) => {
  const changes = git(['diff', '--break-rewrites', '--find-copies', '-l10000', '--name-status', base], root);
  const entries = changes.split(/\r?\n/).map((line) => line.split('\t'));
  return {
    base,
    renames: parseRenames(changes),
    files: entries.filter(([status]) => /^[AMRC]/.test(status)).map((entry) => entry.at(-1)).filter((file) => LINTABLE_FILE.test(file)),
    deleted: entries.filter(([status]) => status === 'D').map(([, file]) => file).filter((file) => LINTABLE_FILE.test(file)),
  };
};

export const listChangedFiles = (histories, root = REPO_ROOT) => {
  const untracked = git(['ls-files', '--others', '--exclude-standard'], root).split(/\r?\n/);
  return [...new Set([...histories.flatMap(({ files }) => files), ...untracked])].filter((file) => LINTABLE_FILE.test(file));
};

export const readAtBase = (base, file, root = REPO_ROOT) => {
  try {
    return git(['show', `${base}:${file}`], root);
  } catch (error) {
    if (error.status === 128 && /does not exist in|exists on disk, but not in/.test(String(error.stderr))) return null;
    throw error;
  }
};
