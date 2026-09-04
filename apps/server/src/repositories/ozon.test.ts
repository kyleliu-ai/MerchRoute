import { createHash, randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { ozonCategoryTemplateInputSchema, ozonPresetInputSchema } from '@n8n-media-review/shared';
import {
  assertCompatibleAppendRemoteAbsenceEvidence,
  assertFrozenOzonPublicationRuntimeInput,
  assertOzonOfferContractTransition,
  assertOzonGrossWeightLinkage,
  assertOzonPresetDefinitionMatchesCategory,
  createOzonTargetedRecoveryLedgerAudit,
  isBoundDurablyAcceptedAutomaticMediaReplay,
  markChangedOzonDescriptionsManual,
  OzonRepository,
  sameOzonPrePlanTimestamp
} from './ozon.js';
import {
  normalizeOzonRfbsStockMismatchCallback,
  OZON_RFBS_STOCK_READBACK_NORMALIZED_EVENT
} from '../services/ozon-publishing/rfbs-stock-callback.js';
import { ozonPreparationGatewayBoundaryLockKey } from '../ozon-preparation-gateway-boundary.js';

const sizedCategorySnapshot = ozonCategoryTemplateInputSchema.parse({
  categoryKey: 'ozon_15621048_91248',
  nameRu: 'Кроссовки',
  nameZh: '运动鞋',
  descriptionCategoryId: 15621048,
  typeId: 91248,
  attributes: [{
    id: 4298,
    name: 'Российский размер',
    nameRu: 'Российский размер',
    nameZh: '俄罗斯尺码',
    type: 'String',
    required: true,
    dictionaryId: 361,
    complexId: 0
  }],
  dictionarySnapshot: {
    '4298': [
      { id: 40, value: '40 中文 / 40 RU', valueRu: '40 RU', valueZh: '40 中文' },
      { id: 41, value: '41 中文 / 41 RU', valueRu: '41 RU', valueZh: '41 中文' }
    ]
  },
  sizing: { sizeMode: 'sized', sizeAttributeKey: '4298:0' }
});

const sizedPresetDefinition = ozonPresetInputSchema.parse({
  name: 'OZON 运动鞋预设',
  categoryKey: sizedCategorySnapshot.categoryKey,
  pricingTemplateId: '10000000-0000-4000-8000-000000000001',
  shippingTemplateId: '10000000-0000-4000-8000-000000000002',
  shippingServiceCode: 'CEL_RFBS_ECONOMY',
  dimensions: { length: 30, width: 20, height: 12, dimensionUnit: 'cm', weight: 700, weightUnit: 'g' },
  sizeAttributeKey: '4298:0',
  sizes: [
    { sizeId: '10000000-0000-4000-8000-000000000040', value: 'dict:40', stock: 8 },
    { sizeId: '10000000-0000-4000-8000-000000000041', value: 'dict:41', stock: 5 }
  ]
});

describe('OZON preset published-category sizing guard', () => {
  it('accepts valid #4298 dictionary-backed size rows', () => {
    expect(() => assertOzonPresetDefinitionMatchesCategory(sizedPresetDefinition, sizedCategorySnapshot)).not.toThrow();
  });

  it('rejects a size key for a sizeless published category', () => {
    expect(() => assertOzonPresetDefinitionMatchesCategory(sizedPresetDefinition, {
      ...sizedCategorySnapshot,
      sizing: { sizeMode: 'sizeless' }
    })).toThrow('无尺码商品发布');
  });

  it('rejects a preset size key that differs from the published category rule', () => {
    expect(() => assertOzonPresetDefinitionMatchesCategory({
      ...sizedPresetDefinition,
      sizeAttributeKey: '9533:0'
    }, sizedCategorySnapshot)).toThrow('必须与已发布类目规则一致');
  });

  it('rejects a dictionary value outside the frozen size snapshot', () => {
    expect(() => assertOzonPresetDefinitionMatchesCategory({
      ...sizedPresetDefinition,
      sizes: [{ ...sizedPresetDefinition.sizes[0]!, value: 'dict:99' }]
    }, sizedCategorySnapshot)).toThrow('不是当前类目快照中的有效字典值');
  });

  it('rejects duplicating the selected size in ordinary category attributes', () => {
    expect(() => assertOzonPresetDefinitionMatchesCategory({
      ...sizedPresetDefinition,
      sharedAttributes: [{ attributeId: 4298, complexId: 0, values: [{ dictionaryValueId: 40 }] }]
    }, sizedCategorySnapshot)).toThrow('不能在普通目录属性中重复提交');
  });
});

describe('OZON preset published-category required attribute guard', () => {
  const category = ozonCategoryTemplateInputSchema.parse({
    ...sizedCategorySnapshot,
    attributes: [
      ...sizedCategorySnapshot.attributes,
      {
        id: 31, name: 'Бренд в одежде и обуви', nameRu: 'Бренд в одежде и обуви', nameZh: '服装和鞋类品牌',
        type: 'String', required: true, dictionaryId: 28732849, complexId: 0
      },
      {
        id: 9163, name: 'Пол', nameRu: 'Пол', nameZh: '性别',
        type: 'String', required: true, dictionaryId: 320, complexId: 0
      },
      {
        id: 8292, name: 'Объединить на одной карточке', nameRu: 'Объединить на одной карточке', nameZh: '合并至一张卡片',
        type: 'String', required: true, dictionaryId: 0, complexId: 0
      }
    ]
  });

  it('accepts system-managed #31/#8292 but requires explicit preset gender #9163', () => {
    const withGender = {
      ...sizedPresetDefinition,
      sharedAttributes: [{ attributeId: 9163, complexId: 0, values: [{ dictionaryValueId: 22880 }] }]
    };
    expect(() => assertOzonPresetDefinitionMatchesCategory(withGender, category)).not.toThrow();
    expect(() => assertOzonPresetDefinitionMatchesCategory(sizedPresetDefinition, category))
      .toThrow('性别 / Пол · #9163');
  });
});

describe('OZON PRE_PLAN timestamp identity', () => {
  it('compares the timestamp instant instead of PostgreSQL and JSON fractional formatting', () => {
    expect(sameOzonPrePlanTimestamp('2026-08-13T10:19:19.480Z', '2026-08-13T10:19:19.48Z')).toBe(true);
    expect(sameOzonPrePlanTimestamp('2026-08-13 10:19:19+00', '2026-08-13T10:19:19.000Z')).toBe(true);
    expect(sameOzonPrePlanTimestamp('2026-08-13T10:19:19.481Z', '2026-08-13T10:19:19.480Z')).toBe(false);
    expect(sameOzonPrePlanTimestamp('invalid', '2026-08-13T10:19:19.480Z')).toBe(false);
  });
});

describe('OZON shared preparation recheck admission', () => {
  it('does not require the removed global credential fallback for a storeless shared preparation', async () => {
    const repository = new OzonRepository();
    const job = {
      id: '50000000-0000-4000-8000-000000000132',
      sku: '0000132',
      state: 'WAITING_MEDIA',
      source: 'AUTO',
      taskKind: 'SHARED_PREPARATION',
      payload: { multistorePreparation: true },
      rowVersion: 24
    };
    vi.spyOn(repository, 'getJob').mockResolvedValue(job as any);
    vi.spyOn(repository, 'getSettings').mockResolvedValue({
      enabled: true,
      credentialReady: false,
      taskApiWebhookUrl: undefined
    } as any);
    const transition = vi.spyOn(repository, 'transitionJob').mockResolvedValue({ ...job, state: 'READY', rowVersion: 25 } as any);

    await expect(repository.recheck(job.id, 'AUTO', 24)).resolves.toMatchObject({ state: 'READY', rowVersion: 25 });
    expect(transition).toHaveBeenCalledWith(job.id, expect.objectContaining({
      rowVersion: 24,
      state: 'READY',
      eventType: 'JOB_RECHECKED'
    }));
  });

  it('continues requiring the legacy global runtime binding for non-preparation jobs', async () => {
    const repository = new OzonRepository();
    const job = {
      id: '50000000-0000-4000-8000-000000000133',
      sku: '0000133',
      state: 'NEEDS_ATTENTION',
      source: 'AUTO',
      taskKind: 'LEGACY',
      payload: {},
      rowVersion: 3
    };
    vi.spyOn(repository, 'getJob').mockResolvedValue(job as any);
    vi.spyOn(repository, 'getSettings').mockResolvedValue({
      enabled: true,
      credentialReady: false,
      taskApiWebhookUrl: undefined
    } as any);
    const transition = vi.spyOn(repository, 'transitionJob').mockResolvedValue({ ...job, state: 'WAITING_MEDIA', rowVersion: 4 } as any);

    await expect(repository.recheck(job.id, 'AUTO', 3)).resolves.toMatchObject({ state: 'WAITING_MEDIA' });
    expect(transition).toHaveBeenCalledWith(job.id, expect.objectContaining({ state: 'WAITING_MEDIA' }));
  });
});

describe('OZON automatic preparation manual-success reconciliation CAS', () => {
  const requestId = '17000000-0000-5000-8000-000000000170';
  const planHash = `sha256:${'a'.repeat(64)}`;
  const baseRow = {
    id: '5f848e98-f28a-4bcc-8f1d-2fab1bae0b7a',
    sku: '0000170',
    state: 'CANCELLED',
    source: 'AUTO',
    task_kind: 'SHARED_PREPARATION',
    store_alias: 'default',
    offer_ids: [],
    product_links: [],
    stage_states: {},
    retry_count: 0,
    row_version: 8,
    payload: {
      multistorePreparation: true,
      manualSuccessReconciliation: {
        requestId,
        planHash,
        appliedAt: '2026-09-04T02:10:00.000Z',
        targetStores: []
      }
    },
    created_at: '2026-09-04T01:00:00.000Z',
    updated_at: '2026-09-04T02:10:00.000Z'
  };

  it('returns the existing marker idempotently without touching listing or publication rows', async () => {
    const query = vi.fn(async (sqlInput: unknown) => {
      const sql = String(sqlInput);
      if (sql.includes('SELECT sku FROM ozon_publish_jobs')) return { rows: [{ sku: baseRow.sku }] };
      if (sql.includes('pg_advisory_xact_lock')) return { rows: [] };
      if (sql.includes('SELECT * FROM ozon_publish_jobs WHERE id=$1 FOR UPDATE')) return { rows: [baseRow] };
      throw new Error(`unexpected idempotent reconciliation query: ${sql}`);
    });
    const repository = new OzonRepository('postgres://not-used');
    Object.defineProperty(repository, 'transaction', {
      value: async (operation: (client: unknown) => Promise<unknown>) => operation({ query })
    });

    await expect(repository.reconcileAutomaticPreparationToManualSuccess({
      jobId: baseRow.id,
      expectedJobRowVersion: 7,
      expectedListingRowVersion: 11,
      expectedListingRevision: 5,
      eligibilityAt: '2026-09-04T02:00:00.000Z',
      requestId,
      planHash,
      targetStores: []
    })).resolves.toMatchObject({
      job: { id: baseRow.id, state: 'CANCELLED', rowVersion: 8 },
      reconciliation: { requestId, planHash, appliedAt: '2026-09-04T02:10:00.000Z' }
    });
    expect(query.mock.calls.some(([sql]) => /ozon_listing_drafts|ozon_store_publications|^\s*UPDATE\b/i.test(String(sql)))).toBe(false);
  });

  it('rejects a stale job rowVersion before reading manual listing evidence', async () => {
    const staleRow = {
      ...baseRow,
      state: 'NEEDS_ATTENTION',
      payload: { multistorePreparation: true }
    };
    const query = vi.fn(async (sqlInput: unknown) => {
      const sql = String(sqlInput);
      if (sql.includes('SELECT sku FROM ozon_publish_jobs')) return { rows: [{ sku: staleRow.sku }] };
      if (sql.includes('pg_advisory_xact_lock')) return { rows: [] };
      if (sql.includes('SELECT * FROM ozon_publish_jobs WHERE id=$1 FOR UPDATE')) return { rows: [staleRow] };
      throw new Error(`unexpected stale reconciliation query: ${sql}`);
    });
    const repository = new OzonRepository('postgres://not-used');
    Object.defineProperty(repository, 'transaction', {
      value: async (operation: (client: unknown) => Promise<unknown>) => operation({ query })
    });

    await expect(repository.reconcileAutomaticPreparationToManualSuccess({
      jobId: staleRow.id,
      expectedJobRowVersion: 7,
      expectedListingRowVersion: 11,
      expectedListingRevision: 5,
      eligibilityAt: '2026-09-04T02:00:00.000Z',
      requestId,
      planHash,
      targetStores: []
    })).rejects.toMatchObject({ code: 'TASK_LOCKED' });
    expect(query.mock.calls.some(([sql]) => String(sql).includes('ozon_listing_drafts'))).toBe(false);
  });
});

describe('OZON automatic business task projection', () => {
  it('excludes every shared preparation row and projects fully archived publications out of attention counts', async () => {
    const repository = new OzonRepository();
    const query = vi.spyOn(repository as any, 'query');
    query
      .mockResolvedValueOnce({ rows: [{ count: '0' }] })
      .mockResolvedValueOnce({ rows: [] });

    await repository.listJobs({ source: 'AUTO', businessOnly: true });

    expect(String(query.mock.calls[0]?.[0])).toContain("COALESCE(j.payload->>'multistorePreparation','false')='true'");
    expect(String(query.mock.calls[0]?.[0])).toContain("<>'SHARED_PREPARATION'");
    expect(String(query.mock.calls[0]?.[0])).not.toContain("j.state NOT IN ('NEEDS_ATTENTION','FAILED','CANCELLED')");
    expect(String(query.mock.calls[1]?.[0])).toContain("COALESCE(j.payload->>'multistorePreparation','false')='true'");

    query.mockReset().mockResolvedValueOnce({ rows: [
      { state: 'ARCHIVED', count: '2' },
      { state: 'NEEDS_ATTENTION', count: '1' }
    ] });
    await expect(repository.stats('AUTO', true)).resolves.toEqual({ ARCHIVED: 2, NEEDS_ATTENTION: 1 });
    const statsSql = String(query.mock.calls[0]?.[0]);
    expect(statsSql).toContain("COALESCE(job.payload->>'multistorePreparation','false')='true'");
    expect(statsSql).toContain('jsonb_array_elements_text');
    expect(statsSql).toContain('LEFT JOIN ozon_product_mappings mapping');
    expect(statsSql).toContain("job.state='NEEDS_ATTENTION'");
    expect(statsSql).toContain('job.publication_id IS NOT NULL');
    expect(statsSql).toContain("job.last_error_code IN ('OZON_PLATFORM_NEEDS_ATTENTION','OZON_PLATFORM_STATUS_ABNORMAL')");
    expect(statsSql).toContain('mapping.last_verified_at<job.created_at');
    expect(statsSql).toContain("mapping.status_snapshot->>'displayState'");
    expect(statsSql).toContain("<>'ARCHIVED'");
    expect(query.mock.calls[0]?.[1]).toEqual(['AUTO']);
  });

  it('uses the same business-only predicate for manual task history', async () => {
    const repository = new OzonRepository();
    const query = vi.spyOn(repository as any, 'query');
    query
      .mockResolvedValueOnce({ rows: [{ count: '0' }] })
      .mockResolvedValueOnce({ rows: [] });

    await repository.listManualJobsForSku('0000133');

    const countSql = String(query.mock.calls[0]?.[0]);
    const itemsSql = String(query.mock.calls[1]?.[0]);
    expect(countSql).toContain("j.source=$1");
    expect(countSql).toContain("<>'SHARED_PREPARATION'");
    expect(itemsSql).toContain("<>'SHARED_PREPARATION'");
    expect(query.mock.calls[0]?.[1]?.slice(0, 2)).toEqual(['MANUAL', '0000133']);
  });

  it('projects only the frozen preset name and publication mode into automatic list rows', async () => {
    const repository = new OzonRepository();
    const query = vi.spyOn(repository as any, 'query');
    query
      .mockResolvedValueOnce({ rows: [{ count: '1' }] })
      .mockResolvedValueOnce({ rows: [{
        id: '11111111-1111-4111-8111-111111111111',
        sku: '0000141',
        offer_ids: ['0000141-01'],
        state: 'SUCCEEDED',
        source: 'AUTO',
        task_kind: 'STORE_PUBLICATION',
        store_alias: 'tek-plus',
        store_id: '21111111-1111-4111-8111-111111111111',
        publication_id: '31111111-1111-4111-8111-111111111111',
        payload: { presetName: '冻结自动预设' },
        summary_preset_id: '41111111-1111-4111-8111-111111111111',
        summary_preset_row_version: 9,
        summary_publication_mode: 'COMPATIBLE_UPSERT',
        summary_source_preset_id: null,
        stage_states: {}, retry_count: 0, row_version: 5,
        created_at: '2026-08-14T00:00:00.000Z', updated_at: '2026-08-14T01:00:00.000Z'
      }] })
      .mockResolvedValueOnce({ rows: [] });

    const response = await repository.listJobs({ source: 'AUTO', businessOnly: true });

    expect(response.items[0]).toMatchObject({
      publicationMode: 'COMPATIBLE_UPSERT',
      presetBinding: {
        presetName: '冻结自动预设',
        presetRowVersion: 9,
        sourcePresetExists: false
      }
    });
    expect(String(query.mock.calls[1]?.[0])).toContain('publication.materialized_product_snapshot summary_materialized_product_snapshot');
  });
});

describe('OZON publication runtime frozen identity', () => {
  const current = {
    id: '50000000-0000-4000-8000-000000000001',
    sku: '9900002',
    publication_id: '10000000-0000-4000-8000-000000000001',
    store_id: '00000000-0000-4000-8000-000000000002',
    store_alias: 'default',
    task_id: 'default__9900002__r4',
    credential_version_id: '20000000-0000-4000-8000-000000000001',
    credential_binding_mode: 'VAULT',
    store_config_version: 3,
    warehouse_id: 'warehouse-1',
    offer_contract_hash: `sha256:${'1'.repeat(64)}`,
    materialization_hash: `sha256:${'2'.repeat(64)}`,
    listing_revision: 4,
    directory_stage: 'INBOX',
    offer_ids: ['9900002-01'],
    work_rel_path: 'stores/default/inbox/9900002',
    task_folder: '9900002__r4',
    payload: { schemaVersion: 3, mode: 'MULTISTORE_PUBLICATION' }
  };
  const input = {
    rowVersion: 7,
    state: 'SUBMITTING' as const,
    eventType: 'RUNTIME_UPDATED',
    message: 'test',
    taskId: current.task_id,
    storeAlias: current.store_alias,
    warehouseId: current.warehouse_id,
    offerIds: ['9900002-01'],
    revision: 4,
    lastAppliedRevision: 4,
    directoryStage: 'PROCESSING' as const,
    taskFolder: '9900002__r4',
    workRelPath: 'processing/default__9900002__r4',
    productMappings: [{ offerId: '9900002-01', ozonProductId: '501', warehouseId: 'warehouse-1' }],
    jobPayload: {
      taskId: current.task_id,
      storeId: current.store_id,
      storeAlias: current.store_alias,
      publicationId: current.publication_id,
      credentialVersionId: current.credential_version_id,
      credentialBindingMode: current.credential_binding_mode,
      storeConfigVersion: 3,
      warehouseId: current.warehouse_id,
      offerContractHash: current.offer_contract_hash,
      materializationHash: current.materialization_hash,
      revision: 4
    }
  };

  it('derives the only allowed task/path/revision/store snapshot', () => {
    expect(assertFrozenOzonPublicationRuntimeInput(current, input)).toEqual({
      taskId: 'default__9900002__r4',
      storeAlias: 'default',
      warehouseId: 'warehouse-1',
      revision: 4,
      taskFolder: '9900002__r4',
      directoryStage: 'PROCESSING',
      workRelPath: 'processing/default__9900002__r4'
    });
  });

  it('accepts only the exact dated central success path for a succeeded publication callback', () => {
    const workRelPath = 'success/2026-08-11/default__9900002__r4';
    expect(assertFrozenOzonPublicationRuntimeInput(current, {
      ...input,
      state: 'SUCCEEDED',
      directoryStage: 'SUCCESS',
      workRelPath,
      jobPayload: {
        ...input.jobPayload,
        directoryStage: 'SUCCESS',
        workRelPath
      }
    })).toEqual({
      taskId: 'default__9900002__r4',
      storeAlias: 'default',
      warehouseId: 'warehouse-1',
      revision: 4,
      taskFolder: '9900002__r4',
      directoryStage: 'SUCCESS',
      workRelPath
    });
  });

  it('rejects a non-terminal callback that tries to claim a dated success path', () => {
    const workRelPath = 'success/2026-08-11/default__9900002__r4';
    expect(() => assertFrozenOzonPublicationRuntimeInput(current, {
      ...input,
      state: 'MODERATING',
      directoryStage: 'SUCCESS',
      workRelPath,
      jobPayload: {
        ...input.jobPayload,
        directoryStage: 'SUCCESS',
        workRelPath
      }
    })).toThrowError(/冻结身份/);
  });

  it.each([
    ['missing date', 'success/default__9900002__r4', undefined],
    ['invalid date', 'success/2026-02-30/default__9900002__r4', undefined],
    ['cross store', 'success/2026-08-11/2466679__9900002__r4', undefined],
    ['extra segment', 'success/2026-08-11/extra/default__9900002__r4', undefined],
    ['wrong task folder', 'success/2026-08-11/default__9900002__r5', undefined],
    ['payload disagreement', 'success/2026-08-11/default__9900002__r4', 'success/2026-08-12/default__9900002__r4']
  ])('rejects a succeeded publication callback with %s', (_case, workRelPath, payloadPath) => {
    expect(() => assertFrozenOzonPublicationRuntimeInput(current, {
      ...input,
      state: 'SUCCEEDED',
      directoryStage: 'SUCCESS',
      workRelPath,
      jobPayload: {
        ...input.jobPayload,
        directoryStage: 'SUCCESS',
        workRelPath: payloadPath ?? workRelPath
      }
    })).toThrowError(/冻结身份/);
  });

  it.each([
    ['taskId', { taskId: 'attacker__9900002__r4' }],
    ['storeAlias', { storeAlias: 'attacker' }],
    ['warehouseId', { warehouseId: 'warehouse-other' }],
    ['revision', { revision: 5 }],
    ['taskFolder', { taskFolder: 'attacker__9900002__r4' }],
    ['workRelPath', { workRelPath: 'stores/attacker/processing/9900002__r4' }],
    ['offerIds', { offerIds: ['9900002-02'] }],
    ['payload offerIds', { jobPayload: { ...input.jobPayload, offerIds: ['9900002-02'] } }],
    ['mapping warehouse', { productMappings: [{ offerId: '9900002-01', ozonProductId: '501', warehouseId: 'warehouse-other' }] }]
  ])('rejects caller drift in %s', (_field, override) => {
    expect(() => assertFrozenOzonPublicationRuntimeInput(current, { ...input, ...override }))
      .toThrowError(/冻结身份/);
  });

  it('keeps a lone schema-v3 publication binding hash out of the dual-set parser', () => {
    expect(assertOzonOfferContractTransition(
      { schemaVersion: 3, mode: 'MULTISTORE_PUBLICATION', offerContractHash: current.offer_contract_hash },
      {},
      ['9900002-01']
    )).toBeUndefined();
    expect(assertOzonOfferContractTransition(
      { schemaVersion: 3, mode: 'MULTISTORE_PUBLICATION', offerContractHash: current.offer_contract_hash },
      { offerContractHash: current.offer_contract_hash },
      ['9900002-01']
    )).toBeUndefined();
    expect(() => assertOzonOfferContractTransition(
      { schemaVersion: 3, mode: 'MULTISTORE_PUBLICATION', offerContractHash: current.offer_contract_hash },
      { offerContractHash: `sha256:${'f'.repeat(64)}` },
      ['9900002-01']
    )).toThrowError(/不允许修改/);
  });

  it('still fails closed when any semantic dual-set field is only partially supplied', () => {
    expect(() => assertOzonOfferContractTransition(
      { schemaVersion: 3, mode: 'MULTISTORE_PUBLICATION', offerContractHash: current.offer_contract_hash },
      { expectedOfferIds: ['9900002-01'] },
      ['9900002-01']
    )).toThrowError(/字段不完整/);
    expect(() => assertOzonOfferContractTransition(
      { offerContractHash: current.offer_contract_hash },
      {},
      ['9900002-01']
    )).toThrowError(/字段不完整/);
  });

  it('leaves a pre-v3 historical legacy bootstrap on its compatibility path', () => {
    expect(assertFrozenOzonPublicationRuntimeInput({ ...current, payload: { schemaVersion: 2 } }, input)).toBeUndefined();
  });
});

describe('OZON store-aware job projection', () => {
  it('maps every frozen store/publication/runtime identity from the SQL row', async () => {
    const jobId = '50000000-0000-4000-8000-000000000001';
    const row = {
      id: jobId,
      sku: '0000119',
      state: 'READY',
      source: 'AUTO',
      store_alias: 'default',
      store_id: '00000000-0000-4000-8000-000000000002',
      publication_id: '10000000-0000-4000-8000-000000000001',
      credential_version_id: '20000000-0000-4000-8000-000000000001',
      credential_binding_mode: 'VAULT',
      store_config_version: 4,
      warehouse_id: '1020002456503000',
      offer_contract_hash: `sha256:${'1'.repeat(64)}`,
      materialization_hash: `sha256:${'2'.repeat(64)}`,
      offer_ids: ['0000119-01'],
      product_links: [],
      payload: {},
      stage_states: {},
      retry_count: 0,
      row_version: 7,
      created_at: '2026-08-11T08:00:00.000Z',
      updated_at: '2026-08-11T08:01:00.000Z'
    };
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [row], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 });
    const repository = new OzonRepository('postgres://not-used');
    Object.defineProperty(repository, 'query', { value: query });

    await expect(repository.getJob(jobId, 'AUTO')).resolves.toMatchObject({
      id: jobId,
      storeId: row.store_id,
      publicationId: row.publication_id,
      credentialVersionId: row.credential_version_id,
      credentialBindingMode: 'VAULT',
      storeConfigVersion: 4,
      warehouseId: row.warehouse_id,
      offerContractHash: row.offer_contract_hash,
      materializationHash: row.materialization_hash
    });
  });
});

