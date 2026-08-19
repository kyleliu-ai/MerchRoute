import { randomUUID } from 'node:crypto';
import process from 'node:process';
import dotenv from 'dotenv';
import pg from 'pg';

dotenv.config({ path: '.env' });

const { Client } = pg;
const defaultStoreId = '00000000-0000-4000-8000-000000000002';
const sourceUrl = process.env.DATABASE_URL || '';
const originalFleetCapability = process.env.MERCHROUTE_OZON_MULTISTORE_FLEET_READY;
process.env.MERCHROUTE_OZON_MULTISTORE_FLEET_READY = 'true';

if (!sourceUrl) {
  throw new Error('OZON 多店铺迁移 smoke 需要 DATABASE_URL，禁止缺库跳过。');
}

const schema = `ozon_ms_smoke_${Date.now()}_${process.pid}`.toLowerCase();
if (!/^ozon_ms_smoke_[0-9]+_[0-9]+$/.test(schema)) throw new Error('临时 schema 边界校验失败');
const freshSchema = `ozon_ms_smoke_${Date.now() + 1}_${process.pid}`.toLowerCase();
if (!/^ozon_ms_smoke_[0-9]+_[0-9]+$/.test(freshSchema)) throw new Error('fresh 临时 schema 边界校验失败');
const scopedUrl = new URL(sourceUrl);
scopedUrl.searchParams.set('options', `-c search_path=${schema}`);
const admin = new Client({ connectionString: sourceUrl });
const createdSchemas = [];

try {
  await admin.connect();
  await admin.query(`CREATE SCHEMA ${quoteIdentifier(schema)}`);
  createdSchemas.push(schema);

  await initializeBaseRepository(scopedUrl.toString());
  const before = await seedUpgradeFixture(scopedUrl.toString());
  await initializeStoreRepository(scopedUrl.toString());
  const evidence = await verifyMigration(scopedUrl.toString(), before);
  await setHardeningRestartSentinel(scopedUrl.toString(), before.versionId);
  await initializeRepositories(scopedUrl.toString());
  await assertHardeningRestartSentinel(scopedUrl.toString(), before.versionId);
  const secondCoreEvidence = await collectCoreEvidence(scopedUrl.toString());
  if (JSON.stringify(evidence.coreEvidence) !== JSON.stringify(secondCoreEvidence)) {
    throw new Error('014 二次初始化改变了迁移核心证据');
  }

  // Create the zero-row schema only after the seeded schema already owns all
  // identically named constraints. This catches cross-schema conname lookups.
  await admin.query(`CREATE SCHEMA ${quoteIdentifier(freshSchema)}`);
  createdSchemas.push(freshSchema);
  const freshUrl = new URL(sourceUrl);
  freshUrl.searchParams.set('options', `-c search_path=${freshSchema}`);
  await initializeRepositories(freshUrl.toString());
  await assertSharedMaterialAttemptMigration(freshUrl.toString());
  const freshCounts = await collectHistoricalCounts(freshUrl.toString());
  if (Object.values(freshCounts).some((value) => Number(value) !== 0)) {
    throw new Error(`zero-row fresh 初始化出现意外历史数据：${JSON.stringify(freshCounts)}`);
  }
  const freshCoreEvidence = await collectCoreEvidence(freshUrl.toString());
  await initializeRepositories(freshUrl.toString());
  const freshSecondEvidence = await collectCoreEvidence(freshUrl.toString());
  if (JSON.stringify(freshCoreEvidence) !== JSON.stringify(freshSecondEvidence)) {
    throw new Error('zero-row fresh 二次初始化改变了迁移核心证据');
  }

  console.log(JSON.stringify({
    ok: true,
    schema,
    migrations: ['013_ozon_multistore_vault', '014_ozon_multistore_hardening', '017_ozon_store_owned_presets', '018_ozon_shared_material_and_preparation_attempts'],
    defaultStoreId,
    ...evidence,
    idempotentSecondInitialization: true,
    scenarios: {
      seeded012Upgrade: { schema, beforeCounts: before.counts, afterCounts: evidence.upgradeCounts, idempotent: true },
      zeroRowFresh: { schema: freshSchema, counts: freshCounts, coreEvidence: freshCoreEvidence, idempotent: true,
        createdAfterSameNamedConstraintsExisted: true }
    }
  }, null, 2));
} finally {
  for (const createdSchema of createdSchemas.reverse()) {
    await admin.query(`DROP SCHEMA IF EXISTS ${quoteIdentifier(createdSchema)} CASCADE`);
  }
  await admin.end().catch(() => undefined);
  if (originalFleetCapability === undefined) delete process.env.MERCHROUTE_OZON_MULTISTORE_FLEET_READY;
  else process.env.MERCHROUTE_OZON_MULTISTORE_FLEET_READY = originalFleetCapability;
}

async function initializeBaseRepository(connectionString) {
  const { OzonRepository } = await import('../apps/server/dist/repositories/ozon.js');
  const repository = new OzonRepository(connectionString);
  try { await repository.initialize(); }
  finally { await repository.close().catch(() => undefined); }
}

async function initializeStoreRepository(connectionString) {
  const { OzonStoreRepository } = await import('../apps/server/dist/repositories/ozon-stores.js');
  const repository = new OzonStoreRepository(connectionString);
  try { await repository.initialize(); }
  finally { await repository.close().catch(() => undefined); }
}

async function initializeRepositories(connectionString) {
  const [{ OzonRepository }, { OzonStoreRepository }] = await Promise.all([
    import('../apps/server/dist/repositories/ozon.js'),
    import('../apps/server/dist/repositories/ozon-stores.js')
  ]);
  const repositories = [new OzonRepository(connectionString), new OzonStoreRepository(connectionString)];
  try {
    for (const repository of repositories) await repository.initialize();
  } finally {
    for (const repository of repositories.reverse()) await repository.close().catch(() => undefined);
  }
}

