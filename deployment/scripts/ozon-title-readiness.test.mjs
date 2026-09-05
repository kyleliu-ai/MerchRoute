import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import { patchOzonTitleV4, TITLE_POLICY_NODES } from '../n8n/patches/ozon-title-v4.mjs';
import { validateOzonTitle, OZON_EXECUTABLE_CONTENT_POLICY_VERSIONS } from '../../packages/shared/dist/index.js';

const definition = JSON.parse(fs.readFileSync(new URL('../n8n/workflows/ozon/HDh0ZNLK2ps5qasR.json', import.meta.url), 'utf8'));
function run(name, input, request = {}, initial = {}) {
  const source = definition.nodes.find(node => node.name === name).parameters.jsCode;
  return vm.runInNewContext(`(function(){${source}\n})()`, {
    $input: { first: () => ({ json: input }) },
    $: name => ({ first: () => ({ json: name === 'Validate Translation Request' ? request : initial }) })
  }, { timeout: 1000 })[0].json;
}

test('T001 deployment is already patched; the live patch changes only the three policy nodes', () => {
  assert.deepEqual(patchOzonTitleV4(definition), definition);
  const legacy = structuredClone(definition);
  for (const node of legacy.nodes.filter(node => TITLE_POLICY_NODES.includes(node.name))) {
    node.parameters.jsCode = node.parameters.jsCode
      .replace(",'merchroute-ozon-content-v4'", '')
      .replace("contentPolicyVersion === 'merchroute-ozon-content-v2' ? titleImitationV2 : titleImitationV3",
        "contentPolicyVersion === 'merchroute-ozon-content-v3' ? titleImitationV3 : titleImitationV2");
  }
  assert.deepEqual(patchOzonTitleV4(legacy), definition);
  legacy.nodes.find(node => node.name === TITLE_POLICY_NODES[0]).parameters.jsCode = 'return []';
  assert.throws(() => patchOzonTitleV4(legacy), /policy guard drift/);
});

for (const policy of OZON_EXECUTABLE_CONTENT_POLICY_VERSIONS) {
  test(`T001 accepts and preserves ${policy} without weakening title checks`, () => {
    const request = run('Validate Translation Request', { body: {
      content: '女士手提包', language: '俄文', maxLength: 200, requestId: 'same-task', contentPolicyVersion: policy
    } });
    assert.equal(request.contentPolicyVersion, policy);
    for (const title of [
      'Сумка женская', 'Сумка с аналогичным узором', 'Сумка аналог бренда', 'Сумка реплика',
      'сумка', 'Сумка 😀', 'Сумка 中文', 'Сумка\nновая', 'Сумка\\nновая',
      'Сумка скидка', 'Сумка 100 руб', 'Сумка www.example.com', 'Сумка [новая]',
      'Сумка\u200b', 'Сумка сумка сумка', 'Сумка ' + 'а'.repeat(28)
    ]) {
      const expected = validateOzonTitle(title, policy);
      for (const node of TITLE_POLICY_NODES.slice(1)) {
        const invoke = () => run(node, { messageContent: JSON.stringify({ contentTranslate: title }) }, request);
        if (expected.valid) {
          assert.equal(invoke().contentTranslate, title);
          assert.equal(invoke().contentPolicyVersion, policy);
        } else assert.throws(invoke, /OUTPUT_INVALID/, `${policy}: ${node}: ${title}`);
      }
    }
  });
}

test('missing/future policy and invalid JSON still fail; shortening remains single pass', () => {
  for (const policy of [undefined, '', 'merchroute-ozon-content-v99']) {
    assert.throws(() => run('Validate Translation Request', { body: {
      content: '包', language: '俄文', maxLength: 200, contentPolicyVersion: policy
    } }), /VALIDATION_ERROR/);
  }
  const request = { contentPolicyVersion: 'merchroute-ozon-content-v4', maxLength: 10 };
  const initial = run('Parse Initial Translation', { messageContent: '{"contentTranslate":"Сумка женская"}' }, request);
  assert.equal(initial.needsShortening, true);
  const shortening = run('Build Single Shortening Request', initial, request);
  assert.equal(shortening.shorteningAttempted, true);
  assert.throws(() => run('Build Single Shortening Request', shortening, request), /OUTPUT_INVALID/);
  assert.throws(() => run('Parse Shortened Translation', { messageContent: '{"contentTranslate":"Сумка женская"}' }, request, initial), /OUTPUT_INVALID/);
  assert.equal(run('Parse Shortened Translation', { messageContent: '{"contentTranslate":"Сумка"}' }, request, initial).contentTranslate, 'Сумка');
  for (const raw of ['not json', '{}', '{"contentTranslate":"Сумка","extra":true}']) {
    assert.throws(() => run('Parse Initial Translation', { messageContent: raw }, request), /OUTPUT_INVALID/);
  }
});
