import { spawnSync } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { pathToFileURL } from 'url';
import { z } from 'zod';
import { getWebPackagePaths } from './web-package-paths.js';
import { fetchUpdateNotes } from './changelog/update-notes.js';
import { compareVersions } from './version-order.js';
import { isEnterpriseMode } from './enterprise-mode.js';
import { getSpawnSyncBaseOptions, spawnPackageManagerProbe } from './package-manager-probe.js';

import { resolveNpmRegistryRequest } from './npm/npm-registry-config.js';
import type { JsonObject, JsonValue } from './shared/json-values.js';

type VersionValue = JsonValue | undefined;
type PackageManager = 'npm' | 'pnpm' | 'yarn' | 'bun';
type DetectionReason = 'forced-env' | 'install-path-owner' | 'global-root-owner' | 'hinted-visible-install' | 'runtime-visible-install' | 'last-resort-visible-install' | 'default-fallback' | 'unmanaged-install';
type ForkReleaseSource = { readonly repo: string; readonly tag: string | null; readonly channel: string | undefined };
type ForkWebTarball = { readonly version: string; readonly url: string };
const forkReleaseSchema = z.object({
  tag_name: z.string().nullish(),
  name: z.string().nullish(),
  body: z.string().nullish(),
  html_url: z.string().nullish(),
  assets: z.array(z.object({ name: z.string().nullish(), browser_download_url: z.string().nullish() })).nullish(),
});
type ForkRelease = z.infer<typeof forkReleaseSchema>;

export interface PackageManagerDetection {
  packageManager: PackageManager | 'electron';
  reason: DetectionReason | 'desktop-runtime';
  packagePath: string | null;
  packageManagerCommand: string | null;
  globalNodeModulesRoot: string | null;
}

export interface UpdateCheckOptions {
  appType?: string | undefined;
  platform?: string | undefined;
  arch?: string | undefined;
  deviceClass?: string | undefined;
  reportUsage?: boolean;
  installId?: string | undefined;
  instanceMode?: string | undefined;
  currentVersion?: VersionValue;
  channel?: string | undefined;
}

export interface UpdateCheckResult {
  available: boolean;
  currentVersion: VersionValue;
  version?: VersionValue;
  body?: string | undefined;
  releaseUrl?: string | undefined;
  downloadUrl?: string | undefined;
  nextSuggestedCheckInSec?: number | undefined;
  error?: string;
  packageManager?: PackageManager | 'electron';
  updateCommand?: string;
}

export interface UpdateCommandOptions {
  targetVersion?: VersionValue;
  target?: string | undefined;
}

export interface ExecuteUpdateOptions extends UpdateCommandOptions {
  silent?: boolean;
}

const isText = (value: unknown): value is string => typeof value === 'string';
const isNumber = (value: unknown): value is number => typeof value === 'number';
const hasJsonFields = (value: JsonValue | undefined): value is JsonObject =>
  value !== null && typeof value === 'object';
const isPackageManager = (value: string): value is PackageManager =>
  ['npm', 'pnpm', 'yarn', 'bun'].includes(value);

const PACKAGE_NAME = '@openchamber/web';
const PACKAGE_PATH_SEGMENTS = PACKAGE_NAME.split('/');
const UPSTREAM_REPO = 'openchamber/openchamber';

// Release links follow the repo the update check reads, so a fork build never
// sends the user to the official releases for the build it is offering, and the
// Android APK it advertises is its own.
function releasesApiUrl() {
  return `${GITHUB_API_URL}/repos/${getForkReleaseSource()?.repo ?? UPSTREAM_REPO}/releases`;
}

function releasesWebUrl() {
  return `https://github.com/${getForkReleaseSource()?.repo ?? UPSTREAM_REPO}/releases`;
}
// The reason is kept with the package manager: a later call must still tell
// a copy no package manager installed from one it did.
let cachedDetection: { packageManager: PackageManager; reason: DetectionReason } | null = null;

const UPDATE_CHECK_URL = process.env.OPENCHAMBER_UPDATE_API_URL || 'https://api.openchamber.dev/v1/update/check';
const GITHUB_API_URL = 'https://api.github.com';

/**
 * A fork publishes its own releases and is absent from npm, and
 * `api.openchamber.dev` only knows official versions — asking either would
 * report an upstream build as if it were the fork's. With
 * `OPENCHAMBER_UPDATE_REPO` set, the check reads that repo's releases instead of
 * the npm and update-service paths below. Every fork entry point sets it, so the
 * desktop window, a browser attached to it, and the CLI agree. Unset, this is
 * upstream and nothing here changes.
 *
 * `OPENCHAMBER_UPDATE_RELEASE_TAG` picks between the two release models. Set, it
 * names one rolling release rewritten in place and builds are told apart by
 * their build marker; unset, releases are versioned and semver decides.
 * Web updates follow `serverUpdateChannel`: Canary reads the `canary` release
 * and its versioned web tarballs. An explicit rolling tag keeps its override.
 * Android continues to read the fork's Stable release independently of that
 * server setting.
 *
 * Read at call time, not at module load: Electron sets these before starting the
 * in-process server, and ESM imports run before that.
 */
function getForkReleaseSource(channel?: string): ForkReleaseSource | null {
  const repo = (process.env.OPENCHAMBER_UPDATE_REPO || '').trim();
  const tag = (process.env.OPENCHAMBER_UPDATE_RELEASE_TAG || '').trim();
  // Also keeps a malformed value out of the request URL.
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) return null;
  return { repo, tag: tag || (channel === 'canary' ? 'canary' : null), channel: tag ? undefined : channel };
}

