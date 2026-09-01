import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { constants, type Stats } from 'node:fs';
import { access, copyFile, lstat, mkdir, readFile, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { AppError, IMAGE_EXTENSIONS, validateLocalImportProductName, type StageConfig } from '@n8n-media-review/shared';
import { Decimal } from 'decimal.js';
import type { ConfigService } from '../../config/service.js';
import {
  type LocalImportRecord,
  type LocalImportSourceInput,
  type PurchaseInput,
  type PurchaseRepository
} from '../../repositories/purchases.js';
import { atomicRenameWithRetry } from '../../utils/atomic-rename.js';

const PREVIEW_TTL_MS = 30 * 60_000;
const MAX_SELECTED_DIRECTORIES = 20;
const MAX_FILES_PER_IMPORT = 10_000;
const BUSINESS_EXTENSIONS = new Set(['.json', '.txt', '.csv', '.xml', '.xlsx', '.xls', '.md']);
const VIDEO_EXTENSIONS = new Set(['.mp4', '.mov', '.avi', '.mkv', '.webm', '.m4v']);
const EXCLUDED_NAME_PARTS = ['session', 'cookie', 'token', 'cache', 'logs', 'runtime', 'download-state', 'download_status', 'download-status', 'temp', 'tmp'];

type PreviewFile = { relativePath: string; sha256: string; sizeBytes: number };
type PreviewSource = {
  platform: string;
  relativePath: string;
  normalizedPathKey: string;
  directoryName: string;
  isPrimary: boolean;
  externalSku?: string;
  informationFileRelativePath?: string;
  informationFileSha256?: string;
  providerUrls: string[];
  files: PreviewFile[];
};
type ProductFields = Omit<PurchaseInput, 'downloadWorkflowCode'>;
export type LocalImportPriceConversion = {
  sourceCurrency: 'CNY' | 'RUB';
  exchangeRate?: string;
  status: 'NOT_REQUIRED' | 'CALCULATED' | 'MANUAL_REQUIRED';
  issue?: 'MISSING' | 'INVALID';
  calculatedPurchasePrice?: string;
};
export type LocalImportDirectoryEntry = {
  name: string;
  relativePath: string;
  platform: string;
  hasChildren: boolean;
  childDirectoryCount: number;
  createdAt: string;
  modifiedAt: string;
};
type LocalImportDirectorySortMode = 'platform-root' | 'product-media' | 'name';
type PreviewSnapshot = {
  token: string;
  createdAt: number;
  previewHash: string;
  sourceConfigHash: string;
  targetConfigHash: string;
  sourcePlatform: string;
  importWorkflowLabel: string;
  sourceRoot: string;
  candidateRoot: string;
  fields: ProductFields;
  priceConversion: LocalImportPriceConversion;
  sources: PreviewSource[];
};

export type LocalImportPreview = Omit<PreviewSnapshot, 'createdAt' | 'sourceRoot' | 'candidateRoot'> & {
  expiresAt: string;
  fileCount: number;
  imageCount: number;
};

export class LocalImportService {
  private readonly previews = new Map<string, PreviewSnapshot>();

  constructor(
    private readonly config: ConfigService,
    private readonly purchases: PurchaseRepository,
    private readonly onImported: () => Promise<unknown>
  ) {}

  async listDirectories(relativePath = '') {
    const { root, configHash } = await this.sourceConfiguration();
    const normalized = normalizeRelativePath(relativePath, true);
    const directory = await resolveSafeDirectory(root, normalized);
    const entries = await readdir(directory.absolutePath, { withFileTypes: true });
    const directories: LocalImportDirectoryEntry[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink() || isHiddenName(entry.name)) continue;
      const childRelative = normalized ? `${normalized}/${entry.name}` : entry.name;
      const child = await resolveSafeDirectory(root, childRelative);
      const [children, info] = await Promise.all([
        readdir(child.absolutePath, { withFileTypes: true }),
        lstat(child.absolutePath)
      ]);
      const childDirectoryCount = children.filter((candidate) => candidate.isDirectory() && !candidate.isSymbolicLink() && !isHiddenName(candidate.name)).length;
      const hasChildren = childDirectoryCount > 0;
      if (!normalized && !hasChildren) continue;
      directories.push({
        name: entry.name,
        relativePath: childRelative,
        platform: childRelative.split('/')[0]!,
        hasChildren,
        childDirectoryCount,
        createdAt: directoryCreatedAt(info),
        modifiedAt: new Date(info.mtimeMs).toISOString()
      });
    }
    const depth = normalized.split('/').filter(Boolean).length;
    const sortMode: LocalImportDirectorySortMode = depth === 0 ? 'platform-root' : depth === 1 ? 'product-media' : 'name';
    return { path: normalized, configHash, directories: sortLocalImportDirectories(directories, sortMode) };
  }

  async preview(input: { directories?: unknown; primaryDirectory?: unknown }): Promise<LocalImportPreview> {
    const directories = validateDirectorySelection(input.directories);
    const primaryDirectory = normalizeRelativePath(String(input.primaryDirectory || ''));
    if (!directories.includes(primaryDirectory)) throw new AppError('CONFIG_INVALID', '采购信息主目录必须在已选目录中');
    const platforms = new Set(directories.map((item) => item.split('/')[0]!.toLocaleLowerCase('en-US')));
    if (platforms.size !== 1) throw new AppError('LOCAL_IMPORT_CROSS_PLATFORM', '一次导入只能选择同一平台的媒体目录', undefined, 409);
    rejectParentChildSelections(directories);
    const sourceConfig = await this.sourceConfiguration();
    const targetConfig = await this.targetConfiguration(false);
    const sources: PreviewSource[] = [];
    let totalFiles = 0;
    for (const relativePath of directories) {
      const directory = await resolveSafeDirectory(sourceConfig.root, relativePath);
      const files = await scanBusinessFiles(directory.absolutePath);
      totalFiles += files.length;
      if (totalFiles > MAX_FILES_PER_IMPORT) throw new AppError('LOCAL_IMPORT_TOO_LARGE', `一次导入最多允许 ${MAX_FILES_PER_IMPORT} 个业务文件`, undefined, 409);
      const information = await readProductInformation(directory.absolutePath, files, relativePath === primaryDirectory);
      sources.push({
        platform: relativePath.split('/')[0]!, relativePath, normalizedPathKey: normalizePathKey(relativePath),
        directoryName: path.posix.basename(relativePath), isPrimary: relativePath === primaryDirectory,
        externalSku: information.externalSku, informationFileRelativePath: information.relativePath,
        informationFileSha256: information.sha256, providerUrls: information.providerUrls, files
      });
    }
    const primary = sources.find((source) => source.isPrimary)!;
    const productInfo = await parseProductInformation(sourceConfig.root, primary);
    const { fields, priceConversion } = mapProductFields(productInfo);
    const sourcePlatform = primary.platform;
    const importWorkflowLabel = `本地导入-${sourcePlatform}`;
    const previewHash = sha256(stableJson({ sourceConfigHash: sourceConfig.configHash, targetConfigHash: targetConfig.configHash, sourcePlatform, importWorkflowLabel, fields, priceConversion, sources }));
    const token = randomUUID();
    const snapshot: PreviewSnapshot = {
      token, createdAt: Date.now(), previewHash, sourceConfigHash: sourceConfig.configHash, targetConfigHash: targetConfig.configHash,
      sourcePlatform, importWorkflowLabel, sourceRoot: sourceConfig.root, candidateRoot: targetConfig.root, fields, priceConversion, sources
    };
    this.prunePreviews();
    this.previews.set(token, snapshot);
    return toPublicPreview(snapshot);
  }

  async import(input: { previewToken?: unknown; idempotencyKey?: unknown; fields?: unknown }) {
    const token = String(input.previewToken || '').trim();
    const idempotencyKey = String(input.idempotencyKey || '').trim();
    const snapshot = await this.validPreview(token);
    const fields = validateEditedFields(input.fields, snapshot.fields);
    const providerUrls = [...new Set(snapshot.sources.flatMap((source) => source.providerUrls))];
    const primaryUrl = fields.providerUrl.trim();
    if (!providerUrls.includes(primaryUrl)) providerUrls.unshift(primaryUrl);
    const sources: LocalImportSourceInput[] = snapshot.sources.map((source) => ({
      platform: source.platform, relativePath: source.relativePath, normalizedPathKey: source.normalizedPathKey,
      isPrimary: source.isPrimary, externalSku: source.externalSku,
      informationFileRelativePath: source.informationFileRelativePath, informationFileSha256: source.informationFileSha256,
      providerUrl: source.providerUrls[0], targetSubdirectory: source.directoryName,
      copyManifest: { files: source.files }
    }));
    const reservation = await this.purchases.reserveLocalImport({
      idempotencyKey, previewHash: snapshot.previewHash,
      sourceConfigSnapshot: { stageId: 'E000', inputQueueRoot: snapshot.sourceRoot, configHash: snapshot.sourceConfigHash },
      targetConfigSnapshot: { stageId: 'E000', candidateRoot: snapshot.candidateRoot, configHash: snapshot.targetConfigHash },
      purchase: { ...fields, downloadWorkflowCode: undefined }, providerUrls, sources
    });
    if (!reservation.created || reservation.import.status === 'SKIPPED_DUPLICATE' || reservation.import.status === 'IMPORTED') return reservation.import;
    return this.copyReservedImport(reservation.import);
  }

  async get(id: string) { return this.purchases.getLocalImport(id); }

  async list(input: Parameters<PurchaseRepository['listLocalImports']>[0]) { return this.purchases.listLocalImports(input); }

  async updatePurchase(id: string, input: Omit<PurchaseInput, 'downloadWorkflowCode'>) {
    return this.purchases.updateLocalImportPurchase(id, input);
  }

  async retry(id: string) {
    const record = await this.purchases.getLocalImport(id);
    if (record.status === 'IMPORTED' || record.status === 'SKIPPED_DUPLICATE') return record;
    if (record.status !== 'COPY_FAILED_RETRYABLE') throw new AppError('LOCAL_IMPORT_NOT_RETRYABLE', '当前本地导入状态不可重试', { status: record.status }, 409);
    await this.assertRecordConfiguration(record);
    await this.purchases.markLocalImportCopying(id);
    return this.copyReservedImport(await this.purchases.getLocalImport(id));
  }

  private async validPreview(token: string): Promise<PreviewSnapshot> {
    const snapshot = this.previews.get(token);
    if (!snapshot || Date.now() - snapshot.createdAt > PREVIEW_TTL_MS) {
      this.previews.delete(token);
      throw new AppError('LOCAL_IMPORT_PREVIEW_EXPIRED', '预览已过期，请重新选择目录并预览', undefined, 409);
    }
    const source = await this.sourceConfiguration();
    const target = await this.targetConfiguration(false);
    if (source.configHash !== snapshot.sourceConfigHash || target.configHash !== snapshot.targetConfigHash) {
      this.previews.delete(token);
      throw new AppError('LOCAL_IMPORT_PREVIEW_EXPIRED', 'E000 目录配置已变化，旧预览已失效，请重新预览', undefined, 409);
    }
    return snapshot;
  }

  private async copyReservedImport(record: LocalImportRecord): Promise<LocalImportRecord> {
    try {
      await this.assertRecordConfiguration(record);
      const sku = record.sku!;
      const product = await this.purchases.getPurchase(sku);
      const productName = String(product.productName);
      const candidateRoot = String(record.targetConfigSnapshot.candidateRoot);
      const folderName = `${sku}-${safeFolderName(productName)}`;
      const target = path.join(candidateRoot, folderName);
      const stagingRoot = path.join(candidateRoot, '.staging');
      const staging = path.join(stagingRoot, `${folderName}.__tmp__${record.id}`);
      const existing = await compatibleExistingTarget(target, record.id, record.previewHash);
      if (existing) return await this.purchases.completeLocalImport(record.id, target);
      if (await stat(target).catch(() => null)) throw new AppError('LOCAL_IMPORT_TARGET_CONFLICT', '目标目录已存在且与本次导入不一致', { target }, 409);
      await mkdir(stagingRoot, { recursive: true });
      await rm(staging, { recursive: true, force: true });
      await mkdir(staging, { recursive: true });
      const manifestSources: Array<Record<string, unknown>> = [];
      for (const source of record.sources) {
        const sourceRoot = String(record.sourceConfigSnapshot.inputQueueRoot);
        const resolved = await resolveSafeDirectory(sourceRoot, source.relativePath);
        const files = manifestFiles(source.copyManifest);
        const copied: PreviewFile[] = [];
        for (const file of files) {
          const sourceFile = await resolveSafeFile(resolved.absolutePath, file.relativePath);
          const actualHash = await fileSha256(sourceFile);
          if (actualHash !== file.sha256) throw new AppError('LOCAL_IMPORT_SOURCE_CHANGED', '来源文件在预览后发生变化，请重新预览', { relativePath: `${source.relativePath}/${file.relativePath}` }, 409);
          const destination = path.join(staging, source.targetSubdirectory, ...file.relativePath.split('/'));
          await mkdir(path.dirname(destination), { recursive: true });
          await copyFile(sourceFile, destination);
          const copiedHash = await fileSha256(destination);
          if (copiedHash !== file.sha256) throw new AppError('VERIFY_FAILED', '复制后的文件 SHA-256 校验失败', { relativePath: file.relativePath });
          copied.push(file);
        }
        manifestSources.push({ platform: source.platform, relativePath: source.relativePath, targetSubdirectory: source.targetSubdirectory, files: copied });
      }
      await writeJson(path.join(staging, 'task-context.json'), { schemaVersion: 1, workflowCode: 'E000', SKU: sku, productName, sourceLocalImportId: record.id });
      await writeJson(path.join(staging, 'local-import-manifest.json'), {
        schemaVersion: 1, localImportId: record.id, sku, productName, previewHash: record.previewHash,
        sourceConfigSnapshot: record.sourceConfigSnapshot, targetConfigSnapshot: record.targetConfigSnapshot,
        sources: manifestSources, createdAt: new Date().toISOString()
      });
      await atomicRenameWithRetry(staging, target);
      const completed = await this.purchases.completeLocalImport(record.id, target);
      await this.onImported();
      return completed;
    } catch (error) {
      const code = error instanceof AppError ? error.code : 'LOCAL_IMPORT_COPY_FAILED';
      const message = error instanceof Error ? error.message : '媒体复制失败';
      return this.purchases.failLocalImport(record.id, code, message);
    }
  }

  private async assertRecordConfiguration(record: LocalImportRecord) {
    const source = await this.sourceConfiguration();
    const target = await this.targetConfiguration(true);
    if (source.configHash !== record.sourceConfigSnapshot.configHash || target.configHash !== record.targetConfigSnapshot.configHash) {
      throw new AppError('LOCAL_IMPORT_CONFIG_CHANGED', 'E000 目录配置已变化，不能按旧快照重试', undefined, 409);
    }
  }

  private async sourceConfiguration() {
    const stage = requireE000(this.config.get().stages);
    const root = String(stage.inputQueueRoot || '').trim();
    if (!root) throw new AppError('LOCAL_IMPORT_SOURCE_UNCONFIGURED', '尚未配置 E000 本地导入来源根目录，请前往系统设置', { settingsPath: '/settings/workflows?stage=E000' }, 409);
    await assertStrictDirectory(root, false, '本地导入来源根目录');
    return { root: path.resolve(root), configHash: configurationHash('source', root) };
  }

  private async targetConfiguration(requireWritable: boolean) {
    const stage = requireE000(this.config.get().stages);
    const root = String(stage.candidateRoot || '').trim();
    if (!root) throw new AppError('LOCAL_IMPORT_TARGET_UNCONFIGURED', '尚未配置 E000 候选图片目录，请前往系统设置', { settingsPath: '/settings/workflows?stage=E000' }, 409);
    await assertStrictDirectory(root, requireWritable, 'E000 候选图片目录');
    return { root: path.resolve(root), configHash: configurationHash('target', root) };
  }

  private prunePreviews() {
    for (const [token, preview] of this.previews) if (Date.now() - preview.createdAt > PREVIEW_TTL_MS) this.previews.delete(token);
  }
}

