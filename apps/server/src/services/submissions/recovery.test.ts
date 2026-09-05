import path from 'node:path';
import os from 'node:os';
import { mkdtemp, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { afterEach, describe, expect, it } from 'vitest';
import pino from 'pino';
import type { PendingSubmission } from '@n8n-media-review/shared';
import { StateStore } from '../../repositories/store.js';
import { ReviewOperationService } from '../review-operations.js';
import { SubmissionService } from './index.js';
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) { if (!path.basename(root).startsWith('merchroute-copy-fault-')) throw Error('unsafe cleanup'); await rm(root, { recursive: true, force: true }); }
});
async function fixture(fault?: (next: any, root: string) => Promise<void>) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'merchroute-copy-fault-')); roots.push(root);
  const source = path.join(root, 'source', 'fixture');
  const queue = path.join(root, 'queue'), archive = path.join(root, 'archive'), appData = path.join(root, 'data');
  await Promise.all([source, queue, archive].map((folder) => mkdir(folder, { recursive: true })));
  const images = [];
  for (const name of ['b.png', 'a.png']) {
    await writeFile(path.join(source, name), Buffer.alloc(10_000, name.charCodeAt(0)));
    const info = await stat(path.join(source, name));
    images.push({ relativePath: name, fileName: name, sizeBytes: info.size, lastModifiedAt: info.mtime.toISOString() });
  }
  const pending: PendingSubmission = { id: 'pending', taskId: 'task', sourceStageId: 'E006', targetStageId: 'E001', selectedRelativePaths: ['b.png', 'a.png'], n8nTaskParameters: { SKU: '0000001', productName: 'fixture' }, conflictPolicy: 'new-revision', status: 'PENDING', productSku: '0000001', productNameSnapshot: 'fixture', createdAt: '2026-01-01', updatedAt: '2026-01-01' };
  const config: any = { get: () => ({ submissionConcurrency: 2, stages: [
    { id: 'E006', enabled: true, approvedArchiveRoot: archive, targets: [{ targetStageId: 'E001', targetQueueRoot: queue, folderNameTemplate: '{sourceName}', packageMode: 'preserve-tree', copyRootMetadata: false }] },
    { id: 'E001', enabled: true, targets: [] }
  ] }) };
  const scanner: any = { getTask: async () => ({ taskId: 'task', stageId: 'E006', sourceFolder: source, sourceFolderName: 'fixture', images }), resolveIndexedMedia: async (_task: string, file: string) => ({ absolutePath: path.join(source, file) }) };
  const identity: any = { requirePendingIdentity: async () => ({ sku: '0000001', productName: 'fixture', variants: [] }), inject: (parameters: any) => parameters };
  const make = (store: StateStore) => new SubmissionService(config, store, scanner, identity, pino({ enabled: false }));
  const store = new StateStore(appData, undefined, fault ? { write: async (file, body) => { await fault(JSON.parse(body), root); await writeFile(file, body); } } : undefined);
  await store.initialize();
  await store.update((db) => {
    db.pendingSubmissions.push(pending);
    db.reviews.push({ taskId: 'task', stageId: 'E006', sourceFolder: source, sourceFolderName: 'fixture', selectedRelativePaths: pending.selectedRelativePaths, selectedTargetStageIds: ['E001'], status: 'APPROVED_PENDING_SUBMISSION', createdAt: '2026-01-01', updatedAt: '2026-01-01' });
  });
  return { root, source, queue, archive, store, scanner, service: make(store), restart: async () => { const next = new StateStore(appData); await next.initialize(); return { store: next, service: make(next) }; } };
}
describe('review delivery performance envelope', () => {
  it.each([1, 10])('measures acceptance and 22-file completion at %sx history scale', async (scale) => {
    const f = await fixture();
    const task = await f.scanner.getTask();
    task.images.length = 0;
    for (let index = 0; index < 22; index++) {
      const name = 'bench-' + index + '.png';
      await writeFile(path.join(f.source, name), Buffer.alloc(302180, index));
      const info = await stat(path.join(f.source, name));
      task.images.push({ relativePath: name, fileName: name, sizeBytes: info.size, lastModifiedAt: info.mtime.toISOString() });
    }
    await f.store.update((db) => {
      db.pendingSubmissions[0]!.selectedRelativePaths = task.images.map((row: any) => row.relativePath);
      for (let index = 0; index < 1463 * scale; index++) db.reviews.push({ ...db.reviews[0]!, taskId: 'old-task-' + index, sourceFolder: '/fixture/old/' + index });
      for (let index = 0; index < 2432 * scale; index++) db.submissionHistory.push({
        submissionId: 'old-' + index, taskId: 'old-task-' + index, pendingSubmissionId: 'old-' + index, sourceStageId: 'E006', targetStageId: 'E001',
        sourceFolder: '/fixture/old/' + index, selectedImageCount: 22, selectedRelativePaths: task.images.map((row: any) => row.relativePath),
        n8nTaskParameters: { fixture: 'x'.repeat(1750) }, status: 'SUCCESS', startedAt: '2026-01-01'
      });
    });
    const databaseBytes = (await stat(path.join(f.root, 'data', 'db.json'))).size;
    const operations = new ReviewOperationService(f.store, pino({ enabled: false }));
    operations.register('BATCH', (operation) => f.service.runBatch('perf-' + operation.operationId, operation.input.pendingSubmissionIds as string[], 'new-revision'));
    await operations.start();
    const template = f.store.getPending('pending')!;
    const samples = Math.min(20, Math.max(1, Number(process.env.MERCHROUTE_REVIEW_BENCHMARK_SAMPLES) || 1));
    const acceptance: number[] = [], completion: number[] = [], writes: number[] = [];
    for (let sample = 0; sample < samples; sample++) {
      const pendingId = sample === 0 ? 'pending' : 'pending-' + sample;
      if (sample) await f.store.updateSections(['pendingSubmissions'], (db) => { db.pendingSubmissions.push({ ...template, id: pendingId }); });
      const initialRevision = f.store.stateRevision;
      const started = performance.now();
      const accepted = await operations.accept({ kind: 'BATCH', requestKey: 'perf-' + sample, request: { id: pendingId }, subjectKeys: ['task:task'], input: { pendingSubmissionIds: [pendingId] } });
      acceptance.push(performance.now() - started);
      const result: any = await operations.wait(accepted.operationId);
      completion.push(performance.now() - started);
      writes.push(f.store.stateRevision - initialRevision);
      expect(result.results[0].status).toBe('SUCCESS');
    }
    await operations.stop();
    const p95 = (values: number[]) => [...values].sort((a, b) => a - b)[Math.ceil(values.length * 0.95) - 1]!;
    console.log('DELIVERY_BENCHMARK ' + JSON.stringify({ scale, samples, databaseBytes, files: 22, mediaBytes: 22 * 302180, acceptedP95Ms: Math.round(p95(acceptance)), totalP95Ms: Math.round(p95(completion)), maxDurableWrites: Math.max(...writes) }));
    // Shared CI hardware has no stable latency budget. Always execute both
    // real-history copy/write-count regressions; enforce latency only in the
    // explicitly requested, isolated performance run.
    if (process.env.MERCHROUTE_REVIEW_BENCHMARK === '1') {
      expect(p95(acceptance)).toBeLessThan(scale === 1 ? 1000 : 2000);
      expect(p95(completion)).toBeLessThan(scale === 1 ? 5000 : 8000);
    }
    expect(Math.max(...writes)).toBeLessThanOrEqual(14);

  }, 300_000);
});

