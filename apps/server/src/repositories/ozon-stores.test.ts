import { describe, expect, it, vi } from 'vitest';
import { OZON_DEFAULT_STORE_ID } from '@n8n-media-review/shared';
import { evaluateOzonPreflightCurrency, OzonStoreRepository, parseImportedNoBrandFailures } from './ozon-stores.js';

describe('OZON imported no-brand recovery evidence', () => {
  const failure = [{
    offer_id: '0000122-01', product_id: 5929063200, status: 'imported',
    errors: [{
      code: 'error_attribute_values_out_of_range', attribute_id: 85,
      attribute_name: 'Бренд', level: 'error'
    }]
  }];

  it('accepts only the exact imported product plus attribute 85 business rejection', () => {
    expect(parseImportedNoBrandFailures(JSON.stringify(failure), ['0000122-01']))
      .toEqual([{ offerId: '0000122-01', productId: '5929063200', errors: failure[0].errors }]);
  });

  it.each([
    [{ ...failure[0], product_id: undefined }],
    [{ ...failure[0], status: 'failed' }],
    [{ ...failure[0], errors: [{ ...failure[0].errors[0], attribute_id: 86 }] }],
    [{ ...failure[0], errors: [...failure[0].errors, { code: 'another_error', level: 'error' }] }]
  ])('rejects incomplete, different-attribute, or mixed platform failures', (candidate) => {
    expect(() => parseImportedNoBrandFailures(JSON.stringify([candidate]), ['0000122-01']))
      .toThrowError(/禁止自动纠正/);
  });
});

describe('OZON latest manual publication task summaries', () => {
  const baseRow = {
    id: '11111111-1111-4111-8111-111111111111',
    summary_job_id: '21111111-1111-4111-8111-111111111111',
    summary_task_id: 'task-1',
    sku: '0000140',
    generated_version_id: '31111111-1111-4111-8111-111111111111',
    revision: 3,
    plan_hash: `sha256:${'a'.repeat(64)}`,
    store_id: '41111111-1111-4111-8111-111111111111',
    store_alias_snapshot: 'glauke',
    store_display_name_snapshot: 'Glauke Shop',
    status: 'SUCCEEDED',
    publication_mode: 'CREATE_ONLY',
    preset_id: '51111111-1111-4111-8111-111111111111',
    preset_row_version: 7,
    offer_ids: ['0000140-01', '0000140-02'],
    product_links: [],
    summary_job_payload: { presetName: '女包默认预设' },
    summary_job_product_links: [
      { offerId: '0000140-02', ozonProductId: '9002', ozonSku: '54620002', url: 'https://www.ozon.ru/product/bag-54620002/' },
      { offerId: '0000140-01', ozonProductId: '9001', ozonSku: '54620001', url: 'https://www.ozon.ru/product/bag-54620001/' }
    ],
    source_preset_id: null,
    summary_store_enabled: true,
    summary_store_archived_at: null,
    summary_unsafe_gateway_count: 0,
    current_material_revision: 4,
    current_generated_version_id: '61111111-1111-4111-8111-111111111111',
    row_version: 8,
    created_at: '2026-08-14T01:00:00.000Z',
    updated_at: '2026-08-14T02:00:00.000Z'
  };

  it('retains all stores in the latest batch and joins links by offerId', async () => {
    const second = {
      ...baseRow,
      id: '12222222-2222-4222-8222-222222222222',
      summary_job_id: '22222222-2222-4222-8222-222222222222',
      store_id: '42222222-2222-4222-8222-222222222222',
      store_alias_snapshot: 'tek-plus',
      store_display_name_snapshot: 'Tek+',
      source_preset_id: baseRow.preset_id
    };
    const query = vi.fn(async () => ({ rows: [baseRow, second], rowCount: 2 }));
    const repository = new OzonStoreRepository();
    (repository as any).pool = { query };

    const summaries = await repository.listLatestManualPublicationTaskSummaries(['0000140', '0000140']);

    expect(query).toHaveBeenCalledWith(expect.stringContaining("COALESCE(NULLIF(p.plan_hash,''),'legacy:'||p.generated_version_id::text)"), [['0000140']]);
    expect(query.mock.calls[0]?.[0]).toContain('JOIN latest ON latest.sku=p.sku AND latest.batch_key=p.batch_key');
    expect(summaries).toHaveLength(2);
    expect(summaries[0]).toMatchObject({
      storeDisplayName: 'Glauke Shop',
      currentMaterialRevision: 4,
      presetBinding: { presetName: '女包默认预设', presetRowVersion: 7, sourcePresetExists: false },
      capabilities: { canRepublish: true }
    });
    expect(summaries[0]?.productLinks.map((link) => link.offerId)).toEqual(['0000140-02', '0000140-01']);
  });

  it('omits conflicting structured identities and uses only a frozen preset name', async () => {
    const row = {
      ...baseRow,
      summary_job_payload: {},
      materialized_product_snapshot: { materialSnapshot: { preset: { name: '冻结产物预设' } } },
      summary_job_product_links: [
        { offerId: '0000140-01', ozonProductId: '9001', ozonSku: '54620001', url: 'https://www.ozon.ru/product/bag-54620001/' },
        { offerId: '0000140-01', ozonProductId: 'DIFFERENT', ozonSku: '54629999', url: 'https://www.ozon.ru/product/bag-54629999/' }
      ]
    };
    const query = vi.fn(async () => ({ rows: [row], rowCount: 1 }));
    const repository = new OzonStoreRepository();
    (repository as any).pool = { query };

    const [summary] = await repository.listLatestManualPublicationTaskSummaries(['0000140']);

    expect(summary?.presetBinding?.presetName).toBe('冻结产物预设');
    expect(summary?.productLinks).toEqual([]);
    expect(summary?.linkWarning).toContain('0000140-01');
  });
});

