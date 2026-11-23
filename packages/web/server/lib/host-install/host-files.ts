import { randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { hasCode, isRecord, isString } from './host-inputs.js';
import type { JsonObject, JsonValue } from './host-inputs.js';
import { PACKAGE_SUBDIR } from './host-paths.js';
import type { HostLayout, HostPaths } from './host-paths.js';

export interface RootFileSystem {
  chown(target: string, uid: number, gid: number): Promise<void>;
}

export async function exists(target: string): Promise<boolean> {
  try { await fs.lstat(target); return true; }
  catch (error) { if (hasCode(error, 'ENOENT')) return false; throw error; }
}

export async function readJson(file: string): Promise<JsonValue> {
  try { return JSON.parse(await fs.readFile(file, 'utf8')); }
  catch (error) { if (hasCode(error, 'ENOENT')) return null; throw error; }
}

export async function readOptionalText(file: string): Promise<string | null> {
  try { return await fs.readFile(file, 'utf8'); }
  catch (error) { if (hasCode(error, 'ENOENT')) return null; throw error; }
}

export async function writeRootFile(system: RootFileSystem, file: string, content: string, mode = 0o644): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o755 });
  const temporary = `${file}.${randomBytes(4).toString('hex')}`;
  try {
    await fs.writeFile(temporary, content, { mode, flag: 'wx' });
    await fs.chmod(temporary, mode);
    await system.chown(temporary, 0, 0);
    await fs.rename(temporary, file);
  } finally { await fs.rm(temporary, { force: true }); }
}

export const writeConfig = (system: RootFileSystem, paths: Pick<HostPaths, 'configFile'>, config: JsonObject): Promise<void> =>
  writeRootFile(system, paths.configFile, `${JSON.stringify(config, null, 2)}\n`);

export async function replaceSymlink(link: string, destination: string): Promise<void> {
  const temporary = `${link}.${randomBytes(4).toString('hex')}`;
  await fs.symlink(destination, temporary);
  await fs.rename(temporary, link);
}

export async function linkCommand(paths: HostLayout, say: (message: string) => void): Promise<void> {
  const emitted = path.join(paths.live.app, 'build/bin/cli.js');
  const legacy = path.join(paths.live.app, 'bin/cli.js');
  const target = await exists(path.join(paths.app, 'build/bin/cli.js')) ? emitted : legacy;
  let existing: string | null;
  try { existing = await fs.readlink(paths.binLink); }
  catch (error) { existing = hasCode(error, 'ENOENT') ? null : 'other'; }
  if (existing !== null && ![emitted, legacy].includes(existing)) { say(`${paths.live.binLink} already exists and was left as it is.`); return; }
  await fs.mkdir(path.dirname(paths.binLink), { recursive: true, mode: 0o755 });
  await replaceSymlink(paths.binLink, target);
}

export async function linkedVersion(paths: Pick<HostPaths, 'installDir'>, link: string): Promise<string | null> {
  const target = await fs.readlink(path.join(paths.installDir, link)).catch(() => null);
  if (!target) return null;
  const manifest = await readJson(path.join(paths.installDir, target, PACKAGE_SUBDIR, 'package.json')).catch(() => null);
  return isRecord(manifest) && isString(manifest['version']) ? manifest['version'] : null;
}
