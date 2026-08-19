import path from 'node:path';
import { createHash } from 'node:crypto';
import { lstat, readFile, readdir, realpath, stat } from 'node:fs/promises';
import { normalizeWbDescription } from '@n8n-media-review/shared';
import type { ConfigService } from '../../config/service.js';

type JsonRecord = Record<string, any>;

export type E003DescriptionResult = {
  status: 'READY' | 'FALLBACK' | 'MISSING' | 'AMBIGUOUS';
  content?: string;
  source?: {
    workflowCode: 'E003'; executionId: number; folderName: string; fileName: string; sha256: string;
    productVariantId?: string; variantName?: string;
  };
  skippedLatest?: SkippedCandidate[];
  message?: string;
};

export type E003VariantDescriptionResult = E003DescriptionResult & {
  productVariantId: string;
  productVariantName: string;
};

export type E003VariantDescriptionsResult = E003DescriptionResult & {
  variantSources: E003VariantDescriptionResult[];
};

type ValidCandidate = NonNullable<E003DescriptionResult['source']> & { content: string };
type SkippedCandidate = { executionId?: number; folderName: string; reason: string; productVariantId?: string; variantName?: string };
type FileSnapshot = { realPath: string; size: number; mtimeMs: number; label: string };
type VariantIdentity = { variantId: string; name: string };

export class E003DescriptionSourceService {
  constructor(private readonly config: ConfigService, private readonly stabilityIntervalMs = 250) {}

  async resolve(sku: string, productName: string): Promise<E003DescriptionResult> {
    const scanned = await this.scan(sku, productName);
    if ('status' in scanned) return scanned;
    return selectCandidate(scanned.candidates, scanned.skipped);
  }

  async resolveVariants(sku: string, productName: string, variants: VariantIdentity[]): Promise<E003VariantDescriptionsResult> {
    if (!variants.length) return { status: 'MISSING', variantSources: [], message: '产品没有可匹配 E003 详情的变体' };
    const scanned = await this.scan(sku, productName);
    if ('status' in scanned) return { ...scanned, variantSources: [] };
    const variantSources = variants.map((variant) => {
      const matches = scanned.candidates.filter((candidate) => candidateMatchesVariant(candidate, variant, variants.length));
      const skipped = scanned.skipped.filter((candidate) => skippedMatchesVariant(candidate, variant, variants.length));
      const selected = selectCandidate(matches, skipped, `变体“${variant.name}”`);
      return { ...selected, productVariantId: variant.variantId, productVariantName: variant.name };
    });
    const missing = variantSources.filter((item) => item.status === 'MISSING');
    const ambiguous = variantSources.filter((item) => item.status === 'AMBIGUOUS');
    const fallback = variantSources.filter((item) => item.status === 'FALLBACK');
    const primary = variantSources.find((item) => item.content && item.source);
    const status: E003VariantDescriptionsResult['status'] = ambiguous.length ? 'AMBIGUOUS' : missing.length ? 'MISSING' : fallback.length ? 'FALLBACK' : 'READY';
    return {
      status,
      variantSources,
      ...(primary?.content ? { content: primary.content } : {}),
      ...(primary?.source ? { source: primary.source } : {}),
      ...(status === 'AMBIGUOUS' ? { message: ambiguous.map((item) => item.message).filter(Boolean).join('；') } : {}),
      ...(status === 'MISSING' ? { message: missing.map((item) => item.message).filter(Boolean).join('；') } : {})
    };
  }

  private async scan(sku: string, productName: string): Promise<
    { candidates: ValidCandidate[]; skipped: SkippedCandidate[] }
    | Pick<E003DescriptionResult, 'status' | 'message'>
  > {
    const root = this.config.get().stages.find((stage) => stage.id === 'E003')?.candidateRoot?.trim();
    if (!root) return { status: 'MISSING', message: '系统设置中未配置 E003 候选目录' };
    const rootInfo = await stat(root).catch(() => undefined);
    if (!rootInfo?.isDirectory()) return { status: 'MISSING', message: 'E003 候选目录不存在或不可读' };
    const rootReal = await realpath(root);
    const directories = (await readdir(root, { withFileTypes: true })).filter((entry) => entry.isDirectory());
    const candidates: ValidCandidate[] = [];
    const skipped: SkippedCandidate[] = [];
    for (const entry of directories) {
      const folder = path.join(root, entry.name);
      const contextMeta = await readContextMetadata(folder).catch(() => ({}));
      try {
        const inspected = await inspectCandidate(rootReal, folder, entry.name, sku, productName, this.stabilityIntervalMs);
        if (inspected) candidates.push(inspected);
      } catch (error) {
        skipped.push({
          ...contextMeta,
          folderName: entry.name,
          reason: error instanceof Error ? error.message : '候选校验失败'
        });
      }
    }
    candidates.sort((left, right) => right.executionId - left.executionId || left.folderName.localeCompare(right.folderName));
    skipped.sort((left, right) => (right.executionId || 0) - (left.executionId || 0));
    return { candidates, skipped };
  }
}

