import { expect, it, vi } from 'vitest';
import { createProjectOpenIssuesReader } from './open-issues.js';

const directory = '/projects/app';
const provider = (name = 'github') => ({
  provider: name, instance: name === 'github' ? 'github.com' : 'https://gitlab.example',
  accountId: `${name}-bound-account`, primaryRemote: 'upstream', readiness: 'ready',
});
const setup = (providers = [provider()]) => {
  const bindingService = {
    get: vi.fn(async () => ({ repository: { repositoryId: 'repository-id' }, revision: 7, binding: providers === null ? null : { providers } })),
    validateReadContext: vi.fn(async (context) => context),
    accountUnavailable: vi.fn(),
  };
  const octokit = {};
  const github = {
    getOctokitForAccountId: vi.fn(async () => ({ octokit })),
    resolveGitHubRepoFromDirectory: vi.fn(async () => ({ repo: { owner: 'owner', repo: 'project' } })),
    searchGitHubReferences: vi.fn(async () => ({ items: [{ title: 'Existing issue' }], hasMore: false, cursor: null })),
  };
  const linear = {
    getLinearAuth: vi.fn(() => null),
    readStoredLinearMapping: vi.fn(() => ({ defaultProjectPath: null, teamProjectPaths: {} })),
    listLinearIssues: vi.fn(async () => ({ connected: true, issues: [], hasMore: false, cursor: null })),
  };
  const gitlabService = { listIssues: vi.fn(async () => ({ items: [{ title: 'GitLab issue' }], hasMore: false })) };
  const gitlab = {
    createGitLabClient: vi.fn(() => ({})),
    createGitLabResourceService: vi.fn(() => gitlabService),
  };
  const readSourceControlAccount = vi.fn(async () => ({ token: 'test-only-token', source: 'pat' }));
  const read = createProjectOpenIssuesReader({
    getBindingService: () => bindingService, readSourceControlAccount,
    loadGitHubLibraries: async () => github,
    loadGitLabLibraries: async () => gitlab,
    loadLinearLibraries: async () => linear,
  });
  return { read, bindingService, github, linear, gitlab, gitlabService, readSourceControlAccount, octokit };
};

it('returns a legitimate empty result without selecting ambient provider accounts when no binding exists', async () => {
  const { read, github, readSourceControlAccount, linear } = setup(null);
  expect(await read(directory)).toEqual({ titles: [], warnings: [] });
  expect(github.getOctokitForAccountId).not.toHaveBeenCalled();
  expect(readSourceControlAccount).not.toHaveBeenCalled();
  expect(linear.listLinearIssues).not.toHaveBeenCalled();
});

it('reads GitHub issues with the authoritative repository, revision, account and primary remote', async () => {
  const { read, bindingService, github, octokit } = setup();
  expect(await read(directory)).toEqual({ titles: ['Existing issue'], warnings: [] });
  expect(bindingService.validateReadContext).toHaveBeenCalledWith({
    directory, repositoryId: 'repository-id', bindingRevision: 7,
    provider: 'github', instance: 'github.com', accountId: 'github-bound-account', primaryRemote: 'upstream',
  });
  expect(github.getOctokitForAccountId).toHaveBeenCalledWith('github-bound-account', expect.anything());
  expect(github.resolveGitHubRepoFromDirectory).toHaveBeenCalledWith(directory, 'upstream');
  expect(github.searchGitHubReferences).toHaveBeenCalledWith({
    octokit, repos: [{ owner: 'owner', repo: 'project', source: 'origin' }],
    kind: 'issue', state: 'open', people: 'any', text: '', cursor: null,
  });
});

it('uses the existing GitLab credential resolver, client and canonical resource service', async () => {
  const { read, gitlab, gitlabService, readSourceControlAccount } = setup([provider('gitlab')]);
  expect(await read(directory)).toEqual({ titles: ['GitLab issue'], warnings: [] });
  expect(readSourceControlAccount).toHaveBeenCalledWith(expect.objectContaining({
    provider: 'gitlab', instance: 'https://gitlab.example', accountId: 'gitlab-bound-account',
  }));
  expect(gitlab.createGitLabClient).toHaveBeenCalledWith({ origin: 'https://gitlab.example', token: 'test-only-token', tokenType: 'token' });
  expect(gitlab.createGitLabResourceService).toHaveBeenCalledWith({ origin: 'https://gitlab.example', client: {}, canonicalReads: true });
  expect(gitlabService.listIssues).toHaveBeenCalledWith(directory, { remote: 'upstream', state: 'open', people: 'any', page: 1 });
});

