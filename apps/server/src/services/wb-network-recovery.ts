import { AppError, type WbNetworkDeliveryState, type WbNetworkRecovery } from '@n8n-media-review/shared';

type JsonRecord = Record<string, unknown>;

export const WB_NETWORK_RETRY_DELAYS_MS = [30_000, 60_000, 300_000, 900_000] as const;
export const WB_READABLE_AMBIGUITY_LIMIT_MS = 24 * 60 * 60 * 1_000;

export type WbNetworkErrorClassification = {
  code: string;
  httpStatus?: number;
  deliveryState: WbNetworkDeliveryState;
  retryAfterMs?: number;
};

export function classifyWbNetworkError(error: unknown): WbNetworkErrorClassification | undefined {
  const record = asRecord(error);
  const details = error instanceof AppError ? asRecord(error.details) : asRecord(record.details);
  const httpStatus = positiveInteger(details.httpStatus ?? record.httpStatus ?? record.statusCode);
  const transportCode = transportErrorCode(error);
  const deliveryUnknown = details.deliveryUnknown === true;
  const persistentHttpFailure = httpStatus === 408 || httpStatus === 429 || Boolean(httpStatus && httpStatus >= 500 && httpStatus <= 599);
  const infrastructureFailure = error instanceof AppError && error.code === 'DATABASE_UNAVAILABLE';
  if (!transportCode && !deliveryUnknown && !persistentHttpFailure && !infrastructureFailure) return undefined;
  const code = transportCode || (error instanceof AppError ? error.code : persistentHttpFailure ? `HTTP_${httpStatus}` : 'NETWORK_UNAVAILABLE');
  const deliveryState: WbNetworkDeliveryState = details.deliveryUnknown === false && !persistentHttpFailure
    ? 'NOT_SENT'
    : transportCode && ['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN'].includes(transportCode)
      ? 'NOT_SENT'
      : httpStatus === 429 ? 'RESPONDED' : 'UNKNOWN';
  const retryAfterMs = retryAfterFrom(error, details);
  return {
    code,
    ...(httpStatus ? { httpStatus } : {}),
    deliveryState,
    ...(retryAfterMs !== undefined ? { retryAfterMs } : {})
  };
}

export function nextWbNetworkRecovery(input: {
  previous?: WbNetworkRecovery | null;
  phase: string;
  resumeState: string;
  error: unknown;
  checkpoint?: string;
  now?: Date;
}): { recovery: WbNetworkRecovery; delayMs: number; classification: WbNetworkErrorClassification } | undefined {
  const classification = classifyWbNetworkError(input.error);
  if (!classification) return undefined;
  const now = input.now ?? new Date();
  const nowIso = now.toISOString();
  const attempt = Math.max(0, Number(input.previous?.attempt || 0)) + 1;
  const baseDelay = WB_NETWORK_RETRY_DELAYS_MS[Math.min(attempt - 1, WB_NETWORK_RETRY_DELAYS_MS.length - 1)]!;
  const delayMs = Math.max(baseDelay, classification.retryAfterMs ?? 0);
  const message = input.error instanceof Error ? input.error.message : String(input.error || '网络连接中断');
  return {
    classification,
    delayMs,
    recovery: {
      phase: input.phase,
      resumeState: input.previous?.resumeState || input.resumeState,
      deliveryState: classification.deliveryState,
      attempt,
      firstFailureAt: input.previous?.firstFailureAt || nowIso,
      lastFailureAt: nowIso,
      nextAttemptAt: new Date(now.getTime() + delayMs).toISOString(),
      lastErrorCode: classification.code,
      lastErrorMessage: message,
      ...(classification.retryAfterMs !== undefined ? { retryAfterMs: classification.retryAfterMs } : {}),
      ...(input.checkpoint ? { checkpoint: input.checkpoint } : input.previous?.checkpoint ? { checkpoint: input.previous.checkpoint } : {}),
      ...(input.previous?.readableAmbiguityElapsedMs !== undefined
        ? { readableAmbiguityElapsedMs: input.previous.readableAmbiguityElapsedMs }
        : {})
    }
  };
}