describe('OZON automatic media delivery evidence', () => {
  it('uses the durable ledger timestamp for a stable stage/submission/variant identity', async () => {
    const repository = new OzonRepository('postgres://not-used');
    const query = vi.fn(async () => ({ rows: [{
      source_stage_id: 'E004',
      submission_id: '2ff225f7-fce2-4078-9408-8b454b6c979c',
      variant_id: '89b51b14-279c-4bf7-8510-e001ccc33fb5',
      job_id: '096f4dec-b56b-43f8-bfba-8bed0c8392a9',
      updated_at: new Date('2026-08-12T01:31:32.000Z'),
      payload: {
        sourceStageId: 'E004',
        submissionId: '2ff225f7-fce2-4078-9408-8b454b6c979c',
        variantId: '89b51b14-279c-4bf7-8510-e001ccc33fb5',
        deliveredAt: '2026-08-12T01:31:31.469Z',
        autoPublishDecision: 'ACCEPTED'
      }
    }] }));
    Object.defineProperty(repository, 'query', { value: query });

    await expect(repository.resolveAutomaticMediaDeliveryEvidence({
      sku: '0000121',
      identities: [{
        sourceStageId: 'E004',
        submissionId: '2ff225f7-fce2-4078-9408-8b454b6c979c',
        variantId: '89b51b14-279c-4bf7-8510-e001ccc33fb5'
      }]
    })).resolves.toEqual([{
      sourceStageId: 'E004',
      submissionId: '2ff225f7-fce2-4078-9408-8b454b6c979c',
      variantId: '89b51b14-279c-4bf7-8510-e001ccc33fb5',
      deliveredAt: '2026-08-12T01:31:31.469Z',
      decision: 'ACCEPTED',
      jobId: '096f4dec-b56b-43f8-bfba-8bed0c8392a9',
      payloadHash: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
      updatedAt: '2026-08-12T01:31:32.000Z'
    }]);
  });

  it('fails closed when the referenced ledger identity or decision is no longer admissible', async () => {
    const repository = new OzonRepository('postgres://not-used');
    Object.defineProperty(repository, 'query', { value: vi.fn(async () => ({ rows: [] })) });
    await expect(repository.resolveAutomaticMediaDeliveryEvidence({
      sku: '0000121',
      identities: [{ sourceStageId: 'E005', submissionId: 'missing', variantId: 'variant' }]
    })).rejects.toMatchObject({ code: 'OZON_MEDIA_DELIVERY_IDENTITY_DRIFT' });
  });
});

