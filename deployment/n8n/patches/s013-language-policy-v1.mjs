import assert from 'node:assert/strict';

export const S013_WORKFLOW_ID = 'JEl0xCKTgtiIP9UT';

export const S013_LANGUAGE_NODE_NAMES = Object.freeze({
  sysPrompt: 'sysPrompt',
  prepare: 'User Input Prepare',
  parse: 'Parse Qwen JSON Output',
  decision: 'Needs Title Language Correction',
  buildCorrection: 'Build Controlled Title Correction',
  requestCorrection: 'HTTP Request Title Correction',
  applyCorrection: 'Apply and Validate Title Correction',
  emit: 'Emit Validated Qwen Output',
});

const NEW_NODE_IDS = Object.freeze({
  decision: '2f0f9c21-58ca-4c09-a74d-c0bc2e4023ac',
  buildCorrection: 'f0e40e82-8858-4eec-a07d-f54af31812b3',
  requestCorrection: '18777f5a-dd8f-40ed-a013-c77e7e4b3ff6',
  applyCorrection: '8d9fbe46-2a9e-40c7-8daf-8dfdaf67891b',
  emit: '2cb7d532-7f39-4103-8a19-2e3c2603904a',
});

const PATCH_MARKER = "const S013_TITLE_LANGUAGE_POLICY_V1 = '2026-09-06';";

const clone = (value) => structuredClone(value);

export function normalizeTitleLanguage(value) {
  const raw = value === undefined || value === null ? '' : String(value).trim();
  const lower = raw.toLowerCase();
  if (raw === '俄文' || lower === 'ru-ru') {
    return {
      code: 'ru-RU',
      label: '俄语',
      promptInstruction: '非空的 title 和 titleDescription 必须使用俄语，至少包含一个西里尔字母（Unicode U+0400-U+04FF），禁止出现任何汉字；允许保留必要的拉丁品牌名、型号、数字和标点。',
    };
  }
  if (raw === '英文' || lower === 'en-us') {
    return {
      code: 'en-US',
      label: '英语',
      promptInstruction: '非空的 title 和 titleDescription 必须使用英语，至少包含一个拉丁字母 A-Z 或 a-z，禁止出现任何汉字和西里尔字母；允许保留必要的品牌名、型号、数字和标点。',
    };
  }
  if (raw === '简体中文' || lower === 'zh-cn') {
    return {
      code: 'zh-CN',
      label: '简体中文',
      promptInstruction: '非空的 title 和 titleDescription 必须使用现代简体中文，至少包含一个汉字，不使用繁体表达，禁止出现任何西里尔字母；允许保留必要的拉丁品牌名、型号、数字和标点。',
    };
  }
  const preview = raw.replace(/[\r\n\t]+/g, ' ').slice(0, 80) || 'EMPTY';
  throw new Error('S013_LANGUAGE_UNSUPPORTED: Language=' + JSON.stringify(preview) + '; supported=俄文/ru-RU,英文/en-US,简体中文/zh-CN');
}

export function findTitleLanguageViolations(result, languagePolicy) {
  const sceneKeys = Array.from({ length: 7 }, (_, index) => `scenePrompt${String(index + 1).padStart(2, '0')}`);
  const titleFields = ['title', 'titleDescription'];
  const violations = [];
  const code = languagePolicy?.code;
  if (!['ru-RU', 'en-US', 'zh-CN'].includes(code)) {
    throw new Error('S013_LANGUAGE_UNSUPPORTED: normalized Language=' + String(code || 'EMPTY'));
  }
  for (const sceneKey of sceneKeys) {
    const scene = result?.[sceneKey];
    if (!scene || typeof scene !== 'object' || Array.isArray(scene)) continue;
    for (const field of titleFields) {
      const raw = scene[field];
      const value = raw === undefined || raw === null ? '' : String(raw).trim();
      if (!value) continue;
      const reasons = [];
      const hasCyrillic = /[\u0400-\u04FF]/.test(value);
      const hasHan = /[\u3400-\u9FFF]/.test(value);
      const hasLatin = /[A-Za-z]/.test(value);
      if (code === 'ru-RU') {
        if (!hasCyrillic) reasons.push('missing_cyrillic');
        if (hasHan) reasons.push('contains_han');
      } else if (code === 'en-US') {
        if (!hasLatin) reasons.push('missing_latin');
        if (hasHan) reasons.push('contains_han');
        if (hasCyrillic) reasons.push('contains_cyrillic');
      } else {
        if (!hasHan) reasons.push('missing_han');
        if (hasCyrillic) reasons.push('contains_cyrillic');
      }
      if (reasons.length) violations.push({ sceneKey, field, value, reasons });
    }
  }
  return violations;
}

