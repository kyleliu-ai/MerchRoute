import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { cp, lstat, mkdir, open, readFile, readdir, realpath, rename, rm } from 'node:fs/promises';
import writeFileAtomic from 'write-file-atomic';
import sharp from 'sharp';
import {
  AppError,
  limitWbDescription,
  normalizeWbComparablePath,
  wbProductV2Schema,
  wbPublishingConfigSchema,
  type WbProductV2,
  type WbPublishingConfig,
  type WbMediaPolicy,
  type WbSubmissionMode,
  type WbNetworkRecovery
} from '@n8n-media-review/shared';
import { resolveWbMediaOutputRoot, type ConfigService, type PathValidation } from '../../config/service.js';
import { isPathInside, secureResolve, toApiRelativePath } from '../../utils/paths.js';
import { resolveWbTnvedPolicy, WbRepository, type WbMediaAsset } from '../../repositories/wb.js';
import type { PurchaseRepository } from '../../repositories/purchases.js';
import { N8nWbClient, type WbExistingCardBaseline, type WbRuntimeSyncResult } from './n8n-client.js';
import type { WbTaskNotificationPort } from './notification-port.js';
import { wbTaskErrorDetails } from './task-error.js';
import {
  nextWbNetworkRecovery,
  nextWbReadableAmbiguityRecovery
} from '../wb-network-recovery.js';
import { latestManifestImageOrderErrors } from '../manifest-media-order.js';
import { withWbSourceMediaSkuLock } from '../wb-source-media/sku-lock.js';

type JsonRecord = Record<string, any>;
type WbCharacteristicScalar = string | number | boolean;
type WbCharacteristicValue = WbCharacteristicScalar | WbCharacteristicScalar[];
type WbCharacteristic = { id: number; value: WbCharacteristicValue };
type WbGenerationWarning = {
  code: 'WB_DESCRIPTION_TRUNCATED';
  field: string;
  severity: 'WARNING';
  message: string;
  originalLength: number;
  finalLength: number;
  maxLength: number;
  limitSource: string;
};

export type WbPublishingReadiness = {
  status: 'DISABLED' | 'NOT_CONFIGURED' | 'DIRECTORY_UNAVAILABLE' | 'SYNC_PENDING' | 'READY';
  complete: boolean;
  enabled: boolean;
  rootDirectory: string;
  derivedDirectoryPattern: string;
  local?: PathValidation;
  n8nSync: WbRuntimeSyncResult;
};

type WbProductIdentityPort = Pick<PurchaseRepository, 'listProductVariants'>;
type WbPublishingPorts = WbProductIdentityPort & Partial<WbTaskNotificationPort>;

export type WbStorePublicationPackageInput = {
  sku: string;
  generatedVersionId: string;
  revision: number;
  publicationId: string;
  taskId: string;
  idempotencyKey: string;
  storeId: string;
  storeAlias: string;
  credentialVersionId?: string;
  storeConfigVersion: number;
  warehouseId: string;
  submissionMode: WbSubmissionMode;
  mediaPolicy: WbMediaPolicy;
  mediaTargetVendorCodes?: string[];
  automationRunId?: string;
  existingCardBaseline?: WbExistingCardBaseline[];
  materializationHash?: string;
};

export type WbStorePublicationPackage = {
  markerPath: string;
  productSha256: string;
  sourceContentSignature: string;
  packageRelPath: string;
  packageSignature: string;
  reused: boolean;
};

export class WbPublishingService {
  private n8nSync: WbRuntimeSyncResult = { status: 'disabled', message: '尚未检查 PostgreSQL runtime 配置' };

  constructor(
    private readonly config: ConfigService,
    readonly repository: WbRepository,
    readonly n8n = new N8nWbClient(),
    private readonly purchases?: WbPublishingPorts
  ) {}

  async productVariants(sku: string) { return this.purchases?.listProductVariants(sku) || []; }

  async storePublicationMediaTargetVendorCodes(sku: string, generatedVersionId: string): Promise<string[]> {
    const context = await this.repository.getGeneratedPackageContext(normalizeSku(sku), generatedVersionId);
    if (context.generationScope !== 'STORE_PUBLICATION') {
      throw storePackageError('VERSION_CONFLICT', 'WB 店铺发布媒体目标必须来自逐店铺物化版本', {
        sku,
        generatedVersionId,
        generationScope: context.generationScope
      });
    }
    return publicationVendorCodes(context.productJson);
  }

  async readiness(_refreshRemote = false): Promise<WbPublishingReadiness> {
    const settings = this.config.get().wbPublishing;
    const rootDirectory = settings.rootDirectory.trim();
    const derivedDirectoryPattern = rootDirectory ? path.join(rootDirectory, 'inbox', '<SKU>', 'variants') : '<WB 根目录>/inbox/<SKU>/variants';
    if (!settings.enabled) return { status: 'DISABLED', complete: false, enabled: false, rootDirectory, derivedDirectoryPattern, n8nSync: { status: 'disabled', message: 'WB 上品管理已停用' } };
    if (!rootDirectory) return { status: 'NOT_CONFIGURED', complete: false, enabled: true, rootDirectory, derivedDirectoryPattern, n8nSync: this.n8nSync };
    const local = await this.config.validatePath(rootDirectory);
    if (!local.exists || !local.readable || !local.writable) return { status: 'DIRECTORY_UNAVAILABLE', complete: false, enabled: true, rootDirectory, derivedDirectoryPattern, local, n8nSync: this.n8nSync };
    try {
      const runtime = await this.repository.getRuntimeConfig();
      const remoteRootDirectory = String(runtime.import_root || '');
      this.n8nSync = normalizeWbComparablePath(remoteRootDirectory) === normalizeWbComparablePath(rootDirectory)
        ? { status: 'synced', remoteRootDirectory, message: 'PostgreSQL runtime import_root 已同步' }
        : { status: 'pending', remoteRootDirectory, message: 'PostgreSQL runtime import_root 与 MerchRoute WB 根目录不一致' };
    } catch (error) {
      this.n8nSync = { status: 'pending', message: error instanceof Error ? error.message : 'PostgreSQL runtime 配置回读失败' };
    }
    const complete = this.n8nSync.status === 'synced' && normalizeWbComparablePath(this.n8nSync.remoteRootDirectory || '') === normalizeWbComparablePath(rootDirectory);
    return { status: complete ? 'READY' : 'SYNC_PENDING', complete, enabled: true, rootDirectory, derivedDirectoryPattern, local, n8nSync: this.n8nSync };
  }

  async assertGeneralConfigChange(next: WbPublishingConfig, linkedRootDirectory?: string): Promise<void> {
    const current = this.config.get().wbPublishing;
    if (current.enabled !== next.enabled) {
      throw new AppError('CONFIG_INVALID', '请使用 WB 自动上品的“保存并初始化”接口修改根目录', undefined, 409);
    }
    if (normalizeWbComparablePath(current.rootDirectory) === normalizeWbComparablePath(next.rootDirectory)) return;
    if (!linkedRootDirectory || normalizeWbComparablePath(linkedRootDirectory) !== normalizeWbComparablePath(next.rootDirectory)) {
      throw new AppError('CONFIG_INVALID', 'WB 根目录必须由 E004/E005 的共同输出目录模板推导', undefined, 409);
    }
    if (!this.repository.configured) return;
    await this.repository.withRootConfigurationLock(async (activeCount) => {
      if (activeCount > 0) throw new AppError('TASK_LOCKED', '存在正在生成或投递的 WB 上品任务，暂不能切换共享媒体根目录', { activeCount }, 409);
    });
  }

  async initializeSettings(input: unknown) {
    const parsed = wbPublishingConfigSchema.safeParse(input);
    if (!parsed.success) throw new AppError('CONFIG_INVALID', '无效的 WB 自动上品配置', { issues: parsed.error.issues });
    const next = { enabled: parsed.data.enabled, rootDirectory: parsed.data.rootDirectory.trim() };
    return this.repository.withRootConfigurationLock(async (activeCount) => {
      const current = this.config.get().wbPublishing;
      const rootChanged = normalizeWbComparablePath(current.rootDirectory) !== normalizeWbComparablePath(next.rootDirectory);
      if (rootChanged && activeCount > 0) {
        throw new AppError('TASK_LOCKED', '存在 GENERATING/SUBMITTING/QUEUED/RUNNING 的 WB 上品任务，暂不能切换根目录', { activeCount }, 409);
      }
      if (next.enabled) await this.config.initializeWbPublishingDirectory(next.rootDirectory);
      const saved = await this.config.saveWbPublishing(next);
      if (rootChanged) {
        if (current.rootDirectory) {
          for (const sku of await this.repository.listGeneratedSkus()) {
            const safe = await this.assertProductPathInsideRoot(current.rootDirectory, sku, false).catch(() => false);
            if (safe) await rm(path.join(this.productRoot(current.rootDirectory, sku), '_READY'), { force: true }).catch(() => undefined);
          }
        }
        await this.repository.markAllGeneratedStale();
      }
      if (next.enabled) {
        const runtime = await this.repository.upsertRuntimeConfig({ importRoot: next.rootDirectory, publish_enabled: true });
        this.n8nSync = { status: 'synced', remoteRootDirectory: String(runtime.import_root || next.rootDirectory), message: 'PostgreSQL runtime import_root 已同步' };
      } else {
        await this.repository.upsertRuntimeConfig({ publish_enabled: false }).catch(() => undefined);
        this.n8nSync = { status: 'disabled', message: 'WB 上品管理已停用' };
      }
      return { config: saved, wbPublishingReadiness: await this.readiness(false) };
    });
  }

  async syncSettings() {
    const settings = this.config.get().wbPublishing;
    if (!settings.enabled || !settings.rootDirectory) throw new AppError('CONFIG_INVALID', '请先启用并配置 WB 自动上品根目录', undefined, 409);
    await this.config.initializeWbPublishingDirectory(settings.rootDirectory);
    const runtime = await this.repository.upsertRuntimeConfig({ importRoot: settings.rootDirectory, publish_enabled: true });
    this.n8nSync = { status: 'synced', remoteRootDirectory: String(runtime.import_root || settings.rootDirectory), message: 'PostgreSQL runtime import_root 已同步' };
    return { config: this.config.get(), wbPublishingReadiness: await this.readiness(false) };
  }

  async createListing(sku: string) {
    return this.repository.withRootConfigurationLock(async () => {
      const root = await this.requireLocalRoot();
      const listing = await this.repository.createListing(sku);
      await this.ensureProductDirectories(root, listing.sku);
      return listing;
    });
  }

