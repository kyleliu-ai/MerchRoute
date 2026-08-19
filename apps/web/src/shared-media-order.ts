export type SharedMediaOrderResult<T> =
  | { ok: true; mode: 'EXPLICIT' | 'LEGACY_PATH'; assets: T[] }
  | { ok: false; reason: 'PARTIAL' | 'INVALID' | 'DUPLICATE' | 'NON_CONTIGUOUS'; message: string };

/** Resolve one latest E005 image batch without guessing an incomplete order contract. */
export function resolveSharedMediaOrder<T extends { relativePath: string; sortOrder?: unknown }>(
  assets: readonly T[]
): SharedMediaOrderResult<T> {
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
  if (sortedOrders.some((order, index) => order !== index)) {
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
