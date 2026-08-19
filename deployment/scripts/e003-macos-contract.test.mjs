import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { makeWorkflowPortable, materializeWorkflow } from '../n8n/portable-workflow.mjs';

const projectRoot = path.resolve(import.meta.dirname, '..', '..');
const workflowRoot = path.join(projectRoot, 'deployment', 'n8n', 'workflows', 'core');
const e003Id = 's0lQIcv1ZCgEzGlB';
const shellHelperWorkflowIds = [
  'DSXe7OXHqa1IsQxx',
  'HpCtxAZJdy9RgWk2',
  'KmZ1AibtVGxzCgzc',
  'KtjTu0u08rZJNtyM',
  'Wxng7hVbjMNhVOaO',
  'noHJuIiHfHryuA2e',
  's0lQIcv1ZCgEzGlB',
  'x8D4EHfqI2DHcgL7',
];
const legacyQuoteSource = String.raw`text.replace(/'/g, "'\''")`;
const portableQuoteSource = String.raw`text.replace(/'/g, "'\"'\"'")`;

async function readWorkflow(id) {
  return JSON.parse(await readFile(path.join(workflowRoot, `${id}.json`), 'utf8'));
}

function requireNode(workflow, name) {
  const node = workflow.nodes.find((candidate) => candidate.name === name);
  assert.ok(node, `${workflow.id} 缺少节点 ${name}`);
  return node;
}

function runtimePaths(dataRoot) {
  return {
    MERCHROUTE_N8N_RUNTIME_DIR: `${dataRoot}/n8n-runtime`,
    MERCHROUTE_DATA_ROOT: dataRoot,
    MERCHROUTE_BROWSER_PROFILE_ROOT: `${dataRoot}/browser-profiles`,
    MERCHROUTE_BROWSER_EXECUTABLE: `${dataRoot}/browser/chrome`,
    MERCHROUTE_TEMP_DIR: `${dataRoot}/.tmp`,
  };
}