/**
 * The build marker a fork stamps into its version, e.g. `turbo.5518dc22` in
 * `1.23.1+turbo.5518dc22`. A rolling release reuses one tag and keeps the
 * upstream semver, so this marker — not semver — is what tells two builds apart.
 */
function extractBuildId(value: unknown) {
  if (typeof value !== 'string') return null;
  return value.match(/[A-Za-z][\w-]*\.[0-9a-f]{7,40}\b/)?.[0] ?? null;
}

function extractVersion(value: unknown) {
  if (typeof value !== 'string') return null;
  return value.match(/\d+\.\d+\.\d+[\w.+-]*/)?.[0] ?? null;
}

/**
 * Throws on transport/HTTP failure so the caller reports a failed check: a fork
 * build has no second source, and answering "no update" here would make an
 * unreachable GitHub look up to date.
 */
async function fetchForkRelease(source: ForkReleaseSource): Promise<ForkRelease | null> {
  const endpoint = source.tag
    ? `releases/tags/${encodeURIComponent(source.tag)}`
    : 'releases/latest';
  const response = await fetch(`${GITHUB_API_URL}/repos/${source.repo}/${endpoint}`, {
    headers: {
      Accept: 'application/vnd.github+json',
      'User-Agent': 'openchamber-update-check',
    },
    signal: AbortSignal.timeout(10000),
  });

  // A fork that has not published a versioned release yet answers 404 here, and
  // so does one whose releases are all prereleases. That is "nothing to update
  // to", not a failed check. A rolling tag is different: it is supposed to
  // exist, so its 404 stays an error.
  if (response.status === 404 && !source.tag) return null;

  if (!response.ok) {
    const target = source.tag ? `release "${source.tag}"` : 'the latest release';
    throw new Error(`GitHub returned ${response.status} for ${source.repo} ${target}`);
  }

  return forkReleaseSchema.parse(await response.json());
}

// Canary's title and tag carry no version. Only a web tarball establishes a
// version the server can install; SDK and platform assets cannot select it.
function findForkWebTarball(release: ForkRelease, source: ForkReleaseSource): ForkWebTarball | null {
  const releaseVersion = extractVersion(release?.tag_name) || extractVersion(release?.name);
  let newest: ForkWebTarball | null = null;
  for (const asset of Array.isArray(release?.assets) ? release.assets : []) {
    if (typeof asset?.name !== 'string' || !asset.name.startsWith('openchamber-web-')
      || !asset.name.endsWith('.tgz') || typeof asset.browser_download_url !== 'string') continue;
    const version = asset.name.slice('openchamber-web-'.length, -'.tgz'.length);
    if (source.channel === 'canary') {
      if (!normalizeTargetVersion(version) || !isCanaryVersion(version)) continue;
    } else {
      if (!source.tag && version !== releaseVersion) continue;
      return { version, url: asset.browser_download_url };
    }
    if (!newest || compareVersions(version, newest.version) > 0) newest = { version, url: asset.browser_download_url };
  }
  return newest;
}

function pickAndroidApkUrl(release: ForkRelease) {
  const assets = release.assets?.flatMap(({ name, browser_download_url }) => (
    typeof name === 'string' && name.toLowerCase().endsWith('.apk') && typeof browser_download_url === 'string'
      ? [{ name, browser_download_url }]
      : []
  )) ?? [];
  return (assets.find((asset) => /^OpenChamber-.+-android\.apk$/i.test(asset.name)) || assets[0])?.browser_download_url;
}

async function checkForkRelease(currentVersion: VersionValue, source: ForkReleaseSource,
  { appType, platform }: Pick<UpdateCheckOptions, 'appType' | 'platform'> = {}): Promise<UpdateCheckResult> {
  const release = await fetchForkRelease(source);
  if (!release) return { available: false, currentVersion };

  const body = typeof release?.body === 'string' && release.body.trim() ? release.body : undefined;
  const releaseUrl = typeof release?.html_url === 'string' ? release.html_url : undefined;
  const assetNames = Array.isArray(release?.assets)
    ? release.assets.map((asset) => (typeof asset?.name === 'string' ? asset.name : '')).join(' ')
    : '';

  if (!source.tag || source.channel === 'canary') {
    // Stable uses the versioned release tag; Canary uses its installable web
    // asset. Only an explicit return from Canary to Stable permits a downgrade.
    const remoteVersion = source.channel === 'canary'
      ? findForkWebTarball(release, source)?.version
      : extractVersion(release?.tag_name) || extractVersion(release?.name);
    const available = Boolean(remoteVersion) && (source.channel === 'stable' && isCanaryVersion(currentVersion)
      ? remoteVersion !== currentVersion
      : compareVersions(remoteVersion, currentVersion) > 0);
    return {
      available,
      version: remoteVersion || undefined,
      currentVersion,
      body,
      releaseUrl,
      // The Android app offers only the APK of this fork's own release.
      downloadUrl: available && appType === 'mobile-capacitor' && platform === 'android'
        ? pickAndroidApkUrl(release)
        : undefined,
    };
  }

  const searchableReleaseText = [release?.name, release?.tag_name, assetNames]
    .filter((value) => typeof value === 'string' && value)
    .join(' ');
  const remoteBuildId = extractBuildId(searchableReleaseText);
  const installedBuildId = extractBuildId(currentVersion);
  const remoteVersion = extractVersion(release?.name) || extractVersion(assetNames) || remoteBuildId;

  return {
    // A rolling release keeps one tag and the upstream semver, so build markers
    // are what tell two builds apart. Without a marker on either side there is
    // nothing to compare, so report no update rather than offering the build
    // already installed.
    available: Boolean(remoteBuildId && installedBuildId && remoteBuildId !== installedBuildId),
    version: remoteVersion || undefined,
    currentVersion,
    body,
    releaseUrl,
  };
}

