import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import pg from 'pg';

const { Pool } = pg;
const args = process.argv.slice(2);
const apply = args.includes('--apply');
const taskIdsArg = args.find((value) => value.startsWith('--task-ids='));
const taskIds = [...new Set(String(taskIdsArg?.slice('--task-ids='.length) || '')
  .split(',').map((value) => value.trim()).filter(Boolean))];
if (!taskIds.length) throw new Error('必须通过 --task-ids=<taskId,taskId> 明确指定待迁移任务');
if (args.some((value) => value !== '--apply' && value !== '--dry-run' && !value.startsWith('--task-ids='))) {
  throw new Error('仅支持 --dry-run、--apply 与 --task-ids=...');
}
if (args.includes('--apply') && args.includes('--dry-run')) throw new Error('--apply 与 --dry-run 不能同时使用');
if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL 未配置');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const normalized = (value) => String(value || '').replaceAll('\\', '/').replace(/^\/+|\/+$/g, '');
const inside = (root, candidate) => {
  const relative = path.relative(root, candidate);
  return Boolean(relative) && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
};
const shanghaiDate = (value) => {
  const date = value ? new Date(value) : new Date();
  if (Number.isNaN(date.getTime())) throw new Error(`无法从 finished_at 生成上海日期: ${value}`);
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(date);
  const part = (type) => parts.find((entry) => entry.type === type)?.value;
  return `${part('year')}-${part('month')}-${part('day')}`;
};

function requireOrdinaryDirectory(rootReal, candidate, label) {
  const info = fs.lstatSync(candidate);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`${label} 必须是普通目录且不能是链接`);
  const real = fs.realpathSync(candidate);
  if (!inside(rootReal, real)) throw new Error(`${label} 逃逸 OZON 根目录`);
  let cursor = rootReal;
  for (const segment of path.relative(rootReal, candidate).split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, segment);
    const segmentInfo = fs.lstatSync(cursor);
    if (segmentInfo.isSymbolicLink()) throw new Error(`${label} 路径段 ${segment} 是链接`);
  }
  return real;
}

function requireOrdinaryFile(directory, name) {
  const file = path.join(directory, name);
  const info = fs.lstatSync(file);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error(`${directory} 的 ${name} 不是安全普通文件`);
  return file;
}

function validateIdentity(row, directory) {
  const productPath = requireOrdinaryFile(directory, 'product.json');
  const markerPath = requireOrdinaryFile(directory, '.ozon-intake.json');
  const readyPath = requireOrdinaryFile(directory, '_READY');
  const marker = JSON.parse(fs.readFileSync(markerPath, 'utf8').replace(/^\uFEFF/, ''));
  const ready = JSON.parse(fs.readFileSync(readyPath, 'utf8').replace(/^\uFEFF/, ''));
  const expectedRevision = Number(row.listing_revision);
  const expectedSignature = String(row.directory_signature || '').toLowerCase();
  const actualSignature = `sha256:${crypto.createHash('sha256').update(fs.readFileSync(productPath)).digest('hex')}`;
  const mismatches = [];
  if (String(marker.jobId || marker.job_id || '') !== String(row.id)) mismatches.push('marker.jobId');
  if (String(marker.taskId || marker.task_id || '') !== String(row.task_id)) mismatches.push('marker.taskId');
  if (String(marker.storeAlias || marker.store_alias || '').toLowerCase() !== String(row.store_alias).toLowerCase()) mismatches.push('marker.storeAlias');
  if (String(marker.sku || '') !== String(row.sku)) mismatches.push('marker.sku');
  if (Number(marker.revision) !== expectedRevision) mismatches.push('marker.revision');
  if (String(ready.sku || '') !== String(row.sku)) mismatches.push('ready.sku');
  if (Number(ready.revision) !== expectedRevision) mismatches.push('ready.revision');
  if (!/^sha256:[a-f0-9]{64}$/.test(expectedSignature) || actualSignature !== expectedSignature) mismatches.push('product.signature');
  const markerProductHash = String(marker.productContentHash || marker.product_content_hash || '').replace(/^sha256:/, '');
  if (markerProductHash && `sha256:${markerProductHash}` !== expectedSignature) mismatches.push('marker.productContentHash');
  const readyProductHash = String(ready.productContentHash || ready.product_content_hash || '').replace(/^sha256:/, '');
  if (readyProductHash && `sha256:${readyProductHash}` !== expectedSignature) mismatches.push('ready.productContentHash');
  if (mismatches.length) throw new Error(`${row.task_id} 目录身份不一致: ${mismatches.join(', ')}`);
  return { actualSignature, files: fs.readdirSync(directory).sort() };
}

