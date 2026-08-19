import { describe, expect, it, vi } from 'vitest';
import { AppError } from '@n8n-media-review/shared';
import type { ConfigService } from '../../config/service.js';
import type { PricingRepository } from '../../repositories/pricing.js';
import type { PurchaseRepository } from '../../repositories/purchases.js';
import type { WbPresetRepository, WbListingPresetRecord } from '../../repositories/wb-presets.js';
import type { WbRepository } from '../../repositories/wb.js';
import type { N8nWbClient } from '../wb-publishing/n8n-client.js';
import { filterIdentityVariants, WbPresetService } from './index.js';

const preset: WbListingPresetRecord = {
  id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', rowVersion: 2, isDefault: true, name: '默认预设', description: '',
  pricingTemplateId: '11111111-1111-4111-8111-111111111111', shippingTemplateId: '22222222-2222-4222-8222-222222222222',
  shippingServiceCode: 'CEL_WB_ECONOMY', packaging: { grossWeightGrams: 750, lengthCm: 30, widthCm: 15, heightCm: 10 },
  categoryKey: 'shoes', discountPercent: 49, clubDiscount: 5, tnved: '6404199000', brand: '',
  titleTranslation: { workflowId: 'W2lSSXE3NUaLW1tD', language: '俄文', maxLength: 60 }, descriptionSource: 'E003',
  sharedCharacteristics: [{ id: 204557, value: ['Женский'] }, { id: 15004139, value: ['0000000000'] }],
  variantCharacteristics: [{ id: 14177449, value: ['Черный'] }],
  sizes: [{ sizeId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', techSize: '40', wbSize: '40', stock: 3 }],
  dependencySnapshot: { pricingTemplateVersionId: 'p-v1', pricingTemplateVersionNo: 1, shippingTemplateVersionId: 's-v1', shippingTemplateVersionNo: 1, categoryVersionId: 'c-v1', categoryVersionNo: 1, capturedAt: '2026-07-18T00:00:00.000Z' },
  createdAt: '2026-07-18T00:00:00.000Z', updatedAt: '2026-07-18T00:00:00.000Z'
};

describe('WbPresetService listing initialization', () => {
  it('limits automatic initialization to the current delivery lineage variants', () => {
    const identity = {
      sku: '0000045',
      productName: '尼龙布通勤单肩包',
      variants: [
        { variantId: 'black', name: '黑色' },
        { variantId: 'brown', name: '棕色' },
        { variantId: 'orange', name: '橘红色' },
        { variantId: 'purple', name: '暗紫色' }
      ]
    } as any;
    expect(filterIdentityVariants(identity, ['black', 'orange', 'purple']).variants.map((variant) => variant.name))
      .toEqual(['黑色', '橘红色', '暗紫色']);
    expect(() => filterIdentityVariants(identity, ['missing']))
      .toThrow('自动上品任务引用的产品变体已不存在');
  });

  it('creates and verifies an immutable execution binding independent of later default state', () => {
    const service = new WbPresetService(
      {} as WbPresetRepository, {} as WbRepository, {} as PurchaseRepository, {} as PricingRepository, {} as N8nWbClient,
      { get: () => ({ stages: [] }) } as unknown as ConfigService
    );
    const activatedAt = '2026-07-19T10:00:00.000Z';
    const bindable = {
      ...preset,
      autoPublishEnabled: true,
      autoPublishActivatedAt: activatedAt,
      dependencySnapshot: {
        pricingTemplateVersionId: '31111111-1111-4111-8111-111111111111', pricingTemplateVersionNo: 1,
        shippingTemplateVersionId: '32222222-2222-4222-8222-222222222222', shippingTemplateVersionNo: 2,
        categoryVersionId: '33333333-3333-4333-8333-333333333333', categoryVersionNo: 3,
        capturedAt: '2026-07-18T00:00:00.000Z'
      }
    };
    const binding = service.createExecutionBinding(bindable, '2026-07-19T10:01:00.000Z');
    expect(binding).toMatchObject({
      schemaVersion: 2, presetId: preset.id, presetName: preset.name, presetRowVersion: preset.rowVersion,
      activationStartedAt: activatedAt, boundAt: '2026-07-19T10:01:00.000Z',
      dependencySnapshot: { categoryVersionNo: 3 }
    });
    expect(binding.definitionHash).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(service.parseExecutionBinding(binding)).toEqual(binding);
    expect(() => service.parseExecutionBinding({ ...binding, presetName: '被篡改' })).toThrow('模板绑定快照校验失败');
  });

  it('resolves a bound task by its captured dependency versions instead of the current published preset', async () => {
    const exact = dependencies();
    exact.pricing = { ...exact.pricing, versionId: '31111111-1111-4111-8111-111111111111' };
    exact.shipping = { ...exact.shipping, versionId: '32222222-2222-4222-8222-222222222222', versionNo: 2 };
    exact.category = { ...exact.category, versionId: '33333333-3333-4333-8333-333333333333', versionNo: 3 };
    const repository = {
      resolveDependenciesAtSnapshot: vi.fn(async () => exact),
      resolveDependencies: vi.fn(async () => { throw new Error('不应读取当前发布版本'); })
    } as unknown as WbPresetRepository;
    const service = new WbPresetService(
      repository, {} as WbRepository, {} as PurchaseRepository, {} as PricingRepository, {} as N8nWbClient,
      { get: () => ({ stages: [] }) } as unknown as ConfigService
    );
    const binding = service.createExecutionBinding({
      ...preset, autoPublishEnabled: true, autoPublishActivatedAt: '2026-07-19T10:00:00.000Z',
      dependencySnapshot: {
        pricingTemplateVersionId: exact.pricing.versionId, pricingTemplateVersionNo: exact.pricing.versionNo,
        shippingTemplateVersionId: exact.shipping.versionId, shippingTemplateVersionNo: exact.shipping.versionNo,
        categoryVersionId: exact.category.versionId, categoryVersionNo: exact.category.versionNo,
        capturedAt: '2026-07-18T00:00:00.000Z'
      }
    }, '2026-07-19T10:01:00.000Z');

    const context = await service.resolveExecutionBinding(binding, false);
    expect(context.preset.discountPercent).toBe(49);
    expect(context.resolved.dependencies.category?.versionId).toBe(exact.category.versionId);
    expect((repository.resolveDependenciesAtSnapshot as any)).toHaveBeenCalledTimes(1);
    expect((repository.resolveDependencies as any)).not.toHaveBeenCalled();
  });

  it('uses fixed packaging, creates all protected variants, and keeps barcodes empty', async () => {
    let stored: Record<string, any> | undefined;
    const repository = {
      getDefault: vi.fn(async () => preset),
      get: vi.fn(async () => preset),
      resolveDependencies: vi.fn(async () => dependencies()),
      createInitializedListing: vi.fn(async (input: any) => { stored = input.data; return true; }),
      getTranslation: vi.fn(async () => undefined), putTranslation: vi.fn(async () => undefined)
    } as unknown as WbPresetRepository;
    const wb = {
      getListing: vi.fn(async () => {
        if (!stored) throw new AppError('NOT_FOUND', 'WB 上品草稿不存在', undefined, 404);
        return { sku: '0000001', ...stored, draftVersion: 1 };
      })
    } as unknown as WbRepository;
    const purchases = {
      getProductIdentityBySku: vi.fn(async () => ({ sku: '0000001', productName: '测试运动鞋', variants: [
        { variantId: '00000000-0000-4000-8000-000000000000', name: '默认变体' },
        { variantId: '11111111-1111-4111-8111-111111111111', name: '黑色', wbColor: { colorKey: 'a'.repeat(64), nameRu: 'Черный', nameZh: '黑色' } },
        { variantId: '22222222-2222-4222-8222-222222222222', name: '白色', wbColor: { colorKey: 'b'.repeat(64), nameRu: 'Белый', nameZh: '白色' } }
      ] })),
      findPricingProducts: vi.fn(async () => [{ sku: '0000001', productName: '测试运动鞋', procurement: {
        id: '33333333-3333-4333-8333-333333333333', versionNo: 3, purchasePrice: '21', courierFee: '0', currency: 'CNY',
        grossWeightGrams: '650.5', createdAt: '2026-07-18T00:00:00.000Z'
      } }])
    } as unknown as PurchaseRepository;
    const pricing = {
      calculate: vi.fn(async (_input: any) => ({
        pricingTemplate: { versionId: 'p-v1', versionNo: 1 },
        options: [{ shipping: { serviceCode: 'CEL_WB_ECONOMY', template: { versionId: 's-v1', versionNo: 1 } }, amounts: {
          listing: { costCurrency: { currencyCode: 'CNY', displayValue: '395.86' } },
          targetSale: { costCurrency: { currencyCode: 'CNY', displayValue: '197.93' } }
        } }]
      }))
    } as unknown as PricingRepository;
    const n8n = { getDirectory: vi.fn(async () => [{ tnved: '6404199000', isKiz: true }]) } as unknown as N8nWbClient;
    const service = new WbPresetService(repository, wb, purchases, pricing, n8n, { get: () => ({ stages: [] }) } as unknown as ConfigService);
    vi.spyOn(service.translations, 'translate').mockResolvedValue({ contentTranslate: 'Тестовые кроссовки', cached: false });
    vi.spyOn(service.descriptions, 'resolveVariants').mockResolvedValue({
      status: 'READY',
      content: 'A\\n\\nB',
      source: { workflowCode: 'E003', executionId: 10, folderName: 'safe', fileName: 'detail.txt', sha256: 'hash', productVariantId: '11111111-1111-4111-8111-111111111111', variantName: '黑色' },
      variantSources: [
        {
          status: 'READY',
          content: 'A\\n\\nB',
          source: { workflowCode: 'E003', executionId: 10, folderName: 'safe', fileName: 'detail.txt', sha256: 'hash', productVariantId: '11111111-1111-4111-8111-111111111111', variantName: '黑色' },
          productVariantId: '11111111-1111-4111-8111-111111111111',
          productVariantName: '黑色'
        },
        {
          status: 'READY',
          content: 'A\\n\\nB',
          source: { workflowCode: 'E003', executionId: 10, folderName: 'safe', fileName: 'detail.txt', sha256: 'hash', productVariantId: '22222222-2222-4222-8222-222222222222', variantName: '白色' },
          productVariantId: '22222222-2222-4222-8222-222222222222',
          productVariantName: '白色'
        }
      ]
    });

    const listing = await service.createListing('0000001') as any;
    expect((pricing.calculate as any).mock.calls[0][0].item).toMatchObject({ actualWeightGrams: '650.5', lengthCm: '30', widthCm: '15', heightCm: '10' });
    expect((purchases.findPricingProducts as any)).toHaveBeenCalledTimes(1);
    expect(listing.priceCny).toBe(395.86);
    expect(listing.packaging).toEqual({ grossWeightGrams: 650.5, lengthCm: 30, widthCm: 15, heightCm: 10 });
    expect(listing.videoUploadMode).toBe('COMPRESSED_COPY');
    expect(listing.variants).toHaveLength(2);
    expect(listing.variants.map((variant: any) => variant.vendorCode)).toEqual(['0000001-01', '0000001-02']);
    expect(listing.variants.map((variant: any) => variant.characteristics.find((item: any) => item.id === 14177449)?.value)).toEqual([['Черный'], ['Белый']]);
    expect(listing.variants.map((variant: any) => variant.productVariantColor?.colorKey)).toEqual(['a'.repeat(64), 'b'.repeat(64)]);
    expect(listing.variants.flatMap((variant: any) => variant.sizes).every((size: any) => size.barcode === '')).toBe(true);
    expect(listing.compliance).toEqual({ tnved: '6404199000', kizMarked: true });
    expect(listing.sharedCharacteristics).toEqual([
      { id: 204557, value: ['Женский'] },
      { id: 15004139, value: ['6404199000'] }
    ]);
    expect(listing.sharedCharacteristics.filter((item: any) => item.id === 15004139)).toHaveLength(1);
    expect(listing.purchaseMeasurements).toMatchObject({
      procurementVersionId: '33333333-3333-4333-8333-333333333333',
      procurementVersionNo: 3,
      productHeightCm: null,
      productDepthCm: null,
      productWidthCm: null,
      netWeightGrams: null
    });
    expect(listing.variants.map((variant: any) => variant.characteristics)).toEqual([
      [{ id: 14177449, value: ['Черный'] }],
      [{ id: 14177449, value: ['Белый'] }]
    ]);
    expect(listing.initialization.pricing).toMatchObject({
      listingPriceCny: 395.86, targetSalePriceCny: 197.93, merchantDiscountPercent: 49, currency: 'CNY',
      procurementSource: { procurementVersionId: '33333333-3333-4333-8333-333333333333', procurementVersionNo: 3, purchasePrice: '21', domesticFreight: '0', currency: 'CNY' }
    });
    expect(listing.initialization.grossWeightResolution).toEqual({
      source: 'PROCUREMENT', effectiveGrossWeightGrams: 650.5, procurementGrossWeightGrams: 650.5,
      presetGrossWeightGrams: 750, procurementVersionId: '33333333-3333-4333-8333-333333333333',
      procurementVersionNo: 3, procurementCapturedAt: expect.any(String)
    });
    await expect(service.get(preset.id)).resolves.toMatchObject({
      resolvedDependencies: {
        pricing: { snapshotVersionId: 'p-v1', snapshotVersionNo: 1 },
        shipping: { snapshotVersionId: 's-v1', snapshotVersionNo: 1 },
        category: { snapshotVersionId: 'c-v1', snapshotVersionNo: 1 }
      }
    });
  });

  it.each([
    { label: 'null', grossWeightGrams: null },
    { label: '空字符串', grossWeightGrams: '' },
    { label: '零', grossWeightGrams: '0' },
    { label: '负数', grossWeightGrams: '-0.1' }
  ])('采购毛重为 $label 时回退到预设毛重', async ({ grossWeightGrams }) => {
    const findPricingProducts = vi.fn(async () => [{ sku: '0000001', productName: '测试鞋', procurement: {
      id: '44444444-4444-4444-8444-444444444444', versionNo: 4, purchasePrice: '20', courierFee: '0', currency: 'CNY',
      grossWeightGrams, createdAt: '2026-07-20T00:00:00.000Z'
    } }]);
    const service = new WbPresetService(
      {} as WbPresetRepository,
      {} as WbRepository,
      { findPricingProducts } as unknown as PurchaseRepository,
      {} as PricingRepository,
      {} as N8nWbClient,
      { get: () => ({ stages: [] }) } as unknown as ConfigService
    );
    const buildRuntimeFields = vi.spyOn(service as any, 'buildRuntimeFields').mockResolvedValue({
      patch: { priceCny: 399, titleRu: 'Обувь', descriptionRu: 'A\\n\\nB' }, issues: []
    });

    const initialized = await (service as any).buildInitialization(
      { sku: '0000001', productName: '测试鞋', variants: [{ variantId: 'v1', name: '黑色' }] },
      preset,
      { dependencies: dependencies(), snapshot: preset.dependencySnapshot, issues: [] }
    );

    expect(findPricingProducts).toHaveBeenCalledTimes(1);
    expect(initialized.data.packaging).toEqual({ grossWeightGrams: 750, lengthCm: 30, widthCm: 15, heightCm: 10 });
    expect(initialized.data.initialization.grossWeightResolution).toEqual({
      source: 'PRESET_FALLBACK', effectiveGrossWeightGrams: 750, procurementGrossWeightGrams: null,
      presetGrossWeightGrams: 750, procurementVersionId: '44444444-4444-4444-8444-444444444444',
      procurementVersionNo: 4, procurementCapturedAt: expect.any(String)
    });
    expect(buildRuntimeFields.mock.calls[0]?.[4]).toMatchObject({
      actualWeightGrams: 750,
      product: { procurement: { id: '44444444-4444-4444-8444-444444444444' } }
    });
  });

  it('自动新建与兼容重建共用同一采购毛重初始化规则', async () => {
    for (const mode of ['AUTOMATIC', 'COMPATIBLE_REBUILD'] as const) {
      const harness = createGrossWeightPublicHarness(mode === 'COMPATIBLE_REBUILD');
      const binding = harness.service.createExecutionBinding(harness.boundPreset, '2026-07-21T10:01:00.000Z');
      const listing = mode === 'AUTOMATIC'
        ? await harness.service.createListing('0000001', { automatic: true, presetBinding: binding }) as any
        : await harness.service.rebuildListing('0000001', binding, 'compatibility-test') as any;

      expect(harness.findPricingProducts).toHaveBeenCalledTimes(1);
      expect(harness.pricing.calculate).toHaveBeenCalledWith(expect.objectContaining({
        item: expect.objectContaining({ actualWeightGrams: '612.75', lengthCm: '30', widthCm: '15', heightCm: '10' })
      }));
      expect(listing.packaging).toEqual({ grossWeightGrams: 612.75, lengthCm: 30, widthCm: 15, heightCm: 10 });
      expect(listing.initialization.grossWeightResolution).toMatchObject({
        source: 'PROCUREMENT', effectiveGrossWeightGrams: 612.75, procurementGrossWeightGrams: 612.75,
        procurementVersionId: '88888888-8888-4888-8888-888888888888', procurementVersionNo: 8
      });
      if (mode === 'AUTOMATIC') {
        expect(harness.repository.createInitializedListing).toHaveBeenCalledWith(expect.objectContaining({ automatic: true }));
      } else {
        expect(harness.repository.replaceInitializedListing).toHaveBeenCalledWith(expect.objectContaining({ operationRef: 'compatibility-test' }));
      }
    }
  });

  it('keeps E003 variant description gaps non-blocking when at least one shared description is available', async () => {
    let stored: Record<string, any> | undefined;
    const repository = {
      getDefault: vi.fn(async () => preset),
      resolveDependencies: vi.fn(async () => dependencies()),
      createInitializedListing: vi.fn(async (input: any) => { stored = input.data; return true; }),
      getTranslation: vi.fn(async () => undefined),
      putTranslation: vi.fn(async () => undefined)
    } as unknown as WbPresetRepository;
    const wb = {
      getListing: vi.fn(async () => {
        if (!stored) throw new AppError('NOT_FOUND', 'WB 上品草稿不存在', undefined, 404);
        return { sku: '0000001', ...stored, draftVersion: 1 };
      })
    } as unknown as WbRepository;
    const purchases = {
      getProductIdentityBySku: vi.fn(async () => ({ sku: '0000001', productName: '测试运动鞋', variants: [
        { variantId: 'black', name: '黑色', wbColor: { colorKey: 'a'.repeat(64), nameRu: 'Черный', nameZh: '黑色' } },
        { variantId: 'white', name: '白色', wbColor: { colorKey: 'b'.repeat(64), nameRu: 'Белый', nameZh: '白色' } }
      ] })),
      findPricingProducts: vi.fn(async () => [{ sku: '0000001', productName: '测试运动鞋', procurement: {
        id: '33333333-3333-4333-8333-333333333333', versionNo: 3, purchasePrice: '21', courierFee: '0', currency: 'CNY', createdAt: '2026-07-18T00:00:00.000Z'
      } }])
    } as unknown as PurchaseRepository;
    const pricing = { calculate: vi.fn(async () => ({
      pricingTemplate: { versionId: 'p-v1', versionNo: 1 },
      options: [{ shipping: { serviceCode: 'CEL_WB_ECONOMY', template: { versionId: 's-v1', versionNo: 1 } }, amounts: {
        listing: { costCurrency: { currencyCode: 'CNY', displayValue: '395.86' } },
        targetSale: { costCurrency: { currencyCode: 'CNY', displayValue: '197.93' } }
      } }]
    })) } as unknown as PricingRepository;
    const service = new WbPresetService(
      repository, wb, purchases, pricing,
      { getDirectory: vi.fn(async () => [{ tnved: '6404199000', isKiz: true }]) } as unknown as N8nWbClient,
      { get: () => ({ stages: [] }) } as unknown as ConfigService
    );
    vi.spyOn(service.translations, 'translate').mockResolvedValue({ contentTranslate: 'Тестовые кроссовки', cached: false });
    vi.spyOn(service.descriptions, 'resolveVariants').mockResolvedValue({
      status: 'MISSING',
      content: 'A\\n\\nB',
      source: { workflowCode: 'E003', executionId: 10, folderName: 'safe', fileName: 'detail.txt', sha256: 'hash', productVariantId: 'black', variantName: '黑色' },
      variantSources: [
        {
          status: 'READY',
          content: 'A\\n\\nB',
          source: { workflowCode: 'E003', executionId: 10, folderName: 'safe', fileName: 'detail.txt', sha256: 'hash', productVariantId: 'black', variantName: '黑色' },
          productVariantId: 'black',
          productVariantName: '黑色'
        },
        {
          status: 'MISSING',
          message: '没有找到变体“白色”的最新有效 E003 详情 TXT',
          productVariantId: 'white',
          productVariantName: '白色'
        }
      ]
    });

    const listing = await service.createListing('0000001') as any;
    expect(listing.descriptionRu).toBe('A\\n\\nB');
    expect(listing.variants.find((variant: any) => variant.productVariantId === 'black')).toMatchObject({ descriptionRu: 'A\\n\\nB' });
    expect(listing.variants.find((variant: any) => variant.productVariantId === 'white')).not.toHaveProperty('descriptionRu');
    expect(listing.initialization.issues).toContainEqual(expect.objectContaining({
      code: 'E003_DESCRIPTION_MISSING',
      severity: 'WARNING',
      field: 'variants.white.descriptionRu'
    }));
    expect(listing.initialization.issues.some((item: any) => item.severity === 'ERROR' && String(item.code).startsWith('E003_DESCRIPTION'))).toBe(false);
  });

  it('reuses stable vendor codes and allocates the next suffix for a new color', async () => {
    const service = new WbPresetService(
      {} as WbPresetRepository,
      {} as WbRepository,
      { findPricingProducts: vi.fn(async () => [{ sku: '0000001', productName: '测试鞋', procurement: {
        id: '44444444-4444-4444-8444-444444444444', versionNo: 4, purchasePrice: '20', courierFee: '0', currency: 'CNY',
        productHeightCm: null, productDepthCm: null, productWidthCm: null, netWeightGrams: null,
        createdAt: '2026-07-18T00:00:00.000Z'
      } }]) } as unknown as PurchaseRepository,
      {} as PricingRepository,
      {} as N8nWbClient,
      { get: () => ({ stages: [] }) } as unknown as ConfigService
    );
    vi.spyOn(service as any, 'buildRuntimeFields').mockResolvedValue({
      patch: { priceCny: 399, titleRu: 'Обувь', descriptionRu: 'A\\n\\nB' }, issues: []
    });
    const identity = {
      sku: '0000001', productName: '测试鞋', variants: [
        { variantId: '11111111-1111-4111-8111-111111111111', name: '浅黄', wbColor: { colorKey: 'a'.repeat(64), nameRu: 'Светло-желтый', nameZh: '浅黄' } },
        { variantId: '22222222-2222-4222-8222-222222222222', name: '白色', wbColor: { colorKey: 'b'.repeat(64), nameRu: 'Белый', nameZh: '白色' } },
        { variantId: '33333333-3333-4333-8333-333333333333', name: '黑色', wbColor: { colorKey: 'c'.repeat(64), nameRu: 'Черный', nameZh: '黑色' } }
      ]
    };
    const existing = { variants: [
      { variantId: 'old-a', productVariantId: identity.variants[0]!.variantId, vendorCode: '0000001-01', variantCode: '0000001-01', productVariantColor: identity.variants[0]!.wbColor },
      { variantId: 'old-b', productVariantId: identity.variants[1]!.variantId, vendorCode: '0000001-02', variantCode: '0000001-02', productVariantColor: identity.variants[1]!.wbColor },
      { variantId: 'old-unmanaged', productVariantId: '44444444-4444-4444-8444-444444444444', vendorCode: 'LEGACY-OLD', variantCode: 'LEGACY-OLD', productVariantColor: { colorKey: 'd'.repeat(64), nameRu: 'Красный', nameZh: '红色' } }
    ] };
    const resolved = {
      dependencies: dependencies(), issues: [], kizMarked: true,
      snapshot: preset.dependencySnapshot
    };

    const initialized = await (service as any).buildInitialization(identity, preset, resolved, existing);
    expect(initialized.data.variants.map((variant: any) => variant.vendorCode)).toEqual(['0000001-01', '0000001-02', '0000001-03']);
    expect(initialized.data.variants.slice(0, 2).map((variant: any) => variant.variantId)).toEqual(['old-a', 'old-b']);
    expect(initialized.data.initializationIssues).toContainEqual(expect.objectContaining({ code: 'UNMANAGED_EXISTING_VARIANT_PRESERVED' }));
  });

  it('rebuilds retry issues so recovered translation and E003 warnings do not remain stale', async () => {
    const previousBaseUrl = process.env.WB_AUTOMATION_BASE_URL;
    const previousKey = process.env.WB_AUTOMATION_KEY;
    process.env.WB_AUTOMATION_BASE_URL = 'http://127.0.0.1:5678';
    process.env.WB_AUTOMATION_KEY = 'test-key';
    try {
      const presetSnapshot = {
        name: preset.name,
        description: preset.description,
        pricingTemplateId: preset.pricingTemplateId,
        shippingTemplateId: preset.shippingTemplateId,
        shippingServiceCode: preset.shippingServiceCode,
        packaging: preset.packaging,
        categoryKey: preset.categoryKey,
        discountPercent: preset.discountPercent,
        clubDiscount: preset.clubDiscount,
        videoUploadMode: 'ORIGINAL',
        tnved: preset.tnved,
        brand: preset.brand,
        titleTranslation: preset.titleTranslation,
        descriptionSource: preset.descriptionSource,
        sharedCharacteristics: preset.sharedCharacteristics,
        variantCharacteristics: preset.variantCharacteristics,
        sizes: preset.sizes
      };
      let listing: Record<string, any> = {
        sku: '0000001', draftVersion: 4, priceCny: 100, titleRu: '', descriptionRu: '', videoUploadMode: 'ORIGINAL',
        variants: [
          { productVariantId: 'v1', productVariantName: '黑色', descriptionRu: 'Ручное описание черного варианта.' },
          { productVariantId: 'v2', productVariantName: '白色' }
        ],
        initialization: {
          presetId: preset.id, presetRowVersion: preset.rowVersion, presetSnapshot,
          dependencySnapshot: preset.dependencySnapshot, resolvedVersions: preset.dependencySnapshot,
          issues: [
            { code: 'TITLE_TRANSLATION_UNAVAILABLE', message: '旧配置警告', field: 'titleTranslation.workflowId', severity: 'WARNING', retryable: true },
            { code: 'TITLE_TRANSLATION_FAILED', message: '旧翻译错误', field: 'titleRu', severity: 'ERROR', retryable: true },
            { code: 'E003_DESCRIPTION_FALLBACK', message: '旧回退警告', field: 'descriptionRu', severity: 'WARNING', retryable: false },
            { code: 'E003_DESCRIPTION_MISSING', message: '旧白色详情缺失警告', field: 'variants.v2.descriptionRu', severity: 'WARNING', retryable: true },
            { code: 'TNVED_REQUIRED', message: '旧 TNVED 必填错误', field: 'tnved', severity: 'ERROR', retryable: false }
          ]
        }
      };
      const repository = {
        resolveDependencies: vi.fn(async () => dependencies()),
        resolveDependenciesAtSnapshot: vi.fn(async () => dependencies()),
        patchMissingListing: vi.fn(async (input: any) => {
          listing = { ...listing, ...input.patch, initialization: input.initialization, initializationIssues: input.initialization.issues, draftVersion: 5 };
        }),
        getTranslation: vi.fn(async () => undefined), putTranslation: vi.fn(async () => undefined)
      } as unknown as WbPresetRepository;
      const service = new WbPresetService(
        repository,
        { getListing: vi.fn(async () => listing) } as unknown as WbRepository,
        { getProductIdentityBySku: vi.fn(async () => ({ sku: '0000001', productName: '测试运动鞋', variants: [
          { variantId: 'v1', name: '黑色' },
          { variantId: 'v2', name: '白色' }
        ] })) } as unknown as PurchaseRepository,
        {} as PricingRepository,
        { getDirectory: vi.fn(async () => [{ tnved: '6404199000', isKiz: true }]) } as unknown as N8nWbClient,
        { get: () => ({ stages: [] }) } as unknown as ConfigService
      );
      vi.spyOn(service.translations, 'translate').mockResolvedValue({ contentTranslate: 'Тестовые кроссовки', cached: false });
      vi.spyOn(service.descriptions, 'resolveVariants').mockResolvedValue({
        status: 'READY',
        content: 'Автоматическое описание черного варианта.',
        source: { workflowCode: 'E003', executionId: 11, folderName: 'safe-black', fileName: 'black-detail.txt', sha256: 'a'.repeat(64) },
        variantSources: [
          {
            status: 'READY',
            content: 'Автоматическое описание черного варианта.',
            source: { workflowCode: 'E003', executionId: 11, folderName: 'safe-black', fileName: 'black-detail.txt', sha256: 'a'.repeat(64) },
            productVariantId: 'v1',
            productVariantName: '黑色'
          },
          {
            status: 'READY',
            content: 'Автоматическое описание белого варианта.',
            source: { workflowCode: 'E003', executionId: 12, folderName: 'safe-white', fileName: 'white-detail.txt', sha256: 'b'.repeat(64) },
            productVariantId: 'v2',
            productVariantName: '白色'
          }
        ]
      });

      const result = await service.initializeMissing('0000001', 4) as any;
      expect(result.initialization.issues).toEqual([]);
      expect(result.priceCny).toBe(100);
      expect(result.titleRu).toBe('Тестовые кроссовки');
      expect(result.descriptionRu).toBe('Автоматическое описание черного варианта.');
      expect(result.variants).toEqual([
        expect.objectContaining({ productVariantId: 'v1', descriptionRu: 'Ручное описание черного варианта.' }),
        expect.objectContaining({ productVariantId: 'v2', descriptionRu: 'Автоматическое описание белого варианта.' })
      ]);
      expect(result.initialization.description).toMatchObject({
        type: 'E003',
        status: 'READY',
        variantSources: [
          expect.objectContaining({ productVariantId: 'v1', executionId: 11, sha256: 'a'.repeat(64) }),
          expect.objectContaining({ productVariantId: 'v2', executionId: 12, sha256: 'b'.repeat(64) })
        ]
      });
      expect(result.videoUploadMode).toBe('ORIGINAL');
    } finally {
      if (previousBaseUrl === undefined) delete process.env.WB_AUTOMATION_BASE_URL; else process.env.WB_AUTOMATION_BASE_URL = previousBaseUrl;
      if (previousKey === undefined) delete process.env.WB_AUTOMATION_KEY; else process.env.WB_AUTOMATION_KEY = previousKey;
    }
  });

  it('价格重试复用草稿已捕获的有效毛重，不被后续采购版本覆盖', async () => {
    const grossWeightResolution = {
      source: 'PROCUREMENT', effectiveGrossWeightGrams: 650, procurementGrossWeightGrams: 650,
      presetGrossWeightGrams: 750, procurementVersionId: '33333333-3333-4333-8333-333333333333',
      procurementVersionNo: 3, procurementCapturedAt: '2026-07-18T00:00:00.000Z'
    };
    let listing: Record<string, any> = {
      sku: '0000001', draftVersion: 4, priceCny: 0, titleRu: 'Тестовая обувь', descriptionRu: 'A\\n\\nB',
      packaging: { ...preset.packaging, grossWeightGrams: 650 }, variants: [],
      initialization: {
        presetId: preset.id, presetRowVersion: preset.rowVersion, presetSnapshot: preset,
        dependencySnapshot: preset.dependencySnapshot, resolvedVersions: preset.dependencySnapshot,
        grossWeightResolution,
        issues: [{ code: 'PRICE_INITIALIZATION_FAILED', message: '旧定价错误', field: 'priceCny', severity: 'ERROR', retryable: true }]
      }
    };
    const repository = {
      resolveDependenciesAtSnapshot: vi.fn(async () => dependencies()),
      patchMissingListing: vi.fn(async (input: any) => {
        listing = { ...listing, ...input.patch, initialization: input.initialization, draftVersion: 5 };
      }),
      getTranslation: vi.fn(async () => undefined), putTranslation: vi.fn(async () => undefined)
    } as unknown as WbPresetRepository;
    const findPricingProducts = vi.fn(async () => [{ sku: '0000001', productName: '测试运动鞋', procurement: {
      id: '99999999-9999-4999-8999-999999999999', versionNo: 9, purchasePrice: '24', courierFee: '1', currency: 'CNY',
      grossWeightGrams: '999', createdAt: '2026-07-22T00:00:00.000Z'
    } }]);
    const pricing = { calculate: vi.fn(async () => ({
      pricingTemplate: { versionId: 'p-v1', versionNo: 1 },
      options: [{ shipping: { serviceCode: 'CEL_WB_ECONOMY', template: { versionId: 's-v1', versionNo: 1 } }, amounts: {
        listing: { costCurrency: { currencyCode: 'CNY', displayValue: '400' } },
        targetSale: { costCurrency: { currencyCode: 'CNY', displayValue: '204' } }
      } }]
    })) };
    const service = new WbPresetService(
      repository,
      { getListing: vi.fn(async () => listing) } as unknown as WbRepository,
      {
        getProductIdentityBySku: vi.fn(async () => ({
          sku: '0000001', productName: '测试运动鞋', variants: [{ variantId: 'v1', name: '黑色' }]
        })),
        findPricingProducts
      } as unknown as PurchaseRepository,
      pricing as unknown as PricingRepository,
      { getDirectory: vi.fn(async () => [{ tnved: preset.tnved, isKiz: true }]) } as unknown as N8nWbClient,
      { get: () => ({ stages: [] }) } as unknown as ConfigService
    );

    const result = await service.initializeMissing('0000001', 4) as any;

    expect(findPricingProducts).toHaveBeenCalledTimes(1);
    expect(pricing.calculate).toHaveBeenCalledWith(expect.objectContaining({
      item: expect.objectContaining({ actualWeightGrams: '650' })
    }));
    expect(result.priceCny).toBe(400);
    expect(result.initialization.grossWeightResolution).toEqual(grossWeightResolution);
    expect(result.initialization.issues.some((item: any) => item.code === 'PRICE_INITIALIZATION_FAILED')).toBe(false);
  });

  it('requires a default preset', async () => {
    const service = new WbPresetService(
      { getDefault: vi.fn(async () => undefined) } as unknown as WbPresetRepository,
      { getListing: vi.fn(async () => { throw new AppError('NOT_FOUND', 'WB 上品草稿不存在', undefined, 404); }) } as unknown as WbRepository,
      {} as PurchaseRepository, {} as PricingRepository, {} as N8nWbClient,
      { get: () => ({ stages: [] }) } as unknown as ConfigService
    );
    await expect(service.createListing('0000001')).rejects.toMatchObject({ code: 'WB_DEFAULT_PRESET_REQUIRED', statusCode: 409 });
  });

  it('creates a public manual material task without reading a global default preset', async () => {
    const createPublicMaterialListing = vi.fn(async () => undefined);
    const getDefault = vi.fn(async () => undefined);
    const getListing = vi.fn()
      .mockRejectedValueOnce(new AppError('NOT_FOUND', 'WB 上品草稿不存在', undefined, 404))
      .mockResolvedValueOnce({
        sku: '0000122', draftVersion: 1,
        variants: [{ productVariantId: '11111111-1111-4111-8111-111111111111', productVariantName: '黑色' }]
      });
    const service = new WbPresetService(
      { getDefault, createPublicMaterialListing } as unknown as WbPresetRepository,
      { getListing } as unknown as WbRepository,
      {
        getProductIdentityBySku: vi.fn(async () => ({
          sku: '0000122', productName: '测试商品',
          variants: [{ variantId: '11111111-1111-4111-8111-111111111111', name: '黑色' }]
        }))
      } as unknown as PurchaseRepository,
      {} as PricingRepository, {} as N8nWbClient,
      { get: () => ({ stages: [] }) } as unknown as ConfigService
    );

    await expect(service.createPublicMaterialListing('0000122')).resolves.toMatchObject({
      sku: '0000122', draftVersion: 1
    });
    expect(createPublicMaterialListing).toHaveBeenCalledWith(expect.objectContaining({
      sku: '0000122',
      data: expect.objectContaining({
        initialization: expect.objectContaining({ kind: 'PUBLIC_MATERIAL' }),
        variants: [expect.objectContaining({ productVariantId: '11111111-1111-4111-8111-111111111111' })]
      })
    }));
    expect(getDefault).not.toHaveBeenCalled();
  });

  it('allows an empty TNVED for supported and unsupported categories without querying WB', async () => {
    const blankPreset = {
      ...preset,
      tnved: '',
      sharedCharacteristics: preset.sharedCharacteristics.filter((item) => item.id !== 15004139)
    };
    const create = vi.fn(async (definition: any, snapshot: any) => ({
      ...blankPreset,
      ...definition,
      dependencySnapshot: snapshot,
      rowVersion: 1,
      isDefault: true
    }));
    const setDefault = vi.fn(async () => blankPreset);
    const repository = {
      create,
      get: vi.fn(async () => blankPreset),
      setDefault,
      resolveDependencies: vi.fn(async () => dependencies()),
      getTranslation: vi.fn(async () => undefined),
      putTranslation: vi.fn(async () => undefined)
    } as unknown as WbPresetRepository;
    const getDirectory = vi.fn();
    const service = new WbPresetService(
      repository, {} as WbRepository, {} as PurchaseRepository, {} as PricingRepository,
      { getDirectory } as unknown as N8nWbClient,
      { get: () => ({ stages: [] }) } as unknown as ConfigService
    );

    await expect(service.create(blankPreset)).resolves.toMatchObject({ tnved: '', readiness: 'READY' });
    await expect(service.setDefault(blankPreset.id, blankPreset.rowVersion)).resolves.toMatchObject({ tnved: '', readiness: 'READY' });
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ tnved: '' }), expect.any(Object), true);
    expect(setDefault).toHaveBeenCalled();
    expect(getDirectory).not.toHaveBeenCalled();

    const withoutTnved = dependencies() as any;
    withoutTnved.category.liveSchema = withoutTnved.category.liveSchema.filter((item: any) => item.charcID !== 15004139);
    withoutTnved.category.formConfig.fields = withoutTnved.category.formConfig.fields.filter((item: any) => item.characteristicId !== 15004139);
    withoutTnved.category.formConfig.compliance = {};
    (repository.resolveDependencies as any).mockResolvedValue(withoutTnved);
    await expect(service.create(blankPreset)).resolves.toMatchObject({ tnved: '', readiness: 'READY' });
    await expect(service.create({ ...blankPreset, tnved: '6404199000' })).rejects.toMatchObject({
      code: 'CONFIG_INVALID',
      details: { issues: expect.arrayContaining([expect.objectContaining({ code: 'TNVED_NOT_SUPPORTED_BY_CATEGORY' })]) }
    });
    expect(getDirectory).not.toHaveBeenCalled();
  });

  it('requires TNVED only when the WB live schema marks the characteristic required', async () => {
    const requiredDependencies = dependencies();
    requiredDependencies.category.liveSchema = requiredDependencies.category.liveSchema.map((item: any) =>
      item.charcID === 15004139 ? { ...item, required: true } : item
    );
    requiredDependencies.category.formConfig.fields = requiredDependencies.category.formConfig.fields.map((field: any) =>
      field.characteristicId === 15004139 ? { ...field, required: false } : field
    );
    const create = vi.fn();
    const getDirectory = vi.fn();
    const service = new WbPresetService(
      {
        resolveDependencies: vi.fn(async () => requiredDependencies), create,
        getTranslation: vi.fn(async () => undefined), putTranslation: vi.fn(async () => undefined)
      } as unknown as WbPresetRepository,
      {} as WbRepository, {} as PurchaseRepository, {} as PricingRepository,
      { getDirectory } as unknown as N8nWbClient,
      { get: () => ({ stages: [] }) } as unknown as ConfigService
    );

    await expect(service.create({ ...preset, tnved: '', sharedCharacteristics: [] })).rejects.toMatchObject({
      code: 'CONFIG_INVALID',
      details: { issues: expect.arrayContaining([expect.objectContaining({ code: 'TNVED_REQUIRED', message: 'TNVED为必填项目' })]) }
    });
    expect(create).not.toHaveBeenCalled();
    expect(getDirectory).not.toHaveBeenCalled();
  });

  it('rejects malformed non-empty TNVED before querying the WB directory', async () => {
    const getDirectory = vi.fn();
    const service = new WbPresetService(
      {} as WbPresetRepository, {} as WbRepository, {} as PurchaseRepository, {} as PricingRepository,
      { getDirectory } as unknown as N8nWbClient,
      { get: () => ({ stages: [] }) } as unknown as ConfigService
    );
    await expect(service.create({ ...preset, tnved: '64041A9000' })).rejects.toMatchObject({ code: 'CONFIG_INVALID', statusCode: 400 });
    expect(getDirectory).not.toHaveBeenCalled();
  });

  it('initializes an empty TNVED without writing an empty characteristic', async () => {
    const blankPreset = { ...preset, tnved: '' };
    const service = new WbPresetService(
      {} as WbPresetRepository,
      {} as WbRepository,
      { findPricingProducts: vi.fn(async () => [{ sku: '0000001', productName: '测试鞋', procurement: {
        id: '55555555-5555-4555-8555-555555555555', versionNo: 1, purchasePrice: '20', courierFee: '0', currency: 'CNY', createdAt: '2026-07-18T00:00:00.000Z'
      } }]) } as unknown as PurchaseRepository,
      { calculate: vi.fn(async () => ({
        pricingTemplate: { versionId: 'p-v1', versionNo: 1 },
        options: [{ shipping: { serviceCode: 'CEL_WB_ECONOMY', template: { versionId: 's-v1', versionNo: 1 } }, amounts: {
          listing: { costCurrency: { currencyCode: 'CNY', displayValue: '100' } },
          targetSale: { costCurrency: { currencyCode: 'CNY', displayValue: '51' } }
        } }]
      })) } as unknown as PricingRepository,
      { getDirectory: vi.fn() } as unknown as N8nWbClient,
      { get: () => ({ stages: [] }) } as unknown as ConfigService
    );
    vi.spyOn(service.translations, 'translate').mockResolvedValue({ contentTranslate: 'Тестовые кроссовки', cached: false });
    vi.spyOn(service.descriptions, 'resolveVariants').mockResolvedValue({
      status: 'READY',
      content: 'A\\n\\nB',
      source: { workflowCode: 'E003', executionId: 12, folderName: 'safe', fileName: 'detail.txt', sha256: 'hash', productVariantId: 'v1', variantName: '默认变体' },
      variantSources: [{
        status: 'READY',
        content: 'A\\n\\nB',
        source: { workflowCode: 'E003', executionId: 12, folderName: 'safe', fileName: 'detail.txt', sha256: 'hash', productVariantId: 'v1', variantName: '默认变体' },
        productVariantId: 'v1',
        productVariantName: '默认变体'
      }]
    });

    const initialized = await (service as any).buildInitialization(
      { sku: '0000001', productName: '测试鞋', variants: [{ variantId: 'v1', name: '默认变体' }] },
      blankPreset,
      { dependencies: dependencies(), snapshot: blankPreset.dependencySnapshot, issues: [] }
    );
    expect(initialized.data.compliance).toEqual({ tnved: '', kizMarked: false });
    expect(initialized.data.sharedCharacteristics).not.toContainEqual(expect.objectContaining({ id: 15004139 }));
  });

  it('creates a partial sizeless draft when price, translation, and E003 runtime steps fail', async () => {
    const sizelessPreset = { ...preset, categoryKey: 'bags', sizes: [{ ...preset.sizes[0]!, techSize: undefined, wbSize: undefined, stock: 7 }] };
    let stored: Record<string, any> | undefined;
    const repository = {
      getDefault: vi.fn(async () => sizelessPreset),
      resolveDependencies: vi.fn(async () => ({
        ...dependencies(),
        category: { ...dependencies().category, categoryKey: 'bags', formConfig: { ...dependencies().category.formConfig, sizeMode: 'sizeless', media: { minImages: 1, maxImages: 30, videoAllowed: true, defaultVideoUploadMode: 'ORIGINAL' } } }
      })),
      createInitializedListing: vi.fn(async (input: any) => { stored = input.data; return true; }),
      getTranslation: vi.fn(async () => undefined), putTranslation: vi.fn(async () => undefined)
    } as unknown as WbPresetRepository;
    const wb = { getListing: vi.fn(async () => {
      if (!stored) throw new AppError('NOT_FOUND', 'WB 上品草稿不存在', undefined, 404);
      return { sku: '0000001', ...stored, draftVersion: 1 };
    }) } as unknown as WbRepository;
    const purchases = {
      getProductIdentityBySku: vi.fn(async () => ({ sku: '0000001', productName: '测试背包', variants: [
        { variantId: 'v1', name: '黑色' }, { variantId: 'v2', name: '白色' }
      ] })),
      findPricingProducts: vi.fn(async () => [{ sku: '0000001', productName: '测试背包', procurement: {
        id: '66666666-6666-4666-8666-666666666666', versionNo: 1, purchasePrice: '10', courierFee: '2', currency: 'CNY', createdAt: '2026-07-18T00:00:00.000Z'
      } }])
    } as unknown as PurchaseRepository;
    const pricing = { calculate: vi.fn(async () => ({
      pricingTemplate: { versionId: 'p-v999', versionNo: 999 },
      options: [{ shipping: { serviceCode: 'CEL_WB_ECONOMY', template: { versionId: 's-v1', versionNo: 1 } }, amounts: {
        listing: { costCurrency: { currencyCode: 'CNY', displayValue: '200' } },
        targetSale: { costCurrency: { currencyCode: 'CNY', displayValue: '100' } }
      } }]
    })) } as unknown as PricingRepository;
    const service = new WbPresetService(
      repository, wb, purchases, pricing,
      { getDirectory: vi.fn(async () => [{ tnved: sizelessPreset.tnved, isKiz: false }]) } as unknown as N8nWbClient,
      { get: () => ({ stages: [] }) } as unknown as ConfigService
    );
    vi.spyOn(service.translations, 'translate').mockRejectedValue(new Error('模拟翻译失败'));
    vi.spyOn(service.descriptions, 'resolveVariants').mockResolvedValue({
      status: 'MISSING',
      message: '模拟 E003 缺失',
      variantSources: [
        { status: 'MISSING', message: '模拟 E003 缺失', productVariantId: 'v1', productVariantName: '黑色' },
        { status: 'MISSING', message: '模拟 E003 缺失', productVariantId: 'v2', productVariantName: '白色' }
      ]
    });

    const listing = await service.createListing('0000001') as any;
    expect(listing).toMatchObject({ priceCny: 0, titleRu: '', descriptionRu: '', videoUploadMode: 'ORIGINAL', compliance: { kizMarked: false } });
    expect(listing.packaging).toEqual({ grossWeightGrams: 750, lengthCm: 30, widthCm: 15, heightCm: 10 });
    expect(listing.initialization.grossWeightResolution).toEqual({
      source: 'PRESET_FALLBACK', effectiveGrossWeightGrams: 750, procurementGrossWeightGrams: null,
      presetGrossWeightGrams: 750, procurementVersionId: '66666666-6666-4666-8666-666666666666',
      procurementVersionNo: 1, procurementCapturedAt: expect.any(String)
    });
    expect((purchases.findPricingProducts as any)).toHaveBeenCalledTimes(1);
    expect(listing.initialization.issues.map((item: any) => item.code)).toEqual(expect.arrayContaining([
      'PRICE_INITIALIZATION_FAILED', 'TITLE_TRANSLATION_FAILED', 'E003_DESCRIPTION_MISSING'
    ]));
    expect(listing.initialization.issues.find((item: any) => item.code === 'E003_DESCRIPTION_MISSING')).toMatchObject({
      severity: 'WARNING'
    });
    expect(listing.initialization.issues.find((item: any) => item.code === 'PRICE_INITIALIZATION_FAILED').message).toContain('版本变化');
    expect(listing.variants).toHaveLength(2);
    for (const variant of listing.variants) {
      expect(variant.sizes).toEqual([expect.objectContaining({ barcode: '', stock: 7 })]);
      expect(variant.sizes[0]).not.toHaveProperty('techSize');
      expect(variant.sizes[0]).not.toHaveProperty('wbSize');
    }
  });

  it('requires rowVersion for default and delete mutations', async () => {
    const service = new WbPresetService(
      {} as WbPresetRepository, {} as WbRepository, {} as PurchaseRepository, {} as PricingRepository, {} as N8nWbClient,
      { get: () => ({ stages: [] }) } as unknown as ConfigService
    );
    await expect(service.setDefault(preset.id, Number.NaN)).rejects.toMatchObject({ code: 'CONFIG_INVALID', statusCode: 400 });
    await expect(service.delete(preset.id, Number.NaN)).rejects.toMatchObject({ code: 'CONFIG_INVALID', statusCode: 400 });
  });

  it('rejects the removed preset-level video upload setting with a clear replacement path', async () => {
    const service = new WbPresetService(
      {} as WbPresetRepository, {} as WbRepository, {} as PurchaseRepository, {} as PricingRepository, {} as N8nWbClient,
      { get: () => ({ stages: [] }) } as unknown as ConfigService
    );
    await expect(service.create({ ...preset, videoUploadMode: 'ORIGINAL' })).rejects.toMatchObject({
      code: 'CONFIG_INVALID', statusCode: 400,
      details: { field: 'videoUploadMode', replacement: 'category.formConfig.media.defaultVideoUploadMode' }
    });
  });

  it('rejects purchase-managed characteristic defaults from old clients', async () => {
    const service = new WbPresetService(
      {} as WbPresetRepository,
      {} as WbRepository,
      {} as PurchaseRepository,
      {} as PricingRepository,
      {} as N8nWbClient,
      { get: () => ({ stages: [] }) } as unknown as ConfigService
    );

    await expect(service.create({
      ...preset,
      sharedCharacteristics: [...preset.sharedCharacteristics, { id: 89008, value: 0 }]
    })).rejects.toMatchObject({
      code: 'PRESET_CHARACTERISTIC_SYSTEM_MANAGED',
      statusCode: 400,
      details: { characteristicIds: [89008] }
    });
  });

  it('marks a preset DRIFT when a referenced published version changes', async () => {
    const changed = dependencies();
    changed.pricing = { ...changed.pricing, versionId: 'p-v2', versionNo: 2 };
    const service = new WbPresetService(
      { get: vi.fn(async () => preset), resolveDependencies: vi.fn(async () => changed) } as unknown as WbPresetRepository,
      {} as WbRepository, {} as PurchaseRepository, {} as PricingRepository, {} as N8nWbClient,
      { get: () => ({ stages: [] }) } as unknown as ConfigService
    );
    await expect(service.get(preset.id)).resolves.toMatchObject({
      readiness: 'DRIFT',
      issues: expect.arrayContaining([expect.objectContaining({ code: 'DEPENDENCY_VERSION_DRIFT', severity: 'WARNING' })]),
      resolvedDependencies: { pricing: { versionId: 'p-v2', versionNo: 2, snapshotVersionId: 'p-v1', snapshotVersionNo: 1 } }
    });
  });

  it('rejects provided characteristic defaults with an unknown ID, wrong scope, or invalid live-schema value', async () => {
    const create = vi.fn();
    const repository = {
      resolveDependencies: vi.fn(async () => dependencies()),
      create,
      getTranslation: vi.fn(async () => undefined),
      putTranslation: vi.fn(async () => undefined)
    } as unknown as WbPresetRepository;
    const service = new WbPresetService(
      repository, {} as WbRepository, {} as PurchaseRepository, {} as PricingRepository,
      { getDirectory: vi.fn(async () => [{ tnved: preset.tnved, isKiz: true }]) } as unknown as N8nWbClient,
      { get: () => ({ stages: [] }) } as unknown as ConfigService
    );
    const invalid = {
      ...preset,
      sharedCharacteristics: [
        { id: 14177449, value: ['Черный'] },
        { id: 25471, value: ['不是数字'] },
        { id: 99999999, value: ['unknown'] }
      ],
      variantCharacteristics: []
    };

    await expect(service.create(invalid)).rejects.toMatchObject({
      code: 'CONFIG_INVALID',
      details: { issues: expect.arrayContaining([
        expect.objectContaining({ code: 'PRESET_CHARACTERISTIC_SCOPE_MISMATCH' }),
        expect.objectContaining({ code: 'PRESET_CHARACTERISTIC_VALUE_INVALID' }),
        expect.objectContaining({ code: 'PRESET_CHARACTERISTIC_NOT_MANAGED' })
      ]) }
    });
    expect(create).not.toHaveBeenCalled();
  });
});

