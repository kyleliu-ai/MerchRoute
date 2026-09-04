import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, mkdir, writeFile, readFile, rm, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createServer } from 'node:net';
import { beginBatch } from '../workflow.mjs';
import { atomicJson, git, withCommandLock, registration } from './state.mjs';
import { developmentEnvironment, blockDevelopmentOutbound, assertPortFree } from './development.mjs';
import { inventoryRelease, verifyInstalledRelease, digest, gitBlob, safeRelative } from '../lib/installed-release.mjs';
import { switchRelease } from './release-transaction.mjs';
import { validateV012Rollover } from './publish.mjs';
import { assertNoActivity } from './business-gate.mjs';
import { validateManifest, compareBranchInventory } from '../verify-release-completeness.mjs';
import { candidateSnapshot, verifyAcceptedCandidate } from './candidate-acceptance.mjs';
import { commandTranscript, fixedPortE2eDockerArgs } from './verify.mjs';
import { captureCommand } from '../run-ci-check.mjs';

test('silent successful commands keep actual capture metadata and failing output is preserved',async()=>{
  const argv=[process.execPath,'-e','process.exit(0)'];
  const result=await captureCommand(argv[0],argv.slice(1),{cwd:process.cwd()});
  assert.equal(result.exitCode,0);assert.equal(result.output.length,0);
  const transcript=commandTranscript(argv,result).toString();
  const metadata=JSON.parse(transcript.split('\n')[0].slice('# Command capture: '.length));
  assert.deepEqual(metadata,{argv,exitCode:0,signal:null,outputBytes:0,oversized:false});
  assert.equal(transcript.split('\n').slice(1).join('\n'),'');
  const failed=commandTranscript(argv,{...result,exitCode:1,output:Buffer.from('actual failure')});
  assert.match(failed.toString(),/"exitCode":1/);assert.ok(failed.toString().endsWith('actual failure'));
});

test('both Jimeng regression entrypoints retain isolated tests with bounded file concurrency',async()=>{
  const publicRunner=await readFile(new URL('../../deployment/scripts/run-jimeng-tests.mjs',import.meta.url),'utf8');
  const evidenceRunner=await readFile(new URL('../ci-regression-tests.mjs',import.meta.url),'utf8');
  for(const source of [publicRunner,evidenceRunner]){
    assert.match(source,/'--test', '--test-concurrency=1', '--test-reporter=(?:dot|tap)'/);
    assert.doesNotMatch(source,/--experimental-test-isolation=none|--test-name-pattern/);
    assert.match(source,/\.endsWith\('\.test\.ts'\)/);
  }
});

