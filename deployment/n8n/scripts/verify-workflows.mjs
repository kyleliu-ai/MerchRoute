import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEPLOYMENT_PACKAGES, WORKFLOWS } from '../catalog.mjs';
import { sanitizeWorkflow, sha256, validateWorkflowShape } from '../security.mjs';
import { findLegacyRuntimePaths } from '../portable-workflow.mjs';
import { assertPortableLocalFileTriggerTemplates, verifyCategoryRulesFiles } from '../runtime-contract.mjs';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const n8nRoot = path.resolve(scriptDir, '..');
const deploymentRoot = path.resolve(n8nRoot, '..');
const manifestPath = path.join(n8nRoot, 'manifest.json');
const errors = [];

const regressionSecret = ['sk-proj-', 'A'.repeat(32)].join('');
const regressionRaw = {
  id: 'security-regression',
  name: 'security-regression',
  active: false,
  nodes: [{
    id: 'node',
    name: 'node',
    type: 'n8n-nodes-base.code',
    parameters: { jsCode: `const safe = $env.SAFE_KEY; const apiKey = "${regressionSecret}";` },
  }],
  connections: {},
  settings: {},
};
try {
  const regression = sanitizeWorkflow(regressionRaw, { id: regressionRaw.id, label: regressionRaw.name });
  const serialized = JSON.stringify(regression.workflow);
  if (serialized.includes(regressionSecret) || regression.report.redactedLiterals < 1) {
    errors.push('混合动态引用与硬编码密钥的脱敏回归失败');
  }
} catch (error) {
  errors.push(`脱敏回归无法运行：${error.message}`);
}

async function listFiles(root) {
  const output = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const absolute = path.join(root, entry.name);
    if (entry.isDirectory()) output.push(...(await listFiles(absolute)));
    else output.push(absolute);
  }
  return output;
}

let manifest;
try {
  manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
} catch (error) {
  throw new Error(`无法读取 deployment/n8n/manifest.json：${error.message}`);
}

const expectedIds = new Set(WORKFLOWS.map((item) => item.id));
const manifestIds = new Set((manifest.workflows || []).map((item) => item.id));
if (WORKFLOWS.length === 0 || expectedIds.size !== WORKFLOWS.length) errors.push('catalog.mjs 必须包含非空且唯一的工作流 ID');
if (manifest.workflowCount !== WORKFLOWS.length || manifest.uniqueWorkflowCount !== WORKFLOWS.length) errors.push('manifest 的工作流计数必须与 catalog.mjs 一致');
if (manifest.newInstallActivationPolicy !== 'inactive') errors.push('manifest 必须声明全新安装工作流保持停用');
if (manifestIds.size !== WORKFLOWS.length || [...expectedIds].some((id) => !manifestIds.has(id))) errors.push('manifest 的工作流 ID 与 catalog.mjs 不一致');
for (const entry of WORKFLOWS) {
  for (const dependencyId of entry.dependencies || []) {
    if (!expectedIds.has(dependencyId) || dependencyId === entry.id) errors.push(`${entry.id} 声明了无效依赖 ${dependencyId}`);
  }
}
const wbGateway = WORKFLOWS.find((item) => item.label === 'WB-A001-多店铺API网关');
if (!wbGateway) {
  errors.push('Wildberries 部署包缺少 WB-A001-多店铺API网关');
} else {
  for (const label of ['WB-S001-推进单个任务', 'WB-C001-只读预检与类目模板', 'WB-P003-类目与运行配置API']) {
    const entry = (manifest.workflows || []).find((item) => item.name === label);
    if (!entry || !Array.isArray(entry.dependencies) || !entry.dependencies.includes(wbGateway.id)) {
      errors.push(`${label} 未解析到 WB-A001 网关依赖`);
    }
  }
}
if (!manifest.securityPolicy?.credentialsRemoved || !manifest.securityPolicy?.secretLiteralsRedacted || manifest.securityPolicy?.databaseBackupsIncluded !== false || !manifest.securityPolicy?.portablePathTemplates) {
  errors.push('manifest 安全策略不完整');
}

