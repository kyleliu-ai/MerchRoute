import * as fs from 'node:fs';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import * as crypto from 'node:crypto';
import { createHash } from 'node:crypto';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import test from 'node:test';
import { patchWbPublishRetry, WB_RETRY_NODES } from '../n8n/patches/wb-publish-retry-v1.mjs';

const workflow = JSON.parse(readFileSync(new URL('../n8n/workflows/wb/qYxi3PPmRm7tjK0E.json', import.meta.url), 'utf8'));
const code = name => workflow.nodes.find(node => node.name === name).parameters.jsCode;
const stable = value => Array.isArray(value) ? '[' + value.map(stable).join(',') + ']'
  : value && typeof value === 'object' ? '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + stable(value[k])).join(',') + '}' : JSON.stringify(value);
const hash = value => 'sha256:' + createHash('sha256').update(stable(value)).digest('hex');

function build(attempt = 2, extra = {}) {
  const frozenPayload = [{ subjectID: 7, variants: [{ vendorCode: '0000172-01', sizes: [{ skus: ['original-barcode'] }] }] }];
  const identity = { taskId: 'default__0000172__r4', publicationId: 'publication', revision: 4, idempotencyKey: 'original-key', vendorCodes: ['0000172-01'] };
  const runtime = { cardCreateIntent: { ...identity, logicalIntentId: 'intent', attemptNo: attempt - 1, frozenPayload, frozenPayloadHash: hash(frozenPayload) },
    manualRetry: { contractVersion: 1, retryId: 'retry', cardAttemptNo: attempt, cardWriteAuthorized: true }, ...extra };
  const job = { task_id: identity.taskId, idempotency_key: identity.idempotencyKey, state: 'CARD_CREATE_READY', row_version: 8 };
  const source = code('Build Step').split("if (job.state === 'CARD_CREATE_READY') {")[1].split("if (job.state === 'CARD_UPDATE_READY') {")[0];
  return vm.runInNewContext('(function(){ if(true) {' + source + '})()', {
    job, runtime, product: {}, mapping: {}, template: { subject_id: 7 }, submissionMode: 'CREATE_ONLY',
    productVendorCodes: () => identity.vendorCodes, cardIdentitySnapshot: () => identity,
    cardLogicalIntentId: () => 'intent', jsonSha256: hash, buildCreatePayload: () => frozenPayload,
    isoAfter: () => new Date(Date.now() + 86400000).toISOString(),
    makeRequest: (job, runtime, request, action) => ({ job, runtime, request, action }),
    makePersist: (job, runtime, state, delay, errorCode) => ({ job: { ...job, state }, runtime, delay, errorCode })
  })[0].json;
}
function handle(step, body, statusCode = 200) {
  const runtime = step.runtime;
  runtime.product ||= { productCode: '0000172', revision: 4, variants: [{ vendorCode: '0000172-01', sizes: [] }] };
  const nodes = {
    'Build Step': step,
    'Persist HTTP Intent': { ...step.job, row_version: Number(step.job.row_version) + 1, result_json: JSON.stringify(runtime) },
    'Load Runtime Config': { price_currency_expected: 'CNY', warehouse_id: 1 }
  };
  return vm.runInNewContext('(function(){' + code('Handle WB Response') + '})()', {
    $: name => ({ first: () => ({ json: nodes[name] || {} }), all: () => [] }),
    $input: { all: () => [{ json: { statusCode, body, deliveryState: 'RESPONDED', retryClass: statusCode === 400 ? 'PERMANENT' : 'NONE' } }] },
    $execution: { id: 'isolated-test' }, require: () => { throw new Error('Unexpected filesystem or network dependency'); },
    Buffer
  })[0].json;
}
test('WB retry patch is idempotent and changes only its declared nodes', () => {
  assert.deepEqual(patchWbPublishRetry(workflow), workflow);
  for (const name of WB_RETRY_NODES) assert.ok(code(name).includes('MerchRoute WB manual retry protocol v1'));
  for (const name of WB_RETRY_NODES) new Function(code(name));
});
test('manual attempt 2 and later reuse frozen payload and receive a new ledger reference', () => {
  for (const attempt of [2, 3, 5]) {
    const result = build(attempt);
    assert.equal(result.action, 'INTENT_HTTP');
    assert.equal(result.request.attemptNo, attempt);
    assert.equal(result.request.requestRef, 'default__0000172__r4:CARD_WRITE:intent:attempt-' + attempt);
    assert.equal(result.request.body[0].variants[0].sizes[0].skus[0], 'original-barcode');
    assert.equal(result.job.state, 'CARD_SUBMITTING');
  }
});
test('a new business 400 stops the manual round and records its actual attempt/time', () => {
  const step = build();
  const result = handle(step, { error: true, errorText: 'Internal server error' }, 400);
  assert.equal(result.job.state, 'FAILED');
  const runtime = JSON.parse(result.job.result_json);
  assert.equal(runtime.lastFailureCheckpoint.requestRef, step.request.requestRef);
  assert.equal(runtime.lastFailureCheckpoint.stage, 'CARD_WRITE');
  assert.equal(runtime.manualRetry.cardWriteAuthorized, false);
  assert.ok(Date.parse(runtime.lastFailureCheckpoint.at));
});
test('successful manual card request enters verification without reporting completed publishing', () => {
  const result = handle(build(), { error: false, errorText: '' });
  assert.notEqual(result.job.state, 'FAILED');
  assert.notEqual(result.job.state, 'SUCCEEDED');
  assert.ok(['CARD_WAITING', 'CARD_SUBMITTING'].includes(result.job.state), result.job.state);
});
test('old generic error batch is retained as history while a new batch still stops the retry', () => {
  const at = new Date().toISOString();
  const step = build(); step.request.stage = 'CARDS_ERROR_LIST'; step.job.state = 'CARD_ERROR_RECONCILING';
  step.runtime.cardCreateIntent.lastAttemptAt = at;
  step.runtime.manualRetry.ignoredGenericFailureBatches = [{ batchUUID: 'old-batch', updatedAt: at }];
  const batch = { batchUUID: 'old-batch', updatedAt: at, vendorCodes: ['0000172-01'], errors: { '0000172-01': ['Internal server error'] } };
  const old = handle(structuredClone(step), { data: { items: [batch] } });
  assert.notEqual(old.job.state, 'FAILED');
  const next = handle(structuredClone(step), { data: { items: [{ ...batch, batchUUID: 'new-batch' }] } });
  assert.equal(next.job.state, 'FAILED');
  assert.equal(next.job.last_error_code, 'CARD_REJECTED');
});
test('manual retries do not reset UNKNOWN proof or authorize an ordinary third automatic attempt', () => {
  const recovery = { active: true, attemptNo: 2, proofRounds: 2, finalReadbackOnly: true, retryAuthorizedAt: '2026-09-01T00:00:00Z' };
  const step = build(3, { cardRecovery: recovery });
  assert.deepEqual(step.runtime.cardRecovery, recovery);
  const unauthorized = build(4, { manualRetry: {}, createOnlyGuard: { checkedAt: new Date().toISOString(), vendorCodes: ['0000172-01'] } });
  assert.equal(unauthorized.job.state, 'NEEDS_ATTENTION');
  assert.equal(unauthorized.errorCode, 'CARD_ATTEMPT_LIMIT_REACHED');
});
test('media, price and stock business failures retain the specific checkpoint', () => {
  for (const stage of ['MEDIA_UPLOAD', 'PRICE_WRITE', 'STOCK_WRITE']) {
    const step = build(); step.request.stage = stage; step.job.state = stage === 'MEDIA_UPLOAD' ? 'MEDIA_SUBMITTING' : 'PRICE_SUBMITTING';
    const result = handle(step, { error: true, errorText: 'Invalid data' }, 400);
    assert.equal(result.job.state, 'FAILED');
    assert.equal(JSON.parse(result.job.result_json).lastFailureCheckpoint.stage, stage);
  }
});