describe('OZON store preflight currency contract', () => {
  it.each([
    ['CNY', 'CNY'],
    ['RUB', 'RUB']
  ] as const)('accepts verified %s evidence for a %s store', (configuredCurrency, observedCurrency) => {
    expect(evaluateOzonPreflightCurrency(configuredCurrency, {
      status: 'VERIFIED', currency: observedCurrency, source: 'SELLER_INFO', evidence: {}
    })).toMatchObject({ verified: true, mismatch: false, observedCurrency });
  });

  it.each([
    ['CNY', 'RUB'],
    ['RUB', 'CNY']
  ] as const)('fails closed when configured %s differs from observed %s', (configuredCurrency, observedCurrency) => {
    expect(evaluateOzonPreflightCurrency(configuredCurrency, {
      status: 'VERIFIED', currency: observedCurrency, source: 'SELLER_INFO', evidence: {}
    })).toMatchObject({
      verified: false,
      mismatch: true,
      observedCurrency,
      errorCode: 'OZON_CURRENCY_MISMATCH',
      errorMessage: expect.stringContaining(`店铺配置 ${configuredCurrency} 不一致`)
    });
  });

  it('does not treat deferred or missing evidence as verified', () => {
    expect(evaluateOzonPreflightCurrency('CNY', {
      status: 'DEFERRED_EMPTY_CATALOG', source: 'EMPTY_CATALOG', evidence: {}
    })).toMatchObject({ verified: false, mismatch: false, errorCode: 'OZON_CURRENCY_NOT_VERIFIED' });
  });

  it('treats accountCurrency as semantic store config and makes the previous preflight stale', async () => {
    const current = {
      id: '11111111-1111-4111-8111-111111111111', store_alias: 'tek-plus', display_name: 'Tek+',
      enabled: true, auto_publish_enabled: true, auto_publish_mode: 'CREATE_ONLY',
      default_preset_id: '22222222-2222-4222-8222-222222222222', warehouse_id: 'warehouse-1',
      warehouse_name: 'Warehouse', fulfillment_mode: 'FBS', account_currency: 'RUB', max_daily_styles: 100,
      credential_state: 'ACTIVE', credential_binding_mode: 'VAULT',
      active_credential_version_id: '33333333-3333-4333-8333-333333333333',
      seller_id: 'seller-1', permissions: [], limits: {}, warehouses: [], preflight_status: 'PASSED',
      preflight_checked_at: '2026-08-11T00:00:00.000Z', preflight_due_at: '2026-08-11T18:00:00.000Z',
      preflight_expires_at: '2026-08-12T00:00:00.000Z',
      preflight_report: { currencyVerification: { status: 'VERIFIED', currency: 'RUB' } },
      config_version: 4, row_version: 9, active_task_count: 0, queued_task_count: 0,
      created_at: '2026-08-10T00:00:00.000Z', updated_at: '2026-08-11T00:00:00.000Z'
    };
    const updated = {
      ...current, account_currency: 'CNY', preflight_status: 'STALE', config_version: 5, row_version: 10,
      updated_at: '2026-08-11T01:00:00.000Z'
    };
    const calls: Array<{ text: string; values?: unknown[] }> = [];
    const client = {
      query: vi.fn(async (text: string, values?: unknown[]) => {
        calls.push({ text, values });
        if (text.startsWith('SELECT * FROM ozon_stores')) return { rows: [current], rowCount: 1 };
        if (text.startsWith('UPDATE ozon_stores SET')) return { rows: [updated], rowCount: 1 };
        if (text.includes('FROM ozon_stores s')) return { rows: [updated], rowCount: 1 };
        return { rows: [], rowCount: 0 };
      }),
      release: vi.fn()
    };
    const repository = new OzonStoreRepository();
    (repository as any).pool = { connect: vi.fn(async () => client) };

    await expect(repository.updateStore(current.id, { accountCurrency: 'CNY', rowVersion: 9 }))
      .resolves.toMatchObject({ accountCurrency: 'CNY', configVersion: 5, rowVersion: 10, preflight: { status: 'STALE' } });

    const update = calls.find((call) => call.text.startsWith('UPDATE ozon_stores SET'));
    expect(update?.values?.[8]).toBe('CNY');
    expect(update?.values?.[11]).toBe(true);
    expect(calls.some((call) => call.text.includes('UPDATE ozon_store_runtime_state SET'))).toBe(true);
  });
});

