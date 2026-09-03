import { AsyncLocalStorage } from 'node:async_hooks';

export const reviewOperationContext = new AsyncLocalStorage<{ operationId: string }>();
