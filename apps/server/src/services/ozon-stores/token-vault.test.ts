import { randomBytes, randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { OzonCredentialVault } from './token-vault.js';

describe('OZON credential pair vault', () => {
  it('fails closed without a valid encryption key', () => {
    expect(() => new OzonCredentialVault('').encrypt(
      { clientId: 'client-never-log', apiKey: 'api-key-never-log-123456' },
      randomUUID(),
      randomUUID()
    )).toThrowError(expect.objectContaining({ code: 'CONFIG_INVALID' }));
  });

  it('encrypts the pair atomically and binds it to both store and credential version', () => {
    const vault = new OzonCredentialVault(randomBytes(32).toString('base64'));
    const storeId = randomUUID();
    const credentialVersionId = randomUUID();
    const pair = { clientId: '123456', apiKey: 'top-secret-api-key-1234567890' };
    const encrypted = vault.encrypt(pair, storeId, credentialVersionId);
    expect(JSON.stringify(encrypted)).not.toContain(pair.clientId);
    expect(JSON.stringify(encrypted)).not.toContain(pair.apiKey);
    expect(vault.decrypt(encrypted, storeId, credentialVersionId)).toEqual(pair);
    expect(() => vault.decrypt(encrypted, randomUUID(), credentialVersionId)).toThrowError(
      expect.objectContaining({ code: 'CREDENTIAL_DECRYPT_FAILED' })
    );
    expect(() => vault.decrypt(encrypted, storeId, randomUUID())).toThrowError(
      expect.objectContaining({ code: 'CREDENTIAL_DECRYPT_FAILED' })
    );
  });

  it('rejects tampered ciphertext without exposing plaintext', () => {
    const vault = new OzonCredentialVault(randomBytes(32).toString('base64'));
    const storeId = randomUUID();
    const credentialVersionId = randomUUID();
    const encrypted = vault.encrypt({ clientId: '123456', apiKey: 'top-secret-api-key-1234567890' }, storeId, credentialVersionId);
    const tampered = { ...encrypted, ciphertext: `${encrypted.ciphertext.slice(0, -2)}AA` };
    expect(() => vault.decrypt(tampered, storeId, credentialVersionId)).toThrowError(
      expect.objectContaining({ code: 'CREDENTIAL_DECRYPT_FAILED' })
    );
  });
});
