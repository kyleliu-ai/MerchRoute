import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, access, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { BASELINE, ROOT, assertContainer, assertImage, assertMaintenance, assertStorageQuiescent, assertRecord, digest, profile, safeName, summarize } from './jimeng-deploy-lib.mjs';

const imageId='sha256:'+'1'.repeat(64), oldId='2'.repeat(64);
function record() {
  const files=[{path:'src/fixture.ts',sha256:'3'.repeat(64)}];
  return {schemaVersion:1,baseline:BASELINE,rc:3,imageId,commit:'4'.repeat(40),dirty:true,files,sourceHash:digest(JSON.stringify(files)),platform:'linux/amd64'};
}
function container() {
  return {Id:oldId,Image:imageId,Name:'/fixture',Config:{User:'node',Env:['FIXTURE_SECRET=never-expose'],Labels:{}},
    State:{Running:true,Status:'running',Health:{Status:'healthy'}},HostConfig:{RestartPolicy:{Name:'unless-stopped'},PortBindings:{'8000/tcp':[{HostIp:'127.0.0.1',HostPort:'18001'}]}},
    Mounts:[{Type:'volume',Name:'merchroute-jimeng-test-fixture',Destination:'/app/data',RW:true}]};
}
test('deployment profiles do not allow arbitrary production ports or Docker argument injection',()=>{
  assert.equal(profile('production').port,8000); assert.equal(profile('test').port,18001);
  for(const bad of ['other','8000'])assert.throws(()=>profile(bad));
  for(const bad of ['--privileged','a,b','../data','/root',''])assert.throws(()=>safeName(bad));
});
test('identity verification rejects a healthy container with wrong image, port, mount or user',()=>{
  const valid=container(); assertContainer(valid,record(),valid.Mounts[0].Name,profile('test'));
  const variants=[
    c=>c.Image='sha256:'+'9'.repeat(64), c=>c.Config.User='root',
    c=>c.HostConfig.PortBindings['8000/tcp'][0].HostIp='0.0.0.0',
    c=>c.HostConfig.PortBindings['8000/tcp'][0].HostPort='8000',
    c=>c.Mounts[0].Name='wrong-volume',c=>c.Mounts[0].Type='bind',c=>c.Mounts[0].RW=false,
    c=>c.State.Health.Status='unhealthy',c=>c.HostConfig.RestartPolicy.Name='always',
  ];
  for(const mutate of variants){const c=container();mutate(c);assert.throws(()=>assertContainer(c,record(),'merchroute-jimeng-test-fixture',profile('test')));}
  assert.ok(!JSON.stringify(summarize(valid)).includes('FIXTURE_SECRET'));
});
test('candidate record verifies source manifest and image labels rather than mutable tag',()=>{
  const r=record(); assertRecord(r);
  const image={Id:imageId,Os:'linux',Architecture:'amd64',Config:{Labels:{
    'org.merchroute.jimeng.source-sha256':r.sourceHash,'org.merchroute.jimeng.baseline':BASELINE,
    'org.merchroute.jimeng.rc':'3','org.opencontainers.image.revision':r.commit+'-dirty'}}};
  assertImage(r,image);
  for(const label of Object.keys(image.Config.Labels)){const changed=structuredClone(image);changed.Config.Labels[label]='wrong';assert.throws(()=>assertImage(r,changed));}
  const changed=structuredClone(r);changed.files[0].sha256='8'.repeat(64);assert.throws(()=>assertRecord(changed));
});
test('maintenance evidence is bound to exact identities and expires; missing/unknown is never idle',()=>{
  const c=container(),now=Date.now();
  const gate={containerId:c.Id,imageId:c.Image,volume:'fixture',observedAt:new Date(now).toISOString(),
    newSubmissionsBlocked:true,n8nIdle:true,proxyWorkersIdle:true,unknownSubmissionsResolved:true};
  assertMaintenance(gate,c,'fixture',now);
  for(const key of ['newSubmissionsBlocked','n8nIdle','proxyWorkersIdle','unknownSubmissionsResolved'])assert.throws(()=>assertMaintenance({...gate,[key]:false},c,'fixture',now));
  assert.throws(()=>assertMaintenance(gate,c,'different',now));
  assert.throws(()=>assertMaintenance(gate,c,'fixture',now+300001));
});
test('build dry-run does not create a state directory or contact Docker',async()=>{
  const temporary=await mkdtemp(path.join(os.tmpdir(),'jimeng-dry-run-'));
  const absent=path.join(temporary,'中文 candidate state');
  try {
    const result=spawnSync(process.execPath,['deployment/scripts/jimeng-deploy.mjs','build',`--state-dir=${absent}`,'--rc=3','--dry-run'],{cwd:ROOT,encoding:'utf8',windowsHide:true});
    assert.equal(result.status,0,result.stderr);assert.equal(JSON.parse(result.stdout).dryRun,true);
    await assert.rejects(access(absent));
  } finally {await rm(temporary,{recursive:true,force:true});}
});

