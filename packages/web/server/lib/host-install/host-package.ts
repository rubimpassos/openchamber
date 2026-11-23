import { randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fail, hasCode, isRecord } from './host-inputs.js';
import { readJson } from './host-files.js';
import type { RootFileSystem } from './host-files.js';
import { PACKAGE_SUBDIR } from './host-paths.js';
import type { HostPaths, HostToolchain } from './host-paths.js';

interface PackageSystem extends RootFileSystem {
  npm(node: string, npmCli: string, args: readonly string[], env: Readonly<Record<string, string>>): Promise<string | void>;
}

type PackageInstall = {
  readonly system: PackageSystem;
  readonly paths: Pick<HostPaths, 'installDir' | 'cacheDir'>;
  readonly toolchain: HostToolchain;
  readonly root: string;
  readonly tarball: string;
  readonly version: string;
};

async function sealTree(system: RootFileSystem, directory: string): Promise<void> {
  for (const entry of await fs.readdir(directory, { recursive: true, withFileTypes: true })) {
    const full = path.join(entry.parentPath, entry.name);
    await system.chown(full, 0, 0);
    if (entry.isSymbolicLink()) continue;
    const executable = entry.isDirectory() || ((await fs.stat(full)).mode & 0o111) !== 0;
    await fs.chmod(full, executable ? 0o755 : 0o644);
  }
  await system.chown(directory, 0, 0);
  await fs.chmod(directory, 0o755);
}

export async function installPackage({ system, paths, toolchain, root, tarball, version }: PackageInstall): Promise<string> {
  await fs.mkdir(paths.installDir, { recursive: true, mode: 0o755 });
  await system.chown(paths.installDir, 0, 0);
  await fs.chmod(paths.installDir, 0o755);
  await fs.mkdir(paths.cacheDir, { recursive: true, mode: 0o700 });
  const staging = path.join(paths.installDir, `.staging-${randomBytes(4).toString('hex')}`);
  const name = `${version}-${randomBytes(4).toString('hex')}`;
  try {
    await fs.mkdir(staging, { mode: 0o755 });
    await system.npm(path.join(root, toolchain.node), path.join(root, toolchain.npm), [
      'install', '--prefix', staging, '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund', '--no-update-notifier', tarball,
    ], { PATH: '/usr/local/bin:/usr/bin:/bin', HOME: paths.cacheDir, npm_config_cache: path.join(paths.cacheDir, 'npm'), npm_config_userconfig: '/dev/null' });
    const installed = await readJson(path.join(staging, PACKAGE_SUBDIR, 'package.json'));
    const installedName = isRecord(installed) ? installed['name'] : undefined;
    const installedVersion = isRecord(installed) ? installed['version'] : undefined;
    if (installedName !== '@openchamber/web' || installedVersion !== version) fail('package_mismatch', `The package installed ${installedName ?? '?'}@${installedVersion ?? '?'}, expected @openchamber/web@${version}`);
    for (const entry of ['build/server/lib/host-install/main.js', 'build/bin/cli.js', 'build/bin/cli-runtime.js',
      'build/server/index.js', 'build/server/runtime.js', 'build/server/lib/hostd/main.js', 'build/server/lib/opencode/v2-install.js',
      'build/server/lib/protected-mcp/service/install.js', 'build/server/lib/protected-mcp/service/main.js', 'build/server/lib/protected-mcp/service/relay.js']) {
      try { if ((await fs.stat(path.join(staging, PACKAGE_SUBDIR, entry))).isFile()) continue; }
      catch (error) { if (!hasCode(error, 'ENOENT')) throw error; }
      fail(entry === 'build/server/lib/host-install/main.js' ? 'no_host_installer' : 'incomplete_package', `OpenChamber ${version} is missing ${entry}`);
    }
    await sealTree(system, staging);
    await fs.rename(staging, path.join(paths.installDir, name));
  } finally { await fs.rm(staging, { recursive: true, force: true }); }
  return name;
}

export async function pruneVersions(paths: Pick<HostPaths, 'installDir'>): Promise<void> {
  const keep = new Set<string>();
  for (const link of ['current', 'previous']) {
    const target = await fs.readlink(path.join(paths.installDir, link)).catch(() => null);
    if (target) keep.add(target);
  }
  for (const entry of await fs.readdir(paths.installDir)) {
    if (entry === 'current' || entry === 'previous' || keep.has(entry) || entry.startsWith('.staging-')) continue;
    await fs.rm(path.join(paths.installDir, entry), { recursive: true, force: true });
  }
}
