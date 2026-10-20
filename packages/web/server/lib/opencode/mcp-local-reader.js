import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { asNonEmptyString, isBoolean, isPlainObject, isString } from '../shared/guards.js';

// Serialized into the managed plugin. Keep dependencies limited to these Node imports.
export function createLocalMcpReader(dataDir, platform = { fs, path, createHash, asNonEmptyString, isBoolean, isPlainObject, isString }) {
  return localMcpReader(dataDir, platform);
}

// All dependencies are arguments so bundling the host cannot rewrite captured imports.
export function localMcpReader(dataDir, { fs, path, createHash, asNonEmptyString, isBoolean, isPlainObject, isString }) {
  class LocalMcpError extends Error {
    constructor(code) {
      super('Project-local MCP configuration could not be applied');
      this.name = 'LocalMcpError';
      this.code = code;
    }
  }
  const fail = (code = 'MCP_LOCAL_INVALID') => { throw new LocalMcpError(code); };
  if (!asNonEmptyString(dataDir) || !path.isAbsolute(dataDir)) fail('MCP_LOCAL_DIRECTORY');
  const stringMap = (value) => isPlainObject(value) && Object.values(value).every(isString);
  const positiveInteger = (value) => Number.isSafeInteger(value) && value > 0;
  const validateName = (name) => {
    if (!asNonEmptyString(name) || !/^[a-z0-9](?:[a-z0-9_-]*[a-z0-9])?$/.test(name)) fail();
  };
  const parseServer = (value) => {
    if (!isPlainObject(value)) fail();
    switch (value.type) {
      case 'local':
        if (!Array.isArray(value.command) || value.command.length === 0 ||
          !value.command.every(isString) || !value.command[0].trim()) fail();
        break;
      case 'remote':
        if (!asNonEmptyString(value.url)) fail();
        break;
      default: fail();
    }
    for (const key of ['disabled', 'codemode']) {
      if (key in value && !isBoolean(value[key])) fail();
    }
    if ('cwd' in value && !isString(value.cwd)) fail();
    for (const key of ['environment', 'headers']) {
      if (key in value && !stringMap(value[key])) fail();
    }
    if ('protocol' in value && !['auto', 'legacy', '2026-07-28'].includes(value.protocol)) fail();
    if ('timeout' in value) {
      if (!isPlainObject(value.timeout)) fail();
      for (const key of ['startup', 'catalog', 'execution']) {
        if (key in value.timeout && !positiveInteger(value.timeout[key])) fail();
      }
    }
    if ('oauth' in value && value.oauth !== false) {
      if (!isPlainObject(value.oauth)) fail();
      for (const key of ['client_id', 'client_secret', 'scope', 'redirect_uri', 'auth_server_metadata_url']) {
        if (key in value.oauth && !isString(value.oauth[key])) fail();
      }
      if ('callback_port' in value.oauth && (!positiveInteger(value.oauth.callback_port) || value.oauth.callback_port > 65535)) fail();
    }
    return value;
  };
  const resolve = (directory) => {
    if (!asNonEmptyString(directory) || !path.isAbsolute(directory)) fail('MCP_LOCAL_DIRECTORY');
    const realDirectory = fs.realpathSync(directory);
    if (!fs.statSync(realDirectory).isDirectory()) fail('MCP_LOCAL_DIRECTORY');
    let current = realDirectory;
    let identity = `directory:${realDirectory}`;
    while (true) {
      const marker = path.join(current, '.git');
      let stats;
      try { stats = fs.lstatSync(marker); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (stats) {
        let gitDirectory = marker;
        if (!stats.isDirectory()) {
          const match = /^gitdir: (.+)\r?\n?$/.exec(fs.readFileSync(marker, 'utf8'));
          if (!match) fail('MCP_LOCAL_IDENTITY');
          gitDirectory = path.resolve(current, match[1].trim());
        }
        gitDirectory = fs.realpathSync(gitDirectory);
        let common;
        try { common = fs.readFileSync(path.join(gitDirectory, 'commondir'), 'utf8').trim(); }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
        if (common === '') fail('MCP_LOCAL_IDENTITY');
        const commonDirectory = common === undefined ? gitDirectory : fs.realpathSync(path.resolve(gitDirectory, common));
        if (!fs.statSync(commonDirectory).isDirectory()) fail('MCP_LOCAL_IDENTITY');
        identity = `git:${commonDirectory}`;
        break;
      }
      const parent = path.dirname(current);
      if (parent === current) break;
      current = parent;
    }
    const filename = `${createHash('sha256').update(identity).digest('hex')}.json`;
    return { path: path.join(dataDir, 'mcp-project-local', filename), identity };
  };
  const readTarget = (target) => {
    let content;
    try { content = fs.readFileSync(target.path, 'utf8'); }
    catch (error) {
      if (error.code === 'ENOENT') return { ...target, servers: {}, exists: false };
      fail('MCP_LOCAL_UNREADABLE');
    }
    let document;
    try { document = JSON.parse(content); }
    catch { fail(); }
    if (!isPlainObject(document) || document.version !== 1 || document.identity !== target.identity || !isPlainObject(document.servers)) fail();
    for (const [name, config] of Object.entries(document.servers)) {
      validateName(name);
      parseServer(config);
    }
    return { ...target, servers: document.servers, exists: true };
  };
  return { resolve, readTarget, read: (directory) => readTarget(resolve(directory)), parseServer, validateName };
}
