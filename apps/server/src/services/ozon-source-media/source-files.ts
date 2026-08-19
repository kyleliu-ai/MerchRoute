import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import { lstat, mkdir, readFile, realpath, readdir, rename, rm, rmdir, writeFile } from 'node:fs/promises';
import { AppError, type OzonSourceMediaCleanupArtifactKind } from '@n8n-media-review/shared';
import { withOzonSourceMediaFilesystemLock, withOzonSourceMediaSkuLock } from './sku-lock.js';

export type OzonFrozenMediaFile = {
  assetId?: string;
  relativePath: string;
  kind: 'IMAGE' | 'VIDEO';
  sizeBytes: number;
  sha256: string;
  productVariantId?: string;
  sourceStageId?: string;
  sourceSubmissionId?: string;
  deliveredAt?: string;
};

export type OzonSourceMediaFileSnapshot = {
  exists: boolean;
  sourceRelPath: string;
  absolutePath: string;
  fileCount: number;
  totalBytes: number;
  directorySignature: string;
  mediaIdentityHash: string;
  stagingEmpty: boolean;
  files: Array<{ relativePath: string; sizeBytes: number; sha256: string }>;
};

export type OzonQuarantineResult = {
  state: 'QUARANTINED' | 'SOURCE_ABSENT' | 'ALREADY_QUARANTINED';
  quarantineRelPath: string;
  snapshot?: OzonSourceMediaFileSnapshot;
};

export class OzonSourceMediaFiles {
  async snapshot(input: {
    rootDirectory: string;
    sourceRelPath: string;
    mediaIdentityHash: string;
    frozenMedia: OzonFrozenMediaFile[];
  }): Promise<OzonSourceMediaFileSnapshot> {
    const root = await safeRoot(input.rootDirectory);
    const absolutePath = resolveInside(root, input.sourceRelPath, 'OZON 媒体清理源目录');
    const info = await lstat(absolutePath).catch((error: NodeJS.ErrnoException) => error.code === 'ENOENT' ? undefined : Promise.reject(error));
    if (!info) return {
      exists: false,
      sourceRelPath: portable(input.sourceRelPath),
      absolutePath,
      fileCount: 0,
      totalBytes: 0,
      directorySignature: '',
      mediaIdentityHash: input.mediaIdentityHash,
      stagingEmpty: true,
      files: []
    };
    if (!info.isDirectory() || info.isSymbolicLink()) {
      throw blocked('OZON 媒体清理源不是安全的普通目录', { sourceRelPath: input.sourceRelPath });
    }
    const real = await realpath(absolutePath);
    assertInside(root, real, 'OZON 媒体清理源真实路径');
    const files: OzonSourceMediaFileSnapshot['files'] = [];
    let stagingEmpty = true;
    await walk(real, real, files, (relativePath, isDirectory) => {
      const parts = relativePath.split('/');
      const stagingIndex = parts.findIndex((part) => part === '.staging' || part.startsWith('.staging-'));
      const isEmptyStagingRoot = isDirectory && relativePath === '.staging';
      if (stagingIndex >= 0 && !isEmptyStagingRoot) stagingEmpty = false;
    });
    files.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
    const expected = new Map(input.frozenMedia.map((file) => [portable(file.relativePath), file]));
    if (expected.size !== input.frozenMedia.length || expected.size === 0) {
      throw blocked('OZON 稳定版本没有可证明的冻结媒体集合', { sourceRelPath: input.sourceRelPath });
    }
    const actual = new Map(files.map((file) => [file.relativePath, file]));
    const unexpectedMedia = files.filter((file) => isMediaPath(file.relativePath) && !expected.has(file.relativePath));
    if (unexpectedMedia.length) {
      throw blocked('OZON 媒体目录包含稳定版本之外的新媒体文件', {
        sourceRelPath: input.sourceRelPath,
        unexpectedMedia: unexpectedMedia.map((file) => file.relativePath)
      });
    }
    for (const [relativePath, frozen] of expected) {
      const file = actual.get(relativePath);
      const frozenSha = normalizeSha(frozen.sha256);
      if (!file || file.sizeBytes !== frozen.sizeBytes || normalizeSha(file.sha256) !== frozenSha) {
        throw blocked('OZON 媒体文件与稳定版本冻结身份不一致', {
          sourceRelPath: input.sourceRelPath,
          relativePath,
          expectedSize: frozen.sizeBytes,
          actualSize: file?.sizeBytes,
          expectedSha256: frozenSha,
          actualSha256: file?.sha256
        });
      }
      const extension = path.posix.extname(relativePath).toLocaleLowerCase('en-US');
      const kindMatches = frozen.kind === 'VIDEO'
        ? ['.mp4', '.mov', '.webm'].includes(extension)
        : ['.jpg', '.jpeg', '.png', '.webp'].includes(extension);
      if (!kindMatches) throw blocked('OZON 冻结媒体类型与文件扩展名不一致', { relativePath, kind: frozen.kind });
    }
    const directorySignature = `sha256:${createHash('sha256').update(JSON.stringify(files)).digest('hex')}`;
    return {
      exists: true,
      sourceRelPath: portable(input.sourceRelPath),
      absolutePath: real,
      fileCount: files.length,
      totalBytes: files.reduce((sum, file) => sum + file.sizeBytes, 0),
      directorySignature,
      mediaIdentityHash: input.mediaIdentityHash,
      stagingEmpty,
      files
    };
  }

