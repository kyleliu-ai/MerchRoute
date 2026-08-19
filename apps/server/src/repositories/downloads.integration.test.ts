import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { downloadResourceRetryDelayMs, PurchaseRepository } from './purchases.js';

const connectionString = process.env.DATABASE_URL;
const schema = `downloads_test_${randomUUID().replaceAll('-', '')}`;
let admin: Pool;
let purchases: PurchaseRepository;
let isolatedConnectionString: string;

const purchaseInput = (productName: string, providerUrl: string) => ({
  productName,
  downloadWorkflowCode: 'E998',
  purchasePrice: '10',
  courierFee: '2',
  currency: 'CNY',
  grossWeightGrams: '500',
  lengthCm: '20',
  widthCm: '10',
  heightCm: '8',
  providerUrl
});

describe.runIf(Boolean(connectionString))('download queue and notification PostgreSQL integration', () => {
  it('使用 15、30、60、120、300 秒并在之后保持 5 分钟的资源退避', () => {
    expect([1, 2, 3, 4, 5, 6, 12].map(downloadResourceRetryDelayMs)).toEqual([
      15_000, 30_000, 60_000, 120_000, 300_000, 300_000, 300_000
    ]);
  });

  beforeAll(async () => {
    admin = new Pool({ connectionString, max: 1 });
    await admin.query(`CREATE SCHEMA ${schema}`);
    const isolatedUrl = new URL(connectionString!);
    isolatedUrl.searchParams.set('options', `-c search_path=${schema},public`);
    isolatedConnectionString = isolatedUrl.toString();
    purchases = new PurchaseRepository(isolatedConnectionString);
    await purchases.initialize({
      code: 'E998',
      displayName: '测试默认下载',
      webhookUrl: 'http://127.0.0.1:5678/webhook/test-default',
      parentOutputDir: 'C:\\downloads-test\\default',
      timeoutMs: 900_000,
      enabled: true,
      isDefault: true
    });
    await purchases.saveWorkflow({
      code: 'E999',
      displayName: '测试备用下载',
      webhookUrl: 'http://127.0.0.1:5678/webhook/test-secondary',
      parentOutputDir: 'C:\\downloads-test\\secondary',
      timeoutMs: 900_000,
      enabled: true,
      isDefault: false
    });
    await purchases.saveWorkflow({
      code: 'E007',
      displayName: '1688测试下载',
      webhookUrl: 'http://127.0.0.1:5678/webhook/test-1688',
      parentOutputDir: 'C:\\downloads-test\\1688',
      timeoutMs: 900_000,
      enabled: true,
      isDefault: false,
      recoveryMode: 'IDEMPOTENT_REPLAY'
    });
  });

  afterAll(async () => {
    await purchases?.close();
    await admin?.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin?.end();
  });

  it('严格按批次顺序领取任务，跳过无效项，并生成唯一失败通知和批次汇总', async () => {
    const first = await purchases.createPurchase(purchaseInput('顺序商品一', 'https://example.com/first'));
    const second = await purchases.createPurchase(purchaseInput('顺序商品二', 'https://example.com/second'));

    const batch = await purchases.enqueueDownloadBatch([
      { sku: first.sku, workflowCode: 'E998' },
      { sku: '9999999', workflowCode: 'E998' },
      { sku: second.sku, workflowCode: 'E999' }
    ]);
    expect(batch.queued.map((job) => job.sku)).toEqual([first.sku, second.sku]);
    expect(batch.skipped).toEqual([
      expect.objectContaining({ sku: '9999999', reason: 'DOWNLOAD_WORKFLOW_UNAVAILABLE' })
    ]);

    const firstClaim = await purchases.claimNextJob();
    expect(firstClaim).toMatchObject({ sku: first.sku, batchPosition: 1, status: 'RUNNING' });
    await purchases.completeJob(firstClaim!.id, {
      success: false,
      status: 'human_verification_timeout',
      errors: ['等待登录或验证超过 5 分钟'],
      n8nExecutionId: '9001'
    }, firstClaim!.leaseToken);
    // 重复提交同一终态不会创建第二条失败通知。
    await purchases.completeJob(firstClaim!.id, {
      success: false,
      status: 'human_verification_timeout',
      errors: ['等待登录或验证超过 5 分钟'],
      n8nExecutionId: '9001'
    }, firstClaim!.leaseToken);

    const secondClaim = await purchases.claimNextJob();
    expect(secondClaim).toMatchObject({ sku: second.sku, batchPosition: 3, status: 'RUNNING' });
    expect(Number(secondClaim!.queueSequence)).toBeGreaterThan(Number(firstClaim!.queueSequence));
    await purchases.completeJob(secondClaim!.id, {
      success: true,
      status: 'success',
      outputDir: 'C:\\downloads-test\\secondary\\result',
      n8nExecutionId: '9002'
    }, secondClaim!.leaseToken);

    const completed = await purchases.getDownloadBatch(batch.batchId);
    expect(completed).toMatchObject({
      status: 'COMPLETED',
      queuedCount: 2,
      skippedCount: 1,
      counts: { QUEUED: 0, RUNNING: 0, SUCCEEDED: 1, FAILED: 1 }
    });

    const notifications = await purchases.listNotifications({ pageSize: 20 });
    expect(notifications.items.filter((item) => item.eventType === 'DOWNLOAD_JOB_FAILED')).toHaveLength(1);
    expect(notifications.items.filter((item) => item.eventType === 'DOWNLOAD_BATCH_COMPLETED')).toHaveLength(1);
    expect(notifications.items.find((item) => item.eventType === 'DOWNLOAD_BATCH_COMPLETED')).toMatchObject({ severity: 'WARNING' });
    expect(await purchases.notificationSummary()).toEqual({ unreadCount: 2, unresolvedErrorCount: 1 });
    expect((await purchases.listNotifications({ sourceType: 'DOWNLOAD_JOB', pageSize: 20 })).total).toBe(1);
    expect((await purchases.listNotifications({ eventType: 'DOWNLOAD_BATCH_COMPLETED', pageSize: 20 })).total).toBe(1);
    expect((await purchases.listNotifications({ createdFrom: new Date(Date.now() - 60_000).toISOString(), pageSize: 20 })).total).toBe(2);
    expect((await purchases.listNotifications({ createdTo: '2000-01-01T00:00:00.000Z', pageSize: 20 })).total).toBe(0);
    await expect(purchases.listNotifications({ createdFrom: 'not-a-date' })).rejects.toMatchObject({ code: 'CONFIG_INVALID' });
  });

  it('通知重试使用最新采购版本和当前工作流配置，成功后自动解决原通知', async () => {
    const failed = (await purchases.listNotifications({ state: 'UNRESOLVED', pageSize: 20 })).items[0]!;
    await purchases.updatePurchase(failed.sku!, purchaseInput('重试后的最新产品名', 'https://example.com/latest'));
    await purchases.saveWorkflow({
      code: failed.workflowCode!,
      displayName: '更新后的默认下载',
      webhookUrl: 'http://127.0.0.1:5678/webhook/test-latest',
      parentOutputDir: 'C:\\downloads-test\\latest',
      timeoutMs: 900_000,
      enabled: true,
      isDefault: true
    });

    const retryJob = await purchases.retryNotification(failed.id);
    expect(retryJob).toMatchObject({
      sku: failed.sku,
      workflowCode: failed.workflowCode,
      notificationThreadId: failed.id,
      requestBody: {
        productName: '重试后的最新产品名',
        productUrl: 'https://example.com/latest',
        parentOutputDir: 'C:\\downloads-test\\latest'
      }
    });
    const claimed = await purchases.claimNextJob();
    expect(claimed?.id).toBe(retryJob.id);
    await purchases.completeJob(retryJob.id, {
      success: true,
      status: 'success',
      outputDir: 'C:\\downloads-test\\latest\\resolved',
      n8nExecutionId: '9003'
    }, claimed!.leaseToken);

    const refreshed = await purchases.updateNotification(failed.id, {});
    expect(refreshed.resolvedAt).toBeTruthy();
    expect((refreshed.details as { retryHistory?: unknown[] }).retryHistory).toHaveLength(3);
    expect((await purchases.listNotifications({ state: 'UNRESOLVED', pageSize: 20 })).total).toBe(0);
  });

  it('拒绝重复 SKU 和超过 200 条的批量请求', async () => {
    await expect(purchases.enqueueDownloadBatch([
      { sku: '0000001', workflowCode: 'E998' },
      { sku: '0000001', workflowCode: 'E999' }
    ])).rejects.toMatchObject({ code: 'CONFIG_INVALID' });
    await expect(purchases.enqueueDownloadBatch(Array.from({ length: 201 }, (_, index) => ({
      sku: String(index + 1).padStart(7, '0'),
      workflowCode: 'E998'
    })))).rejects.toMatchObject({ code: 'CONFIG_INVALID' });
  });

  it('保存并更新采购版本的默认下载工作流，并拒绝停用工作流', async () => {
    const created = await purchases.createPurchase({ ...purchaseInput('工作流偏好产品', 'https://example.com/workflow-preference'), downloadWorkflowCode: 'E999' });
    expect(created.procurementVersions[0]).toMatchObject({ versionNo: 1, downloadWorkflowCode: 'E999' });

    const updated = await purchases.updatePurchase(created.sku, { ...purchaseInput('工作流偏好产品', 'https://example.com/workflow-preference'), downloadWorkflowCode: 'E998' });
    expect(updated.procurementVersions.map((version) => version.downloadWorkflowCode)).toEqual(['E998', 'E999']);
    const listed = await purchases.listPurchases({ query: created.sku });
    expect(listed.items[0]?.procurement.downloadWorkflowCode).toBe('E998');

    await admin.query(`UPDATE ${schema}.procurement_versions SET download_workflow_code=NULL WHERE sku=$1 AND version_no=2`, [created.sku]);
    await purchases.syncWorkflows([
      { code: 'E998', displayName: '测试默认下载', webhookUrl: 'http://127.0.0.1:5678/webhook/test-default', parentOutputDir: 'C:\\downloads-test\\default', timeoutMs: 900_000, enabled: true, isDefault: true },
      { code: 'E999', displayName: '测试备用下载', webhookUrl: 'http://127.0.0.1:5678/webhook/test-secondary', parentOutputDir: 'C:\\downloads-test\\secondary', timeoutMs: 900_000, enabled: true, isDefault: false },
      { code: 'E007', displayName: '1688测试下载', webhookUrl: 'http://127.0.0.1:5678/webhook/test-1688', parentOutputDir: 'C:\\downloads-test\\1688', timeoutMs: 900_000, enabled: true, isDefault: false, recoveryMode: 'IDEMPOTENT_REPLAY' }
    ]);
    expect((await purchases.getPurchase(created.sku)).procurementVersions[0]?.downloadWorkflowCode).toBe('E998');

    await purchases.saveWorkflow({
      code: 'E997', displayName: '停用测试下载', webhookUrl: 'http://127.0.0.1:5678/webhook/disabled',
      parentOutputDir: 'C:\\downloads-test\\disabled', timeoutMs: 900_000, enabled: false, isDefault: false
    });
    await expect(purchases.createPurchase({ ...purchaseInput('停用工作流产品', 'https://example.com/disabled-workflow'), downloadWorkflowCode: 'E997' })).rejects.toMatchObject({
      code: 'DOWNLOAD_WORKFLOW_UNAVAILABLE', statusCode: 409
    });
  });

  it('拒绝测试临时目录，并在入队事务内修复被漂移的工作流投影', async () => {
    const unsafeRoot = path.join(os.tmpdir(), `n8n-review-projection-${randomUUID()}`, 'E006', 'candidate');
    await expect(purchases.saveWorkflow({
      code: 'E996', displayName: '不安全测试下载', webhookUrl: 'http://127.0.0.1:5678/webhook/unsafe',
      parentOutputDir: unsafeRoot, timeoutMs: 900_000, enabled: false, isDefault: false
    })).rejects.toMatchObject({ code: 'DOWNLOAD_ROOT_UNSAFE', statusCode: 409 });

    const product = await purchases.createPurchase(purchaseInput('投影原子修复商品', 'https://example.com/projection-heal'));
    const authoritative = (await purchases.listWorkflows(true)).map((workflow) => ({
      code: workflow.code,
      displayName: workflow.displayName,
      webhookUrl: workflow.webhookUrl,
      parentOutputDir: workflow.parentOutputDir,
      timeoutMs: workflow.timeoutMs,
      enabled: workflow.enabled,
      isDefault: workflow.isDefault,
      recoveryMode: workflow.recoveryMode
    }));
    const expectedE998 = authoritative.find((workflow) => workflow.code === 'E998')!;
    await admin.query(`UPDATE ${schema}.download_workflows SET parent_output_dir=$2 WHERE code=$1`, ['E998', unsafeRoot]);

    const queued = await purchases.enqueueDownload(product.sku, 'E998', authoritative);
    expect(queued.requestBody.parentOutputDir).toBe(expectedE998.parentOutputDir);
    expect(queued.workflowSnapshot.parentOutputDir).toBe(expectedE998.parentOutputDir);
    const restored = await admin.query<{ parent_output_dir: string }>(`SELECT parent_output_dir FROM ${schema}.download_workflows WHERE code='E998'`);
    expect(restored.rows[0]?.parent_output_dir).toBe(expectedE998.parentOutputDir);
    const projectionClaim = await purchases.claimNextJob();
    expect(projectionClaim?.id).toBe(queued.id);
    await purchases.completeJob(queued.id, { success: true, status: 'success', outputDir: `${expectedE998.parentOutputDir}\\projection-healed` }, projectionClaim!.leaseToken);
  });

  it('保存产品规格和净重，允许四项独立留空，并拒绝非正数', async () => {
    const legacy = await purchases.createPurchase(purchaseInput('未填写产品规格', 'https://example.com/product-measurements-empty'));
    expect(legacy.procurementVersions[0]).toMatchObject({
      netWeightGrams: null,
      productHeightCm: null,
      productDepthCm: null,
      productWidthCm: null
    });

    const created = await purchases.createPurchase({
      ...purchaseInput('水桶包产品规格', 'https://example.com/product-measurements'),
      netWeightGrams: '550',
      productHeightCm: '30',
      productDepthCm: '15',
      productWidthCm: '39'
    });
    expect(created.procurementVersions[0]).toMatchObject({
      versionNo: 1,
      netWeightGrams: '550.000',
      productHeightCm: '30.000',
      productDepthCm: '15.000',
      productWidthCm: '39.000'
    });
    expect((await purchases.listPurchases({ query: created.sku })).items[0]?.procurement).toMatchObject({
      netWeightGrams: '550.000',
      productHeightCm: '30.000',
      productDepthCm: '15.000',
      productWidthCm: '39.000'
    });

    const updated = await purchases.updatePurchase(created.sku, {
      ...purchaseInput('水桶包产品规格', 'https://example.com/product-measurements'),
      netWeightGrams: '545.5',
      productHeightCm: '31',
      productDepthCm: '16',
      productWidthCm: '40'
    });
    expect(updated.procurementVersions[0]).toMatchObject({
      versionNo: 2,
      netWeightGrams: '545.500',
      productHeightCm: '31.000',
      productDepthCm: '16.000',
      productWidthCm: '40.000'
    });

    const partial = await purchases.createPurchase({
      ...purchaseInput('产品尺寸不完整', 'https://example.com/product-measurements-partial'),
      productHeightCm: '30'
    });
    expect(partial.procurementVersions[0]).toMatchObject({
      productHeightCm: '30.000',
      productDepthCm: null,
      productWidthCm: null,
      netWeightGrams: null
    });
    await expect(purchases.createPurchase({
      ...purchaseInput('产品规格为零', 'https://example.com/product-measurements-zero'),
      netWeightGrams: '0'
    })).rejects.toMatchObject({ code: 'CONFIG_INVALID' });

    const migration = await admin.query<{ count: string }>(`SELECT COUNT(*)::text AS count FROM ${schema}.purchase_schema_migrations WHERE id='010_purchase_product_measurements'`);
    expect(migration.rows[0]?.count).toBe('1');
  });

  it('按产品首次新建时间过滤，并拒绝非法或倒置的时间区间', async () => {
    const before = await purchases.createPurchase(purchaseInput('日期筛选-区间外', 'https://example.com/date-outside'));
    const inside = await purchases.createPurchase(purchaseInput('日期筛选-区间内', 'https://example.com/date-inside'));
    await admin.query(`UPDATE ${schema}.products SET created_at=$2 WHERE sku=$1`, [before.sku, '2026-07-19T15:59:59.999Z']);
    await admin.query(`UPDATE ${schema}.products SET created_at=$2 WHERE sku=$1`, [inside.sku, '2026-07-20T00:00:00.000Z']);

    const result = await purchases.listPurchases({ query: '日期筛选-', createdFrom: '2026-07-20T00:00:00.000Z', createdTo: '2026-07-21T00:00:00.000Z' });
    expect(result.items.map((item) => item.sku)).toEqual([inside.sku]);
    await expect(purchases.listPurchases({ createdFrom: 'not-a-date' })).rejects.toMatchObject({ code: 'CONFIG_INVALID' });
    await expect(purchases.listPurchases({ createdFrom: '2026-07-21T00:00:00.000Z', createdTo: '2026-07-20T00:00:00.000Z' })).rejects.toMatchObject({ code: 'CONFIG_INVALID' });
  });

  it('拒绝保存其他 SKU 已经录入的产品 URL，并返回原 SKU', async () => {
    const original = await purchases.createPurchase(purchaseInput('URL 去重原产品', 'https://example.com/url-registry'));
    await expect(purchases.createPurchase(purchaseInput('URL 去重新产品', '  https://example.com/url-registry  '))).rejects.toMatchObject({
      code: 'PRODUCT_URL_ALREADY_EXISTS',
      message: '产品已经录入',
      statusCode: 409,
      details: { sku: original.sku }
    });

    const updated = await purchases.updatePurchase(original.sku, purchaseInput('URL 去重原产品已编辑', 'https://example.com/url-registry'));
    expect(updated.procurementVersions).toHaveLength(2);

    const other = await purchases.createPurchase(purchaseInput('URL 去重其他产品', 'https://example.com/url-registry-other'));
    await expect(purchases.updatePurchase(other.sku, purchaseInput('URL 去重其他产品', 'https://example.com/url-registry'))).rejects.toMatchObject({
      code: 'PRODUCT_URL_ALREADY_EXISTS',
      details: { sku: original.sku }
    });
  });

  it('E007 Profile 占用进入持久等待，批次保持运行且不会阻塞其他任务', async () => {
    const waitingPurchase = await purchases.createPurchase({
      ...purchaseInput('1688资源等待商品', 'https://detail.1688.com/offer/850722460359.html'),
      downloadWorkflowCode: 'E007'
    });
    const batch = await purchases.enqueueDownloadBatch([{ sku: waitingPurchase.sku, workflowCode: 'E007' }]);
    const claimed = await purchases.claimNextJob();
    expect(claimed?.id).toBe(batch.queued[0]?.id);
    const waiting = await purchases.deferResourceJob(claimed!.id, {
      success: false,
      status: 'profile_busy',
      httpStatus: 409,
      browserProfileBusy: true,
      errors: ['The dedicated 1688 browser profile is already in use.'],
      n8nExecutionId: 'profile-wait-1'
    }, claimed!.leaseToken);
    expect(waiting).toMatchObject({
      status: 'WAITING_RESOURCE', retryReason: 'profile_busy', resourceRetryCount: 1
    });
    expect(new Date(waiting.nextAttemptAt).getTime()).toBeGreaterThan(Date.now());
    expect(await purchases.getDownloadBatch(batch.batchId)).toMatchObject({
      status: 'RUNNING', counts: { QUEUED: 0, WAITING_RESOURCE: 1, RUNNING: 0, SUCCEEDED: 0, FAILED: 0 }
    });
    await expect(purchases.enqueueDownload(waitingPurchase.sku, 'E007')).rejects.toMatchObject({ code: 'DOWNLOAD_ALREADY_QUEUED' });
    expect((await purchases.listNotifications({ pageSize: 100 })).items.some((item) => item.sourceId === waiting.id)).toBe(false);

    const other = await purchases.createPurchase(purchaseInput('等待期间的其他任务', 'https://example.com/resource-wait-other'));
    const otherJob = await purchases.enqueueDownload(other.sku, 'E998');
    const otherClaim = await purchases.claimNextJob();
    expect(otherClaim?.id).toBe(otherJob.id);
    await purchases.completeJob(otherJob.id, { success: true, status: 'success', outputDir: 'C:\\downloads-test\\other' }, otherClaim!.leaseToken);

    await admin.query(`UPDATE ${schema}.download_jobs SET next_attempt_at=NOW()-INTERVAL '1 second' WHERE id=$1`, [waiting.id]);
    const waitingClaim = await purchases.claimNextJob();
    expect(waitingClaim?.id).toBe(waiting.id);
    await purchases.completeJob(waiting.id, { success: true, status: 'success', outputDir: 'C:\\downloads-test\\1688\\success' }, waitingClaim!.leaseToken);
    expect(await purchases.getDownloadBatch(batch.batchId)).toMatchObject({
      status: 'COMPLETED', counts: { QUEUED: 0, WAITING_RESOURCE: 0, RUNNING: 0, SUCCEEDED: 1, FAILED: 0 }
    });
    const migration = await admin.query<{ count: string }>(`SELECT COUNT(*)::text AS count FROM ${schema}.purchase_schema_migrations WHERE id='011_download_resource_waiting'`);
    expect(migration.rows[0]?.count).toBe('1');
  });

  it('服务重启保留资源等待，预算耗尽后才生成失败通知', async () => {
    const product = await purchases.createPurchase({
      ...purchaseInput('1688资源等待重启', 'https://detail.1688.com/offer/850722460360.html'),
      downloadWorkflowCode: 'E007'
    });
    const queued = await purchases.enqueueDownload(product.sku, 'E007');
    const initialClaim = await purchases.claimNextJob();
    expect(initialClaim?.id).toBe(queued.id);
    const waiting = await purchases.deferResourceJob(queued.id, {
      success: false, status: 'profile_busy', httpStatus: 409, browserProfileBusy: true
    }, initialClaim!.leaseToken);

    const restarted = new PurchaseRepository(isolatedConnectionString);
    await restarted.initialize({
      code: 'E998', displayName: '测试默认下载', webhookUrl: 'http://127.0.0.1:5678/webhook/test-default',
      parentOutputDir: 'C:\\downloads-test\\default', timeoutMs: 900_000, enabled: true, isDefault: true
    });
    expect(await restarted.getJob(waiting.id)).toMatchObject({ status: 'WAITING_RESOURCE', resourceRetryCount: 1 });
    await restarted.close();

    await admin.query(`UPDATE ${schema}.download_jobs SET next_attempt_at=NOW()-INTERVAL '1 second' WHERE id=$1`, [waiting.id]);
    const exhaustedClaim = await purchases.claimNextJob();
    expect(exhaustedClaim?.id).toBe(waiting.id);
    await admin.query(`UPDATE ${schema}.download_jobs SET resource_retry_count=11,
      resource_wait_started_at=NOW()-INTERVAL '31 minutes' WHERE id=$1`, [waiting.id]);
    const exhausted = await purchases.deferResourceJob(waiting.id, {
      success: false, status: 'profile_busy', httpStatus: 409, browserProfileBusy: true
    }, exhaustedClaim!.leaseToken);
    expect(exhausted).toMatchObject({ status: 'FAILED', resourceRetryCount: 12, retryReason: 'profile_busy' });
    expect(exhausted.errorMessage).toContain('30 分钟或 12 次重试');
    expect((await purchases.listNotifications({ pageSize: 100 })).items.some((item) => item.sourceId === waiting.id)).toBe(true);
  });

  it('为新任务持久化稳定 downloadJobId，并以全局租约和 CAS 拒绝并发领取及迟到结算', async () => {
    const first = await purchases.createPurchase(purchaseInput('租约保护商品一', 'https://example.com/lease-one'));
    const second = await purchases.createPurchase(purchaseInput('租约保护商品二', 'https://example.com/lease-two'));
    const firstJob = await purchases.enqueueDownload(first.sku, 'E998');
    const secondJob = await purchases.enqueueDownload(second.sku, 'E998');
    expect(firstJob.requestBody.downloadJobId).toBe(firstJob.id);
    expect(firstJob.workflowSnapshot.recoveryMode).toBe('MANUAL');

    const firstClaim = await purchases.claimNextJob('worker-a', 5_000);
    expect(firstClaim).toMatchObject({ id: firstJob.id, leaseOwner: 'worker-a', recoveryMode: 'MANUAL', attempt: 1 });
    expect(firstClaim?.leaseToken).toMatch(/^[0-9a-f-]{36}$/);
    await expect(purchases.claimNextJob('worker-b', 5_000)).resolves.toBeUndefined();
    await expect(purchases.renewJobLease(firstJob.id, 'worker-b', firstClaim!.leaseToken, 5_000)).resolves.toBe(false);
    await expect(purchases.renewJobLease(firstJob.id, 'worker-a', firstClaim!.leaseToken, 5_000)).resolves.toBe(true);
    await expect(purchases.completeJob(firstJob.id, { success: true, status: 'stale' }, randomUUID())).resolves.toBe(false);
    expect(await purchases.getJob(firstJob.id)).toMatchObject({ status: 'RUNNING' });
    await expect(purchases.completeJob(firstJob.id, { success: true, status: 'success', outputDir: 'C:\\downloads-test\\default\\lease-one' }, firstClaim!.leaseToken)).resolves.toBe(true);

    const secondClaim = await purchases.claimNextJob('worker-b', 5_000);
    expect(secondClaim?.id).toBe(secondJob.id);
    await purchases.completeJob(secondJob.id, { success: true, status: 'success', outputDir: 'C:\\downloads-test\\default\\lease-two' }, secondClaim!.leaseToken);
    const migration = await admin.query<{ count: string }>(`SELECT COUNT(*)::text AS count FROM ${schema}.purchase_schema_migrations WHERE id='013_download_job_leases'`);
    expect(migration.rows[0]?.count).toBe('1');
  });

  it('租约过期后只对幂等工作流续领原 job，旧 leaseToken 无法覆盖新执行', async () => {
    const product = await purchases.createPurchase({
      ...purchaseInput('幂等重启恢复商品', 'https://detail.1688.com/offer/850722460361.html'),
      downloadWorkflowCode: 'E007'
    });
    const queued = await purchases.enqueueDownload(product.sku, 'E007');
    const original = await purchases.claimNextJob('worker-before-restart', 5_000);
    expect(original).toMatchObject({ id: queued.id, attempt: 1, recoveryMode: 'IDEMPOTENT_REPLAY' });
    await admin.query(`UPDATE ${schema}.download_jobs SET lease_expires_at=NOW()-INTERVAL '1 second' WHERE id=$1`, [queued.id]);

    const recovered = await purchases.claimNextJob('worker-after-restart', 5_000);
    expect(recovered).toMatchObject({ id: queued.id, attempt: 2, retryReason: 'restart_recovery', leaseOwner: 'worker-after-restart' });
    expect(recovered!.leaseToken).not.toBe(original!.leaseToken);
    await expect(purchases.completeJob(queued.id, { success: true, status: 'stale-owner' }, original!.leaseToken)).resolves.toBe(false);
    expect(await purchases.getJob(queued.id)).toMatchObject({ status: 'RUNNING', retryReason: 'restart_recovery' });
    await expect(purchases.completeJob(queued.id, { success: true, status: 'success', outputDir: 'C:\\downloads-test\\1688\\recovered' }, recovered!.leaseToken)).resolves.toBe(true);
  });

  it('未启用幂等重放的旧 RUNNING 在租约过期后安全失败，绝不自动重发', async () => {
    const product = await purchases.createPurchase(purchaseInput('人工恢复商品', 'https://example.com/manual-recovery'));
    const queued = await purchases.enqueueDownload(product.sku, 'E998');
    const claimed = await purchases.claimNextJob('manual-worker', 5_000);
    expect(claimed?.id).toBe(queued.id);
    await admin.query(`UPDATE ${schema}.download_jobs SET lease_expires_at=NOW()-INTERVAL '1 second' WHERE id=$1`, [queued.id]);

    await expect(purchases.claimNextJob('replacement-worker', 5_000)).resolves.toBeUndefined();
    expect(await purchases.getJob(queued.id)).toMatchObject({
      status: 'FAILED',
      retryReason: 'worker_interrupted_unconfirmed'
    });
  });

  it('租约恢复只信入队快照，后续配置切换不能升级或降级既有任务', async () => {
    const manualProduct = await purchases.createPurchase(purchaseInput('快照人工恢复商品', 'https://example.com/manual-snapshot'));
    const manualJob = await purchases.enqueueDownload(manualProduct.sku, 'E998');
    const manualClaim = await purchases.claimNextJob('manual-snapshot-worker', 5_000);
    expect(manualClaim).toMatchObject({ id: manualJob.id, recoveryMode: 'MANUAL', attempt: 1 });

    await purchases.saveWorkflow({
      code: 'E998', displayName: '测试默认下载', webhookUrl: 'http://127.0.0.1:5678/webhook/test-default',
      parentOutputDir: 'C:\\downloads-test\\default', timeoutMs: 900_000, enabled: true, isDefault: true,
      recoveryMode: 'IDEMPOTENT_REPLAY'
    });
    await admin.query(`UPDATE ${schema}.download_jobs SET lease_expires_at=NOW()-INTERVAL '1 second' WHERE id=$1`, [manualJob.id]);
    await expect(purchases.claimNextJob('manual-snapshot-replacement', 5_000)).resolves.toBeUndefined();
    expect(await purchases.getJob(manualJob.id)).toMatchObject({
      status: 'FAILED', attempt: 1, retryReason: 'worker_interrupted_unconfirmed'
    });

    const idempotentProduct = await purchases.createPurchase({
      ...purchaseInput('快照幂等恢复商品', 'https://detail.1688.com/offer/850722460362.html'),
      downloadWorkflowCode: 'E007'
    });
    const idempotentJob = await purchases.enqueueDownload(idempotentProduct.sku, 'E007');
    const idempotentClaim = await purchases.claimNextJob('idempotent-snapshot-worker', 5_000);
    expect(idempotentClaim).toMatchObject({ id: idempotentJob.id, recoveryMode: 'IDEMPOTENT_REPLAY', attempt: 1 });

    await purchases.saveWorkflow({
      code: 'E007', displayName: '1688测试下载', webhookUrl: 'http://127.0.0.1:5678/webhook/test-1688',
      parentOutputDir: 'C:\\downloads-test\\1688', timeoutMs: 900_000, enabled: true, isDefault: false,
      recoveryMode: 'MANUAL'
    });
    await admin.query(`UPDATE ${schema}.download_jobs SET lease_expires_at=NOW()-INTERVAL '1 second' WHERE id=$1`, [idempotentJob.id]);
    const recovered = await purchases.claimNextJob('idempotent-snapshot-replacement', 5_000);
    expect(recovered).toMatchObject({
      id: idempotentJob.id, recoveryMode: 'IDEMPOTENT_REPLAY', attempt: 2, retryReason: 'restart_recovery'
    });
    await purchases.completeJob(idempotentJob.id, {
      success: true, status: 'success', outputDir: 'C:\\downloads-test\\1688\\snapshot-recovered'
    }, recovered!.leaseToken);

    await purchases.saveWorkflow({
      code: 'E998', displayName: '测试默认下载', webhookUrl: 'http://127.0.0.1:5678/webhook/test-default',
      parentOutputDir: 'C:\\downloads-test\\default', timeoutMs: 900_000, enabled: true, isDefault: true,
      recoveryMode: 'MANUAL'
    });
    await purchases.saveWorkflow({
      code: 'E007', displayName: '1688测试下载', webhookUrl: 'http://127.0.0.1:5678/webhook/test-1688',
      parentOutputDir: 'C:\\downloads-test\\1688', timeoutMs: 900_000, enabled: true, isDefault: false,
      recoveryMode: 'IDEMPOTENT_REPLAY'
    });
  });

  it('migration 013 安全终止 legacy RUNNING 时同步生成失败通知并完成批次', async () => {
    const product = await purchases.createPurchase(purchaseInput('迁移中断批次商品', 'https://example.com/migration-interrupted-batch'));
    const batch = await purchases.enqueueDownloadBatch([{ sku: product.sku, workflowCode: 'E998' }]);
    const claimed = await purchases.claimNextJob('legacy-migration-worker', 5_000);
    expect(claimed?.id).toBe(batch.queued[0]?.id);

    await admin.query(`ALTER TABLE ${schema}.download_jobs DROP CONSTRAINT IF EXISTS download_jobs_running_lease_complete`);
    await admin.query(`DROP INDEX IF EXISTS ${schema}.download_jobs_one_global_running`);
    await admin.query(`DELETE FROM ${schema}.purchase_schema_migrations WHERE id='013_download_job_leases'`);
    await admin.query(`UPDATE ${schema}.download_jobs SET lease_owner=NULL, lease_token=NULL,
      heartbeat_at=NULL, lease_expires_at=NULL WHERE id=$1`, [claimed!.id]);

    const restarted = new PurchaseRepository(isolatedConnectionString);
    try {
      await restarted.initialize({
        code: 'E998', displayName: '测试默认下载', webhookUrl: 'http://127.0.0.1:5678/webhook/test-default',
        parentOutputDir: 'C:\\downloads-test\\default', timeoutMs: 900_000, enabled: true, isDefault: true,
        recoveryMode: 'MANUAL'
      });
      expect(await restarted.getJob(claimed!.id)).toMatchObject({
        status: 'FAILED', retryReason: 'worker_interrupted_unconfirmed'
      });
      expect(await restarted.getDownloadBatch(batch.batchId)).toMatchObject({ status: 'COMPLETED' });
      const notifications = await restarted.listNotifications({ pageSize: 100 });
      expect(notifications.items.filter((item) => item.eventType === 'DOWNLOAD_JOB_FAILED' && item.sourceId === claimed!.id)).toHaveLength(1);
      expect(notifications.items.filter((item) => item.eventType === 'DOWNLOAD_BATCH_COMPLETED' && item.sourceId === batch.batchId)).toHaveLength(1);
    } finally {
      await restarted.close();
    }
  });
});
