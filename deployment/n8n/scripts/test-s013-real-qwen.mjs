import assert from 'node:assert/strict';

import {
  S013_LANGUAGE_NODE_NAMES,
  findTitleLanguageViolations,
  normalizeTitleLanguage,
} from '../patches/s013-language-policy-v1.mjs';

const args = new Map(process.argv.slice(2).map((item) => {
  const [key, ...rest] = item.replace(/^--/, '').split('=');
  return [key, rest.length ? rest.join('=') : 'true'];
}));
const apiUrl = String(process.env.N8N_API_URL || 'http://127.0.0.1:5678').replace(/\/$/, '');
const apiKey = String(process.env.N8N_API_KEY || '').trim();
const executionId = String(args.get('execution-id') || '').trim();
const requestedLanguages = String(args.get('languages') || 'ru-RU,en-US,zh-CN')
  .split(',')
  .map((value) => value.trim())
  .filter(Boolean);
const expectedVersion = String(args.get('expected-version') || '').trim();
const forceCorrectionFixture = args.get('force-correction') === 'true';
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

assert.ok(apiKey, '缺少 N8N_API_KEY');
assert.match(executionId, /^\d+$/, '必须提供数字 --execution-id');
assert.ok(expectedVersion, '必须提供 --expected-version');
assert.ok(requestedLanguages.length > 0, '至少提供一种测试语言');

async function n8nGet(route) {
  const response = await fetch(`${apiUrl}/api/v1${route}`, {
    headers: { 'X-N8N-API-KEY': apiKey },
    signal: AbortSignal.timeout(60_000),
  });
  const text = await response.text();
  assert.ok(response.ok, `n8n GET ${route}: HTTP ${response.status} ${text.slice(0, 300)}`);
  return JSON.parse(text);
}

function firstNodeJson(execution, nodeName) {
  const json = execution.data?.resultData?.runData?.[nodeName]?.[0]?.data?.main?.[0]?.[0]?.json;
  assert.ok(json && typeof json === 'object', `历史执行缺少 ${nodeName} 输出`);
  return json;
}

function requireNode(workflow, name) {
  const node = workflow.nodes.find((candidate) => candidate.name === name);
  assert.ok(node, `在线 S013 缺少节点 ${name}`);
  return node;
}

async function runCode(jsCode, { input = {}, nodes = {} } = {}) {
  const inputItems = Array.isArray(input) ? input.map((json) => ({ json })) : [{ json: input }];
  const $input = { first: () => inputItems[0] || { json: {} }, all: () => inputItems };
  const $ = (name) => {
    const raw = nodes[name];
    const values = Array.isArray(raw) ? raw : [raw || {}];
    const items = values.map((json) => ({ json }));
    return { first: () => items[0] || { json: {} }, all: () => items };
  };
  const fn = new AsyncFunction('$input', '$', jsCode);
  return fn.call({
    helpers: { getBinaryDataBuffer: async () => { throw new Error('real smoke uses the embedded fallback category rules'); } },
  }, $input, $);
}

async function callQwen(request, constants) {
  const url = String(constants?.BaseUrl?.BaseUrl_Run || '').trim();
  const authorization = String(constants?.Authorization?.APIKey_Run || '').trim();
  assert.match(url, /^https?:\/\//i, '历史执行缺少有效 BaseUrl_Run');
  assert.ok(authorization, '历史执行缺少 APIKey_Run');
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { Authorization: authorization, 'Content-Type': 'application/json' },
        body: JSON.stringify(request),
        signal: AbortSignal.timeout(180_000),
      });
      const text = await response.text();
      assert.ok(response.ok, `Qwen HTTP ${response.status}: ${text.slice(0, 200)}`);
      return JSON.parse(text);
    } catch (error) {
      lastError = error;
      if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, 3000));
    }
  }
  throw lastError;
}

const [workflow, execution] = await Promise.all([
  n8nGet('/workflows/JEl0xCKTgtiIP9UT'),
  n8nGet(`/executions/${executionId}?includeData=true`),
]);
assert.equal(workflow.versionId, expectedVersion, '在线 S013 versionId 漂移');
assert.equal(workflow.activeVersionId, expectedVersion, '在线 S013 activeVersionId 漂移');
assert.equal(execution.workflowId, 'JEl0xCKTgtiIP9UT', '历史执行不属于 S013');

