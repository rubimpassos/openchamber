import { spawn } from 'node:child_process';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { isString } from '../../shared/guards.js';
import type { JsonObject, JsonValue } from '../../shared/json-values.js';
import { MAX_FRAME_BYTES, ProtectedMcpError } from './contract.js';
import type { ConnectionId } from './contract.js';
import type { StdioDefinition, StoredDefinition } from './definition-types.js';
import { createLineReader } from './mcp-session.js';
import type { McpBackend } from './mcp-session.js';
import { ensurePrivateDirectory, writePrivateFile } from './store.js';

type StdioUpstreamOptions = {
  readonly definition: Extract<StoredDefinition, { transport: 'stdio' }>;
  readonly credentials: { readonly secrets: Readonly<JsonObject> } | null;
  readonly store: { readonly connectionDirectory: (id: ConnectionId) => Promise<string> };
  readonly resolveExecutable: (command: StdioDefinition['command']) => Promise<string>;
  readonly checkArgument?: (argument: string) => Promise<void>;
  readonly workerPath: string;
  readonly onStderr?: (tail: string) => void;
  readonly log?: (event: string, fields: { readonly connection: ConnectionId }) => void;
};

const STDERR_TAIL_BYTES = 64 * 1024;
const STOP_GRACE_MS = 2000;
const KILL_GRACE_MS = 5000;

const insideDirectory = (directory: string, relative: string) => {
  const target = path.resolve(directory, relative);
  if (target !== directory && !target.startsWith(`${directory}${path.sep}`)) throw new ProtectedMcpError('invalid_state_path', { status: 500 });
  return target;
};

function redactSecrets(text: string, secrets: Readonly<JsonObject>) {
  let result = text;
  for (const value of Object.values(secrets)) {
    if (isString(value) && value.length >= 4) result = result.split(value).join('[redacted]');
  }
  return result;
}

export async function startStdioUpstream({ definition, credentials, store, resolveExecutable, checkArgument = async () => {}, workerPath, onStderr = () => {}, log = () => {} }: StdioUpstreamOptions): Promise<McpBackend & { readonly pid: number | undefined }> {
  const executable = await resolveExecutable(definition.stdio.command);
  for (const argument of definition.stdio.args) {
    if (isString(argument) && path.isAbsolute(argument)) await checkArgument(argument);
  }
  const directory = await store.connectionDirectory(definition.id);
  const home = path.join(directory, 'home');
  const temporary = path.join(directory, 'tmp');
  const secretsRoot = path.join(directory, 'secrets');
  await Promise.all([ensurePrivateDirectory(home), ensurePrivateDirectory(temporary), ensurePrivateDirectory(secretsRoot)]);
  const secretDirectory = await fs.mkdtemp(path.join(secretsRoot, 'session-'));
  const discardSecrets = () => fs.rm(secretDirectory, { recursive: true, force: true }).catch(() => {});

  const secrets = credentials?.secrets ?? {};
  let child: ChildProcessWithoutNullStreams;
  try {
    const env: JsonObject = { PATH: workerPath, HOME: home, TMPDIR: temporary, LANG: 'C.UTF-8' };
    for (const [name, value] of Object.entries(definition.stdio.env)) {
      if (isString(value)) env[name] = value;
      else if ('secret' in value) env[name] = secrets[value.secret];
      else if ('secretFile' in value) {
        const content = secrets[value.secretFile];
        if (!isString(content)) throw new ProtectedMcpError('secret_missing', { status: 500, message: `secret_missing: ${name}` });
        const file = path.join(secretDirectory, value.secretFile);
        await writePrivateFile(file, content);
        env[name] = file;
      } else env[name] = insideDirectory(directory, value.state);
    }
    const workerEnvironment = Object.fromEntries(Object.entries(env).map(([name, value]) => {
      if (!isString(value)) throw new ProtectedMcpError('secret_missing', { status: 500, message: `secret_missing: ${name}` });
      return [name, value] as const;
    }));
    const args = definition.stdio.args.map((argument) => (isString(argument) ? argument : insideDirectory(directory, argument.state)));
    child = spawn(executable, args, { cwd: directory, env: workerEnvironment, stdio: ['pipe', 'pipe', 'pipe'], detached: true });
    await new Promise<void>((resolve, reject) => {
      child.once('spawn', () => resolve());
      child.once('error', (error: NodeJS.ErrnoException) => reject(new ProtectedMcpError('runtime_unavailable', { status: 500, message: error.code ?? 'spawn_failed' })));
    });
  } catch (error) {
    await discardSecrets();
    throw error;
  }
  let onMessage: (message: JsonValue) => void = () => {};
  let onClose = () => {};
  let exited = false;
  let stderrTail = '';

  const killGroup = (signal: NodeJS.Signals) => {
    try {
      if (child.pid === undefined) return;
      process.kill(-child.pid, signal);
    } catch { return; }
  };
  child.stdout.on('data', createLineReader({
    onValue: (value) => onMessage(value),
    onInvalid: () => log('worker_invalid_output', { connection: definition.id }),
    onOverflow: () => log('worker_frame_too_large', { connection: definition.id }),
  }));
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => {
    stderrTail = redactSecrets(`${stderrTail}${chunk}`, secrets).slice(-STDERR_TAIL_BYTES);
    onStderr(stderrTail);
  });
  child.stdin.on('error', () => {});
  child.once('exit', () => {
    exited = true;
    discardSecrets();
    onClose();
  });

  return {
    pid: child.pid,
    send(message) {
      if (exited) return;
      if (child.stdin.writableLength > MAX_FRAME_BYTES * 2) {
        killGroup('SIGKILL');
        return;
      }
      child.stdin.write(`${JSON.stringify(message)}\n`);
    },
    onMessage(callback) { onMessage = callback; },
    onClose(callback) { onClose = callback; },
    close() {
      if (exited) return;
      child.stdin.end();
      setTimeout(() => {
        if (exited) return;
        killGroup('SIGTERM');
        setTimeout(() => { if (!exited) killGroup('SIGKILL'); }, KILL_GRACE_MS).unref();
      }, STOP_GRACE_MS).unref();
    },
  };
}