describe('OZON RFBS normalized runtime update authority', () => {
  it('accepts the normalized event only when the locked job, listing, and mappings match the internal attestation', async () => {
    const fixture = createRepositoryRfbsNormalizationFixture();
    const { repository, query, mutationQueries } = createRfbsNormalizationRepository(fixture);

    const result = await repository.recordN8nUpdate(fixture.jobRow.id as string, fixture.normalizedInput);

    expect(result.job).toMatchObject({
      id: fixture.jobRow.id,
      state: 'SUCCEEDED',
      rowVersion: 28,
      revision: 4,
      taskFolder: '0000105__r4',
      directoryStage: 'SUCCESS',
      workRelPath: expect.stringMatching(/^success\/\d{4}-\d{2}-\d{2}\/0000105__r4$/),
      directorySignature: `sha256:${'a'.repeat(64)}`
    });
    expect(result.mappings).toHaveLength(1);
    expect(query.mock.calls.some(([sql]) => String(sql).includes('UPDATE ozon_publish_jobs'))).toBe(true);
    const normalizedEvent = query.mock.calls.find(([sql, values]) => (
      String(sql).includes('INSERT INTO ozon_publish_events')
      && Array.isArray(values)
      && values[2] === OZON_RFBS_STOCK_READBACK_NORMALIZED_EVENT
    ));
    expect(normalizedEvent).toBeDefined();
    const mediaUpdates = query.mock.calls.filter(([sql]) => String(sql).includes('UPDATE ozon_media_deliveries'));
    expect(mediaUpdates).toHaveLength(1);
    expect(mediaUpdates[0]?.[1]?.slice(0, 5)).toEqual([
      '0000105', 'E005', 'rfbs-images-submission', 'variant-1', fixture.jobRow.id
    ]);
    const consumedEvent = query.mock.calls.find(([sql, values]) => (
      String(sql).includes('INSERT INTO ozon_publish_events')
      && Array.isArray(values)
      && values[2] === 'AUTO_MEDIA_CONSUMED_REMOTE'
    ));
    expect(consumedEvent).toBeDefined();
    expect(fixture.deliveryRows[0]?.payload).toMatchObject({
      autoPublishDecision: 'CONSUMED_REMOTE',
      representedOfferIds: ['0000105-01'],
      consumedByAutomaticJobId: fixture.jobRow.id
    });
    expect(fixture.deliveryRows[1]?.payload).toMatchObject({ autoPublishDecision: 'ACCEPTED' });
    expect(mutationQueries()).not.toHaveLength(0);
  });

  it('rejects a bound automatic delivery ownership drift before any success mutation', async () => {
    const fixture = createRepositoryRfbsNormalizationFixture();
    fixture.deliveryRows[0]!.job_id = randomUUID();
    const { repository, mutationQueries } = createRfbsNormalizationRepository(fixture);

    await expect(repository.recordN8nUpdate(
      fixture.jobRow.id as string,
      fixture.normalizedInput
    )).rejects.toMatchObject({ code: 'TASK_LOCKED', statusCode: 409 });
    expect(mutationQueries()).toHaveLength(0);
    expect(fixture.deliveryRows[1]?.payload).toMatchObject({ autoPublishDecision: 'ACCEPTED' });
  });

  it('rejects a normalized event without the internal attestation before any state or event mutation', async () => {
    const fixture = createRepositoryRfbsNormalizationFixture();
    const withoutAttestation = { ...fixture.normalizedInput };
    delete withoutAttestation.rfbsStockReadbackAttestation;
    const { repository, mutationQueries } = createRfbsNormalizationRepository(fixture);

    await expect(repository.recordN8nUpdate(
      fixture.jobRow.id as string,
      withoutAttestation
    )).rejects.toMatchObject({ code: 'CONFIG_INVALID', statusCode: 409 });
    expect(mutationQueries()).toHaveLength(0);
  });

  it('rejects an attestation carried by any event other than the controlled normalized event', async () => {
    const fixture = createRepositoryRfbsNormalizationFixture();
    const { repository, mutationQueries } = createRfbsNormalizationRepository(fixture);

    await expect(repository.recordN8nUpdate(fixture.jobRow.id as string, {
      ...fixture.normalizedInput,
      eventType: 'EXTERNAL_RFBS_BYPASS_ATTEMPT'
    })).rejects.toMatchObject({ code: 'CONFIG_INVALID', statusCode: 409 });
    expect(mutationQueries()).toHaveLength(0);
  });

  it.each([
    ['job contract', (fixture: RepositoryRfbsNormalizationFixture) => {
      fixture.jobRow.payload = {
        ...(fixture.jobRow.payload as Record<string, unknown>),
        offerContractHash: `sha256:${'f'.repeat(64)}`
      };
    }],
    ['listing fulfillment mode', (fixture: RepositoryRfbsNormalizationFixture) => {
      fixture.listingRow.data = { fulfillmentMode: 'FBS' };
    }],
    ['persisted mapping identity', (fixture: RepositoryRfbsNormalizationFixture) => {
      fixture.mappingRows[0]!.ozon_product_id = '9999999999';
    }],
    ['persisted mapping stock snapshot', (fixture: RepositoryRfbsNormalizationFixture) => {
      fixture.mappingRows[0]!.status_snapshot = {
        ...(fixture.mappingRows[0]!.status_snapshot as Record<string, unknown>),
        stockPresent: 0
      };
    }],
    ['attestation callback hash', (fixture: RepositoryRfbsNormalizationFixture) => {
      fixture.normalizedInput.rfbsStockReadbackAttestation = {
        ...fixture.normalizedInput.rfbsStockReadbackAttestation!,
        callbackHash: `sha256:${'0'.repeat(64)}`
      };
    }],
    ['success path shape', (fixture: RepositoryRfbsNormalizationFixture) => {
      setRfbsArchiveWorkRelPath(fixture, 'success/2026-08-09/nested/0000105__r4');
    }],
    ['success archive date', (fixture: RepositoryRfbsNormalizationFixture) => {
      setRfbsArchiveWorkRelPath(fixture, 'success/2000-01-01/0000105__r4');
    }],
    ['success task folder', (fixture: RepositoryRfbsNormalizationFixture) => {
      const archiveDate = String(fixture.normalizedInput.workRelPath).split('/')[1];
      fixture.normalizedInput.taskFolder = '0000105__r5';
      fixture.normalizedInput.workRelPath = `success/${archiveDate}/0000105__r5`;
      fixture.normalizedInput.jobPayload = {
        ...(fixture.normalizedInput.jobPayload || {}),
        taskFolder: '0000105__r5',
        workRelPath: fixture.normalizedInput.workRelPath
      };
    }],
    ['success directory signature', (fixture: RepositoryRfbsNormalizationFixture) => {
      const changedSignature = `sha256:${'b'.repeat(64)}`;
      fixture.normalizedInput.directorySignature = changedSignature;
      fixture.normalizedInput.jobPayload = {
        ...(fixture.normalizedInput.jobPayload || {}),
        directorySignature: changedSignature
      };
    }],
    ['top-level and job payload archive metadata', (fixture: RepositoryRfbsNormalizationFixture) => {
      fixture.normalizedInput.jobPayload = {
        ...(fixture.normalizedInput.jobPayload || {}),
        directoryStage: 'PROCESSING'
      };
    }]
  ])('rejects %s drift without changing job state or writing an event', async (_label, mutate) => {
    const fixture = createRepositoryRfbsNormalizationFixture();
    mutate(fixture);
    const { repository, mutationQueries } = createRfbsNormalizationRepository(fixture);

    await expect(repository.recordN8nUpdate(
      fixture.jobRow.id as string,
      fixture.normalizedInput
    )).rejects.toMatchObject({ code: 'CONFIG_INVALID', statusCode: 409 });
    expect(mutationQueries()).toHaveLength(0);
  });
});

describe('OZON durable AUTO media replay ownership', () => {
  const identity = { sourceStageId: 'E004', submissionId: 'submission-1', variantId: randomUUID() };
  const accepted = {
    ...identity,
    deliveredAt: '2026-08-09T01:00:00.000Z',
    autoPublishDecision: 'ACCEPTED',
    autoPublishAcceptanceId: 'acceptance-1',
    autoPublishAcceptedAt: '2026-08-09T01:00:01.000Z',
    autoPublishAcceptedByJobId: 'job-1',
    autoPublishAcceptedPresetId: 'preset-1',
    autoPublishAcceptedPresetRowVersion: 8,
    autoPublishAcceptedSettingsRowVersion: 12,
    autoPublishAcceptedActivationStartedAt: '2026-08-09T00:00:00.000Z',
    autoPublishAcceptedDefinitionHash: `sha256:${'a'.repeat(64)}`
  };

  it('recognizes an idempotent replay only when the durable ledger and the same AUTO job own the identity', () => {
    const job = { id: 'job-1', source: 'AUTO', payload: { mediaDeliveries: [accepted] } };
    expect(isBoundDurablyAcceptedAutomaticMediaReplay('job-1', accepted, job, identity)).toBe(true);
    expect(isBoundDurablyAcceptedAutomaticMediaReplay('job-2', accepted, job, identity)).toBe(false);
    expect(isBoundDurablyAcceptedAutomaticMediaReplay('job-1', accepted, job, {
      ...identity,
      submissionId: 'new-submission'
    })).toBe(false);
    expect(isBoundDurablyAcceptedAutomaticMediaReplay('job-1', {
      ...accepted,
      autoPublishAcceptedSettingsRowVersion: undefined
    }, job, identity)).toBe(false);
  });

  it('creates an order-independent full-SKU ledger CAS hash and detects any row mutation', () => {
    const rows = [
      { sourceStageId: 'E005', submissionId: 'b', variantId: 'v2', jobId: null, payload: { value: 2 }, updatedAt: '2026-08-09 01:00:00.000001+00' },
      { sourceStageId: 'E004', submissionId: 'a', variantId: 'v1', jobId: 'job-1', payload: { value: 1 }, updatedAt: '2026-08-09 01:00:00.000000+00' }
    ];
    const audit = createOzonTargetedRecoveryLedgerAudit(rows);
    expect(createOzonTargetedRecoveryLedgerAudit([...rows].reverse())).toEqual(audit);
    expect(createOzonTargetedRecoveryLedgerAudit([
      rows[0]!,
      { ...rows[1]!, updatedAt: '2026-08-09 01:00:00.000002+00' }
    ])).not.toEqual(audit);
  });

  it('persists a capability-gated delivery as an idempotent deferred ledger without a job', async () => {
    let ledgerRow: Record<string, unknown> | undefined;
    const query = vi.fn(async (sqlInput: unknown, valuesInput?: unknown[]) => {
      const sql = String(sqlInput);
      const values = valuesInput || [];
      if (sql.includes('pg_advisory_xact_lock')) return { rows: [], rowCount: 1 };
      if (sql.includes('SELECT * FROM ozon_media_deliveries')) {
        return { rows: ledgerRow ? [ledgerRow] : [], rowCount: ledgerRow ? 1 : 0 };
      }
      if (sql.includes('INSERT INTO ozon_media_deliveries')) {
        ledgerRow = {
          sku: values[0],
          source_stage_id: values[1],
          submission_id: values[2],
          variant_id: values[3],
          job_id: null,
          payload: parseTestRecord(values[4])
        };
        return { rows: [ledgerRow], rowCount: 1 };
      }
      throw new Error(`unexpected capability ledger query: ${sql}`);
    });
    const repository = new OzonRepository('postgres://not-used');
    Object.defineProperty(repository, 'transaction', {
      value: async (operation: (client: unknown) => Promise<unknown>) => operation({ query })
    });
    const input = {
      sku: '0000119',
      media: {
        sourceStageId: 'E004',
        submissionId: '72e3276d-a297-4ed5-9e21-9bce2b342c29',
        variantId: '6cae502a-0651-4732-812d-6c2a7f4a00e1',
        deliveredAt: '2026-08-11T07:25:45.012Z'
      }
    };

    await expect(repository.deferAutomaticMediaDeliveryForCapability(input)).resolves.toEqual({
      job: undefined,
      becameRunnable: false,
      deferred: true
    });
    expect(ledgerRow).toMatchObject({
      job_id: null,
      payload: {
        autoPublishDecision: 'DEFERRED',
        autoPublishDeferredReason: 'OZON_MULTISTORE_FLEET_CAPABILITY_DISABLED',
        deliveredAt: input.media.deliveredAt
      }
    });
    await expect(repository.deferAutomaticMediaDeliveryForCapability(input)).resolves.toEqual({
      job: undefined,
      becameRunnable: false,
      deferred: true
    });
    expect(query.mock.calls.filter(([sql]) => String(sql).includes('INSERT INTO ozon_media_deliveries'))).toHaveLength(1);
    expect(query.mock.calls.some(([sql]) => String(sql).includes('ozon_publish_jobs'))).toBe(false);
  });
});

