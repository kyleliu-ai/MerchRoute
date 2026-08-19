import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import pg from 'pg';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
for (const file of ['.env.runtime', '.env']) {
  const candidate = path.join(root, file);
  if (fs.existsSync(candidate)) dotenv.config({ path: candidate, override: false, quiet: true });
}

const apply = process.argv.includes('--apply');
const taskIds = process.argv.slice(2).filter((value) => value !== '--apply');
if (!taskIds.length || taskIds.some((value) => !/^[a-z0-9][a-z0-9-]{1,31}__[0-9]{7}__r[1-9]\d*$/i.test(value))) {
  throw new Error('请传入一个或多个合法 taskId；默认只读，实际恢复需追加 --apply');
}
if (new Set(taskIds).size !== taskIds.length) throw new Error('taskId 不能重复');
if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL 未配置');

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const client = await pool.connect();

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function vendorCodes(product) {
  const variants = Array.isArray(asObject(product).variants) ? asObject(product).variants : [];
  const values = variants.map((variant) => String(asObject(variant).vendorCode || '').trim());
  if (!values.length || values.some((value) => !/^[A-Za-z0-9._-]+$/.test(value)) || new Set(values).size !== values.length) {
    throw new Error('product.json 缺少唯一且合法的 vendorCode');
  }
  return values;
}

function hasWriteIntent(runtime) {
  const keys = [
    'cardSubmittedAt', 'cardOperation', 'cardCreateIntent', 'cardAddIntent', 'cardUpdateIntent',
    'mediaIntent', 'priceIntentAt', 'priceUploadIds', 'stockIntent', 'stockSubmittedAt', 'finalResult'
  ];
  return keys.some((key) => {
    const value = runtime[key];
    if (Array.isArray(value)) return value.length > 0;
    if (value && typeof value === 'object') return Object.keys(value).length > 0;
    return value !== undefined && value !== null && value !== '';
  });
}

