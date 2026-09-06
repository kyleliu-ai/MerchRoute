import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  assertJimengGlobalConfigWorkflow,
  patchJimengGlobalConfigWorkflow,
} from '../patches/jimeng-global-config-v1.mjs';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const patchOrder = ['ieWnRGeC7KdeS1GT', 'Wxng7hVbjMNhVOaO', 'HpCtxAZJdy9RgWk2'];
const e003Id = 's0lQIcv1ZCgEzGlB';
const globalWorkflowId = 'jN9Gqze2z9S1A0wt';
const globalNodeId = '60a084ea-2e0d-4f02-a77a-8c026458647b';
const allowedSettings = new Set([
  'saveExecutionProgress', 'saveManualExecutions', 'saveDataErrorExecution',
  'saveDataSuccessExecution', 'executionTimeout', 'errorWorkflow', 'timezone',
  'executionOrder', 'callerPolicy', 'callerIds', 'timeSavedPerExecution',
  'redactionPolicy', 'availableInMCP', 'customTelemetryTags',
]);

function parseArguments(argv) {
  const values = new Map();
  const expectedVersions = {};
  const expectedActiveVersions = {};
  for (const argument of argv) {
    if (argument === '--apply') values.set('apply', 'true');
    else if (argument.startsWith('--expected=')) {
      const [id, versionId] = argument.slice('--expected='.length).split(':');
      expectedVersions[id] = versionId;
    } else if (argument.startsWith('--expected-active=')) {
      const [id, versionId] = argument.slice('--expected-active='.length).split(':');
      expectedActiveVersions[id] = versionId;
    } else {
      const [key, ...rest] = argument.replace(/^--/, '').split('=');
      values.set(key, rest.length ? rest.join('=') : 'true');
    }
  }
  return { values, expectedVersions, expectedActiveVersions };
}

function updatePayload(workflow) {
  const settings = { ...workflow.settings };
  delete settings.binaryMode;
  const unknown = Object.keys(settings).filter((key) => !allowedSettings.has(key));
  assert.deepEqual(unknown, [], `${workflow.id}: 存在 public API PUT 不支持的 settings`);
  return {
    name: workflow.name,
    nodes: workflow.nodes,
    connections: workflow.connections,
    settings,
  };
}

function changedNodeNames(before, after) {
  const beforeById = new Map(before.nodes.map((node) => [node.id, node]));
  return after.nodes
    .filter((node) => JSON.stringify(node) !== JSON.stringify(beforeById.get(node.id)))
    .map((node) => node.name);
}

function expectedChangedNodes(id) {
  if (id === 'Wxng7hVbjMNhVOaO') return new Set([
    'Global Constants', 'setParameter', 'Build Jimeng Tasks',
    'Generate Cutout Image', 'Generate Cutout Image Retry Once',
  ]);
  if (id === 'HpCtxAZJdy9RgWk2') return new Set([
    'Global Constants', 'setParameter', 'Build View Tasks', 'Build Async Submit Batch',
    'Submit View Tasks Async', 'Initialize View Polling', 'Check View Tasks Status',
    'Build Explicit Retry Batch', 'Submit Explicit Retry Tasks',
    'Initialize Retry Polling', 'Check Retry Tasks Status',
  ]);
  return new Set([
    'Global Constants', 'Normalize Batch Or Single Input', 'Generate Base64 Image',
    'Build Async Submit Batch', 'Submit Image Tasks Async', 'Initialize Initial Polling',
    'Check Initial Tasks Status', 'Build Explicit Retry Batch',
    'Submit Explicit Retry Tasks', 'Initialize Retry Polling', 'Check Retry Tasks Status',
  ]);
}

function assertPatchScope(before, after) {
  if (before.nodes.some((node) => node.name === 'Global Constants')) {
    const actual = changedNodeNames(before, after);
    const allowedMigrationNodes = before.id === 'Wxng7hVbjMNhVOaO'
      ? new Set(['Build Jimeng Tasks'])
      : before.id === 'HpCtxAZJdy9RgWk2'
        ? new Set(['Build View Tasks', 'Evaluate View Tasks', 'Evaluate Retry Tasks'])
        : new Set(['Normalize Batch Or Single Input', 'Evaluate Initial Tasks', 'Evaluate Retry Tasks']);
    assert.ok(
      actual.every((nodeName) => allowedMigrationNodes.has(nodeName)),
      `${before.id}: 运行时兼容修复范围漂移：${actual.join(', ')}`,
    );
    assert.equal(after.nodes.length, before.nodes.length, `${before.id}: URL 校验修复不得增删节点`);
    assert.equal(after.name, before.name);
    assert.equal(after.active, before.active);
    assert.deepEqual(after.connections, before.connections);
    assert.deepEqual(after.settings, before.settings);
    if (actual.length === 0) assert.deepEqual(after, before, `${before.id}: 幂等补丁不应产生变化`);
    assertJimengGlobalConfigWorkflow(after);
    return;
  }
  const actual = new Set(changedNodeNames(before, after));
  assert.deepEqual([...actual].sort(), [...expectedChangedNodes(before.id)].sort(), `${before.id}: 修改节点范围漂移`);
  assert.equal(after.nodes.length, before.nodes.length + 1, `${before.id}: 应只新增一个 Global Constants 节点`);
  assert.equal(after.name, before.name);
  assert.equal(after.active, before.active);
}