async function verifyMigration(connectionString, before) {
  const client = new Client({ connectionString });
  try {
    await client.connect();
    const currentSchema = String((await client.query('SELECT current_schema() value')).rows[0]?.value || '');
    if (!currentSchema.startsWith('ozon_ms_smoke_')) throw new Error(`拒绝在非临时 schema 断言：${currentSchema}`);

    const migrations = (await client.query("SELECT id FROM ozon_schema_migrations WHERE id=ANY($1::text[]) ORDER BY id", [[
      '013_ozon_multistore_vault', '014_ozon_multistore_hardening', '017_ozon_store_owned_presets',
      '018_ozon_shared_material_and_preparation_attempts'
    ]])).rows;
    if (migrations.length !== 4) throw new Error('013/014/017/018 migration 记录缺失');
    const store = (await client.query('SELECT id::text,store_alias FROM ozon_stores WHERE id=$1', [defaultStoreId])).rows[0];
    if (store?.id !== defaultStoreId || store?.store_alias !== 'default') throw new Error('固定 default store 映射缺失');

    const upgradeCounts = await historicalCounts(client);
    if (JSON.stringify(before.counts) !== JSON.stringify(upgradeCounts)) {
      throw new Error(`升级前后历史行数不一致：${JSON.stringify({ before: before.counts, after: upgradeCounts })}`);
    }
    const modes = (await client.query(`SELECT credential_binding_mode,COUNT(*)::int count
      FROM ozon_publish_jobs WHERE id=ANY($1::uuid[]) GROUP BY credential_binding_mode ORDER BY credential_binding_mode`, [before.jobIds])).rows;
    if (modes.length !== 2 || !modes.some((row) => row.credential_binding_mode === 'PURE_LEGACY' && row.count === 1)
      || !modes.some((row) => row.credential_binding_mode === 'LEGACY_PUBLICATION' && row.count === 1)) {
      throw new Error(`旧任务三态回填证据异常：${JSON.stringify(modes)}`);
    }
    const migratedOverrides = (await client.query(
      'SELECT material_overrides FROM ozon_listing_versions WHERE id=$1', [before.versionId]
    )).rows[0]?.material_overrides;
    const migratedOfferOverride = migratedOverrides?.offerOverrides?.[0];
    if (Object.keys(migratedOverrides || {}).length !== 1
      || migratedOverrides.offerOverrides?.length !== 1
      || Object.keys(migratedOfferOverride || {}).length !== 2
      || migratedOfferOverride?.offerId !== '9900002-01'
      || migratedOfferOverride?.stock !== 7) {
      throw new Error(`历史 material override 未按基准预设差异回填：${JSON.stringify(migratedOverrides)}`);
    }
    await assertHistoricalPolicyBackfill(client, before.policyBackfill);
    await assertLegacyDefaults(client);
    await assertStoreOwnedPresetMigration(client);
    await assertSharedMaterialAttemptMigrationWithClient(client);
    await assertAliasAndSellerBoundaries(client);
    await assertImmutablePreflight(client);
    await assertDeferredPreflight(connectionString, client);
    await assertClaimSql(connectionString, client);
    await assertPublicationReadbackHold(connectionString, client, before.jobIds[1]);
    await assertFrozenCredentialRotation(connectionString, client);
    await assertStrictGatewayAndJobChecks(client);
    await assertGatewayRequestConcurrency(connectionString);
    await assertCompoundStoreIdentities(client);

    const coreEvidence = await collectCoreEvidenceWithClient(client);
    return {
      upgradeCounts,
      backfilledBindingModes: modes,
      diffOnlyMaterialOverrides: migratedOverrides,
      coreEvidence,
      legacyInsertDefaults: ['ozon_publish_jobs', 'ozon_publish_events', 'ozon_product_mappings', 'ozon_platform_status_refresh_leases'],
      immutablePreflightRuns: true,
      sellerUniquenessAtEnableBoundary: true,
      reservedAliasRejected: true,
      immutableAlias: true,
      deferredCurrencyFailClosed: true,
      frozenCredentialRotationClaim: true,
      strictGatewayReceiptMatrix: true,
      strictJobBindingMode: true,
      compoundStoreIdentities: true,
      hardeningRestartPreservesOverrides: true,
      claimSqlExecutable: true
      ,publicationReadbackHoldFencedAndRecoverable: true
      ,gatewayRequestConcurrentIdempotency: true
    };
  } finally {
    await client.end().catch(() => undefined);
  }
}

async function assertSharedMaterialAttemptMigration(connectionString) {
  const client = new Client({ connectionString });
  try {
    await client.connect();
    await assertSharedMaterialAttemptMigrationWithClient(client);
  } finally {
    await client.end().catch(() => undefined);
  }
}

async function assertSharedMaterialAttemptMigrationWithClient(client) {
  const expectedColumns = new Map([
    ['ozon_listing_versions', ['content_policy_version', 'material_hash', 'material_hash_version']],
    ['ozon_publish_jobs', ['task_kind']],
    ['ozon_store_publications', [
      'preparation_job_id', 'planned_job_id', 'request_id', 'plan_hash',
      'content_policy_version', 'material_hash', 'material_hash_version',
      'preset_row_version', 'publication_mode'
    ]]
  ]);
  const rows = (await client.query(`SELECT table_name,column_name FROM information_schema.columns
    WHERE table_schema=current_schema() AND table_name=ANY($1::text[])`, [[...expectedColumns.keys()]])).rows;
  const actual = new Set(rows.map((row) => `${row.table_name}.${row.column_name}`));
  const missingColumns = [...expectedColumns].flatMap(([table, columns]) => columns
    .filter((column) => !actual.has(`${table}.${column}`))
    .map((column) => `${table}.${column}`));
  if (missingColumns.length) throw new Error(`018 列缺失：${JSON.stringify(missingColumns)}`);

  const expectedIndexes = [
    'ozon_publications_preparation_store_unique',
    'ozon_publications_request_store_unique',
    'ozon_publish_jobs_one_active_shared_preparation',
    'ozon_publish_jobs_one_active_publication_per_store_sku'
  ];
  const indexes = (await client.query(`SELECT indexname,indexdef FROM pg_indexes
    WHERE schemaname=current_schema() AND indexname=ANY($1::text[])`, [expectedIndexes])).rows;
  if (indexes.length !== expectedIndexes.length
    || indexes.some((row) => !/CREATE UNIQUE INDEX/i.test(String(row.indexdef || '')))) {
    throw new Error(`018 唯一索引不完整：${JSON.stringify(indexes)}`);
  }
  const oldIndex = (await client.query(`SELECT 1 FROM pg_indexes
    WHERE schemaname=current_schema() AND indexname='ozon_publish_jobs_one_active_per_store_sku'`)).rows[0];
  if (oldIndex) throw new Error('018 未删除会让父准备任务阻塞子 publication 的旧索引');

  const expectedConstraints = [
    'ozon_publish_jobs_task_kind_check',
    'ozon_publication_preparation_job_fk',
    'ozon_publication_planned_job_fk',
    'ozon_publication_mode_check'
  ];
  const constraints = (await client.query(`SELECT conname FROM pg_constraint
    WHERE connamespace=current_schema()::regnamespace AND conname=ANY($1::text[])`, [expectedConstraints])).rows;
  if (constraints.length !== expectedConstraints.length) {
    throw new Error(`018 约束缺失：${JSON.stringify({ expectedConstraints, constraints })}`);
  }
}

async function assertStoreOwnedPresetMigration(client) {
  const forbiddenColumns = new Set([
    'is_default', 'auto_publish_activated_at', 'default_store_alias', 'credential_ready',
    'seller_id', 'seller_name', 'account_currency', 'last_preflight_at',
    'last_preflight_status', 'last_preflight_message'
  ]);
  const columns = (await client.query(`SELECT table_name,column_name FROM information_schema.columns
    WHERE table_schema=current_schema() AND table_name=ANY($1::text[])`, [[
      'ozon_listing_presets', 'ozon_system_settings'
    ]])).rows;
  const retained = columns.filter((row) => forbiddenColumns.has(row.column_name));
  if (retained.length) throw new Error(`017 仍保留全局默认或单店铺系统列：${JSON.stringify(retained)}`);
  const polluted = (await client.query(`SELECT id::text FROM ozon_listing_presets WHERE
    definition ?| ARRAY['isDefault','autoPublishEnabled','autoPublishMode','autoPublishActivatedAt','warehouseId','fulfillmentMode','currency']`)).rows;
  if (polluted.length) throw new Error(`017 仍保留预设级店铺策略：${JSON.stringify(polluted)}`);
  const audit = (await client.query("SELECT snapshot FROM ozon_legacy_configuration_audit WHERE id='017_ozon_store_owned_presets'")).rows[0];
  if (!audit?.snapshot?.presets || !audit?.snapshot?.systemSettings) {
    throw new Error('017 缺少迁移前只读审计快照');
  }
}

