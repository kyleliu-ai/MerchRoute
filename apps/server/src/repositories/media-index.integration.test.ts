import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { Pool } from 'pg';
import { createDefaultConfig } from '@n8n-media-review/shared';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { ConfigService } from '../config/service.js';
import type { StateStore } from './store.js';
import { ScannerService } from '../services/scanner/index.js';
import { mediaIndexTaskId, MediaIndexRepository, type MediaIndexTaskInput } from './media-index.js';

const connectionString = process.env.DATABASE_URL;
const schema = `media_index_test_${randomUUID().replaceAll('-', '')}`;
let admin: Pool;
let database: Pool;
let repository: MediaIndexRepository;
const candidateRoot = path.join(path.parse(process.cwd()).root, 'media-index-test', 'E001');
const movedCandidateRoot = path.join(path.parse(process.cwd()).root, 'media-index-test', 'E001-moved');

describe.runIf(Boolean(connectionString))('MediaIndexRepository PostgreSQL integration', () => {
  beforeAll(async () => {
    admin = new Pool({ connectionString, max: 1 });
    await admin.query(`CREATE SCHEMA ${schema}`);
    const isolated = new URL(connectionString!);
    isolated.searchParams.set('options', `-c search_path=${schema},public`);
    database = new Pool({ connectionString: isolated.toString(), max: 2 });
    await database.query('CREATE TABLE legacy_business_data(id INTEGER PRIMARY KEY,value TEXT NOT NULL)');
    await database.query("INSERT INTO legacy_business_data(id,value) VALUES(1,'preserve-me')");
    repository = new MediaIndexRepository('instance-primary', isolated.toString());
    await repository.initialize();
    // initialize is deliberately idempotent on the same repository instance.
    await repository.initialize();
  });

  afterAll(async () => {
    await repository?.close();
    await database?.end();
    await admin?.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin?.end();
  });

  it('creates five media-index business tables plus one migration marker and persists source probe state', async () => {
    const tables = await database.query<{ table_name: string }>(`SELECT table_name FROM information_schema.tables
      WHERE table_schema=current_schema() AND table_name LIKE 'media_index_%' ORDER BY table_name`);
    expect(tables.rows.map((row) => row.table_name)).toEqual([
      'media_index_files',
      'media_index_generations',
      'media_index_reconcile_queue',
      'media_index_schema_migrations',
      'media_index_sources',
      'media_index_tasks'
    ]);
    const migration = await database.query<{ count: string }>(`SELECT COUNT(*)::text AS count
      FROM media_index_schema_migrations WHERE id='001_media_index_projection'`);
    expect(migration.rows[0]?.count).toBe('1');
    const reinitializer = new MediaIndexRepository('instance-primary', repositoryConnectionString());
    await reinitializer.initialize();
    expect(reinitializer).toMatchObject({ configured: true, connected: true });
    await reinitializer.close();
    expect(reinitializer).toMatchObject({ configured: true, connected: false });
    const activeGenerationForeignKey = await database.query<{
      definition: string;
      condeferrable: boolean;
      condeferred: boolean;
    }>(`SELECT pg_get_constraintdef(oid) AS definition,condeferrable,condeferred
      FROM pg_constraint
      WHERE conrelid='media_index_sources'::regclass
        AND conname='media_index_sources_active_generation_fk'`);
    expect(activeGenerationForeignKey.rows).toEqual([expect.objectContaining({
      definition: expect.stringContaining(
        'FOREIGN KEY (active_generation_id) REFERENCES media_index_generations(id) ON DELETE SET NULL DEFERRABLE'
      ),
      condeferrable: true,
      condeferred: false
    })]);
    expect(await database.query('SELECT * FROM legacy_business_data')).toMatchObject({
      rows: [{ id: 1, value: 'preserve-me' }]
    });

    await repository.upsertSource('E001', candidateRoot, 'revision-one', true);
    const source = await repository.updateSourceProbe('E001', {
      queueCount: 7,
      rootFingerprint: 'probe-fingerprint',
      rootDirectoryCount: 3,
      shallowCheckedAt: '2026-08-07T01:02:03.000Z',
      watcherStatus: 'DEGRADED'
    });
    expect(source).toMatchObject({
      instanceId: 'instance-primary',
      stageId: 'E001',
      root: candidateRoot,
      configRevision: 'revision-one',
      enabled: true,
      queueCount: 7,
      rootFingerprint: 'probe-fingerprint',
      rootDirectoryCount: 3,
      shallowCheckedAt: '2026-08-07T01:02:03.000Z',
      watcherStatus: 'DEGRADED'
    });
    await expect(database.query("UPDATE media_index_sources SET watcher_status='WATCHING' WHERE id=$1", [source!.id]))
      .rejects.toMatchObject({ code: '23514' });

    const otherInstance = new MediaIndexRepository('instance-secondary', repositoryConnectionString());
    await otherInstance.initialize();
    const otherRoot = path.join(path.parse(process.cwd()).root, 'media-index-test-other', 'E001');
    const otherSource = await otherInstance.upsertSource('E001', otherRoot, 'other-revision', true);
    expect(otherSource).toMatchObject({ instanceId: 'instance-secondary', stageId: 'E001', root: otherRoot });
    expect(otherSource.id).not.toBe(source?.id);
    expect(await repository.getSource('E001')).toMatchObject({ instanceId: 'instance-primary', root: candidateRoot });
    await otherInstance.enqueueReconcile({ stageId: 'E001', kind: 'FULL', configRevision: 'other-revision' });
    expect(await otherInstance.countReconciliations()).toBe(1);
    expect(await repository.countReconciliations()).toBe(0);
    await expect(repository.claimReconcile('wrong-instance-worker', 5)).resolves.toEqual([]);
    const [otherClaim] = await otherInstance.claimReconcile('other-instance-worker', 1);
    await otherInstance.completeReconcile(otherClaim!.id, otherClaim!.leaseToken!, otherClaim!.eventRevision);
    await otherInstance.close();
  });

  it('keeps BUILDING and failed generations invisible and atomically activates a complete snapshot', async () => {
    const building = await repository.beginFullGeneration('E001', 'revision-one');
    expect(building).toMatchObject({ stageId: 'E001', status: 'BUILDING', taskCount: 0, fileCount: 0 });
    await repository.writeFullGeneration(building!.id, [task('产品甲', '产品甲', '2026-08-07T02:00:00.000Z')]);
    await expect(repository.loadActiveSnapshot('E001')).resolves.toBeUndefined();

    const failed = await repository.beginFullGeneration('E001', 'revision-one');
    await repository.writeFullGeneration(failed!.id, [task('失败代', '失败代', '2026-08-07T02:30:00.000Z')]);
    expect(await repository.failGeneration(failed!.id, 'SCAN_FAILED')).toBe(true);
    await expect(repository.loadActiveSnapshot('E001')).resolves.toBeUndefined();

    const activated = await repository.activateGeneration('E001', building!.id, 'revision-one', {
      rootFingerprint: 'active-fingerprint-one',
      rootDirectoryCount: 1
    });
    expect(activated).toMatchObject({ status: 'ACTIVE', taskCount: 1, fileCount: 2, rootFingerprint: 'active-fingerprint-one', rootDirectoryCount: 1 });
    const snapshot = await repository.loadActiveSnapshot('E001');
    expect(snapshot).toMatchObject({
      stageId: 'E001',
      configRevision: 'revision-one',
      queueCount: 7,
      generation: {
        id: building!.id,
        taskCount: 1,
        fileCount: 2,
        rootFingerprint: 'active-fingerprint-one',
        rootDirectoryCount: 1
      },
      tasks: [{
        taskId: mediaIndexTaskId('E001', path.join(candidateRoot, '产品甲')),
        sourceFolder: path.join(candidateRoot, '产品甲'),
        relativeTaskDirectory: '产品甲',
        sourceFolderName: '产品甲',
        imageCount: 1,
        videoCount: 1,
        mediaCount: 2,
        subfolderCount: 1,
        representativeImages: ['主图.jpg'],
        representativeMedia: [{ relativePath: '主图.jpg', mediaType: 'image' }],
        files: [
          expect.objectContaining({ relativePath: '主图.jpg', mediaType: 'image' }),
          expect.objectContaining({ relativePath: '视频/Show.MP4', mediaType: 'video' })
        ]
      }]
    });
    const taskColumns = await database.query<{ column_name: string }>(`SELECT column_name FROM information_schema.columns
      WHERE table_schema=current_schema() AND table_name='media_index_tasks' ORDER BY column_name`);
    expect(taskColumns.rows.map((row) => row.column_name)).not.toEqual(expect.arrayContaining(['source_folder', 'task_id']));
    const fileColumns = await database.query<{ column_name: string }>(`SELECT column_name FROM information_schema.columns
      WHERE table_schema=current_schema() AND table_name='media_index_files' ORDER BY column_name`);
    expect(fileColumns.rows.map((row) => row.column_name)).not.toEqual(expect.arrayContaining(['task_id', 'file_name', 'directory']));
    const persistedFile = await database.query<{ relative_path: string; relative_path_key: string }>(`SELECT relative_path,relative_path_key
      FROM media_index_files WHERE relative_path LIKE '%Show.MP4'`);
    expect(persistedFile.rows[0]).toEqual({
      relative_path: '视频/Show.MP4',
      relative_path_key: process.platform === 'win32' ? '视频/show.mp4' : '视频/Show.MP4'
    });
  });

  it('invalidates an active snapshot when root or config revision changes and rejects stale activation', async () => {
    const stale = await repository.beginFullGeneration('E001', 'revision-one');
    await repository.writeFullGeneration(stale!.id, [task('旧根目录', '旧根目录', '2026-08-07T03:00:00.000Z')]);
    const changed = await repository.upsertSource('E001', movedCandidateRoot, 'revision-two', true);
    expect(changed.activeGenerationId).toBeUndefined();
    await expect(repository.loadActiveSnapshot('E001')).resolves.toBeUndefined();
    await expect(repository.activateGeneration('E001', stale!.id, 'revision-one', {
      rootFingerprint: 'stale-fingerprint', rootDirectoryCount: 1
    })).resolves.toBeUndefined();

    const current = await repository.beginFullGeneration('E001', 'revision-two');
    await repository.writeFullGeneration(current!.id, [task('新根目录', '新根目录', '2026-08-07T04:00:00.000Z')]);
    await repository.activateGeneration('E001', current!.id, 'revision-two', {
      rootFingerprint: 'active-fingerprint-two', rootDirectoryCount: 1
    });
    expect((await repository.loadActiveSnapshot('E001'))?.tasks.map((item) => item.taskId)).toEqual([
      mediaIndexTaskId('E001', path.join(movedCandidateRoot, '新根目录'))
    ]);
  });

  it('transactionally replaces and removes one task only for the current revision', async () => {
    await expect(repository.replaceTask('E001', 'stale-revision', '新根目录', task('新根目录', '不会写入', '2026-08-07T05:00:00.000Z'))).resolves.toBe(false);
    await expect(repository.replaceTask('E001', 'revision-two', '新根目录', task('新根目录', '增量更新', '2026-08-07T05:00:00.000Z'))).resolves.toBe(true);
    expect(await repository.loadActiveSnapshot('E001')).toMatchObject({
      generation: { taskCount: 1, fileCount: 2 },
      tasks: [{ relativeTaskDirectory: '新根目录', sourceFolderName: '增量更新' }]
    });
    await expect(repository.replaceTask('E001', 'revision-two', '新根目录')).resolves.toBe(true);
    expect(await repository.loadActiveSnapshot('E001')).toMatchObject({ generation: { taskCount: 0, fileCount: 0 }, tasks: [] });
  });

  it('prunes failed and older retired generations without deleting ACTIVE or BUILDING, then recovers stale builds separately', async () => {
    const replacement = await repository.beginFullGeneration('E001', 'revision-two');
    await repository.writeFullGeneration(replacement!.id, [task('保留任务', '保留任务', '2026-08-07T06:00:00.000Z')]);
    await repository.activateGeneration('E001', replacement!.id, 'revision-two', {
      rootFingerprint: 'active-fingerprint-three', rootDirectoryCount: 1
    });
    const failed = await repository.beginFullGeneration('E001', 'revision-two');
    await repository.failGeneration(failed!.id, 'intentional failure');
    const building = await repository.beginFullGeneration('E001', 'revision-two');
    await database.query("UPDATE media_index_generations SET updated_at=NOW()-INTERVAL '2 hours' WHERE id=$1", [building!.id]);

    const pruned = await repository.pruneGenerations('E001', { keepRetired: 1 });
    expect(pruned.failedDeleted).toBeGreaterThanOrEqual(1);
    const afterPrune = await generationStatuses();
    expect(afterPrune.filter((row) => row.status === 'ACTIVE').map((row) => row.id)).toEqual([replacement!.id]);
    expect(afterPrune.filter((row) => row.status === 'RETIRED')).toHaveLength(1);
    expect(afterPrune.filter((row) => row.status === 'BUILDING').map((row) => row.id)).toContain(building!.id);
    expect(afterPrune.some((row) => row.status === 'FAILED')).toBe(false);

    await expect(repository.recoverStaleBuildingGenerations(60_000, 'E001')).resolves.toBe(1);
    expect((await generationStatuses()).find((row) => row.id === building!.id)?.status).toBe('FAILED');
    await repository.pruneGenerations('E001');
    expect((await generationStatuses()).some((row) => row.id === building!.id)).toBe(false);
    expect((await repository.loadActiveSnapshot('E001'))?.generation.id).toBe(replacement!.id);
  });

  it('coalesces queue events and preserves a newer event when an older claim completes', async () => {
    const first = await repository.enqueueReconcile({ stageId: 'E001', kind: 'FULL', configRevision: 'revision-two' });
    const coalesced = await repository.enqueueReconcile({ stageId: 'E001', kind: 'FULL', configRevision: 'revision-two' });
    expect(coalesced).toMatchObject({ id: first.id, eventRevision: '2', retryCount: 0 });

    const claimed = await repository.claimReconcile('worker-one', 1, 60_000);
    expect(claimed).toHaveLength(1);
    expect(claimed[0]).toMatchObject({ id: first.id, eventRevision: '2', leaseOwner: 'worker-one' });
    expect(claimed[0]?.leaseToken).toBeTruthy();
    await expect(repository.renewReconcileLease(first.id, randomUUID(), 60_000)).resolves.toBe(false);
    await database.query(`UPDATE media_index_reconcile_queue SET lease_until=NOW()+INTERVAL '10 milliseconds'
      WHERE id=$1`, [first.id]);
    await expect(repository.renewReconcileLease(first.id, claimed[0]!.leaseToken!, 60_000)).resolves.toBe(true);
    const renewedLease = await database.query<{ remaining_ms: number }>(`SELECT EXTRACT(EPOCH FROM (lease_until-NOW()))*1000 AS remaining_ms
      FROM media_index_reconcile_queue WHERE id=$1`, [first.id]);
    expect(Number(renewedLease.rows[0]?.remaining_ms)).toBeGreaterThan(50_000);
    await database.query('SELECT pg_sleep(0.025)');
    await expect(repository.recoverExpiredLeases()).resolves.toBe(0);
    await expect(repository.claimReconcile('heartbeat-competitor', 1)).resolves.toEqual([]);

    const newer = await repository.enqueueReconcile({ stageId: 'E001', kind: 'FULL', configRevision: 'revision-two' });
    expect(newer.eventRevision).toBe('3');
    await expect(repository.completeReconcile(first.id, claimed[0]!.leaseToken!, claimed[0]!.eventRevision)).resolves.toBe('SUPERSEDED');

    const reclaimed = await repository.claimReconcile('worker-two', 1, 60_000);
    expect(reclaimed[0]).toMatchObject({ id: first.id, eventRevision: '3', leaseOwner: 'worker-two' });
    await expect(repository.completeReconcile(first.id, reclaimed[0]!.leaseToken!, reclaimed[0]!.eventRevision)).resolves.toBe('COMPLETED');
    await expect(repository.claimReconcile('worker-three', 1)).resolves.toEqual([]);
  });

  it('retries failures and recovers expired leases while TASK items remain independently deduplicated', async () => {
    const taskA = await repository.enqueueReconcile({ stageId: 'E001', kind: 'TASK', taskId: 'task-a', relativeTaskDirectory: '产品/任务甲', configRevision: 'revision-two' });
    const taskASecond = await repository.enqueueReconcile({ stageId: 'E001', kind: 'TASK', taskId: 'task-a', relativeTaskDirectory: '产品\\任务甲', configRevision: 'revision-two' });
    const taskB = await repository.enqueueReconcile({ stageId: 'E001', kind: 'TASK', taskId: 'task-b', relativeTaskDirectory: '产品/任务乙', configRevision: 'revision-two' });
    expect(taskASecond).toMatchObject({ id: taskA.id, eventRevision: '2' });
    expect(taskASecond).toMatchObject({ relativeTaskDirectory: '产品/任务甲', pathKey: '产品/任务甲' });
    expect(taskB.id).not.toBe(taskA.id);

    const [failedClaim] = await repository.claimReconcile('worker-failure', 1);
    await expect(repository.failReconcile({
      id: failedClaim!.id,
      leaseToken: failedClaim!.leaseToken!,
      eventRevision: failedClaim!.eventRevision,
      error: 'temporary failure',
      retryAt: new Date(Date.now() - 1_000).toISOString()
    })).resolves.toBe('RETRY_SCHEDULED');
    expect(await repository.getSource('E001')).toMatchObject({ lastError: 'temporary failure' });
    const retried = await repository.claimReconcile('worker-retry', 1);
    expect(retried[0]).toMatchObject({ id: failedClaim!.id, retryCount: 1, lastError: 'temporary failure' });
    await database.query("UPDATE media_index_reconcile_queue SET lease_until=NOW()-INTERVAL '1 second' WHERE id=$1", [retried[0]!.id]);
    expect(await repository.recoverExpiredLeases()).toBe(1);

    const recovered = await repository.claimReconcile('worker-recovered', 1);
    expect(recovered[0]).toMatchObject({ id: failedClaim!.id, retryCount: 2, lastError: 'LEASE_EXPIRED' });
    await repository.completeReconcile(recovered[0]!.id, recovered[0]!.leaseToken!, recovered[0]!.eventRevision);

    const remaining = await repository.claimReconcile('worker-remaining', 5);
    expect(remaining.map((item) => item.id)).toEqual([taskB.id]);
    await repository.completeReconcile(remaining[0]!.id, remaining[0]!.leaseToken!, remaining[0]!.eventRevision);
  });

  it('rejects an incompatible same-name draft without changing it or unrelated legacy data', async () => {
    const draftSchema = `media_index_incompatible_${randomUUID().replaceAll('-', '')}`;
    let draftDatabase: Pool | undefined;
    let draftRepository: MediaIndexRepository | undefined;
    await admin.query(`CREATE SCHEMA ${draftSchema}`);
    try {
      const draftUrl = new URL(connectionString!);
      draftUrl.searchParams.set('options', `-c search_path=${draftSchema},public`);
      draftDatabase = new Pool({ connectionString: draftUrl.toString(), max: 1 });
      await draftDatabase.query('CREATE TABLE legacy_business_data(id INTEGER PRIMARY KEY,value TEXT NOT NULL)');
      await draftDatabase.query("INSERT INTO legacy_business_data(id,value) VALUES(1,'unchanged')");
      await draftDatabase.query(`CREATE TABLE media_index_sources(
        stage_id TEXT PRIMARY KEY,
        root TEXT NOT NULL,
        config_revision TEXT NOT NULL,
        enabled BOOLEAN NOT NULL DEFAULT true
      )`);
      await draftDatabase.query(`INSERT INTO media_index_sources(stage_id,root,config_revision)
        VALUES('E001','legacy-root','legacy-revision')`);

      draftRepository = new MediaIndexRepository('draft-instance', draftUrl.toString());
      expect(draftRepository).toMatchObject({ configured: true, connected: false });
      await expect(draftRepository.initialize()).rejects.toMatchObject({
        code: 'MEDIA_INDEX_SCHEMA_INCOMPATIBLE',
        statusCode: 409
      });
      expect(draftRepository).toMatchObject({ configured: true, connected: false });

      const tables = await draftDatabase.query<{ table_name: string }>(`SELECT table_name FROM information_schema.tables
        WHERE table_schema=current_schema() ORDER BY table_name`);
      expect(tables.rows.map((row) => row.table_name)).toEqual(['legacy_business_data', 'media_index_sources']);
      expect(await draftDatabase.query('SELECT * FROM legacy_business_data')).toMatchObject({
        rows: [{ id: 1, value: 'unchanged' }]
      });
      expect(await draftDatabase.query('SELECT * FROM media_index_sources')).toMatchObject({
        rows: [{ stage_id: 'E001', root: 'legacy-root', config_revision: 'legacy-revision', enabled: true }]
      });

      // Once the incompatible draft is explicitly removed by its owner, the same repository can retry.
      await draftDatabase.query('DROP TABLE media_index_sources');
      await draftRepository.initialize();
      expect(draftRepository).toMatchObject({ configured: true, connected: true });
    } finally {
      await draftRepository?.close();
      await draftDatabase?.end();
      await admin.query(`DROP SCHEMA IF EXISTS ${draftSchema} CASCADE`);
    }
  });
});

