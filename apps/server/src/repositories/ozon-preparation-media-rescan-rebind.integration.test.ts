import { createHash, randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { OZON_DEFAULT_STORE_ID } from '@n8n-media-review/shared';
import { OzonRepository } from './ozon.js';
import { OzonStoreRepository } from './ozon-stores.js';

const connectionString = process.env.DATABASE_URL;
const schema = `ozon_media_rescan_rebind_${randomUUID().replaceAll('-', '')}`;
let admin: Pool;
let repository: OzonRepository;
let stores: OzonStoreRepository;

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`).join(',')}}`;
  return JSON.stringify(value);
}

describe.runIf(Boolean(connectionString))('OZON automatic preparation media-rescan rebound PostgreSQL', () => {
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

  async function seed(input: { sku: string; jobId: string; changePrice?: boolean }) {
    const variantId = randomUUID();
    const videoSubmissionId = randomUUID();
    const imageSubmissionId = randomUUID();
    const priorData = {
      currency: 'CNY',
      offers: [{
        offerId: `${input.sku}-01`,productVariantId: variantId,price: 456.78,stock: 1,
        media: [{ assetId: 'image-1' }, { assetId: 'video-1' }]
      }],
      mediaAssets: [
        {
          assetId: 'image-1',kind: 'image',relativePath: 'images/01.png',sha256: 'a'.repeat(64),sortOrder: 0,
          sourceStageId: 'E005',sourceSubmissionId: imageSubmissionId,productVariantId: variantId,
          deliveredAt: '2026-08-12T01:31:43.292Z',modifiedAt: '2026-08-12T01:31:43.300Z'
        },
        {
          assetId: 'video-1',kind: 'video',relativePath: 'videos/01.mp4',sha256: 'b'.repeat(64),sortOrder: 0,
          sourceStageId: 'E004',sourceSubmissionId: videoSubmissionId,productVariantId: variantId,
          deliveredAt: '2026-08-12T01:31:31.419Z',modifiedAt: '2026-08-12T01:31:31.430Z',durationSeconds: 12.1
        }
      ]
    };
    const currentData = structuredClone(priorData);
    currentData.mediaAssets.reverse();
    currentData.mediaAssets[0]!.modifiedAt = '2026-08-12T01:32:00.000Z';
    currentData.mediaAssets[0]!.durationSeconds = 12.2;
    currentData.mediaAssets[1]!.modifiedAt = '2026-08-12T01:32:00.001Z';
    if (input.changePrice) currentData.offers[0]!.price = 999;
    const signature = `sha256:${createHash('sha256').update(stableJson(priorData)).digest('hex')}`;
    await admin.query(`INSERT INTO ${schema}.ozon_listing_drafts(
      sku,product_name_snapshot,management_source,status,row_version,revision,data
    ) VALUES($1,'测试商品','AUTO','READY',3,3,$2::jsonb)`, [input.sku, JSON.stringify(currentData)]);
    await admin.query(`INSERT INTO ${schema}.ozon_listing_versions(id,sku,revision,snapshot)
      VALUES($1,$2,2,$3::jsonb)`, [randomUUID(), input.sku, JSON.stringify({ revision: 2,row_version: 2,data: priorData })]);
    await admin.query(`INSERT INTO ${schema}.ozon_publish_jobs(
      id,sku,state,source,payload,stage_states,row_version,store_alias,store_id,
      credential_binding_mode,store_config_version,directory_stage,work_rel_path,offer_ids,last_error_code,last_error_message
    ) VALUES($1,$2,'NEEDS_ATTENTION','AUTO',$3::jsonb,$4::jsonb,7,'default',$5,'PURE_LEGACY',1,'INBOX',$6,$7::jsonb,
      'OZON_MEDIA_DELIVERY_IDENTITY_DRIFT','媒体时间戳不一致')`, [
      input.jobId,
      input.sku,
      JSON.stringify({
        multistorePreparation: true,
        autoPreparedStartedWithoutListing: true,
        autoPreparedByJobId: input.jobId,
        autoPreparedMode: 'COMPATIBLE_UPSERT',
        autoPreparedListingRevision: 2,
        autoPreparedListingRowVersion: 2,
        autoPreparedListingDataSignature: signature,
        offerIds: [`${input.sku}-01`],
        expectedOfferIds: [`${input.sku}-01`],
        submittedOfferIds: [`${input.sku}-01`],
        publishOfferIds: [`${input.sku}-01`],
        mediaDeliveries: [{ sourceStageId: 'E004',submissionId: videoSubmissionId,variantId }]
      }),
      JSON.stringify({ import: 'PENDING',moderation: 'PENDING',images: 'LOCAL_READY',video: 'LOCAL_READY',price: 'PENDING',stock: 'PENDING' }),
      OZON_DEFAULT_STORE_ID,
      `inbox/${input.sku}`,
      JSON.stringify([`${input.sku}-01`])
    ]);
    await admin.query(`INSERT INTO ${schema}.ozon_media_deliveries(
      sku,source_stage_id,submission_id,variant_id,job_id,payload
    ) VALUES
      ($1,'E004',$2,$4,$5,$6::jsonb),
      ($1,'E005',$3,$4,NULL,$7::jsonb)`, [
      input.sku,
      videoSubmissionId,
      imageSubmissionId,
      variantId,
      input.jobId,
      JSON.stringify({ sourceStageId: 'E004',submissionId: videoSubmissionId,variantId,deliveredAt: '2026-08-12T01:31:31.469Z',autoPublishDecision: 'ACCEPTED' }),
      JSON.stringify({ sourceStageId: 'E005',submissionId: imageSubmissionId,variantId,deliveredAt: '2026-08-12T01:31:43.329Z',autoPublishDecision: 'DEFERRED' })
    ]);
  }

  it('rebounds one exact automatic media rescan and preserves the original preparation job', async () => {
    const jobId = randomUUID();
    await seed({ sku: '0000121',jobId });

    await expect(repository.rebindAutomaticPreparationAfterMediaRescan({
      jobId,expectedJobRowVersion: 7
    })).resolves.toMatchObject({
      id: jobId,state: 'READY',rowVersion: 8,
      payload: expect.objectContaining({
        autoPreparedListingRevision: 3,
        autoPreparedListingRowVersion: 3,
        autoPreparedMediaRescanRecovery: expect.objectContaining({ previousRevision: 2,listingRevision: 3,deliveryCount: 2 })
      })
    });
    const event = await admin.query(`SELECT event_type,from_state,to_state FROM ${schema}.ozon_publish_events
      WHERE job_id=$1 AND event_type='AUTOMATIC_PREPARATION_REBOUND_AFTER_MEDIA_RESCAN'`, [jobId]);
    expect(event.rows).toEqual([{
      event_type: 'AUTOMATIC_PREPARATION_REBOUND_AFTER_MEDIA_RESCAN',
      from_state: 'NEEDS_ATTENTION',
      to_state: 'READY'
    }]);
  });

  it('rejects a business-field edit even when the media identities are unchanged', async () => {
    const jobId = randomUUID();
    await seed({ sku: '0000122',jobId,changePrice: true });

    await expect(repository.rebindAutomaticPreparationAfterMediaRescan({
      jobId,expectedJobRowVersion: 7
    })).rejects.toMatchObject({ code: 'VERSION_CONFLICT' });
    await expect(repository.getJob(jobId)).resolves.toMatchObject({ state: 'NEEDS_ATTENTION',rowVersion: 7 });
  });
});
