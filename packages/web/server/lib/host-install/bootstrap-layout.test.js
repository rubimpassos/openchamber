import fs from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, it } from 'vitest';

const scratch = [];
afterEach(async () => { for (const directory of scratch.splice(0)) await fs.rm(directory, { recursive: true, force: true }); });
const script = fileURLToPath(new URL('../../../../../scripts/install.sh', import.meta.url));

async function releaseFixture() {
  const directory = await fs.mkdtemp('/tmp/opencode/host-release-');
  scratch.push(directory);
  const source = path.join(directory, 'source');
  const workdir = path.join(directory, 'unpacked');
  const write = async (file, text) => { await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, text); };
  await fs.mkdir(workdir);
  await write(path.join(source, 'package/package.json'), '{"name":"@openchamber/web","version":"2.7.3","type":"module"}');
  for (const entry of ['host-install/main.js', 'protected-mcp/service/install.js']) {
    await write(path.join(source, 'package/build/server/lib', entry), 'import fs from "node:fs"; fs.writeFileSync(process.env.CAPTURE, JSON.stringify(process.argv.slice(2)));');
    await write(path.join(source, 'package/server/lib', entry), 'throw new Error("The source entrypoint must not run");');
  }
  const archive = path.join(directory, 'release.tgz');
  const packed = spawnSync('tar', ['-czf', archive, '-C', source, 'package'], { encoding: 'utf8', timeout: 5000 });
  if (packed.status !== 0) throw new Error(packed.stderr);
  const bytes = await fs.readFile(archive);
  return { directory, workdir, archive, bytes, captured: path.join(directory, 'arguments.json') };
}

function runBootstrap(fixture, mode) {
  const sha256 = createHash('sha256').update(fixture.bytes).digest('hex');
  const integrity = `sha512-${createHash('sha512').update(fixture.bytes).digest('base64')}`;
  const program = [
    '. "$1"',
    'uname() { printf "Linux\\n"; }; id() { printf "0\\n"; }',
    'protected_mcp_node() { printf "%s\\n" "$NODE"; }',
    'protected_mcp_trusted_path() { return 0; }',
    'protected_mcp_remove_on_exit() { :; }',
    'mktemp() { printf "%s\\n" "$WORKDIR"; }',
    'curl() { case "$*" in *" -o "*) cp "$ARCHIVE" "${@: -1}";; *) printf "%s\\n" "$METADATA";; esac; }',
    'chown() { :; }; chmod() { :; }',
    'shift; main "$@"',
  ].join('\n');
  const metadata = mode === 'host'
    ? { tag_name: 'v2.7.3', assets: [{ name: 'openchamber-web-2.7.3.tgz', digest: `sha256:${sha256}`, browser_download_url: 'https://fixture.invalid/release' }] }
    : { dist: { tarball: 'https://fixture.invalid/release', integrity } };
  const options = mode === 'host' ? ['--owner', 'fixture-owner', '--repo', 'fixture/repo'] : ['--engine-user', 'fixture-agent'];
  const result = spawnSync('bash', ['-c', program, 'fixture', script, `--${mode}`, ...options], {
    env: { PATH: process.env.PATH, OPENCHAMBER_INSTALL_FUNCTIONS_ONLY: '1', NODE: process.execPath,
      WORKDIR: fixture.workdir, ARCHIVE: fixture.archive, CAPTURE: fixture.captured, METADATA: JSON.stringify(metadata) },
    encoding: 'utf8', timeout: 10_000,
  });
  return { result, options };
}

it.each(['host', 'protected-mcp'])('launches the emitted %s installer from a verified tarball without host changes', async (mode) => {
  // Given
  const fixture = await releaseFixture();
  // When
  const { result, options } = runBootstrap(fixture, mode);
  // Then
  expect(result.status, result.stderr || result.stdout).toBe(0);
  const forwarded = JSON.parse(await fs.readFile(fixture.captured, 'utf8'));
  expect(forwarded[0]).toBe('install');
  for (let index = 0; index < options.length; index += 2) expect(forwarded.slice(forwarded.lastIndexOf(options[index]), forwarded.lastIndexOf(options[index]) + 2)).toEqual(options.slice(index, index + 2));
  if (mode === 'protected-mcp') {
    expect(forwarded.slice(forwarded.indexOf('--source'), forwarded.indexOf('--source') + 2)).toEqual(['--source', path.join(fixture.workdir, 'package/build/server')]);
  } else {
    expect(forwarded.slice(forwarded.indexOf('--tarball'), forwarded.indexOf('--tarball') + 2)).toEqual(['--tarball', path.join(fixture.workdir, 'package.tgz')]);
  }
});

it.each(['host', 'protected-mcp'])('refuses the %s installer when downloaded bytes differ from the recorded digest', async (mode) => {
  // Given
  const fixture = await releaseFixture();
  await fs.appendFile(fixture.archive, 'tampered');
  // When
  const { result } = runBootstrap(fixture, mode);
  // Then
  expect(result.status, result.stderr || result.stdout).toBe(1);
  await expect(fs.stat(fixture.captured)).rejects.toMatchObject({ code: 'ENOENT' });
});
