import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  S013_LANGUAGE_NODE_NAMES,
  changedNodeNames,
  findTitleLanguageViolations,
  normalizeTitleLanguage,
  parseAssistantJson,
  patchS013LanguagePolicyWorkflow,
} from '../n8n/patches/s013-language-policy-v1.mjs';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDir, '..', '..');
const workflowPath = path.join(projectRoot, 'deployment', 'n8n', 'workflows', 'core', 'JEl0xCKTgtiIP9UT.json');
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

function makeResult() {
  const result = {
    productAppearance: '产品外观保持一致',
    sellingPoints: ['卖点1', '卖点2', '卖点3', '卖点4', '卖点5', '卖点6', '卖点7'],
    targetMarket: '目标市场',
  };
  for (let index = 1; index <= 7; index += 1) {
    result[`scenePrompt${String(index).padStart(2, '0')}`] = {
      prompt: `场景${index}`,
      title: '',
      titleDescription: '',
    };
  }
  return result;
}

async function runCode(jsCode, { input = {}, nodes = {}, binaryError = true } = {}) {
  const inputItems = Array.isArray(input)
    ? input.map((json) => ({ json }))
    : [{ json: input }];
  const $input = {
    first: () => inputItems[0] || { json: {} },
    all: () => inputItems,
  };
  const $ = (name) => {
    const value = nodes[name];
    const items = Array.isArray(value)
      ? value.map((json) => ({ json }))
      : [{ json: value || {} }];
    return {
      first: () => items[0] || { json: {} },
      all: () => items,
    };
  };
  const fn = new AsyncFunction('$input', '$', jsCode);
  return fn.call({
    helpers: {
      getBinaryDataBuffer: async () => {
        if (binaryError) throw new Error('fixture uses fallback rules');
        return Buffer.from('');
      },
    },
  }, $input, $);
}

test('normalizes the three supported languages and rejects everything else', () => {
  assert.equal(normalizeTitleLanguage('俄文').code, 'ru-RU');
  assert.equal(normalizeTitleLanguage('ru-RU').code, 'ru-RU');
  assert.equal(normalizeTitleLanguage('RU-ru').code, 'ru-RU');
  assert.equal(normalizeTitleLanguage('英文').code, 'en-US');
  assert.equal(normalizeTitleLanguage('en-US').code, 'en-US');
  assert.equal(normalizeTitleLanguage('简体中文').code, 'zh-CN');
  assert.equal(normalizeTitleLanguage('zh-CN').code, 'zh-CN');
  assert.throws(() => normalizeTitleLanguage(''), /S013_LANGUAGE_UNSUPPORTED/);
  assert.throws(() => normalizeTitleLanguage('法文'), /S013_LANGUAGE_UNSUPPORTED/);
});

test('validates Russian title and titleDescription without rejecting Latin brands', () => {
  const result = makeResult();
  result.scenePrompt01.title = 'Новая сумка 2026';
  result.scenePrompt01.titleDescription = 'Стильная сумка Brand X';
  assert.deepEqual(findTitleLanguageViolations(result, normalizeTitleLanguage('俄文')), []);

  result.scenePrompt01.title = 'New Bag';
  result.scenePrompt01.titleDescription = 'Стильная 手提包';
  assert.deepEqual(
    findTitleLanguageViolations(result, normalizeTitleLanguage('ru-RU')).map(({ field, reasons }) => ({ field, reasons })),
    [
      { field: 'title', reasons: ['missing_cyrillic'] },
      { field: 'titleDescription', reasons: ['contains_han'] },
    ],
  );
});

test('validates English title and titleDescription and rejects Han or Cyrillic', () => {
  const result = makeResult();
  result.scenePrompt01.title = 'New Commuter Bag';
  result.scenePrompt01.titleDescription = 'Lightweight design for daily travel';
  assert.deepEqual(findTitleLanguageViolations(result, normalizeTitleLanguage('英文')), []);

  result.scenePrompt01.title = '通勤包';
  result.scenePrompt01.titleDescription = 'Daily сумка';
  assert.deepEqual(
    findTitleLanguageViolations(result, normalizeTitleLanguage('en-US')).map(({ field, reasons }) => ({ field, reasons })),
    [
      { field: 'title', reasons: ['missing_latin', 'contains_han'] },
      { field: 'titleDescription', reasons: ['contains_cyrillic'] },
    ],
  );
});