function inventory(directory) {
  const output = [];
  const visit = (current, prefix = '') => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.isSymbolicLink()) throw new Error(`备份清单发现链接: ${path.join(current, entry.name)}`);
      const absolute = path.join(current, entry.name);
      const relative = normalized(path.join(prefix, entry.name));
      if (entry.isDirectory()) visit(absolute, relative);
      else if (entry.isFile()) {
        const bytes = fs.readFileSync(absolute);
        output.push({ relativePath: relative, sizeBytes: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex') });
      } else throw new Error(`备份清单发现非常规文件: ${absolute}`);
    }
  };
  visit(directory);
  return output;
}

function safePayload(row, targetRelPath, targetDirectory, targetStage) {
  const payload = row.payload && typeof row.payload === 'object' && !Array.isArray(row.payload) ? row.payload : {};
  return {
    ...payload,
    workRelPath: targetRelPath,
    workDirectory: targetDirectory,
    productJsonPath: path.join(targetDirectory, 'product.json'),
    directoryStage: targetStage,
    taskFolder: String(row.task_folder)
  };
}

const settings = await pool.query("SELECT root_directory FROM ozon_system_settings WHERE id='default'");
const rootRaw = String(settings.rows[0]?.root_directory || '').trim();
if (!rootRaw || !path.isAbsolute(rootRaw)) throw new Error('OZON root_directory 未配置为绝对路径');
const root = path.resolve(rootRaw);
const rootInfo = fs.lstatSync(root);
if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw new Error('OZON root_directory 不是安全普通目录');
const rootReal = fs.realpathSync(root);

const rowsResult = await pool.query(`
  SELECT id,task_id,sku,state,store_id,store_alias,publication_id,credential_version_id,
         credential_binding_mode,listing_revision,task_folder,work_rel_path,directory_stage,
         directory_signature,payload,row_version,lease_owner,lease_token,lease_expires_at,
         finished_at,created_at,updated_at
  FROM ozon_publish_jobs WHERE task_id = ANY($1::text[]) ORDER BY task_id`, [taskIds]);
if (rowsResult.rowCount !== taskIds.length) {
  const found = new Set(rowsResult.rows.map((row) => String(row.task_id)));
  throw new Error(`未找到全部任务: ${taskIds.filter((taskId) => !found.has(taskId)).join(', ')}`);
}

