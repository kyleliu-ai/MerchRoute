import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import sharp from 'sharp';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppError } from '@n8n-media-review/shared';
import { ConfigService } from '../../config/service.js';
import type { WbRepository, WbMediaAsset } from '../../repositories/wb.js';
import type { N8nWbClient } from './n8n-client.js';
import { compileProductJson, compileProductJsonWithAudit, validateTnvedCompliance, WbPublishingService } from './index.js';

describe.sequential('WB publishing filesystem service', () => {
  let root = '';

  afterEach(async () => {
    delete process.env.APP_DATA_DIR;
    if (root) await rm(root, { recursive: true, force: true });
  });

  it('validates kizMarked against the exact WB TNVED directory entry before generation', async () => {
    const getDirectory = vi.fn(async () => [
      { tnved: '6404191000', isKiz: false },
      { tnved: '6404199000', isKiz: true }
    ]);
    const n8n = { getDirectory } as unknown as N8nWbClient;
    const base = { category: tnvedCategoryForValidation(), data: { compliance: { tnved: '6404199000', kizMarked: false } } };

    await expect(validateTnvedCompliance(n8n, base)).rejects.toMatchObject({
      code: 'CONFIG_INVALID',
      details: { tnved: '6404199000', expectedKizMarked: true, actualKizMarked: false },
      statusCode: 409
    });
    await expect(validateTnvedCompliance(n8n, {
      ...base, data: { compliance: { tnved: '6404199000', kizMarked: true } }
    })).resolves.toBeUndefined();
    expect(getDirectory).toHaveBeenCalledWith('tnved', { subjectId: 105, search: '6404199000', locale: 'ru' });
  });

  it('fails closed when WB does not return an exact TNVED or a valid isKiz value', async () => {
    const reservation = { category: tnvedCategoryForValidation(), data: { compliance: { tnved: '6404199000', kizMarked: true } } };
    await expect(validateTnvedCompliance({ getDirectory: async () => [] } as unknown as N8nWbClient, reservation))
      .rejects.toMatchObject({ code: 'CONFIG_INVALID', statusCode: 409 });
    await expect(validateTnvedCompliance({ getDirectory: async () => [{ tnved: '6404199000' }] } as unknown as N8nWbClient, reservation))
      .rejects.toMatchObject({ code: 'VERIFY_FAILED', statusCode: 502 });
  });

  it('enforces the three-state TNVED rule without promoting a supported optional field to required', async () => {
    const optional = productReservationForTnved(false);
    expect(compileProductJson(optional)).not.toHaveProperty('compliance');

    const required = productReservationForTnved(true);
    expect(() => compileProductJson(required)).toThrow('TNVED为必填项目');

    const staleKiz = productReservationForTnved(false);
    staleKiz.data.compliance.kizMarked = true;
    expect(() => compileProductJson(staleKiz)).toThrow('TNVED 为空时不能保留 KIZ 标记');

    const staleCharacteristic = productReservationForTnved(false);
    staleCharacteristic.data.sharedCharacteristics.push({ id: 15004139, value: ['6404199000'] });
    expect(() => compileProductJson(staleCharacteristic)).toThrow('TNVED 为空时不能保留 TNVED characteristic');

    const unsupported = productReservationForTnved(false);
    unsupported.category.formConfig.fields = unsupported.category.formConfig.fields.filter((field: any) => field.characteristicId !== 15004139);
    unsupported.category.formConfig.compliance = { tnvedCharacteristicId: null, tnvedRequired: false };
    unsupported.data.compliance = { tnved: '6404199000', kizMarked: false };
    const getDirectory = vi.fn();
    await expect(validateTnvedCompliance({ getDirectory } as unknown as N8nWbClient, unsupported))
      .rejects.toMatchObject({ code: 'CONFIG_INVALID', statusCode: 409 });
    expect(getDirectory).not.toHaveBeenCalled();
  });

  it('returns a clear error when the shared Russian product description is empty', () => {
    const reservation = productReservationForTnved(false);
    reservation.data.descriptionRu = '';
    expect(() => compileProductJson(reservation)).toThrow('俄文产品详情不能为空');
  });

  it('keeps the automatic assignment order in final WB images[]', () => {
    const reservation = productReservationForTnved(false);
    const variantId = reservation.data.variants[0].variantId;
    reservation.mediaAssets = [
      { assetId: 'image-07', relativePath: 'variants/red/07.png' },
      { assetId: 'image-01', relativePath: 'variants/red/01.png' },
      { assetId: 'image-04', relativePath: 'variants/red/04.png' }
    ].map((asset) => ({
      ...asset,
      kind: 'image',
      mimeType: 'image/png',
      sizeBytes: 10,
      sha256: 'a'.repeat(64),
      modifiedAt: '2026-08-10T01:00:00.000Z',
      validationStatus: 'VALID'
    }));
    reservation.variantMedia = [{
      variantId,
      imageAssetIds: ['image-07', 'image-01', 'image-04']
    }];

    expect(compileProductJson(reservation).variants[0]?.images).toEqual([
      'variants/red/07.png',
      'variants/red/01.png',
      'variants/red/04.png'
    ]);
  });

  it('truncates shared and variant descriptions to the WB safe default before product.json generation', () => {
    const reservation = productReservationForTnved(false);
    reservation.data.descriptionRu = 'A'.repeat(2039);
    const baseVariant = reservation.data.variants[0];
    reservation.data.variants = Array.from({ length: 4 }, (_, index) => ({
      ...baseVariant,
      variantId: `00000000-0000-4000-8000-00000000000${index}`,
      variantCode: `0000010-0${index + 1}`,
      vendorCode: `0000010-0${index + 1}`,
      ...(index === 0 ? { descriptionRu: 'B'.repeat(2039) } : {}),
      sizes: [{ techSize: '40', barcode: '', stock: 1 }]
    }));
    reservation.variantMedia = reservation.data.variants.map((variant: any) => ({ variantId: variant.variantId, imageAssetIds: ['image-1'] }));

    const compiled = compileProductJsonWithAudit(reservation);

    expect(compiled.productJson.descriptionRu).toHaveLength(2000);
    expect(compiled.productJson.variants).toHaveLength(4);
    expect(compiled.productJson.variants[0]?.descriptionRu).toHaveLength(2000);
    expect(compiled.productJson.variants[1]).not.toHaveProperty('descriptionRu');
    expect(compiled.productJson.descriptionRu).not.toMatch(/[\r\n]/);
    expect(compiled.productJson.variants[0]?.descriptionRu).not.toMatch(/[\r\n]/);
    expect(compiled.generationWarnings).toEqual([
      expect.objectContaining({ code: 'WB_DESCRIPTION_TRUNCATED', field: 'descriptionRu', originalLength: 2039, finalLength: 2000, maxLength: 2000 }),
      expect.objectContaining({ code: 'WB_DESCRIPTION_TRUNCATED', field: 'variants.0000010-01.descriptionRu', originalLength: 2039, finalLength: 2000, maxLength: 2000 })
    ]);
  });

  it('scans each physical file once and expands shared media to multiple variants', async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'pixroute-wb-publishing-'));
    process.env.APP_DATA_DIR = path.join(root, 'app-data');
    const wbRoot = path.join(root, 'wb-root');
    const variantsRoot = path.join(wbRoot, 'inbox', '0000010', 'variants');
    const redImage = path.join(variantsRoot, '红色', 'images', 'submission-a', '01.png');
    const redVideo = path.join(variantsRoot, '红色', 'videos', 'submission-b', 'main.mp4');
    const powerImage = path.join(variantsRoot, '10W', 'images', 'submission-c', '02.webp');
    await Promise.all([mkdir(path.dirname(redImage), { recursive: true }), mkdir(path.dirname(redVideo), { recursive: true }), mkdir(path.dirname(powerImage), { recursive: true })]);
    await sharp({ create: { width: 32, height: 32, channels: 3, background: '#ffffff' } }).png().toFile(redImage);
    await writeFile(powerImage, await sharp({ create: { width: 24, height: 24, channels: 3, background: '#22aabb' } }).webp().toBuffer());
    const videoHeader = Buffer.alloc(32);
    videoHeader.writeUInt32BE(24, 0);
    videoHeader.write('ftyp', 4, 'ascii');
    videoHeader.write('isom', 8, 'ascii');
    await writeFile(redVideo, videoHeader);
    const redVariantId = randomUUID();
    await writeFile(path.join(variantsRoot, 'variant-media-manifest.json'), JSON.stringify({ schemaVersion: 2, SKU: '0000010', productName: '测试产品', assets: [
      { relativePath: 'variants/红色/images/submission-a/01.png', sha256: createHash('sha256').update(await readFile(redImage)).digest('hex'), kind: 'image', sortOrder: 0, variantId: redVariantId, variantName: '红色', sourceStageId: 'E005', submissionId: 'submission-a' },
      { relativePath: 'variants/红色/videos/submission-b/main.mp4', sha256: createHash('sha256').update(await readFile(redVideo)).digest('hex'), kind: 'video', variantId: redVariantId, variantName: '红色', sourceStageId: 'E004', submissionId: 'submission-b' }
    ] }, null, 2));

    const config = new ConfigService();
    await config.initialize();
    await config.initializeWbPublishingDirectory(wbRoot);
    await config.saveWbPublishing({ enabled: true, rootDirectory: wbRoot });

    let scannedAssets: WbMediaAsset[] = [];
    const blackId = randomUUID();
    const whiteId = randomUUID();
    const repository = {
      withRootConfigurationLock: async (operation: (active: number) => Promise<unknown>) => operation(0),
      getListing: async () => ({ sku: '0000010' }),
      replaceMediaAssets: async (_sku: string, assets: WbMediaAsset[]) => {
        scannedAssets = assets;
        return { sku: '0000010', status: 'DRAFT', draftVersion: 2, mediaAssets: assets, variantMedia: [] };
      },
      reserveGeneration: async () => {
        const image = scannedAssets.find((asset) => asset.kind === 'image' && asset.productVariantName === '红色')!;
        const video = scannedAssets.find((asset) => asset.kind === 'video' && asset.productVariantName === '红色')!;
        return {
          versionId: randomUUID(), revision: 1, sku: '0000010', draftVersion: 2,
          category: {
            categoryKey: 'dynamic_shoes', subjectId: 105, versionNo: 1, schemaHash: `sha256:${'a'.repeat(64)}`,
            liveSchema: [{ charcID: 204557, required: true }, { charcID: 14177449, required: true }, { charcID: 123, charcType: 4, required: true, maxCount: 1 }],
            formConfig: { media: { minImages: 1, maxImages: 7, videoAllowed: true, defaultVideoUploadMode: 'COMPRESSED_COPY' }, compliance: {} },
            managedCharacteristicIds: [123, 204557, 14177449]
          },
          data: {
            brand: '', titleRu: 'Кроссовки', descriptionRu: 'A\n\nB',
            packaging: { lengthCm: 35, widthCm: 20, heightCm: 15, grossWeightGrams: 650 }, priceCny: 10, discountPercent: 0, clubDiscount: 7,
            videoUploadMode: 'COMPRESSED_COPY',
            compliance: { tnved: '', kizMarked: false }, sharedCharacteristics: [{ id: 204557, value: ['Женский'] }, { id: 123, value: ['42'] }],
            variants: [
              { variantId: blackId, variantCode: '0000010-BLACK', vendorCode: '0000010-BLACK', characteristics: [{ id: 14177449, value: ['Черный'] }], sizes: [{ techSize: '', barcode: '', stock: 0 }] },
              { variantId: whiteId, variantCode: '0000010-WHITE', vendorCode: '0000010-WHITE', characteristics: [{ id: 14177449, value: ['Белый'] }], sizes: [{ techSize: '42', wbSize: '40', barcode: '12345678', stock: 5 }] }
            ]
          },
          mediaAssets: scannedAssets,
          variantMedia: [
            { variantId: blackId, imageAssetIds: [image.assetId], videoAssetId: video.assetId },
            { variantId: whiteId, imageAssetIds: [image.assetId], videoAssetId: video.assetId }
          ]
        };
      },
      completeGeneration: async (_sku: string, _versionId: string, productJson: unknown) => ({ sku: '0000010', status: 'GENERATED', draftVersion: 2, productJson }),
      failGeneration: async () => undefined
    } as unknown as WbRepository;
    const service = new WbPublishingService(config, repository);

    const scan = await service.scanMedia('0000010');
    expect(scan.mediaAssets).toHaveLength(3);
    expect(scan.mediaAssets.every((asset: WbMediaAsset) => asset.validationStatus === 'VALID')).toBe(true);
    expect(scan.mediaAssets.map((asset: WbMediaAsset) => asset.relativePath)).toEqual([
      'variants/10W/images/submission-c/02.webp',
      'variants/红色/images/submission-a/01.png',
      'variants/红色/videos/submission-b/main.mp4'
    ]);
    expect(scan.mediaAssets.find((asset: WbMediaAsset) => asset.relativePath.includes('红色/images'))).toMatchObject({ sortOrder: 0, productVariantId: redVariantId, productVariantName: '红色', sourceStageId: 'E005', sourceSubmissionId: 'submission-a' });
    expect(scan.mediaAssets.find((asset: WbMediaAsset) => asset.relativePath.includes('10W'))?.productVariantName).toBeUndefined();
    expect(scan.mediaAssets.some((asset: WbMediaAsset) => asset.relativePath.includes('variant-media-manifest'))).toBe(false);
    const generated = await service.generate('0000010', 2);
    expect(generated.productJson.variants[0]).toMatchObject({ images: ['variants/红色/images/submission-a/01.png'], video: 'variants/红色/videos/submission-b/main.mp4' });
    expect(generated.productJson.variants[1]).toMatchObject({ images: ['variants/红色/images/submission-a/01.png'], video: 'variants/红色/videos/submission-b/main.mp4' });
    expect(generated.productJson.variants[1]?.sizes).toEqual([{ techSize: '42', wbSize: '40', barcode: '12345678', stock: 5 }]);
    expect(generated.productJson.descriptionRu).toBe('A\\n\\nB');
    expect(generated.productJson.descriptionRu).not.toMatch(/[\r\n]/);
    expect(generated.productJson.packaging).toEqual({ lengthCm: 35, widthCm: 20, heightCm: 15, weightKg: 0.65 });
    expect(generated.productJson.clubDiscount).toBe(7);
    expect(generated.productJson.videoUploadMode).toBe('COMPRESSED_COPY');
    expect(generated.productJson).not.toHaveProperty('compliance');
    expect(generated.productJson.variants[0]?.characteristics).toContainEqual({ id: 123, value: 42 });
    const diskProduct = JSON.parse(await readFile(path.join(wbRoot, 'inbox', '0000010', 'product.json'), 'utf8'));
    expect(diskProduct.variants[0].images).toEqual(diskProduct.variants[1].images);
    expect(diskProduct.clubDiscount).toBe(7);
    expect(diskProduct.videoUploadMode).toBe('COMPRESSED_COPY');
  });

  it('creates isolated publication-scoped ready markers and only removes the matching identity', async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'merchroute-wb-store-ready-'));
    process.env.APP_DATA_DIR = path.join(root, 'app-data');
    const wbRoot = path.join(root, 'wb-root');
    const productRoot = path.join(wbRoot, 'inbox', '0000118');
    const imagePath = path.join(productRoot, 'variants', 'red', '01.png');
    await mkdir(path.dirname(imagePath), { recursive: true });
    await sharp({ create: { width: 32, height: 32, channels: 3, background: '#18b6a4' } }).png().toFile(imagePath);
    const productJson = {
      schemaVersion: 2,
      productCode: '0000118',
      variants: [{ vendorCode: '0000118-01', images: ['variants/red/01.png'] }]
    };
    await writeFile(path.join(productRoot, 'product.json'), `${JSON.stringify(productJson, null, 2)}\n`);

    const config = new ConfigService();
    await config.initialize();
    await config.initializeWbPublishingDirectory(wbRoot);
    await config.saveWbPublishing({ enabled: true, rootDirectory: wbRoot });

    let assets: WbMediaAsset[] = [];
    const generatedVersionId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const repository = {
      configured: true,
      withRootConfigurationLock: async (operation: (active?: number) => Promise<unknown>) => operation(0),
      getRuntimeConfig: vi.fn(async () => ({ import_root: wbRoot })),
      getListing: vi.fn(async () => ({ sku: '0000118' })),
      replaceMediaAssets: vi.fn(async (_sku: string, current: WbMediaAsset[]) => {
        assets = current;
        return { sku: '0000118', mediaAssets: current };
      }),
      getGeneratedPackageContext: vi.fn(async () => ({
        sku: '0000118', versionId: generatedVersionId, revision: 1,
        versionStatus: 'GENERATED', draftStatus: 'GENERATED', currentVersionId: generatedVersionId,
        productJson, mediaManifest: { assets }
      }))
    } as unknown as WbRepository;
    const service = new WbPublishingService(config, repository, {} as N8nWbClient);
    await service.scanMedia('0000118');

    const base = {
      sku: '0000118', generatedVersionId, revision: 1,
      taskId: 'default__0000118__r1',
      idempotencyKey: 'default|0000118|1|run-1',
      storeId: '00000000-0000-4000-8000-000000000001', storeAlias: 'default',
      credentialVersionId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', storeConfigVersion: 3,
      warehouseId: '1701558', submissionMode: 'CREATE_ONLY' as const,
      mediaPolicy: 'REPLACE_SELECTED' as const, mediaTargetVendorCodes: ['0000118-01']
    };
    const firstPublicationId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
    const secondPublicationId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
    const first = await service.prepareStorePublicationPackage({ ...base, publicationId: firstPublicationId });
    const second = await service.prepareStorePublicationPackage({
      ...base, publicationId: secondPublicationId,
      taskId: 'second__0000118__r1', idempotencyKey: 'second|0000118|1|run-2'
    });

    expect(first.markerPath).toBe(path.join(productRoot, '.store-ready', `${firstPublicationId}.json`));
    expect(first.productSha256).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(first.sourceContentSignature).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(JSON.parse(await readFile(first.markerPath, 'utf8'))).toMatchObject({
      kind: 'WB_STORE_PUBLICATION_READY', sku: '0000118', generatedVersionId,
      publicationId: firstPublicationId, taskId: base.taskId,
      store: { id: base.storeId, alias: 'default', credentialVersionId: base.credentialVersionId,
        configVersion: 3, warehouseId: '1701558' },
      request: { submissionMode: 'CREATE_ONLY', mediaPolicy: 'REPLACE_SELECTED',
        mediaTargetVendorCodes: ['0000118-01'] }
    });
    await expect(readFile(path.join(productRoot, '_READY'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });

    await expect(service.cleanupStorePublicationPackage({
      sku: '0000118', generatedVersionId, publicationId: firstPublicationId, taskId: 'wrong-task'
    })).rejects.toMatchObject({ code: 'STORE_READY_MARKER_MISMATCH' });
    await expect(readFile(first.markerPath, 'utf8')).resolves.toContain(firstPublicationId);
    await expect(service.cleanupStorePublicationPackage({
      sku: '0000118', generatedVersionId, publicationId: firstPublicationId, taskId: base.taskId
    })).resolves.toBe(true);
    await expect(readFile(first.markerPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(readFile(second.markerPath, 'utf8')).resolves.toContain(secondPublicationId);
  });

  it('creates an immutable store publication package and rejects escape, source drift, and package tampering', async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'merchroute-wb-immutable-package-'));
    process.env.APP_DATA_DIR = path.join(root, 'app-data');
    const wbRoot = path.join(root, 'wb-root');
    const productRoot = path.join(wbRoot, 'inbox', '0000122');
    const imagePath = path.join(productRoot, 'variants', 'red', '01.png');
    await mkdir(path.dirname(imagePath), { recursive: true });
    await sharp({ create: { width: 32, height: 32, channels: 3, background: '#ff2277' } }).png().toFile(imagePath);
    const productJson = {
      schemaVersion: 2,
      productCode: '0000122',
      discountPercent: 49,
      variants: [
        { vendorCode: '0000122-01', images: ['variants/red/01.png'] },
        { vendorCode: '0000122-02', images: ['variants/red/01.png'] }
      ]
    };
    const config = new ConfigService();
    await config.initialize();
    await config.initializeWbPublishingDirectory(wbRoot);
    await config.saveWbPublishing({ enabled: true, rootDirectory: wbRoot });

    let assets: WbMediaAsset[] = [];
    const generatedVersionId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2';
    const materializationHash = `sha256:${'c'.repeat(64)}`;
    const repository = {
      configured: true,
      withRootConfigurationLock: async (operation: (active?: number) => Promise<unknown>) => operation(0),
      getRuntimeConfig: vi.fn(async () => ({ import_root: wbRoot })),
      getListing: vi.fn(async () => ({ sku: '0000122' })),
      replaceMediaAssets: vi.fn(async (_sku: string, current: WbMediaAsset[]) => {
        assets = current;
        return { sku: '0000122', mediaAssets: current };
      }),
      getGeneratedPackageContext: vi.fn(async () => ({
        sku: '0000122', versionId: generatedVersionId, revision: 7,
        versionStatus: 'GENERATED', draftStatus: 'DRAFT', currentVersionId: undefined,
        generationScope: 'STORE_PUBLICATION', materializationHash,
        productJson, mediaManifest: { assets }
      }))
    } as unknown as WbRepository;
    const service = new WbPublishingService(config, repository, {} as N8nWbClient);
    await service.scanMedia('0000122');
    await expect(service.storePublicationMediaTargetVendorCodes('0000122', generatedVersionId))
      .resolves.toEqual(['0000122-01', '0000122-02']);
    const publicationId = 'cccccccc-cccc-4ccc-8ccc-ccccccccccc2';
    const input = {
      sku: '0000122', generatedVersionId, revision: 7, publicationId,
      taskId: 'first__0000122__r7', idempotencyKey: 'first|0000122|7',
      storeId: '00000000-0000-4000-8000-000000000001', storeAlias: 'first',
      credentialVersionId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', storeConfigVersion: 3,
      warehouseId: '1701558', submissionMode: 'CREATE_ONLY' as const,
      mediaPolicy: 'MISSING_ONLY' as const, materializationHash
    };
    await expect(service.prepareStorePublicationPackage({
      ...input,
      submissionMode: 'COMPATIBLE_UPSERT',
      mediaPolicy: 'REPLACE_SELECTED'
    })).rejects.toMatchObject({ code: 'MEDIA_TARGETS_INVALID' });
    const prepared = await service.prepareStorePublicationPackage(input);
    expect(prepared.packageRelPath).toBe(`stores/first/inbox/0000122/${publicationId}`);
    expect(prepared.packageSignature).toMatch(/^sha256:[a-f0-9]{64}$/);
    await expect(readFile(path.join(wbRoot, ...prepared.packageRelPath.split('/'), 'product.json'), 'utf8'))
      .resolves.toContain('"discountPercent": 49');
    await expect(service.prepareStorePublicationPackage({
      ...input,
      publicationId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
      storeAlias: '../../../../outside'
    })).rejects.toMatchObject({ code: 'PATH_TRAVERSAL_BLOCKED' });

    await writeFile(imagePath, 'changed-media');
    await expect(service.prepareStorePublicationPackage({
      ...input,
      publicationId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'
    })).rejects.toMatchObject({ code: 'VERSION_CONFLICT' });

    await sharp({ create: { width: 32, height: 32, channels: 3, background: '#ff2277' } }).png().toFile(imagePath);
    await service.scanMedia('0000122');
    const packagedProduct = path.join(wbRoot, ...prepared.packageRelPath.split('/'), 'product.json');
    await writeFile(packagedProduct, `${JSON.stringify({ ...productJson, discountPercent: 45 })}\n`);
    await expect(service.prepareStorePublicationPackage(input)).rejects.toMatchObject({ code: 'STORE_PACKAGE_IDENTITY_MISMATCH' });
  });

  it('does not remove the old READY marker when a new root fails validation', async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'pixroute-wb-root-switch-'));
    process.env.APP_DATA_DIR = path.join(root, 'app-data');
    const oldRoot = path.join(root, 'old-root');
    const config = new ConfigService();
    await config.initialize();
    await config.initializeWbPublishingDirectory(oldRoot);
    await config.saveWbPublishing({ enabled: true, rootDirectory: oldRoot });
    const productRoot = path.join(oldRoot, 'inbox', '0000010');
    await mkdir(productRoot, { recursive: true });
    await writeFile(path.join(productRoot, '_READY'), 'ready');
    const markAllGeneratedStale = vi.fn(async () => 1);
    const repository = {
      withRootConfigurationLock: async (operation: (active: number) => Promise<unknown>) => operation(0),
      listGeneratedSkus: async () => ['0000010'],
      markAllGeneratedStale
    } as unknown as WbRepository;
    const service = new WbPublishingService(config, repository);
    const invalidRoot = path.join(root, 'not-a-directory');
    await writeFile(invalidRoot, 'file');

    await expect(service.initializeSettings({ enabled: true, rootDirectory: invalidRoot })).rejects.toMatchObject({ code: 'CONFIG_INVALID' });
    expect(await readFile(path.join(productRoot, '_READY'), 'utf8')).toBe('ready');
    expect(config.get().wbPublishing.rootDirectory).toBe(oldRoot);
    expect(markAllGeneratedStale).not.toHaveBeenCalled();
  });

  it('reads the persisted PostgreSQL runtime root on readiness checks', async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'pixroute-wb-readiness-restart-'));
    process.env.APP_DATA_DIR = path.join(root, 'app-data');
    const wbRoot = path.join(root, 'wb-root');
    const config = new ConfigService();
    await config.initialize();
    await config.initializeWbPublishingDirectory(wbRoot);
    await config.saveWbPublishing({ enabled: true, rootDirectory: wbRoot });
    const getRuntimeConfig = vi.fn(async () => ({ import_root: wbRoot }));
    const repository = { getRuntimeConfig } as unknown as WbRepository;
    const service = new WbPublishingService(config, repository, {} as N8nWbClient);

    await expect(service.readiness(false)).resolves.toMatchObject({ status: 'READY', complete: true });
    await expect(service.readiness(false)).resolves.toMatchObject({ status: 'READY', complete: true });
    expect(getRuntimeConfig).toHaveBeenCalledTimes(2);
  });

  it('reports pending and recovers when the PostgreSQL runtime root is corrected', async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'merchroute-wb-readiness-recovery-'));
    process.env.APP_DATA_DIR = path.join(root, 'app-data');
    const wbRoot = path.join(root, 'wb-root');
    const config = new ConfigService();
    await config.initialize();
    await config.initializeWbPublishingDirectory(wbRoot);
    await config.saveWbPublishing({ enabled: true, rootDirectory: wbRoot });
    const getRuntimeConfig = vi.fn()
      .mockResolvedValueOnce({ import_root: path.join(root, 'other-wb-root') })
      .mockResolvedValueOnce({ import_root: wbRoot });
    const service = new WbPublishingService(config, { getRuntimeConfig } as unknown as WbRepository, {} as N8nWbClient);

    await expect(service.readiness(false)).resolves.toMatchObject({ status: 'SYNC_PENDING', complete: false });
    await expect(service.readiness(false)).resolves.toMatchObject({ status: 'READY', complete: true });
    expect(getRuntimeConfig).toHaveBeenCalledTimes(2);
  });

  it('rejects a SKU directory that is a symlink or Windows junction', async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'pixroute-wb-product-link-'));
    process.env.APP_DATA_DIR = path.join(root, 'app-data');
    const wbRoot = path.join(root, 'wb-root');
    const outside = path.join(root, 'outside');
    const config = new ConfigService();
    await config.initialize();
    await config.initializeWbPublishingDirectory(wbRoot);
    await config.saveWbPublishing({ enabled: true, rootDirectory: wbRoot });
    await mkdir(outside, { recursive: true });
    await symlink(outside, path.join(wbRoot, 'inbox', '0000010'), process.platform === 'win32' ? 'junction' : 'dir');
    const repository = {
      withRootConfigurationLock: async (operation: (active: number) => Promise<unknown>) => operation(0),
      createListing: async () => ({ sku: '0000010' })
    } as unknown as WbRepository;

    await expect(new WbPublishingService(config, repository).createListing('0000010')).rejects.toMatchObject({ code: 'PATH_TRAVERSAL_BLOCKED' });
  });

  it('keeps schemaHash distinct from the full n8n definitionHash', async () => {
    const schemaHash = `sha256:${'a'.repeat(64)}`;
    const category = {
      id: randomUUID(), categoryKey: 'dynamic_shoes', nameRu: 'Кроссовки', subjectId: 105, versionNo: 2, schemaHash,
      liveSchema: [{ charcID: 204557 }],
      formConfig: { fields: [{ fieldId: 'gender', characteristicId: 204557, labelRu: 'Пол', scope: 'shared', control: 'select', required: true, order: 1 }], media: { minImages: 1, maxImages: 7, videoAllowed: true, defaultVideoUploadMode: 'ORIGINAL' }, compliance: {} },
      managedCharacteristicIds: [204557], confirmedBy: 'qa', confirmedAt: new Date().toISOString()
    };
    const setProjection = vi.fn(async () => ({ categoryKey: category.categoryKey }));
    const repository = { getPublishedCategory: async () => category, setProjection } as unknown as WbRepository;
    await new WbPublishingService({} as ConfigService, repository, {} as N8nWbClient).syncCategory(category.categoryKey);
    expect(setProjection).toHaveBeenLastCalledWith(category.categoryKey, expect.objectContaining({ status: 'SYNCED', schemaHash, definitionHash: expect.not.stringMatching(schemaHash) }));
  });

  it('projects a present-but-optional TNVED characteristic as tnvedRequired false', async () => {
    const schemaHash = `sha256:${'c'.repeat(64)}`;
    const category = {
      id: randomUUID(), categoryKey: 'optional_tnved_bags', nameRu: 'Сумки', subjectId: 50, versionNo: 3, schemaHash,
      liveSchema: [{ charcID: 15004139, name: 'Код ТН ВЭД', required: false }],
      formConfig: {
        fields: [{ fieldId: 'tnved', characteristicId: 15004139, labelRu: 'Код ТН ВЭД', scope: 'shared', control: 'select', required: true, order: 1 }],
        compliance: { tnvedCharacteristicId: 15004139, tnvedRequired: true }
      },
      managedCharacteristicIds: [15004139], confirmedBy: 'qa', confirmedAt: new Date().toISOString()
    };
    const repository = {
      getPublishedCategory: vi.fn(async () => category), setProjection: vi.fn(async () => ({ categoryKey: category.categoryKey }))
    } as unknown as WbRepository;
    await new WbPublishingService({} as ConfigService, repository, {} as N8nWbClient).syncCategory(category.categoryKey);
    expect(repository.setProjection).toHaveBeenLastCalledWith(category.categoryKey, expect.objectContaining({
      status: 'SYNCED',
      schemaHash,
      definitionHash: expect.any(String)
    }));
  });

  it('deletes the local category template after PostgreSQL projection migration', async () => {
    const category = { categoryKey: 'unused_category', nameRu: 'Тест', nameZh: '测试', subjectId: 999, projection: { status: 'SYNCED' } };
    const order: string[] = [];
    const repository = {
      assertCategoryDeletable: vi.fn(async () => category),
      deleteCategory: vi.fn(async () => { order.push('local'); return category; })
    } as unknown as WbRepository;
    await expect(new WbPublishingService({} as ConfigService, repository, {} as N8nWbClient).deleteCategory(category.categoryKey)).resolves.toMatchObject({
      deletedCategoryKey: category.categoryKey,
      projection: { status: 'DELETED_FROM_POSTGRESQL' }
    });
    expect(order).toEqual(['local']);
  });

  it('recovers an unknown submission only when the task is absent and the SKU is still in inbox', async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'pixroute-wb-submit-recovery-'));
    process.env.APP_DATA_DIR = path.join(root, 'app-data');
    const wbRoot = path.join(root, 'wb-root');
    await mkdir(path.join(wbRoot, 'inbox', '0000011'), { recursive: true });
    const config = new ConfigService();
    await config.initialize();
    await config.initializeWbPublishingDirectory(wbRoot);
    await config.saveWbPublishing({ enabled: true, rootDirectory: wbRoot });
    const submitting = {
      sku: '0000011', status: 'SUBMITTING', generatedVersionId: 'version-2', n8nTaskId: '0000011__r2',
      submittedAt: new Date(Date.now() - 31_000).toISOString(), task: undefined
    };
    const recovered = { ...submitting, status: 'GENERATED', n8nTaskId: undefined };
    const recordSubmitFailure = vi.fn(async () => recovered);
    const repository = { getListing: async () => submitting, recordSubmitFailure } as unknown as WbRepository;
    const n8n = { getJob: async () => { throw new AppError('JOB_NOT_FOUND', '任务不存在', { httpStatus: 404 }, 404); } } as unknown as N8nWbClient;

    const result = await new WbPublishingService(config, repository, n8n).status('0000011');
    expect(result.listing.status).toBe('GENERATED');
    expect(result.pollError).toContain('已恢复为可提交状态');
    expect(recordSubmitFailure).toHaveBeenCalledWith('0000011', 'version-2', expect.any(String), {
      deliveryUnknown: false, expectedTaskId: '0000011__r2'
    });
  });

  it('keeps SUBMITTING when the directory already moved into processing', async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'pixroute-wb-submit-processing-'));
    process.env.APP_DATA_DIR = path.join(root, 'app-data');
    const wbRoot = path.join(root, 'wb-root');
    await mkdir(path.join(wbRoot, 'processing', '0000011__r2'), { recursive: true });
    const config = new ConfigService();
    await config.initialize();
    await config.initializeWbPublishingDirectory(wbRoot);
    await config.saveWbPublishing({ enabled: true, rootDirectory: wbRoot });
    const submitting = {
      sku: '0000011', status: 'SUBMITTING', generatedVersionId: 'version-2', n8nTaskId: '0000011__r2',
      submittedAt: new Date(Date.now() - 31_000).toISOString(), task: undefined
    };
    const recordSubmitFailure = vi.fn();
    const recordTaskNetworkRecovery = vi.fn(async (_sku: string, _taskId: string, recovery: Record<string, unknown>) => ({
      ...submitting, networkRecovery: recovery, networkNextAttemptAt: recovery.nextAttemptAt
    }));
    const repository = { getListing: async () => submitting, recordSubmitFailure, recordTaskNetworkRecovery } as unknown as WbRepository;
    const n8n = { getJob: async () => { throw new AppError('JOB_NOT_FOUND', '任务不存在', { httpStatus: 404 }, 404); } } as unknown as N8nWbClient;

    const result = await new WbPublishingService(config, repository, n8n).status('0000011');
    expect(result.listing.status).toBe('SUBMITTING');
    expect(result.pollError).toContain('processing');
    expect(recordSubmitFailure).not.toHaveBeenCalled();
    expect(recordTaskNetworkRecovery).toHaveBeenCalledWith('0000011', '0000011__r2', expect.objectContaining({
      phase: 'SUBMIT_READBACK', resumeState: 'SUBMITTING', lastErrorCode: 'WB_WRITE_OUTCOME_AMBIGUOUS'
    }));
  });

  it('writes one canonical message-center event shape when a WB listing reaches a terminal status', async () => {
    const queued = {
      sku: '0000022', productName: '测试运动鞋', status: 'QUEUED', n8nTaskId: '0000022__r1',
      autoPublishLocked: false
    };
    const succeeded = {
      ...queued, status: 'SUCCEEDED', nmIds: [1279000001, 1279000002],
      productUrls: ['https://www.wildberries.ru/catalog/1279000001/detail.aspx']
    };
    const repository = {
      getListing: vi.fn(async () => queued),
      updateTaskStatus: vi.fn(async () => succeeded),
      listPendingTerminalNotifications: vi.fn(async () => [{
        sku: '0000022', versionId: 'version-1', expectedStatus: 'SUCCEEDED', listing: succeeded
      }]),
      getPendingTerminalNotification: vi.fn(async () => ({
        sku: '0000022', versionId: 'version-1', expectedStatus: 'SUCCEEDED', listing: succeeded
      })),
      withTerminalNotificationLock: vi.fn(async (_versionId, operation) => operation()),
      markTerminalNotificationDelivered: vi.fn(async () => true)
    } as unknown as WbRepository;
    const n8n = { getJob: vi.fn(async () => ({ state: 'SUCCEEDED' })) } as unknown as N8nWbClient;
    const upsertNotification = vi.fn(async () => undefined);
    const resolveNotifications = vi.fn(async () => undefined);
    const ports = { listProductVariants: vi.fn(async () => []), upsertNotification, resolveNotifications };
    const service = new WbPublishingService({} as ConfigService, repository, n8n, ports);

    await expect(service.reconcileTaskStatus('0000022')).resolves.toMatchObject({ listing: { status: 'SUCCEEDED' } });
    expect(upsertNotification).toHaveBeenCalledWith(expect.objectContaining({
      dedupeKey: 'WB_LISTING_TERMINAL:0000022:0000022__r1:SUCCEEDED',
      category: 'WB_LISTING', eventType: 'WB_LISTING_SUCCEEDED', severity: 'SUCCESS',
      sourceType: 'WB_LISTING', sourceId: '0000022__r1', sku: '0000022', productName: '测试运动鞋',
      details: expect.objectContaining({ sku: '0000022', status: 'SUCCEEDED', source: 'MANUAL', taskId: '0000022__r1' })
    }));
    expect(resolveNotifications).toHaveBeenCalledWith(expect.objectContaining({
      dedupeKey: 'WB_LISTING_TERMINAL:0000022:0000022__r1:FAILED'
    }));
    expect(repository.markTerminalNotificationDelivered).toHaveBeenCalledWith('version-1', 'SUCCEEDED');
  });

  it('labels compatible automatic completion with its run number and WB links', async () => {
    const listing = {
      sku: '0000001', productName: '测试运动鞋', status: 'SUCCEEDED', n8nTaskId: '0000001__r5',
      nmIds: [1279000101, 1279000102],
      productUrls: ['https://www.wildberries.ru/catalog/1279000101/detail.aspx', 'https://www.wildberries.ru/catalog/1279000102/detail.aspx'],
      automationContext: { runId: '11111111-2222-4333-8444-555555555555', runNo: 3, operationMode: 'COMPATIBLE_UPSERT' }
    };
    const repository = {
      listPendingTerminalNotifications: vi.fn(async () => [{ sku: listing.sku, versionId: 'version-compatible', expectedStatus: 'SUCCEEDED', listing }]),
      getPendingTerminalNotification: vi.fn(async () => ({ sku: listing.sku, versionId: 'version-compatible', expectedStatus: 'SUCCEEDED', listing })),
      withTerminalNotificationLock: vi.fn(async (_versionId, operation) => operation()),
      markTerminalNotificationDelivered: vi.fn(async () => true)
    } as unknown as WbRepository;
    const upsertNotification = vi.fn(async () => undefined);
    const service = new WbPublishingService({} as ConfigService, repository, {} as N8nWbClient, {
      listProductVariants: vi.fn(async () => []), upsertNotification, resolveNotifications: vi.fn(async () => undefined)
    });

    await expect(service.flushPendingListingNotifications()).resolves.toMatchObject({ delivered: 1, errors: [] });
    expect(upsertNotification).toHaveBeenCalledWith(expect.objectContaining({
      title: 'WB 兼容重新上品完成 · 0000001',
      message: expect.stringContaining('第 3 轮'),
      details: expect.objectContaining({
        source: 'AUTOMATION', operationMode: 'COMPATIBLE_UPSERT', runNo: 3,
        productUrls: listing.productUrls
      })
    }));
  });

  it('does not notify for queued/running polls and maps BLOCKED to a failed WB listing notification', async () => {
    const current = { sku: '0000023', productName: '测试背包', status: 'QUEUED', n8nTaskId: '0000023__r1', autoPublishLocked: true };
    const updateTaskStatus = vi.fn()
      .mockResolvedValueOnce({ ...current, status: 'RUNNING' })
      .mockResolvedValueOnce({
        ...current,
        status: 'BLOCKED',
        lastError: 'WB 鉴权失败',
        task: { error: 'WB_AUTH_FAILED', message: 'WB 鉴权失败' }
      });
    const repository = {
      getListing: vi.fn(async () => current), updateTaskStatus,
      listPendingTerminalNotifications: vi.fn(async () => {
        const latest = await updateTaskStatus.mock.results.at(-1)?.value;
        return latest?.status === 'BLOCKED' ? [{
          sku: '0000023', versionId: 'version-1', expectedStatus: 'BLOCKED', listing: latest
        }] : [];
      }),
      getPendingTerminalNotification: vi.fn(async () => {
        const latest = await updateTaskStatus.mock.results.at(-1)?.value;
        return latest?.status === 'BLOCKED' ? {
          sku: '0000023', versionId: 'version-1', expectedStatus: 'BLOCKED', listing: latest
        } : undefined;
      }),
      withTerminalNotificationLock: vi.fn(async (_versionId, operation) => operation()),
      markTerminalNotificationDelivered: vi.fn(async () => true)
    } as unknown as WbRepository;
    const n8n = { getJob: vi.fn(async () => ({ state: 'RUNNING' })) } as unknown as N8nWbClient;
    const upsertNotification = vi.fn(async () => undefined);
    const service = new WbPublishingService({} as ConfigService, repository, n8n, {
      listProductVariants: vi.fn(async () => []), upsertNotification, resolveNotifications: vi.fn(async () => undefined)
    });

    await service.reconcileTaskStatus('0000023');
    expect(upsertNotification).not.toHaveBeenCalled();
    await service.reconcileTaskStatus('0000023');
    expect(upsertNotification).toHaveBeenCalledTimes(1);
    expect(upsertNotification).toHaveBeenCalledWith(expect.objectContaining({
      dedupeKey: 'WB_LISTING_TERMINAL:0000023:0000023__r1:FAILED',
      eventType: 'WB_LISTING_FAILED', severity: 'ERROR',
      details: expect.objectContaining({
        status: 'FAILED', source: 'AUTOMATION',
        errorCode: 'WB_AUTH_FAILED', errorMessage: 'WB 鉴权失败'
      })
    }));
  });

  it('keeps the synchronized terminal state when writing the notification fails', async () => {
    const queued = { sku: '0000024', status: 'QUEUED', n8nTaskId: '0000024__r1' };
    const repository = {
      getListing: vi.fn(async () => queued),
      updateTaskStatus: vi.fn(async () => ({ ...queued, status: 'FAILED', lastError: '图片上传失败' })),
      listPendingTerminalNotifications: vi.fn(async () => [{
        sku: '0000024', versionId: 'version-1', expectedStatus: 'FAILED',
        listing: { ...queued, status: 'FAILED', lastError: '图片上传失败' }
      }]),
      getPendingTerminalNotification: vi.fn(async () => ({
        sku: '0000024', versionId: 'version-1', expectedStatus: 'FAILED',
        listing: { ...queued, status: 'FAILED', lastError: '图片上传失败' }
      })),
      withTerminalNotificationLock: vi.fn(async (_versionId, operation) => operation()),
      markTerminalNotificationDelivered: vi.fn(async () => true)
    } as unknown as WbRepository;
    const n8n = { getJob: vi.fn(async () => ({ state: 'FAILED' })) } as unknown as N8nWbClient;
    const service = new WbPublishingService({} as ConfigService, repository, n8n, {
      listProductVariants: vi.fn(async () => []),
      upsertNotification: vi.fn(async () => { throw new Error('notification db unavailable'); }),
      resolveNotifications: vi.fn(async () => undefined)
    });

    await expect(service.reconcileTaskStatus('0000024')).resolves.toMatchObject({
      listing: { status: 'FAILED' }, notificationError: '0000024: notification db unavailable'
    });
  });

  it('notifies when a synchronous n8n submit exception is persisted as a terminal failure', async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'pixroute-wb-submit-notify-'));
    const scenario = await createSubmitFailureScenario(root, 'FAILED');

    await expect(scenario.service.submit('0000026', 3)).rejects.toThrow('n8n bridge unavailable');
    expect(scenario.upsertNotification).toHaveBeenCalledTimes(1);
    expect(scenario.upsertNotification).toHaveBeenCalledWith(expect.objectContaining({
      dedupeKey: 'WB_LISTING_TERMINAL:0000026:0000026__r3:FAILED',
      eventType: 'WB_LISTING_FAILED', severity: 'ERROR'
    }));
  });

  it('does not notify when a synchronous n8n submit exception safely restores the listing to GENERATED', async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'pixroute-wb-submit-retryable-'));
    const scenario = await createSubmitFailureScenario(root, 'GENERATED');

    await expect(scenario.service.submit('0000026', 3)).rejects.toThrow('n8n bridge unavailable');
    expect(scenario.upsertNotification).not.toHaveBeenCalled();
  });

  it('keeps automatic-failure source identity stable before and after an n8n task id appears', async () => {
    const upsertNotification = vi.fn(async () => undefined);
    const resolveNotifications = vi.fn(async () => undefined);
    const service = new WbPublishingService({} as ConfigService, {} as WbRepository, {} as N8nWbClient, {
      listProductVariants: vi.fn(async () => []), upsertNotification, resolveNotifications
    });
    const base = {
      sku: '0000028', state: 'NEEDS_ATTENTION', jobCreatedAt: '2026-07-19T10:30:00.000Z',
      errorCode: 'CONFIG_INVALID', errorMessage: '缺少字段'
    };

    await service.notifyAutoPublishFailure(base);
    await service.notifyAutoPublishFailure({ ...base, taskId: '0000028__r1' });
    expect(upsertNotification).toHaveBeenCalledTimes(2);
    expect(upsertNotification.mock.calls.map(([input]) => input.sourceId)).toEqual([
      '0000028:2026-07-19T10:30:00.000Z', '0000028:2026-07-19T10:30:00.000Z'
    ]);
    expect(upsertNotification.mock.calls[1]![0]).toMatchObject({ details: { taskId: '0000028__r1' } });

    await service.resolveAutoPublishFailure({ sku: base.sku, jobCreatedAt: base.jobCreatedAt, state: 'QUEUED' });
    expect(resolveNotifications).toHaveBeenCalledWith(expect.objectContaining({
      dedupeKey: 'WB_AUTO_PUBLISH_FAILED:0000028:2026-07-19T10:30:00.000Z'
    }));
  });

  it('isolates same-SKU failure notifications by immutable auto job identity and resolves only the selected store', async () => {
    const upsertNotification = vi.fn(async () => undefined);
    const resolveNotifications = vi.fn(async () => undefined);
    const service = new WbPublishingService({} as ConfigService, {} as WbRepository, {} as N8nWbClient, {
      listProductVariants: vi.fn(async () => []), upsertNotification, resolveNotifications
    });
    const base = {
      sku: '0000110', state: 'NEEDS_ATTENTION', jobCreatedAt: '2026-08-10T10:30:00.000Z',
      errorCode: 'CONFIG_INVALID', errorMessage: '缺少字段'
    };
    const first = {
      ...base,
      jobId: '11111111-1111-4111-8111-111111111111',
      storeId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    };
    const second = {
      ...base,
      jobId: '22222222-2222-4222-8222-222222222222',
      storeId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
    };

    await service.notifyAutoPublishFailure(first);
    await service.notifyAutoPublishFailure(second);
    expect(upsertNotification.mock.calls.map(([input]) => [input.dedupeKey, input.sourceId])).toEqual([
      ['WB_AUTO_PUBLISH_FAILED:11111111-1111-4111-8111-111111111111', first.jobId],
      ['WB_AUTO_PUBLISH_FAILED:22222222-2222-4222-8222-222222222222', second.jobId]
    ]);
    expect(upsertNotification.mock.calls[0]![0]).toMatchObject({
      details: { autoPublishJobId: first.jobId, storeId: first.storeId }
    });
    expect(upsertNotification.mock.calls[1]![0]).toMatchObject({
      details: { autoPublishJobId: second.jobId, storeId: second.storeId }
    });

    await service.resolveAutoPublishFailure({
      jobId: first.jobId,
      storeId: first.storeId,
      sku: first.sku,
      jobCreatedAt: first.jobCreatedAt,
      state: 'QUEUED'
    });
    expect(resolveNotifications).toHaveBeenCalledTimes(1);
    expect(resolveNotifications).toHaveBeenCalledWith(expect.objectContaining({
      dedupeKey: `WB_AUTO_PUBLISH_FAILED:${first.jobId}`
    }));
  });

  it('labels a compatible automatic failure with run identity in the message center', async () => {
    const upsertNotification = vi.fn(async () => undefined);
    const service = new WbPublishingService({} as ConfigService, {} as WbRepository, {} as N8nWbClient, {
      listProductVariants: vi.fn(async () => []), upsertNotification, resolveNotifications: vi.fn(async () => undefined)
    });

    await service.notifyAutoPublishFailure({
      sku: '0000001', state: 'NEEDS_ATTENTION', jobCreatedAt: '2026-07-20T10:00:00.000Z',
      runId: '463e69b0-4fc0-4af7-9b9e-85b80e7184f1', runNo: 3, operationMode: 'COMPATIBLE_UPSERT',
      errorCode: 'MEDIA_INCOMPLETE', errorMessage: '缺少黑色变体视频'
    });

    expect(upsertNotification).toHaveBeenCalledWith(expect.objectContaining({
      title: 'WB 兼容重新上品失败 · 0000001',
      message: '第 3 轮 · 缺少黑色变体视频',
      details: expect.objectContaining({
        operationMode: 'COMPATIBLE_UPSERT', operationLabel: '兼容重新上品', runNo: 3,
        automationRunId: '463e69b0-4fc0-4af7-9b9e-85b80e7184f1'
      })
    }));
  });
});