async function seedUpgradeFixture(connectionString) {
  const client = new Client({ connectionString });
  const pureJobId = randomUUID();
  const publicationJobId = randomUUID();
  const versionId = randomUUID();
  const conflictingVersionId = randomUUID();
  const unknownVersionId = randomUUID();
  const provenV1VersionId = randomUUID();
  const conflictingV1JobId = randomUUID();
  const conflictingV2JobId = randomUUID();
  const unknownJobId = randomUUID();
  const provenV1JobId = randomUUID();
  try {
    await client.connect();
    await client.query(`INSERT INTO ozon_listing_drafts(
      sku,product_name_snapshot,status,row_version,revision,data
    ) VALUES
      ('9900002','upgrade publication','READY',1,1,$1::jsonb),
      ('9900003','conflicting policy publication','READY',1,1,'{"offers":[{"offerId":"9900003-01"}]}'::jsonb),
      ('9900004','unknown policy publication','READY',1,1,'{"offers":[{"offerId":"9900004-01"}]}'::jsonb),
      ('9900005','proven v1 policy publication','READY',1,1,'{"offers":[{"offerId":"9900005-01"}]}'::jsonb)`, [JSON.stringify({
      offers: [{ offerId: '9900002-01', stock: 7, attributes: [] }], vat: '0.2', sharedAttributes: [],
      initialization: { presetSnapshot: { definition: {
        vat: '0.2', sharedAttributes: [], defaultStock: 5, variantAttributes: []
      } } }
    })]);
    await client.query(`INSERT INTO ozon_listing_versions(id,sku,revision,snapshot)
      VALUES
        ($1,'9900002',1,$2::jsonb),
        ($3,'9900003',1,'{"sku":"9900003","revision":1,"data":{"offers":[{"offerId":"9900003-01"}]}}'::jsonb),
        ($4,'9900004',1,'{"sku":"9900004","revision":1,"data":{"offers":[{"offerId":"9900004-01"}]}}'::jsonb),
        ($5,'9900005',1,'{"sku":"9900005","revision":1,"data":{"offers":[{"offerId":"9900005-01"}]}}'::jsonb)`, [versionId, JSON.stringify({
      sku: '9900002', revision: 1, data: {
        offers: [{ offerId: '9900002-01', stock: 7, attributes: [] }], vat: '0.2', sharedAttributes: [],
        initialization: { presetSnapshot: { definition: {
          vat: '0.2', sharedAttributes: [], defaultStock: 5, variantAttributes: []
        } } }
      }
    }), conflictingVersionId, unknownVersionId, provenV1VersionId]);
    await client.query(`INSERT INTO ozon_publish_jobs(
      id,sku,state,source,store_alias,listing_revision,offer_ids,task_folder,work_rel_path,directory_stage,directory_signature,payload
    ) VALUES
      ($1,'9900001','SUCCEEDED','MANUAL','default',0,'[]'::jsonb,NULL,NULL,NULL,NULL,'{}'::jsonb),
      ($2,'9900002','SUCCEEDED','MANUAL','default',1,'["9900002-01"]'::jsonb,
       '9900002__r1','processing/9900002__r1','PROCESSING','sha256:'||repeat('a',64),
       '{"contentPolicyVersion":"merchroute-ozon-content-v2","importIntent":{"contentPolicyVersion":"merchroute-ozon-content-v2"}}'::jsonb),
      ($3,'9900003','SUCCEEDED','AUTO','default',1,'["9900003-01"]'::jsonb,
       '9900003__r1','processing/9900003__r1','PROCESSING','sha256:'||repeat('b',64),
       '{"contentPolicyVersion":"merchroute-ozon-content-v1"}'::jsonb),
      ($4,'9900003','SUCCEEDED','AUTO','default',1,'["9900003-01"]'::jsonb,
       '9900003__r1','processing/9900003__r1','PROCESSING','sha256:'||repeat('b',64),
       '{"importIntent":{"contentPolicyVersion":"merchroute-ozon-content-v2"}}'::jsonb),
      ($5,'9900004','SUCCEEDED','AUTO','default',1,'["9900004-01"]'::jsonb,
       '9900004__r1','processing/9900004__r1','PROCESSING','sha256:'||repeat('c',64),
       '{"importIntent":{"phase":"PREPARED"}}'::jsonb),
      ($6,'9900005','SUCCEEDED','AUTO','default',1,'["9900005-01"]'::jsonb,
       '9900005__r1','processing/9900005__r1','PROCESSING','sha256:'||repeat('d',64),
       '{"importIntent":{"contentPolicyVersion":"merchroute-ozon-content-v1"}}'::jsonb)`, [
      pureJobId, publicationJobId, conflictingV1JobId, conflictingV2JobId, unknownJobId, provenV1JobId
    ]);
    await client.query(`INSERT INTO ozon_publish_events(id,job_id,event_type,message)
      VALUES($1,$2,'UPGRADE_FIXTURE','before 013')`, [randomUUID(), pureJobId]);
    await client.query(`INSERT INTO ozon_product_mappings(store_alias,offer_id,sku)
      VALUES('default','9900001-01','9900001')`);
    await client.query(`INSERT INTO ozon_platform_status_refresh_leases(
      sku,job_id,lease_token,listing_row_version,lease_expires_at
    ) VALUES('9900001',$1,$2,1,NOW()+INTERVAL '1 minute')`, [pureJobId, randomUUID()]);
    return {
      counts: await historicalCounts(client),
      jobIds: [pureJobId, publicationJobId],
      versionId,
      policyBackfill: { provenV2VersionId: versionId, provenV1VersionId, conflictingVersionId, unknownVersionId }
    };
  } finally {
    await client.end().catch(() => undefined);
  }
}

async function assertHistoricalPolicyBackfill(client, fixture) {
  const rows = (await client.query(`SELECT id::text,content_policy_version
    FROM ozon_listing_versions WHERE id=ANY($1::uuid[]) ORDER BY id`, [[
    fixture.provenV2VersionId, fixture.provenV1VersionId, fixture.conflictingVersionId, fixture.unknownVersionId
  ]])).rows;
  const byId = new Map(rows.map((row) => [row.id, row.content_policy_version]));
  if (byId.get(fixture.provenV2VersionId) !== 'merchroute-ozon-content-v2') {
    throw new Error(`018 未按唯一 v2 publication/job/importIntent 证据回填版本：${JSON.stringify(rows)}`);
  }
  if (byId.get(fixture.provenV1VersionId) !== 'merchroute-ozon-content-v1') {
    throw new Error(`018 未按唯一 v1 publication/job/importIntent 证据回填版本：${JSON.stringify(rows)}`);
  }
  if (byId.get(fixture.conflictingVersionId) !== 'LEGACY_UNKNOWN') {
    throw new Error(`018 错误回填了 v1/v2 冲突版本：${JSON.stringify(rows)}`);
  }
  if (byId.get(fixture.unknownVersionId) !== 'LEGACY_UNKNOWN') {
    throw new Error(`018 错误回填了无策略证据版本：${JSON.stringify(rows)}`);
  }
}

