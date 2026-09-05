import test from 'node:test';
import assert from 'node:assert/strict';
import { inspectPublishRetries } from './business-gate.mjs';

function client(tables) {
  return {async query(sql,values){
    if(sql.startsWith('SELECT to_regclass'))return {rows:[{name:tables[values[0]]?values[0]:null}]};
    const table=Object.keys(tables).find(name=>sql.endsWith(name));
    assert.ok(table,'Only known retry ledgers may be queried');
    assert.match(sql,/status IN \('CHECKING','RUNNING'\)/);
    assert.match(sql,/lease_until > now\(\)/);
    return {rows:[tables[table]]};
  }};
}
const empty={'public.wb_auto_publish_retries':{active:0,leases:0},'public.ozon_publish_retries':{active:0,leases:0}};
test('old release without new tables remains verifiable; new release requires both migrations',async()=>{
  assert.deepEqual(await inspectPublishRetries(client({}),'0.1.6'),{wbRetryActive:0,wbRetryLeases:0,ozonRetryActive:0,ozonRetryLeases:0});
  await assert.rejects(inspectPublishRetries(client({}),'0.1.7'),/missing/);
  await assert.rejects(inspectPublishRetries(client({'public.wb_auto_publish_retries':{active:0,leases:0}}),'0.1.7'),/ozon_publish_retries/);
  await assert.rejects(inspectPublishRetries(client(empty),''),/known release/);
});
test('WB and OZON retry activity and leases block cutover including rollback to the old release',async()=>{
  for(const version of ['0.1.6','0.1.7'])for(const table of Object.keys(empty))for(const field of ['active','leases']){
    const tables=structuredClone(empty);tables[table][field]=1;
    await assert.rejects(inspectPublishRetries(client(tables),version),/blocked/);
  }
  assert.deepEqual(await inspectPublishRetries(client(empty),'0.1.7'),{wbRetryActive:0,wbRetryLeases:0,ozonRetryActive:0,ozonRetryLeases:0});
});
test('unknown database results and read errors are never interpreted as idle',async()=>{
  const tables=structuredClone(empty);tables['public.wb_auto_publish_retries'].active=undefined;
  await assert.rejects(inspectPublishRetries(client(tables),'0.1.7'),/blocked/);
  await assert.rejects(inspectPublishRetries({query:async()=>{throw new Error('database unavailable')}},'0.1.6'),/unavailable/);
});