describe('OZON compatible append remote absence evidence', () => {
  const evidence = (overrides: Record<string, unknown> = {}) => ({
    status: 'CONFIRMED_EMPTY',
    offerIds: ['0000105-02', '0000105-03'],
    checkedAt: new Date().toISOString(),
    infoItemCount: 0,
    attributeItemCount: 0,
    contractVersion: 2,
    requestedOfferIds: ['0000105-02', '0000105-03'],
    operations: [
      {
        operation: 'infoList', requestId: 'productStatus:infoList', ok: true, upstreamOk: true,
        statusCode: 200, outcome: 'EMPTY', resultShape: 'ARRAY', itemCount: 0
      },
      {
        operation: 'attributesInfo', requestId: 'productStatus:attributesInfo', ok: true, upstreamOk: false,
        statusCode: 404, outcome: 'NOT_FOUND', resultShape: 'NOT_FOUND_ERROR', itemCount: 0, errorCode: '5'
      }
    ],
    absenceEvidence: {
      method: 'INFO_EMPTY_ATTRIBUTES_NOT_FOUND',
      infoList: { statusCode: 200, resultShape: 'ARRAY', itemCount: 0 },
      attributesInfo: { statusCode: 404, resultShape: 'NOT_FOUND_ERROR', itemCount: 0, errorCode: '5' }
    },
    storeAlias: 'default',
    ...overrides
  });

  it('accepts only the canonical fresh v2 absence contract for the exact store and submitted offers', () => {
    expect(assertCompatibleAppendRemoteAbsenceEvidence(
      evidence(), ['0000105-02', '0000105-03'], 'default'
    )).toMatchObject({
      status: 'CONFIRMED_EMPTY',
      contractVersion: 2,
      storeAlias: 'default',
      offerIds: ['0000105-02', '0000105-03']
    });
  });

  it.each([
    ['wrong store', { storeAlias: 'other' }],
    ['wrong offer scope', { offerIds: ['0000105-02'] }],
    ['stale read', { checkedAt: '2026-08-01T00:00:00.000Z' }],
    ['incomplete operations', { operations: [] }]
  ])('rejects %s before repository callbacks can run', (_label, overrides) => {
    expect(() => assertCompatibleAppendRemoteAbsenceEvidence(
      evidence(overrides), ['0000105-02', '0000105-03'], 'default'
    )).toThrowError(expect.objectContaining({ code: 'OZON_REMOTE_STATE_UNPROVEN', statusCode: 409 }));
  });
});

describe('OZON runtime scheduling query', () => {
  it('selects every due remote stage plus inbox dispatch recovery and excludes actively leased jobs', async () => {
    const row = (id: string, updatedAt: string) => ({
      id,
      sku: id === 'runtime-oldest' ? '0000001' : '0000002',
      state: 'MODERATING',
      source: 'MANUAL',
      store_alias: 'default',
      payload: {},
      stage_states: {},
      retry_count: 0,
      row_version: 1,
      created_at: updatedAt,
      updated_at: updatedAt
    });
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [{ count: '2' }] })
      .mockResolvedValueOnce({ rows: [
        row('runtime-oldest', '2026-08-07T01:00:00.000Z'),
        row('runtime-newer', '2026-08-07T02:00:00.000Z')
      ] });
    const repository = new OzonRepository('postgres://not-used');
    Object.defineProperty(repository, 'query', { value: query });

    const result = await repository.listRuntimeJobs({ page: 1, pageSize: 20, remoteOnly: true });

    expect(result).toMatchObject({
      total: 2,
      page: 1,
      pageSize: 20,
      items: [{ id: 'runtime-oldest' }, { id: 'runtime-newer' }]
    });
    expect(query).toHaveBeenCalledTimes(2);
    const [countSql, countValues] = query.mock.calls[0]!;
    const [selectSql, selectValues] = query.mock.calls[1]!;
    expect(countSql).toContain('j.state = ANY($1::text[])');
    expect(countSql).toContain('j.next_attempt_at IS NULL OR j.next_attempt_at <= NOW()');
    expect(countSql).toContain('j.lease_expires_at IS NULL OR j.lease_expires_at <= NOW()');
    expect(countSql).toContain("j.payload->>'finalVerificationLeaseUntil'");
    expect(countSql).toContain('(Z|[+-][0-9]{2}:[0-9]{2})$');
    expect(countSql).toContain("NULLIF(j.task_id,'') IS NOT NULL");
    expect(countValues[0]).toEqual([
      'READY', 'UPLOADING_MEDIA', 'SUBMITTING', 'IMPORTING', 'VERIFYING_IMAGES',
      'UPDATING_PRICE', 'UPDATING_STOCK', 'MODERATING'
    ]);
    expect(selectSql).toContain("WHEN j.payload ? 'networkRecovery' THEN 0");
    expect(selectSql).toContain('COALESCE(j.next_attempt_at,j.updated_at) ASC,j.id ASC');
    expect(selectValues.slice(-2)).toEqual([20, 0]);
  });

  it('claims exactly one due job while atomically owning the platform slot', async () => {
    const baseRow = {
      id: '00000000-0000-4000-8000-000000000031',
      sku: '0000031',
      state: 'IMPORTING',
      source: 'MANUAL',
      store_alias: 'default',
      payload: { importIntent: { offerIds: ['0000031-01'] } },
      stage_states: {},
      retry_count: 0,
      row_version: 7,
      created_at: '2026-08-07T01:00:00.000Z',
      updated_at: '2026-08-07T01:00:00.000Z'
    };
    const query = vi.fn(async (sql: string, values?: unknown[]) => {
      if (sql.includes('SELECT job_id,lease_owner,lease_expires_at')) return { rows: [] };
      if (sql.includes('SELECT * FROM ozon_publish_jobs j')) return { rows: [baseRow] };
      if (sql.includes('SET lease_owner=$2')) return {
        rows: [{
          ...baseRow,
          row_version: 8,
          lease_owner: values?.[1],
          lease_token: values?.[2],
          lease_expires_at: '2026-08-07T01:10:00.000Z'
        }]
      };
      return { rows: [], rowCount: 1 };
    });
    const repository = new OzonRepository('postgres://not-used');
    Object.defineProperty(repository, 'transaction', { value: async (operation: (client: unknown) => Promise<unknown>) => operation({ query }) });

    const claimed = await repository.claimRuntimeJob({ leaseOwner: 'ozon-p002:execution-31', leaseSeconds: 600 });

    expect(claimed).toMatchObject({
      id: baseRow.id,
      rowVersion: 8,
      leaseOwner: 'ozon-p002:execution-31',
      leaseExpiresAt: '2026-08-07T01:10:00.000Z'
    });
    const select = query.mock.calls.find(([sql]) => String(sql).includes('FOR UPDATE SKIP LOCKED'));
    expect(select?.[0]).toContain('LIMIT 1');
    expect(select?.[0]).toContain("j.payload ? 'networkRecovery'");
    expect(select?.[1]?.[0]).toEqual([
      'READY', 'UPLOADING_MEDIA', 'SUBMITTING', 'IMPORTING', 'VERIFYING_IMAGES',
      'UPDATING_PRICE', 'UPDATING_STOCK', 'MODERATING'
    ]);
    expect(query.mock.calls.some(([sql]) => String(sql).includes('INSERT INTO ozon_publish_slots'))).toBe(true);
  });
});

describe('OZON listing description provenance', () => {
  it('marks only user-changed descriptions as MANUAL and clears stale generated metadata', () => {
    const variantIds = [randomUUID(), randomUUID()];
    const initialization = {
      status: 'COMPLETE' as const,
      initializedAt: '2026-08-06T00:00:00.000Z',
      issues: [],
      title: { workflowId: 'HDh0ZNLK2ps5qasR', language: '俄文', maxLength: 60, cached: false },
      description: { workflowCode: 'E003' as const, executionId: 9, fileName: 'detail.txt', sha256: 'a'.repeat(64) }
    };
    const source = { type: 'E003' as const, workflowCode: 'E003' as const, executionId: 9, fileName: 'detail.txt', sha256: 'a'.repeat(64) };
    const offer = (variantId: string, descriptionRu: string) => ({
      variantId, productVariantId: variantId, variantCode: variantId.slice(0, 2), offerId: `offer-${variantId.slice(0, 8)}`,
      barcode: '', modelGroup: '0000001', price: 100, stock: 1, descriptionRu,
      descriptionSource: { ...source, productVariantId: variantId }, descriptionWarnings: [], attributes: [], media: []
    });
    const current = {
      fulfillmentMode: 'FBS' as const, warehouseId: '', currency: 'RUB' as const, vat: '0.2' as const,
      titleRu: 'Заголовок', descriptionRu: 'Автоматическое общее описание.', descriptionSource: source,
      descriptionWarnings: [], initialization, brand: '', sharedAttributes: [],
      offers: [offer(variantIds[0]!, 'Автоматическое описание один.'), offer(variantIds[1]!, 'Автоматическое описание два.')],
      mediaAssets: [], mediaSourceRoot: '', videoUploadMode: 'COMPRESSED_COPY' as const
    };
    const next = markChangedOzonDescriptionsManual(current, {
      ...current,
      descriptionRu: 'Ручное общее описание.',
      offers: [current.offers[0]!, { ...current.offers[1]!, descriptionRu: 'Ручное описание второго варианта.' }]
    });

    expect(next.descriptionSource).toEqual({ type: 'MANUAL' });
    expect(next.offers[0]?.descriptionSource).toMatchObject({ type: 'E003', executionId: 9 });
    expect(next.offers[1]?.descriptionSource).toEqual({ type: 'MANUAL' });
    expect(next.initialization?.title).toEqual(initialization.title);
    expect(next.initialization?.description).toBeUndefined();
  });
});

