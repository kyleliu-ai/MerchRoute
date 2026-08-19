import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { AppError } from '@n8n-media-review/shared';

export type WbEncryptedToken = {
  ciphertext: string;
  nonce: string;
  authTag: string;
  fingerprint: string;
  keyVersion: number;
};

export class WbTokenVault {
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

  encrypt(tokenInput: string, associatedIdentity: string): WbEncryptedToken {
    const token = String(tokenInput || '').trim();
    if (!token) throw new AppError('CONFIG_INVALID', 'WB Token 不能为空');
    const key = this.requireKey();
    const nonce = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, nonce);
    cipher.setAAD(Buffer.from(associatedIdentity, 'utf8'));
    const ciphertext = Buffer.concat([cipher.update(token, 'utf8'), cipher.final()]);
    return {
      ciphertext: ciphertext.toString('base64'),
      nonce: nonce.toString('base64'),
      authTag: cipher.getAuthTag().toString('base64'),
      fingerprint: createHash('sha256').update(token, 'utf8').digest('hex').slice(0, 16),
      keyVersion: 1
    };
  }

  decrypt(encrypted: WbEncryptedToken, associatedIdentity: string): string {
    const key = this.requireKey();
    try {
      const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(encrypted.nonce, 'base64'));
      decipher.setAAD(Buffer.from(associatedIdentity, 'utf8'));
      decipher.setAuthTag(Buffer.from(encrypted.authTag, 'base64'));
      return Buffer.concat([
        decipher.update(Buffer.from(encrypted.ciphertext, 'base64')),
        decipher.final()
      ]).toString('utf8');
    } catch {
      throw new AppError('CREDENTIAL_DECRYPT_FAILED', 'WB Token 无法解密，已拒绝发送平台请求', {
        keyVersion: encrypted.keyVersion,
        fingerprint: encrypted.fingerprint
      }, 503);
    }
  }

  private requireKey(): Buffer {
    if (!this.key) {
      throw new AppError(
        'CONFIG_INVALID',
        this.configurationError || '未配置 MERCHROUTE_CREDENTIAL_ENCRYPTION_KEY，WB 凭据写入和网关调用已关闭',
        undefined,
        503
      );
    }
    return this.key;
  }
}
