import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

export const CATEGORY_RULES_RELATIVE_PATH = '00-config/category-scene-rules.json';

export const LOCAL_FILE_TRIGGER_CONTRACTS = Object.freeze([
  Object.freeze({ workflowId: 'Wxng7hVbjMNhVOaO', stage: 'E001', relativePath: '01_monitorFolder/E001-抠图-监听' }),
  Object.freeze({ workflowId: 'HpCtxAZJdy9RgWk2', stage: 'E002', relativePath: '01_monitorFolder/E002-白底图-生5图-监听' }),
  Object.freeze({ workflowId: 's0lQIcv1ZCgEzGlB', stage: 'E003', relativePath: '01_monitorFolder/E003-5生7-监听' }),
  Object.freeze({ workflowId: 'noHJuIiHfHryuA2e', stage: 'E004', relativePath: '01_monitorFolder/E004-主图生视频-监听' }),
  Object.freeze({ workflowId: 'aj5sD7nSxxpTuRMh', stage: 'E005', relativePath: '01_monitorFolder/E005-主图加-LOGO-监听' }),
]);

export function normalizeWorkflowPath(value) {
  return String(value || '').trim().replaceAll('\\', '/').replace(/\/+$/, '');
}

export function expectedLocalFileTriggerPath(dataRoot, contract) {
  return `${normalizeWorkflowPath(dataRoot)}/${contract.relativePath}`;
}

export function expectedLocalFileTriggerTemplate(contract) {
  return `__MERCHROUTE_DATA_ROOT__/${contract.relativePath}`;
}

function localFileTriggerNodes(workflow) {
  return (workflow?.nodes || []).filter((node) => node.type === 'n8n-nodes-base.localFileTrigger');
}

export function assertPortableLocalFileTriggerTemplates(workflows) {
  const byId = new Map(workflows.map((workflow) => [workflow.id, workflow]));
  for (const contract of LOCAL_FILE_TRIGGER_CONTRACTS) {
    const workflow = byId.get(contract.workflowId);
    if (!workflow) throw new Error(`${contract.stage} 缺少受控工作流 ${contract.workflowId}`);
    const nodes = localFileTriggerNodes(workflow);
    if (nodes.length !== 1) throw new Error(`${contract.stage} 必须恰好包含一个 Local File Trigger`);
    const actual = String(nodes[0].parameters?.path || '');
    const expected = expectedLocalFileTriggerTemplate(contract);
    if (actual !== expected) throw new Error(`${contract.stage} Local File Trigger 模板路径错误：${actual || '<empty>'}`);
    if (actual.includes('\\')) throw new Error(`${contract.stage} Local File Trigger 模板路径含反斜杠`);
  }
}

export function assertMaterializedLocalFileTriggerPaths(workflows, dataRoot) {
  const byId = new Map(workflows.map((workflow) => [workflow.id, workflow]));
  for (const contract of LOCAL_FILE_TRIGGER_CONTRACTS) {
    const workflow = byId.get(contract.workflowId);
    if (!workflow) throw new Error(`${contract.stage} 缺少受控工作流 ${contract.workflowId}`);
    const nodes = localFileTriggerNodes(workflow);
    if (nodes.length !== 1) throw new Error(`${contract.stage} 必须恰好包含一个 Local File Trigger`);
    const actual = String(nodes[0].parameters?.path || '');
    const expected = expectedLocalFileTriggerPath(dataRoot, contract);
    if (actual !== expected) throw new Error(`${contract.stage} Local File Trigger 路径错误：预期 ${expected}，实际 ${actual || '<empty>'}`);
    if (actual.includes('\\')) throw new Error(`${contract.stage} Local File Trigger 路径含反斜杠`);
  }
}

export function categoryRulesFilePath(dataRoot) {
  return path.resolve(dataRoot, ...CATEGORY_RULES_RELATIVE_PATH.split('/'));
}

function comparablePath(value) {
  const resolved = path.resolve(value).replace(/[\\/]+$/, '');
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

export function assertCanonicalCategoryRulesPath(dataRoot, configuredPath) {
  if (!configuredPath || !path.isAbsolute(configuredPath)) throw new Error('MERCHROUTE_CATEGORY_RULES_FILE 必须是绝对路径');
  const expected = categoryRulesFilePath(dataRoot);
  if (comparablePath(configuredPath) !== comparablePath(expected)) {
    throw new Error(`MERCHROUTE_CATEGORY_RULES_FILE 必须指向 ${expected}`);
  }
  return expected;
}

function parseCategoryRules(content, label) {
  let value;
  try { value = JSON.parse(content); }
  catch (error) { throw new Error(`${label} 不是有效 JSON：${error.message}`); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} 必须是 JSON 对象`);
  return value;
}

function sha256(content) {
  return createHash('sha256').update(content).digest('hex');
}

export async function verifyCategoryRulesFiles(repositoryFile, runtimeFile) {
  const [repositoryContent, runtimeContent] = await Promise.all([
    readFile(repositoryFile),
    readFile(runtimeFile),
  ]);
  parseCategoryRules(repositoryContent.toString('utf8'), '仓库内 E003 类目场景规则文件');
  parseCategoryRules(runtimeContent.toString('utf8'), '运行目录 E003 类目场景规则文件');
  const repositorySha256 = sha256(repositoryContent);
  const runtimeSha256 = sha256(runtimeContent);
  if (runtimeSha256 !== repositorySha256) throw new Error('运行目录 E003 类目场景规则文件与仓库版本 SHA-256 不一致');
  return { sha256: repositorySha256, runtimeFile };
}
