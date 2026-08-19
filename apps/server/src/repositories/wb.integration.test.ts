import { createHash, randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PurchaseRepository } from './purchases.js';
import { WbRepository, type WbMediaAsset } from './wb.js';
import { WbStoreRepository } from './wb-stores.js';

const connectionString = process.env.DATABASE_URL;
const schema = `wb_test_${randomUUID().replaceAll('-', '')}`;
let admin: Pool;
let purchases: PurchaseRepository;
let wb: WbRepository;
let wbStores: WbStoreRepository;
let isolatedDatabaseUrl: string;

describe.runIf(Boolean(connectionString))('WB repository PostgreSQL integration', () => {
  beforeAll(async () => {
    admin = new Pool({ connectionString, max: 1 });
    await admin.query(`CREATE SCHEMA ${schema}`);
    const isolatedUrl = new URL(connectionString!);
    isolatedUrl.searchParams.set('options', `-c search_path=${schema},public`);
    isolatedDatabaseUrl = isolatedUrl.toString();
    purchases = new PurchaseRepository(isolatedUrl.toString());
    await purchases.initialize({ code: 'E999', displayName: '测试下载', webhookUrl: 'http://127.0.0.1:5678/webhook/test', parentOutputDir: 'C:\\wb-test', enabled: true, isDefault: true });
    wb = new WbRepository(isolatedUrl.toString());
    const concurrent = new WbRepository(isolatedUrl.toString());
    await wb.initialize();
    await concurrent.initialize();
    await concurrent.close();
    await admin.query(`UPDATE ${schema}.wb_system_settings SET enabled=true,global_concurrency=1 WHERE settings_id='default'`);
    await admin.query(`UPDATE ${schema}.wb_stores SET enabled=true,credential_state='LEGACY_EXTERNAL',warehouse_id='legacy-test'
      WHERE store_alias='default'`);
    wbStores = new WbStoreRepository(isolatedUrl.toString());
    await wbStores.initialize();
  });

  afterAll(async () => {
    await Promise.all([wb?.close(), wbStores?.close(), purchases?.close()]);
    await admin?.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin?.end();
  });

  it('uses the same PostgreSQL root contract for Windows and case-sensitive macOS paths', async () => {
    const windowsExpected = `sha256:${createHash('sha256').update('c:/wb/publish', 'utf8').digest('hex')}`;
    const windowsBackslash = await wb.upsertRuntimeConfig({ importRoot: 'C:\\WB\\Publish\\' });
    expect(windowsBackslash).toMatchObject({
      root_source: 'merchroute-postgresql', root_sync_hash: windowsExpected, dispatch_concurrency: 1
    });
    const windowsForward = await wb.upsertRuntimeConfig({ importRoot: 'c:/wb/publish' });
    expect(windowsForward).toMatchObject({ root_source: 'merchroute-postgresql', root_sync_hash: windowsExpected });

    const macUpperExpected = `sha256:${createHash('sha256').update('/Volumes/WB', 'utf8').digest('hex')}`;
    const macLowerExpected = `sha256:${createHash('sha256').update('/Volumes/wb', 'utf8').digest('hex')}`;
    expect(macUpperExpected).not.toBe(macLowerExpected);
    const macUpper = await wb.upsertRuntimeConfig({ importRoot: '/Volumes/WB/' });
    expect(macUpper).toMatchObject({ root_source: 'merchroute-postgresql', root_sync_hash: macUpperExpected });
    const macLower = await wb.upsertRuntimeConfig({ importRoot: '/Volumes/wb/' });
    expect(macLower).toMatchObject({ root_source: 'merchroute-postgresql', root_sync_hash: macLowerExpected });

    await expect(wb.upsertRuntimeConfig({ dispatchConcurrency: 2 })).resolves.toMatchObject({ dispatch_concurrency: 2 });
    await expect(wb.upsertRuntimeConfig({ dispatch_concurrency: 1 })).resolves.toMatchObject({ dispatch_concurrency: 1 });
    await expect(wb.upsertRuntimeConfig({ dispatchConcurrency: 3 }))
      .rejects.toMatchObject({ code: 'CONFIG_INVALID', statusCode: 409 });
    await expect(admin.query(`UPDATE ${schema}.wb_runtime_config SET dispatch_concurrency=3 WHERE config_id='default'`))
      .rejects.toThrow();
  });

  it('reads back the exact updated store when two stores exist in the same transaction scope', async () => {
    const first = await wbStores.createStore({
      storeAlias: `first-${randomUUID().slice(0, 8)}`,
      displayName: '第一店铺', autoPublishEnabled: false, autoPublishMode: 'CREATE_ONLY',
      warehouseId: '', warehouseName: '', accountCurrency: 'CNY', maxDailyStyles: 100
    });
    const second = await wbStores.createStore({
      storeAlias: `second-${randomUUID().slice(0, 8)}`,
      displayName: '第二店铺', autoPublishEnabled: false, autoPublishMode: 'CREATE_ONLY',
      warehouseId: '', warehouseName: '', accountCurrency: 'CNY', maxDailyStyles: 100
    });
    const updated = await wbStores.updateStore(second.id, { displayName: '第二店铺已更新', rowVersion: second.rowVersion });
    expect(updated).toMatchObject({ id: second.id, displayName: '第二店铺已更新' });
    await expect(wbStores.getStore(first.id)).resolves.toMatchObject({ id: first.id, displayName: '第一店铺' });
    await expect(wbStores.getStore(second.id)).resolves.toMatchObject({ id: second.id, displayName: '第二店铺已更新' });
  });

  it('enforces one global WB dispatch slot across concurrent claim transactions while preserving lease reclaim', async () => {
    await admin.query(`UPDATE ${schema}.wb_system_settings SET global_concurrency=1 WHERE settings_id='default'`);
    const dueTaskId = `claim-due-${randomUUID()}`;
    const secondDueTaskId = `claim-due-second-${randomUUID()}`;
    const futureTaskId = `claim-future-${randomUUID()}`;
    const terminalTaskId = `claim-terminal-${randomUUID()}`;
    await wb.enqueueRuntimeJob({ task_id: dueTaskId, product_code: '9100078', priority: 1000, state: 'QUEUED', next_run_at: new Date(Date.now() - 1_000).toISOString(), result_json: {} });
    await wb.enqueueRuntimeJob({ task_id: secondDueTaskId, product_code: '9100079', priority: 999, state: 'QUEUED', next_run_at: new Date(Date.now() - 1_000).toISOString(), result_json: {} });
    await wb.enqueueRuntimeJob({ task_id: futureTaskId, product_code: '9100080', priority: 998, state: 'QUEUED', next_run_at: new Date(Date.now() + 3_600_000).toISOString(), result_json: {} });
    await wb.enqueueRuntimeJob({ task_id: terminalTaskId, product_code: '9100081', priority: 997, state: 'FAILED', next_run_at: new Date(Date.now() - 1_000).toISOString(), result_json: {} });
    const concurrent = new WbRepository(isolatedDatabaseUrl);
    await concurrent.initialize();
    try {
      const [left, right] = await Promise.all([
        wb.claimRuntimeJobs({ leaseOwner: 'worker-left', limit: 20, leaseSeconds: 600 }),
        concurrent.claimRuntimeJobs({ leaseOwner: 'worker-right', limit: 20, leaseSeconds: 600 })
      ]);
      expect(left.length + right.length).toBe(1);
      const claimed = [...left, ...right][0]!;
      expect(claimed).toMatchObject({ taskId: dueTaskId, rowVersion: 2 });
      // A second due task exists, but the first live lease consumes the only
      // global dispatch slot, including across another repository connection.
      await expect(wb.claimRuntimeJobs({ leaseOwner: 'worker-third', limit: 5, leaseSeconds: 600 })).resolves.toEqual([]);

      await admin.query(`UPDATE ${schema}.wb_publish_jobs SET lease_expires_at=NOW()-INTERVAL '1 second' WHERE task_id=$1`, [dueTaskId]);
      const reclaimed = await concurrent.claimRuntimeJobs({ leaseOwner: 'worker-reclaim', limit: 1, leaseSeconds: 600 });
      expect(reclaimed).toEqual([
        expect.objectContaining({ taskId: dueTaskId, lease_owner: 'worker-reclaim', rowVersion: 3 })
      ]);
      await wb.transitionRuntimeJob(dueTaskId, {
        rowVersion: Number(reclaimed[0]!.rowVersion),
        job: { ...reclaimed[0], state: 'SUCCEEDED', lease_owner: '', lease_expires_at: null, finished_at: new Date().toISOString() }
      });
      const afterRelease = await concurrent.claimRuntimeJobs({ leaseOwner: 'worker-after-release', limit: 5, leaseSeconds: 600 });
      expect(afterRelease).toEqual([
        expect.objectContaining({ taskId: secondDueTaskId, lease_owner: 'worker-after-release', rowVersion: 2 })
      ]);
      await concurrent.transitionRuntimeJob(secondDueTaskId, {
        rowVersion: Number(afterRelease[0]!.rowVersion),
        job: { ...afterRelease[0], state: 'SUCCEEDED', lease_owner: '', lease_expires_at: null, finished_at: new Date().toISOString() }
      });
      const audit = await admin.query(`SELECT event_type,details FROM ${schema}.wb_publish_events WHERE task_id=$1 ORDER BY created_at`, [dueTaskId]);
      expect(audit.rows.filter((row) => row.event_type === 'JOB_CLAIMED')).toHaveLength(2);
      expect(audit.rows.filter((row) => row.event_type === 'JOB_CLAIMED').at(-1)?.details).toMatchObject({
        leaseOwner: 'worker-reclaim', dispatchConcurrency: 1, activeLeasesBeforeClaim: 0
      });
    } finally {
      await concurrent.close();
    }
  });

  it('claims a ready store by its immutable credential and warehouse snapshot after rotation while skipping an unready store', async () => {
    await admin.query(`UPDATE ${schema}.wb_system_settings SET enabled=true,global_concurrency=2 WHERE settings_id='default'`);
    const ready = await wbStores.createStore({
      storeAlias: `ready-${randomUUID().slice(0, 8)}`, displayName: '就绪店铺',
      autoPublishEnabled: false, autoPublishMode: 'CREATE_ONLY', warehouseId: 'warehouse-old', warehouseName: '旧仓',
      accountCurrency: 'CNY', maxDailyStyles: 100
    });
    const oldCredentialId = randomUUID();
    await admin.query(`INSERT INTO ${schema}.wb_store_credential_versions(
      id,store_id,version_no,status,ciphertext,nonce,auth_tag,fingerprint,key_version,activated_at)
      VALUES($1,$2,1,'ACTIVE','cipher-old','nonce-old','tag-old','fingerprint-old',1,NOW())`, [oldCredentialId, ready.id]);
    await admin.query(`UPDATE ${schema}.wb_stores SET enabled=true,credential_state='ACTIVE',active_credential_version_id=$2,
      preflight_status='PASSED',seller_id=$3,permissions='["content","prices","marketplace"]'::jsonb,
      warehouse_id='warehouse-old',account_currency='CNY' WHERE id=$1`, [ready.id, oldCredentialId, `seller-${ready.id}`]);

    const readyTaskId = `snapshot-ready-${randomUUID()}`;
    const enqueued = await wb.enqueueRuntimeJob({
      taskId: readyTaskId, storeId: ready.id, storeAlias: ready.storeAlias,
      credentialVersionId: oldCredentialId, storeConfigVersion: ready.configVersion, warehouseId: 'warehouse-old',
      productCode: '9100090', revision: 1, state: 'QUEUED', next_run_at: new Date(Date.now() - 1_000).toISOString()
    });

    const newCredentialId = randomUUID();
    await admin.query(`UPDATE ${schema}.wb_store_credential_versions SET status='RETIRED',retired_at=NOW() WHERE id=$1`, [oldCredentialId]);
    await admin.query(`INSERT INTO ${schema}.wb_store_credential_versions(
      id,store_id,version_no,status,ciphertext,nonce,auth_tag,fingerprint,key_version,activated_at)
      VALUES($1,$2,2,'ACTIVE','cipher-new','nonce-new','tag-new','fingerprint-new',1,NOW())`, [newCredentialId, ready.id]);
    await admin.query(`UPDATE ${schema}.wb_stores SET active_credential_version_id=$2,config_version=config_version+1,
      warehouse_id='warehouse-new',warehouse_name='新仓' WHERE id=$1`, [ready.id, newCredentialId]);

    const unready = await wbStores.createStore({
      storeAlias: `unready-${randomUUID().slice(0, 8)}`, displayName: '未就绪店铺',
      autoPublishEnabled: false, autoPublishMode: 'CREATE_ONLY', warehouseId: '', warehouseName: '',
      accountCurrency: 'CNY', maxDailyStyles: 100
    });
    await admin.query(`UPDATE ${schema}.wb_stores SET enabled=true WHERE id=$1`, [unready.id]);
    const unreadyTaskId = `snapshot-unready-${randomUUID()}`;
    await admin.query(`INSERT INTO ${schema}.wb_publish_jobs(
      task_id,state,next_run_at,store_id,store_alias,store_config_version,warehouse_id)
      VALUES($1,'QUEUED',NOW()-INTERVAL '1 second',$2,$3,1,'')`, [unreadyTaskId, unready.id, unready.storeAlias]);

    const claimed = await wb.claimRuntimeJobs({ leaseOwner: 'snapshot-worker', limit: 2, leaseSeconds: 600 });
    expect(claimed).toEqual([expect.objectContaining({
      taskId: readyTaskId,
      credentialVersionId: oldCredentialId,
      warehouseId: 'warehouse-old',
      storeConfigVersion: ready.configVersion
    })]);
    expect(claimed.some((job) => job.taskId === unreadyTaskId)).toBe(false);
    await wb.transitionRuntimeJob(readyTaskId, {
      rowVersion: Number(claimed[0]!.rowVersion),
      job: { ...claimed[0], state: 'SUCCEEDED', lease_owner: '', lease_expires_at: null, finished_at: new Date().toISOString() }
    });
    expect(enqueued).toMatchObject({ credentialVersionId: oldCredentialId, warehouseId: 'warehouse-old' });
  });

  it('gates all WB runtime claims during a persisted outage and resumes existing RETRY_WAIT before new QUEUED work', async () => {
    const retryTaskId = `network-retry-${randomUUID()}`;
    const queuedTaskId = `network-queued-${randomUUID()}`;
    const retryJob = await wb.enqueueRuntimeJob({
      task_id: retryTaskId, product_code: '9100082', priority: 1, state: 'RETRY_WAIT',
      next_run_at: new Date(Date.now() - 1_000).toISOString(), result_json: {}
    });
    await wb.enqueueRuntimeJob({
      task_id: queuedTaskId, product_code: '9100083', priority: 10_000, state: 'QUEUED',
      next_run_at: new Date(Date.now() - 1_000).toISOString(), result_json: {}
    });
    const gateUntil = new Date(Date.now() + 15 * 60_000).toISOString();
    const gated = await wb.transitionRuntimeJob(retryTaskId, {
      rowVersion: Number(retryJob.rowVersion),
      job: {
        ...retryJob,
        result_json: {
          networkRecovery: {
            attempt: 9,
            nextAttemptAt: gateUntil,
            lastErrorCode: 'ENOTFOUND',
            lastErrorMessage: 'dns unavailable'
          }
        }
      }
    });
    await expect(wb.getRuntimeConfig()).resolves.toMatchObject({
      network_attempt: 9,
      network_next_attempt_at: gateUntil,
      network_last_error_code: 'ENOTFOUND',
      network_last_error_message: 'dns unavailable'
    });
    await expect(wb.claimRuntimeJobs({ leaseOwner: 'network-gated-worker', limit: 5, leaseSeconds: 600 })).resolves.toEqual([]);

    const cleared = await wb.transitionRuntimeJob(retryTaskId, {
      rowVersion: Number(gated.rowVersion),
      job: { ...gated, result_json: { networkRecovery: null } }
    });
    await expect(wb.getRuntimeConfig()).resolves.toMatchObject({
      network_attempt: 0,
      network_next_attempt_at: undefined,
      network_last_error_code: '',
      network_last_error_message: ''
    });
    const claimed = await wb.claimRuntimeJobs({ leaseOwner: 'network-recovered-worker', limit: 1, leaseSeconds: 600 });
    expect(claimed).toEqual([expect.objectContaining({ taskId: retryTaskId, state: 'RETRY_WAIT' })]);
    expect(claimed[0]?.taskId).not.toBe(queuedTaskId);
    await wb.transitionRuntimeJob(retryTaskId, {
      rowVersion: Number(claimed[0]!.rowVersion),
      job: { ...cleared, ...claimed[0], state: 'SUCCEEDED', lease_owner: '', lease_expires_at: null }
    });
  });

  it('writes DISCOVERED registry identity atomically with a row-versioned transition', async () => {
    const taskId = `transition-registry-${randomUUID()}`;
    const productCode = `92${String(Date.now()).slice(-5)}`;
    const initial = await wb.enqueueRuntimeJob({ task_id: taskId, product_code: productCode, state: 'CARD_RECONCILING', result_json: {} });
    const registryKey = `${productCode}|${productCode}-01|`;
    const transitioned = await wb.transitionRuntimeJob(taskId, {
      rowVersion: Number(initial.rowVersion),
      job: { ...initial, state: 'MEDIA_RECONCILING' },
      registryRows: [{
        registry_key: registryKey,
        product_code: productCode,
        variant_code: `${productCode}-01`,
        vendor_code: `${productCode}-01`,
        barcode: '2054000000001',
        nm_id: '1332000001',
        imt_id: '3403000001',
        chrt_id: '1975000001',
        subject_id: '50',
        status: 'DISCOVERED'
      }],
      eventType: 'CARD_IDENTITY_DISCOVERED'
    });
    expect(transitioned).toMatchObject({ state: 'MEDIA_RECONCILING', rowVersion: Number(initial.rowVersion) + 1 });
    await expect(wb.listRuntimeRegistry(productCode)).resolves.toEqual([
      expect.objectContaining({ registry_key: registryKey, status: 'DISCOVERED', chrt_id: '1975000001' })
    ]);
    await expect(wb.transitionRuntimeJob(taskId, {
      rowVersion: Number(initial.rowVersion),
      job: { ...initial, state: 'PRICE_RECONCILING' },
      registryRows: [{ registry_key: `${registryKey}stale`, product_code: productCode, vendor_code: `${productCode}-01` }]
    })).rejects.toMatchObject({ code: 'TASK_LOCKED', statusCode: 409 });
    expect((await wb.listRuntimeRegistry(productCode)).some((row) => row.registry_key === `${registryKey}stale`)).toBe(false);
  });

  it('recovers a compatible partial-effect task from its original card intent without creating a new revision', async () => {
    const productCode = `93${String(Date.now()).slice(-5)}`;
    const automationRunId = randomUUID();
    const originTaskId = `${productCode}__r1`;
    const failedTaskId = `${productCode}__r3`;
    const mediaSignature = `sha256:${'a'.repeat(64)}`;
    const variants = [0, 1].map((index) => ({
      vendorCode: `${productCode}-0${index + 1}`,
      variantCode: `${productCode}-0${index + 1}`,
      images: Array.from({ length: 7 }, (_, imageIndex) => `variants/${index}/${imageIndex + 1}.png`),
      video: `variants/${index}/main.mp4`,
      sizes: [{ stock: 1, barcode: '' }]
    }));
    const originCards = variants.map((variant, index) => ({
      vendorCode: variant.vendorCode,
      variantCode: variant.variantCode,
      nmID: String(1332400000 + index),
      imtID: '3403253306',
      subjectID: '50',
      sizes: [{ techSize: '', barcode: `20542239980${index + 1}`, chrtID: String(1975854000 + index), sizeID: String(2975854000 + index) }]
    }));
    await wb.enqueueRuntimeJob({
      task_id: originTaskId,
      product_code: productCode,
      revision: 1,
      payload_signature: 'sha256:origin',
      state: 'FAILED',
      partial_effects: true,
      result_json: {
        submissionMode: 'COMPATIBLE_UPSERT', automationRunId, mediaSignature,
        product: { productCode, revision: 1, category: { key: 'bags', subjectId: 50 }, variants },
        cardCreateIntent: { taskId: originTaskId, submissionMode: 'COMPATIBLE_UPSERT', vendorCodes: variants.map((item) => item.vendorCode) },
        cards: originCards
      }
    });
    const failed = await wb.enqueueRuntimeJob({
      task_id: failedTaskId,
      product_code: productCode,
      revision: 3,
      state: 'FAILED',
      partial_effects: true,
      last_error_code: 'ETIMEDOUT',
      result_json: {
        submissionMode: 'COMPATIBLE_UPSERT', automationRunId, mediaSignature, expectedSubjectId: 50,
        product: { productCode, revision: 3, category: { key: 'bags', subjectId: 50 }, variants },
        cards: originCards.map((card, index) => ({
          ...card,
          photosCount: 7,
          videoPresent: true,
          sizes: [{ techSize: '', barcode: `wrong-${index}`, chrtID: '' }]
        })),
        price: { verified: false, uploadIds: [{ id: 'old-price-task' }] },
        priceUploadIds: [{ id: 'old-price-task', kind: 'discount', phase: 'history', done: false }],
        priceQueue: [{ kind: 'discount', body: { data: [{ nmID: Number(originCards[0]!.nmID), discount: 45 }] } }],
        priceIntent: { kind: 'discount' }, priceIntentAt: '2026-08-12T04:00:00.000Z', priceVerifyStartedAt: '2026-08-12T04:01:00.000Z',
        stock: { verified: false }, barcodes: { '0:0': 'wrong-0', '1:0': 'wrong-1' }
      }
    });
    const matches = originCards.map((card) => ({
      vendorCode: card.vendorCode,
      location: 'ACTIVE' as const,
      nmId: Number(card.nmID),
      imtId: Number(card.imtID),
      subjectId: Number(card.subjectID)
    }));
    await expect(wb.recoverCompatibleRuntimeJob(failedTaskId, {
      automationRunId,
      matches: matches.map(({ subjectId: _subjectId, ...match }) => match)
    })).rejects.toMatchObject({ code: 'COMPATIBLE_RECOVERY_UNSAFE', statusCode: 409 });
    await expect(wb.recoverCompatibleRuntimeJob(failedTaskId, {
      automationRunId,
      matches: matches.map((match) => ({ ...match, subjectId: 105 }))
    })).rejects.toMatchObject({ code: 'COMPATIBLE_RECOVERY_UNSAFE', statusCode: 409 });
    const recovered = await wb.recoverCompatibleRuntimeJob(failedTaskId, { automationRunId, matches });
    expect(recovered).toMatchObject({
      taskId: failedTaskId,
      state: 'MEDIA_RECONCILING',
      resumedState: 'MEDIA_RECONCILING',
      originTaskId,
      rowVersion: Number(failed.rowVersion) + 1,
      errorCode: ''
    });
    expect(recovered.result).toMatchObject({
      isUpdate: true,
      existingCardBaseline: originCards.map((card) => ({ vendorCode: card.vendorCode, nmID: card.nmID })),
      barcodes: { '0:0': '205422399801', '1:0': '205422399802' },
      compatibleRecovery: { originTaskId, automationRunId, verifyMediaBeforeSkip: true, mediaSignatureMatched: true }
    });
    expect(recovered.result).toMatchObject({
      price: { verified: false, uploadIds: [] }, priceUploadIds: [], priceQueue: [],
      priceIntent: null, priceIntentAt: '', priceVerifyStartedAt: ''
    });
    expect((recovered.result as any).cards[0].sizes[0]).toMatchObject({ barcode: '205422399801', chrtID: '1975854000' });
    await expect(wb.listRuntimeRegistry(productCode)).resolves.toEqual([
      expect.objectContaining({ registry_key: `${productCode}|${productCode}-01|`, status: 'DISCOVERED', nm_id: originCards[0]!.nmID, chrt_id: '1975854000' }),
      expect.objectContaining({ registry_key: `${productCode}|${productCode}-02|`, status: 'DISCOVERED', nm_id: originCards[1]!.nmID, chrt_id: '1975854001' })
    ]);

    const unsafeTaskId = `${productCode}__r4`;
    await wb.enqueueRuntimeJob({
      task_id: unsafeTaskId,
      product_code: productCode,
      revision: 4,
      state: 'FAILED',
      partial_effects: true,
      result_json: {
        submissionMode: 'COMPATIBLE_UPSERT', automationRunId, mediaSignature, expectedSubjectId: 50,
        product: { productCode, revision: 4, category: { key: 'bags', subjectId: 50 }, variants },
        cards: originCards
      }
    });
    await expect(wb.recoverCompatibleRuntimeJob(unsafeTaskId, {
      automationRunId,
      matches: [{ ...matches[0]!, location: 'TRASH' }, matches[1]!]
    })).rejects.toMatchObject({ code: 'WB_CARD_ALREADY_EXISTS', statusCode: 409 });
    await expect(wb.getRuntimeJob(unsafeTaskId)).resolves.toMatchObject({ state: 'FAILED', rowVersion: 1 });
  });

  it('stores multiple size rows for the same WB vendorCode and nmID', async () => {
    const taskId = `registry-size-${randomUUID()}`;
    await wb.enqueueRuntimeJob({ task_id: taskId, product_code: '9000069', state: 'QUEUED', result_json: {} });
    await wb.upsertRuntimeRegistry(taskId, [
      { registry_key: `${taskId}|41`, product_code: '9000069', vendor_code: '9000069-01', nm_id: '1300000069', tech_size: '41', barcode: '2000000000041' },
      { registry_key: `${taskId}|42`, product_code: '9000069', vendor_code: '9000069-01', nm_id: '1300000069', tech_size: '42', barcode: '2000000000042' }
    ]);
    await expect(wb.listRuntimeRegistry('9000069')).resolves.toEqual([
      expect.objectContaining({ registry_key: `${taskId}|41`, vendor_code: '9000069-01', nm_id: '1300000069', tech_size: '41' }),
      expect.objectContaining({ registry_key: `${taskId}|42`, vendor_code: '9000069-01', nm_id: '1300000069', tech_size: '42' })
    ]);
  });

  it('filters manual listings by the half-open updated date range and combined search', async () => {
    const first = await purchases.createPurchase({ productName: '日期筛选起点', purchasePrice: '10', providerUrl: 'https://example.com/date-start' });
    const middle = await purchases.createPurchase({ productName: '日期筛选中间', purchasePrice: '11', providerUrl: 'https://example.com/date-middle' });
    const end = await purchases.createPurchase({ productName: '日期筛选终点', purchasePrice: '12', providerUrl: 'https://example.com/date-end' });
    const created = await Promise.all([wb.createListing(first.sku), wb.createListing(middle.sku), wb.createListing(end.sku)]);
    expect(created.every((listing) => listing.latestOperationSource === 'MANUAL')).toBe(true);
    await admin.query(`UPDATE ${schema}.wb_listing_drafts SET updated_at=CASE sku
      WHEN $1 THEN '2026-07-21T16:00:00.000Z'::timestamptz
      WHEN $2 THEN '2026-07-22T08:00:00.000Z'::timestamptz
      WHEN $3 THEN '2026-07-22T16:00:00.000Z'::timestamptz END
      WHERE sku IN ($1,$2,$3)`, [first.sku, middle.sku, end.sku]);

    const range = await wb.listListings({ updatedFrom: '2026-07-21T16:00:00.000Z', updatedTo: '2026-07-22T16:00:00.000Z' });
    expect(range.total).toBe(2);
    expect(range.items.map((item) => item.sku)).toEqual([middle.sku, first.sku]);

    const combined = await wb.listListings({ query: '中间', updatedFrom: '2026-07-21T16:00:00.000Z', updatedTo: '2026-07-22T16:00:00.000Z' });
    expect(combined.total).toBe(1);
    expect(combined.items[0]?.sku).toBe(middle.sku);

    await admin.query(`UPDATE ${schema}.wb_listing_drafts SET
      latest_operation_source='AUTOMATION',latest_operation_at=updated_at,latest_operation_ref='automation:test-run'
      WHERE sku=$1`, [middle.sku]);
    const manual = await wb.listListings({ source: 'MANUAL', updatedFrom: '2026-07-21T16:00:00.000Z', updatedTo: '2026-07-22T16:00:00.000Z' });
    expect(manual.items.map((item) => item.sku)).toEqual([first.sku]);
    const automatic = await wb.listListings({ source: 'AUTOMATION', query: '中间' });
    expect(automatic).toMatchObject({ total: 1, items: [{ sku: middle.sku, latestOperationSource: 'AUTOMATION', latestOperationRef: 'automation:test-run' }] });

    const middleListing = await wb.getListing(middle.sku);
    const manuallySaved = await wb.updateListing(middle.sku, { draftVersion: middleListing.draftVersion, brand: '人工接管' });
    expect(manuallySaved).toMatchObject({ latestOperationSource: 'MANUAL', latestOperationRef: `manual:save:${middleListing.draftVersion + 1}` });
    expect((await wb.listListings({ source: 'AUTOMATION', query: '中间' })).total).toBe(0);
    expect((await wb.listListings({ source: 'MANUAL', query: '中间' })).total).toBe(1);
  });

  it('versions a dynamic category and keeps shared media as one asset', async () => {
    const purchase = await purchases.createPurchase({ productName: '多变体测试', purchasePrice: '10', providerUrl: 'https://example.com/product' });
    const liveSchema = [{ name: 'B', charcID: 204557 }, { charcID: 14177449, name: 'A' }];
    const formConfig = { fields: [
      { fieldId: 'gender', characteristicId: 204557, labelRu: 'Пол', scope: 'shared', control: 'select', required: true, order: 1 },
      { fieldId: 'color', characteristicId: 14177449, labelRu: 'Цвет', scope: 'variant', control: 'multi-select', required: true, order: 2 }
    ], media: { minImages: 1, maxImages: 7, videoAllowed: true, defaultVideoUploadMode: 'ORIGINAL' }, compliance: {} };
    await wb.createCategory('dynamic_shoes', { nameRu: 'Кроссовки', subjectId: 105, liveSchema, formConfig });
    const published = await wb.publishCategory('dynamic_shoes', 'qa@example.com');
    const version = published.versions.find((item: any) => item.status === 'PUBLISHED');
    const canonicalLiveSchema = '[{"charcID":204557,"name":"B"},{"charcID":14177449,"name":"A"}]';
    expect(version.schemaHash).toBe(`sha256:${createHash('sha256').update(canonicalLiveSchema).digest('hex')}`);
    expect(version.managedCharacteristicIds).toEqual([204557, 14177449]);
    expect(version.formConfig.media.defaultVideoUploadMode).toBe('ORIGINAL');
    await wb.saveCategoryDraft('dynamic_shoes', { nameRu: 'Новая категория', subjectId: 999, liveSchema, formConfig });
    await expect(wb.getPublishedCategory('dynamic_shoes')).resolves.toMatchObject({ nameRu: 'Кроссовки', subjectId: 105, id: version.id });

    let listing = await wb.createListing(purchase.sku);
    expect(listing.clubDiscount).toBeNull();
    const sharedImage: WbMediaAsset = {
      assetId: 'asset-image', relativePath: 'variants/01.png', kind: 'image', mimeType: 'image/png', sizeBytes: 100,
      sha256: 'a'.repeat(64), modifiedAt: new Date(0).toISOString(), validationStatus: 'VALID'
    };
    const sharedVideo: WbMediaAsset = {
      assetId: 'asset-video', relativePath: 'variants/main.mp4', kind: 'video', mimeType: 'video/mp4', sizeBytes: 200,
      sha256: 'b'.repeat(64), modifiedAt: new Date(0).toISOString(), validationStatus: 'VALID'
    };
    listing = await wb.replaceMediaAssets(purchase.sku, [sharedImage, sharedVideo]);
    const blackId = randomUUID();
    const whiteId = randomUUID();
    listing = await wb.updateListing(purchase.sku, {
      draftVersion: listing.draftVersion, categoryKey: 'dynamic_shoes', categoryVersionId: version.id,
      titleRu: 'Кроссовки', descriptionRu: 'A\n\nB', clubDiscount: 7, sharedCharacteristics: [{ id: 204557, value: ['Женский'] }],
      variants: [
        { variantId: blackId, variantCode: `${purchase.sku}-BLACK`, vendorCode: `${purchase.sku}-BLACK`, characteristics: [{ id: 14177449, value: ['Черный'] }], sizes: [] },
        { variantId: whiteId, variantCode: `${purchase.sku}-WHITE`, vendorCode: `${purchase.sku}-WHITE`, characteristics: [{ id: 14177449, value: ['Белый'] }], sizes: [] }
      ],
      variantMedia: [
        { variantId: blackId, imageAssetIds: ['asset-image'], videoAssetId: 'asset-video' },
        { variantId: whiteId, imageAssetIds: ['asset-image'], videoAssetId: 'asset-video' }
      ]
    });
    expect(listing.descriptionRu).toBe('A\\n\\nB');
    expect(listing.clubDiscount).toBe(7);
    const e003Initialization = {
      description: { type: 'E003', workflowCode: 'E003', executionId: 10, sha256: 'source-hash' },
      issues: [{ code: 'E003_DESCRIPTION_FALLBACK', message: '回退提示', field: 'descriptionRu', severity: 'WARNING', retryable: false }]
    };
    await admin.query(`UPDATE ${schema}.wb_listing_drafts SET data=data || $2::jsonb WHERE sku=$1`, [purchase.sku, JSON.stringify({ initialization: e003Initialization, initializationIssues: e003Initialization.issues })]);
    listing = await wb.getListing(purchase.sku);
    listing = await wb.updateListing(purchase.sku, { draftVersion: listing.draftVersion, brand: '无关字段修改', descriptionRu: listing.descriptionRu });
    expect(listing.initialization.description).toMatchObject({ type: 'E003', executionId: 10, sha256: 'source-hash' });
    expect(listing.initialization.issues).toEqual(e003Initialization.issues);
    const unresolvedRuntimeIssues = [
      ...e003Initialization.issues,
      { code: 'TITLE_TRANSLATION_FAILED', message: '翻译失败', field: 'titleRu', severity: 'ERROR', retryable: true },
      { code: 'PRICE_INITIALIZATION_FAILED', message: '定价失败', field: 'priceCny', severity: 'ERROR', retryable: true }
    ];
    await admin.query(`UPDATE ${schema}.wb_listing_drafts SET data=jsonb_set(jsonb_set(data,'{initialization,issues}',$2::jsonb),'{initializationIssues}',$2::jsonb) WHERE sku=$1`, [purchase.sku, JSON.stringify(unresolvedRuntimeIssues)]);
    listing = await wb.getListing(purchase.sku);
    listing = await wb.updateListing(purchase.sku, { draftVersion: listing.draftVersion, titleRu: 'Ручной заголовок', priceCny: 120 });
    expect(listing.initialization.issues).toEqual(e003Initialization.issues);
    expect(listing.initializationIssues).toEqual(e003Initialization.issues);
    await expect(wb.getListing(purchase.sku)).resolves.toMatchObject({ clubDiscount: 7 });
    expect(listing.mediaAssets).toHaveLength(2);
    expect(listing.variantMedia).toEqual(expect.arrayContaining([
      expect.objectContaining({ variantId: blackId, imageAssetIds: ['asset-image'], videoAssetId: 'asset-video' }),
      expect.objectContaining({ variantId: whiteId, imageAssetIds: ['asset-image'], videoAssetId: 'asset-video' })
    ]));

    const reservation = await wb.reserveGeneration(purchase.sku, listing.draftVersion);
    expect(reservation).toMatchObject({ revision: 1, category: { categoryKey: 'dynamic_shoes', schemaHash: version.schemaHash } });
    expect(reservation.data).toMatchObject({ clubDiscount: 7 });
    expect(await wb.getListing(purchase.sku)).toMatchObject({ latestOperationSource: 'MANUAL', latestOperationRef: `manual:generate:${reservation.versionId}` });
    listing = await wb.completeGeneration(purchase.sku, reservation.versionId, { schemaVersion: 2 }, { assets: [sharedImage, sharedVideo], variantMedia: listing.variantMedia });
    expect(listing.status).toBe('GENERATED');
    await expect(wb.getGeneratedPackageContext(purchase.sku, reservation.versionId)).resolves.toMatchObject({
      sku: purchase.sku,
      versionId: reservation.versionId,
      revision: 1,
      versionStatus: 'GENERATED',
      draftStatus: 'GENERATED',
      currentVersionId: reservation.versionId,
      productJson: { schemaVersion: 2 },
      mediaManifest: { assets: [sharedImage, sharedVideo] }
    });
    await expect(wb.getGeneratedPackageContext(purchase.sku, randomUUID()))
      .rejects.toMatchObject({ code: 'NOT_FOUND', statusCode: 404 });
    await wb.setProjection('dynamic_shoes', {
      status: 'SYNCED', sourceVersionId: version.id, schemaHash: version.schemaHash,
      definitionHash: `sha256:${'b'.repeat(64)}`, syncedAt: new Date().toISOString()
    });
    const runtimeProjection = await wb.getRuntimeCategoryProjection('dynamic_shoes');
    expect(runtimeProjection).toMatchObject({
      status: 'READY',
      projectionStatus: 'SYNCED',
      projection_status: 'SYNCED',
      confirmedBy: 'qa@example.com',
      confirmed_by: 'qa@example.com'
    });
    expect(JSON.parse(String(runtimeProjection.live_schema_json))).toEqual(runtimeProjection.liveSchema);
    expect(JSON.parse(String(runtimeProjection.form_config_json))).toEqual(runtimeProjection.formConfig);
    expect(JSON.parse(String(runtimeProjection.managed_characteristic_ids_json))).toEqual(runtimeProjection.managedCharacteristicIds);
    expect(JSON.parse(String(runtimeProjection.compliance_json))).toEqual(runtimeProjection.compliance);
    const submit = await wb.beginSubmit(purchase.sku, listing.draftVersion);
    expect(await wb.getListing(purchase.sku)).toMatchObject({ latestOperationSource: 'MANUAL', latestOperationRef: `manual:submit:${submit.versionId}` });
    expect((await wb.getListing(purchase.sku)).status).toBe('SUBMITTING');
    await expect(wb.reserveGeneration(purchase.sku, listing.draftVersion)).rejects.toMatchObject({ code: 'TASK_LOCKED' });
    await expect(wb.updateListing(purchase.sku, { draftVersion: listing.draftVersion, brand: '' })).rejects.toMatchObject({ code: 'TASK_LOCKED' });
    const networkRecovery = {
      phase: 'SUBMIT_DISPATCH', resumeState: 'SUBMITTING', deliveryState: 'UNKNOWN' as const, attempt: 1,
      firstFailureAt: new Date().toISOString(), lastFailureAt: new Date().toISOString(),
      nextAttemptAt: new Date(Date.now() + 30_000).toISOString(), lastErrorCode: 'ETIMEDOUT',
      lastErrorMessage: 'WB-P001 response lost', checkpoint: `taskId:${submit.expectedTaskId}`
    };
    listing = await wb.recordSubmitFailure(purchase.sku, submit.versionId, 'WB-P001 response lost', {
      deliveryUnknown: true, expectedTaskId: submit.expectedTaskId, networkRecovery
    });
    expect(listing).toMatchObject({
      status: 'SUBMITTING', n8nTaskId: submit.expectedTaskId,
      networkRecovery: { attempt: 1, resumeState: 'SUBMITTING' }, networkNextAttemptAt: networkRecovery.nextAttemptAt
    });
    await expect(wb.listActiveTaskReferences()).resolves.not.toContainEqual(expect.objectContaining({ sku: purchase.sku }));
    await admin.query(`UPDATE ${schema}.wb_listing_drafts SET network_next_attempt_at=NOW()-INTERVAL '1 second' WHERE sku=$1`, [purchase.sku]);
    await expect(wb.listActiveTaskReferences()).resolves.toContainEqual({ sku: purchase.sku, taskId: submit.expectedTaskId, status: 'SUBMITTING' });
    listing = await wb.recordSubmitFailure(purchase.sku, submit.versionId, 'explicit rejection', { deliveryUnknown: false, expectedTaskId: submit.expectedTaskId });
    expect(listing.status).toBe('GENERATED');
    expect(listing.networkRecovery).toBeUndefined();
    expect(listing.networkNextAttemptAt).toBeUndefined();
    const accepted = await wb.beginSubmit(purchase.sku, listing.draftVersion);
    const automationContext = { runId: '11111111-2222-4333-8444-555555555555', runNo: 3, operationMode: 'COMPATIBLE_UPSERT' as const };
    listing = await wb.markQueued(purchase.sku, accepted.versionId, { taskId: accepted.expectedTaskId, raw: { accepted: true }, automationContext });
    await expect(wb.listActiveTaskReferences()).resolves.toContainEqual({ sku: purchase.sku, taskId: accepted.expectedTaskId, status: 'QUEUED' });
    listing = await wb.updateTaskStatus(purchase.sku, accepted.expectedTaskId, {
      state: 'CARD_SUBMITTING', variants: [{ vendorCode: `${purchase.sku}-BLACK`, nmID: 1266130451, link: 'https://www.wildberries.ru/catalog/1266130451/detail.aspx' }]
    });
    expect(listing).toMatchObject({ status: 'RUNNING', nmIds: [1266130451], productUrls: ['https://www.wildberries.ru/catalog/1266130451/detail.aspx'] });
    listing = await wb.updateTaskStatus(purchase.sku, accepted.expectedTaskId, {
      state: 'SUCCEEDED', variants: [{ vendorCode: `${purchase.sku}-BLACK`, nmID: 1266130451, link: 'https://www.wildberries.ru/catalog/1266130451/detail.aspx' }]
    });
    expect(listing.status).toBe('SUCCEEDED');
    let pendingTerminal = await wb.listPendingTerminalNotifications(10, purchase.sku);
    expect(pendingTerminal).toEqual([
      expect.objectContaining({
        sku: purchase.sku, versionId: accepted.versionId, expectedStatus: 'SUCCEEDED',
        listing: expect.objectContaining({ generatedVersionId: accepted.versionId, n8nTaskId: accepted.expectedTaskId, status: 'SUCCEEDED', automationContext })
      })
    ]);
    await admin.query(`UPDATE ${schema}.wb_listing_drafts SET generated_version_id=NULL WHERE sku=$1`, [purchase.sku]);
    expect(await wb.listPendingTerminalNotifications(10, purchase.sku)).toHaveLength(1);
    await admin.query(`UPDATE ${schema}.wb_listing_drafts SET generated_version_id=$2 WHERE sku=$1`, [purchase.sku, accepted.versionId]);
    expect(await wb.markTerminalNotificationDelivered(accepted.versionId, 'FAILED')).toBe(false);
    expect(await wb.markTerminalNotificationDelivered(accepted.versionId, 'SUCCEEDED')).toBe(true);
    await wb.updateTaskStatus(purchase.sku, accepted.expectedTaskId, { state: 'SUCCEEDED', variants: [] });
    expect(await wb.listPendingTerminalNotifications(10, purchase.sku)).toHaveLength(0);
    await wb.updateTaskStatus(purchase.sku, accepted.expectedTaskId, { state: 'FAILED', error: 'late failure correction', variants: [] });
    pendingTerminal = await wb.listPendingTerminalNotifications(10, purchase.sku);
    expect(pendingTerminal[0]).toMatchObject({ expectedStatus: 'FAILED', listing: { lastError: 'late failure correction' } });
    await wb.updateTaskStatus(purchase.sku, accepted.expectedTaskId, { state: 'SUCCEEDED', variants: [] });
    expect(await wb.markTerminalNotificationDelivered(accepted.versionId, 'FAILED')).toBe(false);
    expect((await wb.listPendingTerminalNotifications(10, purchase.sku))[0]).toMatchObject({ expectedStatus: 'SUCCEEDED' });
    await wb.markTerminalNotificationDelivered(accepted.versionId, 'SUCCEEDED');
    await expect(wb.listActiveTaskReferences()).resolves.not.toContainEqual(expect.objectContaining({ sku: purchase.sku }));
    listing = await wb.updateListing(purchase.sku, { draftVersion: listing.draftVersion, brand: '', clubDiscount: null });
    expect(listing.status).toBe('STALE');
    expect(listing.clubDiscount).toBeNull();
    expect(listing.n8nTaskId).toBeUndefined();
    await expect(wb.deleteCategory('dynamic_shoes')).rejects.toMatchObject({ code: 'TASK_LOCKED', statusCode: 409 });

    await wb.createCategory('unused_category', { nameRu: 'Неиспользуемая категория', subjectId: 999, liveSchema, formConfig });
    await expect(wb.assertCategoryDeletable('unused_category')).resolves.toMatchObject({ categoryKey: 'unused_category' });
    await expect(wb.deleteCategory('unused_category')).resolves.toMatchObject({ categoryKey: 'unused_category' });
    await expect(wb.getCategory('unused_category')).rejects.toMatchObject({ code: 'NOT_FOUND', statusCode: 404 });
  });

  it('recovers a current manual FAILED listing only with transport evidence, exact task/xmin identity, and no runtime lease', async () => {
    const purchase = await purchases.createPurchase({
      productName: '手动历史断网恢复测试',
      purchasePrice: '18',
      providerUrl: 'https://example.com/wb-historical-network-recovery'
    });
    await wb.createListing(purchase.sku);
    const category = await wb.getCategory('dynamic_shoes');
    const categoryVersionId = category.versions.find((item: any) => item.status === 'PUBLISHED')!.id;
    const versionId = randomUUID();
    const taskId = `${purchase.sku}__r1`;
    await admin.query(`INSERT INTO ${schema}.wb_listing_versions(
        id,sku,revision,status,category_version_id,product_json,media_manifest,n8n_task_id,result_json,error_message,completed_at)
      VALUES($1,$2,1,'FAILED',$3,'{}'::jsonb,'{}'::jsonb,$4,$5::jsonb,$6,NOW())`, [
      versionId, purchase.sku, categoryVersionId, taskId,
      JSON.stringify({ state: 'FAILED', errorCode: 'ETIMEDOUT', errorMessage: 'request timed out before response' }),
      'ETIMEDOUT request timed out before response'
    ]);
    await admin.query(`UPDATE ${schema}.wb_listing_drafts SET
        status='FAILED',generated_version_id=$2,n8n_task_id=$3,last_error=$4,updated_at=NOW()
      WHERE sku=$1`, [purchase.sku, versionId, taskId, 'ETIMEDOUT request timed out before response']);
    await wb.enqueueRuntimeJob({
      task_id: taskId, idempotency_key: `wb:${taskId}`, folder_name: taskId,
      work_relpath: `processing/${taskId}`, product_code: purchase.sku, revision: 1,
      payload_signature: 'sha256:manual-historical-network', state: 'FAILED', resume_state: 'CARD_SUBMITTING',
      result_json: {
        networkRecovery: {
          phase: 'CARD_WRITE', resumeState: 'CARD_SUBMITTING', deliveryState: 'UNKNOWN', attempt: 2,
          firstFailureAt: '2026-08-07T00:00:00.000Z', lastFailureAt: '2026-08-07T00:01:00.000Z',
          nextAttemptAt: '2026-08-07T00:06:00.000Z', lastErrorCode: 'ETIMEDOUT',
          lastErrorMessage: 'request timed out', lastCheckpoint: 'CARD_CREATE_READY'
        },
        cardCreateIntent: { taskId, vendorCodes: [`${purchase.sku}-01`] }, audit: []
      },
      last_error_code: 'ETIMEDOUT', last_error_message: 'request timed out'
    });

    const candidates = await wb.listHistoricalNetworkListingCandidates();
    const candidate = candidates.find((item) => item.identity.versionId === versionId)!;
    expect(candidate).toMatchObject({
      kind: 'MANUAL',
      identity: { versionId, sku: purchase.sku, revision: 1, taskId },
      rowVersion: expect.stringMatching(/^\d+$/),
      proposedRecovery: expect.objectContaining({
        phase: 'SUBMIT_READBACK', resumeState: 'SUBMITTING', deliveryState: 'UNKNOWN', attempt: 1,
        lastErrorCode: 'ETIMEDOUT', checkpoint: `taskId:${taskId}`
      }),
      evidence: {
        state: 'FAILED', draftState: 'FAILED', transport: true,
        errorCode: 'ETIMEDOUT', activeLease: false, currentDraft: true
      }
    });
    await expect(wb.recoverHistoricalNetworkListing(versionId, taskId, '0', candidate.proposedRecovery))
      .rejects.toMatchObject({ code: 'VERSION_CONFLICT' });
    await expect(wb.recoverHistoricalNetworkListing(versionId, taskId, candidate.rowVersion, {
      ...candidate.proposedRecovery,
      nextAttemptAt: new Date(Date.parse(candidate.proposedRecovery.nextAttemptAt) + 30_000).toISOString()
    })).rejects.toMatchObject({ code: 'VERSION_CONFLICT' });

    const runtimeCandidate = (await wb.listHistoricalRuntimeNetworkFailureCandidates())
      .find((item) => item.identity.taskId === taskId)!;
    expect(runtimeCandidate).toMatchObject({
      kind: 'RUNTIME',
      identity: {
        taskId, idempotencyKey: `wb:${taskId}`, productCode: purchase.sku, revision: 1,
        payloadSignature: 'sha256:manual-historical-network', workRelpath: `processing/${taskId}`
      },
      rowVersion: expect.any(Number),
      evidence: {
        state: 'FAILED', transport: true, activeLease: false, phase: 'CARD_WRITE',
        checkpoint: 'CARD_CREATE_READY', deliveryState: 'UNKNOWN', safeResumeState: 'CARD_SUBMITTING',
        safeReadback: true, recoverable: true
      }
    });
    await expect(wb.recoverHistoricalRuntimeNetworkFailure(taskId, {
      ...runtimeCandidate.identity, rowVersion: runtimeCandidate.rowVersion + 100
    })).rejects.toMatchObject({ code: 'VERSION_CONFLICT' });

    await admin.query(`UPDATE ${schema}.wb_publish_jobs SET lease_owner='historical-manual-worker',
      lease_expires_at=NOW()+INTERVAL '10 minutes' WHERE task_id=$1`, [taskId]);
    await expect(wb.recoverHistoricalRuntimeNetworkFailure(taskId, {
      ...runtimeCandidate.identity, rowVersion: runtimeCandidate.rowVersion
    })).rejects.toMatchObject({ code: 'TASK_LOCKED' });
    await expect(wb.recoverHistoricalNetworkListing(versionId, taskId, candidate.rowVersion, candidate.proposedRecovery))
      .rejects.toMatchObject({ code: 'TASK_LOCKED' });
    expect((await wb.listHistoricalNetworkListingCandidates()).some((item) => item.identity.versionId === versionId)).toBe(false);

    await admin.query(`UPDATE ${schema}.wb_publish_jobs SET lease_expires_at=NOW()-INTERVAL '1 second' WHERE task_id=$1`, [taskId]);
    const dueCandidate = (await wb.listHistoricalNetworkListingCandidates()).find((item) => item.identity.versionId === versionId)!;
    await expect(wb.recoverHistoricalNetworkListing(versionId, taskId, dueCandidate.rowVersion, dueCandidate.proposedRecovery))
      .rejects.toMatchObject({ code: 'RUNTIME_RECOVERY_REQUIRED' });
    const dueRuntimeCandidate = (await wb.listHistoricalRuntimeNetworkFailureCandidates())
      .find((item) => item.identity.taskId === taskId)!;
    const recoveredRuntime = await wb.recoverHistoricalRuntimeNetworkFailure(taskId, {
      ...dueRuntimeCandidate.identity,
      rowVersion: dueRuntimeCandidate.rowVersion
    });
    expect(recoveredRuntime).toMatchObject({
      rowVersion: dueRuntimeCandidate.rowVersion + 1,
      evidence: { safeResumeState: 'CARD_SUBMITTING', safeReadback: true, recoverable: true },
      job: {
        taskId, idempotency_key: `wb:${taskId}`, productCode: purchase.sku, revision: 1,
        work_relpath: `processing/${taskId}`, state: 'RETRY_WAIT', resume_state: 'CARD_SUBMITTING'
      }
    });
    expect(Date.parse(String(recoveredRuntime.job.next_run_at))).toBeGreaterThan(Date.now());
    await expect(wb.getRuntimeConfig()).resolves.toMatchObject({
      network_attempt: 2,
      network_next_attempt_at: recoveredRuntime.job.next_run_at,
      network_last_error_code: 'ETIMEDOUT'
    });

    const recovered = await wb.recoverHistoricalNetworkListing(
      versionId, taskId, dueCandidate.rowVersion, dueCandidate.proposedRecovery
    );
    expect(recovered).toMatchObject({
      rowVersion: expect.stringMatching(/^\d+$/),
      evidence: { state: 'FAILED', transport: true, activeLease: false, currentDraft: true },
      listing: {
        sku: purchase.sku, status: 'SUBMITTING', generatedVersionId: versionId, n8nTaskId: taskId,
        networkRecovery: { attempt: 1, resumeState: 'SUBMITTING' },
        networkNextAttemptAt: dueCandidate.proposedRecovery.nextAttemptAt
      }
    });
    expect(recovered.rowVersion).not.toBe(dueCandidate.rowVersion);
    expect(await wb.countListingVersions(purchase.sku)).toBe(1);
    expect((await wb.listHistoricalNetworkListingCandidates()).some((item) => item.identity.versionId === versionId)).toBe(false);
  });

  it('rejects a historical UNKNOWN barcode allocation because no readback-safe checkpoint exists', async () => {
    const taskId = 'runtime-unsafe-barcode';
    await wb.enqueueRuntimeJob({
      task_id: taskId, idempotency_key: `wb:${taskId}`, folder_name: taskId,
      work_relpath: `processing/${taskId}`, product_code: '0000999', revision: 2,
      payload_signature: 'sha256:unsafe-barcode', state: 'FAILED', resume_state: 'BARCODE_ALLOCATING',
      result_json: {
        networkRecovery: {
          phase: 'BARCODE_ALLOCATE', resumeState: 'BARCODE_ALLOCATING', deliveryState: 'UNKNOWN', attempt: 1,
          firstFailureAt: '2026-08-07T00:00:00.000Z', lastFailureAt: '2026-08-07T00:00:00.000Z',
          nextAttemptAt: '2026-08-07T00:00:30.000Z', lastErrorCode: 'HTTP_503',
          lastErrorMessage: 'HTTP 503 while allocating barcode', lastCheckpoint: 'BARCODE_ALLOCATING'
        }
      },
      last_error_code: 'HTTP_503', last_error_message: 'HTTP 503 while allocating barcode'
    });
    const candidate = (await wb.listHistoricalRuntimeNetworkFailureCandidates())
      .find((item) => item.identity.taskId === taskId)!;
    expect(candidate).toMatchObject({
      evidence: {
        errorCode: 'HTTP_503', httpStatus: 503, deliveryState: 'UNKNOWN',
        safeReadback: false, recoverable: false
      }
    });
    await expect(wb.recoverHistoricalRuntimeNetworkFailure(taskId, {
      ...candidate.identity,
      rowVersion: candidate.rowVersion
    })).rejects.toMatchObject({ code: 'RECOVERY_UNSAFE' });
    await expect(wb.getRuntimeJob(taskId)).resolves.toMatchObject({
      taskId, state: 'FAILED', rowVersion: candidate.rowVersion
    });
  });

  it('clears stale KIZ and TNVED characteristics when a draft TNVED is empty', async () => {
    const purchase = await purchases.createPurchase({ productName: 'TNVED 清理测试', purchasePrice: '10', providerUrl: 'https://example.com/tnved-clear' });
    const liveSchema = [
      { charcID: 15004139, name: 'Код ТН ВЭД', required: false },
      { charcID: 204557, name: 'Пол', required: true }
    ];
    const formConfig = {
      fields: [
        { fieldId: 'tnved', characteristicId: 15004139, labelRu: 'Код ТН ВЭД', scope: 'shared', control: 'select', required: true, order: 1 },
        { fieldId: 'gender', characteristicId: 204557, labelRu: 'Пол', scope: 'shared', control: 'select', required: true, order: 2 }
      ],
      sizeMode: 'sized', compliance: { tnvedCharacteristicId: 15004139, tnvedRequired: true }
    };
    await wb.createCategory('tnved_clear_category', { nameRu: 'Тест TNVED', subjectId: 50003, liveSchema, formConfig });
    const category = await wb.publishCategory('tnved_clear_category', 'qa@example.com');
    const version = category.versions.find((item: any) => item.status === 'PUBLISHED');
    let listing = await wb.createListing(purchase.sku);
    const variantId = randomUUID();
    listing = await wb.updateListing(purchase.sku, {
      draftVersion: listing.draftVersion, categoryKey: 'tnved_clear_category', categoryVersionId: version.id,
      compliance: { tnved: '', kizMarked: true },
      sharedCharacteristics: [{ id: 204557, value: ['Женский'] }, { id: 15004139, value: ['6404199000'] }],
      variants: [{
        variantId, variantCode: `${purchase.sku}-01`, vendorCode: `${purchase.sku}-01`,
        characteristics: [{ id: 15004139, value: ['6404199000'] }], sizes: []
      }]
    });
    expect(listing.compliance).toEqual({ tnved: '', kizMarked: false });
    expect(listing.sharedCharacteristics).not.toContainEqual(expect.objectContaining({ id: 15004139 }));
    expect(listing.variants[0].characteristics).not.toContainEqual(expect.objectContaining({ id: 15004139 }));
  });

  it('projects the latest procurement measurements and marks a generated draft stale after measurement drift', async () => {
    const created = await purchases.createPurchase({
      productName: '采购规格权威来源测试',
      purchasePrice: '18',
      providerUrl: 'https://example.com/wb-purchase-measurements',
      productHeightCm: '28',
      productWidthCm: '36',
      netWeightGrams: '520'
    });
    const liveSchema = [
      { charcID: 90630, name: 'Высота предмета', charcType: 4, required: false },
      { charcID: 90652, name: 'Глубина предмета', charcType: 4, required: false },
      { charcID: 90673, name: 'Ширина предмета', charcType: 4, required: false },
      { charcID: 89008, name: 'Вес товара без упаковки (г)', charcType: 4, required: false }
    ];
    const formConfig = {
      fields: [
        { fieldId: 'height', characteristicId: 90630, labelRu: 'Высота предмета', scope: 'shared', control: 'number', required: false, order: 1 },
        { fieldId: 'depth', characteristicId: 90652, labelRu: 'Глубина предмета', scope: 'shared', control: 'number', required: false, order: 2 },
        { fieldId: 'width', characteristicId: 90673, labelRu: 'Ширина предмета', scope: 'shared', control: 'number', required: false, order: 3 },
        { fieldId: 'weight', characteristicId: 89008, labelRu: 'Вес товара без упаковки (г)', scope: 'shared', control: 'number', required: false, order: 4 }
      ],
      media: { minImages: 0, maxImages: 7, videoAllowed: false },
      sizeMode: 'sizeless',
      compliance: {}
    };
    await wb.createCategory('purchase_measurement_bags', { nameRu: 'Сумки', subjectId: 50, liveSchema, formConfig });
    const category = await wb.publishCategory('purchase_measurement_bags', 'qa@example.com');
    const version = category.versions.find((item: any) => item.status === 'PUBLISHED');

    let listing = await wb.createListing(created.sku);
    listing = await wb.updateListing(created.sku, {
      draftVersion: listing.draftVersion,
      categoryKey: 'purchase_measurement_bags',
      categoryVersionId: version.id,
      sharedCharacteristics: [{ id: 89008, value: 0 }]
    });
    expect(listing.sharedCharacteristics).toEqual([
      { id: 90630, value: 28 },
      { id: 90673, value: 36 },
      { id: 89008, value: 520 }
    ]);
    expect(listing.purchaseMeasurements).toMatchObject({
      procurementVersionId: created.procurementVersions[0]?.id,
      procurementVersionNo: 1,
      productHeightCm: 28,
      productDepthCm: null,
      productWidthCm: 36,
      netWeightGrams: 520
    });

    const reservation = await wb.reserveGeneration(created.sku, listing.draftVersion);
    expect(reservation.data.sharedCharacteristics).toEqual(listing.sharedCharacteristics);
    const snapshot = await admin.query<{ purchase_measurements: Record<string, unknown> }>(
      `SELECT purchase_measurements FROM ${schema}.wb_listing_versions WHERE id=$1`,
      [reservation.versionId]
    );
    expect(snapshot.rows[0]?.purchase_measurements).toMatchObject({ procurementVersionNo: 1, productHeightCm: 28 });
    listing = await wb.completeGeneration(created.sku, reservation.versionId, { schemaVersion: 2 }, {});
    await wb.setProjection('purchase_measurement_bags', {
      status: 'SYNCED',
      sourceVersionId: version.id,
      schemaHash: version.schemaHash,
      definitionHash: `sha256:${'c'.repeat(64)}`,
      syncedAt: new Date().toISOString()
    });

    await purchases.updatePurchase(created.sku, {
      productName: '采购规格权威来源测试',
      purchasePrice: '18',
      providerUrl: 'https://example.com/wb-purchase-measurements',
      productHeightCm: '29',
      productWidthCm: '36',
      netWeightGrams: '520'
    });
    await expect(wb.beginSubmit(created.sku, listing.draftVersion)).rejects.toMatchObject({
      code: 'VERSION_CONFLICT',
      message: '采购管理中的产品尺寸或净重已变化，请重新生成 product.json'
    });
    await expect(wb.getListing(created.sku)).resolves.toMatchObject({
      status: 'STALE',
      lastError: '采购管理中的产品尺寸或净重已变化，请重新生成 product.json'
    });
  });

  it('protects linked gross weight on save and generation while keeping historical drafts editable', async () => {
    const linkedPurchase = await purchases.createPurchase({
      productName: '毛重联动防护测试',
      purchasePrice: '20',
      providerUrl: 'https://example.com/wb-linked-gross-weight',
      grossWeightGrams: '650'
    });
    const liveSchema = [{ charcID: 204557, name: 'Пол' }];
    const formConfig = {
      fields: [
        { fieldId: 'gender', characteristicId: 204557, labelRu: 'Пол', scope: 'shared', control: 'select', required: false, order: 1 }
      ],
      media: { minImages: 0, maxImages: 7, videoAllowed: false },
      sizeMode: 'sizeless',
      compliance: {}
    };
    await wb.createCategory('gross_weight_guard', { nameRu: 'Защита веса', subjectId: 50004, liveSchema, formConfig });
    const category = await wb.publishCategory('gross_weight_guard', 'qa@example.com');
    const version = category.versions.find((item: any) => item.status === 'PUBLISHED');
    let linked = await wb.createListing(linkedPurchase.sku);
    const grossWeightResolution = {
      source: 'PROCUREMENT',
      effectiveGrossWeightGrams: 650,
      procurementGrossWeightGrams: 650,
      presetGrossWeightGrams: 750,
      procurementVersionId: linkedPurchase.procurementVersions[0]!.id,
      procurementVersionNo: 1,
      procurementCapturedAt: '2026-08-06T12:00:00.000Z'
    };
    await admin.query(`UPDATE ${schema}.wb_listing_drafts SET data=data || $2::jsonb WHERE sku=$1`, [
      linkedPurchase.sku,
      JSON.stringify({
        packaging: { grossWeightGrams: 650, lengthCm: 30, widthCm: 15, heightCm: 10 },
        initialization: { grossWeightResolution }
      })
    ]);
    linked = await wb.getListing(linkedPurchase.sku);

    await expect(wb.updateListing(linkedPurchase.sku, {
      draftVersion: linked.draftVersion,
      packaging: { grossWeightGrams: 700, lengthCm: 31, widthCm: 16, heightCm: 11 }
    })).rejects.toMatchObject({
      code: 'CONFIG_INVALID',
      message: '毛重由采购管理/上架预设联动管理，不能手动修改',
      details: { expectedGrossWeightGrams: 650, actualGrossWeightGrams: 700 }
    });

    await expect(wb.updateListing(linkedPurchase.sku, {
      draftVersion: linked.draftVersion,
      packaging: { grossWeightGrams: 650, weightKg: 99, lengthCm: 31, widthCm: 16, heightCm: 11 }
    })).rejects.toMatchObject({
      code: 'CONFIG_INVALID',
      message: '毛重由采购管理/上架预设联动管理，不能手动修改',
      details: { field: 'packaging.weightKg', expectedGrossWeightGrams: 650, actualWeightKg: 99 }
    });

    linked = await wb.updateListing(linkedPurchase.sku, {
      draftVersion: linked.draftVersion,
      categoryKey: 'gross_weight_guard',
      categoryVersionId: version.id,
      packaging: { lengthCm: 31, widthCm: 16, heightCm: 11 }
    });
    expect(linked.packaging).toEqual({ grossWeightGrams: 650, lengthCm: 31, widthCm: 16, heightCm: 11 });
    linked = await wb.updateListing(linkedPurchase.sku, {
      draftVersion: linked.draftVersion,
      packaging: { grossWeightGrams: 650, lengthCm: 32, widthCm: 17, heightCm: 12 }
    });
    expect(linked.packaging).toEqual({ grossWeightGrams: 650, lengthCm: 32, widthCm: 17, heightCm: 12 });

    await admin.query(`UPDATE ${schema}.wb_listing_drafts SET data=jsonb_set(data,'{packaging,weightKg}','99'::jsonb) WHERE sku=$1`, [linkedPurchase.sku]);
    await expect(wb.reserveGeneration(linkedPurchase.sku, linked.draftVersion)).rejects.toMatchObject({
      code: 'CONFIG_INVALID',
      message: '毛重由采购管理/上架预设联动管理；当前包装毛重与联动快照不一致，不能生成 product.json',
      details: { field: 'packaging.weightKg', expectedGrossWeightGrams: 650, actualWeightKg: 99 }
    });
    await admin.query(`UPDATE ${schema}.wb_listing_drafts SET data=data #- '{packaging,weightKg}' WHERE sku=$1`, [linkedPurchase.sku]);
    await admin.query(`UPDATE ${schema}.wb_listing_drafts SET data=jsonb_set(data,'{packaging,grossWeightGrams}','651'::jsonb) WHERE sku=$1`, [linkedPurchase.sku]);
    await expect(wb.reserveGeneration(linkedPurchase.sku, linked.draftVersion)).rejects.toMatchObject({
      code: 'CONFIG_INVALID',
      message: '毛重由采购管理/上架预设联动管理；当前包装毛重与联动快照不一致，不能生成 product.json',
      details: { expectedGrossWeightGrams: 650, actualGrossWeightGrams: 651 }
    });
    const linkedVersions = await admin.query<{ count: string }>(`SELECT COUNT(*)::text count FROM ${schema}.wb_listing_versions WHERE sku=$1`, [linkedPurchase.sku]);
    expect(Number(linkedVersions.rows[0]?.count || 0)).toBe(0);

    await admin.query(`UPDATE ${schema}.wb_listing_drafts
      SET data=jsonb_set(
        jsonb_set(data,'{packaging,grossWeightGrams}','650'::jsonb),
        '{initialization,grossWeightResolution,source}',
        $2::jsonb
      ) WHERE sku=$1`, [linkedPurchase.sku, JSON.stringify('PRESET_FALLBACK')]);
    await expect(wb.reserveGeneration(linkedPurchase.sku, linked.draftVersion)).rejects.toMatchObject({
      code: 'CONFIG_INVALID',
      message: '毛重联动审计快照无效，请重新初始化 WB 上品资料'
    });
    const versionsAfterInvalidAudit = await admin.query<{ count: string }>(`SELECT COUNT(*)::text count FROM ${schema}.wb_listing_versions WHERE sku=$1`, [linkedPurchase.sku]);
    expect(Number(versionsAfterInvalidAudit.rows[0]?.count || 0)).toBe(0);

    const historicalPurchase = await purchases.createPurchase({
      productName: '历史毛重草稿兼容测试',
      purchasePrice: '20',
      providerUrl: 'https://example.com/wb-historical-gross-weight'
    });
    let historical = await wb.createListing(historicalPurchase.sku);
    historical = await wb.updateListing(historicalPurchase.sku, {
      draftVersion: historical.draftVersion,
      categoryKey: 'gross_weight_guard',
      categoryVersionId: version.id,
      packaging: { grossWeightGrams: 700, weightKg: 1.2, lengthCm: 30, widthCm: 15, heightCm: 10 }
    });
    expect(historical.packaging).toMatchObject({ grossWeightGrams: 700, weightKg: 1.2 });
    await expect(wb.reserveGeneration(historicalPurchase.sku, historical.draftVersion)).resolves.toMatchObject({
      data: { packaging: { grossWeightGrams: 700, weightKg: 1.2 } }
    });
  });

  it('indexes Russian catalog terms, serializes syncs and deactivates a subject only after two complete misses', async () => {
    const firstLock = await wb.acquireCatalogSyncLock();
    expect(firstLock).toBeDefined();
    await expect(wb.acquireCatalogSyncLock()).resolves.toBeUndefined();
    await firstLock!.release();

    const parents = [{ parentId: 1, nameRu: 'Аксессуары', nameZh: '配饰', isVisible: true }];
    const colors = [{ colorKey: 'black', position: 0, nameRu: 'черный', nameZh: '黑色', parentNameRu: 'черный', parentNameZh: '黑色' }];
    const dictionaries = [
      { directory: 'countries' as const, valueKey: '15000170', position: 0, wbId: 15000170, nameRu: 'Китай', nameZh: '中国', fullNameRu: 'Китайская Народная Республика', fullNameZh: '' },
      { directory: 'seasons' as const, valueKey: 'summer', position: 0, nameRu: 'лето', nameZh: '夏季', fullNameRu: '', fullNameZh: '' },
      { directory: 'kinds' as const, valueKey: 'female', position: 0, nameRu: 'Женский', nameZh: '女性', fullNameRu: '', fullNameZh: '' }
    ];
    const first = await wb.beginCatalogRun('MANUAL');
    await wb.completeCatalogRun(first.run.runId, parents, [
      { subjectId: 8986, subjectNameRu: 'Рюкзаки', subjectNameZh: '背包', parentId: 1, parentNameRu: 'Аксессуары', parentNameZh: '配饰' }
    ], colors, dictionaries, 'snapshot-1.json', `sha256:${'1'.repeat(64)}`);
    await expect(wb.searchCatalogSubjects('рюкзак')).resolves.toEqual([
      expect.objectContaining({ subjectId: 8986, subjectName: 'Рюкзаки', parentName: 'Аксессуары', active: true })
    ]);
    await expect(wb.searchCatalogSubjects('背包')).resolves.toEqual([
      expect.objectContaining({
        subjectId: 8986, subjectName: 'Рюкзаки', subjectNameRu: 'Рюкзаки', subjectNameZh: '背包',
        parentName: 'Аксессуары', parentNameRu: 'Аксессуары', parentNameZh: '配饰', active: true
      })
    ]);

    const second = await wb.beginCatalogRun('MANUAL');
    await wb.completeCatalogRun(second.run.runId, parents, [
      { subjectId: 9991, subjectNameRu: 'Сумки', subjectNameZh: '', parentId: 1, parentNameRu: 'Аксессуары', parentNameZh: '配饰' }
    ], colors, dictionaries, 'snapshot-2.json', `sha256:${'2'.repeat(64)}`);
    await expect(wb.searchCatalogSubjects('рюкзак')).resolves.toHaveLength(1);

    const third = await wb.beginCatalogRun('MANUAL');
    await wb.completeCatalogRun(third.run.runId, parents, [
      { subjectId: 9991, subjectNameRu: 'Сумки', subjectNameZh: '', parentId: 1, parentNameRu: 'Аксессуары', parentNameZh: '配饰' }
    ], colors, dictionaries, 'snapshot-3.json', `sha256:${'3'.repeat(64)}`);
    await expect(wb.searchCatalogSubjects('рюкзак')).resolves.toHaveLength(0);
    await expect(wb.searchCatalogSubjects('аксессуары')).resolves.toEqual([
      expect.objectContaining({ subjectId: 9991, subjectName: 'Сумки' })
    ]);
    await expect(wb.searchCatalogSubjects('9991')).resolves.toEqual([
      expect.objectContaining({ subjectId: 9991 })
    ]);
    await expect(wb.catalogOverview()).resolves.toMatchObject({
      parentCount: 1, subjectCount: 1, colorCount: 1,
      dictionaryCounts: { countries: 1, seasons: 1, kinds: 1, colors: 1 },
      latestRun: { status: 'SUCCEEDED' }
    });
    await expect(wb.searchCatalogColors('黑色')).resolves.toEqual([expect.objectContaining({ nameRu: 'черный', nameZh: '黑色' })]);
    await expect(wb.searchCatalogDictionary('countries', '中国')).resolves.toEqual([
      expect.objectContaining({ wbId: 15000170, nameRu: 'Китай', nameZh: '中国' })
    ]);

    const scheduled = await wb.beginCatalogRun('SCHEDULED', '2026-07-20');
    await wb.failCatalogRun(scheduled.run.runId, 'WB_SYNC_FAILED', 'scheduled test');
    await expect(wb.beginCatalogRun('SCHEDULED', '2026-07-20')).resolves.toMatchObject({
      created: false,
      run: { runId: scheduled.run.runId, trigger: 'SCHEDULED', scheduleKey: '2026-07-20' }
    });
  });
});
