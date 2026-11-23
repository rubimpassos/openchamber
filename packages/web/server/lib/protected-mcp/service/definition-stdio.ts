import path from 'node:path';
import { isPlainObject, isString } from '../../shared/guards.js';
import type { EnvironmentValue, PackageCommand, StateReference, StdioDefinition } from './definition-types.js';
import { fail, MAX_ITEMS, onlyKeys, plainText, relativeStatePath, slotReference } from './definition-values.js';
import type { JsonValue } from '../../shared/json-values.js';

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const PACKAGE_NAME = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;
const EXACT_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const BIN_NAME = /^[A-Za-z0-9._-]{1,128}$/;
const RESERVED_ENVIRONMENT = new Set([
  'PATH', 'HOME', 'TMPDIR', 'NODE_OPTIONS', 'NODE_PATH', 'NODE_EXTRA_CA_CERTS', 'LD_PRELOAD', 'LD_LIBRARY_PATH',
  'LD_AUDIT', 'PYTHONPATH', 'PYTHONHOME', 'PYTHONSTARTUP', 'PERL5LIB', 'PERL5OPT', 'RUBYLIB', 'RUBYOPT',
  'BASH_ENV', 'ENV', 'GIT_EXEC_PATH', 'GCONV_PATH',
]);

function parseArgument(value: JsonValue | undefined, field: string): string | StateReference {
  if (isString(value)) return plainText(value, field);
  if (!isPlainObject(value)) fail('invalid_definition', field);
  if ('secret' in value || 'secretFile' in value) fail('secret_in_arguments', field);
  onlyKeys(value, ['state'], field);
  return { state: relativeStatePath(value.state, field) };
}

function parseEnvironmentValue(value: JsonValue | undefined, field: string): EnvironmentValue {
  if (isString(value)) return plainText(value, field);
  if (!isPlainObject(value)) fail('invalid_definition', field);
  const [kind] = Object.keys(value);
  if (Object.keys(value).length !== 1) fail('invalid_definition', field);
  switch (kind) {
    case 'secret': return { secret: slotReference(value, 'secret', field) };
    case 'secretFile': return { secretFile: slotReference(value, 'secretFile', field) };
    case 'state': return { state: relativeStatePath(value.state, field) };
    default: return fail('invalid_definition', field);
  }
}

function parseCommand(value: JsonValue | undefined): string | PackageCommand {
  if (isString(value)) {
    if (!path.isAbsolute(value) || path.normalize(value) !== value || value.includes('\0')) fail('invalid_command', 'stdio.command');
    return value;
  }
  if (!isPlainObject(value)) fail('invalid_command', 'stdio.command');
  onlyKeys(value, ['package', 'version', 'bin'], 'stdio.command');
  if (!isString(value.package) || !PACKAGE_NAME.test(value.package) || value.package.length > 214) fail('invalid_package', 'stdio.command.package');
  if (!isString(value.version) || !EXACT_VERSION.test(value.version)) fail('invalid_package', 'stdio.command.version');
  if (!isString(value.bin) || !BIN_NAME.test(value.bin)) fail('invalid_package', 'stdio.command.bin');
  return { package: value.package, version: value.version, bin: value.bin };
}

export function parseStdio(value: JsonValue | undefined): StdioDefinition {
  if (!isPlainObject(value)) fail('invalid_definition', 'stdio');
  onlyKeys(value, ['command', 'args', 'env'], 'stdio');
  const args = value.args ?? [];
  if (!Array.isArray(args) || args.length > MAX_ITEMS) fail('invalid_definition', 'stdio.args');
  const env = value.env ?? {};
  if (!isPlainObject(env) || Object.keys(env).length > MAX_ITEMS) fail('invalid_definition', 'stdio.env');
  const parsedEnv: Record<string, EnvironmentValue> = {};
  for (const [name, item] of Object.entries(env)) {
    if (!ENV_NAME.test(name)) fail('invalid_definition', `stdio.env.${name}`);
    if (RESERVED_ENVIRONMENT.has(name) || name.startsWith('DYLD_')) fail('reserved_environment', `stdio.env.${name}`);
    parsedEnv[name] = parseEnvironmentValue(item, `stdio.env.${name}`);
  }
  return {
    command: parseCommand(value.command),
    args: args.map((item: JsonValue, index) => parseArgument(item, `stdio.args.${index}`)),
    env: parsedEnv,
  };
}
