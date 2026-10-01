// Chrome for the machines that have none: the service downloads Google's
// Chrome for Testing into its own data directory, without root, so installing
// the extension is enough. What it cannot do without root is install the
// system libraries Chrome links against; for those it names the missing
// libraries and the exact command to install them.
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const VERSIONS_URL = 'https://googlechromelabs.github.io/chrome-for-testing/last-known-good-versions-with-downloads.json';
const PLATFORM = 'linux64';

// Extracts a zip archive with Node's own inflate, so the host needs no unzip.
export const extractZip = async (buffer, destination) => {
  const root = path.resolve(destination);
  let end = buffer.length - 22;
  while (end >= 0 && buffer.readUInt32LE(end) !== 0x06054b50) end -= 1;
  if (end < 0) throw new Error('The Chrome download is not a zip archive');
  const entries = buffer.readUInt16LE(end + 10);
  let offset = buffer.readUInt32LE(end + 16);
  for (let index = 0; index < entries; index += 1) {
    if (buffer.readUInt32LE(offset) !== 0x02014b50) throw new Error('The Chrome download is damaged');
    const method = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const mode = (buffer.readUInt32LE(offset + 38) >>> 16) & 0o777;
    const localOffset = buffer.readUInt32LE(offset + 42);
    const name = buffer.subarray(offset + 46, offset + 46 + nameLength).toString('utf8');
    offset += 46 + nameLength + extraLength + commentLength;
    const target = path.resolve(root, name);
    if (target !== root && !target.startsWith(`${root}${path.sep}`)) throw new Error('The Chrome download names a path outside its folder');
    if (name.endsWith('/')) {
      await fs.promises.mkdir(target, { recursive: true });
      continue;
    }
    const dataStart = localOffset + 30 + buffer.readUInt16LE(localOffset + 26) + buffer.readUInt16LE(localOffset + 28);
    const data = buffer.subarray(dataStart, dataStart + compressedSize);
    const contents = method === 0 ? data : method === 8 ? zlib.inflateRawSync(data) : null;
    if (!contents) throw new Error(`The Chrome download uses an unsupported compression (${method})`);
    await fs.promises.mkdir(path.dirname(target), { recursive: true });
    await fs.promises.writeFile(target, contents, { mode: mode || 0o644 });
  }
};

const run = (command, args) => new Promise((resolve) => {
  execFile(command, args, { timeout: 10_000, maxBuffer: 4 * 1024 * 1024 }, (error, stdout) => resolve(error && !stdout ? '' : String(stdout)));
});

// The shared libraries the dynamic linker cannot find for this binary.
export const missingLibraries = async (binary) => {
  const output = await run('ldd', [binary]);
  return [...new Set([...output.matchAll(/^\s*(\S+)\s+=>\s+not found/gm)].map((match) => match[1]))];
};

// Chrome for Testing lists its Debian dependencies next to the binary.
export const aptCommand = async (binary) => {
  const deps = await fs.promises.readFile(path.join(path.dirname(binary), 'deb.deps'), 'utf8').catch(() => '');
  const packages = [...new Set(deps.split('\n').map((line) => line.trim().split(/[\s(]/)[0]).filter(Boolean))];
  return packages.length > 0 ? `sudo apt-get install -y ${packages.join(' ')}` : null;
};

export const describeMissingLibraries = async (binary) => {
  const missing = await missingLibraries(binary);
  if (missing.length === 0) return null;
  const command = await aptCommand(binary);
  return `Chrome is installed but this machine lacks libraries it needs (${missing.join(', ')}).${command ? ` Run this once on the server, then retry: ${command}` : ' Install them with the system package manager, then retry.'}`;
};

export const createChromeInstaller = ({ directory, fetchImpl = fetch, platform = process.platform, arch = process.arch }) => {
  let state = { status: 'idle', message: '', path: null, version: null };
  let installing = null;
  // Read back from the `current` file by `installed()`, the only other
  // place that knows it, so `GET /chrome` can name a version without
  // re-downloading or launching Chrome to ask it.
  let installedVersion = null;

  const binaryIn = (versionDirectory) => path.join(versionDirectory, 'chrome-linux64', 'chrome');

  const installed = async () => {
    const current = await fs.promises.readFile(path.join(directory, 'current'), 'utf8').catch(() => '');
    const version = current.trim();
    if (!version) return null;
    const binary = binaryIn(path.join(directory, version));
    const found = await fs.promises.access(binary, fs.constants.X_OK).then(() => binary, () => null);
    if (found) installedVersion = version;
    return found;
  };

  const install = async () => {
    if (platform !== 'linux' || arch !== 'x64') {
      throw new Error('Chrome or Chromium was not found, and it can be downloaded automatically only on Linux x64. Install Chrome or set chromePath in config.json.');
    }
    state = { status: 'installing', message: 'Downloading Chrome for the shared browser' };
    const versions = await (await fetchImpl(VERSIONS_URL)).json();
    const stable = versions?.channels?.Stable;
    const download = stable?.downloads?.chrome?.find((entry) => entry.platform === PLATFORM);
    if (!stable?.version || !download?.url) throw new Error('Could not find a Chrome download for this machine');
    // A 200 MB download over a flaky link gets a few tries before giving up.
    let archive = null;
    for (let attempt = 1; !archive; attempt += 1) {
      try {
        const response = await fetchImpl(download.url);
        if (!response.ok) throw new Error(`Downloading Chrome failed (HTTP ${response.status})`);
        archive = Buffer.from(await response.arrayBuffer());
      } catch (error) {
        if (attempt >= 3) throw error;
        state = { status: 'installing', message: `Downloading Chrome for the shared browser (retry ${attempt})` };
      }
    }
    state = { status: 'installing', message: `Unpacking Chrome ${stable.version}`, path: null, version: null };
    const versionDirectory = path.join(directory, stable.version);
    const staging = `${versionDirectory}.partial`;
    await fs.promises.rm(staging, { recursive: true, force: true });
    await fs.promises.mkdir(staging, { recursive: true, mode: 0o700 });
    await extractZip(archive, staging);
    await fs.promises.rm(versionDirectory, { recursive: true, force: true });
    await fs.promises.rename(staging, versionDirectory);
    await fs.promises.writeFile(path.join(directory, 'current'), `${stable.version}\n`);
    installedVersion = stable.version;
    return binaryIn(versionDirectory);
  };

  return {
    get state() {
      return { ...state };
    },
    installed,
    // The managed Chrome, downloading it once when there is none yet.
    ensure() {
      installing ??= (async () => {
        const binary = (await installed()) ?? (await install());
        const problem = await describeMissingLibraries(binary);
        state = problem
          ? { status: 'missing-libraries', message: problem, path: binary, version: installedVersion }
          : { status: 'ready', message: '', path: binary, version: installedVersion };
        return binary;
      })().catch((error) => {
        state = { status: 'failed', message: error instanceof Error ? error.message : String(error), path: null, version: null };
        throw error;
      }).finally(() => {
        installing = null;
      });
      return installing;
    },
  };
};
