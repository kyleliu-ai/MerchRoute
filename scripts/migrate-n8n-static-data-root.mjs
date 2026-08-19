import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import pg from 'pg';

const options = new Map(process.argv.slice(2).map((argument) => {
  const [key, ...value] = argument.split('=');
  return [key.replace(/^--/, ''), value.join('=')];
}));
const workflowId = options.get('workflow') || 'ieWnRGeC7KdeS1GT';
const expectedVersionId = options.get('version');
const oldRoot = options.get('old') || 'G:\\01_n8n-global';
const newRoot = options.get('new') || 'G:\\01_MerchRoute';
const envFile = options.get('env') || 'D:\\globle_n8n-data\\.n8n\\.env';
const backupRoot = options.get('backup');
if (!expectedVersionId) throw new Error('--version is required');
if (!backupRoot || !path.isAbsolute(backupRoot)) throw new Error('--backup must be an absolute path');

function parseEnv(content) {
  const values = {};
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const match = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) continue;
    let value = match[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    values[match[1]] = value;
  }
  return values;
}

const environment = { ...parseEnv(await readFile(envFile, 'utf8')), ...process.env };
const client = new pg.Client({
  host: environment.DB_POSTGRESDB_HOST || environment.N8N_DB_POSTGRESDB_HOST,
  port: Number(environment.DB_POSTGRESDB_PORT || environment.N8N_DB_POSTGRESDB_PORT || 5432),
  database: environment.DB_POSTGRESDB_DATABASE || environment.N8N_DB_POSTGRESDB_DATABASE,
  user: environment.DB_POSTGRESDB_USER || environment.N8N_DB_POSTGRESDB_USER,
  password: environment.DB_POSTGRESDB_PASSWORD || environment.N8N_DB_POSTGRESDB_PASSWORD,
});

const forms = [
  [oldRoot.replaceAll('\\', '\\\\'), newRoot.replaceAll('\\', '\\\\')],
  [oldRoot, newRoot],
  [oldRoot.replaceAll('\\', '/'), newRoot.replaceAll('\\', '/')],
];
function migrate(value, counter) {
  if (typeof value === 'string') {
    let result = value;
    for (const [before, after] of forms) {
      const count = result.split(before).length - 1;
      if (count > 0) {
        counter.count += count;
        result = result.replaceAll(before, after);
      }
    }
    return result;
  }
  if (Array.isArray(value)) return value.map((item) => migrate(item, counter));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, migrate(item, counter)]));
  return value;
}

await mkdir(backupRoot, { recursive: true });
await client.connect();
try {
  await client.query('BEGIN');
  const result = await client.query('select id, "versionId", "staticData" from workflow_entity where id=$1 for update', [workflowId]);
  if (result.rowCount !== 1) throw new Error(`Workflow ${workflowId} was not found`);
  const before = result.rows[0];
  if (before.versionId !== expectedVersionId) throw new Error(`Workflow ${workflowId} version drifted: ${before.versionId}`);
  const counter = { count: 0 };
  const migrated = migrate(before.staticData, counter);
  if (counter.count !== 1) throw new Error(`Expected exactly one staticData root occurrence; found ${counter.count}`);
  await writeFile(path.join(backupRoot, `${workflowId}-staticData-before.json`), `${JSON.stringify(before, null, 2)}\n`, 'utf8');
  const updated = await client.query('update workflow_entity set "staticData"=$1::json where id=$2 and "versionId"=$3', [JSON.stringify(migrated), workflowId, expectedVersionId]);
  if (updated.rowCount !== 1) throw new Error('Static data update lost its compare-and-set guard');
  const readback = await client.query('select "versionId", "staticData" from workflow_entity where id=$1', [workflowId]);
  const serialized = JSON.stringify(readback.rows[0].staticData);
  if (serialized.includes('01_n8n-global') || !serialized.includes('01_MerchRoute')) throw new Error('Static data readback did not converge');
  await client.query('COMMIT');
  console.log(JSON.stringify({ workflowId, versionId: readback.rows[0].versionId, occurrencesChanged: counter.count, workflowVersionCreated: false }, null, 2));
} catch (error) {
  await client.query('ROLLBACK').catch(() => undefined);
  throw error;
} finally {
  await client.end();
}
