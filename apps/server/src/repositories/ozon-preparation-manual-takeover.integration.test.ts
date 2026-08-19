import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { OZON_DEFAULT_STORE_ID } from '@n8n-media-review/shared';
import { OzonRepository } from './ozon.js';
import { OzonStoreRepository } from './ozon-stores.js';

const connectionString = process.env.DATABASE_URL;
const schema = `ozon_manual_takeover_${randomUUID().replaceAll('-', '')}`;
let admin: Pool;
let repository: OzonRepository;
let stores: OzonStoreRepository;

describe.runIf(Boolean(connectionString))('OZON automatic preparation manual takeover PostgreSQL', () => {
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
    repository = new OzonRepository(isolatedUrl.toString());
    await repository.initialize();
    stores = new OzonStoreRepository(isolatedUrl.toString());
    await stores.initialize();
  });

  afterAll(async () => {
    await stores?.close();
    await repository?.close();
    await admin?.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin?.end();
  });

  it('atomically moves an exact local failed preparation to manual ownership without platform artifacts', async () => {
    const sku = '0000121';
    const jobId = '096f4dec-b56b-43f8-bfba-8bed0c8392a9';
    const variantId = '89b51b14-279c-4bf7-8510-e001ccc33fb5';
    const videoSubmissionId = '2ff225f7-fce2-4078-9408-8b454b6c979c';
    const imageSubmissionId = '0f43b6fd-48d7-407b-a2e9-3cf218600bd0';
    const data = {
      offers: [{
        offerId: '0000121-01',
        productVariantId: variantId,
        media: [{ assetId: 'video-1' }, { assetId: 'image-1' }]
      }],
      mediaAssets: [
        {
          assetId: 'video-1',sourceStageId: 'E004',sourceSubmissionId: videoSubmissionId,
          productVariantId: variantId,deliveredAt: '2026-08-12T01:31:31.419Z'
        },
        {
          assetId: 'image-1',sourceStageId: 'E005',sourceSubmissionId: imageSubmissionId,
          productVariantId: variantId,deliveredAt: '2026-08-12T01:31:43.292Z'
        }
      ]
    };
    await admin.query(`INSERT INTO ${schema}.ozon_listing_drafts(
      sku,product_name_snapshot,management_source,status,row_version,revision,data
    ) VALUES($1,'测试商品','AUTO','READY',3,3,$2::jsonb)`, [sku, JSON.stringify(data)]);
    await admin.query(`INSERT INTO ${schema}.ozon_publish_jobs(
      id,sku,state,source,payload,stage_states,row_version,store_alias,store_id,
      credential_binding_mode,store_config_version,directory_stage,work_rel_path
    ) VALUES($1,$2,'NEEDS_ATTENTION','AUTO',$3::jsonb,$4::jsonb,7,'default',$5,'PURE_LEGACY',1,'INBOX',$6)`, [
      jobId,
      sku,
      JSON.stringify({ multistorePreparation: true, autoPreparedStartedWithoutListing: true }),
      JSON.stringify({ import: 'PENDING', moderation: 'PENDING', images: 'LOCAL_READY', video: 'LOCAL_READY', price: 'PENDING', stock: 'PENDING' }),
      OZON_DEFAULT_STORE_ID,
      `inbox/${sku}`
    ]);
    await admin.query(`INSERT INTO ${schema}.ozon_media_deliveries(
      sku,source_stage_id,submission_id,variant_id,job_id,payload
    ) VALUES
      ($1,'E004',$2,$4,$5,$6::jsonb),
      ($1,'E005',$3,$4,NULL,$7::jsonb)`, [
      sku,
      videoSubmissionId,
      imageSubmissionId,
      variantId,
      jobId,
      JSON.stringify({
        sourceStageId: 'E004',submissionId: videoSubmissionId,variantId,
        deliveredAt: '2026-08-12T01:31:31.469Z',autoPublishDecision: 'ACCEPTED'
      }),
      JSON.stringify({
        sourceStageId: 'E005',submissionId: imageSubmissionId,variantId,
        deliveredAt: '2026-08-12T01:31:43.329Z',autoPublishDecision: 'DEFERRED'
      })
    ]);

    await expect(repository.takeOverAutomaticPreparationForManual({
      jobId,sku,expectedJobRowVersion: 7,expectedListingRowVersion: 3
    })).resolves.toMatchObject({
      job: { id: jobId,state: 'CANCELLED',rowVersion: 8 },
      listing: { sku,managementSource: 'MANUAL',rowVersion: 4 }
    });

    const deliveries = await admin.query(`SELECT source_stage_id,job_id,payload
      FROM ${schema}.ozon_media_deliveries WHERE sku=$1 ORDER BY source_stage_id`, [sku]);
    expect(deliveries.rows).toHaveLength(2);
    expect(deliveries.rows.every((row) => row.job_id === null)).toBe(true);
    expect(deliveries.rows.every((row) => (
      row.payload.autoPublishDecision === 'IGNORED'
      && row.payload.autoPublishIgnoredReason === 'MANUAL_TAKEOVER'
      && row.payload.manualTakeoverJobId === jobId
    ))).toBe(true);
    const event = await admin.query(`SELECT event_type,from_state,to_state FROM ${schema}.ozon_publish_events
      WHERE job_id=$1 AND event_type='AUTOMATIC_PREPARATION_TAKEN_OVER_MANUALLY'`, [jobId]);
    expect(event.rows).toEqual([{
      event_type: 'AUTOMATIC_PREPARATION_TAKEN_OVER_MANUALLY',
      from_state: 'NEEDS_ATTENTION',
      to_state: 'CANCELLED'
    }]);
    await expect(repository.listListings({ source: 'MANUAL', query: sku })).resolves.toMatchObject({
      total: 1,items: [expect.objectContaining({ sku,managementSource: 'MANUAL' })]
    });
    await expect(repository.listListings({ source: 'AUTO', query: sku })).resolves.toMatchObject({ total: 0,items: [] });
  });
});
