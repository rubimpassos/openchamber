import { spawnSync } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { fetchUpdateNotes } from './changelog/update-notes.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PACKAGE_NAME = '@openchamber/web';
const PACKAGE_PATH_SEGMENTS = PACKAGE_NAME.split('/');
const NPM_REGISTRY_URL = `https://registry.npmjs.org/${PACKAGE_NAME}`;
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
let cachedDetectedPm = null;

function getSpawnSyncBaseOptions() {
  return process.platform === 'win32' ? { windowsHide: true } : {};
}
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
 *
 * Read at call time, not at module load: Electron sets these before starting the
 * in-process server, and ESM imports run before that.
 */
function getForkReleaseSource() {
  const repo = (process.env.OPENCHAMBER_UPDATE_REPO || '').trim();
  const tag = (process.env.OPENCHAMBER_UPDATE_RELEASE_TAG || '').trim();
  // Also keeps a malformed value out of the request URL.
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) return null;
  return { repo, tag: tag || null };
}

/**
 * The build marker a fork stamps into its version, e.g. `turbo.5518dc22` in
 * `1.23.1+turbo.5518dc22`. A rolling release reuses one tag and keeps the
 * upstream semver, so this marker — not semver — is what tells two builds apart.
 */
function extractBuildId(value) {
  if (typeof value !== 'string') return null;
  return value.match(/[A-Za-z][\w-]*\.[0-9a-f]{7,40}\b/)?.[0] ?? null;
}

function extractVersion(value) {
  if (typeof value !== 'string') return null;
  return value.match(/\d+\.\d+\.\d+[\w.+-]*/)?.[0] ?? null;
}

/**
 * Throws on transport/HTTP failure so the caller reports a failed check: a fork
 * build has no second source, and answering "no update" here would make an
 * unreachable GitHub look up to date.
 */
async function fetchForkRelease(source) {
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

  return response.json();
}

async function checkForkRelease(currentVersion, source) {
  const release = await fetchForkRelease(source);
  if (!release) return { available: false, currentVersion };

  const body = typeof release?.body === 'string' && release.body.trim() ? release.body : undefined;
  const releaseUrl = typeof release?.html_url === 'string' ? release.html_url : undefined;
  const assetNames = Array.isArray(release?.assets)
    ? release.assets.map((asset) => (typeof asset?.name === 'string' ? asset.name : '')).join(' ')
    : '';

  if (!source.tag) {
    // Versioned releases carry the version in the tag, so semver decides, and a
    // republished or rolled-back release cannot offer a build already installed.
    const remoteVersion = extractVersion(release?.tag_name) || extractVersion(release?.name);
    return {
      available: Boolean(remoteVersion) && compareVersions(remoteVersion, currentVersion) > 0,
      version: remoteVersion || undefined,
      currentVersion,
      body,
      releaseUrl,
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
  const source = getForkReleaseSource();
  if (!source) return { target: `${PACKAGE_NAME}@latest`, origin: 'npm' };

  const release = await fetchForkRelease(source);
  if (!release) {
    throw new Error(`${source.repo} has published no release to update from yet.`);
  }

  const tarball = (Array.isArray(release.assets) ? release.assets : []).find((asset) => (
    typeof asset?.name === 'string'
    && asset.name.startsWith('openchamber-web-')
    && asset.name.endsWith('.tgz')
    && typeof asset.browser_download_url === 'string'
  ));

  if (!tarball) {
    throw new Error(
      `The ${source.repo} release carries no .tgz asset to install. `
      + `This build is not published to npm, so there is nothing else to update from.`,
    );
  }

  return { target: tarball.browser_download_url, origin: 'fork' };
}

function getOpenChamberConfigDir() {
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA;
    if (appData) return path.join(appData, 'openchamber');
  }

  return path.join(os.homedir(), '.config', 'openchamber');
}

function sanitizeInstallScope(scope) {
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
    // Generate new id.
  }

  const installId = crypto.randomUUID();
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(idPath, `${installId}\n`, { encoding: 'utf8', mode: 0o600 });
  return installId;
}

