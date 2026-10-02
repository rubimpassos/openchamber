/**
 * This build is a fork. Its releases live in its own repository, it is absent
 * from npm, and `api.openchamber.dev` only knows official versions, so leaving
 * the update source unset would offer an upstream build to someone running this
 * one — and `openchamber update` would install it.
 *
 * Every entry point declares the source before anything reads it: the CLI, the
 * server, and Electron, which sets the same value before starting the
 * in-process server. An already-set value always wins, so Electron and an
 * operator override both survive.
 *
 * No release tag: this fork publishes versioned releases, so the check reads
 * whichever is latest and compares semver.
 */
const FORK_RELEASE_REPO = 'rubimpassos/openchamber';

export function applyForkReleaseSource(environment = process.env) {
  if ((environment.OPENCHAMBER_UPDATE_REPO || '').trim()) return;
  environment.OPENCHAMBER_UPDATE_REPO = FORK_RELEASE_REPO;
}

/**
 * The 1.x line of this fork is frozen. `main` moved to 2.x (OpenCode 2), and its
 * releases are published to the same repository, so "latest" there is a 2.x
 * build that cannot run against OpenCode 1.x. A 1.x install must never offer or
 * install it: every update check on this branch reports "no update".
 */
export const FORK_UPDATES_FROZEN = true;
