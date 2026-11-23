import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { downloadRelease, findRelease, obtainPackage } from './release.js';

const digest = (content) => createHash('sha256').update(content).digest('hex');
const answer = (body, status = 200) => async () => new Response(body, { status });
const json = (value) => answer(JSON.stringify(value));
const asset = (name, extra = {}) => ({ name, browser_download_url: `https://example.test/${name}`, digest: `sha256:${'a'.repeat(64)}`, ...extra });
const scratch = [];
afterEach(async () => { for (const directory of scratch.splice(0)) await fs.rm(directory, { recursive: true, force: true }); });

describe('host release lookup', () => {
  it('picks the web package of the release version and its recorded digest', async () => {
    const release = await findRelease({
      repo: 'example/openchamber',
      fetchImpl: json({ tag_name: 'v2.7.0', assets: [asset('openchamber-sdk-2.7.0.tgz'), asset('openchamber-web-2.6.9.tgz'), asset('openchamber-web-2.7.0.tgz')] }),
    });
    expect(release).toEqual({ version: '2.7.0', url: 'https://example.test/openchamber-web-2.7.0.tgz', sha256: 'a'.repeat(64) });
  });

  it('refuses a package GitHub recorded no digest for', async () => {
    const result = findRelease({ repo: 'example/openchamber', fetchImpl: json({ tag_name: 'v2.7.0', assets: [asset('openchamber-web-2.7.0.tgz', { digest: null })] }) });
    await expect(result).rejects.toMatchObject({ code: 'digest_missing' });
  });

  it('reports an unreachable release as a failure', async () => {
    await expect(findRelease({ repo: 'example/openchamber', fetchImpl: answer('', 503) })).rejects.toMatchObject({ code: 'release_unavailable' });
  });

  it.each([null, [], { tag_name: 'v2.7.0', assets: [null, 1, 'asset'] },
    { tag_name: 'v2.7.0', assets: [asset('openchamber-web-2.7.0.tgz', { browser_download_url: null })] }])(
    'refuses release inputs without a usable package: %j', async (payload) => {
      // Given
      const fetchImpl = json(payload);
      // When
      const result = findRelease({ repo: 'example/openchamber', fetchImpl });
      // Then
      await expect(result).rejects.toMatchObject({ code: 'package_missing' });
    },
  );

  it('keeps a download only when its digest matches', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'host-release-'));
    try {
      const file = path.join(directory, 'package.tgz');
      await downloadRelease({ url: 'https://example.test/p.tgz', sha256: digest('good') }, file, { fetchImpl: answer('good') });
      expect(await fs.readFile(file, 'utf8')).toBe('good');
      const tampered = downloadRelease({ url: 'https://example.test/p.tgz', sha256: digest('good') }, file, { fetchImpl: answer('evil') });
      await expect(tampered).rejects.toMatchObject({ code: 'digest_mismatch' });
      expect(await fs.stat(file).catch(() => null)).toBeNull();
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });
});

it.each([null, '', '../outside', '2.7.3/../../outside'])('rejects an explicit tarball without a safe version: %j', async (version) => {
  // Given: no release adapter is needed for a supplied archive.
  const options = { system: {}, paths: {}, config: {}, tarball: '/fixture/archive.tgz', version };
  // When
  const result = obtainPackage(options);
  // Then
  await expect(result).rejects.toMatchObject({ code: 'invalid_version' });
});

it('keeps a supplied tarball after source cleanup', async () => {
  // Given
  const directory = await fs.mkdtemp('/tmp/opencode/host-source-');
  scratch.push(directory);
  const tarball = path.join(directory, 'supplied.tgz');
  await fs.writeFile(tarball, 'supplied');
  const source = await obtainPackage({ system: {}, paths: {}, config: {}, tarball, version: '2.7.3' });
  // When
  await source.cleanup();
  // Then
  expect(await fs.readFile(tarball, 'utf8')).toBe('supplied');
});

it('uses the already selected release and cleans only its cached download', async () => {
  // Given
  const cacheDir = await fs.mkdtemp('/tmp/opencode/host-source-');
  scratch.push(cacheDir);
  const keep = path.join(cacheDir, 'unrelated.tgz');
  await fs.writeFile(keep, 'keep');
  const release = { version: '2.7.3', url: 'https://fixture.invalid/release', sha256: digest('package') };
  const system = { downloadRelease: async (selected, file) => {
    await downloadRelease(selected, file, { fetchImpl: answer('package') });
  } };
  const source = await obtainPackage({ system, paths: { cacheDir }, config: {}, release });
  expect(await fs.readFile(source.tarball, 'utf8')).toBe('package');
  // When
  await source.cleanup();
  // Then
  expect(await fs.readdir(cacheDir)).toEqual(['unrelated.tgz']);
});
