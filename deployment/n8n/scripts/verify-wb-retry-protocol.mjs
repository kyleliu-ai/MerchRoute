import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { WB_RETRY_NODES, WB_RETRY_WORKFLOW_ID, patchWbPublishRetry } from '../patches/wb-publish-retry-v1.mjs';

// Reads only by default. Changing the gate requires a separate deployment authorization.
const apply = process.argv.includes('--apply');
const disable = process.argv.includes('--disable');
if (apply && !process.argv.includes('--approved')) throw new Error('--apply requires --approved for this deployment');
const base = new URL(process.env.MERCHROUTE_BASE_URL || 'http://127.0.0.1:43173');
assert.ok(['http:', 'https:'].includes(base.protocol) && base.hostname === '127.0.0.1');
const runtimeKey = process.env.MERCHROUTE_RUNTIME_KEY;
assert.ok(runtimeKey, 'MERCHROUTE_RUNTIME_KEY is required');
async function appRequest(route, body) {
  const response = await fetch(new URL(route, base), { method: body ? 'POST' : 'GET',
    headers: { 'x-merchroute-runtime-key': runtimeKey, 'content-type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(30_000) });
  assert.ok(response.ok, 'MerchRoute response: ' + response.status);
  return response.json();
}
let workflowVersionId;
if (!disable) {
  const expectedCommit = process.argv.find(arg => arg.startsWith('--expected-commit='))?.split('=')[1];
  assert.match(expectedCommit || '', /^[a-f0-9]{40}$/);
  const about = await appRequest('/api/v1/about/version');
  assert.equal(about.current.commitSha, expectedCommit, 'Running backend commit differs');
  assert.equal(about.current.dirty, false, 'An uncommitted development build cannot enable the release gate');
  const capability = await appRequest('/api/v1/wb/runtime/retry-protocol');
  assert.equal(capability.contractVersion, 1);
  const n8nBase = new URL(process.env.N8N_API_URL || 'http://127.0.0.1:5678');
  assert.ok(['http:', 'https:'].includes(n8nBase.protocol));
  assert.ok(process.env.N8N_API_KEY, 'N8N_API_KEY is required');
  const response = await fetch(new URL('/api/v1/workflows/' + WB_RETRY_WORKFLOW_ID, n8nBase), {
    headers: { 'X-N8N-API-KEY': process.env.N8N_API_KEY }, signal: AbortSignal.timeout(30_000)
  });
  assert.ok(response.ok, 'Cannot read S001');
  const live = await response.json();
  const candidate = JSON.parse(await readFile(new URL('../workflows/wb/' + WB_RETRY_WORKFLOW_ID + '.json', import.meta.url), 'utf8'));
  assert.deepEqual(patchWbPublishRetry(candidate), candidate, 'Controlled workflow lacks retry patch');
  assert.equal(live.active, true, 'S001 must already be active');
  for (const name of WB_RETRY_NODES) {
    const actual = live.nodes.find(node => node.name === name)?.parameters?.jsCode;
    const expected = candidate.nodes.find(node => node.name === name)?.parameters?.jsCode;
    assert.equal(actual?.replaceAll('\r\n', '\n'), expected?.replaceAll('\r\n', '\n'), 'S001 node differs: ' + name);
  }
  workflowVersionId = live.versionId;
  assert.match(workflowVersionId || '', /^[a-f0-9-]{36}$/i);
}
if (apply) {
  const result = await appRequest('/api/v1/wb/runtime/retry-protocol', { enabled: !disable, contractVersion: 1, workflowVersionId });
  assert.equal(result.enabled, !disable);
  console.log(JSON.stringify({ applied: true, ...result }));
} else console.log(JSON.stringify({ applied: false, enabled: !disable, workflowVersionId, message: 'Read-only verification completed' }));
