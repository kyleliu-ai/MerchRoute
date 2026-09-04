import path from 'node:path';
import os from 'node:os';
import { mkdtemp, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { afterEach, describe, expect, it } from 'vitest';
import type { ReviewOperationMetrics } from '@n8n-media-review/shared';
import { StateStore } from '../../repositories/store.js';
import { reviewOperationContext } from '../../utils/review-operation-context.js';
import { VariantMediaDeliveryService } from './index.js';
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) { if (!path.basename(root).startsWith('merchroute-terminal-fault-')) throw Error('unsafe cleanup'); await rm(root, { recursive: true, force: true }); }
});
async function fixture(observeWrite?: (database: any) => void) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'merchroute-terminal-fault-')); roots.push(root);
  const source = path.join(root, 'source'), archive = path.join(root, 'archive');
  await Promise.all([source, archive].map((folder) => mkdir(folder)));
  await writeFile(path.join(source, 'second.png'), Buffer.alloc(2048, 2));
  await writeFile(path.join(source, 'first.png'), Buffer.alloc(2048, 1));
  const images = await Promise.all(['second.png', 'first.png'].map(async (name) => {
    const info = await stat(path.join(source, name));
    return { relativePath: name, fileName: name, sizeBytes: info.size, lastModifiedAt: info.mtime.toISOString() };
  }));
  const stage: any = { id: 'E005', enabled: true, approvedArchiveRoot: archive, outputRoot: path.join(root, 'wb', 'inbox', '<SKU>', 'variants') };
  const input: any = { submissionId: 'stable-terminal-id', platform: 'WB', stage, task: { taskId: 'task', stageId: 'E005', sourceFolder: source, sourceFolderName: 'fixture', images }, selectedRelativePaths: ['second.png', 'first.png'], productSku: '0000001', productName: 'fixture', variantId: 'variant', variantName: 'black' };
  const store = new StateStore(path.join(root, 'data'), undefined, observeWrite ? {
    write: async (file, body) => { const database = JSON.parse(body); observeWrite(database); await writeFile(file, body); }
  } : undefined); await store.initialize();
  const service = new VariantMediaDeliveryService({} as any, undefined, store);
  return { root, input, store, service };
}
describe('terminal manifest recovery', () => {
  it('persists only verified, commit-intent and final checkpoints on a normal delivery', async () => {
    const phases: string[] = [];
    let completedWrite: any;
    const f = await fixture((database) => {
      const phase = database.deliveryCheckpoints?.[0]?.phase;
      if (phase) phases.push(phase);
      if (phase === 'COMPLETE') completedWrite = database;
    });
    await f.service.deliver(f.input);
    expect(phases).toEqual(['VERIFIED', 'COMMIT_INTENT', 'COMPLETE']);
    expect(completedWrite).toMatchObject({
      deliveryOutbox: [{ submissionId: 'stable-terminal-id', status: 'PENDING' }],
      submissionHistory: [{ submissionId: 'stable-terminal-id', status: 'SUCCESS' }],
      appEvents: [{ type: 'WB_MEDIA_DELIVERED', details: { submissionId: 'stable-terminal-id' } }]
    });
  });
  it('reconciles a directory renamed before manifest save without changing submission identity', async () => {
    const f = await fixture();
    const original = (f.service as any).updateManifest.bind(f.service);
    (f.service as any).updateManifest = async () => { throw Error('manifest interrupted'); };
    await expect(f.service.deliver(f.input)).rejects.toThrow('manifest interrupted');
    expect(f.store.section('deliveryCheckpoints')![0]!.phase).toBe('NEEDS_ATTENTION');
    (f.service as any).updateManifest = original;
    await rm(f.input.task.sourceFolder, { recursive: true, force: true });
    const result = await f.service.deliver(f.input);
    expect(result).toMatchObject({ submissionId: 'stable-terminal-id', status: 'SUCCESS' });
    const manifest = JSON.parse(await readFile(result.mediaManifestPath!, 'utf8'));
    expect(manifest.assets.map((row: any) => [row.submissionId, row.sortOrder])).toEqual([['stable-terminal-id', 0], ['stable-terminal-id', 1]]);
    expect(f.store.section('deliveryOutbox')).toHaveLength(1);
    expect((await f.service.deliver(f.input)).submissionId).toBe(result.submissionId);
    expect(f.store.section('submissionHistory')).toHaveLength(1);
  });
  it('does not recreate files when both staging and unacknowledged target disappeared', async () => {
    const f = await fixture();
    (f.service as any).updateManifest = async () => { throw Error('before manifest'); };
    await expect(f.service.deliver(f.input)).rejects.toThrow();
    const checkpoint = f.store.section('deliveryCheckpoints')![0]!;
    await rename(checkpoint.targetFinal, path.join(f.root, 'consumed'));
    const next = new VariantMediaDeliveryService({} as any, undefined, f.store);
    await expect(next.deliver(f.input)).rejects.toMatchObject({ record: { errorCode: 'DELIVERY_OUTCOME_UNKNOWN' } });
    expect(await stat(checkpoint.targetFinal).catch(() => null)).toBeNull();
  });
  it('rejects a corrupted visible target while recovering from a post-manifest interruption', async () => {
    const f = await fixture();
    const original = (f.service as any).saveCheckpoint.bind(f.service);
    let interrupted = false;
    (f.service as any).saveCheckpoint = async (checkpoint: any, completed: boolean, platform: any) => {
      if (completed && !interrupted) { interrupted = true; throw Error('receipt interrupted'); }
      return original(checkpoint, completed, platform);
    };
    await expect(f.service.deliver(f.input)).rejects.toThrow('receipt interrupted');
    const checkpoint = f.store.section('deliveryCheckpoints')![0]!;
    await writeFile(path.join(checkpoint.targetFinal, 'second.png'), Buffer.alloc(2048, 9));
    const restarted = new VariantMediaDeliveryService({} as any, undefined, f.store);
    await expect(restarted.deliver(f.input)).rejects.toMatchObject({ record: { errorCode: 'DELIVERY_OUTCOME_UNKNOWN' } });
    expect(f.store.section('deliveryCheckpoints')![0]!.phase).toBe('NEEDS_ATTENTION');
  });
  it('reuses the submission and creates one outbox receipt after a valid post-manifest recovery', async () => {
    const f = await fixture();
    const original = (f.service as any).saveCheckpoint.bind(f.service);
    let interrupted = false;
    (f.service as any).saveCheckpoint = async (checkpoint: any, completed: boolean, platform: any) => {
      if (completed && !interrupted) { interrupted = true; throw Error('receipt interrupted'); }
      return original(checkpoint, completed, platform);
    };
    await expect(f.service.deliver(f.input)).rejects.toThrow('receipt interrupted');
    const restarted = new VariantMediaDeliveryService({} as any, undefined, f.store);
    const result = await restarted.deliver(f.input);
    expect(result).toMatchObject({ submissionId: 'stable-terminal-id', status: 'SUCCESS' });
    expect(f.store.section('deliveryOutbox')).toHaveLength(1);
    expect(f.store.section('submissionHistory')).toHaveLength(1);
  });
});

