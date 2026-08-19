import { afterEach, describe, expect, it, vi } from 'vitest';
import { OZON_DEFAULT_STORE_ID } from '@n8n-media-review/shared';
import { OzonStoreRepository } from './ozon-stores.js';

const credentialVersionId = '20000000-0000-4000-8000-000000000001';
const now = '2026-08-11T06:00:00.000Z';
const originalFleetReady = process.env.MERCHROUTE_OZON_MULTISTORE_FLEET_READY;

afterEach(() => {
  if (originalFleetReady === undefined) delete process.env.MERCHROUTE_OZON_MULTISTORE_FLEET_READY;
  else process.env.MERCHROUTE_OZON_MULTISTORE_FLEET_READY = originalFleetReady;
});

function storeRow(preflightStatus: 'PENDING' | 'FAILED' = 'PENDING') {
  return {
    id: OZON_DEFAULT_STORE_ID,
    store_alias: 'default',
    display_name: 'Default',
    enabled: false,
    auto_publish_enabled: false,
    auto_publish_mode: 'CREATE_ONLY',
    warehouse_id: '',
    warehouse_name: '',
    fulfillment_mode: 'FBS',
    account_currency: 'RUB',
    max_daily_styles: 100,
    credential_state: 'PENDING',
    credential_binding_mode: 'VAULT',
    active_credential_version_id: null,
    pending_credential_id: credentialVersionId,
    permissions: [],
    limits: {},
    warehouses: [],
    preflight_status: preflightStatus,
    preflight_error_code: preflightStatus === 'FAILED' ? 'OZON_PREFLIGHT_DISPATCH_REJECTED' : '',
    preflight_error_message: preflightStatus === 'FAILED' ? '预检 Webhook 明确未受理请求' : '',
    preflight_report: {},
    active_task_count: 0,
    queued_task_count: 0,
    duplicate_seller_count: 0,
    config_version: 4,
    row_version: preflightStatus === 'FAILED' ? 10 : 9,
    created_at: now,
    updated_at: now
  };
}

function repositoryWithQuery(query: (sql: string, values: unknown[]) => Promise<any>) {
  const client = {
    query: vi.fn(async (sql: string, values: unknown[] = []) => {
      if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return { rows: [], rowCount: 0 };
      return query(sql, values);
    }),
    release: vi.fn()
  };
  const repository = new OzonStoreRepository();
  (repository as any).pool = { connect: vi.fn(async () => client) };
  return { repository, client };
}

