import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConfigService } from '../../config/service.js';
import type { PurchaseRepository } from '../../repositories/purchases.js';
import { LegacyRootCompatibility } from '../../utils/legacy-root-compatibility.js';
import {
  LocalImportService,
  assertStrictDirectory,
  isAbsolutePathForPlatform,
  isSameLocalImportSourceRoot,
  localImportSourceRootKey,
  sortLocalImportDirectories,
  type LocalImportDirectoryEntry
} from './index.js';

describe('LocalImportService', () => {
  let root: string;
  let sourceRoot: string;
  let candidateRoot: string;
  let config: { get: () => any };

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'merchroute-local-import-'));
    sourceRoot = path.join(root, 'source');
    candidateRoot = path.join(root, 'candidate');
    await Promise.all([mkdir(sourceRoot), mkdir(candidateRoot)]);
    config = { get: () => ({ stages: [{ id: 'E000', enabled: true, inputQueueRoot: sourceRoot, candidateRoot }] }) };
  });

  afterEach(async () => { await rm(root, { recursive: true, force: true }); });

  it('returns only platform roots with media directories and sorts platform media folders newest first', async () => {
    await mkdir(path.join(sourceRoot, 'Z-platform', 'product-Z'), { recursive: true });
    await mkdir(path.join(sourceRoot, 'A-platform', 'product-A'), { recursive: true });
    await mkdir(path.join(sourceRoot, 'EMPTY-platform'));
    const diagnostics = path.join(sourceRoot, 'adaptation-diagnostics');
    await mkdir(diagnostics);
    await writeFile(path.join(diagnostics, 'media-adaptation-PDD-test.json'), '{}');
    await mkdir(path.join(sourceRoot, '.hidden-platform', 'product-hidden'), { recursive: true });
    await symlink(path.join(sourceRoot, 'A-platform'), path.join(sourceRoot, 'linked-platform'), process.platform === 'win32' ? 'junction' : 'dir');
    const older = path.join(sourceRoot, 'PDD', 'Z-older');
    const newer = path.join(sourceRoot, 'PDD', 'A-newer');
    await mkdir(older, { recursive: true });
    await new Promise((resolve) => setTimeout(resolve, 20));
    await mkdir(newer);
    await Promise.all([
      mkdir(path.join(newer, 'Z-detail')),
      mkdir(path.join(newer, 'A-detail')),
      mkdir(path.join(newer, '.runtime'))
    ]);
    await symlink(newer, path.join(sourceRoot, 'PDD', 'linked-media'), process.platform === 'win32' ? 'junction' : 'dir');
    const aPlatformModifiedAt = new Date('2026-08-25T08:00:00.000Z');
    const pddModifiedAt = new Date('2026-08-26T08:00:00.000Z');
    const zPlatformModifiedAt = new Date('2026-08-27T08:00:00.000Z');
    await Promise.all([
      utimes(path.join(sourceRoot, 'A-platform'), aPlatformModifiedAt, aPlatformModifiedAt),
      utimes(path.join(sourceRoot, 'PDD'), pddModifiedAt, pddModifiedAt),
      utimes(path.join(sourceRoot, 'Z-platform'), zPlatformModifiedAt, zPlatformModifiedAt)
    ]);
    const listLocalImportSourceRegistrations = vi.fn().mockResolvedValue([
      { normalizedPathKey: 'pdd/a-newer', sourceRoot, status: 'COPYING' },
      { normalizedPathKey: 'pdd/z-older', sourceRoot: path.join(root, 'old-source'), status: 'IMPORTED' }
    ]);
    const service = new LocalImportService(
      config as unknown as ConfigService,
      { listLocalImportSourceRegistrations } as unknown as PurchaseRepository,
      vi.fn()
    );

    const rootDirectories = await service.listDirectories();
    const mediaDirectories = await service.listDirectories('PDD');
    const childDirectories = await service.listDirectories('PDD/A-newer');

    expect(rootDirectories.directories.map((item) => item.name)).toEqual(['Z-platform', 'PDD', 'A-platform']);
    expect(rootDirectories.directories.map((item) => item.childDirectoryCount)).toEqual([1, 2, 1]);
    expect(rootDirectories.directories.every((item) => !Number.isNaN(Date.parse(item.createdAt)) && !Number.isNaN(Date.parse(item.modifiedAt)))).toBe(true);
    expect(rootDirectories.directories.map((item) => item.modifiedAt)).toEqual([
      zPlatformModifiedAt.toISOString(), pddModifiedAt.toISOString(), aPlatformModifiedAt.toISOString()
    ]);
    expect(mediaDirectories.directories.map((item) => item.name)).toEqual(['A-newer', 'Z-older']);
    expect(mediaDirectories.directories.map((item) => item.importStatus)).toEqual(['IMPORTED', 'NEW']);
    expect(mediaDirectories.directories[0]!.childDirectoryCount).toBe(2);
    expect(Date.parse(mediaDirectories.directories[0]!.createdAt)).toBeGreaterThan(Date.parse(mediaDirectories.directories[1]!.createdAt));
    expect(childDirectories.directories.map((item) => item.name)).toEqual(['A-detail', 'Z-detail']);
    expect(rootDirectories.directories.every((item) => item.importStatus === undefined)).toBe(true);
    expect(childDirectories.directories.every((item) => item.importStatus === undefined)).toBe(true);
    expect(listLocalImportSourceRegistrations).toHaveBeenCalledTimes(1);
    expect(listLocalImportSourceRegistrations).toHaveBeenCalledWith(['pdd/a-newer', 'pdd/z-older']);
  });

  it('uses the directory name as a stable ascending tie-breaker', () => {
    const createdAt = '2026-08-27T08:00:00.000Z';
    const modifiedAt = '2026-08-28T08:00:00.000Z';
    const entries: LocalImportDirectoryEntry[] = [
      { name: 'Z-R1', relativePath: 'PDD/Z-R1', platform: 'PDD', hasChildren: true, childDirectoryCount: 1, createdAt, modifiedAt },
      { name: 'A-R1', relativePath: 'PDD/A-R1', platform: 'PDD', hasChildren: true, childDirectoryCount: 1, createdAt, modifiedAt }
    ];

    expect(sortLocalImportDirectories(entries, 'product-media').map((item) => item.name)).toEqual(['A-R1', 'Z-R1']);
    expect(sortLocalImportDirectories(entries, 'platform-root').map((item) => item.name)).toEqual(['A-R1', 'Z-R1']);
    expect(sortLocalImportDirectories(entries, 'name').map((item) => item.name)).toEqual(['A-R1', 'Z-R1']);
    expect(entries.map((item) => item.name)).toEqual(['Z-R1', 'A-R1']);
  });

  it.each(['COPYING', 'IMPORTED', 'COPY_FAILED_RETRYABLE'] as const)(
    'marks every registered color directory imported during %s without changing historical root snapshots',
    async (status) => {
      await Promise.all(['red', 'blue', 'new'].map((name) => mkdir(path.join(sourceRoot, 'PDD', name), { recursive: true })));
      const historicalRoot = path.join(root, 'retired-source');
      const registrations = [
        { normalizedPathKey: 'pdd/red', sourceRoot: historicalRoot, status },
        { normalizedPathKey: 'pdd/blue', sourceRoot: historicalRoot, status },
        { normalizedPathKey: 'pdd/new', sourceRoot: undefined, status }
      ];
      const originalSnapshots = JSON.stringify(registrations);
      const listLocalImportSourceRegistrations = vi.fn().mockResolvedValue(registrations);
      const compatibility = new LegacyRootCompatibility({ legacyRoot: historicalRoot, canonicalRoot: sourceRoot });
      const canonicalizePath = vi.fn((value: string) => compatibility.canonicalizePath(value));
      const service = new LocalImportService(
        config as unknown as ConfigService,
        { listLocalImportSourceRegistrations } as unknown as PurchaseRepository,
        vi.fn(), canonicalizePath
      );

      const result = await service.listDirectories('PDD');

      expect(Object.fromEntries(result.directories.map((entry) => [entry.name, entry.importStatus])))
        .toEqual({ red: 'IMPORTED', blue: 'IMPORTED', new: 'NEW' });
      expect(listLocalImportSourceRegistrations).toHaveBeenCalledTimes(1);
      expect(listLocalImportSourceRegistrations).toHaveBeenCalledWith(expect.arrayContaining(['pdd/red', 'pdd/blue', 'pdd/new']));
      expect(canonicalizePath).toHaveBeenCalledWith(historicalRoot);
      expect(JSON.stringify(registrations)).toBe(originalSnapshots);

      const changedRoot = path.join(root, 'changed-source');
      await mkdir(path.join(changedRoot, 'PDD', 'red'), { recursive: true });
      config.get = () => ({ stages: [{ id: 'E000', enabled: true, inputQueueRoot: changedRoot, candidateRoot }] });
      expect((await service.listDirectories('PDD')).directories).toEqual([
        expect.objectContaining({ name: 'red', importStatus: 'NEW' })
      ]);
    }
  );

  it('matches source roots with operating-system path semantics', () => {
    expect(localImportSourceRootKey(' C:/MerchRoute/Source/ ', 'win32')).toBe('c:\\merchroute\\source');
    expect(isSameLocalImportSourceRoot('C:\\MerchRoute\\Source', 'c:/merchroute/source/', 'win32')).toBe(true);
    expect(isSameLocalImportSourceRoot('/srv/MerchRoute/source/', '/srv/MerchRoute/source', 'darwin')).toBe(true);
    expect(isSameLocalImportSourceRoot('/srv/MerchRoute/source', '/srv/merchroute/source', 'linux')).toBe(false);
    expect(isSameLocalImportSourceRoot('/srv/MerchRoute/source', '/srv/MerchRoute/other', 'linux')).toBe(false);
    expect(isSameLocalImportSourceRoot('/srv/MerchRoute/source', undefined, 'linux')).toBe(false);
    expect(localImportSourceRootKey('relative/source', 'linux')).toBeUndefined();
    expect(localImportSourceRootKey('C:\\media\\source', 'darwin')).toBeUndefined();
  });

  it('maps the primary information file, preserves multiple same-platform folders and filters runtime/video files', async () => {
    const red = path.join(sourceRoot, 'PDD', 'red');
    const blue = path.join(sourceRoot, 'PDD', 'blue');
    await Promise.all([mkdir(red, { recursive: true }), mkdir(blue, { recursive: true })]);
    await writeFile(path.join(red, 'productInformation-123.json'), JSON.stringify({
      SKU: 'external-123', productName: '本地导入测试包', sellingPrice: 19.8, currencyType: 'CNY', courierFee: 2,
      productHeightCm: 11, productDepthCm: 4, productWidthCm: 20, netWeightGrams: 180, grossWeightGrams: 260,
      lengthCm: 22, widthCm: 12, heightCm: 7, productUrl: 'https://example.com/products/123'
    }));
    await writeFile(path.join(red, 'main.jpg'), 'image-one');
    await writeFile(path.join(red, 'clip.mp4'), 'video');
    await writeFile(path.join(red, '.pdd-download-state.json'), '{}');
    await writeFile(path.join(blue, 'detail.png'), 'image-two');
    await writeFile(path.join(blue, 'metadata.json'), JSON.stringify({ productUrl: 'https://example.com/products/123-blue' }));
    const service = new LocalImportService(config as unknown as ConfigService, {} as PurchaseRepository, vi.fn());

    const preview = await service.preview({ directories: ['PDD/red', 'PDD/blue'], primaryDirectory: 'PDD/red' });

    expect(preview).toMatchObject({ sourcePlatform: 'PDD', importWorkflowLabel: '本地导入-PDD', priceConversion: { sourceCurrency: 'CNY', status: 'NOT_REQUIRED' } });
    expect(preview.fields).toMatchObject({ productName: '本地导入测试包', purchasePrice: '19.8', retailPrice: null, currency: 'CNY', providerUrl: 'https://example.com/products/123', grossWeightGrams: '260' });
    expect(preview.sources).toHaveLength(2);
    expect(preview.sources[0]).toMatchObject({ externalSku: 'external-123', informationFileRelativePath: 'productInformation-123.json' });
    expect(preview.sources.flatMap((source) => source.files.map((file) => file.relativePath))).toEqual(expect.arrayContaining(['main.jpg', 'detail.png', 'metadata.json', 'productInformation-123.json']));
    expect(preview.sources.flatMap((source) => source.files.map((file) => file.relativePath))).not.toEqual(expect.arrayContaining(['clip.mp4', '.pdd-download-state.json']));
    expect(preview.fields).not.toHaveProperty('SKU');
  });

  it('keeps an invalid source product name editable in preview and enforces the normalized name at final import', async () => {
    const folder = path.join(sourceRoot, 'PDD', 'invalid-name');
    await mkdir(folder, { recursive: true });
    await writeFile(path.join(folder, 'productInformation-sku.json'), JSON.stringify({
      productName: 'E2E本地导入包', sellingPrice: 19.8, currencyType: 'CNY',
      productUrl: 'https://example.com/invalid-local-import-name'
    }));
    const reserveLocalImport = vi.fn().mockResolvedValue({ created: false, import: { id: 'existing', status: 'IMPORTED' } });
    const service = new LocalImportService(config as unknown as ConfigService, { reserveLocalImport } as unknown as PurchaseRepository, vi.fn());
    const preview = await service.preview({ directories: ['PDD/invalid-name'], primaryDirectory: 'PDD/invalid-name' });

    expect(preview.fields.productName).toBe('E2E本地导入包');
    await expect(service.import({ previewToken: preview.token, idempotencyKey: 'invalid-name', fields: preview.fields })).rejects.toMatchObject({
      code: 'LOCAL_IMPORT_INFORMATION_INVALID',
      message: '产品名称仅允许汉字、数字 0-9 及中文常用标点',
      details: { field: 'productName', issue: 'INVALID_CHARACTERS', actualLength: 8 }
    });
    expect(reserveLocalImport).not.toHaveBeenCalled();

    await service.import({
      previewToken: preview.token,
      idempotencyKey: 'normalized-name',
      fields: { ...preview.fields, productName: '  神奇商品2（新）  ' }
    });
    expect(reserveLocalImport).toHaveBeenCalledWith(expect.objectContaining({
      purchase: expect.objectContaining({ productName: '神奇商品2（新）' })
    }));
  });

  it('converts a RUB retail price to a four-decimal CNY purchase price and rejects first-import retail tampering', async () => {
    const folder = path.join(sourceRoot, 'WB', 'rub-price');
    await mkdir(folder, { recursive: true });
    await writeFile(path.join(folder, 'productInformation-sku.json'), JSON.stringify({
      productName: '俄罗斯来源商品', sellingPrice: 1384, currencyType: 'RUB', Exchange: 12,
      productUrl: 'https://example.com/rub-price'
    }));
    const reserveLocalImport = vi.fn().mockResolvedValue({ created: false, import: { id: 'existing', status: 'IMPORTED' } });
    const service = new LocalImportService(config as unknown as ConfigService, { reserveLocalImport } as unknown as PurchaseRepository, vi.fn());

    const preview = await service.preview({ directories: ['WB/rub-price'], primaryDirectory: 'WB/rub-price' });

    expect(preview.priceConversion).toEqual({ sourceCurrency: 'RUB', exchangeRate: '12', status: 'CALCULATED', calculatedPurchasePrice: '115.3333' });
    expect(preview.fields).toMatchObject({ purchasePrice: '115.3333', retailPrice: '1384', currency: 'CNY' });
    await service.import({
      previewToken: preview.token, idempotencyKey: 'rub-once',
      fields: { ...preview.fields, purchasePrice: '120.25', retailPrice: '1', currency: 'RUB' }
    });
    expect(reserveLocalImport).toHaveBeenCalledWith(expect.objectContaining({
      purchase: expect.objectContaining({ purchasePrice: '120.25', retailPrice: '1384', currency: 'CNY' })
    }));
  });

  it.each([
    ['missing', undefined, 'MISSING'],
    ['invalid', 0, 'INVALID']
  ])('keeps RUB retail price and requires a manual CNY price when Exchange is %s', async (_case, Exchange, issue) => {
    const folder = path.join(sourceRoot, 'WB', `exchange-${_case}`);
    await mkdir(folder, { recursive: true });
    await writeFile(path.join(folder, 'productInformation-sku.json'), JSON.stringify({
      productName: '需要手填采购价', sellingPrice: 1200, currencyType: 'RUB', Exchange,
      productUrl: `https://example.com/exchange-${_case}`
    }));
    const service = new LocalImportService(config as unknown as ConfigService, {} as PurchaseRepository, vi.fn());

    const preview = await service.preview({ directories: [`WB/exchange-${_case}`], primaryDirectory: `WB/exchange-${_case}` });

    expect(preview.priceConversion).toEqual({ sourceCurrency: 'RUB', status: 'MANUAL_REQUIRED', issue });
    expect(preview.fields).toMatchObject({ purchasePrice: '', retailPrice: '1200', currency: 'CNY' });
  });

  it('rejects unsupported source currencies instead of guessing an exchange rule', async () => {
    const folder = path.join(sourceRoot, 'OZON', 'usd-price');
    await mkdir(folder, { recursive: true });
    await writeFile(path.join(folder, 'productInformation-sku.json'), JSON.stringify({
      productName: '未知币种商品', sellingPrice: 10, currencyType: 'USD', productUrl: 'https://example.com/usd-price'
    }));
    const service = new LocalImportService(config as unknown as ConfigService, {} as PurchaseRepository, vi.fn());

    await expect(service.preview({ directories: ['OZON/usd-price'], primaryDirectory: 'OZON/usd-price' }))
      .rejects.toMatchObject({ code: 'LOCAL_IMPORT_CURRENCY_UNSUPPORTED' });
  });

  it('rejects cross-platform and parent-child selections before filesystem copy', async () => {
    const service = new LocalImportService(config as unknown as ConfigService, {} as PurchaseRepository, vi.fn());
    await expect(service.preview({ directories: ['PDD/red', 'WB/blue'], primaryDirectory: 'PDD/red' })).rejects.toMatchObject({ code: 'LOCAL_IMPORT_CROSS_PLATFORM' });
    await expect(service.preview({ directories: ['PDD/red', 'PDD/red/detail'], primaryDirectory: 'PDD/red' })).rejects.toMatchObject({ code: 'LOCAL_IMPORT_PARENT_CHILD_SELECTION' });
  });

  it('invalidates a preview immediately when the E000 source configuration changes', async () => {
    const folder = path.join(sourceRoot, 'PDD', 'one');
    await mkdir(folder, { recursive: true });
    await writeFile(path.join(folder, 'productInformation-sku.json'), JSON.stringify({ productName: '配置变化', sellingPrice: 1, productUrl: 'https://example.com/one' }));
    const purchases = { reserveLocalImport: vi.fn() } as unknown as PurchaseRepository;
    const service = new LocalImportService(config as unknown as ConfigService, purchases, vi.fn());
    const preview = await service.preview({ directories: ['PDD/one'], primaryDirectory: 'PDD/one' });
    const changedRoot = path.join(root, 'changed-source');
    await mkdir(changedRoot);
    config.get = () => ({ stages: [{ id: 'E000', enabled: true, inputQueueRoot: changedRoot, candidateRoot }] });
    await expect(service.import({ previewToken: preview.token, idempotencyKey: 'once', fields: preview.fields })).rejects.toMatchObject({ code: 'LOCAL_IMPORT_PREVIEW_EXPIRED' });
    expect(purchases.reserveLocalImport).not.toHaveBeenCalled();
  });

  it('retries a historical failed import through canonical roots and writes only canonical paths to the new manifest', async () => {
    const mediaDirectory = path.join(sourceRoot, 'PDD', 'legacy-product');
    const mediaFile = path.join(mediaDirectory, 'main.jpg');
    await mkdir(mediaDirectory, { recursive: true });
    await writeFile(mediaFile, 'historical-media');
    const sha256 = createHash('sha256').update(await readFile(mediaFile)).digest('hex');
    const legacyBase = path.join(root, 'legacy-root');
    const legacySourceRoot = path.join(legacyBase, 'source');
    const legacyCandidateRoot = path.join(legacyBase, 'candidate');
    const canonicalizePath = (value: string) => {
      const relative = path.relative(legacyBase, value);
      return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative)) ? path.join(root, relative) : value;
    };
    const hash = (kind: string, value: string) => createHash('sha256').update(stableTestJson({
      stageId: 'E000', kind, root: process.platform === 'win32' ? path.normalize(path.resolve(value)).toLocaleLowerCase('en-US') : path.normalize(path.resolve(value))
    })).digest('hex');
    const record = {
      id: '11111111-1111-4111-8111-111111111111', idempotencyKey: 'legacy-retry', sku: '0000001',
      status: 'COPY_FAILED_RETRYABLE', sourcePlatform: 'PDD', importWorkflowLabel: '本地导入-PDD',
      sourceConfigSnapshot: { stageId: 'E000', inputQueueRoot: legacySourceRoot, configHash: hash('source', legacySourceRoot) },
      targetConfigSnapshot: { stageId: 'E000', candidateRoot: legacyCandidateRoot, configHash: hash('target', legacyCandidateRoot) },
      previewHash: 'preview-hash', retryCount: 1, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      sources: [{
        id: 'source-1', platform: 'PDD', relativePath: 'PDD/legacy-product', normalizedPathKey: 'pdd/legacy-product',
        isPrimary: true, targetSubdirectory: 'legacy-product', copyManifest: { files: [{ relativePath: 'main.jpg', sha256, sizeBytes: 16 }] }
      }]
    } as any;
    const completeLocalImport = vi.fn(async (_id, targetFolder) => ({ ...record, status: 'IMPORTED', targetFolder }));
    const purchases = {
      getLocalImport: vi.fn(async () => record),
      markLocalImportCopying: vi.fn(async () => ({ ...record, status: 'COPYING' })),
      getPurchase: vi.fn(async () => ({ sku: '0000001', productName: '历史商品' })),
      completeLocalImport,
      failLocalImport: vi.fn()
    } as unknown as PurchaseRepository;
    const service = new LocalImportService(config as unknown as ConfigService, purchases, vi.fn(), canonicalizePath);

    await expect(service.retry(record.id)).resolves.toMatchObject({ status: 'IMPORTED' });

    const target = path.join(candidateRoot, '0000001-历史商品');
    const manifest = JSON.parse(await readFile(path.join(target, 'local-import-manifest.json'), 'utf8'));
    expect(manifest.sourceConfigSnapshot).toMatchObject({ inputQueueRoot: sourceRoot, configHash: hash('source', sourceRoot) });
    expect(manifest.targetConfigSnapshot).toMatchObject({ candidateRoot, configHash: hash('target', candidateRoot) });
    expect(JSON.stringify(manifest)).not.toContain(legacyBase);
    expect(record.sourceConfigSnapshot.inputQueueRoot).toBe(legacySourceRoot);
    expect(completeLocalImport).toHaveBeenCalledWith(record.id, target);
  });

  it('validates current-platform absolute paths and refuses a volume root', async () => {
    expect(isAbsolutePathForPlatform('C:\\media\\source', 'win32')).toBe(true);
    expect(isAbsolutePathForPlatform('/Volumes/media/source', 'darwin')).toBe(true);
    expect(isAbsolutePathForPlatform('C:\\media\\source', 'darwin')).toBe(false);
    await expect(assertStrictDirectory(path.parse(root).root, false, '测试目录')).rejects.toMatchObject({ code: 'LOCAL_IMPORT_PATH_INVALID' });
    await expect(assertStrictDirectory(sourceRoot, false, '测试目录')).resolves.toBeUndefined();
  });
});

function stableTestJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableTestJson).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => `${JSON.stringify(key)}:${stableTestJson(item)}`).join(',')}}`;
  return JSON.stringify(value);
}
