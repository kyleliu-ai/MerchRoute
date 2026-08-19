import { access, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const E007_WORKFLOW_ID = 'G8MSbp9u0dudSgba';
export const BLOCKING_EXECUTION_STATUSES = Object.freeze(['new', 'running', 'unknown', 'waiting']);

function parseOptions(argv) {
  return new Map(argv.map((item) => {
    const [key, ...rest] = item.replace(/^--/, '').split('=');
    return [key, rest.length ? rest.join('=') : 'true'];
  }));
}

function parseEnv(content) {
  const output = {};
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const index = line.indexOf('=');
    if (index > 0) output[line.slice(0, index)] = line.slice(index + 1);
  }
  return output;
}

export function assertValidTablePrefix(value = '') {
  if (!/^[A-Za-z0-9_]*$/.test(value)) throw new Error('DB_TABLE_PREFIX 含非法字符，拒绝拼接 SQL 标识符');
  return value;
}

export function summarizeExecutionGuard(rows, phase) {
  const totalCount = Number(rows[0]?.totalCount ?? rows.length);
  const blockers = rows.map((row) => ({
    id: String(row.id),
    status: String(row.status),
    startedAt: row.startedAt ? new Date(row.startedAt).toISOString() : null,
    waitTill: row.waitTill ? new Date(row.waitTill).toISOString() : null,
  }));
  return {
    schemaVersion: 1,
    phase,
    workflowId: E007_WORKFLOW_ID,
    safe: totalCount === 0,
    blockingStatuses: [...BLOCKING_EXECUTION_STATUSES],
    blockingExecutionCount: totalCount,
    blockers,
    blockersTruncated: totalCount > blockers.length,
    databaseMutated: false,
  };
}

export async function auditN8nUpdateState({ envFile, phase = 'pre-stop' }) {
  if (!['pre-stop', 'post-start'].includes(phase)) throw new Error('--phase 只允许 pre-stop 或 post-start');
  await access(envFile);
  const runtime = parseEnv(await readFile(envFile, 'utf8'));
  if (runtime.DB_TYPE !== 'postgresdb') throw new Error('升级守卫仅支持当前受控的 PostgreSQL n8n 数据库');
  const required = ['DB_POSTGRESDB_HOST', 'DB_POSTGRESDB_PORT', 'DB_POSTGRESDB_DATABASE', 'DB_POSTGRESDB_USER', 'DB_POSTGRESDB_PASSWORD'];
  const missing = required.filter((key) => !runtime[key]);
  if (missing.length) throw new Error(`n8n.env 缺少数据库字段：${missing.join(', ')}`);
  const prefix = assertValidTablePrefix(runtime.DB_TABLE_PREFIX || '');
  const tableName = `"${prefix}execution_entity"`;
  const { default: pg } = await import('pg');
  const client = new pg.Client({
    host: runtime.DB_POSTGRESDB_HOST,
    port: Number(runtime.DB_POSTGRESDB_PORT),
    database: runtime.DB_POSTGRESDB_DATABASE,
    user: runtime.DB_POSTGRESDB_USER,
    password: runtime.DB_POSTGRESDB_PASSWORD,
    application_name: 'merchroute-n8n-upgrade-guard',
    connectionTimeoutMillis: 10_000,
    statement_timeout: 10_000,
  });
  try {
    await client.connect();
    const result = await client.query(
      `SELECT id, status, "startedAt", "waitTill", COUNT(*) OVER()::int AS "totalCount"
       FROM ${tableName}
       WHERE "workflowId" = $1
         AND status = ANY($2::text[])
         AND "deletedAt" IS NULL
       ORDER BY id DESC
       LIMIT 50`,
      [E007_WORKFLOW_ID, [...BLOCKING_EXECUTION_STATUSES]],
    );
    return summarizeExecutionGuard(result.rows, phase);
  } finally {
    await client.end().catch(() => undefined);
  }
}

async function main() {
  const options = parseOptions(process.argv.slice(2));
  const defaultHome = process.platform === 'win32'
    ? path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'MerchRoute')
    : path.join(os.homedir(), 'Library', 'Application Support', 'MerchRoute');
  const appHome = path.resolve(options.get('app-home') || process.env.MERCHROUTE_APP_HOME || defaultHome);
  const envFile = path.resolve(options.get('env-file') || path.join(appHome, 'secrets', 'n8n.env'));
  const phase = options.get('phase') || 'pre-stop';
  if (options.get('dry-run') === 'true') {
    console.log(JSON.stringify({
      dryRun: true,
      phase,
      workflowId: E007_WORKFLOW_ID,
      envFile,
      readOnly: true,
      blockingStatuses: [...BLOCKING_EXECUTION_STATUSES],
    }, null, 2));
    return;
  }
  const report = await auditN8nUpdateState({ envFile, phase });
  console.log(JSON.stringify(report, null, 2));
  if (!report.safe) {
    throw new Error(`E007 仍有 ${report.blockingExecutionCount} 条非终态 n8n 执行；已停止升级，禁止直接改库或盲目重放`);
  }
}

const isDirectRun = process.argv[1]
  && pathToFileURL(path.resolve(process.argv[1])).href === pathToFileURL(fileURLToPath(import.meta.url)).href;
if (isDirectRun) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
