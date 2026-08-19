import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { Pool } from 'pg';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const apply = process.argv.includes('--apply');
const databaseUrl = process.env.DATABASE_URL || readEnvValue(path.join(projectRoot, '.env'), 'DATABASE_URL');

if (!databaseUrl) {
  throw new Error('缺少 DATABASE_URL，无法核对 OZON 历史任务目录');
}

const pool = new Pool({ connectionString: databaseUrl, max: 1 });
const report = {
  mode: apply ? 'apply' : 'dry-run',
  startedAt: new Date().toISOString(),
  rootDirectory: '',
  eligible: [],
  alreadyReconciled: [],
  updatedMetadata: [],
  conflicts: [],
  missing: [],
  ignored: []
};

try {
  const settingsResult = await pool.query(`
    SELECT root_directory
    FROM ozon_system_settings
    WHERE id='default'
  `);
  const rootDirectory = String(settingsResult.rows[0]?.root_directory || '').trim();
  if (!rootDirectory || !path.isAbsolute(rootDirectory)) {
    throw new Error('OZON 上品配置缺少有效的绝对任务根目录');
  }
  report.rootDirectory = rootDirectory;

  const rootInfo = fs.lstatSync(rootDirectory);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) {
    throw new Error('OZON 任务根目录必须是真实目录，不能是文件或符号链接');
  }
  const rootReal = fs.realpathSync(rootDirectory);
  const jobsResult = await pool.query(`
    SELECT id,sku,state,source,finished_at,payload,store_alias,offer_ids,
           listing_revision,task_folder,work_rel_path,directory_stage,directory_signature
    FROM ozon_publish_jobs
    ORDER BY created_at,id
  `);
  const jobs = new Map(jobsResult.rows.map((job) => [String(job.id), job]));
  const markers = discoverMarkers(rootReal);
  const seenJobIds = new Set();

  for (const candidate of markers) {
    const outcome = inspectCandidate(candidate, jobs, rootReal);
    if (outcome.jobId) seenJobIds.add(outcome.jobId);
    if (!outcome.ok) {
      report.conflicts.push(outcome);
      continue;
    }
    if (!outcome.moveRequired && !outcome.metadataRequired) {
      report.alreadyReconciled.push(outcome.summary);
      continue;
    }
    report.eligible.push(outcome.summary);
    if (!apply) continue;

    try {
      if (outcome.moveRequired) {
        fs.mkdirSync(path.dirname(outcome.targetDirectory), { recursive: true });
        assertSafePath(rootReal, path.dirname(outcome.targetDirectory));
        if (fs.existsSync(outcome.targetDirectory)) {
          const existing = inspectExistingTarget(outcome.targetDirectory, outcome.expected);
          report.conflicts.push({
            path: outcome.sourceRelPath,
            jobId: outcome.jobId,
            reason: existing.ok
              ? '源目录与完全匹配的目标目录同时存在；为避免自动删除或覆盖，已停止补偿'
              : `目标目录冲突：${existing.reason}`
          });
          continue;
        }
        fs.renameSync(outcome.sourceDirectory, outcome.targetDirectory);
      }

      await updateJobDirectoryMetadata(pool, outcome);
      if (outcome.moveRequired) {
        report.updatedMetadata.push({
          jobId: outcome.jobId,
          sku: outcome.sku,
          from: outcome.sourceRelPath,
          to: outcome.targetRelPath,
          directoryStage: outcome.directoryStage
        });
      } else {
        report.updatedMetadata.push({
          jobId: outcome.jobId,
          sku: outcome.sku,
          path: outcome.targetRelPath,
          directoryStage: outcome.directoryStage
        });
      }
    } catch (error) {
      report.conflicts.push({
        path: outcome.sourceRelPath,
        jobId: outcome.jobId,
        reason: `补偿失败：${errorMessage(error)}；可在修复原因后幂等重试`
      });
    }
  }

  for (const job of jobs.values()) {
    const revision = jobRevision(job);
    const hasDirectoryEvidence = revision > 0
      || Boolean(job.work_rel_path)
      || Boolean(job.task_folder)
      || Boolean(job.payload?.productJsonPath);
    if (!hasDirectoryEvidence || seenJobIds.has(String(job.id))) continue;
    report.missing.push({
      jobId: String(job.id),
      sku: String(job.sku),
      revision,
      state: String(job.state),
      reason: '未找到可校验的 .ozon-intake.json；按安全规则不自动重建或移动'
    });
  }
} finally {
  await pool.end();
}

