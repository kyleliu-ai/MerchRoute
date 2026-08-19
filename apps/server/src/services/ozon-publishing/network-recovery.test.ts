import { describe, expect, it } from 'vitest';
import type { OzonPublishJob } from '@n8n-media-review/shared';
import {
  nextOzonNetworkRecovery,
  normalizeOzonNetworkError,
  OzonNetworkRequestError,
  parseRetryAfterMs
} from './network-recovery.js';

describe('OZON persistent network recovery', () => {
  const job = (networkRecovery?: OzonPublishJob['payload']['networkRecovery']) => ({
    payload: networkRecovery ? { networkRecovery } : {}
  }) as Pick<OzonPublishJob, 'payload'>;

  it('uses 30s, 60s, 5m, then 15m forever without exhausting the task', () => {
    const now = new Date('2026-08-07T00:00:00.000Z');
    const error = new OzonNetworkRequestError({
      code: 'ETIMEDOUT',
      message: 'response timed out',
      deliveryState: 'UNKNOWN'
    });
    let recovery = nextOzonNetworkRecovery(job(), { phase: 'N8N_DISPATCH', resumeState: 'READY', error, now });
    const delays: number[] = [Date.parse(recovery.nextAttemptAt) - now.getTime()];
    for (let attempt = 2; attempt <= 7; attempt += 1) {
      recovery = nextOzonNetworkRecovery(job(recovery), { phase: 'N8N_DISPATCH', resumeState: 'READY', error, now });
      delays.push(Date.parse(recovery.nextAttemptAt) - now.getTime());
      expect(recovery.attempt).toBe(attempt);
    }
    expect(delays).toEqual([30_000, 60_000, 300_000, 900_000, 900_000, 900_000, 900_000]);
    expect(recovery.deliveryState).toBe('UNKNOWN');
    expect(recovery.firstFailureAt).toBe(now.toISOString());
  });

  it('distinguishes definitely-not-sent connection failures from unknown outcomes', () => {
    expect(normalizeOzonNetworkError(Object.assign(new Error('refused'), { code: 'ECONNREFUSED' })))
      .toMatchObject({ code: 'ECONNREFUSED', deliveryState: 'NOT_SENT' });
    expect(normalizeOzonNetworkError(Object.assign(new Error('reset'), { code: 'ECONNRESET' })))
      .toMatchObject({ code: 'ECONNRESET', deliveryState: 'UNKNOWN' });
    expect(normalizeOzonNetworkError(new Error('bad input'))).toBeUndefined();
  });

  it('honors Retry-After when it is later than the local schedule', () => {
    const now = new Date('2026-08-07T00:00:00.000Z');
    const error = new OzonNetworkRequestError({
      code: 'OZON_UPSTREAM_HTTP_429',
      message: 'rate limited',
      deliveryState: 'UNKNOWN',
      retryAfterMs: 120_000
    });
    const recovery = nextOzonNetworkRecovery(job(), { phase: 'PRICE_WRITE', resumeState: 'UPDATING_PRICE', error, now });
    expect(recovery.nextAttemptAt).toBe('2026-08-07T00:02:00.000Z');
    expect(parseRetryAfterMs('120', now.getTime())).toBe(120_000);
    expect(parseRetryAfterMs('Fri, 07 Aug 2026 00:03:00 GMT', now.getTime())).toBe(180_000);
  });
});
