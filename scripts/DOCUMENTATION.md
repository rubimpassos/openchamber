# Changed-files gate

## Ownership

`check-changed.mjs` runs the pre-commit checks and compares lint findings and file sizes with the branch base. Package scripts own the individual checks.

## Invariants

- Dead-code analysis sees tracked files in their current state and untracked files that Git does not ignore. Deleted files stay absent.
- Knip's gitignore rules must not match ancestors outside the checkout.
- The analysis snapshot retains root and workspace dependencies through links. Cleanup removes only the snapshot, including after a failed check.
- Each `--base` is verified as a commit and resolved once before comparison. With no explicit base, the existing `merge-base HEAD origin/main` selection applies. The selected commit IDs are printed in full.
- Comparisons include staged and unstaged source changes, deleted predecessors and untracked sources. The ratchet still compares totals per rule across the change, so extracting or moving code can retire debt elsewhere in the same change.
- Size checks count physical lines. A predecessor is the same path or a Git-proven move; a same-named retained copy supplies no allowance. Existing catalog, declaration, generated and test exclusions remain. The server/bin JavaScript-to-TypeScript allowance requires a proven predecessor over 800 lines and the same basename, even if its folder moved.

## Decisions

### Why integration comparisons merge file budgets before rule totals

The accepted-history policy is in `openchamber-change-discipline`. Each history's old paths are normalized to current paths through its rename map before taking the maximum count for each file/rule pair. Summing history totals would count the same inherited debt twice. Deleted paths also contribute once per file/rule, preserving the ordinary relocation budget.

### Why rename detection has an explicit exhaustive budget

Git's default rename limit can skip similarity matching on large integrations and classify converted implementations as new files. The comparison uses one full-tree `--break-rewrites --find-copies -l10000` pass per history, without basename guesses or repeated path-restricted searches. A copy inherits lineage only when its source is a scored rewrite and has exactly one copy destination, which covers a body moved behind a small entry without granting retained or multiply copied implementations the same size allowance.

### Why Knip runs in a temporary source snapshot

Knip 5.80.0 passes absolute package entry patterns to fast-glob with relative gitignore patterns. The repository's `*.local` rule then matches the `.local` ancestor of OpenCode worktrees and loses package source mappings. A root symlink also produces incorrect results because resolvers canonicalize paths back into the original checkout.

Checkouts without a dot-prefixed path segment run Knip in place. For hidden paths, the gate copies only the files listed by `git ls-files --cached --others --exclude-standard` into a system temporary directory and links root and package `node_modules` directories. Git metadata and ignored outputs, including `tmp`, `dist`, browser profiles and `packages/web/build`, stay out of the snapshot. The clean-tree and unused-export reports match an ordinary worktree without those outputs.

Runtime sockets and other special filesystem entries are skipped because Knip analyzes files and they cannot be copied. Copy-on-write is requested where available, but the snapshot also stays source-sized on filesystems without it. No ignore rules or findings change, and the original checkout stays in place. POSIX uses `/tmp` so a hidden `TMPDIR` cannot reintroduce the failure.