function directoryCreatedAt(info: Pick<Stats, 'birthtimeMs' | 'mtimeMs'>): string {
  const timestamp = Number.isFinite(info.birthtimeMs) && info.birthtimeMs > 0 ? info.birthtimeMs : info.mtimeMs;
  return new Date(timestamp).toISOString();
}

export function sortLocalImportDirectories(directories: LocalImportDirectoryEntry[], mode: LocalImportDirectorySortMode): LocalImportDirectoryEntry[] {
  return [...directories].sort((left, right) => {
    if (mode === 'platform-root') {
      const modifiedAtDifference = Date.parse(right.modifiedAt) - Date.parse(left.modifiedAt);
      if (modifiedAtDifference !== 0) return modifiedAtDifference;
    } else if (mode === 'product-media') {
      const createdAtDifference = Date.parse(right.createdAt) - Date.parse(left.createdAt);
      if (createdAtDifference !== 0) return createdAtDifference;
    }
    return left.name.localeCompare(right.name, 'zh-CN');
  });
}

export function isAbsolutePathForPlatform(value: string, platform: NodeJS.Platform): boolean {
  return platform === 'win32' ? path.win32.isAbsolute(value) : path.posix.isAbsolute(value);
}

export async function assertStrictDirectory(root: string, writable: boolean, label: string): Promise<void> {
  const trimmed = root.trim();
  if (!isAbsolutePathForPlatform(trimmed, process.platform)) throw new AppError('LOCAL_IMPORT_PATH_INVALID', `${label}必须是当前操作系统支持的绝对路径`);
  const resolved = path.resolve(trimmed);
  if (normalizeNativePath(resolved) === normalizeNativePath(path.parse(resolved).root)) throw new AppError('LOCAL_IMPORT_PATH_INVALID', `${label}不能是磁盘或卷根目录`);
  const info = await lstat(resolved).catch(() => undefined);
  if (!info?.isDirectory()) throw new AppError('LOCAL_IMPORT_PATH_UNAVAILABLE', `${label}不存在或不是目录`, { path: resolved }, 409);
  if (info.isSymbolicLink()) throw new AppError('LOCAL_IMPORT_PATH_UNSAFE', `${label}不能是符号链接或 reparse point`, { path: resolved }, 409);
  const canonical = await realpath(resolved);
  if (normalizeNativePath(canonical) !== normalizeNativePath(resolved)) throw new AppError('LOCAL_IMPORT_PATH_UNSAFE', `${label}不能经过符号链接、junction 或 reparse point`, { path: resolved }, 409);
  await access(resolved, constants.R_OK).catch(() => { throw new AppError('LOCAL_IMPORT_PATH_UNREADABLE', `${label}不可读`, { path: resolved }, 409); });
  if (writable) await access(resolved, constants.W_OK).catch(() => { throw new AppError('LOCAL_IMPORT_PATH_UNWRITABLE', `${label}不可写`, { path: resolved }, 409); });
}

