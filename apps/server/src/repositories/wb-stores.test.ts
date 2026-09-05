import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { evaluateWbPreflightCurrency, syncPublicationFromRuntime, WbStoreRepository } from './wb-stores.js';

describe('WB store preflight currency evidence', () => {
  it('distinguishes a WB-verified CNY account from an empty-catalog deferred check', () => {
    expect(evaluateWbPreflightCurrency('CNY', {
      accountCurrency: 'CNY',
      details: { currencySource: 'WB_PRICE_LIST', currencyVerified: true, currencyVerification: 'VERIFIED' }
    })).toEqual({ currency: 'CNY', verified: true, verification: 'VERIFIED' });

    expect(evaluateWbPreflightCurrency('CNY', {
      accountCurrency: 'CNY',
      details: { currencySource: 'STORE_CONFIG', currencyVerified: false, currencyVerification: 'DEFERRED_EMPTY_CATALOG' }
    })).toEqual({ currency: 'CNY', verified: false, verification: 'DEFERRED_EMPTY_CATALOG' });
  });

  it('fails closed when configured CNY is presented without verified or deferred evidence', () => {
    expect(evaluateWbPreflightCurrency('CNY', { accountCurrency: 'CNY', details: {} })).toMatchObject({
      verification: 'INVALID',
      blocker: expect.stringContaining('不满足空目录延期验证合同')
    });
    expect(evaluateWbPreflightCurrency('CNY', {
      accountCurrency: 'RUB',
      details: { currencySource: 'WB_PRICE_LIST', currencyVerified: true, currencyVerification: 'VERIFIED' }
    })).toMatchObject({ verification: 'VERIFIED', blocker: 'WB 平台账户币种不是 CNY' });
  });
});

describe('WB store publication runtime synchronization', () => {
  it('queries multiple listing SKUs and the MANUAL source without N+1 requests', async () => {
    const repository = new WbStoreRepository();
    const query = vi.fn(async () => ({ rows: [] }));
    (repository as any).query = query;

    await expect(repository.listPublications({
      skus: ['0000110', '0000122', '0000110'],
      source: 'MANUAL'
    })).resolves.toEqual([]);
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining('p.sku=ANY($1::text[])'),
      [['0000110', '0000122'], 'MANUAL']
    );
    expect(String(query.mock.calls[0]?.[0])).toContain('p.source=$2');
    expect(String(query.mock.calls[0]?.[0])).toContain('SELECT p.*');

    query.mockClear();
    await expect(repository.listPublications({
      skus: ['0000122'],
      source: 'MANUAL',
      compact: true
    })).resolves.toEqual([]);
    const compactSql = String(query.mock.calls[0]?.[0]);
    expect(compactSql).not.toContain('SELECT p.*');
    expect(compactSql).not.toMatch(/\bp\.result_json\s*(?:,|$)/m);
    expect(compactSql).toContain("jsonb_array_elements");
    expect(compactSql).toContain("card.value->>'nmID'");
    expect(compactSql).toContain('p.plan_hash');
    expect(compactSql).toContain('p.config_snapshot');
    expect(compactSql).toContain('p.nm_ids');
    expect(compactSql).toContain('latest.plan_hash');
    expect(compactSql).not.toContain('LIMIT 1000');
    await expect(repository.listPublications({ skus: ['invalid'] })).rejects.toMatchObject({ code: 'CONFIG_INVALID' });
  });

  it('projects each manual publication frozen preset and associates variant codes by nmID', async () => {
    const repository = new WbStoreRepository();
    const baseRow = {
      sku: '0000140', generated_version_id: '11111111-1111-4111-8111-111111111111',
      status: 'SUCCEEDED', source: 'MANUAL', revision: 2, plan_hash: `sha256:${'a'.repeat(64)}`,
      preset_definition_hash: `sha256:${'b'.repeat(64)}`, task_id: 'default__0000140__r2',
      nm_ids: ['222', '111'],
      product_urls: [
        'https://www.wildberries.ru/catalog/222/detail.aspx',
        'https://www.wildberries.ru/catalog/111/detail.aspx',
        'https://www.wildberries.ru/catalog/222/detail.aspx',
        'http://www.wildberries.ru/catalog/333/detail.aspx',
        'https://example.com/catalog/444/detail.aspx'
      ],
      product_link_identities: [
        { nmId: '111', variantCode: '0000140-01' },
        { nmId: '222', variantCode: '0000140-02' },
        { nmId: '222', variantCode: 'ambiguous-code' }
      ],
      config_snapshot: { draftVersion: 4, planStoreIds: ['store-1', 'store-2'] },
      publication_draft_version: '4', preset_row_version: '12', operation_mode: 'COMPATIBLE_UPSERT',
      source_preset_exists: true, error_code: '', error_message: '', row_version: 3,
      created_at: '2026-08-14T01:00:00.000Z', updated_at: '2026-08-14T02:00:00.000Z',
      completed_at: '2026-08-14T02:00:00.000Z'
    };
    (repository as any).query = vi.fn(async () => ({ rows: [
      { ...baseRow, id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', store_id: 'store-1', store_alias_snapshot: 'default', store_display_name: 'TEK+01', preset_id: 'preset-1', preset_name: 'WB 女包 49%' },
      { ...baseRow, id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', store_id: 'store-2', store_alias_snapshot: '250167882', store_display_name: 'TEK+02', revision: 3, task_id: '250167882__0000140__r3', preset_id: 'preset-2', preset_name: 'WB 女包 45%', preset_row_version: '8' }
    ] }));

    const rows = await repository.listPublications({ skus: ['0000140'], source: 'MANUAL', compact: true });

    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      storeDisplayName: 'TEK+01', presetName: 'WB 女包 49%', presetRowVersion: 12,
      operationMode: 'COMPATIBLE_UPSERT', draftVersion: 4, sourcePresetExists: true,
      productLinks: [
        { nmId: '222', url: 'https://www.wildberries.ru/catalog/222/detail.aspx' },
        { nmId: '111', url: 'https://www.wildberries.ru/catalog/111/detail.aspx', variantCode: '0000140-01' }
      ]
    });
    expect(rows[1]).toMatchObject({ storeDisplayName: 'TEK+02', presetName: 'WB 女包 45%', presetRowVersion: 8 });
  });

  it('updates success and failure by publication id so two stores keep independent outcomes', async () => {
    const query = vi.fn(async () => ({ rows: [], rowCount: 1 }));
    const client = { query } as any;
    const successId = '11111111-1111-4111-8111-111111111111';
    const failureId = '22222222-2222-4222-8222-222222222222';

    await syncPublicationFromRuntime(client, {
      publication_id: successId,
      state: 'SUCCEEDED',
      result_json: { cards: [{ nmID: 123456 }], registry: [{ nm_id: '123456' }] },
      last_error_code: '', last_error_message: ''
    });
    await syncPublicationFromRuntime(client, {
      publication_id: failureId,
      state: 'FAILED',
      result_json: { phase: 'CARD_RECONCILING' },
      last_error_code: 'CARD_RECONCILE_TIMEOUT',
      last_error_message: '第二店失败'
    });

    expect(query).toHaveBeenNthCalledWith(1, expect.stringContaining('WHERE id=$1'), [
      successId, 'SUCCEEDED', JSON.stringify(['123456']), JSON.stringify(['https://www.wildberries.ru/catalog/123456/detail.aspx']),
      JSON.stringify({ cards: [{ nmID: 123456 }], registry: [{ nm_id: '123456' }] }), '', '', true
    ]);
    expect(query).toHaveBeenNthCalledWith(2, expect.stringContaining('WHERE id=$1'), [
      failureId, 'FAILED', JSON.stringify([]), JSON.stringify([]), JSON.stringify({ phase: 'CARD_RECONCILING' }),
      'CARD_RECONCILE_TIMEOUT', '第二店失败', true
    ]);
  });

  it('uses a status CAS so a late dispatch rejection cannot roll QUEUED or RUNNING back to NEEDS_ATTENTION', async () => {
    const repository = new WbStoreRepository();
    const query = vi.fn(async () => ({ rows: [], rowCount: 0 }));
    (repository as any).query = query;

    await expect(repository.markPublicationFailed(
      '11111111-1111-4111-8111-111111111111', 'VERIFY_FAILED', 'late 403'
    )).rejects.toMatchObject({ code: 'TASK_LOCKED', statusCode: 409 });
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining("status IN ('PLANNED','DISPATCHING','NEEDS_ATTENTION')"),
      ['11111111-1111-4111-8111-111111111111', 'VERIFY_FAILED', 'late 403']
    );
  });
});

