const skuLocks = new Map<string, Promise<void>>();

export async function withWbSourceMediaSkuLock<T>(sku: string, operation: () => Promise<T>): Promise<T> {
  if (!/^\d{7}$/.test(sku)) throw new Error('WB 来源媒体锁只接受 7 位 SKU');
  const key = `WB:${sku}`;
  const previous = skuLocks.get(key) || Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => { release = resolve; });
  const chain = previous.catch(() => undefined).then(() => current);
  skuLocks.set(key, chain);
  await previous.catch(() => undefined);
  try {
    return await operation();
  } finally {
    release();
    if (skuLocks.get(key) === chain) skuLocks.delete(key);
  }
}