report.finishedAt = new Date().toISOString();
report.counts = {
  eligible: report.eligible.length,
  alreadyReconciled: report.alreadyReconciled.length,
  updatedMetadata: report.updatedMetadata.length,
  conflicts: report.conflicts.length,
  missing: report.missing.length,
  ignored: report.ignored.length
};
console.log(JSON.stringify(report, null, 2));
if (report.conflicts.length) process.exitCode = 2;

function discoverMarkers(rootReal) {
  const candidates = [];
  const inbox = path.join(rootReal, 'inbox');
  const processing = path.join(rootReal, 'processing');
  const success = path.join(rootReal, 'success');
  for (const directory of directChildDirectories(inbox)) candidates.push(readMarkerCandidate(directory, rootReal, 'INBOX'));
  for (const directory of directChildDirectories(processing)) candidates.push(readMarkerCandidate(directory, rootReal, 'PROCESSING'));
  for (const dateDirectory of directChildDirectories(success)) {
    for (const directory of directChildDirectories(dateDirectory)) candidates.push(readMarkerCandidate(directory, rootReal, 'SUCCESS'));
  }
  return candidates;
}

function directChildDirectories(parent) {
  if (!fs.existsSync(parent)) return [];
  assertSafeDirectory(parent);
  return fs.readdirSync(parent, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink())
    .map((entry) => path.join(parent, entry.name));
}

function readMarkerCandidate(directory, rootReal, discoveredStage) {
  const markerPath = path.join(directory, '.ozon-intake.json');
  if (!fs.existsSync(markerPath)) {
    return { directory, rootReal, discoveredStage, markerPath, marker: undefined };
  }
  let marker;
  try {
    marker = JSON.parse(fs.readFileSync(markerPath, 'utf8').replace(/^\uFEFF/, ''));
  } catch (error) {
    marker = { __parseError: error instanceof Error ? error.message : String(error) };
  }
  return { directory, rootReal, discoveredStage, markerPath, marker };
}

