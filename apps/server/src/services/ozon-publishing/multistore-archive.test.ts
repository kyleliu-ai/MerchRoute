import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppError } from '@n8n-media-review/shared';
import type { FastifyBaseLogger } from 'fastify';
import type { OzonRepository } from '../../repositories/ozon.js';
import type { PurchaseRepository } from '../../repositories/purchases.js';
import { OzonPublishingService } from './index.js';

const roots: string[] = [];

type StoreTask = {
  job: any;
  processing: string;
  signature: string;
  mapping: { offerId: string; ozonProductId: string; ozonSku: string };
};

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function createRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'merchroute-ozon-multistore-archive-'));
  roots.push(root);
  return root;
}

async function createStoreTask(
  rootDirectory: string,
  input: {
    alias: string;
    storeId: string;
    jobId: string;
    publicationId: string;
    ozonProductId: string;
    ozonSku: string;
  }
): Promise<StoreTask> {
  const sku = '0000118';
  const revision = 2;
  const taskFolder = `${sku}__r${revision}`;
  const taskId = `${input.alias}__${sku}__r${revision}`;
  const offerId = `${sku}-01`;
  const workRelPath = `processing/${taskId}`;
  const processing = path.join(rootDirectory, ...workRelPath.split('/'));
  await mkdir(processing, { recursive: true });
  await mkdir(path.join(rootDirectory, 'success'), { recursive: true });
  const product = {
    schemaVersion: 3,
    productCode: sku,
    revision,
    offers: [{ offerId }]
  };
  const productBytes = `${JSON.stringify(product, null, 2)}\n`;
  const signature = `sha256:${createHash('sha256').update(productBytes).digest('hex')}`;
  await writeFile(path.join(processing, 'product.json'), productBytes);
  await writeFile(path.join(processing, '.ozon-intake.json'), JSON.stringify({
    jobId: input.jobId,
    taskId,
    storeId: input.storeId,
    storeAlias: input.alias,
    publicationId: input.publicationId,
    sku,
    revision,
    productContentHash: signature
  }));
  await writeFile(path.join(processing, '_ERROR.json'), JSON.stringify({
    jobId: input.jobId,
    sku,
    revision,
    state: 'NEEDS_ATTENTION',
    evidence: `preserve-${input.alias}`
  }));
  return {
    processing,
    signature,
    mapping: {
      offerId,
      ozonProductId: input.ozonProductId,
      ozonSku: input.ozonSku
    },
    job: {
      id: input.jobId,
      sku,
      source: 'AUTO',
      state: 'MODERATING',
      rowVersion: 17,
      retryCount: 0,
      revision,
      storeAlias: input.alias,
      storeId: input.storeId,
      publicationId: input.publicationId,
      credentialBindingMode: 'VAULT',
      taskId,
      offerIds: [offerId],
      ozonProductLinks: [],
      taskFolder,
      workRelPath,
      directoryStage: 'PROCESSING',
      directorySignature: signature,
      stageStates: {},
      payload: {
        schemaVersion: 4,
        mode: 'MULTISTORE_PUBLICATION',
        revision
      },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    }
  };
}

function successJob(task: StoreTask, update: Record<string, unknown>): any {
  const mapping = task.mapping;
  return {
    ...task.job,
    ...update,
    state: 'SUCCEEDED',
    rowVersion: task.job.rowVersion + 1,
    payload: task.job.payload,
    ozonProductLinks: [{
      ...mapping,
      url: `https://www.ozon.ru/product/${mapping.ozonSku}/`
    }],
    updatedAt: new Date().toISOString(),
    finishedAt: new Date().toISOString()
  };
}

function runtimeUpdate(task: StoreTask, overrides: Record<string, unknown> = {}): any {
  return {
    rowVersion: task.job.rowVersion,
    state: 'SUCCEEDED',
    eventType: 'OZON_PUBLICATION_VERIFIED',
    message: 'verified',
    revision: task.job.revision,
    storeAlias: task.job.storeAlias,
    directorySignature: task.signature,
    productMappings: [task.mapping],
    ...overrides
  };
}

