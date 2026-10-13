import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { buildLinuxAutostartDesktopEntry, resolveLinuxAutostartFilePath } from './linux-autostart.mjs';
import { buildAppImageDesktopEntry, reconcileAppImageDesktopEntry } from './linux-desktop-entry.mjs';

// OpenChamber Turbo 2 installs beside the official OpenChamber. Its packages,
// launcher entries and window class therefore carry their own name: the
// official app's .deb/.rpm owns `openchamber`, its desktop file, icons and
// AppArmor profile, and two packages may not install the same paths.
const pkg = JSON.parse(fs.readFileSync(new URL('./package.json', import.meta.url), 'utf8'));
const linux = pkg.build.linux;
const id = linux.executableName;

test('the Linux identity is the fork\'s own, never the official one', () => {
  assert.equal(id, 'openchamber-turbo2');
  assert.equal(pkg.build.deb.packageName, id);
  assert.equal(pkg.build.rpm.packageName, id);
  // rpmbuild otherwise adds /usr/lib/.build-id links named after each ELF
  // file's build id. The official rpm ships the same Electron binaries, so it
  // owns the same links pointing into /opt/OpenChamber, and rpm refuses to
  // install the second package.
  assert.ok(pkg.build.rpm.fpm.includes('--rpm-rpmbuild-define=_build_id_links none'));
  assert.equal(linux.desktop.entry.Icon, id);
  assert.equal(linux.desktop.entry.StartupWMClass, id);
  assert.equal(linux.desktop.entry.Name, pkg.build.productName);
});

test('the runtime names the same desktop file and window class as the package', async (t) => {
  // entry.mjs sets the desktop name Chromium derives the window class from.
  const entrySource = fs.readFileSync(fileURLToPath(new URL('./entry.mjs', import.meta.url)), 'utf8');
  assert.match(entrySource, new RegExp(`app\\.setDesktopName\\('${id}\\.desktop'\\)`));

  assert.equal(path.basename(resolveLinuxAutostartFilePath({ env: {}, homeDir: '/home/u' })), `${id}.desktop`);
  assert.match(buildLinuxAutostartDesktopEntry({ executable: '/x' }), new RegExp(`^StartupWMClass=${id}$`, 'm'));

  const appImageEntry = buildAppImageDesktopEntry({ appImagePath: '/x.AppImage', iconPath: '/i.png' });
  assert.match(appImageEntry, new RegExp(`^StartupWMClass=${id}$`, 'm'));
  assert.match(appImageEntry, new RegExp(`^Name=${pkg.build.productName}$`, 'm'));

  // An AppImage start integrates under the fork's names, with the icon the
  // AppImage ships under its executable name.
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'turbo2-linux-identity-'));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const appDir = path.join(root, 'mount');
  await fsp.mkdir(path.join(appDir, 'usr/share/icons/hicolor/512x512/apps'), { recursive: true });
  await fsp.writeFile(path.join(appDir, `usr/share/icons/hicolor/512x512/apps/${id}.png`), 'png');
  const dataHome = path.join(root, 'data');
  const result = await reconcileAppImageDesktopEntry({
    env: { APPIMAGE: path.join(root, 'OpenChamber.AppImage'), APPDIR: appDir, XDG_DATA_HOME: dataHome, XDG_DATA_DIRS: path.join(root, 'system') },
    homeDir: root,
  });
  assert.equal(result.status, 'integrated');
  assert.equal(result.desktopPath, path.join(dataHome, 'applications', `${id}.desktop`));
  await fsp.access(path.join(dataHome, `icons/hicolor/512x512/apps/${id}.png`));
});

test('an official package installed beside the fork does not hide the fork\'s entry', async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'turbo2-linux-identity-'));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const appDir = path.join(root, 'mount');
  await fsp.mkdir(path.join(appDir, 'usr/share/icons/hicolor/512x512/apps'), { recursive: true });
  await fsp.writeFile(path.join(appDir, `usr/share/icons/hicolor/512x512/apps/${id}.png`), 'png');
  const system = path.join(root, 'system');
  await fsp.mkdir(path.join(system, 'applications'), { recursive: true });
  await fsp.writeFile(path.join(system, 'applications', 'openchamber.desktop'),
    '[Desktop Entry]\nName=OpenChamber\nExec=/opt/OpenChamber/openchamber %U\nStartupWMClass=openchamber\n');

  const result = await reconcileAppImageDesktopEntry({
    env: { APPIMAGE: path.join(root, 'OpenChamber.AppImage'), APPDIR: appDir, XDG_DATA_HOME: path.join(root, 'data'), XDG_DATA_DIRS: system },
    homeDir: root,
  });
  assert.equal(result.status, 'integrated');
});
