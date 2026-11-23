import { EXIT_CODE, TunnelCliError } from './cli-errors.js';
import { hashUiPassword, normalizeUiPassword } from '../../server/lib/ui-auth/ui-password-hash.js';
import { isString } from '../../server/lib/shared/guards.js';
import type { CliOptions } from './cli-args.js';

async function readAll(stream: AsyncIterable<Uint8Array | string>) {
  const chunks: Uint8Array[] = [];
  for await (const chunk of stream) {
    chunks.push(isString(chunk) ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function hashPasswordCommand(_options: CliOptions, { stdin = process.stdin, stdout = process.stdout, stderr = process.stderr }: {
  readonly stdin?: AsyncIterable<Uint8Array | string> & { readonly isTTY?: boolean };
  readonly stdout?: Pick<NodeJS.WriteStream, 'write'>;
  readonly stderr?: Pick<NodeJS.WriteStream, 'write'>;
} = {}) {
  if (stdin.isTTY) {
    stderr.write('Enter the UI password, then press Ctrl-D:\n');
  }
  const password = normalizeUiPassword(await readAll(stdin));
  if (!password) {
    throw new TunnelCliError('No password on stdin. Usage: printf %s "$PASSWORD" | openchamber hash-password', EXIT_CODE.USAGE_ERROR);
  }
  stdout.write(`${hashUiPassword(password)}\n`);
}

export { hashPasswordCommand };