function requireE000(stages: StageConfig[]): StageConfig {
  const stage = stages.find((item) => item.id === 'E000');
  if (!stage?.enabled) throw new AppError('LOCAL_IMPORT_DISABLED', 'E000 本地导入工作流未配置或未启用', { settingsPath: '/settings/workflows?stage=E000' }, 409);
  return stage;
}

function validateDirectorySelection(input: unknown): string[] {
  if (!Array.isArray(input) || !input.length || input.length > MAX_SELECTED_DIRECTORIES) throw new AppError('CONFIG_INVALID', `请选择 1 到 ${MAX_SELECTED_DIRECTORIES} 个媒体目录`);
  const values = input.map((item) => normalizeRelativePath(String(item || '')));
  if (new Set(values.map(normalizePathKey)).size !== values.length) throw new AppError('CONFIG_INVALID', '不能重复选择同一媒体目录');
  return values;
}

function normalizeRelativePath(input: string, allowEmpty = false): string {
  const replaced = input.trim().replaceAll('\\', '/').replace(/^\/+|\/+$/g, '');
  if (!replaced && allowEmpty) return '';
  const parts = replaced.split('/');
  if (!replaced || parts.some((part) => !part || part === '.' || part === '..' || part.includes('\0'))) throw new AppError('LOCAL_IMPORT_PATH_INVALID', '目录必须是配置根目录下的安全相对路径');
  return parts.join('/');
}