  async prepareListingDirectories(sku: string): Promise<void> {
    return this.repository.withRootConfigurationLock(async () => {
      const root = await this.requireLocalRoot();
      await this.ensureProductDirectories(root, sku);
    });
  }

  async restoreSubmittedMediaFromTask(sku: string, taskId: string): Promise<{ restored: boolean; source?: string; target?: string; reason?: string }> {
    return this.repository.withRootConfigurationLock(async () => {
      const root = await this.requireLocalRoot();
      const normalizedSku = normalizeSku(sku);
      const safeTaskId = String(taskId || '').trim();
      if (!safeTaskId || path.basename(safeTaskId) !== safeTaskId || !/^[A-Za-z0-9._-]+$/.test(safeTaskId)) {
        throw new AppError('CONFIG_INVALID', 'n8n 任务号格式无效，不能用于恢复媒体目录', { sku, taskId }, 409);
      }
      const rootReal = await realpath(root);
      const source = await findSubmittedTaskVariants(root, rootReal, safeTaskId);
      if (!source) return { restored: false, reason: 'SUBMITTED_TASK_DIRECTORY_MISSING' };
      await this.ensureProductDirectories(root, normalizedSku);
      const product = this.productRoot(root, normalizedSku);
      const target = this.variantsRoot(root, normalizedSku);
      if (await directoryHasAcceptedMedia(target)) return { restored: false, source, target, reason: 'INBOX_MEDIA_ALREADY_EXISTS' };
      await cp(source, target, { recursive: true, force: true });
      await rm(path.join(product, 'product.json'), { force: true }).catch(() => undefined);
      await rm(path.join(product, '_READY'), { force: true }).catch(() => undefined);
      return { restored: true, source, target };
    });
  }

  async initializeListing<T>(sku: string, initializer: () => Promise<T>): Promise<T> {
    return this.repository.withRootConfigurationLock(async () => {
      const root = await this.requireLocalRoot();
      await this.ensureProductDirectories(root, sku);
      return initializer();
    });
  }

  async updateListing(sku: string, input: unknown, options: { automatic?: boolean; operationRef?: string } = {}) {
    return this.repository.withRootConfigurationLock(async () => {
      const listing = await this.repository.updateListing(sku, input, { bypassAutoLock: options.automatic === true, operationRef: options.operationRef });
      const settings = this.config.get().wbPublishing;
      if (settings.rootDirectory && !['SUBMITTING', 'QUEUED', 'RUNNING'].includes(listing.status)) {
        await this.assertProductPathInsideRoot(settings.rootDirectory, sku, false);
        await rm(path.join(this.productRoot(settings.rootDirectory, sku), '_READY'), { force: true }).catch(() => undefined);
      }
      return listing;
    });
  }

  async scanMedia(sku: string, options: { automatic?: boolean } = {}) {
    return this.repository.withRootConfigurationLock(async () => {
      const root = await this.requireLocalRoot();
      await this.repository.getListing(sku);
      await this.ensureProductDirectories(root, sku);
      const variants = this.variantsRoot(root, sku);
      const assets = await scanMediaDirectory(this.productRoot(root, sku), variants);
      const listing = await this.repository.replaceMediaAssets(sku, assets, { bypassAutoLock: options.automatic === true });
      await rm(path.join(this.productRoot(root, sku), '_READY'), { force: true }).catch(() => undefined);
      return listing;
    });
  }

  async resolveMedia(sku: string, assetId: string): Promise<{ filePath: string; asset: WbMediaAsset }> {
    const root = await this.requireLocalRoot();
    await this.assertProductPathInsideRoot(root, sku, false);
    const asset = await this.repository.getMediaAsset(sku, assetId);
    const productRoot = this.productRoot(root, sku);
    const filePath = await secureResolve(productRoot, asset.relativePath);
    return { filePath, asset };
  }

  async generate(sku: string, draftVersion: number, options: { automatic?: boolean; operationRef?: string } = {}) {
    return this.repository.withRootConfigurationLock(async () => {
      const root = await this.requireLocalRoot();
      await this.ensureProductDirectories(root, sku);
      const reservation = await this.repository.reserveGeneration(sku, draftVersion, { bypassAutoLock: options.automatic === true, operationRef: options.operationRef });
      try {
        const currentAssets = await scanMediaDirectory(this.productRoot(root, sku), this.variantsRoot(root, sku));
        if (stableJson(currentAssets) !== stableJson(reservation.mediaAssets)) {
          await this.repository.failGeneration(sku, reservation.versionId, '媒体文件在上次扫描后已变更');
          const listing = await this.repository.replaceMediaAssets(sku, currentAssets, { bypassAutoLock: options.automatic === true });
          throw new AppError('VERSION_CONFLICT', '媒体文件已变更，草稿已标记过期，请检查后重新生成', { draftVersion: listing.draftVersion }, 409);
        }
        await validateTnvedCompliance(this.n8n, reservation);
        const compiled = compileProductJsonWithAudit(reservation);
        const { productJson } = compiled;
        const productDirectory = this.productRoot(root, sku);
        await rm(path.join(productDirectory, '_READY'), { force: true }).catch(() => undefined);
        const productJsonPath = path.join(productDirectory, 'product.json');
        await writeFileAtomic(productJsonPath, `${JSON.stringify(productJson, null, 2)}\n`);
        const listing = await this.repository.completeGeneration(sku, reservation.versionId, productJson, {
          assets: currentAssets,
          variantMedia: reservation.variantMedia,
          ...(compiled.generationWarnings.length ? { generationWarnings: compiled.generationWarnings } : {})
        });
        return { listing, productJson, productJsonPath };
      } catch (error) {
        if (!(error instanceof AppError && error.code === 'VERSION_CONFLICT')) {
          await this.repository.failGeneration(sku, reservation.versionId, error instanceof Error ? error.message : '生成 product.json 失败').catch(() => undefined);
        }
        throw error;
      }
    });
  }