describe('OZON exact store readback credential contract', () => {
  const storeId = '11111111-1111-4111-8111-111111111111';
  const credentialId = '22222222-2222-4222-8222-222222222222';
  const row = {
    store_id: storeId,
    store_alias: 'tek-plus',
    store_enabled: true,
    archived_at: null,
    store_config_version: 7,
    warehouse_id: 'warehouse-1',
    active_credential_version_id: credentialId,
    credential_id: credentialId,
    credential_store_id: storeId,
    version_no: 3,
    credential_status: 'ACTIVE',
    ciphertext: 'ciphertext',
    nonce: 'nonce',
    auth_tag: 'tag',
    fingerprint: 'fingerprint',
    key_version: 1
  };

  function repositoryWith(rowValue: Record<string, unknown>) {
    const query = vi.fn(async () => ({ rows: [rowValue], rowCount: 1 }));
    const repository = new OzonStoreRepository();
    (repository as any).pool = { query };
    return { repository, query };
  }

  it('loads only the caller-frozen credential ID belonging to the exact enabled store config', async () => {
    const { repository, query } = repositoryWith(row);
    await expect(repository.getExactStoreReadbackIdentity({
      storeId,
      expectedStoreConfigVersion: 7,
      expectedCredentialVersionId: credentialId
    })).resolves.toMatchObject({
      storeId,
      storeAlias: 'tek-plus',
      storeEnabled: true,
      storeConfigVersion: 7,
      credentialVersionId: credentialId,
      credentialBindingMode: 'VAULT',
      credential: { id: credentialId, storeId, version: 3, status: 'ACTIVE' }
    });
    expect(query).toHaveBeenCalledWith(expect.stringContaining('c.id=$2::uuid'), [storeId, credentialId]);
  });

  it.each([
    [{ ...row, store_enabled: false }, 'OZON_STORE_NOT_READY'],
    [{ ...row, archived_at: '2026-08-13T00:00:00.000Z' }, 'OZON_STORE_NOT_READY'],
    [{ ...row, store_config_version: 8 }, 'VERSION_CONFLICT'],
    [{ ...row, credential_id: null }, 'OZON_CREDENTIAL_MISSING'],
    [{ ...row, credential_status: 'RETIRED' }, 'OZON_CREDENTIAL_STALE'],
    [{ ...row, active_credential_version_id: '33333333-3333-4333-8333-333333333333' }, 'OZON_CREDENTIAL_STALE']
  ])('fails closed instead of selecting a replacement credential for %s', async (candidate, code) => {
    const { repository } = repositoryWith(candidate);
    await expect(repository.getExactStoreReadbackIdentity({
      storeId,
      expectedStoreConfigVersion: 7,
      expectedCredentialVersionId: credentialId
    })).rejects.toMatchObject({ code, statusCode: 409 });
  });
});

