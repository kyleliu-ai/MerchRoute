import path from 'node:path';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, mkdir, readFile, readdir, realpath, rename, rm } from 'node:fs/promises';
import writeFileAtomic from 'write-file-atomic';
import { AppError } from '@n8n-media-review/shared';
import { isPathInside } from '../../utils/paths.js';
import { withWbSourceMediaSkuLock } from './sku-lock.js';

const CLEANUP_MARKER = '.wb-source-cleanup.json';

export type WbSourceMediaFileSnapshot = {
  exists: boolean;
  sku: string;
  productRoot: string;
  mediaSignature?: string;
  manifestSha256?: string;
  lastDeliveredAt?: string;
  fileCount: number;
  totalBytes: number;
  stagingEmpty: boolean;
  files: Array<{ relativePath: string; sizeBytes: number; sha256: string }>;
};

export type WbSourceMediaCleanupCredential = {
  schemaVersion: 1;
  cleanupId: string;
  sku: string;
  batchKey: string;
  rowVersion: number;
  mediaSignature: string;
  sourceProductRelPath: string;
  quarantineRelPath: string;
  preparedAt: string;
};

export type WbSourceMediaQuarantineResult = {
  state: 'QUARANTINED' | 'ALREADY_QUARANTINED' | 'SOURCE_ABSENT';
  quarantineRelPath: string;
};

export class WbSourceMediaFiles {
  constructor(private readonly operations: {
    rename: typeof rename;
    rm: typeof rm;
  } = { rename, rm }) {}

  async snapshot(rootDirectory: string, sku: string): Promise<WbSourceMediaFileSnapshot> {
    assertSku(sku);
    const root = await assertRealRoot(rootDirectory);
    const productRoot = path.join(rootDirectory, 'inbox', sku);
    assertInside(rootDirectory, productRoot, 'WB 来源媒体 SKU 目录');
    const info = await safeLstat(productRoot);
    if (!info) return { exists: false, sku, productRoot, fileCount: 0, totalBytes: 0, stagingEmpty: true, files: [] };
    await assertRealDirectory(root, productRoot, 'WB 来源媒体 SKU 目录');
    return this.snapshotDirectory(productRoot, sku, root);
  }

  async snapshotDirectory(productRoot: string, sku: string, allowedRoot?: string): Promise<WbSourceMediaFileSnapshot> {
    assertSku(sku);
    const info = await safeLstat(productRoot);
    if (!info) return { exists: false, sku, productRoot, fileCount: 0, totalBytes: 0, stagingEmpty: true, files: [] };
    const rootReal = allowedRoot || await realpath(path.dirname(productRoot));
    await assertRealDirectory(rootReal, productRoot, 'WB 媒体包目录');
    await assertTreeHasNoLinks(productRoot);
    const stagingRoot = path.join(productRoot, '.staging');
    const stagingEmpty = await directoryEmpty(stagingRoot);
    const variantsRoot = path.join(productRoot, 'variants');
    const variantsInfo = await safeLstat(variantsRoot);
    if (!variantsInfo) throw sourceChanged('WB 来源媒体目录缺少 variants', { sku, variantsRoot });
    await assertRealDirectory(rootReal, variantsRoot, 'WB 来源媒体 variants 目录');
    const files: string[] = [];
    await walkFiles(variantsRoot, files);
    const rows: WbSourceMediaFileSnapshot['files'] = [];
    for (const file of files.sort(comparePortable)) {
      const relativePath = path.relative(productRoot, file).replaceAll('\\', '/');
      const before = await lstat(file);
      if (before.isSymbolicLink() || !before.isFile()) throw unsafePath('WB 来源媒体只允许真实文件', { file });
      const sha256 = `sha256:${await hashFile(file)}`;
      const after = await lstat(file);
      if (before.size !== after.size || before.mtimeMs !== after.mtimeMs) throw sourceChanged('WB 来源媒体仍在写入', { file });
      rows.push({ relativePath, sizeBytes: after.size, sha256 });
    }
    const manifestRow = rows.find((row) => row.relativePath === 'variants/variant-media-manifest.json');
    if (!manifestRow) throw sourceChanged('WB 来源媒体目录缺少 variant-media-manifest.json', { sku });
    const manifestFile = path.join(productRoot, ...manifestRow.relativePath.split('/'));
    const manifest = parseManifest(await readFile(manifestFile, 'utf8'), sku);
    validateManifestFiles(manifest, rows);
    const canonical = {
      schemaVersion: 1,
      sku,
      manifest: manifest.assets.map((asset) => ({
        relativePath: String(asset.relativePath).replaceAll('\\', '/'),
        sizeBytes: Number(asset.sizeBytes),
        sha256: String(asset.sha256),
        kind: String(asset.kind),
        submissionId: String(asset.submissionId || ''),
        sortOrder: Number.isInteger(asset.sortOrder) ? Number(asset.sortOrder) : null,
        deliveredAt: String(asset.deliveredAt || '')
      })),
      files: rows
    };
    const lastDeliveredAt = manifest.assets.map((asset) => String(asset.deliveredAt || ''))
      .filter((value) => Number.isFinite(Date.parse(value))).sort().at(-1);
    return {
      exists: true,
      sku,
      productRoot,
      mediaSignature: `sha256:${createHash('sha256').update(stableJson(canonical)).digest('hex')}`,
      manifestSha256: manifestRow.sha256,
      ...(lastDeliveredAt ? { lastDeliveredAt } : {}),
      fileCount: rows.length,
      totalBytes: rows.reduce((sum, row) => sum + row.sizeBytes, 0),
      stagingEmpty,
      files: rows
    };
  }

