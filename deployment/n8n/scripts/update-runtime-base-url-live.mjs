import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeMerchRouteRuntimeUrls, findRuntimeEndpointContractViolations } from '../security.mjs';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const options = new Map(process.argv.slice(2).map((argument) => {
  const [key, ...value] = argument.replace(/^--/, '').split('=');
  return [key, value.length ? value.join('=') : 'true'];
}));
const apply = options.get('apply') === 'true';
const backupRoot = String(options.get('backup-root') || '').trim();
const apiBaseUrl = String(process.env.N8N_API_URL || 'http://127.0.0.1:5678').replace(/\/$/, '');
const apiKey = String(process.env.N8N_API_KEY || '').trim();
if (!apiKey) throw new Error('缺少 N8N_API_KEY');
if (apply && (!backupRoot || !path.isAbsolute(backupRoot))) throw new Error('--apply 必须同时提供仓库外绝对 --backup-root');
if (apply && (path.resolve(backupRoot) === projectRoot || path.resolve(backupRoot).startsWith(projectRoot + path.sep))) throw new Error('原始工作流备份禁止写入 Git 仓库');

const ids = [
  '0FqozLuQ7vuabT8V','3hyAiON1l3fEHBzA','BcWDcR0JIUKr05lo','cuBblkAPnQQbhWEI','dEg5v4DY59j0tGPB','flPkKc0aNf1uAZ5w','g3KK68BLXX7eShqa',
  'JcTDgNsprA7rPoMA','mTZV8BkPZpzHIJjz','qYxi3PPmRm7tjK0E','stSK51IuxrMZlLjx','WbwJ8ufnL349l9hk','wzrSZDZ0wOEh8XKy'
];
const digest = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

async function api(method, route, body) {
  const response = await fetch(`${apiBaseUrl}${route}`, {
    method,
    headers: { 'X-N8N-API-KEY': apiKey, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(60_000)
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${method} ${route} 失败：HTTP ${response.status} ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : null;
}

function updatePayload(workflow) {
  const allowed = new Set(['saveExecutionProgress','saveManualExecutions','saveDataErrorExecution','saveDataSuccessExecution','executionTimeout','errorWorkflow','timezone','executionOrder','callerPolicy','callerIds','timeSavedPerExecution','redactionPolicy','availableInMCP','customTelemetryTags']);
  return { name: workflow.name, nodes: workflow.nodes, connections: workflow.connections,
    settings: Object.fromEntries(Object.entries(workflow.settings || {}).filter(([key]) => allowed.has(key))) };
}

function assertIdentity(before, after) {
  if (before.id !== after.id || before.active !== after.active) throw new Error(`${before.id} ID 或 active 状态改变`);
  if (JSON.stringify(before.connections) !== JSON.stringify(after.connections)) throw new Error(`${before.id} 连接改变`);
  const afterById = new Map(after.nodes.map((node) => [node.id, node]));
  if (afterById.size !== before.nodes.length) throw new Error(`${before.id} 节点数量改变`);
  for (const node of before.nodes) {
    const current = afterById.get(node.id);
    if (!current || current.name !== node.name || current.type !== node.type) throw new Error(`${before.id}/${node.name} 节点身份改变`);
    if (JSON.stringify(current.credentials || {}) !== JSON.stringify(node.credentials || {})) throw new Error(`${before.id}/${node.name} 凭据绑定改变`);
  }
  const violations = findRuntimeEndpointContractViolations(after);
  if (violations.length) throw new Error(`${before.id} runtime 地址回读失败：${violations.join('; ')}`);
  if (after.active && after.activeVersionId !== after.versionId) throw new Error(`${before.id} activeVersionId 未指向新版本`);
}

async function assertNoActiveExecutions() {
  const result = await api('GET', '/api/v1/executions?status=running&limit=1');
  if (Array.isArray(result?.data) && result.data.length) {
    const execution = result.data[0];
    throw new Error(`n8n 存在活动执行 ${execution.id || 'UNKNOWN'} (${execution.workflowId || 'UNKNOWN'})，禁止修改工作流`);
  }
}

const plans = [];
for (const id of ids) {
  const live = await api('GET', `/api/v1/workflows/${id}`);
  const patched = normalizeMerchRouteRuntimeUrls(live);
  const violations = findRuntimeEndpointContractViolations(patched);
  if (violations.length) throw new Error(`${id} 规范化失败：${violations.join('; ')}`);
  const changed = digest(updatePayload(live)) !== digest(updatePayload(patched));
  plans.push({ id, live, patched, changed });
}

if (!apply) {
  console.log(JSON.stringify({ apply: false, workflows: plans.map(({ id, live, changed }) => ({ id, name: live.name, active: live.active, versionId: live.versionId, changed })) }, null, 2));
  process.exit(0);
}

await assertNoActiveExecutions();
await mkdir(backupRoot, { recursive: true, mode: 0o700 });
for (const plan of plans) await writeFile(path.join(backupRoot, `${plan.id}.json`), `${JSON.stringify(plan.live, null, 2)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });

const updated = [];
try {
  for (const plan of plans) {
    if (!plan.changed) continue;
    await assertNoActiveExecutions();
    await api('PUT', `/api/v1/workflows/${plan.id}`, updatePayload(plan.patched));
    const readback = await api('GET', `/api/v1/workflows/${plan.id}`);
    assertIdentity(plan.live, readback);
    updated.push(plan);
  }
} catch (error) {
  const rollbackErrors = [];
  for (const plan of [...updated].reverse()) {
    try {
      await api('PUT', `/api/v1/workflows/${plan.id}`, updatePayload(plan.live));
      const restored = await api('GET', `/api/v1/workflows/${plan.id}`);
      if (restored.active !== plan.live.active || JSON.stringify(restored.connections) !== JSON.stringify(plan.live.connections)) throw new Error('回滚回读不一致');
    } catch (rollbackError) { rollbackErrors.push(`${plan.id}: ${rollbackError?.message || rollbackError}`); }
  }
  throw new Error(`${error?.message || error}${rollbackErrors.length ? `；回滚失败：${rollbackErrors.join('; ')}` : updated.length ? '；已回滚本次已更新工作流' : '；未写入任何工作流'}`);
}

const readback = [];
for (const plan of plans) {
  const workflow = await api('GET', `/api/v1/workflows/${plan.id}`);
  assertIdentity(plan.live, workflow);
  readback.push({ id: workflow.id, name: workflow.name, active: workflow.active, versionId: workflow.versionId, activeVersionId: workflow.activeVersionId, updatedAt: workflow.updatedAt });
}
await writeFile(path.join(path.dirname(backupRoot), 'runtime-url-live-readback.json'), `${JSON.stringify(readback, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
console.log(JSON.stringify({ apply: true, updatedCount: updated.length, workflows: readback }, null, 2));