describe('OZON multistore runtime claim projection', () => {
  it('returns the exact frozen P002 snapshot including listing_revision as a positive revision', async () => {
    process.env.MERCHROUTE_OZON_MULTISTORE_FLEET_READY = 'true';
    const directorySignature = `sha256:${'3'.repeat(64)}`;
    const leaseExpiresAt = new Date(Date.now() + 600_000).toISOString();
    const row = {
      id: '50000000-0000-4000-8000-000000000001', sku: '0000119', state: 'READY', source: 'AUTO',
      task_kind: 'STORE_PUBLICATION',
      task_id: 'default__0000119__r2', store_id: OZON_DEFAULT_STORE_ID, store_alias: 'default',
      publication_id: '10000000-0000-4000-8000-000000000001', credential_version_id: credentialVersionId,
      credential_binding_mode: 'VAULT', store_config_version: 4, warehouse_id: '1020002456503000',
      offer_contract_hash: `sha256:${'1'.repeat(64)}`, materialization_hash: `sha256:${'2'.repeat(64)}`,
      listing_revision: 2, offer_ids: ['0000119-01'],
      payload: {
        productJsonPath: 'stores/default/inbox/0000119/product.json',
        contentPolicyVersion: 'merchroute-ozon-content-v3',
        materialHash: `sha256:${'4'.repeat(64)}`,
        materialHashVersion: 'ozon-shared-material-v1'
      },
      publication_content_policy_version: 'merchroute-ozon-content-v3',
      publication_material_hash: `sha256:${'4'.repeat(64)}`,
      publication_material_hash_version: 'ozon-shared-material-v1',
      publication_plan_hash: `sha256:${'5'.repeat(64)}`,
      publication_preset_row_version: 7,
      publication_mode: 'CREATE_ONLY',
      stage_states: { media: 'PENDING' },
      import_task_id: '5280256601', ozon_product_id: '5874416999',
      product_links: [{ offerId: '0000119-01', ozonProductId: '5874416999' }],
      task_folder: '0000119__r2', work_rel_path: 'processing/default__0000119__r2',
      directory_stage: 'PROCESSING', directory_signature: directorySignature,
      row_version: 5, retry_count: 2, last_error_code: 'OZON_RATE_LIMITED',
      last_error_message: '等待平台窗口', next_attempt_at: null
    };
    const { repository } = repositoryWithQuery(async (sql, values) => {
      if (sql.includes('pg_advisory_xact_lock')) return { rows: [], rowCount: 1 };
      if (sql.startsWith('UPDATE ozon_publish_jobs SET lease_owner=NULL')) return { rows: [], rowCount: 0 };
      if (sql.includes("payload=payload-'recoveryHold'")) return { rows: [], rowCount: 0 };
      if (sql.includes('SELECT enabled,global_concurrency')) return { rows: [{ enabled: true, global_concurrency: 2 }], rowCount: 1 };
      if (sql.includes('SELECT COUNT(*) count FROM ozon_publish_jobs')) return { rows: [{ count: '0' }], rowCount: 1 };
      if (sql.startsWith('WITH ranked AS')) return { rows: [row], rowCount: 1 };
      if (sql.startsWith('UPDATE ozon_publish_jobs SET\n          lease_owner=')) return {
        rows: [{
          ...row,
          lease_owner: values[1],
          lease_token: values[2],
          lease_expires_at: leaseExpiresAt,
          row_version: 6
        }],
        rowCount: 1
      };
      if (sql.startsWith('UPDATE ozon_store_runtime_state SET last_dispatched_at=')) return { rows: [], rowCount: 1 };
      if (sql.startsWith('INSERT INTO ozon_publish_events')) return { rows: [], rowCount: 1 };
      throw new Error(`unexpected claim SQL: ${sql}`);
    });

    const claimed = await repository.claimRuntimeJobs({ leaseOwner: 'ozon-p002:test', leaseSeconds: 600, limit: 2 });
    expect(claimed).toEqual([{
      id: row.id, sku: row.sku, state: 'READY', source: 'AUTO', taskKind: 'STORE_PUBLICATION', taskId: row.task_id,
      storeId: row.store_id, storeAlias: row.store_alias, publicationId: row.publication_id,
      credentialVersionId: row.credential_version_id, credentialBindingMode: 'VAULT',
      storeConfigVersion: 4, warehouseId: row.warehouse_id,
      offerContractHash: row.offer_contract_hash, materializationHash: row.materialization_hash,
      contentPolicyVersion: 'merchroute-ozon-content-v3',
      publicationContentPolicyVersion: 'merchroute-ozon-content-v3',
      materialHash: `sha256:${'4'.repeat(64)}`,
      materialHashVersion: 'ozon-shared-material-v1',
      publicationMaterialHash: `sha256:${'4'.repeat(64)}`,
      publicationMaterialHashVersion: 'ozon-shared-material-v1',
      planHash: `sha256:${'5'.repeat(64)}`,
      presetRowVersion: 7,
      publicationMode: 'CREATE_ONLY',
      revision: 2, offerIds: row.offer_ids, payload: row.payload, stageStates: row.stage_states,
      importTaskId: row.import_task_id, ozonProductId: row.ozon_product_id, ozonProductLinks: row.product_links,
      taskFolder: row.task_folder, workRelPath: row.work_rel_path, directoryStage: row.directory_stage,
      directorySignature, rowVersion: 6, leaseOwner: 'ozon-p002:test', leaseToken: expect.any(String),
      leaseExpiresAt, retryCount: 2, lastErrorCode: row.last_error_code, lastErrorMessage: row.last_error_message
    }]);
  });
});

