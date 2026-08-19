import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const n8nRoot = path.resolve(scriptDir, '..');
const projectRoot = path.resolve(n8nRoot, '..', '..');
const args = new Map(process.argv.slice(2).map((item) => {
  const [key, ...rest] = item.replace(/^--/, '').split('=');
  return [key, rest.length ? rest.join('=') : 'true'];
}));
const apply = args.get('apply') === 'true';
const backupRoot = String(args.get('backup-root') || '').trim();
const apiBaseUrl = String(process.env.N8N_API_URL || 'http://127.0.0.1:5678').replace(/\/$/, '');
const apiKey = String(process.env.N8N_API_KEY || '').trim();
if (!apiKey) throw new Error('缺少 N8N_API_KEY');
if (apply && (!backupRoot || !path.isAbsolute(backupRoot))) throw new Error('--apply 必须同时提供仓库外绝对 --backup-root');
if (apply && (path.resolve(backupRoot) === projectRoot || path.resolve(backupRoot).startsWith(projectRoot + path.sep))) throw new Error('工作流原始备份禁止写入 Git 仓库');

const definitions = [
  {
    id: 'x8D4EHfqI2DHcgL7',
    file: path.join(n8nRoot, 'workflows', 'core', 'x8D4EHfqI2DHcgL7.json'),
    codeNodes: ['Load Preset Config', 'Build Render Result'],
    stickyNotes: ['Workflow Summary'],
    markerNode: 'Build FFmpeg Command',
    marker: 'const S015_RENDER_SCRIPT_GZIP_BASE64 = ',
  },
  {
    id: 'noHJuIiHfHryuA2e',
    file: path.join(n8nRoot, 'workflows', 'core', 'noHJuIiHfHryuA2e.json'),
    codeNodes: ['Parse Stable Result', 'Collect Image Files', 'Prepare Job Json', 'Build Final Result'],
    stickyNotes: ['Workflow Summary'],
    markerNode: 'Normalize Trigger Path',
    marker: 'const E004_WAIT_STABLE_SCRIPT_GZIP_BASE64 = ',
    copyParameters: ['setParameter'],
  },
];

const digest = (value) => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
const clone = (value) => structuredClone(value);

