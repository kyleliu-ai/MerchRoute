import path from 'node:path';
import os from 'node:os';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import pino from 'pino';
import { StateStore } from './store.js';
import { ReviewOperationService } from '../services/review-operations.js';
import { acquireStateWriterLock } from '../utils/state-writer-lock.js';
const roots: string[] = [];
const services: ReviewOperationService[] = [];
const temp = async () => { const root = await mkdtemp(path.join(os.tmpdir(), 'merchroute-durable-test-')); roots.push(root); return root; };
afterEach(async () => {
  await Promise.all(services.splice(0).map((service) => service.stop().catch(() => undefined)));
  for (const root of roots.splice(0)) { if (!path.basename(root).startsWith('merchroute-durable-test-')) throw Error('unsafe cleanup'); await rm(root, { recursive: true, force: true }); }
});
const review = { taskId: 'task', stageId: 'E001', sourceFolder: '/fixture/task', sourceFolderName: 'task', selectedRelativePaths: ['1.jpg'], selectedTargetStageIds: ['E002'], status: 'DRAFT' as const, createdAt: '2026-01-01', updatedAt: '2026-01-01' };

describe('durable review state', () => {
  it('does not publish failed writes and serializes whole transactions against latest committed state', async () => {
    const root = await temp();
    let fail = false;
    const store = new StateStore(root, undefined, { write: async (file, body) => { if (fail) throw Object.assign(new Error('disk full'), { code: 'ENOSPC' }); await writeFile(file, body); } });
    await store.initialize();
    const notify = vi.fn(); store.subscribe(notify);
    fail = true;
    await expect(store.addEvent('FAILED', 'must not appear')).rejects.toThrow('disk full');
    expect(store.section('appEvents')).toEqual([]);
    expect(JSON.parse(await readFile(path.join(root, 'db.json'), 'utf8')).appEvents).toEqual([]);
    expect(notify).not.toHaveBeenCalled();
    fail = false;
    await Promise.all(Array.from({ length: 20 }, (_, i) => store.addEvent('OK', String(i))));
    expect(store.section('appEvents')).toHaveLength(20);
    expect(new Set(store.section('appEvents').map((row) => row.message)).size).toBe(20);
    await expect(store.updateSections(['reviews'], (db) => { db.reviews.push(review); throw Error('abort'); })).rejects.toThrow('abort');
    expect(store.section('reviews')).toEqual([]);
  });
  it('fails closed on corruption without replacing the original state', async () => {
    const root = await temp(); const file = path.join(root, 'db.json');
    await writeFile(file, '{broken');
    await expect(new StateStore(root).initialize()).rejects.toMatchObject({ code: 'STATE_STORE_UNAVAILABLE' });
    expect(await readFile(file, 'utf8')).toBe('{broken');
  });
  it('reuses identity aliases across 66 media checks and isolates unrelated stage updates', async () => {
    const store = new StateStore(await temp()); await store.initialize();
    await store.updateSections(['reviews'], (db) => { db.reviews.push(review, { ...review, taskId: 'second', stageId: 'E003', sourceFolder: '/fixture/second' }); });
    const resolver = vi.fn((stage, folder) => stage + folder);
    store.configureTaskIdResolver(resolver);
    resolver.mockClear();
    for (let i = 0; i < 66; i++) store.resolveRuntimeTaskId('task');
    await store.addEvent('PROGRESS', 'unrelated');
    store.getReview('task');
    expect(resolver).not.toHaveBeenCalled();
    let affected: string[] = []; store.subscribe((event) => { affected = event.stageIds; });
    await store.updateSections(['reviews'], (db) => { db.reviews[0]!.status = 'SUBMITTED'; });
    expect(affected).toEqual(['E001']);
    expect(resolver).not.toHaveBeenCalled();
  });
  it('holds a kernel-owned exclusive writer reservation until close', async () => {
    const root = await temp();
    const release = await acquireStateWriterLock(root);
    await expect(acquireStateWriterLock(root)).rejects.toMatchObject({ code: 'STATE_WRITER_BUSY' });
    await release();
    await (await acquireStateWriterLock(root))();
  });
});
describe('review operation admission', () => {
  it('deduplicates concurrent keys, retains their identity, locks edits and executes once', async () => {
    const store = new StateStore(await temp()); await store.initialize();
    await store.updateSections(['reviews'], (db) => db.reviews.push(review));
    const service = new ReviewOperationService(store, pino({ enabled: false })); services.push(service);
    const input = { kind: 'APPROVE' as const, requestKey: 'key', request: { task: 'task', value: 1 }, subjectKeys: ['task:task'], input: {} };
    const [one, two] = await Promise.all([service.accept(input), service.accept({ ...input, requestKey: 'alias' })]);
    expect(one.operationId).toBe(two.operationId);
    await expect(service.accept({ ...input, requestKey: 'alias', request: { value: 2 } })).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    await expect(store.updateSections(['reviews'], (db) => { db.reviews[0]!.selectedRelativePaths = []; })).rejects.toMatchObject({ code: 'TASK_LOCKED' });
    const execute = vi.fn(async () => {
      await store.updateSections(['reviews'], (db) => { db.reviews[0]!.status = 'SUBMITTED'; });
      return { ok: true };
    });
    service.register('APPROVE', execute); await service.start();
    expect(await service.wait(one.operationId)).toEqual({ ok: true });
    expect(execute).toHaveBeenCalledTimes(1);
    expect((await service.accept(input)).operationId).toBe(one.operationId);
    expect(JSON.parse(await readFile(path.join(roots.at(-1)!, 'db.json'), 'utf8')).schemaVersion).toBe('1.1');
  });
  it('pauses dispatch after a write failure and resumes the original queued operation', async () => {
    const root = await temp();
    let failRunning = true;
    let attempts = 0;
    const store = new StateStore(root, undefined, { write: async (file, body) => {
      if (JSON.parse(body).reviewOperations?.some((row: any) => row.status === 'RUNNING') && failRunning) {
        attempts += 1; throw Object.assign(Error('disk full'), { code: 'ENOSPC' });
      }
      await writeFile(file, body);
    } });
    await store.initialize();
    const service = new ReviewOperationService(store, pino({ enabled: false })); services.push(service);
    const execute = vi.fn(async () => ({ ok: true })); service.register('APPROVE', execute);
    const operation = await service.accept({ kind: 'APPROVE', requestKey: 'disk', request: {}, subjectKeys: [], input: {} });
    await service.start();
    await vi.waitFor(() => expect(attempts).toBe(1));
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(attempts).toBe(1);
    expect(service.view(operation.operationId).error?.code).toBe('STATE_STORE_UNAVAILABLE');
    failRunning = false;
    await service.retry(operation.operationId);
    expect(await service.wait(operation.operationId)).toEqual({ ok: true });
    expect(execute).toHaveBeenCalledTimes(1);
  });
  it('rejects capacity overflow and stale snapshots without saving a new operation', async () => {
    const store = new StateStore(await temp()); await store.initialize();
    const service = new ReviewOperationService(store, pino({ enabled: false })); services.push(service);
    await expect(service.accept({ kind: 'BATCH', requestKey: 'too-large', request: {}, subjectKeys: [], input: { pendingSubmissionIds: Array(201).fill('x') } })).rejects.toMatchObject({ code: 'REVIEW_QUEUE_FULL' });
    await expect(service.accept({ kind: 'APPROVE', requestKey: 'stale', request: {}, subjectKeys: [], input: {}, validate: () => { throw Error('stale'); } })).rejects.toThrow('stale');
    expect(store.operations()).toEqual([]);
  });
});
