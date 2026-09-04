import { AsyncLocalStorage } from 'node:async_hooks';
import type { ReviewOperationMetrics } from '@n8n-media-review/shared';

type ReviewOperationContext = { operationId: string; metrics: ReviewOperationMetrics };

export const reviewOperationContext = new AsyncLocalStorage<ReviewOperationContext>();

export function addReviewOperationPhase(name: string, durationMs: number): void {
  const metrics = reviewOperationContext.getStore()?.metrics;
  if (!metrics || !Number.isFinite(durationMs) || durationMs < 0) return;
  const phases = metrics.phases ||= {};
  phases[name] = Math.round(((phases[name] || 0) + durationMs) * 10) / 10;
}

export function addReviewOperationWork(fileCount: number, totalBytes: number): void {
  const metrics = reviewOperationContext.getStore()?.metrics;
  if (!metrics) return;
  metrics.fileCount = (metrics.fileCount || 0) + Math.max(0, Math.trunc(fileCount));
  metrics.totalBytes = (metrics.totalBytes || 0) + Math.max(0, Math.trunc(totalBytes));
}
