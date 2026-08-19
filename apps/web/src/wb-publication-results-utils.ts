import type { WbListing, WbStorePublication, WbStorePublicationStatus } from './api/client';

const ACTIVE_PUBLICATION_STATUSES = new Set<WbStorePublicationStatus>([
  'PLANNED',
  'DISPATCHING',
  'QUEUED',
  'RUNNING'
]);

const ATTENTION_PUBLICATION_STATUSES = new Set<WbStorePublicationStatus>([
  'FAILED',
  'NEEDS_ATTENTION'
]);

export const wbPublicationStatusMeta: Record<WbStorePublicationStatus, { label: string; color: string }> = {
  PLANNED: { label: '计划已创建', color: 'default' },
  DISPATCHING: { label: '正在派发', color: 'processing' },
  QUEUED: { label: '已排队', color: 'blue' },
  RUNNING: { label: '上品中', color: 'processing' },
  SUCCEEDED: { label: '已完成', color: 'green' },
  FAILED: { label: '失败', color: 'red' },
  NEEDS_ATTENTION: { label: '需要处理', color: 'volcano' },
  PAUSED: { label: '已暂停', color: 'gold' }
};

export function isWbPublicationActive(publication: Pick<WbStorePublication, 'status'>): boolean {
  return ACTIVE_PUBLICATION_STATUSES.has(publication.status);
}

export function summarizeWbPublications(publications: readonly WbStorePublication[]) {
  const succeeded = publications.filter((item) => item.status === 'SUCCEEDED').length;
  const active = publications.filter(isWbPublicationActive).length;
  const attention = publications.filter((item) => ATTENTION_PUBLICATION_STATUSES.has(item.status)).length;
  const paused = publications.filter((item) => item.status === 'PAUSED').length;
  const parts = [
    succeeded ? `${succeeded} 家完成` : '',
    active ? `${active} 家处理中` : '',
    attention ? `${attention} 家需处理` : '',
    paused ? `${paused} 家暂停` : ''
  ].filter(Boolean);

  return {
    total: publications.length,
    succeeded,
    active,
    attention,
    paused,
    submitted: publications.length > 0,
    allSucceeded: publications.length > 0 && succeeded === publications.length,
    taskCount: new Set(publications.map((item) => item.taskId).filter(Boolean)).size,
    productCount: publications.reduce((count, item) => count + (item.nmIds || []).length, 0),
    detail: parts.length ? parts.join(' · ') : '等待选择店铺'
  };
}

export function wbManualListingDisplay(
  listing: WbListing,
  publications: readonly WbStorePublication[]
): WbListing {
  const current = latestManualPublicationBatch(listing, publications);
  if (!current.length) return listing;

  const statuses = new Set(current.map((publication) => publication.status));
  const batchComplete = hasCompletePublicationBatch(current);
  const status: WbListing['status'] = batchComplete && current.every((publication) => publication.status === 'SUCCEEDED')
    ? 'SUCCEEDED'
    : statuses.has('NEEDS_ATTENTION') || statuses.has('PAUSED')
      ? 'NEEDS_ATTENTION'
      : statuses.has('FAILED')
        ? 'FAILED'
        : statuses.has('RUNNING')
          ? 'RUNNING'
          : statuses.has('QUEUED')
            ? 'QUEUED'
            : statuses.has('PLANNED') || statuses.has('DISPATCHING')
              ? 'SUBMITTING'
              : listing.status;
  const nmIds = uniqueStrings([
    ...current.flatMap((publication) => (publication.nmIds || []).map(String))
  ]);
  const productUrls = uniqueStrings([
    ...current.flatMap((publication) => publication.productUrls || [])
  ]);
  return { ...listing, status, nmIds, productUrls };
}

export type WbManualListingRow = {
  key: string;
  listing: WbListing;
  publication: WbStorePublication;
  publishedDraftVersion?: number;
  currentDraftChanged: boolean;
};

export function wbManualListingRows(
  listings: readonly WbListing[],
  publications: readonly WbStorePublication[]
): WbManualListingRow[] {
  const publicationsBySku = new Map<string, WbStorePublication[]>();
  for (const publication of publications) {
    if (publication.source !== 'MANUAL' || !publication.planHash) continue;
    const current = publicationsBySku.get(publication.sku) || [];
    current.push(publication);
    publicationsBySku.set(publication.sku, current);
  }

  return listings.flatMap((listing) => {
    const latestBatch = latestManualPublicationBatchForSku(publicationsBySku.get(listing.sku) || []);
    return [...latestBatch]
      .sort((left, right) => left.revision - right.revision || left.storeAlias.localeCompare(right.storeAlias))
      .map((publication) => {
        const publishedDraftVersion = publication.draftVersion
          || positiveInteger(publication.configSnapshot?.draftVersion);
        return {
          key: publication.id,
          listing,
          publication,
          ...(publishedDraftVersion ? { publishedDraftVersion } : {}),
          currentDraftChanged: Boolean(publishedDraftVersion && publishedDraftVersion !== listing.draftVersion)
        };
      });
  });
}

