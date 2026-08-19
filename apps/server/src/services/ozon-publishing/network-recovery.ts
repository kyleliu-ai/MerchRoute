import {
  type OzonNetworkDeliveryState,
  type OzonNetworkRecovery,
  type OzonPublishJob,
  type OzonPublishJobState
} from '@n8n-media-review/shared';

export const OZON_NETWORK_RETRY_DELAYS_MS = [30_000, 60_000, 300_000, 900_000] as const;

const NOT_SENT_CODES = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN']);
const UNKNOWN_DELIVERY_CODES = new Set([
  'ECONNABORTED',
  'ECONNRESET',
  'EPIPE',
  'ETIMEDOUT',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_SOCKET'
]);

export class OzonNetworkRequestError extends Error {
  readonly code: string;
  readonly deliveryState: OzonNetworkDeliveryState;
  readonly retryAfterMs?: number;

  constructor(input: {
    code: string;
    message: string;
    deliveryState: OzonNetworkDeliveryState;
    retryAfterMs?: number;
    cause?: unknown;
  }) {
    super(input.message, { cause: input.cause });
    this.name = 'OzonNetworkRequestError';
    this.code = input.code;
    this.deliveryState = input.deliveryState;
    this.retryAfterMs = input.retryAfterMs;
  }
}

export type NormalizedOzonNetworkError = {
  code: string;
  message: string;
  deliveryState: OzonNetworkDeliveryState;
  retryAfterMs?: number;
};

export function normalizeOzonNetworkError(error: unknown): NormalizedOzonNetworkError | undefined {
  if (error instanceof OzonNetworkRequestError) {
    return {
      code: error.code,
      message: error.message,
      deliveryState: error.deliveryState,
      ...(error.retryAfterMs !== undefined ? { retryAfterMs: error.retryAfterMs } : {})
    };
  }
  const code = nestedErrorCode(error);
  const name = error instanceof Error ? error.name.toUpperCase() : '';
  const message = error instanceof Error ? error.message : String(error || 'OZON 网络请求失败');
  if (name === 'ABORTERROR' || name === 'TIMEOUTERROR') {
    return { code: 'ETIMEDOUT', message, deliveryState: 'UNKNOWN' };
  }
  if (NOT_SENT_CODES.has(code)) return { code, message, deliveryState: 'NOT_SENT' };
  if (UNKNOWN_DELIVERY_CODES.has(code)) return { code, message, deliveryState: 'UNKNOWN' };
  if (/fetch failed|network error|socket hang up|连接被重置|连接超时|网络.*(?:不可用|中断|失败)/i.test(message)) {
    return { code: code || 'OZON_NETWORK_ERROR', message, deliveryState: 'UNKNOWN' };
  }
  return undefined;
}

export function isOzonNetworkError(error: unknown): boolean {
  return Boolean(normalizeOzonNetworkError(error));
}

export function nextOzonNetworkRecovery(
  job: Pick<OzonPublishJob, 'payload'>,
  input: {
    phase: string;
    resumeState: OzonPublishJobState;
    error: unknown;
    checkpoint?: Record<string, unknown>;
    now?: Date;
  }
): OzonNetworkRecovery {
  const normalized = normalizeOzonNetworkError(input.error);
  if (!normalized) throw new TypeError('nextOzonNetworkRecovery 只接受网络或上游瞬时错误');
  const now = input.now || new Date();
  const previous = job.payload?.networkRecovery;
  const attempt = previous?.status === 'WAITING_NETWORK' && previous.phase === input.phase
    ? Math.max(0, Number(previous.attempt || 0)) + 1
    : 1;
  const configuredDelay = OZON_NETWORK_RETRY_DELAYS_MS[Math.min(attempt - 1, OZON_NETWORK_RETRY_DELAYS_MS.length - 1)]!;
  const delayMs = Math.max(configuredDelay, normalized.retryAfterMs || 0);
  return {
    schemaVersion: 1,
    status: 'WAITING_NETWORK',
    phase: input.phase,
    resumeState: input.resumeState,
    deliveryState: normalized.deliveryState,
    attempt,
    firstFailureAt: previous?.status === 'WAITING_NETWORK' && previous.phase === input.phase
      ? previous.firstFailureAt
      : now.toISOString(),
    lastFailureAt: now.toISOString(),
    nextAttemptAt: new Date(now.getTime() + delayMs).toISOString(),
    errorCode: normalized.code,
    errorMessage: normalized.message,
    ...(normalized.retryAfterMs !== undefined ? { retryAfterMs: normalized.retryAfterMs } : {}),
    ...(input.checkpoint ? { checkpoint: input.checkpoint } : {})
  };
}

export function parseRetryAfterMs(value: string | null, now = Date.now()): number | undefined {
  const raw = String(value || '').trim();
  if (!raw) return undefined;
  if (/^\d+(?:\.\d+)?$/.test(raw)) return Math.max(0, Math.ceil(Number(raw) * 1_000));
  const timestamp = Date.parse(raw);
  return Number.isFinite(timestamp) ? Math.max(0, timestamp - now) : undefined;
}

function nestedErrorCode(error: unknown): string {
  let current = error;
  for (let depth = 0; depth < 4 && current && typeof current === 'object'; depth += 1) {
    const source = current as { code?: unknown; cause?: unknown };
    const code = String(source.code || '').trim().toUpperCase();
    if (code) return code;
    current = source.cause;
  }
  return '';
}