const triggerSource = firstNodeJson(execution, 'When Executed by Another Workflow');
const historicalGlobal = firstNodeJson(execution, 'Global Constants');
const historicalBuild = firstNodeJson(execution, 'Build Qwen Request with SiliconFlow URLs');
const constants = historicalBuild.constants || {};
const model = String(constants.model?.Model_Run || '').trim();
assert.ok(model, '历史执行缺少 Model_Run');
const imageUrls = (historicalBuild.request?.messages?.[1]?.content || [])
  .filter((item) => item?.type === 'image_url')
  .map((item) => String(item.image_url?.url || '').trim())
  .filter((value) => /^https?:\/\//i.test(value));
assert.ok(imageUrls.length >= 1 && imageUrls.length <= 5, `历史执行图片 URL 数量无效：${imageUrls.length}`);

const sysPromptCode = requireNode(workflow, S013_LANGUAGE_NODE_NAMES.sysPrompt).parameters.jsCode;
const prepareCode = requireNode(workflow, S013_LANGUAGE_NODE_NAMES.prepare).parameters.jsCode;
const parseCode = requireNode(workflow, S013_LANGUAGE_NODE_NAMES.parse).parameters.jsCode;
const buildCorrectionCode = requireNode(workflow, S013_LANGUAGE_NODE_NAMES.buildCorrection).parameters.jsCode;
const applyCorrectionCode = requireNode(workflow, S013_LANGUAGE_NODE_NAMES.applyCorrection).parameters.jsCode;
const emitCode = requireNode(workflow, S013_LANGUAGE_NODE_NAMES.emit).parameters.jsCode;

const results = [];
for (const requestedLanguage of requestedLanguages) {
  const expectedPolicy = normalizeTitleLanguage(requestedLanguage);
  const source = { ...triggerSource, Language: requestedLanguage };
  for (let index = 0; index < 5; index += 1) source[`viewImageAdd${index + 1}`] = imageUrls[index] || '';
  delete source.viewImageAdds;
  delete source.imageUrls;
  delete source.images;
  delete source.viewImages;

  const sysOutput = await runCode(sysPromptCode, {
    nodes: {
      'When Executed by Another Workflow': source,
      'Global Constants': historicalGlobal,
    },
  });
  const shared = sysOutput[0].json;
  assert.equal(shared.Language, expectedPolicy.code);
  const preparedItems = await runCode(prepareCode, {
    nodes: {
      'When Executed by Another Workflow': source,
      sysPrompt: shared,
    },
  });
  const prepared = preparedItems[0].json;
  assert.equal(prepared.Language, expectedPolicy.code);
  assert.equal(prepared.languagePolicy.code, expectedPolicy.code);

  const initialRequest = {
    model,
    messages: [
      { role: 'system', content: shared.sysPrompt },
      {
        role: 'user',
        content: [
          ...imageUrls.map((url) => ({ type: 'image_url', image_url: { url } })),
          { type: 'text', text: prepared.userPrompt },
        ],
      },
    ],
    enable_thinking: false,
    response_format: { type: 'json_object' },
    temperature: 0.2,
  };
  const initialResponse = await callQwen(initialRequest, constants);
  const initialEnvelopeItems = await runCode(parseCode, {
    input: initialResponse,
    nodes: {
      'When Executed by Another Workflow': source,
      'User Input Prepare': prepared,
    },
  });
  let initialEnvelope = initialEnvelopeItems[0].json;
  let forcedCorrectionFixtureApplied = false;
  if (forceCorrectionFixture && !initialEnvelope.needsTitleLanguageCorrection) {
    const forcedResult = JSON.parse(JSON.stringify(initialEnvelope.result));
    const sceneKey = Array.from({ length: 7 }, (_, index) => `scenePrompt${String(index + 1).padStart(2, '0')}`)
      .find((key) => typeof forcedResult?.[key]?.title === 'string' && forcedResult[key].title.trim());
    assert.ok(sceneKey, `${expectedPolicy.code} 没有可用于受控纠正测试的非空 title`);
    forcedResult[sceneKey].title = expectedPolicy.code === 'ru-RU' ? '中文标题' : 'Русский заголовок';
    const forcedViolations = findTitleLanguageViolations(forcedResult, expectedPolicy);
    assert.ok(forcedViolations.length > 0, `${expectedPolicy.code} 人工错误标题未触发校验`);
    initialEnvelope = {
      needsTitleLanguageCorrection: true,
      result: forcedResult,
      languagePolicy: expectedPolicy,
      violations: forcedViolations,
    };
    forcedCorrectionFixtureApplied = true;
  }
  let finalEnvelope = initialEnvelope;
  let qwenCalls = 1;
  if (initialEnvelope.needsTitleLanguageCorrection) {
    const correctionItems = await runCode(buildCorrectionCode, {
      input: initialEnvelope,
      nodes: {
        'Build Qwen Request with SiliconFlow URLs': historicalBuild,
        sysPrompt: shared,
      },
    });
    const correctionContext = correctionItems[0].json;
    const correctionResponse = await callQwen(correctionContext.request, correctionContext.constants);
    qwenCalls += 1;
    const applied = await runCode(applyCorrectionCode, {
      input: correctionResponse,
      nodes: { 'Build Controlled Title Correction': correctionContext },
    });
    finalEnvelope = applied[0].json;
  }
  const emitted = await runCode(emitCode, { input: finalEnvelope });
  const result = emitted[0].json;
  const finalViolations = findTitleLanguageViolations(result, expectedPolicy);
  assert.deepEqual(finalViolations, [], `${expectedPolicy.code} 最终标题仍有语言违规`);
  assert.equal(Object.hasOwn(result, 'languagePolicy'), false);
  assert.equal(Object.hasOwn(result, 'violations'), false);
  const nonemptyTitleFieldCount = Array.from({ length: 7 }, (_, index) => result[`scenePrompt${String(index + 1).padStart(2, '0')}`])
    .flatMap((scene) => [scene?.title, scene?.titleDescription])
    .filter((value) => typeof value === 'string' && value.trim()).length;
  results.push({
    language: expectedPolicy.code,
    qwenCalls,
    correctionUsed: qwenCalls === 2,
    forcedCorrectionFixtureApplied,
    initialViolationCount: initialEnvelope.violations.length,
    finalViolationCount: finalViolations.length,
    nonemptyTitleFieldCount,
    outputKeys: Object.keys(result),
  });
}

console.log(JSON.stringify({
  ok: true,
  workflowId: workflow.id,
  versionId: workflow.versionId,
  sourceExecutionId: execution.id,
  sourceImageCount: imageUrls.length,
  results,
}, null, 2));