describe.runIf(Boolean(connectionString) && process.env.MEDIA_INDEX_PERF_100K === '1')(
  'MediaIndexRepository 100k-file performance',
  () => {
    it('writes, activates, and loads an isolated 100k-file snapshot', async () => {
      const perfSchema = `media_index_perf_${randomUUID().replaceAll('-', '')}`;
      const perfAdmin = new Pool({ connectionString, max: 1 });
      let perfDatabase: Pool | undefined;
      let perfRepository: MediaIndexRepository | undefined;
      await perfAdmin.query(`CREATE SCHEMA ${perfSchema}`);
      try {
        const perfUrl = new URL(connectionString!);
        perfUrl.searchParams.set('options', `-c search_path=${perfSchema},public`);
        perfDatabase = new Pool({ connectionString: perfUrl.toString(), max: 1 });
        perfRepository = new MediaIndexRepository('perf-instance', perfUrl.toString());
        await perfRepository.initialize();
        const perfRoot = path.join(path.parse(process.cwd()).root, 'media-index-perf', 'PERF');
        await perfRepository.upsertSource('E001', perfRoot, 'perf-revision', true);
        const generation = await perfRepository.beginFullGeneration('E001', 'perf-revision');
        const modifiedAt = '2026-08-07T00:00:00.000Z';
        const files = Array.from({ length: 100_000 }, (_, index) => {
          const fileName = `${String(index).padStart(6, '0')}.jpg`;
          return {
            relativePath: `images/${fileName}`,
            fileName,
            directory: 'images',
            sizeBytes: 1_024 + index,
            lastModifiedAt: modifiedAt,
            mediaType: 'image' as const
          };
        });
        await perfRepository.writeFullGeneration(generation!.id, [{
          relativeTaskDirectory: 'task-100k',
          sourceFolderName: 'task-100k',
          imageCount: files.length,
          videoCount: 0,
          mediaCount: files.length,
          subfolderCount: 1,
          lastModifiedAt: modifiedAt,
          representativeImages: ['images/000000.jpg'],
          representativeMedia: [{ relativePath: 'images/000000.jpg', mediaType: 'image' }],
          files
        }]);
        await perfRepository.activateGeneration('E001', generation!.id, 'perf-revision', {
          rootFingerprint: 'perf-root-fingerprint',
          rootDirectoryCount: 1
        });

        const startedAt = performance.now();
        const snapshot = await perfRepository.loadActiveSnapshot('E001');
        const loadMs = performance.now() - startedAt;
        const fileCount = snapshot?.tasks.reduce((sum, item) => sum + item.files.length, 0) ?? 0;
        const appConfig = createDefaultConfig('other');
        const stage = appConfig.stages.find((item) => item.id === 'E001')!;
        stage.candidateRoot = perfRoot;
        const scanner = new ScannerService(
          { get: () => structuredClone(appConfig) } as ConfigService,
          { reviewStatuses: () => new Map() } as unknown as StateStore
        );
        scanner.hydrateStage({
          stageId: 'E001',
          scannedAt: snapshot!.generation.activatedAt,
          rootFingerprint: snapshot!.generation.rootFingerprint || 'perf-root-fingerprint',
          rootDirectoryCount: 1,
          tasks: snapshot!.tasks.map((item) => ({
            taskId: item.taskId,
            stageId: 'E001',
            sourceFolder: item.sourceFolder,
            sourceFolderName: item.sourceFolderName,
            imageCount: item.imageCount,
            videoCount: item.videoCount,
            mediaCount: item.mediaCount,
            subfolderCount: item.subfolderCount,
            lastModifiedAt: item.lastModifiedAt,
            representativeImages: item.representativeImages,
            representativeMedia: item.representativeMedia,
            images: item.files
          }))
        });
        const scanImages = vi.spyOn(scanner, 'scanImages');
        const listStartedAt = performance.now();
        const listed = scanner.listIndexedStageTasks('E001');
        const listMs = performance.now() - listStartedAt;
        process.stdout.write(`[media-index-perf] ${JSON.stringify({ fileCount, loadMs: Math.round(loadMs), listMs: Math.round(listMs * 100) / 100 })}\n`);
        expect(snapshot?.generation.fileCount).toBe(100_000);
        expect(fileCount).toBe(100_000);
        expect(listed).toHaveLength(1);
        expect(scanImages).not.toHaveBeenCalled();
        expect(listMs).toBeLessThan(100);
      } finally {
        await perfRepository?.close();
        await perfDatabase?.end();
        await perfAdmin.query(`DROP SCHEMA IF EXISTS ${perfSchema} CASCADE`);
        await perfAdmin.end();
      }
    }, 180_000);
  }
);