describe('OZON import-intent URL failure recovery evidence', () => {
  const jobId = 'd7938c88-500d-4b75-914c-4602e1640ca3';
  const sku = '0000106';
  const revision = 2;
  const offerIds = ['0000106-01'];
  const listingData = { offers: [{ offerId: offerIds[0] }] };
  const listingDataSignature = `sha256:${createHash('sha256').update(testStableJson(listingData)).digest('hex')}`;
  const directorySignature = `sha256:${'e'.repeat(64)}`;
  const jobRow = (overrides: Record<string, unknown> = {}) => ({
    id: jobId,
    sku,
    state: 'NEEDS_ATTENTION',
    source: 'AUTO',
    store_alias: 'default',
    payload: {
      autoPreparedByJobId: jobId,
      autoPreparedListingRevision: revision,
      autoPreparedListingDataSignature: listingDataSignature
    },
    stage_states: { import: 'PENDING', moderation: 'PENDING', images: 'LOCAL_READY', video: 'LOCAL_READY' },
    offer_ids: offerIds,
    task_id: jobId,
    task_folder: `${sku}__r${revision}`,
    work_rel_path: `processing/${sku}__r${revision}`,
    directory_stage: 'PROCESSING',
    directory_signature: directorySignature,
    listing_revision: revision,
    retry_count: 3,
    row_version: 24,
    last_error_code: 'OZON_COMPATIBLE_UPDATE_NOT_ALLOWED',
    last_error_message: '当前草稿状态 NEEDS_ATTENTION 不允许兼容更新',
    created_at: '2026-08-08T03:52:19.780Z',
    updated_at: '2026-08-08T04:01:53.320Z',
    ...overrides
  });
  const listingRow = (overrides: Record<string, unknown> = {}) => ({
    sku,
    product_name: '单肩大容量包包',
    status: 'NEEDS_ATTENTION',
    row_version: 4,
    revision,
    data: listingData,
    last_task_id: jobId,
    last_error_code: 'OZON_STATE_MACHINE_FAILED',
    last_error_message: 'URL parameter must be a string, got undefined',
    created_at: '2026-08-08T03:53:07.067Z',
    updated_at: '2026-08-08T03:53:41.546Z',
    ...overrides
  });
  const liveMaskedEvents = () => ([
    {
      id: '8c0b80e7-e617-4a24-be8f-59406d0d0952',
      event_type: 'OZON_STATE_MACHINE_FAILED',
      from_state: 'UPLOADING_MEDIA',
      to_state: 'NEEDS_ATTENTION',
      message: 'OZON 上品状态机执行失败',
      payload: {},
      created_at: '2026-08-08T03:53:41.546Z'
    },
    {
      id: '43958451-20e7-4c71-9c6f-740e15eaca3a',
      event_type: 'MEDIA_DELIVERED',
      from_state: 'NEEDS_ATTENTION',
      to_state: 'READY',
      message: 'OZON 共享媒体投递已合并到已绑定的自动上品任务',
      payload: {},
      created_at: '2026-08-08T03:56:20.270Z'
    },
    {
      id: '85229230-89b9-4ebb-9038-e8d3a40ef28a',
      event_type: 'AUTOMATION_STOPPED',
      from_state: 'READY',
      to_state: 'NEEDS_ATTENTION',
      message: '当前草稿状态 NEEDS_ATTENTION 不允许兼容更新',
      payload: {},
      created_at: '2026-08-08T03:56:20.597Z'
    }
  ]);

  it('accepts the existing 106 masked-error sequence without claiming the failure event stored the original URL error', async () => {
    const repository = mockedKnownRecoveryRepository(jobRow(), listingRow(), liveMaskedEvents());
    await expect(repository.recoverKnownPrePlatformFailure(jobId, {
      reason: 'IMPORT_INTENT_URL_MISSING',
      rowVersion: 24,
      listingRowVersion: 4,
      dryRun: true
    })).resolves.toMatchObject({
      status: 'DRY_RUN',
      proposed: { jobState: 'SUBMITTING', listingState: 'SUBMITTING', retryCount: 3 }
    });

    const checks = {
      remoteState: {
        status: 'CONFIRMED_EMPTY' as const,
        offerIds,
        checkedAt: '2026-08-08T12:00:00.000Z',
        contractVersion: 2 as const
      },
      productJson: {
        status: 'MATCHED' as const,
        checkedAt: '2026-08-08T12:00:00.000Z',
        expectedSignature: directorySignature
      }
    };
    const recovered = await repository.recoverKnownPrePlatformFailure(jobId, {
      reason: 'IMPORT_INTENT_URL_MISSING',
      rowVersion: 24,
      listingRowVersion: 4,
      dryRun: false
    }, async () => checks);
    expect(recovered.job.payload?.contentPolicyVersion).toBe('merchroute-ozon-content-v2');
    expect(recovered.job.payload?.knownPrePlatformFailureRecovery).toMatchObject({
      reason: 'IMPORT_INTENT_URL_MISSING',
      failureEvidence: {
        source: 'LISTING_AND_EVENT_SEQUENCE',
        listingError: {
          errorCode: 'OZON_STATE_MACHINE_FAILED',
          errorMessage: 'URL parameter must be a string, got undefined'
        },
        stateMachineFailureEvent: {
          id: '8c0b80e7-e617-4a24-be8f-59406d0d0952',
          message: 'OZON 上品状态机执行失败'
        },
        firstMaskingMediaEvent: { id: '43958451-20e7-4c71-9c6f-740e15eaca3a' },
        firstMaskingAutomationEvent: { id: '85229230-89b9-4ebb-9038-e8d3a40ef28a' },
        currentJobError: {
          errorCode: 'OZON_COMPATIBLE_UPDATE_NOT_ALLOWED',
          errorMessage: '当前草稿状态 NEEDS_ATTENTION 不允许兼容更新'
        }
      }
    });
  });

  it('preserves PostgreSQL Date millisecond precision for the same-second media and mask events', async () => {
    const postgresEvents = liveMaskedEvents().map((event) => ({
      ...event,
      created_at: new Date(event.created_at)
    }));
    const repository = mockedKnownRecoveryRepository(jobRow(), listingRow(), postgresEvents);
    await expect(repository.recoverKnownPrePlatformFailure(jobId, {
      reason: 'IMPORT_INTENT_URL_MISSING',
      rowVersion: 24,
      listingRowVersion: 4,
      dryRun: true
    })).resolves.toMatchObject({
      status: 'DRY_RUN',
      proposed: { jobState: 'SUBMITTING', listingState: 'SUBMITTING', retryCount: 3 }
    });
  });

  it('still accepts an unmasked current job only when both job and listing retain the exact URL error', async () => {
    const repository = mockedKnownRecoveryRepository(jobRow({
      last_error_code: 'OZON_STATE_MACHINE_FAILED',
      last_error_message: 'URL parameter must be a string, got undefined'
    }), listingRow());
    await expect(repository.recoverKnownPrePlatformFailure(jobId, {
      reason: 'IMPORT_INTENT_URL_MISSING',
      rowVersion: 24,
      listingRowVersion: 4,
      dryRun: true
    })).resolves.toMatchObject({ status: 'DRY_RUN' });
  });

  it('rejects masked jobs when the immutable event anchor is missing, duplicated, out of order, or has a contradictory mask', async () => {
    const baseEvents = liveMaskedEvents();
    const variants = [
      { job: jobRow(), events: [] },
      { job: jobRow(), events: [...baseEvents, { ...baseEvents[0]!, id: randomUUID() }] },
      { job: jobRow(), events: baseEvents.map((event) => event.event_type === 'OZON_STATE_MACHINE_FAILED'
        ? { ...event, created_at: '2026-08-08T03:57:00.000Z' }
        : event) },
      { job: jobRow(), events: baseEvents.map((event) => event.event_type === 'AUTOMATION_STOPPED'
        ? { ...event, message: '其他停止原因' }
        : event) },
      { job: jobRow(), events: baseEvents.map((event) => event.event_type === 'OZON_STATE_MACHINE_FAILED'
        ? { ...event, payload: { errorCode: 'OTHER_FAILURE', errorMessage: '其他原始错误' } }
        : event) },
      { job: jobRow({ last_error_message: '当前草稿状态 READY 不允许兼容更新' }), events: baseEvents }
    ];
    for (const variant of variants) {
      const repository = mockedKnownRecoveryRepository(variant.job, listingRow(), variant.events);
      await expect(repository.recoverKnownPrePlatformFailure(jobId, {
        reason: 'IMPORT_INTENT_URL_MISSING',
        rowVersion: 24,
        listingRowVersion: 4,
        dryRun: true
      })).rejects.toMatchObject({ code: 'CONFIG_INVALID', statusCode: 409 });
    }
  });

  it('fails closed when an explicit frozen policy contradicts the v2 allowlisted recovery', async () => {
    for (const contentPolicyVersion of ['LEGACY_UNKNOWN', 'merchroute-ozon-content-v3']) {
      const repository = mockedKnownRecoveryRepository(jobRow({
        payload: { ...(jobRow().payload as object), contentPolicyVersion }
      }), listingRow(), liveMaskedEvents());
      await expect(repository.recoverKnownPrePlatformFailure(jobId, {
        reason: 'IMPORT_INTENT_URL_MISSING', rowVersion: 24, listingRowVersion: 4, dryRun: true
      })).rejects.toMatchObject({ code: 'OZON_LEGACY_TASK_READ_ONLY', statusCode: 409 });
    }
  });
});

describe('OZON late title-limit recovery evidence', () => {
  const jobId = '7c525f2c-a52c-475c-b8f5-a99ab61b348f';
  const sku = '0000107';
  const revision = 2;
  const offerIds = ['0000107-01', '0000107-02', '0000107-03'];
  const listingData = {
    titleRu: 'Универсальная сумка через плечо',
    offers: offerIds.map((offerId) => ({ offerId }))
  };
  const listingDataSignature = `sha256:${createHash('sha256').update(testStableJson(listingData)).digest('hex')}`;
  const directorySignature = `sha256:${'c'.repeat(64)}`;
  const definition60 = titleRecoveryPresetDefinition(60);
  const definitionHash60 = `sha256:${createHash('sha256').update(testStableJson(definition60)).digest('hex')}`;
  const jobRow = (overrides: Record<string, unknown> = {}) => ({
    id: jobId,
    sku,
    state: 'SUBMITTING',
    source: 'AUTO',
    store_alias: 'default',
    payload: {
      presetBinding: {
        schemaVersion: 1,
        presetId: '45c2fbb2-fa2c-4bbc-a2be-c8393d507adf',
        presetName: definition60.name,
        presetRowVersion: 15,
        definition: definition60,
        definitionHash: definitionHash60
      },
      autoPreparedMode: 'COMPATIBLE_UPSERT',
      autoPreparedByJobId: jobId,
      autoPreparedListingRevision: revision,
      autoPreparedListingDataSignature: listingDataSignature,
      productJsonGenerated: true
    },
    stage_states: {
      import: 'PENDING', moderation: 'PENDING', images: 'LOCAL_READY', video: 'LOCAL_READY',
      price: 'CALCULATED', stock: 'READY'
    },
    offer_ids: offerIds,
    product_links: [],
    task_id: jobId,
    task_folder: `${sku}__r${revision}`,
    work_rel_path: `processing/${sku}__r${revision}`,
    directory_stage: 'PROCESSING',
    directory_signature: directorySignature,
    listing_revision: revision,
    retry_count: 4,
    row_version: 65,
    last_error_code: null,
    last_error_message: null,
    created_at: '2026-08-08T09:00:00.000Z',
    updated_at: '2026-08-08T11:00:00.000Z',
    ...overrides
  });
  const listingRow = (overrides: Record<string, unknown> = {}) => ({
    sku,
    product_name_snapshot: '女士单肩包',
    status: 'SUBMITTING',
    row_version: 3,
    revision,
    data: listingData,
    last_task_id: jobId,
    last_error_code: null,
    last_error_message: null,
    created_at: '2026-08-08T09:00:00.000Z',
    updated_at: '2026-08-08T11:00:00.000Z',
    ...overrides
  });

  it('migrates only the frozen job binding and retry count while preserving the submitted job and listing', async () => {
    const observedQuery = vi.fn();
    const repository = mockedKnownRecoveryRepository(jobRow(), listingRow(), [], observedQuery);
    const preview = await repository.recoverKnownPrePlatformFailure(jobId, {
      reason: 'TITLE_TRANSLATION_MAX_LENGTH_60_TO_200',
      rowVersion: 65,
      listingRowVersion: 3,
      dryRun: true
    });
    expect(preview).toMatchObject({
      status: 'DRY_RUN',
      proposed: { jobState: 'SUBMITTING', retryCount: 0, titleTranslationMaxLength: 200 },
      job: { state: 'SUBMITTING', rowVersion: 65, retryCount: 4 },
      listing: { status: 'SUBMITTING', rowVersion: 3, revision }
    });

    const checks = {
      remoteState: {
        status: 'CONFIRMED_EMPTY' as const,
        offerIds,
        checkedAt: '2026-08-08T12:00:00.000Z',
        contractVersion: 2 as const
      },
      productJson: {
        status: 'MATCHED' as const,
        checkedAt: '2026-08-08T12:00:00.000Z',
        expectedSignature: directorySignature
      }
    };
    const recovered = await repository.recoverKnownPrePlatformFailure(jobId, {
      reason: 'TITLE_TRANSLATION_MAX_LENGTH_60_TO_200',
      rowVersion: 65,
      listingRowVersion: 3,
      dryRun: false
    }, async () => checks);
    expect(recovered).toMatchObject({
      status: 'RECOVERED',
      checks,
      job: {
        state: 'SUBMITTING', rowVersion: 66, retryCount: 0, revision,
        offerIds, taskId: jobId, taskFolder: `${sku}__r${revision}`,
        workRelPath: `processing/${sku}__r${revision}`,
        directoryStage: 'PROCESSING', directorySignature,
        payload: {
          contentPolicyVersion: 'merchroute-ozon-content-v2',
          presetBinding: { definition: { titleTranslation: { maxLength: 200 } } },
          knownPrePlatformFailureRecovery: {
            reason: 'TITLE_TRANSLATION_MAX_LENGTH_60_TO_200',
            recoveryMode: 'LATE_SUBMITTING_PRE_PLATFORM',
            listingRowVersion: 3,
            checks
          }
        }
      },
      listing: { status: 'SUBMITTING', rowVersion: 3, revision }
    });
    expect(recovered.job.stageStates).toMatchObject(jobRow().stage_states);
    expect(recovered.job).not.toHaveProperty('lastErrorCode');
    const updateSql = observedQuery.mock.calls.map(([sql]) => String(sql)).find((sql) => sql.includes('UPDATE ozon_publish_jobs'));
    expect(updateSql).toContain('SET payload=$2::jsonb,retry_count=$3');
    expect(updateSql).not.toContain('stage_states=');
    expect(updateSql).not.toContain('last_error_code=');
    expect(observedQuery.mock.calls.some(([sql]) => String(sql).includes('UPDATE ozon_listing_drafts'))).toBe(false);
    expect(observedQuery.mock.calls.some(([sql]) => String(sql).includes('DELETE FROM ozon_publish_slots'))).toBe(false);
    await expect(repository.recoverKnownPrePlatformFailure(jobId, {
      reason: 'TITLE_TRANSLATION_MAX_LENGTH_60_TO_200',
      rowVersion: 65,
      listingRowVersion: 3,
      dryRun: false
    }, async () => checks)).resolves.toMatchObject({ status: 'ALREADY_RECOVERED' });
  });

  it('rejects listing CAS drift, identity drift, remote checkpoints, and incomplete pre-import stages', async () => {
    const cases: Array<{ job?: Record<string, unknown>; listing?: Record<string, unknown>; listingRowVersion?: number }> = [
      { listingRowVersion: 4 },
      { listing: listingRow({ status: 'NEEDS_ATTENTION' }) },
      { listing: listingRow({ last_task_id: randomUUID() }) },
      { job: jobRow({ retry_count: 3 }) },
      { job: jobRow({ directory_stage: 'INBOX' }) },
      { job: jobRow({ offer_ids: offerIds.slice(0, 2) }) },
      { job: jobRow({ stage_states: { ...(jobRow().stage_states as object), import: 'SUBMITTED' } }) },
      { job: jobRow({ payload: { ...(jobRow().payload as object), importIntent: { requestId: 'already-written' } } }) },
      { job: jobRow({ payload: { ...(jobRow().payload as object), mediaUploadAudit: [{ offerId: offerIds[0] }] } }) },
      { job: jobRow({ payload: { ...(jobRow().payload as object), autoPreparedListingDataSignature: `sha256:${'f'.repeat(64)}` } }) }
    ];
    for (const item of cases) {
      const repository = mockedKnownRecoveryRepository(item.job || jobRow(), item.listing || listingRow());
      await expect(repository.recoverKnownPrePlatformFailure(jobId, {
        reason: 'TITLE_TRANSLATION_MAX_LENGTH_60_TO_200',
        rowVersion: 65,
        listingRowVersion: item.listingRowVersion ?? 3,
        dryRun: true
      })).rejects.toMatchObject({ statusCode: 409 });
    }
  });

  it('rejects unknown or contradictory explicit policy markers instead of rebinding them', async () => {
    for (const contentPolicyVersion of ['LEGACY_UNKNOWN', 'merchroute-ozon-content-v3']) {
      const repository = mockedKnownRecoveryRepository(jobRow({
        payload: { ...(jobRow().payload as object), contentPolicyVersion }
      }), listingRow());
      await expect(repository.recoverKnownPrePlatformFailure(jobId, {
        reason: 'TITLE_TRANSLATION_MAX_LENGTH_60_TO_200', rowVersion: 65, listingRowVersion: 3, dryRun: true
      })).rejects.toMatchObject({ code: 'OZON_LEGACY_TASK_READ_ONLY', statusCode: 409 });
    }
  });
});

