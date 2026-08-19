import { describe, expect, it, vi } from 'vitest';
import { AppError } from '@n8n-media-review/shared';
import { WbStoreService } from './index.js';
import { wbMaterialPresetDefinitionHash } from '../wb-presets/material-hash.js';

const storeId = '11111111-1111-4111-8111-111111111111';
const credentialVersionId = '22222222-2222-4222-8222-222222222222';

function publicationPreset(id: string, name: string, discountPercent = 40) {
  return {
    id,
    rowVersion: 1,
    isDefault: false,
    name,
    description: '',
    autoPublishEnabled: false,
    autoPublishMode: 'CREATE_ONLY',
    pricingTemplateId: '31111111-1111-4111-8111-111111111111',
    shippingTemplateId: '32222222-2222-4222-8222-222222222222',
    shippingServiceCode: 'CEL_WB_ECONOMY',
    packaging: { grossWeightGrams: 750, lengthCm: 30, widthCm: 15, heightCm: 10 },
    categoryKey: 'shoes',
    discountPercent,
    clubDiscount: 5,
    tnved: '6404199000',
    brand: '',
    titleTranslation: { workflowId: 'W2lSSXE3NUaLW1tD', language: '俄文', maxLength: 60 },
    descriptionSource: 'E003',
    sharedCharacteristics: [],
    variantCharacteristics: [],
    sizes: [{ sizeId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', techSize: '40', wbSize: '40', stock: 3 }],
    dependencySnapshot: {
      pricingTemplateVersionId: '41111111-1111-4111-8111-111111111111',
      pricingTemplateVersionNo: 1,
      shippingTemplateVersionId: '42222222-2222-4222-8222-222222222222',
      shippingTemplateVersionNo: 1,
      categoryVersionId: '43333333-3333-4333-8333-333333333333',
      categoryVersionNo: 1,
      capturedAt: '2026-08-10T08:00:00.000Z'
    },
    createdAt: '2026-08-10T08:00:00.000Z',
    updatedAt: '2026-08-10T08:00:00.000Z'
  };
}

function presetPreview(preset: ReturnType<typeof publicationPreset>) {
  return {
    preset,
    presetSnapshot: preset,
    dependencySnapshot: preset.dependencySnapshot,
    presetDefinitionHash: wbMaterialPresetDefinitionHash({ presetSnapshot: preset, dependencySnapshot: preset.dependencySnapshot }),
    discountPercent: preset.discountPercent,
    expectedPriceCny: preset.discountPercent === 49 ? 199 : preset.discountPercent === 45 ? 189 : 180,
    categoryKey: preset.categoryKey,
    categoryName: '鞋类',
    packaging: preset.packaging,
    procurementSource: { procurementVersionId: '77777777-7777-4777-8777-777777777777', procurementVersionNo: 2 },
    categoryVersionId: preset.dependencySnapshot.categoryVersionId,
    issues: []
  };
}

function readyStore(id: string, alias: string, presetId: string, credentialId: string) {
  return {
    id,
    storeAlias: alias,
    displayName: alias,
    enabled: true,
    autoPublishEnabled: true,
    autoPublishMode: 'CREATE_ONLY',
    defaultPresetId: presetId,
    warehouseId: `warehouse-${alias}`,
    warehouseName: alias,
    accountCurrency: 'CNY',
    maxDailyStyles: 100,
    credential: { state: 'ACTIVE', configured: true, activeVersionId: credentialId },
    seller: { id: `seller-${alias}` },
    permissions: ['content', 'prices', 'marketplace'],
    preflight: { status: 'PASSED' },
    network: { status: 'READY' },
    readiness: { ready: true, blockers: [] },
    activeTaskCount: 0,
    queuedTaskCount: 0,
    configVersion: 1,
    rowVersion: 1,
    createdAt: '2026-08-10T08:00:00.000Z',
    updatedAt: '2026-08-10T08:00:00.000Z'
  };
}

function harness() {
  const repository = {
    beginPreflight: vi.fn(async () => ({
      store: { storeAlias: 'second', accountCurrency: 'CNY' },
      storeConfigVersion: 7,
      credentialVersionId
    })),
    applyPreflightReport: vi.fn(async () => ({ id: storeId, preflight: { status: 'PASSED' } }))
  };
  const n8n = { preflightStore: vi.fn(async () => ({ accepted: true })) };
  const service = new WbStoreService(repository as any, {} as any, { n8n } as any);
  return { repository, n8n, service };
}

describe('WbStoreService preflight contract', () => {
  it('passes the configured currency to C001 and accepts the strict verified report shape', async () => {
    const { repository, n8n, service } = harness();
    await expect(service.preflight(storeId)).resolves.toMatchObject({ accepted: true });
    expect(n8n.preflightStore).toHaveBeenCalledWith(expect.objectContaining({
      storeId,
      storeAlias: 'second',
      storeConfigVersion: 7,
      credentialVersionId,
      accountCurrency: 'CNY'
    }));

    const report = {
      ok: true,
      sellerId: 'e8923014-e233-47a8-898e-3cc86d67ea61',
      sellerName: 'Seller',
      permissions: ['content', 'prices', 'marketplace'],
      accountCurrency: 'CNY',
      warehouses: [{ id: '12345', name: 'Main' }],
      checkedAt: '2026-08-10T08:00:00.000Z',
      details: {
        currencySource: 'WB_PRICE_LIST',
        currencyVerified: true,
        currencyVerification: 'VERIFIED',
        checks: { seller: { ok: true }, content: { ok: true }, prices: { ok: true }, marketplace: { ok: true } }
      }
    };
    await expect(service.applyPreflightReport(storeId, {
      report, storeConfigVersion: 7, credentialVersionId
    })).resolves.toMatchObject({ preflight: { status: 'PASSED' } });
    expect(repository.applyPreflightReport).toHaveBeenCalledWith(storeId, 7, credentialVersionId, report);
  });

  it('rejects the former C001 transport-only report instead of activating a credential', async () => {
    const { repository, service } = harness();
    await expect(service.applyPreflightReport(storeId, {
      report: {
        checkedAt: '2026-08-10T08:00:00.000Z',
        storeId,
        storeAlias: 'second',
        checks: {},
        transportReady: true,
        readyForStoreValidation: true,
        warehouses: [{ id: '12345', name: 'Main' }]
      },
      storeConfigVersion: 7,
      credentialVersionId
    })).rejects.toMatchObject({ code: 'CONFIG_INVALID' });
    expect(repository.applyPreflightReport).not.toHaveBeenCalled();
  });
});

describe('WbStoreService manual publication dispatch boundary', () => {
  function dispatchHarness(
    submitListing: ReturnType<typeof vi.fn>,
    getJob = vi.fn(),
    autoPublishMode: 'CREATE_ONLY' | 'COMPATIBLE_UPSERT' = 'CREATE_ONLY'
  ) {
    const sku = '0000110';
    const generatedVersionId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const presetId = '55555555-5555-4555-8555-555555555555';
    const preset = publicationPreset(presetId, 'shared', 40);
    const materialHash = wbMaterialPresetDefinitionHash({
      presetSnapshot: preset,
      dependencySnapshot: preset.dependencySnapshot
    });
    const store = { ...readyStore(storeId, 'second', presetId, credentialVersionId), autoPublishMode };
    let publication: any;
    const repository = {
      getPlanningContext: vi.fn(async () => ({
        sku, productName: 'shoe', draftVersion: 3, baseGeneratedVersionId: generatedVersionId, listingStatus: 'GENERATED',
        listingData: { variants: [] }, mediaAssets: [], variantMedia: [], stores: [store]
      })),
      getSettings: vi.fn(async () => ({ rowVersion: 1, rootDirectory: 'F:/wb' })),
      createMaterializedPublication: vi.fn(async (item: any) => {
        if (!publication) {
          publication = {
            ...item, generatedVersionId, revision: 2, taskId: 'second__0000110__r2',
            status: 'PLANNED', nmIds: [], productUrls: [], result: {}, rowVersion: 1,
            createdAt: '2026-08-10T08:00:00.000Z', updatedAt: '2026-08-10T08:00:00.000Z'
          };
        }
        return publication;
      }),
      recordPublicationPackage: vi.fn(async () => publication),
      markPublicationDispatching: vi.fn(async () => {
        publication = { ...publication, status: 'DISPATCHING' };
        return publication;
      }),
      markPublicationQueued: vi.fn(async (_id: string, taskId: string, raw: any) => {
        publication = { ...publication, status: 'QUEUED', taskId, result: raw };
        return publication;
      }),
      markPublicationDispatchUnknown: vi.fn(async (_id: string, taskId: string, code: string, message: string) => {
        publication = {
          ...publication, status: 'DISPATCHING', taskId, errorCode: code, errorMessage: message,
          result: { ...publication.result, dispatchRecovery: { deliveryUnknown: true, taskId } }
        };
        return publication;
      }),
      markPublicationFailed: vi.fn(async (_id: string, code: string, message: string) => {
        publication = { ...publication, status: 'NEEDS_ATTENTION', errorCode: code, errorMessage: message };
        return publication;
      })
    };
    const publishing = {
      n8n: { submitListing, getJob },
      storePublicationMediaTargetVendorCodes: vi.fn(async () => ['0000110-01', '0000110-02']),
      prepareStorePublicationPackage: vi.fn(async () => ({
        markerPath: 'F:/wb/inbox/0000110/.store-ready/publication.json',
        productSha256: `sha256:${'a'.repeat(64)}`,
        sourceContentSignature: `sha256:${'b'.repeat(64)}`,
        packageRelPath: 'stores/second/inbox/0000110/publication',
        packageSignature: `sha256:${'b'.repeat(64)}`,
        reused: false
      })),
      cleanupStorePublicationPackage: vi.fn(async () => true)
    };
    const service = new WbStoreService(
      repository as any,
      {
        previewStoreListing: vi.fn(async () => presetPreview(preset)),
        materializeStoreListing: vi.fn(async () => ({
          data: { variants: [] }, category: { versionId: preset.dependencySnapshot.categoryVersionId },
          preset, presetSnapshot: preset, dependencySnapshot: preset.dependencySnapshot,
          presetDefinitionHash: materialHash
        }))
      } as any,
      publishing as any
    );
    const selection = { draftVersion: 3, stores: [{ storeId }] };
    return {
      service,
      repository,
      publishing,
      selection,
      get publication() { return publication; },
      async create() {
        const plan = await service.publicationPlan(sku, selection);
        return service.createPublications(sku, { ...selection, planHash: plan.planHash });
      }
    };
  }

  it('marks an explicit manual 403 rejection as NEEDS_ATTENTION', async () => {
    const submitListing = vi.fn(async () => {
      throw new AppError('VERIFY_FAILED', 'n8n 拒绝鉴权', { httpStatus: 403, deliveryUnknown: false }, 502);
    });
    const harness = dispatchHarness(submitListing);

    await expect(harness.create()).resolves.toMatchObject({
      accepted: 0,
      failed: 1,
      publications: [{ status: 'NEEDS_ATTENTION', errorCode: 'VERIFY_FAILED' }]
    });
    expect(harness.repository.markPublicationFailed).toHaveBeenCalledOnce();
    expect(harness.repository.markPublicationDispatchUnknown).not.toHaveBeenCalled();
  });

  it('keeps an unknown manual submit DISPATCHING until the same task id is read back', async () => {
    const submitListing = vi.fn(async () => {
      throw new AppError('VERIFY_FAILED', 'socket closed', { deliveryUnknown: true }, 502);
    });
    const getJob = vi.fn()
      .mockRejectedValueOnce(new AppError('VERIFY_FAILED', 'readback timeout', { deliveryUnknown: true }, 502))
      .mockResolvedValueOnce({ taskId: 'second__0000110__r2', productCode: '0000110', revision: 2, storeAlias: 'second' });
    const harness = dispatchHarness(submitListing, getJob);

    await expect(harness.create()).resolves.toMatchObject({ publications: [{ status: 'DISPATCHING' }] });
    await expect(harness.create()).resolves.toMatchObject({ publications: [{ status: 'DISPATCHING' }] });
    expect(submitListing).toHaveBeenCalledOnce();
    await expect(harness.create()).resolves.toMatchObject({ publications: [{ status: 'QUEUED' }] });
    expect(submitListing).toHaveBeenCalledOnce();
    expect(getJob).toHaveBeenCalledTimes(2);
  });

  it('freezes every materialized variant vendorCode for manual COMPATIBLE_UPSERT media replacement', async () => {
    const submitListing = vi.fn(async () => ({
      taskId: 'second__0000110__r2',
      raw: { accepted: true }
    }));
    const harness = dispatchHarness(submitListing, vi.fn(), 'COMPATIBLE_UPSERT');

    await expect(harness.create()).resolves.toMatchObject({ accepted: 1, failed: 0 });
    expect(harness.publishing.storePublicationMediaTargetVendorCodes).toHaveBeenCalledWith(
      '0000110',
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    );
    expect(harness.publishing.prepareStorePublicationPackage).toHaveBeenCalledWith(expect.objectContaining({
      submissionMode: 'COMPATIBLE_UPSERT',
      mediaPolicy: 'REPLACE_SELECTED',
      mediaTargetVendorCodes: ['0000110-01', '0000110-02']
    }));
    expect(submitListing).toHaveBeenCalledWith(expect.objectContaining({
      submissionMode: 'COMPATIBLE_UPSERT',
      mediaPolicy: 'REPLACE_SELECTED',
      mediaTargetVendorCodes: ['0000110-01', '0000110-02']
    }));
  });
});

describe('WbStoreService material preset isolation', () => {
  const sku = '0000110';
  const generatedVersionId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const firstStoreId = '11111111-1111-4111-8111-111111111111';
  const secondStoreId = '22222222-2222-4222-8222-222222222222';
  const firstCredentialId = '33333333-3333-4333-8333-333333333333';
  const secondCredentialId = '44444444-4444-4444-8444-444444444444';
  const firstPresetId = '55555555-5555-4555-8555-555555555555';
  const secondPresetId = '66666666-6666-4666-8666-666666666666';

  it('plans different store presets independently without comparing them to the historical generated version', async () => {
    const firstPreset = publicationPreset(firstPresetId, 'same', 40);
    const secondPreset = publicationPreset(secondPresetId, 'different', 55);
    const repository = {
      getPlanningContext: vi.fn(async () => ({
        sku, productName: 'shoe', draftVersion: 3, baseGeneratedVersionId: generatedVersionId,
        listingStatus: 'GENERATED', listingData: { variants: [] }, mediaAssets: [], variantMedia: [],
        stores: [
          readyStore(firstStoreId, 'first', firstPresetId, firstCredentialId),
          readyStore(secondStoreId, 'second', secondPresetId, secondCredentialId)
        ]
      })),
      getSettings: vi.fn(async () => ({
        enabled: true, rootDirectory: 'F:/wb', timezone: 'Asia/Shanghai',
        globalConcurrency: 2, perStoreConcurrency: 1, rowVersion: 1
      }))
    };
    const presets = {
      previewStoreListing: vi.fn(async (_sku: string, id: string) => presetPreview(id === firstPresetId ? firstPreset : secondPreset))
    };
    const service = new WbStoreService(repository as any, presets as any, {} as any);

    await expect(service.publicationPlan(sku, {
      draftVersion: 3,
      stores: [{ storeId: firstStoreId }, { storeId: secondStoreId }]
    })).resolves.toMatchObject({
      items: [
        { storeId: firstStoreId, discountPercent: 40, ready: true },
        { storeId: secondStoreId, discountPercent: 55, ready: true }
      ]
    });
  });

  it('returns the explicit cleaned-media blocker instead of planning from historical success packages', async () => {
    const preset = publicationPreset(firstPresetId, 'first', 49);
    const repository = {
      getPlanningContext: vi.fn(async () => ({
        sku, productName: 'shoe', draftVersion: 3, baseGeneratedVersionId: generatedVersionId,
        listingStatus: 'GENERATED', sourceMediaState: 'CLEANED', listingData: { variants: [] }, mediaAssets: [], variantMedia: [],
        stores: [readyStore(firstStoreId, 'first', firstPresetId, firstCredentialId)]
      })),
      getSettings: vi.fn(async () => ({
        enabled: true, rootDirectory: 'F:/wb', timezone: 'Asia/Shanghai',
        globalConcurrency: 2, perStoreConcurrency: 1, rowVersion: 1
      }))
    };
    const service = new WbStoreService(repository as any, {
      previewStoreListing: vi.fn(async () => presetPreview(preset))
    } as any, {} as any);

    await expect(service.publicationPlan(sku, {
      draftVersion: 3,
      stores: [{ storeId: firstStoreId }]
    })).resolves.toMatchObject({
      items: [{ ready: false, blockers: expect.arrayContaining(['公共媒体已在成功上品后清理，请重新投递媒体']) }]
    });
  });

  it('creates and dispatches two independent publications when both stores match the generated material hash', async () => {
    const firstPreset = publicationPreset(firstPresetId, 'first', 49);
    const secondPreset = publicationPreset(secondPresetId, 'second', 45);
    const stores = [
      readyStore(firstStoreId, 'first', firstPresetId, firstCredentialId),
      readyStore(secondStoreId, 'second', secondPresetId, secondCredentialId)
    ];
    const rows = new Map<string, any>();
    let revision = 1;
    const createMaterializedPublication = vi.fn(async (item: any) => {
      revision += 1;
      const row = {
        ...item,
        generatedVersionId: revision === 2
          ? 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1'
          : 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2',
        revision,
        taskId: `${item.storeAlias}__${sku}__r${revision}`,
        status: 'PLANNED', nmIds: [], productUrls: [], result: {}, rowVersion: 1,
        createdAt: '2026-08-10T08:00:00.000Z', updatedAt: '2026-08-10T08:00:00.000Z'
      };
      rows.set(item.id, row);
      return row;
    });
    const repository = {
      getPlanningContext: vi.fn(async () => ({
        sku, productName: 'shoe', draftVersion: 3, baseGeneratedVersionId: generatedVersionId,
        listingStatus: 'GENERATED', listingData: { variants: [] }, mediaAssets: [], variantMedia: [],
        stores
      })),
      getSettings: vi.fn(async () => ({
        enabled: true, rootDirectory: 'F:/wb', timezone: 'Asia/Shanghai',
        globalConcurrency: 2, perStoreConcurrency: 1, rowVersion: 1
      })),
      createMaterializedPublication,
      recordPublicationPackage: vi.fn(async (id: string) => rows.get(id)),
      markPublicationDispatching: vi.fn(async (id: string) => ({ ...rows.get(id), status: 'DISPATCHING' })),
      markPublicationQueued: vi.fn(async (id: string, taskId: string, raw: any) => ({
        ...rows.get(id), status: 'QUEUED', taskId, result: raw
      }))
    };
    const presets = {
      previewStoreListing: vi.fn(async (_sku: string, id: string) => presetPreview(id === firstPresetId ? firstPreset : secondPreset)),
      materializeStoreListing: vi.fn(async (_sku: string, id: string) => {
        const preset = id === firstPresetId ? firstPreset : secondPreset;
        return {
          data: { variants: [] }, category: { versionId: preset.dependencySnapshot.categoryVersionId },
          preset, presetSnapshot: preset, dependencySnapshot: preset.dependencySnapshot,
          presetDefinitionHash: wbMaterialPresetDefinitionHash({ presetSnapshot: preset, dependencySnapshot: preset.dependencySnapshot })
        };
      })
    };
    const submitListing = vi.fn(async (input: any) => ({ taskId: `${input.storeAlias}__${sku}__r${input.revision}`, raw: { accepted: true } }));
    const sourceMediaCleanup = {
      registerManualBatch: vi.fn(async () => ({ id: 'cleanup-batch' })),
      linkManualTarget: vi.fn(async () => undefined)
    };
    const service = new WbStoreService(repository as any, presets as any, {
      n8n: { submitListing, getJob: vi.fn() },
      prepareStorePublicationPackage: vi.fn(async () => ({
        markerPath: 'F:/wb/inbox/0000110/.store-ready/publication.json',
        productSha256: `sha256:${'a'.repeat(64)}`,
        sourceContentSignature: `sha256:${'b'.repeat(64)}`,
        packageRelPath: 'stores/alias/inbox/0000110/publication',
        packageSignature: `sha256:${'b'.repeat(64)}`,
        reused: false
      })),
      cleanupStorePublicationPackage: vi.fn(async () => true)
    } as any, sourceMediaCleanup as any);
    const selection = { draftVersion: 3, stores: [{ storeId: firstStoreId }, { storeId: secondStoreId }] };
    const plan = await service.publicationPlan(sku, selection);
    const result = await service.createPublications(sku, { ...selection, planHash: plan.planHash });

    expect(result).toMatchObject({ accepted: 2, failed: 0 });
    expect(createMaterializedPublication).toHaveBeenCalledTimes(2);
    expect(createMaterializedPublication).toHaveBeenNthCalledWith(1, expect.objectContaining({
      draftVersion: 3,
      configSnapshot: expect.objectContaining({ draftVersion: 3, planStoreIds: [firstStoreId, secondStoreId] })
    }));
    expect(result.publications.map((item) => item.generatedVersionId)).toEqual([
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1',
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2'
    ]);
    expect(plan.items.map((item) => item.discountPercent)).toEqual([49, 45]);
    expect(submitListing).toHaveBeenCalledTimes(2);
    expect(sourceMediaCleanup.registerManualBatch).toHaveBeenCalledWith(expect.objectContaining({
      sku,
      planHash: plan.planHash,
      draftVersion: 3,
      expectedStoreIds: [firstStoreId, secondStoreId]
    }));
    expect(sourceMediaCleanup.linkManualTarget).toHaveBeenCalledTimes(2);
  });
});
