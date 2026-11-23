import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { exists, linkedVersion, readJson, writeRootFile } from './host-files.js';
import { layout, PACKAGE_SUBDIR } from './host-paths.js';

const scratch = [];
afterEach(async () => { for (const directory of scratch.splice(0)) await fs.rm(directory, { recursive: true, force: true }); });
const directory = async () => {
  const root = await fs.mkdtemp('/tmp/opencode/host-files-');
  scratch.push(root);
  return root;
};

it('roots disk paths without changing the live paths used by systemd', async () => {
  // Given
  const root = await directory();
  // When
  const paths = layout(root);
  // Then
  for (const [name, live] of Object.entries(paths.live)) expect(paths[name]).toBe(path.join(root, live));
  expect(paths.live.app).toBe('/usr/lib/openchamber/current/node_modules/@openchamber/web');
  expect(paths.unit('openchamber.service')).toBe(path.join(root, 'etc/systemd/system/openchamber.service'));
});

it('returns null for a missing JSON file', async () => {
  // Given
  const missing = path.join(await directory(), 'missing.json');
  // When
  const value = await readJson(missing);
  // Then
  expect(value).toBeNull();
});

it('propagates malformed JSON instead of reporting a missing file', async () => {
  // Given
  const file = path.join(await directory(), 'broken.json');
  await fs.writeFile(file, '{');
  // When
  const value = readJson(file);
  // Then
  await expect(value).rejects.toBeInstanceOf(SyntaxError);
});

it('propagates disk read failures instead of reporting a missing file', async () => {
  // Given
  const file = await directory();
  // When
  const value = readJson(file);
  // Then
  await expect(value).rejects.toMatchObject({ code: 'EISDIR' });
});

it('recognizes a broken symlink as an existing entry', async () => {
  // Given
  const link = path.join(await directory(), 'link');
  await fs.symlink('missing', link);
  // When
  const value = await exists(link);
  // Then
  expect(value).toBe(true);
});

it('preserves the previous file and removes scratch when ownership cannot be set', async () => {
  // Given
  const root = await directory();
  const file = path.join(root, 'host.json');
  await fs.writeFile(file, 'previous');
  const failure = Object.assign(new Error('fixture ownership failure'), { code: 'EPERM' });
  const system = { chown: async () => { throw failure; } };
  // When
  const result = writeRootFile(system, file, 'replacement', 0o600);
  // Then
  await expect(result).rejects.toBe(failure);
  expect(await fs.readFile(file, 'utf8')).toBe('previous');
  expect(await fs.readdir(root)).toEqual(['host.json']);
});

it.each(['{"version":"2.7.3"}', '{"version":42}', '{', 'null'])(
  'reads only a string package version from a retained deployment: %s', async (manifest) => {
    // Given
    const paths = layout(await directory());
    const app = path.join(paths.installDir, 'retained', PACKAGE_SUBDIR);
    await fs.mkdir(app, { recursive: true });
    await fs.writeFile(path.join(app, 'package.json'), manifest);
    await fs.symlink('retained', paths.current);
    // When
    const version = await linkedVersion(paths, 'current');
    // Then
    expect(version).toBe(manifest === '{"version":"2.7.3"}' ? '2.7.3' : null);
  },
);