/**
 * What `openchamber update` should install.
 *
 * Upstream installs the npm package. A fork is absent from npm, so it installs
 * the tarball its release carries; falling back to `@latest` there would replace
 * the fork with the official build, which is the one thing this must never do.
 * So a configured fork with no usable tarball is an error, not a fallback.
 */
export async function resolveUpdateTarget() {
  const source = getForkReleaseSource(readUpdateChannel());
  if (!source) return { target: `${PACKAGE_NAME}@latest`, origin: 'npm' };

  const release = await fetchForkRelease(source);
  if (!release) {
    throw new Error(`${source.repo} has published no release to update from yet.`);
  }

  const tarball = findForkWebTarball(release, source);

  if (!tarball) {
    throw new Error(
      `The ${source.repo} release carries no .tgz asset to install. `
      + `This build is not published to npm, so there is nothing else to update from.`,
    );
  }

  return { target: tarball.url, origin: 'fork' };
}

function getOpenChamberConfigDir() {
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA;
    if (appData) return path.join(appData, 'openchamber');
  }

  return path.join(os.homedir(), '.config', 'openchamber');
}

function sanitizeInstallScope(scope: string) {
  if (scope === 'desktop-electron' || scope === 'vscode' || scope === 'web' || scope === 'mobile-capacitor') return scope;
  return 'web';
}

function getOrCreateInstallId(scope = 'web') {
  const configDir = getOpenChamberConfigDir();
  const normalizedScope = sanitizeInstallScope(scope);
  const idPath = path.join(configDir, `install-id-${normalizedScope}`);

  try {
    const existing = fs.readFileSync(idPath, 'utf8').trim();
    if (existing) return existing;
  } catch {
    void 0;
  }

  const installId = crypto.randomUUID();
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(idPath, `${installId}\n`, { encoding: 'utf8', mode: 0o600 });
  return installId;
}

function mapPlatform(value: string) {
  if (value === 'darwin') return 'macos';
  if (value === 'win32') return 'windows';
  if (value === 'linux') return 'linux';
  return 'web';
}

function mapArch(value: string) {
  if (value === 'arm64' || value === 'aarch64') return 'arm64';
  if (value === 'x64' || value === 'amd64') return 'x64';
  return 'unknown';
}

function normalizeAppType(value: string | undefined) {
  if (value === 'web' || value === 'desktop-electron' || value === 'vscode' || value === 'mobile-capacitor') return value;
  return 'web';
}

function normalizeDeviceClass(value: string | undefined) {
  if (value === 'mobile' || value === 'tablet' || value === 'desktop' || value === 'unknown') return value;
  return 'unknown';
}

function normalizePlatform(value: string | undefined) {
  if (value === 'macos' || value === 'windows' || value === 'linux' || value === 'web' || value === 'android' || value === 'ios') return value;
  return mapPlatform(process.platform);
}

function normalizeArch(value: string | undefined) {
  if (value === 'arm64' || value === 'x64' || value === 'unknown') return value;
  return mapArch(process.arch);
}

const CANARY_MIRROR_URL = 'https://downloads.openchamber.dev/desktop/canary/';

const CANARY_ANDROID_APK_RE = /^OpenChamber-(\d+\.\d+\.\d+-canary\.\d+\.\d+)-\d+-android\.apk$/;

async function fetchCanaryAndroidApk() {
  try {
    const response = await fetch(`${releasesApiUrl()}/tags/canary`, {
      headers: {
        Accept: 'application/vnd.github+json',
        'User-Agent': 'openchamber-update-check',
      },
      signal: AbortSignal.timeout(10000),
    });
    if (response.status === 404) return { newest: null };
    if (!response.ok) return null;

    const release: JsonValue = await response.json();
    let newest: { version: string; name: string; url: string } | null = null;
    for (const asset of hasJsonFields(release) && Array.isArray(release.assets) ? release.assets : []) {
      const match = hasJsonFields(asset) && isText(asset.name) ? CANARY_ANDROID_APK_RE.exec(asset.name) : null;
      if (!match || match[1] === undefined || !hasJsonFields(asset) || !isText(asset.name) || !isText(asset.browser_download_url)) continue;
      if (!newest || compareVersions(match[1], newest.version) > 0) {
        newest = { version: match[1], name: asset.name, url: asset.browser_download_url };
      }
    }
    if (!newest) return { newest: null };
    const mirrorUrl = `${CANARY_MIRROR_URL}${newest.name}`;
    const mirrored = await fetch(mirrorUrl, { method: 'HEAD', signal: AbortSignal.timeout(3000) }).then((head) => head.ok, () => false);
    return { newest: { version: newest.version, url: mirrored ? mirrorUrl : newest.url } };
  } catch {
    return null;
  }
}

