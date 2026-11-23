import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { ProtectedMcpError } from './contract.js';

type OwnershipSystem = { readonly chown: (target: string, uid: number, gid: number) => Promise<void> };
type InstallTree = {
  readonly system: OwnershipSystem;
  readonly source: string;
  readonly files: readonly string[];
  readonly target: string;
  readonly version: string;
};

export async function sourceFiles(source: string): Promise<string[]> {
  const service = path.join(source, 'lib', 'protected-mcp', 'service');
  const names = (await fs.readdir(service)).filter((name) => name.endsWith('.js') && !name.endsWith('.test.js')).sort();
  if (!names.includes('main.js') || !names.includes('relay.js')) throw new ProtectedMcpError('invalid_source', { status: 500, message: `${service} has no service` });
  return [
    ...names.map((name) => path.join('lib', 'protected-mcp', 'service', name)),
    path.join('lib', 'shared', 'guards.js'),
    path.join('lib', 'shared', 'object-guards.js'),
  ];
}

export async function copyTree({ system, source, files, target, version }: InstallTree): Promise<string> {
  const staging = `${target}.staging-${randomBytes(4).toString('hex')}`;
  const digest = createHash('sha256');
  try {
    await fs.mkdir(staging, { recursive: true, mode: 0o755 });
    for (const file of files) {
      const destination = path.join(staging, file);
      await fs.mkdir(path.dirname(destination), { recursive: true, mode: 0o755 });
      const content = await fs.readFile(path.join(source, file));
      digest.update(file).update(content);
      await fs.writeFile(destination, content, { mode: 0o644 });
    }
    await fs.writeFile(path.join(staging, 'package.json'), `${JSON.stringify({ name: 'openchamber-protected-mcp', private: true, type: 'module', version }, null, 2)}\n`, { mode: 0o644 });
    for (const entry of await fs.readdir(staging, { recursive: true, withFileTypes: true })) {
      const full = path.join(entry.parentPath, entry.name);
      await fs.chmod(full, entry.isDirectory() ? 0o755 : 0o644);
      await system.chown(full, 0, 0);
    }
    await fs.chmod(staging, 0o755);
    await system.chown(staging, 0, 0);
    await fs.rm(target, { recursive: true, force: true });
    await fs.rename(staging, target);
  } finally {
    await fs.rm(staging, { recursive: true, force: true });
  }
  return digest.digest('hex');
}

export const replaceSymlink = async (link: string, destination: string): Promise<void> => {
  const temporary = `${link}.${randomBytes(4).toString('hex')}`;
  await fs.symlink(destination, temporary);
  await fs.rename(temporary, link);
};

export const ensureRootDirectory = async (system: OwnershipSystem, directory: string, { own = false }: { readonly own?: boolean } = {}): Promise<void> => {
  const missing: string[] = [];
  for (let current = directory; ; current = path.dirname(current)) {
    if (await fs.stat(current).then(() => true, () => false)) break;
    missing.unshift(current);
    if (path.dirname(current) === current) break;
  }
  for (const created of missing) {
    try {
      await fs.mkdir(created, { mode: 0o755 });
    } catch (error) {
      if (!(error instanceof Error) || !('code' in error) || error.code !== 'EEXIST') throw error;
    }
  }
  for (const target of own && missing.length === 0 ? [directory] : missing) {
    await fs.chmod(target, 0o755);
    await system.chown(target, 0, 0);
  }
};

export const writeRootFile = async (system: OwnershipSystem, file: string, content: string, { mode = 0o644, own = true }: { readonly mode?: number; readonly own?: boolean } = {}): Promise<void> => {
  await ensureRootDirectory(system, path.dirname(file), { own });
  const temporary = `${file}.${randomBytes(4).toString('hex')}`;
  await fs.writeFile(temporary, content, { mode });
  await fs.chmod(temporary, mode);
  await system.chown(temporary, 0, 0);
  await fs.rename(temporary, file);
};
