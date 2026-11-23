import type { FSWatcher } from 'node:fs';
import type { homedir } from 'node:os';
import type { McpEntity } from './config-v2.js';
import type { LocalMcpReaderPlatform, LocalMcpTarget, localMcpReader } from './mcp-local-reader.js';

interface ProtectedTarget {
  readonly directory: string;
  readonly global: string;
  readonly project: string;
  readonly identity: string;
}
interface ProtectedSelection {
  readonly connection: string;
  readonly disabled?: boolean;
}
interface ProtectedReader {
  resolve(target: LocalMcpTarget): ProtectedTarget;
  readTarget(target: ProtectedTarget): { readonly effective: Record<string, ProtectedSelection> };
  materialize(effective: Record<string, ProtectedSelection>, clientConfig: string | null): Record<string, McpEntity>;
}
interface LocalMcpPluginContext {
  readonly location: { readonly directory: string };
  readonly mcp: {
    // OpenCode's editor validates the expanded structured configuration.
    transform(transform: (editor: { set(name: string, config: unknown): void }) => void): void | Promise<void>;
    reload(): Promise<void>;
  };
}
interface LocalMcpPluginDependencies extends LocalMcpReaderPlatform {
  readonly dataDir: string;
  readonly protectedClientConfig: string | null;
  readonly createReader: typeof localMcpReader;
  readonly createProtectedReader: (dataDir: string, platform: Pick<LocalMcpReaderPlatform, 'fs' | 'path' | 'isBoolean' | 'isPlainObject' | 'isString'>) => ProtectedReader;
  readonly homedir: typeof homedir;
}

// Serialized with the readers into a dependency-free plugin package.
export async function setupLocalMcpPlugin(ctx: LocalMcpPluginContext, { dataDir, protectedClientConfig, createReader, createProtectedReader, fs, path, createHash, homedir, asNonEmptyString, isBoolean, isPlainObject, isString }: LocalMcpPluginDependencies): Promise<() => Promise<void>> {
  const reader = createReader(dataDir, { fs, path, createHash, asNonEmptyString, isBoolean, isPlainObject, isString });
  const protectedReader = createProtectedReader(dataDir, { fs, path, isBoolean, isPlainObject, isString });
  const target = reader.resolve(ctx.location.directory);
  // A null client configuration means this runtime offers no protected connections at all.
  const protectedTarget = protectedClientConfig === null ? null : protectedReader.resolve(target);
  let personal: Record<string, McpEntity> = {};
  let selected: Record<string, McpEntity> = {};
  let signature = '{}';
  let closed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let inFlight = Promise.resolve();
  const report = () => console.error('Project-local MCP configuration could not be applied');
  // editor.set validates structured config but does not expand file-loader references.
  const expand = (value: unknown): unknown => {
    if (isString(value)) {
      return value.replace(/\{env:([^}]+)\}/g, (_match, name) => process.env[name] ?? '')
        .replace(/\{file:([^}]+)\}/g, (_match, filename) => {
          const expanded = filename.startsWith('~/') ? path.join(homedir(), filename.slice(2)) : filename;
          try { return fs.readFileSync(path.resolve(ctx.location.directory, expanded), 'utf8').trim(); }
          catch (error) { if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return ''; throw error; }
        });
    }
    if (Array.isArray(value)) return value.map(expand);
    if (isPlainObject(value)) {
      return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, expand(item)]));
    }
    return value;
  };
  // Each source keeps its last valid state when its file breaks, independently of the other.
  const readPersonal = () => {
    try { return reader.readTarget(target).servers; }
    catch { report(); return personal; }
  };
  // Protected entries start the relay for a connection id and nothing else:
  // no reference is expanded and nothing from the selection reaches the command.
  const readSelected = () => {
    if (protectedTarget === null) return {};
    try { return protectedReader.materialize(protectedReader.readTarget(protectedTarget).effective, protectedClientConfig); }
    catch { report(); return selected; }
  };
  const refresh = async () => {
    if (closed) return;
    try {
      const nextPersonal = readPersonal();
      const nextSelected = readSelected();
      const nextSignature = JSON.stringify([nextPersonal, nextSelected]);
      if (signature === nextSignature) return;
      const previous = [personal, selected] as const;
      personal = nextPersonal;
      selected = nextSelected;
      try {
        await ctx.mcp.reload();
        signature = nextSignature;
      } catch (error) {
        [personal, selected] = previous;
        throw error;
      }
    } catch {
      report();
    }
  };
  const schedule = () => {
    if (closed) return;
    clearTimeout(timer);
    timer = setTimeout(() => {
      timer = undefined;
      inFlight = inFlight.then(refresh);
    }, 20);
  };
  // Subscribe before the first read so an atomic replacement during setup is observed.
  const watchers: FSWatcher[] = [];
  const watch = (directory: string, names: readonly string[]) => {
    try {
      const watcher = fs.watch(directory, (_event, filename) => {
        if (filename !== null && names.includes(filename.toString())) schedule();
      });
      watcher.on('error', report);
      watchers.push(watcher);
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
    }
  };
  watch(path.dirname(target.path), [path.basename(target.path)]);
  if (protectedTarget !== null) {
    fs.mkdirSync(protectedTarget.directory, { recursive: true, mode: 0o700 });
    watch(protectedTarget.directory, [path.basename(protectedTarget.global), path.basename(protectedTarget.project)]);
  }
  try {
    personal = readPersonal();
    selected = readSelected();
    signature = JSON.stringify([personal, selected]);
    await ctx.mcp.transform((editor) => {
      for (const [name, config] of Object.entries(personal)) editor.set(name, expand(config));
      for (const [name, config] of Object.entries(selected)) editor.set(name, config);
    });
  } catch (error) {
    for (const watcher of watchers) watcher.close();
    throw error;
  }
  return async () => {
    closed = true;
    clearTimeout(timer);
    for (const watcher of watchers) watcher.close();
    await inFlight;
  };
}
