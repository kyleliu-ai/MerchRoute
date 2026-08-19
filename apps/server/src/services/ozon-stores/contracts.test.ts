import { mkdir, mkdtemp, readFile, rename, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { OZON_DEFAULT_STORE_ID, ozonProductSchema } from '@n8n-media-review/shared';
import { createOzonVariantColorAuthority, OZON_SHARED_SOURCE_STORE_FIELDS } from '../ozon-publishing/index.js';
import { publicationCancellationBlockers } from '../../repositories/ozon-stores.js';
import {
  applyOzonStoreScopedProductFields,
  buildOzonStoreReadyMarker,
  deriveExplicitPriceOverrides,
  materialPriceOverrideBlockers,
  materializeProduct,
  materializeOfferForStore,
  OzonStoreService,
  prepareSharedSource,
  inspectOzonProcessingPackageRecovery,
  sanitizeLegacyCrossCurrencyPriceOverrides,
  signSharedSourceMarker,
  signIntakeTicket,
  stableMaterial,
  stablePresetMaterial,
  writeOzonProcessingRecoveryPackage
} from './index.js';

const temporaryRoots: string[] = [];
const originalFetch = globalThis.fetch;
const originalEncryptionKey = process.env.MERCHROUTE_CREDENTIAL_ENCRYPTION_KEY;
const originalFleetReady = process.env.MERCHROUTE_OZON_MULTISTORE_FLEET_READY;

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  vi.restoreAllMocks();
  globalThis.fetch = originalFetch;
  if (originalEncryptionKey === undefined) delete process.env.MERCHROUTE_CREDENTIAL_ENCRYPTION_KEY;
  else process.env.MERCHROUTE_CREDENTIAL_ENCRYPTION_KEY = originalEncryptionKey;
  if (originalFleetReady === undefined) delete process.env.MERCHROUTE_OZON_MULTISTORE_FLEET_READY;
  else process.env.MERCHROUTE_OZON_MULTISTORE_FLEET_READY = originalFleetReady;
});

describe('OZON staged store onboarding contract', () => {
  it('creates Tek+ as a disabled VAULT store without a preset, warehouse or credential', async () => {
    const repository = {
      createStore: vi.fn(async (input) => ({ id: '10000000-0000-4000-8000-000000000001', enabled: false, ...input }))
    };
    const ozon = { getPreset: vi.fn() };
    const service = new OzonStoreService(repository as any, ozon as any, {} as any, {} as any);

    await expect(service.createStore({ storeAlias: 'tek-plus', displayName: 'Tek+' })).resolves.toMatchObject({
      storeAlias: 'tek-plus', displayName: 'Tek+', enabled: false,
      autoPublishEnabled: false, autoPublishMode: 'CREATE_ONLY',
      warehouseId: '', warehouseName: '', fulfillmentMode: 'FBS', accountCurrency: 'RUB', maxDailyStyles: 100
    });
    expect(ozon.getPreset).not.toHaveBeenCalled();
    expect(repository.createStore).toHaveBeenCalledWith({
      storeAlias: 'tek-plus', displayName: 'Tek+',
      autoPublishEnabled: false, autoPublishMode: 'CREATE_ONLY',
      warehouseId: '', warehouseName: '', fulfillmentMode: 'FBS', accountCurrency: 'RUB', maxDailyStyles: 100
    });
  });
});

describe('OZON runtime claim service contract', () => {
  const runtimeRoot = path.join(os.tmpdir(), 'merchroute-ozon-runtime-root');
  const claimedJob = {
    id: '50000000-0000-4000-8000-000000000001', sku: '0000119', state: 'UPLOADING_MEDIA' as const, source: 'AUTO' as const,
    taskKind: 'STORE_PUBLICATION' as const,
    taskId: 'default__0000119__r2', storeId: OZON_DEFAULT_STORE_ID, storeAlias: 'default',
    publicationId: '10000000-0000-4000-8000-000000000001',
    credentialVersionId: '20000000-0000-4000-8000-000000000001', credentialBindingMode: 'VAULT' as const,
    storeConfigVersion: 4, warehouseId: '1020002456503000', offerContractHash: `sha256:${'1'.repeat(64)}`,
    materializationHash: `sha256:${'2'.repeat(64)}`, revision: 2, offerIds: ['0000119-01'],
    contentPolicyVersion: 'merchroute-ozon-content-v3' as const,
    materialHash: `sha256:${'4'.repeat(64)}`,
    materialHashVersion: 'ozon-shared-material-v1' as const,
    publicationContentPolicyVersion: 'merchroute-ozon-content-v3' as const,
    publicationMaterialHash: `sha256:${'4'.repeat(64)}`,
    publicationMaterialHashVersion: 'ozon-shared-material-v1' as const,
    planHash: `sha256:${'5'.repeat(64)}`,
    presetRowVersion: 3,
    publicationMode: 'CREATE_ONLY' as const,
    payload: { schemaVersion: 3, mode: 'MULTISTORE_PUBLICATION', productJsonPath: path.join(runtimeRoot, 'stores', 'default', 'inbox', '0000119', 'product.json') }, stageStates: {}, ozonProductLinks: [],
    taskFolder: '0000119__r2', workRelPath: 'processing/default__0000119__r2', directoryStage: 'PROCESSING' as const,
    directorySignature: `sha256:${'3'.repeat(64)}`, rowVersion: 6, leaseOwner: 'ozon-p002:test',
    leaseToken: '44444444-4444-4444-8444-444444444444', leaseExpiresAt: '2026-08-11T08:23:30.000Z', retryCount: 0
  };

  it('normalizes request defaults and returns only the strict shared result shape', async () => {
    const repository = {
      getSettings: vi.fn(async () => ({ rootDirectory: runtimeRoot })),
      claimRuntimeJobs: vi.fn(async () => [claimedJob])
    };
    const service = new OzonStoreService(repository as any, {} as any, {} as any, {} as any);
    await expect(service.claimRuntimeJobs({ leaseOwner: 'ozon-p002:test' })).resolves.toEqual({
      items: [{
        ...claimedJob,
        payload: {
          ...claimedJob.payload,
          workRelPath: claimedJob.workRelPath,
          workDirectory: path.join(runtimeRoot, 'processing', 'default__0000119__r2'),
          productJsonPath: path.join(runtimeRoot, 'processing', 'default__0000119__r2', 'product.json')
        }
      }],
      globalConcurrency: 2,
      perStoreConcurrency: 1
    });
    expect(repository.claimRuntimeJobs).toHaveBeenCalledWith({ leaseOwner: 'ozon-p002:test', leaseSeconds: 600, limit: 2 });
  });

  it('projects two stores of the same SKU to separate processing directories', async () => {
    const glauke = {
      ...claimedJob,
      id: '50000000-0000-4000-8000-000000000002',
      taskId: '2466679__0000119__r2',
      storeId: '7d15ba0c-9270-4dd8-bf43-55457670f290',
      storeAlias: '2466679',
      publicationId: '10000000-0000-4000-8000-000000000002',
      credentialVersionId: '20000000-0000-4000-8000-000000000002',
      workRelPath: 'processing/2466679__0000119__r2',
      payload: { productJsonPath: path.join(runtimeRoot, 'stores', '2466679', 'inbox', '0000119', 'product.json') }
    };
    const repository = {
      getSettings: vi.fn(async () => ({ rootDirectory: runtimeRoot })),
      claimRuntimeJobs: vi.fn(async () => [claimedJob, glauke])
    };
    const service = new OzonStoreService(repository as any, {} as any, {} as any, {} as any);
    const result = await service.claimRuntimeJobs({ leaseOwner: 'ozon-p002:test' });
    expect(result.items.map((item) => item.payload.productJsonPath)).toEqual([
      path.join(runtimeRoot, 'processing', 'default__0000119__r2', 'product.json'),
      path.join(runtimeRoot, 'processing', '2466679__0000119__r2', 'product.json')
    ]);
    expect(new Set(result.items.map((item) => item.payload.productJsonPath)).size).toBe(2);
  });

  it('fails closed if a repository projection drops top-level revision', async () => {
    const invalid: Partial<typeof claimedJob> = { ...claimedJob };
    delete invalid.revision;
    const repository = {
      getSettings: vi.fn(async () => ({ rootDirectory: runtimeRoot })),
      claimRuntimeJobs: vi.fn(async () => [invalid])
    };
    const service = new OzonStoreService(repository as any, {} as any, {} as any, {} as any);
    await expect(service.claimRuntimeJobs({ leaseOwner: 'ozon-p002:test' })).rejects.toMatchObject({ name: 'ZodError' });
  });

  it('fails closed when the authoritative workRelPath attempts traversal', async () => {
    const repository = {
      getSettings: vi.fn(async () => ({ rootDirectory: runtimeRoot })),
      claimRuntimeJobs: vi.fn(async () => [{ ...claimedJob, workRelPath: 'processing/../default__0000119__r2' }])
    };
    const service = new OzonStoreService(repository as any, {} as any, {} as any, {} as any);
    await expect(service.claimRuntimeJobs({ leaseOwner: 'ozon-p002:test' })).rejects.toMatchObject({
      code: 'PATH_TRAVERSAL_BLOCKED', statusCode: 409
    });
  });

  it('fails closed before returning claimed work when the configured root is not absolute', async () => {
    const repository = {
      getSettings: vi.fn(async () => ({ rootDirectory: 'relative/ozon-root' })),
      claimRuntimeJobs: vi.fn(async () => [claimedJob])
    };
    const service = new OzonStoreService(repository as any, {} as any, {} as any, {} as any);
    await expect(service.claimRuntimeJobs({ leaseOwner: 'ozon-p002:test' })).rejects.toMatchObject({
      code: 'CONFIG_INVALID', statusCode: 409
    });
    expect(repository.claimRuntimeJobs).not.toHaveBeenCalled();
  });

  it('rejects a cross-store workRelPath even when it remains inside the OZON root', async () => {
    const repository = {
      getSettings: vi.fn(async () => ({ rootDirectory: runtimeRoot })),
      claimRuntimeJobs: vi.fn(async () => [{
        ...claimedJob,
        workRelPath: 'stores/other-store/processing/0000119__r2'
      }])
    };
    const service = new OzonStoreService(repository as any, {} as any, {} as any, {} as any);
    await expect(service.claimRuntimeJobs({ leaseOwner: 'ozon-p002:test' })).rejects.toMatchObject({
      code: 'VERSION_CONFLICT', statusCode: 409
    });
  });
});

