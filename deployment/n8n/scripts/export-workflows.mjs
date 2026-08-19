import { access, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEPLOYMENT_PACKAGES, WORKFLOWS } from '../catalog.mjs';
import { collectWorkflowDependencies, sanitizeWorkflow, sha256, validateWorkflowShape } from '../security.mjs';
import { makeWorkflowPortable } from '../portable-workflow.mjs';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const n8nRoot = path.resolve(scriptDir, '..');
const outputRoot = path.join(n8nRoot, 'workflows');
const manifestPath = path.join(n8nRoot, 'manifest.json');
const apiBaseUrl = (process.env.N8N_API_URL || 'http://127.0.0.1:5678').replace(/\/$/, '');
const apiKey = process.env.N8N_API_KEY;

if (!apiKey) {
  throw new Error('缺少 N8N_API_KEY。请从安全环境变量注入，禁止写入仓库文件。');
}

if (WORKFLOWS.length === 0 || new Set(WORKFLOWS.map((item) => item.id)).size !== WORKFLOWS.length) {
  throw new Error('工作流目录不能为空且 ID 必须唯一');
}

async function exists(target) {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

async function fetchWorkflow(entry) {
  const response = await fetch(`${apiBaseUrl}/api/v1/workflows/${encodeURIComponent(entry.id)}`, {
    headers: { 'X-N8N-API-KEY': apiKey },
  });
  if (!response.ok) throw new Error(`读取工作流 ${entry.id} 失败：HTTP ${response.status}`);
  return response.json();
}

async function mapWithConcurrency(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await worker(items[index]);
    }
  });
  await Promise.all(runners);
  return results;
}

const rawWorkflows = await mapWithConcurrency(WORKFLOWS, 5, fetchWorkflow);
const knownIds = new Set(WORKFLOWS.map((item) => item.id));
const stagedRoot = path.join(n8nRoot, `.export-${process.pid}-${Date.now()}`);
const stagedWorkflows = path.join(stagedRoot, 'workflows');
const stagedManifest = path.join(stagedRoot, 'manifest.json');
const previousWorkflows = path.join(n8nRoot, `.export-previous-workflows-${process.pid}`);
const previousManifest = path.join(n8nRoot, `.export-previous-manifest-${process.pid}.json`);

let workflowsMoved = false;
let manifestMoved = false;

try {
  await mkdir(stagedWorkflows, { recursive: true });
  const manifestWorkflows = [];

  for (let index = 0; index < WORKFLOWS.length; index += 1) {
    const entry = WORKFLOWS[index];
    const { workflow: sanitizedWorkflow, report } = sanitizeWorkflow(rawWorkflows[index], entry);
    const workflow = makeWorkflowPortable(sanitizedWorkflow);
    const findings = validateWorkflowShape(workflow, entry.id);
    if (findings.length > 0) throw new Error(`${entry.id} 验证失败：${findings.join('; ')}`);

    const relativeFile = path.posix.join('workflows', entry.category, `${entry.id}.json`);
    const destination = path.join(stagedRoot, ...relativeFile.split('/'));
    const content = `${JSON.stringify(workflow, null, 2)}\n`;
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, content, { encoding: 'utf8', flag: 'wx' });

    const discoveredDependencies = collectWorkflowDependencies(workflow, knownIds);
    const dependencies = [...new Set([...(entry.dependencies || []), ...discoveredDependencies])].sort();
    for (const dependencyId of dependencies) {
      if (!knownIds.has(dependencyId) || dependencyId === entry.id) {
        throw new Error(`${entry.id} 声明了无效工作流依赖 ${dependencyId}`);
      }
    }

    manifestWorkflows.push({
      id: entry.id,
      name: workflow.name,
      category: entry.category,
      active: workflow.active,
      file: relativeFile,
      sha256: sha256(content),
      dependencies,
      security: report,
    });
  }

  const totals = manifestWorkflows.reduce(
    (sum, item) => ({
      removedCredentialBindings: sum.removedCredentialBindings + item.security.removedCredentialBindings,
      removedWebhookIds: sum.removedWebhookIds + item.security.removedWebhookIds,
      redactedLiterals: sum.redactedLiterals + item.security.redactedLiterals,
    }),
    { removedCredentialBindings: 0, removedWebhookIds: 0, redactedLiterals: 0 },
  );

  const manifest = {
    schemaVersion: 1,
    source: 'local-n8n-rest-api',
    workflowCount: manifestWorkflows.length,
    uniqueWorkflowCount: new Set(manifestWorkflows.map((item) => item.id)).size,
    packages: DEPLOYMENT_PACKAGES,
    securityPolicy: {
      credentialsRemoved: true,
      webhookIdsRemoved: true,
      runtimeStateRemoved: true,
      secretLiteralsRedacted: true,
      rawApiResponsesPersisted: false,
      databaseBackupsIncluded: false,
      portablePathTemplates: true,
    },
    securityTotals: totals,
    workflows: manifestWorkflows,
  };

  let generatedAt = new Date().toISOString();
  if (await exists(manifestPath)) {
    try {
      const previousManifest = JSON.parse(await readFile(manifestPath, 'utf8'));
      const { generatedAt: previousGeneratedAt, ...previousComparable } = previousManifest;
      if (JSON.stringify(previousComparable) === JSON.stringify(manifest)) {
        generatedAt = previousGeneratedAt || generatedAt;
      }
    } catch {
      // Invalid previous manifests are replaced only after the staged export passes validation.
    }
  }
  manifest.generatedAt = generatedAt;

  await writeFile(stagedManifest, `${JSON.stringify(manifest, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });

  for (const item of manifestWorkflows) {
    const content = await readFile(path.join(stagedRoot, ...item.file.split('/')), 'utf8');
    if (sha256(content) !== item.sha256) throw new Error(`${item.id} 的暂存 SHA-256 不匹配`);
  }

  if (await exists(previousWorkflows)) await rm(previousWorkflows, { recursive: true, force: true });
  if (await exists(previousManifest)) await rm(previousManifest, { force: true });
  if (await exists(outputRoot)) await rename(outputRoot, previousWorkflows);
  if (await exists(manifestPath)) await rename(manifestPath, previousManifest);

  await rename(stagedWorkflows, outputRoot);
  workflowsMoved = true;
  await rename(stagedManifest, manifestPath);
  manifestMoved = true;

  await rm(previousWorkflows, { recursive: true, force: true });
  await rm(previousManifest, { force: true });

  console.log(`已安全导出 ${manifest.workflowCount} 个工作流。`);
  console.log(`已删除凭据绑定 ${totals.removedCredentialBindings} 处、webhookId ${totals.removedWebhookIds} 处，脱敏字面值 ${totals.redactedLiterals} 处。`);
} catch (error) {
  if (workflowsMoved) await rm(outputRoot, { recursive: true, force: true });
  if (manifestMoved) await rm(manifestPath, { force: true });
  if (await exists(previousWorkflows)) await rename(previousWorkflows, outputRoot);
  if (await exists(previousManifest)) await rename(previousManifest, manifestPath);
  throw error;
} finally {
  await rm(stagedRoot, { recursive: true, force: true });
  await rm(previousWorkflows, { recursive: true, force: true });
  await rm(previousManifest, { force: true });
}
