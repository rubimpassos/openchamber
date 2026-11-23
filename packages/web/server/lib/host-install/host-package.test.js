import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { fakeSystem, hostRoot } from './fake-system.test-support.js';
import { installPackage } from './host-package.js';
import { layout, PACKAGE_SUBDIR } from './host-support.js';

const cleanups = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

it('seals an emitted package when its installer and runtime entrypoints exist', async () => {
  // Given
  const root = await hostRoot(cleanups);
  const system = fakeSystem(root);
  const paths = layout(root);
  // When
  const directory = await installPackage({ root, system, paths, toolchain: { node: '/usr/bin/node', npm: '/npm.js' },
    tarball: '/fixture/openchamber-web-2.7.3.tgz', version: '2.7.3' });
  // Then
  const cli = path.join(paths.installDir, directory, PACKAGE_SUBDIR, 'build/bin/cli.js');
  expect((await fs.stat(cli)).mode & 0o777).toBe(0o755);
  expect(system.calls).toContainEqual(['chown', expect.stringMatching(/\/node_modules\/@openchamber\/web\/build\/bin\/cli\.js$/), 0, 0]);
});

it.each(['bin/cli.js', 'bin/cli-runtime.js', 'server/index.js', 'server/runtime.js', 'server/lib/hostd/main.js',
  'server/lib/opencode/v2-install.js', 'server/lib/protected-mcp/service/install.js', 'server/lib/protected-mcp/service/main.js', 'server/lib/protected-mcp/service/relay.js'])(
  'refuses promotion when emitted %s is missing', async (entry) => {
    // Given
    const root = await hostRoot(cleanups);
    const system = fakeSystem(root);
    const paths = layout(root);
    const npm = system.npm;
    system.npm = async (...args) => {
      await npm(...args);
      const prefix = args[2][args[2].indexOf('--prefix') + 1];
      await fs.rm(path.join(prefix, PACKAGE_SUBDIR, 'build', entry));
    };
    // When
    const result = installPackage({ root, system, paths, toolchain: { node: '/usr/bin/node', npm: '/npm.js' },
      tarball: '/fixture/openchamber-web-2.7.3.tgz', version: '2.7.3' });
    // Then
    await expect(result).rejects.toMatchObject({ code: 'incomplete_package' });
    expect(await fs.readdir(paths.installDir)).toEqual([]);
  },
);

it('refuses a source-only package before promotion', async () => {
  // Given
  const root = await hostRoot(cleanups);
  const system = fakeSystem(root);
  const paths = layout(root);
  const npm = system.npm;
  system.npm = async (...args) => {
    await npm(...args);
    const app = path.join(args[2][args[2].indexOf('--prefix') + 1], PACKAGE_SUBDIR);
    for (const directory of ['bin', 'server']) await fs.rename(path.join(app, 'build', directory), path.join(app, directory));
  };
  // When
  const result = installPackage({ root, system, paths, toolchain: { node: '/usr/bin/node', npm: '/npm.js' },
    tarball: '/fixture/openchamber-web-2.6.0.tgz', version: '2.6.0' });
  // Then
  await expect(result).rejects.toMatchObject({ code: 'no_host_installer' });
  expect(await fs.readdir(paths.installDir)).toEqual([]);
});

it.each([null, [], { name: '@other/package', version: '2.7.3' }, { name: '@openchamber/web', version: 273 }])(
  'refuses an installed manifest that does not identify the requested release: %j', async (manifest) => {
    // Given
    const root = await hostRoot(cleanups);
    const system = fakeSystem(root);
    const paths = layout(root);
    const npm = system.npm;
    system.npm = async (...args) => {
      await npm(...args);
      const app = path.join(args[2][args[2].indexOf('--prefix') + 1], PACKAGE_SUBDIR);
      await fs.writeFile(path.join(app, 'package.json'), JSON.stringify(manifest));
    };
    // When
    const result = installPackage({ root, system, paths, toolchain: { node: '/usr/bin/node', npm: '/npm.js' },
      tarball: '/fixture/openchamber-web-2.7.3.tgz', version: '2.7.3' });
    // Then
    await expect(result).rejects.toMatchObject({ code: 'package_mismatch' });
    expect(await fs.readdir(paths.installDir)).toEqual([]);
  },
);