describe('OZON description-policy false-positive recovery evidence', () => {
  const jobId = '50bff6f2-9801-4080-8183-2b37b4953d13';
  const sku = '0000105';
  const revision = 4;
  const offerIds = ['0000105-01'];
  const listingData = { offers: [{ offerId: offerIds[0] }] };
  const listingDataSignature = `sha256:${createHash('sha256').update(testStableJson(listingData)).digest('hex')}`;
  const directorySignature = `sha256:${'d'.repeat(64)}`;
  const priorRecovery = {
    schemaVersion: 1,
    reason: 'IMPORT_INTENT_URL_MISSING',
    recoveredAt: '2026-08-08T10:00:00.000Z',
    previousJobRowVersion: 22,
    previousListingRowVersion: 4,
    targetJobState: 'SUBMITTING',
    targetListingState: 'SUBMITTING',
    checks: {
      remoteState: { status: 'CONFIRMED_EMPTY' },
      productJson: { status: 'MATCHED' }
    },
    listingDataSignature,
    revision,
    offerIds,
    directorySignature
  };
  const jobRow = (overrides: Record<string, unknown> = {}) => ({
    id: jobId,
    sku,
    state: 'NEEDS_ATTENTION',
    source: 'AUTO',
    store_alias: 'default',
    payload: {
      autoPreparedByJobId: jobId,
      autoPreparedListingRevision: revision,
      autoPreparedListingDataSignature: listingDataSignature,
      knownPrePlatformFailureRecovery: priorRecovery
    },
    stage_states: { import: 'PENDING' },
    offer_ids: offerIds,
    task_id: jobId,
    task_folder: `${sku}__r${revision}`,
    work_rel_path: `processing/${sku}__r${revision}`,
    directory_stage: 'PROCESSING',
    directory_signature: directorySignature,
    listing_revision: revision,
    retry_count: 5,
    row_version: 23,
    last_error_code: 'OZON_STATE_MACHINE_FAILED',
    last_error_message: 'OZON 提交前校验失败: descriptionRu [KEYWORD_STUFFING]',
    created_at: '2026-08-08T09:00:00.000Z',
    updated_at: '2026-08-08T11:00:00.000Z',
    ...overrides
  });
  const listingRow = (overrides: Record<string, unknown> = {}) => ({
    sku,
    product_name: '详情词频误报恢复',
    status: 'NEEDS_ATTENTION',
    row_version: 5,
    revision,
    data: listingData,
    last_task_id: jobId,
    last_error_code: 'OZON_STATE_MACHINE_FAILED',
    last_error_message: 'OZON 提交前校验失败: descriptionRu [KEYWORD_STUFFING]',
    created_at: '2026-08-08T09:00:00.000Z',
    updated_at: '2026-08-08T11:00:00.000Z',
    ...overrides
  });

  it('dry-runs only when current ownership and the prior URL recovery chain both match', async () => {
    const repository = mockedKnownRecoveryRepository(jobRow(), listingRow());
    await expect(repository.recoverKnownPrePlatformFailure(jobId, {
      reason: 'DESCRIPTION_KEYWORD_STUFFING_FALSE_POSITIVE_V1_TO_V2',
      rowVersion: 23,
      listingRowVersion: 5,
      dryRun: true
    })).resolves.toMatchObject({
      status: 'DRY_RUN',
      proposed: { jobState: 'SUBMITTING', listingState: 'SUBMITTING', retryCount: 5 }
    });

    const checks = {
      remoteState: {
        status: 'CONFIRMED_EMPTY' as const,
        offerIds,
        checkedAt: '2026-08-08T12:00:00.000Z',
        contractVersion: 2 as const
      },
      productJson: {
        status: 'MATCHED' as const,
        checkedAt: '2026-08-08T12:00:00.000Z',
        expectedSignature: directorySignature
      },
      contentPolicy: {
        status: 'MATCHED' as const,
        policyVersion: 'merchroute-ozon-content-v2' as const,
        legacyFalsePositive: true as const
      }
    };
    const recovered = await repository.recoverKnownPrePlatformFailure(jobId, {
      reason: 'DESCRIPTION_KEYWORD_STUFFING_FALSE_POSITIVE_V1_TO_V2',
      rowVersion: 23,
      listingRowVersion: 5,
      dryRun: false
    }, async () => checks);
    expect(recovered).toMatchObject({
      status: 'RECOVERED',
      job: {
        state: 'SUBMITTING',
        retryCount: 5,
        rowVersion: 24,
        payload: {
          contentPolicyVersion: 'merchroute-ozon-content-v2',
          knownPrePlatformFailureRecovery: {
            reason: 'DESCRIPTION_KEYWORD_STUFFING_FALSE_POSITIVE_V1_TO_V2',
            previousRecovery: { reason: 'IMPORT_INTENT_URL_MISSING' },
            checks
          }
        }
      },
      listing: { status: 'SUBMITTING', rowVersion: 6 }
    });
    await expect(repository.recoverKnownPrePlatformFailure(jobId, {
      reason: 'DESCRIPTION_KEYWORD_STUFFING_FALSE_POSITIVE_V1_TO_V2',
      rowVersion: 23,
      listingRowVersion: 5,
      dryRun: false
    }, async () => checks)).resolves.toMatchObject({ status: 'ALREADY_RECOVERED' });
  });

  it('rejects a missing prior chain, error mismatch, or listing ownership drift', async () => {
    const variants = [
      { job: jobRow({ payload: { autoPreparedByJobId: jobId, autoPreparedListingRevision: revision, autoPreparedListingDataSignature: listingDataSignature } }), listing: listingRow() },
      { job: jobRow({ last_error_message: 'descriptionRu [OTHER_ERROR]' }), listing: listingRow() },
      { job: jobRow(), listing: listingRow({ data: { offers: [{ offerId: offerIds[0], changed: true }] } }) }
    ];
    for (const variant of variants) {
      const repository = mockedKnownRecoveryRepository(variant.job, variant.listing);
      await expect(repository.recoverKnownPrePlatformFailure(jobId, {
        reason: 'DESCRIPTION_KEYWORD_STUFFING_FALSE_POSITIVE_V1_TO_V2',
        rowVersion: 23,
        listingRowVersion: 5,
        dryRun: true
      })).rejects.toMatchObject({ statusCode: 409 });
    }
  });

  it('fails closed when frozen policy evidence is unknown or conflicts with v2', async () => {
    for (const contentPolicyVersion of ['LEGACY_UNKNOWN', 'merchroute-ozon-content-v3']) {
      const repository = mockedKnownRecoveryRepository(jobRow({
        payload: { ...(jobRow().payload as object), contentPolicyVersion }
      }), listingRow());
      await expect(repository.recoverKnownPrePlatformFailure(jobId, {
        reason: 'DESCRIPTION_KEYWORD_STUFFING_FALSE_POSITIVE_V1_TO_V2',
        rowVersion: 23,
        listingRowVersion: 5,
        dryRun: true
      })).rejects.toMatchObject({ code: 'OZON_LEGACY_TASK_READ_ONLY', statusCode: 409 });
    }
  });
});

describe('OZON listing gross-weight linkage guard', () => {
  const resolution = (overrides: Record<string, unknown> = {}) => ({
    source: 'PROCUREMENT',
    effectiveGrossWeightGrams: 650.5,
    procurementGrossWeightGrams: 650.5,
    presetGrossWeightGrams: 700,
    procurementVersionId: '11111111-1111-4111-8111-111111111111',
    procurementVersionNo: 7,
    procurementCapturedAt: '2026-08-07T01:02:03.000Z',
    ...overrides
  });
  const data = (grossWeightResolution: Record<string, unknown>, weight = 650.5, weightUnit = 'g') => ({
    initialization: { grossWeightResolution },
    dimensions: { length: 30, width: 20, height: 10, dimensionUnit: 'cm', weight, weightUnit }
  });

  it('accepts procurement weight and normalized fallback snapshots', () => {
    expect(() => assertOzonGrossWeightLinkage(data(resolution()), '0000001')).not.toThrow();
    const fallback = resolution({
      source: 'PRESET_FALLBACK',
      effectiveGrossWeightGrams: 700,
      procurementGrossWeightGrams: null
    });
    expect(() => assertOzonGrossWeightLinkage(data(fallback, 700), '0000001')).not.toThrow();
  });

  it('rejects contradictory source semantics and malformed audit metadata', () => {
    expect(() => assertOzonGrossWeightLinkage(data(resolution({
      source: 'PROCUREMENT',
      effectiveGrossWeightGrams: 700
    }), 700), '0000001')).toThrow(expect.objectContaining({ code: 'CONFIG_INVALID', statusCode: 409 }));
    expect(() => assertOzonGrossWeightLinkage(data(resolution({
      source: 'PRESET_FALLBACK',
      procurementGrossWeightGrams: 650.5,
      effectiveGrossWeightGrams: 700
    }), 700), '0000001')).toThrow(expect.objectContaining({ code: 'CONFIG_INVALID', statusCode: 409 }));
    expect(() => assertOzonGrossWeightLinkage(data(resolution({
      procurementCapturedAt: 'not-a-date'
    })), '0000001')).toThrow(expect.objectContaining({ code: 'CONFIG_INVALID', statusCode: 409 }));
    for (const procurementGrossWeightGrams of [0, -1]) {
      expect(() => assertOzonGrossWeightLinkage(data(resolution({
        source: 'PRESET_FALLBACK',
        effectiveGrossWeightGrams: 700,
        procurementGrossWeightGrams
      }), 700), '0000001')).toThrow(expect.objectContaining({ code: 'CONFIG_INVALID', statusCode: 409 }));
    }
  });

  it('rejects weight or unit bypasses while leaving historical drafts compatible', () => {
    expect(() => assertOzonGrossWeightLinkage(data(resolution(), 651), '0000001'))
      .toThrow(expect.objectContaining({ code: 'CONFIG_INVALID', statusCode: 409 }));
    expect(() => assertOzonGrossWeightLinkage(data(resolution(), 650.5, 'kg'), '0000001'))
      .toThrow(expect.objectContaining({ code: 'CONFIG_INVALID', statusCode: 409 }));
    expect(() => assertOzonGrossWeightLinkage({
      initialization: { status: 'COMPLETE' },
      dimensions: { weight: 1, weightUnit: 'lb' }
    }, '0000001')).not.toThrow();
  });
});