test('historical disposition preserves exact records while rejecting new work, changed data and unapproved exceptions',()=>{
  const c=container();c.State.StartedAt='2026-09-08T03:00:00Z';
  const rows=[{keyHash:'a'.repeat(64),recordHash:'b'.repeat(64),status:'submission_unknown',createdAt:'2026-08-08T03:00:00Z',updatedAt:'2026-08-08T03:01:00Z',hasHistoryId:false},
    {keyHash:'c'.repeat(64),recordHash:'d'.repeat(64),status:'processing',createdAt:'2026-09-08T03:10:00Z',updatedAt:'2026-09-08T03:11:00Z',hasHistoryId:true}];
  const storage={contentHash:'e'.repeat(64),stores:{'image-task-store.json':{statuses:{submission_unknown:1,processing:1},nonterminalRecords:rows},'image-upload-store.json':{statuses:{ready:1}}}};
  const gate={historicalDisposition:{schemaVersion:1,containerStartedAt:c.State.StartedAt,storageContentHash:storage.contentHash,preserveRecords:true,forbidReplay:true,approvalReference:'test approval',records:[
    {...rows[0],disposition:'ignore_preserve',explicitlyApproved:true},
    {...rows[1],disposition:'remote_terminal',remoteState:'failed',evidenceSha256:'f'.repeat(64)}]}};
  assertStorageQuiescent(storage,gate,c);
  const cases=[(s,g)=>g.historicalDisposition.records.pop(),(s,g)=>g.historicalDisposition.records.push(g.historicalDisposition.records[0]),
    (s,g)=>g.historicalDisposition.records[0].explicitlyApproved=false,(s,g)=>g.historicalDisposition.records[0].recordHash='0'.repeat(64),
    (s,g)=>g.historicalDisposition.approvalReference='',(s,g)=>g.historicalDisposition.forbidReplay=false,
    (s,g)=>g.historicalDisposition.storageContentHash='0'.repeat(64),(s,g)=>g.historicalDisposition.containerStartedAt='wrong',
    s=>s.stores['image-task-store.json'].statuses.reserved=1,s=>s.stores['image-upload-store.json'].statuses.uploading=1,
    s=>s.stores['image-task-store.json'].nonterminalRecords[0].updatedAt='2026-09-08T03:20:00Z',
    (s,g)=>g.historicalDisposition.records[1].remoteState='processing',
    (s,g)=>g.historicalDisposition.records[1].disposition='ignore_preserve'];
  for(const mutate of cases){const s=structuredClone(storage),g=structuredClone(gate);mutate(s,g);assert.throws(()=>assertStorageQuiescent(s,g,c));}
  assert.throws(()=>assertStorageQuiescent(storage,{},c));
  assertStorageQuiescent({stores:{'image-task-store.json':{statuses:{success:5}}}}, {},c);
});
