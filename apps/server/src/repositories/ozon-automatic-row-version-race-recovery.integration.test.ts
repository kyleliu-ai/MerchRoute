import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { OZON_DEFAULT_STORE_ID } from '@n8n-media-review/shared';
import { OzonRepository } from './ozon.js';
import { OzonStoreRepository } from './ozon-stores.js';

const connectionString = process.env.DATABASE_URL;
const schema = `ozon_row_race_${randomUUID().replaceAll('-', '')}`;
let admin: Pool;
let repository: OzonRepository;
let stores: OzonStoreRepository;

describe.runIf(Boolean(connectionString))('OZON automatic preparation row-version race recovery PostgreSQL', () => {
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

  async function seed(input: {
    sku: string;
    jobId?: string;
    expectedRowVersion?: number;
    actualRowVersion?: number;
    platformWriteAttempted?: boolean;
    listingPresent?: boolean;
    mappingPresent?: boolean;
    mediaOwnerDrift?: boolean;
    activeLease?: boolean;
    activeSlot?: boolean;
    activeStatusRefresh?: boolean;
    competingJob?: boolean;
  }) {
    const jobId = input.jobId || randomUUID();
    const expectedRowVersion = input.expectedRowVersion ?? 2;
    const actualRowVersion = input.actualRowVersion ?? 3;
    const videoSubmissionId = randomUUID();
    const imageSubmissionId = randomUUID();
    const variantId = randomUUID();
    const payload = {
      multistorePreparation: true,
      autoPreparedOwnershipInvalidatedAt: '2026-09-06T03:24:01.878Z',
      autoPreparedOwnershipInvalidatedReason: 'TASK_LOCKED',
      ...(input.platformWriteAttempted ? { platformWriteAttempted: true } : {}),
      mediaDeliveries: [
        { sourceStageId: 'E004',submissionId: videoSubmissionId,variantId },
        { sourceStageId: 'E005',submissionId: imageSubmissionId,variantId }
      ]
    };
    await admin.query(`INSERT INTO ${schema}.products(sku,product_name,created_at) VALUES($1,'测试商品',NOW())`, [input.sku]);
    await admin.query(`INSERT INTO ${schema}.product_variants(id,sku,name) VALUES($1,$2,'灰色')`, [variantId,input.sku]);
    await admin.query(`INSERT INTO ${schema}.ozon_publish_jobs(
      id,sku,state,source,payload,stage_states,row_version,store_alias,store_id,
      credential_binding_mode,store_config_version,last_error_code,last_error_message,task_kind
    ) VALUES($1,$2,'NEEDS_ATTENTION','AUTO',$3::jsonb,$4::jsonb,$5,'default',$6,
      'PURE_LEGACY',1,'TASK_LOCKED','OZON 自动准备任务已变化，请刷新后重试','SHARED_PREPARATION')`, [
      jobId,input.sku,JSON.stringify(payload),JSON.stringify({ images: 'LOCAL_READY',video: 'LOCAL_READY',import: 'PENDING',price: 'PENDING',stock: 'PENDING',moderation: 'PENDING' }),actualRowVersion + 1,OZON_DEFAULT_STORE_ID
    ]);
    const stoppedEventId = randomUUID();
    await admin.query(`INSERT INTO ${schema}.ozon_publish_events(
      id,job_id,event_type,from_state,to_state,message,payload,store_id
    ) VALUES($1,$2,'AUTOMATION_STOPPED','READY','NEEDS_ATTENTION','版本竞争',$3::jsonb,$4)`, [
      stoppedEventId,jobId,JSON.stringify({ errorDetails: { jobId,expectedRowVersion,actualRowVersion } }),OZON_DEFAULT_STORE_ID
    ]);
    await admin.query(`INSERT INTO ${schema}.ozon_media_deliveries(
      sku,source_stage_id,submission_id,variant_id,job_id,payload
    ) VALUES
      ($1,'E004',$2,$4,$5,$6::jsonb),
      ($1,'E005',$3,$4,$7,$8::jsonb)`, [
      input.sku,videoSubmissionId,imageSubmissionId,variantId,jobId,
      JSON.stringify({ autoPublishDecision: 'ACCEPTED',sourceStageId: 'E004',submissionId: videoSubmissionId,variantId }),
      input.mediaOwnerDrift ? null : jobId,
      JSON.stringify({ autoPublishDecision: 'ACCEPTED',sourceStageId: 'E005',submissionId: imageSubmissionId,variantId })
    ]);
    if (input.activeLease) {
      await admin.query(`UPDATE ${schema}.ozon_publish_jobs SET
        lease_owner='test-worker',lease_token=$2,lease_expires_at=NOW()+INTERVAL '1 hour'
        WHERE id=$1`, [jobId,randomUUID()]);
    }
    if (input.activeSlot) {
      await admin.query(`INSERT INTO ${schema}.ozon_publish_slots(
        slot_key,job_id,lease_owner,lease_token,lease_expires_at
      ) VALUES('OZON_WRITE',$1,'test-worker',$2,NOW()+INTERVAL '1 hour')`, [jobId,randomUUID()]);
    }
    if (input.activeStatusRefresh) {
      await admin.query(`INSERT INTO ${schema}.ozon_platform_status_refresh_leases(
        store_id,sku,job_id,lease_token,listing_row_version,job_row_version,lease_expires_at
      ) VALUES($1,$2,$3,$4,1,$5,NOW()+INTERVAL '1 hour')`, [
        OZON_DEFAULT_STORE_ID,input.sku,jobId,randomUUID(),actualRowVersion + 1
      ]);
    }
    if (input.competingJob) {
      await admin.query(`INSERT INTO ${schema}.ozon_publish_jobs(
        id,sku,state,source,payload,stage_states,row_version,store_alias,store_id,
        credential_binding_mode,store_config_version,task_kind
      ) VALUES($1,$2,'READY','MANUAL','{}'::jsonb,'{}'::jsonb,1,'default',$3,
        'PURE_LEGACY',1,'LEGACY')`, [randomUUID(),input.sku,OZON_DEFAULT_STORE_ID]);
    }
    if (input.listingPresent) {
      await admin.query(`INSERT INTO ${schema}.ozon_listing_drafts(
        sku,product_name_snapshot,management_source,status,data
      ) VALUES($1,'测试商品','AUTO','DRAFT','{}'::jsonb)`, [input.sku]);
    }
    if (input.mappingPresent) {
      await admin.query(`INSERT INTO ${schema}.ozon_product_mappings(
        store_id,store_alias,offer_id,sku
      ) VALUES($1,'default',$2,$3)`, [OZON_DEFAULT_STORE_ID,`${input.sku}-01`,input.sku]);
    }
    return { jobId,stoppedEventId,rowVersion: actualRowVersion + 1 };
  }

  it('re-arms the exact historical race once while preserving its failed event', async () => {
    const seeded = await seed({ sku: '0000175' });

    await expect(repository.recoverAutomaticPreparationRowVersionRaces()).resolves.toEqual({
      scanned: 1,
      recoveredJobIds: [seeded.jobId]
    });
    const recoveredJob = await repository.getJob(seeded.jobId);
    expect(recoveredJob).toMatchObject({
      id: seeded.jobId,
      state: 'READY',
      rowVersion: seeded.rowVersion + 1,
      payload: expect.objectContaining({
        autoPreparedRowVersionRaceRecovery: expect.objectContaining({
          stoppedEventId: seeded.stoppedEventId,
          platformMutation: false,
          mediaDeliveryCount: 2
        })
      })
    });
    expect(recoveredJob).not.toHaveProperty('lastErrorCode');
    const storedJob = await admin.query(`SELECT last_error_code,last_error_message FROM ${schema}.ozon_publish_jobs WHERE id=$1`, [seeded.jobId]);
    expect(storedJob.rows[0]).toEqual({ last_error_code: null,last_error_message: null });
    const events = await admin.query(`SELECT event_type,from_state,to_state FROM ${schema}.ozon_publish_events
      WHERE job_id=$1 ORDER BY created_at,id`, [seeded.jobId]);
    expect(events.rows.map((row) => row.event_type)).toEqual([
      'AUTOMATION_STOPPED',
      'AUTOMATIC_PREPARATION_ROW_VERSION_RACE_RECOVERED'
    ]);
    await expect(repository.recoverAutomaticPreparationRowVersionRaces()).resolves.toEqual({
      scanned: 0,
      recoveredJobIds: []
    });
  });

  it.each([
    ['event version chain changed', '0000201', { expectedRowVersion: 1,actualRowVersion: 3 }],
    ['listing already exists', '0000202', { listingPresent: true }],
    ['product mapping exists', '0000203', { mappingPresent: true }],
    ['platform write marker exists', '0000204', { platformWriteAttempted: true }],
    ['media ownership drifted', '0000205', { mediaOwnerDrift: true }],
    ['runtime lease is active', '0000206', { activeLease: true }],
    ['global write slot is active', '0000207', { activeSlot: true }],
    ['platform status refresh is active', '0000208', { activeStatusRefresh: true }],
    ['another task is runnable', '0000209', { competingJob: true }]
  ])('keeps the task stopped when %s', async (_label, sku, options) => {
    const seeded = await seed({ sku,...options });

    const result = await repository.recoverAutomaticPreparationRowVersionRaces();

    expect(result.recoveredJobIds).not.toContain(seeded.jobId);
    await expect(repository.getJob(seeded.jobId)).resolves.toMatchObject({
      state: 'NEEDS_ATTENTION',rowVersion: seeded.rowVersion,lastErrorCode: 'TASK_LOCKED'
    });
  });
});