async function historicalCounts(client) {
  const tables = [
    'ozon_publish_jobs', 'ozon_publish_events', 'ozon_product_mappings',
    'ozon_platform_status_refresh_leases', 'ozon_listing_versions'
  ];
  const counts = {};
  for (const table of tables) counts[table] = Number((await client.query(`SELECT COUNT(*)::int count FROM ${table}`)).rows[0]?.count || 0);
  return counts;
}

async function collectCoreEvidence(connectionString) {
  const client = new Client({ connectionString });
  try { await client.connect(); return await collectCoreEvidenceWithClient(client); }
  finally { await client.end().catch(() => undefined); }
}

async function collectHistoricalCounts(connectionString) {
  const client = new Client({ connectionString });
  try { await client.connect(); return await historicalCounts(client); }
  finally { await client.end().catch(() => undefined); }
}

async function collectCoreEvidenceWithClient(client) {
  const expectedConstraintNames = [
    'ozon_product_mappings_pkey', 'ozon_platform_status_refresh_leases_pkey',
    'ozon_publish_jobs_store_id_fkey',
    'ozon_store_publications_store_id_fkey', 'ozon_store_preflight_runs_store_id_fkey',
    'ozon_gateway_legacy_receipt_matrix', 'ozon_publish_jobs_credential_binding_mode_check',
    'ozon_publish_jobs_vault_credential_required', 'ozon_stores_active_credential_store_fk',
    'ozon_runtime_preflight_credential_store_fk', 'ozon_preflight_run_credential_store_fk',
    'ozon_publication_credential_store_fk', 'ozon_job_credential_store_fk',
    'ozon_job_publication_store_fk', 'ozon_event_job_store_fk', 'ozon_event_publication_store_fk',
    'ozon_consumption_job_store_fk', 'ozon_consumption_publication_store_fk',
    'ozon_gateway_credential_store_fk', 'ozon_gateway_publication_store_fk',
    'ozon_refresh_lease_job_store_fk', 'ozon_mapping_alias_store_fk'
  ];
  const constraints = (await client.query(`SELECT conname,contype,convalidated,pg_get_constraintdef(oid) definition
    FROM pg_constraint WHERE connamespace=current_schema()::regnamespace AND conname=ANY($1::text[])
    ORDER BY conname`, [expectedConstraintNames])).rows;
  if (constraints.length !== expectedConstraintNames.length || constraints.some((row) => !row.convalidated)) {
    throw new Error(`PK/FK 证据不完整：${JSON.stringify(constraints)}`);
  }
  const indexes = (await client.query(`SELECT indexname FROM pg_indexes
    WHERE schemaname=current_schema() AND indexname=ANY($1::text[]) ORDER BY indexname`, [[
      'ozon_publish_jobs_one_active_shared_preparation',
      'ozon_publish_jobs_one_active_publication_per_store_sku', 'ozon_stores_active_seller_unique',
      'ozon_store_publications_task_unique', 'ozon_product_mappings_store_sku'
    ]])).rows.map((row) => row.indexname);
  if (indexes.length !== 5) throw new Error(`多店铺索引证据不完整：${JSON.stringify(indexes)}`);
  const nulls = (await client.query(`SELECT
    (SELECT COUNT(*)::int FROM ozon_publish_jobs WHERE store_id IS NULL) jobs,
    (SELECT COUNT(*)::int FROM ozon_publish_events WHERE store_id IS NULL) events,
    (SELECT COUNT(*)::int FROM ozon_product_mappings WHERE store_id IS NULL) mappings,
    (SELECT COUNT(*)::int FROM ozon_platform_status_refresh_leases WHERE store_id IS NULL) leases`)).rows[0];
  if (Object.values(nulls).some((value) => Number(value) !== 0)) throw new Error(`store_id NULL 回填不完整：${JSON.stringify(nulls)}`);
  const duplicates = (await client.query(`SELECT
    (SELECT COUNT(*)::int FROM (SELECT store_id,sku FROM ozon_publish_jobs
      WHERE state=ANY(ARRAY['WAITING_MEDIA','READY','UPLOADING_MEDIA','SUBMITTING','IMPORTING','VERIFYING_IMAGES','UPDATING_PRICE','UPDATING_STOCK','MODERATING','NEEDS_ATTENTION']::text[])
      GROUP BY store_id,sku HAVING COUNT(*)>1) x) active_jobs,
    (SELECT COUNT(*)::int FROM (SELECT store_id,offer_id FROM ozon_product_mappings GROUP BY store_id,offer_id HAVING COUNT(*)>1) x) mappings,
    (SELECT COUNT(*)::int FROM (SELECT store_id,generated_version_id FROM ozon_store_publications GROUP BY store_id,generated_version_id HAVING COUNT(*)>1) x) publications`)).rows[0];
  if (Object.values(duplicates).some((value) => Number(value) !== 0)) throw new Error(`复合身份重复：${JSON.stringify(duplicates)}`);
  const orphans = (await client.query(`SELECT
    (SELECT COUNT(*)::int FROM ozon_publish_events e LEFT JOIN ozon_publish_jobs j ON j.id=e.job_id WHERE j.id IS NULL) events,
    (SELECT COUNT(*)::int FROM ozon_publish_jobs j LEFT JOIN ozon_stores s ON s.id=j.store_id WHERE s.id IS NULL) jobs,
    (SELECT COUNT(*)::int FROM ozon_product_mappings m LEFT JOIN ozon_stores s ON s.id=m.store_id WHERE s.id IS NULL) mappings,
    (SELECT COUNT(*)::int FROM ozon_store_publications p LEFT JOIN ozon_stores s ON s.id=p.store_id WHERE s.id IS NULL) publications,
    (SELECT COUNT(*)::int FROM ozon_store_media_consumptions c LEFT JOIN ozon_stores s ON s.id=c.store_id WHERE s.id IS NULL) consumptions`)).rows[0];
  if (Object.values(orphans).some((value) => Number(value) !== 0)) throw new Error(`迁移孤儿证据：${JSON.stringify(orphans)}`);
  const columns = (await client.query(`SELECT table_name,column_name,is_nullable,column_default
    FROM information_schema.columns WHERE table_schema=current_schema() AND (table_name,column_name) IN (
      ('ozon_stores','vault_activated_at'),('ozon_listing_versions','material_overrides'),
      ('ozon_listing_versions','base_preset_id'),('ozon_gateway_requests','credential_binding_mode'),
      ('ozon_gateway_requests','payload_hash'),('ozon_gateway_requests','delegation_state'))
    ORDER BY table_name,column_name`)).rows;
  if (columns.length !== 6) throw new Error(`014 新增列证据不完整：${JSON.stringify(columns)}`);
  return { constraints, indexes, nulls, duplicates, orphans, columns };
}