async function temporary(t){const dir=await realpath(await mkdtemp(path.join(os.tmpdir(),'merchroute-workflow-test-')));t.after(()=>rm(dir,{recursive:true,force:true}));return dir;}
async function fixture(t){
  const base=await temporary(t),root=path.join(base,'repo'),home=path.join(base,'external');await mkdir(root);await mkdir(home);
  const g=(...args)=>git(root,...args);g('init');g('config','user.name','MerchRoute Test');g('config','user.email','test@example.invalid');g('config','commit.gpgsign','false');
  await mkdir(path.join(root,'config'));await atomicJson(path.join(root,'config/release-features.json'),{completedBatches:[]});g('add','config/release-features.json');g('commit','-m','fixture');
  const baseline={commit:g('rev-parse','HEAD'),tree:g('rev-parse','HEAD^{tree}')};
  await atomicJson(path.join(home,'machine.json'),{schemaVersion:1,sourceAuthority:'LOCAL',devRoot:root,baseline});return {root,home,baseline,g};
}
test('two serial batches use the same directory and one worktree; dirty and other owners are blocked',async t=>{
  const {root,home,baseline,g}=await fixture(t);
  const options={name:'first',baseline:baseline.commit,'task-id':'task-1',apply:true,approved:true};
  assert.equal((await beginBatch(root,home,{...options,'dry-run':true})).dryRun,true);
  assert.equal(g('branch','--list','work/*'),'');
  const first=await beginBatch(root,home,options);assert.equal(first.created,true);
  await writeFile(path.join(root,'work.txt'),'draft');
  assert.equal((await beginBatch(root,home,options)).resumed,true);
  await assert.rejects(beginBatch(root,home,{...options,'task-id':'another'}),/different batch/);
  await atomicJson(path.join(home,'batch.json'),{...first.batch,status:'CLOSED',acceptedCommit:baseline.commit});
  await assert.rejects(beginBatch(root,home,{...options,name:'second','task-id':'task-2'}),/Uncommitted/);
  await rm(path.join(root,'work.txt'));
  const second=await beginBatch(root,home,{...options,name:'second','task-id':'task-2'});assert.equal(second.created,true);
  assert.equal(g('worktree','list','--porcelain').split('\n').filter(x=>x.startsWith('worktree ')).length,1);
  assert.equal(JSON.parse(await readFile(path.join(root,'config/release-features.json'))).completedBatches[0].name,first.batch.branch);
});
test('command lease rejects simultaneous writers and does not steal stale locks',async t=>{
  const base=await temporary(t);
  await withCommandLock(base,async()=>{await assert.rejects(withCommandLock(base,async()=>{}),/lock exists/);});
  await atomicJson(path.join(base,'command.lock'),{pid:2147483647,token:'stale'});
  await assert.rejects(withCommandLock(base,async()=>{}),/stale lock/);
});
test('registered repository rejects Git alternates',async t=>{
  const {root,home}=await fixture(t);await registration(root,home);
  await writeFile(path.join(root,'.git/objects/info/alternates'),'/unknown');await assert.rejects(registration(root,home),/alternates/);
});
test('development environment never inherits production secrets, ports or configuration',()=>{
  const sandboxRoot=path.resolve(os.tmpdir(),'merchroute-development-test');
  const config={databaseUrl:'postgresql://merchroute_dev_app:synthetic@127.0.0.1:5432/merchroute_dev',sandboxRoot};
  const env=developmentEnvironment(config,{MERCHROUTE_ENV_FILE:'/production',DATABASE_URL:'production',PORT:'43173',WB_API_TOKEN:'private',NODE_OPTIONS:'unsafe'});
  assert.equal(env.PORT,'4184');assert.equal(env.MERCHROUTE_ENV_FILE,undefined);assert.equal(env.WB_API_TOKEN,undefined);assert.equal(env.NODE_OPTIONS,undefined);
  assert.throws(()=>developmentEnvironment({...config,databaseUrl:config.databaseUrl.replace('/merchroute_dev','/merchroute')}),/dedicated/);
  assert.throws(()=>developmentEnvironment({...config,databaseUrl:config.databaseUrl.replace('127.0.0.1','example.com')}),/dedicated/);
  const stable={...config,runtimeKey:'0'.repeat(40),encryptionKey:Buffer.alloc(32).toString('base64')};
  assert.equal(developmentEnvironment(stable,{}).MERCHROUTE_RUNTIME_KEY,developmentEnvironment(stable,{}).MERCHROUTE_RUNTIME_KEY);
  assert.equal(developmentEnvironment(stable,{}).MERCHROUTE_CREDENTIAL_ENCRYPTION_KEY,stable.encryptionKey);
});
test('development default blocks real HTTP and fetch requests',async()=>{
  const restore=blockDevelopmentOutbound();try{await assert.rejects(fetch('https://example.invalid'),/BLOCKED/);assert.throws(()=>http.get('https://example.invalid'),/BLOCKED/);}finally{restore();}
});
test('port conflict is an error and never falls through to production',async()=>{
  const server=createServer();await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  try{await assert.rejects(assertPortFree(server.address().port),/occupied/);}finally{await new Promise(resolve=>server.close(resolve));}
});