describe('durable file delivery recovery', () => {
  it('persists a source-read failure once and reuses its identity after restarting the same batch', async () => {
    const f = await fixture();
    const readTask = f.scanner.getTask;
    f.scanner.getTask = async () => { throw Error('source cannot be read'); };
    const first = await f.service.runBatch('failed-source-batch', ['pending'], 'new-revision');
    const failure = first.results[0]!;
    expect(failure).toMatchObject({ status: 'FAILED', errorCode: 'SOURCE_FOLDER_MISSING' });
    expect(f.store.getSubmission(failure.submissionId!)).toMatchObject({ sourceFolder: f.source, productSku: '0000001', selectedRelativePaths: ['b.png', 'a.png'] });
    const restarted = await f.restart();
    const replay = await restarted.service.runBatch('failed-source-batch', ['pending'], 'new-revision');
    expect(replay.results).toEqual(first.results);
    expect(restarted.store.section('submissionHistory')).toHaveLength(1);
    expect(await readdir(f.queue)).toEqual([]);
    expect(restarted.store.getPending('pending')?.status).toBe('FAILED');
    f.scanner.getTask = readTask;
    const repaired = await restarted.service.runBatch('failed-source-batch', ['pending'], 'new-revision');
    expect(repaired.results[0]).toMatchObject({ submissionId: failure.submissionId, status: 'SUCCESS' });
    expect(restarted.store.section('submissionHistory')).toHaveLength(1);
  });
  it('does not report or retain a failed delivery when saving its history fails', async () => {
    const f = await fixture(async (next) => {
      if (next.submissionHistory.length) throw Object.assign(Error('disk full'), { code: 'ENOSPC' });
    });
    f.scanner.getTask = async () => { throw Error('missing source'); };
    await expect(f.service.runBatch('failed-save-batch', ['pending'], 'new-revision')).rejects.toMatchObject({ code: 'ENOSPC' });
    expect(f.store.section('submissionHistory')).toEqual([]);
    expect(f.store.getBatch('failed-save-batch')!.items[0]).not.toHaveProperty('submissionId');
    const restarted = await f.restart();
    expect(restarted.store.section('submissionHistory')).toEqual([]);
    const recovered = await restarted.service.runBatch('failed-save-batch', ['pending'], 'new-revision');
    expect(recovered.results[0]?.status).toBe('FAILED');
    expect(restarted.store.section('submissionHistory')).toHaveLength(1);
  });
  it.each(['PREPARING', 'VERIFIED', 'COMMIT_INTENT'])('rebuilds only uncommitted staging after %s save fails', async (phase) => {
    let failed = false;
    const f = await fixture(async (next) => {
      if (!failed && next.deliveryCheckpoints?.some((row: any) => row.phase === phase)) { failed = true; throw Object.assign(Error('disk full'), { code: 'ENOSPC' }); }
    });
    await expect(f.service.runBatch('batch', ['pending'], 'new-revision')).rejects.toBeDefined();
    expect((await readdir(f.queue)).filter((name) => name !== '.staging')).toEqual([]);
    const recovered = await f.restart();
    const result = await recovered.service.runBatch('batch', ['pending'], 'new-revision');
    expect(result.results[0]?.status).toBe('SUCCESS');
    expect((await readdir(f.queue)).filter((name) => name !== '.staging')).toEqual(['fixture']);
    expect(recovered.store.section('submissionHistory')).toHaveLength(1);
  });
  it('finishes an archive even when a consumer immediately removes the queue directory', async () => {
    let consumed = false;
    const f = await fixture(async (next, root) => {
      const checkpoint = next.deliveryCheckpoints?.find((row: any) => row.phase === 'TARGET_COMMITTED');
      if (checkpoint && !consumed) { consumed = true; await rename(checkpoint.targetFinal, path.join(root, 'consumed')); }
    });
    const result = await f.service.runBatch('batch', ['pending'], 'new-revision');
    expect(result.results[0]?.status).toBe('SUCCESS');
    expect(await readFile(path.join(f.archive, 'fixture', 'b.png'))).toEqual(Buffer.alloc(10_000, 'b'.charCodeAt(0)));
    expect(JSON.parse(await readFile(path.join(f.archive, 'fixture', 'selection-manifest.json'), 'utf8')).selectedFiles.map((row: any) => row.sourceRelativePath)).toEqual(['b.png', 'a.png']);
  });
  it('keeps the same submission when the target exists after a receipt write failure', async () => {
    let failed = false;
    const f = await fixture(async (next) => {
      if (!failed && next.deliveryCheckpoints?.some((row: any) => row.phase === 'TARGET_COMMITTED')) { failed = true; throw Error('receipt unavailable'); }
    });
    await expect(f.service.runBatch('batch', ['pending'], 'new-revision')).rejects.toBeDefined();
    const id = f.store.section('deliveryCheckpoints')![0]!.submissionId;
    const recovered = await f.restart();
    f.scanner.getTask = async () => { throw Error('source already gone'); };
    const result = await recovered.service.runBatch('batch', ['pending'], 'new-revision');
    expect(result.results[0]).toMatchObject({ submissionId: id, status: 'SUCCESS' });
    expect((await readdir(f.queue)).filter((name) => name !== '.staging')).toEqual(['fixture']);
  });
  it('holds an unknown consumed target for readback instead of enqueueing a revision', async () => {
    let failed = false;
    const f = await fixture(async (next, root) => {
      const checkpoint = next.deliveryCheckpoints?.find((row: any) => row.phase === 'TARGET_COMMITTED');
      if (checkpoint && !failed) { failed = true; await rename(checkpoint.targetFinal, path.join(root, 'consumed')); throw Error('crash before receipt'); }
    });
    await expect(f.service.runBatch('batch', ['pending'], 'new-revision')).rejects.toBeDefined();
    const recovered = await f.restart();
    await expect(recovered.service.runBatch('batch', ['pending'], 'new-revision')).rejects.toMatchObject({ code: 'DELIVERY_OUTCOME_UNKNOWN' });
    expect(recovered.store.section('deliveryCheckpoints')![0]!.phase).toBe('NEEDS_ATTENTION');
    expect((await readdir(f.queue)).filter((name) => name !== '.staging')).toEqual([]);
    expect((await readdir(path.join(f.archive, '.staging'))).length).toBe(1);
  });
});