/* The catch bindings remain in the function source because this function is embedded verbatim in n8n Code nodes. */
/* eslint-disable @typescript-eslint/no-unused-vars */
export function parseAssistantJson(response, errorCode = 'S013_QWEN_OUTPUT_INVALID') {
  let content = response?.choices?.[0]?.message?.content ?? response?.message?.content ?? response?.content;
  if (content && typeof content === 'object' && !Array.isArray(content)) return content;
  if (typeof content !== 'string') throw new Error(errorCode + ': response did not include object content');
  let text = content.trim();
  const fenced = text.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (fenced) text = fenced[1].trim();
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (firstError) {
    const firstBrace = text.indexOf('{');
    const lastBrace = text.lastIndexOf('}');
    if (firstBrace === -1 || lastBrace <= firstBrace) throw new Error(errorCode + ': response is not valid JSON');
    try {
      parsed = JSON.parse(text.slice(firstBrace, lastBrace + 1));
    } catch (secondError) {
      throw new Error(errorCode + ': response is not valid JSON');
    }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(errorCode + ': response JSON must be an object');
  }
  return parsed;
}
/* eslint-enable @typescript-eslint/no-unused-vars */

function requireNode(workflow, name) {
  const node = workflow.nodes.find((candidate) => candidate.name === name);
  if (!node) throw new Error(`${workflow.id} 缺少节点 ${name}`);
  return node;
}

function replaceOnce(value, find, replacement, label) {
  const occurrences = value.split(find).length - 1;
  if (occurrences !== 1) throw new Error(`${label} 预期匹配 1 次，实际 ${occurrences} 次`);
  return value.replace(find, replacement);
}

const parseRuntime = parseAssistantJson.toString();

function patchSysPrompt(node) {
  let code = node.parameters?.jsCode;
  if (typeof code !== 'string') throw new Error(`${node.name} jsCode 无效`);
  if (code.includes(PATCH_MARKER)) return;
  code = replaceOnce(
    code,
    "function getInputCategory(input) {",
    `${PATCH_MARKER}\n${normalizeTitleLanguage.toString()}\n\nconst languagePolicy = normalizeTitleLanguage(sourceInput.Language ?? sourceInput.language);\n\nfunction getInputCategory(input) {`,
    `${node.name}/语言策略注入`,
  );
  code = replaceOnce(
    code,
    '- Language：标题和标题描述语言，如俄文 / 英文',
    '- Language：标题和标题描述语言，本次已规范化为 ${languagePolicy.code}',
    `${node.name}/输入字段说明`,
  );
  code = replaceOnce(
    code,
    '# 参考视图规则',
    '# 当前标题语言策略（只适用于 title 和 titleDescription）\n\n当前规范语言代码：${languagePolicy.code}\n${languagePolicy.promptInstruction}\n该语言策略不得改变 productAppearance、sellingPoints、targetMarket 和 scenePrompt.prompt 的既有中文要求。\n\n# 参考视图规则',
    `${node.name}/动态提示词`,
  );
  code = replaceOnce(
    code,
    '- title：根据 Language 生成的标题；细节展示或特写场景必须为空字符串 ""',
    '- title：根据当前标题语言策略生成的标题；细节展示或特写场景必须为空字符串 ""',
    `${node.name}/title 结构说明`,
  );
  code = replaceOnce(
    code,
    '- titleDescription：根据 Language 生成的标题描述；细节展示或特写场景必须为空字符串 ""',
    '- titleDescription：根据当前标题语言策略生成的标题描述；细节展示或特写场景必须为空字符串 ""',
    `${node.name}/titleDescription 结构说明`,
  );
  code = replaceOnce(
    code,
    'title 必须使用 Language 指定语言。',
    'title 必须严格遵守当前标题语言策略。',
    `${node.name}/title 规则`,
  );
  code = replaceOnce(
    code,
    'titleDescription 必须使用 Language 指定语言。',
    'titleDescription 必须严格遵守当前标题语言策略。',
    `${node.name}/titleDescription 规则`,
  );
  code = replaceOnce(
    code,
    '      ...sourceInput,\n      sysPrompt: baseSystemPrompt,',
    '      ...sourceInput,\n      Language: languagePolicy.code,\n      languagePolicy,\n      sysPrompt: baseSystemPrompt,',
    `${node.name}/规范语言输出`,
  );
  node.parameters.jsCode = code;
  node.notes = '按当前任务动态规范 ru-RU/en-US/zh-CN 标题语言，并生成类目场景系统提示词';
}

