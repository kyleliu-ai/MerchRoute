import { rename } from 'node:fs/promises';

export const ATOMIC_RENAME_RETRY_DELAYS_MS = [100, 250, 500, 1000, 2000] as const;

type RenameOperation = (sourcePath: string, targetPath: string) => Promise<void>;

type AtomicRenameRetryEvent = {
  sourcePath: string;
  targetPath: string;
  error: NodeJS.ErrnoException;
  errorCode: string;
  attemptNumber: number;
  retryNumber: number;
  totalAttempts: number;
  totalRetries: number;
  delayMs: number;
  elapsedMs: number;
};

type AtomicRenameRecoveredEvent = Omit<AtomicRenameRetryEvent, 'error' | 'attemptNumber'> & {
  attemptNumber: number;
};

type AtomicRenameRetryOptions = {
  renameOperation?: RenameOperation;
  sleep?: (delayMs: number) => Promise<void>;
  now?: () => number;
  onRetry?: (event: AtomicRenameRetryEvent) => void;
  onRecovered?: (event: AtomicRenameRecoveredEvent) => void;
  onExhausted?: (event: AtomicRenameRetryEvent) => void;
};

const wait = (delayMs: number) => new Promise<void>((resolve) => setTimeout(resolve, delayMs));

const errorCodeOf = (error: unknown) => {
  if (!error || typeof error !== 'object' || !('code' in error)) return '';
  return typeof error.code === 'string' ? error.code.toUpperCase() : '';
};

export const isTransientAtomicRenameError = (error: unknown) => {
  const code = errorCodeOf(error);
  return code === 'EPERM' || code === 'EBUSY';
};

export const atomicRenameWithRetry = async (
  sourcePath: string,
  targetPath: string,
  options: AtomicRenameRetryOptions = {}
) => {
  const renameOperation = options.renameOperation ?? rename;
  const sleep = options.sleep ?? wait;
  const now = options.now ?? Date.now;
  const totalRetries = ATOMIC_RENAME_RETRY_DELAYS_MS.length;
  const totalAttempts = totalRetries + 1;
  const startedAt = now();
  let lastErrorCode = '';
  let lastDelayMs = 0;

  for (let attemptNumber = 1; attemptNumber <= totalAttempts; attemptNumber += 1) {
    try {
      await renameOperation(sourcePath, targetPath);
      if (attemptNumber > 1) {
        options.onRecovered?.({
          sourcePath,
          targetPath,
          errorCode: lastErrorCode,
          attemptNumber,
          retryNumber: attemptNumber - 1,
          totalAttempts,
          totalRetries,
          delayMs: lastDelayMs,
          elapsedMs: Math.max(0, now() - startedAt)
        });
      }
      return;
    } catch (error) {
      if (!isTransientAtomicRenameError(error)) throw error;

      const retryNumber = attemptNumber;
      const errorCode = errorCodeOf(error);
      const eventBase = {
        sourcePath,
        targetPath,
        error: error as NodeJS.ErrnoException,
        errorCode,
        attemptNumber,
        retryNumber,
        totalAttempts,
        totalRetries,
        elapsedMs: Math.max(0, now() - startedAt)
      };

      if (attemptNumber >= totalAttempts) {
        options.onExhausted?.({ ...eventBase, retryNumber: totalRetries, delayMs: 0 });
        throw error;
      }

      const delayMs = ATOMIC_RENAME_RETRY_DELAYS_MS[retryNumber - 1]!;
      lastErrorCode = errorCode;
      lastDelayMs = delayMs;
      options.onRetry?.({ ...eventBase, delayMs });
      await sleep(delayMs);
    }
  }
};
