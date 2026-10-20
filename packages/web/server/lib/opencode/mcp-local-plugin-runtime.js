// Serialized with the reader into a dependency-free plugin package.
export async function setupLocalMcpPlugin(ctx, { dataDir, createReader, fs, path, createHash, homedir, asNonEmptyString, isBoolean, isPlainObject, isString }) {
  const reader = createReader(dataDir, { fs, path, createHash, asNonEmptyString, isBoolean, isPlainObject, isString });
  const target = reader.resolve(ctx.location.directory);
  let servers = {};
  let signature = '{}';
  let closed = false;
  let timer;
  let inFlight = Promise.resolve();
  const report = () => console.error('Project-local MCP configuration could not be applied');
  // editor.set validates structured config but does not expand file-loader references.
  const expand = (value) => {
    if (isString(value)) {
      return value.replace(/\{env:([^}]+)\}/g, (_match, name) => process.env[name] ?? '')
        .replace(/\{file:([^}]+)\}/g, (_match, filename) => {
          const expanded = filename.startsWith('~/') ? path.join(homedir(), filename.slice(2)) : filename;
          try { return fs.readFileSync(path.resolve(ctx.location.directory, expanded), 'utf8').trim(); }
          catch (error) { if (error.code === 'ENOENT') return ''; throw error; }
        });
    }
    if (Array.isArray(value)) return value.map(expand);
    if (isPlainObject(value)) {
      return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, expand(item)]));
    }
    return value;
  };
  const refresh = async () => {
    if (closed) return;
    try {
      const next = reader.readTarget(target).servers;
      const nextSignature = JSON.stringify(next);
      if (signature === nextSignature) return;
      const previous = servers;
      servers = next;
      try {
        await ctx.mcp.reload();
        signature = nextSignature;
      } catch (error) {
        servers = previous;
        throw error;
      }
    } catch {
      report();
    }
  };
  // Subscribe before the first read so an atomic replacement during setup is observed.
  const watcher = fs.watch(path.dirname(target.path), (_event, filename) => {
    if (closed || filename?.toString() !== path.basename(target.path)) return;
    clearTimeout(timer);
    timer = setTimeout(() => {
      timer = undefined;
      inFlight = inFlight.then(refresh);
    }, 20);
  });
  watcher.on('error', report);
  try {
    try {
      servers = reader.readTarget(target).servers;
      signature = JSON.stringify(servers);
    } catch {
      report();
    }
    await ctx.mcp.transform((editor) => {
      for (const [name, config] of Object.entries(servers)) editor.set(name, expand(config));
    });
  } catch (error) {
    watcher.close();
    throw error;
  }
  return async () => {
    closed = true;
    clearTimeout(timer);
    watcher.close();
    await inFlight;
  };
}