function patchUserInputPrepare(node) {
  let code = node.parameters?.jsCode;
  if (typeof code !== 'string') throw new Error(`${node.name} jsCode 无效`);
  if (code.includes('const languagePolicy = shared.languagePolicy;')) return;
  code = replaceOnce(
    code,
    "const shared = $('sysPrompt').first().json || {};\n",
    "const shared = $('sysPrompt').first().json || {};\nconst languagePolicy = shared.languagePolicy;\nif (!languagePolicy || !['ru-RU', 'en-US', 'zh-CN'].includes(languagePolicy.code)) {\n  throw new Error('S013_LANGUAGE_UNSUPPORTED: sysPrompt did not provide a supported normalized language');\n}\n",
    `${node.name}/语言策略读取`,
  );
  code = replaceOnce(
    code,
    '  Language: clean(source.Language ?? shared.Language),',
    '  Language: clean(shared.Language),',
    `${node.name}/规范语言输入`,
  );
  code = replaceOnce(
    code,
    '    userInputJson,\n    userPrompt,',
    '    userInputJson,\n    userPrompt,\n    Language: userInput.Language,\n    languagePolicy,',
    `${node.name}/语言策略透传`,
  );
  node.parameters.jsCode = code;
  node.notes = '规范化用户输入并透传当前任务的标题语言策略；支持 URL 或本地图片路径';
}

const INITIAL_PARSE_CODE = `${parseRuntime}\n\n${findTitleLanguageViolations.toString()}\n\nconst response = $input.first().json || {};\nconst productName = String($('When Executed by Another Workflow').first().json.productName ?? '');\nconst prepared = $('User Input Prepare').first().json || {};\nconst languagePolicy = prepared.languagePolicy;\nconst parsed = parseAssistantJson(response);\nconst result = { ...parsed, productName };\nconst violations = findTitleLanguageViolations(result, languagePolicy);\n\nreturn [{\n  json: {\n    needsTitleLanguageCorrection: violations.length > 0,\n    result,\n    languagePolicy,\n    violations,\n  },\n}];`;

const BUILD_CORRECTION_CODE = `const input = $input.first().json || {};\nconst languagePolicy = input.languagePolicy;\nconst violations = Array.isArray(input.violations) ? input.violations : [];\nconst originalResult = input.result;\nif (!originalResult || typeof originalResult !== 'object' || Array.isArray(originalResult)) {\n  throw new Error('S013_TITLE_LANGUAGE_CORRECTION_FAILED: missing original result');\n}\nif (!languagePolicy || !['ru-RU', 'en-US', 'zh-CN'].includes(languagePolicy.code)) {\n  throw new Error('S013_LANGUAGE_UNSUPPORTED: correction branch received invalid language policy');\n}\nif (violations.length < 1) {\n  throw new Error('S013_TITLE_LANGUAGE_CORRECTION_FAILED: correction branch received no violations');\n}\n\nconst requestSource = $('Build Qwen Request with SiliconFlow URLs').first().json || {};\nconst constants = requestSource.constants || {};\nconst model = String(constants.model?.Model_Run || '').trim();\nconst baseUrl = String(constants.BaseUrl?.BaseUrl_Run || '').trim();\nconst authorization = String(constants.Authorization?.APIKey_Run || '').trim();\nif (!model) throw new Error('Missing constants.model.Model_Run');\nif (!baseUrl) throw new Error('Missing constants.BaseUrl.BaseUrl_Run');\nif (!authorization) throw new Error('Missing constants.Authorization.APIKey_Run');\n\nconst limits = $('sysPrompt').first().json || {};\nconst correctionItems = violations.map((violation) => ({\n  sceneKey: violation.sceneKey,\n  field: violation.field,\n  invalidValue: violation.value,\n  reasons: violation.reasons,\n  scenePrompt: String(originalResult?.[violation.sceneKey]?.prompt ?? ''),\n  maxLength: violation.field === 'title' ? limits.titleLimit : limits.titleDescriptionLimit,\n}));\n\nconst correctionSystemPrompt = [\n  '你只负责修正电商主图 JSON 中语言不合格的标题字段。',\n  '当前规范语言代码：' + languagePolicy.code,\n  languagePolicy.promptInstruction,\n  '只修正输入 violations 列出的字段，不得新增、删除或修改其他字段。',\n  '每个违规字段必须且只能返回一次，value 必须是非空字符串并遵守 maxLength。',\n  '只能输出 JSON 对象，结构必须严格为：{"corrections":[{"sceneKey":"scenePrompt01","field":"title","value":"修正后的值"}]}',\n  '禁止输出 Markdown、解释或 JSON 以外的内容。',\n].join('\\n');\n\nconst request = {\n  model,\n  messages: [\n    { role: 'system', content: correctionSystemPrompt },\n    { role: 'user', content: JSON.stringify({ language: languagePolicy.code, violations: correctionItems }) },\n  ],\n  enable_thinking: false,\n  response_format: { type: 'json_object' },\n  temperature: 0,\n};\n\nreturn [{ json: { request, constants, originalResult, languagePolicy, violations } }];`;

