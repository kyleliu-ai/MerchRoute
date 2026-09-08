import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import taskArchive from '../src/api/services/image-task-archive.mjs';
import { ImageTaskLedger, queryIdempotentBatch, reserveIdempotentBatchForAsync, submitIdempotentBatch } from '../src/api/services/image-task-ledger.ts';
import { seedArchive } from './helpers/archive-fixture.ts';

function fixture(t: test.TestContext, execute = true) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), '即梦 archive '));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return { dir, ...seedArchive(dir, execute) };
}
const forbidden = async () => { throw new Error('Unexpected remote/upload IO'); };

test('archive preserves original records, survives restart and unrelated writes, and restores with the volume', async t => {
  const {dir,records,approval,storeFile} = fixture(t);
  const before = fs.readFileSync(storeFile, 'utf8');
  assert.equal(taskArchive.archiveTasks({storeDir:dir,approval,execute:true}).reused,true);
  assert.equal(fs.readFileSync(storeFile,'utf8'),before);
  const ledger = new ImageTaskLedger({storeDir:dir});
  await ledger.reserve({taskId:'new',idempotencyKey:'new',requestHash:'new',tokenFingerprint:'new',context:{}});
  const persisted = JSON.parse(fs.readFileSync(storeFile,'utf8'));
  for (const row of records) assert.deepEqual(persisted.records.find((r:any)=>r.idempotencyKey===row.idempotencyKey),row);
  const restored = path.join(dir,'恢复卷');fs.mkdirSync(restored);
  for(const name of ['image-task-store.json',taskArchive.ARCHIVE_FILE]) fs.copyFileSync(path.join(dir,name),path.join(restored,name));
  const restarted = new ImageTaskLedger({storeDir:restored});
  for(const row of records) {
    assert.equal(restarted.get(row.idempotencyKey)?.status,row.status);
    assert.equal(restarted.get(row.idempotencyKey)?.localDisposition?.state,'archived_no_replay');
    assert.throws(()=>restarted.assertNotArchived(row.idempotencyKey), /禁止重新提交/);
  }
});

test('same key, changed request, associated retry and low-level submission cannot replay archives', async t => {
  const {dir,records} = fixture(t), ledger=new ImageTaskLedger({storeDir:dir});
  for(const row of records) {
    for(const requestHash of [row.requestHash,'changed']) await assert.rejects(ledger.reserve({...row,requestHash}),{code:'task_archived_no_replay'});
    await assert.rejects(ledger.reserve({...row,idempotencyKey:row.idempotencyKey.replace('attempt-0','attempt-1'),context:{retryAttempt:1}}),{code:'task_archived_no_replay'});
    await assert.rejects(ledger.reserve({...row,idempotencyKey:'new-key',context:{parentIdempotencyKey:row.idempotencyKey}}),{code:'task_archived_no_replay'});
    await assert.rejects(ledger.submitReserved(row.idempotencyKey,row.requestHash,forbidden),{code:'task_archived_no_replay'});
    await assert.rejects(ledger.setAsyncBatchMetrics(row.idempotencyKey,row.requestHash,{cacheHit:true,uploadDurationMs:1}),{code:'task_archived_no_replay'});
    const input={ledger,batchKey:'archived',tasks:[{taskId:row.taskId,idempotencyKey:row.idempotencyKey,prompt:'offline fixture',sourceSubmissionId:'SUB-archived'}],common:{},
      sourceImages:[{sourceFileName:'中文.png'}],images:['https://fixture.invalid/source.png'],tokens:['token-archive'],uploadImages:forbidden,submitTask:forbidden};
    await assert.rejects(submitIdempotentBatch(input),{code:'task_archived_no_replay'});
    await assert.rejects(reserveIdempotentBatchForAsync({...input,uploadKey:'archive-upload',tokenFingerprint:row.tokenFingerprint}),{code:'task_archived_no_replay'});
  }
});

test('archived status never polls or becomes success; active tasks in mixed batches still poll', async t => {
  const {dir,records,storeFile} = fixture(t), ledger=new ImageTaskLedger({storeDir:dir});
  const before=fs.readFileSync(storeFile,'utf8');
  const status=await queryIdempotentBatch({ledger,tasks:records,tokens:['unused'],queryTask:forbidden});
  assert.equal(status.archivedCount,3);assert.equal(status.pendingCount,0);assert.equal(status.successCount,0);
  assert.equal(status.failedCount,0);assert.equal(status.unknownCount,0);assert.equal(status.allTerminal,true);
  assert.equal(status.terminalCount,3);assert.ok(status.tasks.every(t=>t.canRetry===false));
  assert.ok(status.tasks.every(t=>!('tokenFingerprint' in t)));
  await ledger.updateFromPoll(records[2].idempotencyKey,{historyId:'original-history',status:'success',imageUrls:['https://fixture.invalid/new.png']});
  assert.equal(fs.readFileSync(storeFile,'utf8'),before);
  await ledger.reserve({taskId:'new',idempotencyKey:'new',requestHash:'new',tokenFingerprint:records[0].tokenFingerprint,context:{}});
  await ledger.submitReserved('new','new',async()=>({historyId:'new-history'}));
  let polls=0;
  const mixed=await queryIdempotentBatch({ledger,tasks:[...records,{idempotencyKey:'new'}],tokens:['token-archive'],queryTask:async historyId=>{
    polls++;assert.equal(historyId,'new-history');return {historyId,status:'processing'};
  }});
  assert.equal(polls,1);assert.equal(mixed.archivedCount,3);assert.equal(mixed.pendingCount,1);assert.equal(mixed.allTerminal,false);
});