function inspectCandidate(candidate, jobs, rootReal) {
  const sourceDirectory = candidate.directory;
  const sourceRelPath = portableRelative(rootReal, sourceDirectory);
  if (!candidate.marker) {
    return {
      ok: false,
      path: sourceRelPath,
      reason: '目录缺少 .ozon-intake.json；按安全规则忽略'
    };
  }
  if (candidate.marker.__parseError) {
    return {
      ok: false,
      path: sourceRelPath,
      reason: `.ozon-intake.json 无法解析：${candidate.marker.__parseError}`
    };
  }
  try {
    assertSafePath(rootReal, sourceDirectory);
    assertSafeRegularFile(candidate.markerPath);
  } catch (error) {
    return { ok: false, path: sourceRelPath, reason: errorMessage(error) };
  }

  const jobId = String(candidate.marker.jobId || '').trim();
  const sku = String(candidate.marker.sku || '').trim();
  const revision = Number(candidate.marker.revision);
  const markerSignature = String(candidate.marker.signature || '').trim();
  const job = jobs.get(jobId);
  if (!job) return { ok: false, path: sourceRelPath, jobId, sku, reason: 'marker 对应任务不存在' };
  if (String(job.sku) !== sku) {
    return { ok: false, path: sourceRelPath, jobId, sku, reason: 'marker SKU 与数据库任务不一致' };
  }
  const expectedRevision = jobRevision(job);
  if (!Number.isInteger(revision) || revision < 1 || revision !== expectedRevision) {
    return {
      ok: false,
      path: sourceRelPath,
      jobId,
      sku,
      reason: `marker revision 与数据库任务不一致：marker=${revision}，job=${expectedRevision}`
    };
  }

  const productJsonPath = path.join(sourceDirectory, 'product.json');
  try {
    assertSafeRegularFile(productJsonPath);
  } catch (error) {
    return { ok: false, path: sourceRelPath, jobId, sku, reason: errorMessage(error) };
  }
  let product;
  try {
    product = JSON.parse(fs.readFileSync(productJsonPath, 'utf8').replace(/^\uFEFF/, ''));
  } catch (error) {
    return { ok: false, path: sourceRelPath, jobId, sku, reason: `product.json 无法解析：${errorMessage(error)}` };
  }
  if (String(product.productCode || '') !== sku || Number(product.revision) !== revision) {
    return { ok: false, path: sourceRelPath, jobId, sku, reason: 'product.json 的 SKU 或 revision 与 marker 不一致' };
  }
  const signature = normalizedProductSignature(product);
  if (!markerSignature || signature !== markerSignature) {
    return { ok: false, path: sourceRelPath, jobId, sku, reason: 'product.json 规范化签名与 marker 不一致' };
  }
  if (job.directory_signature && String(job.directory_signature) !== signature) {
    return { ok: false, path: sourceRelPath, jobId, sku, reason: '数据库目录签名与 marker 不一致' };
  }

  const taskFolder = `${sku}__r${revision}`;
  if (job.task_folder && String(job.task_folder) !== taskFolder) {
    return { ok: false, path: sourceRelPath, jobId, sku, reason: '数据库任务文件夹与稳定命名规则不一致' };
  }
  const state = String(job.state);
  const directoryStage = state === 'SUCCEEDED' ? 'SUCCESS' : 'PROCESSING';
  const targetRelPath = directoryStage === 'SUCCESS'
    ? path.posix.join('success', shanghaiDate(job.finished_at || new Date()), taskFolder)
    : path.posix.join('processing', taskFolder);
  const targetDirectory = resolvePortableRelative(rootReal, targetRelPath);
  const expected = { jobId, sku, revision, signature };
  const currentMatchesTarget = samePath(sourceDirectory, targetDirectory);
  const metadataRequired = String(job.work_rel_path || '').replaceAll('\\', '/') !== targetRelPath
    || String(job.directory_stage || '').toUpperCase() !== directoryStage
    || String(job.task_folder || '') !== taskFolder
    || String(job.directory_signature || '') !== signature;
  const summary = {
    jobId,
    sku,
    revision,
    source: String(job.source),
    state,
    signature,
    from: sourceRelPath,
    to: targetRelPath,
    directoryStage,
    action: currentMatchesTarget ? (metadataRequired ? 'UPDATE_METADATA' : 'NONE') : 'MOVE'
  };
  return {
    ok: true,
    jobId,
    sku,
    revision,
    signature,
    sourceDirectory,
    sourceRelPath,
    targetDirectory,
    targetRelPath,
    directoryStage,
    taskFolder,
    expected,
    moveRequired: !currentMatchesTarget,
    metadataRequired,
    summary
  };
}

function inspectExistingTarget(targetDirectory, expected) {
  try {
    assertSafeDirectory(targetDirectory);
    const markerPath = path.join(targetDirectory, '.ozon-intake.json');
    const productPath = path.join(targetDirectory, 'product.json');
    assertSafeRegularFile(markerPath);
    assertSafeRegularFile(productPath);
    const marker = JSON.parse(fs.readFileSync(markerPath, 'utf8').replace(/^\uFEFF/, ''));
    const product = JSON.parse(fs.readFileSync(productPath, 'utf8').replace(/^\uFEFF/, ''));
    const signature = normalizedProductSignature(product);
    const matches = String(marker.jobId) === expected.jobId
      && String(marker.sku) === expected.sku
      && Number(marker.revision) === expected.revision
      && String(marker.signature) === expected.signature
      && signature === expected.signature;
    return matches ? { ok: true } : { ok: false, reason: '目标 marker、身份或签名不匹配' };
  } catch (error) {
    return { ok: false, reason: errorMessage(error) };
  }
}