function assertReadback(before, expected, actual) {
  assert.equal(actual.id, before.id);
  assert.equal(actual.name, before.name);
  assert.equal(actual.active, before.active, `${before.id}: active 状态改变`);
  assert.deepEqual(actual.nodes, expected.nodes, `${before.id}: 节点回读不一致`);
  assert.deepEqual(actual.connections, expected.connections, `${before.id}: 连接回读不一致`);
  assert.deepEqual(actual.settings, before.settings, `${before.id}: settings 回读不一致`);
  assert.deepEqual(actual.staticData, before.staticData, `${before.id}: staticData 回读不一致`);
  assert.notEqual(actual.versionId, before.versionId, `${before.id}: versionId 未变化`);
  if (actual.active) assert.equal(actual.activeVersionId, actual.versionId, `${before.id}: 新版本未发布`);
  assertJimengGlobalConfigWorkflow(actual);
}

export async function deployJimengGlobalConfig({
  apiUrl,
  apiKey,
  expectedVersions,
  expectedActiveVersions = {},
  backupDirectory,
  apply = false,
  request = fetch,
}) {
  assert.ok(apiUrl && apiKey, 'N8N_API_URL and N8N_API_KEY are required');
  const base = apiUrl.replace(/\/$/, '').replace(/\/api\/v1$/, '') + '/api/v1';
  const api = async (route, method = 'GET', body) => {
    const response = await request(base + route, {
      method,
      redirect: 'error',
      headers: {
        'X-N8N-API-KEY': apiKey,
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(60_000),
    });
    const text = await response.text();
    assert.ok(response.ok, `n8n ${method} ${route}: HTTP ${response.status} ${text.slice(0, 400)}`);
    return text ? JSON.parse(text) : null;
  };

  const globalWorkflow = await api(`/workflows/${globalWorkflowId}`);
  assert.equal(globalWorkflow.versionId, expectedVersions[globalWorkflowId], 'Global Constants 工作流版本漂移');
  assert.equal(globalWorkflow.active, false, 'G01 配置工作流不应被激活');
  const globalNodeTemplate = globalWorkflow.nodes.find((node) => node.id === globalNodeId);
  assert.equal(globalNodeTemplate?.name, 'Global Constants', '未找到指定 Global Constants 节点');
  assert.equal(globalNodeTemplate?.type, 'n8n-nodes-globals.globalConstants');
  assert.equal(globalNodeTemplate?.credentials?.globalConstantsApi?.name, 'modelProvider');

  const e003 = await api(`/workflows/${e003Id}`);
  assert.equal(e003.versionId, expectedVersions[e003Id], 'E003 版本漂移');
  assert.equal(e003.activeVersionId, expectedActiveVersions[e003Id] || e003.versionId, 'E003 发布版本漂移');

  const plans = [];
  for (const id of patchOrder) {
    const before = await api(`/workflows/${id}`);
    assert.equal(before.versionId, expectedVersions[id], `${id}: expected version drift`);
    assert.equal(before.activeVersionId, expectedActiveVersions[id] || before.versionId, `${id}: active version drift`);
    const after = patchJimengGlobalConfigWorkflow(before, globalNodeTemplate);
    assertPatchScope(before, after);
    plans.push({ id, before, after, changedNodes: changedNodeNames(before, after) });
  }

  const summary = {
    dryRun: !apply,
    globalConstants: {
      workflowId: globalWorkflowId,
      workflowVersionId: globalWorkflow.versionId,
      nodeId: globalNodeId,
      credentialName: globalNodeTemplate.credentials.globalConstantsApi.name,
    },
    workflows: plans.map(({ id, before, changedNodes }) => ({
      id,
      name: before.name,
      active: before.active,
      beforeVersionId: before.versionId,
      beforeActiveVersionId: before.activeVersionId,
      changed: changedNodes.length > 0,
      changedNodes,
    })),
    e003: { id: e003.id, versionId: e003.versionId, activeVersionId: e003.activeVersionId, changed: false },
  };
  if (!apply) return summary;

  assert.ok(path.isAbsolute(backupDirectory), '必须提供仓库外绝对备份目录');
  const relative = path.relative(projectRoot, backupDirectory);
  assert.ok(relative.startsWith('..') || path.isAbsolute(relative), '备份目录不得位于 Git 仓库内');
  await mkdir(backupDirectory, { recursive: false, mode: 0o700 });
  await writeFile(path.join(backupDirectory, `${globalWorkflowId}.before.json`), JSON.stringify(globalWorkflow, null, 2), { flag: 'wx', mode: 0o600 });
  await writeFile(path.join(backupDirectory, `${e003Id}.before.json`), JSON.stringify(e003, null, 2), { flag: 'wx', mode: 0o600 });
  for (const plan of plans) {
    await writeFile(path.join(backupDirectory, `${plan.id}.before.json`), JSON.stringify(plan.before, null, 2), { flag: 'wx', mode: 0o600 });
  }

  const updated = [];
  try {
    for (const plan of plans.filter(({ changedNodes }) => changedNodes.length > 0)) {
      const fresh = await api(`/workflows/${plan.id}`);
      assert.deepEqual(fresh, plan.before, `${plan.id}: 备份后线上定义发生变化`);
      const running = await api(`/executions?workflowId=${plan.id}&status=running&limit=100`);
      assert.ok(Array.isArray(running.data) && running.data.length === 0 && !running.nextCursor, `${plan.id}: 存在运行中执行，拒绝更新`);
      await api(`/workflows/${plan.id}`, 'PUT', updatePayload(plan.after));
      const saved = await api(`/workflows/${plan.id}`);
      assertReadback(plan.before, plan.after, saved);
      await writeFile(path.join(backupDirectory, `${plan.id}.after.json`), JSON.stringify(saved, null, 2), { flag: 'wx', mode: 0o600 });
      updated.push({ ...plan, saved });
      await writeFile(path.join(backupDirectory, 'result.json'), JSON.stringify({
        workflows: updated.map(({ id, before, saved: current, changedNodes }) => ({
          id,
          beforeVersionId: before.versionId,
          versionId: current.versionId,
          active: current.active,
          activeVersionId: current.activeVersionId,
          changedNodes,
        })),
        e003: summary.e003,
      }, null, 2), { mode: 0o600 });
    }
  } catch (error) {
    const rollbackErrors = [];
    for (const plan of [...updated].reverse()) {
      try {
        await api(`/workflows/${plan.id}`, 'PUT', updatePayload(plan.before));
        const restored = await api(`/workflows/${plan.id}`);
        assert.deepEqual(restored.nodes, plan.before.nodes);
        assert.deepEqual(restored.connections, plan.before.connections);
        assert.equal(restored.active, plan.before.active);
      } catch (rollbackError) {
        rollbackErrors.push(`${plan.id}: ${rollbackError?.message || rollbackError}`);
      }
    }
    const recovery = rollbackErrors.length
      ? `；回滚失败：${rollbackErrors.join('; ')}`
      : updated.length ? '；已回滚本次已更新工作流' : '；未写入任何工作流';
    throw new Error(`${error?.message || error}${recovery}`);
  }

  const e003Readback = await api(`/workflows/${e003Id}`);
  assert.deepEqual(e003Readback, e003, 'E003 在本次发布中发生了意外变化');
  return {
    backupDirectory,
    globalConstants: summary.globalConstants,
    workflows: plans.map(({ id, before, changedNodes }) => {
      const saved = updated.find((item) => item.id === id)?.saved || before;
      return {
        id,
        name: saved.name,
        beforeVersionId: before.versionId,
        versionId: saved.versionId,
        active: saved.active,
        activeVersionId: saved.activeVersionId,
        changed: changedNodes.length > 0,
        changedNodes,
      };
    }),
    e003: summary.e003,
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values, expectedVersions, expectedActiveVersions } = parseArguments(process.argv.slice(2));
  try {
    const result = await deployJimengGlobalConfig({
      apiUrl: process.env.N8N_API_URL || 'http://127.0.0.1:5678',
      apiKey: process.env.N8N_API_KEY,
      expectedVersions,
      expectedActiveVersions,
      backupDirectory: values.get('backup-dir'),
      apply: values.get('apply') === 'true',
    });
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