async function installedFixture(t){
  const root=await temporary(t),version='0.1.3',commit='a'.repeat(40),builtAt='2026-09-03T00:00:00.000Z';
  const data=Buffer.from(JSON.stringify({name:'fixture',version}));await writeFile(path.join(root,'package.json'),data);
  await mkdir(path.join(root,'apps/server/dist'),{recursive:true});
  await atomicJson(path.join(root,'apps/server/dist/build-info.json'),{productVersion:version,commitSha:commit,dirty:false,builtAt});
  const manifest={schemaVersion:1,kind:'MERCHROUTE_INSTALLED_RELEASE',productVersion:version,sourceCommit:commit,sourceTree:'b'.repeat(40),builtAt,platform:process.platform,arch:process.arch,nodeVersion:process.versions.node,
    sourceFiles:[{path:'package.json',mode:'100644',sha:gitBlob(data)}],files:await inventoryRelease(root)};
  await atomicJson(path.join(root,'installed-release.json'),manifest);
  return {root,manifest,pin:digest(await readFile(path.join(root,'installed-release.json')))};
}
test('Git-free release verification reads actual files and rejects missing/extra/modified files or manifest',async t=>{
  const {root,pin}=await installedFixture(t);assert.equal((await verifyInstalledRelease(root,pin)).manifest.productVersion,'0.1.3');
  await assert.rejects(verifyInstalledRelease(root),/externally pinned/);
  await writeFile(path.join(root,'rogue.js'),'bad');await assert.rejects(verifyInstalledRelease(root,pin),/undeclared/);await rm(path.join(root,'rogue.js'));
  const bytes=await readFile(path.join(root,'package.json'));await writeFile(path.join(root,'package.json'),'{}');await assert.rejects(verifyInstalledRelease(root,pin),/changed/);await writeFile(path.join(root,'package.json'),bytes);
  await rm(path.join(root,'apps/server/dist/build-info.json'));await assert.rejects(verifyInstalledRelease(root,pin),/missing/);
  await writeFile(path.join(root,'installed-release.json'),'{}');await assert.rejects(verifyInstalledRelease(root,pin),/identity changed/);
});
test('accepted runtime artifacts are re-read and a modified archive blocks publication',async t=>{
  const {root,manifest,pin}=await installedFixture(t),artifactRoot=await temporary(t);
  const bytes=Buffer.from('synthetic archive');await writeFile(path.join(artifactRoot,'source.zip'),bytes);
  const candidate={id:'fixture',productVersion:manifest.productVersion,sourceCommit:manifest.sourceCommit,sourceTree:manifest.sourceTree,root,artifactRoot,manifestSha256:pin,artifacts:[{name:'source.zip',sha256:digest(bytes)}]};
  const accepted=candidateSnapshot(candidate);await verifyAcceptedCandidate(candidate,accepted);
  await writeFile(path.join(artifactRoot,'source.zip'),'modified archive');
  await assert.rejects(verifyAcceptedCandidate(candidate,accepted),/artifact changed/);
});
test('Git-free package forbids path escapes, old-directory dependencies and Git state',async t=>{
  for(const name of ['../outside','C:/private','a\\b','/root','a/../b','a//b'])assert.throws(()=>safeRelative(name),/Unsafe/);
  const {root}=await installedFixture(t),external=await temporary(t);await mkdir(path.join(root,'node_modules'));
  await symlink(external,path.join(root,'node_modules/outside'),process.platform==='win32'?'junction':'dir');await assert.rejects(inventoryRelease(root),/External/);
});
test('release transaction requires both probes and never accepts a failed start',async()=>{
  const calls=[];const a={previous:{id:'old'},candidate:{id:'new'},check:async()=>calls.push('check'),stop:async()=>calls.push('stop'),start:async()=>{throw new Error('start failed');},probe:async()=>calls.push('probe'),bind:async()=>calls.push('bind'),accept:async()=>calls.push('accept'),journal:async x=>calls.push(x.state),rollbackCheck:async()=>{throw new Error('active writes');}};
  await assert.rejects(switchRelease(a),/start failed/);assert.equal(calls.includes('accept'),false);assert.equal(calls.at(-1),'RECOVERY_REQUIRED');
  calls.length=0;a.start=async()=>({pid:12});a.probe=async(_binding,_running,cycle)=>calls.push('probe'+cycle);await switchRelease(a);
  assert.deepEqual(calls.slice(-4),['probe1','probe2','accept','ACCEPTED']);
});
test('active or unknown business state blocks release and rollback',()=>{
  assertNoActivity({download:0,review:0});for(const values of [{},{download:1},{unknown:null},{unknown:NaN}])assert.throws(()=>assertNoActivity(values),/blocked/);
});
test('automatic pre-acceptance rollback must pass both restored-runtime probes',async()=>{
  const calls=[];
  await assert.rejects(switchRelease({previous:{id:'old'},candidate:{id:'new'},check:async()=>{},stop:async()=>{},bind:async()=>{},
    start:async b=>{if(b.id==='new')throw Error('new start failed');return {pid:2};},
    probe:async(b,_running,cycle)=>calls.push(b.id+':'+cycle),accept:async()=>calls.push('accept'),rollbackCheck:async()=>{},journal:async r=>calls.push(r.state)}),/new start failed/);
  assert.deepEqual(calls.slice(-3),['old:1','old:2','ROLLED_BACK']);assert.equal(calls.includes('accept'),false);
});

