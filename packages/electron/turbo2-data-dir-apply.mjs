// Packaged runs set the fork directory before startup reads settings.
// Development keeps the launcher's and login shell's directory selection.
import { app } from 'electron';
import { applyTurbo2DataDir } from './turbo2-data-dir.mjs';

if (app.isPackaged && process.env.OPENCHAMBER_ELECTRON_DEV !== '1') applyTurbo2DataDir();