  async quarantine(input: {
    rootDirectory: string;
    cleanupId: string;
    sku: string;
    kind: OzonSourceMediaCleanupArtifactKind;
    sourceRelPath: string;
    mediaIdentityHash: string;
    expectedDirectorySignature?: string;
    frozenMedia: OzonFrozenMediaFile[];
    expectedQuarantineRelPath?: string;
  }): Promise<OzonQuarantineResult> {
    return withOzonSourceMediaSkuLock(input.sku, async () => this.withFilesystemLock(input.rootDirectory, input.sku, async () => {
      const root = await safeRoot(input.rootDirectory);
      const quarantineRelPath = portable(input.expectedQuarantineRelPath
        || `.cleanup/${input.cleanupId}/${input.kind}`);
      const quarantinePath = resolveInside(root, quarantineRelPath, 'OZON 媒体隔离目录');
      const source = await this.snapshot({
        rootDirectory: root,
        sourceRelPath: input.sourceRelPath,
        mediaIdentityHash: input.mediaIdentityHash,
        frozenMedia: input.frozenMedia
      });
      const quarantinedInfo = await lstat(quarantinePath).catch((error: NodeJS.ErrnoException) => error.code === 'ENOENT' ? undefined : Promise.reject(error));
      if (source.exists && quarantinedInfo) {
        throw blocked('OZON 媒体源目录和隔离目录同时存在，禁止覆盖', { sourceRelPath: input.sourceRelPath, quarantineRelPath });
      }
      if (quarantinedInfo) {
        if (!quarantinedInfo.isDirectory() || quarantinedInfo.isSymbolicLink()) {
          throw blocked('OZON 媒体隔离目标不是安全目录', { quarantineRelPath });
        }
        try {
          await this.validateCredential(quarantinePath, input);
        } catch (error) {
          const markerInfo = await lstat(path.join(quarantinePath, '.ozon-source-cleanup.json')).catch(() => undefined);
          if (markerInfo) throw error;
          const recovered = await this.snapshot({
            rootDirectory: root,
            sourceRelPath: quarantineRelPath,
            mediaIdentityHash: input.mediaIdentityHash,
            frozenMedia: input.frozenMedia
          });
          if (!recovered.exists || !input.expectedDirectorySignature
            || recovered.directorySignature !== input.expectedDirectorySignature) throw error;
          await this.writeCredential(quarantinePath, input, recovered);
        }
        return { state: 'ALREADY_QUARANTINED', quarantineRelPath };
      }
      if (!source.exists) return { state: 'SOURCE_ABSENT', quarantineRelPath };
      if (!source.stagingEmpty) throw busy('OZON 媒体目录仍包含 staging，暂不清理', { sourceRelPath: input.sourceRelPath });
      if (input.expectedDirectorySignature && source.directorySignature !== input.expectedDirectorySignature) {
        throw blocked('OZON 媒体目录在隔离前发生变化', {
          sourceRelPath: input.sourceRelPath,
          expected: input.expectedDirectorySignature,
          actual: source.directorySignature
        });
      }
      await mkdir(path.dirname(quarantinePath), { recursive: true });
      await rename(source.absolutePath, quarantinePath);
      const isolated = await this.snapshot({
        rootDirectory: root,
        sourceRelPath: quarantineRelPath,
        mediaIdentityHash: input.mediaIdentityHash,
        frozenMedia: input.frozenMedia
      });
      if (!isolated.exists || isolated.directorySignature !== source.directorySignature
        || isolated.fileCount !== source.fileCount || isolated.totalBytes !== source.totalBytes) {
        throw blocked('OZON 媒体目录在隔离后验签失败', {
          sourceRelPath: input.sourceRelPath,
          quarantineRelPath,
          expectedDirectorySignature: source.directorySignature,
          actualDirectorySignature: isolated.directorySignature
        });
      }
      await this.writeCredential(quarantinePath, input, isolated);
      return { state: 'QUARANTINED', quarantineRelPath, snapshot: isolated };
    }));
  }

