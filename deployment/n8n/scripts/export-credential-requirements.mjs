import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WORKFLOWS } from '../catalog.mjs';
import { buildCredentialRequirements } from '../credential-contract.mjs';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const n8nRoot = path.resolve(scriptDir, '..');
const outputPath = path.join(n8nRoot, 'credential-requirements.json');
const apiBaseUrl = (process.env.N8N_API_URL || 'http://127.0.0.1:5678').replace(/\/$/, '');
const apiKey = process.env.N8N_API_KEY;
if (!apiKey) throw new Error('缺少 N8N_API_KEY。请从安全环境变量注入，禁止写入仓库文件。');

async function fetchWorkflow(entry) {
  const response = await fetch(`${apiBaseUrl}/api/v1/workflows/${encodeURIComponent(entry.id)}`, {
    headers: { 'X-N8N-API-KEY': apiKey },
  });
  if (!response.ok) throw new Error(`读取工作流 ${entry.id} 失败：HTTP ${response.status}`);
  return response.json();
}

const rawWorkflows = [];
for (let index = 0; index < WORKFLOWS.length; index += 5) {
  rawWorkflows.push(...await Promise.all(WORKFLOWS.slice(index, index + 5).map(fetchWorkflow)));
}
const requirements = buildCredentialRequirements(rawWorkflows);
let generatedAt = new Date().toISOString();
try {
  const previous = JSON.parse(await readFile(outputPath, 'utf8'));
  const { generatedAt: previousGeneratedAt, ...previousComparable } = previous;
  if (JSON.stringify(previousComparable) === JSON.stringify(requirements)) generatedAt = previousGeneratedAt || generatedAt;
} catch {
  // The first export has no previous file.
}
requirements.generatedAt = generatedAt;
await mkdir(path.dirname(outputPath), { recursive: true });
const temporaryPath = `${outputPath}.${process.pid}.tmp`;
await writeFile(temporaryPath, `${JSON.stringify(requirements, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
await rename(temporaryPath, outputPath);
console.log(`已导出 ${requirements.requirements.length} 组逻辑凭据、${requirements.bindings.length} 处安全绑定；未保存原凭据 ID、名称或值。`);