async function checkForUpdatesFromApi(currentVersion: VersionValue, options: UpdateCheckOptions = {}) {
  try {
    const appType = normalizeAppType(options.appType);
    const hostPlatform = mapPlatform(process.platform);
    const hostArch = mapArch(process.arch);
    const shouldTrustClientPlatform = appType === 'desktop-electron' || appType === 'vscode' || appType === 'mobile-capacitor';
    const platform = shouldTrustClientPlatform ? normalizePlatform(options.platform) : hostPlatform;
    const arch = shouldTrustClientPlatform ? normalizeArch(options.arch) : hostArch;
    const reportUsage = options.reportUsage !== false && !isEnterpriseMode();
    const payload = {
      appType,
      deviceClass: normalizeDeviceClass(options.deviceClass),
      platform,
      arch,
      channel: /-canary\./.test(String(currentVersion)) ? 'canary' : 'stable',
      currentVersion,
      installId: reportUsage ? (options.installId || getOrCreateInstallId(appType)) : undefined,
      instanceMode: options.instanceMode || 'unknown',
      reportUsage,
    };

    const response = await fetch(UPDATE_CHECK_URL, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(10000),
    });

    if (!response.ok) return null;
    const data: JsonValue = await response.json();
    if (!hasJsonFields(data) || !isText(data.latestVersion)) return null;

    const versionComparison = compareVersions(data.latestVersion, currentVersion);
    if (versionComparison < 0) return null;

    const releaseUrl = `${releasesWebUrl()}/tag/v${data.latestVersion}`;
    const updateAvailable = Boolean(data.updateAvailable) && versionComparison > 0;
    return {
      available: updateAvailable,
      version: data.latestVersion,
      currentVersion,
      body: isText(data.releaseNotes) ? data.releaseNotes : undefined,
      releaseUrl: isText(data.releaseNotesUrl) ? data.releaseNotesUrl : releaseUrl,
      nextSuggestedCheckInSec:
        isNumber(data.nextSuggestedCheckInSec) && Number.isFinite(data.nextSuggestedCheckInSec)
          ? data.nextSuggestedCheckInSec
          : undefined,
    };
  } catch {
    return null;
  }
}

function normalizePathForComparison(filePath: string) {
  if (!filePath) return null;
  const normalized = path.normalize(path.resolve(filePath));
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function getComparablePaths(filePath: string) {
  const paths = new Set<string>();
  const normalized = normalizePathForComparison(filePath);
  if (normalized) {
    paths.add(normalized);
  }

  try {
    const realPath = fs.realpathSync.native ? fs.realpathSync.native(filePath) : fs.realpathSync(filePath);
    const normalizedRealPath = normalizePathForComparison(realPath);
    if (normalizedRealPath) {
      paths.add(normalizedRealPath);
    }
  } catch {
    void 0;
  }

  return paths;
}

function pathSetContains(a: Set<string>, b: Set<string>) {
  for (const value of a) {
    if (b.has(value)) {
      return true;
    }
  }
  return false;
}

function getCurrentPackagePath(): string {
  return getWebPackagePaths().root;
}

function getPackagePathForGlobalRoot(rootPath: string) {
  if (!rootPath) return null;
  return path.join(rootPath, ...PACKAGE_PATH_SEGMENTS);
}

function getUniquePaths(paths: string[]) {
  const seen = new Set<string>();
  const result = [];
  for (const value of paths) {
    const normalized = normalizePathForComparison(value);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(path.resolve(value));
  }
  return result;
}

function getCommandOutput(command: string, args: string[]) {
  try {
    const result = spawnPackageManagerProbe(command, args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 10000,
      ...getSpawnSyncBaseOptions(),
    });

    if (result.status !== 0) {
      return null;
    }

    const stdout = result.stdout.trim();
    return stdout || null;
  } catch {
    return null;
  }
}

function getGlobalBinDirs(pm: string) {
  const pmCommand = resolvePackageManagerCommand(pm);
  if (!isCommandAvailable(pmCommand)) {
    return [];
  }

  const dirs = [];
  switch (pm) {
    case 'pnpm': {
      const pnpmBin = getCommandOutput(pmCommand, ['bin', '-g']);
      if (pnpmBin) dirs.push(pnpmBin);
      const pnpmPrefix = getCommandOutput(pmCommand, ['prefix', '-g']);
      if (pnpmPrefix) dirs.push(process.platform === 'win32' ? pnpmPrefix : path.join(pnpmPrefix, 'bin'));
      break;
    }
    case 'yarn': {
      const yarnBin = getCommandOutput(pmCommand, ['global', 'bin']);
      if (yarnBin) dirs.push(yarnBin);
      break;
    }
    case 'bun': {
      const bunBin = getCommandOutput(pmCommand, ['pm', 'bin', '-g']);
      if (bunBin) dirs.push(bunBin);
      break;
    }
    default: {
      const npmPrefix = getCommandOutput(pmCommand, ['prefix', '-g']);
      if (npmPrefix) dirs.push(process.platform === 'win32' ? npmPrefix : path.join(npmPrefix, 'bin'));
      break;
    }
  }

  return getUniquePaths(dirs);
}

function getGlobalNodeModulesRoots(pm: string) {
  try {
    const pmCommand = resolvePackageManagerCommand(pm);
    if (!isCommandAvailable(pmCommand)) {
      return [];
    }

    const roots = [];

    switch (pm) {
      case 'pnpm': {
        const pnpmRoot = getCommandOutput(pmCommand, ['root', '-g']);
        if (pnpmRoot) roots.push(pnpmRoot);
        const pnpmPrefix = getCommandOutput(pmCommand, ['prefix', '-g']);
        if (pnpmPrefix) roots.push(process.platform === 'win32' ? path.join(pnpmPrefix, 'node_modules') : path.join(pnpmPrefix, 'lib', 'node_modules'));
        break;
      }
      case 'yarn': {
        const yarnDir = getCommandOutput(pmCommand, ['global', 'dir']);
        if (yarnDir) roots.push(path.join(yarnDir, 'node_modules'));
        break;
      }
      case 'bun': {
        const bunBinDir = getCommandOutput(pmCommand, ['pm', 'bin', '-g']);
        if (bunBinDir) {
          roots.push(path.resolve(bunBinDir, '..', 'install', 'global', 'node_modules'));
          roots.push(path.resolve(bunBinDir, '..', '..', 'node_modules'));
        }
        break;
      }
      default:
      {
        const npmRoot = getCommandOutput(pmCommand, ['root', '-g']);
        if (npmRoot) roots.push(npmRoot);
        const npmPrefix = getCommandOutput(pmCommand, ['prefix', '-g']);
        if (npmPrefix) roots.push(process.platform === 'win32' ? path.join(npmPrefix, 'node_modules') : path.join(npmPrefix, 'lib', 'node_modules'));
        break;
      }
    }

    return getUniquePaths(roots);
  } catch {
    return [];
  }
}

