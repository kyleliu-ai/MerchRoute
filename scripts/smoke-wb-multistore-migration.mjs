import { spawnSync } from 'node:child_process';
import { access } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import pg from 'pg';

const { Client } = pg;
const args = process.argv.slice(2);
const apply = args.includes('--apply');
const dumpArg = args.find((value) => value.startsWith('--dump='));
const dumpPath = dumpArg ? path.resolve(dumpArg.slice('--dump='.length)) : '';
const pgRestore = process.env.PG_RESTORE_BIN || 'pg_restore';
const databaseUrl = process.env.DATABASE_URL || '';
const defaultStoreId = '00000000-0000-4000-8000-000000000001';
const expectedMigrations = [
  '028_wb_multi_store_foundation',
  '029_wb_auto_publish_multi_store',
  '030_wb_auto_publish_store_constraints',
  '031_wb_credential_validation_history',
  '032_wb_material_preset_identity',
  '033_wb_auto_material_preset_identity',
  '034_wb_store_auto_activation',
  '035_wb_store_publication_materialization',
  '036_wb_auto_generation_leases',
  '037_wb_card_upload_attempts',
  '038_wb_card_upload_retry_fencing'
];

if (!apply || !dumpPath || !databaseUrl) {
  console.log(`WB 多店铺旧库迁移烟雾测试（只允许一次性临时数据库）

用法：
  node scripts/smoke-wb-multistore-migration.mjs --apply --dump=<pg_dump custom 文件>

必需环境变量：DATABASE_URL
可选环境变量：PG_RESTORE_BIN
`);
  process.exit(apply ? 1 : 0);
}

await access(dumpPath);
const sourceUrl = new URL(databaseUrl);
const databaseName = `merchroute_wb_ms_smoke_${new Date().toISOString().replace(/\D/g, '').slice(0, 14)}_${process.pid}`.toLowerCase();
if (!/^merchroute_wb_ms_smoke_[0-9]{14}_[0-9]+$/.test(databaseName)) throw new Error('临时数据库名称边界校验失败');
const temporaryUrl = new URL(sourceUrl);
temporaryUrl.pathname = `/${databaseName}`;
const admin = new Client({ connectionString: sourceUrl.toString() });
let created = false;

try {
  await admin.connect();
  await admin.query(`CREATE DATABASE ${quoteIdentifier(databaseName)}`);
  created = true;

  const restored = spawnSync(pgRestore, [
    '--exit-on-error',
    '--no-owner',
    '--no-privileges',
    '--host', sourceUrl.hostname,
    '--port', sourceUrl.port || '5432',
    '--username', decodeURIComponent(sourceUrl.username),
    '--dbname', databaseName,
    dumpPath
  ], {
    encoding: 'utf8',
    windowsHide: true,
    shell: false,
    maxBuffer: 16 * 1024 * 1024,
    env: { ...process.env, PGPASSWORD: decodeURIComponent(sourceUrl.password) }
  });
  if (restored.error || restored.status !== 0) {
    throw new Error(`pg_restore 失败（exit=${restored.status ?? 'spawn'}）：${redact(String(restored.stderr || restored.error || 'unknown'))}`);
  }

  const before = await legacySnapshot(temporaryUrl.toString());
  await initializeRepositories(temporaryUrl.toString());
  const first = await migratedSnapshot(temporaryUrl.toString(), before.multiStoreFoundation);
  assertMigration(before, first);

  await initializeRepositories(temporaryUrl.toString());
  const second = await migratedSnapshot(temporaryUrl.toString(), before.multiStoreFoundation);
  assertStable(first, second);

  console.log(JSON.stringify({
    ok: true,
    temporaryDatabase: databaseName,
    restoredFrom: path.basename(dumpPath),
    migrations: expectedMigrations,
    preservedRows: Object.fromEntries(Object.entries(before.keys).map(([name, values]) => [name, values.length])),
    defaultStoreMode: first.defaultMapping.store.credential_state,
    idempotentSecondInitialization: true
  }, null, 2));
} finally {
  if (created) {
    await admin.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1 AND pid<>pg_backend_pid()', [databaseName]).catch(() => undefined);
    await admin.query(`DROP DATABASE IF EXISTS ${quoteIdentifier(databaseName)}`).catch((error) => {
      throw new Error(`临时数据库清理失败：${redact(String(error?.message || error))}`);
    });
  }
  await admin.end().catch(() => undefined);
}