const APPLY_CORRECTION_CODE = `${parseRuntime}\n\n${findTitleLanguageViolations.toString()}\n\nconst response = $input.first().json || {};\nconst context = $('Build Controlled Title Correction').first().json || {};\nconst languagePolicy = context.languagePolicy;\nconst originalResult = context.originalResult;\nconst violations = Array.isArray(context.violations) ? context.violations : [];\nlet parsed;\ntry {\n  parsed = parseAssistantJson(response, 'S013_TITLE_LANGUAGE_CORRECTION_FAILED');\n} catch (error) {\n  throw new Error(error.message);\n}\nconst corrections = parsed.corrections;\nif (!Array.isArray(corrections)) {\n  throw new Error('S013_TITLE_LANGUAGE_CORRECTION_FAILED: corrections must be an array');\n}\nconst expected = new Map();\nfor (const violation of violations) {\n  const key = violation.sceneKey + '.' + violation.field;\n  if (expected.has(key)) throw new Error('S013_TITLE_LANGUAGE_CORRECTION_FAILED: duplicate source violation ' + key);\n  expected.set(key, violation);\n}\nif (corrections.length !== expected.size) {\n  throw new Error('S013_TITLE_LANGUAGE_CORRECTION_FAILED: expected ' + expected.size + ' corrections, received ' + corrections.length);\n}\nconst corrected = JSON.parse(JSON.stringify(originalResult));\nconst seen = new Set();\nfor (const correction of corrections) {\n  if (!correction || typeof correction !== 'object' || Array.isArray(correction)) {\n    throw new Error('S013_TITLE_LANGUAGE_CORRECTION_FAILED: every correction must be an object');\n  }\n  const keys = Object.keys(correction).sort();\n  if (JSON.stringify(keys) !== JSON.stringify(['field', 'sceneKey', 'value'])) {\n    throw new Error('S013_TITLE_LANGUAGE_CORRECTION_FAILED: correction fields must be sceneKey, field, value');\n  }\n  const key = String(correction.sceneKey) + '.' + String(correction.field);\n  if (!expected.has(key) || seen.has(key)) {\n    throw new Error('S013_TITLE_LANGUAGE_CORRECTION_FAILED: unexpected or duplicate correction ' + key);\n  }\n  if (typeof correction.value !== 'string' || !correction.value.trim()) {\n    throw new Error('S013_TITLE_LANGUAGE_CORRECTION_FAILED: corrected value must be a non-empty string for ' + key);\n  }\n  if (!corrected[correction.sceneKey] || typeof corrected[correction.sceneKey] !== 'object' || Array.isArray(corrected[correction.sceneKey])) {\n    throw new Error('S013_TITLE_LANGUAGE_CORRECTION_FAILED: missing scene object ' + String(correction.sceneKey));\n  }\n  corrected[correction.sceneKey][correction.field] = correction.value.trim();\n  seen.add(key);\n}\nconst remaining = findTitleLanguageViolations(corrected, languagePolicy);\nif (remaining.length) {\n  const details = remaining.map((item) => item.sceneKey + '.' + item.field + ':' + item.reasons.join('+')).join(',');\n  throw new Error('S013_TITLE_LANGUAGE_CORRECTION_FAILED: language=' + languagePolicy.code + '; violations=' + details);\n}\nreturn [{ json: { result: corrected } }];`;

