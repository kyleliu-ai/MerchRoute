import { createHash, randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { PurchaseRepository } from './purchases.js';
import { WbRepository } from './wb.js';
import { WbStoreRepository } from './wb-stores.js';
import { WbAutoPublishRepository } from './wb-auto-publish.js';
import { WbAutoPublishRetryService } from '../services/wb-auto-publish/retry.js';
import { WbStoreGatewayService } from '../services/wb-stores/gateway.js';

// Vitest may load this file while another integration fixture is restoring an
// environment override.  CI always supplies a disposable DATABASE_URL, so
// register the suite there and resolve the URL in beforeAll instead of
// silently marking every retry assertion as skipped during that short window.
let connectionString: string | undefined;
const requireDatabase = process.env.CI === 'true';
const schema = 'wb_retry_test_' + randomUUID().replaceAll('-', '');
const storeId = '00000000-0000-4000-8000-000000000001';
let admin: Pool, pool: Pool, purchases: PurchaseRepository, wb: WbRepository, stores: WbStoreRepository, auto: WbAutoPublishRepository;
let gateway: WbStoreGatewayService, service: WbAutoPublishRetryService;
let categoryVersion: string;
let readDelays: number[] = [];
const waitForRead = async (milliseconds: number) => { readDelays.push(milliseconds); };
let sequence = 172;
const stable = (v: any): string => Array.isArray(v) ? '[' + v.map(stable).join(',') + ']'
  : v && typeof v === 'object' ? '{' + Object.keys(v).sort().map(k => JSON.stringify(k) + ':' + stable(v[k])).join(',') + '}' : JSON.stringify(v);
const hash = (v: any) => 'sha256:' + createHash('sha256').update(stable(v)).digest('hex');

describe.runIf(requireDatabase || Boolean(process.env.DATABASE_URL))('WB retry PostgreSQL and gateway integration', () => {
  beforeAll(async () => {
    connectionString = process.env.DATABASE_URL;
    if (!connectionString) throw new Error('WB retry integration requires DATABASE_URL');
    admin = new Pool({ connectionString, max: 1 });
    await admin.query(`CREATE SCHEMA ${schema}`);
    const url = new URL(connectionString!); url.searchParams.set('options', `-c search_path=${schema},public`);
    pool = new Pool({ connectionString: url.toString(), max: 6 });
    purchases = new PurchaseRepository(url.toString());
    await purchases.initialize({ code: 'E999', displayName: 'isolated', webhookUrl: 'http://127.0.0.1:9/test', parentOutputDir: '/tmp/wb-retry-test', enabled: false, isDefault: false });
    wb = new WbRepository(url.toString()); await wb.initialize();
    stores = new WbStoreRepository(url.toString()); await stores.initialize();
    await pool.query('CREATE TABLE IF NOT EXISTS wb_listing_presets(id UUID PRIMARY KEY)');
    auto = new WbAutoPublishRepository(url.toString()); await auto.initialize();
    const categoryId = randomUUID(); categoryVersion = randomUUID();
    await pool.query(`INSERT INTO wb_category_templates(id,category_key,name_ru,subject_id) VALUES($1,'retry_test','test',7)`, [categoryId]);
    await pool.query(`INSERT INTO wb_category_template_versions(id,template_id,version_no,status,name_ru,subject_id,live_schema,form_config,managed_characteristic_ids,schema_hash)
      VALUES($1,$2,1,'PUBLISHED','test',7,'[]','{}','[]','test')`, [categoryVersion, categoryId]);
    gateway = new WbStoreGatewayService(stores, { decryptGatewayCredential: () => 'isolated-placeholder' } as any);
    service = new WbAutoPublishRetryService(wb.autoRetry, gateway, async () => {}, waitForRead);
  }, 60_000);
  beforeEach(async () => {
    readDelays = [];
    await pool.query("UPDATE wb_auto_publish_retries SET next_check_at=NOW()+INTERVAL '1 year'");
    await pool.query("UPDATE wb_store_credential_versions SET status='RETIRED' WHERE status='ACTIVE'");
    await pool.query("UPDATE wb_manual_retry_protocol SET enabled=true,workflow_version_id='isolated-s001-v1',verified_at=NOW()");
  });
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });
  afterAll(async () => {
    await Promise.all([auto?.close(), wb?.close(), stores?.close(), purchases?.close(), pool?.end()]);
    await admin?.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); await admin?.end();
  });

  async function fixture() {
    const sku = String(sequence++).padStart(7, '0');
    const publicationId = randomUUID(), versionId = randomUUID(), credentialId = randomUUID(), runId = randomUUID(), jobId = randomUUID();
    const taskId = 'default__' + sku + '__r4', idempotencyKey = 'frozen:' + taskId;
    const vendorCode = sku + '-01';
    const frozenPayload = [{ subjectID: 7, variants: [{ vendorCode, sizes: [{ skus: ['barcode-' + sku] }] }] }];
    const logicalIntentId = 'card-' + createHash('sha256').update([taskId, publicationId, 4, idempotencyKey, 'CARD_UPLOAD'].join('|')).digest('hex');
    const firstRef = taskId + ':CARD_WRITE:' + logicalIntentId + ':attempt-1';
    const runtime = { automationRunId: runId, cardOperation: 'create',
      product: { productCode: sku, revision: 4, category: { subjectId: 7 }, variants: [{ vendorCode, sizes: [{ barcode: 'barcode-' + sku }] }] },
      cardCreateIntent: { taskId, publicationId, revision: 4, idempotencyKey, logicalIntentId, attemptNo: 1,
        frozenPayload, frozenPayloadHash: hash(frozenPayload), vendorCodes: [vendorCode] },
      cards: [], audit: [{ event: 'HTTP_RESPONSE', status: 400, stage: 'CARD_WRITE', requestRef: firstRef }] };
    await pool.query('INSERT INTO products(sku,product_name) VALUES($1,$2)', [sku, '隔离重试测试']);
    await pool.query('INSERT INTO wb_listing_drafts(sku) VALUES($1)', [sku]);
    await pool.query(`INSERT INTO wb_listing_versions(id,sku,revision,status,category_version_id,product_json,media_manifest,generation_scope)
      VALUES($1,$2,4,'FAILED',$3,$4,'{}','STORE_PUBLICATION')`, [versionId, sku, categoryVersion, JSON.stringify(runtime.product)]);
    await pool.query(`INSERT INTO wb_store_credential_versions(id,store_id,version_no,status,ciphertext,nonce,auth_tag,fingerprint)
      VALUES($1::uuid,$2,$3,'ACTIVE','placeholder','placeholder','placeholder',$1::text)`, [credentialId, storeId, sequence]);
    await pool.query(`UPDATE wb_stores SET enabled=true,credential_state='ACTIVE',active_credential_version_id=$2,warehouse_id='1' WHERE id=$1`, [storeId, credentialId]);
    await pool.query(`INSERT INTO wb_store_publications(id,sku,generated_version_id,revision,store_id,store_alias_snapshot,status,source,credential_version_id,task_id,config_snapshot)
      VALUES($1,$2,$3,4,$4,'default','FAILED','AUTOMATION',$5,$6,$7)`,
    [publicationId, sku, versionId, storeId, credentialId, taskId, JSON.stringify({ automationRunId: runId })]);
    await pool.query(`INSERT INTO wb_publish_jobs(task_id,idempotency_key,store_id,publication_id,credential_version_id,warehouse_id,
      product_code,revision,payload_signature,state,partial_effects,row_version,result_json,last_error_code,last_error_message)
      VALUES($1,$2,$3,$4,$5,'1',$6,4,'frozen-signature','FAILED',false,8,$7,'WB_HTTP_400','Internal server error')`,
    [taskId, idempotencyKey, storeId, publicationId, credentialId, sku, JSON.stringify(runtime)]);
    await pool.query(`INSERT INTO wb_auto_publish_jobs(id,store_id,sku,run_id,state,n8n_task_id,publication_id,last_error_code,last_error_message)
      VALUES($1,$2,$3,$4,'FAILED',$5,$6,'WB_HTTP_400','Internal server error')`, [jobId, storeId, sku, runId, taskId, publicationId]);
    const requestHash = hash({ taskId, storeId, credentialVersionId: credentialId, warehouseId: '1', operation: 'CARD_UPLOAD', payload: { body: frozenPayload } });
    await pool.query(`INSERT INTO wb_gateway_requests(request_ref,request_hash,task_id,publication_id,store_id,credential_version_id,operation,
      logical_intent_id,attempt_no,delivery_state,retry_class,status_code,response_json,completed_at)
      VALUES($1,$2,$3,$4,$5,$6,'CARD_UPLOAD',$7,1,'RESPONDED','PERMANENT',400,'{"errorText":"Internal server error"}',NOW())`,
    [firstRef, requestHash, taskId, publicationId, storeId, credentialId, logicalIntentId]);
    const fetchMock = vi.fn(async (url: string) => {
      const body = url.includes('/cards/error/list') ? { data: { items: [], cursor: { next: false } } }
        : url.includes('/get/cards/') ? { cards: [], cursor: { total: 0 } } : { error: false };
      return new Response(JSON.stringify(body), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);
    const detail = await service.detail(storeId, sku);
    const input = { storeId, runId, requestId: randomUUID(), expectedStateToken: detail.expectedStateToken };
    return { sku, taskId, runId, publicationId, runtime, input, firstRef, fetchMock };
  }
  async function issueCard(f: Awaited<ReturnType<typeof fixture>>) {
    const row = (await pool.query('SELECT * FROM wb_publish_jobs WHERE task_id=$1', [f.taskId])).rows[0];
    const runtime = row.result_json; const attempt = runtime.manualRetry.cardAttemptNo;
    runtime.cardCreateIntent.attemptNo = attempt;
    await pool.query("UPDATE wb_publish_jobs SET state='CARD_SUBMITTING',result_json=$2,row_version=row_version+1 WHERE task_id=$1", [f.taskId, JSON.stringify(runtime)]);
    return { taskId: f.taskId, storeId, requestRef: f.taskId + ':CARD_WRITE:' + runtime.cardCreateIntent.logicalIntentId + ':attempt-' + attempt,
      operation: 'CARD_UPLOAD', payload: { body: runtime.cardCreateIntent.frozenPayload } };
  }
  it('defaults off after migration and rejects an unverified protocol', async () => {
    const f = await fixture();
    await pool.query("UPDATE wb_manual_retry_protocol SET enabled=false,workflow_version_id='',verified_at=NULL");
    expect((await service.detail(storeId, f.sku)).canRetry).toBe(false);
    await expect(service.request(f.sku, f.input)).rejects.toMatchObject({ code: 'WB_RETRY_NOT_DEPLOYED' });
  });
  it.each([200, 400])('0000172-style failure executes a new controlled request, second response %s', async status => {
    const f = await fixture();
    const first = await service.request(f.sku, f.input);
    await service.runPending();
    const resumed = (await pool.query('SELECT * FROM wb_publish_jobs WHERE task_id=$1', [f.taskId])).rows[0];
    expect(resumed.state).toBe('CARD_CREATE_READY');
    expect(resumed.partial_effects).toBe(false);
    expect(resumed.result_json.cardCreateIntent.frozenPayload).toEqual(f.runtime.cardCreateIntent.frozenPayload);
    const input = await issueCard(f);
    f.fetchMock.mockImplementation(async () => new Response(JSON.stringify({ error: status === 400, errorText: status === 400 ? 'Internal server error' : '' }), { status }));
    const results = await Promise.all([gateway.execute(input), gateway.execute(input)]);
    expect(results.some(r => r.statusCode === status)).toBe(true);
    expect(f.fetchMock).toHaveBeenCalledTimes(4); // three complete reads, one new write
    const replay = await gateway.execute(input);
    expect(replay.statusCode).toBe(status);
    expect(f.fetchMock).toHaveBeenCalledTimes(4);
    const ledgers = (await pool.query("SELECT * FROM wb_gateway_requests WHERE task_id=$1 AND operation='CARD_UPLOAD' ORDER BY attempt_no", [f.taskId])).rows;
    expect(ledgers.map(r => [r.attempt_no, r.status_code])).toEqual([[1, 400], [2, status]]);
    expect(ledgers[0].request_ref).toBe(f.firstRef);
    await pool.query("UPDATE wb_publish_jobs SET state=$2,last_error_code=$3,last_error_message=$4 WHERE task_id=$1",
      [f.taskId, status === 200 ? 'SUCCEEDED' : 'FAILED', status === 400 ? 'WB_HTTP_400' : '', status === 400 ? 'second Internal server error' : '']);
    await pool.query('UPDATE wb_auto_publish_retries SET next_check_at=NOW() WHERE id=$1', [first.retry.id]);
    await service.runPending();
    const detail = await service.detail(storeId, f.sku);
    expect(detail.latest?.status).toBe(status === 200 ? 'SUCCEEDED' : 'FAILED');
    expect(detail.latest?.previousErrorCode).toBe('WB_HTTP_400');
    expect((await pool.query('SELECT status FROM wb_store_publications WHERE id=$1', [f.publicationId])).rows[0].status).toBe(status === 200 ? 'SUCCEEDED' : 'FAILED');
  });
  it('serializes double-clicks and two tabs, preserves request idempotency and rejects stale tokens', async () => {
    const f = await fixture();
    await expect(service.request(f.sku, { ...f.input, expectedStateToken: '0'.repeat(64) })).rejects.toMatchObject({ code: 'VERSION_CONFLICT' });
    const results = await Promise.all([service.request(f.sku, f.input), service.request(f.sku, f.input),
      service.request(f.sku, { ...f.input, requestId: randomUUID() })]);
    expect(new Set(results.map(r => r.retry.id)).size).toBe(1);
    await expect(auto.transition(f.sku, 'FAILED', { errorCode: 'OLD_FAILED' }, storeId)).rejects.toMatchObject({ code: 'TASK_LOCKED' });
    const claims = await Promise.all([wb.autoRetry.claim(), wb.autoRetry.claim()]);
    expect(claims.filter(Boolean)).toHaveLength(1);
  });
  it('reads every error batch using the WB data.items and data.cursor pagination contract', async () => {
    const f = await fixture(); let errorPages = 0;
    f.fetchMock.mockImplementation(async url => {
      if (!url.includes('/cards/error/list')) return new Response(JSON.stringify({ cards: [], cursor: { total: 0 } }));
      errorPages++;
      return new Response(JSON.stringify({ data: { items: errorPages === 1 ? [] : [{ vendorCodes: [f.sku + '-01'], errors: { [f.sku + '-01']: ['Invalid title'] } }],
        cursor: { next: errorPages === 1, updatedAt: '2026-09-01T00:00:00Z', batchUUID: 'old-batch' } } }));
    });
    await service.request(f.sku, f.input); await service.runPending();
    expect(errorPages).toBe(2);
    expect(readDelays).toEqual([600, 600, 6_000]);
    expect((await service.detail(storeId, f.sku)).latest).toMatchObject({ status: 'BLOCKED', errorCode: 'WB_RETRY_UNSAFE' });
    expect((await pool.query("SELECT count(*)::int total FROM wb_gateway_requests WHERE task_id=$1 AND operation='CARD_UPLOAD'", [f.taskId])).rows[0].total).toBe(1);
  });
  it.each([400, 401, 403])('stops a rejected readback %s with a concrete reason and no new write', async status => {
    const f = await fixture();
    f.fetchMock.mockImplementation(async () => new Response(JSON.stringify({ errorText: 'Access or request rejected' }), { status }));
    await service.request(f.sku, f.input); await service.runPending();
    expect((await service.detail(storeId, f.sku)).latest).toMatchObject({ status: 'BLOCKED',
      errorCode: status === 400 ? 'WB_RETRY_READBACK_REJECTED' : 'WB_RETRY_CREDENTIAL_UNAVAILABLE' });
    expect((await pool.query("SELECT count(*)::int total FROM wb_gateway_requests WHERE task_id=$1 AND operation='CARD_UPLOAD'", [f.taskId])).rows[0].total).toBe(1);
  });
  it('recovers expired checking leases after restart and fences stale workers', async () => {
    const f = await fixture(); await service.request(f.sku, f.input);
    const abandoned = (await wb.autoRetry.claim())!;
    await pool.query("UPDATE wb_auto_publish_retries SET lease_until=NOW()-INTERVAL '1 second' WHERE id=$1", [abandoned.id]);
    const recovered = (await wb.autoRetry.claim())!;
    expect(recovered.lease_token).not.toBe(abandoned.lease_token);
    await expect(wb.autoRetry.heartbeat(abandoned)).rejects.toMatchObject({ code: 'TASK_LOCKED' });
    await expect(wb.autoRetry.settle(abandoned, 'FAILED', 'stale')).rejects.toMatchObject({ code: 'TASK_LOCKED' });
    await wb.autoRetry.defer(recovered, 'restart');
  });
  it('cannot get write authorization merely by increasing an attempt number', async () => {
    const f = await fixture(); await service.request(f.sku, f.input); await service.runPending();
    const input = await issueCard(f);
    const tampered = input.requestRef.replace('attempt-2', 'attempt-3');
    await expect(gateway.execute({ ...input, requestRef: tampered })).rejects.toMatchObject({ code: 'WB_CARD_INTENT_CONFLICT' });
    expect(f.fetchMock).toHaveBeenCalledTimes(3);
  });
  it('continues media when WB already owns the card, without another create', async () => {
    const f = await fixture();
    f.fetchMock.mockImplementation(async url => new Response(JSON.stringify(
      url.includes('/get/cards/list') ? { cards: [{ vendorCode: f.sku + '-01', nmID: 172, subjectID: 7, sizes: [{ skus: ['barcode-' + f.sku] }] }], cursor: { total: 1 } }
        : url.includes('/cards/error/list') ? { data: { items: [], cursor: { next: false } } } : { cards: [], cursor: { total: 0 } }), { status: 200 }));
    await service.request(f.sku, f.input); await service.runPending();
    const row = (await pool.query('SELECT * FROM wb_publish_jobs WHERE task_id=$1', [f.taskId])).rows[0];
    expect(row.state).toBe('MEDIA_RECONCILING');
    expect(row.result_json.manualRetry.cardWriteAuthorized).toBeUndefined();
    expect(await service.blocksNormalWorker(storeId, f.sku, f.runId)).toBe(true);
    expect(f.fetchMock).toHaveBeenCalledTimes(3);
  });
  it.each(['UNKNOWN', 'incomplete', 'fields'])('does not authorize a duplicate write for %s', async kind => {
    const f = await fixture();
    if (kind === 'UNKNOWN') await pool.query("UPDATE wb_gateway_requests SET delivery_state='UNKNOWN',retry_class='READBACK_REQUIRED' WHERE request_ref=$1", [f.firstRef]);
    if (kind === 'fields') await pool.query(`UPDATE wb_gateway_requests SET response_json='{"errorText":"Invalid title"}' WHERE request_ref=$1`, [f.firstRef]);
    if (kind === 'incomplete') f.fetchMock.mockResolvedValue(new Response(JSON.stringify({ cards: [], cursor: {} }), { status: 200 }));
    await service.request(f.sku, f.input); await service.runPending();
    const retry = (await service.detail(storeId, f.sku)).latest!;
    expect(retry.status).toBe(kind === 'UNKNOWN' ? 'RUNNING' : 'BLOCKED');
    const row = (await pool.query('SELECT result_json FROM wb_publish_jobs WHERE task_id=$1', [f.taskId])).rows[0];
    expect(row.result_json.manualRetry?.cardWriteAuthorized).toBeUndefined();
    expect((await pool.query("SELECT count(*)::int total FROM wb_gateway_requests WHERE task_id=$1 AND operation='CARD_UPLOAD'", [f.taskId])).rows[0].total).toBe(1);
  });
  it('rechecks an expired unconsumed grant after intent persistence and reuses the same authorized attempt', async () => {
    const f = await fixture(); const accepted = await service.request(f.sku, f.input);
    await service.runPending(); const input = await issueCard(f);
    await pool.query(`UPDATE wb_auto_publish_retries SET next_check_at=NOW(),
      evidence=jsonb_set(evidence,'{checkedAt}',to_jsonb((NOW()-INTERVAL '20 minutes')::text)) WHERE id=$1`, [accepted.retry.id]);
    await expect(gateway.execute(input)).rejects.toMatchObject({ code: 'WB_CARD_RETRY_PROOF_EXPIRED' });
    const restarted = new WbAutoPublishRetryService(wb.autoRetry, gateway, async () => {}, waitForRead);
    await restarted.runPending();
    const row = (await pool.query('SELECT result_json,state FROM wb_publish_jobs WHERE task_id=$1', [f.taskId])).rows[0];
    expect(row.state).toBe('CARD_CREATE_READY');
    expect(row.result_json.manualRetry.cardAttemptNo).toBe(2);
    expect((await restarted.detail(storeId, f.sku)).latest!.id).toBe(accepted.retry.id);
    const resumedInput = await issueCard(f);
    expect((await gateway.execute(resumedInput)).statusCode).toBe(200);
  });
  it('keeps a successful TEK+02 record untouched when TEK+01 retries the same SKU', async () => {
    const f = await fixture(); const secondStore = randomUUID(), secondJob = randomUUID(), secondPublication = randomUUID();
    await pool.query("INSERT INTO wb_stores(id,store_alias,display_name) VALUES($1,$2,'TEK+02')", [secondStore, 'second-' + f.sku]);
    await pool.query(`INSERT INTO wb_store_publications(id,sku,generated_version_id,revision,store_id,store_alias_snapshot,status,source)
      SELECT $2,sku,generated_version_id,revision,$3,'second','SUCCEEDED','AUTOMATION' FROM wb_store_publications WHERE id=$1`,
    [f.publicationId, secondPublication, secondStore]);
    await pool.query(`INSERT INTO wb_auto_publish_jobs(id,store_id,sku,run_id,state,publication_id) VALUES($1,$2,$3,$4,'SUCCEEDED',$5)`,
    [secondJob, secondStore, f.sku, randomUUID(), secondPublication]);
    const before = (await pool.query('SELECT row_to_json(p) result FROM wb_store_publications p WHERE id=$1', [secondPublication])).rows[0];
    await service.request(f.sku, f.input); await service.runPending();
    expect((await pool.query('SELECT row_to_json(p) result FROM wb_store_publications p WHERE id=$1', [secondPublication])).rows[0]).toEqual(before);
    expect((await pool.query('SELECT state FROM wb_auto_publish_jobs WHERE id=$1', [secondJob])).rows[0].state).toBe('SUCCEEDED');
  });
  it('projects a runtime manual-attention result as blocked, never as publication RUNNING', async () => {
    const f = await fixture(); const result = await service.request(f.sku, f.input); await service.runPending();
    await pool.query("UPDATE wb_publish_jobs SET state='NEEDS_ATTENTION',last_error_code='CARD_IDENTITY_CONFLICT' WHERE task_id=$1", [f.taskId]);
    await pool.query('UPDATE wb_auto_publish_retries SET next_check_at=NOW() WHERE id=$1', [result.retry.id]);
    await service.runPending();
    expect((await service.detail(storeId, f.sku)).latest!.status).toBe('BLOCKED');
    expect((await pool.query('SELECT status FROM wb_store_publications WHERE id=$1', [f.publicationId])).rows[0].status).toBe('NEEDS_ATTENTION');
  });
});