async function initializeRepositories(connectionString) {
  const [{ WbRepository }, { WbPresetRepository }, { WbStoreRepository }, { WbAutoPublishRepository }] = await Promise.all([
    import('../apps/server/dist/repositories/wb.js'),
    import('../apps/server/dist/repositories/wb-presets.js'),
    import('../apps/server/dist/repositories/wb-stores.js'),
    import('../apps/server/dist/repositories/wb-auto-publish.js')
  ]);
  const repositories = [
    new WbRepository(connectionString),
    new WbPresetRepository(connectionString),
    new WbStoreRepository(connectionString),
    new WbAutoPublishRepository(connectionString)
  ];
  try {
    for (const repository of repositories) await repository.initialize();
  } finally {
    for (const repository of repositories.reverse()) await repository.close().catch(() => undefined);
  }
}

async function legacySnapshot(connectionString) {
  return withClient(connectionString, async (client) => ({
    database: await currentDatabase(client),
    keys: await historicalKeys(client),
    runtime: (await client.query("SELECT * FROM wb_runtime_config WHERE config_id='default'")).rows[0],
    multiStoreFoundation: Boolean((await client.query(`SELECT EXISTS(
      SELECT 1 FROM information_schema.tables WHERE table_schema=current_schema() AND table_name='wb_schema_migrations'
    ) present`)).rows[0]?.present
      && (await client.query("SELECT EXISTS(SELECT 1 FROM wb_schema_migrations WHERE id='028_wb_multi_store_foundation') present")).rows[0]?.present)
  }));
}

async function migratedSnapshot(connectionString, multiStoreFoundation = false) {
  return withClient(connectionString, async (client) => {
    const database = await currentDatabase(client);
    if (!database.startsWith('merchroute_wb_ms_smoke_')) throw new Error(`拒绝在非临时数据库执行迁移断言：${database}`);
    const migrations = (await client.query(`SELECT id,applied_at::text FROM wb_schema_migrations
      WHERE id=ANY($1::text[]) ORDER BY id`, [expectedMigrations])).rows;
    const issues = await migrationIssues(client, multiStoreFoundation);
    const autoIds = (await client.query('SELECT store_id::text,sku::text,id::text FROM wb_auto_publish_jobs ORDER BY store_id,sku')).rows;
    const defaultMapping = await loadDefaultMapping(client);
    const columns = (await client.query(`SELECT table_name,column_name,data_type
      FROM information_schema.columns WHERE table_schema=current_schema() AND (table_name,column_name) IN (
        ('wb_listing_versions','material_preset_definition_hash'),
        ('wb_listing_versions','generation_scope'),
        ('wb_listing_versions','materialization_hash'),
        ('wb_store_publications','preset_definition_hash'),
        ('wb_store_publications','request_key'),
        ('wb_store_publications','plan_hash'),
        ('wb_store_publications','materialization_hash'),
        ('wb_store_publications','package_rel_path'),
        ('wb_store_publications','package_signature'),
        ('wb_auto_publish_jobs','material_preset_definition_hash'),
        ('wb_stores','auto_publish_activated_at'),
        ('wb_auto_generation_leases','owner_job_id'),
        ('wb_auto_generation_leases','owner_run_id'),
        ('wb_auto_generation_leases','owner_store_id'),
        ('wb_auto_generation_leases','phase'),
        ('wb_auto_generation_leases','source_version_id'),
        ('wb_auto_generation_leases','lease_until'),
        ('wb_auto_generation_leases','row_version'),
        ('wb_gateway_requests','logical_intent_id'),
        ('wb_gateway_requests','attempt_no'),
        ('wb_gateway_requests','transport_code'),
        ('wb_gateway_requests','transport_phase')) ORDER BY table_name,column_name`)).rows;
    return { database, keys: await historicalKeys(client), migrations, issues, autoIds, defaultMapping, columns };
  });
}