  async prepareStorePublicationPackage(input: WbStorePublicationPackageInput): Promise<WbStorePublicationPackage> {
    const lockedSku = normalizeSku(input.sku);
    return withWbSourceMediaSkuLock(lockedSku, () => this.repository.withRootConfigurationLock(async () => {
      const readiness = await this.readiness(true);
      if (!readiness.complete) {
        throw storePackageError('CONFIG_INVALID', 'WB 上品目录或 n8n 运行配置尚未就绪', { readiness });
      }
      const sku = lockedSku;
      const context = await this.repository.getGeneratedPackageContext(sku, input.generatedVersionId);
      if (context.generationScope === 'STORE_PUBLICATION') {
        return this.prepareImmutableStorePublicationPackage(readiness.rootDirectory, input, context);
      }
      if (context.currentVersionId !== context.versionId || context.revision !== Number(input.revision)
        || context.versionStatus !== 'GENERATED' || context.draftStatus !== 'GENERATED') {
        throw storePackageError('VERSION_CONFLICT', 'WB 店铺发布绑定的生成版本已过期，请重新生成发布计划', {
          sku,
          generatedVersionId: input.generatedVersionId,
          currentVersionId: context.currentVersionId,
          revision: context.revision,
          versionStatus: context.versionStatus,
          draftStatus: context.draftStatus
        });
      }
      await this.assertProductPathInsideRoot(readiness.rootDirectory, sku, true);
      const productRoot = this.productRoot(readiness.rootDirectory, sku);
      const currentAssets = await scanMediaDirectory(productRoot, this.variantsRoot(readiness.rootDirectory, sku));
      if (stableJson(currentAssets) !== stableJson(asObject(context.mediaManifest).assets || [])) {
        throw storePackageError('VERSION_CONFLICT', '媒体文件已变更，请重新扫描并生成 product.json', { sku });
      }
      let productFile: unknown;
      try {
        productFile = JSON.parse(await readFile(path.join(productRoot, 'product.json'), 'utf8'));
      } catch (error: any) {
        if (error?.code === 'ENOENT') throw storePackageError('SOURCE_FILE_MISSING', 'product.json 不存在，请重新生成', { sku });
        throw storePackageError('VERIFY_FAILED', '磁盘 product.json 无法解析，请重新生成', {
          sku,
          reason: error instanceof Error ? error.message : String(error)
        });
      }
      if (stableJson(productFile) !== stableJson(context.productJson)) {
        throw storePackageError('VERIFY_FAILED', '磁盘 product.json 与已生成版本不一致，请重新生成', { sku });
      }
      const legacyReady = path.join(productRoot, '_READY');
      if (await pathExists(legacyReady)) {
        throw storePackageError('READY_SCOPE_CONFLICT', '共享目录仍存在 legacy _READY，已阻止多店铺任务与旧扫描器竞态', { sku });
      }
      const snapshot = await storePublicationSourceSnapshot(productRoot, productFile);
      const markerDirectory = path.join(productRoot, '.store-ready');
      const markerPath = path.join(markerDirectory, `${input.publicationId}.json`);
      const marker = storePublicationMarker(input, snapshot.productSha256, snapshot.sourceContentSignature);
      await mkdir(markerDirectory, { recursive: true });
      let reused = false;
      try {
        const existing = JSON.parse(await readFile(markerPath, 'utf8')) as JsonRecord;
        reused = stableJson(withoutReadyAt(existing)) === stableJson(withoutReadyAt(marker));
      } catch (error: any) {
        if (error?.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;
      }
      if (!reused) await writeFileAtomic(markerPath, `${JSON.stringify(marker, null, 2)}\n`);
      let readback: unknown;
      try { readback = JSON.parse(await readFile(markerPath, 'utf8')); }
      catch (error) {
        throw storePackageError('READY_WRITE_FAILED', 'WB 店铺发布就绪凭证写入后无法回读', {
          sku,
          publicationId: input.publicationId,
          reason: error instanceof Error ? error.message : String(error)
        });
      }
      if (stableJson(readback) !== stableJson(marker)) {
        throw storePackageError('READY_WRITE_FAILED', 'WB 店铺发布就绪凭证写入后身份不一致', {
          sku,
          publicationId: input.publicationId
        });
      }
      return {
        markerPath,
        productSha256: snapshot.productSha256,
        sourceContentSignature: snapshot.sourceContentSignature,
        packageRelPath: `inbox/${sku}`,
        packageSignature: snapshot.sourceContentSignature,
        reused
      };
    }));
  }

  private async prepareImmutableStorePublicationPackage(
    rootDirectory: string,
    input: WbStorePublicationPackageInput,
    context: Awaited<ReturnType<WbRepository['getGeneratedPackageContext']>>
  ): Promise<WbStorePublicationPackage> {
    if (context.revision !== Number(input.revision) || context.versionStatus !== 'GENERATED'
      || !input.materializationHash || context.materializationHash !== input.materializationHash) {
      throw storePackageError('VERSION_CONFLICT', 'WB 店铺物化版本身份或哈希不一致', {
        generatedVersionId: input.generatedVersionId,
        expectedRevision: input.revision,
        actualRevision: context.revision,
        expectedMaterializationHash: input.materializationHash,
        actualMaterializationHash: context.materializationHash
      });
    }
    if (input.mediaPolicy === 'REPLACE_SELECTED') {
      const expectedVendorCodes = publicationVendorCodes(context.productJson).sort();
      const actualVendorCodes = [...new Set(input.mediaTargetVendorCodes || [])].map(String).sort();
      if (stableJson(actualVendorCodes) !== stableJson(expectedVendorCodes)) {
        throw storePackageError('MEDIA_TARGETS_INVALID', '逐店铺发布包的媒体目标必须完整匹配物化版本变体', {
          expectedVendorCodes,
          actualVendorCodes
        });
      }
    }
    await this.assertProductPathInsideRoot(rootDirectory, input.sku, true);
    const sourceRoot = this.productRoot(rootDirectory, input.sku);
    const currentAssets = await scanMediaDirectory(sourceRoot, this.variantsRoot(rootDirectory, input.sku));
    if (stableJson(currentAssets) !== stableJson(asObject(context.mediaManifest).assets || [])) {
      throw storePackageError('VERSION_CONFLICT', '公共媒体文件已变化，请重新扫描并确认发布计划', { sku: input.sku });
    }
    const packageRelPath = ['stores', input.storeAlias, 'inbox', input.sku, input.publicationId].join('/');
    const target = path.resolve(rootDirectory, ...packageRelPath.split('/'));
    if (!isPathInside(rootDirectory, target)) {
      throw storePackageError('PATH_TRAVERSAL_BLOCKED', 'WB 店铺发布包路径越界', { packageRelPath });
    }
    const markerRelativePath = `.store-ready/${input.publicationId}.json`;
    const markerPath = path.join(target, ...markerRelativePath.split('/'));
    if (await pathExists(target)) {
      const productFile = JSON.parse(await readFile(path.join(target, 'product.json'), 'utf8'));
      const marker = JSON.parse(await readFile(markerPath, 'utf8')) as JsonRecord;
      const snapshot = await storePublicationSourceSnapshot(target, productFile);
      if (stableJson(productFile) !== stableJson(context.productJson)
        || String(marker.publicationId || '') !== input.publicationId
        || String(marker.generatedVersionId || '') !== input.generatedVersionId
        || String(marker.materializationHash || '') !== input.materializationHash
        || String(marker.sourceContentSignature || '') !== snapshot.sourceContentSignature) {
        throw storePackageError('STORE_PACKAGE_IDENTITY_MISMATCH', '已存在的 WB 店铺发布包身份或签名不一致', { packageRelPath });
      }
      return {
        markerPath,
        productSha256: snapshot.productSha256,
        sourceContentSignature: snapshot.sourceContentSignature,
        packageRelPath,
        packageSignature: snapshot.sourceContentSignature,
        reused: true
      };
    }
    const parent = path.dirname(target);
    await mkdir(parent, { recursive: true });
    const staging = path.join(parent, `.staging-${input.publicationId}-${randomUUID()}`);
    await mkdir(staging, { recursive: false });
    try {
      await writeFileAtomic(path.join(staging, 'product.json'), `${JSON.stringify(context.productJson, null, 2)}\n`);
      for (const relativePath of publicationMediaPaths(context.productJson)) {
        const source = await secureResolve(sourceRoot, relativePath);
        const destination = path.join(staging, ...relativePath.split('/'));
        const info = await lstat(source);
        if (info.isSymbolicLink() || !info.isFile()) {
          throw storePackageError('VERIFY_FAILED', 'WB 公共素材引用的媒体不是普通文件', { relativePath });
        }
        await mkdir(path.dirname(destination), { recursive: true });
        await cp(source, destination, { force: false });
      }
      const snapshot = await storePublicationSourceSnapshot(staging, context.productJson);
      const marker = {
        ...storePublicationMarker(input, snapshot.productSha256, snapshot.sourceContentSignature),
        schemaVersion: 2,
        packageRelPath,
        packageSignature: snapshot.sourceContentSignature,
        materializationHash: input.materializationHash
      };
      await mkdir(path.dirname(path.join(staging, ...markerRelativePath.split('/'))), { recursive: true });
      await writeFileAtomic(path.join(staging, ...markerRelativePath.split('/')), `${JSON.stringify(marker, null, 2)}\n`);
      await rename(staging, target);
      return {
        markerPath,
        productSha256: snapshot.productSha256,
        sourceContentSignature: snapshot.sourceContentSignature,
        packageRelPath,
        packageSignature: snapshot.sourceContentSignature,
        reused: false
      };
    } catch (error) {
      await rm(staging, { recursive: true, force: true }).catch(() => undefined);
      throw error;
    }
  }

  async cleanupStorePublicationPackage(input: Pick<WbStorePublicationPackageInput, 'sku' | 'generatedVersionId' | 'publicationId' | 'taskId'>): Promise<boolean> {
    return this.repository.withRootConfigurationLock(async () => {
      const context = await this.repository.getGeneratedPackageContext(input.sku, input.generatedVersionId);
      if (context.generationScope === 'STORE_PUBLICATION') return false;
      const root = await this.requireLocalRoot();
      const sku = normalizeSku(input.sku);
      const safe = await this.assertProductPathInsideRoot(root, sku, false);
      if (!safe) return false;
      const markerDirectory = path.join(this.productRoot(root, sku), '.store-ready');
      const markerPath = path.join(markerDirectory, `${input.publicationId}.json`);
      let marker: JsonRecord;
      try { marker = JSON.parse(await readFile(markerPath, 'utf8')) as JsonRecord; }
      catch (error: any) {
        if (error?.code === 'ENOENT') return false;
        throw storePackageError('STORE_READY_MARKER_INVALID', 'WB 店铺发布就绪凭证无法解析，拒绝误删', {
          sku,
          publicationId: input.publicationId
        });
      }
      if (String(marker.publicationId || '') !== input.publicationId
        || String(marker.taskId || '') !== input.taskId
        || String(marker.generatedVersionId || '') !== input.generatedVersionId
        || String(marker.sku || '') !== sku) {
        throw storePackageError('STORE_READY_MARKER_MISMATCH', 'WB 店铺发布就绪凭证身份不一致，拒绝误删', {
          sku,
          publicationId: input.publicationId
        });
      }
      await rm(markerPath, { force: true });
      const remaining = await readdir(markerDirectory).catch((error: NodeJS.ErrnoException) => error.code === 'ENOENT' ? [] : Promise.reject(error));
      if (!remaining.length) await rm(markerDirectory, { force: true }).catch(() => undefined);
      return true;
    });
  }

  async submit(sku: string, draftVersion: number, options: {
    automatic?: boolean; submissionMode?: WbSubmissionMode; mediaPolicy?: WbMediaPolicy;
    mediaTargetVendorCodes?: string[]; automationRunId?: string; automationRunNo?: number; operationRef?: string;
    existingCardBaseline?: WbExistingCardBaseline[];
  } = {}) {
    return this.repository.withRootConfigurationLock(async () => {
      const readiness = await this.readiness(true);
      if (!readiness.complete) throw new AppError('CONFIG_INVALID', 'WB 上品目录或 n8n 运行配置尚未就绪', { readiness }, 409);
      const context = await this.repository.beginSubmit(sku, draftVersion, { bypassAutoLock: options.automatic === true, operationRef: options.operationRef });
      const productRoot = this.productRoot(readiness.rootDirectory, sku);
      const readyMarker = path.join(productRoot, '_READY');
      let requestStarted = false;
      try {
        await this.assertProductPathInsideRoot(readiness.rootDirectory, sku, true);
        const currentAssets = await scanMediaDirectory(productRoot, this.variantsRoot(readiness.rootDirectory, sku));
        if (stableJson(currentAssets) !== stableJson(asObject(context.mediaManifest).assets || [])) {
          throw new AppError('VERSION_CONFLICT', '媒体文件已变更，请重新扫描并生成 product.json', undefined, 409);
        }
        let productFile: unknown;
        try { productFile = JSON.parse(await readFile(path.join(productRoot, 'product.json'), 'utf8')); }
        catch (error: any) {
          if (error?.code === 'ENOENT') throw new AppError('SOURCE_FILE_MISSING', 'product.json 不存在，请重新生成', undefined, 409);
          throw new AppError('VERIFY_FAILED', '磁盘 product.json 无法解析，请重新生成', { reason: error instanceof Error ? error.message : String(error) }, 409);
        }
        if (stableJson(productFile) !== stableJson(context.productJson)) throw new AppError('VERIFY_FAILED', '磁盘 product.json 与已生成版本不一致，请重新生成', undefined, 409);
        await writeFileAtomic(readyMarker, `${JSON.stringify({ sku, revision: context.revision, generatedVersionId: context.versionId, readyAt: new Date().toISOString() })}\n`);
        requestStarted = true;
        const task = await this.n8n.submitListing({
          folderName: sku, revision: context.revision, submissionMode: options.submissionMode || 'UPSERT',
          mediaPolicy: options.mediaPolicy, mediaTargetVendorCodes: options.mediaTargetVendorCodes,
          automationRunId: options.automationRunId,
          existingCardBaseline: options.existingCardBaseline
        });
        const listing = await this.repository.markQueued(sku, context.versionId, {
          ...task,
          ...(options.automatic && options.automationRunId ? {
            automationContext: {
              runId: options.automationRunId,
              runNo: Number(options.automationRunNo || 1),
              operationMode: options.submissionMode === 'COMPATIBLE_UPSERT' ? 'COMPATIBLE_UPSERT' : 'CREATE_ONLY'
            }
          } : {})
        });
        return { listing, task: task.raw };
      } catch (error) {
        await rm(readyMarker, { force: true }).catch(() => undefined);
        const recoveryError = error instanceof Error
          ? error
          : new AppError('VERIFY_FAILED', 'WB-P001 调用结果未知', { deliveryUnknown: true }, 502);
        const networkPlan = requestStarted ? nextWbNetworkRecovery({
          phase: 'SUBMIT_DISPATCH',
          resumeState: 'SUBMITTING',
          error: recoveryError,
          checkpoint: `taskId:${context.expectedTaskId}`
        }) : undefined;
        const deliveryUnknown = requestStarted && Boolean(networkPlan || !(error instanceof AppError) || error.details?.deliveryUnknown === true);
        await this.repository.recordSubmitFailure(sku, context.versionId, error instanceof Error ? error.message : 'WB-P001 调用失败', {
          deliveryUnknown,
          expectedTaskId: context.expectedTaskId,
          ...(networkPlan ? { networkRecovery: networkPlan.recovery } : {})
        });
        // recordSubmitFailure normally restores GENERATED/SUBMITTING. If a
        // future adapter persists a terminal result, the repository outbox is
        // the only supported notification path.
        await this.flushPendingListingNotifications(1, sku);
        throw error;
      }
    });
  }

  async status(sku: string) {
    const result = await this.reconcileTaskStatus(sku);
    return { ...result, productVariants: await this.productVariants(sku) };
  }

  async reconcileTaskStatus(sku: string) {
    let listing = await this.repository.getListing(sku);
    if (!listing.n8nTaskId) return { listing };
    try {
      const task = await this.n8n.getJob(listing.n8nTaskId);
      listing = await this.repository.updateTaskStatus(sku, listing.n8nTaskId, task);
      const delivery = await this.flushPendingListingNotifications(1, sku);
      const notificationError = delivery.errors[0];
      return { listing, task, ...(notificationError ? { notificationError } : {}) };
    } catch (error) {
      if (listing.status === 'SUBMITTING' && error instanceof AppError && error.code === 'JOB_NOT_FOUND') {
        const submittedAt = Date.parse(String(listing.submittedAt || ''));
        if (!Number.isFinite(submittedAt) || Date.now() - submittedAt < 30_000) {
          const pending = nextWbReadableAmbiguityRecovery({
            previous: listing.networkRecovery as WbNetworkRecovery | undefined,
            phase: 'SUBMIT_READBACK',
            resumeState: 'SUBMITTING',
            message: '任务刚提交，正在等待 n8n 完成台账登记',
            checkpoint: `taskId:${listing.n8nTaskId}`
          });
          const notBefore = Number.isFinite(submittedAt) ? submittedAt + 30_000 : Date.now() + pending.delayMs;
          pending.recovery.nextAttemptAt = new Date(Math.max(Date.parse(pending.recovery.nextAttemptAt), notBefore)).toISOString();
          listing = await this.repository.recordTaskNetworkRecovery(sku, listing.n8nTaskId, pending.recovery);
          return { listing, task: listing.task, pollError: pending.recovery.lastErrorMessage };
        }
        const root = this.config.get().wbPublishing.rootDirectory;
        const inboxExists = root ? await pathExists(this.productRoot(root, sku)) : false;
        const processingExists = root ? await pathExists(path.join(root, 'processing', listing.n8nTaskId)) : false;
        if (processingExists) {
          const pending = nextWbReadableAmbiguityRecovery({
            previous: listing.networkRecovery as WbNetworkRecovery | undefined,
            phase: 'SUBMIT_READBACK',
            resumeState: 'SUBMITTING',
            message: '商品目录已进入 processing，但 n8n 尚未恢复原任务台账',
            checkpoint: `taskId:${listing.n8nTaskId}`
          });
          listing = pending.needsAttention
            ? await this.repository.markTaskNeedsAttention(sku, listing.n8nTaskId, pending.recovery, '平台恢复可读后，原 WB 写入结果累计 24 小时仍无法确认，请按原 taskId 人工重新检查')
            : await this.repository.recordTaskNetworkRecovery(sku, listing.n8nTaskId, pending.recovery);
          return { listing, task: listing.task, pollError: pending.needsAttention ? undefined : pending.recovery.lastErrorMessage };
        }
        if (inboxExists) {
          listing = await this.repository.recordSubmitFailure(sku, listing.generatedVersionId, 'n8n 未登记该幂等任务，已恢复为可提交状态', {
            deliveryUnknown: false, expectedTaskId: listing.n8nTaskId
          });
          await rm(path.join(this.productRoot(root, sku), '_READY'), { force: true }).catch(() => undefined);
          return { listing, pollError: 'n8n 未登记任务，目录仍在 inbox，已恢复为可提交状态' };
        }
        const pending = nextWbReadableAmbiguityRecovery({
          previous: listing.networkRecovery as WbNetworkRecovery | undefined,
          phase: 'SUBMIT_READBACK',
          resumeState: 'SUBMITTING',
          message: 'n8n 未登记任务，且无法确认商品目录位置；已保持原 taskId 等待确认',
          checkpoint: `taskId:${listing.n8nTaskId}`
        });
        listing = pending.needsAttention
          ? await this.repository.markTaskNeedsAttention(sku, listing.n8nTaskId, pending.recovery, '平台恢复可读后，原 WB 写入结果累计 24 小时仍无法确认，请按原 taskId 人工重新检查')
          : await this.repository.recordTaskNetworkRecovery(sku, listing.n8nTaskId, pending.recovery);
        return { listing, task: listing.task, pollError: pending.needsAttention ? undefined : pending.recovery.lastErrorMessage };
      }
      if (['SUBMITTING', 'QUEUED', 'RUNNING'].includes(listing.status)) {
        const networkPlan = nextWbNetworkRecovery({
          previous: listing.networkRecovery as WbNetworkRecovery | undefined,
          phase: 'TASK_STATUS_READBACK',
          resumeState: listing.status,
          error,
          checkpoint: `taskId:${listing.n8nTaskId}`
        });
        if (networkPlan) {
          listing = await this.repository.recordTaskNetworkRecovery(sku, listing.n8nTaskId, networkPlan.recovery);
          return { listing, task: listing.task, pollError: networkPlan.recovery.lastErrorMessage };
        }
      }
      return { listing, task: listing.task, pollError: error instanceof Error ? error.message : 'WB 任务回读失败' };
    }
  }

  async notifyAutoPublishFailure(input: {
    jobId?: string;
    storeId?: string;
    sku: string;
    state: string;
    jobCreatedAt: string;
    runId?: string;
    runNo?: number;
    operationMode?: 'CREATE_ONLY' | 'COMPATIBLE_UPSERT';
    errorCode: string;
    errorMessage: string;
    presetName?: string;
    taskId?: string;
  }): Promise<string | undefined> {
    if (!this.purchases?.upsertNotification) return '消息中心通知端口未配置';
    try {
      const notificationIdentity = autoPublishNotificationIdentity(input);
      await this.purchases.upsertNotification({
        dedupeKey: `WB_AUTO_PUBLISH_FAILED:${notificationIdentity}`,
        category: 'WB_LISTING',
        eventType: 'WB_AUTO_PUBLISH_FAILED',
        severity: 'ERROR',
        title: `WB ${input.operationMode === 'COMPATIBLE_UPSERT' ? '兼容重新上品' : '自动创建'}失败 · ${input.sku}`,
        message: `${input.runNo ? `第 ${input.runNo} 轮 · ` : ''}${input.errorMessage}`,
        sourceType: 'WB_AUTO_PUBLISH_JOB',
        // The task id may only appear after a retry. Keep source identity stable
        // for the lifetime of this one-SKU job and store taskId in details only.
        sourceId: notificationIdentity,
        sku: input.sku,
        details: {
          sku: input.sku,
          status: input.state,
          source: 'AUTOMATION',
          ...(input.jobId ? { autoPublishJobId: input.jobId } : {}),
          ...(input.storeId ? { storeId: input.storeId } : {}),
          operationMode: input.operationMode || 'CREATE_ONLY',
          operationLabel: input.operationMode === 'COMPATIBLE_UPSERT' ? '兼容重新上品' : '自动创建',
          ...(input.runId ? { automationRunId: input.runId } : {}),
          ...(input.runNo ? { runNo: input.runNo } : {}),
          errorCode: input.errorCode,
          errorMessage: input.errorMessage,
          ...(input.presetName ? { presetName: input.presetName } : {}),
          ...(input.taskId ? { taskId: input.taskId } : {})
        }
      });
      return undefined;
    } catch (error) {
      return error instanceof Error ? error.message : 'WB 自动上品失败通知写入失败';
    }
  }

  async resolveAutoPublishFailure(input: {
    jobId?: string;
    storeId?: string;
    runId?: string;
    sku: string;
    jobCreatedAt: string;
    state: string;
  }): Promise<string | undefined> {
    if (!this.purchases?.resolveNotifications) return '消息中心通知解决端口未配置';
    try {
      await this.purchases.resolveNotifications({
        dedupeKey: `WB_AUTO_PUBLISH_FAILED:${autoPublishNotificationIdentity(input)}`,
        details: {
          resolvedBy: 'WB_AUTO_PUBLISH_COORDINATOR',
          resolvedState: input.state,
          resolvedAt: new Date().toISOString()
        }
      });
      return undefined;
    } catch (error) {
      return error instanceof Error ? error.message : 'WB 自动上品失败通知解决失败';
    }
  }

  async flushPendingListingNotifications(limit = 25, sku?: string): Promise<{ delivered: number; errors: string[] }> {
    let pending;
    try {
      pending = await this.repository.listPendingTerminalNotifications(limit, sku);
    } catch (error) {
      return { delivered: 0, errors: [error instanceof Error ? error.message : 'WB 上品待投递通知读取失败'] };
    }
    let delivered = 0;
    const errors: string[] = [];
    for (const candidate of pending) {
      try {
        await this.repository.withTerminalNotificationLock(candidate.versionId, async () => {
          const item = await this.repository.getPendingTerminalNotification(candidate.versionId);
          if (!item) return;
          const notificationError = await this.notifyListingTerminal(item.listing);
          if (notificationError) {
            errors.push(`${item.sku}: ${notificationError}`);
            return;
          }
          const acknowledged = await this.repository.markTerminalNotificationDelivered(item.versionId, item.expectedStatus);
          if (acknowledged) delivered += 1;
        });
      } catch (error) {
        // The message has a stable dedupe key, so leaving the marker armed is
        // safe: the next pass replays the same notification and retries only
        // the acknowledgement.
        errors.push(`${candidate.sku}: ${error instanceof Error ? error.message : 'WB 上品通知确认失败'}`);
      }
    }
    return { delivered, errors };
  }

  private async notifyListingTerminal(listing: JsonRecord): Promise<string | undefined> {
    const status = String(listing.status || '');
    if (status !== 'SUCCEEDED' && status !== 'FAILED' && status !== 'BLOCKED' && status !== 'NEEDS_ATTENTION') return undefined;
    if (!this.purchases?.upsertNotification) return '消息中心通知端口未配置';
    const failed = status === 'FAILED' || status === 'BLOCKED' || status === 'NEEDS_ATTENTION';
    const outcome = failed ? 'FAILED' : 'SUCCEEDED';
    const sku = String(listing.sku || '');
    const taskId = String(listing.n8nTaskId || listing.generatedVersionId || '');
    if (!taskId) return 'WB 上品终态通知缺少任务或版本身份';
    const productName = String(listing.productName || '').trim();
    const taskError = failed ? wbTaskErrorDetails(listing) : undefined;
    const errorMessage = taskError?.errorMessage || '';
    const nmIds = Array.isArray(listing.nmIds) ? listing.nmIds : [];
    const productUrls = Array.isArray(listing.productUrls) ? listing.productUrls : [];
    const automationContext = asObject(listing.automationContext);
    const automationRunId = String(automationContext.runId || '');
    const automationRunNo = Number(automationContext.runNo || 0);
    const automatic = Boolean(automationRunId) || listing.autoPublishLocked === true;
    const automationMode = automationContext.operationMode === 'COMPATIBLE_UPSERT' ? 'COMPATIBLE_UPSERT' : 'CREATE_ONLY';
    const operationLabel = automationMode === 'COMPATIBLE_UPSERT' ? '兼容重新上品' : '自动创建';
    const runLabel = automationRunNo > 0 ? ` · 第 ${automationRunNo} 轮` : '';
    try {
      await this.purchases.upsertNotification({
        dedupeKey: `WB_LISTING_TERMINAL:${sku}:${taskId}:${outcome}`,
        category: 'WB_LISTING',
        eventType: failed ? 'WB_LISTING_FAILED' : 'WB_LISTING_SUCCEEDED',
        severity: failed ? 'ERROR' : 'SUCCESS',
        title: `${failed ? `WB ${automatic ? operationLabel : '上品'}失败` : `WB ${automatic ? operationLabel : '上品'}完成`} · ${sku}`,
        message: failed
          ? `${errorMessage || 'WB 上品任务执行失败，请打开上品工作台查看详情'}${automatic ? runLabel : ''}`
          : `${automatic ? `${operationLabel}${runLabel}已完成` : 'WB 商品资料已完成同步'}${nmIds.length ? `，共 ${nmIds.length} 张商品卡` : ''}`,
        sourceType: 'WB_LISTING',
        sourceId: taskId,
        sku,
        ...(productName ? { productName } : {}),
        details: {
          sku,
          status: outcome,
          source: automatic ? 'AUTOMATION' : 'MANUAL',
          ...(automatic ? { operationMode: automationMode, operationLabel, runNo: automationRunNo || 1, ...(automationRunId ? { automationRunId } : {}) } : {}),
          ...(listing.n8nTaskId ? { taskId } : { generatedVersionId: taskId }),
          nmIds,
          productUrls,
          ...(taskError?.errorCode ? { errorCode: taskError.errorCode } : {}),
          ...(errorMessage ? { errorMessage } : {})
        }
      });
      if (!failed) {
        if (!this.purchases.resolveNotifications) return '消息中心通知解决端口未配置';
        // A remote task should not normally change terminal outcome, but WB/n8n
        // recovery can correct FAILED/BLOCKED to SUCCEEDED. Preserve the success
        // message and close the older stable failure thread in the same outbox
        // attempt before acknowledging delivery.
        await this.purchases.resolveNotifications({
          dedupeKey: `WB_LISTING_TERMINAL:${sku}:${taskId}:FAILED`,
          details: {
            resolvedBy: 'WB_LISTING_SUCCEEDED',
            resolvedAt: new Date().toISOString()
          }
        });
      }
      return undefined;
    } catch (error) {
      return error instanceof Error ? error.message : 'WB 上品终态通知写入失败';
    }
  }

  async syncCategory(categoryKey: string) {
    const category = await this.repository.getPublishedCategory(categoryKey);
    await this.repository.setProjection(categoryKey, { status: 'PENDING', sourceVersionId: category.id, schemaHash: category.schemaHash });
    const tnvedPolicy = resolveWbTnvedPolicy(category.formConfig, category.liveSchema);
    const compliance = {
      tnvedCharacteristicId: tnvedPolicy.characteristicId,
      tnvedRequired: tnvedPolicy.required
    };
    const expectedDefinitionHash = `sha256:${createHash('sha256').update(stableJson({
      categoryKey: category.categoryKey,
      subjectId: category.subjectId,
      templateVersion: category.versionNo,
      schemaHash: category.schemaHash,
      liveSchema: category.liveSchema,
      formConfig: category.formConfig,
      managedCharacteristicIds: category.managedCharacteristicIds,
      compliance
    })).digest('hex')}`;
    const projection = {
      sourceVersionId: category.id,
      categoryKey: category.categoryKey,
      subjectId: category.subjectId,
      subjectName: category.nameRu,
      templateVersion: category.versionNo,
      schemaHash: category.schemaHash,
      liveSchema: category.liveSchema,
      formConfig: category.formConfig,
      managedCharacteristicIds: category.managedCharacteristicIds,
      compliance,
      confirmedBy: category.confirmedBy,
      confirmedAt: category.confirmedAt,
      enabled: true
    };
    try {
      const updated = await this.repository.setProjection(categoryKey, {
        status: 'SYNCED', sourceVersionId: category.id, schemaHash: category.schemaHash,
        definitionHash: expectedDefinitionHash, syncedAt: new Date().toISOString()
      });
      return { category: updated, projection };
    } catch (error) {
      await this.repository.setProjection(categoryKey, { status: 'FAILED', sourceVersionId: category.id, schemaHash: category.schemaHash, lastError: error instanceof Error ? error.message : '类目投影同步失败' });
      throw error;
    }
  }

  async deleteCategory(categoryKey: string) {
    await this.repository.assertCategoryDeletable(categoryKey);
    const deletedCategory = await this.repository.deleteCategory(categoryKey);
    return { deletedCategoryKey: categoryKey, deletedCategory, projection: { status: 'DELETED_FROM_POSTGRESQL' } };
  }

  private async requireLocalRoot(): Promise<string> {
    const settings = this.config.get().wbPublishing;
    if (!settings.enabled || !settings.rootDirectory) throw new AppError('CONFIG_INVALID', '请先在 WB上品页面的“WB上品设置”中启用并配置自动上品根目录', undefined, 409);
    const local = await this.config.validatePath(settings.rootDirectory);
    if (!local.exists || !local.readable || !local.writable) throw new AppError('PATH_NOT_WRITABLE', 'WB 自动上品根目录当前不可读写', { local }, 409);
    return settings.rootDirectory;
  }

  private async ensureProductDirectories(root: string, sku: string): Promise<void> {
    const normalizedSku = normalizeSku(sku);
    const rootReal = await realpath(root);
    const product = this.productRoot(root, normalizedSku);
    const inbox = path.dirname(product);
    await mkdir(inbox, { recursive: true });
    const inboxReal = await assertRealDirectoryInside(rootReal, inbox, 'WB inbox');
    await mkdir(product, { recursive: true });
    const productReal = await assertRealDirectoryInside(inboxReal, product, 'WB 商品目录');
    const variants = this.variantsRoot(root, normalizedSku);
    await mkdir(variants, { recursive: true });
    await assertRealDirectoryInside(productReal, variants, 'WB variants 目录');
  }

  private async assertProductPathInsideRoot(root: string, sku: string, requireExisting: boolean): Promise<boolean> {
    const normalizedSku = normalizeSku(sku);
    const rootReal = await realpath(root);
    const product = this.productRoot(root, normalizedSku);
    const inbox = path.dirname(product);
    const inboxInfo = await lstat(inbox).catch((error: NodeJS.ErrnoException) => error.code === 'ENOENT' ? undefined : Promise.reject(error));
    if (!inboxInfo) {
      if (requireExisting) throw new AppError('SOURCE_FILE_MISSING', 'WB inbox 目录不存在', { inbox }, 409);
      return false;
    }
    const inboxReal = await assertRealDirectoryInside(rootReal, inbox, 'WB inbox');
    const productInfo = await lstat(product).catch((error: NodeJS.ErrnoException) => error.code === 'ENOENT' ? undefined : Promise.reject(error));
    if (!productInfo) {
      if (requireExisting) throw new AppError('SOURCE_FILE_MISSING', 'WB 商品目录不存在', { product }, 409);
      return false;
    }
    const productReal = await assertRealDirectoryInside(inboxReal, product, 'WB 商品目录');
    const variants = this.variantsRoot(root, normalizedSku);
    const variantsInfo = await lstat(variants).catch((error: NodeJS.ErrnoException) => error.code === 'ENOENT' ? undefined : Promise.reject(error));
    if (variantsInfo) await assertRealDirectoryInside(productReal, variants, 'WB variants 目录');
    return true;
  }

  private productRoot(root: string, sku: string): string {
    return path.dirname(this.variantsRoot(root, sku));
  }
  private variantsRoot(root: string, sku: string): string {
    const normalizedSku = normalizeSku(sku);
    const template = this.config.get().stages.find((stage) => stage.id === 'E004')?.outputRoot;
    return template ? resolveWbMediaOutputRoot(template, normalizedSku) : path.join(root, 'inbox', normalizedSku, 'variants');
  }
}

export async function validateTnvedCompliance(n8n: N8nWbClient, reservation: JsonRecord): Promise<void> {
  const data = asObject(reservation.data);
  const compliance = asObject(data.compliance);
  const category = asObject(reservation.category);
  const policy = resolveWbTnvedPolicy(asObject(category.formConfig), category.liveSchema);
  const tnved = normalizeTnved(compliance.tnved);
  const kizMarked = compliance.kizMarked === true;
  if (!tnved) {
    if (policy.required) throw new AppError('CONFIG_INVALID', 'TNVED为必填项目', { subjectId: category.subjectId }, 409);
    if (kizMarked) throw new AppError('CONFIG_INVALID', 'TNVED 为空时不能保留 KIZ 标记', undefined, 409);
    return;
  }
  if (!/^\d{10}$/.test(tnved)) throw new AppError('CONFIG_INVALID', 'TNVED 必须为 10 位数字', { tnved }, 409);
  if (!policy.supported) throw new AppError('CONFIG_INVALID', '当前 WB 类目不使用 TNVED，请清空该字段', { tnved }, 409);
  const subjectId = Number(category.subjectId || 0);
  if (!Number.isInteger(subjectId) || subjectId < 1) {
    throw new AppError('CONFIG_INVALID', '无法核对 TNVED：WB subject ID 无效', { subjectId }, 409);
  }
  const directory = await n8n.getDirectory('tnved', { subjectId, search: tnved, locale: 'ru' });
  const entry = directoryRows(directory).find((row) => normalizeTnved(row.tnved) === tnved);
  if (!entry) {
    throw new AppError('CONFIG_INVALID', `WB TNVED 目录中未找到编码 ${tnved}`, { subjectId, tnved }, 409);
  }
  const expectedKizMarked = parseWbBoolean(entry.isKiz);
  if (expectedKizMarked === undefined) {
    throw new AppError('VERIFY_FAILED', `WB TNVED ${tnved} 未返回有效的 isKiz`, { subjectId, tnved, isKiz: entry.isKiz }, 502);
  }
  const actualKizMarked = kizMarked;
  if (actualKizMarked !== expectedKizMarked) {
    throw new AppError(
      'CONFIG_INVALID',
      `TNVED ${tnved} 要求 KIZ 标记为“${expectedKizMarked ? '是' : '否'}”，请修正后重新生成`,
      { subjectId, tnved, expectedKizMarked, actualKizMarked },
      409
    );
  }
}

function directoryRows(input: unknown): JsonRecord[] {
  if (Array.isArray(input)) return input.map(asObject);
  const record = asObject(input);
  for (const candidate of [record.data, record.items, record.result]) {
    if (Array.isArray(candidate)) return candidate.map(asObject);
  }
  return [];
}

function normalizeTnved(input: unknown): string {
  return String(input ?? '').trim();
}

function parseWbBoolean(input: unknown): boolean | undefined {
  if (typeof input === 'boolean') return input;
  if (input === 1 || input === '1') return true;
  if (input === 0 || input === '0') return false;
  if (typeof input !== 'string') return undefined;
  const normalized = input.trim().toLocaleLowerCase('ru-RU');
  if (['true', 'yes', 'да'].includes(normalized)) return true;
  if (['false', 'no', 'нет'].includes(normalized)) return false;
  return undefined;
}

async function pathExists(candidate: string): Promise<boolean> {
  return lstat(candidate).then(() => true).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return false;
    throw error;
  });
}