it('never resolves credentials for a non-ready or stale binding', async () => {
  const needsAttention = setup([{ ...provider(), readiness: 'account-unavailable' }]);
  expect((await needsAttention.read(directory)).warnings).toEqual([expect.objectContaining({ provider: 'github', kind: 'unavailable' })]);
  expect(needsAttention.github.getOctokitForAccountId).not.toHaveBeenCalled();
  const stale = setup();
  stale.bindingService.validateReadContext.mockRejectedValue(new Error('stale'));
  expect((await stale.read(directory)).warnings[0].kind).toBe('unavailable');
  expect(stale.github.getOctokitForAccountId).not.toHaveBeenCalled();
});

it('reports binding and exact-account failures without exposing provider errors or falling back', async () => {
  const broken = setup();
  broken.bindingService.get.mockRejectedValue(new Error('sensitive provider detail'));
  expect(await broken.read(directory)).toEqual({ titles: [], warnings: [expect.objectContaining({ provider: 'source-control', kind: 'unavailable' })] });
  const missing = setup([provider('gitlab')]);
  missing.readSourceControlAccount.mockResolvedValue(null);
  const result = await missing.read(directory);
  expect(result.titles).toEqual([]);
  expect(result.warnings[0]).toMatchObject({ provider: 'gitlab', kind: 'unavailable' });
  expect(missing.gitlab.createGitLabClient).not.toHaveBeenCalled();
  expect(JSON.stringify(result)).not.toContain('sensitive');
});

it('retains complete sibling results when a provider fails', async () => {
  const { read, github } = setup([provider(), provider('gitlab')]);
  github.searchGitHubReferences.mockRejectedValue(new Error('offline'));
  expect(await read(directory)).toEqual({ titles: ['GitLab issue'], warnings: [expect.objectContaining({ provider: 'github', kind: 'unavailable' })] });
});

it('paginates and deduplicates titles, preserving earlier pages when a later read fails', async () => {
  const { read, github, bindingService } = setup();
  github.searchGitHubReferences
    .mockResolvedValueOnce({ items: [{ title: 'Existing issue' }], hasMore: true, cursor: 'next' })
    .mockResolvedValueOnce({ items: [{ title: 'Existing issue' }, { title: 'Second issue' }], hasMore: true, cursor: 'last' })
    .mockRejectedValueOnce(new Error('offline'));
  expect(await read(directory)).toEqual({ titles: ['Existing issue', 'Second issue'], warnings: [expect.objectContaining({ kind: 'partial' })] });
  expect(github.searchGitHubReferences.mock.calls.map(([input]) => input.cursor)).toEqual([null, 'next', 'last']);
  expect(bindingService.validateReadContext).toHaveBeenCalledTimes(3);
});