function getOwnedPackagePathsFromGlobalBins(pm: string) {
  const packagePaths = [];
  for (const binDir of getGlobalBinDirs(pm)) {
    const binaryName = process.platform === 'win32' ? 'openchamber.cmd' : 'openchamber';
    const binaryPath = path.join(binDir, binaryName);
    if (!fs.existsSync(binaryPath)) continue;

    try {
      const realBinaryPath = fs.realpathSync.native ? fs.realpathSync.native(binaryPath) : fs.realpathSync(binaryPath);
      packagePaths.push(getWebPackagePaths(pathToFileURL(realBinaryPath).href).root);
    } catch {
      void 0;
    }
  }

  return getUniquePaths(packagePaths);
}

function detectPackageManagerFromCurrentInstallPath() {
  return detectPackageManagerFromInstallPath(getCurrentPackagePath());
}

function packageManagerOwnsCurrentInstall(pm: string) {
  const currentPackagePaths = getComparablePaths(getCurrentPackagePath());
  const candidatePackagePaths = [
    ...getGlobalNodeModulesRoots(pm).map(getPackagePathForGlobalRoot),
    ...getOwnedPackagePathsFromGlobalBins(pm),
  ];

  for (const candidatePath of candidatePackagePaths) {
    if (!candidatePath) continue;
    if (pathSetContains(currentPackagePaths, getComparablePaths(candidatePath))) {
      return true;
    }
  }

  return false;
}

function describeDetection(packageManager: PackageManager, reason: DetectionReason): PackageManagerDetection {
  return {
    packageManager,
    reason,
    packagePath: getCurrentPackagePath(),
    packageManagerCommand: resolvePackageManagerCommand(packageManager),
    globalNodeModulesRoot: getGlobalNodeModulesRoots(packageManager)[0] || null,
  };
}

function rememberDetection(packageManager: PackageManager, reason: DetectionReason) {
  cachedDetection = { packageManager, reason };
  return describeDetection(packageManager, reason);
}

export function detectPackageManagerDetails(): PackageManagerDetection {
  if (process.env.OPENCHAMBER_RUNTIME === 'desktop') {
    return {
      packageManager: 'electron',
      reason: 'desktop-runtime',
      packagePath: null,
      packageManagerCommand: null,
      globalNodeModulesRoot: null,
    };
  }

  if (cachedDetection) {
    return describeDetection(cachedDetection.packageManager, cachedDetection.reason);
  }

  const forcedPm = process.env.OPENCHAMBER_PACKAGE_MANAGER?.trim();
  if (forcedPm && isPackageManager(forcedPm)) {
    if (isCommandAvailable(resolvePackageManagerCommand(forcedPm))) {
      return rememberDetection(forcedPm, 'forced-env');
    }
  }

  const installPathPm = detectPackageManagerFromCurrentInstallPath();
  if (installPathPm && packageManagerOwnsCurrentInstall(installPathPm)) {
    return rememberDetection(installPathPm, 'install-path-owner');
  }

  const ownershipCandidates: PackageManager[] = ['pnpm', 'yarn', 'bun', 'npm'];
  for (const candidate of ownershipCandidates) {
    if (packageManagerOwnsCurrentInstall(candidate)) {
      return rememberDetection(candidate, 'global-root-owner');
    }
  }

  const userAgent = process.env.npm_config_user_agent || '';
  let hintedPm: PackageManager | null = null;
  if (userAgent.startsWith('pnpm')) hintedPm = 'pnpm';
  else if (userAgent.startsWith('yarn')) hintedPm = 'yarn';
  else if (userAgent.startsWith('bun')) hintedPm = 'bun';
  else if (userAgent.startsWith('npm')) hintedPm = 'npm';

  const execPath = process.env.npm_execpath || '';
  if (!hintedPm) {
    if (execPath.includes('pnpm')) hintedPm = 'pnpm';
    else if (execPath.includes('yarn')) hintedPm = 'yarn';
    else if (execPath.includes('bun')) hintedPm = 'bun';
    else if (execPath.includes('npm')) hintedPm = 'npm';
  }

  const invokedPm = detectPackageManagerFromInvocationPath(process.argv?.[1]);
  if (!hintedPm) {
    hintedPm = invokedPm;
  }

  if (!hintedPm) {
    hintedPm = installPathPm;
  }

  if (hintedPm && isCommandAvailable(resolvePackageManagerCommand(hintedPm)) && isPackageInstalledWith(hintedPm)) {
    return rememberDetection(hintedPm, 'hinted-visible-install');
  }

  const runtimePm = detectPackageManagerFromRuntimePath(process.execPath);
  if (runtimePm && isCommandAvailable(resolvePackageManagerCommand(runtimePm)) && isPackageInstalledWith(runtimePm)) {
    return rememberDetection(runtimePm, 'runtime-visible-install');
  }

  const pmChecks: { name: PackageManager; check: () => boolean }[] = [
    { name: 'pnpm', check: () => isCommandAvailable(resolvePackageManagerCommand('pnpm')) },
    { name: 'yarn', check: () => isCommandAvailable(resolvePackageManagerCommand('yarn')) },
    { name: 'bun', check: () => isCommandAvailable(resolvePackageManagerCommand('bun')) },
    { name: 'npm', check: () => isCommandAvailable(resolvePackageManagerCommand('npm')) },
  ];

  for (const { name, check } of pmChecks) {
    if (check()) {
      if (isPackageInstalledWith(name)) {
        return rememberDetection(name, 'last-resort-visible-install');
      }
    }
  }

  return rememberDetection('npm', installPathPm ? 'default-fallback' : 'unmanaged-install');
}

