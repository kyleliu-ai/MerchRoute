import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { OzonStoreRepository } from '../apps/server/src/repositories/ozon-stores.js';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const rawArgs = process.argv.slice(2);
const parsedArgs = rawArgs.map((entry) => {
  const separator = entry.indexOf('=');
  return separator < 0 ? [entry, 'true'] : [entry.slice(0, separator), entry.slice(separator + 1)];
}) as Array<[string, string]>;
const allowedArgs = new Set(['--apply', '--job-id', '--expected-row-version']);
if (parsedArgs.some(([key]) => !allowedArgs.has(key))
  || new Set(parsedArgs.map(([key]) => key)).size !== parsedArgs.length
  || parsedArgs.some(([key, value]) => key === '--apply' && value !== 'true')) {
  throw new Error('参数无效：仅支持 --job-id、--expected-row-version 与独立的 --apply');
}
const args = new Map(parsedArgs);
const apply = args.has('--apply');
const jobId = String(args.get('--job-id') || '').trim();
const expectedRowVersion = Number(args.get('--expected-row-version'));
if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(jobId)) {
  throw new Error('必须显式传入 --job-id=<UUID>');
}
if (!Number.isSafeInteger(expectedRowVersion) || expectedRowVersion < 1) {
  throw new Error('必须显式传入 --expected-row-version=<正整数>');
}
const databaseUrl = process.env.DATABASE_URL || readEnvValue(path.join(projectRoot, '.env'), 'DATABASE_URL');
if (!databaseUrl) throw new Error('缺少 DATABASE_URL，无法核验 OZON 媒体 fan-out 收口');

const repository = new OzonStoreRepository(databaseUrl);
try {
  // Recovery tooling must never run schema migrations implicitly, including in dry-run mode.
  await repository.initialize({ migrate: false });
  const result = await repository.reconcileRepresentedMediaFanoutPreparation({
    jobId,
    expectedRowVersion,
    dryRun: !apply
  });
  process.stdout.write(`${JSON.stringify({ mode: apply ? 'apply' : 'dry-run', ...result }, null, 2)}\n`);
} finally {
  await repository.close();
}

function readEnvValue(filePath: string, key: string): string {
  if (!existsSync(filePath)) return '';
  const line = readFileSync(filePath, 'utf8')
    .split(/\r?\n/)
    .find((entry) => entry.trim().startsWith(`${key}=`));
  if (!line) return '';
  const value = line.slice(line.indexOf('=') + 1).trim();
  return value.replace(/^(['"])(.*)\1$/, '$2');
}
