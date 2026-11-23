import { execFile } from 'node:child_process';
import type { ExecFileOptions } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { isRecord, isString } from '../../shared/guards.js';
import { ProtectedMcpError } from './contract.js';
import { ensurePrivateDirectory, readJson, writePrivateFile } from './state-files.js';
import type { PackageCommand } from './definition-types.js';
import type { createIntegrity } from './integrity.js';

const INSTALL_TIMEOUT_MS = 10 * 60_000;

const packageKey = (command: PackageCommand) => `${command.package.replace(/^@/, '').replace('/', '__')}@${command.version}`;

type RunFile = (file: string, args: string[], options: ExecFileOptions, done: (error: Error | null) => void) => void;
type RuntimeOptions = {
  readonly directory: string;
  readonly npmCommand?: readonly [string, ...string[]] | null;
  readonly workerPath: string;
  readonly integrity: Pick<ReturnType<typeof createIntegrity>, 'inspect' | 'checkExecutable'>;
  readonly log?: (event: string, fields: { readonly package: string; readonly version: string; readonly code?: string }) => void;
  readonly runFile?: RunFile;
};

export function createRuntimes({ directory, npmCommand = null, workerPath, integrity, log = () => {}, runFile = execFile }: RuntimeOptions) {
  const installing = new Map<string, Promise<void>>();
  const failures = new Map<string, string>();
  const home = (command: PackageCommand) => path.join(directory, packageKey(command));
  const binary = (command: PackageCommand) => path.join(home(command), 'node_modules', '.bin', command.bin);
  const marker = (command: PackageCommand) => path.join(home(command), '.installed.json');

  const installed = async (command: PackageCommand) => {
    try {
      const record = await readJson(marker(command));
      return isRecord(record) && record.package === command.package && record.version === command.version;
    } catch {
      return false;
    }
  };

  const install = (command: PackageCommand) => {
    const key = packageKey(command);
    const running = installing.get(key);
    if (running) return running;
    const work = (async () => {
      if (await installed(command)) return;
      if (!npmCommand) throw new ProtectedMcpError('package_runtime_unavailable', { status: 500 });
      for (const part of npmCommand) {
        const { findings } = await integrity.inspect(part);
        if (findings.length > 0) throw new ProtectedMcpError('untrusted_package_manager', { status: 500 });
      }
      const target = home(command);
      await ensurePrivateDirectory(directory);
      await fs.rm(target, { recursive: true, force: true });
      await ensurePrivateDirectory(target);
      const scratch = path.join(directory, '.npm');
      await ensurePrivateDirectory(scratch);
      const env = {
        PATH: workerPath,
        HOME: scratch,
        LANG: 'C.UTF-8',
        npm_config_cache: path.join(scratch, 'cache'),
        npm_config_userconfig: path.join(scratch, 'npmrc'),
        npm_config_globalconfig: path.join(scratch, 'npmrc-global'),
        npm_config_update_notifier: 'false',
        npm_config_fund: 'false',
        npm_config_audit: 'false',
      };
      const [file, ...prefix] = npmCommand;
      await new Promise<void>((resolve, reject) => {
        runFile(file, [...prefix, 'install', '--prefix', target, '--ignore-scripts', '--no-audit', '--no-fund', '--omit=dev', '--no-save', '--loglevel=error', `${command.package}@${command.version}`], {
          cwd: target, env, timeout: INSTALL_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024,
        }, (error) => (error ? reject(new ProtectedMcpError('package_install_failed', { status: 500 })) : resolve()));
      });
      await integrity.checkExecutable(binary(command));
      await writePrivateFile(marker(command), JSON.stringify({ package: command.package, version: command.version }));
      failures.delete(key);
      log('package_installed', { package: command.package, version: command.version });
    })();
    installing.set(key, work);
    work.catch((error) => {
      const code = error instanceof Error && 'code' in error && isString(error.code) ? error.code : undefined;
      failures.set(key, code ?? 'package_install_failed');
      log('package_install_failed', { package: command.package, version: command.version, code: code ?? 'unknown' });
    }).finally(() => installing.delete(key));
    return work;
  };

  return {
    install,
    async status(command: string | PackageCommand): Promise<'ready' | 'installing' | 'failed' | 'missing'> {
      if (isString(command)) return 'ready';
      const key = packageKey(command);
      if (installing.has(key)) return 'installing';
      if (await installed(command)) return 'ready';
      return failures.has(key) ? 'failed' : 'missing';
    },
    async resolve(command: string | PackageCommand) {
      if (isString(command)) return integrity.checkExecutable(command);
      if (await installed(command)) return integrity.checkExecutable(binary(command));
      const key = packageKey(command);
      const failure = failures.get(key);
      if (failure !== undefined && !installing.has(key)) throw new ProtectedMcpError(failure, { status: 500 });
      install(command).catch(() => {});
      throw new ProtectedMcpError('runtime_installing', { status: 503 });
    },
  };
}
