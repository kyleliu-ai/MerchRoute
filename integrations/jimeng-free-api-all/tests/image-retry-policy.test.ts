import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {ImageTaskLedger,submitIdempotentBatch} from '../src/api/services/image-task-ledger.ts';

test('only a confirmed empty failure permits exactly one same-input retry, including after restart',async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'jimeng-policy-retry-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 let ledger=new ImageTaskLedger({storeDir:dir});let calls=0;
 const task={taskId:'one',sourceSubmissionId:'SUB-policy',idempotencyKey:'E001:SUB-policy:one:attempt-0',retryAttempt:0,prompt:'test',policyVersion:'merchroute-image-v1',workflowProfile:'E001'};
 const input=(task:any)=>({ledger,batchKey:'fixed-account',common:{model:'jimeng-4.7',ratio:'1:1',resolution:'2k'},images:['https://fixture.invalid/input.png?secret=signature'],sourceImages:[{sourceFileName:'test.png'}],tokens:['fixture-token'],tasks:[task],uploadImages:async()=>['tos-fixture'],submitTask:async()=>({historyId:'h-'+(++calls)})});
 const retry={...task,retryAttempt:1,idempotencyKey:task.idempotencyKey.replace('attempt-0','attempt-1'),parentIdempotencyKey:task.idempotencyKey};
 await assert.rejects(submitIdempotentBatch(input(retry)),{code:'retry_not_allowed'});
 await submitIdempotentBatch(input(task));
 await assert.rejects(submitIdempotentBatch({...input(task),images:['https://fixture.invalid/changed.png']}),{code:'idempotency_conflict'});
 await assert.rejects(submitIdempotentBatch(input({...task,negativePrompt:'changed negative prompt'})),{code:'idempotency_conflict'});
 await assert.rejects(submitIdempotentBatch(input(retry)),{code:'retry_not_allowed'});
 await ledger.updateFromPoll(task.idempotencyKey,{historyId:'h-1',status:'failed',rawStatus:30,failCode:'generation_failed',imageUrls:[]});
 await assert.rejects(submitIdempotentBatch(input({...retry,prompt:'changed'})),{code:'retry_not_allowed'});
 await assert.rejects(submitIdempotentBatch({...input(retry),images:['https://fixture.invalid/changed.png']}),{code:'retry_not_allowed'});
 ledger=new ImageTaskLedger({storeDir:dir});
 await Promise.all([submitIdempotentBatch(input(retry)),submitIdempotentBatch(input(retry))]);
 assert.equal(calls,2);
 await ledger.updateFromPoll(retry.idempotencyKey,{historyId:'h-2',status:'failed',rawStatus:30,imageUrls:[]});
 await assert.rejects(submitIdempotentBatch(input({...retry,retryAttempt:2,idempotencyKey:task.idempotencyKey.replace('attempt-0','attempt-2')})),{code:'retry_limit_exceeded'});
 assert.equal(calls,2);
 assert.doesNotMatch(fs.readFileSync(path.join(dir,'image-task-store.json'),'utf8'),/fixture-token|secret=signature|fixture.invalid\/input/);
});

test('reference filtering and late queries cannot turn an accepted result into a failure',async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'jimeng-policy-results-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const ledger=new ImageTaskLedger({storeDir:dir});
 const input={ledger,batchKey:'b',common:{model:'jimeng-4.5'},images:['https://fixture.invalid/input.png?sig=1'],sourceImages:[{sourceFileName:'input.png'}],tokens:['fixture-token'],tasks:[{taskId:'t',sourceSubmissionId:'s',idempotencyKey:'k',prompt:'p'}],uploadImages:async()=>['tos'],submitTask:async()=>({historyId:'h'})};
 await submitIdempotentBatch(input);
 let result=await ledger.updateFromPoll('k',{historyId:'h',status:'success',rawStatus:50,imageUrls:['https://fixture.invalid/input.png?sig=2','https://fixture.invalid/output.png']});
 assert.equal(result.count,1);assert.deepEqual(result.imageUrls,['https://fixture.invalid/output.png']);
 result=await ledger.updateFromPoll('k',{historyId:'h',status:'failed',rawStatus:30,imageUrls:[]});assert.equal(result.status,'success');
});