  async quarantine(input: {
    rootDirectory: string;
    cleanupId: string;
    sku: string;
    batchKey: string;
    rowVersion: number;
    mediaSignature: string;
    expectedQuarantineRelPath?: string;
  }): Promise<WbSourceMediaQuarantineResult> {
    return withWbSourceMediaSkuLock(input.sku, async () => {
      const snapshot = await this.snapshot(input.rootDirectory, input.sku);
      const quarantineRelPath = input.expectedQuarantineRelPath || `.cleanup/${input.cleanupId}-${input.sku}`;
      const { quarantineRoot, quarantinePath } = await resolveQuarantinePath(input.rootDirectory, quarantineRelPath, input.cleanupId, input.sku);
      const existingQuarantine = await safeLstat(quarantinePath);
      if (existingQuarantine) {
        await assertRealDirectory(await realpath(quarantineRoot), quarantinePath, 'WB 来源媒体隔离目录');
        await assertCredential(quarantinePath, input, quarantineRelPath, false);
        if (snapshot.exists) throw sourceChanged('WB 来源目录与隔离目录同时存在，拒绝覆盖', { sku: input.sku, quarantineRelPath });
        return { state: 'ALREADY_QUARANTINED', quarantineRelPath };
      }
      if (!snapshot.exists) return { state: 'SOURCE_ABSENT', quarantineRelPath };
      if (!snapshot.stagingEmpty) throw sourceChanged('WB 来源媒体 .staging 非空，暂不清理', { sku: input.sku });
      if (snapshot.mediaSignature !== input.mediaSignature) {
        throw sourceChanged('WB 来源媒体已在批次冻结后变化，旧清理候选已失效', {
          sku: input.sku,
          expected: input.mediaSignature,
          actual: snapshot.mediaSignature
        });
      }
      await mkdir(quarantineRoot, { recursive: true });
      await assertRealDirectory(await assertRealRoot(input.rootDirectory), quarantineRoot, 'WB 来源媒体清理隔离根目录');
      const credential: WbSourceMediaCleanupCredential = {
        schemaVersion: 1,
        cleanupId: input.cleanupId,
        sku: input.sku,
        batchKey: input.batchKey,
        rowVersion: input.rowVersion,
        mediaSignature: input.mediaSignature,
        sourceProductRelPath: `inbox/${input.sku}`,
        quarantineRelPath,
        preparedAt: new Date().toISOString()
      };
      await writeFileAtomic(path.join(snapshot.productRoot, CLEANUP_MARKER), `${JSON.stringify(credential, null, 2)}\n`);
      try {
        await this.operations.rename(snapshot.productRoot, quarantinePath);
      } catch (error) {
        throw filesystemFailure(error, 'WB 来源媒体目录原子隔离失败');
      }
      await assertCredential(quarantinePath, input, quarantineRelPath);
      return { state: 'QUARANTINED', quarantineRelPath };
    });
  }