export function isUnmanagedInstall() {
  return (cachedDetection ?? detectPackageManagerDetails()).reason === 'unmanaged-install';
}

export function detectPackageManager() {
  return detectPackageManagerDetails().packageManager;
}

function detectPackageManagerFromInstallPath(pkgPath: string) {
  if (!pkgPath) return null;
  const normalized = pkgPath.replace(/\\/g, '/').toLowerCase();
  if (normalized.includes('/.pnpm/') || normalized.includes('/pnpm/') || normalized.includes('/pnpm-store/')) return 'pnpm';
  if (normalized.includes('/.yarn/')) return 'yarn';
  if (normalized.includes('/.bun/') || normalized.includes('/bun/install/')) return 'bun';
  if (normalized.includes('/node_modules/')) return 'npm';
  return null;
}

function detectPackageManagerFromRuntimePath(runtimePath: string) {
  if (!runtimePath) return null;
  const normalized = runtimePath.replace(/\\/g, '/').toLowerCase();
  if (normalized.includes('/.bun/bin/bun') || normalized.endsWith('/bun') || normalized.endsWith('/bun.exe')) {
    return 'bun';
  }
  if (normalized.includes('/pnpm/')) return 'pnpm';
  if (normalized.includes('/yarn/')) return 'yarn';
  if (normalized.includes('/node') || normalized.endsWith('/node.exe')) return 'npm';
  return null;
}

function detectPackageManagerFromInvocationPath(invokedPath: string | undefined) {
  if (!invokedPath) return null;
  const normalized = invokedPath.replace(/\\/g, '/').toLowerCase();
  if (normalized.includes('/.bun/bin/')) return 'bun';
  if (normalized.includes('/.pnpm/')) return 'pnpm';
  if (normalized.includes('/.yarn/')) return 'yarn';
  return null;
}

function getPackageManagerCommandCandidates(pm: string) {
  const candidates = [];
  if (pm === 'bun') {
    const bunExecutable = process.platform === 'win32' ? 'bun.exe' : 'bun';
    if (process.env.BUN_INSTALL) {
      candidates.push(path.join(process.env.BUN_INSTALL, 'bin', bunExecutable));
    }
    if (process.env.HOME) {
      candidates.push(path.join(process.env.HOME, '.bun', 'bin', bunExecutable));
    }
    if (process.env.USERPROFILE) {
      candidates.push(path.join(process.env.USERPROFILE, '.bun', 'bin', bunExecutable));
    }
  }
  candidates.push(pm);
  return [...new Set(candidates.filter(Boolean))];
}

function resolvePackageManagerCommand(pm: string) {
  const candidates = getPackageManagerCommandCandidates(pm);
  for (const candidate of candidates) {
    if (isCommandAvailable(candidate)) {
      return candidate;
    }
  }
  return pm;
}

function quoteCommand(command: string) {
  if (!command) return command;
  if (!/\s/.test(command)) return command;
  if (process.platform === 'win32') {
    return `"${command.replace(/"/g, '""')}"`;
  }
  return `'${command.replace(/'/g, "'\\''")}'`;
}

function isCommandAvailable(command: string) {
  try {
    const result = spawnPackageManagerProbe(command, ['--version'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 5000,
      ...getSpawnSyncBaseOptions(),
    });
    return result.status === 0;
  } catch {
    return false;
  }
}

function getGlobalListArgs(pm: string) {
  switch (pm) {
    case 'pnpm':
      return ['list', '-g', '--depth=0', PACKAGE_NAME];
    case 'yarn':
      return ['global', 'list', '--depth=0'];
    case 'bun':
      return ['pm', 'ls', '-g'];
    default:
      return ['list', '-g', '--depth=0', PACKAGE_NAME];
  }
}

function isPackageInstalledWith(pm: string) {
  try {
    const pmCommand = resolvePackageManagerCommand(pm);
    const args = getGlobalListArgs(pm);

    const result = spawnPackageManagerProbe(pmCommand, args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 10000,
      ...getSpawnSyncBaseOptions(),
    });

    if (result.status !== 0) return false;
    return result.stdout.includes(PACKAGE_NAME) || result.stdout.includes('openchamber');
  } catch {
    return false;
  }
}

const GLOBAL_VERSION_PATTERN = /@openchamber\/web[@\s]+v?(\d[\w.+-]*)/;

function getInstalledGlobalVersion(pm: string) {
  try {
    const pmCommand = resolvePackageManagerCommand(pm);
    const result = spawnPackageManagerProbe(pmCommand, getGlobalListArgs(pm), {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 10000,
      ...getSpawnSyncBaseOptions(),
    });
    return String(result.stdout || '').match(GLOBAL_VERSION_PATTERN)?.[1] || null;
  } catch {
    return null;
  }
}

