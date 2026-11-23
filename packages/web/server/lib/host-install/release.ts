import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fail, isRecord, isString } from './host-inputs.js';
import type { HostPaths } from './host-paths.js';

const GITHUB_API = 'https://api.github.com';
const ASSET_PREFIX = 'openchamber-web-';
const ASSET_SUFFIX = '.tgz';

export const REPO_PATTERN = /^[\w.-]+\/[\w.-]+$/;
export const VERSION_PATTERN = /^[0-9A-Za-z.+-]{1,64}$/;

class ReleaseError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

export type HostRelease = { readonly version: string; readonly url: string; readonly sha256: string };
type FindReleaseOptions = { readonly repo: string; readonly tag?: string | null; readonly fetchImpl?: typeof fetch };

export async function findRelease({ repo, tag = null, fetchImpl = fetch }: FindReleaseOptions): Promise<HostRelease> {
  if (!REPO_PATTERN.test(repo ?? '')) throw new ReleaseError('invalid_repo', `Invalid repository "${repo}"`);
  const endpoint = tag ? `releases/tags/${encodeURIComponent(tag)}` : 'releases/latest';
  const response = await fetchImpl(`${GITHUB_API}/repos/${repo}/${endpoint}`, {
    headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'openchamber-host-updater' },
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) throw new ReleaseError('release_unavailable', `GitHub returned ${response.status} for ${repo} ${tag ?? 'latest release'}`);
  const value: unknown = await response.json();
  const release = isRecord(value) ? value : {};
  const releaseVersion = String(release['tag_name'] ?? '').replace(/^v/, '');
  const assets: readonly unknown[] = Array.isArray(release['assets']) ? release['assets'] : [];
  for (const asset of assets) {
    if (!isRecord(asset)) continue;
    const name = String(asset['name'] ?? '');
    if (!name.startsWith(ASSET_PREFIX) || !name.endsWith(ASSET_SUFFIX)) continue;
    const version = name.slice(ASSET_PREFIX.length, -ASSET_SUFFIX.length);
    if (version !== releaseVersion || !VERSION_PATTERN.test(version)) continue;
    const sha256 = /^sha256:([0-9a-f]{64})$/.exec(String(asset['digest'] ?? ''))?.[1];
    if (!sha256) throw new ReleaseError('digest_missing', `GitHub has no SHA-256 digest for ${name}`);
    const url = asset['browser_download_url'];
    if (!isString(url)) continue;
    return { version, url, sha256 };
  }
  throw new ReleaseError('package_missing', `Release ${release['tag_name'] ?? '?'} of ${repo} has no ${ASSET_PREFIX}${releaseVersion}${ASSET_SUFFIX}`);
}

const sha256File = async (file: string): Promise<string> => createHash('sha256').update(await fs.readFile(file)).digest('hex');

export async function downloadRelease({ url, sha256 }: Pick<HostRelease, 'url' | 'sha256'>, destination: string, { fetchImpl = fetch }: { readonly fetchImpl?: typeof fetch } = {}): Promise<void> {
  const response = await fetchImpl(url, { headers: { 'User-Agent': 'openchamber-host-updater' }, signal: AbortSignal.timeout(300_000) });
  if (!response.ok) throw new ReleaseError('download_failed', `Download returned ${response.status}`);
  await fs.writeFile(destination, Buffer.from(await response.arrayBuffer()), { mode: 0o600 });
  if (await sha256File(destination) !== sha256) {
    await fs.rm(destination, { force: true });
    throw new ReleaseError('digest_mismatch', 'The downloaded package does not match the digest GitHub records');
  }
}

interface ReleaseSystem {
  findRelease(options: { readonly repo: string }): Promise<HostRelease>;
  downloadRelease(release: HostRelease, destination: string): Promise<void>;
}

type PackageSource = { readonly tarball: string; readonly version: string; readonly cleanup: () => Promise<void> };
type ObtainPackageOptions = {
  readonly system: ReleaseSystem;
  readonly paths: Pick<HostPaths, 'cacheDir'>;
  readonly config: { readonly repo: string };
  readonly tarball?: string | null;
  readonly version?: string | null;
  readonly release?: HostRelease | null;
};

export async function obtainPackage({ system, paths, config, tarball, version, release = null }: ObtainPackageOptions): Promise<PackageSource> {
  if (tarball) {
    if (!version || !VERSION_PATTERN.test(version)) fail('invalid_version', 'Give --version with --tarball');
    return { tarball, version, cleanup: async () => {} };
  }
  const selected = release ?? await system.findRelease({ repo: config.repo });
  await fs.mkdir(paths.cacheDir, { recursive: true, mode: 0o700 });
  const file = path.join(paths.cacheDir, `openchamber-web-${selected.version}-${randomBytes(4).toString('hex')}.tgz`);
  await system.downloadRelease(selected, file);
  return { tarball: file, version: selected.version, cleanup: () => fs.rm(file, { force: true }) };
}