function selectCandidate(candidates: ValidCandidate[], skipped: SkippedCandidate[], label = '该 SKU'): E003DescriptionResult {
  if (!candidates.length) {
    return { status: 'MISSING', skippedLatest: skipped.slice(0, 10), message: `没有找到${label}可通过身份、路径、编码、内容和稳定性校验的 E003 产品详情 TXT` };
  }
  const topExecution = candidates[0]!.executionId;
  const sameExecution = candidates.filter((candidate) => candidate.executionId === topExecution);
  if (sameExecution.length > 1) {
    const uniqueHashes = new Set(sameExecution.map((candidate) => candidate.sha256));
    return {
      status: 'AMBIGUOUS', skippedLatest: skipped.slice(0, 10),
      message: `${label}的 E003 execution ${topExecution} 存在 ${sameExecution.length} 个候选${uniqueHashes.size > 1 ? '且内容冲突' : ''}，已拒绝自动选择`
    };
  }
  const selected = sameExecution[0]!;
  const rejectedNewer = skipped.filter((item) => (item.executionId || 0) > selected.executionId);
  return {
    status: rejectedNewer.length ? 'FALLBACK' : 'READY',
    content: selected.content,
    source: {
      workflowCode: 'E003', executionId: selected.executionId, folderName: selected.folderName,
      fileName: selected.fileName, sha256: selected.sha256,
      ...(selected.productVariantId ? { productVariantId: selected.productVariantId } : {}),
      ...(selected.variantName ? { variantName: selected.variantName } : {})
    },
    ...(skipped.length ? { skippedLatest: skipped.slice(0, 10) } : {})
  };
}

function candidateMatchesVariant(candidate: ValidCandidate, variant: VariantIdentity, variantCount: number): boolean {
  if (candidate.productVariantId) return candidate.productVariantId === variant.variantId;
  if (candidate.variantName) return candidate.variantName === variant.name;
  return variantCount === 1;
}

function skippedMatchesVariant(candidate: SkippedCandidate, variant: VariantIdentity, variantCount: number): boolean {
  if (candidate.productVariantId) return candidate.productVariantId === variant.variantId;
  if (candidate.variantName) return candidate.variantName === variant.name;
  return variantCount === 1;
}

