import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WbAutoPublishRepository } from './wb-auto-publish.js';

const connectionString = process.env.DATABASE_URL;
const schema = `wb_auto_publish_test_${randomUUID().replaceAll('-', '')}`;
let admin: Pool;
let isolatedPool: Pool;
let repository: WbAutoPublishRepository;
let presetId: string;

describe.runIf(Boolean(connectionString))('WB auto publish PostgreSQL repository', () => {
  beforeAll(async () => {
    admin = new Pool({ connectionString, max: 1 });
    await admin.query(`CREATE SCHEMA ${schema}`);
    const isolated = new URL(connectionString!);
    isolated.searchParams.set('options', `-c search_path=${schema},public`);
    isolatedPool = new Pool({ connectionString: isolated.toString(), max: 1 });
    await isolatedPool.query('CREATE TABLE products(sku CHAR(7) PRIMARY KEY,product_name TEXT NOT NULL)');
    await isolatedPool.query('CREATE TABLE wb_listing_presets(id UUID PRIMARY KEY)');
    await isolatedPool.query(`CREATE TABLE wb_listing_drafts(
      sku CHAR(7) PRIMARY KEY REFERENCES products(sku),status TEXT NOT NULL DEFAULT 'DRAFT',
      draft_version INTEGER NOT NULL DEFAULT 1,
      nm_ids JSONB NOT NULL DEFAULT '[]'::jsonb,product_urls JSONB NOT NULL DEFAULT '[]'::jsonb,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
    await isolatedPool.query(`CREATE TABLE wb_publish_jobs(
      task_id TEXT PRIMARY KEY,state TEXT NOT NULL,lease_owner TEXT NOT NULL DEFAULT '',
      lease_expires_at TIMESTAMPTZ,row_version INTEGER NOT NULL DEFAULT 1)`);
    await isolatedPool.query(`CREATE TABLE wb_listing_versions(
      id UUID PRIMARY KEY,sku CHAR(7) NOT NULL,status TEXT NOT NULL,
      generation_scope TEXT NOT NULL DEFAULT 'LISTING',materialization_hash TEXT,
      automation_context JSONB NOT NULL DEFAULT '{}'::jsonb,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
    await isolatedPool.query(`CREATE TABLE wb_store_publications(
      id UUID PRIMARY KEY,sku CHAR(7),generated_version_id UUID,store_id UUID NOT NULL,
      source TEXT,config_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,
      request_key TEXT,
      materialization_hash TEXT,
      nm_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
      product_urls JSONB NOT NULL DEFAULT '[]'::jsonb,
      result_json JSONB NOT NULL DEFAULT '{}'::jsonb)`);
    presetId = randomUUID();
    await isolatedPool.query(`INSERT INTO products(sku,product_name) VALUES
      ('0000098','自动上品测试商品'),('0000097','通知补偿测试商品'),('0000096','通知竞态测试商品'),
      ('0000095','重试失败测试商品'),('0000094','取消解决测试商品'),('0000093','历史终态测试商品')`);
    await isolatedPool.query("INSERT INTO products(sku,product_name) VALUES('0000092','模板绑定测试商品'),('0000081','双店同SKU测试商品')");
    await isolatedPool.query("INSERT INTO products(sku,product_name) VALUES('0000080','双店取消锁测试'),('0000079','双店暂停锁测试')");
    await isolatedPool.query("INSERT INTO products(sku,product_name) VALUES('0000091','兼容多轮测试商品')");
    await isolatedPool.query("INSERT INTO products(sku,product_name) VALUES('0000078','多店铺商品链接投影测试')");
    await isolatedPool.query("INSERT INTO products(sku,product_name) VALUES('0000077','十店生成租约测试'),('0000076','过期生成租约测试'),('0000075','终态生成租约测试'),('0000074','租约 fencing 测试'),('0000073','新 run 清理发布身份测试')");
    await isolatedPool.query("INSERT INTO products(sku,product_name) VALUES('0000089','自动日期筛选起点'),('0000088','自动日期筛选中间'),('0000087','自动日期筛选终点'),('0000086','恢复状态同步测试'),('0000085','自动归属测试'),('0000084','手动接管测试'),('0000083','网络等待测试'),('0000082','历史网络失败测试')");
    await isolatedPool.query('INSERT INTO wb_listing_presets(id) VALUES($1)', [presetId]);
    repository = new WbAutoPublishRepository(isolated.toString());
    await repository.initialize();
  });

  afterAll(async () => {
    await repository?.close();
    await isolatedPool?.end();
    await admin?.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin?.end();
  });

  it('filters automatic jobs by updated date, state, and query with correct totals', async () => {
    const deliveredAt = '2026-07-20T16:00:00.000Z';
    await repository.enqueueDelivery(autoInput('0000089', 'date-start', deliveredAt));
    await repository.enqueueDelivery(autoInput('0000088', 'date-middle', deliveredAt));
    await repository.enqueueDelivery(autoInput('0000087', 'date-end', deliveredAt));
    await repository.transition('0000089', 'NEEDS_ATTENTION', { nextAttemptAt: null, message: '起点任务' });
    await repository.transition('0000088', 'NEEDS_ATTENTION', { nextAttemptAt: null, message: '中间任务' });
    await repository.transition('0000087', 'WAITING_MEDIA', { nextAttemptAt: null, message: '终点任务' });
    await isolatedPool.query(`UPDATE wb_auto_publish_jobs SET updated_at=CASE sku
      WHEN '0000089' THEN '2026-07-21T16:00:00.000Z'::timestamptz
      WHEN '0000088' THEN '2026-07-22T08:00:00.000Z'::timestamptz
      WHEN '0000087' THEN '2026-07-22T16:00:00.000Z'::timestamptz END
      WHERE sku IN ('0000089','0000088','0000087')`);

    const range = await repository.list({ updatedFrom: '2026-07-21T16:00:00.000Z', updatedTo: '2026-07-22T16:00:00.000Z' });
    expect(range.total).toBe(2);
    expect(range.items.map((item) => item.sku)).toEqual(['0000088', '0000089']);

    const combined = await repository.list({ state: 'NEEDS_ATTENTION', query: '0000088', updatedFrom: '2026-07-21T16:00:00.000Z', updatedTo: '2026-07-22T16:00:00.000Z' });
    expect(combined.total).toBe(1);
    expect(combined.items[0]?.sku).toBe('0000088');
  });

  it('keeps the same SKU isolated across two stores, events, transitions, and run history', async () => {
    const secondStoreId = randomUUID();
    const deliveredAt = new Date(Date.now() - 60_000).toISOString();
    const defaultJob = await repository.enqueueDelivery(autoInput('0000081', 'same-sku-default', deliveredAt));
    const secondJob = await repository.enqueueDelivery({
      ...autoInput('0000081', 'same-sku-second', deliveredAt),
      storeId: secondStoreId
    });

    expect(defaultJob).toMatchObject({ sku: '0000081', storeId: '00000000-0000-4000-8000-000000000001' });
    expect(secondJob).toMatchObject({ sku: '0000081', storeId: secondStoreId });
    expect(secondJob?.id).not.toBe(defaultJob?.id);

    await repository.transition('0000081', 'NEEDS_ATTENTION', { errorCode: 'SECOND_ONLY', errorMessage: '第二店失败' }, secondStoreId);
    await expect(repository.get('0000081')).resolves.toMatchObject({ state: 'WAITING_STABLE' });
    await expect(repository.get('0000081', secondStoreId)).resolves.toMatchObject({ state: 'NEEDS_ATTENTION', lastErrorCode: 'SECOND_ONLY' });
    expect((await repository.get('0000081')).events.map((event) => event.eventType)).not.toContain('STATE_CHANGED');
    expect((await repository.get('0000081', secondStoreId)).events.map((event) => event.eventType)).toContain('STATE_CHANGED');

    const rows = await isolatedPool.query<{ store_id: string; total: string }>(`SELECT store_id::text,COUNT(*)::text total
      FROM wb_auto_publish_jobs WHERE sku='0000081' GROUP BY store_id ORDER BY store_id`);
    expect(rows.rows).toHaveLength(2);
    expect(rows.rows.every((row) => Number(row.total) === 1)).toBe(true);
    // Do not leak a due default-store job into later claim tests. A store has a
    // single active lease, so claiming this fixture would legitimately block
    // the later WAITING_NETWORK job for the same default store.
    await repository.transition('0000081', 'NEEDS_ATTENTION', { nextAttemptAt: null });
  });

  it('shows only automatic-owned drafts while preserving hidden job history and aligned counts', async () => {
    const deliveredAt = new Date(Date.now() - 60_000).toISOString();
    const automaticJob = await repository.enqueueDelivery(autoInput('0000085', 'ownership-auto', deliveredAt));
    await repository.enqueueDelivery(autoInput('0000084', 'ownership-manual', deliveredAt));
    await isolatedPool.query(`INSERT INTO wb_listing_drafts(
        sku,status,latest_operation_source,latest_operation_at,latest_operation_ref)
      VALUES
        ('0000085','DRAFT','AUTOMATION',NOW()-INTERVAL '1 second',$1),
        ('0000084','DRAFT','MANUAL',NOW(),'manual:save:2')`, [`automation:${automaticJob!.runId}`]);

    expect((await repository.list({ query: '0000085' })).items.map((job) => job.sku)).toEqual(['0000085']);
    expect((await repository.list({ query: '0000084' })).total).toBe(0);
    await expect(repository.get('0000084')).resolves.toMatchObject({ sku: '0000084', hasListing: true });
    await expect(repository.listRuns('0000084')).resolves.toEqual([expect.objectContaining({ sku: '0000084' })]);

    const before = await repository.counts();
    await isolatedPool.query(`UPDATE wb_listing_drafts SET
      latest_operation_source='MANUAL',latest_operation_at=NOW(),latest_operation_ref='manual:save:3'
      WHERE sku='0000085'`);
    const after = await repository.counts();
    expect(after.WAITING_STABLE || 0).toBe((before.WAITING_STABLE || 0) - 1);
    expect((await repository.list({ query: '0000085' })).total).toBe(0);

    await repository.markAutomaticOperation('0000085', automaticJob!.runId, new Date(Date.now() - 120_000).toISOString());
    expect((await repository.list({ query: '0000085' })).total).toBe(0);
    await repository.markAutomaticOperation('0000085', automaticJob!.runId, new Date(Date.now() + 1_000).toISOString());
    expect((await repository.list({ query: '0000085' })).total).toBe(1);
    await repository.transition('0000085', 'WAITING_MEDIA', { nextAttemptAt: null });
    await repository.transition('0000084', 'WAITING_MEDIA', { nextAttemptAt: null });
  });

  it('deduplicates delivery events, leases due jobs, and never hot-loops waiting states', async () => {
    const deliveredAt = new Date(Date.now() - 60_000).toISOString();
    const input = {
      sku: '0000098', stageId: 'E005' as const, submissionId: 'delivery-1', variantId: randomUUID(), deliveredAt,
      preset: { id: presetId, name: '自动预设', rowVersion: 1, snapshot: { autoPublishEnabled: true } },
      binding: binding(presetId, '自动预设', 1, deliveredAt),
      debounceUntil: new Date(Date.now() - 1_000).toISOString(), operationMode: 'CREATE_ONLY' as const
    };
    await repository.enqueueDelivery(input);
    await repository.enqueueDelivery(input);
    const detail = await repository.get('0000098');
    expect(detail.events.filter((event) => event.eventType === 'MEDIA_DELIVERED')).toHaveLength(1);

    const claimed = await repository.claimDue('worker-a', 2, 60_000);
    expect(claimed).toHaveLength(1);
    expect(claimed[0]).toMatchObject({ sku: '0000098', storeId: '00000000-0000-4000-8000-000000000001' });
    await expect(repository.claimDue('worker-b', 2, 60_000)).resolves.toHaveLength(0);

    await repository.transition('0000098', 'WAITING_MEDIA', { nextAttemptAt: null, message: '等待 E004' });
    await expect(repository.claimDue('worker-a', 2)).resolves.toHaveLength(0);
    await repository.transition('0000098', 'NEEDS_ATTENTION', { nextAttemptAt: null, message: '人工处理' });
    await expect(repository.claimDue('worker-a', 2)).resolves.toHaveLength(0);
  });

  it('persists WAITING_NETWORK indefinitely and only claims it when the saved retry time is due', async () => {
    const deliveredAt = new Date(Date.now() - 60_000).toISOString();
    await repository.enqueueDelivery(autoInput('0000083', 'network-wait', deliveredAt));
    const future = new Date(Date.now() + 15 * 60_000).toISOString();
    const recovery = {
      phase: 'SUBMITTING', resumeState: 'SUBMITTING', deliveryState: 'UNKNOWN' as const, attempt: 20,
      firstFailureAt: '2026-08-01T00:00:00.000Z', lastFailureAt: new Date().toISOString(), nextAttemptAt: future,
      lastErrorCode: 'ETIMEDOUT', lastErrorMessage: 'network unavailable', checkpoint: 'taskId:0000083__r1'
    };
    const waiting = await repository.transition('0000083', 'WAITING_NETWORK', {
      nextAttemptAt: future, networkRecovery: recovery, errorCode: 'ETIMEDOUT', errorMessage: 'network unavailable'
    });
    expect(waiting).toMatchObject({ state: 'WAITING_NETWORK', networkRecovery: { attempt: 20, resumeState: 'SUBMITTING' } });
    await expect(repository.claimDue('network-worker', 1)).resolves.toEqual([]);

    const due = { ...recovery, nextAttemptAt: new Date(Date.now() - 1_000).toISOString() };
    await repository.transition('0000083', 'WAITING_NETWORK', { nextAttemptAt: due.nextAttemptAt, networkRecovery: due });
    await expect(repository.claimDue('network-worker', 1)).resolves.toEqual([
      expect.objectContaining({ sku: '0000083', state: 'WAITING_NETWORK', networkRecovery: expect.objectContaining({ attempt: 20 }) })
    ]);
  });

  it('recovers a historical transport failure only with exact run/task/xmin identity and no live lease', async () => {
    const deliveredAt = new Date(Date.now() - 60_000).toISOString();
    await repository.enqueueDelivery(autoInput('0000082', 'historical-network-failure', deliveredAt));
    await repository.transition('0000082', 'QUEUED', {
      eventType: 'CREATE_ONLY_SUBMITTED', n8nTaskId: '0000082__r1', nextAttemptAt: null
    });
    await repository.transition('0000082', 'FAILED', {
      nextAttemptAt: null, errorCode: 'ECONNRESET', errorMessage: 'socket hang up while publishing'
    });
    const candidates = await repository.listHistoricalNetworkFailureCandidates();
    expect(candidates).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'AUTO',
        identity: expect.objectContaining({ sku: '0000082', taskId: '0000082__r1', runNo: 1 }),
        rowVersion: expect.stringMatching(/^\d+$/),
        proposedRecovery: expect.objectContaining({
          phase: 'SUBMIT_READBACK', resumeState: 'SUBMITTING', deliveryState: 'UNKNOWN', attempt: 1,
          lastErrorCode: 'ECONNRESET', checkpoint: 'taskId:0000082__r1'
        }),
        evidence: expect.objectContaining({ state: 'FAILED', transport: true, activeLease: false, errorCode: 'ECONNRESET' }),
        job: expect.objectContaining({ sku: '0000082', state: 'FAILED', lastErrorCode: 'ECONNRESET' })
      })
    ]));
    await expect(repository.get('0000082')).resolves.toMatchObject({ state: 'FAILED' });
    const candidate = candidates.find((item) => item.identity.sku === '0000082')!;
    await expect(repository.recoverHistoricalNetworkFailure('0000082', {
      ...candidate.identity, rowVersion: '0'
    }, candidate.proposedRecovery)).rejects.toMatchObject({ code: 'VERSION_CONFLICT' });
    await expect(repository.recoverHistoricalNetworkFailure('0000082', {
      ...candidate.identity, rowVersion: candidate.rowVersion
    }, {
      ...candidate.proposedRecovery,
      nextAttemptAt: new Date(Date.parse(candidate.proposedRecovery.nextAttemptAt) + 30_000).toISOString()
    })).rejects.toMatchObject({ code: 'VERSION_CONFLICT' });

    await isolatedPool.query(`UPDATE wb_auto_publish_jobs SET worker_id='historical-live-worker',
      lease_until=NOW()+INTERVAL '10 minutes' WHERE sku='0000082'`);
    const leased = await isolatedPool.query<{ row_version: string }>("SELECT xmin::text row_version FROM wb_auto_publish_jobs WHERE sku='0000082'");
    await expect(repository.recoverHistoricalNetworkFailure('0000082', {
      ...candidate.identity, rowVersion: leased.rows[0]!.row_version
    }, candidate.proposedRecovery)).rejects.toMatchObject({ code: 'TASK_LOCKED' });

    await isolatedPool.query("UPDATE wb_auto_publish_jobs SET lease_until=NOW()-INTERVAL '1 second' WHERE sku='0000082'");
    const dueCandidate = (await repository.listHistoricalNetworkFailureCandidates()).find((item) => item.identity.sku === '0000082')!;
    await isolatedPool.query(`INSERT INTO wb_publish_jobs(task_id,state) VALUES('0000082__r1','FAILED')`);
    await expect(repository.recoverHistoricalNetworkFailure('0000082', {
      ...dueCandidate.identity, rowVersion: dueCandidate.rowVersion
    }, dueCandidate.proposedRecovery)).rejects.toMatchObject({ code: 'RUNTIME_RECOVERY_REQUIRED' });
    await isolatedPool.query(`UPDATE wb_publish_jobs SET state='RETRY_WAIT',row_version=row_version+1
      WHERE task_id='0000082__r1'`);
    const recovered = await repository.recoverHistoricalNetworkFailure('0000082', {
      ...dueCandidate.identity, rowVersion: dueCandidate.rowVersion
    }, dueCandidate.proposedRecovery);
    expect(recovered).toMatchObject({
      rowVersion: expect.stringMatching(/^\d+$/),
      evidence: { state: 'FAILED', transport: true, activeLease: false, errorCode: 'ECONNRESET' },
      job: {
        sku: '0000082', runId: dueCandidate.identity.runId, runNo: dueCandidate.identity.runNo,
        n8nTaskId: '0000082__r1', state: 'WAITING_NETWORK',
        networkRecovery: { attempt: 1, resumeState: 'SUBMITTING' }
      }
    });
    expect(recovered.rowVersion).not.toBe(dueCandidate.rowVersion);
    expect((await repository.listHistoricalNetworkFailureCandidates()).some((item) => item.identity.sku === '0000082')).toBe(false);
    expect((await repository.get('0000082')).events).toEqual(expect.arrayContaining([
      expect.objectContaining({ eventType: 'HISTORICAL_NETWORK_FAILURE_RECOVERED', fromState: 'FAILED', toState: 'WAITING_NETWORK' })
    ]));
  });

  it('keeps recently failed submitted jobs in the bounded n8n recovery synchronization window', async () => {
    const deliveredAt = new Date(Date.now() - 60_000).toISOString();
    await repository.enqueueDelivery(autoInput('0000086', 'delivery-recovery-sync', deliveredAt));
    await repository.transition('0000086', 'QUEUED', {
      eventType: 'CREATE_ONLY_SUBMITTED', n8nTaskId: '0000086__r1', nextAttemptAt: null
    });
    await repository.transition('0000086', 'FAILED', {
      eventType: 'LISTING_STATUS_SYNCED', errorCode: 'WB_TASK_FAILED',
      errorMessage: '临时网络失败', nextAttemptAt: null
    });
    expect((await repository.listSubmitted()).some((job) => job.sku === '0000086')).toBe(true);

    await isolatedPool.query("UPDATE wb_auto_publish_jobs SET last_error_code=NULL,last_error_message=NULL WHERE sku='0000086'");
    expect((await repository.listSubmitted()).some((job) => job.sku === '0000086')).toBe(true);

    await isolatedPool.query("UPDATE wb_auto_publish_jobs SET updated_at=NOW()-INTERVAL '25 hours' WHERE sku='0000086'");
    expect((await repository.listSubmitted()).some((job) => job.sku === '0000086')).toBe(false);
  });

  it('returns API-safe job flags and unlocks an automatic draft when cancelled', async () => {
    await isolatedPool.query("INSERT INTO wb_listing_drafts(sku,status,auto_publish_locked) VALUES('0000098','DRAFT',true) ON CONFLICT(sku) DO UPDATE SET auto_publish_locked=true");
    await repository.transition('0000098', 'NEEDS_ATTENTION', { incrementAttempt: true, incrementRetryKey: 'INITIALIZATION' });
    await repository.transition('0000098', 'NEEDS_ATTENTION', { incrementAttempt: true, incrementRetryKey: 'WB_READ' });
    await expect(repository.get('0000098')).resolves.toMatchObject({
      attemptCount: 2,
      retryCounters: { INITIALIZATION: 1, WB_READ: 1 }
    });
    await repository.recheck('0000098');
    const rechecked = await repository.get('0000098');
    expect(rechecked).toMatchObject({ state: 'CHECKING', canCancel: true, hasListing: true, retryCounters: {} });
    const cancelled = await repository.cancel('0000098');
    expect(cancelled).toMatchObject({ state: 'CANCELLED', canCancel: false, canRecheck: false });
    const lock = await isolatedPool.query<{ auto_publish_locked: boolean }>("SELECT auto_publish_locked FROM wb_listing_drafts WHERE sku='0000098'");
    expect(lock.rows[0]?.auto_publish_locked).toBe(false);
  });

  it('holds a PostgreSQL session advisory lock for the whole SKU operation', async () => {
    let release!: () => void;
    let entered!: () => void;
    const enteredPromise = new Promise<void>((resolve) => { entered = resolve; });
    const blocker = new Promise<void>((resolve) => { release = resolve; });
    const first = repository.withSkuLock('0000098', async () => { entered(); await blocker; return 'done'; });
    await enteredPromise;
    await expect(repository.withSkuLock('0000098', async () => 'duplicate')).resolves.toEqual({ acquired: false });
    release();
    await expect(first).resolves.toEqual({ acquired: true, value: 'done' });
  });

  it('keeps database connections available when many SKU locks query the same pool', async () => {
    const pool = (repository as unknown as { pool: Pool }).pool;
    const previousTimeout = pool.options.connectionTimeoutMillis;
    pool.options.connectionTimeoutMillis = 1000;
    try {
      const results = await Promise.all(Array.from({ length: 8 }, (_, index) => {
        const sku = String(999000 + index).padStart(7, '0');
        return repository.withSkuLock(sku, async () => {
          await new Promise((resolve) => setTimeout(resolve, 80));
          return repository.find(sku);
        });
      }));
      expect(results).toEqual(Array.from({ length: 8 }, () => ({ acquired: true, value: undefined })));
      await expect(repository.withSkuLock('0999000', async () => 'released')).resolves.toEqual({ acquired: true, value: 'released' });
    } finally {
      pool.options.connectionTimeoutMillis = previousTimeout;
    }
  });

  it('creates a new immutable compatible run after the previous run succeeds without replaying old delivery ids', async () => {
    const firstAt = new Date(Date.now() - 120_000).toISOString();
    const first = await repository.enqueueDelivery({ ...autoInput('0000091', 'compatible-run-1', firstAt), operationMode: 'COMPATIBLE_UPSERT' });
    expect(first).toMatchObject({ runNo: 1, operationMode: 'COMPATIBLE_UPSERT', mediaTargetVariantIds: [] });
    await repository.transition('0000091', 'SUCCEEDED', { eventType: 'RUN_1_SUCCEEDED', nextAttemptAt: null });
    await isolatedPool.query("INSERT INTO wb_listing_drafts(sku,status,draft_version) VALUES('0000091','SUCCEEDED',4)");

    const secondAt = new Date(Date.now() - 60_000).toISOString();
    const second = await repository.enqueueDelivery({
      ...autoInput('0000091', 'compatible-run-2', secondAt), operationMode: 'COMPATIBLE_UPSERT',
      variantId: '11111111-1111-4111-8111-111111111111'
    });
    expect(second).toMatchObject({ runNo: 2, operationMode: 'COMPATIBLE_UPSERT', baseRevision: 4, targetRevision: 5 });
    const summarized = await repository.transition('0000091', 'CHECKING', {
      variantSummary: { created: 1, updated: 2, preserved: 1 },
      warnings: [{ code: 'UNMANAGED_EXISTING_VARIANT_PRESERVED', message: '保留旧变体' }]
    });
    expect(summarized).toMatchObject({
      variantSummary: { created: 1, updated: 2, preserved: 1 },
      warnings: [{ code: 'UNMANAGED_EXISTING_VARIANT_PRESERVED', message: '保留旧变体' }]
    });
    expect(second?.runId).not.toBe(first?.runId);
    expect(second?.mediaTargetVariantIds).toEqual(['11111111-1111-4111-8111-111111111111']);
    const duplicate = await repository.enqueueDelivery({
      ...autoInput('0000091', 'compatible-run-1', firstAt), operationMode: 'COMPATIBLE_UPSERT'
    });
    expect(duplicate?.runId).toBe(second?.runId);
    const runs = await repository.listRuns('0000091');
    expect(runs.map((run) => run.runNo)).toEqual([2, 1]);
  });

  it('keeps the first preset binding when later media arrives under another default and survives source deletion', async () => {
    const deliveredAt = new Date(Date.now() - 120_000).toISOString();
    const firstPresetId = randomUUID();
    const secondPresetId = randomUUID();
    await isolatedPool.query('INSERT INTO wb_listing_presets(id) VALUES($1),($2)', [firstPresetId, secondPresetId]);
    await repository.enqueueDelivery({
      ...autoInput('0000092', 'binding-first', deliveredAt),
      preset: { id: firstPresetId, name: '自动预设', rowVersion: 1, snapshot: { autoPublishEnabled: true } },
      binding: binding(firstPresetId, '自动预设', 1, deliveredAt)
    });
    await repository.enqueueDelivery({
      ...autoInput('0000092', 'binding-second', new Date(Date.now() - 60_000).toISOString()),
      preset: { id: secondPresetId, name: '新默认预设', rowVersion: 9, snapshot: { autoPublishEnabled: true } },
      binding: binding(secondPresetId, '新默认预设', 9, new Date(Date.now() - 60_000).toISOString())
    });
    let job = await repository.get('0000092');
    expect(job).toMatchObject({ presetId: firstPresetId, presetName: '自动预设', presetRowVersion: 1, sourcePresetExists: true });
    expect(job.presetBinding).toMatchObject({ presetId: firstPresetId, presetName: '自动预设', presetRowVersion: 1 });

    await isolatedPool.query('DELETE FROM wb_listing_presets WHERE id=$1', [firstPresetId]);
    job = await repository.get('0000092');
    expect(job).toMatchObject({ presetId: firstPresetId, presetName: '自动预设', sourcePresetExists: false });
    expect(job.presetBinding).toMatchObject({ presetId: firstPresetId, presetName: '自动预设' });
  });

  it('persists failure emit/resolve actions and compares the immutable payload when acknowledging', async () => {
    const deliveredAt = new Date(Date.now() - 60_000).toISOString();
    await repository.enqueueDelivery(autoInput('0000097', 'delivery-notification', deliveredAt));
    await repository.transition('0000097', 'NEEDS_ATTENTION', {
      eventType: 'AUTOMATION_FAILED', errorCode: 'CONFIG_INVALID', errorMessage: '缺少必填字段', nextAttemptAt: null
    });
    let pending = await repository.listPendingNotificationActions();
    const emit = pending.find((item) => item.job.sku === '0000097')!;
    expect(emit).toMatchObject({
      action: 'EMIT_FAILURE',
      payload: { failure: { sku: '0000097', state: 'NEEDS_ATTENTION', errorCode: 'CONFIG_INVALID', errorMessage: '缺少必填字段' } }
    });
    expect(await repository.completeNotificationAction('0000097', 'EMIT_FAILURE', { stale: true })).toBe(false);
    expect(await repository.completeNotificationAction('0000097', 'EMIT_FAILURE', emit.payload)).toBe(true);
    expect((await repository.listPendingNotificationActions()).some((item) => item.job.sku === '0000097')).toBe(false);

    await repository.recheck('0000097');
    await repository.transition('0000097', 'QUEUED', { eventType: 'CREATE_ONLY_SUBMITTED', n8nTaskId: '0000097__r1', nextAttemptAt: null });
    pending = await repository.listPendingNotificationActions();
    expect(pending.find((item) => item.job.sku === '0000097')).toMatchObject({
      action: 'RESOLVE_FAILURE',
      payload: {
        failure: { errorCode: 'CONFIG_INVALID', errorMessage: '缺少必填字段' },
        resolution: { sku: '0000097', state: 'QUEUED' }
      }
    });
  });

  it('does not lose an unacknowledged failure when submit/cancel supersedes it and ignores retryable FAILED', async () => {
    const deliveredAt = new Date(Date.now() - 60_000).toISOString();
    await repository.enqueueDelivery(autoInput('0000096', 'delivery-race', deliveredAt));
    await repository.transition('0000096', 'NEEDS_ATTENTION', {
      eventType: 'AUTOMATION_FAILED', errorCode: 'MEDIA_INVALID', errorMessage: '媒体无效', nextAttemptAt: null
    });
    await repository.recheck('0000096');
    await repository.transition('0000096', 'FAILED', {
      eventType: 'LISTING_STATUS_SYNCED', errorCode: 'WB_TASK_FAILED', errorMessage: 'WB 任务失败', nextAttemptAt: null
    });
    expect((await repository.listPendingNotificationActions()).find((item) => item.job.sku === '0000096')).toMatchObject({
      action: 'RESOLVE_FAILURE', payload: { failure: { errorCode: 'MEDIA_INVALID' }, resolution: { state: 'FAILED' } }
    });

    await repository.enqueueDelivery(autoInput('0000095', 'delivery-retry', deliveredAt));
    await repository.transition('0000095', 'FAILED', {
      eventType: 'RETRY_SCHEDULED', errorCode: 'VERIFY_FAILED', errorMessage: '临时网络错误',
      nextAttemptAt: new Date(Date.now() + 60_000).toISOString()
    });
    expect((await repository.listPendingNotificationActions()).some((item) => item.job.sku === '0000095')).toBe(false);

    await repository.enqueueDelivery(autoInput('0000094', 'delivery-cancel', deliveredAt));
    await repository.transition('0000094', 'NEEDS_ATTENTION', {
      eventType: 'AUTOMATION_FAILED', errorCode: 'CONFIG_INVALID', errorMessage: '等待人工', nextAttemptAt: null
    });
    await repository.cancel('0000094');
    expect((await repository.listPendingNotificationActions()).find((item) => item.job.sku === '0000094')).toMatchObject({
      action: 'RESOLVE_FAILURE', payload: { failure: { errorMessage: '等待人工' }, resolution: { state: 'CANCELLED' } }
    });
  });

  it('applies notification outbox migration without arming historical terminal jobs', async () => {
    await isolatedPool.query(`INSERT INTO wb_auto_publish_jobs(id,store_id,sku,run_id,run_no,state,preset_id,preset_name,preset_row_version,preset_snapshot)
      VALUES($3,'00000000-0000-4000-8000-000000000001','0000093',$2,1,'SUCCEEDED',$1,'历史预设',1,'{}'::jsonb)`, [
      presetId, randomUUID(), randomUUID()
    ]);
    await isolatedPool.query(`INSERT INTO wb_listing_drafts(
        sku,status,nm_ids,product_urls,latest_operation_source,latest_operation_at,latest_operation_ref)
      VALUES('0000093','SUCCEEDED','[1279000093,1279000094]'::jsonb,
        '["https://www.wildberries.ru/catalog/1279000093/detail.aspx","https://example.com/catalog/1279000094/detail.aspx","javascript:alert(1)"]'::jsonb,
        'AUTOMATION',NOW(),'automation:historical')`);
    const listed = await repository.list({ query: '0000093' });
    expect(listed.total).toBe(1);
    expect(listed.items[0]).toMatchObject({
      sku: '0000093',
      nmIds: [1279000093, 1279000094],
      productUrls: [
        'https://www.wildberries.ru/catalog/1279000093/detail.aspx',
        'https://www.wildberries.ru/catalog/1279000094/detail.aspx'
      ]
    });
    await expect(repository.get('0000093')).resolves.toMatchObject({
      nmIds: [1279000093, 1279000094],
      productUrls: [
        'https://www.wildberries.ru/catalog/1279000093/detail.aspx',
        'https://www.wildberries.ru/catalog/1279000094/detail.aspx'
      ]
    });
    expect((await repository.listPendingNotificationActions()).some((item) => item.job.sku === '0000093')).toBe(false);
    const migrations = await isolatedPool.query<{ id: string }>("SELECT id FROM wb_schema_migrations WHERE id IN ('011_wb_auto_publish_jobs','013_wb_auto_publish_notification_outbox') ORDER BY id");
    expect(migrations.rows.map((row) => row.id)).toEqual(['011_wb_auto_publish_jobs', '013_wb_auto_publish_notification_outbox']);
  });

  it('projects product links from the bound store publication without leaking the shared draft or another store', async () => {
    const deliveredAt = new Date(Date.now() - 60_000).toISOString();
    const secondStoreId = randomUUID();
    const defaultJob = await repository.enqueueDelivery(autoInput('0000078', 'publication-link-default', deliveredAt));
    const secondJob = await repository.enqueueDelivery({
      ...autoInput('0000078', 'publication-link-second', deliveredAt),
      storeId: secondStoreId
    });
    await isolatedPool.query(`INSERT INTO wb_listing_drafts(
      sku,status,nm_ids,product_urls,latest_operation_source,latest_operation_at,latest_operation_ref)
      VALUES('0000078','SUCCEEDED','[1200000078]'::jsonb,
        '["https://www.wildberries.ru/catalog/1200000078/detail.aspx"]'::jsonb,
        'AUTOMATION',NOW(),'automation:shared-draft')`);
    const defaultPublicationId = randomUUID();
    const secondPublicationId = randomUUID();
    await isolatedPool.query(`INSERT INTO wb_store_publications(id,store_id,nm_ids,product_urls,result_json) VALUES
      ($1,'00000000-0000-4000-8000-000000000001','[1398000078]'::jsonb,
        '["https://www.wildberries.ru/catalog/1398000078/detail.aspx"]'::jsonb,$4::jsonb),
      ($2,$3,'[1398001078,1398002078]'::jsonb,
        '["https://www.wildberries.ru/catalog/1398002078/detail.aspx","https://www.wildberries.ru/catalog/1398001078/detail.aspx"]'::jsonb,$5::jsonb)`, [
      defaultPublicationId, secondPublicationId, secondStoreId,
      JSON.stringify({ cards: [{ nmID: '1398000078', variantCode: '0000078-01' }] }),
      JSON.stringify({ cards: [
        { nmID: '1398002078', variantCode: '0000078-02' },
        { nmID: '1398001078', variantCode: '0000078-01' }
      ] })
    ]);
    await repository.linkPublication('0000078', '00000000-0000-4000-8000-000000000001', defaultJob!.runId, defaultPublicationId);
    await repository.linkPublication('0000078', secondStoreId, secondJob!.runId, secondPublicationId);

    await expect(repository.get('0000078')).resolves.toMatchObject({
      nmIds: [1398000078],
      productUrls: ['https://www.wildberries.ru/catalog/1398000078/detail.aspx'],
      productLinks: [{
        nmId: '1398000078',
        url: 'https://www.wildberries.ru/catalog/1398000078/detail.aspx',
        variantCode: '0000078-01'
      }]
    });
    await expect(repository.get('0000078', secondStoreId)).resolves.toMatchObject({
      nmIds: [1398001078, 1398002078],
      productUrls: [
        'https://www.wildberries.ru/catalog/1398001078/detail.aspx',
        'https://www.wildberries.ru/catalog/1398002078/detail.aspx'
      ],
      productLinks: [
        { nmId: '1398001078', variantCode: '0000078-01' },
        { nmId: '1398002078', variantCode: '0000078-02' }
      ]
    });
    expect((await repository.list({ storeId: secondStoreId, query: '0000078' })).items[0]).toMatchObject({
      nmIds: [1398001078, 1398002078],
      productLinks: [
        { nmId: '1398001078', variantCode: '0000078-01' },
        { nmId: '1398002078', variantCode: '0000078-02' }
      ]
    });
  });

  it('recomputes the shared draft lock after one store is cancelled or paused while another store remains active', async () => {
    const deliveredAt = new Date(Date.now() - 60_000).toISOString();
    const secondStoreId = randomUUID();
    await repository.enqueueDelivery(autoInput('0000080', 'cancel-default', deliveredAt));
    await repository.enqueueDelivery({ ...autoInput('0000080', 'cancel-second', deliveredAt), storeId: secondStoreId });
    const matchingPresetId = randomUUID();
    await isolatedPool.query('INSERT INTO wb_listing_presets(id) VALUES($1)', [matchingPresetId]);
    await repository.enqueueDelivery(autoInput('0000079', 'pause-default', deliveredAt));
    await repository.enqueueDelivery({
      ...autoInput('0000079', 'pause-second', deliveredAt),
      storeId: secondStoreId,
      preset: { id: matchingPresetId, name: '保留预设', rowVersion: 1, snapshot: { autoPublishEnabled: true } },
      binding: binding(matchingPresetId, '保留预设', 1, deliveredAt)
    });
    // CREATE_ONLY intentionally refuses to enqueue over an existing local
    // draft. Create both store jobs first, then attach the shared draft whose
    // lock behavior this test exercises.
    await isolatedPool.query(`INSERT INTO wb_listing_drafts(sku,status,auto_publish_locked,latest_operation_source,latest_operation_at,latest_operation_ref)
      VALUES('0000080','DRAFT',true,'AUTOMATION',NOW(),'automation:cancel-lock'),
        ('0000079','DRAFT',true,'AUTOMATION',NOW(),'automation:pause-lock')`);

    await repository.cancel('0000080');
    expect((await isolatedPool.query<{ auto_publish_locked: boolean }>(
      "SELECT auto_publish_locked FROM wb_listing_drafts WHERE sku='0000080'"
    )).rows[0]?.auto_publish_locked).toBe(true);
    await repository.cancel('0000080', secondStoreId);
    expect((await isolatedPool.query<{ auto_publish_locked: boolean }>(
      "SELECT auto_publish_locked FROM wb_listing_drafts WHERE sku='0000080'"
    )).rows[0]?.auto_publish_locked).toBe(false);

    await repository.pauseMismatchedPreset(matchingPresetId, 1);
    await expect(repository.get('0000079')).resolves.toMatchObject({ state: 'PAUSED' });
    await expect(repository.get('0000079', secondStoreId)).resolves.toMatchObject({ state: 'WAITING_STABLE' });
    expect((await isolatedPool.query<{ auto_publish_locked: boolean }>(
      "SELECT auto_publish_locked FROM wb_listing_drafts WHERE sku='0000079'"
    )).rows[0]?.auto_publish_locked).toBe(true);
    await repository.transition('0000079', 'SUCCEEDED', {}, secondStoreId);
    await repository.setListingLock('0000079', false);
    expect((await isolatedPool.query<{ auto_publish_locked: boolean }>(
      "SELECT auto_publish_locked FROM wb_listing_drafts WHERE sku='0000079'"
    )).rows[0]?.auto_publish_locked).toBe(false);
  });

  it('serializes ten stores through strict version freeze and never treats job terminal state as a fencing signal', async () => {
    const deliveredAt = new Date(Date.now() - 60_000).toISOString();
    const stores = Array.from({ length: 10 }, () => randomUUID());
    const expiredStores = [randomUUID(), randomUUID()];
    const terminalStores = [randomUUID(), randomUUID()];
    const jobs = await Promise.all(stores.map((storeId, index) => repository.enqueueDelivery({
      ...autoInput('0000077', `ten-store-${index}`, deliveredAt),
      storeId
    })));
    expect(jobs.every(Boolean)).toBe(true);

    const claims = await Promise.all(jobs.map((job) => repository.claimGenerationLease(job!)));
    const winnerIndex = claims.findIndex((claim) => claim.acquired);
    expect(claims.filter((claim) => claim.acquired)).toHaveLength(1);
    expect(winnerIndex).toBeGreaterThanOrEqual(0);
    const winner = jobs[winnerIndex]!;
    expect(claims.filter((claim) => !claim.acquired)).toEqual(expect.arrayContaining([
      expect.objectContaining({
        acquired: false,
        ownerJobId: winner.id,
        ownerRunId: winner.runId,
        ownerStoreId: winner.storeId
      })
    ]));

    // The immutable STORE_PUBLICATION is already frozen even though the
    // automatic job has not linked publication_id and has not reached QUEUED.
    // A following store must therefore be able to take the short SKU turn.
    const sourceVersionId = randomUUID();
    const publicationVersionId = randomUUID();
    const publicationId = randomUUID();
    const materializationHash = `sha256:${'a'.repeat(64)}`;
    await isolatedPool.query(`INSERT INTO wb_listing_versions(id,sku,status,generation_scope,materialization_hash)
      VALUES($1,'0000077','GENERATED','LISTING',NULL),
        ($2,'0000077','GENERATED','STORE_PUBLICATION',$3)`, [
      sourceVersionId, publicationVersionId, materializationHash
    ]);
    await isolatedPool.query(`INSERT INTO wb_store_publications(
      id,sku,generated_version_id,store_id,source,config_snapshot,request_key,materialization_hash)
      VALUES($1,'0000077',$2,$3,'AUTOMATION',$4::jsonb,$5,$6)`, [
      publicationId,
      publicationVersionId,
      winner.storeId,
      JSON.stringify({ automationRunId: winner.runId, sourceGeneratedVersionId: sourceVersionId }),
      `automation:${winner.runId}:${winner.storeId}`,
      materializationHash
    ]);
    const frozenSuccessor = jobs[(winnerIndex + 1) % jobs.length]!;
    const frozenClaim = await repository.claimGenerationLease(frozenSuccessor);
    expect(frozenClaim).toMatchObject({
      acquired: true,
      ownerJobId: frozenSuccessor.id,
      ownerRunId: frozenSuccessor.runId
    });
    await expect(repository.releaseGenerationLease(frozenSuccessor, frozenClaim.rowVersion)).resolves.toBe(true);

    const expiredJobs = await Promise.all(expiredStores.map((storeId, index) => repository.enqueueDelivery({
      ...autoInput('0000076', `expired-owner-${index}`, deliveredAt),
      storeId
    })));
    await expect(repository.claimGenerationLease(expiredJobs[0]!)).resolves.toMatchObject({ acquired: true });
    await isolatedPool.query("UPDATE wb_auto_generation_leases SET lease_until=NOW()-INTERVAL '1 second' WHERE sku='0000076'");
    await expect(repository.claimGenerationLease(expiredJobs[1]!)).resolves.toMatchObject({
      acquired: true,
      ownerJobId: expiredJobs[1]!.id
    });

    const terminalJobs = await Promise.all(terminalStores.map((storeId, index) => repository.enqueueDelivery({
      ...autoInput('0000075', `terminal-owner-${index}`, deliveredAt),
      storeId
    })));
    const terminalOwnerClaim = await repository.claimGenerationLease(terminalJobs[0]!);
    expect(terminalOwnerClaim).toMatchObject({ acquired: true });
    await repository.transition('0000075', 'FAILED', {
      eventType: 'TEST_OWNER_TERMINATED',
      errorCode: 'TEST_FAILURE',
      errorMessage: 'simulated owner crash',
      nextAttemptAt: null
    }, terminalJobs[0]!.storeId);
    await expect(repository.claimGenerationLease(terminalJobs[1]!)).resolves.toMatchObject({
      acquired: false,
      ownerJobId: terminalJobs[0]!.id,
      rowVersion: terminalOwnerClaim.rowVersion
    });
    await isolatedPool.query("UPDATE wb_auto_generation_leases SET lease_until=NOW()-INTERVAL '1 second' WHERE sku='0000075'");
    const terminalTakeover = await repository.claimGenerationLease(terminalJobs[1]!);
    expect(terminalTakeover).toMatchObject({ acquired: true, ownerJobId: terminalJobs[1]!.id });
    await repository.transition('0000075', 'NEEDS_ATTENTION', {
      eventType: 'TEST_CONFIG_CONFLICT',
      errorCode: 'CONFIG_INVALID',
      errorMessage: 'simulated preset conflict',
      nextAttemptAt: null
    }, terminalJobs[1]!.storeId);
    await expect(repository.claimGenerationLease(terminalJobs[0]!)).resolves.toMatchObject({
      acquired: false,
      ownerJobId: terminalJobs[1]!.id,
      rowVersion: terminalTakeover.rowVersion
    });
  });

  it('fences heartbeat and release by the claimed generation rowVersion', async () => {
    const deliveredAt = new Date(Date.now() - 60_000).toISOString();
    const job = await repository.enqueueDelivery(autoInput('0000074', 'fencing-owner', deliveredAt));
    const claim = await repository.claimGenerationLease(job!);
    expect(claim.acquired).toBe(true);
    const renewed = await repository.heartbeatGenerationLease(job!, {
      phase: 'GENERATING_SHARED_LISTING',
      expectedRowVersion: claim.rowVersion
    });
    expect(renewed.rowVersion).toBe(claim.rowVersion);
    await expect(repository.heartbeatGenerationLease(job!, {
      phase: 'GENERATING_SHARED_LISTING',
      expectedRowVersion: claim.rowVersion + 1
    })).rejects.toMatchObject({ code: 'AUTOMATION_GENERATION_LEASE_LOST', statusCode: 409 });
    await expect(repository.releaseGenerationLease(job!, claim.rowVersion + 1)).resolves.toBe(false);
    await expect(repository.releaseGenerationLease(job!, claim.rowVersion)).resolves.toBe(true);
  });

  it('clears an archived run publication identity before reusing the automatic job row', async () => {
    const deliveredAt = new Date(Date.now() - 60_000).toISOString();
    const first = await repository.enqueueDelivery(autoInput('0000073', 'first-run', deliveredAt));
    const publicationId = randomUUID();
    await isolatedPool.query('INSERT INTO wb_store_publications(id,store_id) VALUES($1,$2)', [publicationId, first!.storeId]);
    await repository.linkPublication(first!.sku, first!.storeId, first!.runId, publicationId);
    await repository.transition(first!.sku, 'SUCCEEDED', {}, first!.storeId);

    const next = await repository.enqueueDelivery(autoInput('0000073', 'next-run', new Date().toISOString()));
    expect(next).toMatchObject({ runNo: first!.runNo + 1 });
    expect(next?.publicationId).toBeUndefined();
    const persisted = await isolatedPool.query<{ publication_id: string | null }>(
      'SELECT publication_id FROM wb_auto_publish_jobs WHERE id=$1', [first!.id]
    );
    expect(persisted.rows[0]?.publication_id).toBeNull();

    const nextPublicationId = randomUUID();
    await isolatedPool.query('INSERT INTO wb_store_publications(id,store_id) VALUES($1,$2)', [nextPublicationId, next!.storeId]);
    await repository.linkPublication(next!.sku, next!.storeId, next!.runId, nextPublicationId);
    await repository.transition(next!.sku, 'SUCCEEDED', {}, next!.storeId);
    const compatibleInput = autoInput('0000073', 'manual-compatible-run', new Date().toISOString());
    const compatible = await repository.startCompatible({
      sku: '0000073',
      preset: compatibleInput.preset,
      binding: compatibleInput.binding,
      materialPresetDefinitionHash: compatibleInput.materialPresetDefinitionHash,
      variantIds: ['variant-1'],
      baseRevision: 0
    });
    expect(compatible.publicationId).toBeUndefined();
    expect((await isolatedPool.query<{ publication_id: string | null }>(
      'SELECT publication_id FROM wb_auto_publish_jobs WHERE id=$1', [compatible.id]
    )).rows[0]?.publication_id).toBeNull();
  });
});

function autoInput(sku: string, submissionId: string, deliveredAt: string) {
  return {
    sku, stageId: 'E005' as const, submissionId, deliveredAt,
    preset: { id: presetId, name: '自动预设', rowVersion: 1, snapshot: { autoPublishEnabled: true } },
    binding: binding(presetId, '自动预设', 1, deliveredAt),
    materialPresetDefinitionHash: `sha256:${'b'.repeat(64)}`,
    debounceUntil: new Date(Date.now() - 1_000).toISOString(), operationMode: 'CREATE_ONLY' as const
  };
}

function binding(id: string, name: string, rowVersion: number, deliveredAt: string) {
  return {
    schemaVersion: 2, presetId: id, presetName: name, presetRowVersion: rowVersion,
    boundAt: deliveredAt, activationStartedAt: deliveredAt, definitionHash: `sha256:${'a'.repeat(64)}`,
    presetSnapshot: { autoPublishEnabled: true }, dependencySnapshot: {}
  };
}