async function assertLegacyDefaults(client) {
  const jobId = randomUUID();
  const eventId = randomUUID();
  const leaseToken = randomUUID();
  const sku = `SMOKE-${process.pid}`;
  await client.query(`INSERT INTO ozon_publish_jobs(id,sku,state,source,store_alias)
    VALUES($1,$2,'SUCCEEDED','MANUAL','default')`, [jobId, sku]);
  await client.query(`INSERT INTO ozon_publish_events(id,job_id,event_type,message)
    VALUES($1,$2,'SMOKE','migration smoke')`, [eventId, jobId]);
  await client.query(`INSERT INTO ozon_product_mappings(store_alias,offer_id,sku)
    VALUES('default',$1,$2)`, [`offer-${process.pid}`, sku]);
  await client.query(`INSERT INTO ozon_platform_status_refresh_leases(
    sku,job_id,lease_token,listing_row_version,lease_expires_at
  ) VALUES($1,$2,$3,1,NOW()+INTERVAL '1 minute')`, [sku, jobId, leaseToken]);
  const rows = (await client.query(`SELECT store_id::text FROM (
    SELECT store_id FROM ozon_publish_jobs WHERE id=$1
    UNION ALL SELECT store_id FROM ozon_publish_events WHERE id=$2
    UNION ALL SELECT store_id FROM ozon_product_mappings WHERE offer_id=$3
    UNION ALL SELECT store_id FROM ozon_platform_status_refresh_leases WHERE sku=$4
  ) defaults`, [jobId, eventId, `offer-${process.pid}`, sku])).rows;
  if (rows.length !== 4 || rows.some((row) => row.store_id !== defaultStoreId)) {
    throw new Error(`旧 INSERT store_id 默认映射失败：${JSON.stringify(rows)}`);
  }
}

async function assertAliasAndSellerBoundaries(client) {
  let reservedRejected = false;
  try {
    await client.query(`INSERT INTO ozon_stores(id,store_alias,display_name) VALUES($1,'con','reserved')`, [randomUUID()]);
  } catch (error) {
    reservedRejected = error?.code === '23514';
  }
  if (!reservedRejected) throw new Error('Windows 保留名 alias 未被 DB CHECK 拒绝');

  let immutableAlias = false;
  try {
    await client.query("UPDATE ozon_stores SET store_alias='renamed-default' WHERE id=$1", [defaultStoreId]);
  } catch (error) {
    immutableAlias = error?.code === '55000';
  }
  if (!immutableAlias) throw new Error('store_alias 仍可在创建后修改');

  const first = randomUUID();
  const second = randomUUID();
  await client.query(`INSERT INTO ozon_stores(id,store_alias,display_name,seller_id,enabled)
    VALUES($1,'smoke-a','A','duplicate-seller',false),($2,'smoke-b','B','duplicate-seller',false)`, [first, second]);
  await client.query('UPDATE ozon_stores SET enabled=true WHERE id=$1', [first]);
  let duplicateRejected = false;
  try {
    await client.query('UPDATE ozon_stores SET enabled=true WHERE id=$1', [second]);
  } catch (error) {
    duplicateRejected = error?.code === '23505';
  }
  if (!duplicateRejected) throw new Error('重复 Seller 未在第二家启用时拒绝');
}

async function assertDeferredPreflight(connectionString, client) {
  const pendingOnlyStoreId = randomUUID();
  const pendingOnlyCredentialId = randomUUID();
  const rotatingStoreId = randomUUID();
  const activeCredentialId = randomUUID();
  const pendingRotationId = randomUUID();
  await client.query(`INSERT INTO ozon_stores(
    id,store_alias,display_name,credential_state,preflight_status
  ) VALUES($1,'deferred-new','Deferred new','PENDING','PENDING'),
    ($2,'deferred-rotate','Deferred rotate','ACTIVE','PASSED')`, [pendingOnlyStoreId, rotatingStoreId]);
  await client.query(`INSERT INTO ozon_store_runtime_state(store_id) VALUES($1),($2)`, [pendingOnlyStoreId, rotatingStoreId]);
  await client.query(`INSERT INTO ozon_store_credential_versions(
    id,store_id,version_no,status,ciphertext,nonce,auth_tag,fingerprint,validated_at
  ) VALUES
    ($1,$2,1,'PENDING','cipher','nonce','tag','pending-only',NULL),
    ($3,$4,1,'ACTIVE','cipher','nonce','tag','active-old',NOW()),
    ($5,$4,2,'PENDING','cipher','nonce','tag','pending-rotation',NULL)`, [
    pendingOnlyCredentialId, pendingOnlyStoreId, activeCredentialId, rotatingStoreId, pendingRotationId
  ]);
  await client.query(`UPDATE ozon_stores SET active_credential_version_id=$2,
    preflight_checked_at=NOW(),preflight_due_at=NOW()+INTERVAL '18 hours',preflight_expires_at=NOW()+INTERVAL '24 hours'
    WHERE id=$1`, [rotatingStoreId, activeCredentialId]);
  await client.query(`UPDATE ozon_store_runtime_state SET
    preflight_credential_version_id=$2,preflight_store_config_version=1,
    preflight_lock_expires_at=NOW()+INTERVAL '15 minutes',preflight_lease_owner='smoke'
    WHERE store_id=$1`, [pendingOnlyStoreId, pendingOnlyCredentialId]);
  await client.query(`UPDATE ozon_store_runtime_state SET
    preflight_credential_version_id=$2,preflight_store_config_version=1,
    preflight_lock_expires_at=NOW()+INTERVAL '15 minutes',preflight_lease_owner='smoke'
    WHERE store_id=$1`, [rotatingStoreId, pendingRotationId]);

  const { OzonStoreRepository } = await import('../apps/server/dist/repositories/ozon-stores.js');
  const repository = new OzonStoreRepository(connectionString);
  const report = (storeId, credentialVersionId) => ({
    storeId, storeConfigVersion: 1, credentialVersionId,
    sellerId: `seller-${storeId}`, sellerName: 'Smoke seller',
    checks: [{ code: 'currency', ok: true, status: 'DEFERRED', details: {} }],
    warehouses: [{ id: '123', name: 'Smoke', fulfillmentModes: ['FBS'] }],
    permissions: ['read'], limits: {}, currencyVerified: false,
    currencyVerification: { status: 'DEFERRED_EMPTY_CATALOG', evidence: {} },
    observedAt: new Date().toISOString(), ok: true
  });
  try {
    await repository.initialize();
    await repository.applyPreflightReport(pendingOnlyStoreId, 1, pendingOnlyCredentialId, report(pendingOnlyStoreId, pendingOnlyCredentialId));
    await repository.applyPreflightReport(rotatingStoreId, 1, pendingRotationId, report(rotatingStoreId, pendingRotationId));
  } finally {
    await repository.close().catch(() => undefined);
  }
  const states = (await client.query(`SELECT id::text,active_credential_version_id::text,preflight_status
    FROM ozon_stores WHERE id=ANY($1::uuid[]) ORDER BY id`, [[pendingOnlyStoreId, rotatingStoreId]])).rows;
  const pendingOnly = states.find((row) => row.id === pendingOnlyStoreId);
  const rotating = states.find((row) => row.id === rotatingStoreId);
  if (pendingOnly?.active_credential_version_id || pendingOnly?.preflight_status !== 'FAILED') {
    throw new Error(`DEFERRED 首次凭据被错误激活：${JSON.stringify(pendingOnly)}`);
  }
  if (rotating?.active_credential_version_id !== activeCredentialId || rotating?.preflight_status !== 'PASSED') {
    throw new Error(`DEFERRED 轮换覆盖了旧 ACTIVE/PASSED：${JSON.stringify(rotating)}`);
  }
  const credentialStates = (await client.query(`SELECT id::text,status FROM ozon_store_credential_versions
    WHERE id=ANY($1::uuid[]) ORDER BY id`, [[pendingOnlyCredentialId, activeCredentialId, pendingRotationId]])).rows;
  if (credentialStates.find((row) => row.id === pendingOnlyCredentialId)?.status !== 'PENDING'
    || credentialStates.find((row) => row.id === activeCredentialId)?.status !== 'ACTIVE'
    || credentialStates.find((row) => row.id === pendingRotationId)?.status !== 'PENDING') {
    throw new Error(`DEFERRED 凭据状态异常：${JSON.stringify(credentialStates)}`);
  }
  const runs = (await client.query(`SELECT store_id::text,result,error_code FROM ozon_store_preflight_runs
    WHERE store_id=ANY($1::uuid[]) ORDER BY store_id`, [[pendingOnlyStoreId, rotatingStoreId]])).rows;
  if (runs.length !== 2 || runs.some((row) => row.result !== 'FAILED' || row.error_code !== 'OZON_CURRENCY_NOT_VERIFIED')) {
    throw new Error(`DEFERRED immutable run 结果异常：${JSON.stringify(runs)}`);
  }
}

