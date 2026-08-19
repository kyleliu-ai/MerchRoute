import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { lstat, mkdir, readFile, realpath, rename, rm, stat } from 'node:fs/promises';
import pLimit from 'p-limit';
import writeFileAtomic from 'write-file-atomic';
import type { OzonMediaAsset, OzonMediaOptimization } from '@n8n-media-review/shared';
import { isPathInside } from '../../utils/paths.js';

export const OZON_VIDEO_PROFILE_VERSION = 'wb-h264-aac-v1';

type CacheMetadata = OzonMediaOptimization & {
  sourceRelativePath: string;
  createdAt: string;
};

type FfmpegRunner = (inputPath: string, outputPath: string) => Promise<void>;

export type OzonVideoPrewarmResult = {
  assetId: string;
  sourcePath: string;
  cachePath: string;
  metadata: OzonMediaOptimization;
};

export class OzonVideoPrewarmer {
  private readonly limit = pLimit(2);
  private readonly inFlight = new Map<string, Promise<OzonVideoPrewarmResult>>();

  constructor(
    private readonly runFfmpeg: FfmpegRunner = runOzonFfmpeg
  ) {}

  async prewarm(input: {
    rootDirectory: string;
    productRoot: string;
    assets: OzonMediaAsset[];
    enabled: boolean;
  }): Promise<OzonVideoPrewarmResult[]> {
    if (!input.enabled) return [];
    const videos = input.assets.filter((asset) =>
      asset.kind === 'video'
      && asset.mimeType === 'video/mp4'
      && asset.validationStatus === 'VALID'
    );
    return Promise.all(videos.map((asset) => this.schedule(input.rootDirectory, input.productRoot, asset)));
  }

  private schedule(rootDirectory: string, productRoot: string, asset: OzonMediaAsset): Promise<OzonVideoPrewarmResult> {
    const key = `${asset.sha256}:${OZON_VIDEO_PROFILE_VERSION}`;
    const existing = this.inFlight.get(key);
    if (existing) return existing;
    const operation = this.limit(() => this.optimize(rootDirectory, productRoot, asset));
    this.inFlight.set(key, operation);
    void operation.finally(() => {
      if (this.inFlight.get(key) === operation) this.inFlight.delete(key);
    }).catch(() => undefined);
    return operation;
  }

