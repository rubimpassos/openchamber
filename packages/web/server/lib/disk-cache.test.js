import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'bun:test';

import { createDiskCache } from './disk-cache.js';

const dirs = [];
const tempDir = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'disk-cache-'));
  dirs.push(dir);
  return dir;
};

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('createDiskCache', () => {
  it('answers a miss, then the stored bytes and metadata', async () => {
    const cache = createDiskCache({ dir: path.join(tempDir(), 'nested'), maxBytes: 1024, label: 'test' });
    expect(await cache.get({ text: 'hello' })).toBeNull();

    await cache.set({ text: 'hello' }, Buffer.from([1, 2, 10, 3]), { contentType: 'audio/mpeg' });
    const hit = await cache.get({ text: 'hello' });

    expect(hit?.meta).toEqual({ contentType: 'audio/mpeg' });
    expect([...hit.buffer]).toEqual([1, 2, 10, 3]);
    expect(await cache.get({ text: 'hello', voice: 'other' })).toBeNull();
  });

  it('evicts the least recently used entries past the size limit', async () => {
    const dir = tempDir();
    const cache = createDiskCache({ dir, maxBytes: 250, label: 'test' });
    const bytes = Buffer.alloc(90);
    await cache.set('old', bytes);
    await cache.set('used', bytes);
    // Age both, then read one so it counts as recently used.
    const past = new Date(Date.now() - 60_000);
    for (const name of fs.readdirSync(dir)) fs.utimesSync(path.join(dir, name), past, past);
    expect(await cache.get('used')).not.toBeNull();
    await new Promise((resolve) => setTimeout(resolve, 20));

    await cache.set('new', bytes);

    expect(await cache.get('old')).toBeNull();
    expect(await cache.get('used')).not.toBeNull();
    expect(await cache.get('new')).not.toBeNull();
  });

  it('treats a corrupt entry as a miss and never throws on a failed write', async () => {
    const dir = tempDir();
    const cache = createDiskCache({ dir, maxBytes: 1024, label: 'test' });
    await cache.set('key', Buffer.from('x'));
    for (const name of fs.readdirSync(dir)) fs.writeFileSync(path.join(dir, name), 'no header');
    expect(await cache.get('key')).toBeNull();

    const blocked = path.join(dir, 'file');
    fs.writeFileSync(blocked, '');
    await createDiskCache({ dir: blocked, maxBytes: 1024, label: 'test' }).set('key', Buffer.from('x'));
  });
});
