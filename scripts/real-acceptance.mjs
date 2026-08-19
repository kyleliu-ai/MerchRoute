import path from 'node:path';
import { mkdir, stat, writeFile } from 'node:fs/promises';
import sharp from 'sharp';

if (!process.argv.includes('--confirm-n8n-paused')) throw new Error('安全门禁：仅在相关 n8n 定时工作流已暂停后使用 --confirm-n8n-paused');
const baseArg = process.argv.findIndex((item) => item === '--base-url');
const baseUrl = baseArg >= 0 ? process.argv[baseArg + 1] : 'http://127.0.0.1:4191';
const resumeArg = process.argv.findIndex((item) => item === '--resume-prefix');
const stamp = new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14);
const prefix = resumeArg >= 0 ? process.argv[resumeArg + 1] : `CODEX-V001-ACCEPT-${stamp}`;
if (!prefix?.startsWith('CODEX-V001-ACCEPT-')) throw new Error('无效的验收前缀');
const runToken = resumeArg >= 0 ? `-RESUME-${stamp}` : '';
const roots = {
  e006: 'G:\\01_MerchRoute\\03-pddProductMedia',
  e003: 'G:\\01_MerchRoute\\02_generateFolder\\E003-7套图-下载',
  archiveE006: 'G:\\01_MerchRoute\\04_已审核图片目录\\E006-已经审核',
  archiveE003: 'G:\\01_MerchRoute\\04_已审核图片目录\\E003-7张套图-已经审核',
  targetE001: 'G:\\01_MerchRoute\\01_monitorFolder\\E001-抠图-监听',
  targetE004: 'G:\\01_MerchRoute\\01_monitorFolder\\E004-主图生视频-监听',
  targetE005: 'G:\\01_MerchRoute\\01_monitorFolder\\E005-主图加-LOGO-监听'
};
const created = [];

await request('/api/v1/health');
for (const directory of [roots.archiveE006, roots.archiveE003]) {
  await request('/api/v1/config/create-directory', { method: 'POST', body: JSON.stringify({ path: directory }) });
}
const e006Names = Array.from({ length: 10 }, (_, index) => `${prefix}-P${String(index + 1).padStart(2, '0')}`);
for (const name of e006Names) {
  const directory = path.join(roots.e006, name);
  await createProduct(directory, name, ['主图/image_01.png', '详情图/image_02.png']);
  created.push(directory);
}
const e003Name = `${prefix}-E003`;
const e003Directory = path.join(roots.e003, e003Name);
await createProduct(e003Directory, e003Name, ['scenePrompt01/image_01.png', 'scenePrompt02/image_02.png']);
created.push(e003Directory);

const e006Pending = [];
const alreadyCompleted = [];
let pendingSnapshot = (await request('/api/v1/pending-submissions')).items;
for (const name of e006Names) {
  const task = await findTask('E006', name);
  const targetReady = await stat(path.join(roots.targetE001, `${name}-已经审核`, '_READY.json')).catch(() => null);
  const archiveReady = await stat(path.join(roots.archiveE006, `${name}-已经审核`, '_READY.json')).catch(() => null);
  if (targetReady && archiveReady) {
    alreadyCompleted.push({ pendingSubmissionId: null, status: 'SUCCESS', resumedExisting: true, sourceFolderName: name });
    continue;
  }
  const existing = pendingSnapshot.find((item) => item.taskId === task.taskId && item.targetStageId === 'E001');
  if (existing) e006Pending.push(existing.id);
  else {
    const approval = await request(`/api/v1/tasks/${task.taskId}/approve`, { method: 'POST', body: JSON.stringify({ selectedRelativePaths: task.images.map((item) => item.relativePath), targetStageIds: ['E001'] }) });
    e006Pending.push(approval.pendingSubmissions[0].id);
  }
}
const resumedBatch = e006Pending.length ? await request('/api/v1/submissions/batch', { method: 'POST', body: JSON.stringify({ batchId: `BATCH-${prefix}-10${runToken}`, pendingSubmissionIds: e006Pending, conflictPolicy: 'skip' }) }) : { batchId: `BATCH-${prefix}-10${runToken}`, results: [] };
const batch10 = { ...resumedBatch, results: [...alreadyCompleted, ...resumedBatch.results] };
if (batch10.results.some((item) => item.status !== 'SUCCESS')) throw new Error(`10 产品批量投递存在失败：${JSON.stringify(batch10.results)}`);