describe('WB automation store publication materialization', () => {
  const sourceGeneratedVersionId = '11111111-1111-4111-8111-111111111111';
  const storeId = '22222222-2222-4222-8222-222222222222';
  const credentialVersionId = '33333333-3333-4333-8333-333333333333';
  const presetId = '44444444-4444-4444-8444-444444444444';
  const automationRunId = '55555555-5555-4555-8555-555555555555';
  const categoryVersionId = '66666666-6666-4666-8666-666666666666';
  const presetDefinitionHash = `sha256:${'a'.repeat(64)}`;
  const materializationHash = `sha256:${'f'.repeat(64)}`;
  const input = (presetSnapshot: Record<string, unknown> = {}) => ({
    sku: '0000124',
    sourceGeneratedVersionId,
    storeId,
    storeAlias: 'second',
    storeRowVersion: 7,
    storeConfigVersion: 4,
    warehouseId: '123456',
    credentialVersionId,
    presetId,
    presetSnapshot,
    presetDefinitionHash,
    automationRunId,
    automationRunNo: 1,
    operationMode: 'COMPATIBLE_UPSERT' as const,
    mediaTargetVendorCodes: ['0000124-01'],
    existingCardBaseline: [{ vendorCode: '0000124-01', nmID: '1404509519', imtID: '9001', subjectID: '306' }]
  });

  it('recovers a detached publication only with strict run, source, scope, and hash evidence', async () => {
    const repository = new WbStoreRepository();
    const strictRow = {
      id: '77777777-7777-4777-8777-777777777777',
      sku: '0000124',
      generated_version_id: '88888888-8888-4888-8888-888888888888',
      store_id: storeId,
      store_alias_snapshot: 'second',
      store_display_name: '第二店',
      status: 'PLANNED',
      source: 'AUTOMATION',
      request_key: `automation:${automationRunId}:${storeId}`,
      revision: 5,
      preset_id: presetId,
      preset_definition_hash: presetDefinitionHash,
      materialization_hash: materializationHash,
      config_snapshot: { automationRunId, sourceGeneratedVersionId },
      nm_ids: [],
      product_urls: [],
      result_json: {},
      row_version: 1,
      created_at: new Date(),
      updated_at: new Date(),
      publication_generation_scope: 'STORE_PUBLICATION',
      publication_version_status: 'GENERATED',
      publication_version_materialization_hash: materializationHash,
      publication_version_sku: '0000124',
      source_version_id: sourceGeneratedVersionId,
      source_generation_scope: 'LISTING',
      source_version_status: 'GENERATED',
      source_version_sku: '0000124'
    };
    const query = vi.fn(async () => ({ rows: [strictRow] }));
    (repository as any).query = query;

    await expect(repository.findAutomationMaterializedPublication({
      sku: '0000124', automationRunId, storeId
    })).resolves.toMatchObject({
      id: strictRow.id,
      generatedVersionId: strictRow.generated_version_id,
      source: 'AUTOMATION',
      materializationHash
    });
    expect(String(query.mock.calls[0]?.[0])).toContain("publication_version.generation_scope publication_generation_scope");

    query.mockResolvedValueOnce({ rows: [{ ...strictRow, publication_generation_scope: 'LISTING' }] });
    await expect(repository.findAutomationMaterializedPublication({
      sku: '0000124', automationRunId, storeId
    })).rejects.toMatchObject({ code: 'VERSION_CONFLICT', statusCode: 409 });
  });

  function materializationHarness(options: { discountPercent?: number; settingsUpdatedAt?: string } = {}) {
    const repository = new WbStoreRepository();
    let publicationRow: Record<string, unknown> | undefined;
    const calls: Array<{ sql: string; values: unknown[] }> = [];
    const query = vi.fn(async (sqlInput: string, values: unknown[] = []) => {
      const sql = String(sqlInput).replace(/\s+/g, ' ').trim();
      calls.push({ sql, values });
      if (sql.startsWith('SELECT * FROM wb_store_publications WHERE request_key=$1')) {
        return { rows: publicationRow ? [publicationRow] : [] };
      }
      if (sql.startsWith('SELECT v.*,d.generated_version_id')) {
        return { rows: [{
          id: sourceGeneratedVersionId,
          sku: '0000124',
          revision: 4,
          status: 'GENERATED',
          generation_scope: 'LISTING',
          current_version_id: sourceGeneratedVersionId,
          draft_status: 'GENERATED',
          draft_data: {},
          category_version_id: categoryVersionId,
          product_json: {
            schemaVersion: 2,
            productCode: '0000124',
            revision: 4,
            discountPercent: options.discountPercent ?? 49,
            variants: [{ vendorCode: '0000124-01', images: ['variants/blue/02.png', 'variants/blue/01.png'] }]
          },
          media_manifest: {
            assets: [{ relativePath: 'variants/blue/01.png', sha256: `sha256:${'b'.repeat(64)}` }],
            variantMedia: [{ variantId: 'blue', imageAssetIds: ['image-2', 'image-1'] }]
          },
          purchase_measurements: { weightGrams: 700 },
          material_preset_definition_hash: presetDefinitionHash
        }] };
      }
      if (sql.startsWith('SELECT * FROM wb_stores')) {
        return { rows: [{
          id: storeId,
          store_alias: 'second',
          enabled: true,
          auto_publish_enabled: true,
          auto_publish_mode: 'COMPATIBLE_UPSERT',
          default_preset_id: presetId,
          active_credential_version_id: credentialVersionId,
          warehouse_id: '123456',
          row_version: 7,
          config_version: 4
        }] };
      }
      if (sql.startsWith("SELECT * FROM wb_system_settings WHERE settings_id='default'")) {
        return { rows: [{
          settings_id: 'default',
          enabled: true,
          root_directory: 'F:/WB',
          timezone: 'Asia/Shanghai',
          global_concurrency: 2,
          per_store_concurrency: 1,
          row_version: 9,
          updated_at: options.settingsUpdatedAt || '2026-08-12T12:00:00.000Z'
        }] };
      }
      if (sql.startsWith('SELECT COALESCE(MAX(revision),0)+1 revision')) return { rows: [{ revision: 5 }] };
      if (sql.startsWith('INSERT INTO wb_listing_versions')) return { rows: [], rowCount: 1 };
      if (sql.startsWith('INSERT INTO wb_store_publications')) {
        publicationRow = {
          id: values[0],
          sku: values[1],
          generated_version_id: values[2],
          revision: values[3],
          store_id: values[4],
          store_alias_snapshot: values[5],
          status: 'PLANNED',
          source: 'AUTOMATION',
          preset_id: values[6],
          preset_snapshot: JSON.parse(String(values[7])),
          preset_definition_hash: values[8],
          credential_version_id: values[9],
          task_id: values[10],
          config_snapshot: JSON.parse(String(values[11])),
          request_key: values[12],
          materialization_hash: values[13],
          nm_ids: [],
          product_urls: [],
          result_json: {},
          error_code: '',
          error_message: '',
          row_version: 1,
          created_at: '2026-08-12T12:00:00.000Z',
          updated_at: '2026-08-12T12:00:00.000Z'
        };
        return { rows: [publicationRow], rowCount: 1 };
      }
      throw new Error(`unexpected SQL: ${sql}`);
    });
    (repository as any).transaction = async (operation: (client: any) => Promise<any>) => operation({ query });
    return { repository, query, calls };
  }

  it('creates one immutable STORE_PUBLICATION version per automation run and keeps the public draft pointer untouched', async () => {
    const harness = materializationHarness();
    const first = await harness.repository.createAutomationMaterializedPublication(input({ capturedAt: 'first' }));
    const replay = await harness.repository.createAutomationMaterializedPublication(input({ capturedAt: 'replay' }));

    expect(replay).toEqual(first);
    expect(first).toMatchObject({
      sku: '0000124',
      source: 'AUTOMATION',
      storeId,
      storeAlias: 'second',
      status: 'PLANNED',
      taskId: 'second__0000124__r5',
      revision: 5,
      materializationHash: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
      configSnapshot: {
        sourceGeneratedVersionId,
        automationRunId,
        automationRunNo: 1,
        storeRowVersion: 7,
        storeConfigVersion: 4,
        settingsRowVersion: 9,
        rootDirectory: 'F:/WB',
        mediaTargetVendorCodes: ['0000124-01']
      }
    });
    const versionInserts = harness.calls.filter(({ sql }) => sql.startsWith('INSERT INTO wb_listing_versions'));
    const publicationInserts = harness.calls.filter(({ sql }) => sql.startsWith('INSERT INTO wb_store_publications'));
    expect(versionInserts).toHaveLength(1);
    expect(publicationInserts).toHaveLength(1);
    expect(versionInserts[0]!.sql).toContain("'STORE_PUBLICATION'");
    const materializedProduct = JSON.parse(String(versionInserts[0]!.values[4]));
    expect(materializedProduct).toMatchObject({ productCode: '0000124', revision: 5, discountPercent: 49 });
    expect(materializedProduct.variants[0].images).toEqual(['variants/blue/02.png', 'variants/blue/01.png']);
    expect(publicationInserts[0]!.values[12]).toBe(`automation:${automationRunId}:${storeId}`);
    expect(harness.calls.some(({ sql }) => /UPDATE\s+wb_listing_drafts/i.test(sql))).toBe(false);
  });

  it('keeps materialization hashes stable across non-material timestamps and changes them when product material changes', async () => {
    const first = materializationHarness({ settingsUpdatedAt: '2026-08-12T12:00:00.000Z' });
    const second = materializationHarness({ settingsUpdatedAt: '2026-08-12T13:00:00.000Z' });
    const changed = materializationHarness({ discountPercent: 45, settingsUpdatedAt: '2026-08-12T13:00:00.000Z' });

    const firstPublication = await first.repository.createAutomationMaterializedPublication(input({ capturedAt: 'first', boundAt: 'old' }));
    const secondPublication = await second.repository.createAutomationMaterializedPublication(input({ capturedAt: 'second', boundAt: 'new' }));
    const changedPublication = await changed.repository.createAutomationMaterializedPublication(input({ capturedAt: 'second', boundAt: 'new' }));

    expect(secondPublication.materializationHash).toBe(firstPublication.materializationHash);
    expect(changedPublication.materializationHash).not.toBe(firstPublication.materializationHash);
  });

  it('records an immutable package with field-level CAS and treats an exact replay as idempotent', async () => {
    const repository = new WbStoreRepository();
    const publicationId = '77777777-7777-4777-8777-777777777777';
    const materializationHash = `sha256:${'c'.repeat(64)}`;
    const packageSignature = `sha256:${'d'.repeat(64)}`;
    const inputPackage = {
      packageRelPath: 'stores/second/inbox/0000124/77777777-7777-4777-8777-777777777777',
      packageSignature,
      materializationHash
    };
    let row: Record<string, unknown> = {
      id: publicationId,
      sku: '0000124',
      generated_version_id: sourceGeneratedVersionId,
      revision: 5,
      store_id: storeId,
      store_alias_snapshot: 'second',
      status: 'PLANNED',
      source: 'AUTOMATION',
      preset_definition_hash: presetDefinitionHash,
      config_snapshot: {},
      materialization_hash: materializationHash,
      package_rel_path: null,
      package_signature: null,
      nm_ids: [], product_urls: [], result_json: {},
      row_version: 1,
      created_at: '2026-08-12T12:00:00.000Z',
      updated_at: '2026-08-12T12:00:00.000Z'
    };
    const query = vi.fn(async (sql: string, values: unknown[]) => {
      if (sql.startsWith('SELECT * FROM wb_store_publications')) return { rows: [row] };
      if (sql.includes('UPDATE wb_store_publications SET')) {
        row = {
          ...row,
          package_rel_path: values[1],
          package_signature: values[2],
          materialization_hash: values[3],
          row_version: Number(row.row_version) + 1
        };
        return { rows: [row], rowCount: 1 };
      }
      throw new Error(`unexpected SQL: ${sql}`);
    });
    (repository as any).transaction = async (operation: (client: any) => Promise<any>) => operation({ query });

    const first = await repository.recordPublicationPackage(publicationId, inputPackage);
    const replay = await repository.recordPublicationPackage(publicationId, inputPackage);
    expect(first).toMatchObject({ ...inputPackage, rowVersion: 2 });
    expect(replay).toMatchObject({ ...inputPackage, rowVersion: 2 });
    expect(query.mock.calls.filter(([sql]) => String(sql).includes('UPDATE wb_store_publications SET'))).toHaveLength(1);

    await expect(repository.recordPublicationPackage(publicationId, {
      ...inputPackage,
      packageSignature: `sha256:${'e'.repeat(64)}`
    })).rejects.toMatchObject({ code: 'VERSION_CONFLICT', statusCode: 409 });
    expect(query.mock.calls.filter(([sql]) => String(sql).includes('UPDATE wb_store_publications SET'))).toHaveLength(1);
  });
});