  async deleteQuarantine(input: {
    rootDirectory: string;
    cleanupId: string;
    sku: string;
    batchKey: string;
    rowVersion: number;
    mediaSignature: string;
    quarantineRelPath: string;
  }): Promise<{ deleted: boolean }> {
    return withWbSourceMediaSkuLock(input.sku, async () => {
      const { quarantinePath } = await resolveQuarantinePath(input.rootDirectory, input.quarantineRelPath, input.cleanupId, input.sku);
      const info = await safeLstat(quarantinePath);
      if (!info) return { deleted: false };
      await assertCredential(quarantinePath, input, input.quarantineRelPath, false);
      await assertTreeHasNoLinks(quarantinePath);
      try {
        await this.operations.rm(quarantinePath, { recursive: true, force: false, maxRetries: 0 });
      } catch (error) {
        throw filesystemFailure(error, 'WB 来源媒体隔离目录删除失败');
      }
      return { deleted: true };
    });
  }
}

async function resolveQuarantinePath(rootDirectory: string, relPath: string, cleanupId: string, sku: string) {
  const root = await assertRealRoot(rootDirectory);
  const expected = `.cleanup/${cleanupId}-${sku}`;
  if (relPath.replaceAll('\\', '/') !== expected) throw unsafePath('WB 来源媒体隔离路径与清理身份不一致', { relPath, expected });
  const quarantineRoot = path.join(rootDirectory, '.cleanup');
  const quarantinePath = path.join(rootDirectory, ...expected.split('/'));
  assertInside(rootDirectory, quarantineRoot, 'WB 来源媒体隔离根目录');
  assertInside(rootDirectory, quarantinePath, 'WB 来源媒体隔离目录');
  if (!isPathInside(root, path.resolve(quarantinePath))) throw unsafePath('WB 来源媒体隔离目录超出根目录', { quarantinePath });
  return { quarantineRoot, quarantinePath };
}

async function assertCredential(
  directory: string,
  input: { cleanupId: string; sku: string; batchKey: string; rowVersion: number; mediaSignature: string },
  quarantineRelPath: string,
  requireRowVersion = true
): Promise<void> {
  const file = path.join(directory, CLEANUP_MARKER);
  let parsed: Partial<WbSourceMediaCleanupCredential>;
  try { parsed = JSON.parse(await readFile(file, 'utf8')) as Partial<WbSourceMediaCleanupCredential>; }
  catch { throw unsafePath('WB 来源媒体隔离目录缺少有效清理凭证', { directory }); }
  const valid = parsed.schemaVersion === 1 && parsed.cleanupId === input.cleanupId && parsed.sku === input.sku
    && parsed.batchKey === input.batchKey && parsed.mediaSignature === input.mediaSignature
    && parsed.quarantineRelPath === quarantineRelPath && (!requireRowVersion || parsed.rowVersion === input.rowVersion);
  if (!valid) throw unsafePath('WB 来源媒体清理凭证与数据库身份不一致', { directory });
}

async function assertRealRoot(rootDirectory: string): Promise<string> {
  if (!path.isAbsolute(rootDirectory)) throw unsafePath('WB 来源媒体根目录必须是绝对路径', { rootDirectory });
  const info = await safeLstat(rootDirectory);
  if (!info || !info.isDirectory() || info.isSymbolicLink()) throw unsafePath('WB 来源媒体根目录必须是真实目录', { rootDirectory });
  return realpath(rootDirectory);
}

async function assertRealDirectory(rootReal: string, directory: string, label: string): Promise<string> {
  const info = await safeLstat(directory);
  if (!info || !info.isDirectory() || info.isSymbolicLink()) throw unsafePath(`${label}必须是真实目录`, { directory });
  const resolved = await realpath(directory);
  if (!isPathInside(rootReal, resolved) && normalizePath(rootReal) !== normalizePath(resolved)) throw unsafePath(`${label}真实路径超出 WB 根目录`, { directory, resolved });
  return resolved;
}

async function assertTreeHasNoLinks(directory: string): Promise<void> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    const info = await lstat(target);
    if (entry.isSymbolicLink() || info.isSymbolicLink()) throw unsafePath('WB 来源媒体目录中不允许存在符号链接或 junction', { target });
    if (entry.isDirectory()) await assertTreeHasNoLinks(target);
  }
}

