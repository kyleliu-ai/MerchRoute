import assert from 'node:assert/strict';
import fs from 'node:fs';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { deployOzonContentV4 } from '../n8n/scripts/update-ozon-content-v4-live.mjs';
import { POLICY_NODES, DIRECTORY_FAILURE_NODE } from '../n8n/patches/ozon-content-v4.mjs';

function fixture() {
  const ids = Object.keys(POLICY_NODES);
  const definitions = new Map(ids.map((id, index) => {
    const workflow = JSON.parse(fs.readFileSync(new URL(`../n8n/workflows/ozon/${id}.json`, import.meta.url), 'utf8'));
    workflow.versionId = `before-${id}`;
    workflow.active = index === 0; // Inactive workflows must never be activated by this patch.
    workflow.activeVersionId = workflow.active ? workflow.versionId : null;
    workflow.staticData = { preserved: true };
    workflow.settings.binaryMode = 'separate';
    for (const node of workflow.nodes.filter(node => POLICY_NODES[id].includes(node.name))) {
      node.parameters.jsCode = node.parameters.jsCode.replace(",'merchroute-ozon-content-v4'", '')
        .replace("new Error(code + ': ' + message)", 'new Error(message)');
    }
    if (id === 'g3KK68BLXX7eShqa') {
      const node = workflow.nodes.find(node => node.name === DIRECTORY_FAILURE_NODE);
      const start = node.parameters.jsCode.indexOf('  const contractFailureCodes =');
      const end = node.parameters.jsCode.indexOf('  const previous =', start);
      assert.ok(start >= 0 && end > start);
      node.parameters.jsCode = (node.parameters.jsCode.slice(0, start)
        + '  const permanent = /签名冲突|marker.*冲突|逃逸|符号链接|身份或版本无效|多个匹配|同时存在/i.test(message);\n'
        + node.parameters.jsCode.slice(end)).replace("(contractCode || 'OZON_DIRECTORY_CLAIM_REJECTED')", "'OZON_DIRECTORY_CLAIM_REJECTED'");
    }
    return [id, workflow];
  }));
  const writes = [];
  let busy = false;
  const expectedVersions = Object.fromEntries(ids.map(id => [id, definitions.get(id).versionId]));
  const request = async (url, options) => {
    const endpoint = new URL(url);
    if (endpoint.pathname.endsWith('/executions')) return Response.json({ data: busy ? [{ id: 'running' }] : [], nextCursor: null });
    const id = endpoint.pathname.split('/').at(-1);
    assert.ok(definitions.has(id));
    if (options.method === 'PUT') {
      writes.push(id);
      const old = definitions.get(id), body = JSON.parse(options.body);
      assert.equal(body.active, undefined);
      definitions.set(id, { ...old, ...body, settings: { ...old.settings, ...body.settings },
        versionId: `after-${id}`, activeVersionId: old.active ? `after-${id}` : null });
    } else assert.equal(options.method, 'GET');
    return Response.json(definitions.get(id));
  };
  return { definitions, writes, expectedVersions, request, setBusy: () => { busy = true; } };
}

test('controlled deployment is read-only by default and refuses expected-version drift', async () => {
  const f = fixture();
  const options = { ...f, apiUrl: 'http://n8n.invalid', apiKey: 'synthetic' };
  const plan = await deployOzonContentV4(options);
  assert.equal(plan.dryRun, true);
  assert.deepEqual(plan.workflows.find(workflow => workflow.id === '0FqozLuQ7vuabT8V').changedNodes.sort(), [...POLICY_NODES['0FqozLuQ7vuabT8V']].sort());
  assert.ok(plan.workflows.find(workflow => workflow.id === 'g3KK68BLXX7eShqa').changedNodes.includes(DIRECTORY_FAILURE_NODE));
  assert.equal(f.writes.length, 0);
  await assert.rejects(() => deployOzonContentV4({ ...options, expectedVersions: {} }), /version drift/);
  assert.equal(f.writes.length, 0);
});

test('S000 expected-version and node drift stop the entire upgrade before any write', async () => {
  const f = fixture();
  const options = { ...f, apiUrl: 'http://n8n.invalid', apiKey: 'synthetic', apply: true };
  const expectedVersions = { ...f.expectedVersions }; delete expectedVersions['0FqozLuQ7vuabT8V'];
  await assert.rejects(() => deployOzonContentV4({ ...options, expectedVersions }), /0FqozLuQ7vuabT8V: expected version drift/);
  f.definitions.get('0FqozLuQ7vuabT8V').nodes.find(node => node.name === '准备后端 intake 验证').parameters.jsCode = 'return [];';
  await assert.rejects(() => deployOzonContentV4(options), /guard drift/);
  assert.equal(f.writes.length, 0);
});

test('all backups precede writes; active versions are read back and inactive definitions stay inactive', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'ozon-v4-deploy-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const backupDirectory = path.join(directory, 'backup');
  const f = fixture();
  const request = async (url, options) => {
    if (options.method === 'PUT') assert.equal((await readdir(backupDirectory)).filter(name => name.endsWith('.before.json')).length, 4);
    return f.request(url, options);
  };
  const result = await deployOzonContentV4({ ...f, request, apiUrl: 'http://n8n.invalid/api/v1', apiKey: 'synthetic', backupDirectory, apply: true });
  assert.deepEqual(f.writes, ['0FqozLuQ7vuabT8V', 'stSK51IuxrMZlLjx', 'g3KK68BLXX7eShqa', 'HDh0ZNLK2ps5qasR']);
  assert.deepEqual(result.workflows.map(workflow => workflow.active), [false, false, false, true]);
  assert.equal((await readdir(backupDirectory)).length, 9);
});

test('running executions block all mutation but leave recoverable backups', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'ozon-v4-busy-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const f = fixture();
  f.setBusy();
  await assert.rejects(() => deployOzonContentV4({ ...f, apiUrl: 'http://n8n.invalid', apiKey: 'synthetic',
    backupDirectory: path.join(directory, 'backup'), apply: true }), /running execution/);
  assert.equal(f.writes.length, 0);
});
