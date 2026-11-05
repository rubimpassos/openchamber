// Installs OpenChamber system-wide on a Linux host and keeps it updated:
// root-owned code, a system unit that runs it as the owner account, the
// protected MCP service, and a root updater the owner can only ask to run.
// Runs as root; never by the running OpenChamber.
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createIntegrity } from '../protected-mcp/service/integrity.js';
import {
  install as installProtectedMcp,
  uninstall as uninstallProtectedMcp,
} from '../protected-mcp/service/install.js';
import { compareVersions } from '../version-order.js';
import { HOST_CONFIG_FILE, HOST_INSTALL_DIR, HOST_REQUEST_DIR } from './managed.js';
import { downloadRelease, findRelease, REPO_PATTERN, VERSION_PATTERN } from './release.js';

export const APP_UNIT = 'openchamber.service';
export const UPDATER_UNIT = 'openchamber-updater.service';
export const UPDATER_TIMER = 'openchamber-updater.timer';
export const UPDATER_PATH = 'openchamber-updater.path';
const MANAGED_MARKER = '# Managed by the OpenChamber host installer.';
const PACKAGE_SUBDIR = path.join('node_modules', '@openchamber', 'web');
const MIN_NODE = [24, 14];
const NODE_CANDIDATES = ['/usr/bin/node', '/usr/local/bin/node'];
const NPM_CANDIDATES = ['/usr/lib/node_modules/npm/bin/npm-cli.js', '/usr/local/lib/node_modules/npm/bin/npm-cli.js'];

class HostInstallError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

const refuse = (code, message) => {
  throw new HostInstallError(code, message);
};

/** Where everything lives, below an optional root for test installs. */
export function layout(root = '/') {
  const at = (target) => path.join(root, target);
  const live = {
    installDir: HOST_INSTALL_DIR,
    current: `${HOST_INSTALL_DIR}/current`,
    app: `${HOST_INSTALL_DIR}/current/${PACKAGE_SUBDIR}`,
    configFile: HOST_CONFIG_FILE,
    envFile: '/etc/openchamber/openchamber.env',
    requestDir: HOST_REQUEST_DIR,
    requestFile: `${HOST_REQUEST_DIR}/update`,
    cacheDir: '/var/cache/openchamber-host',
    binLink: '/usr/local/bin/openchamber',
    unitDir: '/etc/systemd/system',
  };
  return {
    live,
    installDir: at(live.installDir),
    configFile: at(live.configFile),
    envFile: at(live.envFile),
    requestDir: at(live.requestDir),
    requestFile: at(live.requestFile),
    cacheDir: at(live.cacheDir),
    binLink: at(live.binLink),
    unit: (name) => at(path.join(live.unitDir, name)),
  };
}

const run = (command, args, options = {}) => new Promise((resolve, reject) => {
  execFile(command, args, { timeout: 60_000, maxBuffer: 16 * 1024 * 1024, ...options }, (error, stdout, stderr) => {
    if (error) reject(Object.assign(new Error(`${command} ${args[0] ?? ''} failed: ${String(stderr).trim().slice(-2000)}`), { stderr: String(stderr) }));
    else resolve(String(stdout));
  });
});