test('v0.1.2 rollover requires the exact merged PR, final release and accepted tree',()=>{
  const previous={number:26,sourceCommit:'922b08f444977edd480d1a020cf4a90c4f513809',publicCommit:'a'.repeat(40),tree:'b'.repeat(40)};
  const input={main:'c'.repeat(40),baseTree:previous.tree,oldPr:{merged:true,state:'closed',base:{ref:'main'},head:{sha:previous.publicCommit}},oldRelease:{draft:false,prerelease:false,tag_name:'v0.1.2'},oldPublishedTree:previous.tree};
  assert.equal(validateV012Rollover(previous,input).status,'PUBLISHED_NOT_ACTIVATED');
  assert.throws(()=>validateV012Rollover(previous,{...input,oldPublishedTree:'d'.repeat(40)}),/not aligned/);
  assert.throws(()=>validateV012Rollover({...previous,number:25},input),/outside the approved/);
});

test('isolated PostgreSQL installs pg_trgm before parallel integration workers start',async()=>{
  const source=await readFile(path.join(import.meta.dirname,'verify.mjs'),'utf8');
  const extension=source.indexOf("CREATE EXTENSION IF NOT EXISTS pg_trgm");
  const action=source.indexOf("return await action(");
  assert.ok(extension>0&&action>extension,'pg_trgm must be installed before test workers receive the database URL');
});
test('Windows E2E container keeps port 4183 inside the PostgreSQL network namespace',()=>{
  const args=fixedPortE2eDockerArgs({archive:path.resolve('source.tar'),evidenceDirectory:path.resolve('evidence'),postgresContainer:'a'.repeat(64),databaseUrl:'postgresql://merchroute_ci@127.0.0.1:55555/merchroute_ci_test'});
  assert.equal(args[0],'docker');assert.ok(args.includes('container:'+'a'.repeat(64)));
  const command=args.at(-1);assert.match(command,/127\.0\.0\.1:5432/);assert.match(command,/npm run test:e2e/);assert.doesNotMatch(command,/55555/);
});
test('historical audit retains thirty source branches and thirteen feature groups without fake local refs',async()=>{
  const root=path.resolve(import.meta.dirname,'../..');const manifest=JSON.parse(await readFile(path.join(root,'config/release-features.json'))),historical=await readFile(path.join(root,manifest.historicalAudit.path));
  assert.equal(digest(historical),manifest.historicalAudit.sha256);const audit=JSON.parse(historical);
  assert.equal(audit.branches.length,30);assert.equal(audit.features.length,13);assert.deepEqual(manifest.branches,audit.branches);assert.deepEqual(validateManifest(manifest),[]);
  assert.deepEqual(compareBranchInventory(manifest,[{name:'work/example',head:'a'.repeat(40)}],'work/example','a'.repeat(40)),[]);
});