async function findSubmittedTaskVariants(root: string, rootReal: string, taskId: string): Promise<string | undefined> {
  for (const bucket of ['processing', 'failed']) {
    const bucketPath = path.join(root, bucket);
    const bucketInfo = await lstat(bucketPath).catch((error: NodeJS.ErrnoException) => error.code === 'ENOENT' ? undefined : Promise.reject(error));
    if (!bucketInfo) continue;
    const bucketReal = await assertRealDirectoryInside(rootReal, bucketPath, `WB ${bucket} 目录`);
    const taskRoot = path.join(bucketPath, taskId);
    const taskInfo = await lstat(taskRoot).catch((error: NodeJS.ErrnoException) => error.code === 'ENOENT' ? undefined : Promise.reject(error));
    if (!taskInfo) continue;
    const taskReal = await assertRealDirectoryInside(bucketReal, taskRoot, 'WB 已提交任务目录');
    const variants = path.join(taskRoot, 'variants');
    const variantsInfo = await lstat(variants).catch((error: NodeJS.ErrnoException) => error.code === 'ENOENT' ? undefined : Promise.reject(error));
    if (!variantsInfo) continue;
    await assertRealDirectoryInside(taskReal, variants, 'WB 已提交任务 variants 目录');
    return variants;
  }
  return undefined;
}