function normalizePathKey(value: string) { return value.normalize('NFC').toLocaleLowerCase('en-US'); }
function normalizeNativePath(value: string) { const normalized = path.normalize(value); return process.platform === 'win32' ? normalized.toLocaleLowerCase('en-US') : normalized; }
function isHiddenName(name: string) { return name.startsWith('.') || name.startsWith('~'); }

async function resolveSafeDirectory(root: string, relativePath: string) {
  const parts = relativePath ? normalizeRelativePath(relativePath).split('/') : [];
  const candidate = path.resolve(root, ...parts);
  assertInside(root, candidate);
  const info = await lstat(candidate).catch(() => undefined);
  if (!info?.isDirectory() || info.isSymbolicLink()) throw new AppError('LOCAL_IMPORT_PATH_UNSAFE', '所选媒体目录不存在、不是目录或属于链接目录', { relativePath }, 409);
  const canonical = await realpath(candidate);
  if (normalizeNativePath(canonical) !== normalizeNativePath(candidate)) throw new AppError('LOCAL_IMPORT_PATH_UNSAFE', '所选媒体目录包含符号链接、junction 或 reparse point', { relativePath }, 409);
  assertInside(root, canonical);
  return { absolutePath: candidate, relativePath };
}

async function resolveSafeFile(root: string, relativePath: string) {
  const normalized = normalizeRelativePath(relativePath);
  const candidate = path.resolve(root, ...normalized.split('/'));
  assertInside(root, candidate);
  const info = await lstat(candidate);
  if (!info.isFile() || info.isSymbolicLink()) throw new AppError('LOCAL_IMPORT_PATH_UNSAFE', '来源业务文件已不存在或变为链接文件', { relativePath }, 409);
  const canonical = await realpath(candidate);
  if (normalizeNativePath(canonical) !== normalizeNativePath(candidate)) throw new AppError('LOCAL_IMPORT_PATH_UNSAFE', '来源业务文件包含符号链接或 reparse point', { relativePath }, 409);
  return candidate;
}

