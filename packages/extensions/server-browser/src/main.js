import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createBrowserManager } from './browser-manager.js';
import { createBrowserRuntime } from './browser-runtime.js';
import { loadConfig } from './config.js';
import { createNetworkPolicy } from './network-policy.js';
import { createChromeInstaller } from './chrome-install.js';
import { resolveChromePath } from './chrome-process.js';
import { createDevServerScanner } from './dev-servers.js';
import { createProfileStore, defaultStorePaths } from './profile-store.js';
import { clearProfileSite, listProfileSites } from './profile-sites.js';
import { createService } from './service.js';

const readPort = (value) => {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error('OPENCHAMBER_SERVICE_PORT must be an integer from 1 to 65535');
  }
  return port;
};

export { createBrowserManager, createBrowserRuntime, createService };

export const startService = async ({
  env = process.env,
  configPath,
  runtime,
} = {}) => {
  const token = env.OPENCHAMBER_SERVICE_TOKEN;
  if (typeof token !== 'string' || token.length === 0) {
    throw new Error('OPENCHAMBER_SERVICE_TOKEN is required');
  }
  const config = loadConfig({ env, configPath });
  // One scanner serves every scope; it caches the listener table briefly.
  const scanner = config.discoverDevServers || config.projectDevServers ? createDevServerScanner() : null;
  const devServers = config.discoverDevServers ? scanner : null;
  // Profiles live outside the package, which an update replaces.
  const defaults = defaultStorePaths(env);
  const profiles = createProfileStore({
    root: config.profileStore ?? defaults.root,
    keyFile: config.profileKeyFile ?? defaults.keyFile,
  });
  await profiles.removeStale().catch(() => []);
  const networkPolicy = createNetworkPolicy({
    file: path.join(defaults.root, 'network.json'),
    configured: config.allowPrivateNetwork,
  });
  // Plug and play: without a Chrome on the machine, the service downloads one.
  let systemChrome = null;
  try {
    systemChrome = resolveChromePath(config.chromePath);
  } catch (error) {
    if (config.chromePath) throw error;
  }
  const installer = systemChrome ? null : createChromeInstaller({ directory: path.join(defaults.root, 'chrome') });
  if (installer) void installer.ensure().catch(() => {});
  const chromePath = systemChrome ?? (async () => {
    if (installer.state.status === 'installing') {
      throw new Error(`${installer.state.message}; this happens once after installing the extension. Retry in a minute.`);
    }
    const binary = await installer.ensure();
    if (installer.state.status === 'missing-libraries') throw new Error(installer.state.message);
    return binary;
  });
  // `GET /chrome` and the dock's `chrome` state field share this: a Chrome
  // the host found on the machine needs no install state of its own.
  const chromeStatus = () => (installer ? installer.state : { status: 'system', message: '', path: systemChrome, version: null });
  // `/profiles/sites` and `/profiles/sites/clear` act on the saved profile
  // directly, with no live chat scope; they need only checkout/checkin,
  // not the `{ id, name }` the manager keeps per scope.
  const profileHandle = (id) => ({
    checkout: () => profiles.checkout(id),
    checkin: (directory, version) => profiles.checkin(id, directory, version),
  });
  const profileSites = {
    list: (id) => listProfileSites(profileHandle(id), { chromePath }),
    clear: (id, domain) => clearProfileSite(profileHandle(id), domain, { chromePath }),
  };
  const browserRuntime = runtime ?? createBrowserManager({
    profiles,
    chromeStatus,
    createRuntime: (context, profile) => createBrowserRuntime({
      ...config,
      chromePath,
      devServers,
      projectDevServers: config.projectDevServers ? scanner : null,
      projectDirectory: context.directory.startsWith('profile:') ? null : context.directory,
      allowPrivateNetwork: networkPolicy.allowPrivateNetwork,
      profile: profile ? {
        id: profile.id,
        name: profile.name,
        checkout: () => profiles.checkout(profile.id),
        checkin: (directory, version) => profiles.checkin(profile.id, directory, version),
      } : null,
    }),
  });
  const service = createService({
    runtime: browserRuntime,
    token,
    port: readPort(env.OPENCHAMBER_SERVICE_PORT),
    chromeStatus,
    profileSites,
    networkPolicy,
  });
  await service.listen();
  return service;
};

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  startService().then((service) => {
    let stopping = false;
    const stop = () => {
      if (stopping) return;
      stopping = true;
      void service.close().finally(() => process.exit(0));
    };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  }).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
