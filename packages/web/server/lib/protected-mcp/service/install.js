#!/usr/bin/env node
// Installs, updates and removes the protected MCP service on a Linux host.
// Run by a person as root; never by the running OpenChamber.
import { execFile } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ProtectedMcpError } from './contract.js';
import { createIntegrity } from './integrity.js';
import { ROOT_EQUIVALENT_SOCKETS, runPreflight } from './preflight.js';

const SERVICE_USER = 'openchamber-mcp';
const CLIENT_GROUP = 'openchamber-mcp-clients';
const ADMIN_GROUP = 'openchamber-mcp-admins';
const UNIT_NAME = 'openchamber-protected-mcp.service';
const MIN_NODE = [24, 14];

// Kept local so the root installer loads only the modules it needs, not the state store.
const readJsonFile = async (filename) => {
  try {
    return JSON.parse(await fs.readFile(filename, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
};

/** Where everything lives, below an optional root for disposable test installs. */
export function layout(root = '/') {
  const at = (target) => path.join(root, target);
  return {
    installDir: at('/usr/lib/openchamber-protected-mcp'),
    configDir: at('/etc/openchamber/protected-mcp'),
    serviceConfig: at('/etc/openchamber/protected-mcp/service.json'),
    clientConfig: at('/etc/openchamber/protected-mcp/client.json'),
    stateDir: at('/var/lib/openchamber-protected-mcp'),
    engineSocket: at('/run/openchamber-protected-mcp/engine.sock'),
    unitFile: at(`/etc/systemd/system/${UNIT_NAME}`),
    // Paths as the running system sees them, written into configuration.
    live: {
      installDir: '/usr/lib/openchamber-protected-mcp',
      configDir: '/etc/openchamber/protected-mcp',
      stateDir: '/var/lib/openchamber-protected-mcp',
      engineSocket: '/run/openchamber-protected-mcp/engine.sock',
      adminSocket: '/run/openchamber-protected-mcp-admin/admin.sock',
      serviceConfig: '/etc/openchamber/protected-mcp/service.json',
    },
  };
}

const run = (command, args, options = {}) => new Promise((resolve, reject) => {
  execFile(command, args, { timeout: 60_000, maxBuffer: 4 * 1024 * 1024, ...options }, (error, stdout, stderr) => {
    if (error) reject(Object.assign(new Error(`${command} failed`), { code: error.code, stderr: String(stderr).slice(-2000) }));
    else resolve(String(stdout));
  });
});

/** The privileged operations, injectable so a test can record them in a temporary root. */
function createSystem() {
  const exists = (command, args) => run(command, args).then(() => true, () => false);
  return {
    trustedOwners: [0],
    isRoot: () => process.getuid() === 0,
    hasSystemd: () => fs.stat('/run/systemd/system').then(() => true, () => false),
    async identity(user) {
      const [uid, gids] = await Promise.all([run('id', ['-u', '--', user]), run('id', ['-G', '--', user])]);
      return { uid: Number(uid.trim()), gids: gids.trim().split(/\s+/).map(Number) };
    },
    async ensureGroup(name) {
      if (!await exists('getent', ['group', name])) await run('groupadd', ['--system', name]);
      return Number((await run('getent', ['group', name])).split(':')[2]);
    },
    async ensureUser(name, { home }) {
      if (!await exists('id', ['-u', '--', name])) {
        await run('useradd', ['--system', '--user-group', '--home-dir', home, '--no-create-home', '--shell', '/usr/sbin/nologin', name]);
      }
      return Number((await run('id', ['-u', '--', name])).trim());
    },
    addToGroup: (user, group) => run('usermod', ['--append', '--groups', group, user]),
    removeFromGroup: (user, group) => run('gpasswd', ['--delete', user, group]).catch(() => {}),
    removeUser: (name) => run('userdel', [name]).catch(() => {}),
    removeGroup: (name) => run('groupdel', [name]).catch(() => {}),
    chown: (target, uid, gid) => fs.lchown(target, uid, gid),
    systemctl: (args) => run('systemctl', args),
    nodeVersion: (node) => run(node, ['--version']),
    connect: (socket) => new Promise((resolve, reject) => {
      const client = net.createConnection(socket);
      let answer = '';
      client.setEncoding('utf8');
      client.once('connect', () => client.write('{"type":"status"}\n'));
      client.on('data', (chunk) => { answer += chunk; });
      client.once('error', reject);
      client.once('close', () => {
        try {
          resolve(JSON.parse(answer));
        } catch (error) {
          reject(error);
        }
      });
    }),
  };
}

const refuse = (code, message) => {
  throw new ProtectedMcpError(code, { status: 500, message });
};

const integrityFor = (system, engine) => createIntegrity({ owners: system.trustedOwners, groups: [0], engine });

async function requireTrusted(system, engine, target, code) {
  const { findings } = await integrityFor(system, engine).inspect(target);
  if (findings.length > 0) refuse(code, `${target}: ${findings.map((finding) => `${finding.code} ${finding.subject}`).join(', ')}`);
}

/** The service's own files in the source tree: the service directory without tests, and the shared guards. */
async function sourceFiles(source) {
  const service = path.join(source, 'lib', 'protected-mcp', 'service');
  const names = (await fs.readdir(service)).filter((name) => name.endsWith('.js') && !name.endsWith('.test.js')).sort();
  if (!names.includes('main.js') || !names.includes('relay.js')) refuse('invalid_source', `${service} has no service`);
  return [
    ...names.map((name) => path.join('lib', 'protected-mcp', 'service', name)),
    path.join('lib', 'shared', 'guards.js'),
  ];
}

async function copyTree({ system, source, files, target, version }) {
  const staging = `${target}.staging-${randomBytes(4).toString('hex')}`;
  const digest = createHash('sha256');
  try {
    await fs.mkdir(staging, { recursive: true, mode: 0o755 });
    for (const file of files) {
      const destination = path.join(staging, file);
      await fs.mkdir(path.dirname(destination), { recursive: true, mode: 0o755 });
      const content = await fs.readFile(path.join(source, file));
      digest.update(file).update(content);
      await fs.writeFile(destination, content, { mode: 0o644 });
    }
    await fs.writeFile(path.join(staging, 'package.json'), `${JSON.stringify({ name: 'openchamber-protected-mcp', private: true, type: 'module', version }, null, 2)}\n`, { mode: 0o644 });
    // Modes are set explicitly: root's umask may be 077, and the service must read its code.
    for (const entry of await fs.readdir(staging, { recursive: true, withFileTypes: true })) {
      const full = path.join(entry.parentPath, entry.name);
      await fs.chmod(full, entry.isDirectory() ? 0o755 : 0o644);
      await system.chown(full, 0, 0);
    }
    await fs.chmod(staging, 0o755);
    await system.chown(staging, 0, 0);
    await fs.rm(target, { recursive: true, force: true });
    await fs.rename(staging, target);
  } finally {
    await fs.rm(staging, { recursive: true, force: true });
  }
  return digest.digest('hex');
}

const replaceSymlink = async (link, destination) => {
  const temporary = `${link}.${randomBytes(4).toString('hex')}`;
  await fs.symlink(destination, temporary);
  await fs.rename(temporary, link);
};

/**
 * Creates each missing directory of the chain as root, mode 0755. A recursive
 * mkdir would give the parents root's umask, and with 077 the service could
 * not reach its own configuration. Existing directories are left as they are.
 */
const ensureRootDirectory = async (system, directory, { own = false } = {}) => {
  const missing = [];
  for (let current = directory; ; current = path.dirname(current)) {
    if (await fs.stat(current).then(() => true, () => false)) break;
    missing.unshift(current);
    if (path.dirname(current) === current) break;
  }
  for (const created of missing) {
    await fs.mkdir(created, { mode: 0o755 }).catch((error) => {
      if (error.code !== 'EEXIST') throw error;
    });
  }
  // The service's own directories are reset on every install; system ones only when created here.
  for (const target of own && missing.length === 0 ? [directory] : missing) {
    await fs.chmod(target, 0o755);
    await system.chown(target, 0, 0);
  }
};

const writeRootFile = async (system, file, content, { mode = 0o644, own = true } = {}) => {
  await ensureRootDirectory(system, path.dirname(file), { own });
  const temporary = `${file}.${randomBytes(4).toString('hex')}`;
  await fs.writeFile(temporary, content, { mode });
  await fs.chmod(temporary, mode);
  await system.chown(temporary, 0, 0);
  await fs.rename(temporary, file);
};

/** The hardened unit. The service needs no capability and writes only its state and runtime directories. */
function unitFile({ node, live }) {
  return `[Unit]
Description=OpenChamber protected MCP service
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=${SERVICE_USER}
Group=${SERVICE_USER}
SupplementaryGroups=${CLIENT_GROUP} ${ADMIN_GROUP}
ExecStart=${node} ${live.installDir}/current/lib/protected-mcp/service/main.js --config ${live.serviceConfig}
WorkingDirectory=${live.stateDir}
StateDirectory=openchamber-protected-mcp
StateDirectoryMode=0700
RuntimeDirectory=openchamber-protected-mcp openchamber-protected-mcp-admin
RuntimeDirectoryMode=0750
UMask=0077
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=yes
PrivateTmp=yes
PrivateDevices=yes
ProtectKernelTunables=yes
ProtectKernelModules=yes
ProtectKernelLogs=yes
ProtectControlGroups=yes
ProtectClock=yes
ProtectHostname=yes
RestrictSUIDSGID=yes
RestrictNamespaces=yes
RestrictRealtime=yes
LockPersonality=yes
CapabilityBoundingSet=
AmbientCapabilities=
RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6
LimitCORE=0
Restart=on-failure
RestartSec=2

[Install]
WantedBy=multi-user.target
`;
}

const parseVersion = (text) => {
  const match = /^v(\d+)\.(\d+)/.exec(text.trim());
  return match ? [Number(match[1]), Number(match[2])] : null;
};

const NODE_CANDIDATES = ['/usr/bin/node', '/usr/local/bin/node'];

/** A Node.js the engine cannot replace, recent enough for the service. */
async function trustedNode(system, engine, root, requested) {
  for (const candidate of requested ? [requested] : NODE_CANDIDATES) {
    const target = path.join(root, candidate);
    try {
      await fs.access(target);
    } catch {
      continue;
    }
    await requireTrusted(system, engine, target, 'untrusted_node');
    const version = parseVersion(await system.nodeVersion(target));
    if (!version || version[0] < MIN_NODE[0] || (version[0] === MIN_NODE[0] && version[1] < MIN_NODE[1])) {
      refuse('node_too_old', `${candidate} must be Node.js ${MIN_NODE.join('.')} or newer`);
    }
    return { live: candidate, local: target };
  }
  return refuse('node_missing', 'Install Node.js system-wide, owned by root, then run this again');
}

const NPM_CANDIDATES = ['/usr/lib/node_modules/npm/bin/npm-cli.js', '/usr/local/lib/node_modules/npm/bin/npm-cli.js'];

async function trustedNpm(system, engine, root, node) {
  for (const candidate of NPM_CANDIDATES) {
    const target = path.join(root, candidate);
    try {
      await fs.access(target);
    } catch {
      continue;
    }
    const { findings } = await integrityFor(system, engine).inspect(target);
    if (findings.length === 0) return [node, candidate];
  }
  return null;
}

/**
 * Installs or updates the service. Configuration and state survive an update;
 * the previous version stays on disk as `previous` for a rollback.
 */
export async function install({ root = '/', source, version, engineUser, engineUnit = null, node: requestedNode = null, start = true, acceptUnprotected = false, system = createSystem(), say = () => {} }) {
  const paths = layout(root);
  if (!system.isRoot()) refuse('root_required', 'Run the installer as root');
  if (start && !await system.hasSystemd()) refuse('systemd_required', 'The protected MCP service needs systemd');
  if (!/^[0-9A-Za-z.+-]{1,64}$/.test(version ?? '')) refuse('invalid_version', 'invalid version');
  if (!engineUser || engineUser.startsWith('--')) refuse('engine_user_required', 'Specify --engine-user with the OpenChamber account');
  const engine = await system.identity(engineUser);
  if (engine.uid === 0) refuse('engine_is_root', 'The engine account must not be root');

  await requireTrusted(system, engine, source, 'untrusted_source');
  const files = await sourceFiles(source);
  for (const file of files) await requireTrusted(system, engine, path.join(source, file), 'untrusted_source');
  const node = await trustedNode(system, engine, root, requestedNode);
  const npm = await trustedNpm(system, engine, root, node.live);
  const existing = await readJsonFile(paths.serviceConfig);

  const clientGid = await system.ensureGroup(CLIENT_GROUP);
  const adminGid = await system.ensureGroup(ADMIN_GROUP);
  const serviceUid = await system.ensureUser(SERVICE_USER, { home: paths.live.stateDir });
  const serviceGid = await system.ensureGroup(SERVICE_USER);
  await system.addToGroup(engineUser, CLIENT_GROUP);
  await system.addToGroup(engineUser, ADMIN_GROUP);
  if (existing?.engineUser && existing.engineUser !== engineUser) {
    await system.removeFromGroup(existing.engineUser, CLIENT_GROUP);
    await system.removeFromGroup(existing.engineUser, ADMIN_GROUP);
    say(`Account ${existing.engineUser} was removed from ${CLIENT_GROUP} and ${ADMIN_GROUP}.`);
  }
  say(`Account ${SERVICE_USER} and group ${CLIENT_GROUP} are ready; ${engineUser} is in ${CLIENT_GROUP}.`);
  say(`In stage 1 OpenChamber runs as the engine account ${engineUser}, which administers protected MCP through ${ADMIN_GROUP}.`);

  await ensureRootDirectory(system, paths.installDir, { own: true });
  const versionDir = path.join(paths.installDir, version);
  const digest = await copyTree({ system, source, files, target: versionDir, version });
  const currentLink = path.join(paths.installDir, 'current');
  const previousTarget = await fs.readlink(currentLink).catch(() => null);
  if (previousTarget && previousTarget !== version) await replaceSymlink(path.join(paths.installDir, 'previous'), previousTarget);
  await replaceSymlink(currentLink, version);
  await requireTrusted(system, engine, path.join(versionDir, 'lib', 'protected-mcp', 'service', 'main.js'), 'installed_tree_untrusted');

  const serviceConfig = {
    version: 1,
    serviceVersion: version,
    stateDir: paths.live.stateDir,
    engineSocket: paths.live.engineSocket,
    engineSocketGroup: clientGid,
    engineUser,
    engineUnit: engineUnit ?? existing?.engineUnit ?? null,
    adminSocket: paths.live.adminSocket,
    adminSocketGroup: adminGid,
    workerPath: '/usr/local/bin:/usr/bin:/bin',
    node: node.live,
    npm,
    installDir: paths.live.installDir,
    configDir: paths.live.configDir,
  };
  await writeRootFile(system, paths.serviceConfig, `${JSON.stringify(serviceConfig, null, 2)}\n`);
  await writeRootFile(system, paths.clientConfig, `${JSON.stringify({
    version: 1,
    socket: paths.live.engineSocket,
    adminSocket: paths.live.adminSocket,
    relay: [node.live, `${paths.live.installDir}/current/lib/protected-mcp/service/relay.js`],
  }, null, 2)}\n`);

  await ensureRootDirectory(system, path.dirname(paths.stateDir));
  await fs.mkdir(paths.stateDir, { mode: 0o700 }).catch((error) => {
    if (error.code !== 'EEXIST') throw error;
  });
  await fs.chmod(paths.stateDir, 0o700);
  for (const entry of await fs.readdir(paths.stateDir, { recursive: true })) await system.chown(path.join(paths.stateDir, entry), serviceUid, serviceGid);
  await system.chown(paths.stateDir, serviceUid, serviceGid);

  await writeRootFile(system, paths.unitFile, unitFile({ node: node.live, live: paths.live }), { own: false });

  const preflight = await runPreflight({
    integrity: integrityFor(system, engine),
    engine,
    engineUser,
    engineUnit: serviceConfig.engineUnit,
    trustedPaths: [node.local, ...(npm ? [path.join(root, npm[1])] : [])],
    trustedTrees: [versionDir, paths.configDir],
    privateDirectories: [paths.stateDir],
    sockets: system.sockets ?? ROOT_EQUIVALENT_SOCKETS.map((socket) => path.join(root, socket)),
    socketOwners: system.socketOwners,
  });
  if (preflight.status === 'unprotected' && !acceptUnprotected) {
    refuse('unprotected', `The engine can reach root: ${preflight.findings.filter((finding) => finding.level === 'error').map((finding) => `${finding.code} ${finding.subject ?? ''}`.trim()).join(', ')}. Fix it, or rerun with --accept-unprotected to install anyway.`);
  }

  let status = null;
  if (start) {
    await system.systemctl(['daemon-reload']);
    await system.systemctl(['enable', UNIT_NAME]);
    await system.systemctl(['restart', UNIT_NAME]);
    for (let attempt = 0; attempt < 30 && status === null; attempt += 1) {
      status = await system.connect(paths.engineSocket).catch(() => null);
      if (status === null) await new Promise((resolve) => setTimeout(resolve, 500));
    }
    if (status === null) refuse('service_not_answering', `systemctl status ${UNIT_NAME} tells why`);
  }
  return { version, digest, preflight, status, previous: previousTarget };
}

/** Removes the service. Credentials, the account and its group stay unless `purgeState` is set. */
export async function uninstall({ root = '/', engineUser = null, purgeState = false, system = createSystem() }) {
  const paths = layout(root);
  if (!system.isRoot()) refuse('root_required', 'Run the installer as root');
  await system.systemctl(['disable', '--now', UNIT_NAME]).catch(() => {});
  await fs.rm(paths.unitFile, { force: true });
  await system.systemctl(['daemon-reload']).catch(() => {});
  await fs.rm(paths.installDir, { recursive: true, force: true });
  await fs.rm(paths.clientConfig, { force: true });
  await fs.rm(paths.serviceConfig, { force: true });
  if (purgeState) {
    await fs.rm(paths.stateDir, { recursive: true, force: true });
    if (engineUser) {
      await system.removeFromGroup(engineUser, CLIENT_GROUP);
      await system.removeFromGroup(engineUser, ADMIN_GROUP);
    }
    await system.removeUser(SERVICE_USER);
    await system.removeGroup(CLIENT_GROUP);
    await system.removeGroup(ADMIN_GROUP);
  }
  return { purged: purgeState };
}

/** Moves `current` back to `previous` after a failed update. */
export async function rollback({ root = '/', system = createSystem() }) {
  const paths = layout(root);
  if (!system.isRoot()) refuse('root_required', 'Run the installer as root');
  const previous = await fs.readlink(path.join(paths.installDir, 'previous')).catch(() => null);
  if (!previous) refuse('no_previous_version', 'There is no earlier version to go back to');
  const current = await fs.readlink(path.join(paths.installDir, 'current'));
  await replaceSymlink(path.join(paths.installDir, 'current'), previous);
  await replaceSymlink(path.join(paths.installDir, 'previous'), current);
  await system.systemctl(['restart', UNIT_NAME]);
  return { current: previous };
}

const USAGE = `Usage: install.js <command> [options]   (as root)

Commands:
  install            Install or update the protected MCP service
  uninstall          Remove it; credentials stay unless --purge-state
  rollback           Go back to the previous version

Options for install:
  --source <dir>         Unpacked @openchamber/web server directory, owned by root
  --version <version>    Version label of that source
  --engine-user <name>   Account the OpenChamber server and OpenCode run as
  --engine-unit <unit>   Its systemd unit, checked for NoNewPrivileges
  --node <path>          Node.js to run the service (default /usr/bin/node)
  --no-start             Write everything but do not start the service
  --accept-unprotected   Install even when the engine can reach root
\nManage protected MCP servers in OpenChamber: Settings → MCP.
`;

async function cli(argv) {
  const [command, ...rest] = argv;
  const option = (name) => {
    const index = rest.indexOf(name);
    return index === -1 ? null : rest[index + 1] ?? null;
  };
  const flag = (name) => rest.includes(name);
  if (!command || command === '--help' || flag('--help')) {
    process.stdout.write(USAGE);
    return 0;
  }
  const say = (text) => process.stdout.write(`${text}\n`);
  if (command === 'install' || command === 'update') {
    const result = await install({
      source: option('--source'),
      version: option('--version'),
      engineUser: option('--engine-user'),
      engineUnit: option('--engine-unit'),
      node: option('--node'),
      start: !flag('--no-start'),
      acceptUnprotected: flag('--accept-unprotected'),
      say,
    });
    say(`Installed version ${result.version}.`);
    say(`Boundary status: ${result.preflight.status}${result.preflight.findings.length ? ` (${result.preflight.findings.map((finding) => finding.code).join(', ')})` : ''}.`);
    say('Manage protected MCP servers in OpenChamber: Settings → MCP.');
    say('Restart the OpenChamber service once so its account picks up the new group membership.');
    return 0;
  }
  if (command === 'uninstall') {
    const result = await uninstall({ engineUser: option('--engine-user'), purgeState: flag('--purge-state') });
    say(result.purged ? 'Removed the service, its state and its account.' : 'Removed the service. Credentials and the service account stay for a reinstall.');
    return 0;
  }
  if (command === 'rollback') {
    say(`Running version ${(await rollback({})).current}.`);
    return 0;
  }
  process.stderr.write(USAGE);
  return 64;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === await fs.realpath(process.argv[1])) {
  cli(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  }, (error) => {
    process.stderr.write(`${error.message ?? error}\n`);
    process.exitCode = error.code === 'root_required' ? 77 : 1;
  });
}