describe('OZON automatic frozen listing snapshot contract', () => {
  it('returns the generated listing and store-account prices only after verifying the full artifact chain', async () => {
    const fixture = await automaticSnapshotFixture();
    const repository = {
      getSettings: vi.fn(async () => ({ rootDirectory: fixture.root })),
      getAutomaticListingSnapshotContext: vi.fn(async () => fixture.context)
    };
    const service = new OzonStoreService(repository as any, {} as any, {} as any, {} as any);

    const result = await service.automaticListingSnapshot(fixture.context.job.id, fixture.context.job.storeId);
    expect(result).toMatchObject({
      mode: 'AUTO_TASK_SNAPSHOT',
      readOnly: true,
      jobId: fixture.context.job.id,
      generatedVersionId: fixture.context.generatedVersionId,
      store: {
        id: fixture.context.job.storeId,
        accountCurrency: 'CNY',
        currentAccountCurrency: 'RUB',
        accountCurrencyChanged: true
      },
      listing: {
        generatedVersionId: fixture.context.generatedVersionId,
        data: { mediaSourceRoot: '' }
      },
      pricing: {
        currency: 'CNY',
        offers: [{ offerId: '0000119-01', price: 388.3, oldPrice: 776.6, minPrice: 194.15 }]
      }
    });
    expect(result.listing.data.offers.map((offer) => offer.offerId)).toEqual(['0000119-01']);
    expect(result.pricing.currency).toBe(result.store.accountCurrency);
  });

  it('keeps same-SKU CNY and RUB task snapshots isolated by immutable store identity', async () => {
    const cny = await automaticSnapshotFixture();
    const rub = await automaticSnapshotFixture({
      currency: 'RUB',
      currentAccountCurrency: 'RUB',
      storeId: '70000000-0000-4000-8000-000000000042',
      storeAlias: 'rub-store',
      displayName: 'RUB Store',
      idSuffix: 42
    });
    const cnyService = new OzonStoreService({
      getSettings: vi.fn(async () => ({ rootDirectory: cny.root })),
      getAutomaticListingSnapshotContext: vi.fn(async () => cny.context)
    } as any, {} as any, {} as any, {} as any);
    const rubService = new OzonStoreService({
      getSettings: vi.fn(async () => ({ rootDirectory: rub.root })),
      getAutomaticListingSnapshotContext: vi.fn(async () => rub.context)
    } as any, {} as any, {} as any, {} as any);

    const [cnyResult, rubResult] = await Promise.all([
      cnyService.automaticListingSnapshot(cny.context.job.id, cny.context.job.storeId),
      rubService.automaticListingSnapshot(rub.context.job.id, rub.context.job.storeId)
    ]);
    expect(cnyResult).toMatchObject({ sku: '0000119', store: { storeAlias: 'default' }, pricing: { currency: 'CNY' } });
    expect(rubResult).toMatchObject({ sku: '0000119', store: {
      storeAlias: 'rub-store', accountCurrency: 'RUB', accountCurrencyChanged: false
    }, pricing: { currency: 'RUB' } });
    await expect(cnyService.automaticListingSnapshot(cny.context.job.id, rub.context.job.storeId)).rejects.toMatchObject({
      code: 'NOT_FOUND', statusCode: 404
    });
  });

  it('re-reads job location exactly once when P002 moves the package between lifecycle directories', async () => {
    const fixture = await automaticSnapshotFixture();
    const moved = structuredClone(fixture.context);
    moved.job.directoryStage = 'SUCCESS';
    moved.job.workRelPath = 'success/2026-08-13/default__0000119__r4';
    const movedDirectory = path.join(fixture.root, ...moved.job.workRelPath.split('/'));
    await mkdir(path.dirname(movedDirectory), { recursive: true });
    await rename(fixture.workDirectory, movedDirectory);
    const repository = {
      getSettings: vi.fn(async () => ({ rootDirectory: fixture.root })),
      getAutomaticListingSnapshotContext: vi.fn()
        .mockResolvedValueOnce(fixture.context)
        .mockResolvedValueOnce(moved)
    };
    const service = new OzonStoreService(repository as any, {} as any, {} as any, {} as any);

    await expect(service.automaticListingSnapshot(moved.job.id, moved.job.storeId))
      .resolves.toMatchObject({ pricing: { currency: 'CNY' } });
    expect(repository.getAutomaticListingSnapshotContext).toHaveBeenCalledTimes(2);
  });

  it('returns stable no-fallback 409 evidence when the artifact remains absent', async () => {
    const fixture = await automaticSnapshotFixture();
    await rm(fixture.workDirectory, { recursive: true, force: true });
    const repository = {
      getSettings: vi.fn(async () => ({ rootDirectory: fixture.root })),
      getAutomaticListingSnapshotContext: vi.fn(async () => fixture.context)
    };
    const service = new OzonStoreService(repository as any, {} as any, {} as any, {} as any);

    await expect(service.automaticListingSnapshot(fixture.context.job.id, fixture.context.job.storeId)).rejects.toMatchObject({
      code: 'OZON_FROZEN_ARTIFACT_UNAVAILABLE',
      statusCode: 409,
      details: { noFallback: true }
    });
    expect(repository.getAutomaticListingSnapshotContext).toHaveBeenCalledTimes(2);
  });

  it('fails closed when the signed intake identity drifts instead of relabeling product prices', async () => {
    const fixture = await automaticSnapshotFixture();
    const intakePath = path.join(fixture.workDirectory, '.ozon-intake.json');
    const intake = JSON.parse(await readFile(intakePath, 'utf8')) as Record<string, unknown>;
    intake.storeId = '99999999-9999-4999-8999-999999999999';
    await writeFile(intakePath, `${JSON.stringify(intake, null, 2)}\n`);
    const service = new OzonStoreService({
      getSettings: vi.fn(async () => ({ rootDirectory: fixture.root })),
      getAutomaticListingSnapshotContext: vi.fn(async () => fixture.context)
    } as any, {} as any, {} as any, {} as any);

    await expect(service.automaticListingSnapshot(fixture.context.job.id, fixture.context.job.storeId)).rejects.toMatchObject({
      code: 'VERSION_CONFLICT',
      statusCode: 409,
      details: { noFallback: true, mismatches: expect.arrayContaining(['.ozon-intake.json']) }
    });
  });

  it.each(['READY_MARKER', 'PRODUCT_BYTES'] as const)('fails closed on %s drift', async (kind) => {
    const fixture = await automaticSnapshotFixture({ idSuffix: kind === 'READY_MARKER' ? 43 : 44 });
    if (kind === 'READY_MARKER') {
      const markerPath = path.join(fixture.workDirectory, '_READY');
      const marker = JSON.parse(await readFile(markerPath, 'utf8')) as Record<string, unknown>;
      marker.taskId = 'default__0000119__r999';
      await writeFile(markerPath, `${JSON.stringify(marker, null, 2)}\n`);
    } else {
      const productPath = path.join(fixture.workDirectory, 'product.json');
      await writeFile(productPath, `${await readFile(productPath, 'utf8')} `);
    }
    const service = new OzonStoreService({
      getSettings: vi.fn(async () => ({ rootDirectory: fixture.root })),
      getAutomaticListingSnapshotContext: vi.fn(async () => fixture.context)
    } as any, {} as any, {} as any, {} as any);

    await expect(service.automaticListingSnapshot(fixture.context.job.id, fixture.context.job.storeId)).rejects.toMatchObject({
      code: 'VERSION_CONFLICT', statusCode: 409, details: { noFallback: true }
    });
  });
});

describe('OZON imported product price-floor recovery artifact contract', () => {
  it('verifies the frozen processing product bytes before applying a publication-scoped recovery', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'ozon-import-price-floor-recovery-'));
    temporaryRoots.push(root);
    const workRelPath = 'processing/default__0000119__r4';
    const workDirectory = path.join(root, ...workRelPath.split('/'));
    await mkdir(workDirectory, { recursive: true });
    const product = importPriceFloorProductFixture();
    const raw = Buffer.from(`${JSON.stringify(product, null, 2)}\n`, 'utf8');
    await writeFile(path.join(workDirectory, 'product.json'), raw);
    const checks = {
      storeId: OZON_DEFAULT_STORE_ID,
      storeAlias: 'default',
      sku: '0000119',
      revision: 4,
      taskId: 'default__0000119__r4',
      importTaskId: '5379996545',
      offerIds: ['0000119-01'],
      productIds: ['5913618188'],
      workRelPath,
      directorySignature: `sha256:${createHash('sha256').update(raw).digest('hex')}`,
      importProductCount: 1,
      importInfoCount: 1,
      pricesWriteCount: 0,
      stocksWriteCount: 0
    };
    const publication = { id: '3de7dc25-ddc3-4346-ab2a-be90eca8731d', rowVersion: 6 };
    const recoverImportPriceFloorFailure = vi.fn(async (_publicationId, input) => ({
      status: input.dryRun ? 'DRY_RUN' : 'RECOVERED',
      dryRun: input.dryRun,
      publication,
      jobId: '3fa8fa6b-e7b6-4d9f-9887-6561b57d854a',
      jobRowVersion: input.dryRun ? 6 : 7,
      checks
    }));
    const repository = {
      getSettings: vi.fn(async () => ({ rootDirectory: root })),
      recoverImportPriceFloorFailure
    };
    const service = new OzonStoreService(repository as any, {} as any, {} as any, {} as any);
    const result = await service.recoverImportPriceFloorFailure(publication.id, {
      publicationRowVersion: 6,
      jobRowVersion: 6,
      dryRun: false
    });
    expect(result).toMatchObject({ status: 'RECOVERED', dryRun: false, jobRowVersion: 7 });
    expect(recoverImportPriceFloorFailure).toHaveBeenNthCalledWith(1, publication.id, {
      publicationRowVersion: 6, jobRowVersion: 6, dryRun: true
    });
    expect(recoverImportPriceFloorFailure).toHaveBeenNthCalledWith(2, publication.id, {
      publicationRowVersion: 6, jobRowVersion: 6, dryRun: false
    });
  });

  it('fails before mutation when processing product bytes no longer match the frozen signature', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'ozon-import-price-floor-tamper-'));
    temporaryRoots.push(root);
    const workRelPath = 'processing/default__0000119__r4';
    const workDirectory = path.join(root, ...workRelPath.split('/'));
    await mkdir(workDirectory, { recursive: true });
    await writeFile(path.join(workDirectory, 'product.json'), `${JSON.stringify(importPriceFloorProductFixture())}\n`);
    const recoverImportPriceFloorFailure = vi.fn(async () => ({
      status: 'DRY_RUN', dryRun: true, publication: { id: 'publication-1' }, jobId: 'job-1', jobRowVersion: 6,
      checks: {
        storeId: OZON_DEFAULT_STORE_ID, storeAlias: 'default', sku: '0000119', revision: 4,
        taskId: 'default__0000119__r4', importTaskId: '5379996545', offerIds: ['0000119-01'],
        productIds: ['5913618188'], workRelPath, directorySignature: `sha256:${'0'.repeat(64)}`,
        importProductCount: 1, importInfoCount: 1, pricesWriteCount: 0, stocksWriteCount: 0
      }
    }));
    const service = new OzonStoreService({
      getSettings: vi.fn(async () => ({ rootDirectory: root })), recoverImportPriceFloorFailure
    } as any, {} as any, {} as any, {} as any);
    await expect(service.recoverImportPriceFloorFailure('publication-1', {
      publicationRowVersion: 6, jobRowVersion: 6, dryRun: false
    })).rejects.toMatchObject({ code: 'VERSION_CONFLICT' });
    expect(recoverImportPriceFloorFailure).toHaveBeenCalledTimes(1);
  });
});

describe('OZON imported no-brand recovery artifact contract', () => {
  it('validates the frozen processing artifact before applying the one-shot correction', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'ozon-import-no-brand-'));
    temporaryRoots.push(root);
    const workRelPath = 'processing/2466679__0000119__r4';
    const workDirectory = path.join(root, ...workRelPath.split('/'));
    await mkdir(workDirectory, { recursive: true });
    const product = importPriceFloorProductFixture();
    product.brand = 'Нет бренда';
    product.sharedAttributes = [{ attributeId: 85, complexId: 0, values: [{ value: '无品牌' }] }];
    const raw = Buffer.from(`${JSON.stringify(product, null, 2)}\n`, 'utf8');
    await writeFile(path.join(workDirectory, 'product.json'), raw);
    const checks = {
      storeId: '7d15ba0c-9270-4dd8-bf43-55457670f290', storeAlias: '2466679', sku: '0000119', revision: 4,
      taskId: '2466679__0000119__r4', importTaskId: '5389881966', offerIds: ['0000119-01'],
      productIds: ['5929063200'], workRelPath,
      directorySignature: `sha256:${createHash('sha256').update(raw).digest('hex')}`,
      importProductCount: 1, importInfoCount: 1, pricesWriteCount: 0, stocksWriteCount: 0
    };
    const publication = { id: '576ad31b-486b-4e58-ba7e-9180606ca54f', rowVersion: 6 };
    const recoverImportNoBrandFailure = vi.fn(async (_publicationId, input) => ({
      status: input.dryRun ? 'DRY_RUN' : 'RECOVERED', dryRun: input.dryRun, publication,
      jobId: 'e5918dee-73ae-4b93-a617-f1e442c2463a', jobRowVersion: input.dryRun ? 6 : 7, checks
    }));
    const service = new OzonStoreService({
      getSettings: vi.fn(async () => ({ rootDirectory: root })), recoverImportNoBrandFailure
    } as any, {} as any, {} as any, {} as any);

    await expect(service.recoverImportNoBrandFailure(publication.id, {
      publicationRowVersion: 6, jobRowVersion: 6, dryRun: false
    })).resolves.toMatchObject({ status: 'RECOVERED', jobRowVersion: 7 });
    expect(recoverImportNoBrandFailure).toHaveBeenCalledTimes(2);
  });

  it('rejects a real brand instead of silently converting it', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'ozon-import-real-brand-'));
    temporaryRoots.push(root);
    const workRelPath = 'processing/2466679__0000119__r4';
    const workDirectory = path.join(root, ...workRelPath.split('/'));
    await mkdir(workDirectory, { recursive: true });
    const product = importPriceFloorProductFixture();
    product.brand = 'MerchRoute';
    product.sharedAttributes = [{ attributeId: 85, complexId: 0, values: [{ value: 'MerchRoute' }] }];
    const raw = Buffer.from(`${JSON.stringify(product, null, 2)}\n`, 'utf8');
    await writeFile(path.join(workDirectory, 'product.json'), raw);
    const recoverImportNoBrandFailure = vi.fn(async () => ({
      status: 'DRY_RUN', dryRun: true, publication: { id: 'publication-1' }, jobId: 'job-1', jobRowVersion: 6,
      checks: {
        storeId: '7d15ba0c-9270-4dd8-bf43-55457670f290', storeAlias: '2466679', sku: '0000119', revision: 4,
        taskId: '2466679__0000119__r4', importTaskId: '5389881966', offerIds: ['0000119-01'],
        productIds: ['5929063200'], workRelPath,
        directorySignature: `sha256:${createHash('sha256').update(raw).digest('hex')}`,
        importProductCount: 1, importInfoCount: 1, pricesWriteCount: 0, stocksWriteCount: 0
      }
    }));
    const service = new OzonStoreService({
      getSettings: vi.fn(async () => ({ rootDirectory: root })), recoverImportNoBrandFailure
    } as any, {} as any, {} as any, {} as any);
    await expect(service.recoverImportNoBrandFailure('publication-1', {
      publicationRowVersion: 6, jobRowVersion: 6, dryRun: false
    })).rejects.toMatchObject({ code: 'VERSION_CONFLICT' });
    expect(recoverImportNoBrandFailure).toHaveBeenCalledTimes(1);
  });
});

