import os from 'node:os';
import path from 'node:path';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { createDefaultConfig, type AppConfig } from '@n8n-media-review/shared';
import sharp from 'sharp';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ConfigService } from '../../config/service.js';
import { StateStore } from '../../repositories/store.js';
import { ScannerService } from '../scanner/index.js';
import { ThumbnailService } from './index.js';

describe('ThumbnailService indexed source validation', () => {
  let root: string;
  let config: AppConfig;
  let scanner: ScannerService;
  let thumbnails: ThumbnailService;

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'pixroute-thumbnail-index-'));
    config = createDefaultConfig('other');
    config.stages = config.stages.filter((stage) => stage.id === 'E006');
    config.stages[0]!.candidateRoot = path.join(root, 'candidates');
    const configService = {
      appDataDir: path.join(root, 'app-data'),
      get: () => structuredClone(config)
    } as unknown as ConfigService;
    const store = new StateStore(configService.appDataDir);
    await store.initialize();
    scanner = new ScannerService(configService, store);
    thumbnails = new ThumbnailService(configService, scanner);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('returns 404 and emits a reconcile hint when a cached source file was deleted', async () => {
    const folder = path.join(root, 'candidates', '01-product');
    const source = path.join(folder, 'image.png');
    await mkdir(folder, { recursive: true });
    await writeFile(source, 'test-image', 'utf8');
    const snapshot = await scanner.buildStageSnapshot('E006');
    scanner.hydrateStage(snapshot);
    const invalidations: unknown[] = [];
    scanner.onTaskInvalidated((event) => invalidations.push(event));
    await rm(source, { force: true });

    await expect(thumbnails.get(snapshot.tasks[0]!.taskId, 'image.png')).rejects.toMatchObject({
      code: 'SOURCE_FILE_MISSING',
      statusCode: 404
    });
    expect(invalidations).toEqual([expect.objectContaining({
      stageId: 'E006',
      relativeTaskDirectory: '01-product',
      reason: 'SOURCE_FILE_MISSING'
    })]);
  });

  it('single-flights concurrent thumbnail generation and leaves only the atomic final file', async () => {
    const folder = path.join(root, 'candidates', '02-concurrent');
    await mkdir(folder, { recursive: true });
    await sharp({ create: { width: 2, height: 2, channels: 3, background: '#ffffff' } })
      .png()
      .toFile(path.join(folder, 'image.png'));
    const snapshot = await scanner.buildStageSnapshot('E006');
    scanner.hydrateStage(snapshot);

    const [first, second] = await Promise.all([
      thumbnails.get(snapshot.tasks[0]!.taskId, 'image.png'),
      thumbnails.get(snapshot.tasks[0]!.taskId, 'image.png')
    ]);

    expect(first).toBe(second);
    expect((await readdir(thumbnails.directory)).filter((name) => name.endsWith('.webp'))).toHaveLength(1);
    await expect(thumbnails.clear()).resolves.toEqual({ removed: 1 });
    await expect(readdir(thumbnails.directory)).resolves.toEqual([]);
  });
});
