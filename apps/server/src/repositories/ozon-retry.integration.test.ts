import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { retryFixture } from '../../../../tests/fixtures/ozon-retry.js';
import { OzonRepository } from './ozon.js';
import { OzonStoreRepository, type OzonPublicationInsert } from './ozon-stores.js';
import { retryHash } from './ozon-retry.js';
import { buildOzonRetryPlan } from '../services/ozon-publishing/retry.js';

const connectionString = process.env.DATABASE_URL;
const schema = 'ozon_retry_' + randomUUID().replaceAll('-', '');
let admin: Pool, sql: Pool, stores: OzonStoreRepository;
let skuNumber = 9901700;

describe.runIf(Boolean(connectionString))('OZON durable retry PostgreSQL isolation', () => {
  beforeAll(async () => {
    vi.stubEnv('MERCHROUTE_OZON_MULTISTORE_FLEET_READY', '1');
    admin = new Pool({ connectionString, max: 1 });
    await admin.query(`CREATE SCHEMA ${schema}`);
    await admin.query(`CREATE TABLE ${schema}.products(sku CHAR(7) PRIMARY KEY,product_name TEXT NOT NULL DEFAULT '',created_at TIMESTAMPTZ NOT NULL);
      CREATE TABLE ${schema}.product_variants(id UUID PRIMARY KEY,sku CHAR(7) NOT NULL,name TEXT NOT NULL,normalized_name TEXT NOT NULL DEFAULT '',
      sort_order INTEGER NOT NULL DEFAULT 0,created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
    const url = new URL(connectionString!); url.searchParams.set('options', '-c search_path=' + schema + ',public');
    sql = new Pool({ connectionString: url.toString() });
    const legacy = new OzonRepository(url.toString()); await legacy.initialize(); await legacy.close();
    stores = new OzonStoreRepository(url.toString()); await stores.initialize();
  });
  afterAll(async () => {
    await stores?.close(); await sql?.end();
    await admin?.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); await admin?.end();
    vi.unstubAllEnvs();
  });

  async function seed() {
    const s = retryFixture(String(++skuNumber));
    await sql.query(`INSERT INTO products(sku,created_at) VALUES($1,NOW());`, [s.job.sku]);
    await sql.query(`INSERT INTO ozon_listing_drafts(sku,product_name_snapshot,status,row_version,revision,management_source,data)
      VALUES($1,'Fixture','READY',1,1,'AUTO',$2::jsonb)`, [s.job.sku, JSON.stringify(s.listing!.data)]);
    await sql.query(`INSERT INTO ozon_listing_versions(id,sku,revision,snapshot,content_policy_version,material_hash,material_hash_version,source_media_identity_hash)
      VALUES($1,$2,1,$3::jsonb,$4,$5,$6,$7)`, [s.version!.id, s.job.sku, JSON.stringify(s.version!.snapshot), s.version!.content_policy_version, s.version!.material_hash, s.version!.material_hash_version, s.version!.source_media_identity_hash]);
    await sql.query(`UPDATE ozon_store_credential_versions SET status='RETIRED' WHERE store_id=$1 AND status='ACTIVE'`, [s.store.id]);
    await sql.query(`INSERT INTO ozon_store_credential_versions(id,store_id,version_no,status,ciphertext,nonce,auth_tag,fingerprint,validated_at)
      VALUES($1,$2,$3,'ACTIVE','fixture','fixture','fixture','fixture',NOW())`, [s.job.credential_version_id, s.store.id, skuNumber]);
    await sql.query(`UPDATE ozon_stores SET enabled=true,auto_publish_enabled=true,config_version=1,preflight_status='PASSED',
      preflight_expires_at=NOW()+INTERVAL '1 day',active_credential_version_id=$2 WHERE id=$1`, [s.store.id, s.job.credential_version_id]);
    await sql.query(`UPDATE ozon_system_settings SET enabled=true WHERE id='default'`);
    await sql.query(`INSERT INTO ozon_store_publications(id,sku,generated_version_id,revision,store_id,store_alias_snapshot,status,source,
      credential_binding_mode,credential_version_id,store_config_version,task_id,warehouse_id,account_currency,fulfillment_mode,
      offer_ids,offer_contract_hash,materialization_hash,materialized_product_snapshot,plan_hash,request_id,
      content_policy_version,material_hash,material_hash_version,publication_mode,preset_row_version)
      VALUES($1,$2,$3,1,$4,'default','NEEDS_ATTENTION','AUTOMATION','VAULT',$5,1,$6,'12345','RUB','FBS',
      $7::jsonb,$8,$9,$10::jsonb,$9,$11,$12,$9,'ozon-shared-material-v1','CREATE_ONLY',1)`,
    [s.publication!.id, s.job.sku, s.version!.id, s.store.id, s.job.credential_version_id, s.job.task_id,
      JSON.stringify(s.job.offer_ids), s.publication!.offer_contract_hash, s.publication!.materialization_hash,
      JSON.stringify(s.publication!.materialized_product_snapshot), s.publication!.request_id, s.version!.content_policy_version]);
    await sql.query(`INSERT INTO ozon_publish_jobs(id,sku,state,source,task_kind,store_alias,store_id,publication_id,credential_binding_mode,
      credential_version_id,store_config_version,warehouse_id,task_id,listing_revision,offer_ids,offer_contract_hash,materialization_hash,payload,stage_states,last_error_message)
      VALUES($1,$2,'NEEDS_ATTENTION','AUTO','STORE_PUBLICATION','default',$3,$4,'VAULT',$5,1,'12345',$6,1,$7::jsonb,$8,$9,$10::jsonb,'{"import":"FAILED"}','temporary failure')`,
    [s.job.id, s.job.sku, s.store.id, s.publication!.id, s.job.credential_version_id, s.job.task_id, JSON.stringify(s.job.offer_ids),
      s.publication!.offer_contract_hash, s.publication!.materialization_hash, JSON.stringify(s.job.payload)]);
    await sql.query('UPDATE ozon_store_publications SET planned_job_id=$2 WHERE id=$1', [s.publication!.id, s.job.id]);
    return stores.retries.snapshot(s.job.id, s.store.id);
  }
  async function accept(s: Awaited<ReturnType<typeof seed>>) {
    const plan = buildOzonRetryPlan(s);
    expect(plan.canRetry, plan.blockedReason).toBe(true);
    return stores.retries.accept(s.job.id, { storeId: s.store.id, requestId: randomUUID(), planHash: plan.planHash, confirmRebuild: plan.requiresConfirmation }, plan);
  }
  async function rebuildSeed() {
    const original = await seed(); const presetId = randomUUID();
    await sql.query("INSERT INTO ozon_listing_presets(id,name,definition) VALUES($1,'Retry fixture','{}'::jsonb)", [presetId]);
    await sql.query('UPDATE ozon_stores SET default_preset_id=$2 WHERE id=$1', [original.store.id, presetId]);
    await sql.query("UPDATE ozon_store_publications SET materialized_product_snapshot='{}'::jsonb WHERE id=$1", [original.publication!.id]);
    return stores.retries.snapshot(original.job.id, original.store.id);
  }
  async function claim(id: string) {
    // Finished fixtures do not compete with this test's selected durable record.
    await sql.query(`UPDATE ozon_publish_retries SET next_check_at=NOW()+INTERVAL '1 day' WHERE id<>$1`, [id]);
    const claimed = await stores.retries.claim(); expect(claimed?.id).toBe(id); return claimed!;
  }

  it('migrates once and plan reads do not mutate business rows', async () => {
    const s = await seed(); const before = retryHash(s);
    expect(buildOzonRetryPlan(s)).toMatchObject({ canRetry: true, mode: 'RESUME' });
    expect(retryHash(await stores.retries.snapshot(s.job.id, s.store.id))).toBe(before);
    expect((await sql.query("SELECT count(*) FROM ozon_schema_migrations WHERE id='041_ozon_publish_retry'")).rows[0].count).toBe('1');
  });
  it('accepts one concurrent click, is idempotent and prevents old recheck bypass', async () => {
    const s = await seed(); const plan = buildOzonRetryPlan(s);
    const input = { storeId: s.store.id, requestId: randomUUID(), planHash: plan.planHash, confirmRebuild: false };
    const results = await Promise.all([stores.retries.accept(s.job.id, input, plan), stores.retries.accept(s.job.id, input, plan)]);
    expect(results[0].id).toBe(results[1].id);
    const current = await stores.retries.snapshot(s.job.id, s.store.id);
    expect(current.job.payload.recoveryHold.retryId).toBe(results[0].id);
    await expect(stores.assertRetryOwnership(s.job.id)).rejects.toMatchObject({ code: 'TASK_LOCKED' });
    await expect(stores.retries.assertLegacyRecoveryAllowed(s.job.id)).rejects.toMatchObject({ code: 'VERSION_CONFLICT' });
    await expect(stores.retries.accept(s.job.id, { ...input, requestId: randomUUID() }, plan)).rejects.toMatchObject({ code: 'VERSION_CONFLICT' });
    await stores.retries.settle(await claim(results[0].id), 'BLOCKED', 'fixture stopped');
  });
  it('survives expired worker leases and fences the old worker', async () => {
    const s = await seed(); const accepted = await accept(s); const first = await claim(accepted.id);
    await sql.query("UPDATE ozon_publish_retries SET lease_until=NOW()-INTERVAL '1 second' WHERE id=$1", [accepted.id]);
    const second = await claim(accepted.id);
    expect(second.lease_token).not.toBe(first.lease_token);
    await expect(stores.retries.releaseToRuntime(first, s.job.id, 'READY')).rejects.toMatchObject({ code: 'VERSION_CONFLICT' });
    await stores.retries.checkpoint(second, { checked: true }, 'CHECKING', 'fixture');
    expect((await stores.retries.byRequest(accepted.request_id))?.checkpoint.checked).toBe(true);
    await stores.retries.settle(second, 'BLOCKED', 'fixture stopped');
  });
  it('resumes original import identity without erasing stages or checkpoints', async () => {
    const s = await seed(); const intent = { phase: 'TASK_ID_BOUND', offerIds: s.job.offer_ids, importTaskId: '12345' };
    await sql.query(`UPDATE ozon_publish_jobs SET import_task_id='12345',payload=payload || $2::jsonb WHERE id=$1`, [s.job.id, JSON.stringify({ importIntent: intent })]);
    const original = await stores.retries.snapshot(s.job.id, s.store.id); const accepted = await accept(original);
    await stores.retries.releaseToRuntime(await claim(accepted.id), s.job.id, 'IMPORTING');
    const current = await stores.retries.snapshot(s.job.id, s.store.id);
    expect(current.job).toMatchObject({ id: s.job.id, task_id: s.job.task_id, import_task_id: '12345', state: 'IMPORTING', stage_states: { import: 'FAILED' } });
    expect(current.job.payload.importIntent).toEqual(intent);
    expect(current.job.payload.recoveryHold).toBeUndefined();
    expect((await stores.retries.latest(s.job.id, s.store.id))?.status).toBe('RUNNING');
    await sql.query("UPDATE ozon_publish_jobs SET state='NEEDS_ATTENTION' WHERE id=$1", [s.job.id]);
    await sql.query('UPDATE ozon_publish_retries SET next_check_at=NOW() WHERE id=$1', [accepted.id]);
    await stores.retries.settle(await claim(accepted.id), 'FAILED', 'fixture stopped');
  });
  it('does not release a newly materialized job when configuration changes', async () => {
    const s = await seed(); const accepted = await accept(s); const r = await claim(accepted.id);
    await sql.query("UPDATE ozon_publish_jobs SET state='READY' WHERE id=$1", [s.job.id]);
    await sql.query('UPDATE ozon_stores SET config_version=2 WHERE id=$1', [s.store.id]);
    await expect(stores.retries.releaseToRuntime(r, s.job.id, 'READY')).rejects.toMatchObject({ code: 'VERSION_CONFLICT' });
    await stores.retries.settle(r, 'BLOCKED', '配置已变化');
    const current = await stores.retries.snapshot(s.job.id, s.store.id);
    expect(current.job.state).toBe('NEEDS_ATTENTION');
    expect(current.job.payload.recoveryHold).toBeUndefined();
    expect(current.publication!.status).toBe('NEEDS_ATTENTION');
  });
  it('reserves a genuine new revision once, preserving old immutable version and offers', async () => {
    const s = await rebuildSeed(); const r = await claim((await accept(s)).id);
    const next = await stores.retries.reserveVersion(r);
    expect(next).toEqual(await stores.retries.reserveVersion(r));
    expect(next.versionId).not.toBe(s.version!.id);
    const versions = (await sql.query('SELECT * FROM ozon_listing_versions WHERE sku=$1 ORDER BY revision', [s.job.sku])).rows;
    expect(versions).toHaveLength(2);
    expect(versions[0].snapshot).toEqual(s.version!.snapshot);
    expect(versions[1].snapshot.data).toEqual(s.version!.snapshot.data);
    expect(versions[1].revision).toBe(2);
    await stores.retries.settle(r, 'BLOCKED', 'fixture stopped');
  });
  it('materializes under a hold, releases a claimable single-store replacement and preserves the other store', async () => {
    const s = await rebuildSeed(); const r = await claim((await accept(s)).id);
    const next = await stores.retries.reserveVersion(r);
    const product = { ...retryFixture(s.job.sku).publication!.materialized_product_snapshot, revision: 2 };
    const input: OzonPublicationInsert = {
      retryId: r.id, retryLeaseToken: r.lease_token, id: randomUUID(), jobId: randomUUID(), sku: s.job.sku,
      generatedVersionId: next.versionId, revision: 2, storeId: s.store.id, storeAlias: 'default', storeDisplayName: 'Fixture',
      source: 'AUTOMATION', credentialBindingMode: 'VAULT', credentialVersionId: s.job.credential_version_id, storeConfigVersion: 1,
      requestId: r.id, planHash: s.publication!.plan_hash, contentPolicyVersion: s.version!.content_policy_version,
      materialHash: s.version!.material_hash, materialHashVersion: 'ozon-shared-material-v1', publicationMode: 'CREATE_ONLY', presetRowVersion: 1,
      taskId: 'default__' + s.job.sku + '__r2', warehouseId: '12345', warehouseName: 'Fixture', fulfillmentMode: 'FBS', accountCurrency: 'RUB',
      offerIds: s.job.offer_ids, offerContractHash: retryHash({ storeId: s.store.id, generatedVersionId: next.versionId, offerIds: [...s.job.offer_ids].sort() }),
      materializationHash: s.publication!.materialization_hash, materializedProductSnapshot: product
    };
    await expect(stores.planPublicationAttempt({ ...input, retryId: undefined, retryLeaseToken: undefined })).rejects.toMatchObject({ code: 'TASK_LOCKED' });
    await expect(stores.cancelPublication(s.publication!.id, s.publication!.row_version)).rejects.toMatchObject({ code: 'TASK_LOCKED' });
    const other = await stores.createStore({ storeAlias: 'other' + s.job.sku, displayName: 'Other fixture', autoPublishEnabled: false,
      autoPublishMode: 'CREATE_ONLY', warehouseId: '12345', warehouseName: 'Fixture', fulfillmentMode: 'FBS', accountCurrency: 'RUB', maxDailyStyles: 100 });
    const otherCredentialId = randomUUID();
    await sql.query(`INSERT INTO ozon_store_credential_versions(id,store_id,version_no,status,ciphertext,nonce,auth_tag,fingerprint,validated_at)
      VALUES($1,$2,1,'ACTIVE','fixture','fixture','fixture','fixture',NOW())`, [otherCredentialId, other.id]);
    const otherInput = { ...input, retryId: undefined, retryLeaseToken: undefined, requestId: randomUUID(), id: randomUUID(), jobId: randomUUID(),
      storeId: other.id, storeAlias: other.storeAlias, credentialVersionId: otherCredentialId, taskId: other.storeAlias + '__' + s.job.sku + '__r2' };
    await stores.planPublicationAttempt(otherInput);
    await sql.query("UPDATE ozon_publish_jobs SET state='SUCCEEDED' WHERE id=$1", [otherInput.jobId]);
    await sql.query("UPDATE ozon_store_publications SET status='SUCCEEDED' WHERE id=$1", [otherInput.id]);
    const otherBefore = await stores.retries.snapshot(otherInput.jobId, other.id);
    await stores.planPublicationAttempt(input);
    await stores.materializePublicationAttempt({ retryId: r.id, retryLeaseToken: r.lease_token, publicationId: input.id, jobId: input.jobId,
      planHash: input.planHash, materializationHash: input.materializationHash, packageRelPath: 'stores/default/INBOX/test', packageSignature: input.materializationHash, productJsonPath: '/isolated/product.json' });
    expect((await stores.retries.snapshot(input.jobId, s.store.id)).job.payload.recoveryHold.retryId).toBe(r.id);
    expect(await stores.claimRuntimeJobs({ leaseOwner: 'retry-fixture', leaseSeconds: 60, limit: 2 })).toEqual([]);
    await stores.retries.releaseToRuntime(r, input.jobId);
    const jobs = await stores.claimRuntimeJobs({ leaseOwner: 'retry-fixture', leaseSeconds: 60, limit: 2 });
    expect(jobs.map(j => j.id)).toEqual([input.jobId]);
    const old = await stores.retries.snapshot(s.job.id, s.store.id);
    expect(old.job.state).toBe('NEEDS_ATTENTION');
    expect(old.job.payload.replanReplacement.replacementJobId).toBe(input.jobId);
    expect(old.publication!.result_json.replanReplacement.replacementPublicationId).toBe(input.id);
    expect(await stores.retries.snapshot(otherInput.jobId, other.id)).toEqual(otherBefore);
    await expect(stores.assertRetryOwnership(s.job.id)).rejects.toMatchObject({ code: 'TASK_LOCKED' });
    await sql.query("UPDATE ozon_publish_jobs SET state='NEEDS_ATTENTION',lease_expires_at=NULL WHERE id=$1", [input.jobId]);
    await sql.query('UPDATE ozon_publish_retries SET next_check_at=NOW() WHERE id=$1', [r.id]);
    await stores.retries.settle(await claim(r.id), 'FAILED', 'fixture stopped');
  });
  it('rechecks credential expiry at release, leaving an explicit stop instead of an unclaimable queue', async () => {
    const s = await seed(); const r = await claim((await accept(s)).id);
    await sql.query("UPDATE ozon_store_credential_versions SET validated_at=NOW()-INTERVAL '2 days' WHERE id=$1", [s.job.credential_version_id]);
    await expect(stores.retries.releaseToRuntime(r, s.job.id, 'READY')).rejects.toThrow('凭据已过期');
    await stores.retries.settle(r, 'BLOCKED', '冻结凭据已过期');
    expect((await stores.retries.snapshot(s.job.id, s.store.id)).job.state).toBe('NEEDS_ATTENTION');
  });
});
