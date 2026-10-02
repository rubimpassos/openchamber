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