  async deleteQuarantine(input: {
    rootDirectory: string;
    cleanupId: string;
    sku: string;
    kind: OzonSourceMediaCleanupArtifactKind;
    sourceRelPath: string;
    quarantineRelPath: string;
    mediaIdentityHash: string;
    directorySignature: string;
  }): Promise<void> {
    await withOzonSourceMediaSkuLock(input.sku, async () => this.withFilesystemLock(input.rootDirectory, input.sku, async () => {
      const root = await safeRoot(input.rootDirectory);
      const quarantinePath = resolveInside(root, input.quarantineRelPath, 'OZON 媒体隔离删除目录');
      const sourcePath = resolveInside(root, input.sourceRelPath, 'OZON 媒体清理原目录');
      const sourceInfo = await lstat(sourcePath).catch((error: NodeJS.ErrnoException) => error.code === 'ENOENT' ? undefined : Promise.reject(error));
      const quarantineInfo = await lstat(quarantinePath).catch((error: NodeJS.ErrnoException) => error.code === 'ENOENT' ? undefined : Promise.reject(error));
      if (sourceInfo && quarantineInfo) throw blocked('OZON 媒体源目录和隔离目录同时存在，禁止删除', input);
      if (sourceInfo && !quarantineInfo) throw blocked('OZON 隔离目录消失但源目录仍存在，禁止推断已清理', input);
      if (!quarantineInfo) return;
      if (!quarantineInfo.isDirectory() || quarantineInfo.isSymbolicLink()) throw blocked('OZON 媒体隔离目录不安全', input);
      await this.validateCredential(quarantinePath, input);
      await rm(quarantinePath, { recursive: true, force: false });
      await rmdir(path.dirname(quarantinePath)).catch(() => undefined);
      if (input.kind === 'SHARED_VERSION') {
        const parent = path.dirname(sourcePath);
        const entries = await readdir(parent).catch(() => []);
        if (entries.length === 0) await rmdir(parent).catch(() => undefined);
      }
    }));
  }

  async quarantineExists(rootDirectory: string, quarantineRelPath: string): Promise<boolean> {
    const root = await safeRoot(rootDirectory);
    const target = resolveInside(root, quarantineRelPath, 'OZON 媒体隔离目录');
    const info = await lstat(target).catch(() => undefined);
    return Boolean(info?.isDirectory() && !info.isSymbolicLink());
  }

  private async validateCredential(directory: string, input: {
    cleanupId: string;
    sku: string;
    kind: OzonSourceMediaCleanupArtifactKind;
    sourceRelPath: string;
    mediaIdentityHash: string;
    directorySignature?: string;
  }): Promise<void> {
    let marker: Record<string, unknown>;
    try {
      marker = JSON.parse(await readFile(path.join(directory, '.ozon-source-cleanup.json'), 'utf8')) as Record<string, unknown>;
    } catch {
      throw blocked('OZON 媒体隔离目录缺少有效清理凭据', { directory });
    }
    if (Number(marker.schemaVersion) !== 1 || String(marker.cleanupId) !== input.cleanupId
      || String(marker.sku) !== input.sku || String(marker.kind) !== input.kind
      || String(marker.sourceRelPath) !== portable(input.sourceRelPath)
      || String(marker.mediaIdentityHash) !== input.mediaIdentityHash
      || (input.directorySignature && String(marker.directorySignature) !== input.directorySignature)) {
      throw blocked('OZON 媒体隔离凭据与清理批次不一致', { directory, cleanupId: input.cleanupId, kind: input.kind });
    }
  }

