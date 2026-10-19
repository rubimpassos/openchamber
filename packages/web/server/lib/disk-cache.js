import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

/**
 * A size-bounded cache of byte entries in one directory, for results that cost
 * money to produce again (synthesized speech, small-model text). A key is any
 * JSON value; its SHA-256 names the file. Each file is one JSON header line
 * (the entry's metadata) followed by the bytes. A hit refreshes the file's
 * mtime, and a write past `maxBytes` deletes the least recently used entries
 * down to 90 percent of it.
 *
 * A cache never fails its caller: an unreadable entry is a miss and a failed
 * write is logged and dropped.
 */
export function createDiskCache({ dir, maxBytes, label }) {
  const fileFor = (key) => path.join(dir, crypto.createHash('sha256').update(JSON.stringify(key)).digest('hex'));

  const get = async (key) => {
    const file = fileFor(key);
    let raw;
    try {
      raw = await fs.readFile(file);
    } catch (error) {
      if (error?.code !== 'ENOENT') console.warn(`[${label}] cache read failed:`, error?.message ?? error);
      return null;
    }
    const newline = raw.indexOf(0x0a);
    if (newline < 0) return null;
    let meta;
    try {
      meta = JSON.parse(raw.subarray(0, newline).toString('utf8'));
    } catch {
      return null;
    }
    const now = new Date();
    fs.utimes(file, now, now).catch(() => {});
    return { meta, buffer: raw.subarray(newline + 1) };
  };

  const prune = async () => {
    const names = await fs.readdir(dir);
    const entries = [];
    for (const name of names) {
      if (name.endsWith('.tmp')) continue;
      const stat = await fs.stat(path.join(dir, name)).catch(() => null);
      if (stat?.isFile()) entries.push({ name, size: stat.size, mtimeMs: stat.mtimeMs });
    }
    let total = entries.reduce((sum, entry) => sum + entry.size, 0);
    if (total <= maxBytes) return;
    entries.sort((a, b) => a.mtimeMs - b.mtimeMs);
    for (const entry of entries) {
      if (total <= maxBytes * 0.9) break;
      await fs.rm(path.join(dir, entry.name), { force: true });
      total -= entry.size;
    }
  };

  const set = async (key, buffer, meta = {}) => {
    try {
      await fs.mkdir(dir, { recursive: true, mode: 0o700 });
      const file = fileFor(key);
      const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
      await fs.writeFile(temp, Buffer.concat([Buffer.from(`${JSON.stringify(meta)}\n`, 'utf8'), buffer]), { mode: 0o600 });
      await fs.rename(temp, file);
      await prune();
    } catch (error) {
      console.warn(`[${label}] cache write failed:`, error?.message ?? error);
    }
  };

  return { get, set };
}
