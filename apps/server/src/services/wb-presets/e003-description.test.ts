import path from 'node:path';
import os from 'node:os';
import { mkdtemp, mkdir, readFile, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { afterEach, describe, expect, it } from 'vitest';
import type { ConfigService } from '../../config/service.js';
import { E003DescriptionSourceService } from './e003-description.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

describe('E003DescriptionSourceService', () => {
  it('selects the latest valid detail execution and normalizes literal paragraph separators', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'merchroute-e003-'));
    roots.push(root);
    await createCandidate(root, 100, true, 'A\r\n\r\nB');
    await createCandidate(root, 101, true, 'C\n\nD');
    const service = new E003DescriptionSourceService(configFor(root));
    await expect(service.resolve('0000001', '测试产品')).resolves.toMatchObject({
      status: 'READY', content: 'C\\n\\nD', source: { executionId: 101 }
    });
  });

  it('uses the latest valid detail even when one image scene failed', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'merchroute-e003-fallback-'));
    roots.push(root);
    await createCandidate(root, 100, true, '旧结果');
    await createCandidate(root, 101, false, '新结果');
    const service = new E003DescriptionSourceService(configFor(root));
    const result = await service.resolve('0000001', '测试产品');
    expect(result).toMatchObject({ status: 'READY', content: '新结果', source: { executionId: 101 } });
    expect(result.skippedLatest).toBeUndefined();
  });

  it('uses task-context executionId for fallback when the latest detail TXT is invalid', async () => {
    const root = await testRoot('context-order');
    await createCandidate(root, 100, true, '旧结果', { folderName: 'complete-result' });
    await createCandidate(root, 101, false, Buffer.from([0xc3, 0x28]), { folderName: 'latest-invalid-result' });
    const result = await new E003DescriptionSourceService(configFor(root), 5).resolve('0000001', '测试产品');
    expect(result).toMatchObject({ status: 'FALLBACK', content: '旧结果', source: { executionId: 100 } });
    expect(result.skippedLatest?.[0]).toMatchObject({ executionId: 101, folderName: 'latest-invalid-result' });
  });

  it('rejects a task-context product identity that disagrees with PostgreSQL identity', async () => {
    const root = await testRoot('identity');
    await createCandidate(root, 100, true, '结果', { contextProductName: '被篡改的产品名' });
    const result = await new E003DescriptionSourceService(configFor(root), 5).resolve('0000001', '测试产品');
    expect(result).toMatchObject({ status: 'MISSING' });
    expect(result.skippedLatest?.[0]?.reason).toContain('PostgreSQL 受保护产品名不一致');
  });

  it('fails closed when the same executionId appears in more than one candidate folder', async () => {
    const root = await testRoot('duplicate');
    await createCandidate(root, 100, true, '结果 A', { folderName: 'candidate-a' });
    await createCandidate(root, 100, true, '结果 B', { folderName: 'candidate-b' });
    await expect(new E003DescriptionSourceService(configFor(root), 5).resolve('0000001', '测试产品')).resolves.toMatchObject({
      status: 'AMBIGUOUS', message: expect.stringContaining('存在 2 个候选')
    });
  });

  it('does not bind detail availability to missing or out-of-root image files', async () => {
    const root = await testRoot('image-paths-ignored');
    const folder = await createCandidate(root, 100, false, '有效详情', {
      imagePathOverride: path.join(root, 'outside.png'),
      missingDetailPathForTaskIndexes: [7]
    });
    await unlink(path.join(folder, '7.png'));
    const result = await new E003DescriptionSourceService(configFor(root), 5).resolve('0000001', '测试产品');
    expect(result).toMatchObject({ status: 'READY', content: '有效详情', source: { executionId: 100 } });
  });

  it('rejects detail paths outside the candidate folder', async () => {
    const root = await testRoot('detail-paths');
    const outside = path.join(root, 'outside.txt');
    await writeFile(outside, '越界结果', 'utf8');
    await createCandidate(root, 101, true, '目录内结果', { folderName: 'escaped-path', detailPathOverride: outside });
    const result = await new E003DescriptionSourceService(configFor(root), 5).resolve('0000001', '测试产品');
    expect(result.status).toBe('MISSING');
    expect(result.skippedLatest?.[0]?.reason).toContain('超出任务目录');
  });

  it('rejects conflicting detail paths in one manifest', async () => {
    const root = await testRoot('detail-conflict');
    const folder = await createCandidate(root, 100, false, '结果 A');
    const alternate = path.join(folder, '详情-备用.txt');
    await writeFile(alternate, '结果 B', 'utf8');
    const manifestPath = path.join(folder, 'manifest.json');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as Array<Record<string, unknown>>;
    manifest[manifest.length - 1]!.productDetailFile = alternate;
    await writeFile(manifestPath, JSON.stringify(manifest), 'utf8');
    const result = await new E003DescriptionSourceService(configFor(root), 5).resolve('0000001', '测试产品');
    expect(result).toMatchObject({ status: 'MISSING' });
    expect(result.skippedLatest?.[0]?.reason).toContain('多个不同的详情文件');
  });

  it('rejects a manifest with no detail path', async () => {
    const root = await testRoot('detail-path-missing');
    await createCandidate(root, 100, false, '结果', {
      missingDetailPathForTaskIndexes: Array.from({ length: 7 }, (_, index) => index + 1)
    });
    const result = await new E003DescriptionSourceService(configFor(root), 5).resolve('0000001', '测试产品');
    expect(result).toMatchObject({ status: 'MISSING' });
    expect(result.skippedLatest?.[0]?.reason).toContain('manifest 缺少详情文件路径');
  });

  it('rejects manifest product identity that disagrees with task-context', async () => {
    const root = await testRoot('manifest-identity');
    const folder = await createCandidate(root, 100, false, '结果');
    const manifestPath = path.join(folder, 'manifest.json');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as Array<Record<string, unknown>>;
    manifest[0]!.productName = '被篡改的产品名';
    await writeFile(manifestPath, JSON.stringify(manifest), 'utf8');
    const result = await new E003DescriptionSourceService(configFor(root), 5).resolve('0000001', '测试产品');
    expect(result).toMatchObject({ status: 'MISSING' });
    expect(result.skippedLatest?.[0]?.reason).toContain('manifest 产品身份不一致');
  });

  it('rejects invalid UTF-8 product details', async () => {
    const root = await testRoot('utf8');
    await createCandidate(root, 100, true, Buffer.from([0xc3, 0x28]));
    const result = await new E003DescriptionSourceService(configFor(root), 5).resolve('0000001', '测试产品');
    expect(result).toMatchObject({ status: 'MISSING' });
    expect(result.skippedLatest?.[0]?.reason).toContain('有效 UTF-8');
  });

  it('detects a detail TXT that changes during the stability interval', async () => {
    const root = await testRoot('stability');
    const folder = await createCandidate(root, 100, true, '结果');
    const changingDetail = path.join(folder, '详情.txt');
    const writer = new Promise<void>((resolve) => setTimeout(() => { void writeFile(changingDetail, '仍在写入中的详情内容', 'utf8').then(() => resolve()); }, 100));
    const result = await new E003DescriptionSourceService(configFor(root), 400).resolve('0000001', '测试产品');
    await writer;
    expect(result).toMatchObject({ status: 'MISSING' });
    expect(result.skippedLatest?.[0]?.reason).toContain('仍在写入中');
  });

  it('does not monitor image stability while validating detail TXT', async () => {
    const root = await testRoot('image-stability-ignored');
    const folder = await createCandidate(root, 100, false, '稳定详情');
    const changingImage = path.join(folder, '1.png');
    const writer = new Promise<void>((resolve) => setTimeout(() => { void writeFile(changingImage, Buffer.from([1, 2, 3, 4, 5])).then(() => resolve()); }, 100));
    const result = await new E003DescriptionSourceService(configFor(root), 400).resolve('0000001', '测试产品');
    await writer;
    expect(result).toMatchObject({ status: 'READY', content: '稳定详情' });
  });

  it('resolves each color variant independently without depending on scene counts', async () => {
    const root = await testRoot('variants');
    await createCandidate(root, 200, true, '卡其详情', {
      folderName: 'khaki', taskCount: 2, writePrompts: true, variantName: '卡其色', productVariantId: '11111111-1111-4111-8111-111111111111'
    });
    await createCandidate(root, 201, true, '黑色详情', {
      folderName: 'black', taskCount: 4, writePrompts: true, variantName: '黑色', productVariantId: '22222222-2222-4222-8222-222222222222'
    });
    const result = await new E003DescriptionSourceService(configFor(root), 5).resolveVariants('0000001', '测试产品', [
      { variantId: '11111111-1111-4111-8111-111111111111', name: '卡其色' },
      { variantId: '22222222-2222-4222-8222-222222222222', name: '黑色' }
    ]);
    expect(result.status).toBe('READY');
    expect(result.variantSources).toEqual([
      expect.objectContaining({ productVariantName: '卡其色', content: '卡其详情', source: expect.objectContaining({ executionId: 200 }) }),
      expect.objectContaining({ productVariantName: '黑色', content: '黑色详情', source: expect.objectContaining({ executionId: 201 }) })
    ]);
  });

  it('ignores prompts and scene-index mismatches when the detail TXT is valid', async () => {
    const root = await testRoot('prompt-mismatch');
    const folder = await createCandidate(root, 200, true, '结果', { taskCount: 2, writePrompts: true });
    await writeFile(path.join(folder, 'prompts.json'), JSON.stringify([{ taskIndex: 1 }, { taskIndex: 3 }]), 'utf8');
    const result = await new E003DescriptionSourceService(configFor(root), 5).resolve('0000001', '测试产品');
    expect(result).toMatchObject({ status: 'READY', content: '结果', source: { executionId: 200 } });
  });

  it('rejects missing, empty and overlong detail content', async () => {
    const root = await testRoot('content');
    await createCandidate(root, 100, true, '有效旧结果');
    await createCandidate(root, 101, true, 'x'.repeat(5_001));
    const fallback = await new E003DescriptionSourceService(configFor(root), 5).resolve('0000001', '测试产品');
    expect(fallback).toMatchObject({ status: 'FALLBACK', content: '有效旧结果', source: { executionId: 100 } });
    expect(fallback.skippedLatest?.[0]?.reason).toContain('超过 5000 字符');

    const emptyRoot = await testRoot('empty-content');
    await createCandidate(emptyRoot, 200, true, '\r\n\r\n');
    const empty = await new E003DescriptionSourceService(configFor(emptyRoot), 5).resolve('0000001', '测试产品');
    expect(empty).toMatchObject({ status: 'MISSING' });
    expect(empty.skippedLatest?.[0]?.reason).toContain('产品详情为空');
  });

  it('rejects a symlinked detail TXT when the platform permits creating the fixture', async () => {
    const root = await testRoot('symlink');
    const folder = await createCandidate(root, 100, true, '结果');
    const detailPath = path.join(folder, '详情.txt');
    const targetPath = path.join(folder, '详情-真实.txt');
    await writeFile(targetPath, '结果', 'utf8');
    await unlink(detailPath);
    try {
      await symlink(targetPath, detailPath, 'file');
    } catch (error: any) {
      if (error?.code === 'EPERM') return;
      throw error;
    }
    const result = await new E003DescriptionSourceService(configFor(root), 5).resolve('0000001', '测试产品');
    expect(result).toMatchObject({ status: 'MISSING' });
    expect(result.skippedLatest?.[0]?.reason).toContain('符号链接');
  });
});