function mapPlatform(value) {
  if (value === 'darwin') return 'macos';
  if (value === 'win32') return 'windows';
  if (value === 'linux') return 'linux';
  return 'web';
}

function mapArch(value) {
  if (value === 'arm64' || value === 'aarch64') return 'arm64';
  if (value === 'x64' || value === 'amd64') return 'x64';
  return 'unknown';
}

function normalizeAppType(value) {
  if (value === 'web' || value === 'desktop-electron' || value === 'vscode' || value === 'mobile-capacitor') return value;
  return 'web';
}

function normalizeDeviceClass(value) {
  if (value === 'mobile' || value === 'tablet' || value === 'desktop' || value === 'unknown') return value;
  return 'unknown';
}

function normalizePlatform(value) {
  if (value === 'macos' || value === 'windows' || value === 'linux' || value === 'web' || value === 'android' || value === 'ios') return value;
  return mapPlatform(process.platform);
}

function normalizeArch(value) {
  if (value === 'arm64' || value === 'x64' || value === 'unknown') return value;
  return mapArch(process.arch);
}

async function resolveAndroidApkUrl(version, candidateUrl) {
  if (typeof candidateUrl === 'string') {
    try {
      if (new URL(candidateUrl).pathname.toLowerCase().endsWith('.apk')) return candidateUrl;
    } catch {
      // Resolve malformed or non-APK values from the authoritative release assets below.
    }
  }

  try {
    const response = await fetch(`${releasesApiUrl()}/tags/v${version}`, {
      headers: {
        Accept: 'application/vnd.github+json',
        'User-Agent': 'openchamber-update-check',
      },
      signal: AbortSignal.timeout(10000),
    });
    if (!response.ok) return undefined;

    const release = await response.json();
    const apkAssets = Array.isArray(release?.assets)
      ? release.assets.filter((asset) => (
        typeof asset?.name === 'string'
        && asset.name.toLowerCase().endsWith('.apk')
        && typeof asset.browser_download_url === 'string'
      ))
      : [];
    const canonicalAsset = apkAssets.find((asset) => /^OpenChamber-.+-android\.apk$/i.test(asset.name));
    return (canonicalAsset || apkAssets[0])?.browser_download_url;
  } catch {
    return undefined;
  }
}