for (const expectedPackage of DEPLOYMENT_PACKAGES) {
  const actualPackage = (manifest.packages || []).find((item) => item.id === expectedPackage.id);
  if (!actualPackage || JSON.stringify(actualPackage.workflowIds) !== JSON.stringify(expectedPackage.workflowIds)) {
    errors.push(`部署包 ${expectedPackage.id} 与 catalog.mjs 不一致`);
  }
}

const exportedFiles = [];
const verifiedWorkflows = [];
for (const item of manifest.workflows || []) {
  const catalogEntry = WORKFLOWS.find((entry) => entry.id === item.id);
  if (!catalogEntry) {
    errors.push(`manifest 包含未知工作流 ${item.id}`);
    continue;
  }
  const expectedFile = path.posix.join('workflows', catalogEntry.category, `${item.id}.json`);
  if (item.file !== expectedFile) errors.push(`${item.id} 文件路径错误：${item.file}`);

  const absolute = path.join(n8nRoot, ...expectedFile.split('/'));
  exportedFiles.push(path.normalize(absolute));
  try {
    const content = await readFile(absolute, 'utf8');
    if (sha256(content) !== item.sha256) errors.push(`${item.id} SHA-256 不匹配`);
    const workflow = JSON.parse(content);
    verifiedWorkflows.push(workflow);
    const legacyPaths = findLegacyRuntimePaths(workflow);
    if (legacyPaths.length) errors.push(`${item.id} 仍含本机路径：${legacyPaths.join(', ')}`);
    for (const finding of validateWorkflowShape(workflow, item.id)) errors.push(`${item.id}: ${finding}`);
    if (workflow.name !== item.name || workflow.active !== item.active) errors.push(`${item.id} 的名称或启用状态与 manifest 不一致`);
    for (const dependencyId of catalogEntry.dependencies || []) {
      if (!item.dependencies?.includes(dependencyId)) errors.push(`${item.id} 缺少声明依赖 ${dependencyId}`);
    }
  } catch (error) {
    errors.push(`${item.id} 无法读取或解析：${error.message}`);
  }
}

try {
  assertPortableLocalFileTriggerTemplates(verifiedWorkflows);
} catch (error) {
  errors.push(`E001–E005 Local File Trigger 路径契约失败：${error.message}`);
}

try {
  const categoryRulesFile = path.join(n8nRoot, 'config', 'category-scene-rules.json');
  await verifyCategoryRulesFiles(categoryRulesFile, categoryRulesFile);
} catch (error) {
  errors.push(`E003 类目场景规则文件无效：${error.message}`);
}

try {
  const actualJsonFiles = (await listFiles(path.join(n8nRoot, 'workflows')))
    .filter((file) => file.toLowerCase().endsWith('.json'))
    .map((file) => path.normalize(file))
    .sort();
  const expectedJsonFiles = [...exportedFiles].sort();
  if (JSON.stringify(actualJsonFiles) !== JSON.stringify(expectedJsonFiles)) errors.push('workflows/ 中存在清单外 JSON 或缺少清单文件');
} catch (error) {
  errors.push(`无法枚举 workflows/：${error.message}`);
}

const forbiddenDeploymentFile = /(?:^|[\\/])(?:\.env(?:[.-].*)?|\.merchroute-runtime\.env|credentials[^\\/]*\.json|secrets?[^\\/]*\.json|auth\.json|tokens\.json|config(?:\.json)?|database\.sqlite[^\\/]*)$|\.(?:dump|backup|bak|sql|sql\.gz|sqlite|sqlite3|db|pem|key|p12|pfx)$/i;
for (const file of await listFiles(deploymentRoot)) {
  if (forbiddenDeploymentFile.test(file)) errors.push(`deployment/ 含禁止文件：${path.relative(deploymentRoot, file)}`);
}

if (errors.length > 0) {
  console.error(`部署验证失败（${errors.length} 项）：`);
  errors.forEach((error) => console.error(`- ${error}`));
  process.exitCode = 1;
} else {
  console.log(`部署验证通过：${manifest.workflowCount} 个工作流，3 个部署包，E001–E005 路径模板与 E003 规则文件有效，未发现凭据字段或数据库备份。`);
}
