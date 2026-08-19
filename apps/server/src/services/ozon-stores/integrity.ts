import { createHmac, timingSafeEqual } from 'node:crypto';
import { AppError } from '@n8n-media-review/shared';

export function signIntakeTicket(
  payload: unknown,
  encryptionSecret = process.env.MERCHROUTE_CREDENTIAL_ENCRYPTION_KEY
): string {
  return signCredentialDerivedPayload(
    payload,
    'merchroute:ozon:intake-signing:v1',
    'OZON intake 票据',
    encryptionSecret
  );
}

export function signSharedSourceMarker(
  payload: unknown,
  encryptionSecret = process.env.MERCHROUTE_CREDENTIAL_ENCRYPTION_KEY
): string {
  return signCredentialDerivedPayload(
    payload,
    'merchroute:ozon:shared-source-signing:v1',
    'OZON 共享生成版本标记',
    encryptionSecret
  );
}

export function safeOzonSignatureEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function signCredentialDerivedPayload(
  payload: unknown,
  domain: string,
  purpose: string,
  encryptionSecret: string | undefined
): string {
  const value = String(encryptionSecret || '').trim();
  const encryptionKey = Buffer.from(value, 'base64');
  if (encryptionKey.length !== 32
    || encryptionKey.toString('base64').replace(/=+$/, '') !== value.replace(/=+$/, '')) {
    throw new AppError(
      'CONFIG_INVALID',
      `MERCHROUTE_CREDENTIAL_ENCRYPTION_KEY 必须是 32 字节 Base64 密钥，不能签发${purpose}`,
      undefined,
      503
    );
  }
  const derived = createHmac('sha256', encryptionKey).update(domain).digest();
  return `hmac-sha256:${createHmac('sha256', derived).update(stableJson(payload)).digest('hex')}`;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${stableJson(object[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}