async function assertImmutablePreflight(client) {
  const credentialId = randomUUID();
  const runId = randomUUID();
  await client.query('BEGIN');
  await client.query(`INSERT INTO ozon_store_credential_versions(
    id,store_id,version_no,status,ciphertext,nonce,auth_tag,fingerprint
  ) VALUES($1,$2,1,'PENDING','cipher','nonce','tag','fingerprint')`, [credentialId, defaultStoreId]);
  await client.query(`INSERT INTO ozon_store_preflight_runs(
    id,store_id,store_config_version,credential_version_id,result,report,observed_at
  ) VALUES($1,$2,1,$3,'FAILED','{}'::jsonb,NOW())`, [runId, defaultStoreId, credentialId]);
  await client.query('SAVEPOINT immutable_probe');
  let immutable = false;
  try {
    await client.query("UPDATE ozon_store_preflight_runs SET result='PASSED' WHERE id=$1", [runId]);
  } catch (error) {
    immutable = error?.code === '55000';
    await client.query('ROLLBACK TO SAVEPOINT immutable_probe');
  }
  await client.query('RELEASE SAVEPOINT immutable_probe');
  if (!immutable) {
    await client.query('ROLLBACK');
    throw new Error('preflight run 仍可被修改');
  }
  await client.query('COMMIT');
}

async function assertClaimSql(connectionString, client) {
  await client.query("UPDATE ozon_system_settings SET enabled=true WHERE id='default'");
  const { OzonStoreRepository } = await import('../apps/server/dist/repositories/ozon-stores.js');
  const repository = new OzonStoreRepository(connectionString);
  try {
    await repository.initialize();
    process.env.MERCHROUTE_OZON_MULTISTORE_FLEET_READY = 'false';
    const gated = await repository.claimRuntimeJobs({ leaseOwner: 'migration-smoke-gated', leaseSeconds: 60, limit: 2 });
    if (gated.length) throw new Error('fleet=false 仍领取了 OZON publication 任务');
    process.env.MERCHROUTE_OZON_MULTISTORE_FLEET_READY = 'true';
    await repository.claimRuntimeJobs({ leaseOwner: 'migration-smoke', leaseSeconds: 60, limit: 2 });
  } finally {
    process.env.MERCHROUTE_OZON_MULTISTORE_FLEET_READY = 'true';
    await repository.close().catch(() => undefined);
  }
}

async function assertPublicationReadbackHold(connectionString, client, jobId) {
  const hash = `sha256:${'a'.repeat(64)}`;
  const row = (await client.query('SELECT publication_id::text FROM ozon_publish_jobs WHERE id=$1', [jobId])).rows[0];
  if (!row?.publication_id) throw new Error('readback hold smoke 缺少迁移 publication');
  const publicationId = row.publication_id;
  await client.query(`UPDATE ozon_store_publications SET
    status='FAILED',task_id='default__9900002__r1',offer_ids='["9900002-01"]'::jsonb,
    offer_contract_hash=$2,materialization_hash=$2,warehouse_id='123',
    content_policy_version='merchroute-ozon-content-v2',material_hash=$2,
    material_hash_version='ozon-shared-material-v1',plan_hash=$2,preset_row_version=1,
    publication_mode='CREATE_ONLY',row_version=row_version+1 WHERE id=$1`, [publicationId, hash]);
  await client.query(`UPDATE ozon_publish_jobs SET
    state='READY',task_id='default__9900002__r1',offer_ids='["9900002-01"]'::jsonb,
    task_kind='STORE_PUBLICATION',offer_contract_hash=$2,materialization_hash=$2,warehouse_id='123',
    payload=payload || jsonb_build_object(
      'contentPolicyVersion','merchroute-ozon-content-v2',
      'materialHash',$2::text,
      'materialHashVersion','ozon-shared-material-v1',
      'planHash',$2::text,
      'presetRowVersion',1,
      'publicationMode','CREATE_ONLY'
    ),lease_owner=NULL,lease_token=NULL,lease_expires_at=NULL
    WHERE id=$1`, [jobId, hash]);
  const { OzonStoreRepository } = await import('../apps/server/dist/repositories/ozon-stores.js');
  const repository = new OzonStoreRepository(connectionString);
  try {
    await repository.initialize();
    const publication = await repository.getPublication(publicationId);
    const begun = await repository.beginPublicationReadback(publicationId, publication.rowVersion);
    const hold = (await client.query(`SELECT payload->'recoveryHold' hold FROM ozon_publish_jobs WHERE id=$1`, [jobId])).rows[0]?.hold;
    if (hold?.active !== true || hold?.kind !== 'PUBLICATION_READBACK' || hold?.requestRef !== begun.requestRef || !hold?.expiresAt) {
      throw new Error(`readback hold 未冻结：${JSON.stringify(hold)}`);
    }
    const blocked = await repository.claimRuntimeJobs({ leaseOwner: 'readback-hold-blocked', leaseSeconds: 60, limit: 2 });
    if (blocked.some((job) => job.id === jobId)) throw new Error('readback hold 期间任务被错误 claim');
    await repository.failPublicationReadback({
      publicationId,
      dispatchRowVersion: begun.dispatchRowVersion,
      requestRef: begun.requestRef,
      deliveryState: 'NOT_SENT',
      retryClass: 'RETRYABLE',
      statusCode: 429,
      errorCode: 'SMOKE_429',
      errorMessage: 'migration smoke'
    });
    const released = (await client.query(`SELECT payload ? 'recoveryHold' held FROM ozon_publish_jobs WHERE id=$1`, [jobId])).rows[0];
    if (released?.held) throw new Error('readback fail 后 hold 未清理');
    await client.query(`UPDATE ozon_publish_jobs SET state='READY',lease_owner=NULL,lease_token=NULL,lease_expires_at=NULL,
      payload=jsonb_set(payload,'{recoveryHold}',$2::jsonb,true) WHERE id=$1`, [jobId, JSON.stringify({
      active: true, kind: 'PUBLICATION_READBACK', requestRef: 'stale-smoke', expiresAt: '2020-01-01T00:00:00.000Z'
    })]);
    const reclaimed = await repository.claimRuntimeJobs({ leaseOwner: 'readback-hold-recovered', leaseSeconds: 60, limit: 2 });
    if (!reclaimed.some((job) => job.id === jobId)) throw new Error('过期 readback hold 未被清理并重新 claim');
    await client.query(`UPDATE ozon_publish_jobs SET state='FAILED',lease_owner=NULL,lease_token=NULL,lease_expires_at=NULL WHERE id=$1`, [jobId]);
  } finally {
    await repository.close().catch(() => undefined);
  }
}