function normalizeTargetVersion(value: VersionValue) {
  const normalized = String(value ?? '').trim().replace(/^v/, '');
  return /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(normalized) ? normalized : null;
}

const PNPM_BUILD_DEPENDENCIES = ['msgpackr-extract', 'node-pty'];
const PNPM_ALLOW_BUILD_MIN_VERSION = '10.4.0';

function getPnpmAllowBuildFlags(pmCommand: string) {
  const version = normalizeTargetVersion(getCommandOutput(pmCommand, ['--version']));
  if (!version || compareVersions(version, PNPM_ALLOW_BUILD_MIN_VERSION) < 0) return '';
  return PNPM_BUILD_DEPENDENCIES.map((name) => ` --allow-build=${name}`).join('');
}

/**
 * Get the update command for the detected package manager.
 * When an exact target version is given, it is pinned in the spec instead of
 * re-resolving the `latest` dist-tag at install time: the update check and the
 * package manager see different metadata, and dist-tag resolution can lag the
 * check behind a fresh release (stale packument cache, pnpm minimumReleaseAge).
 *
 * `options.target` replaces the npm package spec with whatever the package
 * manager should install. A fork passes the tarball URL from its own release,
 * because it publishes no npm package and `@latest` would fetch the official
 * build over it. Every supported package manager installs a URL with the same
 * subcommand it uses for a package name.
 */
export function getUpdateCommand(pm: string = detectPackageManager(), options: UpdateCommandOptions = {}) {
  const targetVersion = normalizeTargetVersion(options.targetVersion);
  if (options.targetVersion != null && !targetVersion) {
    throw new Error(`Invalid target version for update: ${String(options.targetVersion)}`);
  }
  const versionSpec = targetVersion ? `@${targetVersion}` : '@latest';
  const target = options.target || `${PACKAGE_NAME}${versionSpec}`;
  const resolvedCommand = resolvePackageManagerCommand(pm);
  const pmCommand = quoteCommand(resolvedCommand);
  const quotedTarget = quoteCommand(target);
  switch (pm) {
    case 'pnpm':
      return `${pmCommand} add -g${getPnpmAllowBuildFlags(resolvedCommand)} ${quotedTarget}`;
    case 'yarn':
      return `${pmCommand} global add ${quotedTarget}`;
    case 'bun':
      return `${pmCommand} add -g ${quotedTarget}`;
    default:
      return `${pmCommand} install -g ${quotedTarget}`;
  }
}

export function getCurrentVersion() {
  try {
    const pkgPath = getWebPackagePaths().packageJson;
    const pkg: JsonValue = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    return (hasJsonFields(pkg) && pkg.version) || 'unknown';
  } catch {
    return 'unknown';
  }
}

const UPDATE_CHANNELS = new Set(['stable', 'canary']);

const isCanaryVersion = (version: VersionValue) => /-canary\./.test(String(version || ''));

function getSettingsFilePath() {
  const dataDir = process.env.OPENCHAMBER_DATA_DIR?.trim();
  return path.join(dataDir ? path.resolve(dataDir) : path.join(os.homedir(), '.config', 'openchamber'), 'settings.json');
}

export function readUpdateChannel(currentVersion = getCurrentVersion()) {
  try {
    const settings: JsonValue = JSON.parse(fs.readFileSync(getSettingsFilePath(), 'utf8'));
    if (hasJsonFields(settings) && isText(settings.serverUpdateChannel) && UPDATE_CHANNELS.has(settings.serverUpdateChannel)) return settings.serverUpdateChannel;
  } catch {
    void 0;
  }
  return isCanaryVersion(currentVersion) ? 'canary' : 'stable';
}

async function fetchDistTags() {
  try {
    const request = resolveNpmRegistryRequest(PACKAGE_NAME);
    const response = await fetch(request.url, {
      headers: { Accept: 'application/json', ...request.headers },
      signal: AbortSignal.timeout(10000),
    });

    if (!response.ok) {
      throw new Error(`Registry responded with ${response.status}`);
    }

    const data: JsonValue = await response.json();
    return (hasJsonFields(data) ? data['dist-tags'] : undefined) ?? {};
  } catch {
    return null;
  }
}

export async function fetchRequiredOpenCodeVersion(version: VersionValue) {
  const target = normalizeTargetVersion(version);
  if (!target) return null;
  try {
    const request = resolveNpmRegistryRequest(PACKAGE_NAME, target);
    const response = await fetch(request.url, {
      headers: { Accept: 'application/json', ...request.headers },
      signal: AbortSignal.timeout(10000),
    });
    if (!response.ok) return null;
    const data: JsonValue = await response.json();
    const engines = hasJsonFields(data) ? data.engines : undefined;
    return /^>=\s*v?(\d+\.\d+\.\d+)$/.exec(String((hasJsonFields(engines) ? engines.opencode : undefined) ?? '').trim())?.[1] ?? null;
  } catch {
    return null;
  }
}

async function getLatestVersion() {
  const tags = await fetchDistTags();
  return (hasJsonFields(tags) && tags.latest) || null;
}

async function fetchChangelogNotes(fromVersion: VersionValue, toVersion: VersionValue) {
  return (await fetchUpdateNotes<VersionValue>(fromVersion, toVersion, compareVersions)) ?? undefined;
}