function task(relativeTaskDirectory: string, folderName: string, modifiedAt: string): MediaIndexTaskInput {
  return {
    relativeTaskDirectory,
    sourceFolderName: folderName,
    imageCount: 999,
    videoCount: 999,
    mediaCount: 999,
    subfolderCount: 1,
    lastModifiedAt: modifiedAt,
    representativeImages: ['主图.jpg'],
    representativeMedia: [{ relativePath: '主图.jpg', mediaType: 'image' }],
    files: [
      { relativePath: '主图.jpg', fileName: '主图.jpg', directory: '', sizeBytes: 1234, lastModifiedAt: modifiedAt, mediaType: 'image' },
      { relativePath: '视频/Show.MP4', fileName: 'ignored-name.mp4', directory: 'ignored-directory', sizeBytes: 5678, lastModifiedAt: modifiedAt, mediaType: 'video' }
    ]
  };
}

function repositoryConnectionString(): string {
  const isolated = new URL(connectionString!);
  isolated.searchParams.set('options', `-c search_path=${schema},public`);
  return isolated.toString();
}

async function generationStatuses(): Promise<Array<{ id: string; status: string }>> {
  const result = await database.query<{ id: string; status: string }>(`SELECT g.id::text,g.status
    FROM media_index_generations g JOIN media_index_sources s ON s.id=g.source_id
    WHERE s.instance_id='instance-primary' AND s.stage_id='E001' ORDER BY g.created_at,g.id`);
  return result.rows;
}