test('successful retry verifies media, price and stock, finalizes, and recovers a rename-before-persist crash', () => {
  let step = build();
  step.runtime.product = { productCode: '0000172', revision: 4, categoryKey: 'retry_test', priceCny: 100, discountPercent: 0,
    variants: [{ vendorCode: '0000172-01', images: ['image.jpg'], sizes: [{ techSize: '0', barcode: 'original-barcode', stock: 5 }] }] };
  step.runtime.price = {}; step.runtime.stock = {};
  const card = { vendorCode: '0000172-01', nmID: 172, imtID: 172, subjectID: 7, photos: [{ big: 'https://example.com/1.jpg' }],
    sizes: [{ techSize: '0', skus: ['original-barcode'], chrtID: 271, wbSize: '0' }] };
  function advance(stage, body) {
    step.request.stage = stage;
    step.request.lookupVendorCodes = ['0000172-01'];
    const output = handle(step, body);
    step = { ...step, action: 'HTTP_JSON', job: output.job, runtime: JSON.parse(output.job.result_json),
      request: { stage: '', resumeState: output.job.state, requestRef: 'read-' + output.job.state } };
    return output.job.state;
  }
  assert.equal(advance('CARD_WRITE', { error: false }), 'CARD_WAITING');
  assert.equal(advance('CARDS_LIST', { cards: [card], cursor: { total: 1 } }), 'MEDIA_RECONCILING', JSON.stringify({ code: step.job.last_error_code, message: step.job.last_error_message }));
  assert.equal(advance('CARDS_LIST', { cards: [card], cursor: { total: 1 } }), 'PRICE_RECONCILING');
  assert.equal(advance('PRICE_LIST', { data: { listGoods: [{ nmID: 172, currencyIsoCode4217: 'CNY', discount: 0, sizes: [{ price: 100 }] }] } }), 'STOCK_RECONCILING');
  assert.equal(advance('STOCK_LIST', { stocks: [{ chrtId: 271, amount: 5 }] }), 'FINAL_VERIFYING');
  assert.equal(advance('CARDS_LIST', { cards: [card], cursor: { total: 1 } }), 'FINALIZING');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'merchroute-wb-retry-'));
  try {
    const relative = 'processing/' + step.job.task_id;
    fs.mkdirSync(path.join(root, relative), { recursive: true });
    step.job = { ...step.job, work_relpath: relative, product_code: '0000172', revision: 4, payload_signature: 'frozen-signature',
      store_id: 'store', store_alias: 'default', publication_id: 'publication', credential_version_id: 'credential', store_config_version: 1, warehouse_id: '1' };
    const config = { import_root: root, publish_enabled: true };
    const nodes = { 'Build Step': step, 'Get Job': { ...step.job, result_json: JSON.stringify(step.runtime) },
      'Load Runtime Config': config, 'Load Category Template': { category_key: 'retry_test', subject_id: 7, status: 'READY' } };
    const context = { $: name => ({ first: () => ({ json: nodes[name] || {} }), all: () => nodes[name] ? [{ json: nodes[name] }] : [] }),
      $execution: { id: 'local-finalize-test' }, require: name => ({ fs, path, crypto })[name], Buffer };
    const completed = vm.runInNewContext('(function(){' + code('Finalize Directory') + '})()', context)[0].json;
    assert.equal(completed.job.state, 'SUCCEEDED');
    assert.equal(completed.job.task_id, step.job.task_id);
    assert.ok(!fs.existsSync(path.join(root, relative)));
    const recovered = vm.runInNewContext('(function(){' + code('Build Step') + '})()', context)[0].json;
    assert.equal(recovered.action, 'FINALIZE');
    nodes['Build Step'] = recovered;
    const replay = vm.runInNewContext('(function(){' + code('Finalize Directory') + '})()', context)[0].json;
    assert.equal(replay.job.state, 'SUCCEEDED');
    assert.equal(replay.job.work_relpath, completed.job.work_relpath);
    assert.ok(JSON.parse(replay.job.result_json).audit.some(event => event.event === 'FINALIZE_RECOVERED'));
  } finally {
    assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep + 'merchroute-wb-retry-'));
    fs.rmSync(root, { recursive: true, force: true });
  }
});