type CandidateOptions = {
  folderName?: string;
  contextProductName?: string;
  imagePathOverride?: string;
  taskCount?: number;
  writePrompts?: boolean;
  variantName?: string;
  productVariantId?: string;
  detailPathOverride?: string;
  missingDetailPathForTaskIndexes?: number[];
};

async function createCandidate(root: string, executionId: number, complete: boolean, detail: string | Buffer, options: CandidateOptions = {}): Promise<string> {
  const folder = path.join(root, options.folderName || `0000001-测试产品-${executionId}`);
  await mkdir(folder, { recursive: true });
  const detailPath = path.join(folder, '详情.txt');
  await writeFile(detailPath, detail, typeof detail === 'string' ? 'utf8' : undefined);
  const manifest = [];
  const taskCount = options.taskCount || 7;
  for (let taskIndex = 1; taskIndex <= taskCount; taskIndex += 1) {
    const imagePath = path.join(folder, `${taskIndex}.png`);
    await writeFile(imagePath, Buffer.from([1, 2, 3]));
    manifest.push({
      SKU: '0000001', productName: '测试产品', taskIndex,
      status: complete || taskIndex !== taskCount ? 'success' : 'failed', error: complete || taskIndex !== taskCount ? '' : 'boom', imageCount: 1,
      ...(options.missingDetailPathForTaskIndexes?.includes(taskIndex) ? {} : { productDetailFile: options.detailPathOverride || detailPath }),
      images: [{ localPath: options.imagePathOverride && taskIndex === 1 ? options.imagePathOverride : imagePath, status: 'pending-download' }]
    });
  }
  await writeFile(path.join(folder, 'task-context.json'), JSON.stringify({
    workflowCode: 'E003', SKU: '0000001', productName: options.contextProductName || '测试产品',
    n8nExecutionId: String(executionId),
    ...(options.variantName ? { variants: options.variantName } : {}),
    ...(options.productVariantId ? { productVariantId: options.productVariantId } : {})
  }), 'utf8');
  await writeFile(path.join(folder, 'manifest.json'), JSON.stringify(manifest), 'utf8');
  if (options.writePrompts) {
    await writeFile(path.join(folder, 'prompts.json'), JSON.stringify(
      Array.from({ length: taskCount }, (_, index) => ({ taskIndex: index + 1 }))
    ), 'utf8');
  }
  return folder;
}

async function testRoot(suffix: string): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), `merchroute-e003-${suffix}-`));
  roots.push(root);
  return root;
}

function configFor(root: string): ConfigService {
  return { get: () => ({ stages: [{ id: 'E003', candidateRoot: root }] }) } as unknown as ConfigService;
}