/** The privileged operations, injectable so a test can record them over a temporary root. */
function createSystem() {
  return {
    trustedOwners: [0],
    isRoot: () => process.getuid() === 0,
    hasSystemd: () => fs.stat('/run/systemd/system').then(() => true, () => false),
    async account(user) {
      const entry = (await run('getent', ['passwd', '--', user]).catch(() => '')).trim();
      if (!entry) refuse('owner_unknown', `There is no account "${user}"`);
      const [, , uid, gid, , home] = entry.split(':');
      const gids = (await run('id', ['-G', '--', user])).trim().split(/\s+/).map(Number);
      return { name: user, uid: Number(uid), gid: Number(gid), gids, home };
    },
    chown: (target, uid, gid) => fs.lchown(target, uid, gid),
    systemctl: (args) => run('systemctl', args),
    isActive: (unit) => run('systemctl', ['is-active', unit]).then((out) => out.trim(), (error) => String(error.stderr ?? '').trim() || 'inactive'),
    nodeVersion: (node) => run(node, ['--version']),
    npm: (node, npmCli, args, env) => run(node, [npmCli, ...args], { timeout: 15 * 60_000, env }),
    // As the owner: OpenCode lives in the owner's home, and root never runs what the owner can write.
    installOpenCode: (owner, node, app) => run('runuser', ['-u', owner.name, '--', 'env', `HOME=${owner.home}`, 'PATH=/usr/local/bin:/usr/bin:/bin', node, '--input-type=module', '-e',
      `const { installOpenCodeV2 } = await import(${JSON.stringify(`${app}/server/lib/opencode/v2-install.js`)}); process.stdout.write(await installOpenCodeV2());`], { timeout: 10 * 60_000, cwd: '/' }),
    findRelease,
    downloadRelease,
    async health(url) {
      const response = await fetch(url, { signal: AbortSignal.timeout(2000) });
      return response.ok ? response.json() : null;
    },
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    protectedMcp: { install: installProtectedMcp, uninstall: uninstallProtectedMcp },
  };
}

const readJson = async (file) => {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
};

const exists = (target) => fs.lstat(target).then(() => true, () => false);

const integrityFor = (system, owner) => createIntegrity({ owners: system.trustedOwners, groups: [0], engine: { uid: owner.uid, gids: owner.gids } });

async function requireTrusted(system, owner, target, code) {
  const { findings } = await integrityFor(system, owner).inspect(target);
  if (findings.length > 0) refuse(code, `${target}: ${findings.map((finding) => `${finding.code} ${finding.subject}`).join(', ')}`);
}

/** A Node.js and npm the owner account cannot replace. */
async function trustedToolchain(system, owner, root) {
  let node = null;
  for (const candidate of NODE_CANDIDATES) {
    if (!await exists(path.join(root, candidate))) continue;
    await requireTrusted(system, owner, path.join(root, candidate), 'untrusted_node');
    const match = /^v(\d+)\.(\d+)/.exec((await system.nodeVersion(path.join(root, candidate))).trim());
    const version = match ? [Number(match[1]), Number(match[2])] : [0, 0];
    if (version[0] < MIN_NODE[0] || (version[0] === MIN_NODE[0] && version[1] < MIN_NODE[1])) {
      refuse('node_too_old', `${candidate} must be Node.js ${MIN_NODE.join('.')} or newer`);
    }
    node = candidate;
    break;
  }
  if (!node) refuse('node_missing', `Install Node.js ${MIN_NODE.join('.')}+ system-wide at /usr/bin/node, owned by root, then run this again`);
  for (const candidate of NPM_CANDIDATES) {
    if (!await exists(path.join(root, candidate))) continue;
    await requireTrusted(system, owner, path.join(root, candidate), 'untrusted_npm');
    return { node, npm: candidate };
  }
  return refuse('npm_missing', 'Install npm system-wide with Node.js, owned by root, then run this again');
}

const writeRootFile = async (system, file, content, mode = 0o644) => {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o755 });
  const temporary = `${file}.${randomBytes(4).toString('hex')}`;
  await fs.writeFile(temporary, content, { mode });
  await fs.chmod(temporary, mode);
  await system.chown(temporary, 0, 0);
  await fs.rename(temporary, file);
};

const replaceSymlink = async (link, destination) => {
  const temporary = `${link}.${randomBytes(4).toString('hex')}`;
  await fs.symlink(destination, temporary);
  await fs.rename(temporary, link);
};

/**
 * Root owns every installed file, only root can write them, and the owner
 * account can read them all: root's umask may be 077, and npm extracts with it.
 */