async function migrationIssues(client, multiStoreFoundation) {
  const queries = [
    `WITH expected(id) AS (VALUES ${expectedMigrations.map((_, index) => `($${index + 1})`).join(',')})
      SELECT 'MISSING_MIGRATION' issue,e.id detail FROM expected e LEFT JOIN wb_schema_migrations m USING(id) WHERE m.id IS NULL`,
    `SELECT 'BAD_BACKFILL' issue,source detail FROM (
       SELECT 'publish_jobs' source FROM wb_publish_jobs WHERE store_id IS DISTINCT FROM '${defaultStoreId}'::uuid OR store_alias<>'default'
       UNION ALL SELECT 'publish_events' FROM wb_publish_events WHERE store_id IS DISTINCT FROM '${defaultStoreId}'::uuid
       UNION ALL SELECT 'registry' FROM wb_product_registry WHERE store_id IS DISTINCT FROM '${defaultStoreId}'::uuid OR store_alias<>'default'
       UNION ALL SELECT 'auto_jobs' FROM wb_auto_publish_jobs WHERE id IS NULL OR store_id IS DISTINCT FROM '${defaultStoreId}'::uuid
       UNION ALL SELECT 'auto_events' FROM wb_auto_publish_events WHERE job_id IS NULL OR store_id IS DISTINCT FROM '${defaultStoreId}'::uuid
       UNION ALL SELECT 'auto_runs' FROM wb_auto_publish_job_runs WHERE job_id IS NULL OR store_id IS DISTINCT FROM '${defaultStoreId}'::uuid
     ) bad GROUP BY source`,
    `SELECT 'AUTO_EVENT_ORPHAN' issue,e.id::text detail FROM wb_auto_publish_events e
       LEFT JOIN wb_auto_publish_jobs j ON j.id=e.job_id AND j.store_id=e.store_id AND j.sku=e.sku WHERE j.id IS NULL
     UNION ALL SELECT 'AUTO_RUN_ORPHAN',r.run_id::text FROM wb_auto_publish_job_runs r
       LEFT JOIN wb_auto_publish_jobs j ON j.id=r.job_id AND j.store_id=r.store_id AND j.sku=r.sku WHERE j.id IS NULL`,
    `WITH expected(name) AS (VALUES
       ('wb_auto_publish_events_job_id_fkey'),('wb_auto_publish_jobs_store_id_fkey'),('wb_auto_publish_events_store_id_fkey'),
       ('wb_auto_publish_job_runs_store_id_fkey'),('wb_auto_publish_jobs_publication_id_fkey'),
       ('wb_auto_publish_events_publication_id_fkey'),('wb_auto_publish_job_runs_publication_id_fkey'),('wb_auto_publish_job_runs_job_id_fkey'))
     SELECT 'MISSING_OR_INVALID_FK' issue,e.name detail FROM expected e LEFT JOIN pg_constraint c
       ON c.conname=e.name AND c.connamespace=current_schema()::regnamespace AND c.contype='f' AND c.convalidated WHERE c.oid IS NULL`,
    `WITH expected(name) AS (VALUES
       ('wb_publish_jobs_store_idempotency'),('wb_auto_publish_jobs_store_sku'),('wb_auto_publish_job_runs_store_sku_run'),
       ('wb_auto_generation_leases_due'),('wb_gateway_requests_logical_attempt_unique'),('wb_gateway_requests_task_card_history'),
       ('wb_gateway_requests_card_task_attempt_unique'))
     SELECT 'MISSING_OR_INVALID_INDEX' issue,e.name detail FROM expected e LEFT JOIN pg_class x
       ON x.relname=e.name AND x.relnamespace=current_schema()::regnamespace LEFT JOIN pg_index i
       ON i.indexrelid=x.oid AND i.indisvalid AND i.indisready WHERE i.indexrelid IS NULL`,
    `SELECT 'BAD_PRIMARY_KEY' issue,c.conrelid::regclass::text detail FROM pg_constraint c
     WHERE c.connamespace=current_schema()::regnamespace
       AND c.conname IN ('wb_product_registry_pkey','wb_auto_publish_jobs_pkey')
       AND pg_get_constraintdef(c.oid) NOT IN ('PRIMARY KEY (store_id, registry_key)','PRIMARY KEY (id)')`,
    `SELECT 'MISSING_GENERATION_LEASE_TABLE' issue,'wb_auto_generation_leases' detail
       WHERE to_regclass(current_schema()||'.wb_auto_generation_leases') IS NULL
     UNION ALL
     SELECT 'MISSING_CARD_ATTEMPT_CONSTRAINT','wb_gateway_requests_card_attempt_pair'
       WHERE NOT EXISTS(SELECT 1 FROM pg_constraint WHERE connamespace=current_schema()::regnamespace
         AND conname='wb_gateway_requests_card_attempt_pair' AND convalidated)
     UNION ALL
     SELECT 'AUTO_STATE_CHECK_MISSING_WAITING_TURN','wb_auto_publish_jobs_state_check'
       WHERE NOT EXISTS(SELECT 1 FROM pg_constraint WHERE connamespace=current_schema()::regnamespace
         AND conname='wb_auto_publish_jobs_state_check'
         AND pg_get_constraintdef(oid) LIKE '%WAITING_GENERATION_TURN%')`
  ];
  const rows = [];
  for (let index = 0; index < queries.length; index += 1) {
    if (multiStoreFoundation && index === 1) continue;
    rows.push(...(await client.query(queries[index], index === 0 ? expectedMigrations : [])).rows);
  }
  return rows;
}

