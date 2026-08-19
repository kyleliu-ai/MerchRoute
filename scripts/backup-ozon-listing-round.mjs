import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { Pool } from 'pg';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sku = readArgument('--sku') || '0000054';
if (!/^\d{7}$/.test(sku)) throw new Error('SKU 必须是 7 位数字');

const databaseUrl = process.env.DATABASE_URL || readEnvValue(path.join(projectRoot, '.env'), 'DATABASE_URL');
if (!databaseUrl) throw new Error('缺少 DATABASE_URL，无法备份 OZON 上品轮次');

const pool = new Pool({ connectionString: databaseUrl, max: 1 });
try {
  const [listingResult, jobsResult, mappingsResult, settingsResult] = await Promise.all([
    pool.query('SELECT * FROM ozon_listing_drafts WHERE sku=$1', [sku]),
    pool.query('SELECT * FROM ozon_publish_jobs WHERE sku=$1 ORDER BY created_at,id', [sku]),
    pool.query('SELECT * FROM ozon_product_mappings WHERE sku=$1 ORDER BY store_alias,offer_id', [sku]),
    pool.query("SELECT root_directory FROM ozon_system_settings WHERE id='default'")
  ]);
  const listing = listingResult.rows[0];
  if (!listing) throw new Error(`OZON 上品草稿不存在：${sku}`);
  const jobIds = jobsResult.rows.map((job) => job.id);
  const eventsResult = jobIds.length
    ? await pool.query('SELECT * FROM ozon_publish_events WHERE job_id=ANY($1::uuid[]) ORDER BY created_at,id', [jobIds])
    : { rows: [] };
  const rootDirectory = String(settingsResult.rows[0]?.root_directory || '').trim();
  if (!path.isAbsolute(rootDirectory)) throw new Error('OZON 任务根目录不是绝对路径');

  const productDirectory = path.join(rootDirectory, 'inbox', sku);
  const productJsonPath = path.join(productDirectory, 'product.json');
  const readyPath = path.join(productDirectory, '_READY');
  const intakePath = path.join(productDirectory, '.ozon-intake.json');
  const productJson = readOptionalFile(productJsonPath);
  const ready = readOptionalFile(readyPath);
  const intake = readOptionalFile(intakePath);
  const backupDirectory = path.join(projectRoot, 'backups', `${timestampForPath()}-ozon-${sku}-stale-round`);
  fs.mkdirSync(backupDirectory, { recursive: true });
  if (productJson) fs.copyFileSync(productJsonPath, path.join(backupDirectory, 'product.json'));
  if (ready) fs.copyFileSync(readyPath, path.join(backupDirectory, '_READY'));
  if (intake) fs.copyFileSync(intakePath, path.join(backupDirectory, '.ozon-intake.json'));
  const databaseBackupPath = path.join(backupDirectory, 'database-before.json');
  fs.writeFileSync(databaseBackupPath, `${JSON.stringify(redactSecrets({
    createdAt: new Date().toISOString(),
    sku,
    listing,
    jobs: jobsResult.rows,
    events: eventsResult.rows,
    mappings: mappingsResult.rows,
    disk: {
      productDirectory,
      productJsonSha256: productJson ? sha256(productJson) : null,
      readySha256: ready ? sha256(ready) : null,
      intakePresent: Boolean(intake)
    }
  }), null, 2)}\n`, 'utf8');
  process.stdout.write(`${JSON.stringify({
    sku,
    listingRevision: Number(listing.revision),
    listingRowVersion: Number(listing.row_version),
    jobCount: jobsResult.rows.length,
    intakePresent: Boolean(intake),
    productJsonPresent: Boolean(productJson),
    readyPresent: Boolean(ready),
    backupDirectory,
    databaseBackupPath
  }, null, 2)}\n`);
} finally {
  await pool.end();
}

function readArgument(name) {
  const prefix = `${name}=`;
  return process.argv.find((entry) => entry.startsWith(prefix))?.slice(prefix.length).trim();
}

function readOptionalFile(filePath) {
  try {
    const info = fs.lstatSync(filePath);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error(`文件不是安全普通文件：${filePath}`);
    return fs.readFileSync(filePath);
  } catch (error) {
    if (error?.code === 'ENOENT') return undefined;
    throw error;
  }
}

function sha256(value) {
  return `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`;
}

function timestampForPath() {
  return new Date().toISOString().replaceAll(':', '-').replace(/\.\d{3}Z$/, 'Z');
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

function redactSecrets(value) {
  if (Array.isArray(value)) return value.map(redactSecrets);
  if (value instanceof Date) return value.toISOString();
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([key, child]) => [
    key,
    /api.?key|authorization|bearer|password|secret|credential|client.?id/i.test(key)
      ? '[REDACTED]'
      : redactSecrets(child)
  ]));
}