async function directoryHasAcceptedMedia(directory: string): Promise<boolean> {
  const info = await lstat(directory).catch((error: NodeJS.ErrnoException) => error.code === 'ENOENT' ? undefined : Promise.reject(error));
  if (!info) return false;
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new AppError('PATH_TRAVERSAL_BLOCKED', 'WB variants 目录必须是真实目录，不能是符号链接或文件', { directory });
  }
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) throw new AppError('PATH_TRAVERSAL_BLOCKED', 'variants 目录中不允许存在符号链接', { path: target });
    if (entry.isDirectory() && await directoryHasAcceptedMedia(target)) return true;
    if (entry.isFile() && ['.jpg', '.jpeg', '.png', '.webp', '.mp4', '.mov'].includes(path.extname(entry.name).toLocaleLowerCase('en-US'))) return true;
  }
  return false;
}

async function scanMediaDirectory(productRoot: string, variantsRoot: string): Promise<WbMediaAsset[]> {
  await mkdir(variantsRoot, { recursive: true });
  const resolvedRoot = await realpath(variantsRoot);
  const manifest = await readVariantMediaManifest(path.join(variantsRoot, 'variant-media-manifest.json'));
  const orderErrors = latestManifestImageOrderErrors(manifest);
  if (orderErrors.length) {
    throw new AppError(
      'MEDIA_MANIFEST_INVALID',
      `WB 媒体清单的最新 E005 图片批次顺序无效：${orderErrors.map((error) => error.message).join('；')}`,
      { errors: orderErrors },
      409
    );
  }
  const manifestByPath = new Map(manifest.map((item) => [String(item.relativePath || '').replaceAll('\\', '/'), item]));
  const files: string[] = [];
  await walk(variantsRoot, files);
  const collisions = new Map<string, string>();
  const assets: WbMediaAsset[] = [];
  for (const filePath of files.sort((left, right) => left.localeCompare(right, 'en'))) {
    const resolved = await realpath(filePath);
    if (!isPathInside(resolvedRoot, resolved)) throw new AppError('PATH_TRAVERSAL_BLOCKED', '媒体文件真实路径超出 variants 目录', { filePath });
    const relativePath = toApiRelativePath(path.relative(productRoot, filePath));
    const collisionKey = relativePath.normalize('NFC').toLocaleLowerCase('en-US');
    if (collisions.has(collisionKey)) throw new AppError('CONFIG_INVALID', '媒体目录存在 Unicode 或大小写冲突文件', { paths: [collisions.get(collisionKey), relativePath] });
    collisions.set(collisionKey, relativePath);
    const extension = path.extname(filePath).toLocaleLowerCase('en-US');
    if (!['.jpg', '.jpeg', '.png', '.webp', '.mp4', '.mov'].includes(extension)) continue;
    const inspected = await inspectMedia(filePath, relativePath, extension);
    const described = manifestByPath.get(relativePath);
    if (described && described.sha256 === inspected.sha256 && described.kind === inspected.kind) {
      if (typeof described.sortOrder === 'number' && Number.isInteger(described.sortOrder) && described.sortOrder >= 0) {
        inspected.sortOrder = Number(described.sortOrder);
      }
      inspected.productVariantId = typeof described.variantId === 'string' ? described.variantId : undefined;
      inspected.productVariantName = typeof described.variantName === 'string' ? described.variantName : undefined;
      const variantColor = asObject(described.variantColor);
      if (/^[a-f0-9]{64}$/.test(String(variantColor.colorKey || '')) && typeof variantColor.nameRu === 'string' && typeof variantColor.nameZh === 'string') {
        inspected.productVariantColor = { colorKey: String(variantColor.colorKey), nameRu: variantColor.nameRu, nameZh: variantColor.nameZh };
      }
      inspected.sourceStageId = typeof described.sourceStageId === 'string' ? described.sourceStageId : undefined;
      inspected.sourceSubmissionId = typeof described.submissionId === 'string' ? described.submissionId : undefined;
      inspected.deliveredAt = typeof described.deliveredAt === 'string' ? described.deliveredAt : undefined;
    }
    assets.push(inspected);
  }
  return assets;
}

