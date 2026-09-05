import type { OzonPublishJob, OzonPublishJobState } from '@n8n-media-review/shared';

export type OzonAutomaticStateGroup = 'waiting' | 'processing' | 'attention' | 'success' | 'closed';

export const ozonAutomaticStateMeta: Record<OzonPublishJobState, {
  label: string;
  color: string;
  group: OzonAutomaticStateGroup;
}> = {
  WAITING_MEDIA: { label: '等待媒体', color: 'default', group: 'waiting' },
  READY: { label: '等待调度', color: 'cyan', group: 'processing' },
  UPLOADING_MEDIA: { label: '上传媒体', color: 'processing', group: 'processing' },
  SUBMITTING: { label: '提交商品', color: 'processing', group: 'processing' },
  IMPORTING: { label: '导入受理', color: 'blue', group: 'processing' },
  VERIFYING_IMAGES: { label: '图片读回', color: 'purple', group: 'processing' },
  UPDATING_PRICE: { label: '价格生效', color: 'geekblue', group: 'processing' },
  UPDATING_STOCK: { label: '库存可售', color: 'lime', group: 'processing' },
  MODERATING: { label: '平台审核', color: 'orange', group: 'processing' },
  SUCCEEDED: { label: '已可售', color: 'green', group: 'success' },
  NEEDS_ATTENTION: { label: '需要处理', color: 'volcano', group: 'attention' },
  FAILED: { label: '上品失败', color: 'red', group: 'attention' },
  CANCELLED: { label: '已取消', color: 'default', group: 'closed' }
};

export type OzonAutomaticTaskReason = {
  text: string;
  detail?: string;
  tone: 'waiting' | 'processing' | 'attention' | 'success' | 'closed';
  nextAttemptAt?: string;
};

function positiveInteger(value: unknown): number | undefined {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : undefined;
}

function text(value: unknown): string | undefined {
  const normalized = typeof value === 'string' ? value.trim() : '';
  return normalized || undefined;
}

function platformLinks(job: Pick<OzonPublishJob, 'ozonProductLinks'>) {
  return Array.isArray(job.ozonProductLinks) ? job.ozonProductLinks : [];
}

type OzonAutomaticTaskStatusInput = Pick<OzonPublishJob, 'state' | 'ozonProductLinks'>
  & Partial<Pick<OzonPublishJob, 'offerIds' | 'payload'>>;

function expectedOfferIds(job: OzonAutomaticTaskStatusInput): string[] {
  const payloadOfferIds = Array.isArray(job.payload?.expectedOfferIds)
    ? job.payload.expectedOfferIds
    : Array.isArray(job.payload?.offerIds)
      ? job.payload.offerIds
      : [];
  return [...new Set([...(job.offerIds || []), ...payloadOfferIds]
    .map((offerId) => String(offerId || '').trim())
    .filter(Boolean))];
}

export function ozonAutomaticTaskPlatformState(job: OzonAutomaticTaskStatusInput): {
  label: string;
  color: string;
  state: 'ON_SALE' | 'ARCHIVED' | 'PARTIAL_ON_SALE' | 'NOT_FOR_SALE';
} | undefined {
  const expected = expectedOfferIds(job);
  if (!expected.length) return undefined;
  const linksByOfferId = new Map(platformLinks(job).map((link) => [link.offerId, link]));
  const links = expected.map((offerId) => linksByOfferId.get(offerId));
  if (links.some((link) => !link)) return undefined;
  const states = links.map((link) => link!.displayState);
  if (states.every((state) => state === 'ON_SALE')) return { label: '已可售', color: 'green', state: 'ON_SALE' };
  if (states.every((state) => state === 'ARCHIVED')) return { label: '已经归档', color: 'default', state: 'ARCHIVED' };
  if (states.every((state) => state === 'ON_SALE' || state === 'ARCHIVED')) {
    return { label: '部分可售', color: 'gold', state: 'PARTIAL_ON_SALE' };
  }
  if (states.every((state) => state === 'NOT_FOR_SALE')) {
    return { label: '商品已下架', color: 'volcano', state: 'NOT_FOR_SALE' };
  }
  return undefined;
}

export function ozonAutomaticTaskPrimaryState(job: OzonAutomaticTaskStatusInput): {
  label: string;
  color: string;
} {
  if (job.payload?.networkRecovery?.status === 'WAITING_NETWORK') {
    return { label: 'OZON上品中', color: 'processing' };
  }
  const meta = ozonAutomaticStateMeta[job.state];
  return { label: meta.label, color: meta.color };
}

