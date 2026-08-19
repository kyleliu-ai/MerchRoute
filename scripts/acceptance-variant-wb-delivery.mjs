import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { copyFile, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import dotenv from 'dotenv';
import sharp from 'sharp';
import pg from 'pg';

const projectRoot = path.resolve(import.meta.dirname, '..');
dotenv.config({ path: path.join(projectRoot, '.env') });
if (!process.env.DATABASE_URL) throw new Error('验收需要 DATABASE_URL');

const runId = `merchroute-accept-${new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}-${randomUUID().slice(0, 6)}`;
const appDataDir = path.join(os.tmpdir(), runId);
const currentAppData = path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'n8n-media-review-center');
await mkdir(appDataDir, { recursive: true });
await copyFile(path.join(currentAppData, 'config.json'), path.join(appDataDir, 'config.json'));
process.env.APP_DATA_DIR = appDataDir;
process.env.LOG_LEVEL = 'silent';

const { buildApp } = await import('../apps/server/dist/app.js');
const app = await buildApp();
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
let sku;
const cleanupPaths = [];
const results = { runId, appDataDir, checks: {}, cleanup: false };

async function request(method, url, payload) {
  const response = await app.inject({ method, url, ...(payload === undefined ? {} : { payload }) });
  let body;
  try { body = response.json(); } catch { body = response.body; }
  if (response.statusCode < 200 || response.statusCode >= 300) {
    throw new Error(`${method} ${url} 失败 (${response.statusCode}): ${typeof body === 'string' ? body : JSON.stringify(body)}`);
  }
  return body;
}