async function inspectCandidate(rootReal: string, folder: string, folderName: string, sku: string, productName: string, stabilityIntervalMs: number): Promise<ValidCandidate | undefined> {
  const folderInfo = await lstat(folder);
  if (!folderInfo.isDirectory() || folderInfo.isSymbolicLink()) throw new Error('候选目录不是安全的真实目录');
  const folderReal = await realpath(folder);
  if (!inside(rootReal, folderReal)) throw new Error('候选目录超出 E003 根目录');
  const [contextRaw, manifestRaw] = await Promise.all([
    readUtf8Json(path.join(folderReal, 'task-context.json')),
    readUtf8Json(path.join(folderReal, 'manifest.json'))
  ]);
  const context = asObject(contextRaw);
  if (String(context.workflowCode || '') !== 'E003') throw new Error('task-context.workflowCode 不是 E003');
  if (String(context.SKU || '') !== sku) return undefined;
  if (String(context.productName || '') !== productName) throw new Error('task-context 产品名与 PostgreSQL 受保护产品名不一致');
  const executionId = Number(String(context.n8nExecutionId || '').trim());
  if (!Number.isSafeInteger(executionId) || executionId < 1) throw new Error('task-context.n8nExecutionId 无效');
  if (!Array.isArray(manifestRaw) || !manifestRaw.length) throw new Error('manifest 必须包含至少一条详情来源记录');
  let detailSnapshot: FileSnapshot | undefined;
  for (const raw of manifestRaw) {
    const item = asObject(raw);
    if (String(item.SKU || '') !== sku || String(item.productName || '') !== productName) throw new Error('manifest 产品身份不一致');
    const currentDetail = String(item.productDetailFile || asObject(item.rawResponse).productDetailFilePath || '').trim();
    if (!currentDetail) continue;
    const snapshot = await inspectNonemptyFile(folderReal, currentDetail, '产品详情');
    if (detailSnapshot && snapshot.realPath !== detailSnapshot.realPath) throw new Error('manifest 引用了多个不同的详情文件');
    detailSnapshot = snapshot;
  }
  if (!detailSnapshot) throw new Error('manifest 缺少详情文件路径');
  await delay(stabilityIntervalMs);
  await assertSnapshotsStable([detailSnapshot]);
  const detailReal = detailSnapshot.realPath;
  const buffer = await readFile(detailReal);
  const text = decodeUtf8(buffer);
  const content = normalizeWbDescription(text.replace(/^\uFEFF/, ''));
  if (!content) throw new Error('产品详情为空');
  if (content.length > 5_000) throw new Error('产品详情超过 5000 字符');
  return {
    workflowCode: 'E003', executionId, folderName, fileName: path.basename(detailReal), content,
    sha256: createHash('sha256').update(content).digest('hex'),
    ...((context.productVariantId || context.variantId) ? { productVariantId: String(context.productVariantId || context.variantId) } : {}),
    ...(String(context.variants || '').trim() ? { variantName: String(context.variants).trim() } : {})
  };
}

async function inspectNonemptyFile(folderReal: string, candidate: string, label: string): Promise<FileSnapshot> {
  const candidatePath = path.isAbsolute(candidate) ? candidate : path.resolve(folderReal, candidate);
  const candidateInfo = await lstat(candidatePath).catch(() => undefined);
  if (!candidateInfo || candidateInfo.isSymbolicLink()) throw new Error(`${label}不存在、为空或为符号链接`);
  const candidateReal = await realpath(candidatePath).catch(() => '');
  if (!candidateReal || !inside(folderReal, candidateReal)) throw new Error(`${label}路径无效或超出任务目录`);
  if (!candidateInfo.isFile() || candidateInfo.size < 1) throw new Error(`${label}不存在、为空或为符号链接`);
  return { realPath: candidateReal, size: candidateInfo.size, mtimeMs: candidateInfo.mtimeMs, label };
}

async function assertSnapshotsStable(snapshots: FileSnapshot[]): Promise<void> {
  for (const snapshot of snapshots) {
    const current = await stat(snapshot.realPath).catch(() => undefined);
    if (!current?.isFile() || current.size < 1) throw new Error(`${snapshot.label}在稳定性检查期间消失或变为空`);
    if (current.size !== snapshot.size || current.mtimeMs !== snapshot.mtimeMs) throw new Error(`${snapshot.label}仍在写入中`);
  }
}

async function readUtf8Json(filePath: string): Promise<unknown> {
  const buffer = await readFile(filePath);
  try { return JSON.parse(decodeUtf8(buffer).replace(/^\uFEFF/, '')); }
  catch { throw new Error(`${path.basename(filePath)} 不是有效 UTF-8 JSON`); }
}

function decodeUtf8(buffer: Buffer): string {
  try { return new TextDecoder('utf-8', { fatal: true }).decode(buffer); }
  catch { throw new Error('文件不是有效 UTF-8 编码'); }
}

function inside(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

async function readContextMetadata(folder: string): Promise<Pick<SkippedCandidate, 'executionId' | 'productVariantId' | 'variantName'>> {
  const context = asObject(await readUtf8Json(path.join(folder, 'task-context.json')));
  const executionId = Number(String(context.n8nExecutionId || '').trim());
  return {
    ...(Number.isSafeInteger(executionId) && executionId > 0 ? { executionId } : {}),
    ...((context.productVariantId || context.variantId) ? { productVariantId: String(context.productVariantId || context.variantId) } : {}),
    ...(String(context.variants || '').trim() ? { variantName: String(context.variants).trim() } : {})
  };
}

function delay(ms: number): Promise<void> { return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms))); }
function asObject(value: unknown): JsonRecord { return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : {}; }