function mockedKnownRecoveryRepository(
  jobRow: Record<string, unknown>,
  listingRow?: Record<string, unknown>,
  recoveryEvents: Array<Record<string, unknown>> = [],
  observeQuery?: (sql: string, values: unknown[]) => void
): OzonRepository {
  let currentJob = { ...jobRow };
  let currentListing = listingRow ? { ...listingRow } : undefined;
  const query = vi.fn(async (sqlInput: string, values: unknown[] = []) => {
    const sql = String(sqlInput);
    observeQuery?.(sql, values);
    if (sql.includes('SELECT sku FROM ozon_publish_jobs')) return { rows: [{ sku: currentJob.sku }] };
    if (sql.includes('pg_advisory_xact_lock')) return { rows: [{}] };
    if (sql.includes('SELECT * FROM ozon_publish_jobs WHERE id=$1 FOR UPDATE')) return { rows: [currentJob] };
    if (sql.includes('SELECT * FROM ozon_listing_drafts WHERE sku=$1 FOR UPDATE')) return { rows: currentListing ? [currentListing] : [] };
    if (sql.includes('FROM ozon_publish_slots')) return { rows: [{ exists: false }] };
    if (sql.includes('FROM ozon_platform_status_refresh_leases')) return { rows: [] };
    if (sql.includes('created_at>$3')) return { rows: [] };
    if (sql.includes('FROM ozon_product_mappings')) return { rows: [{ exists: false }] };
    if (sql.includes('FROM ozon_publish_events')) return { rows: recoveryEvents };
    if (sql.includes('UPDATE ozon_publish_jobs')) {
      if (sql.includes("SET payload=$2::jsonb,retry_count=$3")) {
        currentJob = {
          ...currentJob,
          payload: JSON.parse(String(values[1])),
          retry_count: values[2],
          row_version: Number(currentJob.row_version) + 1,
          updated_at: '2026-08-08T12:00:00.000Z'
        };
        return { rows: [currentJob] };
      }
      currentJob = {
        ...currentJob,
        state: values[1],
        payload: JSON.parse(String(values[2])),
        stage_states: JSON.parse(String(values[3])),
        next_attempt_at: values[4],
        retry_count: values[5],
        last_error_code: null,
        last_error_message: null,
        row_version: Number(currentJob.row_version) + 1,
        updated_at: '2026-08-08T12:00:00.000Z'
      };
      return { rows: [currentJob] };
    }
    if (sql.includes('UPDATE ozon_listing_drafts')) {
      if (!currentListing) throw new Error('unexpected listing update without listing');
      currentListing = {
        ...currentListing,
        status: values[1],
        last_task_id: values[2],
        last_error_code: null,
        last_error_message: null,
        row_version: Number(currentListing.row_version) + 1,
        updated_at: '2026-08-08T12:00:00.000Z'
      };
      return { rows: [currentListing] };
    }
    if (sql.includes('DELETE FROM ozon_publish_slots') || sql.includes('INSERT INTO ozon_publish_events')) {
      return { rows: [], rowCount: 1 };
    }
    throw new Error(`unexpected recovery query: ${sql}`);
  });
  const repository = new OzonRepository('postgres://not-used');
  Object.defineProperty(repository, 'transaction', {
    value: async (operation: (client: unknown) => Promise<unknown>) => operation({ query })
  });
  return repository;
}

function titleRecoveryPresetDefinition(maxLength: number): Record<string, unknown> {
  return {
    name: 'OZON 自动上品预设',
    description: '',
    autoPublishEnabled: true,
    autoPublishMode: 'COMPATIBLE_UPSERT',
    fulfillmentMode: 'FBS',
    warehouseId: '10001',
    categoryKey: 'ozon_1_2',
    pricingTemplateId: '11111111-1111-4111-8111-111111111111',
    shippingTemplateId: '22222222-2222-4222-8222-222222222222',
    shippingServiceCode: 'CEL_FBS_STANDARD',
    currency: 'CNY',
    vat: '0.2',
    defaultStock: 1,
    dimensions: { length: 30, width: 20, height: 10, dimensionUnit: 'cm', weight: 800, weightUnit: 'g' },
    sharedAttributes: [],
    variantAttributes: [],
    titleTranslation: { workflowId: 'HDh0ZNLK2ps5qasR', language: '俄文', maxLength },
    descriptionSource: 'E003',
    sizes: [{ value: '', stock: 1 }],
    mediaPolicy: 'REPLACE_ALL',
    isDefault: true
  };
}

type RepositoryRfbsNormalizationFixture = {
  normalizedInput: NonNullable<ReturnType<typeof normalizeOzonRfbsStockMismatchCallback>>;
  jobRow: Record<string, unknown>;
  listingRow: Record<string, unknown>;
  mappingRows: Array<Record<string, unknown>>;
  deliveryRows: Array<Record<string, unknown>>;
};

function createRepositoryRfbsNormalizationFixture(): RepositoryRfbsNormalizationFixture {
  const now = new Date();
  const offerId = '0000105-01';
  const productId = '5874416999';
  const ozonSku = '5395936600';
  const jobId = '2fa0f3ae-0b22-4ac9-b644-dc9a63af013a';
  const variantId = 'variant-1';
  const leaseToken = '00000000-0000-4000-8000-000000000001';
  const readAt = new Date(now.getTime() - 2_000).toISOString();
  const startedAt = new Date(now.getTime() - 3_000).toISOString();
  const leaseExpiresAt = new Date(now.getTime() + 10 * 60_000).toISOString();
  const acceptedMedia = {
    sourceStageId: 'E005',
    submissionId: 'rfbs-images-submission',
    variantId,
    deliveredAt: new Date(now.getTime() - 60_000).toISOString(),
    autoPublishDecision: 'ACCEPTED',
    autoPublishAcceptanceId: jobId,
    autoPublishAcceptedAt: new Date(now.getTime() - 59_000).toISOString(),
    autoPublishAcceptedByJobId: jobId,
    autoPublishAcceptedPresetId: 'preset-rfbs',
    autoPublishAcceptedPresetRowVersion: 8,
    autoPublishAcceptedSettingsRowVersion: 12,
    autoPublishAcceptedActivationStartedAt: new Date(now.getTime() - 120_000).toISOString(),
    autoPublishAcceptedDefinitionHash: `sha256:${'c'.repeat(64)}`
  };
  const expectedOfferSnapshots = [{
    offerId,
    productVariantId: variantId,
    disposition: 'SUBMITTED',
    price: 194.38,
    oldPrice: 388.76,
    minPrice: 97.19,
    stock: 1,
    descriptionRu: 'description',
    media: { imageCount: 7, videoCount: 1 }
  }];
  const contractBody = {
    offerContractVersion: 1,
    expectedOfferIds: [offerId],
    submittedOfferIds: [offerId],
    publishOfferIds: [offerId],
    expectedOfferSnapshots
  };
  const offerContractHash = `sha256:${createHash('sha256').update(testStableJson(contractBody)).digest('hex')}`;
  const jobPayload = {
    offerIds: [offerId],
    revision: 4,
    storeAlias: 'default',
    warehouseId: '1020002456503000',
    importTaskId: '5358968564',
    materialSnapshot: { store: { fulfillmentMode: 'RFBS' } },
    mediaDeliveries: [acceptedMedia],
    ...contractBody,
    offerContractHash
  };
  const statusSnapshot = {
    displayState: 'ON_SALE',
    businessState: 'PUBLISHED',
    hasStock: true,
    stockPresent: 1,
    readAt,
    warnings: [`OZON_STOCK_DIFFERENCE：${offerId}`]
  };
  const stageStates = {
    import: 'SUCCESS',
    moderation: 'SUCCESS',
    images: 'VERIFIED',
    video: 'VERIFIED',
    productVideo: 'VERIFIED',
    videoCover: 'VERIFIED',
    price: 'VERIFIED',
    stock: 'DIFFERENCE'
  };
  const sourceInput = {
    rowVersion: 27,
    state: 'NEEDS_ATTENTION',
    eventType: 'OZON_FINAL_READBACK_MISMATCH',
    message: 'stock mismatch',
    errorCode: 'OZON_FINAL_READBACK_MISMATCH',
    errorMessage: 'stock mismatch',
    storeAlias: 'default',
    warehouseId: '1020002456503000',
    lastAppliedRevision: 4,
    leaseOwner: 'n8n:ozon:p002:190809',
    leaseToken,
    clearLease: true,
    stageStates,
    payload: {
      warnings: [{ code: 'OZON_STOCK_DIFFERENCE', offerId, expected: 1, actual: 0 }],
      verifiedOfferIds: [offerId],
      readAt,
      descriptionVerificationByOffer: [{ offerId, present: true, matches: true }]
    },
    jobPayload: {
      imageRecovery: {
        phase: 'VERIFIED', affectedOffers: [], expectedImageCount: 7, actualImageCount: 7
      },
      platformStatusWarnings: [{ code: 'OZON_STOCK_DIFFERENCE', offerId, expected: 1, actual: 0 }],
      finalConsistencyRecovery: {
        schemaVersion: 1,
        phase: 'FAILED',
        confirmationCount: 3,
        affectedOffers: [{
          offerId,
          differences: { stock: { expected: 1, actual: 0, valid: true, reasons: [] } }
        }]
      }
    },
    productMappings: [{
      offerId,
      ozonProductId: productId,
      ozonSku,
      platformStatus: 'ON_SALE',
      statusSnapshot
    }]
  };
  const authority = {
    job: {
      id: jobId,
      sku: '0000105',
      offerIds: [offerId],
      storeAlias: 'default',
      state: 'MODERATING',
      source: 'AUTO',
      taskId: jobId,
      importTaskId: '5358968564',
      payload: jobPayload,
      ozonProductLinks: [{ offerId, ozonProductId: productId, ozonSku }],
      taskFolder: '0000105__r4',
      workRelPath: 'processing/0000105__r4',
      directoryStage: 'PROCESSING',
      directorySignature: `sha256:${'a'.repeat(64)}`,
      stageStates,
      retryCount: 0,
      rowVersion: 27,
      revision: 4,
      leaseOwner: sourceInput.leaseOwner,
      leaseToken,
      leaseExpiresAt,
      createdAt: new Date(now.getTime() - 60_000).toISOString(),
      updatedAt: startedAt
    },
    listing: {
      sku: '0000105',
      productName: '潮流单肩包',
      status: 'SUBMITTING',
      rowVersion: 19,
      revision: 4,
      data: { fulfillmentMode: 'RFBS', offers: [{ offerId, productVariantId: variantId }] },
      createdAt: new Date(now.getTime() - 60_000).toISOString(),
      updatedAt: startedAt
    },
    mappings: [{
      storeAlias: 'default',
      offerId,
      sku: '0000105',
      ozonProductId: productId,
      ozonSku,
      lastAppliedRevision: 4,
      status: 'ON_SALE',
      statusSnapshot,
      updatedAt: readAt
    }]
  };
  const operations = ['infoList', 'attributesInfo', 'pricesRead', 'stocksRead', 'picturesInfo'];
  const prepared = operations.map((operation, inputIndex) => ({ json: {
    jobId,
    rowVersion: 27,
    sku: '0000105',
    storeAlias: 'default',
    leaseOwner: sourceInput.leaseOwner,
    leaseToken,
    offerIds: [offerId],
    jobPayload,
    currentState: 'MODERATING',
    importTaskId: '5358968564',
    taskFolder: '0000105__r4',
    workRelPath: 'processing/0000105__r4',
    directoryStage: 'PROCESSING',
    directorySignature: `sha256:${'a'.repeat(64)}`,
    expectedOfferIds: [offerId],
    submittedOfferIds: [offerId],
    publishOfferIds: [offerId],
    expectedOfferSnapshots,
    verifyOperation: operation,
    operation,
    requestId: `${jobId}:${operation}`,
    inputIndex
  } }));
  const responses = operations.map((operation, inputIndex) => ({ json: {
    operation,
    requestId: `${jobId}:${operation}`,
    inputIndex,
    ok: true,
    statusCode: 200,
    isWrite: false,
    deliveryState: 'RESPONDED',
    body: operation === 'stocksRead'
      ? { items: [{
          offer_id: offerId,
          product_id: productId,
          stocks: [{ type: 'rfbs', present: 1, sku: ozonSku, warehouse_ids: [] }]
        }] }
      : operation === 'picturesInfo'
        ? { items: [{ product_id: productId }] }
        : { items: [{ offer_id: offerId }] }
  } }));
  const execution = {
    id: '190809',
    workflowId: 'g3KK68BLXX7eShqa',
    status: 'running',
    startedAt,
    data: { resultData: { runData: {
      '准备平台最终校验': [{ data: { main: [prepared] } }],
      '调用 OZON-A001 最终读回': [{ data: { main: [responses] } }]
    } } }
  };
  const normalizedBeforeArchive = normalizeOzonRfbsStockMismatchCallback(
    authority as Parameters<typeof normalizeOzonRfbsStockMismatchCallback>[0],
    sourceInput as Parameters<typeof normalizeOzonRfbsStockMismatchCallback>[1],
    execution,
    now
  );
  if (!normalizedBeforeArchive?.rfbsStockReadbackAttestation) {
    throw new Error('RFBS repository fixture failed to produce an attestation');
  }
  const taskFolder = '0000105__r4';
  const archiveDate = shanghaiDateForTest(normalizedBeforeArchive.rfbsStockReadbackAttestation.checkedAt);
  const workRelPath = `success/${archiveDate}/${taskFolder}`;
  const directorySignature = `sha256:${'a'.repeat(64)}`;
  const videoCacheCleanedAt = normalizedBeforeArchive.rfbsStockReadbackAttestation.checkedAt;
  const normalizedInput: RepositoryRfbsNormalizationFixture['normalizedInput'] = {
    ...normalizedBeforeArchive,
    revision: 4,
    taskFolder,
    workRelPath,
    directoryStage: 'SUCCESS',
    directorySignature,
    jobPayload: {
      ...(normalizedBeforeArchive.jobPayload || {}),
      videoCacheCleanedAt,
      revision: 4,
      taskFolder,
      workRelPath,
      directoryStage: 'SUCCESS',
      directorySignature
    }
  };
  return {
    normalizedInput,
    jobRow: {
      id: jobId,
      sku: '0000105',
      offer_ids: [offerId],
      store_alias: 'default',
      listing_revision: 4,
      state: 'MODERATING',
      source: 'AUTO',
      task_id: jobId,
      import_task_id: '5358968564',
      payload: jobPayload,
      product_links: [{ offerId, ozonProductId: productId, ozonSku }],
      task_folder: '0000105__r4',
      work_rel_path: 'processing/0000105__r4',
      directory_stage: 'PROCESSING',
      directory_signature: `sha256:${'a'.repeat(64)}`,
      stage_states: stageStates,
      retry_count: 0,
      row_version: 27,
      lease_owner: sourceInput.leaseOwner,
      lease_token: leaseToken,
      lease_expires_at: leaseExpiresAt,
      created_at: new Date(now.getTime() - 60_000).toISOString(),
      updated_at: startedAt
    },
    listingRow: {
      sku: '0000105',
      product_name_snapshot: '潮流单肩包',
      status: 'SUBMITTING',
      row_version: 19,
      revision: 4,
      data: { fulfillmentMode: 'RFBS', offers: [{ offerId, productVariantId: variantId }] },
      created_at: new Date(now.getTime() - 60_000).toISOString(),
      updated_at: startedAt
    },
    mappingRows: [{
      store_alias: 'default',
      offer_id: offerId,
      sku: '0000105',
      ozon_product_id: productId,
      ozon_sku: ozonSku,
      last_applied_revision: 4,
      status: 'ON_SALE',
      status_snapshot: statusSnapshot,
      last_verified_at: readAt,
      updated_at: readAt
    }],
    deliveryRows: [{
      sku: '0000105',
      source_stage_id: acceptedMedia.sourceStageId,
      submission_id: acceptedMedia.submissionId,
      variant_id: acceptedMedia.variantId,
      job_id: jobId,
      payload: acceptedMedia,
      received_at: acceptedMedia.deliveredAt,
      updated_at: acceptedMedia.autoPublishAcceptedAt
    }, {
      sku: '0000105',
      source_stage_id: 'E004',
      submission_id: 'unrelated-historical-submission',
      variant_id: 'variant-unrelated',
      job_id: jobId,
      payload: {
        ...acceptedMedia,
        sourceStageId: 'E004',
        submissionId: 'unrelated-historical-submission',
        variantId: 'variant-unrelated'
      },
      received_at: acceptedMedia.deliveredAt,
      updated_at: acceptedMedia.autoPublishAcceptedAt
    }]
  };
}