async function updateJobDirectoryMetadata(connection, outcome) {
  await connection.query('BEGIN');
  try {
    const result = await connection.query(`
      UPDATE ozon_publish_jobs
      SET task_folder=$2::text,work_rel_path=$3::text,directory_stage=$4::text,directory_signature=$5::text,
          payload=(COALESCE(payload,'{}'::jsonb) - 'productJsonPath' - 'workDirectory')
            || jsonb_build_object(
              'taskFolder',$2::text,
              'workRelPath',$3::text,
              'directoryStage',$4::text,
              'directorySignature',$5::text
            ),
          row_version=row_version+1,updated_at=NOW()
      WHERE id=$1::uuid AND sku=$6::text
      RETURNING id
    `, [
      outcome.jobId,
      outcome.taskFolder,
      outcome.targetRelPath,
      outcome.directoryStage,
      outcome.signature,
      outcome.sku
    ]);
    if (!result.rows[0]) throw new Error('目录移动后数据库任务不存在，已停止元数据更新');
    await connection.query(`
      INSERT INTO ozon_publish_events(
        id,job_id,event_type,from_state,to_state,message,payload
      )
      SELECT $2::uuid,id,'TASK_DIRECTORY_RECONCILED',state,state,
             '历史 OZON 任务目录已按 marker 和签名完成安全补偿',
             jsonb_build_object(
               'taskFolder',$3::text,
               'workRelPath',$4::text,
               'directoryStage',$5::text,
               'directorySignature',$6::text
             )
      FROM ozon_publish_jobs
      WHERE id=$1::uuid
    `, [
      outcome.jobId,
      crypto.randomUUID(),
      outcome.taskFolder,
      outcome.targetRelPath,
      outcome.directoryStage,
      outcome.signature
    ]);
    await connection.query('COMMIT');
  } catch (error) {
    await connection.query('ROLLBACK');
    throw error;
  }
}

function jobRevision(job) {
  const listingRevision = Number(job.listing_revision || 0);
  const payloadRevision = Number(job.payload?.revision || 0);
  return Math.max(listingRevision, payloadRevision);
}

function normalizedProductSignature(product) {
  return `sha256:${crypto.createHash('sha256').update(JSON.stringify(product)).digest('hex')}`;
}

function resolvePortableRelative(rootReal, relative) {
  const segments = String(relative).split('/');
  if (segments.some((segment) => !segment || segment === '.' || segment === '..')) {
    throw new Error(`非法 OZON 相对目录：${relative}`);
  }
  const resolved = path.resolve(rootReal, ...segments);
  assertInsideRoot(rootReal, resolved);
  return resolved;
}

function portableRelative(rootReal, value) {
  assertInsideRoot(rootReal, value);
  return path.relative(rootReal, value).split(path.sep).join('/');
}

function assertInsideRoot(rootReal, value) {
  const relative = path.relative(rootReal, path.resolve(value));
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`目录逃逸 OZON 任务根目录：${value}`);
  }
}

function assertSafePath(rootReal, value) {
  assertInsideRoot(rootReal, value);
  const relative = path.relative(rootReal, path.resolve(value));
  let current = rootReal;
  for (const segment of relative.split(path.sep)) {
    current = path.join(current, segment);
    const info = fs.lstatSync(current);
    if (info.isSymbolicLink()) throw new Error(`路径包含符号链接：${current}`);
  }
  if (fs.realpathSync(value) !== path.resolve(value)) throw new Error(`路径 realpath 不一致：${value}`);
}

function assertSafeDirectory(value) {
  const info = fs.lstatSync(value);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`不是安全的真实目录：${value}`);
}

function assertSafeRegularFile(value) {
  const info = fs.lstatSync(value);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error(`不是安全的普通文件：${value}`);
}

function samePath(left, right) {
  const leftResolved = path.resolve(left);
  const rightResolved = path.resolve(right);
  return process.platform === 'win32'
    ? leftResolved.toLocaleLowerCase() === rightResolved.toLocaleLowerCase()
    : leftResolved === rightResolved;
}

function shanghaiDate(value) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(new Date(value));
  const map = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${map.year}-${map.month}-${map.day}`;
}

function readEnvValue(filePath, key) {
  if (!fs.existsSync(filePath)) return '';
  const line = fs.readFileSync(filePath, 'utf8')
    .split(/\r?\n/)
    .find((entry) => entry.trim().startsWith(`${key}=`));
  if (!line) return '';
  const value = line.slice(line.indexOf('=') + 1).trim();
  return value.replace(/^(['"])(.*)\1$/, '$2');
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}
