import fs from 'node:fs';
import path from 'node:path';
import { webPackagePaths } from '../web-package-paths.js';
import { HOST_INSTALL_DIR, HOST_CONFIG_FILE, HOST_REQUEST_DIR } from './host-paths.js';
export { HOST_INSTALL_DIR, HOST_CONFIG_FILE, HOST_REQUEST_DIR } from './host-paths.js';

const HOST_UPDATE_REQUEST = path.join(HOST_REQUEST_DIR, 'update');

export function isHostManagedInstall({ packageRoot = webPackagePaths.root, installDir = HOST_INSTALL_DIR, configFile = HOST_CONFIG_FILE } = {}): boolean {
  let resolved;
  try {
    resolved = fs.realpathSync(packageRoot);
  } catch {
    return false;
  }
  return resolved.startsWith(`${installDir}/`) && fs.existsSync(configFile);
}

export function requestHostUpdate({ requestFile = HOST_UPDATE_REQUEST } = {}): void {
  fs.writeFileSync(requestFile, '', { mode: 0o600 });
}