const EMIT_CODE = `const result = $input.first().json?.result;\nif (!result || typeof result !== 'object' || Array.isArray(result)) {\n  throw new Error('S013_QWEN_OUTPUT_INVALID: validated result is missing');\n}\nreturn [{ json: result }];`;

function buildNewNodes(initialHttpNode) {
  const names = S013_LANGUAGE_NODE_NAMES;
  const correctionHttp = clone(initialHttpNode);
  correctionHttp.id = NEW_NODE_IDS.requestCorrection;
  correctionHttp.name = names.requestCorrection;
  correctionHttp.position = [2432, 384];
  correctionHttp.notes = '仅在标题语言校验失败时调用一次 Qwen，复用 Model_Run、BaseUrl_Run、APIKey_Run';
  delete correctionHttp.webhookId;
  return [
    {
      parameters: {
        conditions: {
          options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 3 },
          conditions: [{
            id: '34cdd131-86fd-450b-aead-d05d716aefc4',
            leftValue: '={{ $json.needsTitleLanguageCorrection }}',
            rightValue: true,
            operator: { type: 'boolean', operation: 'true', singleValue: true },
          }],
          combinator: 'and',
        },
        options: {},
      },
      id: NEW_NODE_IDS.decision,
      name: names.decision,
      type: 'n8n-nodes-base.if',
      typeVersion: 2.3,
      position: [1984, 480],
      notesInFlow: true,
      notes: '仅当非空 title/titleDescription 不符合当前语言策略时进入一次纠正',
    },
    {
      parameters: { jsCode: BUILD_CORRECTION_CODE },
      id: NEW_NODE_IDS.buildCorrection,
      name: names.buildCorrection,
      type: 'n8n-nodes-base.code',
      typeVersion: 2,
      position: [2208, 384],
      notesInFlow: true,
      notes: '仅提交违规标题字段，构造一次受控 Qwen 纠正请求',
    },
    correctionHttp,
    {
      parameters: { jsCode: APPLY_CORRECTION_CODE },
      id: NEW_NODE_IDS.applyCorrection,
      name: names.applyCorrection,
      type: 'n8n-nodes-base.code',
      typeVersion: 2,
      position: [2656, 384],
      notesInFlow: true,
      notes: '严格应用完整且唯一的字段修正，并再次执行同一语言校验',
    },
    {
      parameters: { jsCode: EMIT_CODE },
      id: NEW_NODE_IDS.emit,
      name: names.emit,
      type: 'n8n-nodes-base.code',
      typeVersion: 2,
      position: [2880, 544],
      notesInFlow: true,
      notes: '移除内部语言策略和纠正元数据，只输出原有 S013 JSON 对象',
    },
  ];
}

function wireCorrectionFlow(workflow) {
  const names = S013_LANGUAGE_NODE_NAMES;
  workflow.connections[names.parse] = { main: [[{ node: names.decision, type: 'main', index: 0 }]] };
  workflow.connections[names.decision] = {
    main: [
      [{ node: names.buildCorrection, type: 'main', index: 0 }],
      [{ node: names.emit, type: 'main', index: 0 }],
    ],
  };
  workflow.connections[names.buildCorrection] = { main: [[{ node: names.requestCorrection, type: 'main', index: 0 }]] };
  workflow.connections[names.requestCorrection] = { main: [[{ node: names.applyCorrection, type: 'main', index: 0 }]] };
  workflow.connections[names.applyCorrection] = { main: [[{ node: names.emit, type: 'main', index: 0 }]] };
  delete workflow.connections[names.emit];
}