test('all controlled hidden-command helpers use the POSIX-safe single-quote contract', async () => {
  for (const id of shellHelperWorkflowIds) {
    const workflow = await readWorkflow(id);
    const codeNodes = workflow.nodes.filter((node) => String(node.parameters?.jsCode || '').includes('__hiddenShQuote'));
    assert.equal(codeNodes.length, 1, `${id} 应且只能包含一个 Shell 引号辅助函数`);
    assert.match(codeNodes[0].parameters.jsCode, new RegExp(portableQuoteSource.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.doesNotMatch(codeNodes[0].parameters.jsCode, new RegExp(legacyQuoteSource.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
});

test('portable workflow normalization only changes the known helper inside jsCode', () => {
  const source = {
    parameters: { jsCode: `function q(value) { return ${legacyQuoteSource}; }` },
    expression: `={{ ${JSON.stringify(legacyQuoteSource)} }}`,
    documentation: legacyQuoteSource,
  };
  const portable = makeWorkflowPortable(source);
  assert.match(portable.parameters.jsCode, new RegExp(portableQuoteSource.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.equal(portable.expression, source.expression);
  assert.equal(portable.documentation, source.documentation);
});

test('POSIX shell executes every generated quote helper with spaces, Chinese, and a single quote', {
  skip: process.platform === 'win32',
}, async () => {
  const payload = "merchroute-e003-o'brien-中文 路径";
  const scriptSource = "const value=Buffer.from(process.argv[1],'base64').toString('utf8');process.stdout.write(JSON.stringify({value}));";
  for (const id of shellHelperWorkflowIds) {
    const workflow = await readWorkflow(id);
    const code = workflow.nodes.find((node) => String(node.parameters?.jsCode || '').includes('__hiddenShQuote')).parameters.jsCode;
    const helperLine = code.split('\n').find((line) => line.includes('function __hiddenShQuote'));
    const context = {};
    vm.runInNewContext(`${helperLine}; quote = __hiddenShQuote;`, context);
    const command = ['node', '-e', context.quote(scriptSource), context.quote(Buffer.from(payload).toString('base64'))].join(' ');
    const result = spawnSync('/bin/sh', ['-c', command], { encoding: 'utf8' });
    assert.equal(result.status, 0, `${id}: ${result.stderr}`);
    assert.deepEqual(JSON.parse(result.stdout), { value: payload });
  }
});

test('E003 output directory is portable and preserves the canonical case on macOS and Windows', async () => {
  const workflow = await readWorkflow(e003Id);
  const sourceCode = requireNode(workflow, 'setParameter').parameters.jsCode;
  assert.match(sourceCode, /const BASE_OUTPUT_DIR = "__MERCHROUTE_DATA_ROOT__\/02_GenerateFolder\/E003-7套图-下载";/);
  assert.doesNotMatch(sourceCode, /[A-Z]:[\\/]|02_generateFolder/);

  const macWorkflow = materializeWorkflow(workflow, runtimePaths('/Users/example/Documents/01_MerchRoute'));
  const macCode = requireNode(macWorkflow, 'setParameter').parameters.jsCode;
  const macOutputLine = macCode.split('\n').find((line) => line.startsWith('const BASE_OUTPUT_DIR ='));
  assert.equal(macOutputLine, 'const BASE_OUTPUT_DIR = "/Users/example/Documents/01_MerchRoute/02_GenerateFolder/E003-7套图-下载";');
  assert.doesNotMatch(macOutputLine, /\\/);

  const windowsWorkflow = materializeWorkflow(workflow, runtimePaths('G:/01_MerchRoute'));
  const windowsCode = requireNode(windowsWorkflow, 'setParameter').parameters.jsCode;
  assert.match(windowsCode, /const BASE_OUTPUT_DIR = "G:\/01_MerchRoute\/02_GenerateFolder\/E003-7套图-下载";/);
});

test('E003 normalizes legacy title lengths to positive numbers before S013', async () => {
  const workflow = await readWorkflow(e003Id);
  const attachCode = requireNode(workflow, 'Attach SiliconFlow Image URLs').parameters.jsCode;
  const runner = new vm.Script(`(function ($input, $) { ${attachCode}\n})`).runInNewContext();
  const paths = ['/media/a.png', '/media/b.png', '/media/c.png'];
  const uploaded = paths.map((sourcePath, inputIndex) => ({
    json: { inputIndex, sourceFileName: path.posix.basename(sourcePath), url: `https://example.invalid/${inputIndex}.png` },
  }));
  const execute = (source) => runner(
    { all: () => uploaded },
    () => ({ first: () => ({ json: { ...source, viewImages: paths } }) }),
  );

  const legacy = execute({ titleLenth: '20', titleDescriptionLenth: '60' })[0].json;
  assert.equal(legacy.titleLength, 20);
  assert.equal(legacy.titleDescriptionLength, 60);
  assert.equal(legacy.titleLenth, 20);
  assert.equal(legacy.titleDescriptionLenth, 60);

  const canonical = execute({ titleLength: 24, titleDescriptionLength: 72 })[0].json;
  assert.equal(canonical.titleLength, 24);
  assert.equal(canonical.titleDescriptionLength, 72);
  for (const invalid of ['', 'not-a-number', 0, -1, 1.5]) {
    assert.throws(() => execute({ titleLength: invalid, titleDescriptionLength: 60 }), /must be a positive integer/);
  }
});

test('E003 passes numeric canonical fields to S013 and stops on sub-workflow failure', async () => {
  const workflow = await readWorkflow(e003Id);
  const call = requireNode(workflow, "Call 'S013-v04-主图场景-编排子流'");
  assert.equal(call.parameters.workflowInputs.value.titleLength, '={{ $json.titleLength }}');
  assert.equal(call.parameters.workflowInputs.value.titleDescriptionLenth, '={{ $json.titleDescriptionLength }}');
  assert.equal(call.parameters.workflowInputs.attemptToConvertTypes, false);
  assert.equal(call.parameters.workflowInputs.convertFieldsToString, false);
  assert.equal(call.onError, 'stopWorkflow');
});