export function ozonAutomaticTaskVersionMode(job: Pick<OzonPublishJob, 'revision' | 'payload' | 'publicationMode'> & { taskKind?: string }): {
  revisionLabel: string;
  modeLabel: string;
} {
  const revision = positiveInteger(job.revision) || positiveInteger(job.payload?.revision);
  const mode = text(job.payload?.mode);
  return {
    revisionLabel: revision ? `R${revision}` : 'R—',
    modeLabel: job.taskKind === 'STORE_PUBLICATION' || mode === 'MULTISTORE_PUBLICATION'
      ? job.publicationMode === 'COMPATIBLE_UPSERT' ? '兼容更新' : '自动创建'
      : '迁移前任务'
  };
}

const defaultReasons: Record<OzonPublishJobState, string> = {
  WAITING_MEDIA: '等待对应变体的 E005 图片和 E004 视频完成投递。',
  READY: '上品资料已就绪，等待自动调度。',
  UPLOADING_MEDIA: '正在上传图片与产品视频。',
  SUBMITTING: '正在提交商品资料到 OZON。',
  IMPORTING: 'OZON 已受理，正在读取导入结果。',
  VERIFYING_IMAGES: '正在核对图片与产品视频读回。',
  UPDATING_PRICE: '正在写入并核对商品价格。',
  UPDATING_STOCK: '正在写入并核对可售库存。',
  MODERATING: '等待平台审核并确认商品可售。',
  SUCCEEDED: '商品资料、媒体、价格与库存已完成同步。',
  NEEDS_ATTENTION: '任务需要人工检查后继续处理。',
  FAILED: '自动上品未完成，请查看错误信息。',
  CANCELLED: '任务已取消，上品资料仍然保留。'
};

export function ozonAutomaticTaskReason(job: Pick<
  OzonPublishJob,
  'state' | 'payload' | 'lastErrorCode' | 'lastErrorMessage' | 'nextAttemptAt' | 'ozonProductLinks'
> & Partial<Pick<OzonPublishJob, 'offerIds'>>): OzonAutomaticTaskReason {
  const platformState = ozonAutomaticTaskPlatformState(job);
  if (platformState?.state === 'PARTIAL_ON_SALE') {
    return {
      text: job.state === 'CANCELLED'
        ? '自动上品流程已取消；平台回读显示部分变体已可售、部分变体已经归档。'
        : '平台回读显示部分变体已可售、部分变体已经归档。',
      tone: job.state === 'CANCELLED' ? 'closed' : 'attention'
    };
  }
  if (platformState?.state === 'ARCHIVED') {
    const detail = platformLinks(job).map((link) => text(link.platformMessage)).find(Boolean);
    return {
      text: '全部变体已经归档，买家端不可售。',
      ...(detail ? { detail } : {}),
      tone: 'closed'
    };
  }
  if (platformState?.state === 'NOT_FOR_SALE') {
    const detail = platformLinks(job).map((link) => text(link.platformMessage)).find(Boolean);
    return {
      text: '全部变体已被平台下架，当前不对买家展示。',
      ...(detail ? { detail } : {}),
      tone: 'attention'
    };
  }

  const recovery = job.payload?.networkRecovery;
  if (recovery?.status === 'WAITING_NETWORK') {
    const nextAttemptAt = text(recovery.nextAttemptAt) || text(job.nextAttemptAt);
    return {
      text: '系统正在继续完成 OZON 上品，无需人工处理。',
      tone: 'processing',
      ...(nextAttemptAt ? { nextAttemptAt } : {})
    };
  }

  const canShowError = ['WAITING_MEDIA', 'NEEDS_ATTENTION', 'FAILED'].includes(job.state);
  const errorMessage = canShowError ? text(job.lastErrorMessage) : undefined;
  const errorCode = canShowError ? text(job.lastErrorCode) : undefined;
  const meta = ozonAutomaticStateMeta[job.state];
  return {
    text: errorMessage || defaultReasons[job.state],
    ...(errorCode ? { detail: errorCode } : {}),
    tone: meta.group === 'success'
      ? 'success'
      : meta.group === 'attention'
        ? 'attention'
        : meta.group === 'closed'
          ? 'closed'
          : meta.group
  };
}

export function ozonAutomaticTaskStatistics(counts: Record<string, number> = {}): {
  waiting: number;
  processing: number;
  needsAttention: number;
  succeeded: number;
} {
  const summary = { waiting: 0, processing: 0, needsAttention: 0, succeeded: 0 };
  for (const [state, rawCount] of Object.entries(counts)) {
    const meta = ozonAutomaticStateMeta[state as OzonPublishJobState];
    const count = Number(rawCount);
    if (!meta || !Number.isFinite(count) || count <= 0) continue;
    if (meta.group === 'waiting') summary.waiting += count;
    else if (meta.group === 'processing') summary.processing += count;
    else if (meta.group === 'attention') summary.needsAttention += count;
    else if (meta.group === 'success') summary.succeeded += count;
  }
  return summary;
}
