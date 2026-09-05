import assert from 'node:assert/strict';
import fs from 'node:fs';
import crypto from 'node:crypto';
import test from 'node:test';
import ts from 'typescript';
import { patchOzonContentV4, POLICY_NODES } from '../n8n/patches/ozon-content-v4.mjs';
import { validateOzonDescription } from '../../packages/shared/dist/index.js';

const load = id => JSON.parse(fs.readFileSync(new URL(`../n8n/workflows/ozon/${id}.json`, import.meta.url), 'utf8'));
function declarations(source, names) {
  const file = ts.createSourceFile('node.js', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const found = file.statements.filter(statement => ts.isVariableStatement(statement)
    && statement.declarationList.declarations.some(declaration => names.includes(declaration.name.getText(file))));
  return found.map(statement => statement.getText(file)).join('\n');
}
const common = ['cjk', 'invalidPlatformText', 'hiddenFormat', 'htmlTags', 'urlPattern', 'emailPattern',
  'contactHintPattern', 'phoneCandidatePattern', 'advertisingPattern', 'pricePattern', 'imitationPatternV2',
  'imitationPatternV3', 'imitationPattern', 'validateDescriptionHtml', 'hasKeywordStuffing', 'hasContactInformation'];

test('all OZON policy checkpoints are patched and all node JavaScript compiles', () => {
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  for (const id of Object.keys(POLICY_NODES)) {
    const workflow = load(id);
    assert.deepEqual(patchOzonContentV4(workflow), workflow);
    for (const node of workflow.nodes.filter(node => node.parameters?.jsCode)) new AsyncFunction(node.parameters.jsCode);
    for (const name of POLICY_NODES[id]) {
      assert.match(workflow.nodes.find(node => node.name === name).parameters.jsCode, /merchroute-ozon-content-v4/);
    }
  }
});

for (const policy of ['merchroute-ozon-content-v2', 'merchroute-ozon-content-v3', 'merchroute-ozon-content-v4']) {
  test(`S001 description checkpoints agree with the application's ${policy} contract`, () => {
    const workflow = load('stSK51IuxrMZlLjx');
    const fixtures = ['Сумка женская', 'Сумка с аналогичным узором', 'Сумка аналог бренда',
      'Сумка сумка сумка сумка сумка сумка сумка сумка сумка сумка',
      'Сумка\nТкань', 'Сумка\\nТкань', 'Сумка 中文', 'Сумка 😀', 'Скидка на сумку',
      'Сумка 100 руб', 'Сумка www.example.com', '<div>Сумка</div>', 'Сумка\u200b'];
    for (const value of fixtures) {
      const expected = validateOzonDescription(value, policy);
      for (const name of ['读取并校验本地媒体路径', '构建商品导入请求', '构建导入意图']) {
        const source = workflow.nodes.find(node => node.name === name).parameters.jsCode;
        const selected = declarations(source, [...common, 'normalizeDescription', 'hashText',
          'validateDescription', 'descriptionIssues', 'descriptionSubmissionByOffer']);
        const hash = text => 'sha256:' + crypto.createHash('sha256').update(text).digest('hex');
        const descriptionSubmission = { policyVersion: policy, maxLength: 6000, maxLengthSource: 'MERCHROUTE_SAFE_DEFAULT',
          byOffer: [{ offerId: 'fixture', sourceHash: hash(value), submittedHash: hash(expected.normalizedForSubmission),
            submitted: expected.normalizedForSubmission }] };
        const context = { descriptionSubmission };
        // Only pure validation declarations are executed: no filesystem/media/API nodes.
        const relevant = name === '构建商品导入请求'
          ? declarations(source, [...common, 'descriptionIssues'])
          : name === '读取并校验本地媒体路径'
            ? declarations(source, [...common, 'validateDescription']) : selected;
        const evaluator = new Function('descriptionPolicyVersion', 'descriptionMaxLength', 'descriptionMaxLengthSource',
          'value', 'offerIds', 'descriptionSourceByOffer', 'payloadByOffer', 'context', 'crypto', relevant + '\n' + (
            name === '构建商品导入请求' ? 'return descriptionIssues(value);' :
              name === '读取并校验本地媒体路径' ? 'return validateDescription(value, "fixture");' : 'return descriptionSubmissionByOffer;'
          ));
        const invoke = () => evaluator(policy, 6000, 'MERCHROUTE_SAFE_DEFAULT',
          name === '构建商品导入请求' ? expected.normalizedForSubmission : value, ['fixture'], new Map([['fixture', value]]),
          new Map([['fixture', { attributes: [{ id: 4191, values: [{ value: expected.normalizedForSubmission }] }] }]]), context, crypto);
        if (name === '构建商品导入请求') assert.equal(invoke().length === 0, expected.valid, `${policy}/${name}/${value}`);
        else if (expected.valid) assert.doesNotThrow(invoke, `${policy}/${name}/${value}`);
        else assert.throws(invoke, /合同/, `${policy}/${name}/${value}`);
      }
    }
  });
}

test('P002 v4 requires every frozen identity; mismatched and future policies remain blocked', () => {
  const workflow = load('g3KK68BLXX7eShqa');
  for (const name of POLICY_NODES.g3KK68BLXX7eShqa.slice(1)) {
    const source = workflow.nodes.find(node => node.name === name).parameters.jsCode;
    const start = source.indexOf('const descriptionPolicyVersion =');
    const end = source.indexOf('if (!supportedDescriptionPolicyVersions.has(descriptionPolicyVersion)', start);
    assert.ok(start >= 0 && end > start);
    const code = source.slice(start, end);
    const check = new Function('context', 'descriptionSubmission', code + '\nreturn supportedDescriptionPolicyVersions.has(descriptionPolicyVersion) && !conflictingFrozenPolicyVersion && !incompleteV3PolicyContract;');
    const v4 = 'merchroute-ozon-content-v4';
    const context = { contentPolicyVersion: v4, publicationContentPolicyVersion: v4, product: { contentPolicyVersion: v4 },
      jobPayload: { contentPolicyVersion: v4, importIntent: { contentPolicyVersion: v4 } } };
    assert.equal(check(context, { policyVersion: v4 }), true);
    for (const field of ['product', 'contentPolicyVersion', 'publicationContentPolicyVersion', 'jobPayload']) {
      const missing = structuredClone(context);
      delete missing[field];
      assert.equal(check(missing, { policyVersion: v4 }), false, `${name}/${field}`);
    }
    const missingIntent = structuredClone(context);
    delete missingIntent.jobPayload.importIntent;
    assert.equal(check(missingIntent, { policyVersion: v4 }), false);
    assert.equal(check(context, { policyVersion: 'merchroute-ozon-content-v3' }), false);
    assert.equal(check(context, { policyVersion: 'merchroute-ozon-content-v99' }), false);
  }
});
