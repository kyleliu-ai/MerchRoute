import { access, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WORKFLOWS } from '../catalog.mjs';
import { collectWorkflowDependencies, sanitizeWorkflow, sha256, validateWorkflowShape } from '../security.mjs';
import { makeWorkflowPortable } from '../portable-workflow.mjs';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const n8nRoot = path.resolve(scriptDir, '..');
const manifestPath = path.join(n8nRoot, 'manifest.json');
const workflowId = String(process.argv.find((value) => value.startsWith('--id='))?.slice(5) || '').trim();
const entry = WORKFLOWS.find((item) => item.id === workflowId);
if (!entry) throw new Error(`--id 必须是已登记的工作流 ID: ${workflowId || 'EMPTY'}`);
const apiBaseUrl = (process.env.N8N_API_URL || 'http://127.0.0.1:5678').replace(/\/$/, '');
const apiKey = process.env.N8N_API_KEY;
if (!apiKey) throw new Error('缺少 N8N_API_KEY');

async function exists(target) {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

const response = await fetch(`${apiBaseUrl}/api/v1/workflows/${encodeURIComponent(entry.id)}`, {
  headers: { 'X-N8N-API-KEY': apiKey },
  signal: AbortSignal.timeout(60_000)
});
if (!response.ok) throw new Error(`读取工作流 ${entry.id} 失败: HTTP ${response.status}`);
const raw = await response.json();
const { workflow: sanitized, report } = sanitizeWorkflow(raw, entry);
const workflow = makeWorkflowPortable(sanitized);
const findings = validateWorkflowShape(workflow, entry.id);
if (findings.length) throw new Error(`${entry.id} 验证失败: ${findings.join('; ')}`);

const knownIds = new Set(WORKFLOWS.map((item) => item.id));
const dependencies = [...new Set([
  ...(entry.dependencies || []),
  ...collectWorkflowDependencies(workflow, knownIds)
])].sort();
if (dependencies.some((id) => !knownIds.has(id) || id === entry.id)) throw new Error(`${entry.id} 包含无效工作流依赖`);

const relativeFile = path.posix.join('workflows', entry.category, `${entry.id}.json`);
const workflowPath = path.join(n8nRoot, ...relativeFile.split('/'));
const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
const manifestIndex = manifest.workflows?.findIndex((item) => item.id === entry.id) ?? -1;
if (manifestIndex < 0) throw new Error(`manifest 未登记 ${entry.id}`);
const content = `${JSON.stringify(workflow, null, 2)}\n`;
manifest.workflows[manifestIndex] = {
  ...manifest.workflows[manifestIndex],
  name: workflow.name,
  active: workflow.active,
  file: relativeFile,
  sha256: sha256(content),
  dependencies,
  security: report
};
manifest.securityTotals = manifest.workflows.reduce((sum, item) => ({
  removedCredentialBindings: sum.removedCredentialBindings + Number(item.security?.removedCredentialBindings || 0),
  removedWebhookIds: sum.removedWebhookIds + Number(item.security?.removedWebhookIds || 0),
  redactedLiterals: sum.redactedLiterals + Number(item.security?.redactedLiterals || 0)
}), { removedCredentialBindings: 0, removedWebhookIds: 0, redactedLiterals: 0 });
manifest.generatedAt = new Date().toISOString();
const manifestContent = `${JSON.stringify(manifest, null, 2)}\n`;

await mkdir(path.dirname(workflowPath), { recursive: true });
const suffix = `.single-export-${process.pid}-${Date.now()}`;
const workflowTemporary = `${workflowPath}${suffix}.tmp`;
const manifestTemporary = `${manifestPath}${suffix}.tmp`;
const workflowBackup = `${workflowPath}${suffix}.bak`;
const manifestBackup = `${manifestPath}${suffix}.bak`;
await writeFile(workflowTemporary, content, { encoding: 'utf8', flag: 'wx' });
await writeFile(manifestTemporary, manifestContent, { encoding: 'utf8', flag: 'wx' });
if (sha256(await readFile(workflowTemporary, 'utf8')) !== manifest.workflows[manifestIndex].sha256) {
  throw new Error('单工作流导出的暂存 SHA-256 不匹配');
}

try {
  if (await exists(workflowPath)) await rename(workflowPath, workflowBackup);
  await rename(workflowTemporary, workflowPath);
  await rename(manifestPath, manifestBackup);
  await rename(manifestTemporary, manifestPath);
  await rm(workflowBackup, { force: true });
  await rm(manifestBackup, { force: true });
} catch (error) {
  await rm(workflowTemporary, { force: true });
  await rm(manifestTemporary, { force: true });
  if (await exists(workflowBackup)) {
    await rm(workflowPath, { force: true });
    await rename(workflowBackup, workflowPath);
  }
  if (await exists(manifestBackup)) {
    await rm(manifestPath, { force: true });
    await rename(manifestBackup, manifestPath);
  }
  throw error;
}

console.log(JSON.stringify({
  ok: true,
  id: entry.id,
  name: workflow.name,
  file: relativeFile,
  sha256: manifest.workflows[manifestIndex].sha256,
  security: report
}, null, 2));
