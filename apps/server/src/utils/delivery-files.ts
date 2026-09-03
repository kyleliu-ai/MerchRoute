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
export async function copyVerified(source: string, destination: string, progress?: (bytes: number) => void): Promise<FileReceipt> {
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
  if (before.size !== bytes || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ino !== after.ino || sha256 !== await fileHash(destination)) {
    throw new AppError('FILE_CHANGED', '拷贝期间来源发生变化或复制校验失败');
  }
  return { relativePath: path.basename(destination), sizeBytes: bytes, sha256 };
}
export async function treeReceipts(root: string, flush = false): Promise<FileReceipt[]> {
  const files: FileReceipt[] = [];
  const walk = async (directory: string): Promise<void> => {
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const file = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new AppError('VERIFY_FAILED', '交付包中不允许符号链接');
      if (entry.isDirectory()) await walk(file);
      else if (entry.isFile()) {
        if (flush) await syncFile(file);
        files.push({ relativePath: path.relative(root, file).split(path.sep).join('/'), sizeBytes: (await lstat(file)).size, sha256: await fileHash(file) });
      } else throw new AppError('VERIFY_FAILED', '交付包包含不支持的文件类型');
    }
    if (flush) await syncDirectory(directory);
  };
  await walk(root);
  return files;
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
