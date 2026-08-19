export type ManifestMediaOrderMode = 'EXPLICIT' | 'LEGACY_PATH';

export type ManifestMediaOrderResult<T> =
  | { ok: true; mode: ManifestMediaOrderMode; assets: T[] }
  | { ok: false; reason: 'PARTIAL' | 'INVALID' | 'DUPLICATE' | 'NON_CONTIGUOUS'; message: string };

export type ManifestMediaOrderError = {
  variantKey: string;
  submissionId: string;
  reason: 'PARTIAL' | 'INVALID' | 'DUPLICATE' | 'NON_CONTIGUOUS';
  message: string;
};

/**
 * Resolve one latest E005 image batch without guessing a partially declared order.
 * Historical batches without sortOrder retain the existing natural path order.
 */
export function resolveManifestMediaOrder<T extends { relativePath: string; sortOrder?: unknown }>(
  assets: T[]
): ManifestMediaOrderResult<T> {
  const declared = assets.filter((asset) => asset.sortOrder !== undefined);
  if (!declared.length) {
    return {
      ok: true,
      mode: 'LEGACY_PATH',
      assets: [...assets].sort((left, right) => left.relativePath.localeCompare(
        right.relativePath,
        'zh-CN',
        { numeric: true }
      ))
    };
  }
  if (declared.length !== assets.length) {
    return {
      ok: false,
      reason: 'PARTIAL',
      message: '同一最新 E005 图片批次只能全部声明 sortOrder，或全部省略 sortOrder'
    };
  }
  if (assets.some((asset) => typeof asset.sortOrder !== 'number'
    || !Number.isInteger(asset.sortOrder)
    || asset.sortOrder < 0)) {
    return {
      ok: false,
      reason: 'INVALID',
      message: '同一最新 E005 图片批次的 sortOrder 必须是从 0 开始的非负整数'
    };
  }
  const orders = assets.map((asset) => Number(asset.sortOrder));
  if (new Set(orders).size !== orders.length) {
    return {
      ok: false,
      reason: 'DUPLICATE',
      message: '同一最新 E005 图片批次不能包含重复的 sortOrder'
    };
  }
  const sortedOrders = [...orders].sort((left, right) => left - right);
  if (sortedOrders.some((value, index) => value !== index)) {
    return {
      ok: false,
      reason: 'NON_CONTIGUOUS',
      message: '同一最新 E005 图片批次的 sortOrder 必须从 0 开始且连续'
    };
  }
  return {
    ok: true,
    mode: 'EXPLICIT',
    assets: [...assets].sort((left, right) => Number(left.sortOrder) - Number(right.sortOrder))
  };
}

/** Validate only the latest E005 image submission for each variant in an accumulated manifest. */
export function latestManifestImageOrderErrors<T extends {
  sourceStageId?: unknown;
  kind?: unknown;
  submissionId?: unknown;
  variantId?: unknown;
  variantColor?: unknown;
  relativePath?: unknown;
  deliveredAt?: unknown;
  sortOrder?: unknown;
}>(assets: T[]): ManifestMediaOrderError[] {
  const byVariant = new Map<string, T[]>();
  for (const asset of assets) {
    if (asset.sourceStageId !== 'E005' || asset.kind !== 'image') continue;
    const variantKey = manifestVariantKey(asset);
    byVariant.set(variantKey, [...(byVariant.get(variantKey) || []), asset]);
  }
  const errors: ManifestMediaOrderError[] = [];
  for (const [variantKey, variantAssets] of byVariant) {
    const bySubmission = new Map<string, T[]>();
    for (const asset of variantAssets) {
      const submissionId = String(asset.submissionId || '__legacy__');
      bySubmission.set(submissionId, [...(bySubmission.get(submissionId) || []), asset]);
    }
    const latest = [...bySubmission.entries()].sort((left, right) => (
      manifestBatchSortValue(right).localeCompare(manifestBatchSortValue(left))
    ))[0];
    if (!latest) continue;
    const ordering = resolveManifestMediaOrder(latest[1].map((asset) => ({
      relativePath: String(asset.relativePath || ''),
      sortOrder: asset.sortOrder
    })));
    if (!ordering.ok) {
      errors.push({
        variantKey,
        submissionId: latest[0],
        reason: ordering.reason,
        message: ordering.message
      });
    }
  }
  return errors;
}

function manifestVariantKey(asset: {
  variantId?: unknown;
  variantColor?: unknown;
  relativePath?: unknown;
}): string {
  const variantId = String(asset.variantId || '').trim();
  if (variantId) return `variant:${variantId}`;
  const color = asset.variantColor && typeof asset.variantColor === 'object' && !Array.isArray(asset.variantColor)
    ? asset.variantColor as Record<string, unknown>
    : {};
  const colorKey = String(color.colorKey || '').trim();
  if (colorKey) return `color:${colorKey}`;
  const segments = String(asset.relativePath || '').replaceAll('\\', '/').split('/').filter(Boolean);
  return `path:${segments[0] === 'variants' && segments[1] ? segments[1] : '__unknown__'}`;
}

function manifestBatchSortValue<T extends { deliveredAt?: unknown }>(entry: [string, T[]]): string {
  const deliveredAt = entry[1].map((asset) => String(asset.deliveredAt || '')).sort().at(-1) || '';
  return `${deliveredAt}\0${entry[0]}`;
}
