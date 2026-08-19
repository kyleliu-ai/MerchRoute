import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { WbTokenVault } from './token-vault.js';

describe('WbTokenVault', () => {
  it('does not fail service construction when the encryption key is absent', () => {
    const vault = new WbTokenVault('');
    expect(vault.configured).toBe(false);
    expect(() => vault.encrypt('never-log-this-token', 'wb-store:first')).toThrowError(expect.objectContaining({
      code: 'CONFIG_INVALID', statusCode: 503
    }));
  });

  it('encrypts with AES-256-GCM and binds ciphertext to the store identity', () => {
    const vault = new WbTokenVault(randomBytes(32).toString('base64'));
    const token = 'wb-secret-token-for-test-only';
    const encrypted = vault.encrypt(token, 'wb-store:first');

    expect(encrypted.ciphertext).not.toContain(token);
    expect(encrypted.nonce).not.toBe('');
    expect(encrypted.authTag).not.toBe('');
    expect(vault.decrypt(encrypted, 'wb-store:first')).toBe(token);
    expect(() => vault.decrypt(encrypted, 'wb-store:second')).toThrowError(expect.objectContaining({
      code: 'CREDENTIAL_DECRYPT_FAILED'
    }));
  });

  it('fails closed for malformed keys and tampered authentication tags without exposing plaintext', () => {
    expect(() => new WbTokenVault('not-a-key').encrypt('plain-secret', 'wb-store:first')).toThrowError(
      expect.objectContaining({ code: 'CONFIG_INVALID' })
    );
    const vault = new WbTokenVault(randomBytes(32).toString('base64'));
    const encrypted = vault.encrypt('plain-secret', 'wb-store:first');
    const tampered = { ...encrypted, authTag: Buffer.alloc(16, 1).toString('base64') };
    try {
      vault.decrypt(tampered, 'wb-store:first');
      throw new Error('expected decryption failure');
    } catch (error) {
      expect(String(error)).not.toContain('plain-secret');
      expect(error).toMatchObject({ code: 'CREDENTIAL_DECRYPT_FAILED' });
    }
  });
});
