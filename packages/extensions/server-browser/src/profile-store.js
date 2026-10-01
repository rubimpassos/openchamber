// Named browser profiles that outlive a scope, a service restart, and an
// update of the extension. Each profile is a Chrome user-data-dir packed and
// sealed with AES-256-GCM into one file under the store; the key lives in a
// separate file outside the store, so a copy of the store alone reveals
// nothing. A profile is unpacked into a private working directory only while
// a browser uses it, and sealed again when that browser closes.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';

const MAGIC = Buffer.from('OCSBP1');
const IV_BYTES = 12;
const TAG_BYTES = 16;
const KEY_BYTES = 32;
const NAME_MAX = 60;
const PROFILE_ID = /^[a-f0-9]{16}$/;
const WORK_PREFIX = 'openchamber-server-browser-profile-';
const WORK_NAME = /^openchamber-server-browser-profile-([a-f0-9]{16})-[A-Za-z0-9]{6}$/;

// Chrome rebuilds these; they only make a sealed profile large and slow.
const SKIPPED_DIRECTORIES = new Set([
  'Cache', 'Code Cache', 'GPUCache', 'DawnCache', 'DawnGraphiteCache', 'DawnWebGPUCache',
  'GrShaderCache', 'GraphiteDawnCache', 'ShaderCache', 'CacheStorage', 'ScriptCache',
  'Crashpad', 'BrowserMetrics', 'component_crx_cache', 'extensions_crx_cache',
  'Safe Browsing', 'optimization_guide_model_store', 'OptimizationHints', 'segmentation_platform',
]);
// Files that belong to the Chrome process that wrote them, not to the profile.
const SKIPPED_FILES = new Set(['SingletonLock', 'SingletonSocket', 'SingletonCookie', 'DevToolsActivePort', 'BrowserMetrics-spare.pma']);

export class StaleProfileError extends Error {
  constructor(name, taken, current) {
    super(`Another chat saved the browser profile "${name}" after this chat's copy was taken (copy version ${taken}, saved version ${current}), so saving this copy would drop that change.`);
    this.name = 'StaleProfileError';
    this.code = 'STALE_PROFILE';
  }
}

export const defaultStorePaths = (env = process.env) => {
  const home = env.HOME || os.homedir();
  const dataHome = env.XDG_DATA_HOME || path.join(home, '.local', 'share');
  const configHome = env.XDG_CONFIG_HOME || path.join(home, '.config');
  return {
    root: path.join(dataHome, 'openchamber-server-browser'),
    keyFile: path.join(configHome, 'openchamber-server-browser', 'profile.key'),
  };
};

const within = (parent, child) => {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
};

// The nearest existing ancestor, resolved, so a key path that does not exist
// yet is still compared against the store by where it would really land.
const realpathOfNearest = (target) => {
  let current = path.resolve(target);
  const rest = [];
  for (;;) {
    try {
      return path.join(fs.realpathSync(current), ...rest.reverse());
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return path.resolve(target);
      rest.push(path.basename(current));
      current = parent;
    }
  }
};

export const normalizeProfileName = (value) => {
  const name = typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
  if (name.length === 0 || name.length > NAME_MAX) throw new Error(`A profile name needs 1 to ${NAME_MAX} characters`);
  return name;
};

const normalizeDirectory = (value) => {
  if (typeof value !== 'string' || !path.isAbsolute(value) || value.length > 4096) {
    throw new Error('Bind a profile to an absolute project directory');
  }
  const resolved = path.resolve(value);
  return resolved.length > 1 ? resolved.replace(/[\\/]+$/, '') : resolved;
};

