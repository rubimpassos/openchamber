import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { ensureLocalMcpDirectory, writeLocalMcpFile } from '../opencode/mcp-local-files.js';
import { createLocalMcpReader } from '../opencode/mcp-local-reader.js';
import { isBoolean, isPlainObject, isString } from '../shared/guards.js';
import { withSourceControlFileLock } from '../source-control/file-lock.js';
import { protectedSelectionReader } from './selections-reader.js';

/**
 * Which protected connections OpenCode starts, for every project or for one.
 * A selection holds an MCP name and a connection id; it grants nothing, since
 * every engine process can call every approved connection anyway.
 */
export function createProtectedSelectionStore({ dataDir }) {
  const local = createLocalMcpReader(dataDir);
  const reader = protectedSelectionReader(dataDir, { fs, path, isBoolean, isPlainObject, isString });
  const globalFile = path.join(dataDir, 'mcp-protected', 'global.json');

  const read = (directory) => {
    if (!directory) {
      const global = reader.readDocument(globalFile, null).servers;
      const effective = Object.fromEntries(Object.entries(global).filter(([, entry]) => !entry.disabled));
      return { global, project: null, effective };
    }
    return reader.readTarget(reader.resolve(local.resolve(directory)));
  };

  const writeDocument = (file, identity, servers) => {
    const document = identity === null ? { version: 1, servers } : { version: 1, identity, servers };
    return writeLocalMcpFile(file, `${JSON.stringify(document, null, 2)}\n`);
  };

  const mutate = async ({ scope, directory }, change) => {
    let file = globalFile;
    let identity = null;
    if (scope === 'project') {
      const target = reader.resolve(local.resolve(directory));
      file = target.project;
      identity = target.identity;
    }
    await ensureLocalMcpDirectory(path.dirname(file));
    return withSourceControlFileLock(`${file}.lock`, async () => {
      const { servers } = reader.readDocument(file, identity);
      change(servers);
      await writeDocument(file, identity, servers);
    });
  };

  return {
    read,
    async set({ scope, directory, name, connection, disabled = false }) {
      reader.validateName(name);
      const entry = reader.parseEntry(disabled ? { connection, disabled: true } : { connection });
      await mutate({ scope, directory }, (servers) => {
        servers[name] = entry;
      });
    },
    async remove({ scope, directory, name }) {
      reader.validateName(name);
      await mutate({ scope, directory }, (servers) => {
        delete servers[name];
      });
    },
    async removeConnection(connectionId) {
      const removed = [];
      const notUpdated = [];
      const directory = path.dirname(globalFile);
      let files;
      try { files = await fs.promises.readdir(directory); }
      catch (error) { if (error.code === 'ENOENT') return { removed, notUpdated }; throw error; }
      for (const name of files.sort().filter((name) => name === 'global.json' || /^project-[0-9a-f]{64}\.json$/.test(name))) {
        const file = path.join(directory, name);
        try {
          await withSourceControlFileLock(`${file}.lock`, async () => {
            const identity = name === 'global.json' ? null : z.object({ identity: z.string().min(1) }).parse(JSON.parse(await fs.promises.readFile(file, 'utf8'))).identity;
            const { servers } = reader.readDocument(file, identity);
            const names = Object.keys(servers).filter((key) => servers[key].connection === connectionId);
            if (names.length === 0) return;
            for (const key of names) delete servers[key];
            await writeDocument(file, identity, servers);
            removed.push(name);
          });
        } catch { notUpdated.push(name); }
      }
      return { removed, notUpdated };
    },
  };
}
