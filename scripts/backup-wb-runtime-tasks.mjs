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
const outputArg = process.argv.find((value) => value.startsWith('--output='));
const taskIds = process.argv.slice(2).filter((value) => !value.startsWith('--output='));
if (!outputArg || !taskIds.length) throw new Error('请传入 --output=<absolute-json-path> 和 taskId');
const output = path.resolve(outputArg.slice('--output='.length));
if (!path.isAbsolute(output) || path.extname(output).toLowerCase() !== '.json') throw new Error('output 必须是绝对 JSON 路径');
const relativeToProject = path.relative(root, output);
if (!relativeToProject.startsWith('..' + path.sep) && !path.isAbsolute(relativeToProject)) {
  throw new Error('output 必须位于 MerchRoute 仓库之外');
}
if (taskIds.some((value) => !/^[a-z0-9][a-z0-9-]{1,31}__[0-9]{7}__r[1-9]\d*$/i.test(value))) throw new Error('taskId 格式无效');
if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL 未配置');

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
try {
  const jobs = await pool.query(`SELECT task_id,store_id,store_alias,product_code,revision,state,row_version,
    publication_id,created_at,updated_at
    FROM wb_publish_jobs WHERE task_id=ANY($1::text[]) ORDER BY task_id`, [taskIds]);
  const publications = await pool.query(`SELECT id,task_id,store_id,store_alias_snapshot,sku,status,
    generated_version_id,revision,source,request_key,plan_hash,materialization_hash,package_rel_path,
    package_signature,row_version,created_at,updated_at
    FROM wb_store_publications WHERE task_id=ANY($1::text[]) ORDER BY task_id`, [taskIds]);
  const versionIds = publications.rows.map((row) => String(row.generated_version_id));
  const versions = await pool.query(`SELECT id,sku,revision,status,n8n_task_id,
    material_preset_definition_hash,generation_scope,materialization_hash,
    generated_at,submitted_at,completed_at,created_at,updated_at
    FROM wb_listing_versions WHERE id=ANY($1::uuid[]) ORDER BY revision,id`, [versionIds]);
  const events = await pool.query(`SELECT id,task_id,store_id,publication_id,event_type,
    from_state,to_state,message,details,created_at
    FROM wb_publish_events WHERE task_id=ANY($1::text[]) ORDER BY task_id,created_at,id`, [taskIds]);
  if (jobs.rowCount !== taskIds.length || publications.rowCount !== taskIds.length || versions.rowCount !== taskIds.length) {
    throw new Error('任务、publication 或物化版本数量不完整，拒绝生成不完整备份');
  }
  const value = {
    schemaVersion: 1,
    capturedAt: new Date().toISOString(),
    taskIds,
    jobs: jobs.rows,
    publications: publications.rows,
    versions: versions.rows,
    events: events.rows
  };
  fs.mkdirSync(path.dirname(output), { recursive: true });
  const temporary = `${output}.tmp-${process.pid}`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  fs.renameSync(temporary, output);
  const readback = JSON.parse(fs.readFileSync(output, 'utf8'));
  if (readback.jobs?.length !== taskIds.length || readback.publications?.length !== taskIds.length) {
    throw new Error('备份写后回读失败');
  }
  console.log(JSON.stringify({ ok: true, output, bytes: fs.statSync(output).size,
    jobs: jobs.rowCount, publications: publications.rowCount, versions: versions.rowCount, events: events.rowCount }, null, 2));
} finally {
  await pool.end();
}