async function sealTree(system, directory) {
  for (const entry of await fs.readdir(directory, { recursive: true, withFileTypes: true })) {
    const full = path.join(entry.parentPath, entry.name);
    await system.chown(full, 0, 0);
    if (entry.isSymbolicLink()) continue;
    const executable = entry.isDirectory() || ((await fs.stat(full)).mode & 0o111) !== 0;
    await fs.chmod(full, executable ? 0o755 : 0o644);
  }
  await system.chown(directory, 0, 0);
  await fs.chmod(directory, 0o755);
}

/**
 * Installs the package into a new `<installDir>/<version>-<random>` and returns
 * that directory's name. A fresh name never touches the directory the running
 * server loads from, also when the same version is installed again.
 */
async function installPackage({ system, paths, toolchain, root, tarball, version }) {
  await fs.mkdir(paths.installDir, { recursive: true, mode: 0o755 });
  await system.chown(paths.installDir, 0, 0);
  await fs.chmod(paths.installDir, 0o755);
  await fs.mkdir(paths.cacheDir, { recursive: true, mode: 0o700 });
  const staging = path.join(paths.installDir, `.staging-${randomBytes(4).toString('hex')}`);
  const name = `${version}-${randomBytes(4).toString('hex')}`;
  try {
    await fs.mkdir(staging, { mode: 0o755 });
    await system.npm(path.join(root, toolchain.node), path.join(root, toolchain.npm), [
      // Only the top package is checked against a digest, so no dependency runs code as root.
      // node-pty and ripgrep ship their Linux binaries in the packages themselves.
      'install', '--prefix', staging, '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund', '--no-update-notifier', tarball,
    ], {
      PATH: '/usr/local/bin:/usr/bin:/bin',
      HOME: paths.cacheDir,
      npm_config_cache: path.join(paths.cacheDir, 'npm'),
      npm_config_userconfig: '/dev/null',
    });
    const installed = await readJson(path.join(staging, PACKAGE_SUBDIR, 'package.json'));
    if (installed?.name !== '@openchamber/web' || installed.version !== version) {
      refuse('package_mismatch', `The package installed ${installed?.name ?? '?'}@${installed?.version ?? '?'}, expected @openchamber/web@${version}`);
    }
    // A release without the updater would leave the host with no way to update again.
    if (!await exists(path.join(staging, PACKAGE_SUBDIR, 'server/lib/host-install/main.js'))) {
      refuse('no_host_installer', `OpenChamber ${version} has no host installer, so it cannot be installed system-wide`);
    }
    await sealTree(system, staging);
    await fs.rename(staging, path.join(paths.installDir, name));
  } finally {
    await fs.rm(staging, { recursive: true, force: true });
  }
  return name;
}

/** The version installed where `link` points, or null. */
async function linkedVersion(paths, link) {
  const target = await fs.readlink(path.join(paths.installDir, link)).catch(() => null);
  if (!target) return null;
  return (await readJson(path.join(paths.installDir, target, PACKAGE_SUBDIR, 'package.json')).catch(() => null))?.version ?? null;
}

const writeConfig = (system, paths, config) => writeRootFile(system, paths.configFile, `${JSON.stringify(config, null, 2)}\n`);

/** Installs the protected MCP service from the OpenChamber tree in `appDir`; a refusal is reported, not thrown. */
async function installProtectedMcpFrom({ system, root, paths, config, owner, appDir, version, say }) {
  if (!config.protectedMcp) return { status: 'disabled' };
  try {
    const result = await system.protectedMcp.install({
      root,
      source: path.join(paths.installDir, appDir, PACKAGE_SUBDIR, 'server'),
      version,
      engineUser: owner.name,
      engineUnit: APP_UNIT,
      acceptUnprotected: config.acceptUnprotected,
      say,
    });
    say(`Protected MCP service ${version} is running; boundary status ${result.preflight.status}.`);
    return { status: 'installed', boundary: result.preflight.status };
  } catch (error) {
    say(`The protected MCP service ${version} was not installed: ${error.message}`);
    return { status: 'failed', code: error.code ?? 'failed', message: error.message };
  }
}

