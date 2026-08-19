import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { CREDENTIAL_DEFINITIONS, buildCredentialImportData } from '../credential-contract.mjs';
import { materializeWorkflow } from '../portable-workflow.mjs';
import {
  assertCanonicalCategoryRulesPath,
  assertMaterializedLocalFileTriggerPaths,
  verifyCategoryRulesFiles,
} from '../runtime-contract.mjs';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const n8nRoot = path.resolve(scriptDir, '..');
const manifest = JSON.parse(await readFile(path.join(n8nRoot, 'manifest.json'), 'utf8'));
const requirements = JSON.parse(await readFile(path.join(n8nRoot, 'credential-requirements.json'), 'utf8'));
const args = new Map(process.argv.slice(2).map((item) => {
  const [key, ...rest] = item.replace(/^--/, '').split('=');
  return [key, rest.length ? rest.join('=') : 'true'];
}));
const dryRun = args.get('dry-run') === 'true';
const credentialsFile = args.get('credentials-file') || process.env.MERCHROUTE_CREDENTIAL_INPUT_FILE || '';
const runtimeKey = String(process.env.MERCHROUTE_RUNTIME_KEY || '').trim();
const runtimePaths = {
  MERCHROUTE_N8N_RUNTIME_DIR: process.env.MERCHROUTE_N8N_RUNTIME_DIR,
  MERCHROUTE_DATA_ROOT: process.env.MERCHROUTE_DATA_ROOT,
  MERCHROUTE_BROWSER_PROFILE_ROOT: process.env.MERCHROUTE_BROWSER_PROFILE_ROOT,
  MERCHROUTE_BROWSER_EXECUTABLE: process.env.MERCHROUTE_BROWSER_EXECUTABLE,
  MERCHROUTE_TEMP_DIR: process.env.MERCHROUTE_TEMP_DIR,
};

if (manifest.workflowCount !== 36 || manifest.uniqueWorkflowCount !== 36) throw new Error('只允许导入已验证的 36 个工作流');
if (manifest.newInstallActivationPolicy !== 'inactive') throw new Error('全新安装必须显式声明工作流保持停用');
const e007Manifest = manifest.workflows.find((item) => item.id === 'G8MSbp9u0dudSgba');
if (e007Manifest?.name !== 'E007-v01-1688产品媒体下载') throw new Error('n8n 部署包缺少受控 E007 工作流 G8MSbp9u0dudSgba');
if (!requirements.requirements?.length || !requirements.bindings?.length) throw new Error('credential-requirements.json 不完整');
if (!credentialsFile || !path.isAbsolute(credentialsFile)) throw new Error('--credentials-file 必须是仓库外的绝对路径');
const resolvedCredentialsFile = path.resolve(credentialsFile);
if (resolvedCredentialsFile.startsWith(path.resolve(n8nRoot, '..', '..') + path.sep)) throw new Error('凭据输入文件禁止放在 Git 仓库内');
const categoryRulesFile = assertCanonicalCategoryRulesPath(
  runtimePaths.MERCHROUTE_DATA_ROOT,
  process.env.MERCHROUTE_CATEGORY_RULES_FILE,
);
await verifyCategoryRulesFiles(path.join(n8nRoot, 'config', 'category-scene-rules.json'), categoryRulesFile);
const input = JSON.parse(await readFile(resolvedCredentialsFile, 'utf8'));
const importData = buildCredentialImportData(input, runtimeKey);

const importedCredentials = requirements.requirements.map((requirement) => ({
  id: requirement.credentialId,
  name: requirement.displayName,
  type: requirement.type,
  data: importData[requirement.logicalAlias],
}));

const bindingsByWorkflow = new Map();
for (const binding of requirements.bindings) {
  const list = bindingsByWorkflow.get(binding.workflowId) || [];
  list.push(binding);
  bindingsByWorkflow.set(binding.workflowId, list);
}

const preparedWorkflows = [];
for (const item of manifest.workflows) {
  const sourcePath = path.join(n8nRoot, ...item.file.split('/'));
  const workflow = materializeWorkflow(JSON.parse(await readFile(sourcePath, 'utf8')), runtimePaths);
  // 新装导入与增量发布是两条不同路径：新装必须保持停用；增量更新应通过 REST API 保留现场 active 状态。
  workflow.active = false;
  for (const binding of bindingsByWorkflow.get(item.id) || []) {
    const node = workflow.nodes.find((candidate) => candidate.name === binding.nodeName);
    if (!node) throw new Error(`${item.id} 缺少凭据绑定节点 ${binding.nodeName}`);
    const definition = CREDENTIAL_DEFINITIONS[binding.logicalAlias];
    node.credentials = node.credentials || {};
    node.credentials[binding.credentialType] = { id: definition.credentialId, name: definition.displayName };
  }
  preparedWorkflows.push({ id: item.id, workflow });
}
assertMaterializedLocalFileTriggerPaths(preparedWorkflows.map((item) => item.workflow), runtimePaths.MERCHROUTE_DATA_ROOT);

if (dryRun) {
  console.log(`dry-run 通过：E001–E005 监听路径与 E003 规则文件验证通过；${importedCredentials.length} 组凭据可生成，${manifest.workflowCount} 个工作流（含 E007 G8MSbp9u0dudSgba）将保持停用。`);
  process.exit(0);
}

const n8nCommand = process.env.N8N_COMMAND || (process.platform === 'win32' ? 'n8n.cmd' : 'n8n');
const secretRoot = path.dirname(resolvedCredentialsFile);
const temporaryRoot = await mkdtemp(path.join(secretRoot, '.n8n-import-'));
await chmod(temporaryRoot, 0o700).catch(() => undefined);

function runN8n(commandArgs) {
  return new Promise((resolve, reject) => {
    const child = spawn(n8nCommand, commandArgs, { stdio: ['ignore', 'pipe', 'pipe'], env: process.env, windowsHide: true });
    let output = '';
    let errorOutput = '';
    child.stdout.on('data', (chunk) => { output += String(chunk); });
    child.stderr.on('data', (chunk) => { errorOutput += String(chunk); });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve(output);
      else reject(new Error(`n8n CLI 失败（${code}）：${errorOutput.trim() || output.trim()}`));
    });
  });
}

try {
  const credentialImportPath = path.join(temporaryRoot, 'credentials.json');
  const workflowImportRoot = path.join(temporaryRoot, 'workflows');
  await mkdir(workflowImportRoot, { recursive: true });
  await writeFile(credentialImportPath, `${JSON.stringify(importedCredentials)}\n`, { encoding: 'utf8', mode: 0o600 });

  for (const { id, workflow } of preparedWorkflows) {
    await writeFile(path.join(workflowImportRoot, `${id}.json`), `${JSON.stringify(workflow, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  }

  await runN8n(['import:credentials', `--input=${credentialImportPath}`]);
  await runN8n(['import:workflow', '--separate', `--input=${workflowImportRoot}`, '--activeState=false']);
  console.log(`导入完成：${importedCredentials.length} 组凭据，${manifest.workflowCount} 个工作流（含 E007 G8MSbp9u0dudSgba）；全部保持停用。`);
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}