test('validates Simplified Chinese script while allowing Latin brands and digits', () => {
  const result = makeResult();
  result.scenePrompt01.title = 'Brand X 轻盈通勤包 2026';
  result.scenePrompt01.titleDescription = '简约设计，适合日常出行';
  assert.deepEqual(findTitleLanguageViolations(result, normalizeTitleLanguage('简体中文')), []);

  result.scenePrompt01.title = 'Daily Bag 2026';
  result.scenePrompt01.titleDescription = '通勤 сумка';
  assert.deepEqual(
    findTitleLanguageViolations(result, normalizeTitleLanguage('zh-CN')).map(({ field, reasons }) => ({ field, reasons })),
    [
      { field: 'title', reasons: ['missing_han'] },
      { field: 'titleDescription', reasons: ['contains_cyrillic'] },
    ],
  );
});

test('empty title fields remain valid for detail scenes', () => {
  const result = makeResult();
  for (const language of ['ru-RU', 'en-US', 'zh-CN']) {
    assert.deepEqual(findTitleLanguageViolations(result, normalizeTitleLanguage(language)), []);
  }
});

test('parses direct, fenced, and wrapped JSON without echoing invalid output', () => {
  assert.deepEqual(parseAssistantJson({ content: { ok: true } }), { ok: true });
  assert.deepEqual(parseAssistantJson({ choices: [{ message: { content: '```json\n{"ok":true}\n```' } }] }), { ok: true });
  assert.deepEqual(parseAssistantJson({ content: 'prefix {"ok":true} suffix' }), { ok: true });
  assert.throws(() => parseAssistantJson({ content: 'not-json' }), /S013_QWEN_OUTPUT_INVALID: response is not valid JSON/);
});

test('repository S013 export contains the complete patch and remains idempotent', async () => {
  const before = JSON.parse(await readFile(workflowPath, 'utf8'));
  const after = patchS013LanguagePolicyWorkflow(before);
  assert.equal(before.nodes.length, 21);
  assert.equal(after.active, before.active);
  assert.deepEqual(after.settings, before.settings);
  assert.deepEqual(changedNodeNames(before, after), []);
  assert.deepEqual(after, before);
  for (const node of after.nodes.filter((candidate) => candidate.type === 'n8n-nodes-base.code')) {
    assert.doesNotThrow(() => new AsyncFunction('$input', '$', node.parameters.jsCode), `${node.name} syntax`);
  }
  assert.deepEqual(patchS013LanguagePolicyWorkflow(after), after);
});

test('generated system prompt contains only the selected title language instruction', async () => {
  const before = JSON.parse(await readFile(workflowPath, 'utf8'));
  const workflow = patchS013LanguagePolicyWorkflow(before);
  const sysPromptCode = workflow.nodes.find((node) => node.name === S013_LANGUAGE_NODE_NAMES.sysPrompt).parameters.jsCode;
  const cases = [
    { input: '俄文', code: 'ru-RU', required: '必须使用俄语', forbidden: ['必须使用英语', '必须使用现代简体中文'] },
    { input: '英文', code: 'en-US', required: '必须使用英语', forbidden: ['必须使用俄语', '必须使用现代简体中文'] },
    { input: '简体中文', code: 'zh-CN', required: '必须使用现代简体中文', forbidden: ['必须使用俄语', '必须使用英语'] },
  ];
  for (const fixture of cases) {
    const output = await runCode(sysPromptCode, {
      nodes: {
        'When Executed by Another Workflow': {
          Language: fixture.input,
          Category: '手提包',
          productName: '2026新款手提包',
          productDescription: '日常通勤手提包',
          titleLength: 20,
          titleDescriptionLenth: 60,
        },
        'Global Constants': { constants: {} },
      },
    });
    const json = output[0].json;
    assert.equal(json.Language, fixture.code);
    assert.equal(json.languagePolicy.code, fixture.code);
    assert.match(json.sysPrompt, new RegExp(fixture.required));
    assert.match(json.sysPrompt, new RegExp(`当前规范语言代码：${fixture.code}`));
    for (const forbidden of fixture.forbidden) assert.doesNotMatch(json.sysPrompt, new RegExp(forbidden));
  }
});

