import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { WORKFLOWS } from '../n8n/catalog.mjs';
import { findRuntimeEndpointContractViolations, normalizeMerchRouteRuntimeUrls } from '../n8n/security.mjs';

const root = path.resolve(import.meta.dirname, '../..');

test('36 个受控工作流不固定 4173，Runtime Base URL 缺失时发送前失败', async () => {
  assert.equal(WORKFLOWS.length, 36);
  for (const entry of WORKFLOWS) {
    const workflow = JSON.parse(await readFile(path.join(root, 'deployment', 'n8n', 'workflows', entry.category, `${entry.id}.json`), 'utf8'));
    assert.deepEqual(findRuntimeEndpointContractViolations(workflow), [], entry.id);
  }
});

test('规范化只改参数字符串，不改节点 ID、连接、凭据和 active', () => {
  const workflow = {
    id: 'fixture', active: true,
    nodes: [{ id: 'node-41737', credentials: { httpHeaderAuth: { id: 'credential-id' } }, parameters: {
      url: 'http://127.0.0.1:4173/api/v1/health', jsCode: "return [{json:{url:'http://127.0.0.1:4173/api/v1/test'}}];"
    }}], connections: { A: { main: [[{ node: 'B', type: 'main', index: 0 }]] } }, settings: {}
  };
  const normalized = normalizeMerchRouteRuntimeUrls(workflow);
  assert.equal(normalized.active, true);
  assert.equal(normalized.nodes[0].id, workflow.nodes[0].id);
  assert.deepEqual(normalized.nodes[0].credentials, workflow.nodes[0].credentials);
  assert.deepEqual(normalized.connections, workflow.connections);
  assert.deepEqual(findRuntimeEndpointContractViolations(normalized), []);
});
