import { describe, expect, test } from 'bun:test';
import type { Project, SourceControlReadContext } from '@/lib/api/types';
import { loadDetectedUpstreamRepo } from './detectedUpstreamRepo';

const context: SourceControlReadContext = {
  provider: 'github',
  instance: 'github.com',
  accountId: 'account',
  repositoryId: 'repo',
  bindingRevision: 1,
  directory: '/repo',
  primaryRemote: 'origin',
};

const upstream: Project = {
  provider: 'github',
  instance: 'github.com',
  id: 'upstream/repo',
  owner: 'upstream',
  name: 'repo',
  url: 'https://github.com/upstream/repo',
};

describe('detected upstream loading', () => {
  test('returns authoritative empty state when the project is not a fork', async () => {
    const result = await loadDetectedUpstreamRepo({
      projectUpstream: async () => ({ identity: context, isFork: false, upstream: null, viewerCanPush: true }),
    }, context);

    expect(result).toEqual({ upstream: null, viewerCanPush: true });
  });

  test('carries the fork parent and push access without reading branches', async () => {
    const result = await loadDetectedUpstreamRepo({
      projectUpstream: async () => ({ identity: context, isFork: true, upstream, viewerCanPush: false }),
    }, context);

    expect(result).toEqual({ upstream, viewerCanPush: false });
  });

  test('does not turn a failed upstream read into a non-fork answer', async () => {
    await expect(loadDetectedUpstreamRepo({
      projectUpstream: async () => { throw new Error('offline'); },
    }, context)).rejects.toThrow('offline');
  });
});
