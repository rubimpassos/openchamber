import fs from 'node:fs';
import tty from 'node:tty';

type PasswordInput = { readonly value: string; readonly done: boolean; readonly cancelled: boolean };

export function typed(state: PasswordInput, keys: string): PasswordInput {
  if (keys.startsWith('\u001b')) return state;
  let { value } = state;
  for (const key of keys) {
    if (key === '\r' || key === '\n' || key === '\u0004') return { value, done: true, cancelled: false };
    if (key === '\u0003') return { value: '', done: true, cancelled: true };
    if (key === '\u007f' || key === '\b') value = [...value].slice(0, -1).join('');
    else if (key >= ' ') value += key;
  }
  return { value, done: false, cancelled: false };
}

async function readHidden(prompt: string, device: string): Promise<string | null> {
  let input: tty.ReadStream | null = null;
  let output: tty.WriteStream;
  try {
    input = new tty.ReadStream(fs.openSync(device, 'r'));
    output = new tty.WriteStream(fs.openSync(device, 'w'));
  } catch {
    input?.destroy();
    return null;
  }
  const terminal = input;
  try {
    output.write(prompt);
    terminal.setRawMode(true);
    const result = await new Promise<PasswordInput>((resolve, reject) => {
      let state: PasswordInput = { value: '', done: false, cancelled: false };
      terminal.on('data', (chunk: Buffer) => {
        state = typed(state, chunk.toString('utf8'));
        if (state.done) resolve(state);
      });
      terminal.once('error', reject);
    });
    output.write('\n');
    if (result.cancelled) throw Object.assign(new Error('The password was not given'), { code: 'cancelled' });
    return result.value;
  } finally {
    terminal.setRawMode(false);
    terminal.destroy();
    output.destroy();
  }
}

export async function askNewPassword({ device = '/dev/tty' } = {}) {
  const first = await readHidden('Password for OpenChamber: ', device);
  if (first === null) return null;
  const again = await readHidden('The same password again: ', device);
  if (first !== again) throw Object.assign(new Error('The two passwords differ'), { code: 'ui_password_mismatch' });
  return first;
}