  private async writeCredential(
    directory: string,
    input: {
      cleanupId: string;
      sku: string;
      kind: OzonSourceMediaCleanupArtifactKind;
      sourceRelPath: string;
      mediaIdentityHash: string;
      expectedDirectorySignature?: string;
      expectedQuarantineRelPath?: string;
    },
    snapshot: OzonSourceMediaFileSnapshot
  ): Promise<void> {
    const quarantineRelPath = portable(input.expectedQuarantineRelPath || `.cleanup/${input.cleanupId}/${input.kind}`);
    await writeFile(path.join(directory, '.ozon-source-cleanup.json'), `${JSON.stringify({
      schemaVersion: 1,
      cleanupId: input.cleanupId,
      sku: input.sku,
      kind: input.kind,
      sourceRelPath: portable(input.sourceRelPath),
      quarantineRelPath,
      mediaIdentityHash: input.mediaIdentityHash,
      directorySignature: snapshot.directorySignature,
      fileCount: snapshot.fileCount,
      totalBytes: snapshot.totalBytes
    }, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
  }

  private async withFilesystemLock<T>(rootDirectory: string, sku: string, operation: () => Promise<T>): Promise<T> {
    return withOzonSourceMediaFilesystemLock(rootDirectory, sku, operation);
  }
}

async function walk(
  root: string,
  current: string,
  output: Array<{ relativePath: string; sizeBytes: number; sha256: string }>,
  onPath: (relativePath: string, isDirectory: boolean) => void
): Promise<void> {
  const entries = await readdir(current, { withFileTypes: true });
  for (const entry of entries) {
    const target = path.join(current, entry.name);
    const relativePath = portable(path.relative(root, target));
    const info = await lstat(target);
    if (info.isSymbolicLink()) throw blocked('OZON 媒体目录包含符号链接或 junction', { relativePath });
    onPath(relativePath, entry.isDirectory());
    if (entry.isDirectory()) await walk(root, target, output, onPath);
    else if (entry.isFile()) output.push({ relativePath, sizeBytes: info.size, sha256: await hashFile(target) });
    else throw blocked('OZON 媒体目录包含非普通文件', { relativePath });
  }
}

async function hashFile(file: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

async function safeRoot(rootDirectory: string): Promise<string> {
  const info = await lstat(rootDirectory).catch(() => undefined);
  if (!info?.isDirectory() || info.isSymbolicLink()) throw blocked('OZON 媒体根目录不存在或不安全', { rootDirectory });
  return realpath(rootDirectory);
}

function resolveInside(root: string, relativePath: string, label: string): string {
  const normalized = portable(relativePath);
  if (!normalized || path.posix.isAbsolute(normalized) || normalized.split('/').some((part) => !part || part === '.' || part === '..')) {
    throw new AppError('PATH_TRAVERSAL_BLOCKED', `${label}包含不安全路径`, { relativePath }, 403);
  }
  const target = path.resolve(root, ...normalized.split('/'));
  assertInside(root, target, label);
  return target;
}

function assertInside(root: string, target: string, label: string): void {
  const relative = path.relative(root, target);
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new AppError('PATH_TRAVERSAL_BLOCKED', `${label}超出 OZON 根目录`, { target }, 403);
  }
}

function portable(value: string): string { return String(value || '').replaceAll('\\', '/').replace(/^\.\//, ''); }
function normalizeSha(value: string): string { return String(value || '').replace(/^sha256:/, '').toLocaleLowerCase('en-US'); }
function isMediaPath(value: string): boolean {
  return ['.jpg', '.jpeg', '.png', '.webp', '.mp4', '.mov', '.webm'].includes(path.posix.extname(value).toLocaleLowerCase('en-US'));
}
function blocked(message: string, details: Record<string, unknown>): AppError {
  return new AppError('OZON_SOURCE_MEDIA_CLEANUP_BLOCKED', message, details, 409);
}
function busy(message: string, details: Record<string, unknown>): AppError {
  return new AppError('OZON_SOURCE_MEDIA_BUSY', message, details, 409);
}