function createRfbsNormalizationRepository(fixture: RepositoryRfbsNormalizationFixture): {
  repository: OzonRepository;
  query: ReturnType<typeof vi.fn>;
  mutationQueries: () => unknown[][];
} {
  let currentJob = { ...fixture.jobRow };
  const query = vi.fn(async (sqlInput: unknown, valuesInput?: unknown[]) => {
    const sql = String(sqlInput);
    const values = valuesInput || [];
    if (sql.includes('SELECT * FROM ozon_publish_jobs WHERE id=$1 FOR UPDATE')) {
      return { rows: [currentJob], rowCount: 1 };
    }
    if (sql.includes('SELECT * FROM ozon_listing_drafts WHERE sku=$1 FOR UPDATE')) {
      return { rows: [fixture.listingRow], rowCount: 1 };
    }
    if (sql.includes('SELECT * FROM ozon_media_deliveries')) {
      const row = fixture.deliveryRows.find((delivery) => (
        delivery.sku === values[0]
        && delivery.source_stage_id === values[1]
        && delivery.submission_id === values[2]
        && delivery.variant_id === values[3]
      ));
      return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
    }
    if (sql.includes('SELECT * FROM ozon_product_mappings')) {
      return { rows: fixture.mappingRows, rowCount: fixture.mappingRows.length };
    }
    if (sql.includes('INSERT INTO ozon_product_mappings')) {
      const row = {
        ...fixture.mappingRows[0],
        status: values[8],
        status_snapshot: parseTestRecord(values[9]),
        updated_at: new Date().toISOString()
      };
      return { rows: [row], rowCount: 1 };
    }
    if (sql.includes('SELECT lease_token,lease_expires_at FROM ozon_platform_status_refresh_leases')) {
      return { rows: [], rowCount: 0 };
    }
    if (sql.includes('UPDATE ozon_media_deliveries')) {
      const row = fixture.deliveryRows.find((delivery) => (
        delivery.sku === values[0]
        && delivery.source_stage_id === values[1]
        && delivery.submission_id === values[2]
        && delivery.variant_id === values[3]
        && delivery.job_id === values[4]
        && testStableJson(delivery.payload) === testStableJson(parseTestRecord(values[8]))
      ));
      if (!row || String(parseTestRecord(row.payload).autoPublishDecision) !== 'ACCEPTED') {
        return { rows: [], rowCount: 0 };
      }
      row.payload = {
        ...parseTestRecord(row.payload),
        autoPublishDecision: 'CONSUMED_REMOTE',
        autoPublishConsumedAt: values[5],
        representedOfferIds: parseTestArray(values[6]),
        consumedByAutomaticJobId: values[7]
      };
      return { rows: [row], rowCount: 1 };
    }
    if (sql.includes('UPDATE ozon_publish_jobs')) {
      currentJob = {
        ...currentJob,
        state: values[1],
        stage_states: parseTestRecord(values[2]),
        payload: parseTestRecord(values[9]),
        next_attempt_at: values[10],
        offer_ids: parseTestArray(values[12]),
        store_alias: values[13],
        task_folder: values[14],
        work_rel_path: values[15],
        directory_stage: values[16],
        directory_signature: values[17],
        listing_revision: values[19],
        lease_owner: values[20],
        lease_token: values[21],
        lease_expires_at: values[22],
        row_version: Number(currentJob.row_version) + 1,
        updated_at: new Date().toISOString()
      };
      return { rows: [currentJob], rowCount: 1 };
    }
    if (sql.includes('UPDATE ozon_listing_drafts')
      || sql.includes('DELETE FROM ozon_publish_slots')
      || sql.includes('INSERT INTO ozon_publish_events')) {
      return { rows: [], rowCount: 1 };
    }
    throw new Error(`unexpected RFBS repository query: ${sql}`);
  });
  const repository = new OzonRepository('postgres://not-used');
  Object.defineProperty(repository, 'transaction', {
    value: async (operation: (client: unknown) => Promise<unknown>) => operation({ query })
  });
  return {
    repository,
    query,
    mutationQueries: () => query.mock.calls.filter(([sql]) => /^\s*(UPDATE|INSERT|DELETE)\b/i.test(String(sql)))
  };
}

function parseTestRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
  const parsed: unknown = JSON.parse(String(value || '{}'));
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
    ? parsed as Record<string, unknown>
    : {};
}

function parseTestArray(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  const parsed: unknown = JSON.parse(String(value || '[]'));
  return Array.isArray(parsed) ? parsed : [];
}

function setRfbsArchiveWorkRelPath(
  fixture: RepositoryRfbsNormalizationFixture,
  workRelPath: string
): void {
  fixture.normalizedInput.workRelPath = workRelPath;
  fixture.normalizedInput.jobPayload = {
    ...(fixture.normalizedInput.jobPayload || {}),
    workRelPath
  };
}

function shanghaiDateForTest(value: string): string {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(new Date(value));
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((entry) => entry.type === type)?.value || '';
  return `${part('year')}-${part('month')}-${part('day')}`;
}

function testStableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(testStableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${testStableJson(entry)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

describe('OZON current-preset recovery gateway serialization', () => {
  it('takes the preparation advisory before evidence count and blocks a ledger committed by the earlier gateway owner', async () => {
    const preparationJobId = '10000000-0000-4000-8000-000000000201';
    const publicationId = '20000000-0000-4000-8000-000000000202';
    const childJobId = '30000000-0000-4000-8000-000000000203';
    const storeId = '40000000-0000-4000-8000-000000000204';
    const originalFanoutPlanHash = `sha256:${'a'.repeat(64)}`;
    const parent = {
      id: preparationJobId,
      sku: '0000152',
      source: 'AUTO',
      task_kind: 'SHARED_PREPARATION',
      state: 'NEEDS_ATTENTION',
      row_version: 7,
      payload: { multistorePreparation: true, fanoutPlan: { planHash: originalFanoutPlanHash } },
      product_links: [],
      directory_stage: 'INBOX'
    };
    const publication = {
      id: publicationId,
      store_id: storeId,
      source: 'AUTOMATION',
      status: 'NEEDS_ATTENTION',
      row_version: 3,
      plan_hash: originalFanoutPlanHash,
      planned_job_id: childJobId,
      product_ids: [],
      ozon_skus: [],
      product_links: [],
      materialized_product_snapshot: {},
      error_code: 'CONFIG_INVALID'
    };
    const child = {
      id: childJobId,
      publication_id: publicationId,
      task_kind: 'STORE_PUBLICATION',
      state: 'NEEDS_ATTENTION',
      row_version: 2,
      task_id: 'serialized-child-task',
      payload: { attemptPhase: 'LOCAL_VALIDATION' },
      product_links: [],
      directory_stage: 'INBOX',
      last_error_code: 'CONFIG_INVALID'
    };
    const calls: Array<{ sql: string; params?: unknown[] }> = [];
    const query = vi.fn(async (sqlInput: unknown, params?: unknown[]) => {
      const sql = String(sqlInput);
      calls.push({ sql, params });
      if (sql.includes('pg_advisory_xact_lock')) return { rows: [], rowCount: 1 };
      if (sql.includes('FROM ozon_publish_jobs WHERE id=$1')) return { rows: [parent], rowCount: 1 };
      if (sql.includes('FROM ozon_gateway_requests')) return { rows: [{ count: '1' }], rowCount: 1 };
      if (sql.includes('FROM ozon_store_publications')) return { rows: [publication], rowCount: 1 };
      if (sql.includes('WHERE publication_id=ANY')) return { rows: [child], rowCount: 1 };
      if (sql.includes('FROM ozon_media_deliveries')) {
        return { rows: [{
          source_stage_id: 'E005', submission_id: 'images', variant_id: 'brown',
          payload: { autoPublishDecision: 'ACCEPTED' }
        }], rowCount: 1 };
      }
      if (sql.includes('COUNT(*) count')) return { rows: [{ count: '0' }], rowCount: 1 };
      throw new Error(`unexpected recovery serialization query: ${sql}`);
    });
    const repository = new OzonRepository('postgres://not-used');
    vi.spyOn(repository, 'getJob').mockResolvedValue({ sku: '0000152' } as any);
    Object.defineProperty(repository, 'transaction', {
      value: async (operation: (client: unknown) => Promise<unknown>) => operation({ query })
    });
    const hash = (character: string) => `sha256:${character.repeat(64)}`;

    await expect(repository.replaceAutomaticPreparationWithCurrentPreset({
      jobId: preparationJobId,
      expectedJobRowVersion: 7,
      requestId: '50000000-0000-5000-8000-000000000205',
      planHash: hash('b'),
      expectedEvidenceHash: hash('c'),
      expectedFanoutPlanHash: originalFanoutPlanHash,
      expectedListingRowVersion: 8,
      expectedListingRevision: 4,
      expectedGeneratedVersionId: '60000000-0000-4000-8000-000000000206',
      expectedMaterialHash: hash('d'),
      expectedDataSignature: hash('e'),
      expectedCurrentPlanHash: hash('f'),
      expectedPlanContractHash: hash('1'),
      expectedSettingsRowVersion: 6,
      expectedRootDirectoryHash: hash('2'),
      expectedVariantColorAuthorityHash: hash('3'),
      targetStores: [{
        id: storeId,
        rowVersion: 3,
        configVersion: 4,
        credentialVersionId: '70000000-0000-4000-8000-000000000207',
        presetId: '80000000-0000-4000-8000-000000000208',
        presetRowVersion: 5,
        presetDefinitionHash: hash('4'),
        presetSnapshotHash: hash('5'),
        publicationMode: 'CREATE_ONLY',
        warehouseId: 'warehouse-1',
        fulfillmentMode: 'FBS',
        accountCurrency: 'RUB',
        expectedOfferIds: ['0000152-01'],
        categoryKey: 'ozon_shoes',
        expectedPublishedCategoryVersionId: '90000000-0000-4000-8000-000000000209',
        expectedProductSnapshotHash: hash('6'),
        expectedProductContractHash: hash('7'),
        expectedModeEvidenceHash: hash('8')
      }]
    })).rejects.toMatchObject({
      code: 'OZON_READBACK_REQUIRED',
      details: { blockers: expect.arrayContaining(['GATEWAY_EVIDENCE_PRESENT']) }
    });

    const boundaryIndex = calls.findIndex((entry) => entry.params?.[0]
      === ozonPreparationGatewayBoundaryLockKey(preparationJobId));
    const gatewayCountIndex = calls.findIndex((entry) => entry.sql.includes('FROM ozon_gateway_requests'));
    expect(boundaryIndex).toBeGreaterThan(0);
    expect(gatewayCountIndex).toBeGreaterThan(boundaryIndex);
    expect(calls.some((entry) => /^\s*(INSERT|UPDATE|DELETE)\b/i.test(entry.sql))).toBe(false);
  });
});
