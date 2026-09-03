import path from 'node:path';
import pino from 'pino';
import type { FastifyBaseLogger } from 'fastify';
import { loadRuntimeEnvironment } from '../runtime-environment.js';
import { WbStoreRepository } from '../repositories/wb-stores.js';
import { WbSourceMediaCleanupRepository } from '../repositories/wb-source-media-cleanup.js';
import { WbSourceMediaCleanupService } from '../services/wb-source-media/index.js';
import { WbSourceMediaFiles } from '../services/wb-source-media/source-files.js';
import { LegacyRootCompatibility } from '../utils/legacy-root-compatibility.js';

const projectRoot = path.resolve(import.meta.dirname, '../../../..');
loadRuntimeEnvironment({ projectRoot });

const args = new Map(process.argv.slice(2).map((argument) => {
  const [key, ...rest] = argument.split('=');
  return [key, rest.join('=') || 'true'];
}));
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('未配置 DATABASE_URL');

const cleanupRepository = new WbSourceMediaCleanupRepository(databaseUrl);
const storeRepository = new WbStoreRepository(databaseUrl);
await storeRepository.initialize();
await cleanupRepository.initialize();
const logger = pino({ level: 'silent' }) as unknown as FastifyBaseLogger;
const legacyRootCompatibility = LegacyRootCompatibility.fromEnvironment();
const service = new WbSourceMediaCleanupService(
  cleanupRepository,
  new WbSourceMediaFiles(),
  logger,
  (value) => legacyRootCompatibility.canonicalizePath(value)
);

try {
  if (args.has('--inspect-orphan') || args.has('--supersede-orphan')) {
    const orphanId = String(args.get('--supersede-orphan') || args.get('--inspect-orphan') || '');
    if (!/^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(orphanId)) throw new Error('孤儿批次检查必须提供有效 UUID');
    if (args.has('--supersede-orphan')) {
      const rowVersion = Number(args.get('--row-version'));
      if (!Number.isInteger(rowVersion) || rowVersion < 1) {
        throw new Error('废止孤儿批次必须同时提供 --row-version=<正整数>');
      }
      const superseded = await service.supersedeOrphanAutomaticBatch(orphanId, rowVersion);
      process.stdout.write(`${JSON.stringify({ mode: 'supersede-orphan', superseded: true, batch: superseded })}\n`);
    } else {
      const inspection = await service.inspectOrphanAutomaticBatch(orphanId);
      process.stdout.write(`${JSON.stringify({
        mode: 'inspect-orphan',
        ...inspection,
        note: '未修改数据库或目录；apply 必须使用 --supersede-orphan=<UUID> 与当前 rowVersion，并会再次完整校验'
      })}\n`);
    }
  } else if (args.has('--apply')) {
    const candidateId = String(args.get('--candidate') || '');
    const rowVersion = Number(args.get('--row-version'));
    if (!/^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(candidateId) || !Number.isInteger(rowVersion) || rowVersion < 1) {
      throw new Error('apply 必须同时提供 --candidate=<UUID> 和 --row-version=<正整数>');
    }
    const activated = await service.applyHistorical(candidateId, rowVersion);
    process.stdout.write(`${JSON.stringify({ mode: 'apply', queued: true, candidate: activated })}\n`);
  } else {
    const settings = await storeRepository.getSettings();
    const skus = String(args.get('--sku') || '').split(',').map((value) => value.trim()).filter(Boolean);
    const items = await service.planHistorical(settings.rootDirectory, skus.length ? skus : undefined);
    for (const item of items) process.stdout.write(`${JSON.stringify({ mode: 'dry-run', ...item })}\n`);
    process.stdout.write(`${JSON.stringify({
      mode: 'dry-run-summary',
      candidates: items.filter((item) => item.eligible).length,
      skipped: items.filter((item) => !item.eligible).length,
      candidateBytes: items.filter((item) => item.eligible).reduce((sum, item) => sum + item.totalBytes, 0),
      note: '未删除任何目录；apply 必须使用上述 candidateId 与 rowVersion，并会再次完整校验'
    })}\n`);
  }
} finally {
  await Promise.all([cleanupRepository.close(), storeRepository.close()]);
}
