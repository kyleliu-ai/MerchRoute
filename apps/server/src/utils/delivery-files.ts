import path from 'node:path';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, open, readdir, lstat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import pLimit from 'p-limit';
import { AppError } from '@n8n-media-review/shared';

// Shared by all batches and both terminal platforms in this process.
export const deliveryIoLimit = pLimit(2);
// Bound independent file work across deliveries so small-file batches can
// overlap fsync/readback without flooding the disk or real-time scanner.
export const deliveryFileIoLimit = pLimit(2);
export type FileReceipt = { relativePath: string; sizeBytes: number; sha256: string };

export async function fileHash(file: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}
export async function syncFile(file: string): Promise<void> {
  const handle = await open(file, 'r+');
  try { await handle.sync(); } finally { await handle.close(); }
}
export async function syncDirectory(directory: string): Promise<void> {
  // Windows does not expose directory fsync through Node; file flush plus
  // atomic same-volume rename is used there. POSIX directory errors propagate.
  if (process.platform === 'win32') return;
  const handle = await open(directory, 'r');
  try { await handle.sync(); } finally { await handle.close(); }
}
export async function syncTreeDirectories(root: string): Promise<void> {
  const walk = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) throw new AppError('VERIFY_FAILED', '交付包中不允许符号链接');
      if (entry.isDirectory()) await walk(path.join(directory, entry.name));
    }
    await syncDirectory(directory);
  };
  await walk(root);
}
export type CopyVerifiedOptions = { deferDestinationReadback?: boolean };
export async function copyVerified(source: string, destination: string, progress?: (bytes: number) => void, options: CopyVerifiedOptions = {}): Promise<FileReceipt> {
  const before = await lstat(source);
  if (!before.isFile() || before.isSymbolicLink() || before.size <= 0) throw new AppError('SOURCE_FILE_MISSING', '来源必须是非空普通文件');
  await mkdir(path.dirname(destination), { recursive: true });
  const hash = createHash('sha256');
  let bytes = 0;
  const meter = new Transform({ transform(chunk, _encoding, callback) { bytes += chunk.length; hash.update(chunk); progress?.(chunk.length); callback(null, chunk); } });
  await pipeline(createReadStream(source), meter, createWriteStream(destination, { flags: 'wx' }));
  await syncFile(destination);
  const after = await lstat(source);
  const sha256 = hash.digest('hex');
  if (before.size !== bytes || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ino !== after.ino
    || (!options.deferDestinationReadback && sha256 !== await fileHash(destination))) {
    throw new AppError('FILE_CHANGED', '拷贝期间来源发生变化或复制校验失败');
  }
  return { relativePath: path.basename(destination), sizeBytes: bytes, sha256 };
}
export async function treeReceipts(root: string, flush = false): Promise<FileReceipt[]> {
  const walk = async (directory: string): Promise<FileReceipt[]> => {
    const results = await settleAll((await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name)).map(async (entry) => {
      const file = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new AppError('VERIFY_FAILED', '交付包中不允许符号链接');
      if (entry.isDirectory()) return walk(file);
      if (!entry.isFile()) throw new AppError('VERIFY_FAILED', '交付包包含不支持的文件类型');
      return deliveryFileIoLimit(async () => {
        if (flush) await syncFile(file);
        return [{ relativePath: path.relative(root, file).split(path.sep).join('/'), sizeBytes: (await lstat(file)).size, sha256: await fileHash(file) }];
      });
    }));
    if (flush) await syncDirectory(directory);
    return results.flat();
  };
  return walk(root);
}
export async function verifyTree(root: string, expected: FileReceipt[]): Promise<boolean> {
  try { return JSON.stringify(await treeReceipts(root)) === JSON.stringify(expected); }
  catch (error: any) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}


const namespaceTails = new Map<string, Promise<unknown>>();
export async function withDeliveryNamespace<T>(namespace: string, action: () => Promise<T>): Promise<T> {
  const key = process.platform === 'win32' ? namespace.toLocaleLowerCase('en-US') : namespace;
  const previous = namespaceTails.get(key) || Promise.resolve();
  const run = previous.catch(() => undefined).then(action);
  namespaceTails.set(key, run);
  try { return await run; } finally { if (namespaceTails.get(key) === run) namespaceTails.delete(key); }
}

async function settleAll<T>(promises: Promise<T>[]): Promise<T[]> {
  const results = await Promise.allSettled(promises);
  const failure = results.find((result): result is PromiseRejectedResult => result.status === 'rejected');
  if (failure) throw failure.reason;
  return results.map((result) => (result as PromiseFulfilledResult<T>).value);
}