function inside(rootDirectory, candidate) {
  const relative = path.relative(rootDirectory, candidate);
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

async function inspectTask(taskId, lock = false) {
  const result = await client.query(`SELECT
      j.*,p.status publication_status,p.error_code publication_error_code,p.error_message publication_error_message,
      p.generated_version_id,p.store_id publication_store_id,p.task_id publication_task_id,
      v.product_json version_product_json,v.generation_scope,
      settings.root_directory
    FROM wb_publish_jobs j
    JOIN wb_store_publications p ON p.id=j.publication_id
    JOIN wb_listing_versions v ON v.id=p.generated_version_id
    JOIN wb_system_settings settings ON settings.settings_id='default'
    WHERE j.task_id=$1
    ${lock ? 'FOR UPDATE OF j,p' : ''}`, [taskId]);
  const row = result.rows[0];
  if (!row) throw new Error(`${taskId}: 未找到关联 publication 的 WB runtime job`);
  const runtime = asObject(row.result_json);
  const expectedVendorCodes = vendorCodes(row.version_product_json);
  const runtimeVendorCodes = vendorCodes(runtime.product);
  if (String(row.state) !== 'FAILED' || String(row.last_error_code) !== 'MEDIA_TARGETS_EMPTY'
    || String(row.publication_status) !== 'FAILED' || String(row.publication_error_code) !== 'MEDIA_TARGETS_EMPTY') {
    throw new Error(`${taskId}: 仅允许恢复 FAILED/MEDIA_TARGETS_EMPTY`);
  }
  if (String(row.generation_scope) !== 'STORE_PUBLICATION'
    || String(row.publication_task_id) !== taskId
    || String(runtime.submissionMode) !== 'COMPATIBLE_UPSERT'
    || String(runtime.mediaPolicy) !== 'REPLACE_SELECTED') {
    throw new Error(`${taskId}: publication 或 COMPATIBLE_UPSERT 身份不匹配`);
  }
  if (Boolean(row.partial_effects) || (Array.isArray(runtime.cards) && runtime.cards.length) || hasWriteIntent(runtime)) {
    throw new Error(`${taskId}: 已存在平台写入或部分副作用证据，拒绝自动恢复`);
  }
  if (Array.isArray(runtime.mediaTargetVendorCodes) && runtime.mediaTargetVendorCodes.length) {
    throw new Error(`${taskId}: mediaTargetVendorCodes 已非空，拒绝覆盖`);
  }
  if (stable(expectedVendorCodes) !== stable(runtimeVendorCodes)) {
    throw new Error(`${taskId}: 数据库物化版本与 runtime product 的 vendorCode 不一致`);
  }
  const rootDirectory = path.resolve(String(row.root_directory || ''));
  const workDirectory = path.resolve(rootDirectory, ...String(row.work_relpath || '').split('/'));
  if (!inside(rootDirectory, workDirectory)) throw new Error(`${taskId}: work_relpath 越界`);
  const diskProduct = JSON.parse(fs.readFileSync(path.join(workDirectory, 'product.json'), 'utf8'));
  if (stable(diskProduct) !== stable(runtime.product)) throw new Error(`${taskId}: processing/product.json 与 runtime product 不一致`);
  const intake = JSON.parse(fs.readFileSync(path.join(workDirectory, '.intake.json'), 'utf8'));
  if (String(intake.taskId || '') !== taskId
    || String(intake.publicationId || '') !== String(row.publication_id || '')
    || String(intake.mediaPolicy || '') !== 'REPLACE_SELECTED'
    || (Array.isArray(intake.mediaTargetVendorCodes) && intake.mediaTargetVendorCodes.length)) {
    throw new Error(`${taskId}: 原始 intake 证据不符合已知漏传故障特征`);
  }
  const leaseActive = String(row.lease_owner || '')
    && row.lease_expires_at && new Date(row.lease_expires_at).getTime() > Date.now();
  if (leaseActive) throw new Error(`${taskId}: 任务仍持有有效 lease`);
  return { row, runtime, expectedVendorCodes, workDirectory };
}

try {
  const inspected = [];
  for (const taskId of taskIds) inspected.push(await inspectTask(taskId));
  if (!apply) {
    console.log(JSON.stringify({
      ok: true,
      dryRun: true,
      tasks: inspected.map(({ row, expectedVendorCodes, workDirectory }) => ({
        taskId: String(row.task_id), publicationId: String(row.publication_id), storeAlias: String(row.store_alias),
        state: String(row.state), publicationStatus: String(row.publication_status), rowVersion: Number(row.row_version),
        mediaTargetVendorCodes: expectedVendorCodes, workDirectory
      }))
    }, null, 2));
    process.exitCode = 0;
  } else {
    await client.query('BEGIN');
    const recovered = [];
    for (const taskId of taskIds) {
      const { row, runtime, expectedVendorCodes } = await inspectTask(taskId, true);
      const audit = Array.isArray(runtime.audit) ? runtime.audit : [];
      const nextRuntime = {
        ...runtime,
        mediaTargetVendorCodes: expectedVendorCodes,
        replaceSelectedVendorCodes: [],
        audit: [...audit, {
          at: new Date().toISOString(),
          event: 'MEDIA_TARGETS_EMPTY_RECOVERED',
          taskId,
          reason: '店铺手动发布漏传 mediaTargetVendorCodes；由冻结 product.json 唯一推导'
        }]
      };
      const updated = await client.query(`UPDATE wb_publish_jobs SET
          state='QUEUED',resume_state='',next_run_at=NOW(),result_json=$3::jsonb,
          last_error_code='',last_error_message='',finished_at=NULL,lease_owner='',lease_expires_at=NULL,
          updated_at=NOW(),row_version=row_version+1
        WHERE task_id=$1 AND row_version=$2 AND state='FAILED' AND last_error_code='MEDIA_TARGETS_EMPTY'
        RETURNING row_version`, [taskId, Number(row.row_version), JSON.stringify(nextRuntime)]);
      if (updated.rowCount !== 1) throw new Error(`${taskId}: runtime CAS 恢复失败`);
      await client.query(`UPDATE wb_store_publications SET
          status='QUEUED',result_json=$2::jsonb,error_code='',error_message='',completed_at=NULL,
          updated_at=NOW(),row_version=row_version+1
        WHERE id=$1 AND status='FAILED' AND error_code='MEDIA_TARGETS_EMPTY'`, [row.publication_id, JSON.stringify(nextRuntime)]);
      await client.query(`INSERT INTO wb_publish_events(
          id,task_id,event_type,from_state,to_state,message,details,store_id,publication_id)
        VALUES(gen_random_uuid(),$1,'MEDIA_TARGETS_EMPTY_RECOVERED','FAILED','QUEUED',
          '从冻结 product.json 补齐手动发布媒体目标并保留原 taskId',
          $2::jsonb,$3,$4)`, [taskId, JSON.stringify({ mediaTargetVendorCodes: expectedVendorCodes }), row.store_id, row.publication_id]);
      recovered.push({ taskId, publicationId: String(row.publication_id), mediaTargetVendorCodes: expectedVendorCodes,
        previousRowVersion: Number(row.row_version), rowVersion: Number(updated.rows[0].row_version) });
    }
    await client.query('COMMIT');
    console.log(JSON.stringify({ ok: true, dryRun: false, recovered }, null, 2));
  }
} catch (error) {
  if (apply) await client.query('ROLLBACK').catch(() => undefined);
  throw error;
} finally {
  client.release();
  await pool.end();
}
