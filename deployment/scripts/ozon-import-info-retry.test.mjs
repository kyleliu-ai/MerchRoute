import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const workflow = JSON.parse(fs.readFileSync(
  path.join(root, 'n8n', 'workflows', 'ozon', 'stSK51IuxrMZlLjx.json'),
  'utf8'
));
const evaluators = Array.from({ length: 6 }, (_, index) => {
  const name = `评估导入状态 ${index + 1}`;
  const matches = workflow.nodes.filter((node) => node.name === name);
  assert.equal(matches.length, 1, `${name} 必须唯一`);
  assert.equal(matches[0].type, 'n8n-nodes-base.code');
  return { name, pollAttempt: index + 1, code: matches[0].parameters.jsCode };
});

const run = async ({ code, pollAttempt }, gateway) => {
  const context = {
    taskId: 'sample-store__SKU-TEST__r1',
    jobId: '11111111-1111-4111-8111-111111111111',
    importTaskId: '1234567890'
  };
  const executionId = '100001';
  const expectedRequestRef = `${context.taskId}:importInfo:task${context.importTaskId}:exec${executionId}:poll${pollAttempt}`;
  const dollar = () => ({ first: () => ({ json: context }) });
  const input = { first: () => ({ json: { ...gateway, operation: 'importInfo', requestRef: gateway.requestRef ?? expectedRequestRef } }) };
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  return new AsyncFunction('$', '$input', '$execution', 'require', code)(dollar, input, { id: executionId }, require);
};

test('six importInfo evaluators compile and carry retryable readback contract', () => {
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  for (const evaluator of evaluators) {
    assert.doesNotThrow(() => new AsyncFunction(evaluator.code));
    assert.match(evaluator.code, /OZON_S001_IMPORT_INFO_RETRYABLE_READBACK_V1/);
    assert.match(evaluator.code, /importReadbackFailure/);
    assert.match(evaluator.code, /retryableReadback/);
  }
});

test('status zero NOT_SENT readback advances to the next poll without throwing', async () => {
  for (const evaluator of evaluators) {
    const result = await run(evaluator, {
      ok: false,
      deliveryState: 'NOT_SENT',
      retryClass: 'RETRYABLE',
      statusCode: 0,
      error: { code: 'OZON_GATEWAY_TRANSPORT', message: 'fetch failed' }
    });
    assert.equal(result.length, 1);
    assert.equal(result[0].json.importComplete, false);
    assert.equal(result[0].json.importContractError, null);
    assert.equal(result[0].json.importReadbackFailure.code, 'OZON_GATEWAY_TRANSPORT');
    assert.equal(result[0].json.importReadbackFailure.pollAttempt, evaluator.pollAttempt);
  }
});

test('identity mismatch still fails closed', async () => {
  await assert.rejects(
    () => run(evaluators[0], {
      ok: false,
      requestRef: 'wrong-request-ref',
      deliveryState: 'NOT_SENT',
      retryClass: 'RETRYABLE',
      statusCode: 0
    }),
    /读回身份或轮次无效/
  );
});

test('non-retryable HTTP failure becomes an explicit terminal contract error', async () => {
  const result = await run(evaluators[0], {
    ok: false,
    deliveryState: 'RESPONDED',
    retryClass: 'NON_RETRYABLE',
    statusCode: 401,
    error: { code: 'OZON_AUTH_FAILED', message: 'unauthorized' },
    body: { message: 'unauthorized' }
  });
  assert.equal(result[0].json.importComplete, true);
  assert.equal(result[0].json.importContractError.code, 'OZON_IMPORT_READBACK_FAILED');
  assert.equal(result[0].json.importReadbackFailure.statusCode, 401);
});