async function loadDefaultMapping(client) {
  const runtime = (await client.query("SELECT * FROM wb_runtime_config WHERE config_id='default'")).rows[0];
  const settings = (await client.query("SELECT * FROM wb_system_settings WHERE settings_id='default'")).rows[0];
  const store = (await client.query('SELECT * FROM wb_stores WHERE id=$1', [defaultStoreId])).rows[0];
  const state = (await client.query('SELECT * FROM wb_store_runtime_state WHERE store_id=$1', [defaultStoreId])).rows[0];
  return { runtime, settings, store, state };
}

async function historicalKeys(client) {
  const definitions = {
    publishJobs: ['wb_publish_jobs', 'task_id::text'],
    publishEvents: ['wb_publish_events', 'id::text'],
    registry: ['wb_product_registry', 'registry_key::text'],
    autoJobs: ['wb_auto_publish_jobs', 'sku::text'],
    autoEvents: ['wb_auto_publish_events', 'id::text'],
    autoRuns: ['wb_auto_publish_job_runs', 'run_id::text']
  };
  const output = {};
  for (const [name, [table, expression]] of Object.entries(definitions)) {
    const exists = Boolean((await client.query('SELECT to_regclass($1) IS NOT NULL present', [table])).rows[0]?.present);
    output[name] = exists ? (await client.query(`SELECT ${expression} key FROM ${table} ORDER BY 1`)).rows.map((row) => String(row.key)) : [];
  }
  return output;
}

function assertMigration(before, after) {
  if (after.database !== before.database || !after.database.startsWith('merchroute_wb_ms_smoke_')) throw new Error('迁移数据库身份发生变化');
  assertEqual(before.keys, after.keys, '历史主键集合');
  if (after.migrations.length !== expectedMigrations.length) throw new Error('028–038 migration 集合不完整');
  if (after.issues.length) throw new Error(`迁移完整性检查失败：${JSON.stringify(after.issues)}`);
  if (after.columns.length !== 22) throw new Error(`WB 生成租约/建卡尝试列不完整：${JSON.stringify(after.columns)}`);
  if (before.multiStoreFoundation) {
    if (!after.defaultMapping.runtime || !after.defaultMapping.settings || !after.defaultMapping.store || !after.defaultMapping.state) {
      throw new Error('现有多店铺默认映射不完整');
    }
  } else {
    assertDefaultMapping(before.runtime, after.defaultMapping);
  }
}

