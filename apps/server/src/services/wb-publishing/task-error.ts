type JsonRecord = Record<string, unknown>;

export type WbTaskErrorDetails = {
  errorCode: string;
  errorMessage: string | null;
};

export function wbTaskErrorDetails(listing: unknown, runtimeTask?: unknown): WbTaskErrorDetails {
  const listingRecord = asRecord(listing);
  const runtimeRecord = asRecord(runtimeTask);
  const candidates = compactRecords([
    runtimeRecord,
    asRecord(runtimeRecord.job),
    asRecord(runtimeRecord.task),
    asRecord(runtimeRecord.data),
    asRecord(asRecord(runtimeRecord.data).job),
    asRecord(listingRecord.task),
    listingRecord
  ]);

  const explicitCode = firstText(candidates.flatMap((candidate) => [
    candidate.errorCode,
    candidate.error_code,
    candidate.lastErrorCode,
    candidate.last_error_code,
    asRecord(candidate.error).code
  ]));
  const legacyErrorCode = candidates
    .map((candidate) => codeLikeText(candidate.error))
    .find(Boolean);
  const errorCode = explicitCode || legacyErrorCode || 'WB_TASK_FAILED';
  const errorMessage = firstText(candidates.flatMap((candidate) => [
    candidate.errorMessage,
    candidate.error_message,
    candidate.lastErrorMessage,
    candidate.last_error_message,
    candidate.lastError,
    candidate.message,
    asRecord(candidate.error).message
  ])) || (errorCode !== 'WB_TASK_FAILED' ? errorCode : null);

  return { errorCode, errorMessage };
}

function asRecord(value: unknown): JsonRecord {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : {};
}

function compactRecords(records: JsonRecord[]): JsonRecord[] {
  return records.filter((record) => Object.keys(record).length > 0);
}

function firstText(values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value !== 'string' && typeof value !== 'number') continue;
    const normalized = String(value).trim();
    if (normalized) return normalized;
  }
  return undefined;
}

function codeLikeText(value: unknown): string | undefined {
  const normalized = typeof value === 'string' || typeof value === 'number' ? String(value).trim() : '';
  return normalized && !/\s/.test(normalized) ? normalized : undefined;
}