  private async optimize(rootDirectory: string, productRoot: string, asset: OzonMediaAsset): Promise<OzonVideoPrewarmResult> {
    const startedAt = Date.now();
    const rootReal = await realpath(rootDirectory);
    const productReal = await realpath(productRoot);
    if (!isPathInside(rootReal, productReal)) throw new Error('OZON 商品媒体目录逃逸任务根目录');
    const sourcePath = path.resolve(productReal, ...asset.relativePath.split('/'));
    const sourceInfo = await lstat(sourcePath);
    if (!sourceInfo.isFile() || sourceInfo.isSymbolicLink()) throw new Error(`OZON 视频不是普通文件: ${asset.relativePath}`);
    const sourceReal = await realpath(sourcePath);
    if (!isPathInside(productReal, sourceReal)) throw new Error(`OZON 视频路径逃逸商品目录: ${asset.relativePath}`);
    const sourceSha256 = await sha256File(sourceReal);
    if (sourceSha256 !== asset.sha256) throw new Error(`OZON 视频 SHA-256 已变化: ${asset.relativePath}`);

    const cacheDirectory = path.join(rootReal, '.cache', 'ozon-video', OZON_VIDEO_PROFILE_VERSION);
    await mkdir(cacheDirectory, { recursive: true });
    const cacheReal = await realpath(cacheDirectory);
    if (!isPathInside(rootReal, cacheReal)) throw new Error('OZON 视频缓存目录逃逸任务根目录');
    const cachePath = path.join(cacheReal, `${sourceSha256}.mp4`);
    const metadataPath = `${cachePath}.json`;
    const cached = await readValidCache(cachePath, metadataPath, sourceSha256);
    if (cached) {
      return {
        assetId: asset.assetId,
        sourcePath: sourceReal,
        cachePath,
        metadata: { ...cached, cacheHit: true, durationMs: Date.now() - startedAt }
      };
    }

    const tempPath = path.join(cacheReal, `.${sourceSha256}.${process.pid}.${randomUUID()}.tmp.mp4`);
    try {
      await this.runFfmpeg(sourceReal, tempPath);
      const outputInfo = await stat(tempPath);
      if (!outputInfo.isFile() || outputInfo.size < 12) throw new Error('FFmpeg 未生成有效的 OZON MP4 缓存');
      const header = await readHeader(tempPath, 12);
      if (header.subarray(4, 8).toString('ascii') !== 'ftyp') throw new Error('FFmpeg 输出不是有效 MP4');
      const outputSha256 = await sha256File(tempPath);
      const sourceSizeBytes = sourceInfo.size;
      const outputSizeBytes = outputInfo.size;
      const relativeCachePath = path.relative(rootReal, cachePath).split(path.sep).join('/');
      const metadata: CacheMetadata = {
        profileVersion: OZON_VIDEO_PROFILE_VERSION,
        sourceSha256,
        outputSha256,
        sourceSizeBytes,
        outputSizeBytes,
        compressionRatio: Number((outputSizeBytes / sourceSizeBytes).toFixed(6)),
        cacheHit: false,
        durationMs: Date.now() - startedAt,
        relativeCachePath,
        sourceRelativePath: asset.relativePath,
        createdAt: new Date().toISOString()
      };
      await rm(cachePath, { force: true });
      await rename(tempPath, cachePath);
      await writeFileAtomic(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`, { encoding: 'utf8' });
      return { assetId: asset.assetId, sourcePath: sourceReal, cachePath, metadata };
    } finally {
      await rm(tempPath, { force: true }).catch(() => undefined);
    }
  }
}

export function ozonVideoCachePath(rootDirectory: string, sourceSha256: string): string {
  return path.join(
    path.resolve(rootDirectory),
    '.cache',
    'ozon-video',
    OZON_VIDEO_PROFILE_VERSION,
    `${sourceSha256}.mp4`
  );
}

async function runOzonFfmpeg(inputPath: string, outputPath: string): Promise<void> {
  const executable = String(process.env.FFMPEG_PATH || 'ffmpeg').trim() || 'ffmpeg';
  const args = [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-i', inputPath,
    '-map_metadata', '-1',
    '-c:v', 'libx264',
    '-preset', 'medium',
    '-b:v', '1500k',
    '-maxrate', '1800k',
    '-bufsize', '3600k',
    '-profile:v', 'high',
    '-pix_fmt', 'yuv420p',
    '-r', '25',
    '-c:a', 'aac',
    '-b:a', '96k',
    '-ar', '44100',
    '-ac', '2',
    '-movflags', '+faststart',
    outputPath
  ];
  await new Promise<void>((resolve, reject) => {
    const child = spawn(executable, args, { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      stderr = `${stderr}${chunk}`.slice(-4_000);
    });
    child.once('error', reject);
    child.once('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`FFmpeg OZON 视频预压缩失败 (${code ?? 'unknown'}): ${stderr.trim()}`));
    });
  });
}

async function readValidCache(
  cachePath: string,
  metadataPath: string,
  expectedSourceSha256: string
): Promise<CacheMetadata | undefined> {
  try {
    const [cacheInfo, metadataRaw] = await Promise.all([stat(cachePath), readFile(metadataPath, 'utf8')]);
    if (!cacheInfo.isFile() || cacheInfo.size < 12) return undefined;
    const metadata = JSON.parse(metadataRaw) as CacheMetadata;
    if (
      metadata.profileVersion !== OZON_VIDEO_PROFILE_VERSION
      || metadata.sourceSha256 !== expectedSourceSha256
      || metadata.outputSizeBytes !== cacheInfo.size
      || metadata.outputSha256 !== await sha256File(cachePath)
    ) return undefined;
    const header = await readHeader(cachePath, 12);
    return header.subarray(4, 8).toString('ascii') === 'ftyp' ? metadata : undefined;
  } catch {
    return undefined;
  }
}

async function sha256File(filePath: string): Promise<string> {
  const content = await readFile(filePath);
  return createHash('sha256').update(content).digest('hex');
}

async function readHeader(filePath: string, length: number): Promise<Buffer> {
  const content = await readFile(filePath);
  return content.subarray(0, length);
}
