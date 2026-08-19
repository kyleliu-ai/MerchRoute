import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { OZON_DEFAULT_STORE_ID } from '@n8n-media-review/shared';
import { OzonStoreRepository } from './ozon-stores.js';
import { OzonRepository } from './ozon.js';

const connectionString = process.env.DATABASE_URL;
const schema = `ozon_represented_media_${randomUUID().replaceAll('-', '')}`;
let admin: Pool;
let stores: OzonStoreRepository;

describe.runIf(Boolean(connectionString))('OZON represented media fan-out reconciliation PostgreSQL', () => {
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

  it('dry-runs, atomically closes, and idempotently replays from both original and current row versions without reading r3', async () => {
    const fixture = await insertFixture('0000118');
    const dryRun = await stores.reconcileRepresentedMediaFanoutPreparation({
      jobId: fixture.targetJobId, expectedRowVersion: 2, dryRun: true
    });
    expect(dryRun).toMatchObject({
      status: 'DRY_RUN', dryRun: true, generatedVersionId: fixture.versionId,
      publicationIds: [...fixture.publicationIds].sort(), storeIds: [...fixture.storeIds].sort(),
      rowVersionBefore: 2, rowVersionAfter: 2
    });
    const beforeApply = await admin.query(`SELECT state,row_version,last_error_code,payload
      FROM ${schema}.ozon_publish_jobs WHERE id=$1`, [fixture.targetJobId]);
    expect(beforeApply.rows[0]).toMatchObject({ state: 'NEEDS_ATTENTION', row_version: 2, last_error_code: 'OZON_MANUAL_DRAFT_PRESENT' });
    expect(beforeApply.rows[0].payload.representedMediaFanoutReconciliation).toBeUndefined();

    const applied = await stores.reconcileRepresentedMediaFanoutPreparation({
      jobId: fixture.targetJobId, expectedRowVersion: 2, dryRun: false
    });
    expect(applied).toMatchObject({ status: 'RECONCILED', rowVersionBefore: 2, rowVersionAfter: 3 });
    const after = await admin.query(`SELECT state,row_version,last_error_code,last_error_message,lease_owner,lease_token,
        lease_expires_at,finished_at,payload FROM ${schema}.ozon_publish_jobs WHERE id=$1`, [fixture.targetJobId]);
    expect(after.rows[0]).toMatchObject({
      state: 'SUCCEEDED', row_version: 3, last_error_code: null, last_error_message: null,
      lease_owner: null, lease_token: null, lease_expires_at: null
    });
    expect(after.rows[0].finished_at).toBeTruthy();
    expect(after.rows[0].payload.representedMediaFanoutReconciliation).toMatchObject({
      completed: true, expectedRowVersion: 2, generatedVersionId: fixture.versionId,
      publicationIds: [...fixture.publicationIds].sort(), storeIds: [...fixture.storeIds].sort()
    });
    const ledger = await admin.query(`SELECT payload FROM ${schema}.ozon_media_deliveries
      WHERE sku=$1 AND source_stage_id='E005'`, [fixture.sku]);
    expect(ledger.rows[0].payload).toMatchObject({
      autoPublishDecision: 'FANNED_OUT', fanoutGeneratedVersionId: fixture.versionId,
      fanoutPublicationIds: [...fixture.publicationIds].sort(), fanoutStoreIds: [...fixture.storeIds].sort()
    });
    const consumptions = await admin.query(`SELECT store_id,decision,publication_id,job_id
      FROM ${schema}.ozon_store_media_consumptions WHERE sku=$1 AND source_stage_id='E005' ORDER BY store_id`, [fixture.sku]);
    expect(consumptions.rows).toHaveLength(2);
    expect(consumptions.rows.every((row) => row.decision === 'ALREADY_BOUND')).toBe(true);
    const events = await admin.query(`SELECT event_type FROM ${schema}.ozon_publish_events
      WHERE job_id=$1 AND event_type='MULTISTORE_REPRESENTED_MEDIA_RECONCILED'`, [fixture.targetJobId]);
    expect(events.rows).toHaveLength(1);

    await expect(stores.reconcileRepresentedMediaFanoutPreparation({
      jobId: fixture.targetJobId, expectedRowVersion: 2, dryRun: false
    })).resolves.toMatchObject({ status: 'ALREADY_RECONCILED', rowVersionAfter: 3, evidenceHash: applied.evidenceHash });
    await expect(stores.reconcileRepresentedMediaFanoutPreparation({
      jobId: fixture.targetJobId, expectedRowVersion: 3, dryRun: false
    })).resolves.toMatchObject({ status: 'ALREADY_RECONCILED', rowVersionAfter: 3, evidenceHash: applied.evidenceHash });
    const eventCount = await admin.query(`SELECT COUNT(*)::int count FROM ${schema}.ozon_publish_events
      WHERE job_id=$1 AND event_type='MULTISTORE_REPRESENTED_MEDIA_RECONCILED'`, [fixture.targetJobId]);
    expect(eventCount.rows[0].count).toBe(1);
  });

  it('fails closed and rolls back every table when immutable offer.media does not reference the delivery asset', async () => {
    const fixture = await insertFixture('0000117', { omitTargetOfferReference: true });
    await expect(stores.reconcileRepresentedMediaFanoutPreparation({
      jobId: fixture.targetJobId, expectedRowVersion: 2, dryRun: false
    })).rejects.toMatchObject({ code: 'VERSION_CONFLICT' });
    const state = await admin.query(`SELECT state,row_version,last_error_code FROM ${schema}.ozon_publish_jobs WHERE id=$1`, [fixture.targetJobId]);
    expect(state.rows[0]).toMatchObject({ state: 'NEEDS_ATTENTION', row_version: 2, last_error_code: 'OZON_MANUAL_DRAFT_PRESENT' });
    const ledger = await admin.query(`SELECT payload->>'autoPublishDecision' decision FROM ${schema}.ozon_media_deliveries
      WHERE sku=$1 AND source_stage_id='E005'`, [fixture.sku]);
    expect(ledger.rows[0].decision).toBe('ACCEPTED');
    const consumptions = await admin.query(`SELECT COUNT(*)::int count FROM ${schema}.ozon_store_media_consumptions
      WHERE sku=$1 AND source_stage_id='E005'`, [fixture.sku]);
    expect(consumptions.rows[0].count).toBe(0);
  });

  it('rolls back an already-updated global ledger when a store consumption is bound to another job', async () => {
    const fixture = await insertFixture('0000116');
    await admin.query(`INSERT INTO ${schema}.ozon_store_media_consumptions(
      store_id,sku,source_stage_id,submission_id,variant_id,decision,publication_id,job_id,reason
    ) VALUES($1,$2,'E005',$3,$4,'STALE',NULL,$5,'conflicting owner')`, [
      OZON_DEFAULT_STORE_ID, fixture.sku, fixture.targetSubmissionId, fixture.variantId, fixture.anchorJobId
    ]);
    await expect(stores.reconcileRepresentedMediaFanoutPreparation({
      jobId: fixture.targetJobId, expectedRowVersion: 2, dryRun: false
    })).rejects.toMatchObject({ code: 'TASK_LOCKED' });
    const state = await admin.query(`SELECT state,row_version FROM ${schema}.ozon_publish_jobs WHERE id=$1`, [fixture.targetJobId]);
    expect(state.rows[0]).toMatchObject({ state: 'NEEDS_ATTENTION', row_version: 2 });
    const ledger = await admin.query(`SELECT payload->>'autoPublishDecision' decision FROM ${schema}.ozon_media_deliveries
      WHERE sku=$1 AND source_stage_id='E005'`, [fixture.sku]);
    expect(ledger.rows[0].decision).toBe('ACCEPTED');
    const conflicting = await admin.query(`SELECT decision,publication_id,job_id FROM ${schema}.ozon_store_media_consumptions
      WHERE store_id=$1 AND sku=$2 AND source_stage_id='E005'`, [OZON_DEFAULT_STORE_ID, fixture.sku]);
    expect(conflicting.rows[0]).toMatchObject({ decision: 'STALE', publication_id: null, job_id: fixture.anchorJobId });
  });

  async function insertFixture(sku: string, options: { omitTargetOfferReference?: boolean } = {}) {
    const variantId = randomUUID();
    const targetSubmissionId = randomUUID();
    const anchorSubmissionId = randomUUID();
    const targetJobId = randomUUID();
    const anchorJobId = randomUUID();
    const versionId = randomUUID();
    const secondStoreId = randomUUID();
    const publicationIds = [randomUUID(), randomUUID()].sort();
    const publicationJobIds = [randomUUID(), randomUUID()];
    const storeIds = [OZON_DEFAULT_STORE_ID, secondStoreId].sort();
    const offerId = `${sku}-01`;
    const targetAssetId = 'a'.repeat(64);
    const anchorAssetId = 'b'.repeat(64);
    const accepted = {
      sourceStageId: 'E005', submissionId: targetSubmissionId, variantId,
      selectedRelativePaths: ['01.png'], deliveredAt: '2026-08-11T13:33:45.002Z',
      autoPublishDecision: 'ACCEPTED', autoPublishAcceptedAt: '2026-08-11T13:33:45.432Z',
      autoPublishAcceptanceId: randomUUID(), autoPublishAcceptedByJobId: targetJobId,
      autoPublishAcceptedPresetId: randomUUID(), autoPublishAcceptedDefinitionHash: `sha256:${'c'.repeat(64)}`,
      autoPublishAcceptedPresetRowVersion: 18, autoPublishAcceptedSettingsRowVersion: 33
    };
    const anchor = {
      sourceStageId: 'E004', submissionId: anchorSubmissionId, variantId,
      selectedRelativePaths: ['video.mp4'], deliveredAt: '2026-08-11T13:33:40.000Z',
      autoPublishDecision: 'FANNED_OUT', fanoutPublicationIds: publicationIds, fanoutStoreIds: storeIds,
      fanoutCompletedAt: '2026-08-11T13:34:06.000Z'
    };
    const media = [
      ...(!options.omitTargetOfferReference ? [{ kind: 'image', assetId: targetAssetId, relativePath: `variants/color/images/${targetSubmissionId}/01.png`, sortOrder: 0 }] : []),
      { kind: 'video', assetId: anchorAssetId, relativePath: `variants/color/videos/${anchorSubmissionId}/video.mp4`, sortOrder: 1 }
    ];
    const snapshot = {
      sku, revision: 2,
      data: {
        offers: [{ offerId, productVariantId: variantId, media }],
        mediaAssets: [
          {
            assetId: targetAssetId, relativePath: `variants/color/images/${targetSubmissionId}/01.png`, kind: 'image', sortOrder: 0,
            mimeType: 'image/png', sizeBytes: 100, sha256: 'd'.repeat(64), modifiedAt: '2026-08-11T13:33:45.002Z',
            validationStatus: 'VALID', productVariantId: variantId, sourceStageId: 'E005', sourceSubmissionId: targetSubmissionId
          },
          {
            assetId: anchorAssetId, relativePath: `variants/color/videos/${anchorSubmissionId}/video.mp4`, kind: 'video', sortOrder: 0,
            mimeType: 'video/mp4', sizeBytes: 100, sha256: 'e'.repeat(64), modifiedAt: '2026-08-11T13:33:40.000Z',
            validationStatus: 'VALID', productVariantId: variantId, sourceStageId: 'E004', sourceSubmissionId: anchorSubmissionId
          }
        ]
      }
    };
    await admin.query(`INSERT INTO ${schema}.products(sku,product_name,created_at) VALUES($1,'Product',NOW())`, [sku]);
    await admin.query(`INSERT INTO ${schema}.ozon_listing_drafts(sku,product_name_snapshot,status,row_version,revision,data)
      VALUES($1,'Product','READY',99,3,$2::jsonb)`, [sku, JSON.stringify({ offers: [], mediaAssets: [] })]);
    await admin.query(`INSERT INTO ${schema}.ozon_listing_versions(id,sku,revision,snapshot)
      VALUES($1,$2,2,$3::jsonb)`, [versionId, sku, JSON.stringify(snapshot)]);
    await admin.query(`INSERT INTO ${schema}.ozon_stores(id,store_alias,display_name,credential_binding_mode)
      VALUES($1,$2,'Second','LEGACY_PUBLICATION')`, [secondStoreId, `store-${sku}`]);
    await admin.query(`INSERT INTO ${schema}.ozon_store_runtime_state(store_id) VALUES($1)`, [secondStoreId]);
    await admin.query(`INSERT INTO ${schema}.ozon_publish_jobs(
      id,sku,state,source,payload,row_version,store_id,store_alias,directory_stage,work_rel_path
    ) VALUES($1,$2,'SUCCEEDED','AUTO',$3::jsonb,9,$4,'default','INBOX',$5)`, [
      anchorJobId, sku, JSON.stringify({
        multistorePreparation: true,
        multistoreFanout: { completed: true, completedAt: anchor.fanoutCompletedAt, publicationIds, storeIds, failures: [] },
        mediaDeliveries: [anchor]
      }), OZON_DEFAULT_STORE_ID, `inbox/${sku}`
    ]);
    await admin.query(`INSERT INTO ${schema}.ozon_publish_jobs(
      id,sku,state,source,payload,row_version,store_id,store_alias,directory_stage,work_rel_path,last_error_code,last_error_message
    ) VALUES($1,$2,'NEEDS_ATTENTION','AUTO',$3::jsonb,2,$4,'default','INBOX',$5,
      'OZON_MANUAL_DRAFT_PRESENT','SKU has a manual draft')`, [
      targetJobId, sku, JSON.stringify({ multistorePreparation: true, mediaDeliveries: [accepted] }),
      OZON_DEFAULT_STORE_ID, `inbox/${sku}`
    ]);
    for (let index = 0; index < storeIds.length; index += 1) {
      const storeId = storeIds[index]!;
      const publicationId = publicationIds[index]!;
      const publicationJobId = publicationJobIds[index]!;
      const taskId = `${storeId === OZON_DEFAULT_STORE_ID ? 'default' : `store-${sku}`}__${sku}__r2`;
      await admin.query(`INSERT INTO ${schema}.ozon_store_publications(
        id,sku,generated_version_id,revision,store_id,store_alias_snapshot,status,source,credential_binding_mode,
        store_config_version,task_id,offer_ids,offer_contract_hash,materialization_hash,product_ids,ozon_skus,completed_at
      ) VALUES($1,$2,$3,2,$4,$5,'SUCCEEDED','AUTOMATION','LEGACY_PUBLICATION',1,$6,$7::jsonb,$8,$9,$10::jsonb,$11::jsonb,NOW())`, [
        publicationId, sku, versionId, storeId, storeId === OZON_DEFAULT_STORE_ID ? 'default' : `store-${sku}`,
        taskId, JSON.stringify([offerId]), `sha256:${'1'.repeat(64)}`, `sha256:${'2'.repeat(64)}`,
        JSON.stringify([String(5000 + index)]), JSON.stringify([String(6000 + index)])
      ]);
      await admin.query(`INSERT INTO ${schema}.ozon_publish_jobs(
        id,sku,state,source,task_id,store_id,store_alias,publication_id,listing_revision,offer_ids,
        offer_contract_hash,materialization_hash,directory_stage,work_rel_path,import_task_id,ozon_product_id,finished_at
      ) VALUES($1,$2,'SUCCEEDED','AUTO',$3,$4,$5,$6,2,$7::jsonb,$8,$9,'SUCCESS',$10,$11,$12,NOW())`, [
        publicationJobId, sku, taskId, storeId, storeId === OZON_DEFAULT_STORE_ID ? 'default' : `store-${sku}`,
        publicationId, JSON.stringify([offerId]), `sha256:${'1'.repeat(64)}`, `sha256:${'2'.repeat(64)}`,
        `success/2026-08-11/${taskId}`,
        String(7000 + index), String(5000 + index)
      ]);
      await admin.query(`INSERT INTO ${schema}.ozon_product_mappings(
        store_alias,store_id,offer_id,sku,ozon_product_id,ozon_sku,last_applied_revision,status
      ) VALUES($1,$2,$3,$4,$5,$6,2,'PUBLISHED')`, [
        storeId === OZON_DEFAULT_STORE_ID ? 'default' : `store-${sku}`, storeId, offerId, sku,
        String(5000 + index), String(6000 + index)
      ]);
    }
    await admin.query(`INSERT INTO ${schema}.ozon_media_deliveries(
      sku,source_stage_id,submission_id,variant_id,job_id,payload,received_at
    ) VALUES($1,'E004',$2,$3,$4,$5::jsonb,'2026-08-11T13:33:40Z'),
      ($1,'E005',$6,$3,$7,$8::jsonb,'2026-08-11T16:07:25Z')`, [
      sku, anchorSubmissionId, variantId, anchorJobId, JSON.stringify(anchor),
      targetSubmissionId, targetJobId, JSON.stringify(accepted)
    ]);
    return { sku, targetJobId, anchorJobId, targetSubmissionId, variantId, versionId, publicationIds, storeIds };
  }
});