function assertInside(root: string, candidate: string) {
  const rootValue = normalizeNativePath(path.resolve(root));
  const candidateValue = normalizeNativePath(path.resolve(candidate));
  if (candidateValue !== rootValue && !candidateValue.startsWith(`${rootValue}${path.sep}`)) throw new AppError('LOCAL_IMPORT_PATH_ESCAPE', '请求路径越过了 E000 配置根目录', undefined, 409);
}

function rejectParentChildSelections(directories: string[]) {
  const keys = directories.map(normalizePathKey);
  for (const [index, key] of keys.entries()) {
    if (keys.some((other, otherIndex) => otherIndex !== index && (key.startsWith(`${other}/`) || other.startsWith(`${key}/`)))) {
      throw new AppError('LOCAL_IMPORT_PARENT_CHILD_SELECTION', '不能同时选择父目录和它的子目录', undefined, 409);
    }
  }
  const names = directories.map((item) => normalizePathKey(path.posix.basename(item)));
  if (new Set(names).size !== names.length) throw new AppError('LOCAL_IMPORT_DUPLICATE_FOLDER_NAME', '所选媒体目录名称重复，无法保持原目录名复制', undefined, 409);
}

async function scanBusinessFiles(root: string): Promise<PreviewFile[]> {
  const result: PreviewFile[] = [];
  const visit = async (directory: string, prefix: string) => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (shouldExclude(relativePath)) continue;
      if (entry.isSymbolicLink()) throw new AppError('LOCAL_IMPORT_PATH_UNSAFE', '媒体目录中包含符号链接或 reparse point', { relativePath }, 409);
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) { await visit(absolute, relativePath); continue; }
      if (!entry.isFile()) continue;
      const extension = path.extname(entry.name).toLocaleLowerCase('en-US');
      if (VIDEO_EXTENSIONS.has(extension) || (!IMAGE_EXTENSIONS.includes(extension as any) && !BUSINESS_EXTENSIONS.has(extension))) continue;
      const fileInfo = await stat(absolute);
      result.push({ relativePath, sha256: await fileSha256(absolute), sizeBytes: fileInfo.size });
    }
  };
  await visit(root, '');
  return result.sort((a, b) => a.relativePath.localeCompare(b.relativePath, 'zh-CN'));
}

