import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  S013_WORKFLOW_ID,
  assertS013LanguagePolicyWorkflow,
  changedNodeNames,
  patchS013LanguagePolicyWorkflow,
} from '../patches/s013-language-policy-v1.mjs';

const E003_WORKFLOW_ID = 's0lQIcv1ZCgEzGlB';
const S011_WORKFLOW_ID = 'KtjTu0u08rZJNtyM';
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDir, '..', '..', '..');
const args = new Map(process.argv.slice(2).map((item) => {
  const [key, ...rest] = item.replace(/^--/, '').split('=');
  return [key, rest.length ? rest.join('=') : 'true'];
}));
const apply = args.get('apply') === 'true';
const apiUrl = String(process.env.N8N_API_URL || 'http://127.0.0.1:5678').replace(/\/$/, '');
const apiKey = String(process.env.N8N_API_KEY || '').trim();
const expectedVersion = String(args.get('expected-version') || '').trim();
const expectedE003Version = String(args.get('expected-e003-version') || '').trim();
const expectedS011Version = String(args.get('expected-s011-version') || '').trim();
const backupDirectory = String(args.get('backup-dir') || '').trim();

assert.ok(apiKey, '缺少 N8N_API_KEY');
assert.ok(expectedVersion, '缺少 --expected-version');
assert.ok(expectedE003Version, '缺少 --expected-e003-version');
assert.ok(expectedS011Version, '缺少 --expected-s011-version');
if (apply) {
  assert.ok(path.isAbsolute(backupDirectory), '--apply 必须提供仓库外绝对 --backup-dir');
  const relative = path.relative(projectRoot, backupDirectory);
  assert.ok(relative.startsWith('..') || path.isAbsolute(relative), '备份目录不得位于 Git 仓库内');
}

const digest = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