export function nextWbReadableAmbiguityRecovery(input: {
  previous?: WbNetworkRecovery | null;
  phase: string;
  resumeState: string;
  message: string;
  checkpoint?: string;
  now?: Date;
}): { recovery: WbNetworkRecovery; delayMs: number; needsAttention: boolean } {
  const now = input.now ?? new Date();
  const nowIso = now.toISOString();
  const previousObservedAt = input.previous?.readableAmbiguityLastObservedAt
    ? Date.parse(input.previous.readableAmbiguityLastObservedAt)
    : Number.NaN;
  const elapsedSincePreviousRead = Number.isFinite(previousObservedAt)
    ? Math.max(0, now.getTime() - previousObservedAt)
    : 0;
  const readableAmbiguityElapsedMs = Math.max(0, Number(input.previous?.readableAmbiguityElapsedMs || 0)) + elapsedSincePreviousRead;
  const attempt = Math.max(0, Number(input.previous?.attempt || 0)) + 1;
  const delayMs = WB_NETWORK_RETRY_DELAYS_MS[Math.min(attempt - 1, WB_NETWORK_RETRY_DELAYS_MS.length - 1)]!;
  return {
    delayMs,
    needsAttention: readableAmbiguityElapsedMs >= WB_READABLE_AMBIGUITY_LIMIT_MS,
    recovery: {
      phase: input.phase,
      resumeState: input.previous?.resumeState || input.resumeState,
      deliveryState: 'UNKNOWN',
      attempt,
      firstFailureAt: input.previous?.firstFailureAt || nowIso,
      lastFailureAt: nowIso,
      nextAttemptAt: new Date(now.getTime() + delayMs).toISOString(),
      lastErrorCode: 'WB_WRITE_OUTCOME_AMBIGUOUS',
      lastErrorMessage: input.message,
      ...(input.checkpoint ? { checkpoint: input.checkpoint } : input.previous?.checkpoint ? { checkpoint: input.previous.checkpoint } : {}),
      readableAmbiguityElapsedMs,
      readableAmbiguityLastObservedAt: nowIso
    }
  };
}

export function transportErrorCode(error: unknown): string | undefined {
  const supported = new Set([
    'ETIMEDOUT', 'ESOCKETTIMEDOUT', 'ECONNRESET', 'ECONNABORTED',
    'ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'TLS_EOF'
  ]);
  const record = asRecord(error);
  const cause = asRecord(record.cause);
  const details = asRecord(record.details);
  for (const value of [record.code, cause.code, details.code, details.errorCode]) {
    const normalized = String(value || '').trim().toUpperCase();
    if (supported.has(normalized)) return normalized;
  }
  const message = `${error instanceof Error ? error.message : String(error || '')} ${String(cause.message || '')} ${String(details.reason || '')}`.toUpperCase();
  for (const code of supported) if (message.includes(code)) return code;
  if (/SOCKET\s+HANG\s+UP/.test(message)) return 'ECONNRESET';
  if (/TLS[^\n]*(?:EOF|DISCONNECT)|CLIENT NETWORK SOCKET DISCONNECTED/.test(message)) return 'TLS_EOF';
  return undefined;
}

function retryAfterFrom(error: unknown, details: JsonRecord): number | undefined {
  const record = asRecord(error);
  for (const value of [details.retryAfterMs, details.retry_after_ms, record.retryAfterMs]) {
    if (value === undefined || value === null || value === '') continue;
    const numeric = Number(value);
    if (Number.isFinite(numeric) && numeric >= 0) return Math.ceil(numeric);
  }
  for (const value of [details.retryAfter, details.retry_after, record.retryAfter]) {
    if (value === undefined || value === null || value === '') continue;
    const seconds = Number(value);
    if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds * 1_000);
    const date = Date.parse(String(value));
    if (Number.isFinite(date)) return Math.max(0, date - Date.now());
  }
  return undefined;
}

function positiveInteger(value: unknown): number | undefined {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function asRecord(value: unknown): JsonRecord {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : {};
}