const quoteUnitArg = (value) => `"${String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

const ownerPath = (owner) => [`${owner.home}/.local/bin`, `${owner.home}/.opencode/bin`, `${owner.home}/.bun/bin`, '/usr/local/bin', '/usr/bin', '/bin'];

/** OpenChamber starts only with an `opencode` on the unit's PATH; when the owner has none, it is installed for them. */
async function ensureOpenCode({ system, root, owner, toolchain, app, say }) {
  for (const directory of ownerPath(owner)) {
    if (await fs.access(path.join(root, directory, 'opencode'), fs.constants.X_OK).then(() => true, () => false)) return;
  }
  say(`${owner.name} has no OpenCode; installing it in ${owner.home}/.opencode/bin.`);
  try {
    await system.installOpenCode(owner, toolchain.node, app);
  } catch (error) {
    refuse('opencode_install_failed', `OpenCode could not be installed for ${owner.name}: ${error.message}. Install it as ${owner.name} (https://opencode.ai) and run this again`);
  }
}

function appUnit({ config, owner, toolchain, live }) {
  const pathEnv = ownerPath(owner).join(':');
  return `${MANAGED_MARKER}
# Add settings in /etc/systemd/system/${APP_UNIT}.d/*.conf; this file is rewritten on every update.
[Unit]
Description=OpenChamber
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=${owner.name}
Group=${owner.gid}
WorkingDirectory=${owner.home}
Environment=HOME=${owner.home}
Environment=${quoteUnitArg(`PATH=${pathEnv}`)}
Environment=OPENCHAMBER_UPDATE_REPO=${config.repo}
EnvironmentFile=-${live.envFile}
ExecStart=${toolchain.node} ${live.app}/bin/cli.js serve --foreground --port ${config.port} --host ${quoteUnitArg(config.host)}
Restart=always
RestartSec=5
# A graceful shutdown on SIGTERM exits 143; a stop is not a failure.
SuccessExitStatus=143
NoNewPrivileges=yes
ProtectSystem=full
UMask=0077

[Install]
WantedBy=multi-user.target
`;
}

function updaterUnits({ toolchain, live }) {
  return {
    [UPDATER_UNIT]: `${MANAGED_MARKER}
[Unit]
Description=OpenChamber host updater
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
ExecStart=${toolchain.node} ${live.app}/server/lib/host-install/main.js update
NoNewPrivileges=yes
PrivateTmp=yes
`,
    [UPDATER_TIMER]: `${MANAGED_MARKER}
[Unit]
Description=Check for OpenChamber updates daily

[Timer]
OnCalendar=daily
RandomizedDelaySec=1h
Persistent=true

[Install]
WantedBy=timers.target
`,
    [UPDATER_PATH]: `${MANAGED_MARKER}
[Unit]
Description=Run the OpenChamber updater when OpenChamber asks for an update

[Path]
PathChanged=${live.requestFile}
Unit=${UPDATER_UNIT}

[Install]
WantedBy=paths.target
`,
  };
}

/** A unit file this installer did not write is someone else's; it is never replaced. */
async function requireOwnUnit(file) {
  const content = await fs.readFile(file, 'utf8').catch((error) => (error.code === 'ENOENT' ? null : Promise.reject(error)));
  if (content !== null && !content.startsWith(MANAGED_MARKER)) {
    refuse('unit_conflict', `${file} was not written by this installer. Move its settings into a drop-in or remove it, then run this again`);
  }
}

const healthUrl = (config) => {
  const host = config.host === '0.0.0.0' || config.host === '::' ? '127.0.0.1' : config.host;
  return `http://${host.includes(':') ? `[${host}]` : host}:${config.port}/health`;
};