describe('OZON multistore material contracts', () => {
  it('removes unproven RUB price fields before applying a CNY store preset while preserving stock and attributes', () => {
    const legacy = sanitizeLegacyCrossCurrencyPriceOverrides({
      currency: 'RUB',
      offers: [{ offerId: '0000119-01', price: 4271.29, oldPrice: 8542.58, minPrice: 2135.64 }]
    }, {
      offerOverrides: [{
        offerId: '0000119-01', price: 4271.29, oldPrice: 8542.58, minPrice: 2135.64,
        stock: 1, attributes: [{ id: 85, values: [{ dictionaryValueId: 126745801 }] }]
      }]
    }, { currency: 'CNY' });
    expect(legacy).toEqual({
      changed: true,
      overrides: {
        offerOverrides: [{
          offerId: '0000119-01', stock: 1,
          attributes: [{ id: 85, values: [{ dictionaryValueId: 126745801 }] }]
        }]
      }
    });

    const derived = deriveExplicitPriceOverrides({
      currency: 'RUB', offers: [{ offerId: '0000119-01', price: 4271.29, oldPrice: 8542.58, minPrice: 2135.64 }]
    }, legacy.overrides, { currency: 'CNY', price: 388.3, oldPrice: 776.6, minPrice: 194.15 });
    expect(derived).toEqual(legacy.overrides);
    expect(materializeOfferForStore(
      { offerId: '0000119-01', price: 4271.29, oldPrice: 8542.58, minPrice: 2135.64, stock: 0 },
      { currency: 'CNY', price: 388.3, oldPrice: 776.6, minPrice: 194.15 },
      1,
      (legacy.overrides.offerOverrides as Record<string, unknown>[])[0]!,
      'CNY'
    )).toEqual({
      offerId: '0000119-01', price: 388.3, oldPrice: 776.6, minPrice: 194.15, stock: 1,
      attributes: [{ id: 85, values: [{ dictionaryValueId: 126745801 }] }]
    });
  });

  it('requires price overrides to prove the same currency as the target store', () => {
    const cnyOverride = {
      offerId: '0000119-01', priceCurrency: 'CNY', price: 399, oldPrice: 799, minPrice: 199, stock: 1
    };
    expect(materialPriceOverrideBlockers({ offerOverrides: [cnyOverride] }, 'CNY')).toEqual([]);
    expect(materializeOfferForStore(
      { offerId: '0000119-01' },
      { currency: 'CNY', price: 388.3, oldPrice: 776.6, minPrice: 194.15 },
      1,
      cnyOverride,
      'CNY'
    )).toMatchObject({ price: 399, oldPrice: 799, minPrice: 199, stock: 1 });

    const rubOverride = { ...cnyOverride, priceCurrency: 'RUB' };
    expect(materialPriceOverrideBlockers({ offerOverrides: [rubOverride] }, 'CNY')).toEqual([
      'Offer 0000119-01 的价格覆盖币种 RUB 与店铺币种 CNY 不一致'
    ]);
    expect(materializeOfferForStore(
      { offerId: '0000119-01' },
      { currency: 'CNY', price: 388.3, oldPrice: 776.6, minPrice: 194.15 },
      1,
      rubOverride,
      'CNY'
    )).toMatchObject({ price: 388.3, oldPrice: 776.6, minPrice: 194.15, stock: 1 });
  });

  it('records currency proof when deriving a same-currency user price override', () => {
    expect(deriveExplicitPriceOverrides({
      currency: 'CNY', offers: [{ offerId: '0000119-01', price: 399, oldPrice: 799, minPrice: 199 }]
    }, {}, { currency: 'CNY', price: 388.3, oldPrice: 776.6, minPrice: 194.15 })).toEqual({
      offerOverrides: [{
        offerId: '0000119-01', price: 399, oldPrice: 799, minPrice: 199, priceCurrency: 'CNY'
      }]
    });
  });

  it('excludes compatibility-only store fields from the stable preset material', () => {
    const first = stablePresetMaterial({
      vat: '0.2', dimensions: { width: 10, capturedAt: 'old' },
      warehouseId: 'warehouse-a', currency: 'RUB', fulfillmentMode: 'FBS',
      autoPublishEnabled: false, autoPublishMode: 'CREATE_ONLY', isDefault: true,
      capturedAt: '2026-08-01T00:00:00.000Z'
    });
    const second = stablePresetMaterial({
      vat: '0.2', dimensions: { width: 10, capturedAt: 'new' },
      warehouseId: 'warehouse-b', currency: 'CNY', fulfillmentMode: 'RFBS',
      autoPublishEnabled: true, autoPublishMode: 'COMPATIBLE_UPSERT', isDefault: false,
      capturedAt: '2026-08-11T00:00:00.000Z'
    });
    expect(second).toEqual(first);
    expect(stablePresetMaterial({ vat: '0.1' })).not.toEqual(first);
  });

  it('keeps the shared source neutral and injects warehouse/currency only for each store materialization', () => {
    expect(OZON_SHARED_SOURCE_STORE_FIELDS).toEqual({
      storeAlias: '__STORE_SCOPED__', fulfillmentMode: 'FBS', warehouseId: '__STORE_SCOPED__', accountCurrency: 'RUB'
    });
    const shared = { storeAlias: '__STORE_SCOPED__', warehouseId: '__STORE_SCOPED__', fulfillmentMode: 'FBS', currency: 'RUB' };
    const settings = { imageUploadConcurrency: 7, videoUploadConcurrency: 2, videoPrewarmEnabled: false };
    const storeA = applyOzonStoreScopedProductFields(shared, {
      storeAlias: 'store-a', warehouseId: '101', fulfillmentMode: 'FBS', accountCurrency: 'RUB'
    }, settings);
    const storeB = applyOzonStoreScopedProductFields(shared, {
      storeAlias: 'store-b', warehouseId: '202', fulfillmentMode: 'RFBS', accountCurrency: 'CNY'
    }, settings);
    expect(storeA).toMatchObject({ storeAlias: 'store-a', warehouseId: '101', fulfillmentMode: 'FBS', currency: 'RUB' });
    expect(storeB).toMatchObject({ storeAlias: 'store-b', warehouseId: '202', fulfillmentMode: 'RFBS', currency: 'CNY' });
    expect(shared).toEqual({ storeAlias: '__STORE_SCOPED__', warehouseId: '__STORE_SCOPED__', fulfillmentMode: 'FBS', currency: 'RUB' });
  });

  it('canonicalizes a persisted no-brand text override after store materialization', () => {
    const source = importPriceFloorProductFixture();
    source.sharedAttributes = [{ attributeId: 85, complexId: 0, values: [{ dictionaryValueId: 126745801 }] }];
    const product = materializeProduct(source as any, {
      storeAlias: '2466679', warehouseId: '1020002357565000', fulfillmentMode: 'FBS', accountCurrency: 'CNY',
      presetSnapshot: { sharedAttributes: [{ attributeId: 85, complexId: 0, values: [{ dictionaryValueId: 126745801 }] }] }
    } as any, {
      imageUploadConcurrency: 4, videoUploadConcurrency: 1, videoPrewarmEnabled: false
    } as any, ['0000119-01'], {
      sharedAttributes: [{ attributeId: 85, complexId: 0, values: [{ value: '无品牌' }] }]
    }, { currency: 'CNY', price: 388.3, oldPrice: 776.6, minPrice: 194.15 });

    expect(product.sharedAttributes).toEqual([
      { attributeId: 85, complexId: 0, values: [{ dictionaryValueId: 126745801 }] }
    ]);
  });

  it('preserves a real brand value during store materialization', () => {
    const source = importPriceFloorProductFixture();
    source.sharedAttributes = [{ attributeId: 85, complexId: 0, values: [{ value: 'MerchRoute' }] }];
    const product = materializeProduct(source as any, {
      storeAlias: '2466679', warehouseId: '1020002357565000', fulfillmentMode: 'FBS', accountCurrency: 'CNY',
      presetSnapshot: {}
    } as any, {
      imageUploadConcurrency: 4, videoUploadConcurrency: 1, videoPrewarmEnabled: false
    } as any, ['0000119-01'], {}, { currency: 'CNY', price: 388.3, oldPrice: 776.6, minPrice: 194.15 });

    expect(product.sharedAttributes).toEqual([
      { attributeId: 85, complexId: 0, values: [{ value: 'MerchRoute' }] }
    ]);
  });

  it('excludes an authoring-machine media root from portable material hashes', () => {
    const windows = stableMaterial({
      productCode: '9900002', mediaSourceRoot: 'F:\\OZON\\shared\\9900002',
      mediaAssets: [{ relativePath: 'images/01.jpg', sha256: 'abc' }]
    });
    const mac = stableMaterial({
      productCode: '9900002', mediaSourceRoot: '/Volumes/OZON/shared/9900002',
      mediaAssets: [{ relativePath: 'images/01.jpg', sha256: 'abc' }]
    });
    expect(mac).toEqual(windows);
    expect(JSON.stringify(mac)).not.toContain('/Volumes/OZON');
  });

  it('builds the S000 _READY identity with the exact product byte signature', () => {
    const marker = buildOzonStoreReadyMarker({
      jobId: '55555555-5555-4555-8555-555555555555', taskId: 'default__9900002__r1',
      sku: '9900002', revision: 1, productContentHash: `sha256:${'3'.repeat(64)}`
    });
    expect(marker).toEqual({
      schemaVersion: 1, jobId: '55555555-5555-4555-8555-555555555555',
      taskId: 'default__9900002__r1', sku: '9900002', revision: 1,
      signature: `sha256:${'3'.repeat(64)}`
    });
  });

  it('derives intake tickets from the credential encryption key, not the n8n-visible runtime key', () => {
    const credentialKey = Buffer.alloc(32, 7).toString('base64');
    const runtimeKeyPretendingToBeSecret = Buffer.alloc(32, 8).toString('base64');
    const payload = { jobId: 'job', productContentHash: `sha256:${'1'.repeat(64)}` };
    const valid = signIntakeTicket(payload, credentialKey);
    const forgedByRuntimeKey = signIntakeTicket(payload, runtimeKeyPretendingToBeSecret);
    expect(valid).toMatch(/^hmac-sha256:[a-f0-9]{64}$/);
    expect(forgedByRuntimeKey).not.toBe(valid);
    expect(() => signIntakeTicket(payload, 'runtime-key-visible-to-n8n'))
      .toThrowError(/MERCHROUTE_CREDENTIAL_ENCRYPTION_KEY/);
  });

  it('round-trips the signed marker identity and rejects a runtime-key forgery before DB verification', async () => {
    const credentialKey = Buffer.alloc(32, 7).toString('base64');
    const runtimeKey = Buffer.alloc(32, 8).toString('base64');
    process.env.MERCHROUTE_CREDENTIAL_ENCRYPTION_KEY = credentialKey;
    const signed = {
      schemaVersion: 1, jobId: '55555555-5555-4555-8555-555555555555', taskId: 'default__9900002__r1',
      storeId: OZON_DEFAULT_STORE_ID, storeAlias: 'default',
      publicationId: '10000000-0000-4000-8000-000000000001',
      credentialVersionId: '20000000-0000-4000-8000-000000000001', credentialBindingMode: 'VAULT',
      storeConfigVersion: 1, warehouseId: '123', sku: '9900002', revision: 1,
      planHash: `sha256:${'4'.repeat(64)}`,
      contentPolicyVersion: 'merchroute-ozon-content-v3',
      materialHash: `sha256:${'5'.repeat(64)}`,
      materialHashVersion: 'ozon-shared-material-v1',
      presetRowVersion: 1,
      publicationMode: 'CREATE_ONLY',
      materializationHash: `sha256:${'2'.repeat(64)}`, offerContractHash: `sha256:${'1'.repeat(64)}`,
      productContentHash: `sha256:${'3'.repeat(64)}`
    } as const;
    const runtimeFields = {
      rowVersion: 2, leaseToken: '00000000-0000-4000-8000-000000000091'
    };
    const { schemaVersion, ...verifyBody } = signed;
    expect(schemaVersion).toBe(1);
    const repository = { verifyIntake: vi.fn(async () => ({ jobId: signed.jobId, storeId: signed.storeId })) };
    const service = new OzonStoreService(repository as any, {} as any, {} as any, {} as any);
    await expect(service.verifyIntake({ ...verifyBody, ...runtimeFields, ticket: signIntakeTicket(signed, credentialKey) }))
      .resolves.toMatchObject({ verified: true, identity: { jobId: signed.jobId, storeId: signed.storeId } });
    expect(repository.verifyIntake).toHaveBeenCalledOnce();
    await expect(service.verifyIntake({ ...verifyBody, ...runtimeFields, ticket: signIntakeTicket(signed, runtimeKey) }))
      .rejects.toMatchObject({ code: 'AUTH_INVALID', statusCode: 401 });
    expect(repository.verifyIntake).toHaveBeenCalledOnce();
  });

  it('uses the generated listing snapshot when a fresh SKU has no legacy inbox product.json', async () => {
    process.env.MERCHROUTE_CREDENTIAL_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');
    const root = await mkdtemp(path.join(os.tmpdir(), 'ozon-shared-source-'));
    temporaryRoots.push(root);
    const source = path.join(root, 'source-media');
    await mkdir(source);
    const buildFresh = vi.fn(async () => ({
      // Deliberately incomplete: the assertion is that the fresh builder is
      // reached instead of throwing ENOENT for root/inbox/<sku>/product.json.
      product: { schemaVersion: 2, productCode: '9900002', revision: 1, offers: [{ offerId: '9900002-01' }] },
      sourceDirectory: source
    }));
    await expect(prepareSharedSource(root, {
      sku: '9900002', draftVersion: 1, generatedVersionId: '30000000-0000-4000-8000-000000000001',
      revision: 1, listingStatus: 'READY', listingSnapshot: {}, materialOverrides: {},
      offerIds: ['9900002-01'], stores: []
    }, buildFresh)).rejects.toMatchObject({ message: 'OZON 共享源 product.json 无效' });
    expect(buildFresh).toHaveBeenCalledOnce();
  });

  it('rejects a tampered generated-version product instead of signing it as a new store package', async () => {
    process.env.MERCHROUTE_CREDENTIAL_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');
    const root = await mkdtemp(path.join(os.tmpdir(), 'ozon-shared-integrity-'));
    temporaryRoots.push(root);
    const source = path.join(root, 'source-media');
    await mkdir(source);
    await writeFile(path.join(source, 'image.jpg'), 'image-bytes');
    await writeFile(path.join(source, 'video.mp4'), 'video-bytes');
    const context = {
      sku: '9900002', draftVersion: 1, generatedVersionId: '30000000-0000-4000-8000-000000000001',
      revision: 1, listingStatus: 'READY', listingSnapshot: {}, materialOverrides: {},
      offerIds: ['9900002-01'], stores: []
    };
    const buildFresh = vi.fn(async () => ({
      product: {
        schemaVersion: 1,
        storeAlias: '__STORE_SCOPED__',
        productCode: '9900002',
        productName: 'Test product',
        revision: 1,
        fulfillmentMode: 'FBS',
        warehouseId: '__STORE_SCOPED__',
        category: {
          categoryKey: 'test-category', descriptionCategoryId: 1, typeId: 1,
          templateVersion: 1, schemaHash: `sha256:${'a'.repeat(64)}`
        },
        currency: 'RUB', vat: '0.2', titleRu: 'Тестовый товар', descriptionRu: 'Описание товара',
        brand: 'Нет бренда',
        dimensions: { length: 1, width: 1, height: 1, dimensionUnit: 'cm', weight: 1, weightUnit: 'g' },
        sharedAttributes: [], mediaCapabilities: {}, mediaSourceRoot: '',
        offers: [{
          variantId: '40000000-0000-4000-8000-000000000001', variantCode: '01', offerId: '9900002-01',
          price: 100, stock: 1,
          media: [
            { assetId: 'image', relativePath: 'image.jpg', kind: 'image', sortOrder: 0, isPrimary: true },
            { assetId: 'video', relativePath: 'video.mp4', kind: 'video', sortOrder: 1, isPrimary: false }
          ]
        }]
      },
      sourceDirectory: source
    }));
    await expect(prepareSharedSource(root, context, buildFresh)).resolves.toMatchObject({ productCode: '9900002' });
    const productPath = path.join(root, 'shared', context.sku, context.generatedVersionId, 'product.json');
    const markerPath = path.join(root, 'shared', context.sku, context.generatedVersionId, '.ozon-shared-source.json');
    const tampered = JSON.parse(await readFile(productPath, 'utf8'));
    tampered.mediaSourceRoot = 'tampered-after-generation';
    const tamperedBytes = `${JSON.stringify(tampered, null, 2)}\n`;
    await writeFile(productPath, tamperedBytes, 'utf8');
    const forgedMarker = JSON.parse(await readFile(markerPath, 'utf8'));
    forgedMarker.productContentHash = `sha256:${createHash('sha256').update(tamperedBytes).digest('hex')}`;
    const signedFields = { ...forgedMarker };
    delete signedFields.integritySignature;
    forgedMarker.integritySignature = signSharedSourceMarker(
      signedFields,
      Buffer.alloc(32, 8).toString('base64')
    );
    await writeFile(markerPath, `${JSON.stringify(forgedMarker, null, 2)}\n`, 'utf8');
    await expect(prepareSharedSource(root, context, buildFresh))
      .rejects.toMatchObject({ code: 'VERSION_CONFLICT', statusCode: 409 });
    expect(buildFresh).toHaveBeenCalledOnce();
  });

  it('rejects a generated-version directory symlink that escapes the shared SKU root', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'ozon-shared-link-root-'));
    const outside = await mkdtemp(path.join(os.tmpdir(), 'ozon-shared-link-outside-'));
    temporaryRoots.push(root, outside);
    const context = {
      sku: '9900002', draftVersion: 1, generatedVersionId: '30000000-0000-4000-8000-000000000001',
      revision: 1, listingStatus: 'READY', listingSnapshot: {}, materialOverrides: {},
      offerIds: ['9900002-01'], stores: []
    };
    const skuRoot = path.join(root, 'shared', context.sku);
    await mkdir(skuRoot, { recursive: true });
    await symlink(outside, path.join(skuRoot, context.generatedVersionId), process.platform === 'win32' ? 'junction' : 'dir');
    const buildFresh = vi.fn();
    await expect(prepareSharedSource(root, context, buildFresh))
      .rejects.toMatchObject({ code: 'PATH_TRAVERSAL_BLOCKED', statusCode: 409 });
    expect(buildFresh).not.toHaveBeenCalled();
  });
});

