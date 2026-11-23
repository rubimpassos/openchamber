import fs from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, it } from 'vitest';
import { fakeSystem, hostRoot, installOptions } from './fake-system.test-support.js';
import { install, layout, rollback, update } from './host.js';
import { AGENT_UNIT, ALL_UNITS, APP_UNIT, HOSTD_UNIT, UPDATER_UNIT } from './host-units.js';

const cleanups = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const marker = 'process.stdout.write(JSON.stringify(process.argv.slice(2)));';
const runWrapper = async (paths, argv = ['status', '--json'], env = process.env) => {
  const script = (await fs.readFile(paths.wrapper, 'utf8')).replaceAll(paths.live.installDir, paths.installDir);
  return spawnSync('sh', ['-s', '--', ...argv], { input: script, env, encoding: 'utf8', timeout: 5000 });
};

async function legacyInstall() {
  const root = await hostRoot(cleanups);
  const system = fakeSystem(root);
  await install(installOptions(root, system, { separation: false }));
  const paths = layout(root);
  for (const directory of ['bin', 'server']) await fs.rename(path.join(paths.app, 'build', directory), path.join(paths.app, directory));
  await fs.rm(path.join(paths.app, 'build'), { recursive: true });
  await fs.writeFile(path.join(paths.app, 'server/lib/host-install/main.js'), marker);
  for (const unit of ALL_UNITS) {
    const text = await fs.readFile(paths.unit(unit), 'utf8').catch((error) => { if (error.code === 'ENOENT') return null; throw error; });
    if (text !== null) await fs.writeFile(paths.unit(unit), unit === UPDATER_UNIT
      ? text.replace(/^ExecStart=.*$/m, `ExecStart=/usr/bin/node ${paths.live.app}/server/lib/host-install/main.js update`)
      : text.replaceAll('/build/', '/'));
  }
  await fs.unlink(paths.binLink);
  await fs.symlink(`${paths.live.app}/bin/cli.js`, paths.binLink);
  return { root, paths };
}

it.each([false, true])('points each executable and protected MCP source at the emitted package, separation=%s', async (separation) => {
  // Given
  const root = await hostRoot(cleanups);
  const system = fakeSystem(root);
  // When
  await install(installOptions(root, system, { separation }));
  // Then
  const paths = layout(root);
  // A package with no source fallback. CLI and server bootstraps must resolve their runtimes.
  await fs.writeFile(path.join(paths.app, 'package.json'), '{"type":"module"}');
  for (const [entry, code] of Object.entries({
    'build/bin/cli.js': 'import "./cli-runtime.js";',
    'build/bin/cli-runtime.js': 'import "../server/index.js";',
    'build/server/index.js': 'import "./runtime.js";',
    'build/server/runtime.js': marker,
    'build/server/lib/hostd/main.js': marker,
    'build/server/lib/host-install/main.js': marker,
  })) await fs.writeFile(path.join(paths.app, entry), code);
  const launches = [
    [APP_UNIT, ['serve', '--foreground', '--port', '3000', '--host', '127.0.0.1']],
    [HOSTD_UNIT, []], [UPDATER_UNIT, ['update']],
    ...(separation ? [[AGENT_UNIT, ['serve', '--foreground', '--api-only', '--host', '127.0.0.1', '--port', '41890']]] : []),
  ];
  for (const [unit, expected] of launches) {
    const text = await fs.readFile(paths.unit(unit), 'utf8');
    const command = /^ExecStart=(.+)$/m.exec(text)[1].replaceAll(paths.live.installDir, paths.installDir);
    expect(command.startsWith(`/usr/bin/node ${paths.installDir}/`)).toBe(true);
    const result = spawnSync('sh', ['-c', command], { encoding: 'utf8', timeout: 5000 });
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual(expected);
  }
  const source = system.calls.find(([name]) => name === 'protectedMcp.options')[1].source;
  expect(source).toBe(path.join(await fs.realpath(paths.app), 'build/server'));
  expect((await fs.stat(path.join(root, await fs.readlink(paths.binLink)))).isFile()).toBe(true);
});

it('runs the emitted root wrapper with the original command arguments', async () => {
  // Given
  const root = await hostRoot(cleanups);
  await install(installOptions(root, fakeSystem(root), { separation: false }));
  const paths = layout(root);
  await fs.writeFile(path.join(paths.app, 'build/server/lib/host-install/main.js'), marker);
  // When
  const result = await runWrapper(paths);
  // Then
  expect(result.status, result.stderr).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual(['status', '--json']);
});

