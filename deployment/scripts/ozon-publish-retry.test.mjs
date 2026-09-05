import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const workflow = JSON.parse(readFileSync(new URL('../n8n/workflows/ozon/g3KK68BLXX7eShqa.json', import.meta.url), 'utf8'));
const code = name => workflow.nodes.find(node => node.name === name).parameters.jsCode;

test('P002 import recovery must flow through authoritative price-stock readback before writes', () => {
  const targets = name => workflow.connections[name].main.flat().map(edge => edge.node);
  assert(targets('恢复导入可写入').includes('构建价格库存回读'));
  assert(targets('分析价格库存回读').includes('仍需价格库存写入'));
  assert(targets('仍需价格库存写入').includes('构建恢复价格库存写入'));
});

test('existing P002 pending builder never replays an already successful offer', () => {
  const context = {
    jobId: '11111111-1111-4111-8111-111111111111', taskId: 'default__9900171__r1', rowVersion: 5,
    product: { warehouseId: '12345', currency: 'RUB', offers: [{ offerId: 'a', price: 400, stock: 1 }, { offerId: 'b', price: 500, stock: 2 }] },
    jobPayload: { priceStockWriteProgress: {
      pricesWrite: { succeededOfferIds: ['a'], pendingOfferIds: ['b'], failedOfferIds: [] },
      stocksWrite: { succeededOfferIds: ['a', 'b'], pendingOfferIds: [], failedOfferIds: [] }
    } }
  };
  const sandbox = { require, $input: { all: () => [{ json: context }] } };
  const result = vm.runInNewContext('(function(){' + code('构建恢复价格库存写入') + '})()', sandbox);
  assert.equal(result.length, 1);
  assert.equal(result[0].json.operation, 'pricesWrite');
  assert.deepEqual(JSON.parse(JSON.stringify(result[0].json.requestedOfferIds)), ['b']);
});

test('frozen import recovery selects read-only importInfo or infoList, never importProduct', () => {
  const source = code('准备恢复导入查询');
  assert(source.includes("hasImportTaskId ? 'importInfo' : 'infoList'"));
  assert(!source.includes("operation: 'importProduct'"));
  assert(code('分析恢复导入状态').includes('OZON_IMPORT_ABSENCE_CONFIRMATION_PENDING'));
});
