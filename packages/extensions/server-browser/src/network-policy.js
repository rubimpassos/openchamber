import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Whether pages may open localhost and private-network addresses.
 *
 * On someone's own computer (desktop OS, WSL, a graphical Linux session) the
 * "private network" is their machine and their LAN, and blocking it only gets
 * in the way of opening their dev servers. On a remote server it is the
 * provider's network, so it stays blocked unless allowed.
 *
 * The user's choice from Settings (stored next to the profiles) wins over
 * `allowPrivateNetwork` in config.json, which wins over that guess.
 */
export const isPersonalMachine = ({ platform = process.platform, env = process.env, readFile = fs.readFileSync } = {}) => {
  if (platform === 'darwin' || platform === 'win32') return true;
  if (env.WSL_DISTRO_NAME || env.WSL_INTEROP) return true;
  try {
    if (/microsoft/i.test(String(readFile('/proc/version', 'utf8')))) return true;
  } catch {
    // not Linux, or /proc unreadable
  }
  return Boolean(env.DISPLAY || env.WAYLAND_DISPLAY);
};

export const createNetworkPolicy = ({
  file = path.join(os.homedir(), '.local', 'share', 'openchamber-server-browser', 'network.json'),
  configured = null,
  personalMachine = isPersonalMachine(),
} = {}) => {
  const read = () => {
    try {
      const value = JSON.parse(fs.readFileSync(file, 'utf8'));
      return typeof value?.allowPrivateNetwork === 'boolean' ? value.allowPrivateNetwork : null;
    } catch {
      return null;
    }
  };
  let chosen = read();

  const state = () => ({
    allowPrivateNetwork: chosen ?? configured ?? personalMachine,
    source: chosen !== null ? 'settings' : configured !== null ? 'config' : 'default',
    defaultValue: configured ?? personalMachine,
    personalMachine,
  });

  return {
    allowPrivateNetwork: () => state().allowPrivateNetwork,
    state,
    /** `null` goes back to the default. */
    set(value) {
      if (value !== null && typeof value !== 'boolean') throw new Error('allowPrivateNetwork must be true, false, or null');
      chosen = value;
      fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
      if (value === null) fs.rmSync(file, { force: true });
      else fs.writeFileSync(file, `${JSON.stringify({ allowPrivateNetwork: value }, null, 2)}\n`, { mode: 0o600 });
      return state();
    },
  };
};
