import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { OZON_DEFAULT_STORE_ID } from '@n8n-media-review/shared';
import { OzonStoreRepository } from './ozon-stores.js';
import { OzonRepository } from './ozon.js';

const connectionString = process.env.DATABASE_URL;
const schema = `ozon_duplicate_card_recovery_${randomUUID().replaceAll('-', '')}`;
let admin: Pool;
let stores: OzonStoreRepository;

describe.runIf(Boolean(connectionString))('OZON duplicate-card recovery PostgreSQL', () => {
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

  it('persists mixed platform evidence and idempotently stops only the automation flow', async () => {
    const sku = '0000171';
    const offerIds = ['0000171-01', '0000171-02'];
    const generatedVersionId = randomUUID();
    const credentialVersionId = randomUUID();
    const publicationId = randomUUID();
    const jobId = randomUUID();
    const taskId = `default__${sku}__r4`;
    const offerContractHash = `sha256:${'1'.repeat(64)}`;
    const materializationHash = `sha256:${'2'.repeat(64)}`;
    const duplicateMessage = 'OZON 判定 0000171-01 与已有商品卡 0000143-01 类似或重复';
    const importFailures = [{
      offer_id: offerIds[0],
      errors: [{ code: 'SPU_ALREADY_EXISTS_IN_ANOTHER_ACCOUNT', message: duplicateMessage }]
    }];

    await admin.query(`INSERT INTO ${schema}.products(sku,product_name,created_at) VALUES($1,'Product',NOW())`, [sku]);
    await admin.query(`INSERT INTO ${schema}.ozon_listing_drafts(sku,product_name_snapshot,status,row_version)
      VALUES($1,'Product','MODERATING',4)`, [sku]);
    await admin.query(`INSERT INTO ${schema}.ozon_listing_versions(id,sku,revision,snapshot)
      VALUES($1,$2,4,$3::jsonb)`, [generatedVersionId, sku, JSON.stringify({
      sku, productName: 'Product', status: 'MODERATING', rowVersion: 4, revision: 4,
      data: { offers: offerIds.map((offerId) => ({ offerId, media: [] })) }
    })]);
    await admin.query(`INSERT INTO ${schema}.ozon_store_credential_versions(
      id,store_id,version_no,status,ciphertext,nonce,auth_tag,fingerprint
    ) VALUES($1,$2,1,'ACTIVE','cipher','nonce','tag',$3)`, [credentialVersionId, OZON_DEFAULT_STORE_ID, 'a'.repeat(64)]);
    await admin.query(`INSERT INTO ${schema}.ozon_store_publications(
      id,sku,generated_version_id,revision,store_id,store_alias_snapshot,status,source,
      credential_binding_mode,credential_version_id,store_config_version,task_id,warehouse_id,
      offer_ids,offer_contract_hash,materialization_hash,error_code,error_message,row_version
    ) VALUES($1,$2,$3,4,$4,'default','NEEDS_ATTENTION','AUTOMATION','VAULT',$5,1,$6,'1020002456503000',
      $7::jsonb,$8,$9,'OZON_IMPORT_PARTIAL_FAILED',$10,6)`, [
      publicationId, sku, generatedVersionId, OZON_DEFAULT_STORE_ID, credentialVersionId, taskId,
      JSON.stringify(offerIds), offerContractHash, materializationHash, duplicateMessage
    ]);
    await admin.query(`INSERT INTO ${schema}.ozon_publish_jobs(
      id,sku,state,source,task_kind,store_alias,store_id,publication_id,credential_binding_mode,
      credential_version_id,store_config_version,warehouse_id,task_id,listing_revision,offer_ids,
      offer_contract_hash,materialization_hash,import_task_id,payload,stage_states,last_error_code,last_error_message,row_version
    ) VALUES($1,$2,'NEEDS_ATTENTION','AUTO','STORE_PUBLICATION','default',$3,$4,'VAULT',$5,1,
      '1020002456503000',$6,4,$7::jsonb,$8,$9,'5570342576',$10::jsonb,$11::jsonb,
      'OZON_IMPORT_PARTIAL_FAILED',$12,6)`, [
      jobId, sku, OZON_DEFAULT_STORE_ID, publicationId, credentialVersionId, taskId,
      JSON.stringify(offerIds), offerContractHash, materializationHash,
      JSON.stringify({ importFailures }), JSON.stringify({ import: 'FAILED', moderation: 'FAILED' }), duplicateMessage
    ]);

    const refreshRequestId = randomUUID();
    const readback = await stores.beginPublicationReadback(publicationId, 6, refreshRequestId);
    const readAt = '2026-09-05T11:00:00.000Z';
    const refreshed = await stores.completePublicationReadback({
      publicationId,
      dispatchRowVersion: readback.dispatchRowVersion,
      requestRef: readback.requestRef,
      operationRequestId: refreshRequestId,
      readAt,
      businessState: 'NEEDS_ATTENTION',
      offers: [
        {
          offerId: offerIds[0]!, ozonProductId: '6235951347', ozonSku: '5235951347',
          displayState: 'ARCHIVED', businessState: 'NEEDS_ATTENTION', readAt,
          missingConfirmationCount: 0, confirmed: true, hasStock: false,
          platformMessage: 'Убран из продажи'
        },
        {
          offerId: offerIds[1]!, ozonProductId: '6235951166', ozonSku: '5235951166',
          displayState: 'ON_SALE', businessState: 'PUBLISHED', readAt,
          missingConfirmationCount: 0, confirmed: true, hasStock: true
        }
      ],
      warnings: [],
      stageStates: { import: 'FAILED', moderation: 'NEEDS_ATTENTION', images: 'VERIFIED', video: 'VERIFIED', price: 'VERIFIED', stock: 'VERIFIED' }
    });
    expect(refreshed).toMatchObject({ status: 'NEEDS_ATTENTION', rowVersion: 8 });

    const afterRefresh = (await admin.query(`SELECT j.state,j.row_version,j.payload,j.product_links,j.last_error_code,j.last_error_message,
      p.status publication_status,p.row_version publication_row_version,p.product_links publication_product_links,
      p.error_code publication_error_code,p.error_message publication_error_message
      FROM ${schema}.ozon_publish_jobs j JOIN ${schema}.ozon_store_publications p ON p.id=j.publication_id
      WHERE j.id=$1`, [jobId])).rows[0];
    expect(afterRefresh).toMatchObject({
      state: 'NEEDS_ATTENTION', row_version: 8,
      last_error_code: 'OZON_IMPORT_PARTIAL_FAILED', last_error_message: duplicateMessage,
      publication_status: 'NEEDS_ATTENTION', publication_row_version: 8,
      publication_error_code: 'OZON_IMPORT_PARTIAL_FAILED', publication_error_message: duplicateMessage
    });
    expect(afterRefresh.payload.importFailures).toEqual(importFailures);
    expect(afterRefresh.product_links).toEqual(expect.arrayContaining([
      expect.objectContaining({ offerId: offerIds[0], displayState: 'ARCHIVED' }),
      expect.objectContaining({ offerId: offerIds[1], displayState: 'ON_SALE' })
    ]));
    expect(afterRefresh.publication_product_links).toEqual(afterRefresh.product_links);

    const mappings = (await admin.query(`SELECT offer_id,status,status_snapshot FROM ${schema}.ozon_product_mappings
      WHERE store_id=$1 AND sku=$2 ORDER BY offer_id`, [OZON_DEFAULT_STORE_ID, sku])).rows;
    expect(mappings.map((mapping) => [mapping.offer_id, mapping.status, mapping.status_snapshot.hasStock])).toEqual([
      [offerIds[0], 'ARCHIVED', false],
      [offerIds[1], 'ON_SALE', true]
    ]);

    await admin.query(`UPDATE ${schema}.ozon_publish_jobs SET lease_owner='test',lease_token=$2,
      lease_expires_at=NOW()+INTERVAL '10 minutes' WHERE id=$1`, [jobId, randomUUID()]);
    await expect(stores.stopPublicationAutomation(publicationId, 8, randomUUID())).rejects.toMatchObject({
      code: 'OZON_AUTOMATION_STOP_BLOCKED', details: expect.objectContaining({ blockers: expect.arrayContaining(['runtimeLease']) })
    });
    await admin.query(`UPDATE ${schema}.ozon_publish_jobs SET lease_owner=NULL,lease_token=NULL,lease_expires_at=NULL,
      payload=jsonb_set(payload,'{networkRecovery}','{"deliveryState":"UNKNOWN"}'::jsonb,true) WHERE id=$1`, [jobId]);
    await expect(stores.stopPublicationAutomation(publicationId, 8, randomUUID())).rejects.toMatchObject({
      code: 'OZON_AUTOMATION_STOP_BLOCKED', details: expect.objectContaining({ blockers: expect.arrayContaining(['unknownDelivery']) })
    });
    await admin.query(`UPDATE ${schema}.ozon_publish_jobs SET payload=payload-'networkRecovery' WHERE id=$1`, [jobId]);

    const stopRequestId = randomUUID();
    const stopped = await stores.stopPublicationAutomation(publicationId, 8, stopRequestId);
    expect(stopped).toMatchObject({ status: 'CANCELLED', rowVersion: 9 });
    await expect(stores.stopPublicationAutomation(publicationId, 8, stopRequestId))
      .resolves.toMatchObject({ status: 'CANCELLED', rowVersion: 9 });
    await expect(stores.stopPublicationAutomation(publicationId, 8, randomUUID()))
      .rejects.toMatchObject({ code: 'VERSION_CONFLICT' });

    const closed = (await admin.query(`SELECT j.state,j.payload,j.product_links,j.last_error_code,
      p.status publication_status,p.result_json,p.product_links publication_product_links,p.error_code publication_error_code
      FROM ${schema}.ozon_publish_jobs j JOIN ${schema}.ozon_store_publications p ON p.id=j.publication_id
      WHERE j.id=$1`, [jobId])).rows[0];
    expect(closed).toMatchObject({
      state: 'CANCELLED', last_error_code: 'OZON_IMPORT_PARTIAL_FAILED',
      publication_status: 'CANCELLED', publication_error_code: 'OZON_IMPORT_PARTIAL_FAILED'
    });
    expect(closed.payload.operatorClosure).toMatchObject({ requestId: stopRequestId, platformMutation: false });
    expect(closed.result_json.operatorClosure).toMatchObject({ requestId: stopRequestId, platformMutation: false });
    expect(closed.product_links).toEqual(afterRefresh.product_links);
    expect(closed.publication_product_links).toEqual(afterRefresh.product_links);
    const stopEvent = (await admin.query(`SELECT payload FROM ${schema}.ozon_publish_events
      WHERE job_id=$1 AND event_type='PUBLICATION_AUTOMATION_STOPPED'`, [jobId])).rows[0];
    expect(stopEvent.payload).toMatchObject({ requestId: stopRequestId, platformMutation: false });
  });
});