describe('OZON publication operation semantics', () => {
  it('applies CREATE_ONLY and COMPATIBLE_UPSERT independently for automatic store publications', async () => {
    const createOnlyStoreId = OZON_DEFAULT_STORE_ID;
    const compatibleStoreId = '7d15ba0c-9270-4dd8-bf43-55457670f290';
    const product = importPriceFloorProductFixture();
    const retainedOffer = product.offers[0]!;
    const newOffer = {
      ...structuredClone(retainedOffer),
      variantId: '22222222-2222-4222-8222-222222222222',
      variantCode: '02',
      offerId: '0000119-02'
    };
    const repository = {
      getSuccessfulOfferUnion: vi.fn(async (storeId: string) => storeId === createOnlyStoreId
        ? ['0000119-01']
        : ['0000119-01'])
    };
    const service = new OzonStoreService(repository as any, {} as any, {} as any, {} as any);
    const built = {
      context: {
        stores: [
          { id: createOnlyStoreId, autoPublishMode: 'CREATE_ONLY' },
          { id: compatibleStoreId, autoPublishMode: 'COMPATIBLE_UPSERT' }
        ]
      },
      productByStore: new Map([
        [createOnlyStoreId, structuredClone(product)],
        [compatibleStoreId, { ...structuredClone(product), offers: [structuredClone(retainedOffer), newOffer] }]
      ]),
      modeEvidenceByStore: new Map(),
      plan: {
        planHash: `sha256:${'a'.repeat(64)}`,
        variantColorAuthority: { hash: `sha256:${'b'.repeat(64)}` },
        sku: '0000119',
        draftVersion: 4,
        generatedVersionId: '30000000-0000-4000-8000-000000000001',
        revision: 4,
        createdAt: '2026-08-13T00:00:00.000Z',
        items: [
          {
            storeId: createOnlyStoreId, storeAlias: 'tek', ready: true, blockers: [],
            offerIds: ['0000119-01'], offerContractHash: `sha256:${'1'.repeat(64)}`,
            materializationHash: `sha256:${'2'.repeat(64)}`, storeConfigVersion: 1
          },
          {
            storeId: compatibleStoreId, storeAlias: 'glauke', ready: true, blockers: [],
            offerIds: ['0000119-01', '0000119-02'], offerContractHash: `sha256:${'3'.repeat(64)}`,
            materializationHash: `sha256:${'4'.repeat(64)}`, storeConfigVersion: 1
          }
        ]
      }
    };
    await (service as any).applyPublicationModes(built);
    const materialized = built;
    expect(materialized.plan.items[0]).toMatchObject({
      ready: false,
      blockers: [expect.stringContaining('仅创建模式')]
    });
    expect(materialized.plan.items[1]).toMatchObject({ ready: true, offerIds: ['0000119-02'] });
    expect(materialized.productByStore.get(compatibleStoreId).offers).toHaveLength(1);
    expect(materialized.productByStore.get(compatibleStoreId).offers[0].offerId).toBe('0000119-02');
  });

  it('materializes one shared draft independently with each store preset', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'ozon-store-preset-materialization-'));
    temporaryRoots.push(root);
    const sourceDirectory = path.join(root, 'authoring');
    await mkdir(path.join(sourceDirectory, 'images'), { recursive: true });
    await mkdir(path.join(sourceDirectory, 'videos'), { recursive: true });
    await writeFile(path.join(sourceDirectory, 'images', '01.png'), 'image');
    await writeFile(path.join(sourceDirectory, 'videos', 'main.mp4'), 'video');
    process.env.MERCHROUTE_OZON_MULTISTORE_FLEET_READY = 'true';
    process.env.MERCHROUTE_CREDENTIAL_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');
    const stores = [
      {
        id: OZON_DEFAULT_STORE_ID,
        storeAlias: 'tek',
        displayName: 'Tek+',
        enabled: true,
        defaultPresetId: '10000000-0000-4000-8000-000000000001',
        presetName: 'Tek 蓝图',
        presetRowVersion: 3,
        presetSnapshot: { name: 'Tek 蓝图', category: 'tek-category' },
        warehouseId: 'tek-warehouse',
        warehouseName: 'Tek warehouse',
        fulfillmentMode: 'FBS' as const,
        accountCurrency: 'RUB' as const,
        autoPublishMode: 'CREATE_ONLY' as const,
        credential: { state: 'ACTIVE', bindingMode: 'VAULT' as const, activeVersionId: '20000000-0000-4000-8000-000000000001' },
        readiness: { ready: true, score: 100, blockers: [] },
        configVersion: 5,
        rowVersion: 6
      },
      {
        id: '7d15ba0c-9270-4dd8-bf43-55457670f290',
        storeAlias: 'glauke',
        displayName: 'Glauke',
        enabled: true,
        defaultPresetId: '10000000-0000-4000-8000-000000000002',
        presetName: 'Glauke 蓝图',
        presetRowVersion: 8,
        presetSnapshot: { name: 'Glauke 蓝图', category: 'glauke-category' },
        warehouseId: 'glauke-warehouse',
        warehouseName: 'Glauke warehouse',
        fulfillmentMode: 'RFBS' as const,
        accountCurrency: 'CNY' as const,
        autoPublishMode: 'COMPATIBLE_UPSERT' as const,
        credential: { state: 'ACTIVE', bindingMode: 'VAULT' as const, activeVersionId: '20000000-0000-4000-8000-000000000002' },
        readiness: { ready: true, score: 100, blockers: [] },
        configVersion: 9,
        rowVersion: 10
      }
    ];
    const repository = {
      getSuccessfulOfferUnion: vi.fn(async () => []),
      getPlanningContext: vi.fn(async () => ({
        sku: '0000119',
        draftVersion: 2,
        generatedVersionId: '30000000-0000-4000-8000-000000000001',
        revision: 4,
        contentPolicyVersion: 'merchroute-ozon-content-v3',
        materialHash: `sha256:${'a'.repeat(64)}`,
        materialHashVersion: 'ozon-shared-material-v1',
        sourceMediaIdentityHash: `sha256:${'c'.repeat(64)}`,
        listingStatus: 'DRAFT',
        listingSnapshot: {},
        materialOverrides: {},
        offerIds: ['0000119-01'],
        stores
      })),
      getSettings: vi.fn(async () => ({
        enabled: true,
        rootDirectory: root,
        rowVersion: 3,
        imageUploadConcurrency: 4,
        videoUploadConcurrency: 1,
        videoPrewarmEnabled: false
      }))
    };
    const variantColorAuthority = createOzonVariantColorAuthority([{
      productVariantId: '11111111-1111-4111-8111-111111111111',
      itemKey: 'colors:1494:972075644',
      dictionaryId: 1494,
      valueId: 972075644,
      nameRu: 'кофе',
      source: 'AUTO_EXACT_RU'
    }]);
    const publishing = {
      resolveVariantColorAuthority: vi.fn(async () => variantColorAuthority),
      buildStorePresetProduct: vi.fn(async (_sku, _draftVersion, presetSnapshot) => {
        const isTek = presetSnapshot.category === 'tek-category';
        const product = importPriceFloorProductFixture();
        product.category = {
          ...product.category,
          categoryKey: isTek ? 'ozon_17028922_970642857' : 'ozon_17028923_970642858',
          descriptionCategoryId: isTek ? 17028922 : 17028923,
          typeId: isTek ? 970642857 : 970642858
        };
        product.offers = [{
          ...product.offers[0]!,
          offerId: isTek ? '0000119-TEK' : '0000119-GLAUKE',
          price: isTek ? 388.3 : 688.6,
          oldPrice: isTek ? 776.6 : 1377.2,
          minPrice: isTek ? 194.15 : 344.3,
          stock: isTek ? 3 : 17
        }];
        return { listing: { revision: 4 }, productJson: product, sourceMediaDirectory: sourceDirectory };
      })
    };
    const service = new OzonStoreService(repository as any, {} as any, publishing as any, {} as any);

    const built = await (service as any).buildPlan('0000119', { draftVersion: 2, storeIds: stores.map((store) => store.id) });

    expect(publishing.buildStorePresetProduct).toHaveBeenCalledTimes(2);
    expect(publishing.resolveVariantColorAuthority).toHaveBeenCalledTimes(1);
    expect(publishing.buildStorePresetProduct.mock.calls.every((call) => call[5] === variantColorAuthority)).toBe(true);
    const tekProduct = built.productByStore.get(stores[0]!.id);
    const glaukeProduct = built.productByStore.get(stores[1]!.id);
    expect(tekProduct).toMatchObject({
      storeAlias: 'tek', warehouseId: 'tek-warehouse', fulfillmentMode: 'FBS', currency: 'RUB',
      category: { descriptionCategoryId: 17028922, typeId: 970642857 },
      offers: [{ offerId: '0000119-TEK', price: 388.3, stock: 3 }]
    });
    expect(glaukeProduct).toMatchObject({
      storeAlias: 'glauke', warehouseId: 'glauke-warehouse', fulfillmentMode: 'RFBS', currency: 'CNY',
      category: { descriptionCategoryId: 17028923, typeId: 970642858 },
      offers: [{ offerId: '0000119-GLAUKE', price: 688.6, stock: 17 }]
    });
    expect(built.plan.items.map((item: any) => item.offerIds)).toEqual([
      ['0000119-TEK'],
      ['0000119-GLAUKE']
    ]);

    const frozen = await service.automaticPublicationPlan('0000119', 2, stores.map((store) => store.id));
    expect(frozen.variantColorAuthority).toEqual(variantColorAuthority);
    const createFromBuiltPlan = vi.spyOn(service as any, 'createFromBuiltPlan').mockResolvedValue({
      publications: [], results: [], failures: [], accepted: 0, failed: 0
    });
    await service.createAutomaticPublicationsFromFrozenPlan(
      frozen,
      { sourceStageId: 'E005', submissionId: 'frozen-roundtrip', deliveredAt: '2026-08-13T00:00:00.000Z' },
      'b8094cb3-2c9c-411c-af6b-aab99bbff6d1'
    );
    const parsedFrozen = createFromBuiltPlan.mock.calls[0]![0];
    expect(parsedFrozen.plan.planHash).toBe(frozen.planHash);
    expect(parsedFrozen.plan.items.map((item: any) => ({
      publicationId: item.publicationId,
      jobId: item.jobId,
      taskId: item.taskId,
      offerIds: item.offerIds
    }))).toEqual(frozen.items.map((item) => ({
      publicationId: item.publicationId,
      jobId: item.jobId,
      taskId: item.taskId,
      offerIds: item.offerIds
    })));

    const legacyV2 = structuredClone(frozen) as any;
    legacyV2.schemaVersion = 2;
    delete legacyV2.sourceMediaIdentityHash;
    legacyV2.planHash = testStableHash(legacyPublicationPlanCanonical(legacyV2));
    delete legacyV2.frozenContractHash;
    legacyV2.frozenContractHash = testStableHash(legacyV2);
    createFromBuiltPlan.mockClear();
    await service.createAutomaticPublicationsFromFrozenPlan(
      legacyV2,
      { sourceStageId: 'E005', submissionId: 'legacy-v2-roundtrip', deliveredAt: '2026-08-13T00:00:00.000Z' },
      'b8094cb3-2c9c-411c-af6b-aab99bbff6d1'
    );
    expect(createFromBuiltPlan.mock.calls[0]![0].plan.sourceMediaIdentityHash).toBe('');
  });

  it('allows cancellation only before runtime/platform evidence exists', () => {
    expect(publicationCancellationBlockers({ state: 'READY', directory_stage: 'INBOX', payload: {} })).toEqual([]);
    expect(publicationCancellationBlockers({
      state: 'IMPORTING', directory_stage: 'PROCESSING', import_task_id: '777',
      lease_token: '00000000-0000-4000-8000-000000000091',
      payload: { networkRecovery: { deliveryState: 'UNKNOWN' } }
    })).toEqual(expect.arrayContaining(['runtimeState', 'directoryStage', 'importTaskId', 'runtimeLease', 'networkDeliveryState']));
  });

  it('writes the S000 package contract and commits FANNED_OUT consumption through createPublication', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'ozon-package-'));
    temporaryRoots.push(root);
    await mkdir(path.join(root, 'shared', '9900002', '30000000-0000-4000-8000-000000000001'), { recursive: true });
    process.env.MERCHROUTE_CREDENTIAL_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');
    const publication = publicationFixture();
    const repository = publicationRepository(root, vi.fn(async () => publication));
    const service = new OzonStoreService(repository as any, {} as any, {} as any, {} as any);
    const result = await (service as any).createFromBuiltPlan(publicationBuiltPlan(root), 'AUTOMATION', deliveryIdentity());
    expect(result).toMatchObject({ accepted: 1, failed: 0 });
    expect(repository.recordMediaConsumption).toHaveBeenCalledWith(expect.objectContaining({
      storeId: publication.storeId,
      publicationId: publication.id,
      decision: 'FANNED_OUT'
    }));
    expect(repository.createPublication.mock.calls[0]?.[1]).toMatchObject({
      sourceStageId: 'E005', submissionId: 'submission-1'
    });
    const packageDirectory = path.join(root, 'stores', 'default', 'inbox', '9900002');
    const ready = JSON.parse(await readFile(path.join(packageDirectory, '_READY'), 'utf8'));
    const marker = JSON.parse(await readFile(path.join(packageDirectory, '.ozon-intake.json'), 'utf8'));
    const productBytes = await readFile(path.join(packageDirectory, 'product.json'));
    expect(ready).toMatchObject({ sku: '9900002', revision: 1, signature: marker.productContentHash });
    expect(marker.productContentHash).toBe(`sha256:${createHash('sha256').update(productBytes).digest('hex')}`);
  });

  it('rebuilds a missing processing package only from the frozen product bytes and shared media', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'ozon-processing-recovery-'));
    temporaryRoots.push(root);
    const sku = '9900138';
    const generatedVersionId = '30000000-0000-4000-8000-000000000138';
    const relativePath = 'variants/coffee/images/submission/image.png';
    const source = path.join(root, 'shared', sku, generatedVersionId, ...relativePath.split('/'));
    const mediaBytes = Buffer.from('frozen media');
    await mkdir(path.dirname(source), { recursive: true });
    await mkdir(path.join(root, 'processing'), { recursive: true });
    await writeFile(source, mediaBytes);
    process.env.MERCHROUTE_CREDENTIAL_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');
    const product = {
      schemaVersion: 2,
      productCode: sku,
      contentPolicyVersion: 'merchroute-ozon-content-v3',
      materialHash: `sha256:${'1'.repeat(64)}`,
      materialHashVersion: 'ozon-shared-material-v1',
      mediaAssets: [{
        relativePath,
        sha256: createHash('sha256').update(mediaBytes).digest('hex')
      }],
      offers: [{ offerId: `${sku}-01`, media: [{ relativePath }] }]
    };
    const packageSignature = `sha256:${createHash('sha256')
      .update(`${JSON.stringify(product, null, 2)}\n`).digest('hex')}`;
    const input = {
      rootDirectory: root,
      workRelPath: `processing/2466679__${sku}__r1`,
      sku,
      generatedVersionId,
      revision: 1,
      publicationId: '10000000-0000-4000-8000-000000000138',
      jobId: '50000000-0000-4000-8000-000000000138',
      taskId: `2466679__${sku}__r1`,
      storeId: '70000000-0000-4000-8000-000000000138',
      storeAlias: '2466679',
      credentialBindingMode: 'VAULT' as const,
      credentialVersionId: '20000000-0000-4000-8000-000000000138',
      storeConfigVersion: 28,
      warehouseId: '1020002357565000',
      planHash: `sha256:${'2'.repeat(64)}`,
      contentPolicyVersion: 'merchroute-ozon-content-v3',
      materialHash: `sha256:${'1'.repeat(64)}`,
      materialHashVersion: 'ozon-shared-material-v1',
      presetRowVersion: 4,
      publicationMode: 'COMPATIBLE_UPSERT' as const,
      materializationHash: `sha256:${'3'.repeat(64)}`,
      offerContractHash: `sha256:${'4'.repeat(64)}`,
      packageSignature,
      product
    };

    await expect(inspectOzonProcessingPackageRecovery(input)).resolves.toMatchObject({
      targetState: 'MISSING', mediaFileCount: 1, mediaBytes: mediaBytes.length, packageSignature
    });
    const restored = await writeOzonProcessingRecoveryPackage(input);
    expect(restored.targetState).toBe('MATCHED');
    const target = restored.targetDirectory;
    await expect(readFile(path.join(target, ...relativePath.split('/')))).resolves.toEqual(mediaBytes);
    const intake = JSON.parse(await readFile(path.join(target, '.ozon-intake.json'), 'utf8'));
    expect(intake).toMatchObject({
      publicationId: input.publicationId,
      jobId: input.jobId,
      taskId: input.taskId,
      productContentHash: packageSignature
    });
    await expect(writeOzonProcessingRecoveryPackage(input)).resolves.toMatchObject({ targetState: 'MATCHED' });
    await writeFile(path.join(target, 'product.json'), '{}\n');
    await expect(inspectOzonProcessingPackageRecovery(input)).rejects.toMatchObject({ code: 'VERSION_CONFLICT' });
  });

  it('writes two automatic publication packages with each store warehouse instead of the legacy preset warehouse', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'ozon-two-store-package-'));
    temporaryRoots.push(root);
    const generatedVersionId = '30000000-0000-4000-8000-000000000001';
    await mkdir(path.join(root, 'shared', '9900002', generatedVersionId), { recursive: true });
    process.env.MERCHROUTE_CREDENTIAL_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');
    const tekStoreId = OZON_DEFAULT_STORE_ID;
    const glaukeStoreId = '7d15ba0c-9270-4dd8-bf43-55457670f290';
    const stores = [
      {
        id: tekStoreId,
        storeAlias: 'default',
        displayName: 'OZON-Tek+',
        warehouseId: '1020002456503000',
        warehouseName: 'Tek warehouse',
        fulfillmentMode: 'RFBS' as const,
        accountCurrency: 'CNY' as const,
        presetSnapshot: { warehouseId: 'W03 CEL标准-123深圳润百国际仓（库存仓）' }
      },
      {
        id: glaukeStoreId,
        storeAlias: '2466679',
        displayName: 'OZON-Glauke',
        warehouseId: '1020002357565000',
        warehouseName: 'Glauke warehouse',
        fulfillmentMode: 'RFBS' as const,
        accountCurrency: 'CNY' as const,
        presetSnapshot: { warehouseId: 'W03 CEL标准-123深圳润百国际仓（库存仓）' }
      }
    ];
    const sharedProduct = {
      schemaVersion: 2,
      storeAlias: '__STORE_SCOPED__',
      productCode: '9900002',
      revision: 1,
      warehouseId: '__STORE_SCOPED__',
      fulfillmentMode: 'FBS',
      currency: 'RUB',
      mediaSourceRoot: '',
      mediaAssets: [],
      offers: [{ offerId: '9900002-01' }]
    };
    const runtime = { imageUploadConcurrency: 7, videoUploadConcurrency: 2, videoPrewarmEnabled: false };
    const productByStore = new Map(stores.map((store) => [
      store.id,
      applyOzonStoreScopedProductFields(sharedProduct, store, runtime)
    ]));
    const plan = {
      context: {
        stores,
        contentPolicyVersion: 'merchroute-ozon-content-v3',
        materialHash: `sha256:${'5'.repeat(64)}`,
        materialHashVersion: 'ozon-shared-material-v1'
      },
      productByStore,
      modeEvidenceByStore: new Map(),
      settingsContract: { rowVersion: 1, rootDirectoryHash: testStableHash(root) },
      plan: {
        planHash: `sha256:${'4'.repeat(64)}`,
        contentPolicyVersion: 'merchroute-ozon-content-v3',
        materialHash: `sha256:${'5'.repeat(64)}`,
        materialHashVersion: 'ozon-shared-material-v1',
        sku: '9900002',
        draftVersion: 1,
        generatedVersionId,
        revision: 1,
        createdAt: '2026-08-11T00:00:00.000Z',
        items: stores.map((store, index) => ({
          storeId: store.id,
          storeAlias: store.storeAlias,
          displayName: store.displayName,
          ready: true,
          blockers: [],
          storeRowVersion: 1,
          storeConfigVersion: 1,
          credentialVersionId: `${index + 2}0000000-0000-4000-8000-000000000001`,
          credentialBindingMode: 'VAULT' as const,
          publicationId: `${index + 1}0000000-0000-4000-8000-000000000001`,
          jobId: `${index + 5}0000000-0000-4000-8000-000000000001`,
          plannedJobId: `${index + 5}0000000-0000-4000-8000-000000000001`,
          publicationMode: 'CREATE_ONLY' as const,
          presetRowVersion: 1,
          warehouseId: store.warehouseId,
          warehouseName: store.warehouseName,
          fulfillmentMode: store.fulfillmentMode,
          accountCurrency: store.accountCurrency,
          offerIds: ['9900002-01'],
          offerContractHash: `sha256:${String(index + 1).repeat(64)}`,
          materializationHash: `sha256:${String(index + 3).repeat(64)}`,
          taskId: `${store.storeAlias}__9900002__r1`
        }))
      }
    };
    const createPublication = vi.fn(async (input) => ({
      ...publicationFixture(),
      id: input.id,
      storeId: input.storeId,
      storeAliasSnapshot: input.storeAlias,
      warehouseId: input.warehouseId,
      warehouseName: input.warehouseName
    }));
    const repository = publicationRepository(root, createPublication);
    const service = new OzonStoreService(repository as any, {} as any, {} as any, {} as any);

    const result = await (service as any).createFromBuiltPlan(plan, 'AUTOMATION', deliveryIdentity());

    expect(result).toMatchObject({ accepted: 2, failed: 0 });
    expect(createPublication).toHaveBeenCalledTimes(2);
    for (const store of stores) {
      const packageDirectory = path.join(root, 'stores', store.storeAlias, 'inbox', '9900002');
      const product = JSON.parse(await readFile(path.join(packageDirectory, 'product.json'), 'utf8'));
      const intake = JSON.parse(await readFile(path.join(packageDirectory, '.ozon-intake.json'), 'utf8'));
      expect(product).toMatchObject({
        storeAlias: store.storeAlias,
        warehouseId: store.warehouseId,
        fulfillmentMode: store.fulfillmentMode,
        currency: store.accountCurrency
      });
      expect(intake).toMatchObject({ storeId: store.id, warehouseId: store.warehouseId });
      expect(JSON.stringify({ product, intake })).not.toContain('W03 CEL标准');
    }
  });

  it('retains the signed package under the fixed attempt identity when materialization fails', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'ozon-package-rollback-'));
    temporaryRoots.push(root);
    await mkdir(path.join(root, 'shared', '9900002', '30000000-0000-4000-8000-000000000001'), { recursive: true });
    process.env.MERCHROUTE_CREDENTIAL_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');
    const repository = publicationRepository(root, vi.fn(async () => {
      throw new Error('injected media consumption transaction failure');
    }));
    const service = new OzonStoreService(repository as any, {} as any, {} as any, {} as any);
    const result = await (service as any).createFromBuiltPlan(publicationBuiltPlan(root), 'AUTOMATION', deliveryIdentity());
    expect(result).toMatchObject({ accepted: 0, failed: 1 });
    expect(await stat(path.join(root, 'stores', 'default', 'inbox', '9900002'))).toMatchObject({});
    expect(repository.failPublicationAttempt).toHaveBeenCalledWith(expect.objectContaining({
      publicationId: '10000000-0000-4000-8000-000000000001',
      phase: 'PACKAGE_OR_DATABASE'
    }));
    expect(repository.recordMediaConsumption).toHaveBeenCalledWith(expect.objectContaining({ decision: 'FAILED' }));
  });

  it('persists the exact variant and store evidence when E001 color validation blocks one publication', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'ozon-color-blocked-'));
    temporaryRoots.push(root);
    const repository = publicationRepository(root, vi.fn());
    const built = publicationBuiltPlan(root);
    built.plan.items[0] = {
      ...built.plan.items[0]!,
      ready: false,
      blockers: ['OZON 商品变体缺少 E001 审核确定的颜色目录身份'],
      errorCode: 'OZON_VARIANT_COLOR_REQUIRED',
      errorDetails: {
        productVariantId: '11111111-1111-4111-8111-111111111111',
        productVariantName: '咖啡色',
        storeId: OZON_DEFAULT_STORE_ID,
        storeAlias: 'default'
      }
    };
    const service = new OzonStoreService(repository as any, {} as any, {} as any, {} as any);

    const result = await (service as any).createFromBuiltPlan(built, 'AUTOMATION', deliveryIdentity());

    expect(result).toMatchObject({ accepted: 0, failed: 1 });
    expect(repository.failPublicationAttempt).toHaveBeenCalledWith(expect.objectContaining({
      errorCode: 'OZON_VARIANT_COLOR_REQUIRED',
      phase: 'LOCAL_VALIDATION',
      errorDetails: expect.objectContaining({
        productVariantId: '11111111-1111-4111-8111-111111111111',
        productVariantName: '咖啡色',
        storeAlias: 'default'
      })
    }));
  });

  it('dispatches the post-begin rowVersion and never reflects arbitrary webhook credentials', async () => {
    const repository = {
      beginPreflight: vi.fn(async () => ({
        store: { id: OZON_DEFAULT_STORE_ID, storeAlias: 'default', rowVersion: 9 },
        storeConfigVersion: 4,
        credentialVersionId: '20000000-0000-4000-8000-000000000001'
      })),
      getSettings: vi.fn(async () => ({ preflightWebhookUrl: 'https://workflow.example/preflight' }))
    };
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      headers: { Authorization: 'Bearer secret' }, clientId: 'leak', apiKey: 'leak'
    }), { status: 202 }));
    globalThis.fetch = fetchMock as typeof fetch;
    const service = new OzonStoreService(repository as any, {} as any, {} as any, {} as any);
    const result = await service.preflight(OZON_DEFAULT_STORE_ID, { rowVersion: 8 });
    const retried = await service.preflight(OZON_DEFAULT_STORE_ID, { rowVersion: 8 });
    const request = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(JSON.parse(String(request.body))).toEqual({
      action: 'preflight',
      storeId: OZON_DEFAULT_STORE_ID,
      storeAlias: 'default',
      rowVersion: 9,
      storeConfigVersion: 4,
      credentialVersionId: '20000000-0000-4000-8000-000000000001',
      requestRef: result.requestRef
    });
    expect(result).not.toHaveProperty('response');
    expect(JSON.stringify(result)).not.toContain('secret');
    expect(retried.requestRef).not.toBe(result.requestRef);
  });

  it('does not acquire a preflight lock when the webhook is not configured', async () => {
    const repository = {
      getSettings: vi.fn(async () => ({ preflightWebhookUrl: '' })),
      beginPreflight: vi.fn()
    };
    const service = new OzonStoreService(repository as any, {} as any, {} as any, {} as any);
    await expect(service.preflight(OZON_DEFAULT_STORE_ID, { rowVersion: 8 })).rejects.toMatchObject({
      code: 'CONFIG_INVALID', statusCode: 409
    });
    expect(repository.beginPreflight).not.toHaveBeenCalled();
  });

  it('releases only an explicitly rejected manual dispatch and leaves an unknown delivery fenced', async () => {
    const credentialVersionId = '20000000-0000-4000-8000-000000000001';
    const repository = {
      getSettings: vi.fn(async () => ({ preflightWebhookUrl: 'https://workflow.example/preflight' })),
      beginPreflight: vi.fn(async () => ({
        store: { id: OZON_DEFAULT_STORE_ID, storeAlias: 'default', rowVersion: 9 },
        storeConfigVersion: 4,
        credentialVersionId
      })),
      failPreflightDispatch: vi.fn(async () => ({ id: OZON_DEFAULT_STORE_ID, preflight: { status: 'FAILED' } }))
    };
    const service = new OzonStoreService(repository as any, {} as any, {} as any, {} as any);

    globalThis.fetch = vi.fn(async () => new Response('{}', { status: 400 })) as typeof fetch;
    await expect(service.preflight(OZON_DEFAULT_STORE_ID, { rowVersion: 8 })).rejects.toMatchObject({
      code: 'OZON_PREFLIGHT_DISPATCH_REJECTED'
    });
    expect(repository.failPreflightDispatch).toHaveBeenCalledWith(OZON_DEFAULT_STORE_ID, 4, credentialVersionId);

    repository.failPreflightDispatch.mockClear();
    globalThis.fetch = vi.fn(async () => { throw new Error('connection outcome unknown'); }) as typeof fetch;
    await expect(service.preflight(OZON_DEFAULT_STORE_ID, { rowVersion: 8 })).rejects.toMatchObject({
      code: 'OZON_PREFLIGHT_DISPATCH_UNKNOWN',
      details: expect.objectContaining({ deliveryUnknown: true })
    });
    expect(repository.failPreflightDispatch).not.toHaveBeenCalled();
  });

  it('never rematerializes a NEEDS_ATTENTION attempt when task detail proves remote progress without a gateway row', async () => {
    const publication = { ...publicationFixture(), status: 'NEEDS_ATTENTION' as const };
    const repository = {
      getPublication: vi.fn(async () => publication),
      getPublicationTaskDetail: vi.fn(async () => ({
        publication,
        events: [],
        frozenContract: { planHash: publication.planHash, requestId: publication.requestId },
        readback: { required: false, canRecheck: true, gatewayRequestCount: 0, deliveryStates: [] },
        recovery: { canRecheck: true, canManualTakeover: false, recoveryMode: 'READBACK_REQUIRED' }
      })),
      getSettings: vi.fn(),
      getPublicationRecoveryArtifact: vi.fn(),
      materializePublicationAttempt: vi.fn()
    };
    const service = new OzonStoreService(repository as any, {} as any, {} as any, {} as any);

    await expect(service.recheckPublication(publication.id, {
      rowVersion: publication.rowVersion,
      planHash: publication.planHash,
      requestId: publication.requestId
    })).rejects.toMatchObject({
      code: 'OZON_READBACK_REQUIRED',
      statusCode: 409,
      details: expect.objectContaining({ recoveryMode: 'READBACK_REQUIRED' })
    });
    expect(repository.getSettings).not.toHaveBeenCalled();
    expect(repository.getPublicationRecoveryArtifact).not.toHaveBeenCalled();
    expect(repository.materializePublicationAttempt).not.toHaveBeenCalled();
  });

  it('dispatches publication-scoped productStatus and commits only the verified readback', async () => {
    const publication = publicationFixture();
    const repository = {
      getPublication: vi.fn(async () => publication),
      getSettings: vi.fn(async () => ({
        adminApiWebhookUrl: 'http://n8n.test/webhook/ozon-admin', publicationReadbackEnabled: true
      })),
      beginPublicationReadback: vi.fn(async () => ({
        publication, dispatchRowVersion: publication.rowVersion + 1, requestRef: 'ozon-readback:request-1',
        taskId: 'default__9900002__r1',
        listing: { sku: '9900002', status: 'MODERATING', data: { offers: [{ offerId: '9900002-01', media: [] }] } },
        mappings: []
      })),
      completePublicationReadback: vi.fn(async () => ({ ...publication, status: 'SUCCEEDED', rowVersion: publication.rowVersion + 2 })),
      failPublicationReadback: vi.fn(async () => undefined)
    };
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      ok: true, httpStatus: 200, result: {
        contractVersion: 2, requestedOfferIds: ['9900002-01'], readAt: '2026-08-11T01:00:00.000Z',
        infoItems: [{ offer_id: '9900002-01', id: '501', sku: '1001', statuses: {
          status_name: 'selling', moderate_status: 'approved', validation_status: 'success'
        } }],
        attributeItems: [],
        operations: [
          { operation: 'infoList', ok: true, statusCode: 200 },
          { operation: 'attributesInfo', ok: true, statusCode: 200 }
        ]
      }
    }), { status: 200 }));
    globalThis.fetch = fetchMock as typeof fetch;
    const service = new OzonStoreService(repository as any, {} as any, {} as any, {} as any);
    await expect(service.recheckPublication(publication.id, {
      rowVersion: publication.rowVersion, planHash: publication.planHash, requestId: publication.requestId
    }))
      .resolves.toMatchObject({ status: 'SUCCEEDED' });
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({
      action: 'productStatus', requestRef: 'ozon-readback:request-1',
      taskId: 'default__9900002__r1', publicationId: publication.id,
      offerIds: ['9900002-01']
    });
    expect(repository.completePublicationReadback).toHaveBeenCalledWith(expect.objectContaining({
      publicationId: publication.id, requestRef: 'ozon-readback:request-1', businessState: 'PUBLISHED'
    }));
    expect(repository.failPublicationReadback).not.toHaveBeenCalled();
  });

  it('persists a 429 readback as NOT_SENT/RETRYABLE without changing authoritative platform state', async () => {
    const publication = publicationFixture();
    const repository = {
      getPublication: vi.fn(async () => publication),
      getSettings: vi.fn(async () => ({
        adminApiWebhookUrl: 'http://n8n.test/webhook/ozon-admin', publicationReadbackEnabled: true
      })),
      beginPublicationReadback: vi.fn(async () => ({
        publication, dispatchRowVersion: publication.rowVersion + 1, requestRef: 'ozon-readback:request-429',
        taskId: 'default__9900002__r1', listing: { data: { offers: [] } }, mappings: []
      })),
      completePublicationReadback: vi.fn(),
      failPublicationReadback: vi.fn(async () => undefined)
    };
    globalThis.fetch = vi.fn(async () => new Response('{}', { status: 429 })) as typeof fetch;
    const service = new OzonStoreService(repository as any, {} as any, {} as any, {} as any);
    await expect(service.recheckPublication(publication.id, {
      rowVersion: publication.rowVersion, planHash: publication.planHash, requestId: publication.requestId
    }))
      .rejects.toMatchObject({ code: 'OZON_PLATFORM_STATUS_REFRESH_FAILED', statusCode: 429 });
    expect(repository.completePublicationReadback).not.toHaveBeenCalled();
    expect(repository.failPublicationReadback).toHaveBeenCalledWith(expect.objectContaining({
      deliveryState: 'NOT_SENT', retryClass: 'RETRYABLE', statusCode: 429
    }));
  });

  it('keeps publication readback NOT_SENT until the controlled fleet capability is enabled', async () => {
    const publication = publicationFixture();
    const repository = {
      getPublication: vi.fn(async () => publication),
      getSettings: vi.fn(async () => ({
        adminApiWebhookUrl: 'http://n8n.test/webhook/ozon-admin', publicationReadbackEnabled: false
      })),
      beginPublicationReadback: vi.fn()
    };
    const service = new OzonStoreService(repository as any, {} as any, {} as any, {} as any);
    await expect(service.recheckPublication(publication.id, {
      rowVersion: publication.rowVersion, planHash: publication.planHash, requestId: publication.requestId
    }))
      .rejects.toMatchObject({ code: 'OZON_READBACK_DISPATCH_UNAVAILABLE', statusCode: 409 });
    expect(repository.beginPublicationReadback).not.toHaveBeenCalled();
  });

  it('rejects republish when no newer generated revision exists', async () => {
    const publication = publicationFixture();
    const repository = {
      getPublication: vi.fn(async () => publication),
      getCurrentListingVersion: vi.fn(async () => ({
        draftVersion: 7, revision: publication.revision, generatedVersionId: publication.generatedVersionId
      })),
      republishPublication: vi.fn()
    };
    const service = new OzonStoreService(repository as any, {} as any, {} as any, {} as any);
    await expect(service.republishPublication(publication.id, { rowVersion: publication.rowVersion }))
      .rejects.toMatchObject({ code: 'VERSION_CONFLICT', statusCode: 409 });
    expect(repository.republishPublication).not.toHaveBeenCalled();
  });

  it('creates a new publication identity for a newer revision instead of reopening the old job', async () => {
    const publication = publicationFixture();
    const next = { ...publication, id: '10000000-0000-4000-8000-000000000099', revision: 2,
      generatedVersionId: '30000000-0000-4000-8000-000000000099', rowVersion: 1 };
    const repository = {
      getPublication: vi.fn(async () => publication),
      getCurrentListingVersion: vi.fn(async () => ({ draftVersion: 8, revision: 2, generatedVersionId: next.generatedVersionId })),
      republishPublication: vi.fn()
    };
    const service = new OzonStoreService(repository as any, {} as any, {} as any, {} as any);
    vi.spyOn(service as any, 'buildPlan').mockResolvedValue({
      context: {}, productByStore: new Map(),
      plan: { items: [{ storeId: OZON_DEFAULT_STORE_ID, ready: true, blockers: [] }] }
    });
    vi.spyOn(service as any, 'createFromBuiltPlan').mockResolvedValue({ publications: [next], failures: [], accepted: 1, failed: 0 });
    await expect(service.republishPublication(publication.id, { rowVersion: publication.rowVersion })).resolves.toEqual(next);
    expect((service as any).buildPlan).toHaveBeenCalledWith('9900002', {
      draftVersion: 8, storeIds: [OZON_DEFAULT_STORE_ID]
    });
    expect(next.id).not.toBe(publication.id);
    expect(repository.republishPublication).not.toHaveBeenCalled();
  });

  it('computes chained compatible append against the successful store/SKU offer union', async () => {
    const base = { ...publicationFixture(), status: 'SUCCEEDED' as const, offerIds: ['9900002-B'] };
    const repository = {
      getPublication: vi.fn(async () => base),
      getSuccessfulOfferUnion: vi.fn(async () => ['9900002-A', '9900002-B'])
    };
    const service = new OzonStoreService(repository as any, {
      getListing: vi.fn(async () => ({ rowVersion: 9 }))
    } as any, {} as any, {} as any);
    vi.spyOn(service as any, 'buildPlan').mockResolvedValue({
      context: { offerIds: ['9900002-A', '9900002-B', '9900002-C'] },
      productByStore: new Map([[OZON_DEFAULT_STORE_ID, {
        schemaVersion: 2, productCode: '9900002', revision: 3, offers: [
          { offerId: '9900002-A' }, { offerId: '9900002-B' }, { offerId: '9900002-C' }
        ]
      }]]),
      plan: {
        planHash: `sha256:${'4'.repeat(64)}`, sku: '9900002', draftVersion: 9,
        variantColorAuthority: { hash: `sha256:${'5'.repeat(64)}` },
        generatedVersionId: '30000000-0000-4000-8000-000000000099', revision: 3,
        createdAt: '2026-08-11T00:00:00.000Z', items: [{
          storeId: OZON_DEFAULT_STORE_ID, offerIds: ['9900002-A', '9900002-B', '9900002-C'],
          blockers: [], materializationHash: `sha256:${'2'.repeat(64)}`
        }]
      }
    });
    const result = await service.compatibleAppendPlan(base.id);
    expect(result.plan.newOfferIds).toEqual(['9900002-C']);
    expect(result.plan.newOfferIds).not.toContain('9900002-A');
  });
});