async function api(method, route, body) {
  const response = await fetch(`${apiBaseUrl}${route}`, {
    method,
    headers: {
      'X-N8N-API-KEY': apiKey,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(60_000),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${method} ${route} 失败：HTTP ${response.status} ${text.slice(0, 500)}`);
  return text ? JSON.parse(text) : null;
}

function requireNode(workflow, name) {
  const node = workflow.nodes.find((candidate) => candidate.name === name);
  if (!node) throw new Error(`${workflow.id} 缺少节点 ${name}`);
  return node;
}

function mergeCodeTail(liveCode, repositoryCode, marker, label) {
  const liveIndex = liveCode.indexOf(marker);
  const repositoryIndex = repositoryCode.indexOf(marker);
  if (liveIndex < 0 || repositoryIndex < 0) throw new Error(`${label} 缺少安全合并标记`);
  return `${liveCode.slice(0, liveIndex)}${repositoryCode.slice(repositoryIndex)}`;
}

function updatePayload(workflow) {
  const allowedSettingKeys = new Set([
    'saveExecutionProgress', 'saveManualExecutions', 'saveDataErrorExecution',
    'saveDataSuccessExecution', 'executionTimeout', 'errorWorkflow', 'timezone',
    'executionOrder', 'callerPolicy', 'callerIds', 'timeSavedPerExecution',
    'redactionPolicy', 'availableInMCP', 'customTelemetryTags',
  ]);
  return {
    name: workflow.name,
    nodes: workflow.nodes,
    connections: workflow.connections,
    settings: Object.fromEntries(Object.entries(workflow.settings || {}).filter(([key]) => allowedSettingKeys.has(key))),
  };
}

function patchWorkflow(live, repository, definition) {
  const patched = clone(live);
  patched.name = repository.name;
  const liveIds = patched.nodes.map((node) => node.id).sort();
  const repositoryIds = repository.nodes.map((node) => node.id).sort();
  if (JSON.stringify(liveIds) !== JSON.stringify(repositoryIds)) throw new Error(`${definition.id} 本机与仓库节点 ID 集合不一致`);
  for (const name of definition.codeNodes || []) {
    const target = requireNode(patched, name);
    const source = requireNode(repository, name);
    if (target.id !== source.id || target.type !== source.type) throw new Error(`${definition.id}/${name} 节点身份不一致`);
    target.parameters.jsCode = source.parameters.jsCode;
  }
  for (const name of definition.stickyNotes || []) {
    requireNode(patched, name).parameters.content = requireNode(repository, name).parameters.content;
  }
  for (const name of definition.copyParameters || []) {
    const target = requireNode(patched, name);
    const source = requireNode(repository, name);
    if (target.id !== source.id || target.type !== source.type) throw new Error(`${definition.id}/${name} 节点身份不一致`);
    target.parameters = clone(source.parameters);
  }
  const markerTarget = requireNode(patched, definition.markerNode);
  const markerSource = requireNode(repository, definition.markerNode);
  markerTarget.parameters.jsCode = mergeCodeTail(markerTarget.parameters.jsCode, markerSource.parameters.jsCode, definition.marker, `${definition.id}/${definition.markerNode}`);
  return patched;
}

function assertPreserved(before, after, expected) {
  if (after.id !== before.id) throw new Error(`${before.id} 回读 ID 改变`);
  if (after.active !== before.active) throw new Error(`${before.id} 回读 active 状态改变`);
  if (JSON.stringify(after.connections) !== JSON.stringify(before.connections)) throw new Error(`${before.id} 回读连接发生变化`);
  if (JSON.stringify(after.settings || {}) !== JSON.stringify(before.settings || {})) throw new Error(`${before.id} 回读设置发生变化`);
  for (const beforeNode of before.nodes) {
    const afterNode = requireNode(after, beforeNode.name);
    if (afterNode.id !== beforeNode.id || afterNode.type !== beforeNode.type) throw new Error(`${before.id}/${beforeNode.name} 回读节点身份改变`);
    if (JSON.stringify(afterNode.credentials || {}) !== JSON.stringify(beforeNode.credentials || {})) throw new Error(`${before.id}/${beforeNode.name} 回读凭据绑定改变`);
  }
  for (const name of expected.codeNodes || []) {
    if (requireNode(after, name).parameters.jsCode !== requireNode(expected.repository, name).parameters.jsCode) throw new Error(`${before.id}/${name} 回读代码不一致`);
  }
  const markerCode = requireNode(after, expected.markerNode).parameters.jsCode;
  const repositoryMarkerCode = requireNode(expected.repository, expected.markerNode).parameters.jsCode;
  const markerIndex = markerCode.indexOf(expected.marker);
  const repositoryMarkerIndex = repositoryMarkerCode.indexOf(expected.marker);
  if (markerIndex < 0 || markerCode.slice(markerIndex) !== repositoryMarkerCode.slice(repositoryMarkerIndex)) throw new Error(`${before.id}/${expected.markerNode} 回读内嵌代码不一致`);
  if (after.active && after.activeVersionId !== after.versionId) throw new Error(`${before.id} 更新后 activeVersionId 未指向新版本`);
}

const plans = [];
for (const definition of definitions) {
  const [live, repository] = await Promise.all([
    api('GET', `/api/v1/workflows/${definition.id}`),
    readFile(definition.file, 'utf8').then(JSON.parse),
  ]);
  const patched = patchWorkflow(live, repository, definition);
  plans.push({ ...definition, live, repository, patched });
}

const summary = plans.map((plan) => ({
  id: plan.id,
  beforeName: plan.live.name,
  afterName: plan.patched.name,
  active: plan.live.active,
  beforeVersionId: plan.live.versionId,
  beforeCodeSha256: digest(updatePayload(plan.live)),
  afterCodeSha256: digest(updatePayload(plan.patched)),
  changed: digest(updatePayload(plan.live)) !== digest(updatePayload(plan.patched)),
}));

if (!apply) {
  console.log(JSON.stringify({ apply: false, order: definitions.map((item) => item.id), workflows: summary }, null, 2));
  process.exit(0);
}

await mkdir(backupRoot, { recursive: true, mode: 0o700 });
for (const plan of plans) await writeFile(path.join(backupRoot, `${plan.id}.json`), `${JSON.stringify(plan.live, null, 2)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });

const updated = [];
try {
  for (const plan of plans) {
    if (!summary.find((item) => item.id === plan.id).changed) continue;
    await api('PUT', `/api/v1/workflows/${plan.id}`, updatePayload(plan.patched));
    const readback = await api('GET', `/api/v1/workflows/${plan.id}`);
    assertPreserved(plan.live, readback, plan);
    updated.push(plan);
  }
} catch (error) {
  const rollbackErrors = [];
  for (const plan of [...updated].reverse()) {
    try {
      await api('PUT', `/api/v1/workflows/${plan.id}`, updatePayload(plan.live));
      const restored = await api('GET', `/api/v1/workflows/${plan.id}`);
      if (restored.active !== plan.live.active || JSON.stringify(restored.connections) !== JSON.stringify(plan.live.connections)) throw new Error('回滚回读不一致');
    } catch (rollbackError) {
      rollbackErrors.push(`${plan.id}: ${rollbackError?.message || rollbackError}`);
    }
  }
  const recovery = rollbackErrors.length
    ? `；回滚失败：${rollbackErrors.join('; ')}`
    : updated.length ? '；已回滚本次已更新工作流' : '；未写入任何工作流';
  throw new Error(`${error?.message || error}${recovery}`);
}

const readback = [];
for (const plan of plans) {
  const workflow = await api('GET', `/api/v1/workflows/${plan.id}`);
  readback.push({
    id: workflow.id,
    name: workflow.name,
    active: workflow.active,
    versionId: workflow.versionId,
    activeVersionId: workflow.activeVersionId,
    updatedAt: workflow.updatedAt,
    codeSha256: digest(updatePayload(workflow)),
  });
}
await writeFile(path.join(path.dirname(backupRoot), 'live-readback.json'), `${JSON.stringify(readback, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
console.log(JSON.stringify({ apply: true, backupRoot, workflows: readback }, null, 2));