async function api(method, route, body) {
  const response = await fetch(`${apiUrl}/api/v1${route}`, {
    method,
    redirect: 'error',
    headers: {
      'X-N8N-API-KEY': apiKey,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(60_000),
  });
  const text = await response.text();
  assert.ok(response.ok, `n8n ${method} ${route}: HTTP ${response.status} ${text.slice(0, 400)}`);
  return text ? JSON.parse(text) : null;
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

function assertPatchScope(before, after) {
  assert.equal(after.id, before.id);
  assert.equal(after.name, before.name);
  assert.equal(after.active, before.active);
  assert.deepEqual(after.settings, before.settings);
  assert.deepEqual(after.staticData, before.staticData);
  assert.equal(after.nodes.length, before.nodes.length + 5);
  assert.deepEqual(changedNodeNames(before, after), [
    'Apply and Validate Title Correction',
    'Build Controlled Title Correction',
    'Emit Validated Qwen Output',
    'HTTP Request Title Correction',
    'Needs Title Language Correction',
    'Parse Qwen JSON Output',
    'User Input Prepare',
    'sysPrompt',
  ]);
  for (const beforeNode of before.nodes) {
    const afterNode = after.nodes.find((node) => node.id === beforeNode.id);
    assert.ok(afterNode, `${before.id}/${beforeNode.name} 节点丢失`);
    assert.equal(afterNode.name, beforeNode.name, `${before.id}/${beforeNode.name} 节点重命名`);
    assert.equal(afterNode.type, beforeNode.type, `${before.id}/${beforeNode.name} 节点类型改变`);
    assert.deepEqual(afterNode.credentials, beforeNode.credentials, `${before.id}/${beforeNode.name} 凭据绑定改变`);
  }
  for (const [name, connections] of Object.entries(before.connections || {})) {
    if (name !== 'Parse Qwen JSON Output') assert.deepEqual(after.connections[name], connections, `${before.id}/${name} 原连接发生变化`);
  }
  assertS013LanguagePolicyWorkflow(after);
}

function assertReadback(before, expected, actual) {
  assert.equal(actual.id, before.id);
  assert.equal(actual.name, before.name);
  assert.equal(actual.active, before.active, 'S013 active 状态改变');
  assert.deepEqual(actual.nodes, expected.nodes, 'S013 节点回读不一致');
  assert.deepEqual(actual.connections, expected.connections, 'S013 连接回读不一致');
  assert.deepEqual(actual.settings, before.settings, 'S013 settings 回读不一致');
  assert.deepEqual(actual.staticData, before.staticData, 'S013 staticData 回读不一致');
  assert.notEqual(actual.versionId, before.versionId, 'S013 versionId 未变化');
  if (actual.active) assert.equal(actual.activeVersionId, actual.versionId, 'S013 新版本未成为 activeVersionId');
  assertS013LanguagePolicyWorkflow(actual);
}

const [before, e003Before, s011Before] = await Promise.all([
  api('GET', `/workflows/${S013_WORKFLOW_ID}`),
  api('GET', `/workflows/${E003_WORKFLOW_ID}`),
  api('GET', `/workflows/${S011_WORKFLOW_ID}`),
]);

assert.equal(before.versionId, expectedVersion, 'S013 版本漂移');
assert.equal(before.activeVersionId, expectedVersion, 'S013 activeVersionId 漂移');
assert.equal(e003Before.versionId, expectedE003Version, 'E003 版本漂移');
assert.equal(s011Before.versionId, expectedS011Version, 'S011 版本漂移');

const patched = patchS013LanguagePolicyWorkflow(before);
assertPatchScope(before, patched);

const summary = {
  apply,
  workflow: {
    id: before.id,
    name: before.name,
    active: before.active,
    beforeVersionId: before.versionId,
    beforeActiveVersionId: before.activeVersionId,
    beforeDigest: digest(updatePayload(before)),
    patchedDigest: digest(updatePayload(patched)),
    changedNodes: changedNodeNames(before, patched),
    nodeCountBefore: before.nodes.length,
    nodeCountAfter: patched.nodes.length,
  },
  unchangedBaselines: {
    E003: { id: e003Before.id, versionId: e003Before.versionId, activeVersionId: e003Before.activeVersionId },
    S011: { id: s011Before.id, versionId: s011Before.versionId, activeVersionId: s011Before.activeVersionId },
  },
};

if (!apply) {
  console.log(JSON.stringify(summary, null, 2));
  process.exit(0);
}

await mkdir(backupDirectory, { recursive: false, mode: 0o700 });
await writeFile(path.join(backupDirectory, `${S013_WORKFLOW_ID}.before.json`), `${JSON.stringify(before, null, 2)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
await writeFile(path.join(backupDirectory, 'unchanged-baselines.json'), `${JSON.stringify(summary.unchangedBaselines, null, 2)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });

let saved;
try {
  const [fresh, e003Fresh, s011Fresh, running] = await Promise.all([
    api('GET', `/workflows/${S013_WORKFLOW_ID}`),
    api('GET', `/workflows/${E003_WORKFLOW_ID}`),
    api('GET', `/workflows/${S011_WORKFLOW_ID}`),
    api('GET', `/executions?workflowId=${S013_WORKFLOW_ID}&status=running&limit=100`),
  ]);
  assert.deepEqual(fresh, before, '备份后 S013 在线定义发生变化');
  assert.deepEqual(e003Fresh, e003Before, '备份后 E003 在线定义发生变化');
  assert.deepEqual(s011Fresh, s011Before, '备份后 S011 在线定义发生变化');
  assert.ok(Array.isArray(running.data) && running.data.length === 0 && !running.nextCursor, 'S013 存在运行中执行，拒绝更新');

  await api('PUT', `/workflows/${S013_WORKFLOW_ID}`, updatePayload(patched));
  saved = await api('GET', `/workflows/${S013_WORKFLOW_ID}`);
  assertReadback(before, patched, saved);

  const [e003After, s011After] = await Promise.all([
    api('GET', `/workflows/${E003_WORKFLOW_ID}`),
    api('GET', `/workflows/${S011_WORKFLOW_ID}`),
  ]);
  assert.deepEqual(e003After, e003Before, 'E003 在本次发布中发生意外变化');
  assert.deepEqual(s011After, s011Before, 'S011 在本次发布中发生意外变化');
} catch (error) {
  if (saved) {
    try {
      await api('PUT', `/workflows/${S013_WORKFLOW_ID}`, updatePayload(before));
      const restored = await api('GET', `/workflows/${S013_WORKFLOW_ID}`);
      assert.deepEqual(restored.nodes, before.nodes);
      assert.deepEqual(restored.connections, before.connections);
      assert.equal(restored.active, before.active);
      throw new Error(`${error.message}；已将 S013 定义回滚至修改前内容`);
    } catch (rollbackError) {
      if (rollbackError.message.endsWith('已将 S013 定义回滚至修改前内容')) throw rollbackError;
      throw new Error(`${error.message}；S013 自动回滚失败：${rollbackError.message}`);
    }
  }
  throw error;
}

await writeFile(path.join(backupDirectory, `${S013_WORKFLOW_ID}.after.json`), `${JSON.stringify(saved, null, 2)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
const result = {
  ...summary,
  backupDirectory,
  workflow: {
    ...summary.workflow,
    versionId: saved.versionId,
    activeVersionId: saved.activeVersionId,
    updatedAt: saved.updatedAt,
    readbackDigest: digest(updatePayload(saved)),
  },
};
await writeFile(path.join(backupDirectory, 'result.json'), `${JSON.stringify(result, null, 2)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
console.log(JSON.stringify(result, null, 2));