it('bounds GitHub and GitLab pagination and explicitly reports truncation', async () => {
  const { read, github, gitlabService } = setup([provider(), provider('gitlab')]);
  github.searchGitHubReferences.mockImplementation(async () => ({ items: [{ title: 'Existing issue' }], hasMore: true, cursor: `page-${github.searchGitHubReferences.mock.calls.length}` }));
  gitlabService.listIssues.mockResolvedValue({ items: [], hasMore: true });
  const result = await read(directory);
  expect(github.searchGitHubReferences).toHaveBeenCalledTimes(10);
  expect(gitlabService.listIssues.mock.calls.map(([, options]) => options.page)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  expect(result.warnings).toHaveLength(2);
  expect(result.warnings.every((warning) => warning.kind === 'partial' && warning.message.includes('truncated'))).toBe(true);
});

it('includes only mapped open Linear issues and honors team overrides over the default project', async () => {
  const { read, linear } = setup(null);
  linear.getLinearAuth.mockReturnValue({ workspaceId: 'workspace-a' });
  linear.readStoredLinearMapping.mockReturnValue({ defaultProjectPath: directory, teamProjectPaths: { other: '/projects/other' } });
  linear.listLinearIssues.mockResolvedValue({ connected: true, hasMore: false, issues: [
    { title: 'Default issue', team: { id: 'default' }, state: { type: 'started' } },
    { title: 'Other project', team: { id: 'other' }, state: { type: 'started' } },
    ...['completed', 'canceled', 'cancelled', 'duplicate'].map((type) => ({ title: type, state: { type } })),
  ] });
  expect(await read(directory)).toEqual({ titles: ['Default issue'], warnings: [] });
  expect(linear.listLinearIssues).toHaveBeenCalledWith({ status: 'open', assignee: 'any', cursor: null });
});

it('uses explicit team mappings without a default and does not query an unmapped workspace', async () => {
  const { read, linear } = setup(null);
  linear.getLinearAuth.mockReturnValue({ workspaceId: 'workspace-a' });
  expect(await read(directory)).toEqual({ titles: [], warnings: [] });
  expect(linear.listLinearIssues).not.toHaveBeenCalled();
  linear.readStoredLinearMapping.mockReturnValue({ defaultProjectPath: null, teamProjectPaths: { selected: directory } });
  linear.listLinearIssues.mockResolvedValue({ connected: true, hasMore: false, issues: [
    { title: 'Mapped issue', team: { id: 'selected' }, state: { type: 'unstarted' } },
    { title: 'Unmapped issue', team: { id: 'other' }, state: { type: 'started' } },
  ] });
  expect(await read(directory)).toEqual({ titles: ['Mapped issue'], warnings: [] });
});

it('reports disconnected mapped Linear and mapping failures explicitly', async () => {
  const { read, linear } = setup(null);
  linear.getLinearAuth.mockReturnValue({ workspaceId: 'workspace-a' });
  linear.readStoredLinearMapping.mockReturnValue({ defaultProjectPath: directory, teamProjectPaths: {} });
  linear.listLinearIssues.mockResolvedValue({ connected: false });
  expect((await read(directory)).warnings).toEqual([expect.objectContaining({ provider: 'linear', kind: 'unavailable' })]);
  linear.readStoredLinearMapping.mockImplementation(() => { throw new Error('malformed mapping'); });
  expect((await read(directory)).warnings[0].kind).toBe('unavailable');
});

it('discards a Linear page if the current workspace changes during its read', async () => {
  const { read, linear } = setup(null);
  let workspaceId = 'workspace-a';
  linear.getLinearAuth.mockImplementation(() => ({ workspaceId }));
  linear.readStoredLinearMapping.mockReturnValue({ defaultProjectPath: directory, teamProjectPaths: {} });
  linear.listLinearIssues.mockImplementation(async () => {
    workspaceId = 'workspace-b';
    return { connected: true, issues: [{ title: 'Wrong workspace' }], hasMore: false };
  });
  expect(await read(directory)).toEqual({ titles: [], warnings: [expect.objectContaining({ provider: 'linear', kind: 'unavailable' })] });
});

it('bounds Linear pagination and rejects missing or repeated continuation cursors', async () => {
  const { read, linear } = setup(null);
  linear.getLinearAuth.mockReturnValue({ workspaceId: 'workspace-a' });
  linear.readStoredLinearMapping.mockReturnValue({ defaultProjectPath: directory, teamProjectPaths: {} });
  linear.listLinearIssues.mockImplementation(async () => ({ connected: true, issues: [{ title: 'Linear issue' }], hasMore: true, cursor: `page-${linear.listLinearIssues.mock.calls.length}` }));
  const result = await read(directory);
  expect(linear.listLinearIssues).toHaveBeenCalledTimes(10);
  expect(result).toEqual({ titles: ['Linear issue'], warnings: [expect.objectContaining({ provider: 'linear', kind: 'partial', message: expect.stringContaining('truncated') })] });
  linear.listLinearIssues.mockResolvedValue({ connected: true, issues: [], hasMore: true, cursor: null });
  expect((await read(directory)).warnings[0].kind).toBe('partial');
});