test('unapproved keys, reservations, changed hashes and expired approvals fail without writes', t => {
  const {dir,approval,storeFile}=fixture(t,false), before=fs.readFileSync(storeFile,'utf8');
  for(const mutate of [
    (a:any)=>a.records[0].keyHash='0'.repeat(64),(a:any)=>a.records[0].recordHash='0'.repeat(64),
    (a:any)=>a.records.push(a.records[0]),(a:any)=>a.forbidReplay=false,
    (a:any)=>a.expiresAt='2000-01-01T00:00:00Z',(a:any)=>a.approvalReference='',(a:any)=>a.storeSha256='0'.repeat(64),
  ]) {const a=structuredClone(approval);mutate(a);assert.throws(()=>taskArchive.archiveTasks({storeDir:dir,approval:a,execute:true}));}
  assert.equal(fs.readFileSync(storeFile,'utf8'),before);assert.equal(fs.existsSync(path.join(dir,taskArchive.ARCHIVE_FILE)),false);
  assert.equal(taskArchive.archiveTasks({storeDir:dir,approval}).dryRun,true);
  assert.equal(fs.readFileSync(storeFile,'utf8'),before);
  const store=JSON.parse(before);store.records[0].status='reserved';fs.writeFileSync(storeFile,JSON.stringify(store));
  const a={...approval,storeSha256:taskArchive.sha(fs.readFileSync(storeFile)),records:store.records.map((r:any)=>({keyHash:taskArchive.keyDigest(r.idempotencyKey),recordHash:taskArchive.recordDigest(r)}))};
  assert.throws(()=>taskArchive.archiveTasks({storeDir:dir,approval:a,execute:true}));
});

test('missing, corrupt or changed archive/ledger binding refuses startup, including orphaned tombstones', t => {
  for(const mode of ['archive-missing','archive-corrupt','archive-changed','record-changed','ledger-missing']) {
    const {dir,storeFile}=fixture(t), archiveFile=path.join(dir,taskArchive.ARCHIVE_FILE);
    if(mode==='archive-missing')fs.unlinkSync(archiveFile);
    if(mode==='archive-corrupt')fs.writeFileSync(archiveFile,'{');
    if(mode==='archive-changed'){const a=JSON.parse(fs.readFileSync(archiveFile,'utf8'));a.records[0].forbidReplay=false;fs.writeFileSync(archiveFile,JSON.stringify(a));}
    if(mode==='record-changed'){const s=JSON.parse(fs.readFileSync(storeFile,'utf8'));s.records[0].status='processing';fs.writeFileSync(storeFile,JSON.stringify(s));}
    if(mode==='ledger-missing')fs.unlinkSync(storeFile);
    assert.throws(()=>new ImageTaskLedger({storeDir:dir}));
  }
});

test('interrupted binding fails closed and exact approved retry repairs it without changing task rows', t => {
  const {dir,approval,storeFile,records}=fixture(t,false), original=fs.readFileSync(storeFile,'utf8');
  taskArchive.archiveTasks({storeDir:dir,approval,execute:true});
  fs.writeFileSync(storeFile,original); // Crash after archive rename, before ledger rename.
  assert.throws(()=>new ImageTaskLedger({storeDir:dir}));
  taskArchive.archiveTasks({storeDir:dir,approval,execute:true});
  assert.deepEqual(JSON.parse(fs.readFileSync(storeFile,'utf8')).records,records);
  assert.equal(new ImageTaskLedger({storeDir:dir}).get(records[0].idempotencyKey)?.localDisposition?.forbidReplay,true);
});

test('legacy array stores archive without losing rows or requiring a history ID for unknown submissions', t => {
  const {dir,approval,storeFile,records}=fixture(t,false);
  fs.writeFileSync(storeFile,JSON.stringify(records));
  approval.storeSha256=taskArchive.sha(fs.readFileSync(storeFile));
  taskArchive.archiveTasks({storeDir:dir,approval,execute:true});
  assert.deepEqual(JSON.parse(fs.readFileSync(storeFile,'utf8')).records,records);
  assert.equal(new ImageTaskLedger({storeDir:dir}).get(records[0].idempotencyKey)?.historyId,'');
});
