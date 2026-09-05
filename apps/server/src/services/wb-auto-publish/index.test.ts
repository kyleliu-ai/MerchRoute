import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { AppError } from '@n8n-media-review/shared';
import {
  buildAutomaticAssignments,
  classifyCreateOnlyMatches,
  isCompatibleRuntimeRecoveryCandidate,
  isBlockingInitializationIssue,
  isStaleAutomationDraft,
  listingTaskErrorCode,
  listingTaskErrorMessage,
  shouldRegenerateSubmittedListingAfterRecheck,
  transientNetworkErrorCode,
  WbAutoPublishingCoordinator
} from './index.js';
import { wbMaterialPresetDefinitionHash } from '../wb-presets/material-hash.js';

function logger() {
  return { warn: vi.fn(), info: vi.fn(), debug: vi.fn() } as any;
}

function materialPresetSnapshot(name = '测试预设', discountPercent = 40) {
  return {
    name,
    description: '',
    autoPublishEnabled: true,
    autoPublishMode: 'CREATE_ONLY',
    pricingTemplateId: '11111111-1111-4111-8111-111111111111',
    shippingTemplateId: '22222222-2222-4222-8222-222222222222',
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
    sizes: [{ sizeId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', techSize: '40', wbSize: '40', stock: 3 }]
  };
}

function materialDependencies() {
  return {
    pricingTemplateVersionId: '31111111-1111-4111-8111-111111111111',
    pricingTemplateVersionNo: 1,
    shippingTemplateVersionId: '32222222-2222-4222-8222-222222222222',
    shippingTemplateVersionNo: 2,
    categoryVersionId: '33333333-3333-4333-8333-333333333333',
    categoryVersionNo: 3,
    capturedAt: '2026-07-18T00:00:00.000Z'
  };
}

describe('WbAutoPublishingCoordinator activation boundary', () => {
  it('inherits explicit E003 image order for automatic WB assignments', () => {
    const productVariantId = '11111111-1111-4111-8111-111111111111';
    const deliveredAt = '2026-08-10T01:00:00.000Z';
    const mediaAssets = [
      { assetId: 'image-01', relativePath: 'variants/red/01.png', sortOrder: 1 },
      { assetId: 'image-04', relativePath: 'variants/red/04.png', sortOrder: 2 },
      { assetId: 'image-07', relativePath: 'variants/red/07.png', sortOrder: 0 }
    ].map((asset) => ({
      ...asset,
      kind: 'image',
      validationStatus: 'VALID',
      productVariantId,
      sourceStageId: 'E005',
      sourceSubmissionId: 'e005-ordered',
      deliveredAt
    }));
    const assignments = buildAutomaticAssignments(
      {
        variants: [{ variantId: 'wb-red', productVariantId, vendorCode: '0000069-01' }],
        mediaAssets
      },
      [{ variantId: productVariantId, name: '红色' }],
      '2026-08-10T00:00:00.000Z',
      { minImages: 1, maxImages: 7, videoAllowed: false }
    );

    expect(assignments).toEqual([{ variantId: 'wb-red', imageAssetIds: ['image-07', 'image-01', 'image-04'] }]);
  });

  it.each([
    {
      label: '部分缺失',
      assets: [
        { assetId: 'image-1', relativePath: 'variants/red/01.png', sortOrder: 0 },
        { assetId: 'image-2', relativePath: 'variants/red/02.png' }
      ]
    },
    {
      label: '重复',
      assets: [
        { assetId: 'image-1', relativePath: 'variants/red/01.png', sortOrder: 0 },
        { assetId: 'image-2', relativePath: 'variants/red/02.png', sortOrder: 0 }
      ]
    },
    {
      label: '不连续',
      assets: [
        { assetId: 'image-1', relativePath: 'variants/red/01.png', sortOrder: 0 },
        { assetId: 'image-2', relativePath: 'variants/red/02.png', sortOrder: 2 }
      ]
    }
  ])('stops WB automatic assignment when the latest batch has $label sortOrder', ({ assets }) => {
    const productVariantId = '11111111-1111-4111-8111-111111111111';
    expect(() => buildAutomaticAssignments(
      {
        variants: [{ variantId: 'wb-red', productVariantId, vendorCode: '0000069-01' }],
        mediaAssets: assets.map((asset) => ({
          ...asset,
          kind: 'image',
          validationStatus: 'VALID',
          productVariantId,
          sourceStageId: 'E005',
          sourceSubmissionId: 'e005-invalid',
          deliveredAt: '2026-08-10T01:00:00.000Z'
        }))
      },
      [{ variantId: productVariantId, name: '红色' }],
      '2026-08-10T00:00:00.000Z',
      { minImages: 1, maxImages: 7, videoAllowed: false }
    )).toThrow(expect.objectContaining({ code: 'MEDIA_MANIFEST_INVALID' }));
  });

  it('classifies exact self-owned partial CREATE_ONLY cards without treating duplicate matches as external cards', () => {
    const listing = {
      n8nTaskId: '0000060__r1',
      task: {
        variants: [
          { vendorCode: '0000060-01', nmID: 1307332522 },
          { vendorCode: '0000060-02', nmID: 1307332523 },
          { vendorCode: '0000060-03', nmID: 1307332524 }
        ]
      }
    };
    expect(classifyCreateOnlyMatches([
      '0000060-01', '0000060-02', '0000060-03'
    ], [
      { vendorCode: '0000060-01', location: 'ACTIVE', nmId: 1307332522 },
      { vendorCode: '0000060-01', location: 'ACTIVE', nmId: 1307332522 },
      { vendorCode: '0000060-02', location: 'ACTIVE', nmId: 1307332523 },
      { vendorCode: '0000060-03', location: 'ACTIVE', nmId: 1307332524 }
    ], listing, { operationMode: 'CREATE_ONLY', n8nTaskId: '0000060__r1' } as any)).toMatchObject({
      kind: 'SELF_OWNED',
      matches: [
        { vendorCode: '0000060-01', location: 'ACTIVE', nmId: 1307332522 },
        { vendorCode: '0000060-02', location: 'ACTIVE', nmId: 1307332523 },
        { vendorCode: '0000060-03', location: 'ACTIVE', nmId: 1307332524 }
      ]
    });
  });

  it('fails closed for external active cards, trash cards and missing task variants', () => {
    const job = { operationMode: 'CREATE_ONLY', n8nTaskId: '0000060__r1' } as any;
    const listing = { n8nTaskId: '0000060__r1', task: { variants: [{ vendorCode: '0000060-01', nmID: 1307332522 }] } };
    expect(classifyCreateOnlyMatches(['0000060-01'], [
      { vendorCode: '0000060-01', location: 'ACTIVE', nmId: 999 }
    ], listing, job)).toMatchObject({ kind: 'BLOCKED', reason: 'nm_id_mismatch' });
    expect(classifyCreateOnlyMatches(['0000060-01'], [
      { vendorCode: '0000060-01', location: 'TRASH', nmId: 1307332522 }
    ], listing, job)).toMatchObject({ kind: 'BLOCKED', reason: 'trash_match' });
    expect(classifyCreateOnlyMatches(['0000060-01'], [
      { vendorCode: '0000060-01', location: 'ACTIVE', nmId: 1307332522 }
    ], { n8nTaskId: '0000060__r1', task: {} }, job)).toMatchObject({ kind: 'BLOCKED', reason: 'task_variants_missing' });
  });

  it('does not treat historical E003 description errors as automatic publish blockers', () => {
    expect(isBlockingInitializationIssue({ code: 'E003_DESCRIPTION_MISSING', severity: 'ERROR', retryable: true })).toBe(false);
    expect(isBlockingInitializationIssue({ code: 'E003_DESCRIPTION_AMBIGUOUS', severity: 'ERROR', retryable: false })).toBe(false);
    expect(isBlockingInitializationIssue({ code: 'PRICE_INITIALIZATION_FAILED', severity: 'ERROR', retryable: true })).toBe(true);
    expect(isBlockingInitializationIssue({ code: 'TITLE_TRANSLATION_FAILED', severity: 'ERROR', retryable: true })).toBe(true);
    expect(isBlockingInitializationIssue({ code: 'E003_DESCRIPTION_MISSING', severity: 'WARNING', retryable: true })).toBe(false);
  });

  it('classifies only empty automation-owned DRAFT listings as reclaimable stale drafts', async () => {
    const staleDraft = {
      sku: '0000069',
      status: 'DRAFT',
      latestOperationSource: 'AUTOMATION',
      autoPublishLocked: false,
      n8nTaskId: '',
      nmIds: [],
      productUrls: [],
      mediaAssets: [],
      variantMedia: []
    };
    const noVersions = vi.fn(async () => 0);

    await expect(isStaleAutomationDraft(staleDraft, noVersions)).resolves.toBe(true);
    expect(noVersions).toHaveBeenCalledWith('0000069');
    await expect(isStaleAutomationDraft({ ...staleDraft, latestOperationSource: 'MANUAL' }, noVersions)).resolves.toBe(false);
    await expect(isStaleAutomationDraft({ ...staleDraft, n8nTaskId: '0000069__r1' }, noVersions)).resolves.toBe(false);
    await expect(isStaleAutomationDraft({ ...staleDraft, nmIds: [1300000001] }, noVersions)).resolves.toBe(false);
    await expect(isStaleAutomationDraft({ ...staleDraft, productUrls: ['https://www.wildberries.ru/catalog/1300000001/detail.aspx'] }, noVersions)).resolves.toBe(false);
    await expect(isStaleAutomationDraft({ ...staleDraft, mediaAssets: [{ assetId: 'asset-1' }] }, noVersions)).resolves.toBe(false);
    await expect(isStaleAutomationDraft({ ...staleDraft, variantMedia: [{ variantId: 'variant-1' }] }, noVersions)).resolves.toBe(false);
    await expect(isStaleAutomationDraft({ ...staleDraft, autoPublishLocked: true }, noVersions)).resolves.toBe(true);
    await expect(isStaleAutomationDraft(staleDraft, vi.fn(async () => 1))).resolves.toBe(false);
  });

  it('rebuilds and audits reclaimable automation-owned stale drafts during compatible upsert', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'wb-stale-draft-'));
    const productRoot = path.join(root, 'inbox', '0000069');
    const mediaDir = path.join(productRoot, 'variants', 'wine');
    await mkdir(mediaDir, { recursive: true });
    await writeFile(path.join(mediaDir, '01.png'), Buffer.from('image'));
    await writeFile(path.join(mediaDir, 'main.mp4'), Buffer.from('video'));
    const deliveredAt = '2026-08-02T09:30:00.000Z';
    await writeFile(path.join(productRoot, 'variants', 'variant-media-manifest.json'), JSON.stringify({
      schemaVersion: 2,
      SKU: '0000069',
      assets: [
        {
          assetId: 'image-wine-1',
          variantId: 'wine',
          variantColor: { colorKey: 'wine' },
          sourceStageId: 'E005',
          kind: 'image',
          relativePath: 'variants/wine/01.png',
          sizeBytes: 5,
          sha256: 'image-sha',
          deliveredAt,
          submissionId: 'e005-new'
        },
        {
          assetId: 'video-wine-1',
          variantId: 'wine',
          variantColor: { colorKey: 'wine' },
          sourceStageId: 'E004',
          kind: 'video',
          relativePath: 'variants/wine/main.mp4',
          sizeBytes: 5,
          sha256: 'video-sha',
          deliveredAt,
          submissionId: 'e004-new'
        }
      ]
    }));

    const staleDraft = {
      sku: '0000069',
      status: 'DRAFT',
      draftVersion: 1,
      latestOperationSource: 'AUTOMATION',
      latestOperationRef: 'automation:44444444-4444-4444-8444-444444444444',
      autoPublishLocked: false,
      n8nTaskId: '',
      nmIds: [],
      productUrls: [],
      mediaAssets: [],
      variantMedia: []
    };
    const binding = {
      schemaVersion: 2,
      presetId: 'preset-1',
      presetName: 'WB 预设',
      presetRowVersion: 4,
      boundAt: deliveredAt,
      activationStartedAt: '2026-08-02T09:00:00.000Z',
      definitionHash: 'sha256:preset',
      presetSnapshot: materialPresetSnapshot('WB 预设'),
      dependencySnapshot: materialDependencies()
    };
    const transition = vi.fn(async () => ({}));
    const rebuildListing = vi.fn(async () => {
      throw new AppError('STOP_AFTER_REBUILD', 'stop test', undefined, 500);
    });
    const coordinator = new WbAutoPublishingCoordinator(
      {
        configured: true,
        transition,
        persistBinding: vi.fn(async () => undefined),
        claimGenerationLease: vi.fn(async (job: any) => ({
          acquired: true,
          sku: job.sku,
          ownerJobId: job.id,
          ownerRunId: job.runId,
          ownerStoreId: job.storeId,
          phase: 'GENERATING_SHARED_LISTING',
          leaseUntil: new Date(Date.now() + 120_000).toISOString(),
          rowVersion: 1
        })),
        heartbeatGenerationLease: vi.fn(async (job: any, input: any) => ({
          acquired: true,
          sku: job.sku,
          ownerJobId: job.id,
          ownerRunId: job.runId,
          ownerStoreId: job.storeId,
          phase: input.phase,
          leaseUntil: new Date(Date.now() + 120_000).toISOString(),
          rowVersion: input.expectedRowVersion
        })),
        releaseGenerationLease: vi.fn(async () => true),
        findGenerationOwner: vi.fn(async () => ({
          id: '77777777-7777-4777-8777-777777777777',
          runId: '44444444-4444-4444-8444-444444444444',
          storeId: '22222222-2222-4222-8222-222222222222',
          state: 'GENERATING'
        }))
      } as any,
      {
        parseExecutionBinding: vi.fn(() => binding),
        resolveExecutionBinding: vi.fn(async () => ({
          resolved: { issues: [], dependencies: { category: { formConfig: { media: { minImages: 1, maxImages: 7, videoAllowed: true } } } } }
        })),
        rebuildListing
      } as any,
      {
        repository: {
          getListing: vi.fn(async () => staleDraft),
          countListingVersions: vi.fn(async () => 0)
        },
        productVariants: vi.fn(async () => [
          { variantId: 'black', name: '黑色', wbColor: { colorKey: 'black' } },
          { variantId: 'wine', name: '酒红色', wbColor: { colorKey: 'wine' } }
        ]),
        readiness: vi.fn(async () => ({ complete: true, rootDirectory: root }))
      } as any,
      { read: () => ({ submissionHistory: [] }) } as any,
      logger(),
      { stableWindowMs: 0, stableProbeMs: 0 }
    );

    await expect((coordinator as any).processJob({
      id: '77777777-7777-4777-8777-777777777777',
      sku: '0000069',
      storeId: '22222222-2222-4222-8222-222222222222',
      state: 'NEEDS_ATTENTION',
      operationMode: 'COMPATIBLE_UPSERT',
      targetRevision: 2,
      runId: '44444444-4444-4444-8444-444444444444',
      runNo: 2,
      presetBinding: binding,
      mediaTargetVariantIds: ['wine'],
      retryCounters: {},
      lastDeliveryAt: deliveredAt,
      updatedAt: deliveredAt,
      triggerType: 'AUTO'
    })).rejects.toMatchObject({ code: 'STOP_AFTER_REBUILD' });

    expect(rebuildListing).toHaveBeenCalledWith(
      '0000069', binding, 'automation:44444444-4444-4444-8444-444444444444', false,
      expect.objectContaining({
        jobId: '77777777-7777-4777-8777-777777777777',
        runId: '44444444-4444-4444-8444-444444444444',
        rowVersion: 1
      })
    );
    expect(transition).toHaveBeenCalledWith('0000069', 'INITIALIZING', expect.objectContaining({
      eventType: 'STALE_AUTOMATION_DRAFT_RECLAIMED'
    }), '22222222-2222-4222-8222-222222222222');
  });

  it('regenerates instead of resuming the old failed n8n task after manual recheck', () => {
    const rechecked = { state: 'CHECKING', n8nTaskId: '0000056__r1', lastErrorCode: undefined };
    expect(shouldRegenerateSubmittedListingAfterRecheck(rechecked as any, {
      status: 'FAILED', n8nTaskId: '0000056__r1', lastError: 'Описание не более 2000 символов'
    })).toBe(true);
    expect(shouldRegenerateSubmittedListingAfterRecheck(rechecked as any, {
      status: 'BLOCKED', n8nTaskId: '0000056__r1', lastError: '旧错误'
    })).toBe(true);
    expect(shouldRegenerateSubmittedListingAfterRecheck({ ...rechecked, lastErrorCode: 'WB_TASK_FAILED' } as any, {
      status: 'FAILED', n8nTaskId: '0000056__r1'
    })).toBe(false);
    expect(shouldRegenerateSubmittedListingAfterRecheck(rechecked as any, {
      status: 'RUNNING', n8nTaskId: '0000056__r1'
    })).toBe(false);
    expect(shouldRegenerateSubmittedListingAfterRecheck(rechecked as any, {
      status: 'FAILED', n8nTaskId: '0000056__r2'
    })).toBe(false);
  });

  it('recognizes only failed compatible tasks with recorded partial effects as in-place recovery candidates', () => {
    const candidate = {
      state: 'FAILED',
      partial_effects: true,
      result: { submissionMode: 'COMPATIBLE_UPSERT' }
    };
    expect(isCompatibleRuntimeRecoveryCandidate(candidate)).toBe(true);
    expect(isCompatibleRuntimeRecoveryCandidate({ ...candidate, state: 'RUNNING' })).toBe(false);
    expect(isCompatibleRuntimeRecoveryCandidate({ ...candidate, partial_effects: false })).toBe(false);
    expect(isCompatibleRuntimeRecoveryCandidate({ ...candidate, result: { submissionMode: 'CREATE_ONLY' } })).toBe(false);
  });

  it('requires the controlled retry endpoint for already submitted compatible failures', async () => {
    const job = {
      sku: '0000078', state: 'FAILED', operationMode: 'COMPATIBLE_UPSERT', runId: 'run-78',
      n8nTaskId: '0000078__r3', presetBinding: { schemaVersion: 2 }
    } as any;
    const recheck = vi.fn(async () => ({ ...job, state: 'CHECKING' }));
    const repository = {
      configured: true,
      get: vi.fn(async () => job),
      recheck,
      withSkuLock: vi.fn(async (_sku, operation) => ({ acquired: true, value: await operation() }))
    } as any;
    const runtimeJob = {
      taskId: '0000078__r3', state: 'FAILED', partial_effects: true,
      result: { submissionMode: 'COMPATIBLE_UPSERT' }
    };
    const publishing = { repository: { getRuntimeJob: vi.fn(async () => runtimeJob) } } as any;
    const coordinator = new WbAutoPublishingCoordinator(repository, {} as any, publishing, {} as any, logger());
    vi.spyOn(coordinator as any, 'bindingForJob').mockResolvedValue(job.presetBinding);
    const recover = vi.spyOn(coordinator as any, 'recoverCompatibleForJob').mockResolvedValue({
      runtimeJob: { ...runtimeJob, state: 'MEDIA_RECONCILING' },
      automationJob: { ...job, state: 'RUNNING' }
    });
    vi.spyOn(coordinator as any, 'runWorkerNow').mockResolvedValue(undefined);

    await expect(coordinator.recheck('0000078')).rejects.toMatchObject({ code: 'WB_RETRY_ENDPOINT_REQUIRED' });
    expect(recover).not.toHaveBeenCalled();
    expect(recheck).not.toHaveBeenCalled();
  });

  it('preserves concrete network error codes from WB task state and recognizes bounded transient failures', () => {
    expect(listingTaskErrorCode({ task: { errorCode: 'ETIMEDOUT' } })).toBe('ETIMEDOUT');
    expect(listingTaskErrorCode({ task: { last_error_code: 'ECONNRESET' } })).toBe('ECONNRESET');
    expect(listingTaskErrorCode({}, {
      error: 'CARD_RECONCILE_TIMEOUT', message: '商品卡同步超时'
    })).toBe('CARD_RECONCILE_TIMEOUT');
    expect(listingTaskErrorMessage({}, {
      error: 'CARD_RECONCILE_TIMEOUT', message: '商品卡同步超时'
    })).toBe('商品卡同步超时');
    expect(listingTaskErrorCode({ task: {} })).toBe('WB_TASK_FAILED');
    expect(transientNetworkErrorCode(Object.assign(new Error('connect timed out'), { code: 'ETIMEDOUT' }))).toBe('ETIMEDOUT');
    expect(transientNetworkErrorCode({ cause: { code: 'EAI_AGAIN' } })).toBe('EAI_AGAIN');
    expect(transientNetworkErrorCode(new Error('socket hang up'))).toBe('ECONNRESET');
    expect(transientNetworkErrorCode(new Error('Client network socket disconnected before secure TLS connection was established'))).toBe('TLS_EOF');
    expect(transientNetworkErrorCode(Object.assign(new Error('certificate has expired'), { code: 'CERT_HAS_EXPIRED' }))).toBeUndefined();
    expect(transientNetworkErrorCode(new Error('401 invalid token'))).toBeUndefined();
  });

  it('revives a failed automation job when the same recovered n8n task is running again', async () => {
    const failedJob = {
      sku: '0000044', state: 'FAILED', n8nTaskId: '0000044__r1',
      lastErrorCode: 'WB_TASK_FAILED', createdAt: '2026-07-23T11:49:00.000Z'
    } as any;
    const transition = vi.fn(async () => ({}));
    const setListingLock = vi.fn(async () => undefined);
    const repository = {
      configured: true,
      listSubmitted: vi.fn(async () => [failedJob]),
      transition,
      setListingLock
    } as any;
    const publishing = {
      reconcileTaskStatus: vi.fn(async () => ({
        listing: {
          sku: '0000044', status: 'RUNNING', n8nTaskId: '0000044__r1',
          lastError: 'Client network socket disconnected before secure TLS connection was established'
        }
      }))
    } as any;
    const coordinator = new WbAutoPublishingCoordinator(
      repository, {} as any, publishing, {} as any, logger()
    );

    await (coordinator as any).synchronizeSubmittedJobs();

    expect(publishing.reconcileTaskStatus).toHaveBeenCalledWith('0000044');
    expect(transition).toHaveBeenCalledWith('0000044', 'RUNNING', expect.objectContaining({
      eventType: 'LISTING_STATUS_SYNCED',
      n8nTaskId: '0000044__r1',
      errorCode: null,
      errorMessage: null
    }));
    expect(setListingLock).not.toHaveBeenCalled();

    transition.mockClear();
    repository.listSubmitted.mockResolvedValue([{
      ...failedJob, state: 'RUNNING', lastErrorCode: null, lastErrorMessage: '旧网络错误'
    }]);
    await (coordinator as any).synchronizeSubmittedJobs();
    expect(transition).toHaveBeenCalledWith('0000044', 'RUNNING', expect.objectContaining({
      errorCode: null,
      errorMessage: null
    }));
  });

  it('refreshes an already failed automation job with the exact runtime task error and message', async () => {
    const transition = vi.fn(async () => ({}));
    const repository = {
      configured: true,
      listSubmitted: vi.fn(async () => [{
        sku: '0000078', state: 'FAILED', n8nTaskId: '0000078__r3',
        lastErrorCode: 'WB_TASK_FAILED', lastErrorMessage: undefined,
        createdAt: '2026-08-05T01:00:00.000Z'
      }]),
      transition,
      setListingLock: vi.fn(async () => undefined)
    } as any;
    const publishing = {
      reconcileTaskStatus: vi.fn(async () => ({
        listing: {
          sku: '0000078', status: 'FAILED', n8nTaskId: '0000078__r3',
          lastError: undefined
        },
        task: {
          state: 'FAILED', error: 'CARD_RECONCILE_TIMEOUT',
          message: '商品卡异步同步超过 15 分钟'
        }
      }))
    } as any;
    const coordinator = new WbAutoPublishingCoordinator(
      repository, {} as any, publishing, {} as any, logger()
    );

    await (coordinator as any).synchronizeSubmittedJobs();

    expect(transition).toHaveBeenCalledWith('0000078', 'FAILED', expect.objectContaining({
      eventType: 'LISTING_STATUS_SYNCED',
      errorCode: 'CARD_RECONCILE_TIMEOUT',
      errorMessage: '商品卡异步同步超过 15 分钟'
    }));
  });

  it('only enqueues deliveries at or after the active preset activation time', async () => {
    const enqueueDelivery = vi.fn(async (input) => ({ sku: input.sku, state: 'WAITING_STABLE' }));
    const repository = {
      configured: true, enqueueDelivery, find: vi.fn(async () => undefined),
      withSkuLock: vi.fn(async (_sku, operation) => ({ acquired: true, value: await operation() })), counts: vi.fn(async () => ({}))
    } as any;
    const activatedAt = '2026-07-19T10:00:00.000Z';
    const binding = {
      schemaVersion: 2, presetId: 'preset-1', presetName: '默认预设', presetRowVersion: 7,
      boundAt: activatedAt, activationStartedAt: activatedAt, definitionHash: 'sha256:test',
      presetSnapshot: materialPresetSnapshot('默认预设'), dependencySnapshot: materialDependencies()
    };
    const presets = {
      getActiveAutoPreset: vi.fn(async () => ({ id: 'preset-1', name: '默认预设', rowVersion: 7, autoPublishActivatedAt: activatedAt, autoPublishEnabled: true, readiness: 'READY' })),
      createExecutionBinding: vi.fn(() => binding)
    } as any;
    const coordinator = new WbAutoPublishingCoordinator(repository, presets, {} as any, { read: () => ({ submissionHistory: [] }) } as any, logger(), {
      debounceMs: 10_000, stableWindowMs: 0, stableProbeMs: 0
    });

    await coordinator.onMediaDelivered({ sku: '0000021', stageId: 'E005', submissionId: 'old', deliveredAt: '2026-07-19T09:59:59.999Z' });
    expect(enqueueDelivery).not.toHaveBeenCalled();
    await coordinator.onMediaDelivered({ sku: '0000021', stageId: 'E005', submissionId: 'new', deliveredAt: activatedAt });
    expect(enqueueDelivery).toHaveBeenCalledWith(expect.objectContaining({
      sku: '0000021', submissionId: 'new', binding, debounceUntil: '2026-07-19T10:00:10.000Z'
    }));
  });

  it('does not pause bound jobs when no default preset has active automation and exposes intake separately', async () => {
    const repository = {
      configured: true, counts: vi.fn(async () => ({ WAITING_MEDIA: 2, WAITING_GENERATION_TURN: 1, RUNNING: 1, SUCCEEDED: 3 })),
      boundCountsByPreset: vi.fn(async () => ({ 'preset-a': 3 }))
    } as any;
    const presets = { getActiveAutoPreset: vi.fn(async () => undefined) } as any;
    const coordinator = new WbAutoPublishingCoordinator(repository, presets, {} as any, { read: () => ({ submissionHistory: [] }) } as any, logger());

    await coordinator.handlePresetChanged();
    await expect(coordinator.status()).resolves.toMatchObject({
      enabled: false, acceptingNewJobs: false, continuingBoundJobs: 4,
      counts: { WAITING_MEDIA: 2, WAITING_GENERATION_TURN: 1, RUNNING: 1, SUCCEEDED: 3 },
      summary: { total: 7, waiting: 3, processing: 1, succeeded: 3 }
    });
  });

  it('records later media against the original binding even after the active default disappears', async () => {
    const original = { sku: '0000021', presetId: 'preset-a', presetName: 'A1', presetRowVersion: 4, state: 'WAITING_MEDIA' };
    const recordDelivery = vi.fn(async () => original);
    const repository = {
      configured: true, find: vi.fn(async () => original), recordDelivery,
      withSkuLock: vi.fn(async (_sku, operation) => ({ acquired: true, value: await operation() }))
    } as any;
    const presets = { getActiveAutoPreset: vi.fn(async () => undefined) } as any;
    const coordinator = new WbAutoPublishingCoordinator(repository, presets, {} as any, { read: () => ({ submissionHistory: [] }) } as any, logger(), { debounceMs: 10_000 });

    await coordinator.onMediaDelivered({ sku: '0000021', stageId: 'E004', submissionId: 'video-after-switch', deliveredAt: '2026-07-19T10:05:00.000Z' });
    expect(recordDelivery).toHaveBeenCalledWith(expect.objectContaining({ sku: '0000021', submissionId: 'video-after-switch' }));
    expect(presets.getActiveAutoPreset).not.toHaveBeenCalled();
  });

  it('routes only a SKU first delivery through the current default and never rebinds it after A1 switches to B', async () => {
    const jobs = new Map<string, any>();
    let active = { id: 'preset-a', name: 'A1', rowVersion: 3, autoPublishActivatedAt: '2026-07-19T10:00:00.000Z', autoPublishEnabled: true, readiness: 'READY' };
    const enqueueDelivery = vi.fn(async (input: any) => {
      const job = { sku: input.sku, presetId: input.binding.presetId, presetName: input.binding.presetName, presetRowVersion: input.binding.presetRowVersion, presetBinding: input.binding, state: 'WAITING_STABLE' };
      jobs.set(input.sku, job);
      return job;
    });
    const recordDelivery = vi.fn(async (input: any) => jobs.get(input.sku));
    const repository = {
      configured: true, enqueueDelivery, recordDelivery,
      find: vi.fn(async (sku: string) => jobs.get(sku)),
      withSkuLock: vi.fn(async (_sku: string, operation: () => Promise<any>) => ({ acquired: true, value: await operation() }))
    } as any;
    const presets = {
      getActiveAutoPreset: vi.fn(async () => active),
      createExecutionBinding: vi.fn((preset: any, boundAt: string) => ({
        schemaVersion: 2, presetId: preset.id, presetName: preset.name, presetRowVersion: preset.rowVersion,
        boundAt, activationStartedAt: preset.autoPublishActivatedAt, definitionHash: `sha256:${preset.id}`,
        presetSnapshot: materialPresetSnapshot(preset.name, preset.id === 'preset-a' ? 40 : 55),
        dependencySnapshot: materialDependencies()
      }))
    } as any;
    const coordinator = new WbAutoPublishingCoordinator(repository, presets, {} as any, { read: () => ({ submissionHistory: [] }) } as any, logger(), { debounceMs: 0 });

    await coordinator.onMediaDelivered({ sku: '0000021', stageId: 'E004', submissionId: 'a-video', deliveredAt: '2026-07-19T10:01:00.000Z' });
    active = { ...active, id: 'preset-b', name: 'B', rowVersion: 1, autoPublishActivatedAt: '2026-07-19T10:02:00.000Z' };
    await coordinator.onMediaDelivered({ sku: '0000021', stageId: 'E005', submissionId: 'a-images', deliveredAt: '2026-07-19T10:03:00.000Z' });
    await coordinator.onMediaDelivered({ sku: '0000022', stageId: 'E005', submissionId: 'b-images', deliveredAt: '2026-07-19T10:04:00.000Z' });

    expect(enqueueDelivery).toHaveBeenCalledTimes(2);
    expect(enqueueDelivery.mock.calls[0]![0].binding).toMatchObject({ presetId: 'preset-a', presetName: 'A1', presetRowVersion: 3, presetSnapshot: { discountPercent: 40 } });
    expect(recordDelivery).toHaveBeenCalledWith(expect.objectContaining({ sku: '0000021', submissionId: 'a-images' }));
    expect(enqueueDelivery.mock.calls[1]![0].binding).toMatchObject({ presetId: 'preset-b', presetName: 'B', presetRowVersion: 1, presetSnapshot: { discountPercent: 55 } });
    expect(presets.getActiveAutoPreset).toHaveBeenCalledTimes(2);
  });

  it('uses the store-scoped activation boundary for a non-global default preset and freezes it in the job binding', async () => {
    const storeActivatedAt = '2026-08-10T08:00:00.000Z';
    const store = {
      id: '11111111-1111-4111-8111-111111111111',
      storeAlias: 'second',
      enabled: true,
      autoPublishEnabled: true,
      defaultPresetId: '22222222-2222-4222-8222-222222222222',
      readiness: { ready: true, blockers: [] },
      credential: { state: 'ACTIVE' },
      autoPublishActivatedAt: storeActivatedAt,
      createdAt: storeActivatedAt
    };
    const enqueueDelivery = vi.fn(async (input: any) => ({ ...input, state: 'WAITING_STABLE' }));
    const repository = {
      configured: true,
      find: vi.fn(async () => undefined),
      enqueueDelivery,
      withSkuLock: vi.fn(async (_sku: string, operation: () => Promise<any>) => ({ acquired: true, value: await operation() }))
    } as any;
    const preset = {
      id: store.defaultPresetId,
      name: '第二店非全局默认预设',
      rowVersion: 3,
      readiness: 'READY'
      // autoPublishActivatedAt is intentionally absent for non-global presets.
    };
    const createExecutionBinding = vi.fn((source: any, boundAt: string, activationStartedAt: string) => ({
      schemaVersion: 2,
      presetId: source.id,
      presetName: source.name,
      presetRowVersion: source.rowVersion,
      boundAt,
      activationStartedAt,
      definitionHash: `sha256:${'c'.repeat(64)}`,
      presetSnapshot: materialPresetSnapshot(source.name),
      dependencySnapshot: materialDependencies()
    }));
    const coordinator = new WbAutoPublishingCoordinator(
      repository,
      { get: vi.fn(async () => preset), createExecutionBinding } as any,
      {} as any,
      { read: () => ({ submissionHistory: [] }) } as any,
      logger(),
      { debounceMs: 0 },
      {
        configured: true,
        getSettings: vi.fn(async () => ({ enabled: true })),
        listStores: vi.fn(async () => [store])
      } as any
    );

    await coordinator.onMediaDelivered({
      sku: '0000110', stageId: 'E005', submissionId: 'before', deliveredAt: '2026-08-10T07:59:59.999Z'
    });
    expect(enqueueDelivery).not.toHaveBeenCalled();

    await coordinator.onMediaDelivered({
      sku: '0000110', stageId: 'E005', submissionId: 'after', deliveredAt: '2026-08-10T08:00:01.000Z'
    });
    expect(createExecutionBinding).toHaveBeenCalledWith(preset, '2026-08-10T08:00:01.000Z', storeActivatedAt);
    expect(enqueueDelivery).toHaveBeenCalledWith(expect.objectContaining({
      storeId: store.id,
      binding: expect.objectContaining({ activationStartedAt: storeActivatedAt })
    }));
  });

  it('freezes each ready store own default preset discount without falling back to a global default', async () => {
    const activatedAt = '2026-08-10T08:00:00.000Z';
    const stores = [
      {
        id: '11111111-1111-4111-8111-111111111111', storeAlias: 'first', enabled: true,
        autoPublishEnabled: true, autoPublishMode: 'CREATE_ONLY',
        defaultPresetId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1',
        readiness: { ready: true, blockers: [] }, credential: { state: 'ACTIVE' },
        autoPublishActivatedAt: activatedAt, createdAt: activatedAt
      },
      {
        id: '22222222-2222-4222-8222-222222222222', storeAlias: 'second', enabled: true,
        autoPublishEnabled: true, autoPublishMode: 'CREATE_ONLY',
        defaultPresetId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2',
        readiness: { ready: true, blockers: [] }, credential: { state: 'ACTIVE' },
        autoPublishActivatedAt: activatedAt, createdAt: activatedAt
      }
    ];
    const discounts = new Map([[stores[0]!.defaultPresetId, 49], [stores[1]!.defaultPresetId, 45]]);
    const enqueueDelivery = vi.fn(async (input: any) => ({
      ...input,
      id: input.storeId === stores[0]!.id ? '11111111-1111-4111-8111-111111111101' : '22222222-2222-4222-8222-222222222202',
      runId: input.storeId === stores[0]!.id ? '11111111-1111-4111-8111-111111111102' : '22222222-2222-4222-8222-222222222203',
      state: 'WAITING_STABLE'
    }));
    const getActiveAutoPreset = vi.fn();
    const sourceMediaCleanup = {
      noteMediaDelivered: vi.fn(async () => undefined),
      registerAutomaticBatch: vi.fn(async () => ({ id: 'cleanup-batch' })),
      discardIncompleteAutomaticBatch: vi.fn(async () => false)
    };
    const coordinator = new WbAutoPublishingCoordinator(
      {
        configured: true,
        find: vi.fn(async () => undefined),
        enqueueDelivery,
        withSkuLock: vi.fn(async (_sku: string, operation: () => Promise<any>) => ({ acquired: true, value: await operation() }))
      } as any,
      {
        get: vi.fn(async (id: string) => ({ id, name: `preset-${id.slice(-1)}`, rowVersion: 1, readiness: 'READY', discountPercent: discounts.get(id) })),
        getActiveAutoPreset,
        createExecutionBinding: vi.fn((source: any, boundAt: string, activationStartedAt: string) => ({
          schemaVersion: 2, presetId: source.id, presetName: source.name, presetRowVersion: source.rowVersion,
          boundAt, activationStartedAt, definitionHash: `sha256:${source.discountPercent === 49 ? 'a' : 'b'}`.padEnd(71, '0'),
          presetSnapshot: materialPresetSnapshot(source.name, source.discountPercent), dependencySnapshot: materialDependencies()
        }))
      } as any,
      {} as any,
      { read: () => ({ submissionHistory: [] }) } as any,
      logger(),
      { debounceMs: 0 },
      {
        configured: true,
        getSettings: vi.fn(async () => ({ enabled: true, rootDirectory: 'G:/wb' })),
        listStores: vi.fn(async () => stores)
      } as any,
      sourceMediaCleanup as any
    );

    await coordinator.onMediaDelivered({
      sku: '0000122', stageId: 'E005', submissionId: 'two-store-images', deliveredAt: '2026-08-10T08:01:00.000Z'
    });

    expect(enqueueDelivery).toHaveBeenCalledTimes(2);
    expect(enqueueDelivery.mock.calls.map((call) => [call[0].storeId, call[0].binding.presetSnapshot.discountPercent]))
      .toEqual([[stores[0]!.id, 49], [stores[1]!.id, 45]]);
    expect(sourceMediaCleanup.noteMediaDelivered).toHaveBeenCalledWith('0000122');
    expect(sourceMediaCleanup.registerAutomaticBatch).toHaveBeenCalledWith(expect.objectContaining({
      sku: '0000122',
      rootDirectory: 'G:/wb',
      targets: [
        { storeId: stores[0]!.id, jobId: '11111111-1111-4111-8111-111111111101', runId: '11111111-1111-4111-8111-111111111102' },
        { storeId: stores[1]!.id, jobId: '22222222-2222-4222-8222-222222222202', runId: '22222222-2222-4222-8222-222222222203' }
      ]
    }));
    expect(sourceMediaCleanup.discardIncompleteAutomaticBatch).not.toHaveBeenCalled();
    expect(getActiveAutoPreset).not.toHaveBeenCalled();
  });

  it('idempotently restores a missing cleanup batch for an exactly observed historical delivery', async () => {
    const deliveredAt = '2026-08-10T08:01:00.000Z';
    const stores = [
      {
        id: '11111111-1111-4111-8111-111111111111', storeAlias: 'first', enabled: true,
        autoPublishEnabled: true, autoPublishMode: 'COMPATIBLE_UPSERT', autoPublishActivatedAt: '2026-08-10T08:00:00.000Z',
        readiness: { ready: true, blockers: [] }, credential: { state: 'ACTIVE' }
      },
      {
        id: '22222222-2222-4222-8222-222222222222', storeAlias: 'second', enabled: true,
        autoPublishEnabled: true, autoPublishMode: 'COMPATIBLE_UPSERT', autoPublishActivatedAt: '2026-08-10T08:00:00.000Z',
        readiness: { ready: true, blockers: [] }, credential: { state: 'ACTIVE' }
      }
    ];
    const jobs = stores.map((store, index) => ({
      id: index ? '22222222-2222-4222-8222-222222222202' : '11111111-1111-4111-8111-111111111101',
      runId: index ? '22222222-2222-4222-8222-222222222203' : '11111111-1111-4111-8111-111111111102',
      storeId: store.id, sku: '0000122', state: 'SUCCEEDED',
      lastDeliveryAt: deliveredAt
    }));
    const repository = {
      configured: true,
      find: vi.fn(async (_sku: string, storeId: string) => jobs.find((job) => job.storeId === storeId)),
      withSkuLock: vi.fn(async (_sku: string, operation: () => Promise<any>) => ({ acquired: true, value: await operation() }))
    } as any;
    const sourceMediaCleanup = {
      noteMediaDelivered: vi.fn(),
      sourceState: vi.fn(async () => ({ state: 'AVAILABLE' })),
      registerAutomaticBatch: vi.fn(async () => ({ id: 'cleanup-batch' })),
      discardIncompleteAutomaticBatch: vi.fn()
    };
    const coordinator = new WbAutoPublishingCoordinator(
      repository, {} as any, {} as any, { read: () => ({ submissionHistory: [] }) } as any, logger(), {},
      {
        configured: true,
        getSettings: vi.fn(async () => ({ enabled: true, rootDirectory: 'G:/wb' })),
        listStores: vi.fn(async () => stores)
      } as any,
      sourceMediaCleanup as any
    );

    await expect(coordinator.onMediaDelivered({
      sku: '0000122', stageId: 'E005', submissionId: 'already-recorded', deliveredAt, replay: true
    } as any)).resolves.toEqual(jobs[0]);

    expect(sourceMediaCleanup.noteMediaDelivered).not.toHaveBeenCalled();
    expect(sourceMediaCleanup.sourceState).toHaveBeenCalledWith('0000122');
    expect(sourceMediaCleanup.registerAutomaticBatch).toHaveBeenCalledWith(expect.objectContaining({
      sku: '0000122',
      targets: jobs.map((job) => ({ storeId: job.storeId, jobId: job.id, runId: job.runId }))
    }));
    expect(repository.withSkuLock).toHaveBeenCalledTimes(2);
  });

  it('does not create a cleanup batch when a replayed delivery predates every store activation', async () => {
    const stores = [
      {
        id: '11111111-1111-4111-8111-111111111111', storeAlias: 'first', enabled: true,
        autoPublishEnabled: true, autoPublishMode: 'COMPATIBLE_UPSERT', defaultPresetId: 'preset-a',
        autoPublishActivatedAt: '2026-08-14T03:31:57.711Z', readiness: { ready: true, blockers: [] }, credential: { state: 'ACTIVE' }
      },
      {
        id: '22222222-2222-4222-8222-222222222222', storeAlias: 'second', enabled: true,
        autoPublishEnabled: true, autoPublishMode: 'COMPATIBLE_UPSERT', defaultPresetId: 'preset-b',
        autoPublishActivatedAt: '2026-08-14T03:32:04.012Z', readiness: { ready: true, blockers: [] }, credential: { state: 'ACTIVE' }
      }
    ];
    const sourceMediaCleanup = {
      sourceState: vi.fn(async () => ({ state: 'AVAILABLE' })),
      registerAutomaticBatch: vi.fn(),
      discardIncompleteAutomaticBatch: vi.fn(async () => true)
    };
    const repository = {
      configured: true,
      find: vi.fn(async () => undefined),
      withSkuLock: vi.fn(async (_sku: string, operation: () => Promise<any>) => ({ acquired: true, value: await operation() }))
    } as any;
    const getPreset = vi.fn();
    const coordinator = new WbAutoPublishingCoordinator(
      repository,
      { get: getPreset } as any,
      {} as any,
      { read: () => ({ submissionHistory: [] }) } as any,
      logger(),
      {},
      {
        configured: true,
        getSettings: vi.fn(async () => ({ enabled: true, rootDirectory: 'G:/wb' })),
        listStores: vi.fn(async () => stores)
      } as any,
      sourceMediaCleanup as any
    );

    await expect(coordinator.onMediaDelivered({
      sku: '0000133', stageId: 'E005', submissionId: 'historical-images',
      deliveredAt: '2026-08-14T03:10:23.157Z', replay: true
    })).resolves.toBeUndefined();

    expect(getPreset).not.toHaveBeenCalled();
    expect(sourceMediaCleanup.registerAutomaticBatch).not.toHaveBeenCalled();
    expect(sourceMediaCleanup.discardIncompleteAutomaticBatch).toHaveBeenCalledWith({
      sku: '0000133', rootDirectory: 'G:/wb', submissionId: 'historical-images',
      deliveredAt: '2026-08-14T03:10:23.157Z', expectedStoreIds: stores.map((store) => store.id)
    });
  });

  it('does not freeze a partial cleanup batch when one eligible store lock is busy', async () => {
    const activatedAt = '2026-08-10T08:00:00.000Z';
    const stores = [
      {
        id: '11111111-1111-4111-8111-111111111111', storeAlias: 'first', enabled: true,
        autoPublishEnabled: true, autoPublishMode: 'COMPATIBLE_UPSERT', defaultPresetId: 'preset-a',
        autoPublishActivatedAt: activatedAt, readiness: { ready: true, blockers: [] }, credential: { state: 'ACTIVE' }
      },
      {
        id: '22222222-2222-4222-8222-222222222222', storeAlias: 'second', enabled: true,
        autoPublishEnabled: true, autoPublishMode: 'COMPATIBLE_UPSERT', defaultPresetId: 'preset-b',
        autoPublishActivatedAt: activatedAt, readiness: { ready: true, blockers: [] }, credential: { state: 'ACTIVE' }
      }
    ];
    let lockCall = 0;
    const sourceMediaCleanup = {
      noteMediaDelivered: vi.fn(),
      registerAutomaticBatch: vi.fn(),
      discardIncompleteAutomaticBatch: vi.fn(async () => true)
    };
    const coordinator = new WbAutoPublishingCoordinator(
      {
        configured: true,
        find: vi.fn(async () => undefined),
        enqueueDelivery: vi.fn(async (input: any) => ({
          id: '11111111-1111-4111-8111-111111111101', runId: '11111111-1111-4111-8111-111111111102',
          storeId: input.storeId, sku: input.sku, state: 'WAITING_STABLE'
        })),
        withSkuLock: vi.fn(async (_sku: string, operation: () => Promise<any>) => {
          lockCall += 1;
          return lockCall === 1 ? { acquired: true, value: await operation() } : { acquired: false };
        })
      } as any,
      {
        get: vi.fn(async (id: string) => ({ id, name: id, rowVersion: 1, readiness: 'READY' })),
        createExecutionBinding: vi.fn((preset: any, boundAt: string) => ({
          schemaVersion: 2, presetId: preset.id, presetName: preset.name, presetRowVersion: 1,
          boundAt, activationStartedAt: activatedAt, definitionHash: `sha256:${'a'.repeat(64)}`,
          presetSnapshot: materialPresetSnapshot(preset.name, 49), dependencySnapshot: materialDependencies()
        }))
      } as any,
      {} as any,
      { read: () => ({ submissionHistory: [] }) } as any,
      logger(),
      {},
      {
        configured: true,
        getSettings: vi.fn(async () => ({ enabled: true, rootDirectory: 'G:/wb' })),
        listStores: vi.fn(async () => stores)
      } as any,
      sourceMediaCleanup as any
    );

    await coordinator.onMediaDelivered({
      sku: '0000122', stageId: 'E005', submissionId: 'partial-lock', deliveredAt: '2026-08-10T08:01:00.000Z'
    });

    expect(sourceMediaCleanup.discardIncompleteAutomaticBatch).toHaveBeenCalledOnce();
    expect(sourceMediaCleanup.registerAutomaticBatch).not.toHaveBeenCalled();
  });

  it('reports multi-store intake from system settings and ready stores while continuing frozen jobs without a global preset', async () => {
    const counts = vi.fn(async () => ({ RUNNING: 1 }));
    const repository = {
      configured: true,
      counts,
      boundCountsByPreset: vi.fn(async () => ({ 'store-preset': 1 }))
    } as any;
    const getActiveAutoPreset = vi.fn(async () => undefined);
    const candidate = {
      enabled: true,
      autoPublishEnabled: true,
      autoPublishActivatedAt: '2026-08-10T08:00:00.000Z',
      storeAlias: 'second',
      readiness: { ready: false },
      credential: { state: 'ACTIVE' }
    } as any;
    const settings = { enabled: true };
    const listStores = vi.fn(async () => [candidate]);
    const coordinator = new WbAutoPublishingCoordinator(
      repository,
      { getActiveAutoPreset } as any,
      {} as any,
      { read: () => ({ submissionHistory: [] }) } as any,
      logger(),
      {},
      { configured: true, getSettings: vi.fn(async () => settings), listStores } as any
    );

    await expect(coordinator.status()).resolves.toMatchObject({
      enabled: true,
      acceptingNewJobs: false,
      continuingBoundJobs: 1
    });
    counts.mockResolvedValue({} as any);
    candidate.readiness.ready = true;
    await expect(coordinator.status()).resolves.toMatchObject({
      enabled: true,
      acceptingNewJobs: true,
      continuingBoundJobs: 0
    });
    settings.enabled = false;
    await expect(coordinator.status()).resolves.toMatchObject({ enabled: false, acceptingNewJobs: false });
    expect(getActiveAutoPreset).not.toHaveBeenCalled();
  });

  it('reconciles missed deliveries from the earliest ready store activation even when the global preset is absent or later', async () => {
    const history = [
      { submissionId: 'old', productSku: '0000110', status: 'SUCCESS', deliveryType: 'WB_MEDIA', sourceStageId: 'E005', startedAt: '2026-08-10T07:59:00.000Z', completedAt: '2026-08-10T07:59:59.999Z' },
      { submissionId: 'first-store', productSku: '0000110', status: 'SUCCESS', deliveryType: 'WB_MEDIA', sourceStageId: 'E005', startedAt: '2026-08-10T08:00:00.000Z', completedAt: '2026-08-10T08:01:00.000Z' },
      { submissionId: 'second-store', productSku: '0000111', status: 'SUCCESS', deliveryType: 'WB_MEDIA', sourceStageId: 'E004', startedAt: '2026-08-10T08:05:00.000Z', completedAt: '2026-08-10T08:06:00.000Z' }
    ] as any[];
    const callOrder: string[] = [];
    const repository = {
      configured: true,
      earliestOpenBindingAt: vi.fn(async () => undefined),
      listSubmitted: vi.fn(async () => { callOrder.push('submitted'); return []; }),
      listPendingNotificationActions: vi.fn(async () => [])
    } as any;
    const getActiveAutoPreset = vi.fn(async () => ({ autoPublishActivatedAt: '2026-08-10T09:00:00.000Z' }));
    const stores = [
      { enabled: true, autoPublishEnabled: true, autoPublishActivatedAt: '2026-08-10T08:00:00.000Z', storeAlias: 'first', readiness: { ready: true }, credential: { state: 'ACTIVE' } },
      { enabled: true, autoPublishEnabled: true, autoPublishActivatedAt: '2026-08-10T08:05:00.000Z', storeAlias: 'second', readiness: { ready: true }, credential: { state: 'ACTIVE' } }
    ] as any[];
    const coordinator = new WbAutoPublishingCoordinator(
      repository,
      { getActiveAutoPreset } as any,
      {} as any,
      { read: () => ({ submissionHistory: history }) } as any,
      logger(),
      {},
      { configured: true, getSettings: vi.fn(async () => ({ enabled: true })), listStores: vi.fn(async () => stores) } as any
    );
    const delivered = vi.spyOn(coordinator, 'onMediaDelivered').mockImplementation(async (input) => {
      callOrder.push(`delivery:${input.submissionId}`);
      if (input.submissionId === 'first-store') throw new Error('historical source was already cleaned');
      return undefined;
    });

    await coordinator.reconcileNow();

    expect(delivered.mock.calls.map(([input]) => input.submissionId)).toEqual(['first-store', 'second-store']);
    expect(delivered.mock.calls.every(([input]) => input.replay === true)).toBe(true);
    expect(callOrder).toEqual(['submitted', 'delivery:first-store', 'delivery:second-store']);
    expect((coordinator as any).lastReconciledAt).toEqual(expect.any(String));
    expect(getActiveAutoPreset).not.toHaveBeenCalled();
  });

  it('pauses authentication failures but persists network and 429 waits without exhausting retries', async () => {
    const transition = vi.fn(async () => ({}));
    const setListingLock = vi.fn(async () => undefined);
    const notifyAutoPublishFailure = vi.fn(async () => undefined);
    const completeNotificationAction = vi.fn(async () => true);
    const job = { sku: '0000021', state: 'CHECKING', attemptCount: 3, retryCounters: {}, createdAt: '2026-07-19T10:00:00.000Z', presetName: '默认预设' } as any;
    let pending: any[] = [];
    const repository = {
      configured: true, transition, setListingLock,
      listPendingNotificationActions: vi.fn(async () => pending), completeNotificationAction
    } as any;
    const coordinator = new WbAutoPublishingCoordinator(
      repository, {} as any, { notifyAutoPublishFailure, resolveAutoPublishFailure: vi.fn(async () => undefined) } as any, {} as any, logger()
    );

    await (coordinator as any).handleJobError(job, new AppError('VERIFY_FAILED', 'unauthorized', { httpStatus: 401 }, 502));
    expect(transition).toHaveBeenLastCalledWith('0000021', 'PAUSED', expect.objectContaining({
      eventType: 'AUTHENTICATION_FAILED', errorCode: 'WB_AUTH_FAILED', nextAttemptAt: null
    }));
    expect(setListingLock).toHaveBeenCalledWith('0000021', false);
    const payload = { failure: { sku: job.sku, state: 'PAUSED', jobCreatedAt: job.createdAt, errorCode: 'WB_AUTH_FAILED', errorMessage: 'unauthorized', presetName: job.presetName } };
    pending = [{ action: 'EMIT_FAILURE', payload, job }];
    await (coordinator as any).flushPendingNotifications();
    expect(notifyAutoPublishFailure).toHaveBeenCalledWith(expect.objectContaining({
      sku: '0000021', state: 'PAUSED', errorCode: 'WB_AUTH_FAILED', jobCreatedAt: job.createdAt
    }));
    expect(completeNotificationAction).toHaveBeenCalledWith('0000021', 'EMIT_FAILURE', payload);

    transition.mockClear();
    notifyAutoPublishFailure.mockClear();
    pending = [];
    const before = Date.now();
    await (coordinator as any).handleJobError(job, new AppError('VERIFY_FAILED', 'rate limited', { httpStatus: 429, retryAfterMs: 12_000 }, 502));
    expect(transition).toHaveBeenCalledWith('0000021', 'WAITING_NETWORK', expect.objectContaining({
      eventType: 'RATE_LIMIT_WAIT_SCHEDULED', incrementAttempt: true, incrementRetryKey: 'WB_RATE_LIMIT',
      networkRecovery: expect.objectContaining({ attempt: 1, resumeState: 'CHECKING', deliveryState: 'RESPONDED' }),
      details: expect.objectContaining({ httpStatus: 429, retryDelayMs: 30_000, retryKey: 'WB_RATE_LIMIT', networkAttempt: 1 })
    }));
    const retryAt = Date.parse(transition.mock.calls[0]![2].nextAttemptAt);
    expect(retryAt).toBeGreaterThanOrEqual(before + 29_900);
    expect(retryAt).toBeLessThanOrEqual(Date.now() + 30_100);
    expect(notifyAutoPublishFailure).not.toHaveBeenCalled();

    transition.mockClear();
    await (coordinator as any).handleJobError(job, new AppError('WB_TASK_NOT_REGISTERED', 'WB-P001 未持久化预期任务', {
      httpStatus: 502, expectedTaskId: '0000021__r1', deliveryUnknown: false
    }, 502));
    expect(transition).toHaveBeenCalledWith('0000021', 'WAITING_NETWORK', expect.objectContaining({
      eventType: 'NETWORK_WAIT_SCHEDULED',
      errorCode: 'WB_TASK_NOT_REGISTERED',
      incrementRetryKey: 'WB_TASK_REGISTRATION',
      details: expect.objectContaining({ retryKey: 'WB_TASK_REGISTRATION', networkAttempt: 1 })
    }));

    transition.mockClear();
    const persistentJob = {
      ...job,
      state: 'WAITING_NETWORK',
      networkRecovery: {
        phase: 'SUBMITTING', resumeState: 'SUBMITTING', deliveryState: 'UNKNOWN', attempt: 25,
        firstFailureAt: '2026-08-01T00:00:00.000Z', lastFailureAt: '2026-08-07T00:00:00.000Z',
        nextAttemptAt: '2026-08-07T00:15:00.000Z', lastErrorCode: 'ETIMEDOUT', lastErrorMessage: 'offline'
      }
    } as any;
    await (coordinator as any).handleJobError(persistentJob, Object.assign(new Error('still offline'), { code: 'ETIMEDOUT' }));
    expect(transition).toHaveBeenCalledWith('0000021', 'WAITING_NETWORK', expect.objectContaining({
      networkRecovery: expect.objectContaining({ attempt: 26, resumeState: 'SUBMITTING' })
    }));
    const persistentDelay = Date.parse(transition.mock.calls[0]![2].nextAttemptAt) - Date.now();
    expect(persistentDelay).toBeGreaterThanOrEqual(899_900);
    expect(persistentDelay).toBeLessThanOrEqual(900_100);
  });

  it('notifies once with a stable job dedupe identity only after a non-retryable automatic failure', async () => {
    const transition = vi.fn(async () => ({}));
    const notifyAutoPublishFailure = vi.fn(async () => undefined);
    const job = {
      sku: '0000025', state: 'GENERATING', attemptCount: 3, retryCounters: {},
      createdAt: '2026-07-19T10:10:00.000Z', presetName: '自动上品预设'
    } as any;
    const payload = { failure: {
      sku: job.sku, state: 'NEEDS_ATTENTION', jobCreatedAt: job.createdAt,
      errorCode: 'CONFIG_INVALID', errorMessage: '缺少 WB 必填类目字段', presetName: job.presetName
    } };
    const completeNotificationAction = vi.fn(async () => true);
    const coordinator = new WbAutoPublishingCoordinator(
      {
        configured: true, transition, setListingLock: vi.fn(async () => undefined),
        listPendingNotificationActions: vi.fn(async () => [{ action: 'EMIT_FAILURE', payload, job }]),
        completeNotificationAction
      } as any,
      {} as any,
      { notifyAutoPublishFailure, resolveAutoPublishFailure: vi.fn(async () => undefined) } as any,
      {} as any,
      logger()
    );

    await (coordinator as any).handleJobError(job, new AppError('CONFIG_INVALID', '缺少 WB 必填类目字段', undefined, 409));
    expect(transition).toHaveBeenCalledWith('0000025', 'NEEDS_ATTENTION', expect.objectContaining({
      eventType: 'AUTOMATION_FAILED', errorCode: 'CONFIG_INVALID', errorMessage: '缺少 WB 必填类目字段'
    }));
    expect(notifyAutoPublishFailure).not.toHaveBeenCalled();
    await (coordinator as any).flushPendingNotifications();
    expect(notifyAutoPublishFailure).toHaveBeenCalledTimes(1);
    expect(notifyAutoPublishFailure).toHaveBeenCalledWith({
      sku: '0000025', state: 'NEEDS_ATTENTION', jobCreatedAt: job.createdAt,
      errorCode: 'CONFIG_INVALID', errorMessage: '缺少 WB 必填类目字段', presetName: '自动上品预设',
      operationMode: 'CREATE_ONLY'
    });
    expect(completeNotificationAction).toHaveBeenCalledWith('0000025', 'EMIT_FAILURE', payload);
  });

  it('dispatches the same generated SKU as two isolated store publications without writing the singleton draft task pointer', async () => {
    const linkPublication = vi.fn(async () => undefined);
    const rows = new Map<string, any>();
    let nextRevision = 4;
    const storeRepository = {
      createAutomationMaterializedPublication: vi.fn(async (item: any) => {
        const revision = nextRevision++;
        const id = item.storeAlias === 'first'
          ? '77777777-7777-4777-8777-777777777771'
          : '77777777-7777-4777-8777-777777777772';
        const row = {
          id, sku: item.sku, source: 'AUTOMATION', storeId: item.storeId, storeAlias: item.storeAlias,
          generatedVersionId: item.storeAlias === 'first'
            ? '88888888-8888-4888-8888-888888888881'
            : '88888888-8888-4888-8888-888888888882',
          revision, taskId: `${item.storeAlias}__${item.sku}__r${revision}`,
          presetId: item.presetId, presetDefinitionHash: item.presetDefinitionHash,
          credentialVersionId: item.credentialVersionId,
          materializationHash: `sha256:${item.storeAlias === 'first' ? 'c' : 'd'}`.padEnd(71, item.storeAlias === 'first' ? 'c' : 'd'),
          configSnapshot: {
            sourceGeneratedVersionId: item.sourceGeneratedVersionId,
            automationRunId: item.automationRunId,
            automationRunNo: item.automationRunNo,
            operationMode: item.operationMode,
            mediaTargetVendorCodes: item.mediaTargetVendorCodes,
            storeConfigVersion: item.storeConfigVersion,
            warehouseId: item.warehouseId,
            credentialVersionId: item.credentialVersionId
          },
          status: 'PLANNED',
          nmIds: [], productUrls: [], result: {}, rowVersion: 1,
          createdAt: '2026-08-10T08:00:00.000Z', updatedAt: '2026-08-10T08:00:00.000Z'
        };
        rows.set(id, row);
        return row;
      }),
      recordPublicationPackage: vi.fn(async (id: string, packageIdentity: any) => {
        const row = { ...rows.get(id), ...packageIdentity, rowVersion: 2 };
        rows.set(id, row);
        return row;
      }),
      markPublicationDispatching: vi.fn(async (id: string) => ({ ...rows.get(id), status: 'DISPATCHING' })),
      markPublicationQueued: vi.fn(async (id: string, taskId: string, raw: any) => ({
        ...rows.get(id), status: 'QUEUED', taskId, result: raw
      }))
    };
    const submitListing = vi.fn(async (input: any) => ({
      taskId: `${input.storeAlias}__${input.folderName}__r${input.revision}`,
      raw: { accepted: true, storeId: input.storeId }
    }));
    const publishing = {
      n8n: { submitListing, getJob: vi.fn() },
      submit: vi.fn(),
      prepareStorePublicationPackage: vi.fn(async (input: any) => ({
        markerPath: `F:/wb/stores/${input.storeAlias}/inbox/0000110/${input.publicationId}/.store-ready/${input.publicationId}.json`,
        productSha256: `sha256:${'a'.repeat(64)}`,
        sourceContentSignature: `sha256:${'b'.repeat(64)}`,
        packageRelPath: `stores/${input.storeAlias}/inbox/0000110/${input.publicationId}`,
        packageSignature: `sha256:${'b'.repeat(64)}`,
        reused: false
      })),
      cleanupStorePublicationPackage: vi.fn(async () => true)
    } as any;
    const coordinator = new WbAutoPublishingCoordinator(
      { configured: true, linkPublication } as any,
      {} as any,
      publishing,
      {} as any,
      logger(),
      {},
      storeRepository as any
    );
    const store = (id: string, alias: string, credential: string) => ({
      id, storeAlias: alias, displayName: alias, enabled: true, autoPublishEnabled: true,
      autoPublishMode: 'CREATE_ONLY', warehouseId: `warehouse-${alias}`, warehouseName: alias,
      accountCurrency: 'CNY', maxDailyStyles: 100, credential: { state: 'ACTIVE', activeVersionId: credential },
      seller: {}, permissions: ['content', 'prices', 'marketplace'], preflight: { status: 'PASSED' },
      network: { status: 'READY' }, readiness: { ready: true, blockers: [] }, activeTaskCount: 0, queuedTaskCount: 0,
      configVersion: 4, rowVersion: 5, createdAt: '2026-08-10T08:00:00.000Z', updatedAt: '2026-08-10T08:00:00.000Z'
    }) as any;
    const listing = { generatedVersionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', revision: 3 };
    const job = (storeId: string, runId: string) => ({
      sku: '0000110', storeId, runId, runNo: 1, operationMode: 'CREATE_ONLY',
      presetId: '99999999-9999-4999-8999-999999999999', presetSnapshot: {}
    }) as any;
    const stores = [
      store('11111111-1111-4111-8111-111111111111', 'first', '33333333-3333-4333-8333-333333333333'),
      store('22222222-2222-4222-8222-222222222222', 'second', '44444444-4444-4444-8444-444444444444')
    ];

    const publications = await Promise.all(stores.map((target, index) => (coordinator as any).dispatchStorePublication(
      job(target.id, `55555555-5555-4555-8555-55555555555${index}`), listing, target,
      {
        submissionMode: 'CREATE_ONLY',
        mediaTargetVendorCodes: ['0000110-01'],
        presetDefinitionHash: `sha256:${'a'.repeat(64)}`
      }
    )));

    expect(publications.map((item) => item.taskId).sort()).toEqual(['first__0000110__r4', 'second__0000110__r5']);
    expect(new Set(publications.map((item) => item.generatedVersionId)).size).toBe(2);
    expect(publications.map((item) => item.packageRelPath).sort()).toEqual([
      'stores/first/inbox/0000110/77777777-7777-4777-8777-777777777771',
      'stores/second/inbox/0000110/77777777-7777-4777-8777-777777777772'
    ]);
    expect(submitListing).toHaveBeenCalledTimes(2);
    expect(submitListing).toHaveBeenCalledWith(expect.objectContaining({
      storeAlias: 'first', publicationId: expect.any(String),
      packageRelPath: expect.stringContaining('stores/first/inbox/0000110/'),
      packageSignature: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
      materializationHash: expect.stringMatching(/^sha256:[a-f0-9]{64}$/)
    }));
    expect(submitListing).toHaveBeenCalledWith(expect.objectContaining({
      storeAlias: 'second', publicationId: expect.any(String),
      packageRelPath: expect.stringContaining('stores/second/inbox/0000110/'),
      packageSignature: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
      materializationHash: expect.stringMatching(/^sha256:[a-f0-9]{64}$/)
    }));
    expect(new Set(submitListing.mock.calls.map((call) => call[0].publicationId)).size).toBe(2);
    expect(storeRepository.createAutomationMaterializedPublication).toHaveBeenCalledTimes(2);
    expect(storeRepository.createAutomationMaterializedPublication.mock.calls.every((call) => (
      call[0].presetDefinitionHash === `sha256:${'a'.repeat(64)}`
    ))).toBe(true);
    expect(storeRepository.recordPublicationPackage).toHaveBeenCalledTimes(2);
    expect(linkPublication).toHaveBeenCalledTimes(2);
    expect(publishing.cleanupStorePublicationPackage).not.toHaveBeenCalled();
    expect(publishing.submit).not.toHaveBeenCalled();
  });

  it('waits through the publication-before-insert window, then rebuilds the second store after the turn is released', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'wb-store-preset-fanout-'));
    const productRoot = path.join(root, 'inbox', '0000110');
    await mkdir(path.join(productRoot, 'variants', 'black'), { recursive: true });
    await writeFile(path.join(productRoot, 'variants', 'black', '01.png'), Buffer.from('image'));
    await writeFile(path.join(productRoot, 'variants', 'black', 'main.mp4'), Buffer.from('video'));
    await writeFile(path.join(productRoot, 'variants', 'variant-media-manifest.json'), JSON.stringify({
      schemaVersion: 2,
      SKU: '0000110',
      assets: [{
        assetId: 'image-black-1', variantId: 'black', variantColor: { colorKey: 'black' },
        sourceStageId: 'E005', kind: 'image', relativePath: 'variants/black/01.png',
        sizeBytes: 5, sha256: '6105d6cc76af400325e94d588ce511be5bfdbb73b437dc51eca43917d7a43e3d',
        deliveredAt: '2026-08-10T08:30:00.000Z', submissionId: 'e005-new'
      }, {
        assetId: 'video-black-1', variantId: 'black', variantColor: { colorKey: 'black' },
        sourceStageId: 'E004', kind: 'video', relativePath: 'variants/black/main.mp4',
        sizeBytes: 5, sha256: '0cab1c9617404faf2b24e221e189ca5945813e14d3f766345b09ca13bbe28ffc',
        deliveredAt: '2026-08-10T08:30:00.000Z', submissionId: 'e004-new'
      }]
    }));
    const binding = {
      schemaVersion: 2,
      presetId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      presetName: '第二店预设',
      presetRowVersion: 1,
      boundAt: '2026-08-10T08:00:00.000Z',
      activationStartedAt: '2026-08-10T08:00:00.000Z',
      definitionHash: `sha256:${'b'.repeat(64)}`,
      presetSnapshot: materialPresetSnapshot('第二店预设', 55),
      dependencySnapshot: materialDependencies()
    };
    const checkVendorCodes = vi.fn();
    const submitListing = vi.fn();
    const assertGeneratedVersionPreset = vi.fn(async (generatedVersionId: string) => {
      if (generatedVersionId === 'cccccccc-cccc-4ccc-8ccc-cccccccccccc') {
        throw new AppError('PRESET_VERSION_MISMATCH', 'different generated material', undefined, 409);
      }
    });
    const rebuildListing = vi.fn(async () => {
      throw new AppError('STOP_AFTER_STORE_REBUILD', 'stop test', undefined, 500);
    });
    const transition = vi.fn(async () => ({}));
    const claimGenerationLease = vi.fn()
      .mockResolvedValueOnce({
        acquired: false,
        sku: '0000110',
        ownerJobId: '11111111-1111-4111-8111-111111111111',
        ownerRunId: '55555555-5555-4555-8555-555555555555',
        ownerStoreId: '11111111-1111-4111-8111-111111111111',
        phase: 'MATERIALIZING_STORE_PUBLICATION',
        leaseUntil: new Date(Date.now() + 12_000).toISOString(),
        rowVersion: 1
      })
      .mockResolvedValue({
        acquired: true,
        sku: '0000110',
        ownerJobId: '77777777-7777-4777-8777-777777777777',
        ownerRunId: '44444444-4444-4444-8444-444444444444',
        ownerStoreId: '22222222-2222-4222-8222-222222222222',
        phase: 'GENERATING_SHARED_LISTING',
        leaseUntil: new Date(Date.now() + 120_000).toISOString(),
        rowVersion: 2
      });
    const releaseGenerationLease = vi.fn(async () => true);
    const heartbeatGenerationLease = vi.fn(async (leaseJob: any, input: any) => ({
      acquired: true,
      sku: leaseJob.sku,
      ownerJobId: leaseJob.id,
      ownerRunId: leaseJob.runId,
      ownerStoreId: leaseJob.storeId,
      phase: input.phase,
      ...(input.sourceVersionId ? { sourceVersionId: input.sourceVersionId } : {}),
      leaseUntil: new Date(Date.now() + 120_000).toISOString(),
      rowVersion: input.expectedRowVersion
    }));
    const repository = {
      configured: true,
      persistBinding: vi.fn(async () => undefined),
      transition,
      claimGenerationLease,
      heartbeatGenerationLease,
      releaseGenerationLease,
      findGenerationOwner: vi.fn(async () => ({
        id: '11111111-1111-4111-8111-111111111111',
        runId: '55555555-5555-4555-8555-555555555555',
        storeId: '11111111-1111-4111-8111-111111111111',
        state: 'GENERATING'
      }))
    } as any;
    const listingBeforeTurn = {
      sku: '0000110',
      status: 'GENERATED',
      generatedVersionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      revision: 3,
      draftVersion: 3,
      autoPublishLocked: true,
      latestOperationSource: 'AUTOMATION',
      latestOperationRef: 'automation:55555555-5555-4555-8555-555555555555',
      variants: [{ variantId: 'listing-black', productVariantId: 'black', vendorCode: '0000110-01' }]
    };
    const listingAfterTurn = {
      ...listingBeforeTurn,
      generatedVersionId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      revision: 4,
      draftVersion: 4
    };
    const getListing = vi.fn()
      .mockResolvedValueOnce(listingBeforeTurn)
      .mockResolvedValueOnce(listingBeforeTurn)
      .mockResolvedValue(listingAfterTurn);
    const coordinator = new WbAutoPublishingCoordinator(
      repository,
      {
        parseExecutionBinding: vi.fn(() => binding),
        resolveExecutionBinding: vi.fn(async () => ({
          resolved: { issues: [], dependencies: { category: { formConfig: { media: { minImages: 1, maxImages: 7, videoAllowed: true } } } } }
        })),
        rebuildListing
      } as any,
      {
        repository: {
          getListing,
          countListingVersions: vi.fn(async () => 1)
        },
        n8n: { checkVendorCodes, submitListing },
        productVariants: vi.fn(async () => [{ variantId: 'black', name: '黑色', wbColor: { colorKey: 'black' } }]),
        readiness: vi.fn(async () => ({ complete: true, rootDirectory: root }))
      } as any,
      {} as any,
      logger(),
      { stableWindowMs: 0, stableProbeMs: 0 },
      {
        getStore: vi.fn(async () => ({
          id: '22222222-2222-4222-8222-222222222222',
          storeAlias: 'second',
          credential: { state: 'ACTIVE', activeVersionId: '33333333-3333-4333-8333-333333333333' }
        })),
        assertGeneratedVersionPreset,
        findAutomationMaterializedPublication: vi.fn(async () => undefined),
        hasFrozenAutomationPublicationForSource: vi.fn(async () => true)
      } as any
    );

    const job = {
      id: '77777777-7777-4777-8777-777777777777',
      sku: '0000110',
      storeId: '22222222-2222-4222-8222-222222222222',
      state: 'CHECKING',
      operationMode: 'CREATE_ONLY',
      runId: '44444444-4444-4444-8444-444444444444',
      runNo: 1,
      presetBinding: binding,
      mediaTargetVariantIds: ['black'],
      mediaTargetVendorCodes: [],
      retryCounters: {},
      lastDeliveryAt: '2026-08-10T08:30:00.000Z',
      updatedAt: '2026-08-10T08:30:00.000Z',
      triggerType: 'AUTO',
      targetRevision: 1
    } as any;

    await expect((coordinator as any).processJob(job)).resolves.toBeUndefined();
    expect(transition).toHaveBeenCalledWith('0000110', 'WAITING_GENERATION_TURN', expect.objectContaining({
      eventType: 'WAITING_GENERATION_TURN',
      message: '等待同一 SKU 的另一店完成共享版本冻结',
      details: expect.objectContaining({
        ownerRunId: '55555555-5555-4555-8555-555555555555',
        ownerPhase: 'MATERIALIZING_STORE_PUBLICATION'
      }),
      nextAttemptAt: expect.any(String),
      errorCode: null,
      errorMessage: null
    }), '22222222-2222-4222-8222-222222222222');
    expect(Date.parse(transition.mock.calls[0]![2].nextAttemptAt) - Date.now()).toBeGreaterThanOrEqual(4_800);
    expect(rebuildListing).not.toHaveBeenCalled();
    expect(releaseGenerationLease).not.toHaveBeenCalled();

    transition.mockClear();
    await expect((coordinator as any).processJob({ ...job, state: 'WAITING_GENERATION_TURN' }))
      .rejects.toMatchObject({ code: 'STOP_AFTER_STORE_REBUILD' });

    expect(claimGenerationLease).toHaveBeenCalledTimes(2);
    expect(assertGeneratedVersionPreset).toHaveBeenCalledWith(
      'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      expect.stringMatching(/^sha256:[a-f0-9]{64}$/)
    );
    expect(rebuildListing).toHaveBeenCalledWith(
      '0000110', binding, 'automation:44444444-4444-4444-8444-444444444444', true,
      expect.objectContaining({
        jobId: '77777777-7777-4777-8777-777777777777',
        runId: '44444444-4444-4444-8444-444444444444',
        rowVersion: 2
      })
    );
    expect(transition).toHaveBeenCalledWith('0000110', 'INITIALIZING', expect.objectContaining({
      eventType: 'STORE_PRESET_VERSION_REBUILD_STARTED'
    }), '22222222-2222-4222-8222-222222222222');
    expect(checkVendorCodes).not.toHaveBeenCalled();
    expect(submitListing).not.toHaveBeenCalled();
    expect(releaseGenerationLease).toHaveBeenCalledWith(expect.objectContaining({
      id: '77777777-7777-4777-8777-777777777777',
      sku: '0000110',
      runId: '44444444-4444-4444-8444-444444444444'
    }), 2);
  });

  it('links and resumes a strict detached STORE_PUBLICATION after commit-before-link crash', async () => {
    const runId = '44444444-4444-4444-8444-444444444444';
    const storeId = '22222222-2222-4222-8222-222222222222';
    const presetId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    const binding = {
      schemaVersion: 2,
      presetId,
      presetName: '崩溃恢复预设',
      presetRowVersion: 1,
      boundAt: '2026-08-10T08:00:00.000Z',
      activationStartedAt: '2026-08-10T08:00:00.000Z',
      definitionHash: `sha256:${'b'.repeat(64)}`,
      presetSnapshot: materialPresetSnapshot('崩溃恢复预设', 49),
      dependencySnapshot: materialDependencies()
    };
    const presetDefinitionHash = wbMaterialPresetDefinitionHash(binding as any);
    const publication = {
      id: '77777777-7777-4777-8777-777777777777',
      sku: '0000110',
      generatedVersionId: '99999999-9999-4999-8999-999999999999',
      storeId,
      storeAlias: 'second',
      status: 'SUCCEEDED',
      source: 'AUTOMATION',
      taskId: 'second__0000110__r4',
      revision: 4,
      presetId,
      presetDefinitionHash,
      materializationHash: `sha256:${'c'.repeat(64)}`,
      configSnapshot: {
        automationRunId: runId,
        sourceGeneratedVersionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        presetId
      },
      nmIds: ['1410000000'],
      productUrls: ['https://www.wildberries.ru/catalog/1410000000/detail.aspx'],
      result: {},
      rowVersion: 1,
      createdAt: '2026-08-10T08:00:00.000Z',
      updatedAt: '2026-08-10T08:01:00.000Z'
    } as any;
    const linkPublication = vi.fn(async () => undefined);
    const transition = vi.fn(async () => ({}));
    const claimGenerationLease = vi.fn();
    const getListing = vi.fn();
    const coordinator = new WbAutoPublishingCoordinator(
      {
        configured: true,
        persistBinding: vi.fn(async () => undefined),
        linkPublication,
        transition,
        setListingLock: vi.fn(async () => undefined),
        claimGenerationLease
      } as any,
      {
        parseExecutionBinding: vi.fn(() => binding),
        resolveExecutionBinding: vi.fn(async () => ({ resolved: { issues: [], dependencies: {} } }))
      } as any,
      { repository: { getListing } } as any,
      {} as any,
      logger(),
      {},
      {
        getStore: vi.fn(async () => ({ id: storeId, storeAlias: 'second' })),
        findAutomationMaterializedPublication: vi.fn(async () => publication),
        getPublication: vi.fn(async () => publication),
        syncPublication: vi.fn(async () => publication)
      } as any
    );
    const job = {
      id: '11111111-1111-4111-8111-111111111111',
      sku: '0000110',
      storeId,
      state: 'CHECKING',
      operationMode: 'COMPATIBLE_UPSERT',
      runId,
      runNo: 1,
      presetId,
      presetBinding: binding,
      materialPresetDefinitionHash: presetDefinitionHash,
      mediaTargetVariantIds: ['black'],
      mediaTargetVendorCodes: [],
      retryCounters: {},
      triggerType: 'MEDIA_DELIVERY'
    } as any;

    await expect((coordinator as any).processJob(job)).resolves.toBeUndefined();
    expect(linkPublication).toHaveBeenCalledWith('0000110', storeId, runId, publication.id);
    expect(transition).toHaveBeenCalledWith('0000110', 'SUCCEEDED', expect.objectContaining({
      eventType: 'LINKED_PUBLICATION_RESUMED',
      n8nTaskId: publication.taskId
    }), storeId);
    expect(claimGenerationLease).not.toHaveBeenCalled();
    expect(getListing).not.toHaveBeenCalled();
  });

  it('upserts an unacknowledged failure before resolving it after submit and keeps the action on transient errors', async () => {
    const job = { sku: '0000027', state: 'QUEUED', createdAt: '2026-07-19T10:20:00.000Z' } as any;
    const failure = {
      sku: job.sku, state: 'NEEDS_ATTENTION', jobCreatedAt: job.createdAt,
      errorCode: 'CONFIG_INVALID', errorMessage: '缺少必填字段'
    };
    const payload = { failure, resolution: { sku: job.sku, state: 'QUEUED', jobCreatedAt: job.createdAt } };
    const notifyAutoPublishFailure = vi.fn(async () => undefined);
    const resolveAutoPublishFailure = vi.fn()
      .mockResolvedValueOnce('notification database unavailable')
      .mockResolvedValueOnce(undefined);
    const completeNotificationAction = vi.fn(async () => true);
    const repository = {
      configured: true,
      listPendingNotificationActions: vi.fn(async () => [{ action: 'RESOLVE_FAILURE', payload, job }]),
      completeNotificationAction
    } as any;
    const coordinator = new WbAutoPublishingCoordinator(
      repository, {} as any, { notifyAutoPublishFailure, resolveAutoPublishFailure } as any, {} as any, logger()
    );

    await (coordinator as any).flushPendingNotifications();
    expect(notifyAutoPublishFailure).toHaveBeenCalledWith({ ...failure, operationMode: 'CREATE_ONLY' });
    expect(resolveAutoPublishFailure).toHaveBeenCalledTimes(1);
    expect(completeNotificationAction).not.toHaveBeenCalled();

    await (coordinator as any).flushPendingNotifications();
    expect(notifyAutoPublishFailure).toHaveBeenCalledTimes(2);
    expect(resolveAutoPublishFailure).toHaveBeenCalledTimes(2);
    expect(completeNotificationAction).toHaveBeenCalledWith('0000027', 'RESOLVE_FAILURE', payload);
  });
});