async function checkForUpdatesFromApi(currentVersion, options = {}) {
  try {
    const appType = normalizeAppType(options.appType);
    const hostPlatform = mapPlatform(process.platform);
    const hostArch = mapArch(process.arch);
    const shouldTrustClientPlatform = appType === 'desktop-electron' || appType === 'vscode' || appType === 'mobile-capacitor';
    const platform = shouldTrustClientPlatform ? normalizePlatform(options.platform) : hostPlatform;
    const arch = shouldTrustClientPlatform ? normalizeArch(options.arch) : hostArch;
    const reportUsage = options.reportUsage !== false;
    const payload = {
      appType,
      deviceClass: normalizeDeviceClass(options.deviceClass),
      platform,
      arch,
      channel: 'stable',
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
    const data = await response.json();
    if (typeof data?.latestVersion !== 'string') return null;

    const versionComparison = compareVersions(data.latestVersion, currentVersion);
    if (versionComparison < 0) return null;

    const releaseUrl = `${releasesWebUrl()}/tag/v${data.latestVersion}`;
    const downloadUrl = typeof data.downloadUrl === 'string'
      ? data.downloadUrl
      : typeof data.download?.url === 'string'
        ? data.download.url
        : undefined;
    const updateAvailable = Boolean(data.updateAvailable) && versionComparison > 0;
    const mobileDownloadUrl = updateAvailable && appType === 'mobile-capacitor' && platform === 'android'
      ? await resolveAndroidApkUrl(data.latestVersion, downloadUrl)
      : undefined;
    return {
      available: updateAvailable,
      version: data.latestVersion,
      currentVersion,
      body: typeof data.releaseNotes === 'string' ? data.releaseNotes : undefined,
      releaseUrl: typeof data.releaseNotesUrl === 'string' ? data.releaseNotesUrl : releaseUrl,
      downloadUrl: mobileDownloadUrl,
      nextSuggestedCheckInSec:
        typeof data.nextSuggestedCheckInSec === 'number' && Number.isFinite(data.nextSuggestedCheckInSec)
          ? data.nextSuggestedCheckInSec
          : undefined,
    };
  } catch {
    return null;
  }
}

function normalizePathForComparison(filePath) {
  if (!filePath || typeof filePath !== 'string') return null;
  const normalized = path.normalize(path.resolve(filePath));
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function getComparablePaths(filePath) {
  const paths = new Set();
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
  }

  return paths;
}

function pathSetContains(a, b) {
  for (const value of a) {
    if (b.has(value)) {
      return true;
    }
  }
  return false;
}

function getCurrentPackagePath() {
  return path.resolve(__dirname, '..', '..');
}

function getPackagePathForGlobalRoot(rootPath) {
  if (!rootPath) return null;
  return path.join(rootPath, ...PACKAGE_PATH_SEGMENTS);
}

function getUniquePaths(paths) {
  const seen = new Set();
  const result = [];
  for (const value of paths) {
    const normalized = normalizePathForComparison(value);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(path.resolve(value));
  }
  return result;
}

function getCommandOutput(command, args) {
  try {
    const result = spawnSync(command, args, {
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

function getGlobalBinDirs(pm) {
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

function getGlobalNodeModulesRoots(pm) {
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

function getOwnedPackagePathsFromGlobalBins(pm) {
  const packagePaths = [];
  for (const binDir of getGlobalBinDirs(pm)) {
    const binaryName = process.platform === 'win32' ? 'openchamber.cmd' : 'openchamber';
    const binaryPath = path.join(binDir, binaryName);
    if (!fs.existsSync(binaryPath)) continue;

    try {
      const realBinaryPath = fs.realpathSync.native ? fs.realpathSync.native(binaryPath) : fs.realpathSync(binaryPath);
      packagePaths.push(path.resolve(realBinaryPath, '..', '..'));
    } catch {
    }
  }

  return getUniquePaths(packagePaths);
}

function detectPackageManagerFromCurrentInstallPath() {
  return detectPackageManagerFromInstallPath(getCurrentPackagePath());
}

function packageManagerOwnsCurrentInstall(pm) {
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

export function detectPackageManagerDetails() {
  // In desktop (Electron) runtime, package-manager detection is worthless —
  // the app ships as a .app bundle, not installed via npm/pnpm/yarn/bun, and
  // updates are handled by electron-updater. The detection path does up to a
  // dozen spawnSync(pm, ['bin', '-g']) calls with 10s timeouts each; under
  // the in-process server every one blocks the Electron main event loop and
  // manifests as a multi-second UI freeze. Short-circuit here.
  if (process.env.OPENCHAMBER_RUNTIME === 'desktop') {
    return {
      packageManager: 'electron',
      reason: 'desktop-runtime',
      packagePath: null,
      packageManagerCommand: null,
      globalNodeModulesRoot: null,
    };
  }

  if (cachedDetectedPm) {
      return {
        packageManager: cachedDetectedPm,
        reason: 'cached',
        packagePath: getCurrentPackagePath(),
        packageManagerCommand: resolvePackageManagerCommand(cachedDetectedPm),
        globalNodeModulesRoot: getGlobalNodeModulesRoots(cachedDetectedPm)[0] || null,
      };
  }

  const forcedPm = process.env.OPENCHAMBER_PACKAGE_MANAGER?.trim();
  if (forcedPm && ['npm', 'pnpm', 'yarn', 'bun'].includes(forcedPm)) {
    const forcedPmCommand = resolvePackageManagerCommand(forcedPm);
    if (isCommandAvailable(forcedPmCommand)) {
      cachedDetectedPm = forcedPm;
      return {
        packageManager: cachedDetectedPm,
        reason: 'forced-env',
        packagePath: getCurrentPackagePath(),
        packageManagerCommand: forcedPmCommand,
        globalNodeModulesRoot: getGlobalNodeModulesRoots(cachedDetectedPm)[0] || null,
      };
    }
  }

  // First prefer the package manager that demonstrably owns the current install.
  const installPathPm = detectPackageManagerFromCurrentInstallPath();
  if (installPathPm && packageManagerOwnsCurrentInstall(installPathPm)) {
    cachedDetectedPm = installPathPm;
    return {
      packageManager: cachedDetectedPm,
      reason: 'install-path-owner',
      packagePath: getCurrentPackagePath(),
      packageManagerCommand: resolvePackageManagerCommand(cachedDetectedPm),
      globalNodeModulesRoot: getGlobalNodeModulesRoots(cachedDetectedPm)[0] || null,
    };
  }

  const ownershipCandidates = ['pnpm', 'yarn', 'bun', 'npm'];
  for (const candidate of ownershipCandidates) {
    if (packageManagerOwnsCurrentInstall(candidate)) {
      cachedDetectedPm = candidate;
      return {
        packageManager: cachedDetectedPm,
        reason: 'global-root-owner',
        packagePath: getCurrentPackagePath(),
        packageManagerCommand: resolvePackageManagerCommand(cachedDetectedPm),
        globalNodeModulesRoot: getGlobalNodeModulesRoots(cachedDetectedPm)[0] || null,
      };
    }
  }

  // Fall back to weaker hints only when ownership cannot be established.
  const userAgent = process.env.npm_config_user_agent || '';
  let hintedPm = null;
  if (userAgent.startsWith('pnpm')) hintedPm = 'pnpm';
  else if (userAgent.startsWith('yarn')) hintedPm = 'yarn';
  else if (userAgent.startsWith('bun')) hintedPm = 'bun';
  else if (userAgent.startsWith('npm')) hintedPm = 'npm';

  // Check execpath.
  const execPath = process.env.npm_execpath || '';
  if (!hintedPm) {
    if (execPath.includes('pnpm')) hintedPm = 'pnpm';
    else if (execPath.includes('yarn')) hintedPm = 'yarn';
    else if (execPath.includes('bun')) hintedPm = 'bun';
    else if (execPath.includes('npm')) hintedPm = 'npm';
  }

  // Detect from invoked binary path.
  const invokedPm = detectPackageManagerFromInvocationPath(process.argv?.[1]);
  if (!hintedPm) {
    hintedPm = invokedPm;
  }

  if (!hintedPm) {
    hintedPm = installPathPm;
  }

  // Validate the hint against package visibility, but only after ownership checks failed.
  if (hintedPm && isCommandAvailable(resolvePackageManagerCommand(hintedPm)) && isPackageInstalledWith(hintedPm)) {
    cachedDetectedPm = hintedPm;
    return {
      packageManager: cachedDetectedPm,
      reason: 'hinted-visible-install',
      packagePath: getCurrentPackagePath(),
      packageManagerCommand: resolvePackageManagerCommand(cachedDetectedPm),
      globalNodeModulesRoot: getGlobalNodeModulesRoots(cachedDetectedPm)[0] || null,
    };
  }

  const runtimePm = detectPackageManagerFromRuntimePath(process.execPath);
  if (runtimePm && isCommandAvailable(resolvePackageManagerCommand(runtimePm)) && isPackageInstalledWith(runtimePm)) {
    cachedDetectedPm = runtimePm;
    return {
      packageManager: cachedDetectedPm,
      reason: 'runtime-visible-install',
      packagePath: getCurrentPackagePath(),
      packageManagerCommand: resolvePackageManagerCommand(cachedDetectedPm),
      globalNodeModulesRoot: getGlobalNodeModulesRoots(cachedDetectedPm)[0] || null,
    };
  }

  // Last resort: pick a PM that can at least see the package.
  const pmChecks = [
    { name: 'pnpm', check: () => isCommandAvailable(resolvePackageManagerCommand('pnpm')) },
    { name: 'yarn', check: () => isCommandAvailable(resolvePackageManagerCommand('yarn')) },
    { name: 'bun', check: () => isCommandAvailable(resolvePackageManagerCommand('bun')) },
    { name: 'npm', check: () => isCommandAvailable(resolvePackageManagerCommand('npm')) },
  ];

  for (const { name, check } of pmChecks) {
    if (check()) {
      // Verify this PM actually has the package installed globally
      if (isPackageInstalledWith(name)) {
        cachedDetectedPm = name;
        return {
          packageManager: cachedDetectedPm,
          reason: 'last-resort-visible-install',
          packagePath: getCurrentPackagePath(),
          packageManagerCommand: resolvePackageManagerCommand(cachedDetectedPm),
          globalNodeModulesRoot: getGlobalNodeModulesRoots(cachedDetectedPm)[0] || null,
        };
      }
    }
  }

  cachedDetectedPm = 'npm';
  return {
    packageManager: cachedDetectedPm,
    reason: 'default-fallback',
    packagePath: getCurrentPackagePath(),
    packageManagerCommand: resolvePackageManagerCommand(cachedDetectedPm),
    globalNodeModulesRoot: getGlobalNodeModulesRoots(cachedDetectedPm)[0] || null,
  };
}

export function detectPackageManager() {
  return detectPackageManagerDetails().packageManager;
}

function detectPackageManagerFromInstallPath(pkgPath) {
  if (!pkgPath) return null;
  const normalized = pkgPath.replace(/\\/g, '/').toLowerCase();
  if (normalized.includes('/.pnpm/') || normalized.includes('/pnpm/')) return 'pnpm';
  if (normalized.includes('/.yarn/')) return 'yarn';
  if (normalized.includes('/.bun/') || normalized.includes('/bun/install/')) return 'bun';
  if (normalized.includes('/node_modules/')) return 'npm';
  return null;
}

function detectPackageManagerFromRuntimePath(runtimePath) {
  if (!runtimePath || typeof runtimePath !== 'string') return null;
  const normalized = runtimePath.replace(/\\/g, '/').toLowerCase();
  if (normalized.includes('/.bun/bin/bun') || normalized.endsWith('/bun') || normalized.endsWith('/bun.exe')) {
    return 'bun';
  }
  if (normalized.includes('/pnpm/')) return 'pnpm';
  if (normalized.includes('/yarn/')) return 'yarn';
  if (normalized.includes('/node') || normalized.endsWith('/node.exe')) return 'npm';
  return null;
}

function detectPackageManagerFromInvocationPath(invokedPath) {
  if (!invokedPath || typeof invokedPath !== 'string') return null;
  const normalized = invokedPath.replace(/\\/g, '/').toLowerCase();
  if (normalized.includes('/.bun/bin/')) return 'bun';
  if (normalized.includes('/.pnpm/')) return 'pnpm';
  if (normalized.includes('/.yarn/')) return 'yarn';
  return null;
}

function getPackageManagerCommandCandidates(pm) {
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

function resolvePackageManagerCommand(pm) {
  const candidates = getPackageManagerCommandCandidates(pm);
  for (const candidate of candidates) {
    if (isCommandAvailable(candidate)) {
      return candidate;
    }
  }
  return pm;
}

function quoteCommand(command) {
  if (!command) return command;
  if (!/\s/.test(command)) return command;
  if (process.platform === 'win32') {
    return `"${command.replace(/"/g, '""')}"`;
  }
  return `'${command.replace(/'/g, "'\\''")}'`;
}

function isCommandAvailable(command) {
  try {
    const result = spawnSync(command, ['--version'], {
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

function isPackageInstalledWith(pm) {
  try {
    const pmCommand = resolvePackageManagerCommand(pm);
    let args;
    switch (pm) {
      case 'pnpm':
        args = ['list', '-g', '--depth=0', PACKAGE_NAME];
        break;
      case 'yarn':
        args = ['global', 'list', '--depth=0'];
        break;
      case 'bun':
        args = ['pm', 'ls', '-g'];
        break;
      default:
        args = ['list', '-g', '--depth=0', PACKAGE_NAME];
    }

    const result = spawnSync(pmCommand, args, {
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

/**
 * Get the update command for the detected package manager.
 *
 * `target` is whatever the package manager should install. It defaults to the
 * npm package; a fork passes the tarball URL from its own release instead,
 * because it publishes no npm package and `@latest` would fetch the official
 * build over it. Every supported package manager installs a URL with the same
 * subcommand it uses for a package name.
 */
export function getUpdateCommand(pm = detectPackageManager(), target = `${PACKAGE_NAME}@latest`) {
  const pmCommand = quoteCommand(resolvePackageManagerCommand(pm));
  const quotedTarget = quoteCommand(target);
  switch (pm) {
    case 'pnpm':
      return `${pmCommand} add -g ${quotedTarget}`;
    case 'yarn':
      return `${pmCommand} global add ${quotedTarget}`;
    case 'bun':
      return `${pmCommand} add -g ${quotedTarget}`;
    default:
      return `${pmCommand} install -g ${quotedTarget}`;
  }
}

/**
 * Get current installed version from package.json
 */
export function getCurrentVersion() {
  try {
    const pkgPath = path.resolve(__dirname, '..', '..', 'package.json');
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    return pkg.version || 'unknown';
  } catch {
    return 'unknown';
  }
}

/**
 * Fetch latest version from npm registry
 */
async function getLatestVersion() {
  try {
    const response = await fetch(NPM_REGISTRY_URL, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(10000),
    });

    if (!response.ok) {
      throw new Error(`Registry responded with ${response.status}`);
    }

    const data = await response.json();
    return data['dist-tags']?.latest || null;
  } catch (error) {
    return null;
  }
}

/**
 * Compare semver-like version strings.
 */
function parseVersionForComparison(value) {
  const normalized = String(value || '').replace(/^v/, '').split('+')[0];
  const prereleaseIndex = normalized.indexOf('-');
  const core = prereleaseIndex >= 0 ? normalized.slice(0, prereleaseIndex) : normalized;
  const parts = core.split('.').map((part) => {
    const parsed = Number.parseInt(part || '0', 10);
    return Number.isFinite(parsed) ? parsed : 0;
  });

  return {
    parts,
    prerelease: prereleaseIndex >= 0,
  };
}

function compareVersions(left, right) {
  const a = parseVersionForComparison(left);
  const b = parseVersionForComparison(right);
  const length = Math.max(a.parts.length, b.parts.length);

  for (let index = 0; index < length; index += 1) {
    const diff = (a.parts[index] || 0) - (b.parts[index] || 0);
    if (diff !== 0) return diff;
  }

  if (a.prerelease !== b.prerelease) {
    return a.prerelease ? -1 : 1;
  }

  return 0;
}

/** Release notes between the installed and the offered version, or undefined. */
async function fetchChangelogNotes(fromVersion, toVersion) {
  return (await fetchUpdateNotes(fromVersion, toVersion, compareVersions)) ?? undefined;
}

export async function checkForUpdates(options = {}) {
  const currentVersion = options.currentVersion || getCurrentVersion();
  const pm = detectPackageManager();
  const appType = normalizeAppType(options.appType);
  const platform = normalizePlatform(options.platform);

  const forkSource = getForkReleaseSource();
  if (forkSource) {
    try {
      return { ...await checkForkRelease(currentVersion, forkSource), packageManager: pm };
    } catch (error) {
      return {
        available: false,
        currentVersion,
        error: error instanceof Error ? error.message : 'Failed to check the fork release',
      };
    }
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
  let changelog;
  let downloadUrl;
  if (available) {
    changelog = await fetchChangelogNotes(currentVersion, latestVersion);
    if (appType === 'mobile-capacitor' && platform === 'android') {
      downloadUrl = await resolveAndroidApkUrl(latestVersion);
    }
  }

  return {
    available,
    version: latestVersion,
    currentVersion,
    body: changelog,
    releaseUrl: `${releasesWebUrl()}/tag/v${latestVersion}`,
    downloadUrl,
    packageManager: pm,
    // Show our CLI command, not raw package manager command
    updateCommand: 'openchamber update',
  };
}

/**
 * Execute the update (used by CLI)
 */
export function executeUpdate(pm = detectPackageManager(), options = {}) {
  const command = options?.target ? getUpdateCommand(pm, options.target) : getUpdateCommand(pm);
  if (!options?.silent) {
    console.log(`Updating ${PACKAGE_NAME} using ${pm}...`);
    console.log(`Running: ${command}`);
  }

  const result = spawnSync(command, {
    stdio: 'inherit',
    shell: true,
    ...getSpawnSyncBaseOptions(),
  });

  return {
    success: result.status === 0,
    exitCode: result.status,
  };
}