async function readVariantMediaManifest(file: string): Promise<Array<Record<string, any>>> {
  try {
    const parsed = JSON.parse(await readFile(file, 'utf8')) as { schemaVersion?: unknown; assets?: unknown };
    if (![1, 2].includes(Number(parsed.schemaVersion)) || !Array.isArray(parsed.assets)) return [];
    return parsed.assets.filter((item): item is Record<string, any> => Boolean(item) && typeof item === 'object' && !Array.isArray(item));
  } catch {
    return [];
  }
}

async function walk(directory: string, files: string[]): Promise<void> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) throw new AppError('PATH_TRAVERSAL_BLOCKED', 'variants 目录中不允许存在符号链接', { path: target });
    if (entry.isDirectory()) await walk(target, files);
    else if (entry.isFile()) files.push(target);
  }
}

async function inspectMedia(filePath: string, relativePath: string, extension: string): Promise<WbMediaAsset> {
  const before = await lstat(filePath);
  const kind: 'image' | 'video' = ['.mp4', '.mov'].includes(extension) ? 'video' : 'image';
  const maxBytes = kind === 'video' ? 50 * 1024 * 1024 : 10 * 1024 * 1024;
  let validationError = before.size === 0 ? '文件为空' : before.size > maxBytes ? `${kind === 'video' ? '视频' : '图片'}超过 ${maxBytes / 1024 / 1024}MB` : undefined;
  const handle = await open(filePath, 'r');
  const header = Buffer.alloc(16);
  try { await handle.read(header, 0, header.length, 0); } finally { await handle.close(); }
  const mimeType = detectMime(header, extension);
  if (!mimeType) validationError ||= '文件签名与扩展名不匹配';
  if (kind === 'image' && mimeType) {
    try {
      // Decode from an in-memory buffer so libvips never retains a Windows file handle.
      const metadata = await sharp(await readFile(filePath)).metadata();
      if (!metadata.width || !metadata.height) validationError ||= '无法读取图片尺寸';
    } catch {
      validationError ||= '图片文件无法解码';
    }
  }
  const sha256 = await hashFile(filePath);
  const after = await lstat(filePath);
  if (before.size !== after.size || before.mtimeMs !== after.mtimeMs) validationError ||= '文件仍在复制或写入';
  const assetId = createHash('sha256').update(`${relativePath}\0${sha256}`).digest('hex');
  return {
    assetId, relativePath, kind, mimeType: mimeType || 'application/octet-stream', sizeBytes: after.size, sha256,
    modifiedAt: after.mtime.toISOString(), validationStatus: validationError ? 'INVALID' : 'VALID', ...(validationError ? { validationError } : {})
  };
}