function dependencies() {
  return {
    pricing: { id: preset.pricingTemplateId, name: 'WB', active: true, platformCode: 'WB', versionId: 'p-v1', versionNo: 1, definition: { costCurrencyCode: 'CNY' } },
    shipping: { id: preset.shippingTemplateId, name: 'CEL', active: true, carrierActive: true, platformCode: 'WB', versionId: 's-v1', versionNo: 1, definition: { services: [{ code: 'CEL_WB_ECONOMY', rules: [] }] } },
    category: {
      categoryKey: 'shoes', nameRu: 'Кроссовки', nameZh: '运动鞋', subjectId: 105, active: true, versionId: 'c-v1', versionNo: 1,
      liveSchema: [
        { charcID: 15004139, charcType: 1, maxCount: 1, required: false },
        { charcID: 204557, charcType: 1, maxCount: 1 },
        { charcID: 14177449, charcType: 1, maxCount: 3 },
        { charcID: 25471, charcType: 4, maxCount: 1 }
      ],
      formConfig: { sizeMode: 'sized', fields: [
        { fieldId: 'tnved', characteristicId: 15004139, scope: 'shared' },
        { fieldId: 'gender', characteristicId: 204557, scope: 'shared' },
        { fieldId: 'color', characteristicId: 14177449, scope: 'variant' },
        { fieldId: 'weight', characteristicId: 25471, scope: 'shared' }
      ], compliance: { tnvedCharacteristicId: 15004139 } },
      schemaHash: `sha256:${'a'.repeat(64)}`
    }
  };
}

