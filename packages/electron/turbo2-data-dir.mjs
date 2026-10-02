import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// OpenChamber Turbo 2 installs beside OpenChamber Turbo (v1). Both would
// otherwise share ~/.config/openchamber: the desktop settings (hosts, window
// state) and the embedded server's data. The 2.x server migrates that data in
// place, which would break the v1 app, so this build owns its own directory.
// Everything that resolves the data directory (early-startup's settings path,
// the embedded server, managed OpenCode) reads OPENCHAMBER_DATA_DIR, so setting
// it here, before any of them is imported, moves all of them at once.
export const TURBO2_DATA_DIR_NAME = 'openchamber-turbo2';
const LEGACY_DATA_DIR_NAME = 'openchamber';
const SEEDED_FILES = ['settings.json', 'preferences.json'];

export const resolveTurbo2DataDir = ({ environment = process.env, homeDir = os.homedir() } = {}) => {
  const configured = typeof environment.OPENCHAMBER_DATA_DIR === 'string'
    ? environment.OPENCHAMBER_DATA_DIR.trim()
    : '';
  if (configured) return { dataDir: configured, owned: false };
  return { dataDir: path.join(homeDir, '.config', TURBO2_DATA_DIR_NAME), owned: true };
};

// First run only: copy the v1 desktop settings so saved hosts and preferences
// carry over. It is a copy, so the 2.x migration never touches the v1 files.
export const seedTurbo2DataDir = ({ dataDir, homeDir = os.homedir(), fileSystem = fs } = {}) => {
  if (fileSystem.existsSync(dataDir)) return false;
  const source = path.join(homeDir, '.config', LEGACY_DATA_DIR_NAME);
  fileSystem.mkdirSync(dataDir, { recursive: true });
  for (const name of SEEDED_FILES) {
    const from = path.join(source, name);
    if (fileSystem.existsSync(from)) fileSystem.copyFileSync(from, path.join(dataDir, name));
  }
  return true;
};

export const applyTurbo2DataDir = ({ environment = process.env, homeDir = os.homedir(), fileSystem = fs } = {}) => {
  const { dataDir, owned } = resolveTurbo2DataDir({ environment, homeDir });
  if (!owned) return dataDir;
  environment.OPENCHAMBER_DATA_DIR = dataDir;
  try {
    seedTurbo2DataDir({ dataDir, homeDir, fileSystem });
  } catch (error) {
    console.warn('[electron] could not seed OpenChamber Turbo 2 data directory', error);
  }
  return dataDir;
};