async function archivedDirectory(rootDirectory: string, taskId: string): Promise<string> {
  const successRoot = path.join(rootDirectory, 'success');
  const dates = await readdir(successRoot);
  expect(dates).toHaveLength(1);
  return path.join(successRoot, dates[0]!, taskId);
}

describe('OZON multi-store succeeded directory archive', () => {
  it('archives two stores with the same SKU independently and clears terminal markers in each scope', async () => {
    const rootDirectory = await createRoot();
    const tek = await createStoreTask(rootDirectory, {
      alias: 'default',
      storeId: '00000000-0000-4000-8000-000000000002',
      jobId: 'bbdeffc0-82b9-4745-ad52-46e9006f8f2a',
      publicationId: 'be481b18-103f-4a3e-8372-407ccad721ea',
      ozonProductId: '5915904972',
      ozonSku: '5431186483'
    });
    const glauke = await createStoreTask(rootDirectory, {
      alias: '2466679',
      storeId: '00000000-0000-4000-8000-000000000003',
      jobId: '62e08ce9-a3f2-4ef5-b841-020ca2488fd8',
      publicationId: 'dccd4b3a-1424-40ee-8ae2-1f017ad6c7f2',
      ozonProductId: '5915904905',
      ozonSku: '5431186297'
    });
    const tasks = new Map([[tek.job.id, tek], [glauke.job.id, glauke]]);
    const recordN8nUpdate = vi.fn(async (id: string, update: Record<string, unknown>) => {
      const task = tasks.get(id)!;
      return { job: successJob(task, update), mappings: [task.mapping], mapping: task.mapping };
    });
    const repository = {
      getJob: vi.fn(async (id: string) => tasks.get(id)!.job),
      assertPlatformStatusRefreshNotLeased: vi.fn(async () => undefined),
      getSettings: vi.fn(async () => ({ enabled: true, rootDirectory })),
      recordN8nUpdate
    } as unknown as OzonRepository;
    const service = new OzonPublishingService(repository, {} as PurchaseRepository, {} as FastifyBaseLogger);

    const [tekResult, glaukeResult] = await Promise.all([
      service.recordRuntimeUpdate(tek.job.id, runtimeUpdate(tek)),
      service.recordRuntimeUpdate(glauke.job.id, runtimeUpdate(glauke))
    ]);

    expect(tekResult.job).toMatchObject({ state: 'SUCCEEDED', storeAlias: 'default' });
    expect(glaukeResult.job).toMatchObject({ state: 'SUCCEEDED', storeAlias: '2466679' });
    await expect(lstat(tek.processing)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(lstat(glauke.processing)).rejects.toMatchObject({ code: 'ENOENT' });
    const tekArchived = await archivedDirectory(rootDirectory, tek.job.taskId);
    const glaukeArchived = await archivedDirectory(rootDirectory, glauke.job.taskId);
    await expect(readFile(path.join(tekArchived, 'product.json'), 'utf8')).resolves.toContain('0000118-01');
    await expect(readFile(path.join(glaukeArchived, 'product.json'), 'utf8')).resolves.toContain('0000118-01');
    for (const archived of [tekArchived, glaukeArchived]) {
      await expect(lstat(path.join(archived, '_ERROR.json'))).rejects.toMatchObject({ code: 'ENOENT' });
      expect((await readdir(archived)).filter((name) => name.startsWith('_ERROR.recovered-'))).toHaveLength(1);
    }
    await expect(lstat(path.join(rootDirectory, 'success'))).resolves.toMatchObject({});
    expect(recordN8nUpdate).toHaveBeenCalledWith(tek.job.id, expect.objectContaining({
      workRelPath: expect.stringMatching(/^success\/\d{4}-\d{2}-\d{2}\/default__0000118__r2$/),
      directoryStage: 'SUCCESS'
    }));
    expect(recordN8nUpdate).toHaveBeenCalledWith(glauke.job.id, expect.objectContaining({
      workRelPath: expect.stringMatching(/^success\/\d{4}-\d{2}-\d{2}\/2466679__0000118__r2$/),
      directoryStage: 'SUCCESS'
    }));
  });

  it('rolls a store-scoped archive back to the same processing directory when the database CAS is rejected', async () => {
    const rootDirectory = await createRoot();
    const task = await createStoreTask(rootDirectory, {
      alias: '2466679',
      storeId: '00000000-0000-4000-8000-000000000003',
      jobId: '62e08ce9-a3f2-4ef5-b841-020ca2488fd8',
      publicationId: 'dccd4b3a-1424-40ee-8ae2-1f017ad6c7f2',
      ozonProductId: '5915904905',
      ozonSku: '5431186297'
    });
    const repository = {
      getJob: vi.fn(async () => task.job),
      assertPlatformStatusRefreshNotLeased: vi.fn(async () => undefined),
      getSettings: vi.fn(async () => ({ enabled: true, rootDirectory })),
      recordN8nUpdate: vi.fn(async () => {
        throw new AppError('TASK_LOCKED', 'OZON 运行时发布租约已失效', undefined, 409);
      })
    } as unknown as OzonRepository;
    const service = new OzonPublishingService(repository, {} as PurchaseRepository, { error: vi.fn() } as any);

    await expect(service.recordRuntimeUpdate(task.job.id, runtimeUpdate(task))).rejects.toMatchObject({
      code: 'TASK_LOCKED',
      statusCode: 409
    });

    await expect(readFile(path.join(task.processing, 'product.json'), 'utf8')).resolves.toContain('0000118-01');
    const dateDirectories = await readdir(path.join(rootDirectory, 'success'));
    for (const date of dateDirectories) {
      await expect(lstat(path.join(rootDirectory, 'success', date, task.job.taskId)))
        .rejects.toMatchObject({ code: 'ENOENT' });
    }
  });

  it('keeps a committed store-scoped success archive when the database response is lost', async () => {
    const rootDirectory = await createRoot();
    const task = await createStoreTask(rootDirectory, {
      alias: 'default',
      storeId: '00000000-0000-4000-8000-000000000002',
      jobId: 'bbdeffc0-82b9-4745-ad52-46e9006f8f2a',
      publicationId: 'be481b18-103f-4a3e-8372-407ccad721ea',
      ozonProductId: '5915904972',
      ozonSku: '5431186483'
    });
    let reads = 0;
    const getJob = vi.fn(async () => {
      reads += 1;
      if (reads === 1) return task.job;
      const archived = await archivedDirectory(rootDirectory, task.job.taskId);
      const date = path.basename(path.dirname(archived));
      return successJob(task, {
        directoryStage: 'SUCCESS',
        workRelPath: `success/${date}/${task.job.taskId}`,
        taskFolder: task.job.taskFolder,
        directorySignature: task.signature
      });
    });
    const repository = {
      getJob,
      assertPlatformStatusRefreshNotLeased: vi.fn(async () => undefined),
      getSettings: vi.fn(async () => ({ enabled: true, rootDirectory })),
      recordN8nUpdate: vi.fn(async () => {
        throw new Error('connection lost after COMMIT');
      })
    } as unknown as OzonRepository;
    const service = new OzonPublishingService(repository, {} as PurchaseRepository, { error: vi.fn() } as any);

    const result = await service.recordRuntimeUpdate(task.job.id, runtimeUpdate(task));

    expect(result.job).toMatchObject({ state: 'SUCCEEDED', directoryStage: 'SUCCESS' });
    expect(result.mapping).toMatchObject(task.mapping);
    await expect(lstat(task.processing)).rejects.toMatchObject({ code: 'ENOENT' });
    const archived = await archivedDirectory(rootDirectory, task.job.taskId);
    await expect(lstat(path.join(archived, '_ERROR.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('never rolls an archive back from a single stale read after an unknown COMMIT response', async () => {
    const rootDirectory = await createRoot();
    const task = await createStoreTask(rootDirectory, {
      alias: 'default',
      storeId: '00000000-0000-4000-8000-000000000002',
      jobId: 'bbdeffc0-82b9-4745-ad52-46e9006f8f2a',
      publicationId: 'be481b18-103f-4a3e-8372-407ccad721ea',
      ozonProductId: '5915904972',
      ozonSku: '5431186483'
    });
    const recordN8nUpdate = vi.fn()
      .mockRejectedValueOnce(new Error('connection lost while waiting for COMMIT'))
      .mockImplementationOnce(async (_id: string, update: Record<string, unknown>) => ({
        job: successJob(task, update),
        mappings: [task.mapping],
        mapping: task.mapping
      }));
    const repository = {
      getJob: vi.fn(async () => task.job),
      assertPlatformStatusRefreshNotLeased: vi.fn(async () => undefined),
      getSettings: vi.fn(async () => ({ enabled: true, rootDirectory })),
      recordN8nUpdate
    } as unknown as OzonRepository;
    const service = new OzonPublishingService(repository, {} as PurchaseRepository, { error: vi.fn() } as any);

    await expect(service.recordRuntimeUpdate(task.job.id, runtimeUpdate(task))).rejects.toMatchObject({
      code: 'OZON_DIRECTORY_ARCHIVE_COMMIT_UNKNOWN',
      statusCode: 503
    });

    await expect(lstat(task.processing)).rejects.toMatchObject({ code: 'ENOENT' });
    const archivedBeforeReplay = await archivedDirectory(rootDirectory, task.job.taskId);
    await expect(lstat(archivedBeforeReplay)).resolves.toMatchObject({});

    const replay = await service.recordRuntimeUpdate(task.job.id, runtimeUpdate(task));
    expect(replay.job).toMatchObject({ state: 'SUCCEEDED', directoryStage: 'SUCCESS' });
    await expect(lstat(task.processing)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(recordN8nUpdate).toHaveBeenCalledTimes(2);
  });

  it('refuses to roll a store archive into a replaced processing parent junction', async () => {
    const rootDirectory = await createRoot();
    const task = await createStoreTask(rootDirectory, {
      alias: '2466679',
      storeId: '00000000-0000-4000-8000-000000000003',
      jobId: '62e08ce9-a3f2-4ef5-b841-020ca2488fd8',
      publicationId: 'dccd4b3a-1424-40ee-8ae2-1f017ad6c7f2',
      ozonProductId: '5915904905',
      ozonSku: '5431186297'
    });
    const processingRoot = path.dirname(task.processing);
    const outside = await mkdtemp(path.join(os.tmpdir(), 'merchroute-ozon-rollback-outside-'));
    roots.push(outside);
    const repository = {
      getJob: vi.fn(async () => task.job),
      assertPlatformStatusRefreshNotLeased: vi.fn(async () => undefined),
      getSettings: vi.fn(async () => ({ enabled: true, rootDirectory })),
      recordN8nUpdate: vi.fn(async () => {
        await rm(processingRoot, { recursive: true, force: true });
        await symlink(outside, processingRoot, 'junction');
        throw new AppError('TASK_LOCKED', 'OZON 运行时发布租约已失效', undefined, 409);
      })
    } as unknown as OzonRepository;
    const service = new OzonPublishingService(repository, {} as PurchaseRepository, { error: vi.fn() } as any);

    await expect(service.recordRuntimeUpdate(task.job.id, runtimeUpdate(task))).rejects.toMatchObject({
      code: 'VERSION_CONFLICT',
      statusCode: 409,
      message: expect.stringContaining('无法安全回滚目录')
    });

    expect(await readdir(outside)).toEqual([]);
    const archived = await archivedDirectory(rootDirectory, task.job.taskId);
    await expect(lstat(archived)).resolves.toMatchObject({});
    await expect(lstat(task.processing)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects a cross-store source path before moving either store directory', async () => {
    const rootDirectory = await createRoot();
    const task = await createStoreTask(rootDirectory, {
      alias: 'default',
      storeId: '00000000-0000-4000-8000-000000000002',
      jobId: 'bbdeffc0-82b9-4745-ad52-46e9006f8f2a',
      publicationId: 'be481b18-103f-4a3e-8372-407ccad721ea',
      ozonProductId: '5915904972',
      ozonSku: '5431186483'
    });
    const recordN8nUpdate = vi.fn();
    const repository = {
      getJob: vi.fn(async () => task.job),
      assertPlatformStatusRefreshNotLeased: vi.fn(async () => undefined),
      getSettings: vi.fn(async () => ({ enabled: true, rootDirectory })),
      recordN8nUpdate
    } as unknown as OzonRepository;
    const service = new OzonPublishingService(repository, {} as PurchaseRepository, {} as FastifyBaseLogger);

    await expect(service.recordRuntimeUpdate(task.job.id, runtimeUpdate(task, {
      workRelPath: `processing/2466679__${task.job.taskFolder}`
    }))).rejects.toMatchObject({
      code: 'VERSION_CONFLICT',
      statusCode: 409
    });

    await expect(lstat(task.processing)).resolves.toMatchObject({});
    expect(recordN8nUpdate).not.toHaveBeenCalled();
  });

  it('rejects whitespace-only byte changes in a signed store package', async () => {
    const rootDirectory = await createRoot();
    const task = await createStoreTask(rootDirectory, {
      alias: 'default',
      storeId: '00000000-0000-4000-8000-000000000002',
      jobId: 'bbdeffc0-82b9-4745-ad52-46e9006f8f2a',
      publicationId: 'be481b18-103f-4a3e-8372-407ccad721ea',
      ozonProductId: '5915904972',
      ozonSku: '5431186483'
    });
    const parsed = JSON.parse(await readFile(path.join(task.processing, 'product.json'), 'utf8'));
    await writeFile(path.join(task.processing, 'product.json'), JSON.stringify(parsed));
    const recordN8nUpdate = vi.fn();
    const repository = {
      getJob: vi.fn(async () => task.job),
      assertPlatformStatusRefreshNotLeased: vi.fn(async () => undefined),
      getSettings: vi.fn(async () => ({ enabled: true, rootDirectory })),
      recordN8nUpdate
    } as unknown as OzonRepository;
    const service = new OzonPublishingService(repository, {} as PurchaseRepository, {} as FastifyBaseLogger);

    await expect(service.recordRuntimeUpdate(task.job.id, runtimeUpdate(task))).rejects.toMatchObject({
      code: 'VERSION_CONFLICT',
      statusCode: 409,
      details: expect.objectContaining({ integrityMode: 'RAW_BYTES' })
    });

    await expect(lstat(task.processing)).resolves.toMatchObject({});
    expect(recordN8nUpdate).not.toHaveBeenCalled();
  });

  it('rejects a legacy signature field substituted into a signed store marker', async () => {
    const rootDirectory = await createRoot();
    const task = await createStoreTask(rootDirectory, {
      alias: 'default',
      storeId: '00000000-0000-4000-8000-000000000002',
      jobId: 'bbdeffc0-82b9-4745-ad52-46e9006f8f2a',
      publicationId: 'be481b18-103f-4a3e-8372-407ccad721ea',
      ozonProductId: '5915904972',
      ozonSku: '5431186483'
    });
    const markerPath = path.join(task.processing, '.ozon-intake.json');
    const marker = JSON.parse(await readFile(markerPath, 'utf8')) as Record<string, unknown>;
    const productContentHash = marker.productContentHash;
    delete marker.productContentHash;
    marker.signature = productContentHash;
    await writeFile(markerPath, JSON.stringify(marker));
    const recordN8nUpdate = vi.fn();
    const repository = {
      getJob: vi.fn(async () => task.job),
      assertPlatformStatusRefreshNotLeased: vi.fn(async () => undefined),
      getSettings: vi.fn(async () => ({ enabled: true, rootDirectory })),
      recordN8nUpdate
    } as unknown as OzonRepository;
    const service = new OzonPublishingService(repository, {} as PurchaseRepository, {} as FastifyBaseLogger);

    await expect(service.recordRuntimeUpdate(task.job.id, runtimeUpdate(task))).rejects.toMatchObject({
      code: 'VERSION_CONFLICT',
      statusCode: 409,
      message: expect.stringContaining('签名字段与冻结任务模式不一致')
    });

    await expect(lstat(task.processing)).resolves.toMatchObject({});
    expect(recordN8nUpdate).not.toHaveBeenCalled();
  });
});
