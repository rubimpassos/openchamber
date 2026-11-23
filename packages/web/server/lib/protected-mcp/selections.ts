import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { ensureLocalMcpDirectory, writeLocalMcpFile } from '../opencode/mcp-local-files.js';
import { createLocalMcpReader } from '../opencode/mcp-local-reader.js';
import { hasProperties, isBoolean, isPlainObject, isString } from '../shared/guards.js';
import { withSourceControlFileLock } from '../source-control/file-lock.js';
import { protectedSelectionReader } from './selections-reader.js';
import { assertSelectionMirrorWriteFits, projectIdentitySchema, selectionDocumentName } from './selection-mirror-documents.js';

type SelectionServers = ReturnType<ReturnType<typeof protectedSelectionReader>['readDocument']>['servers'];
type SelectionScope =
  | { readonly scope: 'global'; readonly directory?: string | null | undefined }
  | { readonly scope: 'project'; readonly directory: string };
type SelectionName = { readonly name: string };
type SelectionInput = SelectionScope & SelectionName & { readonly connection: unknown; readonly disabled?: boolean };
type SelectionStoreOptions = {
  readonly dataDir: string;
  readonly resolveProjectIdentity?: ((directory: string) => string | Promise<string>) | undefined;
  readonly enforceMirrorCapacity?: boolean;
};

/**
 * Which protected connections OpenCode starts, for every project or for one.
 * A selection holds an MCP name and a connection id. The front door pushes
 * their enabled union to the service's shared agent subject after route writes.
 */
export function createProtectedSelectionStore({ dataDir, resolveProjectIdentity, enforceMirrorCapacity = false }: SelectionStoreOptions) {
  const local = createLocalMcpReader(dataDir);
  const reader = protectedSelectionReader(dataDir, { fs, path, isBoolean, isPlainObject, isString });
  const globalFile = path.join(dataDir, 'mcp-protected', 'global.json');
  const resolveRemoteTarget = async (directory: string) => {
    const identity = projectIdentitySchema.parse(await resolveProjectIdentity?.(directory));
    return { global: globalFile, project: path.join(path.dirname(globalFile), selectionDocumentName({ identity })), identity };
  };

  const read = (directory?: string | null) => {
    if (!directory) {
      const global = reader.readDocument(globalFile, null).servers;
      const effective = Object.fromEntries(Object.entries(global).filter(([, entry]) => !entry.disabled));
      return { global, project: null, effective };
    }
    if (resolveProjectIdentity) return resolveRemoteTarget(directory).then((target) => reader.readTarget(target));
    return reader.readTarget(reader.resolve(local.resolve(directory)));
  };

  const writeDocument = (file: string, identity: string | null, servers: SelectionServers) => {
    const document = identity === null ? { version: 1, servers } : { version: 1, identity, servers };
    return writeLocalMcpFile(file, `${JSON.stringify(document, null, 2)}\n`);
  };

  const mutate = async ({ scope, directory }: SelectionScope, change: (servers: SelectionServers) => void) => {
    let file = globalFile;
    let identity: string | null = null;
    if (scope === 'project') {
      const target = resolveProjectIdentity ? await resolveRemoteTarget(directory) : reader.resolve(local.resolve(directory));
      file = target.project;
      identity = target.identity;
    }
    await ensureLocalMcpDirectory(path.dirname(file));
    const commit = () => withSourceControlFileLock(`${file}.lock`, async () => {
      const { servers } = reader.readDocument(file, identity);
      change(servers);
      if (enforceMirrorCapacity) {
        await assertSelectionMirrorWriteFits(dataDir, identity === null ? { version: 1, servers } : { version: 1, identity, servers });
      }
      await writeDocument(file, identity, servers);
    });
    return enforceMirrorCapacity
      ? withSourceControlFileLock(path.join(dataDir, 'mcp-protected-capacity.lock'), commit)
      : commit();
  };

  return {
    read,
    async set(input: SelectionInput) {
      const { name, connection, disabled = false } = input;
      reader.validateName(name);
      const entry = reader.parseEntry(disabled ? { connection, disabled: true } : { connection });
      await mutate(input, (servers) => {
        servers[name] = entry;
      });
    },
    async remove(input: SelectionScope & SelectionName) {
      const { name } = input;
      reader.validateName(name);
      await mutate(input, (servers) => {
        delete servers[name];
      });
    },
    async removeConnection(connectionId: string) {
      const removed: string[] = [];
      const notUpdated: string[] = [];
      const directory = path.dirname(globalFile);
      let files: string[];
      try { files = await fs.promises.readdir(directory); }
      catch (error) { if (hasProperties(error) && error.code === 'ENOENT') return { removed, notUpdated }; throw error; }
      for (const name of files.sort().filter((name) => name === 'global.json' || /^project-[0-9a-f]{64}\.json$/.test(name))) {
        const file = path.join(directory, name);
        try {
          await withSourceControlFileLock(`${file}.lock`, async () => {
            const identity = name === 'global.json' ? null : z.object({ identity: z.string().min(1) }).parse(JSON.parse(await fs.promises.readFile(file, 'utf8'))).identity;
            const { servers } = reader.readDocument(file, identity);
            const names = Object.entries(servers).filter(([, entry]) => entry.connection === connectionId).map(([key]) => key);
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
