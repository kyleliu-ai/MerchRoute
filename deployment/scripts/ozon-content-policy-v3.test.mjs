import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const deploymentRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function workflow(id) {
  return JSON.parse(fs.readFileSync(path.join(deploymentRoot, 'n8n', 'workflows', 'ozon', `${id}.json`), 'utf8'));
}

function code(workflowDefinition, name) {
  const matches = workflowDefinition.nodes.filter((node) => node.name === name && typeof node.parameters?.jsCode === 'string');
  assert.equal(matches.length, 1, `${name} 必须唯一存在`);
  assert.doesNotThrow(() => new Function(matches[0].parameters.jsCode), `${name} JavaScript 必须可编译`);
  return matches[0].parameters.jsCode;
}

test('OZON content policy v3 only releases Russian analog adjectives', () => {
  const v3 = /(?:^|[^\p{L}\p{N}])(?:аналог(?:а|у|ом|е|и|ов|ам|ами|ах)?|реплик\p{L}*|копи[яи]\p{L}*|подделк\p{L}*|имитац\p{L}*|1\s*:\s*1|replica|imitation|counterfeit)(?=$|[^\p{L}\p{N}])/iu;
  for (const allowed of [
    'с аналогичным тисненым рисунком',
    'из аналогичного материала',
    'Аналогичный узор повторяется'
  ]) assert.equal(v3.test(allowed), false, allowed);
  for (const blocked of [
    'аналог', 'аналога', 'аналогом', 'аналоги', 'аналогов', 'аналогами',
    'реплика бренда', 'копия товара', 'подделка', 'имитация', 'формат 1:1', 'counterfeit'
  ]) assert.equal(v3.test(blocked), true, blocked);
});

test('S001 freezes and applies v2/v3 in all three content checkpoints', () => {
  const definition = workflow('stSK51IuxrMZlLjx');
  for (const name of ['读取并校验本地媒体路径', '构建商品导入请求', '构建导入意图']) {
    const source = code(definition, name);
    assert.match(source, /merchroute-ozon-content-v2/u);
    assert.match(source, /merchroute-ozon-content-v3/u);
    assert.equal(source.includes(String.raw`аналог\p{L}*`), true);
    assert.equal(source.includes('аналог(?:а|у|ом|е|и|ов|ам|ами|ах)?'), true);
    assert.match(source, /importIntent\?\.descriptionSubmission\?\.policyVersion/u);
  }
  assert.match(code(definition, '构建导入意图'), /contentPolicyVersion: descriptionPolicyVersion/u);
});

test('T001 carries the selected policy through both title parsers', () => {
  const definition = workflow('HDh0ZNLK2ps5qasR');
  const validation = code(definition, 'Validate Translation Request');
  assert.match(validation, /String\(body\.contentPolicyVersion \|\| body\.policyVersion \|\| ''\)/u);
  assert.doesNotMatch(validation, /policyVersion \|\| 'merchroute-ozon-content-v2'/u);
  assert.match(validation, /必须是显式且受支持的冻结版本/u);
  for (const name of ['Parse Initial Translation', 'Parse Shortened Translation']) {
    const source = code(definition, name);
    assert.match(source, /merchroute-ozon-content-v2/u);
    assert.match(source, /merchroute-ozon-content-v3/u);
    assert.match(source, /contentPolicyVersion,/u);
  }
});

test('P002 requires a complete v3 product/publication/job/import-intent contract', () => {
  const definition = workflow('g3KK68BLXX7eShqa');
  for (const name of ['分析平台最终状态', '分析平台最终状态 2', '分析平台最终状态 3', '分析平台最终状态 4']) {
    const source = code(definition, name);
    assert.match(source, /merchroute-ozon-content-v3/u);
    assert.match(source, /incompleteV3PolicyContract/u);
    assert.match(source, /conflictingFrozenPolicyVersion/u);
    assert.match(source, /jobContext: String\(context\.contentPolicyVersion \|\| ''\)/u);
    assert.match(source, /publicationRecord: String\(context\.publicationContentPolicyVersion \|\| ''\)/u);
    assert.match(source, /'product','jobContext','publicationRecord','job','importIntent'/u);
  }
  const selector = code(definition, '选择待推进任务');
  assert.match(selector, /publicationContentPolicyVersion/u);
  assert.match(selector, /contentPolicyVersion !== publicationContentPolicyVersion/u);
  assert.match(selector, /materialHashVersion !== 'ozon-shared-material-v1'/u);
  assert.match(selector, /publicationMaterialHash/u);
  assert.match(selector, /materialHash !== publicationMaterialHash/u);
  assert.match(selector, /materialHashVersion !== publicationMaterialHashVersion/u);
});

test('every S001/P002 runtime transition sends the complete frozen binding', () => {
  const expectedByWorkflow = new Map([
    ['stSK51IuxrMZlLjx', [
      '回写 MerchRoute 任务状态',
      '持久化图片补传意图',
      '持久化导入意图',
      '持久化 OZON 导入任务'
    ]],
    ['g3KK68BLXX7eShqa', [
      '锁定待推进任务',
      '回写状态机失败',
      '回写最终校验结果',
      '回写恢复导入结果',
      '回写目录认领失败'
    ]]
  ]);
  for (const [workflowId, expectedNames] of expectedByWorkflow) {
    const definition = workflow(workflowId);
    const transitionNodes = definition.nodes.filter((node) => {
      if (node.type !== 'n8n-nodes-base.httpRequest') return false;
      const url = String(node.parameters?.url || '');
      return url.includes('/transition') || url.includes('$json.url');
    });
    assert.deepEqual(transitionNodes.map((node) => node.name).sort(), [...expectedNames].sort(), `${workflowId} transition 节点集合漂移`);
    for (const node of transitionNodes) {
      const body = String(node.parameters?.jsonBody || '');
      assert.match(body, /\bcontentPolicyVersion\s*:/u, `${node.name} 缺少 contentPolicyVersion`);
      assert.match(body, /\bmaterialHash\s*:/u, `${node.name} 缺少 materialHash`);
      assert.match(body, /\bmaterialHashVersion\s*:/u, `${node.name} 缺少 materialHashVersion`);
    }
  }
});

test('S001 final transition builder preserves the frozen policy and material binding', () => {
  const definition = workflow('stSK51IuxrMZlLjx');
  const source = code(definition, '构建 MerchRoute 状态回写');
  assert.match(source, /const trigger = \$\('When Executed by Another Workflow'\)\.first\(\)\.json \|\| \{\}/u);
  assert.match(source, /const contentPolicyVersion = .*trigger\.product\?\.contentPolicyVersion.*trigger\.jobPayload\?\.contentPolicyVersion/u);
  assert.match(source, /const materialHash = .*trigger\.jobPayload\?\.materialHash/u);
  assert.match(source, /const materialHashVersion = .*trigger\.jobPayload\?\.materialHashVersion/u);
  assert.match(source, /contentPolicyVersion,\s*\n\s*materialHash,\s*\n\s*materialHashVersion/u);
});