describe('WB automatic store publication dispatch boundary', () => {
  function dispatchHarness(
    submitListing: ReturnType<typeof vi.fn>,
    getJob = vi.fn(),
    options: { legacyPublication?: boolean } = {}
  ) {
    const store = {
      id: '11111111-1111-4111-8111-111111111111',
      storeAlias: 'second', displayName: '第二店', enabled: true, autoPublishEnabled: true,
      autoPublishMode: 'CREATE_ONLY', warehouseId: 'warehouse-second', warehouseName: '第二店仓',
      accountCurrency: 'CNY', maxDailyStyles: 100,
      credential: { state: 'ACTIVE', activeVersionId: '22222222-2222-4222-8222-222222222222' },
      seller: {}, permissions: ['content', 'prices', 'marketplace'], preflight: { status: 'PASSED' },
      network: { status: 'READY' }, readiness: { ready: true, blockers: [] }, activeTaskCount: 0, queuedTaskCount: 0,
      configVersion: 4, rowVersion: 5, createdAt: '2026-08-10T08:00:00.000Z', updatedAt: '2026-08-10T08:00:00.000Z'
    } as any;
    const listing = { generatedVersionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', revision: 3 };
    const job = {
      id: '33333333-3333-4333-8333-333333333333', storeId: store.id, sku: '0000110',
      runId: '44444444-4444-4444-8444-444444444444', runNo: 1, operationMode: 'CREATE_ONLY',
      state: 'SUBMITTING', presetId: '55555555-5555-4555-8555-555555555555', presetSnapshot: {},
      retryCounters: {}, createdAt: '2026-08-10T08:00:00.000Z'
    } as any;
    let publication: any = options.legacyPublication ? {
      id: '99999999-9999-4999-8999-999999999999', sku: '0000110',
      generatedVersionId: listing.generatedVersionId, revision: listing.revision,
      storeId: store.id, storeAlias: store.storeAlias, source: 'AUTOMATION',
      taskId: 'second__0000110__r3', presetId: job.presetId,
      presetDefinitionHash: `sha256:${'a'.repeat(64)}`,
      credentialVersionId: store.credential.activeVersionId,
      configSnapshot: {
        automationRunId: job.runId,
        automationRunNo: job.runNo,
        autoPublishMode: 'CREATE_ONLY',
        storeConfigVersion: store.configVersion,
        warehouseId: store.warehouseId
      },
      status: 'PLANNED', nmIds: [], productUrls: [], result: {}, rowVersion: 1,
      createdAt: '2026-08-10T08:00:00.000Z', updatedAt: '2026-08-10T08:00:00.000Z'
    } : undefined;
    if (options.legacyPublication) job.publicationId = publication.id;
    const storeRepository = {
      createAutomationMaterializedPublication: vi.fn(async (item: any) => {
        if (!publication) {
          publication = {
            id: '66666666-6666-4666-8666-666666666666', sku: item.sku,
            generatedVersionId: '77777777-7777-4777-8777-777777777777', revision: 4,
            storeId: item.storeId, storeAlias: item.storeAlias, source: 'AUTOMATION',
            taskId: 'second__0000110__r4', presetId: item.presetId,
            presetDefinitionHash: item.presetDefinitionHash,
            credentialVersionId: item.credentialVersionId,
            materializationHash: `sha256:${'c'.repeat(64)}`,
            configSnapshot: {
              sourceGeneratedVersionId: item.sourceGeneratedVersionId,
              automationRunId: item.automationRunId,
              automationRunNo: item.automationRunNo,
              operationMode: item.operationMode,
              mediaTargetVendorCodes: item.mediaTargetVendorCodes,
              storeConfigVersion: item.storeConfigVersion,
              warehouseId: item.warehouseId,
              credentialVersionId: item.credentialVersionId
            },
            status: 'PLANNED', nmIds: [], productUrls: [], result: {}, rowVersion: 1,
            createdAt: '2026-08-10T08:00:00.000Z', updatedAt: '2026-08-10T08:00:00.000Z'
          };
        }
        return publication;
      }),
      getPublication: vi.fn(async () => publication),
      recordPublicationPackage: vi.fn(async (_id: string, packageIdentity: any) => {
        publication = { ...publication, ...packageIdentity, rowVersion: publication.rowVersion + 1 };
        return publication;
      }),
      markPublicationDispatching: vi.fn(async () => {
        publication = { ...publication, status: 'DISPATCHING', rowVersion: publication.rowVersion + 1 };
        return publication;
      }),
      markPublicationQueued: vi.fn(async (_id: string, taskId: string, raw: any) => {
        publication = { ...publication, status: 'QUEUED', taskId, result: raw, errorCode: undefined, errorMessage: undefined };
        return publication;
      }),
      markPublicationDispatchUnknown: vi.fn(async (_id: string, taskId: string, code: string, message: string) => {
        publication = {
          ...publication,
          status: 'DISPATCHING', taskId, errorCode: code, errorMessage: message,
          result: { ...publication.result, dispatchRecovery: { deliveryUnknown: true, taskId } }
        };
        return publication;
      }),
      markPublicationFailed: vi.fn(async (_id: string, code: string, message: string) => {
        publication = { ...publication, status: 'NEEDS_ATTENTION', errorCode: code, errorMessage: message };
        return publication;
      })
    };
    const transition = vi.fn(async (_sku: string, state: string) => ({ ...job, state }));
    const repository = {
      configured: true,
      linkPublication: vi.fn(async () => undefined),
      transition,
      setListingLock: vi.fn(async () => undefined)
    } as any;
    const publishing = {
      n8n: { submitListing, getJob },
      prepareStorePublicationPackage: vi.fn(async (input: any) => ({
        markerPath: input.materializationHash
          ? `F:/wb/stores/second/inbox/0000110/${input.publicationId}/.store-ready/${input.publicationId}.json`
          : `F:/wb/inbox/0000110/.store-ready/${input.publicationId}.json`,
        productSha256: `sha256:${'a'.repeat(64)}`,
        sourceContentSignature: `sha256:${'b'.repeat(64)}`,
        packageRelPath: input.materializationHash
          ? `stores/second/inbox/0000110/${input.publicationId}`
          : 'inbox/0000110',
        packageSignature: `sha256:${'b'.repeat(64)}`,
        reused: false
      })),
      cleanupStorePublicationPackage: vi.fn(async () => true)
    } as any;
    const coordinator = new WbAutoPublishingCoordinator(
      repository, {} as any, publishing, {} as any, logger(), {}, storeRepository as any
    );
    const dispatch = (listingOverride = listing) => (coordinator as any).dispatchStorePublication(job, listingOverride, store, {
      submissionMode: 'CREATE_ONLY', mediaTargetVendorCodes: ['0000110-01'], presetDefinitionHash: `sha256:${'a'.repeat(64)}`
    });
    return { coordinator, dispatch, get publication() { return publication; }, storeRepository, repository, publishing, transition, job };
  }

  it('reuses a linked STORE_PUBLICATION generated version without comparing it to the old source LISTING id', async () => {
    const submitListing = vi.fn(async (input: any) => ({
      taskId: `second__0000110__r${input.revision}`,
      raw: { accepted: true }
    }));
    const harness = dispatchHarness(submitListing);

    await expect(harness.dispatch()).resolves.toMatchObject({
      status: 'QUEUED',
      generatedVersionId: '77777777-7777-4777-8777-777777777777',
      revision: 4
    });
    harness.job.publicationId = harness.publication.id;
    await expect(harness.dispatch({
      generatedVersionId: harness.publication.generatedVersionId,
      revision: harness.publication.revision
    })).resolves.toMatchObject({ status: 'QUEUED', taskId: 'second__0000110__r4' });

    expect(harness.storeRepository.createAutomationMaterializedPublication).toHaveBeenCalledOnce();
    expect(harness.storeRepository.getPublication).toHaveBeenCalledOnce();
    expect(submitListing).toHaveBeenCalledOnce();
  });

  it('keeps a deployment-before-upgrade LISTING publication on the shared-package compatibility branch', async () => {
    const submitListing = vi.fn(async () => ({
      taskId: 'second__0000110__r3',
      raw: { accepted: true, compatibility: true }
    }));
    const harness = dispatchHarness(submitListing, vi.fn(), { legacyPublication: true });

    await expect(harness.dispatch()).resolves.toMatchObject({
      status: 'QUEUED',
      generatedVersionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      taskId: 'second__0000110__r3'
    });
    expect(harness.storeRepository.createAutomationMaterializedPublication).not.toHaveBeenCalled();
    expect(harness.storeRepository.recordPublicationPackage).not.toHaveBeenCalled();
    expect(harness.repository.linkPublication).toHaveBeenCalledWith(
      '0000110', harness.job.storeId, harness.job.runId, harness.job.publicationId
    );
    expect(harness.publishing.prepareStorePublicationPackage).toHaveBeenCalledWith(
      expect.not.objectContaining({ materializationHash: expect.anything() })
    );
    expect(submitListing).toHaveBeenCalledWith(expect.not.objectContaining({
      packageRelPath: expect.anything(),
      packageSignature: expect.anything(),
      materializationHash: expect.anything()
    }));
    expect(harness.publishing.cleanupStorePublicationPackage).toHaveBeenCalledOnce();
  });

  it('moves both the publication and automatic job to NEEDS_ATTENTION after an explicit pre-submit 403 rejection', async () => {
    const submitListing = vi.fn(async () => {
      throw new AppError('VERIFY_FAILED', 'n8n 拒绝鉴权', { httpStatus: 403, deliveryUnknown: false }, 502);
    });
    const harness = dispatchHarness(submitListing);
    let caught: unknown;
    try { await harness.dispatch(); } catch (error) { caught = error; }

    expect(caught).toMatchObject({ code: 'VERIFY_FAILED', state: 'NEEDS_ATTENTION' });
    expect(harness.publication).toMatchObject({ status: 'NEEDS_ATTENTION', errorCode: 'VERIFY_FAILED' });
    expect(harness.storeRepository.markPublicationFailed).toHaveBeenCalledOnce();

    await (harness.coordinator as any).handleJobError(harness.job, caught);
    expect(harness.transition).toHaveBeenCalledWith(
      '0000110', 'NEEDS_ATTENTION', expect.objectContaining({ errorCode: 'VERIFY_FAILED' }), harness.job.storeId
    );
  });

  it('keeps an unknown submit in DISPATCHING and only completes it through deterministic task readback', async () => {
    const submitListing = vi.fn(async () => {
      throw new AppError('VERIFY_FAILED', 'socket closed', { deliveryUnknown: true }, 502);
    });
    const getJob = vi.fn()
      .mockRejectedValueOnce(new AppError('VERIFY_FAILED', 'readback timeout', { deliveryUnknown: true }, 502))
      .mockResolvedValueOnce({ taskId: 'second__0000110__r4', productCode: '0000110', revision: 4, storeAlias: 'second' });
    const harness = dispatchHarness(submitListing, getJob);

    await expect(harness.dispatch()).rejects.toMatchObject({ details: { deliveryUnknown: true } });
    expect(harness.publication).toMatchObject({
      status: 'DISPATCHING', result: { dispatchRecovery: { deliveryUnknown: true, taskId: 'second__0000110__r4' } }
    });
    await expect(harness.dispatch({
      generatedVersionId: '88888888-8888-4888-8888-888888888888', revision: 9
    })).rejects.toMatchObject({ details: { deliveryUnknown: true } });
    expect(submitListing).toHaveBeenCalledOnce();

    await expect(harness.dispatch({
      generatedVersionId: '88888888-8888-4888-8888-888888888888', revision: 9
    })).resolves.toMatchObject({ status: 'QUEUED', taskId: 'second__0000110__r4' });
    expect(submitListing).toHaveBeenCalledOnce();
    expect(getJob).toHaveBeenCalledTimes(2);
    expect(harness.storeRepository.createAutomationMaterializedPublication).toHaveBeenCalledTimes(3);
    expect(harness.publication).toMatchObject({
      id: '66666666-6666-4666-8666-666666666666',
      generatedVersionId: '77777777-7777-4777-8777-777777777777',
      revision: 4
    });
  });

  it('safely resubmits the same deterministic task id after an explicit JOB_NOT_FOUND readback', async () => {
    const submitListing = vi.fn()
      .mockRejectedValueOnce(new AppError('VERIFY_FAILED', 'socket closed', { deliveryUnknown: true }, 502))
      .mockResolvedValueOnce({ taskId: 'second__0000110__r3', raw: { accepted: true } });
    const getJob = vi.fn(async () => {
      throw new AppError('JOB_NOT_FOUND', '任务不存在', { deliveryUnknown: false }, 404);
    });
    const harness = dispatchHarness(submitListing, getJob);

    await expect(harness.dispatch()).rejects.toMatchObject({ details: { deliveryUnknown: true } });
    await expect(harness.dispatch()).resolves.toMatchObject({ status: 'QUEUED', taskId: 'second__0000110__r3' });
    expect(submitListing).toHaveBeenCalledTimes(2);
    expect(submitListing.mock.calls[0]![0]).toMatchObject({
      storeAlias: 'second', publicationId: harness.publication.id,
      idempotencyKey: 'second|0000110|4|44444444-4444-4444-8444-444444444444',
      packageRelPath: `stores/second/inbox/0000110/${harness.publication.id}`,
      packageSignature: `sha256:${'b'.repeat(64)}`,
      materializationHash: `sha256:${'c'.repeat(64)}`
    });
    expect(submitListing.mock.calls[1]![0]).toEqual(submitListing.mock.calls[0]![0]);
  });
});
