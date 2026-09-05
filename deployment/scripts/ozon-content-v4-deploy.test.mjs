import assert from 'node:assert/strict';
import fs from 'node:fs';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { deployOzonContentV4 } from '../n8n/scripts/update-ozon-content-v4-live.mjs';
import { POLICY_NODES } from '../n8n/patches/ozon-content-v4.mjs';

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
      node.parameters.jsCode = node.parameters.jsCode.replace(",'merchroute-ozon-content-v4'", '');
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
  assert.equal((await deployOzonContentV4(options)).dryRun, true);
  assert.equal(f.writes.length, 0);
  await assert.rejects(() => deployOzonContentV4({ ...options, expectedVersions: {} }), /version drift/);
  assert.equal(f.writes.length, 0);
});

test('all backups precede writes; active versions are read back and inactive definitions stay inactive', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'ozon-v4-deploy-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const backupDirectory = path.join(directory, 'backup');
  const f = fixture();
  const request = async (url, options) => {
    if (options.method === 'PUT') assert.equal((await readdir(backupDirectory)).filter(name => name.endsWith('.before.json')).length, 3);
    return f.request(url, options);
  };
  const result = await deployOzonContentV4({ ...f, request, apiUrl: 'http://n8n.invalid/api/v1', apiKey: 'synthetic', backupDirectory, apply: true });
  assert.equal(f.writes.length, 3);
  assert.deepEqual(result.workflows.map(workflow => workflow.active), [false, false, true]);
  assert.equal((await readdir(backupDirectory)).length, 7);
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
