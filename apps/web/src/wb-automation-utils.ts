export const wbAutoPublishStateMeta: Record<string, { label: string; color: string; group: 'waiting' | 'processing' | 'attention' | 'success' | 'closed' }> = {
  WAITING_MEDIA: { label: '等待媒体', color: 'default', group: 'waiting' },
  WAITING_STABLE: { label: '等待目录稳定', color: 'cyan', group: 'waiting' },
  WAITING_NETWORK: { label: '等待网络恢复', color: 'geekblue', group: 'waiting' },
  WAITING_GENERATION_TURN: { label: '等待同 SKU 版本冻结', color: 'geekblue', group: 'waiting' },
  CHECKING: { label: '检查上品条件', color: 'processing', group: 'processing' },
  INITIALIZING: { label: '初始化上品资料', color: 'processing', group: 'processing' },
  GENERATING: { label: '生成 product.json', color: 'cyan', group: 'processing' },
  SUBMITTING: { label: '提交到 WB', color: 'processing', group: 'processing' },
  QUEUED: { label: 'WB 已排队', color: 'blue', group: 'processing' },
  RUNNING: { label: 'WB 上品中', color: 'processing', group: 'processing' },
  SUCCEEDED: { label: '自动上品完成', color: 'green', group: 'success' },
  NEEDS_ATTENTION: { label: '需要人工处理', color: 'orange', group: 'attention' },
  PAUSED: { label: '已暂停', color: 'gold', group: 'attention' },
  BLOCKED_EXISTING_CARD: { label: '发现既有商品卡', color: 'volcano', group: 'attention' },
  FAILED: { label: '自动上品失败', color: 'red', group: 'attention' },
  CANCELLED: { label: '已取消', color: 'default', group: 'closed' }
};

export function summarizeWbAutoPublishCounts(counts: Record<string, number> = {}) {
  const summary = { waiting: 0, processing: 0, attention: 0, success: 0 };
  for (const [state, rawCount] of Object.entries(counts)) {
    const meta = wbAutoPublishStateMeta[state];
    const count = Number(rawCount) || 0;
    if (meta?.group === 'waiting') summary.waiting += count;
    else if (meta?.group === 'processing') summary.processing += count;
    else if (meta?.group === 'attention') summary.attention += count;
    else if (meta?.group === 'success') summary.success += count;
  }
  return summary;
}

export type WbAutoPublishIdentity = { storeId: string; sku: string };

export function wbAutoPublishJobKey(job: WbAutoPublishIdentity) {
  return `${job.storeId}:${job.sku}`;
}

export function sameWbAutoPublishJob(job: WbAutoPublishIdentity, identity?: WbAutoPublishIdentity) {
  return Boolean(identity && job.storeId === identity.storeId && job.sku === identity.sku);
}

export type WbAutoPublishNoticePresentation = {
  tone: 'progress' | 'error' | 'success';
  alertType: 'info' | 'warning' | 'success';
  codeLabel: '进度代码' | '错误代码';
};

const wbAutoPublishAttentionStates = new Set([
  'NEEDS_ATTENTION',
  'PAUSED',
  'BLOCKED_EXISTING_CARD',
  'FAILED'
]);

export function wbAutoPublishNoticePresentation(state: string): WbAutoPublishNoticePresentation {
  if (wbAutoPublishAttentionStates.has(state)) {
    return { tone: 'error', alertType: 'warning', codeLabel: '错误代码' };
  }
  if (state === 'SUCCEEDED') {
    return { tone: 'success', alertType: 'success', codeLabel: '进度代码' };
  }
  return { tone: 'progress', alertType: 'info', codeLabel: '进度代码' };
}

export type WbAutoPublishProductLinkInput = {
  nmId: string | number;
  url: string;
  variantCode?: string;
};

export function wbAutoPublishProductLinks(input: {
  productLinks?: WbAutoPublishProductLinkInput[];
  productUrls?: string[];
}): WbAutoPublishProductLinkInput[] {
  const output: WbAutoPublishProductLinkInput[] = [];
  const seen = new Set<string>();
  const append = (link: WbAutoPublishProductLinkInput) => {
    const url = String(link.url || '').trim();
    if (!isWbProductUrl(url) || seen.has(url)) return;
    seen.add(url);
    const variantCode = String(link.variantCode || '').trim();
    output.push({ nmId: link.nmId, url, ...(variantCode ? { variantCode } : {}) });
  };
  (input.productLinks || []).forEach(append);
  (input.productUrls || []).forEach((url) => append({ nmId: '', url }));
  return output;
}

function isWbProductUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && (url.hostname === 'wildberries.ru' || url.hostname.endsWith('.wildberries.ru'));
  }
  catch { return false; }
}