function productReservationForTnved(required: boolean): any {
  const variantId = randomUUID();
  return {
    sku: '0000010', revision: 1,
    category: {
      categoryKey: 'tnved_policy', subjectId: 105, versionNo: 1, schemaHash: `sha256:${'a'.repeat(64)}`,
      liveSchema: [
        { charcID: 15004139, name: 'Код ТН ВЭД', required },
        { charcID: 204557, name: 'Пол', required: true }
      ],
      formConfig: {
        fields: [
          { fieldId: 'tnved', characteristicId: 15004139, required: true },
          { fieldId: 'gender', characteristicId: 204557, required: true }
        ],
        sizeMode: 'sized', media: { minImages: 1, maxImages: 7, videoAllowed: false },
        compliance: { tnvedCharacteristicId: 15004139, tnvedRequired: true }
      },
      managedCharacteristicIds: [15004139, 204557]
    },
    data: {
      brand: '', titleRu: 'Тестовый товар', descriptionRu: 'A\\n\\nB',
      packaging: { lengthCm: 30, widthCm: 20, heightCm: 10, grossWeightGrams: 500 },
      priceCny: 100, discountPercent: 0, compliance: { tnved: '', kizMarked: false },
      sharedCharacteristics: [{ id: 204557, value: ['Женский'] }],
      variants: [{
        variantId, variantCode: '0000010-01', vendorCode: '0000010-01', characteristics: [],
        sizes: [{ techSize: '40', barcode: '', stock: 1 }]
      }]
    },
    mediaAssets: [{
      assetId: 'image-1', relativePath: 'variants/01.png', kind: 'image', mimeType: 'image/png', sizeBytes: 10,
      sha256: 'a'.repeat(64), modifiedAt: '2026-07-20T00:00:00.000Z', validationStatus: 'VALID'
    }],
    variantMedia: [{ variantId, imageAssetIds: ['image-1'] }]
  };
}