const plans = [];
for (const row of rowsResult.rows) {
  const taskId = String(row.task_id);
  const sku = String(row.sku);
  const revision = Number(row.listing_revision);
  const taskFolder = `${sku}__r${revision}`;
  const alias = String(row.store_alias || '').toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]{1,31}$/.test(alias) || taskId !== `${alias}__${sku}__r${revision}` || row.task_folder !== taskFolder) {
    throw new Error(`${taskId} 不符合冻结 alias/SKU/revision/taskFolder 身份`);
  }
  if (row.lease_owner || row.lease_token || row.lease_expires_at) throw new Error(`${taskId} 仍持有运行租约，拒绝迁移`);
  const state = String(row.state).toUpperCase();
  const currentRelPath = normalized(row.work_rel_path);
  const currentStage = String(row.directory_stage).toUpperCase();
  let targetStage;
  let targetRelPath;
  if (state === 'SUCCEEDED') {
    const existingDate = currentRelPath.match(/^stores\/[a-z0-9][a-z0-9-]{1,31}\/success\/(\d{4}-\d{2}-\d{2})\//)?.[1];
    targetStage = 'SUCCESS';
    targetRelPath = `success/${existingDate || shanghaiDate(row.finished_at)}/${taskId}`;
  } else if (state === 'NEEDS_ATTENTION' && currentStage === 'PROCESSING') {
    targetStage = 'PROCESSING';
    targetRelPath = `processing/${taskId}`;
  } else {
    throw new Error(`${taskId} 状态 ${state}/${currentStage} 不允许本迁移工具自动分类`);
  }
  const oldPattern = currentStage === 'SUCCESS'
    ? new RegExp(`^stores/${alias}/success/\\d{4}-\\d{2}-\\d{2}/${taskFolder.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`)
    : new RegExp(`^stores/${alias}/processing/${taskFolder.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`);
  const alreadyCentral = currentRelPath === targetRelPath;
  if (!alreadyCentral && !oldPattern.test(currentRelPath)) throw new Error(`${taskId} 当前路径不是已知旧目录: ${currentRelPath}`);
  const source = path.resolve(rootReal, ...currentRelPath.split('/'));
  const target = path.resolve(rootReal, ...targetRelPath.split('/'));
  if (!inside(rootReal, source) || !inside(rootReal, target)) throw new Error(`${taskId} 源或目标路径逃逸 OZON 根目录`);
  const sourceExists = fs.existsSync(source);
  const targetExists = fs.existsSync(target);
  if (alreadyCentral) {
    if (!sourceExists) throw new Error(`${taskId} 数据库已是中央路径但目录不存在`);
    const directory = requireOrdinaryDirectory(rootReal, source, `${taskId} 中央目录`);
    plans.push({ row, taskId, from: currentRelPath, to: targetRelPath, targetStage, source, target, identity: validateIdentity(row, directory), action: 'NOOP' });
    continue;
  }
  if (sourceExists === targetExists) throw new Error(sourceExists
    ? `${taskId} 新旧目录同时存在，拒绝自动选择`
    : `${taskId} 新旧目录均不存在`);
  const authoritative = requireOrdinaryDirectory(rootReal, sourceExists ? source : target, `${taskId} 权威目录`);
  plans.push({ row, taskId, from: currentRelPath, to: targetRelPath, targetStage, source, target,
    identity: validateIdentity(row, authoritative), action: sourceExists ? 'MIGRATE' : 'RECONCILE_DATABASE' });
}

const publicPlans = plans.map((plan) => ({
  taskId: plan.taskId,
  from: plan.from,
  to: plan.to,
  targetStage: plan.targetStage,
  action: plan.action,
  state: plan.row.state,
  rowVersion: Number(plan.row.row_version),
  signature: plan.identity.actualSignature,
  files: plan.identity.files
}));
if (!apply) {
  console.log(JSON.stringify({ ok: true, dryRun: true, root: rootReal, plans: publicPlans }, null, 2));
  await pool.end();
  process.exit(0);
}

