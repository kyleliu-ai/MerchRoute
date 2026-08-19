import { createHash, randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { OZON_CONTENT_POLICY_VERSION, OZON_DEFAULT_STORE_ID } from '@n8n-media-review/shared';
import { assertIntegrationSchemaBoundary } from '../testing/integration-database-guard.js';
import { sourceMediaIdentityHashFromSnapshot } from '../services/ozon-source-media/index.js';
import { OzonSourceMediaCleanupRepository } from './ozon-source-media-cleanup.js';
import { OzonStoreRepository } from './ozon-stores.js';
import { OzonRepository } from './ozon.js';

const connectionString = process.env.DATABASE_URL;
const schema = `ozon_source_cleanup_${randomUUID().replaceAll('-', '')}`;
const sku = '9900190';
const generatedVersionId = randomUUID();
const publicationId = randomUUID();
const jobId = randomUUID();
const requestId = randomUUID();
const hash = `sha256:${'b'.repeat(64)}`;
let admin: Pool;
let isolated: Pool;
let stores: OzonStoreRepository;
let repository: OzonSourceMediaCleanupRepository;
let concurrent: OzonSourceMediaCleanupRepository;
let isolatedUrl: string;

describe.runIf(Boolean(connectionString))('OZON source media cleanup migration 019 PostgreSQL', () => {
  beforeAll(async () => {
    admin = new Pool({ connectionString, max: 1 });
    await admin.query(`CREATE SCHEMA ${schema}`);
    await admin.query(`CREATE TABLE ${schema}.products(
      sku CHAR(7) PRIMARY KEY,product_name TEXT NOT NULL DEFAULT '',created_at TIMESTAMPTZ NOT NULL
    )`);
    await admin.query(`CREATE TABLE ${schema}.product_variants(
      id UUID PRIMARY KEY,sku CHAR(7) NOT NULL,name TEXT NOT NULL,normalized_name TEXT NOT NULL DEFAULT '',
      sort_order INTEGER NOT NULL DEFAULT 0,created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
    const url = new URL(connectionString!);
    url.searchParams.set('options', `-c search_path=${schema},public`);
    isolatedUrl = url.toString();
    isolated = new Pool({ connectionString: isolatedUrl, max: 2 });
    const boundary = await isolated.query<{ current_schema: string }>('SELECT current_schema()');
    assertIntegrationSchemaBoundary(boundary.rows[0]?.current_schema, schema, 'OZON source cleanup migration 019');

    const ozon = new OzonRepository(isolatedUrl);
    await ozon.initialize();
    await ozon.close();
    stores = new OzonStoreRepository(isolatedUrl);
    await stores.initialize();

    const snapshot = versionSnapshot();
    await isolated.query('INSERT INTO products(sku,product_name,created_at) VALUES($1,$2,NOW())', [sku, '019 清理测试']);
    await isolated.query(`INSERT INTO ozon_listing_drafts(sku,product_name_snapshot,management_source,status,revision,data)
      VALUES($1,$2,'MANUAL','DRAFT',1,'{}'::jsonb)`, [sku, '019 清理测试']);
    await isolated.query(`INSERT INTO ozon_listing_versions(
      id,sku,revision,snapshot,content_policy_version,material_hash,material_hash_version,source_media_identity_hash
    ) VALUES($1,$2,1,$3::jsonb,$4,$5,'ozon-shared-material-v1','')`, [
      generatedVersionId, sku, JSON.stringify(snapshot), OZON_CONTENT_POLICY_VERSION, hash
    ]);

    repository = new OzonSourceMediaCleanupRepository(isolatedUrl);
    concurrent = new OzonSourceMediaCleanupRepository(isolatedUrl);
    await repository.initialize();
    await concurrent.initialize({ migrate: false });

    await stores.planPublicationAttempt({
      id: publicationId,
      jobId,
      sku,
      generatedVersionId,
      revision: 1,
      storeId: OZON_DEFAULT_STORE_ID,
      storeAlias: 'default',
      storeDisplayName: '默认测试店铺',
      source: 'MANUAL',
      credentialBindingMode: 'LEGACY_PUBLICATION',
      storeConfigVersion: 1,
      presetSnapshot: {},
      presetDefinitionHash: hash,
      requestId,
      planHash: hash,
      contentPolicyVersion: OZON_CONTENT_POLICY_VERSION,
      materialHash: hash,
      materialHashVersion: 'ozon-shared-material-v1',
      publicationMode: 'CREATE_ONLY',
      taskId: `default__${sku}__r1`,
      warehouseId: 'warehouse-test',
      warehouseName: '测试仓',
      fulfillmentMode: 'FBS',
      accountCurrency: 'RUB',
      offerIds: [`${sku}-01`],
      offerContractHash: hash,
      materializationHash: hash,
      materializedProductSnapshot: {}
    });
  });

  afterAll(async () => {
    await Promise.all([repository?.close(), concurrent?.close(), stores?.close(), isolated?.end()]);
    await admin?.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin?.end();
  });

  it('幂等迁移、回填可证明媒体身份并只让一个 worker 认领精确版本批次', async () => {
    const expectedMediaHash = sourceMediaIdentityHashFromSnapshot(versionSnapshot());
    const schemaState = await isolated.query(`SELECT
      to_regclass('ozon_source_media_cleanup_batches')::text batches,
      to_regclass('ozon_source_media_cleanup_targets')::text targets,
      to_regclass('ozon_source_media_cleanup_artifacts')::text artifacts,
      (SELECT source_media_identity_hash FROM ozon_listing_versions WHERE id=$1) source_hash,
      (SELECT COUNT(*)::int FROM ozon_schema_migrations WHERE id='019_ozon_source_media_cleanup') migration_count`,
    [generatedVersionId]);
    expect(schemaState.rows[0]).toMatchObject({
      batches: 'ozon_source_media_cleanup_batches',
      targets: 'ozon_source_media_cleanup_targets',
      artifacts: 'ozon_source_media_cleanup_artifacts',
      source_hash: expectedMediaHash,
      migration_count: 1
    });

    const targets = [{
      storeId: OZON_DEFAULT_STORE_ID,
      publicationId,
      jobId,
      taskId: `default__${sku}__r1`
    }];
    const expectedTargetHash = `sha256:${createHash('sha256').update(JSON.stringify({ generatedVersionId, targets })).digest('hex')}`;
    const input = {
      generatedVersionId,
      sku,
      revision: 1,
      source: 'MANUAL' as const,
      rootDirectory: 'G:\\isolated-ozon-root',
      materialHash: hash,
      sourceMediaIdentityHash: expectedMediaHash,
      expectedTargetHash,
      triggerIdentity: { schemaVersion: 1, requestId },
      targets
    };
    const [left, right] = await Promise.all([repository.registerBatch(input), concurrent.registerBatch(input)]);
    expect(right.id).toBe(left.id);
    const artifacts = await isolated.query(`SELECT kind,state,source_rel_path FROM ozon_source_media_cleanup_artifacts
      WHERE cleanup_id=$1 ORDER BY kind`, [left.id]);
    expect(artifacts.rows).toEqual([
      { kind: 'RAW_INBOX', state: 'WAITING_TARGETS', source_rel_path: `inbox/${sku}` },
      { kind: 'SHARED_VERSION', state: 'WAITING_TARGETS', source_rel_path: `shared/${sku}/${generatedVersionId}` }
    ]);

    await isolated.query(`INSERT INTO ozon_publish_slots(
      slot_key,job_id,lease_owner,lease_token,lease_expires_at
    ) VALUES($1,$2,'cleanup-integration',$3,NOW()+INTERVAL '5 minutes')`, [
      'OZON_RUNTIME_WRITE', jobId, randomUUID()
    ]);
    await expect(repository.evidence(left.id)).resolves.toMatchObject({ activeSlotCount: 1 });
    await isolated.query("DELETE FROM ozon_publish_slots WHERE slot_key='OZON_RUNTIME_WRITE'");

    const [claimedA, claimedB] = await Promise.all([
      repository.claimDue('worker-a', 1),
      concurrent.claimDue('worker-b', 1)
    ]);
    expect(claimedA.length + claimedB.length).toBe(1);
    const claimed = [...claimedA, ...claimedB][0]!;
    const marked = await repository.markArtifactState({
      cleanupId: left.id,
      leaseToken: claimed.leaseToken!,
      kind: 'RAW_INBOX',
      expected: ['WAITING_TARGETS'],
      state: 'QUARANTINING',
      quarantineRelPath: `.cleanup/${left.id}/RAW_INBOX`,
      directorySignature: hash,
      fileCount: 1,
      totalBytes: 5,
      reclaimedBytes: 5
    });
    expect(marked).toMatchObject({
      state: 'QUARANTINING',
      quarantineRelPath: `.cleanup/${left.id}/RAW_INBOX`,
      fileCount: 1,
      totalBytes: 5,
      reclaimedBytes: 5
    });
    await isolated.query(`UPDATE ozon_source_media_cleanup_batches SET
      lease_owner=NULL,lease_token=NULL,lease_expires_at=NULL WHERE id=$1`, [left.id]);
    await expect(repository.assertVersionAvailable(generatedVersionId)).rejects.toMatchObject({
      code: 'OZON_SOURCE_MEDIA_CLEANED',
      statusCode: 410
    });

    const replay = new OzonSourceMediaCleanupRepository(isolatedUrl);
    await expect(replay.initialize()).resolves.toBeUndefined();
    await replay.close();
    await expect(isolated.query(`SELECT COUNT(*)::int count FROM ozon_source_media_cleanup_batches`))
      .resolves.toMatchObject({ rows: [{ count: 1 }] });
  });
});

function versionSnapshot(): Record<string, unknown> {
  return {
    sharedMaterial: {
      hashVersion: 'ozon-shared-material-v1',
      contentPolicyVersion: OZON_CONTENT_POLICY_VERSION,
      sku,
      productName: '019 清理测试',
      materialRevision: 1,
      rowVersion: 1,
      descriptionRu: 'Описание',
      initialization: { issues: [] },
      variants: [{
        variantId: 'variant-01',
        productVariantId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        productVariantName: '测试变体',
        descriptionRu: '',
        media: [{ assetId: 'asset-01', kind: 'image', relativePath: 'variants/测试变体/images/submission/image.png', sortOrder: 0 }]
      }],
      mediaAssets: [{
        assetId: 'asset-01', kind: 'image', relativePath: 'variants/测试变体/images/submission/image.png',
        mimeType: 'image/png', sizeBytes: 5, sha256: 'a'.repeat(64), validationStatus: 'VALID',
        productVariantId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', sourceStageId: 'E005',
        sourceSubmissionId: 'submission', deliveredAt: '2026-08-14T00:00:00.000Z'
      }]
    }
  };
}