function tnvedCategoryForValidation(): any {
  return {
    subjectId: 105,
    liveSchema: [{ charcID: 15004139, name: 'Код ТН ВЭД', required: false }],
    formConfig: {
      fields: [{ fieldId: 'tnved', characteristicId: 15004139, required: false }],
      compliance: { tnvedCharacteristicId: 15004139, tnvedRequired: false }
    }
  };
}

async function createSubmitFailureScenario(root: string, failureStatus: 'FAILED' | 'GENERATED') {
  process.env.APP_DATA_DIR = path.join(root, 'app-data');
  const wbRoot = path.join(root, 'wb-root');
  const productRoot = path.join(wbRoot, 'inbox', '0000026');
  await mkdir(path.join(productRoot, 'variants'), { recursive: true });
  await writeFile(path.join(productRoot, 'product.json'), '{}\n');
  const config = new ConfigService();
  await config.initialize();
  await config.initializeWbPublishingDirectory(wbRoot);
  await config.saveWbPublishing({ enabled: true, rootDirectory: wbRoot });
  const context = {
    versionId: 'generated-version-3', revision: 3, expectedTaskId: '0000026__r3',
    productJson: {}, mediaManifest: { assets: [] }
  };
  const failedListing = {
    sku: '0000026', productName: '提交异常测试商品', status: failureStatus,
    generatedVersionId: context.versionId,
    ...(failureStatus === 'FAILED' ? { n8nTaskId: context.expectedTaskId, lastError: 'n8n bridge unavailable' } : {})
  };
  const repository = {
    withRootConfigurationLock: async (operation: () => Promise<unknown>) => operation(),
    getRuntimeConfig: vi.fn(async () => ({ import_root: wbRoot })),
    beginSubmit: vi.fn(async () => context),
    recordSubmitFailure: vi.fn(async () => failedListing),
    listPendingTerminalNotifications: vi.fn(async () => failureStatus === 'FAILED' ? [{
      sku: '0000026', versionId: context.versionId, expectedStatus: 'FAILED', listing: failedListing
    }] : []),
    getPendingTerminalNotification: vi.fn(async () => failureStatus === 'FAILED' ? {
      sku: '0000026', versionId: context.versionId, expectedStatus: 'FAILED', listing: failedListing
    } : undefined),
    withTerminalNotificationLock: vi.fn(async (_versionId, operation) => operation()),
    markTerminalNotificationDelivered: vi.fn(async () => true)
  } as unknown as WbRepository;
  const n8n = {
    configured: true,
    submitListing: vi.fn(async () => { throw new Error('n8n bridge unavailable'); })
  } as unknown as N8nWbClient;
  const upsertNotification = vi.fn(async () => undefined);
  const service = new WbPublishingService(config, repository, n8n, {
    listProductVariants: vi.fn(async () => []), upsertNotification, resolveNotifications: vi.fn(async () => undefined)
  });
  return { service, upsertNotification };
}
