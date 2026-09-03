import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FastifyBaseLogger } from 'fastify';
import type { OzonPublishJob } from '@n8n-media-review/shared';
import type {
  OzonKnownPrePlatformFailureRecoveryChecks,
  OzonKnownPrePlatformFailureRecoveryInput,
  OzonRepository
} from '../../repositories/ozon.js';
import type { PurchaseRepository } from '../../repositories/purchases.js';
import { OzonPublishingService } from './index.js';

const roots: string[] = [];

afterEach(async () => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('OZON known pre-platform failure recovery service', () => {
  it('dry-runs read-only checks, then rechecks under apply and clears the terminal marker only after both checks pass', async () => {
    const fixture = await importRecoveryFixture();
    const recoverKnownPrePlatformFailure = recoveryRepositoryMethod(fixture.job);
    const repository = {
      getJob: vi.fn(async () => fixture.job),
      getSettings: vi.fn(async () => ({
        rootDirectory: fixture.root,
        adminApiWebhookUrl: 'http://n8n.test/webhook/ozon-admin'
      })),
      recoverKnownPrePlatformFailure
    } as unknown as OzonRepository;
    const fetchMock = vi.fn(async () => emptyProductStatusResponse());
    vi.stubGlobal('fetch', fetchMock);
    const service = new OzonPublishingService(
      repository,
      {} as PurchaseRepository,
      { error: vi.fn() } as unknown as FastifyBaseLogger
    );

    const dryRun = await service.recoverKnownPrePlatformFailure(fixture.job.id, {
      reason: 'IMPORT_INTENT_URL_MISSING',
      rowVersion: fixture.job.rowVersion,
      listingRowVersion: 4,
      dryRun: true
    });
    expect(dryRun).toMatchObject({
      status: 'DRY_RUN',
      checks: {
        remoteState: {
          status: 'CONFIRMED_EMPTY', offerIds: fixture.job.offerIds, contractVersion: 2,
          absenceEvidence: { method: 'BOTH_ARRAYS_EMPTY' }
        },
        productJson: { status: 'MATCHED', expectedSignature: fixture.signature }
      }
    });
    expect(await readFile(path.join(fixture.directory, '_ERROR.json'), 'utf8')).toContain(fixture.job.id);

    const applied = await service.recoverKnownPrePlatformFailure(fixture.job.id, {
      reason: 'IMPORT_INTENT_URL_MISSING',
      rowVersion: fixture.job.rowVersion,
      listingRowVersion: 4,
      dryRun: false
    });
    expect(applied).toMatchObject({
      status: 'RECOVERED',
      checks: {
        remoteState: {
          status: 'CONFIRMED_EMPTY', contractVersion: 2,
          absenceEvidence: { method: 'BOTH_ARRAYS_EMPTY' }
        },
        productJson: { status: 'MATCHED' }
      }
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls.map((call) => JSON.parse(String((call[1] as RequestInit).body)))).toEqual([
      { action: 'productStatus', offerIds: fixture.job.offerIds },
      { action: 'productStatus', offerIds: fixture.job.offerIds },
      { action: 'productStatus', offerIds: fixture.job.offerIds }
    ]);
    expect(recoverKnownPrePlatformFailure).toHaveBeenCalledTimes(3);
    const markerNames = await readdir(fixture.directory);
    expect(markerNames).not.toContain('_ERROR.json');
    expect(markerNames.some((name) => name.startsWith('_ERROR.recovered-'))).toBe(true);
  });

  it('rejects a changed product.json signature and leaves the terminal marker untouched', async () => {
    const fixture = await importRecoveryFixture();
    await writeFile(path.join(fixture.directory, 'product.json'), JSON.stringify({ productCode: fixture.job.sku, changed: true }));
    const repository = {
      getJob: vi.fn(async () => fixture.job),
      getSettings: vi.fn(async () => ({
        rootDirectory: fixture.root,
        adminApiWebhookUrl: 'http://n8n.test/webhook/ozon-admin'
      })),
      recoverKnownPrePlatformFailure: recoveryRepositoryMethod(fixture.job)
    } as unknown as OzonRepository;
    vi.stubGlobal('fetch', vi.fn(async () => emptyProductStatusResponse()));
    const service = new OzonPublishingService(repository, {} as PurchaseRepository, {} as FastifyBaseLogger);

    await expect(service.recoverKnownPrePlatformFailure(fixture.job.id, {
      reason: 'IMPORT_INTENT_URL_MISSING',
      rowVersion: fixture.job.rowVersion,
      listingRowVersion: 4,
      dryRun: false
    })).rejects.toMatchObject({ code: 'VERSION_CONFLICT' });
    expect(await readFile(path.join(fixture.directory, '_ERROR.json'), 'utf8')).toContain(fixture.job.id);
  });

  it('rejects network and unknown readback instead of treating it as an empty platform state', async () => {
    const fixture = await importRecoveryFixture();
    const repository = {
      getJob: vi.fn(async () => fixture.job),
      getSettings: vi.fn(async () => ({
        rootDirectory: fixture.root,
        adminApiWebhookUrl: 'http://n8n.test/webhook/ozon-admin'
      })),
      recoverKnownPrePlatformFailure: recoveryRepositoryMethod(fixture.job)
    } as unknown as OzonRepository;
    const service = new OzonPublishingService(repository, {} as PurchaseRepository, {} as FastifyBaseLogger);

    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('fetch failed'); }));
    await expect(service.recoverKnownPrePlatformFailure(fixture.job.id, {
      reason: 'IMPORT_INTENT_URL_MISSING', rowVersion: fixture.job.rowVersion, listingRowVersion: 4, dryRun: true
    })).rejects.toMatchObject({ code: 'OZON_REMOTE_STATE_UNPROVEN' });

    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ ok: true, result: { operations: [] } }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    })));
    await expect(service.recoverKnownPrePlatformFailure(fixture.job.id, {
      reason: 'IMPORT_INTENT_URL_MISSING', rowVersion: fixture.job.rowVersion, listingRowVersion: 4, dryRun: true
    })).rejects.toMatchObject({ code: 'OZON_REMOTE_STATE_UNPROVEN' });
  });

  it('records title snapshot recovery checks as not applicable without calling OZON', async () => {
    const job = {
      id: randomUUID(), sku: '0000107', source: 'AUTO', state: 'NEEDS_ATTENTION', storeAlias: 'default',
      offerIds: [], ozonProductLinks: [], stageStates: {}, retryCount: 4, rowVersion: 59,
      payload: {}, createdAt: '2026-08-08T00:00:00.000Z', updatedAt: '2026-08-08T00:00:00.000Z'
    } as OzonPublishJob;
    const recoverKnownPrePlatformFailure = recoveryRepositoryMethod(job);
    const repository = {
      getJob: vi.fn(async () => job),
      getSettings: vi.fn(async () => ({ rootDirectory: '' })),
      recoverKnownPrePlatformFailure
    } as unknown as OzonRepository;
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const service = new OzonPublishingService(repository, {} as PurchaseRepository, {} as FastifyBaseLogger);

    const result = await service.recoverKnownPrePlatformFailure(job.id, {
      reason: 'TITLE_TRANSLATION_MAX_LENGTH_60_TO_200', rowVersion: 59, dryRun: true
    });
    expect(result.checks).toMatchObject({
      remoteState: { status: 'NOT_APPLICABLE', offerIds: [] },
      productJson: { status: 'NOT_APPLICABLE' }
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rechecks P003 v2 and the signed three-offer product.json for a late SUBMITTING title migration', async () => {
    const offerIds = ['0000107-01', '0000107-02', '0000107-03'];
    const fixture = await importRecoveryFixture({
      schemaVersion: 2,
      productCode: '0000107',
      revision: 2,
      offers: offerIds.map((offerId) => ({ offerId }))
    }, { sku: '0000107', offerIds, state: 'SUBMITTING' });
    const productBefore = await readFile(path.join(fixture.directory, 'product.json'), 'utf8');
    const recoverKnownPrePlatformFailure = recoveryRepositoryMethod(fixture.job, {
      jobState: 'SUBMITTING', retryCount: 0, titleTranslationMaxLength: 200
    });
    const repository = {
      getJob: vi.fn(async () => fixture.job),
      getSettings: vi.fn(async () => ({
        rootDirectory: fixture.root,
        adminApiWebhookUrl: 'http://n8n.test/webhook/ozon-admin'
      })),
      recoverKnownPrePlatformFailure
    } as unknown as OzonRepository;
    const fetchMock = vi.fn(async () => emptyProductStatusResponse(offerIds));
    vi.stubGlobal('fetch', fetchMock);
    const service = new OzonPublishingService(repository, {} as PurchaseRepository, {} as FastifyBaseLogger);

    const dryRun = await service.recoverKnownPrePlatformFailure(fixture.job.id, {
      reason: 'TITLE_TRANSLATION_MAX_LENGTH_60_TO_200',
      rowVersion: fixture.job.rowVersion,
      listingRowVersion: 3,
      dryRun: true
    });
    expect(dryRun).toMatchObject({
      status: 'DRY_RUN',
      proposed: { jobState: 'SUBMITTING', retryCount: 0 },
      checks: {
        remoteState: {
          status: 'CONFIRMED_EMPTY', contractVersion: 2, requestedOfferIds: offerIds,
          absenceEvidence: { method: 'BOTH_ARRAYS_EMPTY' }
        },
        productJson: { status: 'MATCHED', expectedSignature: fixture.signature }
      }
    });

    const applied = await service.recoverKnownPrePlatformFailure(fixture.job.id, {
      reason: 'TITLE_TRANSLATION_MAX_LENGTH_60_TO_200',
      rowVersion: fixture.job.rowVersion,
      listingRowVersion: 3,
      dryRun: false
    });
    expect(applied).toMatchObject({
      status: 'RECOVERED',
      checks: {
        remoteState: { status: 'CONFIRMED_EMPTY', requestedOfferIds: offerIds },
        productJson: { status: 'MATCHED', expectedSignature: fixture.signature }
      }
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(await readFile(path.join(fixture.directory, 'product.json'), 'utf8')).toBe(productBefore);
  });

  it('rejects a signed late-title product.json whose identity or complete Offer set differs from the job', async () => {
    const offerIds = ['0000107-01', '0000107-02', '0000107-03'];
    const invalidProducts = [
      { schemaVersion: 2, productCode: '0000999', revision: 2, offers: offerIds.map((offerId) => ({ offerId })) },
      { schemaVersion: 2, productCode: '0000107', revision: 3, offers: offerIds.map((offerId) => ({ offerId })) },
      { schemaVersion: 2, productCode: '0000107', revision: 2, offers: offerIds.slice(0, 2).map((offerId) => ({ offerId })) },
      { schemaVersion: 2, productCode: '0000107', revision: 2, offers: offerIds.map(() => ({ offerId: offerIds[0] })) }
    ];
    for (const product of invalidProducts) {
      const fixture = await importRecoveryFixture(product, { sku: '0000107', offerIds, state: 'SUBMITTING' });
      const repository = {
        getJob: vi.fn(async () => fixture.job),
        getSettings: vi.fn(async () => ({
          rootDirectory: fixture.root,
          adminApiWebhookUrl: 'http://n8n.test/webhook/ozon-admin'
        })),
        recoverKnownPrePlatformFailure: recoveryRepositoryMethod(fixture.job, {
          jobState: 'SUBMITTING', retryCount: 0, titleTranslationMaxLength: 200
        })
      } as unknown as OzonRepository;
      vi.stubGlobal('fetch', vi.fn(async () => emptyProductStatusResponse(offerIds)));
      const service = new OzonPublishingService(repository, {} as PurchaseRepository, {} as FastifyBaseLogger);

      await expect(service.recoverKnownPrePlatformFailure(fixture.job.id, {
        reason: 'TITLE_TRANSLATION_MAX_LENGTH_60_TO_200',
        rowVersion: fixture.job.rowVersion,
        listingRowVersion: 3,
        dryRun: true
      })).rejects.toMatchObject({ code: 'VERSION_CONFLICT', statusCode: 409 });
    }
  });

  it('rechecks remote state and signed product descriptions before applying the v1-to-v2 false-positive recovery', async () => {
    const dispersedDescription = [
      'Сумка', 'мягкая', 'фактура', 'золотистого', 'оттенка', 'удобные', 'ручки',
      'сумка', 'прочная', 'молния', 'внутренняя', 'подкладка', 'ровные', 'строчки',
      'сумка', 'регулируемый', 'ремень', 'золотистого', 'цвета', 'надежная', 'застежка'
    ].join(' ');
    const fixture = await importRecoveryFixture({
      schemaVersion: 2,
      productCode: '0000105',
      revision: 2,
      descriptionRu: dispersedDescription,
      offers: [{ offerId: '0000105-01' }]
    });
    const recoverKnownPrePlatformFailure = recoveryRepositoryMethod(fixture.job);
    const repository = {
      getJob: vi.fn(async () => fixture.job),
      getSettings: vi.fn(async () => ({
        rootDirectory: fixture.root,
        adminApiWebhookUrl: 'http://n8n.test/webhook/ozon-admin'
      })),
      recoverKnownPrePlatformFailure
    } as unknown as OzonRepository;
    const fetchMock = vi.fn(async () => emptyProductStatusResponse());
    vi.stubGlobal('fetch', fetchMock);
    const service = new OzonPublishingService(repository, {} as PurchaseRepository, {} as FastifyBaseLogger);

    const dryRun = await service.recoverKnownPrePlatformFailure(fixture.job.id, {
      reason: 'DESCRIPTION_KEYWORD_STUFFING_FALSE_POSITIVE_V1_TO_V2',
      rowVersion: fixture.job.rowVersion,
      listingRowVersion: 4,
      dryRun: true
    });
    expect(dryRun.checks).toMatchObject({
      remoteState: { status: 'CONFIRMED_EMPTY', contractVersion: 2 },
      productJson: { status: 'MATCHED', expectedSignature: fixture.signature },
      contentPolicy: {
        status: 'MATCHED',
        policyVersion: 'merchroute-ozon-content-v2',
        legacyFalsePositive: true
      }
    });

    const applied = await service.recoverKnownPrePlatformFailure(fixture.job.id, {
      reason: 'DESCRIPTION_KEYWORD_STUFFING_FALSE_POSITIVE_V1_TO_V2',
      rowVersion: fixture.job.rowVersion,
      listingRowVersion: 4,
      dryRun: false
    });
    expect(applied).toMatchObject({
      status: 'RECOVERED',
      checks: { contentPolicy: { status: 'MATCHED', legacyFalsePositive: true } }
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    const markerNames = await readdir(fixture.directory);
    expect(markerNames).not.toContain('_ERROR.json');
  });

  it('rejects descriptions that are still invalid in v2 or have no legacy false-positive evidence', async () => {
    const dispersedDescription = [
      'Сумка', 'мягкая', 'фактура', 'золотистого', 'оттенка', 'удобные', 'ручки',
      'сумка', 'прочная', 'молния', 'внутренняя', 'подкладка', 'ровные', 'строчки',
      'сумка', 'регулируемый', 'ремень', 'золотистого', 'цвета', 'надежная', 'застежка'
    ].join(' ');
    const products = [
      { descriptionRu: 'Сумка сумка сумка', offers: [{ offerId: '0000105-01' }] },
      { descriptionRu: 'Описание товара с надежной застежкой', offers: [{ offerId: '0000105-01' }] },
      {
        descriptionRu: dispersedDescription,
        offers: [{ offerId: '0000105-01', descriptionRu: 'Сумка сумка сумка' }]
      }
    ];
    for (const product of products) {
      const fixture = await importRecoveryFixture({ schemaVersion: 2, productCode: '0000105', revision: 2, ...product });
      const repository = {
        getJob: vi.fn(async () => fixture.job),
        getSettings: vi.fn(async () => ({
          rootDirectory: fixture.root,
          adminApiWebhookUrl: 'http://n8n.test/webhook/ozon-admin'
        })),
        recoverKnownPrePlatformFailure: recoveryRepositoryMethod(fixture.job)
      } as unknown as OzonRepository;
      vi.stubGlobal('fetch', vi.fn(async () => emptyProductStatusResponse()));
      const service = new OzonPublishingService(repository, {} as PurchaseRepository, {} as FastifyBaseLogger);

      await expect(service.recoverKnownPrePlatformFailure(fixture.job.id, {
        reason: 'DESCRIPTION_KEYWORD_STUFFING_FALSE_POSITIVE_V1_TO_V2',
        rowVersion: fixture.job.rowVersion,
        listingRowVersion: 4,
        dryRun: false
      })).rejects.toMatchObject({ code: 'CONFIG_INVALID' });
      expect(await readFile(path.join(fixture.directory, '_ERROR.json'), 'utf8')).toContain(fixture.job.id);
    }
  });
});

async function importRecoveryFixture(
  productInput?: Record<string, unknown>,
  overrides: { sku?: string; offerIds?: string[]; state?: OzonPublishJob['state'] } = {}
) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'merchroute-ozon-known-recovery-'));
  roots.push(root);
  const sku = overrides.sku || '0000105';
  const revision = 2;
  const id = randomUUID();
  const taskFolder = `${sku}__r${revision}`;
  const directory = path.join(root, 'processing', taskFolder);
  await mkdir(directory, { recursive: true });
  const product = productInput || { schemaVersion: 2, productCode: sku, revision, offers: [{ offerId: `${sku}-01` }] };
  const signature = `sha256:${createHash('sha256').update(JSON.stringify(product)).digest('hex')}`;
  await writeFile(path.join(directory, 'product.json'), JSON.stringify(product));
  await writeFile(path.join(directory, '.ozon-intake.json'), JSON.stringify({ jobId: id, sku, revision, signature }));
  await writeFile(path.join(directory, '_ERROR.json'), JSON.stringify({ jobId: id, sku, revision }));
  const job = {
    id,
    sku,
    source: 'AUTO',
    state: overrides.state || 'NEEDS_ATTENTION',
    storeAlias: 'default',
    offerIds: overrides.offerIds || [`${sku}-01`],
    ozonProductLinks: [],
    stageStates: { import: 'PENDING' },
    retryCount: 3,
    rowVersion: 22,
    revision,
    listingRevision: revision,
    taskId: id,
    taskFolder,
    workRelPath: `processing/${taskFolder}`,
    directoryStage: 'PROCESSING',
    directorySignature: signature,
    payload: {},
    createdAt: '2026-08-08T00:00:00.000Z',
    updatedAt: '2026-08-08T00:00:00.000Z'
  } as OzonPublishJob;
  return { root, directory, signature, job };
}

function recoveryRepositoryMethod(
  job: OzonPublishJob,
  titleProposal: { jobState: 'READY' | 'SUBMITTING'; retryCount: number; titleTranslationMaxLength: number } = {
    jobState: 'READY', retryCount: 0, titleTranslationMaxLength: 200
  }
) {
  return vi.fn(async (
    _id: string,
    input: OzonKnownPrePlatformFailureRecoveryInput,
    beforeCommit?: (lockedJob: OzonPublishJob) => Promise<OzonKnownPrePlatformFailureRecoveryChecks>
  ) => {
    const proposed = input.reason === 'TITLE_TRANSLATION_MAX_LENGTH_60_TO_200'
      ? titleProposal
      : {
          jobState: 'SUBMITTING' as const,
          listingState: 'SUBMITTING' as const,
          retryCount: job.retryCount
        };
    if (input.dryRun) {
      return {
        status: 'DRY_RUN' as const,
        reason: input.reason,
        dryRun: true,
        previous: { jobRowVersion: job.rowVersion, ...(input.listingRowVersion ? { listingRowVersion: input.listingRowVersion } : {}) },
        proposed,
        job
      };
    }
    if (!beforeCommit) throw new Error('beforeCommit required');
    const checks = await beforeCommit(job);
    return {
      status: 'RECOVERED' as const,
      reason: input.reason,
      dryRun: false,
      previous: { jobRowVersion: job.rowVersion, ...(input.listingRowVersion ? { listingRowVersion: input.listingRowVersion } : {}) },
      proposed,
      checks,
      job
    };
  });
}

function emptyProductStatusResponse(offerIds: string[] = ['0000105-01']): Response {
  return new Response(JSON.stringify({
    ok: true,
    httpStatus: 200,
    result: {
      contractVersion: 2,
      requestedOfferIds: offerIds,
      readAt: '2026-08-08T00:30:00.000Z',
      infoItems: [],
      attributeItems: [],
      operations: [
        {
          operation: 'infoList', requestId: 'productStatus:infoList', ok: true, upstreamOk: true,
          statusCode: 200, outcome: 'EMPTY', resultShape: 'ARRAY', itemCount: 0
        },
        {
          operation: 'attributesInfo', requestId: 'productStatus:attributesInfo', ok: true, upstreamOk: true,
          statusCode: 200, outcome: 'EMPTY', resultShape: 'ARRAY', itemCount: 0
        }
      ],
      absenceEvidence: {
        method: 'BOTH_ARRAYS_EMPTY',
        infoList: { statusCode: 200, resultShape: 'ARRAY', itemCount: 0 },
        attributesInfo: { statusCode: 200, resultShape: 'ARRAY', itemCount: 0 }
      }
    }
  }), { status: 200, headers: { 'Content-Type': 'application/json' } });
}