describe('OZON preflight lock recovery', () => {
  it('rejects a second manual run while the original report lease is still active', async () => {
    const { repository, client } = repositoryWithQuery(async (sql) => {
      if (sql.startsWith('SELECT * FROM ozon_stores')) return { rows: [storeRow()], rowCount: 1 };
      if (sql.includes('FROM ozon_store_runtime_state rs')) return {
        rows: [{
          store_id: OZON_DEFAULT_STORE_ID,
          preflight_credential_version_id: credentialVersionId,
          preflight_store_config_version: 4,
          preflight_lock_expires_at: '2026-08-11T06:15:00.000Z',
          preflight_lease_owner: 'manual',
          preflight_lock_active: true
        }],
        rowCount: 1
      };
      throw new Error(`unexpected SQL: ${sql}`);
    });

    await expect(repository.beginPreflight(OZON_DEFAULT_STORE_ID, 9)).rejects.toMatchObject({
      code: 'OZON_PREFLIGHT_IN_PROGRESS', statusCode: 409
    });
    expect(client.query.mock.calls.some(([sql]) => String(sql).startsWith('UPDATE '))).toBe(false);
  });

  it('records an expired report lease as FAILED evidence before safely starting a new PENDING run', async () => {
    let projection = storeRow();
    let auditValues: unknown[] | undefined;
    const { repository, client } = repositoryWithQuery(async (sql, values) => {
      if (sql.startsWith('SELECT * FROM ozon_stores')) return { rows: [projection], rowCount: 1 };
      if (sql.includes('FROM ozon_store_runtime_state rs')) return {
        rows: [{
          store_id: OZON_DEFAULT_STORE_ID,
          preflight_credential_version_id: credentialVersionId,
          preflight_store_config_version: 4,
          preflight_lock_expires_at: '2026-08-11T05:45:00.000Z',
          preflight_lease_owner: 'manual',
          preflight_lock_active: false
        }],
        rowCount: 1
      };
      if (sql.includes('INSERT INTO ozon_store_preflight_runs')) {
        auditValues = values;
        return { rows: [{ id: 'audit' }], rowCount: 1 };
      }
      if (sql.includes('FROM ozon_store_credential_versions')) {
        return { rows: [{ id: credentialVersionId, status: 'PENDING', version_no: 1 }], rowCount: 1 };
      }
      if (sql.includes("UPDATE ozon_stores SET preflight_status='PENDING'")) {
        projection = {
          ...projection,
          preflight_status: 'PENDING',
          preflight_error_code: 'OZON_PREFLIGHT_REPORT_TIMEOUT',
          preflight_error_message: '预检任务在租约期限内未回写结果',
          row_version: 10
        };
        return { rows: [], rowCount: 1 };
      }
      if (sql.startsWith('UPDATE ozon_store_runtime_state SET')) return { rows: [], rowCount: 1 };
      if (sql.startsWith('SELECT s.*')) return { rows: [projection], rowCount: 1 };
      throw new Error(`unexpected SQL: ${sql}`);
    });

    const result = await repository.beginPreflight(OZON_DEFAULT_STORE_ID, 9);
    expect(result.store.preflight).toMatchObject({
      status: 'PENDING',
      errorCode: 'OZON_PREFLIGHT_REPORT_TIMEOUT'
    });
    expect(auditValues?.[5]).toBe('OZON_PREFLIGHT_REPORT_TIMEOUT');
    expect(JSON.parse(String(auditValues?.[4]))).toMatchObject({
      source: 'MERCHROUTE_LOCK_TIMEOUT', result: 'FAILED'
    });
    expect(client.query.mock.calls.some(([sql]) => String(sql).includes("preflight_status='PASSED'"))).toBe(false);
  });

  it('clears an explicitly rejected manual dispatch and marks a credential-only store FAILED', async () => {
    let projection = storeRow();
    let runtimeCleared = false;
    let auditValues: unknown[] | undefined;
    const { repository, client } = repositoryWithQuery(async (sql, values) => {
      if (sql.includes('SELECT s.active_credential_version_id,rs.*')) return {
        rows: [{
          active_credential_version_id: null,
          preflight_credential_version_id: credentialVersionId,
          preflight_store_config_version: 4,
          preflight_lock_expires_at: '2026-08-11T06:15:00.000Z',
          preflight_lease_owner: 'manual'
        }],
        rowCount: 1
      };
      if (sql.includes('INSERT INTO ozon_store_preflight_runs')) {
        auditValues = values;
        return { rows: [{ id: 'audit' }], rowCount: 1 };
      }
      if (sql.startsWith('UPDATE ozon_store_runtime_state SET')) {
        runtimeCleared = true;
        return { rows: [], rowCount: 1 };
      }
      if (sql.includes("UPDATE ozon_stores SET preflight_status='FAILED'")) {
        projection = storeRow('FAILED');
        return { rows: [], rowCount: 1 };
      }
      if (sql.startsWith('SELECT s.*')) return { rows: [projection], rowCount: 1 };
      throw new Error(`unexpected SQL: ${sql}`);
    });

    const result = await repository.failPreflightDispatch(OZON_DEFAULT_STORE_ID, 4, credentialVersionId);
    expect(runtimeCleared).toBe(true);
    expect(result.preflight).toMatchObject({ status: 'FAILED', errorCode: 'OZON_PREFLIGHT_DISPATCH_REJECTED' });
    expect(auditValues?.[5]).toBe('OZON_PREFLIGHT_DISPATCH_REJECTED');
    expect(JSON.parse(String(auditValues?.[4]))).toEqual({
      source: 'MERCHROUTE_DISPATCH_REJECTED', result: 'FAILED'
    });
    expect(client.query.mock.calls.some(([sql]) => String(sql).includes("preflight_status='PASSED'"))).toBe(false);
  });

  it('lets the hourly claim recover an expired asynchronous run without manufacturing PASSED', async () => {
    let auditValues: unknown[] | undefined;
    const { repository, client } = repositoryWithQuery(async (sql, values) => {
      if (sql.includes('SELECT\n          s.id store_id')) return {
        rows: [{
          store_id: OZON_DEFAULT_STORE_ID,
          store_alias: 'default',
          config_version: 4,
          active_credential_version_id: null,
          credential_version_id: credentialVersionId,
          credential_status: 'PENDING',
          preflight_lock_expires_at: '2026-08-11T05:45:00.000Z',
          expired_credential_version_id: credentialVersionId,
          expired_store_config_version: 4
        }],
        rowCount: 1
      };
      if (sql.includes('INSERT INTO ozon_store_preflight_runs')) {
        auditValues = values;
        return { rows: [{ id: 'audit' }], rowCount: 1 };
      }
      if (sql.startsWith('UPDATE ozon_store_runtime_state SET')) return {
        rows: [{ preflight_lock_expires_at: '2026-08-11T06:15:00.000Z' }],
        rowCount: 1
      };
      if (sql.includes("UPDATE ozon_stores SET preflight_status='PENDING'")) return { rows: [], rowCount: 1 };
      throw new Error(`unexpected SQL: ${sql}`);
    });

    const claimed = await repository.claimDuePreflights({ leaseOwner: 'ozon-c001-hourly', limit: 20 });
    expect(claimed).toHaveLength(1);
    expect(claimed[0]).toMatchObject({
      storeId: OZON_DEFAULT_STORE_ID,
      storeAlias: 'default',
      storeConfigVersion: 4,
      credentialVersionId
    });
    expect(auditValues?.[5]).toBe('OZON_PREFLIGHT_REPORT_TIMEOUT');
    expect(client.query.mock.calls.some(([sql]) => String(sql).includes("preflight_status='PASSED'"))).toBe(false);
  });
});