// Packs regular files below `root` into one buffer: for each file, its
// relative path, mode and bytes. Links and sockets are left out.
export const packDirectory = async (root) => {
  const chunks = [];
  const walk = async (relative) => {
    const entries = await fs.promises.readdir(path.join(root, relative), { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const child = relative ? path.join(relative, entry.name) : entry.name;
      if (entry.isDirectory()) {
        if (!SKIPPED_DIRECTORIES.has(entry.name)) await walk(child);
      } else if (entry.isFile() && !SKIPPED_FILES.has(entry.name) && !entry.name.endsWith('.tmp')) {
        const absolute = path.join(root, child);
        let bytes;
        try {
          bytes = await fs.promises.readFile(absolute);
        } catch (error) {
          // Chrome may delete a journal between listing and reading.
          if (error?.code === 'ENOENT') continue;
          throw error;
        }
        const name = Buffer.from(child.split(path.sep).join('/'));
        const header = Buffer.alloc(16);
        header.writeUInt32BE(name.length, 0);
        header.writeUInt32BE((await fs.promises.stat(absolute).catch(() => ({ mode: 0o600 }))).mode & 0o777, 4);
        header.writeBigUInt64BE(BigInt(bytes.length), 8);
        chunks.push(header, name, bytes);
      }
    }
  };
  await walk('');
  return Buffer.concat(chunks);
};

export const unpackDirectory = async (buffer, root) => {
  let offset = 0;
  while (offset < buffer.length) {
    if (offset + 16 > buffer.length) throw new Error('The sealed profile is truncated');
    const nameLength = buffer.readUInt32BE(offset);
    const mode = buffer.readUInt32BE(offset + 4) & 0o700;
    const size = Number(buffer.readBigUInt64BE(offset + 8));
    offset += 16;
    const name = buffer.subarray(offset, offset + nameLength).toString('utf8');
    offset += nameLength;
    const target = path.resolve(root, ...name.split('/'));
    if (!name || !within(root, target) || target === path.resolve(root)) throw new Error('The sealed profile names a path outside itself');
    if (offset + size > buffer.length) throw new Error('The sealed profile is truncated');
    await fs.promises.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    await fs.promises.writeFile(target, buffer.subarray(offset, offset + size), { mode: mode || 0o600 });
    offset += size;
  }
};

const writeAtomic = async (file, bytes, mode) => {
  const temporary = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  await fs.promises.writeFile(temporary, bytes, { mode });
  await fs.promises.rename(temporary, file);
};

export const createProfileStore = ({
  root,
  keyFile,
  workRoot = process.env.XDG_RUNTIME_DIR || os.tmpdir(),
  now = Date.now,
} = {}) => {
  if (typeof root !== 'string' || !path.isAbsolute(root)) throw new Error('The profile store needs an absolute directory');
  if (typeof keyFile !== 'string' || !path.isAbsolute(keyFile)) throw new Error('The profile key needs an absolute file path');
  if (within(realpathOfNearest(root), realpathOfNearest(keyFile))) {
    throw new Error(`The profile key file must live outside the profile store (${root}); set profileKeyFile elsewhere`);
  }
  const registryFile = path.join(root, 'profiles.json');
  const blobDirectory = path.join(root, 'profiles');
  let queue = Promise.resolve();
  const serialize = (operation) => {
    const next = queue.catch(() => {}).then(operation);
    queue = next;
    return next;
  };

  const ensureRoot = async () => {
    await fs.promises.mkdir(blobDirectory, { recursive: true, mode: 0o700 });
    await fs.promises.chmod(root, 0o700);
    await fs.promises.chmod(blobDirectory, 0o700);
  };

  const readRegistry = async () => {
    try {
      const parsed = JSON.parse(await fs.promises.readFile(registryFile, 'utf8'));
      return Array.isArray(parsed?.profiles) ? parsed : { profiles: [] };
    } catch (error) {
      if (error?.code === 'ENOENT') return { profiles: [] };
      throw new Error(`Could not read ${registryFile}: ${error.message}`);
    }
  };

  const writeRegistry = async (registry) => {
    await ensureRoot();
    await writeAtomic(registryFile, `${JSON.stringify(registry, null, 2)}\n`, 0o600);
  };

  const readKey = async ({ create }) => {
    try {
      const stat = await fs.promises.stat(keyFile);
      if (process.platform !== 'win32' && (stat.mode & 0o077) !== 0) {
        throw new Error(`The profile key ${keyFile} is readable by other users; run chmod 600 on it`);
      }
      const key = await fs.promises.readFile(keyFile);
      if (key.length !== KEY_BYTES) throw new Error(`The profile key ${keyFile} must hold exactly ${KEY_BYTES} bytes`);
      return key;
    } catch (error) {
      if (error?.code !== 'ENOENT' || !create) throw error;
      await fs.promises.mkdir(path.dirname(keyFile), { recursive: true, mode: 0o700 });
      const key = crypto.randomBytes(KEY_BYTES);
      await fs.promises.writeFile(keyFile, key, { mode: 0o600, flag: 'wx' }).catch(async (writeError) => {
        if (writeError?.code !== 'EEXIST') throw writeError;
      });
      return readKey({ create: false });
    }
  };

  const blobFile = (id) => path.join(blobDirectory, `${id}.bin`);

  const seal = async (id, bytes) => {
    const key = await readKey({ create: true });
    const iv = crypto.randomBytes(IV_BYTES);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    // The id is authenticated, so one profile's file cannot stand in for another's.
    cipher.setAAD(Buffer.from(id));
    const encrypted = Buffer.concat([cipher.update(zlib.gzipSync(bytes)), cipher.final()]);
    return Buffer.concat([MAGIC, iv, encrypted, cipher.getAuthTag()]);
  };

  const unseal = async (id, sealed) => {
    if (sealed.length < MAGIC.length + IV_BYTES + TAG_BYTES || !sealed.subarray(0, MAGIC.length).equals(MAGIC)) {
      throw new Error('The sealed profile is not in a format this version can read');
    }
    let key;
    try {
      key = await readKey({ create: false });
    } catch (error) {
      if (error?.code === 'ENOENT') throw new Error(`The profile key ${keyFile} is missing, so saved profiles cannot be opened; delete them or restore the key`);
      throw error;
    }
    const iv = sealed.subarray(MAGIC.length, MAGIC.length + IV_BYTES);
    const tag = sealed.subarray(sealed.length - TAG_BYTES);
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAAD(Buffer.from(id));
    decipher.setAuthTag(tag);
    try {
      return zlib.gunzipSync(Buffer.concat([decipher.update(sealed.subarray(MAGIC.length + IV_BYTES, sealed.length - TAG_BYTES)), decipher.final()]));
    } catch {
      throw new Error('The saved profile could not be decrypted with the current key');
    }
  };

  const requireProfile = (registry, id) => {
    const profile = typeof id === 'string' && PROFILE_ID.test(id) ? registry.profiles.find((candidate) => candidate.id === id) : null;
    if (!profile) throw new Error('That profile no longer exists');
    return profile;
  };

  const describe = async (profile) => {
    const stat = await fs.promises.stat(blobFile(profile.id)).catch(() => null);
    return { ...profile, projects: [...profile.projects], saved: Boolean(stat), savedBytes: stat?.size ?? 0 };
  };

  const store = {
    paths: Object.freeze({ root, keyFile, registryFile, blobDirectory }),

    list: () => serialize(async () => Promise.all((await readRegistry()).profiles.map(describe))),

    get: (id) => serialize(async () => describe(requireProfile(await readRegistry(), id))),

    create: (name) => serialize(async () => {
      const registry = await readRegistry();
      const normalized = normalizeProfileName(name);
      if (registry.profiles.some((profile) => profile.name.toLowerCase() === normalized.toLowerCase())) {
        throw new Error(`A profile named "${normalized}" already exists`);
      }
      const profile = { id: crypto.randomBytes(8).toString('hex'), name: normalized, projects: [], createdAt: now(), lastUsedAt: null, version: 0, savedAt: null };
      registry.profiles.push(profile);
      await writeRegistry(registry);
      return describe(profile);
    }),

    rename: (id, name) => serialize(async () => {
      const registry = await readRegistry();
      const profile = requireProfile(registry, id);
      const normalized = normalizeProfileName(name);
      if (registry.profiles.some((other) => other !== profile && other.name.toLowerCase() === normalized.toLowerCase())) {
        throw new Error(`A profile named "${normalized}" already exists`);
      }
      profile.name = normalized;
      await writeRegistry(registry);
      return describe(profile);
    }),

    // A directory belongs to at most one profile; binding it moves it.
    bind: (id, directory) => serialize(async () => {
      const registry = await readRegistry();
      const profile = requireProfile(registry, id);
      const normalized = normalizeDirectory(directory);
      for (const other of registry.profiles) other.projects = other.projects.filter((entry) => entry !== normalized);
      profile.projects.push(normalized);
      profile.projects.sort();
      await writeRegistry(registry);
      return describe(profile);
    }),

    unbind: (id, directory) => serialize(async () => {
      const registry = await readRegistry();
      const profile = requireProfile(registry, id);
      const normalized = normalizeDirectory(directory);
      profile.projects = profile.projects.filter((entry) => entry !== normalized);
      await writeRegistry(registry);
      return describe(profile);
    }),

    // The profile bound to the directory or its nearest bound ancestor, so a
    // worktree or subfolder of a bound project uses the project's profile.
    resolve: (directory) => serialize(async () => {
      if (typeof directory !== 'string' || !path.isAbsolute(directory)) return null;
      const target = path.resolve(directory);
      let best = null;
      for (const profile of (await readRegistry()).profiles) {
        for (const project of profile.projects) {
          if (within(project, target) && (!best || project.length > best.project.length)) best = { profile, project };
        }
      }
      return best ? { id: best.profile.id, name: best.profile.name } : null;
    }),

    remove: (id) => serialize(async () => {
      const registry = await readRegistry();
      const profile = requireProfile(registry, id);
      registry.profiles = registry.profiles.filter((candidate) => candidate !== profile);
      await fs.promises.rm(blobFile(id), { force: true });
      await writeRegistry(registry);
    }),

    // Wipes every profile and the key. Nothing sealed before can be opened
    // again, even from a backup of the store.
    revokeAll: () => serialize(async () => {
      await fs.promises.rm(blobDirectory, { recursive: true, force: true });
      await fs.promises.rm(registryFile, { force: true });
      await fs.promises.rm(keyFile, { force: true });
    }),

    // Unpacks a copy of a profile into a new private directory for one
    // browser, with the version it was taken at.
    checkout: (id) => serialize(async () => {
      const registry = await readRegistry();
      const profile = requireProfile(registry, id);
      await fs.promises.mkdir(workRoot, { recursive: true });
      const directory = await fs.promises.mkdtemp(path.join(workRoot, `${WORK_PREFIX}${id}-`));
      await fs.promises.chmod(directory, 0o700);
      try {
        const sealed = await fs.promises.readFile(blobFile(id)).catch((error) => (error?.code === 'ENOENT' ? null : Promise.reject(error)));
        if (sealed) await unpackDirectory(await unseal(id, sealed), directory);
      } catch (error) {
        await fs.promises.rm(directory, { recursive: true, force: true });
        throw error;
      }
      profile.lastUsedAt = now();
      await writeRegistry(registry);
      return { directory, version: profile.version ?? 0 };
    }),

    // Copies left by a service that was killed: they were never the master,
    // so they are removed, and no plaintext outlives the next start.
    removeStale: async () => {
      const entries = await fs.promises.readdir(workRoot, { withFileTypes: true }).catch(() => []);
      const removed = [];
      for (const entry of entries) {
        const match = entry.isDirectory() ? WORK_NAME.exec(entry.name) : null;
        if (!match) continue;
        const directory = path.join(workRoot, entry.name);
        const stat = await fs.promises.lstat(directory).catch(() => null);
        if (!stat || stat.uid !== process.getuid?.()) continue;
        await fs.promises.rm(directory, { recursive: true, force: true });
        removed.push(match[1]);
      }
      return removed;
    },

    // Saves a copy into the master. The copy must have been taken at the
    // master's current version: a copy taken before another save would
    // silently drop that save, so it is refused. Returns the new version, or
    // null when the profile was deleted or revoked meanwhile.
    checkin: (id, directory, expectedVersion) => serialize(async () => {
      const registry = await readRegistry();
      const profile = registry.profiles.find((candidate) => candidate.id === id);
      if (!profile) return null;
      const current = profile.version ?? 0;
      if (current !== expectedVersion) throw new StaleProfileError(profile.name, expectedVersion, current);
      const sealed = await seal(id, await packDirectory(directory));
      await ensureRoot();
      await writeAtomic(blobFile(id), sealed, 0o600);
      profile.version = current + 1;
      profile.savedAt = now();
      await writeRegistry(registry);
      return profile.version;
    }),

    // The master's current version, to tell a copy it is out of date before saving.
    version: (id) => serialize(async () => requireProfile(await readRegistry(), id).version ?? 0),
  };
  return store;
};