async function assertGatewayRequestConcurrency(connectionString) {
  const { OzonStoreRepository } = await import('../apps/server/dist/repositories/ozon-stores.js');
  const left = new OzonStoreRepository(connectionString);
  const right = new OzonStoreRepository(connectionString);
  const requestRef = `gateway-concurrent-${randomUUID()}`;
  const input = {
    requestRef,
    requestHash: `sha256:${'1'.repeat(64)}`,
    payloadHash: `sha256:${'2'.repeat(64)}`,
    operation: 'infoList',
    identity: {
      storeId: defaultStoreId,
      storeAlias: 'default',
      credentialBindingMode: 'LEGACY_PUBLICATION',
      storeConfigVersion: 1,
      warehouseId: '',
      offerIds: [],
      productIds: [],
      storeEnabled: true,
      leaseActive: false
    }
  };
  try {
    await left.initialize();
    await right.initialize();
    const results = await Promise.all([left.beginGatewayRequest(input), right.beginGatewayRequest(input)]);
    if (results.filter((result) => result.existing).length !== 1) {
      throw new Error(`相同 requestRef 并发幂等结果异常：${JSON.stringify(results)}`);
    }
    let conflict = false;
    try { await left.beginGatewayRequest({ ...input, requestHash: `sha256:${'3'.repeat(64)}` }); }
    catch (error) { conflict = error?.code === 'VERSION_CONFLICT'; }
    if (!conflict) throw new Error('不同 hash 的同 requestRef 未被拒绝');
  } finally {
    await left.close().catch(() => undefined);
    await right.close().catch(() => undefined);
  }
}

async function assertFrozenCredentialRotation(connectionString, client) {
  const storeId = randomUUID();
  const activeCredentialId = randomUUID();
  const frozenFreshId = randomUUID();
  const frozenExpiredId = randomUUID();
  const freshJobId = randomUUID();
  const expiredJobId = randomUUID();
  const freshVersionId = randomUUID();
  const expiredVersionId = randomUUID();
  const freshPublicationId = randomUUID();
  const expiredPublicationId = randomUUID();
  await client.query(`INSERT INTO ozon_stores(
    id,store_alias,display_name,enabled,credential_state,credential_binding_mode,
    active_credential_version_id,preflight_status,preflight_checked_at,preflight_due_at,preflight_expires_at
  ) VALUES($1,'rotation-smoke','Rotation smoke',true,'ACTIVE','VAULT',NULL,'PASSED',NOW(),NOW()+INTERVAL '18 hours',NOW()+INTERVAL '24 hours')`, [storeId]);
  await client.query(`INSERT INTO ozon_store_runtime_state(store_id) VALUES($1)`, [storeId]);
  await client.query(`INSERT INTO ozon_store_credential_versions(
    id,store_id,version_no,status,ciphertext,nonce,auth_tag,fingerprint,validated_at,activated_at,retired_at
  ) VALUES
    ($1,$2,3,'ACTIVE','cipher','nonce','tag','active',NOW(),NOW(),NULL),
    ($3,$2,2,'RETIRED','cipher','nonce','tag','fresh-retired',NOW()-INTERVAL '1 hour',NOW()-INTERVAL '2 hours',NOW()),
    ($4,$2,1,'RETIRED','cipher','nonce','tag','expired-retired',NOW()-INTERVAL '25 hours',NOW()-INTERVAL '26 hours',NOW()-INTERVAL '2 hours')`, [
    activeCredentialId, storeId, frozenFreshId, frozenExpiredId
  ]);
  await client.query('UPDATE ozon_stores SET active_credential_version_id=$2 WHERE id=$1', [storeId, activeCredentialId]);
  await client.query(`INSERT INTO ozon_listing_drafts(sku,product_name_snapshot,status,row_version,revision,data) VALUES
    ('9900101','rotation fresh','READY',1,1,'{}'::jsonb),
    ('9900102','rotation expired','READY',1,1,'{}'::jsonb)`);
  await client.query(`INSERT INTO ozon_listing_versions(id,sku,revision,snapshot) VALUES
    ($1,'9900101',1,'{}'::jsonb),($2,'9900102',1,'{}'::jsonb)`, [freshVersionId, expiredVersionId]);
  await client.query(`INSERT INTO ozon_store_publications(
    id,sku,generated_version_id,revision,store_id,store_alias_snapshot,status,source,
    credential_binding_mode,credential_version_id,store_config_version,warehouse_id,
    offer_ids,offer_contract_hash,materialization_hash,package_rel_path,package_signature,
    content_policy_version,material_hash,material_hash_version,plan_hash,preset_row_version,publication_mode
  ) VALUES
    ($1,'9900101',$3,1,$5,'rotation-smoke','QUEUED','MANUAL','VAULT',$6,1,'123','["9900101-01"]'::jsonb,$8,$9,'stores/rotation-smoke/inbox/9900101',$10,'merchroute-ozon-content-v2',$9,'ozon-shared-material-v1',$8,1,'CREATE_ONLY'),
    ($2,'9900102',$4,1,$5,'rotation-smoke','QUEUED','MANUAL','VAULT',$7,1,'123','["9900102-01"]'::jsonb,$8,$9,'stores/rotation-smoke/inbox/9900102',$10,'merchroute-ozon-content-v2',$9,'ozon-shared-material-v1',$8,1,'CREATE_ONLY')`, [
    freshPublicationId, expiredPublicationId, freshVersionId, expiredVersionId, storeId,
    frozenFreshId, frozenExpiredId, `sha256:${'1'.repeat(64)}`, `sha256:${'2'.repeat(64)}`, `sha256:${'3'.repeat(64)}`
  ]);
  await client.query(`INSERT INTO ozon_publish_jobs(
    id,sku,state,source,store_id,store_alias,publication_id,credential_binding_mode,credential_version_id,
    store_config_version,warehouse_id,offer_ids,offer_contract_hash,materialization_hash,listing_revision,
    task_id,task_folder,work_rel_path,directory_stage,directory_signature,task_kind,payload
  ) VALUES
    ($1,'9900101','READY','MANUAL',$3,'rotation-smoke',$6,'VAULT',$4,1,'123','["9900101-01"]'::jsonb,$8,$9,1,'rotation-smoke__9900101__r1','9900101__r1','stores/rotation-smoke/inbox/9900101','INBOX',$10,'STORE_PUBLICATION',jsonb_build_object('contentPolicyVersion','merchroute-ozon-content-v2','materialHash',$9::text,'materialHashVersion','ozon-shared-material-v1','planHash',$8::text,'presetRowVersion',1,'publicationMode','CREATE_ONLY')),
    ($2,'9900102','READY','MANUAL',$3,'rotation-smoke',$7,'VAULT',$5,1,'123','["9900102-01"]'::jsonb,$8,$9,1,'rotation-smoke__9900102__r1','9900102__r1','stores/rotation-smoke/inbox/9900102','INBOX',$10,'STORE_PUBLICATION',jsonb_build_object('contentPolicyVersion','merchroute-ozon-content-v2','materialHash',$9::text,'materialHashVersion','ozon-shared-material-v1','planHash',$8::text,'presetRowVersion',1,'publicationMode','CREATE_ONLY'))`, [
    freshJobId, expiredJobId, storeId, frozenFreshId, frozenExpiredId,
    freshPublicationId, expiredPublicationId, `sha256:${'1'.repeat(64)}`, `sha256:${'2'.repeat(64)}`, `sha256:${'3'.repeat(64)}`
  ]);
  const { OzonStoreRepository } = await import('../apps/server/dist/repositories/ozon-stores.js');
  const repository = new OzonStoreRepository(connectionString);
  try {
    await repository.initialize();
    const first = await repository.claimRuntimeJobs({ leaseOwner: 'rotation-smoke', leaseSeconds: 60, limit: 2 });
    if (!first.some((job) => job.id === freshJobId) || first.some((job) => job.id === expiredJobId)) {
      throw new Error(`轮换后冻结凭据 claim 结果异常：${JSON.stringify(first.map((job) => job.id))}`);
    }
    await client.query(`UPDATE ozon_publish_jobs SET state='SUCCEEDED',lease_owner=NULL,lease_token=NULL,lease_expires_at=NULL
      WHERE id=$1`, [freshJobId]);
    const second = await repository.claimRuntimeJobs({ leaseOwner: 'rotation-smoke-2', leaseSeconds: 60, limit: 2 });
    if (second.some((job) => job.id === expiredJobId)) throw new Error('过期冻结凭据被错误 claim');
  } finally {
    await repository.close().catch(() => undefined);
  }
}

