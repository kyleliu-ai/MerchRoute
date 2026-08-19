import { AppError, type WbStorePublication } from '@n8n-media-review/shared';

type JsonRecord = Record<string, unknown>;

export type WbPublicationDispatchError = {
  kind: 'REJECTED' | 'UNKNOWN';
  code: string;
  message: string;
  error: AppError;
};

export function classifyWbPublicationDispatchError(error: unknown, input: {
  publicationId: string;
  taskId: string;
}): WbPublicationDispatchError {
  const code = error instanceof AppError ? error.code : 'WB_PUBLICATION_DISPATCH_UNKNOWN';
  const message = error instanceof Error ? error.message : 'WB 多店铺发布调度结果未知';
  const details = error instanceof AppError ? error.details : undefined;
  const explicitlyRejected = error instanceof AppError
    && (details?.deliveryUnknown === false || error.code === 'CONFIG_INVALID');
  if (explicitlyRejected) {
    return { kind: 'REJECTED', code, message, error };
  }
  return {
    kind: 'UNKNOWN',
    code,
    message,
    error: new AppError(code, message, {
      ...(details || {}),
      publicationId: input.publicationId,
      expectedTaskId: input.taskId,
      deliveryUnknown: true
    }, error instanceof AppError ? error.statusCode : 502)
  };
}

export function publicationHasUnknownDispatch(publication: Pick<WbStorePublication, 'status' | 'result'>): boolean {
  if (publication.status !== 'DISPATCHING') return false;
  return asRecord(asRecord(publication.result).dispatchRecovery).deliveryUnknown === true;
}

export function unknownDispatchReadbackError(
  publication: Pick<WbStorePublication, 'id' | 'taskId'>,
  error: unknown
): WbPublicationDispatchError {
  const source = error instanceof AppError ? error : undefined;
  const code = source?.code || 'WB_PUBLICATION_DISPATCH_UNKNOWN';
  const message = source?.message || 'WB 发布提交结果未知，等待按原 taskId 回读';
  return {
    kind: 'UNKNOWN',
    code,
    message,
    error: new AppError(code, message, {
      ...(source?.details || {}),
      publicationId: publication.id,
      expectedTaskId: publication.taskId,
      deliveryUnknown: true,
      recovery: 'TASK_ID_READBACK_ONLY'
    }, 502)
  };
}

function asRecord(value: unknown): JsonRecord {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : {};
}
