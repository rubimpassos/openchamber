import { describe, expect, it } from 'vitest';
import {
  isLoopbackBindHost,
  isNetworkExposedBindHost,
  isUiAuthConfigured,
} from './bind-host.js';
import { hashUiPassword } from '../ui-auth/ui-password-hash.js';

describe('bind host exposure classification', () => {
  it('allows only proven loopback bind hosts without authentication', () => {
    for (const host of ['localhost', '127.0.0.1', '127.25.1.2', '::1', '[::1]', '::ffff:127.0.0.1']) {
      expect(isLoopbackBindHost(host), host).toBe(true);
      expect(isNetworkExposedBindHost(host), host).toBe(false);
    }
  });

  it('treats wildcard, LAN, IPv6 local, and unknown hosts as exposed', () => {
    for (const host of [
      '0.0.0.0',
      '0',
      '0x0',
      '::',
      '[::]',
      '192.168.1.10',
      '10.0.0.5',
      '172.16.0.2',
      '::ffff:192.168.1.10',
      'fe80::1',
      'fc00::1',
      'openchamber.local',
      'example.com',
      '',
    ]) {
      expect(isLoopbackBindHost(host), host).toBe(false);
      expect(isNetworkExposedBindHost(host), host).toBe(true);
    }
  });
});

describe('UI auth configuration for network exposure', () => {
  it('accepts a well-formed password hash without a plaintext password', () => {
    expect(isUiAuthConfigured({ passwordHash: hashUiPassword('correct horse') })).toBe(true);
  });

  it('still accepts a plaintext password', () => {
    expect(isUiAuthConfigured({ password: 'correct horse' })).toBe(true);
  });

  it('rejects blank, missing and malformed credentials', () => {
    expect(isUiAuthConfigured({})).toBe(false);
    expect(isUiAuthConfigured({ password: '   ' })).toBe(false);
    expect(isUiAuthConfigured({ passwordHash: 'scrypt$not-base64!$x' })).toBe(false);
    expect(isUiAuthConfigured({ passwordHash: 'bcrypt$c2FsdA==$aGFzaA==' })).toBe(false);
  });
});