function shouldExclude(relativePath: string) {
  const parts = relativePath.split('/');
  if (parts.some(isHiddenName)) return true;
  const lower = relativePath.toLocaleLowerCase('en-US');
  return EXCLUDED_NAME_PARTS.some((part) => lower.includes(part));
}

async function readProductInformation(root: string, files: PreviewFile[], required: boolean) {
  const exact = files.find((file) => file.relativePath.toLocaleLowerCase('en-US') === 'productinformation-sku.json');
  const numbered = files.find((file) => /^productinformation-\d+\.json$/i.test(file.relativePath));
  const selected = exact || numbered;
  if (!selected) {
    if (required) throw new AppError('LOCAL_IMPORT_INFORMATION_MISSING', '采购信息主目录缺少 productInformation-sku.json 或 productInformation-数字.json', undefined, 409);
    return { providerUrls: [] as string[] };
  }
  const parsed = parseJsonObject(await readFile(path.join(root, ...selected.relativePath.split('/')), 'utf8'), selected.relativePath);
  return {
    externalSku: optionalText(parsed.SKU ?? parsed.sku), relativePath: selected.relativePath, sha256: selected.sha256,
    providerUrls: collectUrls(parsed)
  };
}

async function parseProductInformation(sourceRoot: string, source: PreviewSource) {
  if (!source.informationFileRelativePath) throw new AppError('LOCAL_IMPORT_INFORMATION_MISSING', '采购信息主目录缺少产品信息文件', undefined, 409);
  const file = path.join(sourceRoot, ...source.relativePath.split('/'), ...source.informationFileRelativePath.split('/'));
  return parseJsonObject(await readFile(file, 'utf8'), source.informationFileRelativePath);
}

function parseJsonObject(raw: string, relativePath: string): Record<string, unknown> {
  try {
    const value = JSON.parse(raw);
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('根节点不是对象');
    return value as Record<string, unknown>;
  } catch (error) {
    throw new AppError('LOCAL_IMPORT_INFORMATION_INVALID', '产品信息 JSON 格式无效', { relativePath, reason: error instanceof Error ? error.message : String(error) }, 409);
  }
}

