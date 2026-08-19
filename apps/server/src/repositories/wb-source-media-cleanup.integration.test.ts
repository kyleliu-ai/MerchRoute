import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PurchaseRepository } from './purchases.js';
import { WbRepository } from './wb.js';
import { WbStoreRepository } from './wb-stores.js';
import { WbSourceMediaCleanupRepository } from './wb-source-media-cleanup.js';
import { assertIntegrationSchemaBoundary, guardedIntegrationDatabaseUrl } from '../testing/integration-database-guard.js';

const connectionString = guardedIntegrationDatabaseUrl({
  purpose: 'WB source media cleanup PostgreSQL integration test',
  testDatabaseUrl: process.env.WB_SOURCE_MEDIA_CLEANUP_TEST_DATABASE_URL,
  productionDatabaseUrl: process.env.DATABASE_URL
});
const schema = `wb_source_cleanup_test_${randomUUID().replaceAll('-', '')}`;
const testSku = '9900123';
let admin: Pool;
let isolated: Pool;
let purchases: PurchaseRepository;
let wb: WbRepository;
let stores: WbStoreRepository;
let repository: WbSourceMediaCleanupRepository;
let concurrent: WbSourceMediaCleanupRepository;
let secondStoreId: string;

describe.runIf(Boolean(connectionString))('WB source media cleanup PostgreSQL queue', () => {
  beforeAll(async () => {
    admin = new Pool({ connectionString, max: 1 });
    await admin.query(`CREATE SCHEMA ${schema}`);
    const url = new URL(connectionString!);
    url.searchParams.set('options', `-c search_path=${schema},public`);
    isolated = new Pool({ connectionString: url.toString(), max: 1 });
    const boundary = await isolated.query<{ current_schema: string }>('SELECT current_schema()');
    assertIntegrationSchemaBoundary(boundary.rows[0]?.current_schema, schema, 'WB source media cleanup PostgreSQL integration test');
    purchases = new PurchaseRepository(url.toString());
    await purchases.initialize({ code: 'E999', displayName: '测试下载', webhookUrl: 'http://127.0.0.1/test', parentOutputDir: 'C:\\wb-test', enabled: true, isDefault: true });
    wb = new WbRepository(url.toString());
    await wb.initialize();
    stores = new WbStoreRepository(url.toString());
    await stores.initialize();
    await isolated.query(`CREATE TABLE IF NOT EXISTS wb_auto_publish_jobs(
      id UUID PRIMARY KEY,store_id UUID NOT NULL REFERENCES wb_stores(id),sku CHAR(7) NOT NULL REFERENCES products(sku),
      run_id UUID NOT NULL,state TEXT NOT NULL,n8n_task_id TEXT,publication_id UUID,last_delivery_at TIMESTAMPTZ,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),UNIQUE(store_id,sku))`);
    const second = await stores.createStore({
      storeAlias: `cleanup-${randomUUID().slice(0, 8)}`,
      displayName: '清理测试店铺',
      autoPublishEnabled: false,
      autoPublishMode: 'CREATE_ONLY',
      warehouseId: 'warehouse-test',
      warehouseName: '测试仓',
      accountCurrency: 'CNY',
      maxDailyStyles: 10
    });
    secondStoreId = second.id;
    await isolated.query('INSERT INTO products(sku,product_name) VALUES($1,$2)', [testSku, '清理队列测试商品']);
    await isolated.query("INSERT INTO wb_listing_drafts(sku,status,draft_version) VALUES($1,'DRAFT',3)", [testSku]);
    repository = new WbSourceMediaCleanupRepository(url.toString());
    concurrent = new WbSourceMediaCleanupRepository(url.toString());
    await repository.initialize();
    await concurrent.initialize();
  });

  afterAll(async () => {
    await Promise.all([repository?.close(), concurrent?.close(), stores?.close(), wb?.close(), purchases?.close(), isolated?.end()]);
    await admin?.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin?.end();
  });

  it('freezes the complete store set and lets only one worker lease the batch', async () => {
    const expectedStoreIds = ['00000000-0000-4000-8000-000000000001', secondStoreId];
    const batch = await repository.registerBatch({
      sku: testSku,
      source: 'MANUAL',
      batchKey: `manual:${testSku}:plan-a`,
      expectedStoreIds,
      rootDirectory: 'G:\\wb-root',
      mediaSignature: `sha256:${'a'.repeat(64)}`,
      planHash: `sha256:${'b'.repeat(64)}`,
      draftVersion: 3
    });
    expect(batch.expectedStoreIds).toEqual([...expectedStoreIds].sort());
    expect(await repository.targets(batch.id)).toHaveLength(2);
    const draft = await isolated.query('SELECT source_media_state,source_media_cleanup_id FROM wb_listing_drafts WHERE sku=$1', [testSku]);
    expect(draft.rows[0]).toMatchObject({ source_media_state: 'CLEANUP_PENDING', source_media_cleanup_id: batch.id });

    const [left, right] = await Promise.all([repository.claimDue('worker-a', 1), concurrent.claimDue('worker-b', 1)]);
    expect(left.length + right.length).toBe(1);
    const claimed = left[0] || right[0]!;
    expect(claimed.leaseToken).toMatch(/^[0-9a-f-]{36}$/);
    await (left.length ? repository : concurrent).releaseWaiting(claimed, 1_000);
  });

  it('makes dry-run candidates inert until the exact rowVersion is activated', async () => {
    await repository.markSourceAvailable(testSku);
    const candidate = await repository.registerBatch({
      sku: testSku,
      source: 'AUTOMATION',
      batchKey: `historical:automation:${testSku}:test`,
      expectedStoreIds: ['00000000-0000-4000-8000-000000000001'],
      rootDirectory: 'G:\\wb-root',
      mediaSignature: `sha256:${'c'.repeat(64)}`,
      mediaBatchId: `historical-${testSku}`,
      deliveredAt: '2026-08-14T00:00:00.000Z',
      initialStatus: 'CANDIDATE'
    });
    expect(candidate.status).toBe('CANDIDATE');
    await expect(repository.sourceState(testSku)).resolves.toEqual({ state: 'AVAILABLE' });
    expect(await repository.claimDue('worker-a', 10)).toEqual([]);
    await expect(repository.activateCandidate(candidate.id, candidate.rowVersion + 1)).rejects.toMatchObject({ code: 'VERSION_CONFLICT' });
    await expect(repository.activateCandidate(candidate.id, candidate.rowVersion)).resolves.toMatchObject({ status: 'PENDING' });
  });

  it('supersedes pending cleanup when new media arrives and restores AVAILABLE without deleting history', async () => {
    await repository.markSourceAvailable(testSku);
    const latest = await repository.latestForSku(testSku);
    expect(latest?.status).toBe('SUPERSEDED');
    const draft = await isolated.query('SELECT source_media_state,source_media_cleaned_at,source_media_cleanup_id FROM wb_listing_drafts WHERE sku=$1', [testSku]);
    expect(draft.rows[0]).toMatchObject({ source_media_state: 'AVAILABLE', source_media_cleaned_at: null, source_media_cleanup_id: null });
    expect((await repository.list({ sku: testSku })).length).toBeGreaterThanOrEqual(2);
  });

  it('atomically registers an automatic cleanup batch with the complete persisted job set', async () => {
    await isolated.query('DELETE FROM wb_auto_publish_jobs WHERE sku=$1', [testSku]);
    const availableStores = await isolated.query('SELECT id FROM wb_stores ORDER BY id LIMIT 2');
    expect(availableStores.rows).toHaveLength(2);
    const targets = availableStores.rows.map((row) => String(row.id)).sort().map((storeId) => ({
      storeId,
      jobId: randomUUID(),
      runId: randomUUID()
    }));
    for (const target of targets) {
      await isolated.query(`INSERT INTO wb_auto_publish_jobs(id,store_id,sku,run_id,state,last_delivery_at)
        VALUES($1,$2,$3,$4,'WAITING_STABLE',NOW())
        ON CONFLICT(store_id,sku) DO UPDATE SET id=EXCLUDED.id,run_id=EXCLUDED.run_id,state=EXCLUDED.state,
          publication_id=NULL,last_delivery_at=EXCLUDED.last_delivery_at,updated_at=NOW()`, [target.jobId, target.storeId, testSku, target.runId]);
    }
    const input = {
      sku: testSku,
      source: 'AUTOMATION' as const,
      batchKey: 'automation:complete-job-set',
      expectedStoreIds: targets.map((target) => target.storeId),
      rootDirectory: 'G:\\wb-root',
      mediaSignature: `sha256:${'d'.repeat(64)}`,
      mediaBatchId: `sha256:${'e'.repeat(64)}`,
      deliveredAt: '2026-08-14T00:00:00.000Z'
    };

    const [first, second] = await Promise.all([
      repository.registerAutomationBatch(input, targets),
      concurrent.registerAutomationBatch(input, targets)
    ]);

    expect(second.id).toBe(first.id);
    await expect(repository.targets(first.id)).resolves.toEqual(expect.arrayContaining(targets.map((target) => expect.objectContaining({
      storeId: target.storeId,
      automationJobId: target.jobId,
      automationRunId: target.runId
    }))));
    const rows = await isolated.query('SELECT COUNT(*) count FROM wb_source_media_cleanup_batches WHERE batch_key=$1', [input.batchKey]);
    expect(Number(rows.rows[0].count)).toBe(1);
  });

  it('rejects an automatic cleanup batch when the frozen job set is incomplete', async () => {
    const jobs = await isolated.query('SELECT id,store_id,run_id FROM wb_auto_publish_jobs WHERE sku=$1 ORDER BY store_id', [testSku]);
    const onlyOne = jobs.rows.slice(0, 1).map((row) => ({ storeId: String(row.store_id), jobId: String(row.id), runId: String(row.run_id) }));
    await expect(repository.registerAutomationBatch({
      sku: testSku, source: 'AUTOMATION', batchKey: 'automation:incomplete-job-set',
      expectedStoreIds: ['00000000-0000-4000-8000-000000000001', secondStoreId],
      rootDirectory: 'G:\\wb-root', mediaSignature: `sha256:${'f'.repeat(64)}`,
      mediaBatchId: `sha256:${'1'.repeat(64)}`, deliveredAt: '2026-08-14T00:00:00.000Z'
    }, onlyOne)).rejects.toMatchObject({ code: 'CONFIG_INVALID' });
    expect((await isolated.query("SELECT COUNT(*) count FROM wb_source_media_cleanup_batches WHERE batch_key='automation:incomplete-job-set'")).rows[0].count).toBe('0');
  });

  it('uses rowVersion and durable orphan evidence before superseding a zero-job automatic batch', async () => {
    await isolated.query('DELETE FROM wb_auto_publish_jobs WHERE sku=$1', [testSku]);
    const storeRows = await isolated.query('SELECT id FROM wb_stores ORDER BY id LIMIT 2');
    const expectedStoreIds = storeRows.rows.map((row) => String(row.id));
    await isolated.query(`UPDATE wb_stores SET auto_publish_activated_at='2026-08-14T00:10:00.000Z'
      WHERE id=ANY($1::uuid[])`, [expectedStoreIds]);
    const batch = await repository.registerBatch({
      sku: testSku, source: 'AUTOMATION', batchKey: 'automation:orphan-zero-jobs', expectedStoreIds,
      rootDirectory: 'G:\\wb-root', mediaSignature: `sha256:${'2'.repeat(64)}`,
      mediaBatchId: `sha256:${'3'.repeat(64)}`, deliveredAt: '2026-08-14T00:00:00.000Z'
    });

    await expect(repository.inspectOrphanAutomationBatch(batch.id)).resolves.toMatchObject({ reasons: [] });
    await expect(repository.supersedeOrphanAutomationBatch(
      batch.id, batch.rowVersion + 1, 'AUTOMATION_BATCH_WITHOUT_JOBS', 'test'
    )).rejects.toMatchObject({ code: 'VERSION_CONFLICT' });
    await repository.supersedeOrphanAutomationBatch(batch.id, batch.rowVersion, 'AUTOMATION_BATCH_WITHOUT_JOBS', 'test');
    await expect(repository.get(batch.id)).resolves.toMatchObject({
      status: 'SUPERSEDED',
      lastErrorCode: 'AUTOMATION_BATCH_WITHOUT_JOBS'
    });
    await expect(repository.sourceState(testSku)).resolves.toEqual({ state: 'AVAILABLE' });
  });
});