test('one controlled correction changes only the exact violating title field', async () => {
  const before = JSON.parse(await readFile(workflowPath, 'utf8'));
  const workflow = patchS013LanguagePolicyWorkflow(before);
  const node = (name) => workflow.nodes.find((candidate) => candidate.name === name);
  const original = makeResult();
  original.scenePrompt01.title = '时尚通勤包';
  original.scenePrompt01.titleDescription = 'Стильная сумка для города';
  const initial = await runCode(node(S013_LANGUAGE_NODE_NAMES.parse).parameters.jsCode, {
    input: { choices: [{ message: { content: JSON.stringify(original) } }] },
    nodes: {
      'When Executed by Another Workflow': { productName: '2026新款手提包' },
      'User Input Prepare': { languagePolicy: normalizeTitleLanguage('ru-RU') },
    },
  });
  const envelope = initial[0].json;
  assert.equal(envelope.needsTitleLanguageCorrection, true);
  assert.equal(envelope.violations.length, 1);
  const untouchedBefore = JSON.parse(JSON.stringify(envelope.result));

  const applied = await runCode(node(S013_LANGUAGE_NODE_NAMES.applyCorrection).parameters.jsCode, {
    input: {
      choices: [{ message: { content: JSON.stringify({ corrections: [{ sceneKey: 'scenePrompt01', field: 'title', value: 'Стильная сумка' }] }) } }],
    },
    nodes: {
      'Build Controlled Title Correction': {
        originalResult: envelope.result,
        languagePolicy: envelope.languagePolicy,
        violations: envelope.violations,
      },
    },
  });
  const corrected = applied[0].json.result;
  assert.equal(corrected.scenePrompt01.title, 'Стильная сумка');
  untouchedBefore.scenePrompt01.title = 'Стильная сумка';
  assert.deepEqual(corrected, untouchedBefore);
  assert.deepEqual(findTitleLanguageViolations(corrected, envelope.languagePolicy), []);

  const emitted = await runCode(node(S013_LANGUAGE_NODE_NAMES.emit).parameters.jsCode, { input: applied[0].json });
  assert.deepEqual(emitted, [{ json: corrected }]);
  assert.equal(Object.hasOwn(emitted[0].json, 'languagePolicy'), false);
});

test('controlled correction rejects missing, extra, duplicate, blank, or still-invalid patches', async () => {
  const before = JSON.parse(await readFile(workflowPath, 'utf8'));
  const workflow = patchS013LanguagePolicyWorkflow(before);
  const code = workflow.nodes.find((node) => node.name === S013_LANGUAGE_NODE_NAMES.applyCorrection).parameters.jsCode;
  const original = makeResult();
  original.scenePrompt01.title = '中文标题';
  const context = {
    originalResult: original,
    languagePolicy: normalizeTitleLanguage('en-US'),
    violations: findTitleLanguageViolations(original, normalizeTitleLanguage('en-US')),
  };
  const run = (corrections) => runCode(code, {
    input: { content: JSON.stringify({ corrections }) },
    nodes: { 'Build Controlled Title Correction': context },
  });
  await assert.rejects(run([]), /expected 1 corrections/);
  await assert.rejects(run([{ sceneKey: 'scenePrompt02', field: 'title', value: 'English title' }]), /unexpected or duplicate correction/);
  await assert.rejects(run([{ sceneKey: 'scenePrompt01', field: 'title', value: '', extra: true }]), /correction fields must be/);
  await assert.rejects(run([{ sceneKey: 'scenePrompt01', field: 'title', value: '   ' }]), /non-empty string/);
  await assert.rejects(run([{ sceneKey: 'scenePrompt01', field: 'title', value: 'Русский заголовок' }]), /S013_TITLE_LANGUAGE_CORRECTION_FAILED: language=en-US/);
});