function collectUrls(value: unknown, urls = new Set<string>(), eligible = false): string[] {
  if (eligible && typeof value === 'string') {
    try { const parsed = new URL(value.trim()); if (parsed.protocol === 'http:' || parsed.protocol === 'https:') urls.add(value.trim()); } catch { /* not a URL */ }
  } else if (Array.isArray(value)) value.forEach((item) => collectUrls(item, urls, eligible));
  else if (value && typeof value === 'object') {
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) collectUrls(item, urls, /^(product|provider|goods|source)url$/i.test(key));
  }
  return [...urls];
}

function mapProductFields(value: Record<string, unknown>): { fields: ProductFields; priceConversion: LocalImportPriceConversion } {
  const providerUrl = requiredText(value.productUrl, '商品 URL');
  try { new URL(providerUrl); } catch { throw new AppError('LOCAL_IMPORT_INFORMATION_INVALID', '产品信息中的商品 URL 无效', undefined, 409); }
  const sourceCurrency = (optionalText(value.currencyType) || 'CNY').toUpperCase();
  if (sourceCurrency !== 'CNY' && sourceCurrency !== 'RUB') {
    throw new AppError('LOCAL_IMPORT_CURRENCY_UNSUPPORTED', `本地导入仅支持 CNY 或 RUB，当前币种为 ${sourceCurrency}`, { sourceCurrency }, 409);
  }
  const sourcePrice = requiredDecimal(value.sellingPrice, sourceCurrency === 'RUB' ? '零售价格' : '国内采购价');
  const exchangeInput = value.Exchange;
  const exchangeRate = positiveDecimal(exchangeInput);
  const exchangeIssue = exchangeInput == null || String(exchangeInput).trim() === '' ? 'MISSING' : 'INVALID';
  const calculatedPurchasePrice = sourceCurrency === 'RUB' && exchangeRate
    ? new Decimal(sourcePrice).div(exchangeRate).toDecimalPlaces(4, Decimal.ROUND_HALF_UP).toFixed(4)
    : undefined;
  const fields: ProductFields = {
    productName: requiredText(value.productName, '产品名称'), purchasePrice: sourceCurrency === 'CNY' ? sourcePrice : calculatedPurchasePrice || '',
    retailPrice: sourceCurrency === 'RUB' ? sourcePrice : null,
    currency: 'CNY', courierFee: optionalDecimal(value.courierFee) || '0',
    productHeightCm: optionalDecimal(value.productHeightCm), productDepthCm: optionalDecimal(value.productDepthCm), productWidthCm: optionalDecimal(value.productWidthCm),
    netWeightGrams: optionalDecimal(value.netWeightGrams), grossWeightGrams: optionalDecimal(value.grossWeightGrams),
    lengthCm: optionalDecimal(value.lengthCm), widthCm: optionalDecimal(value.widthCm), heightCm: optionalDecimal(value.heightCm),
    providerUrl
  };
  return {
    fields,
    priceConversion: sourceCurrency === 'CNY'
      ? { sourceCurrency, status: 'NOT_REQUIRED' }
      : exchangeRate
        ? { sourceCurrency, exchangeRate, status: 'CALCULATED', calculatedPurchasePrice }
        : { sourceCurrency, status: 'MANUAL_REQUIRED', issue: exchangeIssue }
  };
}

function validateEditedFields(value: unknown, fallback: ProductFields): ProductFields {
  const input = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const providerUrl = requiredText(input.providerUrl ?? fallback.providerUrl, '商品 URL');
  try { new URL(providerUrl); } catch { throw new AppError('LOCAL_IMPORT_INFORMATION_INVALID', '产品信息中的商品 URL 无效', undefined, 409); }
  return {
    productName: requiredLocalImportProductName(input.productName ?? fallback.productName),
    purchasePrice: requiredDecimal(input.purchasePrice ?? fallback.purchasePrice, '国内采购价'),
    retailPrice: fallback.retailPrice,
    currency: 'CNY',
    courierFee: optionalDecimal(input.courierFee ?? fallback.courierFee) || '0',
    productHeightCm: optionalDecimal(input.productHeightCm ?? fallback.productHeightCm),
    productDepthCm: optionalDecimal(input.productDepthCm ?? fallback.productDepthCm),
    productWidthCm: optionalDecimal(input.productWidthCm ?? fallback.productWidthCm),
    netWeightGrams: optionalDecimal(input.netWeightGrams ?? fallback.netWeightGrams),
    grossWeightGrams: optionalDecimal(input.grossWeightGrams ?? fallback.grossWeightGrams),
    lengthCm: optionalDecimal(input.lengthCm ?? fallback.lengthCm),
    widthCm: optionalDecimal(input.widthCm ?? fallback.widthCm),
    heightCm: optionalDecimal(input.heightCm ?? fallback.heightCm),
    providerUrl
  };
}

