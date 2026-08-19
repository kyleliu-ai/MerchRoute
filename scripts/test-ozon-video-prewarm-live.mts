import { createHash } from 'node:crypto';
import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import type { OzonMediaAsset } from '@n8n-media-review/shared';
import { OzonVideoPrewarmer } from '../apps/server/src/services/ozon-publishing/video-optimization.ts';

const rootDirectory = path.resolve(String(process.argv[2] || ''));
const productRoot = path.resolve(String(process.argv[3] || ''));
if (!path.isAbsolute(rootDirectory) || !path.isAbsolute(productRoot)) {
  throw new Error('用法: tsx scripts/test-ozon-video-prewarm-live.mts <rootDirectory> <productRoot>');
}

const variantsDirectory = path.join(productRoot, 'variants');
const fileNames = (await readdir(variantsDirectory))
  .filter((fileName) => fileName.toLowerCase().endsWith('.mp4'))
  .sort();
if (fileNames.length !== 2) throw new Error(`测试夹具必须恰好包含 2 个 MP4，实际 ${fileNames.length}`);

const assets: OzonMediaAsset[] = await Promise.all(fileNames.map(async (fileName, index) => {
  const filePath = path.join(variantsDirectory, fileName);
  const content = await readFile(filePath);
  const info = await stat(filePath);
  return {
    assetId: `live-video-${index + 1}`,
    relativePath: `variants/${fileName}`,
    kind: 'video',
    mimeType: 'video/mp4',
    sizeBytes: info.size,
    sha256: createHash('sha256').update(content).digest('hex'),
    modifiedAt: info.mtime.toISOString(),
    validationStatus: 'VALID'
  };
}));

const prewarmer = new OzonVideoPrewarmer();
const coldStartedAt = Date.now();
const cold = await prewarmer.prewarm({ rootDirectory, productRoot, assets, enabled: true });
const coldDurationMs = Date.now() - coldStartedAt;
const warmStartedAt = Date.now();
const warm = await prewarmer.prewarm({ rootDirectory, productRoot, assets, enabled: true });
const warmDurationMs = Date.now() - warmStartedAt;

if (cold.length !== 2 || warm.length !== 2) throw new Error('预压缩结果数量不完整');
if (cold.some((result) => result.metadata.outputSizeBytes <= 0)) throw new Error('预压缩输出为空');
if (warm.some((result) => !result.metadata.cacheHit)) throw new Error('第二轮未全部命中缓存');

console.log(JSON.stringify({
  ok: true,
  videos: 2,
  profileVersion: cold[0]?.metadata.profileVersion,
  coldDurationMs,
  warmDurationMs,
  cold: cold.map((result) => ({
    sourceSizeBytes: result.metadata.sourceSizeBytes,
    outputSizeBytes: result.metadata.outputSizeBytes,
    compressionRatio: result.metadata.compressionRatio,
    cacheHit: result.metadata.cacheHit
  })),
  warmCacheHits: warm.filter((result) => result.metadata.cacheHit).length
}, null, 2));