/** Waits until the restarted OpenChamber answers with `version`. */
async function waitForVersion(system, config, version, timeoutMs = 90_000) {
  for (let waited = 0; waited < timeoutMs; waited += 1000) {
    const body = await system.health(healthUrl(config)).catch(() => null);
    if (body?.openchamberVersion === version) return true;
    await system.sleep(1000);
  }
  return false;
}

/** Removes installed versions other than `current` and `previous`. */
async function pruneVersions(paths) {
  const keep = new Set();
  for (const link of ['current', 'previous']) {
    const target = await fs.readlink(path.join(paths.installDir, link)).catch(() => null);
    if (target) keep.add(target);
  }
  for (const entry of await fs.readdir(paths.installDir)) {
    if (entry === 'current' || entry === 'previous' || keep.has(entry) || entry.startsWith('.staging-')) continue;
    await fs.rm(path.join(paths.installDir, entry), { recursive: true, force: true });
  }
}

/**
 * Puts `version` in place and running: package, units, protected MCP service,
 * restart. When anything after the switch fails, or the new version does not
 * come up, `current` and `previous` go back to what they were, the protected
 * MCP service follows, the version that ran before is restarted, and the
 * failed version is held back from later automatic updates.
 */
async function deploy({ system, root, paths, config, owner, toolchain, tarball, version, say }) {
  const dirName = await installPackage({ system, paths, toolchain, root, tarball, version });
  const app = path.join(paths.live.installDir, dirName, PACKAGE_SUBDIR);
  await requireTrusted(system, owner, path.join(paths.installDir, dirName, PACKAGE_SUBDIR, 'bin', 'cli.js'), 'installed_tree_untrusted');
  await ensureOpenCode({ system, root, owner, toolchain, app, say });

  const currentLink = path.join(paths.installDir, 'current');
  const previousLink = path.join(paths.installDir, 'previous');
  const before = { current: await fs.readlink(currentLink).catch(() => null), previous: await fs.readlink(previousLink).catch(() => null) };
  const beforeVersion = await linkedVersion(paths, 'current');
  const goBack = async (reason) => {
    if (before.current) await replaceSymlink(currentLink, before.current);
    else await fs.rm(currentLink, { force: true });
    if (before.previous) await replaceSymlink(previousLink, before.previous);
    else await fs.rm(previousLink, { force: true });
    if (before.current) await installProtectedMcpFrom({ system, root, paths, config, owner, appDir: before.current, version: beforeVersion, say });
    await writeConfig(system, paths, { ...config, skipVersion: version });
    if (before.current) await system.systemctl(['restart', APP_UNIT]).catch(() => {});
    refuse(reason.code, before.current
      ? `${reason.message} OpenChamber ${beforeVersion} runs again, and automatic updates skip ${version}`
      : reason.message);
  };

  if (before.current) await replaceSymlink(previousLink, before.current);
  await replaceSymlink(currentLink, dirName);
  say(`Installed OpenChamber ${version} in ${path.join(paths.live.installDir, dirName)}.`);
  let protectedMcp;
  try {
    const units = { [APP_UNIT]: appUnit({ config, owner, toolchain, live: paths.live }), ...updaterUnits({ toolchain, live: paths.live }) };
    for (const [name, content] of Object.entries(units)) await writeRootFile(system, paths.unit(name), content);
    await system.systemctl(['daemon-reload']);

    // Before OpenChamber starts, so its process gets the service's groups.
    protectedMcp = await installProtectedMcpFrom({ system, root, paths, config, owner, appDir: dirName, version, say });

    await system.systemctl(['enable', APP_UNIT, UPDATER_PATH]);
    await system.systemctl([config.autoUpdate ? 'enable' : 'disable', '--now', UPDATER_TIMER]);
    await system.systemctl(['start', UPDATER_PATH]);
    await system.systemctl(['restart', APP_UNIT]);
  } catch (error) {
    await goBack({ code: error.code ?? 'deploy_failed', message: `Installing OpenChamber ${version} failed: ${error.message}.` });
  }
  if (!await waitForVersion(system, config, version)) {
    await goBack({ code: 'not_started', message: `OpenChamber ${version} did not start; journalctl -u ${APP_UNIT} tells why.` });
  }
  say(`OpenChamber ${version} is running on ${config.host}:${config.port} as ${owner.name}.`);
  await pruneVersions(paths);
  return { version, previous: beforeVersion, protectedMcp };
}