function requiredText(value: unknown, field: string) { const text = optionalText(value); if (!text) throw new AppError('LOCAL_IMPORT_INFORMATION_INVALID', `${field}不能为空`, undefined, 409); return text; }
function requiredLocalImportProductName(value: unknown) {
  const validation = validateLocalImportProductName(value);
  if (!validation.valid) {
    throw new AppError('LOCAL_IMPORT_INFORMATION_INVALID', validation.message, {
      field: 'productName', issue: validation.issue, actualLength: validation.length
    }, 409);
  }
  return validation.value;
}
function optionalText(value: unknown) { return value == null ? undefined : String(value).trim() || undefined; }
function requiredDecimal(value: unknown, field: string) { const decimal = optionalDecimal(value); if (decimal === undefined) throw new AppError('LOCAL_IMPORT_INFORMATION_INVALID', `${field}必须是有效数字`, undefined, 409); return decimal; }
function optionalDecimal(value: unknown) { if (value == null || value === '') return undefined; const number = Number(value); return Number.isFinite(number) && number >= 0 ? String(value).trim() : undefined; }
function positiveDecimal(value: unknown) { const decimal = optionalDecimal(value); return decimal !== undefined && new Decimal(decimal).greaterThan(0) ? decimal : undefined; }

function manifestFiles(value: Record<string, unknown>): PreviewFile[] {
  const files = value.files;
  if (!Array.isArray(files)) throw new AppError('LOCAL_IMPORT_MANIFEST_INVALID', '数据库中的复制清单无效', undefined, 500);
  return files.map((file) => {
    const item = file as Record<string, unknown>;
    const relativePath = normalizeRelativePath(String(item.relativePath || ''));
    const sha = String(item.sha256 || '').toLowerCase();
    const sizeBytes = Number(item.sizeBytes);
    if (!/^[a-f0-9]{64}$/.test(sha) || !Number.isSafeInteger(sizeBytes) || sizeBytes < 0) throw new AppError('LOCAL_IMPORT_MANIFEST_INVALID', '数据库中的文件哈希清单无效', undefined, 500);
    return { relativePath, sha256: sha, sizeBytes };
  });
}

function configurationHash(kind: string, root: string) { return sha256(stableJson({ stageId: 'E000', kind, root: normalizeNativePath(path.resolve(root)) })); }
function sha256(value: string | Buffer) { return createHash('sha256').update(value).digest('hex'); }
async function fileSha256(file: string) { return sha256(await readFile(file)); }
function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(',')}}`;
  return JSON.stringify(value);
}
function safeFolderName(value: string) {
  const cleaned = [...value.normalize('NFC')].map((character) => character.charCodeAt(0) <= 31 || '<>:"/\\|?*'.includes(character) ? '-' : character).join('');
  return cleaned.replace(/[. ]+$/g, '').trim().slice(0, 100) || '未命名产品';
}
async function writeJson(file: string, value: unknown) { await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' }); }
async function compatibleExistingTarget(target: string, id: string, previewHash: string) {
  try { const manifest = JSON.parse(await readFile(path.join(target, 'local-import-manifest.json'), 'utf8')); return manifest.localImportId === id && manifest.previewHash === previewHash; }
  catch { return false; }
}
function toPublicPreview(snapshot: PreviewSnapshot): LocalImportPreview {
  const files = snapshot.sources.flatMap((source) => source.files);
  return {
    token: snapshot.token, previewHash: snapshot.previewHash, sourceConfigHash: snapshot.sourceConfigHash, targetConfigHash: snapshot.targetConfigHash,
    sourcePlatform: snapshot.sourcePlatform, importWorkflowLabel: snapshot.importWorkflowLabel, priceConversion: snapshot.priceConversion,
    fields: snapshot.fields, sources: snapshot.sources, expiresAt: new Date(snapshot.createdAt + PREVIEW_TTL_MS).toISOString(),
    fileCount: files.length, imageCount: files.filter((file) => IMAGE_EXTENSIONS.includes(path.extname(file.relativePath).toLocaleLowerCase('en-US') as any)).length
  };
}