async function automaticSnapshotFixture(options: {
  currency?: 'RUB' | 'CNY';
  currentAccountCurrency?: 'RUB' | 'CNY';
  storeId?: string;
  storeAlias?: string;
  displayName?: string;
  idSuffix?: number;
} = {}) {
  process.env.MERCHROUTE_CREDENTIAL_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');
  const root = await mkdtemp(path.join(os.tmpdir(), 'ozon-automatic-snapshot-'));
  temporaryRoots.push(root);
  const suffix = String(options.idSuffix ?? 41).padStart(12, '0');
  const jobId = `50000000-0000-4000-8000-${suffix}`;
  const publicationId = `10000000-0000-4000-8000-${suffix}`;
  const generatedVersionId = `30000000-0000-4000-8000-${suffix}`;
  const credentialVersionId = `20000000-0000-4000-8000-${suffix}`;
  const storeId = options.storeId ?? OZON_DEFAULT_STORE_ID;
  const storeAlias = options.storeAlias ?? 'default';
  const accountCurrency = options.currency ?? 'CNY';
  const taskId = `${storeAlias}__0000119__r4`;
  const offerIds = ['0000119-01'];
  const product = ozonProductSchema.parse({
    ...importPriceFloorProductFixture(),
    storeAlias,
    currency: accountCurrency
  });
  const offerContractHash = testStableHash({
    storeId,
    generatedVersionId,
    offerIds: [...offerIds].sort()
  });
  const materializationHash = testStableHash({
    product: stableMaterial(product),
    storeId,
    storeConfigVersion: 8,
    credentialVersionId,
    presetId: null,
    presetDefinitionHash: null,
    warehouseId: '1020002456503000',
    fulfillmentMode: 'FBS',
    accountCurrency,
    offerContractHash
  });
  const productBytes = Buffer.from(`${JSON.stringify(product, null, 2)}\n`, 'utf8');
  const productContentHash = `sha256:${createHash('sha256').update(productBytes).digest('hex')}`;
  const workRelPath = `stores/${storeAlias}/inbox/0000119`;
  const workDirectory = path.join(root, ...workRelPath.split('/'));
  await mkdir(workDirectory, { recursive: true });
  const ticketPayload = {
    schemaVersion: 1,
    jobId,
    taskId,
    storeId,
    storeAlias,
    publicationId,
    credentialVersionId,
    credentialBindingMode: 'VAULT',
    storeConfigVersion: 8,
    warehouseId: '1020002456503000',
    sku: '0000119',
    revision: 4,
    materializationHash,
    offerContractHash,
    productContentHash
  };
  await Promise.all([
    writeFile(path.join(workDirectory, 'product.json'), productBytes),
    writeFile(path.join(workDirectory, '_READY'), `${JSON.stringify(buildOzonStoreReadyMarker({
      jobId, taskId, sku: '0000119', revision: 4, productContentHash
    }), null, 2)}\n`),
    writeFile(path.join(workDirectory, '.ozon-intake.json'), `${JSON.stringify({
      ...ticketPayload,
      ticket: signIntakeTicket(ticketPayload)
    }, null, 2)}\n`)
  ]);
  const publication = {
    id: publicationId,
    sku: '0000119',
    generatedVersionId,
    revision: 4,
    storeId,
    storeAliasSnapshot: storeAlias,
    storeDisplayNameSnapshot: options.displayName ?? 'Tek+',
    status: 'SUCCEEDED',
    source: 'AUTOMATION',
    credentialBindingMode: 'VAULT',
    credentialVersionId,
    storeConfigVersion: 8,
    taskId,
    warehouseId: '1020002456503000',
    warehouseName: '测试仓库',
    fulfillmentMode: 'FBS',
    accountCurrency,
    offerIds,
    offerContractHash,
    materializationHash,
    packageRelPath: workRelPath,
    packageSignature: productContentHash,
    productIds: [],
    ozonSkus: [],
    productLinks: [],
    result: {},
    rowVersion: 5,
    createdAt: '2026-08-13T00:00:00.000Z',
    updatedAt: '2026-08-13T00:05:00.000Z',
    completedAt: '2026-08-13T00:05:00.000Z'
  } as const;
  const context = {
    job: {
      id: jobId,
      source: 'AUTO',
      taskId,
      storeId,
      storeAlias,
      publicationId,
      credentialVersionId,
      credentialBindingMode: 'VAULT',
      storeConfigVersion: 8,
      warehouseId: '1020002456503000',
      sku: '0000119',
      revision: 4,
      offerIds,
      offerContractHash,
      materializationHash,
      payload: {
        schemaVersion: 3,
        mode: 'MULTISTORE_PUBLICATION',
        storeId,
        publicationId,
        offerContractHash,
        materializationHash
      },
      taskFolder: '0000119__r4',
      workRelPath,
      directoryStage: 'INBOX',
      directorySignature: productContentHash
    },
    publication,
    generatedVersionId,
    listingSnapshot: {
      sku: '0000119',
      productName: '测试商品',
      managementSource: 'AUTO',
      status: 'READY',
      rowVersion: 7,
      revision: 4,
      generatedVersionId,
      data: {
        currency: 'RUB',
        mediaSourceRoot: path.join(root, 'shared', '0000119'),
        offers: [
          { offerId: '0000119-01', price: 4269, oldPrice: 8538, minPrice: 2134.5 },
          { offerId: '0000119-foreign', price: 9999, oldPrice: 19998, minPrice: 4999.5 }
        ]
      },
      createdAt: '2026-08-13T00:00:00.000Z',
      updatedAt: '2026-08-13T00:00:00.000Z'
    },
    currentAccountCurrency: options.currentAccountCurrency ?? 'RUB'
  } as const;
  return { root, workDirectory, context };
}

