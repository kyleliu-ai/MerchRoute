import os from 'node:os';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import type { FastifyBaseLogger } from 'fastify';
import { createDefaultConfig, type AppConfig } from '@n8n-media-review/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConfigService } from '../../config/service.js';
import { StateStore } from '../../repositories/store.js';
import { ScannerService } from '../scanner/index.js';
import { MediaIndexService } from './index.js';

type FakeWatcherRecord = {
  root: string;
  recursive: boolean;
  listener: (eventType: string, filename: string | Buffer | null) => void;
  errors: Array<(error: Error) => void>;
  closed: boolean;
};

describe('MediaIndexService memory fallback', () => {
  let root: string;
  let config: AppConfig;
  let configService: ConfigService;
  let scanner: ScannerService;
  let service: MediaIndexService;
  let watcherRecords: FakeWatcherRecord[];

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'pixroute-media-index-service-'));
    config = createDefaultConfig('other');
    config.stages = config.stages.filter((stage) => stage.id === 'E006');
    const stage = config.stages[0]!;
    stage.candidateRoot = path.join(root, 'candidates');
    stage.inputQueueRoot = undefined;
    configService = {
      appDataDir: path.join(root, 'app-data'),
      get: () => structuredClone(config)
    } as unknown as ConfigService;
    const store = new StateStore(configService.appDataDir);
    await store.initialize();
    scanner = new ScannerService(configService, store);
    watcherRecords = [];
    service = new MediaIndexService(configService, scanner, {
      warn: vi.fn(),
      info: vi.fn()
    } as unknown as FastifyBaseLogger, {
      databaseUrl: null,
      debounceMs: 2_000,
      queuePollMs: 60_000,
      shallowIntervalMs: 60_000,
      fullIntervalMs: 60_000,
      taskConcurrency: 8,
      fullConcurrency: 2,
      watcherFactory: (watchRoot, options, listener) => {
        if (!existsSync(watchRoot)) throw new Error(`watch root missing: ${watchRoot}`);
        const record: FakeWatcherRecord = { root: watchRoot, recursive: options.recursive, listener, errors: [], closed: false };
        watcherRecords.push(record);
        return {
          close: () => { record.closed = true; },
          on: (event: string, callback: (error: Error) => void) => {
            if (event === 'error') record.errors.push(callback);
            return undefined as any;
          }
        } as any;
      }
    });
  });

  afterEach(async () => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    await service.close();
    await rm(root, { recursive: true, force: true });
  });

  it('coalesces concurrent full refreshes when PostgreSQL is not configured', async () => {
    await createProduct(path.join(root, 'candidates'), '01-single-flight');
    const originalBuild = scanner.buildStageSnapshot.bind(scanner);
    let builds = 0;
    vi.spyOn(scanner, 'buildStageSnapshot').mockImplementation(async (...args) => {
      builds += 1;
      await new Promise((resolve) => setTimeout(resolve, 20));
      return originalBuild(...args);
    });
    await service.initialize();

    const [first, second] = await Promise.all([service.refreshStage('E006'), service.refreshStage('E006')]);

    expect(builds).toBe(1);
    expect(first).toEqual(second);
    expect(first).toHaveLength(1);
    expect(service.getState('E006')).toMatchObject({
      revision: expect.stringMatching(/^[a-f0-9]{64}$/),
      status: 'READY',
      queueCount: 0
    });
  });

  it('keeps the last complete memory generation when the candidate root becomes unavailable', async () => {
    const candidateRoot = path.join(root, 'candidates');
    await createProduct(candidateRoot, '01-preserved');
    await service.initialize();
    const [task] = await service.refreshStage('E006');
    await rm(candidateRoot, { recursive: true, force: true });

    await expect(service.refreshStage('E006')).rejects.toMatchObject({
      code: 'SOURCE_ROOT_UNAVAILABLE',
      statusCode: 503
    });
    expect(scanner.listIndexedStageTasks('E006')).toEqual([expect.objectContaining({ taskId: task!.taskId })]);
    expect(service.getState('E006')).toMatchObject({ status: 'STALE' });
  });

  it('invalidates the old in-memory snapshot immediately when the stage config revision changes', async () => {
    const oldRoot = path.join(root, 'candidates');
    await createProduct(oldRoot, '01-old-root');
    await service.initialize();
    await service.refreshStage('E006');
    expect(scanner.listIndexedStageTasks('E006')).toEqual([expect.objectContaining({ sourceFolderName: '01-old-root' })]);

    const newRoot = path.join(root, 'new-candidates');
    await createProduct(newRoot, '02-new-root');
    config.stages[0]!.candidateRoot = newRoot;
    await service.syncConfig();

    expect(await service.listStageTasks('E006')).toEqual([]);
    await expect(service.refreshStage('E006')).resolves.toEqual([
      expect.objectContaining({ sourceFolderName: '02-new-root' })
    ]);
  });

  it('retains disabled-stage task identity so old detail URLs return STAGE_DISABLED instead of 404', async () => {
    await createProduct(path.join(root, 'candidates'), '01-disabled');
    await service.initialize();
    const [task] = await service.refreshStage('E006');
    config.stages[0]!.enabled = false;
    await service.syncConfig();

    await expect(service.listStageTasks('E006')).resolves.toEqual([]);
    await expect(scanner.getTask(task!.taskId)).rejects.toMatchObject({
      code: 'STAGE_DISABLED',
      statusCode: 409
    });
  });

  it('does not refresh memory as READY while a configured repository is in runtime outage', async () => {
    const candidateRoot = path.join(root, 'candidates');
    await createProduct(candidateRoot, '01-stale');
    const [task] = await scanner.scanStage('E006');
    (service as any).repository.connectionString = 'postgresql://configured-but-offline.invalid/test';
    (service as any).repository.pool = { end: vi.fn(async () => undefined) };

    await expect(service.refreshStage('E006')).rejects.toMatchObject({
      code: 'MEDIA_INDEX_DATABASE_UNAVAILABLE',
      statusCode: 503
    });
    expect(scanner.listIndexedStageTasks('E006')).toEqual([expect.objectContaining({ taskId: task!.taskId })]);
    expect(service.getState('E006')).toMatchObject({ status: 'STALE' });
  });

  it('reports deduplicated fallback pending work instead of counting repeated events', async () => {
    await createProduct(path.join(root, 'candidates'), '01-pending');
    await service.initialize();
    await service.refreshStage('E006');

    await service.enqueueTask('E006', '01-pending');
    await service.enqueueTask('E006', '01-pending');
    expect(service.getState('E006').pendingReconciliations).toBe(1);
    await (service as any).enqueueFull('E006');
    await (service as any).enqueueFull('E006');
    expect(service.getState('E006').pendingReconciliations).toBe(1);
  });

  it('escalates a watcher event without filename to one debounced FULL and processes it immediately', async () => {
    await createProduct(path.join(root, 'candidates'), '01-full-event');
    await service.initialize();
    await service.refreshStage('E006');
    await settleService(service);
    const build = vi.spyOn(scanner, 'buildStageSnapshot');
    vi.useFakeTimers();

    candidateWatcher(watcherRecords).listener('rename', null);
    await vi.advanceTimersByTimeAsync(1_999);
    expect(build).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await settleService(service);

    expect(build).toHaveBeenCalledTimes(1);
  });

  it('merges repeated events for the same task into one TASK refresh after two seconds', async () => {
    await createProduct(path.join(root, 'candidates'), '01-debounced');
    await service.initialize();
    await service.refreshStage('E006');
    await settleService(service);
    const buildTask = vi.spyOn(scanner, 'buildTaskSnapshot');
    vi.useFakeTimers();
    const watcher = candidateWatcher(watcherRecords);

    watcher.listener('change', '01-debounced/image.png');
    watcher.listener('change', '01-debounced/image.png');
    watcher.listener('rename', '01-debounced/image.png');
    await vi.advanceTimersByTimeAsync(2_000);
    await settleService(service);

    expect(buildTask).toHaveBeenCalledTimes(1);
    expect(buildTask).toHaveBeenCalledWith('E006', '01-debounced');
  });

  it('escalates a 25-task watcher burst to FULL and cancels per-task debounce work', async () => {
    await createProduct(path.join(root, 'candidates'), '01-existing');
    await service.initialize();
    await service.refreshStage('E006');
    await settleService(service);
    const buildFull = vi.spyOn(scanner, 'buildStageSnapshot');
    const buildTask = vi.spyOn(scanner, 'buildTaskSnapshot');
    vi.useFakeTimers();
    const watcher = candidateWatcher(watcherRecords);

    for (let index = 0; index < 25; index += 1) watcher.listener('rename', `task-${index}/image.png`);
    await vi.advanceTimersByTimeAsync(2_000);
    await settleService(service);

    expect(buildFull).toHaveBeenCalledTimes(1);
    expect(buildTask).not.toHaveBeenCalled();
  });

  it('restarts a failed watcher after two seconds and returns from DEGRADED to ACTIVE', async () => {
    await createProduct(path.join(root, 'candidates'), '01-watcher-restart');
    await service.initialize();
    await service.refreshStage('E006');
    await settleService(service);
    vi.useFakeTimers();
    const failed = candidateWatcher(watcherRecords);

    failed.errors[0]!(new Error('simulated watcher failure'));
    expect(service.getState('E006')).toMatchObject({ watcherStatus: 'DEGRADED', status: 'STALE' });
    await vi.advanceTimersByTimeAsync(2_000);
    await settleService(service);

    expect(failed.closed).toBe(true);
    expect(candidateWatcher(watcherRecords)).not.toBe(failed);
    expect(service.getState('E006').watcherStatus).toBe('ACTIVE');
  });

  it('ignores callbacks from a closed watcher after a config revision installs a new root', async () => {
    await createProduct(path.join(root, 'candidates'), '01-old-watcher');
    await service.initialize();
    await service.refreshStage('E006');
    await settleService(service);
    const oldWatcher = candidateWatcher(watcherRecords);
    const newRoot = path.join(root, 'replacement-candidates');
    await createProduct(newRoot, '02-new-watcher');
    config.stages[0]!.candidateRoot = newRoot;
    await service.syncConfig();
    const enqueueTask = vi.spyOn(service, 'enqueueTask');
    const refresh = vi.spyOn(service, 'refreshStage');
    vi.useFakeTimers();

    oldWatcher.listener('rename', '01-old-watcher/image.png');
    await vi.advanceTimersByTimeAsync(3_000);
    await settleService(service);

    expect(oldWatcher.closed).toBe(true);
    expect(enqueueTask).not.toHaveBeenCalled();
    expect(refresh).not.toHaveBeenCalled();
  });

  it('keeps the previous queue count and still publishes the candidate snapshot when inputQueueRoot is unavailable', async () => {
    await createProduct(path.join(root, 'candidates'), '01-queue-independent');
    config.stages[0]!.inputQueueRoot = path.join(root, 'missing-input-queue');
    await service.initialize();

    await expect(service.refreshStage('E006')).resolves.toEqual([
      expect.objectContaining({ sourceFolderName: '01-queue-independent' })
    ]);
    expect(service.getState('E006')).toMatchObject({
      status: 'STALE',
      queueCount: 0,
      error: expect.any(String)
    });
  });

  it('replays a same-task event revision that arrives while the previous TASK scan is running', async () => {
    await createProduct(path.join(root, 'candidates'), '01-replay');
    await service.initialize();
    await service.refreshStage('E006');
    await settleService(service);
    const original = scanner.buildTaskSnapshot.bind(scanner);
    const firstStarted = deferred<void>();
    const releaseFirst = deferred<void>();
    let calls = 0;
    vi.spyOn(scanner, 'buildTaskSnapshot').mockImplementation(async (...args) => {
      calls += 1;
      if (calls === 1) {
        firstStarted.resolve();
        await releaseFirst.promise;
      }
      return original(...args);
    });
    vi.useFakeTimers();
    const watcher = candidateWatcher(watcherRecords);

    watcher.listener('change', '01-replay/image.png');
    await vi.advanceTimersByTimeAsync(2_000);
    await firstStarted.promise;
    watcher.listener('change', '01-replay/image.png');
    await vi.advanceTimersByTimeAsync(2_000);
    releaseFirst.resolve();
    await settleService(service);

    expect(calls).toBe(2);
  });

  it('waits for an active full refresh before closing the repository', async () => {
    await createProduct(path.join(root, 'candidates'), '01-close');
    await service.initialize();
    await service.refreshStage('E006');
    await settleService(service);
    const original = scanner.buildStageSnapshot.bind(scanner);
    const started = deferred<void>();
    const release = deferred<void>();
    vi.spyOn(scanner, 'buildStageSnapshot').mockImplementation(async (...args) => {
      started.resolve();
      await release.promise;
      return original(...args);
    });

    const refresh = service.refreshStage('E006');
    await started.promise;
    let closed = false;
    const closing = service.close().then(() => { closed = true; });
    await Promise.resolve();
    expect(closed).toBe(false);
    release.resolve();
    await Promise.all([refresh, closing]);
    expect(closed).toBe(true);
  });

  it('flushes the final debounced watcher lastEventAt before close returns', async () => {
    await createProduct(path.join(root, 'candidates'), '01-event-flush');
    await service.initialize();
    await service.refreshStage('E006');
    await settleService(service);
    const updateSourceRuntime = vi.spyOn(service as any, 'updateSourceRuntime');

    candidateWatcher(watcherRecords).listener('change', '01-event-flush/image.png');
    const eventAt = service.getState('E006').lastEventAt;
    await service.close();

    expect(eventAt).toBeTruthy();
    expect(updateSourceRuntime).toHaveBeenCalledWith('E006', expect.objectContaining({ lastEventAt: eventAt }));
  });

  it('clamps concurrent FULL scans to one even when the option requests two', async () => {
    const otherStage = createDefaultConfig('other').stages.find((stage) => stage.id === 'E001')!;
    otherStage.candidateRoot = path.join(root, 'E001-candidates');
    otherStage.inputQueueRoot = undefined;
    config.stages.push(otherStage);
    await Promise.all([
      createProduct(path.join(root, 'candidates'), '01-e006'),
      createProduct(otherStage.candidateRoot, '01-e001')
    ]);
    await service.initialize();
    await settleService(service);
    const original = scanner.buildStageSnapshot.bind(scanner);
    let active = 0;
    let maximum = 0;
    vi.spyOn(scanner, 'buildStageSnapshot').mockImplementation(async (...args) => {
      active += 1;
      maximum = Math.max(maximum, active);
      await new Promise((resolve) => setTimeout(resolve, 20));
      try { return await original(...args); } finally { active -= 1; }
    });

    await Promise.all([service.refreshStage('E006'), service.refreshStage('E001')]);

    expect(maximum).toBe(1);
  });

  it('clamps concurrent TASK scans to two even when the option requests eight', async () => {
    for (const stageId of ['E001', 'E002']) {
      const stage = createDefaultConfig('other').stages.find((item) => item.id === stageId)!;
      stage.candidateRoot = path.join(root, `${stageId}-candidates`);
      stage.inputQueueRoot = undefined;
      config.stages.push(stage);
    }
    for (const stage of config.stages) await createProduct(stage.candidateRoot!, '01-task');
    await service.syncConfig();
    const original = scanner.buildTaskSnapshot.bind(scanner);
    let active = 0;
    let maximum = 0;
    vi.spyOn(scanner, 'buildTaskSnapshot').mockImplementation(async (...args) => {
      active += 1;
      maximum = Math.max(maximum, active);
      await new Promise((resolve) => setTimeout(resolve, 20));
      try { return await original(...args); } finally { active -= 1; }
    });

    await Promise.all(config.stages.map((stage) => (service as any).runTaskRefresh(stage.id, '01-task')));

    expect(maximum).toBe(2);
  });
});

function candidateWatcher(records: FakeWatcherRecord[]): FakeWatcherRecord {
  return records.filter((record) => record.recursive && !record.closed).at(-1)!;
}

async function settleService(service: MediaIndexService): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    await Promise.resolve();
    const background = [...(service as any).backgroundFlights] as Promise<unknown>[];
    const queue = (service as any).queueFlight as Promise<unknown> | undefined;
    if (!background.length && !queue) return;
    await Promise.allSettled([...background, ...(queue ? [queue] : [])]);
  }
  throw new Error('media index background work did not settle');
}

function deferred<T>(): { promise: Promise<T>; resolve: (value?: T) => void } {
  let resolve!: (value?: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

async function createProduct(candidateRoot: string, name: string): Promise<string> {
  const folder = path.join(candidateRoot, name);
  await mkdir(folder, { recursive: true });
  await writeFile(path.join(folder, 'image.png'), 'test-image', 'utf8');
  return folder;
}