export function assertS013LanguagePolicyWorkflow(workflow) {
  assert.equal(workflow.id, S013_WORKFLOW_ID);
  const names = S013_LANGUAGE_NODE_NAMES;
  const sysPrompt = requireNode(workflow, names.sysPrompt);
  const prepare = requireNode(workflow, names.prepare);
  const parse = requireNode(workflow, names.parse);
  const initialHttp = requireNode(workflow, 'HTTP Request Form');
  const correctionHttp = requireNode(workflow, names.requestCorrection);
  for (const name of [names.decision, names.buildCorrection, names.applyCorrection, names.emit]) requireNode(workflow, name);
  assert.match(sysPrompt.parameters.jsCode, /S013_TITLE_LANGUAGE_POLICY_V1/);
  assert.doesNotMatch(sysPrompt.parameters.jsCode, /Language：标题和标题描述语言，如俄文 \/ 英文/);
  assert.match(sysPrompt.parameters.jsCode, /\$\{languagePolicy\.promptInstruction\}/);
  assert.match(prepare.parameters.jsCode, /Language: clean\(shared\.Language\)/);
  assert.match(prepare.parameters.jsCode, /languagePolicy,/);
  assert.match(parse.parameters.jsCode, /findTitleLanguageViolations/);
  assert.deepEqual(correctionHttp.parameters, initialHttp.parameters);
  assert.equal(correctionHttp.retryOnFail, initialHttp.retryOnFail);
  assert.equal(correctionHttp.maxTries, initialHttp.maxTries);
  assert.equal(correctionHttp.waitBetweenTries, initialHttp.waitBetweenTries);
  assert.deepEqual(workflow.connections[names.parse]?.main?.[0], [{ node: names.decision, type: 'main', index: 0 }]);
  assert.deepEqual(workflow.connections[names.decision]?.main?.[0], [{ node: names.buildCorrection, type: 'main', index: 0 }]);
  assert.deepEqual(workflow.connections[names.decision]?.main?.[1], [{ node: names.emit, type: 'main', index: 0 }]);
  assert.deepEqual(workflow.connections[names.buildCorrection]?.main?.[0], [{ node: names.requestCorrection, type: 'main', index: 0 }]);
  assert.deepEqual(workflow.connections[names.requestCorrection]?.main?.[0], [{ node: names.applyCorrection, type: 'main', index: 0 }]);
  assert.deepEqual(workflow.connections[names.applyCorrection]?.main?.[0], [{ node: names.emit, type: 'main', index: 0 }]);
  assert.equal(workflow.connections[names.emit], undefined);
  return true;
}

export function patchS013LanguagePolicyWorkflow(workflow) {
  const patched = clone(workflow);
  if (patched.id !== S013_WORKFLOW_ID) throw new Error(`不支持的工作流 ${patched.id}`);
  const names = S013_LANGUAGE_NODE_NAMES;
  const existingNewNodes = Object.values(names).filter((name) => [names.decision, names.buildCorrection, names.requestCorrection, names.applyCorrection, names.emit].includes(name) && patched.nodes.some((node) => node.name === name));
  const alreadyPatched = requireNode(patched, names.sysPrompt).parameters?.jsCode?.includes(PATCH_MARKER);
  if (alreadyPatched || existingNewNodes.length) {
    if (!alreadyPatched || existingNewNodes.length !== 5) throw new Error(`${patched.id} 检测到不完整的 S013 语言策略补丁`);
    assertS013LanguagePolicyWorkflow(patched);
    return patched;
  }

  patchSysPrompt(requireNode(patched, names.sysPrompt));
  patchUserInputPrepare(requireNode(patched, names.prepare));
  const parseNode = requireNode(patched, names.parse);
  parseNode.parameters.jsCode = INITIAL_PARSE_CODE;
  parseNode.notes = '解析初次 Qwen JSON，并校验非空 title/titleDescription 是否符合当前任务语言';
  const initialHttp = requireNode(patched, 'HTTP Request Form');
  patched.nodes.push(...buildNewNodes(initialHttp));
  wireCorrectionFlow(patched);
  assertS013LanguagePolicyWorkflow(patched);
  return patched;
}

export function changedNodeNames(before, after) {
  const beforeById = new Map(before.nodes.map((node) => [node.id, node]));
  const afterById = new Map(after.nodes.map((node) => [node.id, node]));
  return [...new Set([...beforeById.keys(), ...afterById.keys()])]
    .filter((id) => JSON.stringify(beforeById.get(id)) !== JSON.stringify(afterById.get(id)))
    .map((id) => afterById.get(id)?.name || beforeById.get(id)?.name || id)
    .sort();
}