function testStableHash(value: unknown): string {
  return `sha256:${createHash('sha256').update(testStableJson(value)).digest('hex')}`;
}

function testStableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(testStableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${testStableJson(record[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function legacyPublicationPlanCanonical(frozen: any): Record<string, unknown> {
  const modeEvidence = new Map((frozen.stores as any[]).map((entry) => [entry.storeId, entry.modeEvidence]));
  return {
    sku: frozen.sku,
    draftVersion: frozen.draftVersion,
    generatedVersionId: frozen.generatedVersionId,
    revision: frozen.revision,
    contentPolicyVersion: frozen.contentPolicyVersion,
    materialHash: frozen.materialHash,
    materialHashVersion: frozen.materialHashVersion,
    variantColorAuthority: frozen.variantColorAuthority,
    settingsRowVersion: frozen.settingsRowVersion,
    rootDirectoryHash: frozen.rootDirectoryHash,
    items: (frozen.items as any[]).map((item) => ({
      storeId: item.storeId,
      storeAlias: item.storeAlias,
      storeRowVersion: item.storeRowVersion,
      storeConfigVersion: item.storeConfigVersion,
      credentialVersionId: item.credentialVersionId || null,
      credentialBindingMode: item.credentialBindingMode,
      presetId: item.presetId || null,
      presetRowVersion: item.presetRowVersion || null,
      presetDefinitionHash: item.presetDefinitionHash || null,
      publicationMode: item.publicationMode,
      publicationId: item.publicationId,
      jobId: item.jobId,
      plannedJobId: item.plannedJobId,
      taskId: item.taskId,
      warehouseId: item.warehouseId,
      fulfillmentMode: item.fulfillmentMode,
      accountCurrency: item.accountCurrency,
      ready: item.ready,
      blockers: [...item.blockers],
      errorCode: item.errorCode || null,
      errorDetails: item.errorDetails || null,
      offerIds: [...item.offerIds],
      offerContractHash: item.offerContractHash,
      materializationHash: item.materializationHash,
      modeEvidence: modeEvidence.get(item.storeId) || null
    })).sort((left, right) => left.storeId.localeCompare(right.storeId))
  };
}

function publicationFixture() {
  return {
    id: '10000000-0000-4000-8000-000000000001', sku: '9900002',
    generatedVersionId: '30000000-0000-4000-8000-000000000001', revision: 1,
    storeId: OZON_DEFAULT_STORE_ID, storeAliasSnapshot: 'default', storeDisplayNameSnapshot: 'Default',
    status: 'FAILED', source: 'MANUAL', credentialBindingMode: 'VAULT',
    credentialVersionId: '20000000-0000-4000-8000-000000000001', storeConfigVersion: 1,
    warehouseId: '123', warehouseName: 'Warehouse', fulfillmentMode: 'FBS', accountCurrency: 'RUB',
    plannedJobId: '50000000-0000-4000-8000-000000000001',
    requestId: '60000000-0000-4000-8000-000000000001',
    planHash: `sha256:${'4'.repeat(64)}`,
    contentPolicyVersion: 'merchroute-ozon-content-v3',
    materialHash: `sha256:${'5'.repeat(64)}`,
    materialHashVersion: 'ozon-shared-material-v1',
    presetRowVersion: 1,
    publicationMode: 'CREATE_ONLY',
    offerIds: ['9900002-01'], offerContractHash: `sha256:${'1'.repeat(64)}`,
    materializationHash: `sha256:${'2'.repeat(64)}`, productIds: [], ozonSkus: [], productLinks: [],
    result: {}, rowVersion: 3, createdAt: '2026-08-11T00:00:00.000Z', updatedAt: '2026-08-11T00:00:00.000Z'
  } as const;
}

function deliveryIdentity() {
  return { sourceStageId: 'E005', submissionId: 'submission-1', variantId: 'main', deliveredAt: '2026-08-11T00:00:00.000Z' };
}

function importPriceFloorProductFixture() {
  const image = { assetId: 'asset-1', relativePath: 'images/01.png', kind: 'image' as const, sortOrder: 0, isPrimary: true };
  const video = { assetId: 'video-1', relativePath: 'videos/main.mp4', kind: 'video' as const, sortOrder: 1, isPrimary: false };
  return {
    schemaVersion: 1 as const,
    storeAlias: 'default',
    productCode: '0000119',
    productName: '测试商品',
    revision: 4,
    fulfillmentMode: 'FBS' as const,
    warehouseId: '1020002456503000',
    category: {
      categoryKey: 'ozon_1_2',
      descriptionCategoryId: 17028922,
      typeId: 970642857,
      templateVersion: 2,
      schemaHash: `sha256:${'a'.repeat(64)}`
    },
    currency: 'CNY' as const,
    vat: '0.2' as const,
    titleRu: 'Женская сумка через плечо',
    descriptionRu: 'Описание товара',
    brand: '',
    dimensions: { length: 300, width: 200, height: 120, dimensionUnit: 'mm' as const, weight: 700, weightUnit: 'g' as const },
    sharedAttributes: [],
    mediaCapabilities: {},
    offers: [{
      variantId: '11111111-1111-4111-8111-111111111111',
      variantCode: '01',
      offerId: '0000119-01',
      price: 388.3,
      oldPrice: 776.6,
      minPrice: 194.15,
      stock: 1,
      media: [image, video]
    }]
  };
}

function publicationRepository(rootDirectory: string, createPublication: ReturnType<typeof vi.fn>) {
  let planned: any;
  return {
    getSettings: vi.fn(async () => ({ rootDirectory, rowVersion: 1 })),
    listPublications: vi.fn(async () => []),
    createPublication,
    planPublicationAttempt: vi.fn(async (input: any) => {
      planned = {
        ...publicationFixture(),
        ...input,
        storeAliasSnapshot: input.storeAlias,
        storeDisplayNameSnapshot: input.storeDisplayName,
        status: 'PLANNED',
        rowVersion: 1
      };
      return planned;
    }),
    materializePublicationAttempt: vi.fn(async (input: any) => {
      const result = await createPublication({ ...planned, ...input }, deliveryIdentity());
      return { ...planned, ...result, status: 'QUEUED' };
    }),
    failPublicationAttempt: vi.fn(async (input: any) => ({
      ...planned,
      id: input.publicationId,
      status: 'NEEDS_ATTENTION',
      errorCode: input.errorCode,
      errorMessage: input.errorMessage
    })),
    recordMediaConsumption: vi.fn(async () => undefined)
  };
}

function publicationBuiltPlan(rootDirectory: string) {
  const store = {
    id: OZON_DEFAULT_STORE_ID, storeAlias: 'default', displayName: 'Default', presetSnapshot: {}
  };
  return {
    context: {
      stores: [store],
      contentPolicyVersion: 'merchroute-ozon-content-v3',
      materialHash: `sha256:${'5'.repeat(64)}`,
      materialHashVersion: 'ozon-shared-material-v1'
    },
    productByStore: new Map([[OZON_DEFAULT_STORE_ID, {
      schemaVersion: 2, productCode: '9900002', revision: 1, mediaSourceRoot: '', mediaAssets: [],
      contentPolicyVersion: 'merchroute-ozon-content-v3', materialHash: `sha256:${'5'.repeat(64)}`,
      materialHashVersion: 'ozon-shared-material-v1',
      offers: [{ offerId: '9900002-01' }]
    }]]),
    modeEvidenceByStore: new Map(),
    settingsContract: { rowVersion: 1, rootDirectoryHash: testStableHash(rootDirectory) },
    plan: {
      planHash: `sha256:${'4'.repeat(64)}`, sku: '9900002', draftVersion: 1,
      generatedVersionId: '30000000-0000-4000-8000-000000000001', revision: 1,
      createdAt: '2026-08-11T00:00:00.000Z',
      items: [{
        storeId: OZON_DEFAULT_STORE_ID, storeAlias: 'default', displayName: 'Default', ready: true, blockers: [],
        storeRowVersion: 1, storeConfigVersion: 1,
        credentialVersionId: '20000000-0000-4000-8000-000000000001', credentialBindingMode: 'VAULT',
        warehouseId: '123', warehouseName: 'Warehouse', fulfillmentMode: 'FBS', accountCurrency: 'RUB',
        offerIds: ['9900002-01'], offerContractHash: `sha256:${'1'.repeat(64)}`,
        contentPolicyVersion: 'merchroute-ozon-content-v3', materialHash: `sha256:${'5'.repeat(64)}`,
        publicationMode: 'CREATE_ONLY', presetRowVersion: 1,
        publicationId: '10000000-0000-4000-8000-000000000001',
        jobId: '50000000-0000-4000-8000-000000000001',
        plannedJobId: '50000000-0000-4000-8000-000000000001',
        materializationHash: `sha256:${'2'.repeat(64)}`, taskId: 'default__9900002__r1'
      }]
    }
  };
}
