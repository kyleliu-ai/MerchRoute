import assert from 'node:assert/strict';
import { mkdir, writeFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { patchOzonContentV4, PATCH_NODES } from '../patches/ozon-content-v4.mjs';

const root = path.resolve(import.meta.dirname, '../../..');
// Downstream first, so accepting v4 titles cannot expose an unpatched submit/readback step.
const ids = ['0FqozLuQ7vuabT8V', 'stSK51IuxrMZlLjx', 'g3KK68BLXX7eShqa', 'HDh0ZNLK2ps5qasR'];
const allowedSettings = new Set(['saveExecutionProgress', 'saveManualExecutions', 'saveDataErrorExecution',
  'saveDataSuccessExecution', 'executionTimeout', 'errorWorkflow', 'timezone', 'executionOrder', 'callerPolicy',
  'callerIds', 'timeSavedPerExecution', 'redactionPolicy', 'availableInMCP']);

export async function deployOzonContentV4({ apiUrl, apiKey, expectedVersions, backupDirectory, apply = false, request = fetch }) {
  assert.ok(apiKey && apiUrl, 'N8N_API_URL and N8N_API_KEY are required');
  const base = apiUrl.replace(/\/$/, '').replace(/\/api\/v1$/, '') + '/api/v1';
  const api = async (route, method = 'GET', body) => {
    const response = await request(base + route, { method, redirect: 'error',
      headers: { 'X-N8N-API-KEY': apiKey, ...(body ? { 'content-type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(30_000) });
    assert.ok(response.ok, `n8n ${method} ${route}: HTTP ${response.status}; do not blindly replay mutations`);
    return response.json();
  };
  const plans = [];
  for (const id of ids) {
    const before = await api(`/workflows/${id}`);
    assert.equal(before.versionId, expectedVersions[id], `${id}: expected version drift`);
    if (before.active) assert.equal(before.activeVersionId, before.versionId, `${id}: unpublished draft exists`);
    const after = patchOzonContentV4(before);
    const changes = after.nodes.filter((node, index) => JSON.stringify(node) !== JSON.stringify(before.nodes[index])).map(node => node.name);
    assert.ok(changes.every(name => PATCH_NODES[id].includes(name)));
    const names = new Set(after.nodes.map(node => node.name));
    for (const [name, outputs] of Object.entries(after.connections)) {
      assert.ok(names.has(name));
      for (const edges of Object.values(outputs)) for (const branch of edges) for (const edge of branch) assert.ok(names.has(edge.node));
    }
    const settings = { ...before.settings };
    delete settings.binaryMode; // Server-managed, not accepted by the public API PUT schema.
    assert.ok(Object.keys(settings).every(key => allowedSettings.has(key)), `${id}: unknown settings; refusing to discard them`);
    plans.push({ id, before, after, changes, settings });
  }
  const summary = plans.map(({ id, before, changes }) => ({ id, beforeVersionId: before.versionId, active: before.active, changedNodes: changes }));
  if (!apply) return { dryRun: true, workflows: summary };
  assert.ok(path.isAbsolute(backupDirectory), 'An absolute external backup directory is required');
  const relative = path.relative(root, backupDirectory);
  assert.ok(relative.startsWith('..') || path.isAbsolute(relative), 'Backups must be outside the repository');
  const parent = await realpath(path.dirname(backupDirectory));
  const resolvedRelative = path.relative(await realpath(root), parent);
  assert.ok(resolvedRelative.startsWith('..') || path.isAbsolute(resolvedRelative), 'Backup parent resolves into repository');
  await mkdir(backupDirectory, { mode: 0o700 }); // Must be new; never overwrite a previous recovery point.
  // Back up ALL definitions before the first mutation.
  for (const plan of plans) await writeFile(path.join(backupDirectory, `${plan.id}.before.json`), JSON.stringify(plan.before, null, 2), { flag: 'wx', mode: 0o600 });
  const results = [];
  for (const plan of plans) {
    const fresh = await api(`/workflows/${plan.id}`);
    assert.deepEqual(fresh, plan.before, `${plan.id}: live definition changed after backup`);
    const running = await api(`/executions?workflowId=${plan.id}&status=running&limit=100`);
    assert.ok(Array.isArray(running.data) && running.data.length === 0 && !running.nextCursor, `${plan.id}: running execution; retry later`);
    if (!plan.changes.length) { results.push({ id: plan.id, versionId: fresh.versionId, active: fresh.active, changed: false }); continue; }
    await api(`/workflows/${plan.id}`, 'PUT', {
      name: plan.before.name, nodes: plan.after.nodes, connections: plan.before.connections, settings: plan.settings
    });
    const saved = await api(`/workflows/${plan.id}`);
    assert.deepEqual(saved.nodes, plan.after.nodes, `${plan.id}: node readback mismatch`);
    assert.deepEqual(saved.connections, plan.before.connections, `${plan.id}: connection readback mismatch`);
    assert.deepEqual(saved.settings, plan.before.settings, `${plan.id}: settings readback mismatch`);
    assert.deepEqual(saved.staticData, plan.before.staticData, `${plan.id}: static data readback mismatch`);
    assert.equal(saved.active, plan.before.active, `${plan.id}: active state changed`);
    assert.notEqual(saved.versionId, plan.before.versionId);
    // Current n8n public PUT publishes an already-active workflow atomically.
    // Verify it rather than creating an unnecessary deactivate/404 window.
    if (saved.active) assert.equal(saved.activeVersionId, saved.versionId, `${plan.id}: new version not published`);
    await writeFile(path.join(backupDirectory, `${plan.id}.after.json`), JSON.stringify(saved, null, 2), { flag: 'wx', mode: 0o600 });
    results.push({ id: plan.id, beforeVersionId: plan.before.versionId, versionId: saved.versionId, active: saved.active, changedNodes: plan.changes });
    await writeFile(path.join(backupDirectory, 'result.json'), JSON.stringify({ workflows: results }, null, 2), { mode: 0o600 });
  }
  return { backupDirectory, workflows: results };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const expectedVersions = Object.fromEntries(args.filter(arg => arg.startsWith('--expected=')).map(arg => arg.slice(11).split(':')));
  const backupDirectory = args.find(arg => arg.startsWith('--backup-dir='))?.slice(13);
  try {
    console.log(JSON.stringify(await deployOzonContentV4({ apiUrl: process.env.N8N_API_URL, apiKey: process.env.N8N_API_KEY,
      expectedVersions, backupDirectory, apply: args.includes('--apply') }), null, 2));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
