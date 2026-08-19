import os from 'node:os';
import path from 'node:path';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createDefaultConfig, type AppConfig } from '@n8n-media-review/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConfigService } from '../../config/service.js';
import { StateStore } from '../../repositories/store.js';
import { ScannerService } from './index.js';

describe('ScannerService stage index replacement', () => {
  let root: string;
  let config: AppConfig;
  let scanner: ScannerService;

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'pixroute-scanner-index-'));
    config = createDefaultConfig('other');
    config.stages = config.stages.filter((stage) => ['E006', 'E001', 'E005'].includes(stage.id));
    for (const stage of config.stages) stage.candidateRoot = path.join(root, stage.id);
    const configService = { get: () => structuredClone(config) } as ConfigService;
    const store = new StateStore(path.join(root, 'app-data'));
    await store.initialize();
    scanner = new ScannerService(configService, store);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(root, { recursive: true, force: true });
  });

  it('evicts a deleted task after rescan and preserves tasks from other stages', async () => {
    const deletedFolder = await createProduct(root, 'E006', '01-deleted');
    await createProduct(root, 'E001', '01-preserved');
    const [deletedTask] = await scanner.scanStage('E006');
    const [preservedTask] = await scanner.scanStage('E001');

    await rm(deletedFolder, { recursive: true, force: true });

    await expect(scanner.scanStage('E006')).resolves.toEqual([]);
    await expect(scanner.getTask(deletedTask!.taskId)).rejects.toMatchObject({
      code: 'SOURCE_FOLDER_MISSING',
      statusCode: 404
    });
    await expect(scanner.getTask(preservedTask!.taskId)).resolves.toMatchObject({
      taskId: preservedTask!.taskId,
      sourceFolderName: '01-preserved'
    });
  });

  it('evicts stale tasks when the stage root is empty or the stage is disabled', async () => {
    await createProduct(root, 'E006', '01-stale');
    const [task] = await scanner.scanStage('E006');
    const stage = config.stages.find((item) => item.id === 'E006')!;

    stage.candidateRoot = '';
    await expect(scanner.scanStage('E006')).resolves.toEqual([]);
    await expect(scanner.getTask(task!.taskId)).rejects.toMatchObject({ statusCode: 404 });

    stage.candidateRoot = path.join(root, 'E006');
    stage.enabled = true;
    await expect(scanner.scanStage('E006')).resolves.toHaveLength(1);
    stage.enabled = false;
    await expect(scanner.scanStage('E006')).resolves.toEqual([]);
    await expect(scanner.getTask(task!.taskId)).rejects.toMatchObject({ statusCode: 404 });
  });

  it('does not expose a partial stage snapshot when a rescan fails', async () => {
    await createProduct(root, 'E006', '01-existing');
    await scanner.scanStage('E006');
    const newFolder = await createProduct(root, 'E006', '02-new');
    const brokenFolder = await createProduct(root, 'E006', '03-broken');
    const newTaskId = scanner.taskId('E006', newFolder);
    const originalScanImages = scanner.scanImages.bind(scanner);
    let calls = 0;
    vi.spyOn(scanner, 'scanImages').mockImplementation(async (...args) => {
      calls += 1;
      if (calls === 3) throw new Error('simulated scan failure');
      return originalScanImages(...args);
    });

    await expect(scanner.scanStage('E006')).rejects.toThrow('simulated scan failure');
    vi.restoreAllMocks();
    await Promise.all([
      rm(newFolder, { recursive: true, force: true }),
      rm(brokenFolder, { recursive: true, force: true })
    ]);

    await expect(scanner.getTask(newTaskId)).rejects.toMatchObject({
      code: 'SOURCE_FOLDER_MISSING',
      statusCode: 404
    });
  });

  it('coalesces concurrent fallback scans into one stage snapshot build', async () => {
    await createProduct(root, 'E006', '01-single-flight');
    const originalBuild = scanner.buildStageSnapshot.bind(scanner);
    let builds = 0;
    vi.spyOn(scanner, 'buildStageSnapshot').mockImplementation(async (...args) => {
      builds += 1;
      await new Promise((resolve) => setTimeout(resolve, 20));
      return originalBuild(...args);
    });

    const [first, second] = await Promise.all([scanner.scanStage('E006'), scanner.scanStage('E006')]);

    expect(builds).toBe(1);
    expect(first).toEqual(second);
    expect(first).toHaveLength(1);
  });

  it('serves hydrated task detail without recursively scanning media again', async () => {
    await createProduct(root, 'E006', '01-hydrated');
    const snapshot = await scanner.buildStageSnapshot('E006');
    scanner.hydrateStage(snapshot);
    const scanImages = vi.spyOn(scanner, 'scanImages');

    await expect(scanner.getTask(snapshot.tasks[0]!.taskId)).resolves.toMatchObject({
      taskId: snapshot.tasks[0]!.taskId,
      sourceFolderName: '01-hydrated',
      images: [{ relativePath: 'image.png' }]
    });
    expect(scanImages).not.toHaveBeenCalled();
  });

  it('treats a persistent-index miss as authoritative and never falls back to scanAll', async () => {
    scanner.setPersistentIndexAuthoritative(true);
    const scanAll = vi.spyOn(scanner, 'scanAll');

    await expect(scanner.getTask('missing-task')).rejects.toMatchObject({
      code: 'SOURCE_FOLDER_MISSING',
      statusCode: 404
    });
    expect(scanAll).not.toHaveBeenCalled();
  });

  it('returns 404 and emits a durable-reconcile hint when a hydrated task directory disappears', async () => {
    const folder = await createProduct(root, 'E006', '01-removed-after-hydrate');
    const snapshot = await scanner.buildStageSnapshot('E006');
    scanner.hydrateStage(snapshot);
    const invalidations: unknown[] = [];
    scanner.onTaskInvalidated((event) => invalidations.push(event));
    await rm(folder, { recursive: true, force: true });

    await expect(scanner.getTask(snapshot.tasks[0]!.taskId)).rejects.toMatchObject({
      code: 'SOURCE_FOLDER_MISSING',
      statusCode: 404
    });
    expect(invalidations).toEqual([expect.objectContaining({
      stageId: 'E006',
      relativeTaskDirectory: '01-removed-after-hydrate',
      reason: 'TASK_DIRECTORY_MISSING'
    })]);
  });

  it('rejects unindexed paths, traversal, and files changed after the snapshot without rescanning', async () => {
    const folder = await createProduct(root, 'E006', '01-media-validation');
    const snapshot = await scanner.buildStageSnapshot('E006');
    scanner.hydrateStage(snapshot);
    const taskId = snapshot.tasks[0]!.taskId;
    const invalidations: unknown[] = [];
    scanner.onTaskInvalidated((event) => invalidations.push(event));

    await expect(scanner.resolveIndexedMedia(taskId, '../outside.png')).rejects.toMatchObject({ code: 'PATH_TRAVERSAL_BLOCKED' });
    await expect(scanner.resolveIndexedMedia(taskId, 'not-indexed.png')).rejects.toMatchObject({
      code: 'SOURCE_FILE_MISSING',
      statusCode: 404
    });
    await writeFile(path.join(folder, 'image.png'), 'changed-image-content', 'utf8');
    await expect(scanner.resolveIndexedMedia(taskId, 'image.png')).rejects.toMatchObject({
      code: 'SOURCE_FILE_CHANGED',
      statusCode: 409
    });
    expect(invalidations).toEqual([expect.objectContaining({ reason: 'SOURCE_FILE_CHANGED' })]);
  });

  it('rejects a hydrated snapshot whose relative directory does not match its absolute source folder', async () => {
    await createProduct(root, 'E006', '01-source');
    const snapshot = await scanner.buildStageSnapshot('E006');
    snapshot.tasks[0] = { ...snapshot.tasks[0]!, sourceFolderName: '02-mismatch' };

    expect(() => scanner.hydrateStage(snapshot)).toThrowError(expect.objectContaining({ code: 'CONFIG_INVALID' }));
  });

  it('allows an already-packaging caller to revalidate indexed media after the source stage is disabled', async () => {
    await createProduct(root, 'E006', '01-packaging');
    const snapshot = await scanner.buildStageSnapshot('E006');
    scanner.hydrateStage(snapshot);
    config.stages.find((stage) => stage.id === 'E006')!.enabled = false;

    await expect(scanner.resolveIndexedMedia(snapshot.tasks[0]!.taskId, 'image.png')).rejects.toMatchObject({
      code: 'STAGE_DISABLED',
      statusCode: 409
    });
    await expect(scanner.resolveIndexedMedia(snapshot.tasks[0]!.taskId, 'image.png', { allowDisabledStage: true }))
      .resolves.toMatchObject({ image: { relativePath: 'image.png' } });
  });

  it('restores E005 image lineage from the output selection manifest and keeps legacy fallbacks explicit', async () => {
    await createE005Product(root, '01-ordered', [
      { targetRelativePath: '01.png', sortOrder: 1 },
      { targetRelativePath: '04.png', sortOrder: 2 },
      { targetRelativePath: '07.png', sortOrder: 0 }
    ]);
    await createE005Product(root, '02-legacy-array-order', [
      { targetRelativePath: '04.png' },
      { targetRelativePath: '07.png' },
      { targetRelativePath: '01.png' }
    ]);
    await createE005Product(root, '03-no-manifest');

    await scanner.scanStage('E005');
    const ordered = await taskByName(scanner, 'E005', '01-ordered');
    const legacy = await taskByName(scanner, 'E005', '02-legacy-array-order');
    const fallback = await taskByName(scanner, 'E005', '03-no-manifest');

    expect(ordered.images.map((item) => item.relativePath)).toEqual(['07.png', '01.png', '04.png']);
    expect(ordered.representativeImages).toEqual(['07.png', '01.png', '04.png']);
    expect(legacy.images.map((item) => item.relativePath)).toEqual(['04.png', '07.png', '01.png']);
    expect(fallback.images.map((item) => item.relativePath)).toEqual(['01.png', '04.png', '07.png']);
  });

  it('rejects a partially ordered E005 output manifest instead of guessing the image order', async () => {
    await createE005Product(root, '01-invalid', [
      { targetRelativePath: '07.png', sortOrder: 0 },
      { targetRelativePath: '01.png' },
      { targetRelativePath: '04.png', sortOrder: 2 }
    ]);

    await expect(scanner.scanStage('E005')).rejects.toMatchObject({ code: 'CONFIG_INVALID', statusCode: 409 });
  });
});

async function createProduct(root: string, stageId: string, name: string): Promise<string> {
  const folder = path.join(root, stageId, name);
  await mkdir(folder, { recursive: true });
  await writeFile(path.join(folder, 'image.png'), 'test-image', 'utf8');
  return folder;
}

async function createE005Product(root: string, name: string, selectedFiles?: Array<{ targetRelativePath: string; sortOrder?: number }>): Promise<string> {
  const folder = path.join(root, 'E005', name);
  await mkdir(folder, { recursive: true });
  await Promise.all(['01.png', '04.png', '07.png'].map((fileName) => writeFile(path.join(folder, fileName), `test-${fileName}`, 'utf8')));
  if (selectedFiles) await writeFile(path.join(folder, 'selection-manifest.json'), `${JSON.stringify({ schemaVersion: '1.0', selectedFiles }, null, 2)}\n`, 'utf8');
  return folder;
}

async function taskByName(scanner: ScannerService, stageId: string, sourceFolderName: string) {
  const task = scanner.listIndexedStageTasks(stageId).find((item) => item.sourceFolderName === sourceFolderName);
  if (!task) throw new Error(`missing task ${sourceFolderName}`);
  return scanner.getTask(task.taskId);
}
