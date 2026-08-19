import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { lstat, mkdir, open, readFile, realpath, rename, unlink } from 'node:fs/promises';
import { AppError } from '@n8n-media-review/shared';

const skuLocks = new Map<string, Promise<void>>();

export async function withOzonSourceMediaSkuLock<T>(sku: string, operation: () => Promise<T>): Promise<T> {
  if (!/^\d{7}$/.test(sku)) throw new Error('OZON 来源媒体锁只接受 7 位 SKU');
  const key = `OZON:${sku}`;
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

export async function withOzonSourceMediaFilesystemLock<T>(
  rootDirectory: string,
  sku: string,
  operation: () => Promise<T>
): Promise<T> {
  if (!/^\d{7}$/.test(sku)) throw new Error('OZON 来源媒体锁只接受 7 位 SKU');
  const rootInfo = await lstat(rootDirectory).catch(() => undefined);
  if (!rootInfo?.isDirectory() || rootInfo.isSymbolicLink()) throw blocked('OZON 媒体根目录不存在或不安全', { rootDirectory });
  const root = await realpath(rootDirectory);
  const lockDirectory = path.join(root, '.locks');
  await mkdir(lockDirectory, { recursive: true });
  const lockPath = path.join(lockDirectory, `ozon-source-media-cleanup-${sku}.lock`);
  const handle = await acquireFilesystemLock(lockPath, sku);
  try {
    return await operation();
  } finally {
    await handle.close().catch(() => undefined);
    await unlink(lockPath).catch(() => undefined);
  }
}

async function acquireFilesystemLock(lockPath: string, sku: string) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = await open(lockPath, 'wx');
      await handle.writeFile(`${JSON.stringify({ pid: process.pid, sku, createdAt: new Date().toISOString() })}\n`);
      return handle;
    } catch (error: any) {
      if (error?.code !== 'EEXIST') throw error;
      if (attempt > 0 || !await reclaimStaleFilesystemLock(lockPath)) {
        throw new AppError('OZON_SOURCE_MEDIA_BUSY', 'OZON 同 SKU 媒体正在被其他进程处理', { sku }, 409);
      }
    }
  }
  throw new AppError('OZON_SOURCE_MEDIA_BUSY', 'OZON 同 SKU 媒体正在被其他进程处理', { sku }, 409);
}

async function reclaimStaleFilesystemLock(lockPath: string): Promise<boolean> {
  const info = await lstat(lockPath).catch((error: NodeJS.ErrnoException) => error.code === 'ENOENT' ? undefined : Promise.reject(error));
  if (!info) return true;
  if (!info.isFile() || info.isSymbolicLink()) throw blocked('OZON 媒体清理锁不是安全的普通文件', { lockPath });
  if (Date.now() - info.mtimeMs < 15 * 60_000) return false;
  let pid = 0;
  try {
    const parsed = JSON.parse(await readFile(lockPath, 'utf8')) as Record<string, unknown>;
    pid = Number(parsed.pid || 0);
  } catch {
    pid = 0;
  }
  if (pid > 0 && processIsAlive(pid)) return false;
  const stalePath = `${lockPath}.stale-${process.pid}-${randomUUID()}`;
  try {
    await rename(lockPath, stalePath);
  } catch (error: any) {
    if (error?.code === 'ENOENT') return true;
    return false;
  }
  await unlink(stalePath).catch(() => undefined);
  return true;
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: any) {
    return error?.code === 'EPERM';
  }
}

function blocked(message: string, details: Record<string, unknown>): AppError {
  return new AppError('OZON_SOURCE_MEDIA_CLEANUP_BLOCKED', message, details, 409);
}
