import path from 'node:path';
import os from 'node:os';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { afterEach, describe, expect, it } from 'vitest';
import { StateStore } from './store.js';
import { LegacyRootCompatibility } from '../utils/legacy-root-compatibility.js';

describe('StateStore observers', () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it('notifies active observers only after a persisted update', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'merchroute-state-observer-'));
    roots.push(root);
    const store = new StateStore(root);
    await store.initialize();
    let notifications = 0;
    const unsubscribe = store.subscribe(() => { notifications += 1; });

    await store.update((db) => { db.appEvents = []; });
    expect(notifications).toBe(1);

    unsubscribe();
    await store.update((db) => { db.appEvents = []; });
    expect(notifications).toBe(1);
  });

  it('canonicalizes historical read views without rewriting db.json', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'merchroute-state-legacy-read-'));
    roots.push(root);
    const oldFolder = 'G:\\01_n8n-global\\03_MediaDownload\\SKU';
    const database = {
      schemaVersion: '1.0',
      reviews: [],
      pendingSubmissions: [],
      submissionHistory: [{ submissionId: 'history-1', sourceFolder: oldFolder }],
      submissionBatches: [],
      appEvents: [{ id: 'event-1', type: 'TEST', message: 'test', details: { sourceFolder: oldFolder }, createdAt: '2026-09-02T00:00:00.000Z' }]
    };
    await writeFile(path.join(root, 'db.json'), `${JSON.stringify(database, null, 2)}\n`, 'utf8');
    const compatibility = new LegacyRootCompatibility({ legacyRoot: 'G:\\01_n8n-global', canonicalRoot: 'G:\\01_MerchRoute' });
    const store = new StateStore(root, (value) => compatibility.canonicalizeJson(value));
    await store.initialize();

    expect(store.read().submissionHistory[0]?.sourceFolder).toBe('G:\\01_MerchRoute\\03_MediaDownload\\SKU');
    expect(store.read().appEvents[0]?.details?.sourceFolder).toBe('G:\\01_MerchRoute\\03_MediaDownload\\SKU');
    await store.update((db) => { db.appEvents[0]!.message = 'unrelated update'; });

    const persisted = await readFile(path.join(root, 'db.json'), 'utf8');
    expect(persisted).toContain('G:\\\\01_n8n-global\\\\03_MediaDownload\\\\SKU');
    expect(persisted).not.toContain('G:\\\\01_MerchRoute\\\\03_MediaDownload\\\\SKU');
  });

  it('propagates mapped-key collisions without modifying the persisted file', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'merchroute-state-legacy-collision-'));
    roots.push(root);
    const database = {
      schemaVersion: '1.0', reviews: [], pendingSubmissions: [], submissionHistory: [], submissionBatches: [],
      appEvents: [{ id: 'event-1', type: 'TEST', message: 'test', details: {
        'G:\\01_n8n-global\\same': 'legacy',
        'g:\\01_merchroute\\SAME': 'canonical'
      }, createdAt: '2026-09-02T00:00:00.000Z' }]
    };
    const serialized = `${JSON.stringify(database, null, 2)}\n`;
    await writeFile(path.join(root, 'db.json'), serialized, 'utf8');
    const compatibility = new LegacyRootCompatibility({ legacyRoot: 'G:\\01_n8n-global', canonicalRoot: 'G:\\01_MerchRoute' });
    const store = new StateStore(root, (value) => compatibility.canonicalizeJson(value));
    await store.initialize();

    expect(() => store.read()).toThrow(/重复对象键/);
    expect(await readFile(path.join(root, 'db.json'), 'utf8')).toBe(serialized);
  });

  it('aliases a canonical runtime task ID to the historical persisted task without rewriting its identity or path', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'merchroute-state-task-alias-'));
    roots.push(root);
    const historicalTaskId = 'historical-task-id';
    const oldFolder = 'G:\\01_n8n-global\\02_generateFolder\\E001\\0000001-product';
    const database = {
      schemaVersion: '1.0',
      reviews: [{
        taskId: historicalTaskId,
        stageId: 'E001',
        sourceFolder: oldFolder,
        sourceFolderName: '0000001-product',
        selectedRelativePaths: ['1.jpg'],
        selectedTargetStageIds: ['E002'],
        status: 'DRAFT',
        createdAt: '2026-09-01T00:00:00.000Z',
        updatedAt: '2026-09-01T00:00:00.000Z'
      }],
      pendingSubmissions: [], submissionHistory: [], submissionBatches: [], appEvents: []
    };
    await writeFile(path.join(root, 'db.json'), `${JSON.stringify(database, null, 2)}\n`, 'utf8');
    const compatibility = new LegacyRootCompatibility({ legacyRoot: 'G:\\01_n8n-global', canonicalRoot: 'G:\\01_MerchRoute' });
    const store = new StateStore(root, (value) => compatibility.canonicalizeJson(value));
    await store.initialize();
    store.configureTaskIdResolver((stageId, sourceFolder) => `${stageId}:${sourceFolder.toLocaleLowerCase('en-US')}`);
    const runtimeTaskId = 'E001:g:\\01_merchroute\\02_generatefolder\\e001\\0000001-product';

    expect(store.resolveRuntimeTaskId(historicalTaskId)).toBe(runtimeTaskId);
    expect(store.resolvePersistedTaskId(runtimeTaskId)).toBe(historicalTaskId);
    expect(store.getReview(runtimeTaskId)).toMatchObject({
      taskId: historicalTaskId,
      sourceFolder: 'G:\\01_MerchRoute\\02_generateFolder\\E001\\0000001-product',
      status: 'DRAFT'
    });
    expect(store.reviewStatuses().get(runtimeTaskId)).toBe('DRAFT');

    await store.update((db) => {
      db.reviews.find((item) => item.taskId === store.resolvePersistedTaskId(runtimeTaskId))!.status = 'APPROVED_PENDING_SUBMISSION';
    });
    const persisted = await readFile(path.join(root, 'db.json'), 'utf8');
    expect(JSON.parse(persisted).reviews).toEqual([
      expect.objectContaining({ taskId: historicalTaskId, sourceFolder: oldFolder, status: 'APPROVED_PENDING_SUBMISSION' })
    ]);
  });

  it('allows new submission history IDs to share a runtime path with one historical review alias', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'merchroute-state-history-alias-'));
    roots.push(root);
    const oldFolder = 'G:\\01_n8n-global\\02_generateFolder\\E004\\0000001-product';
    const currentFolder = 'G:\\01_MerchRoute\\02_generateFolder\\E004\\0000001-product';
    const database = {
      schemaVersion: '1.0',
      reviews: [{ taskId: 'old-review-id', stageId: 'E004', sourceFolder: oldFolder, sourceFolderName: '0000001-product', selectedRelativePaths: [], selectedTargetStageIds: [], status: 'DRAFT', createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z' }],
      pendingSubmissions: [],
      submissionHistory: [{ submissionId: 'new-history', pendingSubmissionId: 'none', taskId: 'new-runtime-id', sourceStageId: 'E004', targetStageId: 'WB_SHARED_MEDIA', sourceFolder: currentFolder, selectedImageCount: 1, status: 'SUCCESS', startedAt: '2026-09-02T00:00:00.000Z' }],
      submissionBatches: [], appEvents: []
    };
    await writeFile(path.join(root, 'db.json'), `${JSON.stringify(database, null, 2)}\n`, 'utf8');
    const compatibility = new LegacyRootCompatibility({ legacyRoot: 'G:\\01_n8n-global', canonicalRoot: 'G:\\01_MerchRoute' });
    const store = new StateStore(root, (value) => compatibility.canonicalizeJson(value));
    await store.initialize();
    store.configureTaskIdResolver((_stageId, sourceFolder) => sourceFolder === currentFolder ? 'new-runtime-id' : 'unexpected');

    expect(store.resolvePersistedTaskId('new-runtime-id')).toBe('old-review-id');
    expect(store.getReview('new-runtime-id')).toMatchObject({ taskId: 'old-review-id', sourceFolder: currentFolder });
    expect(store.reviewStatuses().get('new-runtime-id')).toBe('DRAFT');
  });
});