function detectMime(header: Buffer, extension: string): string | undefined {
  if ((extension === '.jpg' || extension === '.jpeg') && header[0] === 0xff && header[1] === 0xd8 && header[2] === 0xff) return 'image/jpeg';
  if (extension === '.png' && header.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (extension === '.webp' && header.subarray(0, 4).toString('ascii') === 'RIFF' && header.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
  if ((extension === '.mp4' || extension === '.mov') && header.subarray(4, 8).toString('ascii') === 'ftyp') return extension === '.mov' ? 'video/quicktime' : 'video/mp4';
  return undefined;
}

async function hashFile(filePath: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filePath)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

async function storePublicationSourceSnapshot(productRoot: string, productJson: unknown): Promise<{
  productSha256: string;
  sourceContentSignature: string;
}> {
  const paths = new Set<string>(['product.json', ...publicationMediaPaths(productJson)]);
  for (const manifest of ['variants/variant-media-manifest.json', 'variant-media-manifest.json']) {
    if (await pathExists(path.join(productRoot, ...manifest.split('/')))) paths.add(manifest);
  }
  const rows: Array<{ relativePath: string; size: number; sha256: string }> = [];
  // Keep the byte ordering identical to S000's JavaScript default sort so
  // non-ASCII media paths produce the same publication content signature on
  // Windows and macOS.
  for (const relativePathValue of [...paths].sort()) {
    const relativePath = relativePathValue.replaceAll('\\', '/');
    if (!relativePath || path.posix.isAbsolute(relativePath)
      || relativePath.split('/').some((part) => !part || part === '.' || part === '..')) {
      throw storePackageError('VERIFY_FAILED', 'product.json 引用了不安全的媒体路径', { relativePath });
    }
    const filePath = await secureResolve(productRoot, relativePath);
    const info = await lstat(filePath);
    if (info.isSymbolicLink() || !info.isFile()) {
      throw storePackageError('VERIFY_FAILED', 'WB 店铺发布源文件必须是真实文件', { relativePath });
    }
    rows.push({ relativePath, size: info.size, sha256: `sha256:${await hashFile(filePath)}` });
  }
  const productRow = rows.find((row) => row.relativePath === 'product.json');
  if (!productRow) throw storePackageError('VERIFY_FAILED', 'WB 店铺发布源文件缺少 product.json');
  return {
    productSha256: productRow.sha256,
    sourceContentSignature: `sha256:${createHash('sha256').update(JSON.stringify(rows)).digest('hex')}`
  };
}

function publicationMediaPaths(productJson: unknown): string[] {
  const product = asObject(productJson);
  const paths = new Set<string>();
  for (const variantValue of Array.isArray(product.variants) ? product.variants : []) {
    const variant = asObject(variantValue);
    for (const image of Array.isArray(variant.images) ? variant.images : []) paths.add(String(image));
    if (variant.video) paths.add(String(variant.video));
  }
  return [...paths].map((value) => value.replaceAll('\\', '/')).sort();
}

function storePublicationMarker(
  input: WbStorePublicationPackageInput,
  productSha256: string,
  sourceContentSignature: string
): JsonRecord {
  const mediaTargetVendorCodes = [...new Set(input.mediaTargetVendorCodes || [])].map(String).sort();
  const existingCardBaseline = [...(input.existingCardBaseline || [])].map((entry) => ({
    vendorCode: String(entry.vendorCode || ''),
    nmID: String(entry.nmID || '')
  })).sort((left, right) => left.vendorCode.localeCompare(right.vendorCode));
  return {
    schemaVersion: 1,
    kind: 'WB_STORE_PUBLICATION_READY',
    sku: normalizeSku(input.sku),
    revision: Number(input.revision),
    generatedVersionId: String(input.generatedVersionId),
    publicationId: String(input.publicationId),
    taskId: String(input.taskId),
    idempotencyKey: String(input.idempotencyKey),
    store: {
      id: String(input.storeId),
      alias: String(input.storeAlias),
      credentialVersionId: input.credentialVersionId ? String(input.credentialVersionId) : null,
      configVersion: Number(input.storeConfigVersion),
      warehouseId: String(input.warehouseId)
    },
    request: {
      submissionMode: input.submissionMode,
      mediaPolicy: input.mediaPolicy,
      mediaTargetVendorCodes,
      automationRunId: input.automationRunId ? String(input.automationRunId) : null,
      existingCardBaseline
    },
    productSha256,
    sourceContentSignature,
    readyAt: new Date().toISOString()
  };
}

function publicationVendorCodes(productJson: unknown): string[] {
  const variants = Array.isArray(asObject(productJson).variants) ? asObject(productJson).variants as JsonRecord[] : [];
  const vendorCodes = variants.map((variant) => String(asObject(variant).vendorCode || '').trim());
  if (!vendorCodes.length
    || vendorCodes.some((vendorCode) => !/^[A-Za-z0-9._-]+$/.test(vendorCode))
    || new Set(vendorCodes).size !== vendorCodes.length) {
    throw storePackageError('MEDIA_TARGETS_INVALID', '逐店铺物化版本缺少唯一且合法的卖家商品编码', {
      vendorCodes
    });
  }
  return vendorCodes;
}

function withoutReadyAt(value: JsonRecord): JsonRecord {
  const copy = { ...value };
  delete copy.readyAt;
  return copy;
}

function storePackageError(code: string, message: string, details: JsonRecord = {}): AppError {
  return new AppError(code, message, { ...details, stage: 'STORE_PACKAGE_PREPARATION', deliveryUnknown: false }, 409);
}

export function compileProductJson(reservation: JsonRecord): WbProductV2 {
  return compileProductJsonWithAudit(reservation).productJson;
}

export function compileProductJsonWithAudit(reservation: JsonRecord): { productJson: WbProductV2; generationWarnings: WbGenerationWarning[] } {
  const data = asObject(reservation.data);
  const category = asObject(reservation.category);
  const assets = new Map((reservation.mediaAssets as WbMediaAsset[]).map((asset) => [asset.assetId, asset]));
  const assignments = new Map((Array.isArray(reservation.variantMedia) ? reservation.variantMedia : []).map((item: JsonRecord) => [item.variantId, item]));
  const shared = Array.isArray(data.sharedCharacteristics) ? data.sharedCharacteristics : [];
  const variants = Array.isArray(data.variants) ? data.variants : [];
  if (!variants.length) throw new AppError('CONFIG_INVALID', '至少需要一个商品变体');
  const formConfig = asObject(category.formConfig);
  const mediaRules = { minImages: 1, maxImages: 30, videoAllowed: true, ...asObject(formConfig.media) };
  const allowedIds = new Set((Array.isArray(category.managedCharacteristicIds) ? category.managedCharacteristicIds : []).map(Number));
  const schema = characteristicSchemaMap(category.liveSchema);
  const complianceInput = asObject(data.compliance);
  const tnvedPolicy = resolveWbTnvedPolicy(formConfig, category.liveSchema);
  const tnvedId = tnvedPolicy.characteristicId;
  const tnved = String(complianceInput.tnved || '').trim();
  const kizMarked = complianceInput.kizMarked === true;
  if (tnved && !/^\d{10}$/.test(tnved)) throw new AppError('CONFIG_INVALID', 'TNVED 必须为 10 位数字', { tnved });
  if (!tnvedPolicy.supported && tnved) throw new AppError('CONFIG_INVALID', '当前 WB 类目不使用 TNVED，请清空该字段', { tnved });
  if (tnvedPolicy.required && !tnved) throw new AppError('CONFIG_INVALID', 'TNVED为必填项目');
  if (!tnved && kizMarked) throw new AppError('CONFIG_INVALID', 'TNVED 为空时不能保留 KIZ 标记');
  const generationWarnings: WbGenerationWarning[] = [];
  const sharedDescription = limitWbDescription(String(data.descriptionRu || ''));
  const { value: descriptionRu } = sharedDescription;
  if (!descriptionRu) throw new AppError('CONFIG_INVALID', '俄文产品详情不能为空，请填写产品详情或确认至少有一个有效 E003 详情 TXT');
  if (sharedDescription.truncated) generationWarnings.push(descriptionTruncatedWarning('descriptionRu', sharedDescription));
  const includeCompliance = Boolean(tnved);
  const productVariants = variants.map((variantInput: unknown, variantIndex: number) => {
    const variant = asObject(variantInput);
    const assignment = assignments.get(variant.variantId);
    if (!assignment) throw new AppError('CONFIG_INVALID', '变体尚未分配媒体', { variantId: variant.variantId });
    const imageIds = Array.isArray(assignment.imageAssetIds) ? assignment.imageAssetIds as string[] : [];
    if (imageIds.length < Number(mediaRules.minImages) || imageIds.length > Number(mediaRules.maxImages)) {
      throw new AppError('CONFIG_INVALID', '变体图片数不符合类目模板限制', { variantId: variant.variantId, count: imageIds.length, mediaRules });
    }
    const images = imageIds.map((assetId) => requireAsset(assets, assetId, 'image').relativePath);
    const video = assignment.videoAssetId ? requireAsset(assets, String(assignment.videoAssetId), 'video').relativePath : undefined;
    if (video && mediaRules.videoAllowed === false) throw new AppError('CONFIG_INVALID', '当前类目模板不允许视频', { variantId: variant.variantId });
    const characteristics = normalizeCharacteristics(
      [...shared, ...(Array.isArray(variant.characteristics) ? variant.characteristics : [])],
      schema,
      variantIndex
    );
    validateCharacteristics(characteristics, allowedIds, schema, variantIndex);
    if (tnvedId) {
      const characteristic = characteristics.find((item) => item.id === tnvedId);
      const value = characteristic ? characteristicValues(characteristic.value).map(String) : undefined;
      if (tnved) {
        if (value?.length !== 1 || value[0] !== tnved) throw new AppError('CONFIG_INVALID', 'TNVED 合规快照与 characteristic 值不一致', { variantId: variant.variantId, tnvedId });
      } else if (characteristic) {
        throw new AppError('CONFIG_INVALID', 'TNVED 为空时不能保留 TNVED characteristic', { variantId: variant.variantId, tnvedId });
      }
    }
    const sizes = normalizeSizes(variant.sizes);
    if (formConfig.sizeMode === 'sizeless' && (sizes.length !== 1 || sizes.some((size) => size.techSize !== undefined || size.wbSize !== undefined || size.insoleLengthCm !== undefined))) {
      throw new AppError('CONFIG_INVALID', '当前类目要求每个变体只有一个无尺码库存单位', { variantId: variant.variantId });
    }
    if (formConfig.sizeMode === 'sized' && sizes.some((size) => !size.techSize)) {
      throw new AppError('CONFIG_INVALID', '当前类目要求每个库存单位填写 techSize', { variantId: variant.variantId });
    }
    const variantDescription = String(variant.descriptionRu || '').trim()
      ? limitWbDescription(String(variant.descriptionRu))
      : undefined;
    if (variantDescription?.truncated) {
      generationWarnings.push(descriptionTruncatedWarning(`variants.${String(variant.vendorCode || variantIndex + 1)}.descriptionRu`, variantDescription));
    }
    return {
      variantCode: String(variant.variantCode || ''), vendorCode: String(variant.vendorCode || ''), characteristics,
      ...(variantDescription?.value ? { descriptionRu: variantDescription.value } : {}),
      images, ...(video ? { video } : {}), sizes
    };
  });
  const product: WbProductV2 = {
    schemaVersion: 2, productCode: String(reservation.sku), revision: Number(reservation.revision),
    category: { key: String(category.categoryKey), subjectId: Number(category.subjectId), templateVersion: Number(category.versionNo), schemaHash: String(category.schemaHash) },
    brand: String(data.brand || ''), titleRu: String(data.titleRu || ''), descriptionRu,
    packaging: normalizePackaging(data.packaging), priceCny: Number(data.priceCny || 0), discountPercent: Number(data.discountPercent || 0),
    ...(data.clubDiscount == null ? {} : { clubDiscount: Number(data.clubDiscount) }),
    videoUploadMode: data.videoUploadMode === 'COMPRESSED_COPY' ? 'COMPRESSED_COPY' : 'ORIGINAL',
    ...(includeCompliance ? { compliance: { tnved, kizMarked } } : {}),
    variants: productVariants as WbProductV2['variants']
  };
  const parsed = wbProductV2Schema.safeParse(product);
  if (!parsed.success) throw new AppError('CONFIG_INVALID', parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('；'), { issues: parsed.error.issues });
  return { productJson: parsed.data, generationWarnings };
}

function descriptionTruncatedWarning(field: string, input: ReturnType<typeof limitWbDescription>): WbGenerationWarning {
  return {
    code: 'WB_DESCRIPTION_TRUNCATED',
    field,
    severity: 'WARNING',
    message: `WB 描述超过 ${input.maxLength} 字符，已自动截断后生成 product.json`,
    originalLength: input.originalLength,
    finalLength: input.finalLength,
    maxLength: input.maxLength,
    limitSource: input.limitSource
  };
}

function characteristicSchemaMap(input: unknown): Map<number, JsonRecord> {
  const root = asObject(input);
  const candidates = Array.isArray(input) ? input : Array.isArray(root.data) ? root.data : Array.isArray(root.characteristics) ? root.characteristics : [];
  const entries: Array<[number, JsonRecord]> = [];
  for (const candidate of candidates) {
    const item = asObject(candidate);
    const id = Number(item.charcID || item.id);
    if (Number.isInteger(id) && id > 0) entries.push([id, item]);
  }
  return new Map(entries);
}

function normalizeCharacteristics(items: unknown[], schema: Map<number, JsonRecord>, variantIndex: number): WbCharacteristic[] {
  return items.map((input, itemIndex) => {
    const item = asObject(input);
    const id = Number(item.id);
    if (!Number.isInteger(id) || id <= 0) throw new AppError('CONFIG_INVALID', 'characteristic ID 必须是正整数', { variantIndex, itemIndex, id: item.id });
    const descriptor = schema.get(id);
    if (!isCharacteristicValue(item.value)) throw new AppError('CONFIG_INVALID', 'characteristic value 必须是标量或非空数组', { variantIndex, id });
    const rawCharcType = descriptor?.charcType ?? descriptor?.charc_type;
    const hasCharcType = rawCharcType !== undefined && rawCharcType !== null && rawCharcType !== '';
    const charcType = hasCharcType ? Number(rawCharcType) : undefined;
    if (charcType === 0) throw new AppError('CONFIG_INVALID', 'characteristic 已被 WB 标记为停用', { variantIndex, id });
    if (charcType === 4) {
      const values = characteristicValues(item.value);
      if (values.length !== 1) throw new AppError('CONFIG_INVALID', 'WB 数值型 characteristic 只能包含一个值', { variantIndex, id });
      const raw = values[0];
      const numberValue = typeof raw === 'number' ? raw : typeof raw === 'string' && raw.trim() ? Number(raw) : Number.NaN;
      if (!Number.isFinite(numberValue)) throw new AppError('CONFIG_INVALID', 'WB 数值型 characteristic 必须是有效数字', { variantIndex, id, value: raw });
      return { id, value: numberValue };
    }
    const values = characteristicValues(item.value);
    if (charcType === 1 && values.some((value) => typeof value !== 'string')) {
      throw new AppError('CONFIG_INVALID', 'WB 字符串型 characteristic 必须是字符串或字符串数组', { variantIndex, id });
    }
    const dictionary = [descriptor?.dictionaryValues, descriptor?.allowedValues, descriptor?.values, descriptor?.options].find(Array.isArray);
    if (dictionary?.length) {
      const allowed = new Set(dictionary.map((value: unknown) => {
        const entry = asObject(value);
        return String(entry.name ?? entry.value ?? entry.label ?? value);
      }));
      const invalid = values.find((value) => typeof value === 'string' && !allowed.has(value));
      if (invalid !== undefined) throw new AppError('CONFIG_INVALID', 'characteristic 值不在当前 WB 字典中', { variantIndex, id, value: invalid });
    }
    return { id, value: item.value };
  });
}

function validateCharacteristics(items: WbCharacteristic[], allowedIds: Set<number>, schema: Map<number, JsonRecord>, variantIndex: number): void {
  const ids = items.map((item) => Number(item.id));
  if (new Set(ids).size !== ids.length) throw new AppError('CONFIG_INVALID', '同一变体的 characteristic ID 不能重复', { variantIndex });
  for (const item of items) {
    if (allowedIds.size && !allowedIds.has(Number(item.id))) throw new AppError('CONFIG_INVALID', 'characteristic 不属于已发布表单模板', { variantIndex, id: item.id });
    const descriptor = schema.get(Number(item.id));
    if (schema.size && !descriptor) throw new AppError('CONFIG_INVALID', 'characteristic ID 不存在于 live_schema_json', { variantIndex, id: item.id });
    const maxCount = Number(descriptor?.maxCount || descriptor?.max_count || 0);
    const valueCount = characteristicValues(item.value).length;
    if (maxCount > 0 && valueCount > maxCount) throw new AppError('CONFIG_INVALID', 'characteristic 值数量超出 WB 限制', { variantIndex, id: item.id, maxCount });
  }
  for (const [id, descriptor] of schema) {
    if ((descriptor.required === true || descriptor.required === 1 || descriptor.isRequired === true) && !ids.includes(id)) {
      throw new AppError('CONFIG_INVALID', '缺少 WB 类目必填 characteristic', { variantIndex, id });
    }
  }
}

function normalizePackaging(input: unknown): WbProductV2['packaging'] {
  const packaging = asObject(input);
  const explicitWeightKg = Number(packaging.weightKg);
  const grossWeightGrams = Number(packaging.grossWeightGrams);
  const weightKg = Number.isFinite(explicitWeightKg) && explicitWeightKg > 0 ? explicitWeightKg : grossWeightGrams / 1_000;
  return {
    lengthCm: Number(packaging.lengthCm),
    widthCm: Number(packaging.widthCm),
    heightCm: Number(packaging.heightCm),
    weightKg
  };
}

function normalizeSizes(input: unknown): WbProductV2['variants'][number]['sizes'] {
  if (!Array.isArray(input)) return [];
  return input.map((value) => {
    const size = asObject(value);
    const techSize = String(size.techSize || '').trim();
    const wbSize = String(size.wbSize || '').trim();
    const insoleLengthCm = size.insoleLengthCm == null || size.insoleLengthCm === '' ? undefined : Number(size.insoleLengthCm);
    return {
      ...(techSize ? { techSize } : {}),
      ...(wbSize ? { wbSize } : {}),
      ...(insoleLengthCm === undefined ? {} : { insoleLengthCm }),
      barcode: String(size.barcode || '').trim(),
      stock: Number(size.stock || 0)
    };
  });
}

function characteristicValues(value: unknown): WbCharacteristicScalar[] {
  return Array.isArray(value) && value.every(isCharacteristicScalar) ? value : isCharacteristicScalar(value) ? [value] : [];
}

function isCharacteristicValue(value: unknown): value is WbCharacteristicValue {
  return isCharacteristicScalar(value) || (Array.isArray(value) && value.length > 0 && value.every(isCharacteristicScalar));
}

function isCharacteristicScalar(value: unknown): value is WbCharacteristicScalar {
  return typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value)) || typeof value === 'boolean';
}