const backupDirectory = path.resolve('backups', `${new Date().toISOString().replace(/[:.]/g, '-')}-ozon-central-directory-migration`);
fs.mkdirSync(backupDirectory, { recursive: true });
fs.writeFileSync(path.join(backupDirectory, 'database-rows.json'), `${JSON.stringify(rowsResult.rows, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
fs.writeFileSync(path.join(backupDirectory, 'directory-inventory.json'), `${JSON.stringify(plans.map((plan) => ({
  taskId: plan.taskId,
  from: plan.from,
  to: plan.to,
  files: inventory(fs.existsSync(plan.source) ? plan.source : plan.target)
})), null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });

const completed = [];
for (const plan of plans) {
  if (plan.action === 'NOOP') {
    completed.push({ taskId: plan.taskId, action: 'NOOP', workRelPath: plan.to, rowVersion: Number(plan.row.row_version) });
    continue;
  }
  const moved = plan.action === 'MIGRATE';
  if (moved) {
    fs.mkdirSync(path.dirname(plan.target), { recursive: true });
    fs.renameSync(plan.source, plan.target);
  }
  const client = await pool.connect();
  let transactionOpen = false;
  try {
    await client.query('BEGIN');
    transactionOpen = true;
    const locked = await client.query('SELECT * FROM ozon_publish_jobs WHERE id=$1 FOR UPDATE', [plan.row.id]);
    const current = locked.rows[0];
    if (!current || Number(current.row_version) !== Number(plan.row.row_version)
      || normalized(current.work_rel_path) !== plan.from || current.lease_owner || current.lease_token || current.lease_expires_at) {
      throw new Error(`${plan.taskId} 数据库身份、rowVersion、路径或租约在迁移前已变化`);
    }
    const nextPayload = safePayload(current, plan.to, plan.target, plan.targetStage);
    const updated = await client.query(`UPDATE ozon_publish_jobs
      SET work_rel_path=$2,directory_stage=$3,payload=$4::jsonb,row_version=row_version+1,updated_at=NOW()
      WHERE id=$1 AND row_version=$5 RETURNING row_version`, [
      current.id, plan.to, plan.targetStage, JSON.stringify(nextPayload), current.row_version
    ]);
    if (updated.rowCount !== 1) throw new Error(`${plan.taskId} 数据库 CAS 更新失败`);
    await client.query(`INSERT INTO ozon_publish_events(
      id,job_id,event_type,from_state,to_state,message,payload,store_id,publication_id
    ) SELECT $1,id,'DIRECTORY_LAYOUT_MIGRATED',state,state,$2,$3::jsonb,store_id,publication_id
      FROM ozon_publish_jobs WHERE id=$4`, [
      crypto.randomUUID(), 'OZON 任务目录已迁移到中央 processing/success 生命周期目录',
      JSON.stringify({ from: plan.from, to: plan.to, directoryStage: plan.targetStage, migrationVersion: 1 }), current.id
    ]);
    await client.query('COMMIT');
    transactionOpen = false;
  } catch (error) {
    if (transactionOpen) await client.query('ROLLBACK').catch(() => undefined);
    const readback = await pool.query('SELECT work_rel_path,row_version FROM ozon_publish_jobs WHERE id=$1', [plan.row.id]).catch(() => ({ rows: [] }));
    const durablePath = normalized(readback.rows[0]?.work_rel_path);
    if (durablePath !== plan.to && moved) {
      try { fs.renameSync(plan.target, plan.source); }
      catch (rollbackError) {
        throw new Error(`${plan.taskId} 数据库更新失败且目录回滚失败: ${error.message}; rollback=${rollbackError.message}`);
      }
    }
    if (durablePath !== plan.to) throw error;
  } finally {
    client.release();
  }
  const readback = await pool.query(`SELECT task_id,state,work_rel_path,directory_stage,row_version,lease_owner,lease_token,lease_expires_at,payload
    FROM ozon_publish_jobs WHERE id=$1`, [plan.row.id]);
  const final = readback.rows[0];
  if (!final || final.task_id !== plan.taskId || normalized(final.work_rel_path) !== plan.to
    || String(final.directory_stage) !== plan.targetStage || Number(final.row_version) !== Number(plan.row.row_version) + 1
    || final.lease_owner || final.lease_token || final.lease_expires_at) {
    throw new Error(`${plan.taskId} 迁移后数据库读回不一致`);
  }
  const directory = requireOrdinaryDirectory(rootReal, plan.target, `${plan.taskId} 迁移后目录`);
  validateIdentity(plan.row, directory);
  completed.push({ taskId: plan.taskId, action: plan.action === 'MIGRATE' ? 'MIGRATED' : 'DATABASE_RECONCILED',
    state: final.state, directoryStage: final.directory_stage, workRelPath: final.work_rel_path, rowVersion: final.row_version });
}

console.log(JSON.stringify({ ok: true, dryRun: false, root: rootReal, backupDirectory, completed }, null, 2));
await pool.end();