it('replaces the old managed CLI link when updating a legacy installation', async () => {
  // Given
  const { root, paths } = await legacyInstall();
  // When
  await update({ root, system: fakeSystem(root) });
  // Then
  expect(await fs.readlink(paths.binLink)).toBe(`${paths.live.app}/build/bin/cli.js`);
  expect((await fs.stat(path.join(root, await fs.readlink(paths.binLink)))).isFile()).toBe(true);
});

it('restores legacy units, CLI and protected MCP source when rolling back across layouts', async () => {
  // Given
  const { root, paths } = await legacyInstall();
  const oldUnit = await fs.readFile(paths.unit(APP_UNIT), 'utf8');
  await update({ root, system: fakeSystem(root) });
  await fs.writeFile(path.join(paths.app, 'build/server/lib/host-install/main.js'), marker);
  const updater = await fs.readFile(paths.unit(UPDATER_UNIT), 'utf8');
  const system = fakeSystem(root);
  // When
  await rollback({ root, system });
  // Then
  expect(await fs.readlink(paths.binLink)).toBe(`${paths.live.app}/bin/cli.js`);
  expect(await fs.readFile(paths.unit(APP_UNIT), 'utf8')).toBe(oldUnit);
  expect(await fs.readFile(paths.unit(UPDATER_UNIT), 'utf8')).toBe(updater);
  expect(system.calls.find(([name]) => name === 'protectedMcp.options')[1].source).toBe(path.join(await fs.realpath(paths.app), 'server'));
  const result = await runWrapper(paths);
  expect(result.status, result.stderr).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual(['status', '--json']);
});

it('keeps the legacy command usable when an emitted deployment fails health checks', async () => {
  // Given
  const { root, paths } = await legacyInstall();
  const system = fakeSystem(root, { broken: '2.7.0' });
  // When
  const result = update({ root, system });
  // Then
  await expect(result).rejects.toMatchObject({ code: 'not_started' });
  expect(await fs.readlink(paths.binLink)).toBe(`${paths.live.app}/bin/cli.js`);
  const command = await runWrapper(paths);
  expect(command.status, command.stderr).toBe(0);
  expect(JSON.parse(command.stdout)).toEqual(['status', '--json']);
});

it('keeps layout-aware management through two wrapper-invoked cross-layout rollbacks', async () => {
  // Given
  const { root, paths } = await legacyInstall();
  await update({ root, system: fakeSystem(root) });
  const source = (entry) => fileURLToPath(new URL(entry, import.meta.url));
  const driver = `
    import fs from 'node:fs/promises';
    import { cli } from ${JSON.stringify(source('./main.js'))};
    import { rollback } from ${JSON.stringify(source('./host-rollback.js'))};
    import { fakeSystem } from ${JSON.stringify(source('./fake-system.test-support.js'))};
    const root = ${JSON.stringify(root)};
    const system = fakeSystem(root);
    const install = system.protectedMcp.install;
    system.protectedMcp.install = async (options) => { await fs.access(options.source); return install(options); };
    process.exitCode = await cli(process.argv.slice(2), { commands: { rollback: () => rollback({ root, system }) } });
  `;
  await fs.writeFile(path.join(paths.app, 'build/server/lib/host-install/main.js'), driver);
  const previous = path.join(paths.installDir, await fs.readlink(path.join(paths.installDir, 'previous')));
  await fs.writeFile(path.join(previous, 'node_modules/@openchamber/web/server/lib/host-install/main.js'), 'throw new Error("Legacy management must not be selected");');
  const env = { ...process.env, NODE_OPTIONS: `--import=${source('../../../scripts/register-server-sources.mjs')}` };
  const updater = await fs.readFile(paths.unit(UPDATER_UNIT), 'utf8');
  // When: the same root wrapper performs both directions.
  const first = await runWrapper(paths, ['rollback', '--json'], env);
  const second = await runWrapper(paths, ['rollback', '--json'], env);
  // Then
  expect([first.status, second.status], `${first.stderr}\n${second.stderr}`).toEqual([0, 0]);
  expect([JSON.parse(first.stdout).version, JSON.parse(second.stdout).version]).toEqual(['2.6.0', '2.7.0']);
  expect(await fs.readlink(paths.binLink)).toBe(`${paths.live.app}/build/bin/cli.js`);
  expect(await fs.readlink(path.join(root, 'usr/lib/openchamber-protected-mcp/current'))).toBe('2.7.0');
  expect(await fs.readFile(paths.unit(UPDATER_UNIT), 'utf8')).toBe(updater);
});

it('leaves another installation\'s CLI link alone when updating', async () => {
  // Given
  const { root, paths } = await legacyInstall();
  await fs.unlink(paths.binLink);
  await fs.symlink('/other/openchamber', paths.binLink);
  // When
  await update({ root, system: fakeSystem(root) });
  // Then
  expect(await fs.readlink(paths.binLink)).toBe('/other/openchamber');
});