async function assertStrictGatewayAndJobChecks(client) {
  await expectSqlState(client, `INSERT INTO ozon_gateway_requests(
    request_ref,request_hash,payload_hash,store_id,credential_binding_mode,operation,
    delivery_state,retry_class,delegation_state,status_code,response_json
  ) VALUES($1,'request-hash','payload-hash',$2,'LEGACY_PUBLICATION','infoList',
    'RESPONDED','NONE','RECEIPT_RECORDED',NULL,'{}'::jsonb)`, [
    `receipt-null-${randomUUID()}`, defaultStoreId
  ], '23514', 'RESPONDED legacy receipt with NULL status');
  await expectSqlState(client, `INSERT INTO ozon_gateway_requests(
    request_ref,request_hash,payload_hash,store_id,credential_binding_mode,operation,
    delivery_state,retry_class,delegation_state,status_code,response_json
  ) VALUES($1,'request-hash','payload-hash',$2,'LEGACY_PUBLICATION','importProduct',
    'NOT_SENT','RETRYABLE','RECEIPT_RECORDED',500,'{}'::jsonb)`, [
    `receipt-write-500-${randomUUID()}`, defaultStoreId
  ], '23514', 'ambiguous legacy write 500 classified as NOT_SENT');
  await expectSqlState(client, `INSERT INTO ozon_publish_jobs(
    id,sku,state,source,store_alias,credential_binding_mode
  ) VALUES($1,'9900201','SUCCEEDED','MANUAL','default','INVALID_MODE')`, [randomUUID()],
  '23514', 'invalid job credential binding mode');
  await expectSqlState(client, `INSERT INTO ozon_publish_jobs(
    id,sku,state,source,store_alias,credential_binding_mode,credential_version_id
  ) VALUES($1,'9900202','SUCCEEDED','MANUAL','default','VAULT',NULL)`, [randomUUID()],
  '23514', 'VAULT job without credential');
}

async function assertCompoundStoreIdentities(client) {
  const storeA = randomUUID();
  const storeB = randomUUID();
  const credentialB = randomUUID();
  const jobB = randomUUID();
  const aliasA = `compound-a-${process.pid}`.slice(0, 30);
  const aliasB = `compound-b-${process.pid}`.slice(0, 30);
  await client.query(`INSERT INTO ozon_stores(id,store_alias,display_name)
    VALUES($1,$2,'Compound A'),($3,$4,'Compound B')`, [storeA, aliasA, storeB, aliasB]);
  await client.query('INSERT INTO ozon_store_runtime_state(store_id) VALUES($1),($2)', [storeA, storeB]);
  await client.query(`INSERT INTO ozon_store_credential_versions(
    id,store_id,version_no,status,ciphertext,nonce,auth_tag,fingerprint
  ) VALUES($1,$2,1,'PENDING','cipher','nonce','tag','compound-b')`, [credentialB, storeB]);
  await client.query(`INSERT INTO ozon_publish_jobs(
    id,sku,state,source,store_id,store_alias,credential_binding_mode
  ) VALUES($1,'9900301','SUCCEEDED','MANUAL',$2,$3,'PURE_LEGACY')`, [jobB, storeB, aliasB]);

  await expectSqlState(client, `UPDATE ozon_store_runtime_state
    SET preflight_credential_version_id=$2 WHERE store_id=$1`, [storeA, credentialB],
  '23503', 'cross-store preflight credential');
  await expectSqlState(client, `INSERT INTO ozon_platform_status_refresh_leases(
    store_id,sku,job_id,lease_token,listing_row_version,lease_expires_at
  ) VALUES($1,'9900301',$2,$3,1,NOW()+INTERVAL '1 minute')`, [storeA, jobB, randomUUID()],
  '23503', 'cross-store refresh lease job');
  await expectSqlState(client, `INSERT INTO ozon_product_mappings(
    store_id,store_alias,offer_id,sku
  ) VALUES($1,$2,'compound-offer','9900302')`, [storeA, aliasB],
  '23503', 'cross-store mapping alias');
}

async function expectSqlState(client, sql, values, expectedCode, label) {
  await client.query('BEGIN');
  try {
    await client.query(sql, values);
  } catch (error) {
    await client.query('ROLLBACK');
    if (error?.code === expectedCode) return;
    throw new Error(`${label} returned ${error?.code || 'unknown'} instead of ${expectedCode}`);
  }
  await client.query('ROLLBACK');
  throw new Error(`${label} was not rejected`);
}

async function setHardeningRestartSentinel(connectionString, versionId) {
  const client = new Client({ connectionString });
  try {
    await client.connect();
    await client.query(`UPDATE ozon_listing_versions SET material_overrides='{"vat":"0.1"}'::jsonb WHERE id=$1`, [versionId]);
  } finally { await client.end().catch(() => undefined); }
}

async function assertHardeningRestartSentinel(connectionString, versionId) {
  const client = new Client({ connectionString });
  try {
    await client.connect();
    const value = (await client.query('SELECT material_overrides FROM ozon_listing_versions WHERE id=$1', [versionId])).rows[0]?.material_overrides;
    if (JSON.stringify(value) !== JSON.stringify({ vat: '0.1' })) {
      throw new Error(`014 重启覆盖了显式 material_overrides：${JSON.stringify(value)}`);
    }
  } finally { await client.end().catch(() => undefined); }
}

function quoteIdentifier(value) {
  if (!/^ozon_ms_smoke_[0-9]+_[0-9]+$/.test(value)) throw new Error('不安全的 schema 标识符');
  return `"${value}"`;
}