/** Request directory: the owner may create the request file, nothing else. */
async function prepareRequestDir(system, paths, owner) {
  await fs.mkdir(path.dirname(paths.requestDir), { recursive: true, mode: 0o755 });
  await system.chown(path.dirname(paths.requestDir), 0, 0);
  await fs.chmod(path.dirname(paths.requestDir), 0o755);
  await fs.mkdir(paths.requestDir, { recursive: true, mode: 0o700 });
  await system.chown(paths.requestDir, owner.uid, owner.gid);
  await fs.chmod(paths.requestDir, 0o700);
}

/** `/usr/local/bin/openchamber`, unless something else already has that name. */
async function linkCommand(paths, say) {
  const target = path.join(paths.live.app, 'bin', 'cli.js');
  const existing = await fs.readlink(paths.binLink).catch((error) => (error.code === 'ENOENT' ? null : 'other'));
  if (existing !== null && existing !== target) {
    say(`${paths.live.binLink} already exists and was left as it is.`);
    return;
  }
  await fs.mkdir(path.dirname(paths.binLink), { recursive: true, mode: 0o755 });
  await replaceSymlink(paths.binLink, target);
}

async function prepare(system) {
  if (!system.isRoot()) refuse('root_required', 'Run this as root');
  if (!await system.hasSystemd()) refuse('systemd_required', 'The host install needs systemd');
}

/** Fetches the release's web package into the cache, unless `tarball` already holds it. */
async function obtainPackage({ system, paths, config, tarball, version, release = null }) {
  if (tarball) {
    if (!VERSION_PATTERN.test(version ?? '')) refuse('invalid_version', 'Give --version with --tarball');
    return { tarball, version, cleanup: async () => {} };
  }
  release ??= await system.findRelease({ repo: config.repo });
  await fs.mkdir(paths.cacheDir, { recursive: true, mode: 0o700 });
  const file = path.join(paths.cacheDir, `openchamber-web-${release.version}-${randomBytes(4).toString('hex')}.tgz`);
  await system.downloadRelease(release, file);
  return { tarball: file, version: release.version, cleanup: () => fs.rm(file, { force: true }) };
}

/**
 * Installs or reinstalls OpenChamber for `owner`. Options left out keep their
 * value from an earlier install.
 */