describe('OZON 0000136 variant color repair intent contract', () => {
  const publicationId = '11111111-1111-4111-8111-111111111111';
  const jobId = '22222222-2222-4222-8222-222222222222';
  const storeId = '33333333-3333-4333-8333-333333333333';
  const credentialId = '44444444-4444-4444-8444-444444444444';
  const requestRef = `ozon-color-repair:${publicationId}:${'a'.repeat(64)}:v1`;
  const input = {
    publicationId,
    publicationRowVersion: 7,
    taskId: 'default__0000136__r1',
    storeConfigVersion: 12,
    credentialVersionId: credentialId,
    requestRef,
    requestHash: `sha256:${'b'.repeat(64)}`,
    payloadHash: `sha256:${'c'.repeat(64)}`,
    planHash: `sha256:${'d'.repeat(64)}`,
    offerIds: ['0000136-01', '0000136-02'],
    evidence: { authorityHash: `sha256:${'e'.repeat(64)}` }
  };
  const lockedRow = {
    id: publicationId,
    publication_row_version: 7,
    status: 'SUCCEEDED',
    store_id: storeId,
    task_id: input.taskId,
    offer_ids: input.offerIds,
    credential_binding_mode: 'VAULT',
    credential_version_id: credentialId,
    frozen_store_config_version: 12,
    job_id: jobId,
    job_state: 'SUCCEEDED',
    job_task_id: input.taskId,
    lease_owner: null,
    lease_token: null,
    lease_expires_at: null,
    store_enabled: true,
    store_archived_at: null,
    current_store_config_version: 12,
    credential_id: credentialId,
    credential_status: 'ACTIVE'
  };

  it('persists the immutable UNKNOWN ledger and single-write slot before any external request', async () => {
    const calls: Array<{ sql: string; values?: unknown[] }> = [];
    const client = {
      query: vi.fn(async (sql: string, values?: unknown[]) => {
        calls.push({ sql, values });
        if (sql.includes('FROM ozon_store_publications p')) return { rows: [lockedRow], rowCount: 1 };
        if (sql.includes('FROM ozon_gateway_requests WHERE request_ref')) return { rows: [], rowCount: 0 };
        if (sql.includes("delivery_state='UNKNOWN'")) return { rows: [{ exists: false }], rowCount: 1 };
        if (sql.includes('FROM ozon_publish_slots WHERE slot_key')) return { rows: [{ exists: false }], rowCount: 1 };
        return { rows: [], rowCount: 1 };
      }),
      release: vi.fn()
    };
    const repository = new OzonStoreRepository();
    (repository as any).pool = { connect: vi.fn(async () => client) };

    const result = await repository.beginVariantColorRepairIntent(input);

    expect(result).toMatchObject({ requestRef, leaseToken: expect.any(String) });
    const slotIndex = calls.findIndex(({ sql }) => sql.includes('INSERT INTO ozon_publish_slots'));
    const ledgerIndex = calls.findIndex(({ sql }) => sql.includes('INSERT INTO ozon_gateway_requests'));
    const eventIndex = calls.findIndex(({ sql }) => sql.includes('OZON_VARIANT_COLOR_REPAIR_INTENT'));
    expect(slotIndex).toBeGreaterThan(-1);
    expect(ledgerIndex).toBeGreaterThan(slotIndex);
    expect(eventIndex).toBeGreaterThan(ledgerIndex);
    expect(calls[ledgerIndex]?.sql).toContain("'attributesUpdate','UNKNOWN','READBACK_REQUIRED'");
  });

  it('returns the matching requestRef ledger without acquiring another slot or creating another intent', async () => {
    const calls: string[] = [];
    const existing = {
      request_ref: requestRef,
      request_hash: input.requestHash,
      payload_hash: input.payloadHash,
      publication_id: publicationId,
      operation: 'attributesUpdate',
      delivery_state: 'UNKNOWN'
    };
    const client = {
      query: vi.fn(async (sql: string) => {
        calls.push(sql);
        if (sql.includes('FROM ozon_store_publications p')) return { rows: [lockedRow], rowCount: 1 };
        if (sql.includes('FROM ozon_gateway_requests WHERE request_ref')) return { rows: [existing], rowCount: 1 };
        return { rows: [], rowCount: 1 };
      }),
      release: vi.fn()
    };
    const repository = new OzonStoreRepository();
    (repository as any).pool = { connect: vi.fn(async () => client) };

    await expect(repository.beginVariantColorRepairIntent(input)).resolves.toMatchObject({
      requestRef,
      existing: expect.objectContaining({ request_ref: requestRef, delivery_state: 'UNKNOWN' })
    });
    expect(calls.some((sql) => sql.includes('INSERT INTO ozon_publish_slots'))).toBe(false);
    expect(calls.some((sql) => sql.includes('OZON_VARIANT_COLOR_REPAIR_INTENT'))).toBe(false);
  });
});

