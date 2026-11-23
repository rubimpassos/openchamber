import path from 'node:path';

export const HOST_INSTALL_DIR = '/usr/lib/openchamber';
export const HOST_CONFIG_FILE = '/etc/openchamber/host.json';
export const HOST_REQUEST_DIR = '/var/lib/openchamber-host/requests';
export const FRONT_HOME = '/var/lib/openchamber';
export const PACKAGE_SUBDIR = 'node_modules/@openchamber/web';

const LIVE_PATHS = {
  installDir: HOST_INSTALL_DIR, current: `${HOST_INSTALL_DIR}/current`, app: `${HOST_INSTALL_DIR}/current/${PACKAGE_SUBDIR}`,
  configFile: HOST_CONFIG_FILE, envFile: '/etc/openchamber/openchamber.env', requestDir: HOST_REQUEST_DIR,
  requestFile: `${HOST_REQUEST_DIR}/update`, cacheDir: '/var/cache/openchamber-host', binLink: '/usr/local/bin/openchamber',
  wrapper: '/usr/local/sbin/openchamber-host', agentEnv: '/etc/openchamber/agent.env', agentLink: '/etc/openchamber/agent-link.env',
  previousDeployment: '/etc/openchamber/previous-deployment.json',
} as const;

export type HostPaths = { readonly [Name in keyof typeof LIVE_PATHS]: string };
export type HostLayout = HostPaths & {
  readonly live: HostPaths;
  readonly unit: (name: string) => string;
};
export type HostToolchain = { readonly node: string; readonly npm: string };

export function oldDataDirectory(text: string | null, human: { readonly home: string }): string {
  const line = (text ?? '').split('\n').find((entry) => /^\s*OPENCHAMBER_DATA_DIR=/.test(entry));
  const value = line?.slice(line.indexOf('=') + 1).trim().replace(/^(['"])(.*)\1$/, '$2');
  return value && path.isAbsolute(value) ? value : path.join(human.home, '.config/openchamber');
}

export function layout(root = '/'): HostLayout {
  const rooted = (value: string) => path.join(root, value);
  return {
    live: LIVE_PATHS,
    installDir: rooted(LIVE_PATHS.installDir), current: rooted(LIVE_PATHS.current), app: rooted(LIVE_PATHS.app),
    configFile: rooted(LIVE_PATHS.configFile), envFile: rooted(LIVE_PATHS.envFile), requestDir: rooted(LIVE_PATHS.requestDir),
    requestFile: rooted(LIVE_PATHS.requestFile), cacheDir: rooted(LIVE_PATHS.cacheDir), binLink: rooted(LIVE_PATHS.binLink),
    wrapper: rooted(LIVE_PATHS.wrapper), agentEnv: rooted(LIVE_PATHS.agentEnv), agentLink: rooted(LIVE_PATHS.agentLink),
    previousDeployment: rooted(LIVE_PATHS.previousDeployment),
    unit: (name) => path.join(root, '/etc/systemd/system', name),
  };
}
