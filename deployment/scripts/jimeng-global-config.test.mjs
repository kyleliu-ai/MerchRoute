import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import {
  assertJimengGlobalConfigWorkflow,
  jimengEndpoint,
  patchJimengGlobalConfigWorkflow,
  validateJimengConstants,
} from '../n8n/patches/jimeng-global-config-v1.mjs';

const root = path.resolve(import.meta.dirname, '..');
const workflowRoot = path.join(root, 'n8n', 'workflows', 'core');
const ids = ['Wxng7hVbjMNhVOaO', 'HpCtxAZJdy9RgWk2', 'ieWnRGeC7KdeS1GT'];
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const globalNodeTemplate = {
  parameters: {},
  type: 'n8n-nodes-globals.globalConstants',
  typeVersion: 1,
  name: 'Global Constants',
  credentials: { globalConstantsApi: { id: 'fixture', name: 'modelProvider' } },
};

const constants = {
  model: { jimengModel: 'jimeng-4.7' },
  BaseUrl: { JimengUrl: 'http://localhost:8000/' },
  Authorization: { jimengAuthorValue: 'Bearer fixture-value' },
};

test('Global Constants contract preserves model, URL root, and exact Authorization value', () => {
  assert.deepEqual(validateJimengConstants(constants), {
    jimengModel: 'jimeng-4.7',
    jimengUrl: 'http://localhost:8000',
    jimengAuthorValue: 'Bearer fixture-value',
  });
  assert.equal(jimengEndpoint(constants, '/v1/images/generations'), 'http://localhost:8000/v1/images/generations');
  assert.equal(jimengEndpoint(constants, '/v1/images/tasks/batch'), 'http://localhost:8000/v1/images/tasks/batch');
  assert.equal(jimengEndpoint(constants, '/v1/images/tasks/status'), 'http://localhost:8000/v1/images/tasks/status');
});

test('Global Constants contract rejects missing fields and non-root URLs', () => {
  for (const candidate of [
    { ...constants, model: {} },
    { ...constants, BaseUrl: {} },
    { ...constants, Authorization: {} },
    { ...constants, BaseUrl: { JimengUrl: 'ftp://localhost:8000' } },
    { ...constants, BaseUrl: { JimengUrl: 'http://user:password@localhost:8000' } },
    { ...constants, BaseUrl: { JimengUrl: 'http://localhost:8000/v1/images' } },
  ]) assert.throws(() => validateJimengConstants(candidate), /CONFIG_INVALID/);
});

for (const id of ids) {
  test(`${id} uses Global Constants without hardcoded Jimeng auth, URL, or model`, async () => {
    const workflow = JSON.parse(await readFile(path.join(workflowRoot, `${id}.json`), 'utf8'));
    const alreadyPatched = workflow.nodes.some((node) => node.name === 'Global Constants');
    const patched = patchJimengGlobalConfigWorkflow(workflow, globalNodeTemplate);
    assertJimengGlobalConfigWorkflow(patched);
    assert.equal(patched.nodes.length, workflow.nodes.length + (alreadyPatched ? 0 : 1));
    assert.equal(patched.active, workflow.active);
    const source = patched.nodes.find((node) => node.name === 'Global Constants');
    if (alreadyPatched) assert.deepEqual(source.credentials, workflow.nodes.find((node) => node.name === 'Global Constants').credentials);
    else assert.equal(source.credentials.globalConstantsApi.name, 'modelProvider');
    assert.deepEqual(patchJimengGlobalConfigWorkflow(patched, globalNodeTemplate), patched);
    assert.doesNotMatch(JSON.stringify(patched.nodes), /new URL\(jimengUrl\)/);
    assert.match(JSON.stringify(patched.nodes), /const jimengUrlMatch =/);
    for (const node of patched.nodes.filter((candidate) => candidate.type === 'n8n-nodes-base.code')) {
      assert.doesNotThrow(() => new AsyncFunction(node.parameters.jsCode), `${id}/${node.name} JavaScript 语法无效`);
    }
    if (id === 'ieWnRGeC7KdeS1GT') {
      const batchCode = patched.nodes.find((node) => node.name === 'Build Async Submit Batch').parameters.jsCode;
      assert.match(batchCode, /const \{ constants: _constants, \.\.\.taskInput \} = item/);
      assert.match(batchCode, /model: jimengModel/);
      const returnCode = patched.nodes.find((node) => node.name === 'Return Image URLs').parameters.jsCode;
      assert.doesNotMatch(returnCode, /constants:/);
    }
  });
}