async function walkFiles(directory: string, files: string[]): Promise<void> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) throw unsafePath('WB 来源媒体目录中不允许存在符号链接或 junction', { target });
    if (entry.isDirectory()) await walkFiles(target, files);
    else if (entry.isFile()) files.push(target);
  }
}

async function directoryEmpty(directory: string): Promise<boolean> {
  const info = await safeLstat(directory);
  if (!info) return true;
  if (!info.isDirectory() || info.isSymbolicLink()) throw unsafePath('WB 来源媒体 .staging 必须是真实目录', { directory });
  return (await readdir(directory)).length === 0;
}

function parseManifest(raw: string, sku: string): { assets: Array<Record<string, any>> } {
  try {
    const parsed = JSON.parse(raw) as { schemaVersion?: unknown; SKU?: unknown; assets?: unknown };
    if (![1, 2].includes(Number(parsed.schemaVersion)) || parsed.SKU !== sku || !Array.isArray(parsed.assets)) throw new Error('结构无效');
    return { assets: parsed.assets as Array<Record<string, any>> };
  } catch (error) {
    throw sourceChanged('WB 来源媒体 manifest 无效', { sku, reason: error instanceof Error ? error.message : String(error) });
  }
}

function validateManifestFiles(manifest: { assets: Array<Record<string, any>> }, files: WbSourceMediaFileSnapshot['files']): void {
  const byPath = new Map(files.map((file) => [file.relativePath, file]));
  for (const asset of manifest.assets) {
    const relativePath = String(asset.relativePath || '').replaceAll('\\', '/');
    if (!relativePath.startsWith('variants/') || relativePath.split('/').some((part) => !part || part === '.' || part === '..')) {
      throw sourceChanged('WB 来源媒体 manifest 包含不安全路径', { relativePath });
    }
    const file = byPath.get(relativePath);
    if (!file || file.sizeBytes !== Number(asset.sizeBytes) || file.sha256 !== `sha256:${String(asset.sha256 || '').replace(/^sha256:/, '')}`) {
      throw sourceChanged('WB 来源媒体 manifest 与实际文件不一致', { relativePath });
    }
  }
}

async function safeLstat(target: string) {
  return lstat(target).catch((error: NodeJS.ErrnoException) => error.code === 'ENOENT' ? undefined : Promise.reject(error));
}

async function hashFile(file: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${stableJson(object[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function assertSku(sku: string): void {
  if (!/^\d{7}$/.test(sku)) throw unsafePath('WB 来源媒体清理只接受 7 位 SKU', { sku });
}

function assertInside(root: string, target: string, label: string): void {
  if (!isPathInside(path.resolve(root), path.resolve(target))) throw unsafePath(`${label}超出 WB 根目录`, { root, target });
}

function comparePortable(left: string, right: string): number {
  return left.replaceAll('\\', '/').localeCompare(right.replaceAll('\\', '/'), 'en');
}

function normalizePath(value: string): string {
  const normalized = path.resolve(value).replaceAll('\\', '/').replace(/\/+$/, '');
  return process.platform === 'win32' ? normalized.toLocaleLowerCase('en-US') : normalized;
}

function unsafePath(message: string, details: Record<string, unknown>): AppError {
  return new AppError('PATH_TRAVERSAL_BLOCKED', message, details, 409);
}

function sourceChanged(message: string, details: Record<string, unknown>): AppError {
  return new AppError('WB_SOURCE_MEDIA_CHANGED', message, details, 409);
}

function filesystemFailure(error: unknown, message: string): AppError {
  const code = (error as NodeJS.ErrnoException)?.code || 'WB_SOURCE_MEDIA_CLEANUP_FAILED';
  const retryable = ['EPERM', 'EBUSY', 'EACCES', 'ENOTEMPTY'].includes(code);
  return new AppError(
    retryable ? 'WB_SOURCE_MEDIA_CLEANUP_RETRY' : 'WB_SOURCE_MEDIA_CLEANUP_FAILED',
    `${message}: ${error instanceof Error ? error.message : String(error)}`,
    { filesystemCode: code, retryable },
    409
  );
}