describe('OZON pre-platform multistore preparation recheck gate', () => {
  const preparationRow = (overrides: Record<string, unknown> = {}) => ({
    id: 'c3ac35ed-0000-4000-8000-000000000001',
    sku: '0000119',
    source: 'AUTO',
    state: 'NEEDS_ATTENTION',
    store_id: OZON_DEFAULT_STORE_ID,
    publication_id: null,
    credential_binding_mode: 'VAULT',
    row_version: 9,
    task_id: null,
    import_task_id: null,
    ozon_product_id: null,
    task_folder: null,
    work_rel_path: 'inbox/0000119',
    directory_stage: 'INBOX',
    directory_signature: null,
    lease_owner: null,
    lease_token: null,
    lease_expires_at: null,
    product_links: [],
    payload: { multistorePreparation: true, mediaSignature: 'local-only-signature' },
    ...overrides
  });

  function routeGuard(row: Record<string, unknown>) {
    const query = vi.fn(async () => ({ rows: [row], rowCount: 1 }));
    const repository = new OzonStoreRepository();
    (repository as any).pool = { query };
    return { repository, query };
  }

  it('returns the exact rowVersion token only for a default-store AUTO preparation with no platform evidence', async () => {
    const { repository } = routeGuard(preparationRow());

    await expect(repository.assertLegacyJobRouteAllowed(
      'c3ac35ed-0000-4000-8000-000000000001',
      'RECHECK'
    )).resolves.toEqual({ expectedRowVersion: 9 });
  });

  it.each([
    ['publication bound', { publication_id: '10000000-0000-4000-8000-000000000001' }],
    ['non-default store', { store_id: '7d15ba0c-9270-4dd8-bf43-55457670f290' }],
    ['wrong source', { source: 'MANUAL' }],
    ['runnable state', { state: 'READY' }],
    ['runtime task', { task_id: 'default__0000119__r1' }],
    ['import task', { import_task_id: '123' }],
    ['remote product', { ozon_product_id: '501' }],
    ['processing directory', { directory_stage: 'PROCESSING' }],
    ['runtime lease', { lease_token: '00000000-0000-4000-8000-000000000091' }],
    ['unknown delivery', { payload: { multistorePreparation: true, networkRecovery: { deliveryState: 'UNKNOWN' } } }],
    ['platform write marker', { payload: { multistorePreparation: true, platformWriteAttempted: true } }]
  ])('keeps %s fail closed behind publication APIs', async (_label, overrides) => {
    const { repository } = routeGuard(preparationRow(overrides));

    await expect(repository.assertLegacyJobRouteAllowed(
      'c3ac35ed-0000-4000-8000-000000000001',
      'RECHECK'
    )).rejects.toMatchObject({ code: 'OZON_PUBLICATION_REQUIRED', statusCode: 409 });
  });

  it('does not extend the exception to cancel', async () => {
    const { repository } = routeGuard(preparationRow());

    await expect(repository.assertLegacyJobRouteAllowed(
      'c3ac35ed-0000-4000-8000-000000000001',
      'CANCEL'
    )).rejects.toMatchObject({ code: 'OZON_PUBLICATION_REQUIRED', statusCode: 409 });
  });
});
