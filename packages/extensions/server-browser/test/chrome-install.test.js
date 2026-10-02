import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import zlib from 'node:zlib';
import { createChromeInstaller, extractZip } from '../src/chrome-install.js';

// A minimal zip archive with deflated entries, built the way zip tools write it.
const zip = (files) => {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const { name, contents, mode = 0o644 } of files) {
    const data = zlib.deflateRawSync(Buffer.from(contents));
    const nameBytes = Buffer.from(name);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(contents.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(contents.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(((0o100000 | mode) << 16) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    locals.push(local, nameBytes, data);
    centrals.push(central, nameBytes);
    offset += local.length + nameBytes.length + data.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
};

const scratch = (context) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'chrome-install-test-'));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
};

test('unpacks a zip with executable modes and refuses paths outside its folder', async (context) => {
  const directory = scratch(context);
  await extractZip(zip([{ name: 'chrome-linux64/chrome', contents: '#!/bin/sh\necho ok\n', mode: 0o755 }, { name: 'chrome-linux64/deb.deps', contents: 'libnss3 (>= 3.26)\nlibgbm1\n' }]), directory);
  assert.equal(fs.statSync(path.join(directory, 'chrome-linux64', 'chrome')).mode & 0o111, 0o111);
  await assert.rejects(extractZip(zip([{ name: '../escape', contents: 'x' }]), path.join(directory, 'inner')), /outside its folder/);
  assert.equal(fs.existsSync(path.join(directory, 'escape')), false);
});

test('downloads Chrome once, retries a failed download, and reuses it afterwards', async (context) => {
  const directory = scratch(context);
  let archiveRequests = 0;
  const fetchImpl = async (url) => {
    if (url.endsWith('.json')) {
      return { ok: true, json: async () => ({ channels: { Stable: { version: '1.2.3', downloads: { chrome: [{ platform: 'linux64', url: 'https://example.test/chrome.zip' }] } } } }) };
    }
    archiveRequests += 1;
    if (archiveRequests === 1) throw new Error('connection reset');
    return { ok: true, arrayBuffer: async () => zip([{ name: 'chrome-linux64/chrome', contents: '#!/bin/sh\n', mode: 0o755 }]) };
  };
  const installer = createChromeInstaller({ directory, fetchImpl, platform: 'linux', arch: 'x64' });
  const binary = await installer.ensure();
  assert.equal(binary, path.join(directory, '1.2.3', 'chrome-linux64', 'chrome'));
  assert.equal(archiveRequests, 2);
  assert.equal(await createChromeInstaller({ directory, fetchImpl: () => assert.fail('no second download'), platform: 'linux', arch: 'x64' }).ensure(), binary);

  // Where no build exists, it says what to do instead.
  await assert.rejects(createChromeInstaller({ directory: path.join(directory, 'mac'), platform: 'darwin', arch: 'arm64' }).ensure(), /only on Linux x64/);
});
