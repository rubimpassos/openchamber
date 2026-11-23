import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import type { JsonValue } from './shared/json-values.js';

const headerSchema = z.object({ contentType: z.string().optional() }).passthrough();
type CacheHeader = z.infer<typeof headerSchema>;
type CacheOptions = { readonly dir: string; readonly maxBytes: number; readonly label: string };

export function createDiskCache<Key = JsonValue>({ dir, maxBytes, label }: CacheOptions) {
  const fileFor = (key: Key) => path.join(dir, crypto.createHash('sha256').update(JSON.stringify(key)).digest('hex'));

  const get = async (key: Key) => {
    const file = fileFor(key);
    let raw;
    try {
      raw = await fs.readFile(file);
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) {
        console.warn(`[${label}] cache read failed:`, error instanceof Error ? error.message : error);
      }
      return null;
    }
    const newline = raw.indexOf(0x0a);
    if (newline < 0) return null;
    let meta;
    try {
      meta = headerSchema.safeParse(JSON.parse(raw.subarray(0, newline).toString('utf8')));
    } catch {
      return null;
    }
    if (!meta.success) return null;
    const now = new Date();
    fs.utimes(file, now, now).catch(() => {});
    return { meta: meta.data, buffer: raw.subarray(newline + 1) };
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

  const set = async (key: Key, buffer: Buffer, meta: CacheHeader = {}) => {
    try {
      await fs.mkdir(dir, { recursive: true, mode: 0o700 });
      const file = fileFor(key);
      const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
      await fs.writeFile(temp, Buffer.concat([Buffer.from(`${JSON.stringify(meta)}\n`, 'utf8'), buffer]), { mode: 0o600 });
      await fs.rename(temp, file);
      await prune();
    } catch (error) {
      console.warn(`[${label}] cache write failed:`, error instanceof Error ? error.message : error);
    }
  };

  return { get, set };
}
