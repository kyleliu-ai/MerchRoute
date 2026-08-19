import { createCipheriv, createDecipheriv, createHmac, randomBytes } from 'node:crypto';
import { AppError } from '@n8n-media-review/shared';

export type OzonCredentialPair = { clientId: string; apiKey: string };

export type OzonEncryptedCredentialPair = {
  ciphertext: string;
  nonce: string;
  authTag: string;
  fingerprint: string;
  keyVersion: number;
};

export class OzonCredentialVault {
  private readonly key?: Buffer;
  private readonly configurationError?: string;

  constructor(secret = process.env.MERCHROUTE_CREDENTIAL_ENCRYPTION_KEY) {
    const value = String(secret || '').trim();
    if (!value) return;
    const decoded = Buffer.from(value, 'base64');
    if (decoded.length !== 32 || decoded.toString('base64').replace(/=+$/, '') !== value.replace(/=+$/, '')) {
      this.configurationError = 'MERCHROUTE_CREDENTIAL_ENCRYPTION_KEY 必须是 32 字节 Base64 密钥';
      return;
    }
    this.key = decoded;
  }

  get configured(): boolean { return Boolean(this.key); }

  encrypt(pairInput: OzonCredentialPair, storeId: string, credentialVersionId: string): OzonEncryptedCredentialPair {
    const pair = normalizeCredentialPair(pairInput);
    const key = this.requireKey();
    const plaintext = stableCredentialJson(pair);
    const nonce = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, nonce);
    cipher.setAAD(Buffer.from(associatedIdentity(storeId, credentialVersionId), 'utf8'));
    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    return {
      ciphertext: ciphertext.toString('base64'),
      nonce: nonce.toString('base64'),
      authTag: cipher.getAuthTag().toString('base64'),
      fingerprint: createHmac('sha256', key).update(plaintext, 'utf8').digest('hex').slice(0, 16),
      keyVersion: 1
    };
  }

  decrypt(encrypted: OzonEncryptedCredentialPair, storeId: string, credentialVersionId: string): OzonCredentialPair {
    const key = this.requireKey();
    try {
      const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(encrypted.nonce, 'base64'));
      decipher.setAAD(Buffer.from(associatedIdentity(storeId, credentialVersionId), 'utf8'));
      decipher.setAuthTag(Buffer.from(encrypted.authTag, 'base64'));
      const plaintext = Buffer.concat([
        decipher.update(Buffer.from(encrypted.ciphertext, 'base64')),
        decipher.final()
      ]).toString('utf8');
      const parsed = JSON.parse(plaintext) as Record<string, unknown>;
      return normalizeCredentialPair({ clientId: String(parsed.clientId || ''), apiKey: String(parsed.apiKey || '') });
    } catch {
      throw new AppError('CREDENTIAL_DECRYPT_FAILED', 'OZON 凭据无法解密，已拒绝发送平台请求', {
        keyVersion: encrypted.keyVersion,
        fingerprint: encrypted.fingerprint
      }, 503);
    }
  }

  private requireKey(): Buffer {
    if (!this.key) {
      throw new AppError(
        'CONFIG_INVALID',
        this.configurationError || '未配置 MERCHROUTE_CREDENTIAL_ENCRYPTION_KEY，OZON 凭据写入和网关调用已关闭',
        undefined,
        503
      );
    }
    return this.key;
  }
}

function associatedIdentity(storeId: string, credentialVersionId: string): string {
  return `ozon-store:${storeId}:credential:${credentialVersionId}`;
}

function normalizeCredentialPair(input: OzonCredentialPair): OzonCredentialPair {
  const clientId = String(input.clientId || '').trim();
  const apiKey = String(input.apiKey || '').trim();
  if (!clientId || !apiKey) throw new AppError('CONFIG_INVALID', 'OZON Client-Id 和 Api-Key 必须成对填写');
  return { clientId, apiKey };
}

function stableCredentialJson(pair: OzonCredentialPair): string {
  return JSON.stringify({ apiKey: pair.apiKey, clientId: pair.clientId });
}
