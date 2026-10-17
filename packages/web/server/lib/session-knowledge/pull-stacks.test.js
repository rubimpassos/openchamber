import { describe, expect, test } from 'bun:test';
import { createFollowedPullStackContext } from './pull-stacks.js';

const DIRECTORY = '/work/project';
const anchor = { owner: 'acme', repo: 'app', number: 1 };
const link = (overrides = {}) => ({ kind: 'pull', followStack: true, number: 1, url: 'https://github.com/acme/app/pull/1', ...overrides });
const session = (links) => ({ metadata: { openchamber: { linked_issues: links } } });
const binding = () => ({
  revision: 3,
  repository: { repositoryId: 'repo_1', remotes: [{ name: 'upstream', fetch: { fingerprint: 'fp' } }] },
  binding: { providers: [{ provider: 'github', instance: 'github.com', accountId: 'bound-account', primaryRemote: 'upstream', readiness: 'ready', endpoint: { fingerprint: 'fp' } }] },
});

describe('followed pull stack collection', () => {
  test('reads only with the current repository binding when an anchor is followed', async () => {
    // Given a repository bound to a specific account and remote.
    const calls = [];
    const collect = createFollowedPullStackContext({
      readBinding: async (directory) => { calls.push(directory); return binding(); },
      readPullStack: async (input) => { calls.push(input); return null; },
    });

    // When the session resolves its anchor.
    const result = await collect(DIRECTORY, session([link()]));

    // Then the reader receives the exact repository authority and a successful null remains distinct.
    expect(calls).toEqual([DIRECTORY, {
      context: { directory: DIRECTORY, repositoryId: 'repo_1', bindingRevision: 3, accountId: 'bound-account', primaryRemote: 'upstream', provider: 'github', instance: 'github.com' },
      ...anchor,
    }]);
    expect(result).toEqual([{ anchor, status: 'available', stack: null }]);
  });

  test.each([
    ['unlinked', []],
    ['unfollowed', [link({ followStack: undefined })]],
    ['issue', [link({ kind: 'issue' })]],
    ['other provider', [link({ url: 'https://gitlab.com/acme/app/pull/1' })]],
    ['mismatched number', [link({ number: 2 })]],
  ])('performs no binding or provider reads when the link is %s', async (_name, links) => {
    // Given a session with no valid followed GitHub PR.
    let reads = 0;
    const collect = createFollowedPullStackContext({
      readBinding: async () => { reads += 1; return binding(); },
      readPullStack: async () => { reads += 1; return null; },
    });

    // When a turn resolves its context.
    const result = await collect(DIRECTORY, session(links));

    // Then it owes nothing and makes no reads.
    expect(result).toEqual([]);
    expect(reads).toBe(0);
  });

  test.each(['account-unavailable', 'confirmation-required', 'config-changed'])('keeps failure explicit when the provider is %s', async (readiness) => {
    // Given a binding that grants no ready provider authority.
    const read = binding();
    read.binding.providers[0].readiness = readiness;
    let reads = 0;
    const collect = createFollowedPullStackContext({
      readBinding: async () => read,
      readPullStack: async () => { reads += 1; return null; },
    });

    // When its followed anchor is resolved.
    const result = await collect(DIRECTORY, session([link()]));

    // Then no account fallback or provider request occurs.
    expect(result).toEqual([{ anchor, status: 'unavailable', reason: 'binding-unavailable' }]);
    expect(reads).toBe(0);
  });

  test('reports unavailable context when the binding store fails', async () => {
    // Given a binding store that cannot be read.
    const collect = createFollowedPullStackContext({
      readBinding: async () => { throw new Error('private path'); },
      readPullStack: async () => { throw new Error('must not be reached'); },
    });

    // When its followed anchor is resolved.
    const result = await collect(DIRECTORY, session([link()]));

    // Then no successful empty snapshot or private error enters context.
    expect(result).toEqual([{ anchor, status: 'unavailable', reason: 'binding-unavailable' }]);
  });

  test('deduplicates the same anchor when metadata contains equivalent links', async () => {
    // Given equivalent canonical and mixed-case GitHub links.
    let reads = 0;
    const collect = createFollowedPullStackContext({
      readBinding: async () => binding(),
      readPullStack: async () => { reads += 1; return null; },
    });

    // When they are resolved together.
    const result = await collect(DIRECTORY, session([link(), link({ url: 'https://github.com/Acme/App/pull/1#discussion' })]));

    // Then one current snapshot is read and returned.
    expect(result).toHaveLength(1);
    expect(reads).toBe(1);
  });

  test.each(['unbound', 'account-unavailable'])('follows the current account for an %s repository like the reference picker', async (state) => {
    const read = binding();
    read.repository.remotes[0].fetch.displayUrl = 'https://github.com/acme/app.git';
    if (state === 'unbound') read.binding = null;
    else read.binding.providers[0].readiness = state;
    const calls = [];
    const collect = createFollowedPullStackContext({
      readBinding: async () => read,
      readCurrentAccountId: async () => 'current-account',
      readPullStack: async (input) => { calls.push(input); return null; },
    });

    expect(await collect(DIRECTORY, session([link()]))).toEqual([{ anchor, status: 'available', stack: null }]);
    expect(calls[0].context).toMatchObject({ accountId: 'current-account', primaryRemote: 'upstream', bindingRevision: 3 });
  });

  test.each(['confirmation-required', 'config-changed'])('never replaces %s authority with the current account', async (readiness) => {
    const read = binding();
    read.binding.providers[0].readiness = readiness;
    read.repository.remotes[0].fetch.displayUrl = 'https://github.com/acme/app.git';
    let accountReads = 0;
    const collect = createFollowedPullStackContext({
      readBinding: async () => read,
      readCurrentAccountId: async () => { accountReads += 1; return 'current'; },
      readPullStack: async () => { throw new Error('must not be reached'); },
    });

    expect(await collect(DIRECTORY, session([link()]))).toEqual([{ anchor, status: 'unavailable', reason: 'binding-unavailable' }]);
    expect(accountReads).toBe(0);
  });
});
