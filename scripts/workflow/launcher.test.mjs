import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { execFileSync, spawn } from 'node:child_process';
import { createServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { digest } from '../lib/installed-release.mjs';
import { atomicJson, recoverCommandLock } from './state.mjs';
import { npmForNode } from './toolchain.mjs';
import { verifyDevelopmentDatabase } from './development-database.mjs';
import { verifyLegacyRelease } from './legacy-release.mjs';
import { testEnvironment } from './verify.mjs';
import { probeReadOnlyPages } from './read-only-pages.mjs';
import { candidateSnapshot, assertAcceptedCandidate } from './candidate-acceptance.mjs';
import { switchRelease } from './release-transaction.mjs';
import { assertAboutIdentity, assertRecoverablePreStopJournal, assertV014OperatorHardening, createPublishedBinding, downloadAcceptedArtifact, stopProcessInput } from './release.mjs';

test('release stop payload retains the verified runtime endpoint',()=>{
  const binding={schemaVersion:2,root:'C:/发布包',nodePath:'C:/工具/node.exe',runtimeEndpoint:{host:'127.0.0.1',port:43173,origin:'http://127.0.0.1:43173'}};
  const live={pid:1234,createdAt:'2026-09-04T00:00:00.000Z',entry:'C:/release/apps/server/dist/index.js',nodePath:'C:/wrong/node.exe'};
  assert.deepEqual(stopProcessInput(binding,live),{
    pid:live.pid,createdAt:live.createdAt,entry:path.join(binding.root,'apps/server/dist/index.js'),nodePath:binding.nodePath,runtimeEndpoint:binding.runtimeEndpoint
  });
  assert.equal(live.runtimeEndpoint,undefined,'the inspected process record must remain immutable');
  assert.throws(()=>stopProcessInput(binding,{...live,createdAt:''}),/incomplete/);
});

test('v0.1.4 operator hardening accepts only the exact local release-tool patch',()=>{
  const commit='2b4d9ff3c9cd479bb8be3a4e726c0f2db30adb3b',tree='8793bb5338ed659748afae6e4ad68db3a9a90114';
  const status=['M AGENTS.md',' M scripts/release-windows.ps1',' M scripts/workflow/launcher.test.mjs',' M scripts/workflow/publish.mjs',' M scripts/workflow/release.mjs'].join('\n');
  const identity={commit,tree,status},candidate={sourceCommit:commit,sourceTree:tree,productVersion:'0.1.4'};
  assert.equal(assertV014OperatorHardening(identity,candidate,'v0.1.4-prestop-unicode').length,5);
  assert.throws(()=>assertV014OperatorHardening({...identity,status:status+'\n M apps/server/src/app.ts'},candidate,'v0.1.4-prestop-unicode'),/outside/);
  assert.throws(()=>assertV014OperatorHardening(identity,candidate,'wrong-mode'),/not bound/);
});

test('published binding upgrades a schema v1 candidate after all spread fields are applied',()=>{
  const endpoint={host:'127.0.0.1',port:43173,origin:'http://127.0.0.1:43173'};
  const binding=createPublishedBinding({schemaVersion:1,productVersion:'0.1.4'},{schemaVersion:1,runtimeEndpoint:endpoint,nodePath:'C:/node.exe'});
  assert.equal(binding.schemaVersion,2);assert.deepEqual(binding.runtimeEndpoint,endpoint);
  assert.throws(()=>createPublishedBinding({schemaVersion:1},{}),/explicit runtime endpoint/);
});

test('release asset download retries transient failures but never retries a hash mismatch',async()=>{
  const bytes=Buffer.from('accepted asset'),artifact={sha256:digest(bytes)},asset={browser_download_url:'https://example.invalid/asset'};
  let attempts=0;
  const fetchImpl=async()=>{attempts++;if(attempts<3)throw new Error('temporary network failure');return new Response(bytes)};
  assert.deepEqual(await downloadAcceptedArtifact(asset,artifact,{fetchImpl,sleep:async()=>{}}),{attempts:3,bytes:bytes.length});
  attempts=0;
  await assert.rejects(downloadAcceptedArtifact(asset,artifact,{fetchImpl:async()=>{attempts++;return new Response('tampered')},sleep:async()=>{}}),/differs/);
  assert.equal(attempts,1);
});

test('legacy rollback accepts an old About response without runtimeEndpoint but new releases do not',()=>{
  const current={commitSha:'a'.repeat(40),productVersion:'0.1.0'};
  const legacy={legacy:true,schemaVersion:2,sourceCommit:current.commitSha,productVersion:current.productVersion,runtimeEndpoint:{host:'127.0.0.1',port:43173,origin:'http://127.0.0.1:43173'}};
  assert.equal(assertAboutIdentity(legacy,{current,runtimeStatus:'CURRENT'}),true);
  const release={...legacy,legacy:false,productVersion:'0.1.4'};
  const releaseCurrent={...current,productVersion:'0.1.4'};
  assert.throws(()=>assertAboutIdentity(release,{current:releaseCurrent,runtimeStatus:'CURRENT'}),/identity mismatch/);
  assert.equal(assertAboutIdentity(release,{current:{...releaseCurrent,runtimeEndpoint:release.runtimeEndpoint},runtimeStatus:'CURRENT'}),true);
});

test('a failed cutover journal can be retried only after proving the old runtime was never stopped',()=>{
  const previous={root:'C:/legacy',sourceCommit:'a'.repeat(40),productVersion:'0.1.0'};
  const journal={state:'FAILED',previous:{...previous},candidate:{sourceCommit:'b'.repeat(40)},error:'stop adapter failed'};
  const proof={previous,currentLive:{pid:5804,createdAt:'2026-09-04T00:00:00.000Z'},expectedPid:5804,pointerExists:false,acceptedCommit:previous.sourceCommit};
  assert.equal(assertRecoverablePreStopJournal(journal,proof),true);
  assert.throws(()=>assertRecoverablePreStopJournal(journal,{...proof,pointerExists:true}),/not a proven pre-stop/);
  assert.throws(()=>assertRecoverablePreStopJournal(journal,{...proof,currentLive:{stopped:true}}),/not a proven pre-stop/);
  assert.throws(()=>assertRecoverablePreStopJournal({...journal,state:'RECOVERY_REQUIRED'},proof),/not a proven pre-stop/);
});

test('acceptance pins the exact package and artifacts, not only the source commit',()=>{
  const candidate={id:'fixture',productVersion:'0.1.4',root:path.resolve('fixture-release'),artifactRoot:path.resolve('fixture-artifacts'),sourceCommit:'a'.repeat(40),sourceTree:'b'.repeat(40),manifestSha256:'c'.repeat(64),artifacts:[{name:'source.zip',sha256:'d'.repeat(64)}]};
  const accepted=candidateSnapshot(candidate);assert.deepEqual(assertAcceptedCandidate(candidate,accepted),accepted);
  assert.throws(()=>assertAcceptedCandidate({...candidate,manifestSha256:'e'.repeat(64)},accepted),/accepted build/);
  assert.throws(()=>assertAcceptedCandidate({...candidate,artifacts:[{name:'source.zip',sha256:'e'.repeat(64)}]},accepted),/accepted build/);
  assert.throws(()=>assertAcceptedCandidate(candidate,undefined),/missing/);
});

for(const failure of ['accept','journal'])test('acceptance '+failure+' failure cannot roll back beneath a possibly committed record',async()=>{
  const calls=[];
  const adapters={previous:{id:'old'},candidate:{id:'new'},check:async()=>{},stop:async b=>calls.push('stop:'+b.id),bind:async b=>calls.push('bind:'+b.id),start:async()=>({pid:1}),probe:async()=>{},
    accept:async()=>{calls.push('accepted-write');if(failure==='accept')throw Error('accept failed');},
    journal:async r=>{calls.push(r.state);if(failure==='journal'&&r.state==='ACCEPTED')throw Error('journal failed');},rollbackCheck:async()=>calls.push('rollback')};
  await assert.rejects(switchRelease(adapters),/failed/);
  assert.equal(calls.includes('rollback'),false);assert.equal(calls.includes('bind:old'),false);assert.equal(calls.at(-1),'RECOVERY_REQUIRED');
});

test('runtime page probes request the browser HTML contract and reject non-page responses',async()=>{
  const seen=[];
  const fetchPage=async(url,options)=>{
    seen.push(url);assert.equal(options.headers.Accept,'text/html');
    return new Response('<html><div id="root"></div></html>',{status:200,headers:{'content-type':'text/html; charset=utf-8'}});
  };
  assert.deepEqual(await probeReadOnlyPages('http://127.0.0.1:4183',fetchPage),{pages:3});
  assert.equal(seen.length,3);
  await assert.rejects(probeReadOnlyPages('https://example.invalid',fetchPage),/Unapproved/);
  await assert.rejects(probeReadOnlyPages('http://127.0.0.1:4183',async()=>new Response('{}',{headers:{'content-type':'application/json'}})),/page failed/);
  await assert.rejects(probeReadOnlyPages('http://127.0.0.1:4183',async()=>new Response('wrong page',{headers:{'content-type':'text/html'}})),/application shell/);
});

test('full local regression bounds workers without relaxing timeouts or inheriting credentials',()=>{
  const env=testEnvironment({VITEST_MAX_THREADS:'100',VITEST_MAX_FORKS:'100',MERCHROUTE_ENV_FILE:'production',DATABASE_URL:'production'},'synthetic','cleanup');
  assert.equal(env.VITEST_MAX_THREADS,'2');assert.equal(env.VITEST_MAX_FORKS,'2');
  assert.equal(env.VITEST_MIN_THREADS,'1');assert.equal(env.VITEST_MIN_FORKS,'1');
  assert.equal(env.MERCHROUTE_ENV_FILE,undefined);assert.equal(env.DATABASE_URL,'synthetic');
});

test('docs preserve local authority, serial ownership, phase boundary and production isolation',async()=>{
  const root=path.resolve(import.meta.dirname,'../..');
  for(const file of ['AGENTS.md','docs/SINGLE_DEVELOPER_WORKFLOW.zh-CN.md','deployment/AGENT_INSTALL_PROMPT.zh-CN.md','deployment/AGENT_UPDATE_PROMPT.zh-CN.md']){
    const text=await readFile(path.join(root,file),'utf8');
    for(const marker of ['批次','43173','4184','0.1.4'])assert.ok(text.includes(marker),file+' missing '+marker);
  }
  const vite=await readFile(path.join(root,'apps/web/vite.config.ts'),'utf8');assert.ok(vite.includes('http://127.0.0.1:4184'));assert.ok(!vite.includes(':4173'));assert.ok(vite.includes('strictPort: true'));
});
test('stale-lock recovery requires exact hash and explicit approval',async t=>{
  const home=await mkdtemp(path.join(os.tmpdir(),'merchroute-lock-recovery-'));t.after(()=>rm(home,{recursive:true,force:true}));
  const file=path.join(home,'command.lock');await atomicJson(file,{pid:2147483647,token:'fixture'});const pin=digest(await readFile(file));
  await assert.rejects(recoverCommandLock(home,{'lock-sha256':'bad'}),/identity/);
  await assert.rejects(recoverCommandLock(home,{'lock-sha256':pin}),/requires/);
  assert.equal((await recoverCommandLock(home,{'lock-sha256':pin,'dry-run':true})).recoverable,true);
  assert.equal((await recoverCommandLock(home,{'lock-sha256':pin,apply:true,approved:true})).recovered,true);
});
if(process.platform==='win32')for(const shell of ['powershell.exe','pwsh']){
  test('fixed launcher parses and refuses changed bindings in '+shell,async t=>{
    const root=await mkdtemp(path.join(os.tmpdir(),'merchroute-launcher-test-'));t.after(()=>rm(root,{recursive:true,force:true}));
    await mkdir(path.join(root,'scripts'));const entry=path.join(root,'scripts/release-runtime.mjs');await writeFile(entry,'throw new Error("must not execute")');
    const pointer=path.join(root,'pointer.json'),binding={schemaVersion:2,root,nodePath:process.execPath,nodeSha256:digest(await readFile(process.execPath)),launcherSha256:digest(await readFile(entry)),runtimeEndpoint:{host:'127.0.0.1',port:43173,origin:'http://127.0.0.1:43173'}};
    binding.bootstrapHashes={};
    for(const file of ['scripts/release-runtime.mjs','scripts/lib/installed-release.mjs','scripts/workflow/development.mjs','scripts/workflow/state.mjs']){
      const target=path.join(root,file);await mkdir(path.dirname(target),{recursive:true});if(target!==entry)await writeFile(target,'// fixture');binding.bootstrapHashes[file]=digest(await readFile(target));
    }
    await atomicJson(pointer,binding);const script=path.resolve(import.meta.dirname,'../Start-MerchRoute.ps1');
    const run=()=>execFileSync(shell,['-NoProfile','-File',script,'-ReleasePointer',pointer,'-CheckOnly'],{encoding:'utf8',windowsHide:true,stdio:['ignore','pipe','pipe']});
    assert.match(run(),/Launcher binding verified/);await writeFile(path.join(root,'scripts/lib/installed-release.mjs'),'changed verifier');assert.throws(run);
  });
}
if(process.platform==='win32')for(const shell of ['powershell.exe','pwsh'])test('Windows release adapter preserves Chinese paths and stops only the inspected process in '+shell,async t=>{
  const temporaryRoot=await mkdtemp(path.join(os.tmpdir(),'merchroute-stop-adapter-'));t.after(()=>rm(temporaryRoot,{recursive:true,force:true}));
  const root=path.join(temporaryRoot,'中文路径');await mkdir(root);
  let port=0;
  for(let candidate=43800;candidate<43900&&!port;candidate++){
    const server=createServer();
    try{await new Promise((resolve,reject)=>server.once('error',reject).listen(candidate,'127.0.0.1',resolve));port=candidate;}catch{/* Try the next bounded test port. */}
    finally{if(server.listening)await new Promise(resolve=>server.close(resolve));}
  }
  assert.ok(port,'no bounded fixture port is available');
  const entry=path.join(root,'apps/server/dist/index.js');await mkdir(path.dirname(entry),{recursive:true});
  await writeFile(entry,"import{createServer}from'node:net';createServer((_q,r)=>r.end('ok')).listen(Number(process.argv[2]),'127.0.0.1',()=>console.log('READY'));\n");
  const child=spawn(process.execPath,[entry,String(port)],{windowsHide:true,stdio:['ignore','pipe','pipe']});
  t.after(()=>{if(child.exitCode===null)child.kill();});
  await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('fixture server did not start')),10000);child.once('error',reject);child.stdout.on('data',data=>{if(data.toString().includes('READY')){clearTimeout(timer);resolve();}});});
  const binding={schemaVersion:2,root,nodePath:process.execPath,runtimeEndpoint:{host:'127.0.0.1',port,origin:'http://127.0.0.1:'+port}};
  const inspectFile=path.join(root,'inspect.json');await atomicJson(inspectFile,{entry,nodePath:process.execPath,runtimeEndpoint:binding.runtimeEndpoint});
  const adapter=path.resolve(import.meta.dirname,'../release-windows.ps1');
  const live=JSON.parse(execFileSync(shell,['-NoProfile','-File',adapter,'-Action','Inspect','-InputFile',inspectFile],{encoding:'utf8',windowsHide:true}));
  assert.equal(live.pid,child.pid);
  const stopFile=path.join(root,'stop.json');await atomicJson(stopFile,stopProcessInput(binding,live));
  execFileSync(shell,['-NoProfile','-File',adapter,'-Action','Stop','-InputFile',stopFile],{encoding:'utf8',windowsHide:true});
  await new Promise(resolve=>child.once('exit',resolve));
  assert.notEqual(child.exitCode,null);
});
test('npm lookup supports Windows and macOS archive layouts without relying on PATH',async t=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'merchroute-toolchain-test-'));t.after(()=>rm(root,{recursive:true,force:true}));
  for(const [binary,npm] of [['windows/node.exe','windows/node_modules/npm/bin/npm-cli.js'],['mac/bin/node','mac/lib/node_modules/npm/bin/npm-cli.js']]){
    await mkdir(path.dirname(path.join(root,npm)),{recursive:true});await writeFile(path.join(root,npm),'// fixture');assert.equal(await npmForNode(path.join(root,binary)),path.join(root,npm));
  }
  await assert.rejects(npmForNode(path.join(root,'missing/node')),/not found/);
});
test('missing local database input and missing legacy inventory fail before service mutation',async t=>{
  const home=await mkdtemp(path.join(os.tmpdir(),'merchroute-preflight-test-'));t.after(()=>rm(home,{recursive:true,force:true}));
  await assert.rejects(verifyDevelopmentDatabase(path.resolve(import.meta.dirname,'../..'),home),/not initialized/);
  await assert.rejects(verifyLegacyRelease({legacy:true}),/inventory is missing/);
});