async function exists(target) {
  return Boolean(await stat(target).catch(() => undefined));
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function createPng(target) {
  await mkdir(path.dirname(target), { recursive: true });
  await sharp({ create: { width: 64, height: 64, channels: 4, background: { r: 14, g: 165, b: 164, alpha: 1 } } })
    .png()
    .toFile(target);
}

async function createMp4(target) {
  await mkdir(path.dirname(target), { recursive: true });
  const ffmpeg = 'D:\\myTools\\ffmpeg\\bin\\ffmpeg.exe';
  const generated = spawnSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=black:s=160x160:d=0.6', '-c:v', 'mpeg4', '-pix_fmt', 'yuv420p', target], { encoding: 'utf8' });
  if (generated.status !== 0) throw new Error(`FFmpeg 验收视频生成失败: ${generated.stderr || generated.stdout}`);
}

async function writeContext(folder, workflowCode, identity) {
  await writeFile(path.join(folder, 'task-context.json'), `${JSON.stringify({
    schemaVersion: 1,
    workflowCode,
    SKU: identity.SKU,
    productName: identity.productName,
    ...(identity.variantId ? { variantId: identity.variantId } : {}),
    ...(identity.variants ? { variants: identity.variants } : {}),
    sourceSubmissionId: `${runId}-upstream`,
    n8nExecutionId: 'acceptance-local',
  }, null, 2)}\n`, 'utf8');
}

async function findTask(stageId, sourceFolderName) {
  await request('POST', `/api/v1/stages/${stageId}/rescan`);
  const tasks = await request('GET', `/api/v1/stages/${stageId}/tasks`);
  const task = tasks.items.find((item) => item.sourceFolderName === sourceFolderName);
  if (!task) throw new Error(`${stageId} 未扫描到验收目录 ${sourceFolderName}`);
  return task;
}

try {
  const config = app.services.config.get();
  const e001 = config.stages.find((stage) => stage.id === 'E001');
  const e004 = config.stages.find((stage) => stage.id === 'E004');
  const e005 = config.stages.find((stage) => stage.id === 'E005');
  assert(e001 && e004 && e005, 'E001/E004/E005 配置缺失');
  assert(e004.outputRoot === e005.outputRoot, 'E004/E005 outputRoot 不一致');
  assert((e004.outputRoot.match(/<SKU>/g) || []).length === 1, 'outputRoot 必须包含且只包含一个 <SKU>');

  const purchase = await request('POST', '/api/v1/purchases', {
    productName: `MerchRoute变体验收-${runId}`,
    purchasePrice: '1.00',
    courierFee: '0',
    currency: 'CNY',
    grossWeightGrams: '100',
    lengthCm: '10',
    widthCm: '10',
    heightCm: '10',
    transportMode: '验收',
    providerUrl: 'https://example.com/merchroute-acceptance',
  });
  sku = purchase.purchase.sku;
  const productName = purchase.purchase.productName;
  assert(purchase.purchase.variants.includes('默认变体'), '新产品未初始化默认变体');
  await request('POST', '/api/v1/wb/listings', { sku });

  const e001FolderName = `${runId}-e001`;
  const e001Folder = path.join(e001.candidateRoot, e001FolderName);
  cleanupPaths.push(e001Folder);
  await createPng(path.join(e001Folder, '01.png'));
  await writeContext(e001Folder, 'E001', { SKU: sku, productName });
  const e001Task = await findTask('E001', e001FolderName);
  const approved = await request('POST', `/api/v1/tasks/${encodeURIComponent(e001Task.taskId)}/approve`, {
    selectedRelativePaths: ['01.png'],
    targetStageIds: ['E002'],
    variantSelectionGroups: [{ groupId: `${runId}-red`, variantName: '验收红色', selectedRelativePaths: ['01.png'] }],
  });
  assert(approved.pendingSubmissions.length === 1, 'E001 未生成一条独立变体待投递记录');
  const pending = approved.pendingSubmissions[0];
  assert(pending.variantName === '验收红色', '待投递记录变体名未冻结');
  assert(pending.n8nTaskParameters.variants === '验收红色', 'n8n 参数未强制注入 variants');
  assert(typeof pending.variantId === 'string' && pending.variantId, '待投递记录未冻结 variantId');
  await request('DELETE', `/api/v1/pending-submissions/${encodeURIComponent(pending.id)}`);
  results.checks.e001VariantFreeze = { sku, variantId: pending.variantId, variantName: pending.variantName };

  const identity = { SKU: sku, productName, variantId: pending.variantId, variants: '验收红色' };
  const e004FolderName = `${runId}-e004`;
  const e005FolderName = `${runId}-e005`;
  const e004Folder = path.join(e004.candidateRoot, e004FolderName);
  const e005Folder = path.join(e005.candidateRoot, e005FolderName);
  cleanupPaths.push(e004Folder, e005Folder);
  await createMp4(path.join(e004Folder, 'main.mp4'));
  await createPng(path.join(e005Folder, '01.png'));
  await writeContext(e004Folder, 'E004', identity);
  await writeContext(e005Folder, 'E005', identity);

  const e004Task = await findTask('E004', e004FolderName);
  const e005Task = await findTask('E005', e005FolderName);
  assert(e004Task.mediaCount === 1 && e004Task.videoCount === 1, 'E004 未识别验收视频');
  assert(e005Task.mediaCount === 1 && e005Task.imageCount === 1, 'E005 未识别验收图片');
  const deliveredVideo = (await request('POST', `/api/v1/tasks/${encodeURIComponent(e004Task.taskId)}/approve`, { selectedRelativePaths: ['main.mp4'], targetStageIds: [] })).submission;
  const deliveredImage = (await request('POST', `/api/v1/tasks/${encodeURIComponent(e005Task.taskId)}/approve`, { selectedRelativePaths: ['01.png'], targetStageIds: [] })).submission;
  assert(deliveredVideo.status === 'SUCCESS' && deliveredImage.status === 'SUCCESS', 'E004/E005 终端投递未成功');
  cleanupPaths.push(deliveredVideo.archiveFolder, deliveredImage.archiveFolder);

  const expectedOutputRoot = e004.outputRoot.replace('<SKU>', sku);
  const productRoot = path.dirname(expectedOutputRoot);
  cleanupPaths.push(productRoot);
  assert(path.resolve(deliveredVideo.resolvedOutputRoot) === path.resolve(expectedOutputRoot), 'E004 未使用解析后的共享输出目录');
  assert(path.resolve(deliveredImage.resolvedOutputRoot) === path.resolve(expectedOutputRoot), 'E005 未使用解析后的共享输出目录');
  assert(!deliveredVideo.targetFolder.includes('<SKU>') && !deliveredImage.targetFolder.includes('<SKU>'), '投递生成了字面量 <SKU> 路径');
  assert(await exists(path.join(deliveredVideo.targetFolder, 'main.mp4')), '视频目标文件不存在');
  assert(await exists(path.join(deliveredImage.targetFolder, '01.png')), '图片目标文件不存在');

  const manifestPath = path.join(expectedOutputRoot, 'variant-media-manifest.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  assert(manifest.SKU === sku && manifest.assets.length === 2, '共享媒体清单 SKU 或媒体数量不正确');
  assert(new Set(manifest.assets.map((asset) => asset.sourceStageId)).size === 2, '清单未同时记录 E004/E005 来源');
  assert(manifest.assets.every((asset) => asset.variantId === pending.variantId && asset.variantName === '验收红色'), '清单变体身份不一致');

  const scan = await request('POST', `/api/v1/wb/listings/${sku}/media/scan`);
  assert(scan.mediaAssets.length === 2, 'WB 扫描未发现全部图片和视频');
  assert(scan.mediaAssets.some((asset) => asset.kind === 'image' && asset.productVariantName === '验收红色'), 'WB 未识别变体图片');
  assert(scan.mediaAssets.some((asset) => asset.kind === 'video' && asset.productVariantName === '验收红色'), 'WB 未识别变体视频');
  assert(scan.mediaAssets.every((asset) => asset.relativePath.startsWith('variants/验收红色/')), 'WB 未保留完整多层相对路径');
  results.checks.terminalDelivery = {
    outputRoot: expectedOutputRoot,
    videoTarget: deliveredVideo.targetFolder,
    imageTarget: deliveredImage.targetFolder,
    manifestAssets: manifest.assets.length,
  };
  results.checks.wbRecursiveScan = scan.mediaAssets.map((asset) => ({ kind: asset.kind, relativePath: asset.relativePath, variantName: asset.productVariantName, sourceStageId: asset.sourceStageId }));
} finally {
  await app.close().catch(() => undefined);
  for (const target of [...new Set(cleanupPaths.filter(Boolean))].sort((left, right) => right.length - left.length)) {
    await rm(target, { recursive: true, force: true }).catch(() => undefined);
  }
  if (sku) await pool.query('DELETE FROM products WHERE sku = $1', [sku]).catch(() => undefined);
  await pool.end().catch(() => undefined);
  await rm(appDataDir, { recursive: true, force: true }).catch(() => undefined);
  results.cleanup = true;
}

process.stdout.write(`${JSON.stringify(results, null, 2)}\n`);