function createGrossWeightPublicHarness(existing: boolean) {
  const dependencySnapshot = {
    pricingTemplateVersionId: '71111111-1111-4111-8111-111111111111', pricingTemplateVersionNo: 7,
    shippingTemplateVersionId: '72222222-2222-4222-8222-222222222222', shippingTemplateVersionNo: 7,
    categoryVersionId: '73333333-3333-4333-8333-333333333333', categoryVersionNo: 7,
    capturedAt: '2026-07-21T10:00:00.000Z'
  };
  const boundPreset = {
    ...preset,
    autoPublishEnabled: true,
    autoPublishMode: 'COMPATIBLE_UPSERT' as const,
    autoPublishActivatedAt: '2026-07-21T10:00:00.000Z',
    dependencySnapshot
  };
  const resolvedDependencies = dependencies() as any;
  resolvedDependencies.pricing = {
    ...resolvedDependencies.pricing,
    versionId: dependencySnapshot.pricingTemplateVersionId,
    versionNo: dependencySnapshot.pricingTemplateVersionNo
  };
  resolvedDependencies.shipping = {
    ...resolvedDependencies.shipping,
    versionId: dependencySnapshot.shippingTemplateVersionId,
    versionNo: dependencySnapshot.shippingTemplateVersionNo
  };
  resolvedDependencies.category = {
    ...resolvedDependencies.category,
    versionId: dependencySnapshot.categoryVersionId,
    versionNo: dependencySnapshot.categoryVersionNo
  };
  let listing: Record<string, any> | undefined = existing
    ? { sku: '0000001', draftVersion: 2, variants: [], packaging: preset.packaging }
    : undefined;
  const repository = {
    getDefault: vi.fn(async () => boundPreset),
    resolveDependencies: vi.fn(async () => resolvedDependencies),
    resolveDependenciesAtSnapshot: vi.fn(async () => resolvedDependencies),
    createInitializedListing: vi.fn(async (input: any) => {
      listing = { sku: input.sku, ...input.data, draftVersion: 1 };
      return true;
    }),
    replaceInitializedListing: vi.fn(async (input: any) => {
      listing = { sku: input.sku, ...input.data, draftVersion: Number(listing?.draftVersion || 0) + 1 };
    }),
    getTranslation: vi.fn(async () => undefined),
    putTranslation: vi.fn(async () => undefined)
  };
  const findPricingProducts = vi.fn(async () => [{
    sku: '0000001',
    productName: '测试鞋',
    updatedAt: '2026-07-21T10:00:00.000Z',
    procurement: {
      id: '88888888-8888-4888-8888-888888888888', versionNo: 8, purchasePrice: '25', courierFee: '1', currency: 'CNY',
      grossWeightGrams: '612.75', productHeightCm: null, productDepthCm: null, productWidthCm: null, netWeightGrams: null,
      createdAt: '2026-07-21T09:00:00.000Z'
    }
  }]);
  const pricing = {
    calculate: vi.fn(async () => ({
      pricingTemplate: { versionId: dependencySnapshot.pricingTemplateVersionId, versionNo: dependencySnapshot.pricingTemplateVersionNo },
      options: [{
        shipping: {
          serviceCode: 'CEL_WB_ECONOMY',
          template: { versionId: dependencySnapshot.shippingTemplateVersionId, versionNo: dependencySnapshot.shippingTemplateVersionNo }
        },
        amounts: {
          listing: { costCurrency: { currencyCode: 'CNY', displayValue: '300' } },
          targetSale: { costCurrency: { currencyCode: 'CNY', displayValue: '153' } }
        }
      }]
    }))
  };
  const service = new WbPresetService(
    repository as unknown as WbPresetRepository,
    { getListing: vi.fn(async () => {
      if (!listing) throw new AppError('NOT_FOUND', 'WB 上品草稿不存在', undefined, 404);
      return listing;
    }) } as unknown as WbRepository,
    {
      getProductIdentityBySku: vi.fn(async () => ({
        sku: '0000001', productName: '测试鞋', variants: [{ variantId: 'v1', name: '黑色' }]
      })),
      findPricingProducts
    } as unknown as PurchaseRepository,
    pricing as unknown as PricingRepository,
    { getDirectory: vi.fn(async () => [{ tnved: preset.tnved, isKiz: false }]) } as unknown as N8nWbClient,
    { get: () => ({ stages: [] }) } as unknown as ConfigService
  );
  vi.spyOn(service.translations, 'translate').mockResolvedValue({ contentTranslate: 'Тестовая обувь', cached: false });
  vi.spyOn(service.descriptions, 'resolveVariants').mockResolvedValue({
    status: 'READY', content: 'A\\n\\nB',
    source: { workflowCode: 'E003', executionId: 20, folderName: 'safe', fileName: 'detail.txt', sha256: 'hash' },
    variantSources: [{
      status: 'READY', content: 'A\\n\\nB', productVariantId: 'v1', productVariantName: '黑色',
      source: { workflowCode: 'E003', executionId: 20, folderName: 'safe', fileName: 'detail.txt', sha256: 'hash' }
    }]
  });
  return { service, boundPreset, repository, findPricingProducts, pricing };
}
