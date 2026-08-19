import path from 'node:path';
import pino from 'pino';
import type { FastifyBaseLogger } from 'fastify';
import { loadRuntimeEnvironment } from '../runtime-environment.js';
import { OzonSourceMediaCleanupRepository } from '../repositories/ozon-source-media-cleanup.js';
import { OzonSourceMediaCleanupService } from '../services/ozon-source-media/index.js';
import { OzonSourceMediaFiles } from '../services/ozon-source-media/source-files.js';

const projectRoot = path.resolve(import.meta.dirname, '../../../..');
loadRuntimeEnvironment({ projectRoot });

const args = parseArgs(process.argv.slice(2));
const command = String(args.get('_command') || 'plan');
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('未配置 DATABASE_URL');

const cleanupRepository = new OzonSourceMediaCleanupRepository(databaseUrl);
await cleanupRepository.initialize({ migrate: false });
const logger = pino({ level: 'silent' }) as unknown as FastifyBaseLogger;
const service = new OzonSourceMediaCleanupService(cleanupRepository, new OzonSourceMediaFiles(), logger);

try {
  const rootDirectory = await cleanupRepository.getConfiguredRootDirectory();
  if (command === 'status') {
    process.stdout.write(`${JSON.stringify({ mode: 'status', ...(await cleanupRepository.status()) })}\n`);
  } else if (command === 'register' && args.has('--apply')) {
    const generatedVersionId = requiredUuid(args.get('--generated-version-id'), '--generated-version-id');
    const batch = await service.registerHistorical(generatedVersionId, rootDirectory);
    process.stdout.write(`${JSON.stringify({ mode: 'register-apply', queued: true, batch })}\n`);
  } else if (command === 'run' && args.has('--apply')) {
    const cleanupId = args.get('--cleanup-id');
    if (cleanupId) {
      const summary = await service.runOne(requiredUuid(cleanupId, '--cleanup-id'));
      process.stdout.write(`${JSON.stringify({ mode: 'run-apply', summary })}\n`);
    } else {
      const limit = boundedLimit(args.get('--limit'));
      const result = await service.runDue(limit);
      process.stdout.write(`${JSON.stringify({ mode: 'run-apply-limited', limit, result })}\n`);
    }
  } else if (command === 'run') {
    const cleanupId = requiredUuid(args.get('--cleanup-id'), '--cleanup-id');
    const inspection = await service.inspect(cleanupId);
    process.stdout.write(`${JSON.stringify({
      mode: 'run-dry-run',
      ...inspection,
      note: '未修改数据库或目录；apply 必须显式使用 run --apply --cleanup-id=<UUID>，且会再次完整校验'
    })}\n`);
  } else {
    const skus = String(args.get('--sku') || '').split(',').map((value) => value.trim()).filter(Boolean);
    const generatedVersionId = command === 'register'
      ? requiredUuid(args.get('--generated-version-id'), '--generated-version-id')
      : undefined;
    const planned = await service.planHistorical(rootDirectory, skus.length ? skus : undefined);
    const items = generatedVersionId
      ? planned.filter((item) => item.generatedVersionId === generatedVersionId)
      : planned;
    if (generatedVersionId && !items.length) throw new Error('指定 generatedVersionId 不存在、已登记或不具备历史候选身份');
    for (const item of items) process.stdout.write(`${JSON.stringify({ mode: 'plan', ...item })}\n`);
    process.stdout.write(`${JSON.stringify({
      mode: command === 'register' ? 'register-dry-run-summary' : 'plan-summary',
      candidates: items.filter((item) => item.eligible).length,
      skipped: items.filter((item) => !item.eligible).length,
      candidateBytes: items.filter((item) => item.eligible).reduce((sum, item) => sum + item.rawBytes + item.sharedBytes, 0),
      note: '未登记清理批次、未移动或删除目录；历史登记必须单独执行 register --apply'
    })}\n`);
  }
} finally {
  await cleanupRepository.close();
}

function parseArgs(values: string[]): Map<string, string> {
  const result = new Map<string, string>();
  const command = values.find((value) => !value.startsWith('--')) || 'plan';
  result.set('_command', command);
  for (const argument of values.filter((value) => value.startsWith('--'))) {
    const [key, ...rest] = argument.split('=');
    if (key) result.set(key, rest.join('=') || 'true');
  }
  return result;
}

function requiredUuid(value: string | undefined, name: string): string {
  const normalized = String(value || '');
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(normalized)) {
    throw new Error(`${name} 必须是有效 UUID`);
  }
  return normalized;
}

function boundedLimit(value: string | undefined): number {
  const parsed = Number(value || 1);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 100) throw new Error('--limit 必须是 1–100 的整数');
  return parsed;
}
