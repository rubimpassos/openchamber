import { afterEach, describe, expect, it } from 'vitest';
import { collectStartupEnv } from './cli-startup.js';
import { hashUiPassword } from '../../server/lib/ui-auth/ui-password-hash.js';

const PLAINTEXT_KEY = 'OPENCHAMBER_UI_PASSWORD';
const HASH_KEY = 'OPENCHAMBER_UI_PASSWORD_HASH';
const saved = { [PLAINTEXT_KEY]: process.env[PLAINTEXT_KEY], [HASH_KEY]: process.env[HASH_KEY] };

afterEach(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe('startup env persistence of the UI password', () => {
  it('persists a hash of a plaintext password and never the plaintext', () => {
    process.env[PLAINTEXT_KEY] = 'plain-startup-pass';
    delete process.env[HASH_KEY];

    const env = collectStartupEnv({ uiPassword: 'plain-startup-pass' });

    expect(env).not.toHaveProperty(PLAINTEXT_KEY);
    expect(JSON.stringify(env)).not.toContain('plain-startup-pass');
    expect(env[HASH_KEY]).toMatch(/^scrypt\$/);
  });

  it('persists an inherited hash unchanged', () => {
    const hash = hashUiPassword('inherited');
    process.env[HASH_KEY] = hash;

    const env = collectStartupEnv({ uiPasswordHash: hash });

    expect(env[HASH_KEY]).toBe(hash);
  });
});
