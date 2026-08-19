import type { OzonPublication, OzonPublicationStatus } from './api/client';

const ACTIVE_STATUSES = new Set<OzonPublicationStatus>(['PLANNED', 'MATERIALIZED', 'QUEUED', 'RUNNING']);
const ATTENTION_STATUSES = new Set<OzonPublicationStatus>(['FAILED', 'NEEDS_ATTENTION']);

export const ozonPublicationStatusMeta: Record<OzonPublicationStatus, { label: string; color: string }> = {
  PLANNED: { label: '计划已冻结', color: 'blue' },
  MATERIALIZED: { label: '店铺发布包已生成', color: 'cyan' },
  QUEUED: { label: '等待执行', color: 'gold' },
  RUNNING: { label: '正在上品', color: 'processing' },
  SUCCEEDED: { label: '上品完成', color: 'green' },
  FAILED: { label: '上品失败', color: 'red' },
  NEEDS_ATTENTION: { label: '需要处理', color: 'volcano' },
  PAUSED: { label: '已暂停', color: 'default' },
  CANCELLED: { label: '已取消', color: 'default' }
};

export function isOzonPublicationActive(publication: Pick<OzonPublication, 'status'>) {
  return ACTIVE_STATUSES.has(publication.status);
}

export function summarizeOzonPublications(publications: readonly OzonPublication[]) {
  const succeeded = publications.filter((item) => item.status === 'SUCCEEDED').length;
  const active = publications.filter(isOzonPublicationActive).length;
  const attention = publications.filter((item) => ATTENTION_STATUSES.has(item.status)).length;
  const paused = publications.filter((item) => item.status === 'PAUSED').length;
  return {
    total: publications.length,
    succeeded,
    active,
    attention,
    paused,
    taskCount: new Set(publications.map((item) => item.taskId).filter(Boolean)).size,
    offerCount: publications.reduce((sum, item) => sum + item.offerIds.length, 0),
    allSucceeded: publications.length > 0 && succeeded === publications.length
  };
}

export type OzonPublicationProductView = {
  offerId: string;
  productId?: string;
  ozonSku?: string;
  url?: string;
};

export type OzonPublicationActions = {
  canCancel: boolean;
  canRecheck: boolean;
  canCompatibleAppend: boolean;
  canRepublish: boolean;
};

export function ozonPublicationActions(status: OzonPublicationStatus): OzonPublicationActions {
  return {
    canCancel: ['PLANNED', 'MATERIALIZED', 'QUEUED', 'PAUSED'].includes(status),
    canRecheck: ['PLANNED', 'FAILED', 'NEEDS_ATTENTION', 'PAUSED'].includes(status),
    canCompatibleAppend: status === 'SUCCEEDED',
    canRepublish: ['SUCCEEDED', 'FAILED', 'NEEDS_ATTENTION'].includes(status)
  };
}

export function ozonPublicationCanRecheckLocally(
  publication: Pick<OzonPublication, 'status' | 'taskId'>
): boolean {
  // taskId is reserved deterministically when a schema-v4 attempt is planned;
  // only task-detail can decide whether it is still pre-platform.
  return ['PLANNED', 'FAILED', 'NEEDS_ATTENTION'].includes(publication.status);
}

export function ozonPublicationProducts(publication: Pick<OzonPublication, 'offerIds' | 'productIds' | 'ozonSkus' | 'productLinks'>): OzonPublicationProductView[] {
  const count = Math.max(publication.offerIds.length, publication.productIds.length, publication.ozonSkus.length, publication.productLinks.length);
  return Array.from({ length: count }, (_, index) => {
    const offerId = publication.offerIds[index] || `offer-${index + 1}`;
    const url = publication.productLinks[index];
    return {
      offerId,
      ...(publication.productIds[index] ? { productId: publication.productIds[index] } : {}),
      ...(publication.ozonSkus[index] ? { ozonSku: publication.ozonSkus[index] } : {}),
      ...(url ? { url } : {})
    };
  });
}
