import { EXIT_CODE, TunnelCliError } from './cli-errors.js';
import { hashUiPassword, normalizeUiPassword } from '../../server/lib/ui-auth/ui-password-hash.js';

async function readAll(stream) {
  const chunks = [];
  for await (const chunk of stream) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

// Reads the password from stdin (never argv, so it stays out of shell history
// and the process list) and prints the OPENCHAMBER_UI_PASSWORD_HASH value.
async function hashPasswordCommand(_options, { stdin = process.stdin, stdout = process.stdout, stderr = process.stderr } = {}) {
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