function hasCompletePublicationBatch(publications: readonly WbStorePublication[]): boolean {
  const expectedStoreIds = uniqueStrings(publications.flatMap((publication) => {
    const value = publication.configSnapshot?.planStoreIds;
    return Array.isArray(value) ? value.map(String) : [];
  }));
  if (!expectedStoreIds.length) return true;
  const actualStoreIds = new Set(publications.map((publication) => publication.storeId));
  return expectedStoreIds.every((storeId) => actualStoreIds.has(storeId));
}

function latestManualPublicationBatch(
  listing: Pick<WbListing, 'sku' | 'status' | 'draftVersion' | 'generatedVersionId'>,
  publications: readonly WbStorePublication[]
): WbStorePublication[] {
  const matching = publications.filter((publication) => {
    if (publication.source !== 'MANUAL' || publication.sku !== listing.sku || !publication.planHash) return false;
    const snapshot = publication.configSnapshot || {};
    const snapshotDraftVersion = Number(snapshot.draftVersion);
    if (Number.isInteger(snapshotDraftVersion) && snapshotDraftVersion > 0) {
      return snapshotDraftVersion === listing.draftVersion;
    }
    return listing.status === 'GENERATED'
      && Boolean(listing.generatedVersionId)
      && String(snapshot.baseGeneratedVersionId || '') === listing.generatedVersionId;
  });
  if (!matching.length) return [];
  const createdAtByPlan = new Map<string, number>();
  for (const publication of matching) {
    const createdAt = Date.parse(publication.createdAt);
    createdAtByPlan.set(publication.planHash!, Math.max(
      createdAtByPlan.get(publication.planHash!) || Number.NEGATIVE_INFINITY,
      Number.isFinite(createdAt) ? createdAt : Number.NEGATIVE_INFINITY
    ));
  }
  const latestPlanHash = [...createdAtByPlan.entries()]
    .sort((left, right) => right[1] - left[1] || right[0].localeCompare(left[0]))[0]?.[0];
  return matching.filter((publication) => publication.planHash === latestPlanHash);
}

function latestManualPublicationBatchForSku(publications: readonly WbStorePublication[]): WbStorePublication[] {
  if (!publications.length) return [];
  const createdAtByPlan = new Map<string, number>();
  for (const publication of publications) {
    if (!publication.planHash) continue;
    const createdAt = Date.parse(publication.createdAt);
    createdAtByPlan.set(publication.planHash, Math.max(
      createdAtByPlan.get(publication.planHash) || Number.NEGATIVE_INFINITY,
      Number.isFinite(createdAt) ? createdAt : Number.NEGATIVE_INFINITY
    ));
  }
  const latestPlanHash = [...createdAtByPlan.entries()]
    .sort((left, right) => right[1] - left[1] || right[0].localeCompare(left[0]))[0]?.[0];
  return latestPlanHash ? publications.filter((publication) => publication.planHash === latestPlanHash) : [];
}

function positiveInteger(value: unknown): number | undefined {
  const normalized = Number(value);
  return Number.isInteger(normalized) && normalized > 0 ? normalized : undefined;
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => String(value || '').trim()).filter(Boolean))];
}

export function wbPublicationProductLinks(publication: Pick<WbStorePublication, 'nmIds' | 'productUrls' | 'productLinks'>) {
  const nmIds = [...new Set((publication.nmIds || [])
    .map((value) => String(value || '').trim())
    .filter((value) => /^\d+$/.test(value)))];
  const urlsByNmId = new Map<string, string>();
  const variantsByNmId = new Map<string, Set<string>>();

  const candidates = [
    ...(publication.productLinks || []).map((link) => ({
      url: String(link.url || ''),
      declaredNmId: String(link.nmId || '').trim(),
      variantCode: String(link.variantCode || '').trim()
    })),
    ...(publication.productUrls || []).map((url) => ({ url: String(url || ''), declaredNmId: '', variantCode: '' }))
  ];
  for (const candidate of candidates) {
    try {
      const url = new URL(candidate.url);
      const match = url.pathname.match(/^\/catalog\/(\d+)(?:\/|$)/);
      if (url.protocol !== 'https:' || (url.hostname !== 'wildberries.ru' && !url.hostname.endsWith('.wildberries.ru')) || !match) continue;
      const nmId = match[1]!;
      if (candidate.declaredNmId && candidate.declaredNmId !== nmId) continue;
      if (!urlsByNmId.has(nmId)) urlsByNmId.set(nmId, url.toString());
      if (candidate.variantCode) {
        const variants = variantsByNmId.get(nmId) || new Set<string>();
        variants.add(candidate.variantCode);
        variantsByNmId.set(nmId, variants);
      }
    } catch {
      // Ignore malformed or non-WB links from historical task results.
    }
  }

  const orderedIds = [...nmIds, ...[...urlsByNmId.keys()].filter((nmId) => !nmIds.includes(nmId))];
  return orderedIds.map((nmId) => {
    const variants = variantsByNmId.get(nmId);
    return {
      nmId,
      url: urlsByNmId.get(nmId) || `https://www.wildberries.ru/catalog/${nmId}/detail.aspx`,
      ...(variants?.size === 1 ? { variantCode: [...variants][0]! } : {})
    };
  });
}