export async function install({
  root = '/', system = createSystem(), say = () => {},
  owner: ownerName, repo, port, host, autoUpdate, protectedMcp, acceptUnprotected, tarball = null, version = null,
}) {
  await prepare(system);
  const paths = layout(root);
  const existing = await readJson(paths.configFile);
  const config = {
    version: 1,
    owner: ownerName ?? existing?.owner,
    repo: repo ?? existing?.repo,
    port: port ?? existing?.port ?? 3000,
    host: host ?? existing?.host ?? '127.0.0.1',
    autoUpdate: autoUpdate ?? existing?.autoUpdate ?? true,
    protectedMcp: protectedMcp ?? existing?.protectedMcp ?? true,
    acceptUnprotected: acceptUnprotected ?? existing?.acceptUnprotected ?? false,
  };
  if (!config.owner || config.owner.startsWith('-')) refuse('owner_required', 'Give --owner with the account OpenChamber runs as');
  if (!REPO_PATTERN.test(config.repo ?? '')) refuse('repo_required', 'Give --repo with the GitHub repository whose releases to install, as owner/name');
  if (!Number.isInteger(config.port) || config.port < 1 || config.port > 65535) refuse('invalid_port', `Invalid port ${config.port}`);
  if (!/^[0-9A-Za-z.:-]{1,255}$/.test(config.host)) refuse('invalid_host', `Invalid host ${config.host}`);
  const owner = await system.account(config.owner);
  if (owner.uid === 0) refuse('owner_is_root', 'OpenChamber must not run as root; give the account of the person who uses it');
  if (existing?.owner && existing.owner !== owner.name) refuse('owner_changed', `This host is installed for ${existing.owner}. Uninstall first to change the owner`);
  for (const name of [APP_UNIT, UPDATER_UNIT, UPDATER_TIMER, UPDATER_PATH]) await requireOwnUnit(paths.unit(name));
  const toolchain = await trustedToolchain(system, owner, root);
  if (await exists(path.join(root, owner.home, '.config/systemd/user', APP_UNIT))) {
    say(`${owner.name} also has a user unit ${APP_UNIT}. Turn it off as ${owner.name}: systemctl --user disable --now ${APP_UNIT}`);
  }

  const source = await obtainPackage({ system, paths, config, tarball, version });
  try {
    await writeConfig(system, paths, config);
    if (!await exists(paths.envFile)) await writeRootFile(system, paths.envFile, '# Environment for OpenChamber, such as OPENCHAMBER_UI_PASSWORD=...\n', 0o600);
    await prepareRequestDir(system, paths, owner);
    const result = await deploy({ system, root, paths, config, owner, toolchain, tarball: source.tarball, version: source.version, say });
    await linkCommand(paths, say);
    return { ...result, config };
  } finally {
    await source.cleanup();
  }
}

/** Takes the request file away; an owner who made it something else only blocks their own requests. */
async function consumeRequest(paths, say) {
  const entry = await fs.lstat(paths.requestFile).catch(() => null);
  if (!entry) return;
  if (entry.isDirectory()) await fs.rmdir(paths.requestFile).catch(() => say(`${paths.live.requestFile} is a directory that is not empty; remove it to ask for updates again.`));
  else await fs.unlink(paths.requestFile);
}

/**
 * Installs the repository's latest release when it is newer than the running
 * one and is not the version a rollback held back. A pending request from
 * OpenChamber is consumed first. With `tarball`, that package is installed
 * whatever its version.
 */
export async function update({ root = '/', system = createSystem(), say = () => {}, tarball = null, version = null }) {
  await prepare(system);
  const paths = layout(root);
  await consumeRequest(paths, say);
  const config = await readJson(paths.configFile);
  if (!config) refuse('not_installed', 'OpenChamber is not installed on this host');
  const current = await linkedVersion(paths, 'current');
  const owner = await system.account(config.owner);
  const toolchain = await trustedToolchain(system, owner, root);

  const release = tarball ? null : await system.findRelease({ repo: config.repo });
  if (release && current && compareVersions(release.version, current) <= 0) {
    say(`OpenChamber ${current} is up to date.`);
    return { version: current, updated: false };
  }
  if (release && release.version === config.skipVersion) {
    say(`OpenChamber ${release.version} was rolled back on this host, so ${current} stays. Install it explicitly to try it again.`);
    return { version: current, updated: false, skipped: release.version };
  }
  const source = await obtainPackage({ system, paths, config, tarball, version, release });
  try {
    say(`Updating OpenChamber ${current ?? 'none'} -> ${source.version}.`);
    const result = await deploy({ system, root, paths, config, owner, toolchain, tarball: source.tarball, version: source.version, say });
    return { ...result, updated: true };
  } finally {
    await source.cleanup();
  }
}

