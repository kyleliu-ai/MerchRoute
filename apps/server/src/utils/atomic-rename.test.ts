import { describe, expect, it, vi } from 'vitest';
import { ATOMIC_RENAME_RETRY_DELAYS_MS, atomicRenameWithRetry } from './atomic-rename.js';

const fsError = (code: string) => Object.assign(new Error(`${code} rename failure`), { code });

const fakeClock = () => {
  let elapsedMs = 0;
  return {
    now: () => elapsedMs,
    sleep: vi.fn(async (delayMs: number) => {
      elapsedMs += delayMs;
    })
  };
};

describe('atomicRenameWithRetry', () => {
  it('首次成功时不等待，也不写重试事件', async () => {
    const renameOperation = vi.fn(async () => undefined);
    const clock = fakeClock();
    const onRetry = vi.fn();
    const onRecovered = vi.fn();
    const onExhausted = vi.fn();

    await atomicRenameWithRetry('temp', 'final', { renameOperation, ...clock, onRetry, onRecovered, onExhausted });

    expect(renameOperation).toHaveBeenCalledOnce();
    expect(clock.sleep).not.toHaveBeenCalled();
    expect(onRetry).not.toHaveBeenCalled();
    expect(onRecovered).not.toHaveBeenCalled();
    expect(onExhausted).not.toHaveBeenCalled();
  });

  it.each(['EPERM', 'EBUSY'])('%s 连续两次失败后按固定退避恢复', async (code) => {
    let failuresRemaining = 2;
    const renameOperation = vi.fn(async () => {
      if (failuresRemaining > 0) {
        failuresRemaining -= 1;
        throw fsError(code);
      }
    });
    const clock = fakeClock();
    const onRetry = vi.fn();
    const onRecovered = vi.fn();
    const onExhausted = vi.fn();

    await atomicRenameWithRetry('temp', 'final', { renameOperation, ...clock, onRetry, onRecovered, onExhausted });

    expect(renameOperation).toHaveBeenCalledTimes(3);
    expect(clock.sleep.mock.calls.map(([delayMs]) => delayMs)).toEqual([100, 250]);
    expect(onRetry.mock.calls.map(([event]) => ({
      errorCode: event.errorCode,
      attemptNumber: event.attemptNumber,
      retryNumber: event.retryNumber,
      delayMs: event.delayMs,
      elapsedMs: event.elapsedMs
    }))).toEqual([
      { errorCode: code, attemptNumber: 1, retryNumber: 1, delayMs: 100, elapsedMs: 0 },
      { errorCode: code, attemptNumber: 2, retryNumber: 2, delayMs: 250, elapsedMs: 100 }
    ]);
    expect(onRecovered).toHaveBeenCalledWith(expect.objectContaining({
      errorCode: code,
      attemptNumber: 3,
      retryNumber: 2,
      totalAttempts: 6,
      totalRetries: 5,
      delayMs: 250,
      elapsedMs: 350
    }));
    expect(onExhausted).not.toHaveBeenCalled();
  });

  it('第 6 次仍失败时记录耗尽并透传最后一次错误', async () => {
    const errors = Array.from({ length: 6 }, () => fsError('EPERM'));
    const renameOperation = vi.fn(async () => {
      throw errors[renameOperation.mock.calls.length - 1];
    });
    const clock = fakeClock();
    const onRetry = vi.fn();
    const onRecovered = vi.fn();
    const onExhausted = vi.fn();

    await expect(atomicRenameWithRetry('temp', 'final', {
      renameOperation,
      ...clock,
      onRetry,
      onRecovered,
      onExhausted
    })).rejects.toBe(errors[5]);

    expect(renameOperation).toHaveBeenCalledTimes(6);
    expect(clock.sleep.mock.calls.map(([delayMs]) => delayMs)).toEqual([...ATOMIC_RENAME_RETRY_DELAYS_MS]);
    expect(onRetry).toHaveBeenCalledTimes(5);
    expect(onRecovered).not.toHaveBeenCalled();
    expect(onExhausted).toHaveBeenCalledOnce();
    expect(onExhausted).toHaveBeenCalledWith(expect.objectContaining({
      error: errors[5],
      errorCode: 'EPERM',
      attemptNumber: 6,
      retryNumber: 5,
      totalAttempts: 6,
      totalRetries: 5,
      delayMs: 0,
      elapsedMs: 3850
    }));
  });

  it.each(['EACCES', 'EEXIST', 'ENOENT'])('%s 首次失败即退出', async (code) => {
    const error = fsError(code);
    const renameOperation = vi.fn(async () => {
      throw error;
    });
    const clock = fakeClock();
    const onRetry = vi.fn();
    const onRecovered = vi.fn();
    const onExhausted = vi.fn();

    await expect(atomicRenameWithRetry('temp', 'final', {
      renameOperation,
      ...clock,
      onRetry,
      onRecovered,
      onExhausted
    })).rejects.toBe(error);

    expect(renameOperation).toHaveBeenCalledOnce();
    expect(clock.sleep).not.toHaveBeenCalled();
    expect(onRetry).not.toHaveBeenCalled();
    expect(onRecovered).not.toHaveBeenCalled();
    expect(onExhausted).not.toHaveBeenCalled();
  });

  it('最后一次允许的尝试成功时只记录恢复，不误记耗尽', async () => {
    let failuresRemaining = 5;
    const renameOperation = vi.fn(async () => {
      if (failuresRemaining > 0) {
        failuresRemaining -= 1;
        throw fsError('EBUSY');
      }
    });
    const clock = fakeClock();
    const onRecovered = vi.fn();
    const onExhausted = vi.fn();

    await atomicRenameWithRetry('temp', 'final', { renameOperation, ...clock, onRecovered, onExhausted });

    expect(renameOperation).toHaveBeenCalledTimes(6);
    expect(clock.sleep.mock.calls.map(([delayMs]) => delayMs)).toEqual([...ATOMIC_RENAME_RETRY_DELAYS_MS]);
    expect(onRecovered).toHaveBeenCalledWith(expect.objectContaining({
      errorCode: 'EBUSY',
      attemptNumber: 6,
      retryNumber: 5,
      elapsedMs: 3850
    }));
    expect(onExhausted).not.toHaveBeenCalled();
  });
});
