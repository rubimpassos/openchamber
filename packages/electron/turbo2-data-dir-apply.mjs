// Side-effect entry: entry.mjs imports this first so OPENCHAMBER_DATA_DIR is
// set before anything resolves the data directory.
import { applyTurbo2DataDir } from './turbo2-data-dir.mjs';

applyTurbo2DataDir();