describe('terminal delivery performance envelope', () => {
  it.each([
    { stageId: 'E004', fileCount: 1, totalBytes: 10 * 1024 * 1024, extension: '.mp4', budgetMs: 10_000 },
    { stageId: 'E005', fileCount: 7, totalBytes: 3 * 1024 * 1024, extension: '.png', budgetMs: 15_000 }
  ])('$stageId completes a two-platform synthetic delivery within its isolated budget', async ({ stageId, fileCount, totalBytes, extension, budgetMs }) => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'merchroute-terminal-fault-')); roots.push(root);
    const source = path.join(root, 'source');
    const archive = path.join(root, 'archive');
    await Promise.all([source, archive, path.join(root, 'ozon')].map((directory) => mkdir(directory, { recursive: true })));
    const names = Array.from({ length: fileCount }, (_, index) => `${String(index + 1).padStart(2, '0')}${extension}`);
    const sizes = names.map((_name, index) => Math.floor(totalBytes / fileCount) + (index === 0 ? totalBytes % fileCount : 0));
    const images = [];
    for (const [index, name] of names.entries()) {
      await writeFile(path.join(source, name), Buffer.alloc(sizes[index]!, index + 1));
      const info = await stat(path.join(source, name));
      images.push({ relativePath: name, fileName: name, sizeBytes: info.size, lastModifiedAt: info.mtime.toISOString() });
    }
    const stage: any = {
      id: stageId,
      enabled: true,
      approvedArchiveRoot: archive,
      outputRoot: path.join(root, 'wb', 'inbox', '<SKU>', 'variants'),
      ozonOutputRoot: path.join(root, 'ozon', 'inbox', '<SKU>', 'variants')
    };
    const task: any = { taskId: `task-${stageId}`, stageId, sourceFolder: source, sourceFolderName: `fixture-${stageId}`, images };
    const store = new StateStore(path.join(root, 'data')); await store.initialize();
    await store.updateSections(['submissionHistory'], (db) => {
      for (let index = 0; index < 2457; index += 1) db.submissionHistory.push({
        submissionId: `history-${index}`,
        pendingSubmissionId: `history-${index}`,
        taskId: `history-task-${index}`,
        sourceStageId: stageId,
        targetStageId: 'HISTORY_FIXTURE',
        sourceFolder: `/fixture/history/${index}`,
        selectedImageCount: fileCount,
        selectedRelativePaths: names,
        n8nTaskParameters: { fixture: 'x'.repeat(1750) },
        status: 'SUCCESS',
        startedAt: '2026-01-01T00:00:00.000Z'
      });
    });
    const databaseBytes = (await stat(path.join(root, 'data', 'db.json'))).size;
    const service = new VariantMediaDeliveryService({} as any, undefined, store);
    const started = performance.now();
    const metrics: ReviewOperationMetrics = { queueMs: 0 };
    await reviewOperationContext.run({ operationId: `benchmark-${stageId}`, metrics }, async () => {
      await service.deliver({ submissionId: `${stageId}-wb`, platform: 'WB', stage, task, selectedRelativePaths: names, productSku: '0000001', productName: 'fixture', variantId: 'variant', variantName: 'black' });
      await service.deliver({ submissionId: `${stageId}-ozon`, platform: 'OZON', stage, task, selectedRelativePaths: names, productSku: '0000001', productName: 'fixture', variantId: 'variant', variantName: 'black', archiveMedia: false });
    });
    const elapsedMs = performance.now() - started;
    console.log('TERMINAL_DELIVERY_BENCHMARK ' + JSON.stringify({ stageId, platforms: 2, fileCount, totalBytes, databaseBytes, elapsedMs: Math.round(elapsedMs), phases: metrics.phases }));
    expect(store.section('deliveryOutbox')).toHaveLength(2);
    if (process.env.MERCHROUTE_REVIEW_BENCHMARK === '1') expect(elapsedMs).toBeLessThan(budgetMs);
  }, 60_000);
});
