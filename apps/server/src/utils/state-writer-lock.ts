import { createHash } from 'node:crypto';
import { createServer } from 'node:net';
import { mkdir, realpath } from 'node:fs/promises';
import { AppError } from '@n8n-media-review/shared';

// A kernel-held loopback reservation is released on process death on Windows and
// macOS. No expiry or stale lock-file deletion can admit a second live writer.
export async function acquireStateWriterLock(directory: string): Promise<() => Promise<void>> {
  await mkdir(directory, { recursive: true });
  const resolved = await realpath(directory);
  const identity = process.platform === 'win32' ? resolved.toLocaleLowerCase('en-US') : resolved;
  const port = 49152 + createHash('sha256').update(identity).digest().readUInt16BE(0) % 16384;
  const server = createServer((socket) => socket.destroy());
  await new Promise<void>((resolve, reject) => {
    server.once('error', () => reject(new AppError('STATE_WRITER_BUSY', '审核数据目录的独占写入锁被占用；请确认其他实例已退出', { port }, 503)));
    server.listen({ host: '127.0.0.1', port, exclusive: true }, () => { server.unref(); resolve(); });
  });
  return () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}