function requireAsset(assets: Map<string, WbMediaAsset>, assetId: string, kind: 'image' | 'video'): WbMediaAsset {
  const asset = assets.get(assetId);
  if (!asset || asset.kind !== kind) throw new AppError('CONFIG_INVALID', '媒体分配引用了无效资产', { assetId, kind });
  if (asset.validationStatus !== 'VALID') throw new AppError('CONFIG_INVALID', '已分配的媒体文件未通过校验', { assetId, error: asset.validationError });
  return asset;
}

async function assertRealDirectoryInside(baseReal: string, candidate: string, label: string): Promise<string> {
  const info = await lstat(candidate);
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw new AppError('PATH_TRAVERSAL_BLOCKED', `${label} 必须是真实目录，不能是符号链接或文件`, { path: candidate });
  }
  const candidateReal = await realpath(candidate);
  if (!isPathInside(baseReal, candidateReal)) {
    throw new AppError('PATH_TRAVERSAL_BLOCKED', `${label} 的真实路径超出允许根目录`, { path: candidate, realPath: candidateReal });
  }
  return candidateReal;
}

function normalizeSku(input: string): string {
  const sku = String(input || '').trim();
  if (!/^\d{7}$/.test(sku)) throw new AppError('CONFIG_INVALID', 'SKU 必须是 7 位数字');
  return sku;
}
function autoPublishNotificationIdentity(input: {
  jobId?: string;
  storeId?: string;
  runId?: string;
  sku: string;
  jobCreatedAt: string;
}): string {
  const jobId = String(input.jobId || '').trim();
  if (jobId) return jobId;
  const storeId = String(input.storeId || '').trim();
  const runId = String(input.runId || '').trim();
  if (storeId && runId) return `${storeId}:${runId}`;
  return `${input.sku}:${input.jobCreatedAt}`;
}
function asObject(value: unknown): JsonRecord { return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : {}; }
function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value as JsonRecord).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(',')}}`;
  return JSON.stringify(value);
}