function assertStable(first, second) {
  assertEqual(first.keys, second.keys, '二次初始化历史主键');
  assertEqual(first.autoIds, second.autoIds, '二次初始化自动任务 ID');
  assertEqual(first.migrations, second.migrations, '二次初始化 migration 时间');
  assertEqual(first.defaultMapping, second.defaultMapping, '二次初始化默认店映射');
  assertEqual(first.columns, second.columns, '二次初始化列定义');
  if (second.issues.length) throw new Error(`二次初始化完整性检查失败：${JSON.stringify(second.issues)}`);
}

function assertDefaultMapping(runtime, mapping) {
  const { settings, store, state } = mapping;
  if (!runtime || !settings || !store || !state) throw new Error('默认 runtime/settings/store/state 映射缺失');
  const expectedConcurrency = Math.min(2, Math.max(1, Number(runtime.dispatch_concurrency || 1)));
  const checks = [
    [settings.enabled, runtime.publish_enabled, 'settings.enabled'],
    [settings.root_directory, runtime.import_root, 'settings.root_directory'],
    [settings.timezone, runtime.timezone, 'settings.timezone'],
    [Number(settings.global_concurrency), expectedConcurrency, 'settings.global_concurrency'],
    [store.enabled, runtime.publish_enabled, 'store.enabled'],
    [store.auto_publish_enabled, runtime.publish_enabled, 'store.auto_publish_enabled'],
    [store.warehouse_id, runtime.warehouse_id, 'store.warehouse_id'],
    [store.account_currency, runtime.price_currency_expected, 'store.account_currency'],
    [Number(store.max_daily_styles), Number(runtime.max_daily_styles), 'store.max_daily_styles'],
    [store.credential_state, runtime.credential_ready ? 'LEGACY_EXTERNAL' : 'MISSING', 'store.credential_state'],
    [store.preflight_status, runtime.credential_ready ? 'STALE' : 'NOT_RUN', 'store.preflight_status'],
    [Number(state.network_attempt), Number(runtime.network_attempt), 'state.network_attempt'],
    [state.network_last_error_code, runtime.network_last_error_code, 'state.network_last_error_code'],
    [state.network_last_error_message, runtime.network_last_error_message, 'state.network_last_error_message']
  ];
  for (const [actual, expected, label] of checks) if (actual !== expected) throw new Error(`${label} 回填不一致`);
  const activation = store.auto_publish_activated_at ? new Date(store.auto_publish_activated_at).toISOString() : null;
  const created = new Date(store.created_at).toISOString();
  if (store.auto_publish_enabled ? activation !== created : activation !== null) throw new Error('store.auto_publish_activated_at 回填不一致');
}

async function currentDatabase(client) {
  return String((await client.query('SELECT current_database() database')).rows[0]?.database || '');
}

async function withClient(connectionString, operation) {
  const client = new Client({ connectionString });
  try { await client.connect(); return await operation(client); }
  finally { await client.end().catch(() => undefined); }
}

function assertEqual(actual, expected, label) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(`${label} 不一致`);
}

function quoteIdentifier(value) {
  if (!/^merchroute_wb_ms_smoke_[a-z0-9_]+$/.test(value)) throw new Error('数据库标识符不安全');
  return `"${value.replaceAll('"', '""')}"`;
}

function redact(value) {
  let output = value;
  if (sourceUrl.password) output = output.replaceAll(sourceUrl.password, '[redacted]');
  return output.replace(/postgres(?:ql)?:\/\/[^\s]+/gi, '[postgres-url-redacted]').slice(0, 2000);
}