/** Runs the previous version again and holds the one it leaves back from automatic updates. */
export async function rollback({ root = '/', system = createSystem(), say = () => {} }) {
  await prepare(system);
  const paths = layout(root);
  const previousDir = await fs.readlink(path.join(paths.installDir, 'previous')).catch(() => null);
  if (!previousDir) refuse('no_previous_version', 'There is no earlier version to go back to');
  const config = await readJson(paths.configFile);
  const leaving = await linkedVersion(paths, 'current');
  const currentDir = await fs.readlink(path.join(paths.installDir, 'current'));
  await replaceSymlink(path.join(paths.installDir, 'current'), previousDir);
  await replaceSymlink(path.join(paths.installDir, 'previous'), currentDir);
  const version = await linkedVersion(paths, 'current');
  await installProtectedMcpFrom({ system, root, paths, config, owner: await system.account(config.owner), appDir: previousDir, version, say });
  await writeConfig(system, paths, { ...config, skipVersion: leaving });
  await system.systemctl(['restart', APP_UNIT]);
  say(`OpenChamber ${version} runs again; automatic updates skip ${leaving}.`);
  return { version, skipped: leaving };
}

/**
 * Takes the request directory from the owner before emptying it, and never
 * deletes recursively in it: the owner could swap an entry for a link while
 * root walks it.
 */
async function removeRequestDir(system, paths) {
  if (!await exists(paths.requestDir)) return;
  await system.chown(paths.requestDir, 0, 0);
  await fs.chmod(paths.requestDir, 0o700);
  for (const entry of await fs.readdir(paths.requestDir, { withFileTypes: true })) {
    const full = path.join(paths.requestDir, entry.name);
    await (entry.isDirectory() ? fs.rmdir(full) : fs.unlink(full)).catch(() => {});
  }
  await fs.rmdir(paths.requestDir).catch(() => {});
  await fs.rmdir(path.dirname(paths.requestDir)).catch(() => {});
}

/**
 * Removes the host install. The environment file, which may hold a password,
 * and the protected MCP credentials stay unless `purge` is set.
 */
export async function uninstall({ root = '/', system = createSystem(), say = () => {}, purge = false }) {
  if (!system.isRoot()) refuse('root_required', 'Run this as root');
  const paths = layout(root);
  const config = await readJson(paths.configFile);
  for (const name of [APP_UNIT, UPDATER_UNIT, UPDATER_TIMER, UPDATER_PATH]) await requireOwnUnit(paths.unit(name));
  for (const name of [UPDATER_TIMER, UPDATER_PATH, APP_UNIT]) await system.systemctl(['disable', '--now', name]).catch(() => {});
  if (config?.protectedMcp !== false) {
    await system.protectedMcp.uninstall({ root, engineUser: config?.owner ?? null, purgeState: purge }).catch((error) => say(`The protected MCP service was not removed: ${error.message}`));
  }
  for (const name of [APP_UNIT, UPDATER_UNIT, UPDATER_TIMER, UPDATER_PATH]) await fs.rm(paths.unit(name), { force: true });
  await system.systemctl(['daemon-reload']).catch(() => {});
  if (await fs.readlink(paths.binLink).catch(() => null) === path.join(paths.live.app, 'bin', 'cli.js')) await fs.rm(paths.binLink, { force: true });
  await fs.rm(paths.installDir, { recursive: true, force: true });
  await removeRequestDir(system, paths);
  await fs.rm(paths.cacheDir, { recursive: true, force: true });
  await fs.rm(paths.configFile, { force: true });
  if (purge) await fs.rm(paths.envFile, { force: true });
  say(purge ? 'Removed OpenChamber, its settings and the protected MCP credentials.' : `Removed OpenChamber. ${paths.live.envFile} and the protected MCP credentials stay for a reinstall.`);
  return { purged: purge };
}

/** What is installed and running. Needs no root. */
export async function status({ root = '/', system = createSystem() }) {
  const paths = layout(root);
  const config = await readJson(paths.configFile).catch(() => null);
  if (!config) return { installed: false };
  const units = {};
  for (const name of [APP_UNIT, UPDATER_TIMER, UPDATER_PATH]) units[name] = await system.isActive(name);
  return { installed: true, config, current: await linkedVersion(paths, 'current'), previous: await linkedVersion(paths, 'previous'), units };
}
