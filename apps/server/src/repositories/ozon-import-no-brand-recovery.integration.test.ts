import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { OZON_DEFAULT_STORE_ID } from '@n8n-media-review/shared';
import { OzonStoreRepository } from './ozon-stores.js';
import { OzonRepository } from './ozon.js';

const connectionString = process.env.DATABASE_URL;
const schema = `ozon_no_brand_recovery_${randomUUID().replaceAll('-', '')}`;
let admin: Pool;
let stores: OzonStoreRepository;

describe.runIf(Boolean(connectionString))('OZON imported no-brand recovery PostgreSQL', () => {
  beforeAll(async () => {
    admin = new Pool({ connectionString, max: 1 });
    await admin.query(`CREATE SCHEMA ${schema}`);
    await admin.query(`CREATE TABLE ${schema}.products (
      sku CHAR(7) PRIMARY KEY,product_name TEXT NOT NULL DEFAULT '',created_at TIMESTAMPTZ NOT NULL
    )`);
    await admin.query(`CREATE TABLE ${schema}.product_variants (
      id UUID PRIMARY KEY,sku CHAR(7) NOT NULL,name TEXT NOT NULL,normalized_name TEXT NOT NULL DEFAULT '',
      sort_order INTEGER NOT NULL DEFAULT 0,created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
    const isolatedUrl = new URL(connectionString!);
    isolatedUrl.searchParams.set('options', `-c search_path=${schema},public`);
    const isolatedConnectionString = isolatedUrl.toString();
    const legacy = new OzonRepository(isolatedConnectionString);
    await legacy.initialize();
    await legacy.close();
    stores = new OzonStoreRepository(isolatedConnectionString);
    await stores.initialize();
  });

  afterAll(async () => {
    await stores?.close();
    await admin?.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin?.end();
  });

  it('uses a new one-shot import identity only for an exact attribute-85 rejection', async () => {
    const sku = '0000122';
    const generatedVersionId = randomUUID();
    const credentialVersionId = randomUUID();
    const publicationId = randomUUID();
    const jobId = randomUUID();
    const offerId = '0000122-01';
    const productId = '5929063200';
    const taskId = `default__${sku}__r6`;
    const offerContractHash = `sha256:${'1'.repeat(64)}`;
    const materializationHash = `sha256:${'2'.repeat(64)}`;
    const directorySignature = `sha256:${'3'.repeat(64)}`;
    const errorMessage = JSON.stringify([{
      offer_id: offerId, product_id: Number(productId), status: 'imported',
      errors: [{
        code: 'error_attribute_values_out_of_range', attribute_id: 85,
        attribute_name: 'Бренд', level: 'error'
      }]
    }]);

    await admin.query(`INSERT INTO ${schema}.products(sku,product_name,created_at) VALUES($1,'Product',NOW())`, [sku]);
    await admin.query(`INSERT INTO ${schema}.ozon_listing_drafts(sku,product_name_snapshot,status,row_version)
      VALUES($1,'Product','READY',6)`, [sku]);
    await admin.query(`INSERT INTO ${schema}.ozon_listing_versions(id,sku,revision,snapshot)
      VALUES($1,$2,6,$3::jsonb)`, [generatedVersionId, sku, JSON.stringify({ sku, data: { offers: [{ offerId }] } })]);
    await admin.query(`INSERT INTO ${schema}.ozon_store_credential_versions(
      id,store_id,version_no,status,ciphertext,nonce,auth_tag,fingerprint
    ) VALUES($1,$2,1,'ACTIVE','cipher','nonce','tag',$3)`, [credentialVersionId, OZON_DEFAULT_STORE_ID, 'a'.repeat(64)]);
    await admin.query(`UPDATE ${schema}.ozon_stores SET active_credential_version_id=$1 WHERE id=$2`, [
      credentialVersionId, OZON_DEFAULT_STORE_ID
    ]);
    await admin.query(`INSERT INTO ${schema}.ozon_store_publications(
      id,sku,generated_version_id,revision,store_id,store_alias_snapshot,status,source,
      credential_binding_mode,credential_version_id,store_config_version,offer_ids,offer_contract_hash,
      materialization_hash,product_ids,error_code,error_message,row_version
    ) VALUES($1,$2,$3,6,$4,'default','NEEDS_ATTENTION','MANUAL','VAULT',$5,1,$6::jsonb,$7,$8,$9::jsonb,
      'OZON_IMPORT_PARTIAL_FAILED',$10,6)`, [
      publicationId, sku, generatedVersionId, OZON_DEFAULT_STORE_ID, credentialVersionId,
      JSON.stringify([offerId]), offerContractHash, materializationHash, JSON.stringify([productId]), errorMessage
    ]);
    await admin.query(`INSERT INTO ${schema}.ozon_publish_jobs(
      id,sku,state,source,store_alias,store_id,publication_id,credential_binding_mode,credential_version_id,
      store_config_version,warehouse_id,task_id,listing_revision,offer_ids,offer_contract_hash,materialization_hash,
      import_task_id,ozon_product_id,directory_stage,work_rel_path,directory_signature,payload,stage_states,
      last_error_code,last_error_message,row_version
    ) VALUES($1,$2,'NEEDS_ATTENTION','MANUAL','default',$3,$4,'VAULT',$5,1,'1020002456503000',$6,6,$7::jsonb,$8,$9,
      '5389881966',$10,'PROCESSING',$11,$12,$13::jsonb,$14::jsonb,'OZON_IMPORT_PARTIAL_FAILED',$15,6)`, [
      jobId, sku, OZON_DEFAULT_STORE_ID, publicationId, credentialVersionId, taskId, JSON.stringify([offerId]),
      offerContractHash, materializationHash, productId, `processing/${taskId}`, directorySignature,
      JSON.stringify({
        schemaVersion: 3, mode: 'MULTISTORE_PUBLICATION', offerContractHash,
        importIntent: {
          schemaVersion: 2, phase: 'TASK_ID_BOUND', requestId: `import:${jobId}:r6`,
          payloadHash: `sha256:${'7'.repeat(64)}`, importTaskId: '5389881966', offerIds: [offerId], attempt: 1
        }
      }), JSON.stringify({ import: 'FAILED', price: 'PENDING', stock: 'PENDING' }), errorMessage
    ]);
    await admin.query(`INSERT INTO ${schema}.ozon_product_mappings(
      store_alias,store_id,offer_id,sku,ozon_product_id,last_applied_revision,status
    ) VALUES('default',$1,$2,$3,$4,6,'imported')`, [OZON_DEFAULT_STORE_ID, offerId, sku, productId]);
    for (const operation of ['importProduct', 'importInfo']) {
      await admin.query(`INSERT INTO ${schema}.ozon_gateway_requests(
        request_ref,request_hash,task_id,publication_id,store_id,credential_version_id,operation,
        delivery_state,retry_class,status_code,response_json,credential_binding_mode,payload_hash,delegation_state
      ) VALUES($1,$2,$3,$4,$5,$6,$7,'RESPONDED','NONE',200,'{}'::jsonb,'VAULT',$8,'RECEIPT_RECORDED')`, [
        `${taskId}:${operation}`, `sha256:${operation === 'importProduct' ? '4' : '5'}`.padEnd(71, operation === 'importProduct' ? '4' : '5'),
        taskId, publicationId, OZON_DEFAULT_STORE_ID, credentialVersionId, operation, `sha256:${'6'.repeat(64)}`
      ]);
    }

    const dryRun = await stores.recoverImportNoBrandFailure(publicationId, {
      publicationRowVersion: 6, jobRowVersion: 6, dryRun: true
    });
    expect(dryRun).toMatchObject({ status: 'DRY_RUN', dryRun: true, jobId, jobRowVersion: 6 });
    expect(dryRun.checks).toMatchObject({
      importProductCount: 1, importInfoCount: 1, pricesWriteCount: 0, stocksWriteCount: 0,
      offerIds: [offerId], productIds: [productId]
    });

    const recovered = await stores.recoverImportNoBrandFailure(publicationId, {
      publicationRowVersion: 6, jobRowVersion: 6, dryRun: false
    });
    expect(recovered).toMatchObject({ status: 'RECOVERED', dryRun: false, jobRowVersion: 7 });
    const after = (await admin.query(`SELECT j.state,j.row_version,j.import_task_id,j.last_error_code,j.payload,
      p.status publication_status,p.row_version publication_row_version,p.error_code publication_error_code
      FROM ${schema}.ozon_publish_jobs j JOIN ${schema}.ozon_store_publications p ON p.id=j.publication_id
      WHERE j.id=$1`, [jobId])).rows[0];
    expect(after).toMatchObject({
      state: 'UPLOADING_MEDIA', row_version: 7, import_task_id: null, last_error_code: null,
      publication_status: 'RUNNING', publication_row_version: 7, publication_error_code: ''
    });
    expect(after.payload.importNoBrandRecovery).toMatchObject({
      reason: 'IMPORTED_PRODUCT_NO_BRAND_ATTRIBUTE_REJECTED', importProductReachable: true,
      recoveryAttempt: 1, previousImportTaskId: '5389881966', offerIds: [offerId], productIds: [productId]
    });
    expect(after.payload.importIntent).toMatchObject({
      requestId: `import:${jobId}:r6:no-brand:1`, phase: 'RETRY_ALLOWED', importTaskId: null
    });
    expect(after.payload.importTaskId).toBeNull();

    await expect(stores.recoverImportNoBrandFailure(publicationId, {
      publicationRowVersion: 7, jobRowVersion: 7, dryRun: false
    })).resolves.toMatchObject({ status: 'ALREADY_RECOVERED', jobRowVersion: 7 });

    await admin.query(`UPDATE ${schema}.ozon_publish_jobs SET
      state='NEEDS_ATTENTION',last_error_code='OZON_PLATFORM_STATUS_ABNORMAL',
      last_error_message='{"abnormalOfferIds":["0000122-01"]}',
      payload=jsonb_set(payload,'{importTaskId}',to_jsonb('5389881966'::text),true),row_version=9
      WHERE id=$1`, [jobId]);
    await admin.query(`UPDATE ${schema}.ozon_store_publications SET
      status='NEEDS_ATTENTION',error_code='OZON_PLATFORM_STATUS_ABNORMAL',
      error_message='{"abnormalOfferIds":["0000122-01"]}',row_version=8 WHERE id=$1`, [publicationId]);

    await expect(stores.recoverImportNoBrandFailure(publicationId, {
      publicationRowVersion: 8, jobRowVersion: 9, dryRun: true
    })).resolves.toMatchObject({ status: 'DRY_RUN', jobRowVersion: 9 });
    await expect(stores.recoverImportNoBrandFailure(publicationId, {
      publicationRowVersion: 8, jobRowVersion: 9, dryRun: false
    })).resolves.toMatchObject({ status: 'RECOVERED', jobRowVersion: 10 });
    const rearmed = (await admin.query(`SELECT state,row_version,payload FROM ${schema}.ozon_publish_jobs WHERE id=$1`, [jobId])).rows[0];
    expect(rearmed).toMatchObject({ state: 'UPLOADING_MEDIA', row_version: 10 });
    expect(rearmed.payload).toMatchObject({
      importTaskId: null,
      importNoBrandRecovery: { rearmCount: 1, recoveryRequestId: `import:${jobId}:r6:no-brand:1` }
    });
    await expect(stores.recoverImportNoBrandFailure(publicationId, {
      publicationRowVersion: 9, jobRowVersion: 10, dryRun: false
    })).resolves.toMatchObject({ status: 'ALREADY_RECOVERED', jobRowVersion: 10 });
  });
});