describe('WB gateway request retry fencing', () => {
  it('rearms only a completed retryable NOT_SENT request with the same request hash', async () => {
    const repository = new WbStoreRepository();
    const existing = {
      request_ref: 'vendor-check:run:recovery:0:active', request_hash: 'sha256:same',
      operation: 'CARDS_LIST_ACTIVE', store_id: '11111111-1111-4111-8111-111111111111', task_id: null,
      delivery_state: 'NOT_SENT', retry_class: 'RETRYABLE', completed_at: new Date().toISOString()
    };
    const query = vi.fn(async (sql: string) => {
      if (sql.startsWith('SELECT * FROM wb_gateway_requests')) return { rows: [existing] };
      if (sql.startsWith('UPDATE wb_gateway_requests SET')) return { rows: [{ ...existing, delivery_state: 'UNKNOWN', retry_class: 'READBACK_REQUIRED', completed_at: null }] };
      throw new Error(`unexpected SQL: ${sql}`);
    });
    (repository as any).transaction = async (operation: (client: any) => Promise<any>) => operation({ query });

    await expect(repository.beginGatewayRequest({
      requestRef: existing.request_ref,
      requestHash: existing.request_hash,
      operation: 'CARDS_LIST_ACTIVE',
      identity: {
        storeId: '11111111-1111-4111-8111-111111111111', storeAlias: 'second',
        warehouseId: '123', configVersion: 1, rootDirectory: 'F:/WB', storeEnabled: true, leaseActive: false,
        credential: {
          id: '22222222-2222-4222-8222-222222222222', storeId: '11111111-1111-4111-8111-111111111111',
          version: 1, status: 'ACTIVE', ciphertext: 'cipher', nonce: 'nonce', authTag: 'tag', fingerprint: 'fp', keyVersion: 1
        }
      }
    })).resolves.toMatchObject({ idempotent: false, row: { delivery_state: 'UNKNOWN', retry_class: 'READBACK_REQUIRED' } });
    expect(query).toHaveBeenCalledWith(expect.stringContaining("delivery_state='UNKNOWN',retry_class='READBACK_REQUIRED'"), [existing.request_ref]);
  });

  const cardTaskId = 'second__0000133__r1';
  const cardPublicationId = '33333333-3333-4333-8333-333333333333';
  const cardCredentialId = '22222222-2222-4222-8222-222222222222';
  const cardIdempotencyKey = 'second|0000133|1|33333333-3333-4333-8333-333333333333';
  const cardIntentId = `card-${createHash('sha256').update([
    cardTaskId, cardPublicationId, '1', cardIdempotencyKey, 'CARD_UPLOAD'
  ].join('|')).digest('hex')}`;
  const stable = (value: unknown): string => {
    if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
    if (value && typeof value === 'object') {
      const object = value as Record<string, unknown>;
      return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${stable(object[key])}`).join(',')}}`;
    }
    return JSON.stringify(value);
  };
  const frozenPayload = [{ subjectID: 123, variants: [{ vendorCode: '0000133-01', sizes: [{ skus: ['2054703694743'] }] }] }];
  const cardRequestHash = `sha256:${createHash('sha256').update(stable({
    taskId: cardTaskId,
    storeId: '11111111-1111-4111-8111-111111111111',
    credentialVersionId: cardCredentialId,
    warehouseId: '123',
    operation: 'CARD_UPLOAD',
    payload: { body: frozenPayload }
  })).digest('hex')}`;
  const cardIdentity = () => ({
    storeId: '11111111-1111-4111-8111-111111111111', storeAlias: 'second', taskId: cardTaskId,
    publicationId: cardPublicationId,
    warehouseId: '123', configVersion: 1, rootDirectory: 'F:/WB', storeEnabled: true, leaseActive: true,
    credential: {
      id: cardCredentialId, storeId: '11111111-1111-4111-8111-111111111111',
      version: 1, status: 'ACTIVE' as const, ciphertext: 'cipher', nonce: 'nonce', authTag: 'tag', fingerprint: 'fp', keyVersion: 1
    }
  });

  it('atomically adopts one legacy CARD_UPLOAD as attempt 1 before creating attempt 2', async () => {
    const repository = new WbStoreRepository();
    const requestHash = cardRequestHash;
    const proofOneAt = '2026-08-14T03:42:16.000Z';
    const proofTwoAt = '2026-08-14T03:43:17.000Z';
    const legacy = {
      request_ref: `${cardTaskId}:CARD_WRITE:2026-08-14T03:12:10.390Z:0`,
      request_hash: requestHash, operation: 'CARD_UPLOAD', task_id: cardTaskId,
      store_id: cardIdentity().storeId, publication_id: cardPublicationId, credential_version_id: cardCredentialId,
      logical_intent_id: null, attempt_no: null, created_at: '2026-08-14T03:12:10.390Z',
      completed_at: '2026-08-14T03:12:15.876Z', delivery_state: 'UNKNOWN', retry_class: 'READBACK_REQUIRED'
    };
    const runtime = {
      cardOperation: 'create',
      product: { productCode: '0000133', variants: [{ vendorCode: '0000133-01' }] },
      cardCreateIntent: {
        taskId: cardTaskId, publicationId: cardPublicationId, revision: 1, idempotencyKey: cardIdempotencyKey,
        vendorCodes: ['0000133-01'], logicalIntentId: cardIntentId, attemptNo: 2,
        frozenPayload, frozenPayloadHash: `sha256:${createHash('sha256').update(stable(frozenPayload)).digest('hex')}`,
        retryIssuedAt: '2026-08-14T03:43:18.000Z'
      },
      cardRecovery: {
        active: true, logicalIntentId: cardIntentId, attemptNo: 2, proofRounds: 2, finalReadbackOnly: true,
        retryAuthorizedAt: proofTwoAt
      },
      audit: [
        { event: 'CARD_UNKNOWN_PROOF_ROUND', logicalIntentId: cardIntentId, round: 1, at: proofOneAt },
        { event: 'CARD_UNKNOWN_PROOF_ROUND', logicalIntentId: cardIntentId, round: 2, at: proofTwoAt }
      ]
    };
    const job = {
      task_id: cardTaskId, store_id: cardIdentity().storeId, publication_id: cardPublicationId,
      credential_version_id: cardCredentialId, warehouse_id: '123', product_code: '0000133', revision: 1,
      idempotency_key: cardIdempotencyKey, state: 'CARD_SUBMITTING', result_json: runtime,
      db_now: '2026-08-14T03:43:18.000Z'
    };
    const created = { ...legacy, request_ref: `${cardTaskId}:CARD_WRITE:${cardIntentId}:attempt-2`, logical_intent_id: cardIntentId, attempt_no: 2 };
    const query = vi.fn(async (sql: string) => {
      if (sql.startsWith('SELECT * FROM wb_gateway_requests WHERE request_ref')) return { rows: [] };
      if (sql.includes('WHERE logical_intent_id=$1 FOR UPDATE')) return { rows: [] };
      if (sql.startsWith('SELECT task_id,store_id,publication_id')) return { rows: [job] };
      if (sql.includes('WHERE logical_intent_id=$1 AND attempt_no=1')) return { rows: [] };
      if (sql.includes("logical_intent_id IS NULL AND operation='CARD_UPLOAD'")) return { rows: [legacy] };
      if (sql.includes("WHERE task_id=$1 AND operation='CARD_UPLOAD' AND attempt_no=$2")) return { rows: [] };
      if (sql.startsWith('UPDATE wb_gateway_requests SET logical_intent_id=')) return { rows: [], rowCount: 1 };
      if (sql.startsWith('INSERT INTO wb_gateway_requests')) return { rows: [created] };
      throw new Error(`unexpected SQL: ${sql}`);
    });
    (repository as any).transaction = async (operation: (client: any) => Promise<any>) => operation({ query });

    await expect(repository.beginGatewayRequest({
      requestRef: created.request_ref, requestHash, operation: 'CARD_UPLOAD', identity: cardIdentity(),
      logicalIntentId: cardIntentId, attemptNo: 2
    })).resolves.toMatchObject({ idempotent: false, row: { attempt_no: 2 } });
    expect(query).toHaveBeenCalledWith(expect.stringContaining('attempt_no=1'), [legacy.request_ref, cardIntentId]);
  });

  it('rejects attempt 2 before 30 minutes, without two 60-second proof rounds, or after a resolved attempt 1', async () => {
    const cases = [
      {
        name: 'too early', dbNow: '2026-08-14T03:40:00.000Z', proofOneAt: '2026-08-14T03:42:16.000Z',
        proofTwoAt: '2026-08-14T03:43:17.000Z', deliveryState: 'UNKNOWN', retryClass: 'READBACK_REQUIRED'
      },
      {
        name: 'proof interval too short', dbNow: '2026-08-14T03:44:00.000Z', proofOneAt: '2026-08-14T03:42:16.000Z',
        proofTwoAt: '2026-08-14T03:42:50.000Z', deliveryState: 'UNKNOWN', retryClass: 'READBACK_REQUIRED'
      },
      {
        name: 'attempt 1 responded', dbNow: '2026-08-14T03:44:00.000Z', proofOneAt: '2026-08-14T03:42:16.000Z',
        proofTwoAt: '2026-08-14T03:43:17.000Z', deliveryState: 'RESPONDED', retryClass: 'NONE'
      },
      {
        name: 'attempt 1 definitely not sent', dbNow: '2026-08-14T03:44:00.000Z', proofOneAt: '2026-08-14T03:42:16.000Z',
        proofTwoAt: '2026-08-14T03:43:17.000Z', deliveryState: 'NOT_SENT', retryClass: 'RETRYABLE'
      },
      {
        name: 'future-dated proof', dbNow: '2026-08-14T03:44:00.000Z', proofOneAt: '2026-08-14T04:42:16.000Z',
        proofTwoAt: '2026-08-14T04:43:17.000Z', deliveryState: 'UNKNOWN', retryClass: 'READBACK_REQUIRED'
      }
    ];
    for (const entry of cases) {
      const repository = new WbStoreRepository();
      const attemptOne = {
        request_ref: `${cardTaskId}:CARD_WRITE:${cardIntentId}:attempt-1`, request_hash: cardRequestHash,
        operation: 'CARD_UPLOAD', task_id: cardTaskId, store_id: cardIdentity().storeId,
        publication_id: cardPublicationId, credential_version_id: cardCredentialId,
        logical_intent_id: cardIntentId, attempt_no: 1, created_at: '2026-08-14T03:12:10.390Z',
        completed_at: '2026-08-14T03:12:15.876Z', delivery_state: entry.deliveryState, retry_class: entry.retryClass
      };
      const payloadHash = `sha256:${createHash('sha256').update(stable(frozenPayload)).digest('hex')}`;
      const job = {
        task_id: cardTaskId, store_id: cardIdentity().storeId, publication_id: cardPublicationId,
        credential_version_id: cardCredentialId, warehouse_id: '123', product_code: '0000133', revision: 1,
        idempotency_key: cardIdempotencyKey, state: 'CARD_SUBMITTING', db_now: entry.dbNow,
        result_json: {
          cardOperation: 'create', product: { productCode: '0000133', variants: [{ vendorCode: '0000133-01' }] },
          cardCreateIntent: {
            taskId: cardTaskId, publicationId: cardPublicationId, revision: 1, idempotencyKey: cardIdempotencyKey,
            vendorCodes: ['0000133-01'], logicalIntentId: cardIntentId, attemptNo: 2,
            frozenPayload, frozenPayloadHash: payloadHash,
            retryIssuedAt: new Date(Date.parse(entry.proofTwoAt) + 1_000).toISOString()
          },
          cardRecovery: {
            active: true, logicalIntentId: cardIntentId, attemptNo: 2, proofRounds: 2, finalReadbackOnly: true,
            retryAuthorizedAt: entry.proofTwoAt
          },
          audit: [
            { event: 'CARD_UNKNOWN_PROOF_ROUND', logicalIntentId: cardIntentId, round: 1, at: entry.proofOneAt },
            { event: 'CARD_UNKNOWN_PROOF_ROUND', logicalIntentId: cardIntentId, round: 2, at: entry.proofTwoAt }
          ]
        }
      };
      const query = vi.fn(async (sql: string) => {
        if (sql.startsWith('SELECT * FROM wb_gateway_requests WHERE request_ref')) return { rows: [] };
        if (sql.includes('WHERE logical_intent_id=$1 AND attempt_no=1')) return { rows: [attemptOne] };
        if (sql.includes('WHERE logical_intent_id=$1 FOR UPDATE')) return { rows: [attemptOne] };
        if (sql.startsWith('SELECT task_id,store_id,publication_id')) return { rows: [job] };
        throw new Error(`unexpected SQL in ${entry.name}: ${sql}`);
      });
      (repository as any).transaction = async (operation: (client: any) => Promise<any>) => operation({ query });
      await expect(repository.beginGatewayRequest({
        requestRef: `${cardTaskId}:CARD_WRITE:${cardIntentId}:attempt-2`, requestHash: cardRequestHash,
        operation: 'CARD_UPLOAD', identity: cardIdentity(), logicalIntentId: cardIntentId, attemptNo: 2
      }), entry.name).rejects.toMatchObject({ code: 'WB_CARD_RETRY_NOT_AUTHORIZED', statusCode: 409 });
    }
  });

  it('rejects a changed frozen payload and makes a concurrent same attempt idempotent', async () => {
    const repository = new WbStoreRepository();
    const prior = {
      request_ref: 'second__0000133__r1:CARD_WRITE:intent-133:attempt-1',
      request_hash: `sha256:${'a'.repeat(64)}`, operation: 'CARD_UPLOAD', task_id: 'second__0000133__r1',
      store_id: cardIdentity().storeId, publication_id: cardPublicationId, credential_version_id: cardCredentialId,
      logical_intent_id: 'intent-133', attempt_no: 1,
      delivery_state: 'UNKNOWN', retry_class: 'READBACK_REQUIRED', completed_at: new Date().toISOString()
    };
    let intentRows = [prior];
    const query = vi.fn(async (sql: string) => {
      if (sql.startsWith('SELECT * FROM wb_gateway_requests WHERE request_ref')) return { rows: [] };
      if (sql.includes('WHERE logical_intent_id=$1 FOR UPDATE')) return { rows: intentRows };
      throw new Error(`unexpected SQL: ${sql}`);
    });
    (repository as any).transaction = async (operation: (client: any) => Promise<any>) => operation({ query });

    await expect(repository.beginGatewayRequest({
      requestRef: 'second__0000133__r1:CARD_WRITE:intent-133:attempt-2',
      requestHash: `sha256:${'b'.repeat(64)}`, operation: 'CARD_UPLOAD', identity: cardIdentity(),
      logicalIntentId: 'intent-133', attemptNo: 2
    })).rejects.toMatchObject({ code: 'WB_CARD_INTENT_CONFLICT', statusCode: 409 });

    intentRows = [{ ...prior, request_ref: 'already-created-attempt-2', attempt_no: 2 }];
    await expect(repository.beginGatewayRequest({
      requestRef: 'concurrent-attempt-2', requestHash: prior.request_hash, operation: 'CARD_UPLOAD', identity: cardIdentity(),
      logicalIntentId: 'intent-133', attemptNo: 2
    })).resolves.toMatchObject({ idempotent: true, row: { request_ref: 'already-created-attempt-2' } });
  });

  it('rejects CARD_UPLOAD attempts outside the database integer range below the shared schema', async () => {
    const repository = new WbStoreRepository();
    await expect(repository.beginGatewayRequest({
      requestRef: 'second__0000133__r1:CARD_WRITE:intent-133:attempt-3',
      requestHash: `sha256:${'a'.repeat(64)}`, operation: 'CARD_UPLOAD', identity: cardIdentity(),
      logicalIntentId: 'intent-133', attemptNo: 2147483648
    })).rejects.toMatchObject({ code: 'WB_CARD_ATTEMPT_INVALID', statusCode: 409 });
  });

  it('rejects a modern attempt 1 when the same task already has a legacy UNKNOWN write', async () => {
    const repository = new WbStoreRepository();
    const legacy = {
      request_ref: `${cardTaskId}:CARD_WRITE:2026-08-14T03:12:10.390Z:0`,
      request_hash: cardRequestHash, operation: 'CARD_UPLOAD', task_id: cardTaskId,
      store_id: cardIdentity().storeId, publication_id: cardPublicationId, credential_version_id: cardCredentialId,
      logical_intent_id: null, attempt_no: null, completed_at: '2026-08-14T03:12:15.876Z',
      delivery_state: 'UNKNOWN', retry_class: 'READBACK_REQUIRED'
    };
    const job = {
      task_id: cardTaskId, store_id: cardIdentity().storeId, publication_id: cardPublicationId,
      credential_version_id: cardCredentialId, warehouse_id: '123', product_code: '0000133', revision: 1,
      idempotency_key: cardIdempotencyKey, state: 'CARD_SUBMITTING', db_now: '2026-08-14T03:12:16.000Z',
      result_json: {
        cardOperation: 'create', product: { productCode: '0000133', variants: [{ vendorCode: '0000133-01' }] },
        cardCreateIntent: {
          taskId: cardTaskId, publicationId: cardPublicationId, revision: 1, idempotencyKey: cardIdempotencyKey,
          vendorCodes: ['0000133-01'], logicalIntentId: cardIntentId, attemptNo: 1,
          frozenPayload, frozenPayloadHash: `sha256:${createHash('sha256').update(stable(frozenPayload)).digest('hex')}`
        }
      }
    };
    const requestRef = `${cardTaskId}:CARD_WRITE:${cardIntentId}:attempt-1`;
    let legacyRows = [legacy];
    const query = vi.fn(async (sql: string) => {
      if (sql.startsWith('SELECT * FROM wb_gateway_requests WHERE request_ref')) return { rows: [] };
      if (sql.includes('WHERE logical_intent_id=$1 FOR UPDATE')) return { rows: [] };
      if (sql.startsWith('SELECT task_id,store_id,publication_id')) return { rows: [job] };
      if (sql.includes("logical_intent_id IS NULL AND operation='CARD_UPLOAD'")) return { rows: legacyRows };
      throw new Error(`unexpected SQL: ${sql}`);
    });
    (repository as any).transaction = async (operation: (client: any) => Promise<any>) => operation({ query });

    await expect(repository.beginGatewayRequest({
      requestRef, requestHash: cardRequestHash, operation: 'CARD_UPLOAD', identity: cardIdentity(),
      logicalIntentId: cardIntentId, attemptNo: 1
    })).rejects.toMatchObject({ code: 'WB_CARD_LEGACY_ATTEMPT_EXISTS', statusCode: 409 });
    expect(query.mock.calls.some(([sql]) => String(sql).startsWith('INSERT INTO wb_gateway_requests'))).toBe(false);

    legacyRows = [legacy, { ...legacy, request_ref: `${legacy.request_ref}:duplicate` }];
    await expect(repository.beginGatewayRequest({
      requestRef, requestHash: cardRequestHash, operation: 'CARD_UPLOAD', identity: cardIdentity(),
      logicalIntentId: cardIntentId, attemptNo: 1
    })).rejects.toMatchObject({ code: 'WB_CARD_IDENTITY_AMBIGUOUS', statusCode: 409 });
    expect(query.mock.calls.some(([sql]) => String(sql).startsWith('INSERT INTO wb_gateway_requests'))).toBe(false);
  });

  it('rejects creating a new timestamp-shaped legacy CARD_UPLOAD request', async () => {
    const repository = new WbStoreRepository();
    const query = vi.fn(async (sql: string) => {
      if (sql.startsWith('SELECT * FROM wb_gateway_requests WHERE request_ref')) return { rows: [] };
      throw new Error(`unexpected SQL: ${sql}`);
    });
    (repository as any).transaction = async (operation: (client: any) => Promise<any>) => operation({ query });
    await expect(repository.beginGatewayRequest({
      requestRef: `${cardTaskId}:CARD_WRITE:2026-08-14T03:12:10.390Z:0`,
      requestHash: cardRequestHash, operation: 'CARD_UPLOAD', identity: cardIdentity()
    })).rejects.toMatchObject({ code: 'WB_CARD_LEGACY_REPLAY_REQUIRED', statusCode: 409 });
  });

  it('persists the sanitized transport code and phase with the terminal ledger result', async () => {
    const repository = new WbStoreRepository();
    const query = vi.fn(async () => ({ rows: [], rowCount: 1 }));
    (repository as any).query = query;
    await repository.completeGatewayRequest({
      requestRef: 'second__0000133__r1:CARD_WRITE:intent-133:attempt-1',
      statusCode: 0,
      deliveryState: 'UNKNOWN',
      retryClass: 'READBACK_REQUIRED',
      transportCode: 'ECONNRESET',
      transportPhase: 'REQUEST',
      response: { error: 'WB_GATEWAY_TRANSPORT' }
    });
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining('transport_code=$7,transport_phase=$8'),
      expect.arrayContaining(['ECONNRESET', 'REQUEST'])
    );
  });

  it('keeps an existing exact legacy requestRef read-only and idempotent', async () => {
    const repository = new WbStoreRepository();
    const requestHash = cardRequestHash;
    const legacy = {
      request_ref: `${cardTaskId}:CARD_WRITE:2026-08-14T03:12:10.390Z:0`, request_hash: requestHash,
      operation: 'CARD_UPLOAD', task_id: cardTaskId, store_id: cardIdentity().storeId,
      publication_id: cardPublicationId, credential_version_id: cardCredentialId,
      logical_intent_id: null, attempt_no: null, delivery_state: 'UNKNOWN', retry_class: 'READBACK_REQUIRED',
      completed_at: new Date().toISOString()
    };
    const query = vi.fn(async (sql: string) => {
      if (sql.startsWith('SELECT * FROM wb_gateway_requests WHERE request_ref')) return { rows: [legacy] };
      throw new Error(`unexpected SQL: ${sql}`);
    });
    (repository as any).transaction = async (operation: (client: any) => Promise<any>) => operation({ query });

    await expect(repository.beginGatewayRequest({
      requestRef: legacy.request_ref, requestHash, operation: 'CARD_UPLOAD', identity: cardIdentity()
    })).resolves.toMatchObject({ idempotent: true, row: { logical_intent_id: null, attempt_no: null } });
    expect(query.mock.calls.some(([sql]) => String(sql).startsWith('INSERT INTO wb_gateway_requests'))).toBe(false);
  });
});