describe('OZON automatic listing snapshot repository contract', () => {
  it('fails closed with no fallback when a legacy automatic job has no publication/version binding', async () => {
    const query = vi.fn(async () => ({
      rows: [{
        id: '50000000-0000-4000-8000-000000000041',
        publication_id: null,
        publication_row: null,
        generated_version_id: null,
        listing_snapshot: null
      }],
      rowCount: 1
    }));
    const repository = new OzonStoreRepository();
    (repository as any).pool = { query };

    await expect(repository.getAutomaticListingSnapshotContext('50000000-0000-4000-8000-000000000041'))
      .rejects.toMatchObject({
        code: 'VERSION_CONFLICT',
        statusCode: 409,
        details: { noFallback: true }
      });
  });
});

describe('OZON publication task-detail recovery evidence', () => {
  it('does not classify a fixed planned taskId as local once independent remote progress exists', async () => {
    const publicationId = '11111111-1111-4111-8111-111111111111';
    const jobId = '22222222-2222-4222-8222-222222222222';
    const createdAt = '2026-08-13T00:00:00.000Z';
    const planHash = `sha256:${'a'.repeat(64)}`;
    const jobRow = {
      id: jobId,
      sku: '0000132',
      state: 'NEEDS_ATTENTION',
      source: 'AUTO',
      task_kind: 'STORE_PUBLICATION',
      task_id: 'default__0000132__r2',
      import_task_id: 'remote-import-132',
      store_id: OZON_DEFAULT_STORE_ID,
      store_alias: 'default',
      publication_id: publicationId,
      credential_binding_mode: 'VAULT',
      store_config_version: 2,
      warehouse_id: 'warehouse-1',
      offer_ids: ['0000132-01'],
      product_links: [],
      listing_revision: 2,
      payload: {
        schemaVersion: 4,
        mode: 'MULTISTORE_PUBLICATION',
        attemptPhase: 'PLANNED',
        publicationId,
        planHash
      },
      stage_states: {},
      retry_count: 0,
      row_version: 4,
      created_at: createdAt,
      updated_at: createdAt
    };
    const row = {
      id: publicationId,
      sku: '0000132',
      generated_version_id: '33333333-3333-4333-8333-333333333333',
      revision: 2,
      store_id: OZON_DEFAULT_STORE_ID,
      store_alias_snapshot: 'default',
      store_display_name_snapshot: 'OZON 主店',
      status: 'NEEDS_ATTENTION',
      source: 'AUTOMATION',
      credential_binding_mode: 'VAULT',
      store_config_version: 2,
      planned_job_id: jobId,
      request_id: '44444444-4444-4444-8444-444444444444',
      plan_hash: planHash,
      content_policy_version: 'merchroute-ozon-content-v3',
      material_hash: `sha256:${'b'.repeat(64)}`,
      material_hash_version: 'ozon-shared-material-v1',
      task_id: 'default__0000132__r2',
      warehouse_id: 'warehouse-1',
      fulfillment_mode: 'FBS',
      account_currency: 'RUB',
      publication_mode: 'CREATE_ONLY',
      offer_ids: ['0000132-01'],
      offer_contract_hash: `sha256:${'c'.repeat(64)}`,
      materialization_hash: `sha256:${'d'.repeat(64)}`,
      product_ids: [],
      ozon_skus: [],
      product_links: [],
      result_json: {},
      row_version: 3,
      created_at: createdAt,
      updated_at: createdAt,
      system_enabled: true,
      admin_api_webhook_url: 'http://n8n.test/webhook/ozon-admin',
      events: [],
      gateway_rows: [],
      job_row: jobRow
    };
    const query = vi.fn(async () => ({ rows: [row], rowCount: 1 }));
    const repository = new OzonStoreRepository();
    (repository as any).pool = { query };

    await expect(repository.getPublicationTaskDetail(publicationId)).resolves.toMatchObject({
      readback: { required: false, canRecheck: true, gatewayRequestCount: 0 },
      recovery: { canRecheck: true, recoveryMode: 'READBACK_REQUIRED' }
    });
  });
});