async function checkChannelForUpdates(channel: string, currentVersion: VersionValue, options: UpdateCheckOptions) {
  const [, distTags] = await Promise.all([
    checkForUpdatesFromApi(currentVersion, options),
    fetchDistTags(),
  ]);
  if (!distTags) {
    return { available: false, currentVersion, error: 'Unable to determine versions' };
  }
  const target = normalizeTargetVersion(hasJsonFields(distTags) ? (channel === 'canary' ? distTags.canary : distTags.latest) : undefined);
  if (!target) {
    return { available: false, currentVersion };
  }
  const available = channel === 'canary' ? compareVersions(target, currentVersion) > 0 : target !== currentVersion;
  return {
    available,
    version: target,
    currentVersion,
    body: available ? await fetchChangelogNotes(currentVersion, target) : undefined,
    releaseUrl: channel === 'canary' ? `${releasesWebUrl()}/tag/canary` : `${releasesWebUrl()}/tag/v${target}`,
  };
}

export async function checkForUpdates(options: UpdateCheckOptions = {}): Promise<UpdateCheckResult> {
  const currentVersion = options.currentVersion || getCurrentVersion();
  const pm = detectPackageManager();
  const appType = normalizeAppType(options.appType);
  const platform = normalizePlatform(options.platform);

  // `options.channel` is for a caller whose installer reads one channel only, such as a host install.
  const forkSource = getForkReleaseSource(appType === 'web' ? options.channel ?? readUpdateChannel(currentVersion) : undefined);
  if (forkSource) {
    try {
      return { ...await checkForkRelease(currentVersion, forkSource, { appType, platform }), packageManager: pm };
    } catch (error) {
      return {
        available: false,
        currentVersion,
        error: error instanceof Error ? error.message : 'Failed to check the fork release',
      };
    }
  }

  if (appType === 'web' && currentVersion !== 'unknown') {
    const channel = readUpdateChannel(currentVersion);
    if (channel === 'canary' || isCanaryVersion(currentVersion)) {
      return {
        ...await checkChannelForUpdates(channel, currentVersion, options),
        packageManager: pm,
        updateCommand: 'openchamber update',
      };
    }
  }

  if (appType === 'mobile-capacitor' && platform === 'android' && currentVersion !== 'unknown') {
    const [, canary] = await Promise.all([
      checkForUpdatesFromApi(currentVersion, options),
      fetchCanaryAndroidApk(),
    ]);
    if (!canary) {
      return { available: false, currentVersion, error: 'Unable to determine versions' };
    }
    const available = canary.newest !== null && compareVersions(canary.newest.version, currentVersion) > 0;
    return {
      available,
      version: canary.newest?.version,
      currentVersion,
      body: available && canary.newest ? await fetchChangelogNotes(currentVersion, canary.newest.version) : undefined,
      releaseUrl: `${releasesWebUrl()}/tag/canary`,
      downloadUrl: available && canary.newest ? canary.newest.url : undefined,
    };
  }

  if (currentVersion !== 'unknown') {
    const remote = await checkForUpdatesFromApi(currentVersion, options);
    if (remote) {
      if (remote.available && appType === 'web') {
        const npmLatest = await getLatestVersion();
        if (!npmLatest || compareVersions(npmLatest, remote.version) < 0) {
          remote.available = false;
        }
      }
      return {
        ...remote,
        packageManager: pm,
        updateCommand: 'openchamber update',
      };
    }
  }

  const latestVersion = await getLatestVersion();

  if (!latestVersion || currentVersion === 'unknown') {
    return {
      available: false,
      currentVersion,
      error: 'Unable to determine versions',
    };
  }

  const available = compareVersions(latestVersion, currentVersion) > 0;
  const changelog = available ? await fetchChangelogNotes(currentVersion, latestVersion) : undefined;

  return {
    available,
    version: latestVersion,
    currentVersion,
    body: changelog,
    releaseUrl: `${releasesWebUrl()}/tag/v${latestVersion}`,
    packageManager: pm,
    updateCommand: 'openchamber update',
  };
}

/**
 * Execute the update (used by CLI).
 * When an exact target version is given, the globally installed version is
 * read back after the package manager exits: a zero exit status alone is not
 * proof the target landed (stale dist-tag resolution, pnpm release-age policy),
 * and the caller must not report success without the version matching.
 */
export function executeUpdate(pm: string = detectPackageManager(), options: ExecuteUpdateOptions = {}) {
  const command = getUpdateCommand(pm, { targetVersion: options.targetVersion, target: options.target });
  if (!options?.silent) {
    console.log(`Updating ${PACKAGE_NAME} using ${pm}...`);
    console.log(`Running: ${command}`);
  }

  const result = spawnSync(command, {
    stdio: 'inherit',
    shell: true,
    ...getSpawnSyncBaseOptions(),
  });

  if (result.status !== 0) {
    return {
      success: false,
      exitCode: result.status,
      error: `Package manager exited with code ${result.status}`,
    };
  }

  const targetVersion = normalizeTargetVersion(options.targetVersion);
  if (!targetVersion) {
    return {
      success: true,
      exitCode: result.status,
      installedVersion: null,
    };
  }

  const installedVersion = getInstalledGlobalVersion(pm);
  if (!installedVersion) {
    return {
      success: false,
      exitCode: result.status,
      error: `Could not determine the globally installed ${PACKAGE_NAME} version after the update; not reporting success`,
    };
  }

  if (compareVersions(installedVersion, targetVersion) !== 0) {
    return {
      success: false,
      exitCode: result.status,
      error: `Installed ${PACKAGE_NAME} version ${installedVersion} does not match target ${targetVersion}. The package manager may have resolved different metadata or filtered the release.`,
    };
  }

  return {
    success: true,
    exitCode: result.status,
    installedVersion,
  };
}