describe('WB auto-publish activation reset boundaries', () => {
  const now = '2026-08-10T08:00:00.000Z';
  const storeId = '11111111-1111-4111-8111-111111111111';
  const projectedStore = (enabled: boolean) => ({
    id: storeId,
    store_alias: 'second',
    display_name: '第二店',
    enabled,
    auto_publish_enabled: true,
    auto_publish_activated_at: '2026-08-09T08:00:00.000Z',
    auto_publish_mode: 'CREATE_ONLY',
    default_preset_id: '22222222-2222-4222-8222-222222222222',
    warehouse_id: 'warehouse-second',
    warehouse_name: '第二店仓',
    account_currency: 'CNY',
    max_daily_styles: 100,
    active_credential_id: '33333333-3333-4333-8333-333333333333',
    active_credential_version: 1,
    active_credential_fingerprint: 'fingerprint',
    active_credential_updated_at: now,
    preflight_status: 'PASSED',
    seller_id: 'seller-second',
    system_enabled: true,
    root_directory: 'F:/WB',
    row_version: enabled ? 2 : 1,
    config_version: 1,
    created_at: now,
    updated_at: now
  });

  it('resets a store activation boundary when an auto-enabled store is re-enabled', async () => {
    const repository = new WbStoreRepository();
    let projectedReads = 0;
    const query = vi.fn(async (sql: string) => {
      if (sql.startsWith('SELECT * FROM wb_stores')) {
        return { rows: [{ ...projectedStore(false), auto_publish_enabled: true }] };
      }
      if (sql.startsWith('SELECT s.*')) {
        projectedReads += 1;
        return { rows: [projectedStore(projectedReads > 1)] };
      }
      return { rows: [], rowCount: 1 };
    });
    (repository as any).transaction = async (operation: (client: any) => Promise<any>) => operation({ query });

    await expect(repository.setStoreEnabled(storeId, true, 1)).resolves.toMatchObject({ enabled: true });
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining('auto_publish_activated_at=CASE WHEN $3 THEN NOW()'),
      [storeId, true, true]
    );
  });

  it('resets all enabled auto-store activation boundaries when global publishing is re-enabled', async () => {
    const repository = new WbStoreRepository();
    const settingsRow = {
      settings_id: 'default', enabled: false, root_directory: 'F:/WB', timezone: 'Asia/Shanghai',
      global_concurrency: 1, row_version: 1, created_at: now, updated_at: now
    };
    const query = vi.fn(async (sql: string) => {
      if (sql.startsWith('SELECT * FROM wb_system_settings')) return { rows: [settingsRow] };
      if (sql.startsWith('UPDATE wb_system_settings')) return { rows: [{ ...settingsRow, enabled: true, row_version: 2 }] };
      return { rows: [], rowCount: 1 };
    });
    (repository as any).transaction = async (operation: (client: any) => Promise<any>) => operation({ query });

    await expect(repository.updateSettings({ enabled: true, rowVersion: 1 })).resolves.toMatchObject({ enabled: true, rowVersion: 2 });
    expect(query.mock.calls.some(([sql]) => String(sql).includes(
      'WHERE enabled=true AND auto_publish_enabled=true AND archived_at IS NULL'
    ))).toBe(true);
  });
});