describe('OZON planned publication persistence contract', () => {
  it('keeps the migration-018 publication columns and SQL parameters aligned', async () => {
    const publicationId = '11111111-1111-4111-8111-111111111111';
    const jobId = '22222222-2222-4222-8222-222222222222';
    const storeId = '33333333-3333-4333-8333-333333333333';
    const generatedVersionId = '44444444-4444-4444-8444-444444444444';
    const requestId = '55555555-5555-4555-8555-555555555555';
    const planHash = `sha256:${'a'.repeat(64)}`;
    const materialHash = `sha256:${'b'.repeat(64)}`;
    const publicationRow = {
      id: publicationId,
      sku: '0000132',
      generated_version_id: generatedVersionId,
      revision: 2,
      store_id: storeId,
      store_alias_snapshot: 'store-1',
      store_display_name_snapshot: 'Store 1',
      status: 'PLANNED',
      source: 'AUTOMATION',
      credential_binding_mode: 'VAULT',
      credential_version_id: '66666666-6666-4666-8666-666666666666',
      store_config_version: 3,
      preset_id: '77777777-7777-4777-8777-777777777777',
      preset_row_version: 4,
      preset_snapshot: {},
      preset_definition_hash: `sha256:${'c'.repeat(64)}`,
      preparation_job_id: '88888888-8888-4888-8888-888888888888',
      planned_job_id: jobId,
      request_id: requestId,
      plan_hash: planHash,
      content_policy_version: 'merchroute-ozon-content-v3',
      material_hash: materialHash,
      material_hash_version: 'ozon-shared-material-v1',
      publication_mode: 'CREATE_ONLY',
      task_id: 'store-1__0000132__r2',
      warehouse_id: 'warehouse-1',
      warehouse_name: 'Warehouse 1',
      fulfillment_mode: 'FBS',
      account_currency: 'RUB',
      offer_ids: ['0000132-01'],
      offer_contract_hash: `sha256:${'d'.repeat(64)}`,
      materialization_hash: `sha256:${'e'.repeat(64)}`,
      product_ids: [],
      ozon_skus: [],
      product_links: [],
      result_json: {},
      row_version: 1,
      created_at: '2026-08-14T00:00:00.000Z',
      updated_at: '2026-08-14T00:00:00.000Z'
    };
    let publicationSelectCount = 0;
    const query = vi.fn(async (text: string, values?: unknown[]) => {
      if (text.startsWith('SELECT * FROM ozon_store_publications')) {
        publicationSelectCount += 1;
        return publicationSelectCount === 1
          ? { rows: [], rowCount: 0 }
          : { rows: [publicationRow], rowCount: 1 };
      }
      if (text.includes('FROM ozon_publish_jobs')) return { rows: [], rowCount: 0 };
      if (text.startsWith('INSERT INTO ozon_store_publications')) {
        expect(text).toContain('$32::jsonb');
        expect(text).not.toContain('$33');
        expect(values).toHaveLength(32);
      }
      return { rows: [], rowCount: 1 };
    });
    const client = { query, release: vi.fn() };
    const repository = new OzonStoreRepository();
    (repository as any).pool = { connect: vi.fn(async () => client) };

    await expect(repository.planPublicationAttempt({
      id: publicationId,
      jobId,
      sku: '0000132',
      generatedVersionId,
      revision: 2,
      storeId,
      storeAlias: 'store-1',
      storeDisplayName: 'Store 1',
      source: 'AUTOMATION',
      credentialBindingMode: 'VAULT',
      credentialVersionId: publicationRow.credential_version_id,
      storeConfigVersion: 3,
      presetId: publicationRow.preset_id,
      presetRowVersion: 4,
      presetSnapshot: {},
      presetDefinitionHash: publicationRow.preset_definition_hash,
      preparationJobId: publicationRow.preparation_job_id,
      requestId,
      planHash,
      contentPolicyVersion: 'merchroute-ozon-content-v3',
      materialHash,
      materialHashVersion: 'ozon-shared-material-v1',
      publicationMode: 'CREATE_ONLY',
      taskId: publicationRow.task_id,
      warehouseId: 'warehouse-1',
      warehouseName: 'Warehouse 1',
      fulfillmentMode: 'FBS',
      accountCurrency: 'RUB',
      offerIds: ['0000132-01'],
      offerContractHash: publicationRow.offer_contract_hash,
      materializationHash: publicationRow.materialization_hash,
      materializedProductSnapshot: {}
    })).resolves.toMatchObject({ id: publicationId, status: 'PLANNED', plannedJobId: jobId });
  });
});

