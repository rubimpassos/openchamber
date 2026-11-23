import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const bootstrap = new URL('./turbo2-data-dir-apply.mjs', import.meta.url).href;
const nativeEdges = new URL('./test-support/native-electron.mjs', import.meta.url).href;

for (const mode of ['packaged', 'unpackaged', 'dev-flag', 'explicit']) {
  test(`fork data bootstrap respects ${mode} startup ownership`, (context) => {
    // Given a legacy profile and a separate home for this process.
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-turbo2-bootstrap-'));
    context.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const legacy = path.join(root, '.config', 'openchamber');
    fs.mkdirSync(legacy, { recursive: true });
    fs.writeFileSync(path.join(legacy, 'settings.json'), '{"desktopHosts":[]}');
    const explicit = path.join(root, 'custom');

    // When the real side-effect module runs with Electron's packaged flag.
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
      import os from 'node:os';
      import { installNativeElectron } from ${JSON.stringify(nativeEdges)};
      os.homedir = () => process.argv[1];
      installNativeElectron({ directory: process.argv[1], app: { isPackaged: ${mode !== 'unpackaged'} } });
      await import(${JSON.stringify(bootstrap)});
      process.stdout.write(JSON.stringify(process.env.OPENCHAMBER_DATA_DIR));
    `, root], {
      env: {
        ...process.env,
        OPENCHAMBER_DATA_DIR: mode === 'explicit' ? explicit : '',
        OPENCHAMBER_ELECTRON_DEV: mode === 'dev-flag' ? '1' : '',
      },
      encoding: 'utf8', timeout: 10_000, windowsHide: true,
    });

    // Then only a packaged default seeds the fork's production directory.
    assert.equal(result.status, 0, result.stderr);
    const target = path.join(root, '.config', 'openchamber-turbo2');
    assert.equal(JSON.parse(result.stdout), mode === 'packaged' ? target : mode === 'explicit' ? explicit : '');
    assert.equal(fs.existsSync(target), mode === 'packaged');
    if (mode === 'packaged') {
      assert.equal(fs.readFileSync(path.join(target, 'settings.json'), 'utf8'), '{"desktopHosts":[]}');
    }
  });
}
