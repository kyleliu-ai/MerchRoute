import { describe, expect, it, vi } from 'vitest';
import { AppError } from '@n8n-media-review/shared';
import { classifyWbNetworkError, nextWbNetworkRecovery, nextWbReadableAmbiguityRecovery } from './wb-network-recovery.js';

describe('WB persistent network recovery', () => {
  it('uses 30s, 60s, 5m, 15m and then keeps waiting every 15m', () => {
    const now = new Date('2026-08-07T12:00:00.000Z');
    let previous;
    const delays: number[] = [];
    for (let attempt = 1; attempt <= 7; attempt += 1) {
      const planned = nextWbNetworkRecovery({
        previous,
        phase: 'CHECK_VENDOR_CODES',
        resumeState: 'CHECKING',
        error: Object.assign(new Error('connection reset'), { code: 'ECONNRESET' }),
        now
      })!;
      previous = planned.recovery;
      delays.push(planned.delayMs);
    }
    expect(delays).toEqual([30_000, 60_000, 300_000, 900_000, 900_000, 900_000, 900_000]);
    expect(previous).toMatchObject({ attempt: 7, resumeState: 'CHECKING', deliveryState: 'UNKNOWN' });
  });

  it('never shortens Retry-After and accepts both seconds-converted milliseconds and HTTP-date', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-07T12:00:00.000Z'));
    try {
      const milliseconds = nextWbNetworkRecovery({
        phase: 'WB_WRITE', resumeState: 'SUBMITTING', now: new Date(),
        error: new AppError('VERIFY_FAILED', 'rate limited', { httpStatus: 429, retryAfterMs: 1_200_000 }, 502)
      })!;
      expect(milliseconds.delayMs).toBe(1_200_000);
      expect(milliseconds.recovery.deliveryState).toBe('RESPONDED');

      const seconds = nextWbNetworkRecovery({
        phase: 'WB_READ', resumeState: 'RUNNING', now: new Date(),
        error: new AppError('VERIFY_FAILED', 'rate limited', { httpStatus: 429, retryAfter: '45' }, 502)
      })!;
      expect(seconds.delayMs).toBe(45_000);

      const date = nextWbNetworkRecovery({
        phase: 'WB_READ', resumeState: 'RUNNING', now: new Date(),
        error: new AppError('VERIFY_FAILED', 'server busy', { httpStatus: 503, retryAfter: 'Fri, 07 Aug 2026 12:20:00 GMT' }, 502)
      })!;
      expect(date.delayMs).toBe(1_200_000);
    } finally {
      vi.useRealTimers();
    }
  });

  it('classifies definite pre-delivery failures separately from unknown outcomes', () => {
    expect(classifyWbNetworkError(Object.assign(new Error('dns failed'), { code: 'ENOTFOUND' }))).toMatchObject({
      code: 'ENOTFOUND', deliveryState: 'NOT_SENT'
    });
    expect(classifyWbNetworkError(new AppError('VERIFY_FAILED', 'response lost', { deliveryUnknown: true }, 502))).toMatchObject({
      code: 'VERIFY_FAILED', deliveryState: 'UNKNOWN'
    });
    expect(classifyWbNetworkError(new AppError('CONFIG_INVALID', 'bad category', undefined, 409))).toBeUndefined();
  });

  it('counts only consecutive platform-readable ambiguity toward the 24h manual fallback', () => {
    const first = nextWbReadableAmbiguityRecovery({
      phase: 'SUBMIT_READBACK', resumeState: 'SUBMITTING', message: 'not found',
      now: new Date('2026-08-07T00:00:00.000Z')
    });
    const disconnected = nextWbNetworkRecovery({
      previous: first.recovery, phase: 'SUBMIT_READBACK', resumeState: 'SUBMITTING',
      error: Object.assign(new Error('offline'), { code: 'ENOTFOUND' }),
      now: new Date('2026-08-08T12:00:00.000Z')
    })!;
    const readableAgain = nextWbReadableAmbiguityRecovery({
      previous: disconnected.recovery, phase: 'SUBMIT_READBACK', resumeState: 'SUBMITTING', message: 'still not found',
      now: new Date('2026-08-09T00:00:00.000Z')
    });
    expect(readableAgain.recovery.readableAmbiguityElapsedMs).toBe(0);
    expect(readableAgain.needsAttention).toBe(false);
    const after24h = nextWbReadableAmbiguityRecovery({
      previous: readableAgain.recovery, phase: 'SUBMIT_READBACK', resumeState: 'SUBMITTING', message: 'still not found',
      now: new Date('2026-08-10T00:00:00.000Z')
    });
    expect(after24h.needsAttention).toBe(true);
  });
});