describe('OZON provisional import product evidence', () => {
  const taskId = 'default__0000118__r2';
  const publicationId = '11111111-1111-4111-8111-111111111111';
  const otherPublicationId = '22222222-2222-4222-8222-222222222222';
  const storeId = '33333333-3333-4333-8333-333333333333';
  const otherStoreId = '44444444-4444-4444-8444-444444444444';

  function evidence(overrides: Record<string, unknown> = {}) {
    return {
      task_id: taskId,
      publication_id: publicationId,
      store_id: storeId,
      operation: 'importInfo',
      delivery_state: 'RESPONDED',
      retry_class: 'NONE',
      status_code: 200,
      job_offer_ids: ['0000118-01'],
      publication_offer_ids: ['0000118-01'],
      response_json: {
        result: { items: [{ offer_id: '0000118-01', product_id: 501, status: 'imported', errors: [] }] }
      },
      ...overrides
    };
  }

  function repositoryWithRows(rows: Record<string, unknown>[]) {
    const query = vi.fn(async () => ({ rows, rowCount: rows.length }));
    const repository = new OzonStoreRepository();
    (repository as any).pool = { query };
    return { repository, query };
  }

  it('keeps same-offer product evidence isolated by task, publication and store', async () => {
    const { repository, query } = repositoryWithRows([
      evidence(),
      evidence({ store_id: otherStoreId, response_json: {
        result: { items: [{ offer_id: '0000118-01', product_id: 777, status: 'imported', errors: [] }] }
      } }),
      evidence({ publication_id: otherPublicationId, response_json: {
        result: { items: [{ offer_id: '0000118-01', product_id: 888, status: 'imported', errors: [] }] }
      } })
    ]);
    await expect(repository.getProvisionalImportProductIds({ taskId, publicationId, storeId }))
      .resolves.toEqual(['501']);
    expect(query).toHaveBeenCalledWith(expect.stringContaining("gateway.operation='importInfo'"), [
      taskId, publicationId, storeId
    ]);
  });

  it('rejects UNKNOWN/non-2xx ledgers and products not tied to both frozen offer contracts', async () => {
    const { repository } = repositoryWithRows([
      evidence({ delivery_state: 'UNKNOWN', retry_class: 'READBACK_REQUIRED', status_code: null }),
      evidence({ status_code: 500 }),
      evidence({ response_json: {
        result: { items: [{ offer_id: 'foreign-offer', product_id: 600, status: 'imported', errors: [] }] }
      } }),
      evidence({ response_json: {
        result: { items: [{ offer_id: '0000118-01', product_id: 601, status: 'failed', errors: [] }] }
      } }),
      evidence({ response_json: {
        result: { items: [{ offer_id: '0000118-01', product_id: 602, status: 'imported', errors: [{ code: 'x' }] }] }
      } })
    ]);
    await expect(repository.getProvisionalImportProductIds({ taskId, publicationId, storeId }))
      .resolves.toEqual([]);
  });
});

