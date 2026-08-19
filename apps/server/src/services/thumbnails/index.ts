import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, stat, readdir, rename, rm } from 'node:fs/promises';
import sharp from 'sharp';
import { AppError } from '@n8n-media-review/shared';
import type { ConfigService } from '../../config/service.js';
import type { ScannerService } from '../scanner/index.js';

export class ThumbnailService {
  readonly directory: string;
  private readonly generationFlights = new Map<string, Promise<string>>();
  private clearFlight?: Promise<{ removed: number }>;
  constructor(private readonly config: ConfigService, private readonly scanner: ScannerService) {
    this.directory = path.join(config.appDataDir, 'thumbnails');
  }

  async get(taskId: string, relativePath: string): Promise<string> {
    if (this.clearFlight) await this.clearFlight;
    const resolved = await this.scanner.resolveIndexedMedia(taskId, relativePath);
    const source = resolved.absolutePath;
    const hash = createHash('sha256').update(`${source}${resolved.image.sizeBytes}${resolved.image.lastModifiedAt}`).digest('hex');
    const destination = path.join(this.directory, `${hash}.webp`);
    if (await thumbnailExists(destination)) return destination;
    const active = this.generationFlights.get(destination);
    if (active) return active;
    const operation = (async () => {
      await mkdir(this.directory, { recursive: true });
      if (await thumbnailExists(destination)) return destination;
      const options = this.config.get().thumbnail;
      const temporary = path.join(this.directory, `.${hash}.${randomUUID()}.tmp.webp`);
      try {
        await sharp(source)
          .rotate()
          .resize({ width: options.maxWidth, height: options.maxHeight, fit: 'inside', withoutEnlargement: true })
          .webp({ quality: options.quality })
          .toFile(temporary);
        await this.scanner.resolveIndexedMedia(taskId, relativePath);
        try {
          await rename(temporary, destination);
        } catch (error: any) {
          if (!['EEXIST', 'EPERM', 'EACCES'].includes(error?.code) || !await thumbnailExists(destination)) throw error;
        }
      } catch (error: any) {
        if (error instanceof AppError) throw error;
        await this.scanner.resolveIndexedMedia(taskId, relativePath);
        throw error;
      } finally {
        await rm(temporary, { force: true }).catch(() => undefined);
      }
      return destination;
    })();
    this.generationFlights.set(destination, operation);
    try {
      return await operation;
    } finally {
      if (this.generationFlights.get(destination) === operation) this.generationFlights.delete(destination);
    }
  }

  async stats(): Promise<{ count: number; bytes: number }> {
    await mkdir(this.directory, { recursive: true });
    const entries = await readdir(this.directory, { withFileTypes: true });
    let bytes = 0;
    let count = 0;
    for (const entry of entries.filter((item) => item.isFile() && item.name.endsWith('.webp'))) {
      bytes += (await stat(path.join(this.directory, entry.name))).size;
      count += 1;
    }
    return { count, bytes };
  }

  async clear(): Promise<{ removed: number }> {
    if (this.clearFlight) return this.clearFlight;
    const operation = (async () => {
      await Promise.allSettled([...this.generationFlights.values()]);
      await mkdir(this.directory, { recursive: true });
      const entries = await readdir(this.directory, { withFileTypes: true });
      const files = entries.filter((item) => item.isFile() && item.name.endsWith('.webp'));
      await Promise.all(files.map((item) => rm(path.join(this.directory, item.name), { force: true })));
      return { removed: files.length };
    })();
    this.clearFlight = operation;
    try {
      return await operation;
    } finally {
      if (this.clearFlight === operation) this.clearFlight = undefined;
    }
  }
}

async function thumbnailExists(file: string): Promise<boolean> {
  const info = await lstat(file).catch(() => null);
  if (!info) return false;
  if (info.isSymbolicLink()) throw new AppError('PATH_TRAVERSAL_BLOCKED', '缩略图缓存文件不能是符号链接', { file });
  return info.isFile();
}
