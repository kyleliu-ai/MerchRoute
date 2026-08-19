import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { afterEach, describe, expect, it } from 'vitest';
import type { OzonMediaAsset } from '@n8n-media-review/shared';
import { OzonVideoPrewarmer, OZON_VIDEO_PROFILE_VERSION } from './video-optimization.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('OzonVideoPrewarmer', () => {
  it('uses a stable SHA/profile cache and does not change the original MP4', async () => {
    const rootDirectory = await mkdtemp(path.join(os.tmpdir(), 'ozon-prewarm-'));
    roots.push(rootDirectory);
    const productRoot = path.join(rootDirectory, 'inbox', '0000099');
    const sourcePath = path.join(productRoot, 'variants', 'main.mp4');
    await mkdir(path.dirname(sourcePath), { recursive: true });
    const source = Buffer.concat([Buffer.from([0, 0, 0, 20]), Buffer.from('ftypisom'), Buffer.alloc(256, 7)]);
    await writeFile(sourcePath, source);
    const sourceSha256 = createHash('sha256').update(source).digest('hex');
    const asset: OzonMediaAsset = {
      assetId: 'video-main',
      relativePath: 'variants/main.mp4',
      kind: 'video',
      mimeType: 'video/mp4',
      sizeBytes: source.length,
      sha256: sourceSha256,
      modifiedAt: new Date().toISOString(),
      validationStatus: 'VALID',
      durationSeconds: 10
    };
    let runs = 0;
    const prewarmer = new OzonVideoPrewarmer(async (_input, output) => {
      runs += 1;
      await writeFile(output, Buffer.concat([Buffer.from([0, 0, 0, 20]), Buffer.from('ftypisom'), Buffer.alloc(64, 3)]));
    });

    const cold = await prewarmer.prewarm({ rootDirectory, productRoot, assets: [asset], enabled: true });
    const warm = await prewarmer.prewarm({ rootDirectory, productRoot, assets: [asset], enabled: true });

    expect(runs).toBe(1);
    expect(cold[0]?.metadata).toMatchObject({ profileVersion: OZON_VIDEO_PROFILE_VERSION, cacheHit: false, sourceSha256 });
    expect(warm[0]?.metadata).toMatchObject({ profileVersion: OZON_VIDEO_PROFILE_VERSION, cacheHit: true, sourceSha256 });
    expect(await readFile(sourcePath)).toEqual(source);
    expect(cold[0]!.cachePath).toContain(path.join('.cache', 'ozon-video', OZON_VIDEO_PROFILE_VERSION));
  });

  it('never runs more than two video optimizations concurrently', async () => {
    const rootDirectory = await mkdtemp(path.join(os.tmpdir(), 'ozon-prewarm-concurrency-'));
    roots.push(rootDirectory);
    const productRoot = path.join(rootDirectory, 'inbox', '0000098');
    await mkdir(path.join(productRoot, 'variants'), { recursive: true });
    const assets: OzonMediaAsset[] = [];
    for (let index = 0; index < 4; index += 1) {
      const source = Buffer.concat([Buffer.from([0, 0, 0, 20]), Buffer.from('ftypisom'), Buffer.alloc(64, index + 1)]);
      const fileName = `video-${index}.mp4`;
      await writeFile(path.join(productRoot, 'variants', fileName), source);
      assets.push({
        assetId: `video-${index}`,
        relativePath: `variants/${fileName}`,
        kind: 'video',
        mimeType: 'video/mp4',
        sizeBytes: source.length,
        sha256: createHash('sha256').update(source).digest('hex'),
        modifiedAt: new Date().toISOString(),
        validationStatus: 'VALID',
        durationSeconds: 10
      });
    }
    let active = 0;
    let peak = 0;
    const prewarmer = new OzonVideoPrewarmer(async (_input, output) => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 20));
      await writeFile(output, Buffer.concat([Buffer.from([0, 0, 0, 20]), Buffer.from('ftypisom'), Buffer.alloc(32)]));
      active -= 1;
    });

    await prewarmer.prewarm({ rootDirectory, productRoot, assets, enabled: true });
    expect(peak).toBe(2);
  });
});