const e003Task = await findTask('E003', e003Name);
pendingSnapshot = (await request('/api/v1/pending-submissions')).items;
let dualPending = pendingSnapshot.filter((item) => item.taskId === e003Task.taskId && ['E004', 'E005'].includes(item.targetStageId));
if (dualPending.length !== 2) {
  const e003Approval = await request(`/api/v1/tasks/${e003Task.taskId}/approve`, { method: 'POST', body: JSON.stringify({ selectedRelativePaths: e003Task.images.map((item) => item.relativePath), targetStageIds: ['E004', 'E005'] }) });
  dualPending = e003Approval.pendingSubmissions;
}
const dual = await request('/api/v1/submissions/batch', { method: 'POST', body: JSON.stringify({ batchId: `BATCH-${prefix}-DUAL${runToken}`, pendingSubmissionIds: dualPending.map((item) => item.id), conflictPolicy: 'skip' }) });
if (dual.results.some((item) => item.status !== 'SUCCESS')) throw new Error(`E003 双目标投递存在失败：${JSON.stringify(dual.results)}`);

const firstTask = await findTask('E006', e006Names[0]);
const revisionApproval = await request(`/api/v1/tasks/${firstTask.taskId}/approve`, { method: 'POST', body: JSON.stringify({ selectedRelativePaths: firstTask.images.map((item) => item.relativePath), targetStageIds: ['E001'] }) });
const revision = await request('/api/v1/submissions/batch', { method: 'POST', body: JSON.stringify({ batchId: `BATCH-${prefix}-R02${runToken}`, pendingSubmissionIds: [revisionApproval.pendingSubmissions[0].id], conflictPolicy: 'new-revision' }) });
if (revision.results[0]?.status !== 'SUCCESS') throw new Error(`R02 验收失败：${JSON.stringify(revision.results)}`);

const expected = [
  ...e006Names.flatMap((name) => [path.join(roots.e006, name), path.join(roots.archiveE006, `${name}-已经审核`), path.join(roots.targetE001, `${name}-已经审核`)]),
  path.join(roots.targetE001, `${e006Names[0]}-已经审核__R02`),
  e003Directory,
  path.join(roots.archiveE003, `${e003Name}-已经审核`),
  path.join(roots.targetE004, `${e003Name}-已经审核`),
  path.join(roots.targetE005, `${e003Name}-已经审核`)
];
for (const item of expected) if (!(await stat(item).catch(() => null))) throw new Error(`验收产物缺失：${item}`);
const report = { version: 'v001', prefix, completedAt: new Date().toISOString(), batch10, dual, revision, artifacts: expected };
const reportDir = path.resolve('acceptance-results');
await mkdir(reportDir, { recursive: true });
const reportFile = path.join(reportDir, `${prefix}.json`);
await writeFile(reportFile, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
console.log(JSON.stringify({ ok: true, reportFile, artifacts: expected }, null, 2));

async function findTask(stageId, name) {
  await request(`/api/v1/stages/${stageId}/rescan`, { method: 'POST' });
  const list = await request(`/api/v1/stages/${stageId}/tasks?search=${encodeURIComponent(name)}&pageSize=100`);
  const summary = list.items.find((item) => item.sourceFolderName === name);
  if (!summary) throw new Error(`扫描不到验收产品：${stageId}/${name}`);
  return request(`/api/v1/tasks/${summary.taskId}`);
}
async function request(url, init) {
  const response = await fetch(`${baseUrl}${url}`, { ...init, headers: init?.body ? { 'Content-Type': 'application/json' } : undefined });
  const data = await response.json();
  if (!response.ok) throw new Error(data?.error ? `${data.error.code}: ${data.error.message}` : `HTTP ${response.status}`);
  return data;
}
async function createProduct(directory, productName, relativePaths) {
  if (await stat(directory).catch(() => null)) return;
  await mkdir(directory, { recursive: false });
  await writeFile(path.join(directory, 'product-info.json'), `${JSON.stringify({ productName, acceptance: true }, null, 2)}\n`, 'utf8');
  for (const [index, relative] of relativePaths.entries()) {
    const file = path.join(directory, ...relative.split('/'));
    await mkdir(path.dirname(file), { recursive: true });
    await sharp({ create: { width: 320, height: 320, channels: 3, background: index ? '#d98b2b' : '#087f8c' } }).png().toFile(file);
  }
}
