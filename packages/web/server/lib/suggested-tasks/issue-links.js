// "Create issue" opens the tracker's own new-issue page with the title and
// body filled in; the user files it under their own account. OpenChamber
// writes nothing to the tracker, so no provider mutation, credential or
// audit record is involved.

// Browsers and trackers cut long URLs; a body this size stays well inside them.
const MAX_BODY_IN_URL = 6_000;

const repositoryOf = (remoteUrl) => {
  const scp = /^[^@\s]+@([^:\s]+):(.+?)(?:\.git)?\/?$/.exec(remoteUrl);
  if (scp) return { host: scp[1].toLowerCase(), path: scp[2] };
  try {
    const url = new URL(remoteUrl);
    if (!['https:', 'http:', 'ssh:'].includes(url.protocol)) return null;
    const repositoryPath = url.pathname.replace(/^\/+/, '').replace(/\.git$/, '').replace(/\/+$/, '');
    return repositoryPath ? { host: url.hostname.toLowerCase(), path: repositoryPath } : null;
  } catch {
    return null;
  }
};

/** The trackers a project can file an issue in: its `origin` (or first) remote, and Linear when connected. */
export const resolveIssueTargets = ({ remotes, linearConnected }) => {
  const remote = remotes.find((entry) => entry.name === 'origin') ?? remotes[0] ?? null;
  const repository = remote ? repositoryOf(remote.fetchUrl) : null;
  const targets = [];
  if (repository?.host === 'github.com' && repository.path.split('/').length === 2) {
    targets.push({ provider: 'github', base: `https://github.com/${repository.path}` });
  } else if (repository?.host.includes('gitlab')) {
    targets.push({ provider: 'gitlab', base: `https://${repository.host}/${repository.path}` });
  }
  if (linearConnected) targets.push({ provider: 'linear', base: 'https://linear.new' });
  return targets;
};

export const buildIssueUrl = (target, { title, body }) => {
  const description = body.length > MAX_BODY_IN_URL ? `${body.slice(0, MAX_BODY_IN_URL)}\n\n…` : body;
  if (target.provider === 'github') {
    return `${target.base}/issues/new?${new URLSearchParams({ title, body: description })}`;
  }
  if (target.provider === 'gitlab') {
    return `${target.base}/-/issues/new?${new URLSearchParams({ 'issue[title]': title, 'issue[description]': description })}`;
  }
  return `${target.base}?${new URLSearchParams({ title, description })}`;
};