describe('OZON media fan-out batch finalization', () => {
  const jobId = '50000000-0000-4000-8000-000000000132';
  const input = {
    jobId,
    sku: '0000132',
    deliveries: [
      { sourceStageId: 'E004', submissionId: 'submission-e004', variantId: '01' },
      { sourceStageId: 'E005', submissionId: 'submission-e005', variantId: '01' }
    ],
    publicationIds: [
      '60000000-0000-4000-8000-000000000001',
      '60000000-0000-4000-8000-000000000002'
    ],
    storeIds: [
      '70000000-0000-4000-8000-000000000001',
      '70000000-0000-4000-8000-000000000002'
    ]
  };

  function ledgerRow(sourceStageId: string, submissionId: string, decision = 'ACCEPTED') {
    return {
      job_id: jobId,
      sku: '0000132',
      source_stage_id: sourceStageId,
      submission_id: submissionId,
      variant_id: '01',
      payload: { autoPublishDecision: decision }
    };
  }

  function harness(rows: Record<string, unknown>[], updateRowCount = rows.length) {
    const query = vi.fn(async (text: string) => {
      if (text === 'BEGIN' || text === 'COMMIT' || text === 'ROLLBACK') return { rows: [], rowCount: null };
      if (text.includes('SELECT d.* FROM ozon_media_deliveries')) return { rows, rowCount: rows.length };
      if (text.includes('FROM ozon_store_publications')) return {
        rows: input.publicationIds.map((id, index) => ({
          id,
          store_id: input.storeIds[index],
          preparation_job_id: jobId,
          status: 'QUEUED'
        })),
        rowCount: input.publicationIds.length
      };
      if (text.includes('UPDATE ozon_media_deliveries d SET')) return { rows: [], rowCount: updateRowCount };
      throw new Error(`unexpected query: ${text}`);
    });
    const client = { query, release: vi.fn() };
    const repository = new OzonStoreRepository();
    (repository as any).pool = { connect: vi.fn(async () => client) };
    return { repository, query, client };
  }

  it('locks and finalizes every frozen media identity in one transaction', async () => {
    const { repository, query, client } = harness([
      ledgerRow('E004', 'submission-e004'),
      ledgerRow('E005', 'submission-e005')
    ]);

    await expect(repository.finalizeMediaFanoutBatch(input)).resolves.toBe(true);
    expect(query.mock.calls.map(([text]) => text)).toEqual([
      'BEGIN',
      expect.stringContaining('SELECT d.* FROM ozon_media_deliveries'),
      expect.stringContaining('FROM ozon_store_publications'),
      expect.stringContaining('UPDATE ozon_media_deliveries d SET'),
      'COMMIT'
    ]);
    expect(query).not.toHaveBeenCalledWith('ROLLBACK');
    expect(client.release).toHaveBeenCalledOnce();
  });

  it('rejects an empty or incomplete publication set before touching any media ledger', async () => {
    const { repository, query } = harness([
      ledgerRow('E004', 'submission-e004'),
      ledgerRow('E005', 'submission-e005')
    ]);
    await expect(repository.finalizeMediaFanoutBatch({ ...input, publicationIds: [] }))
      .rejects.toMatchObject({ code: 'CONFIG_INVALID', details: { publicationCount: 0, storeCount: 2 } });
    expect(query).not.toHaveBeenCalled();
  });

  it('rolls back before update when only part of the frozen identity set still exists', async () => {
    const { repository, query } = harness([ledgerRow('E004', 'submission-e004')]);

    await expect(repository.finalizeMediaFanoutBatch(input)).rejects.toMatchObject({
      code: 'OZON_MEDIA_DELIVERY_IDENTITY_DRIFT',
      details: { expected: 2, actual: 1 }
    });
    expect(query.mock.calls.some(([text]) => String(text).includes('UPDATE ozon_media_deliveries d SET'))).toBe(false);
    expect(query).toHaveBeenCalledWith('ROLLBACK');
    expect(query).not.toHaveBeenCalledWith('COMMIT');
  });

  it('rolls back the whole batch when the atomic CAS update misses one ledger', async () => {
    const { repository, query } = harness([
      ledgerRow('E004', 'submission-e004'),
      ledgerRow('E005', 'submission-e005')
    ], 1);

    await expect(repository.finalizeMediaFanoutBatch(input)).rejects.toMatchObject({
      code: 'TASK_LOCKED',
      details: { expected: 2, actual: 1 }
    });
    expect(query).toHaveBeenCalledWith('ROLLBACK');
    expect(query).not.toHaveBeenCalledWith('COMMIT');
  });

  it('fails closed and rolls back a pre-existing partial FANNED_OUT state', async () => {
    const completed = ledgerRow('E004', 'submission-e004', 'FANNED_OUT');
    completed.payload = {
      autoPublishDecision: 'FANNED_OUT',
      fanoutPublicationIds: input.publicationIds,
      fanoutStoreIds: input.storeIds
    } as any;
    const { repository, query } = harness([
      completed,
      ledgerRow('E005', 'submission-e005')
    ]);

    await expect(repository.finalizeMediaFanoutBatch(input)).rejects.toMatchObject({
      code: 'VERSION_CONFLICT',
      details: { completed: 1, expected: 2 }
    });
    expect(query).toHaveBeenCalledWith('ROLLBACK');
    expect(query).not.toHaveBeenCalledWith('COMMIT');
  });
});
