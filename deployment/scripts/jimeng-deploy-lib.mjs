import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { copyFile, lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile, statfs } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { assertExternal, withCommandLock } from '../../scripts/workflow/state.mjs';
import { setTimeout } from 'node:timers/promises';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const BASELINE = '0dbfb17b9397e84c3a9d66c2af7c8a4242984dc0';
export const PREFIX = 'integrations/jimeng-free-api-all/';
export const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
export const json = async (file) => JSON.parse(await readFile(file, 'utf8'));
export const imageId = (value) => /^sha256:[a-f0-9]{64}$/.test(value || '');
export const containerId = (value) => /^[a-f0-9]{64}$/.test(value || '');
export function docker(args, { allowMissing = false } = {}) {
  try { return execFileSync('docker', args, { encoding: 'utf8', windowsHide: true, stdio: ['ignore','pipe','pipe'], maxBuffer: 32 * 1024 ** 2 }).trim(); }
  catch (error) {
    if (allowMissing && /No such (image|object|container|volume)/i.test(String(error.stderr))) return null;
    throw new Error(`Docker ${args.slice(0,2).join(' ')} failed (exit ${error.status ?? 'unavailable'}); no mutation retry was attempted`);
  }
}
export async function dockerBuild(args) {
  await new Promise((resolve,reject) => {
    const child = spawn('docker', args, { stdio:'inherit', windowsHide:true, shell:false });
    child.on('error', reject);
    child.on('close', (code) => code === 0 ? resolve() : reject(new Error(`Docker build failed: ${code}`)));
  });
}
export function releaseIdentity(version, componentVersion = version, repository = 'merchroute/jimeng-free-api-all') {
  assert.match(version || '', /^\d+\.\d+\.\d+$/, 'Stable product version required');
  assert.equal(componentVersion, version, 'Jimeng and product versions must match');
  assert.match(repository, /^[a-z0-9]+(?:[._-][a-z0-9]+)*(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)+$/);
  return { productVersion:version, componentVersion, releaseTag:`v${version}`, imageRepository:repository,
    formalTag:`${repository}:${version}`, containerName:`merchroute-jimeng-v${version}` };
}
export function profile(name = 'test', version = JSON.parse(readFileSync(path.join(ROOT,'deployment/runtime-versions.json'),'utf8')).jimeng.version) {
  if (name === 'production') return { name, port:8000, container:releaseIdentity(version).containerName, network:'bridge' };
  if (name === 'test') return { name, port:18001, container:'merchroute-jimeng-isolated', network:'bridge' };
  throw new Error('Only test and production profiles are supported');
}
export function safeName(value) {
  assert.match(value || '', /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,100}$/, 'Explicit Docker resource name required');
  return value;
}
export function inspectImage(id) {
  assert.ok(imageId(id), 'Immutable image ID required');
  return JSON.parse(docker(['image','inspect',id]))[0];
}
export function inspectContainer(id) {
  const raw = docker(['container','inspect',safeName(id)], { allowMissing:true });
  return raw === null ? null : JSON.parse(raw)[0];
}
export function writers(volume) {
  safeName(volume);
  const ids = docker(['ps','--filter',`volume=${volume}`,'--no-trunc','--format','{{.ID}}']).split(/\s+/).filter(Boolean);
  return ids.map(inspectContainer).filter((c) => c?.Mounts.some((m) => m.Type === 'volume' && m.Name === volume && m.RW));
}
export function summarize(c) {
  if (!c) return null;
  return { id:c.Id, name:c.Name?.replace(/^\//,''), imageId:c.Image, user:c.Config.User,
    state:c.State.Status, health:c.State.Health?.Status, startedAt:c.State.StartedAt,
    restart:c.HostConfig.RestartPolicy, ports:c.HostConfig.PortBindings,
    mounts:c.Mounts.map((m) => ({ type:m.Type, name:m.Name, destination:m.Destination, rw:m.RW })),
    composeProject:c.Config.Labels?.['com.docker.compose.project'] ?? null };
}
export function assertContainer(c, record, volume, selected, { healthy = true } = {}) {
  assert.ok(c && containerId(c.Id), 'Expected container absent');
  assert.equal(c.Image, record.imageId, 'Container image identity mismatch');
  assert.ok(['node','1000:1000'].includes(c.Config.User), 'Root or unknown runtime user');
  assert.equal(c.HostConfig.RestartPolicy.Name, 'unless-stopped', 'Restart policy mismatch');
  assert.deepEqual(c.HostConfig.PortBindings, { '8000/tcp':[{HostIp:'127.0.0.1',HostPort:String(selected.port)}] }, 'Port identity mismatch');
  const data = c.Mounts.filter((m) => m.Destination === '/app/data');
  assert.equal(data.length, 1, 'Exactly one data mount required');
  assert.equal(data[0].Type, 'volume'); assert.equal(data[0].Name, volume); assert.equal(data[0].RW, true);
  assert.equal(c.State.Running, true);
  if (healthy) assert.equal(c.State.Health?.Status, 'healthy', 'Docker health not healthy');
}
export function assertRecord(record) {
  assert.equal(record.schemaVersion, 1);
  assert.equal(record.baseline, BASELINE);
  assert.ok(imageId(record.imageId));
  assert.ok(Number.isInteger(record.rc) && record.rc >= 3);
  if (record.release) assert.deepEqual(record.release, releaseIdentity(record.release.productVersion, record.release.componentVersion, record.release.imageRepository));
  assert.match(record.commit, /^[a-f0-9]{40}$/);
  assert.ok(Array.isArray(record.files) && record.files.length > 0);
  const seen = new Set();
  for (const file of record.files) {
    assert.ok(typeof file.path === 'string' && !file.path.includes('\\') && !file.path.startsWith('/') && !file.path.split('/').some((p) => p === '..' || p === '.'));
    assert.match(file.sha256, /^[a-f0-9]{64}$/);
    assert.ok(!seen.has(file.path)); seen.add(file.path);
  }
  assert.equal(digest(JSON.stringify(record.files)), record.sourceHash, 'Source manifest hash mismatch');
  return record;
}
export function assertImage(record, raw = inspectImage(record.imageId)) {
  assertRecord(record);
  assert.equal(raw.Id, record.imageId);
  assert.equal(`${raw.Os}/${raw.Architecture}`, record.platform);
  const labels = raw.Config.Labels || {};
  assert.equal(labels['org.merchroute.jimeng.source-sha256'], record.sourceHash);
  assert.equal(labels['org.merchroute.jimeng.baseline'], BASELINE);
  assert.equal(labels['org.merchroute.jimeng.rc'], String(record.rc));
  assert.equal(labels['org.opencontainers.image.revision'], record.commit + (record.dirty ? '-dirty' : ''));
  if (record.release) {
    assert.equal(labels['org.opencontainers.image.version'], record.release.componentVersion);
    assert.equal(labels['org.merchroute.product.version'], record.release.productVersion);
  }
  return raw;
}

export async function sourceFiles(root = ROOT) {
  const files = [];
  async function visit(relative) {
    const absolute = path.join(root,relative), info = await lstat(absolute);
    assert.ok(!info.isSymbolicLink(), 'Build input links are forbidden');
    if (info.isDirectory()) {
      for (const name of (await readdir(absolute)).sort()) await visit(`${relative}/${name}`);
    } else {
      assert.ok(info.isFile(), 'Non-regular build input');
      files.push({ path:relative, sha256:digest(await readFile(absolute)) });
    }
  }
  for (const name of ['.dockerignore','Dockerfile','compose.yaml','package.json','package-lock.json','tsconfig.json','libs.d.ts','configs','public','src','tests','patches/scripts']) await visit(PREFIX + name);
  for (const name of ['deployment/runtime-versions.json','deployment/scripts/jimeng-deploy.mjs','deployment/scripts/jimeng-deploy-lib.mjs','deployment/scripts/jimeng-deploy.test.mjs','deployment/scripts/run-jimeng-tests.mjs','deployment/scripts/preflight.mjs','deployment/scripts/bootstrap-windows.ps1','deployment/scripts/bootstrap-macos.sh','deployment/JIMENG_DEPLOYMENT.zh-CN.md','scripts/ci-jimeng-ping.mjs','package.json','.github/workflows/ci.yml']) await visit(name);
  await visit('deployment/n8n/patches/jimeng-unified-policy-v1.mjs');
  await visit('deployment/n8n/patches/jimeng-unified-policy-v1.test.mjs');
  return files.sort((a,b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
}

export async function build({ stateDir, rc = 3, dryRun = false }) {
  assert.ok(Number.isInteger(rc) && rc >= 3, 'RC sequence must start at 3');
  await assertExternal(ROOT,stateDir);
  const versions = (await json(path.join(ROOT,'deployment/runtime-versions.json'))).jimeng;
  const pkg = await json(path.join(ROOT,PREFIX,'package.json'));
  const release = releaseIdentity((await json(path.join(ROOT,'package.json'))).version, versions.version, versions.imageRepository);
  assert.equal(pkg.version, release.componentVersion);
  assert.equal(pkg.engines.node, versions.node); assert.equal(pkg.engines.npm, versions.npm);
  const files = await sourceFiles(), sourceHash = digest(JSON.stringify(files));
  const git = (...args) => execFileSync('git', ['-C',ROOT,...args], {encoding:'utf8',windowsHide:true}).trim();
  const commit = git('rev-parse','HEAD'), dirty = Boolean(git('status','--porcelain','--untracked-files=all'));
  git('merge-base','--is-ancestor',BASELINE,'HEAD');
  const tag = `${versions.imageRepository}:${versions.version}-jimeng47-rc.${rc}-${sourceHash.slice(0,16)}`;
  const recordFile = path.join(stateDir, `build-rc.${rc}-${sourceHash.slice(0,16)}.json`);
  if (dryRun) return { dryRun:true, tag, recordFile, sourceHash, commit, dirty, files:files.length };
  return withCommandLock(stateDir, async () => {
    for (const entry of await readdir(stateDir)) {
      const match = /^build-rc\.(\d+)-/.exec(entry);
      assert.ok(!match || Number(match[1]) < rc, 'Use a new RC sequence; build records are immutable');
    }
    assert.equal(docker(['image','inspect',tag], {allowMissing:true}), null, 'Candidate tag already exists; never overwrite it');
    const snapshot = await mkdtemp(path.join(os.tmpdir(),'merchroute-jimeng-build-'));
    try {
      // Build only a frozen allow-listed context; do not send the live checkout,
      // credentials, logs, runtime data or .git to the Docker daemon.
      for (const file of files.filter((f) => f.path.startsWith(PREFIX))) {
        const target = path.join(snapshot,file.path.slice(PREFIX.length));
        await mkdir(path.dirname(target),{recursive:true});
        await copyFile(path.join(ROOT,file.path),target);
        assert.equal(digest(await readFile(target)),file.sha256,'Build input changed during snapshot');
      }
      const iid = path.join(stateDir,`build-${randomUUID()}.iid`);
      await dockerBuild(['build','--build-arg',`NODE_IMAGE=node:${versions.node}-bookworm`,
        '--label',`org.merchroute.jimeng.source-sha256=${sourceHash}`,
        '--label',`org.merchroute.jimeng.baseline=${BASELINE}`,
        '--label',`org.merchroute.jimeng.rc=${rc}`,
        '--label',`org.opencontainers.image.version=${release.componentVersion}`,
        '--label',`org.merchroute.product.version=${release.productVersion}`,
        '--label',`org.opencontainers.image.revision=${commit}${dirty ? '-dirty' : ''}`,
        '--iidfile',iid,'--tag',tag,snapshot]);
      const id = (await readFile(iid,'utf8')).trim();
      const raw = inspectImage(id);
      const record = { schemaVersion:1,baseline:BASELINE,rc,tag,imageId:id,commit,dirty,sourceHash,files,release,
        platform:`${raw.Os}/${raw.Architecture}`,node:versions.node,npm:versions.npm,createdAt:new Date().toISOString(),
        acceptance:{ node20BuildGate:true, isolatedDeployment:false, candidateLiveGeneration:false, productionActivated:false } };
      assertImage(record,raw);
      await writeFile(recordFile,JSON.stringify(record,null,2)+'\n',{flag:'wx',mode:0o600});
      return {recordFile,imageId:id,tag,sourceHash,acceptance:record.acceptance};
    } finally { await rm(snapshot,{recursive:true,force:true}); }
  });
}

export async function inspect({ container, volume }) {
  const c = inspectContainer(container);
  return { container:summarize(c), volumeExists:docker(['volume','inspect',safeName(volume)],{allowMissing:true}) !== null,
    writers:writers(volume).map(summarize), readOnly:true };
}
export async function verify({ record, container, volume, selected }) {
  assertImage(record);
  const c = inspectContainer(container);
  assertContainer(c,record,volume,selected);
  if (record.release) {
    assert.equal(c.Config.Labels['org.merchroute.product.version'], record.release.productVersion);
    assert.equal(c.Config.Labels['org.opencontainers.image.version'], record.release.componentVersion);
    assert.equal(docker(['exec',c.Id,'node','-p',"require('./package.json').version"]),record.release.componentVersion);
    if (selected.name === 'production') assert.equal(c.Name,'/'+record.release.containerName);
  }
  assert.deepEqual(writers(volume).map((w) => w.Id),[c.Id], 'Unexpected second volume writer');
  const origin = `http://127.0.0.1:${selected.port}`;
  const ping = await fetch(origin+'/ping',{signal:AbortSignal.timeout(3000)});
  assert.ok(ping.ok); assert.equal((await ping.text()).replaceAll('"','').trim(),'pong');
  const welcome = await fetch(origin+'/',{signal:AbortSignal.timeout(3000)});
  assert.ok(welcome.ok && (welcome.headers.get('content-type')||'').includes('text/html'));
  assert.ok((await welcome.text()).includes('jimeng-free-api已启动'));
  const runtime = JSON.parse(docker(['exec',c.Id,'node','-e','console.log(JSON.stringify({node:process.versions.node,uid:process.getuid(),gid:process.getgid()}))']));
  assert.equal(runtime.node,record.node); assert.equal(runtime.uid,1000); assert.equal(runtime.gid,1000);
  const storage=JSON.parse(docker(['exec',c.Id,'node',VOLUME_HELPER,'inspect']));
  assert.equal(storage.permissionsCompatible,true,'Data ownership or file permissions are incompatible');
  // No generation/status POSTs: status may recover a worker and is not read-only.
  return {ok:true,container:summarize(c),recordSourceHash:record.sourceHash,runtime,storage,readOnly:true};
}

const VOLUME_HELPER = '/app/deployment/jimeng-volume.cjs';
export function volumeAction(record, volume, action, { backup, archiveSha256 } = {}) {
  assert.notEqual(docker(['volume','inspect',safeName(volume)],{allowMissing:true}),null,'Volume absent; helper must never create it implicitly');
  const live=writers(volume);
  if (action==='probe' && live.length===1) {
    assert.equal(live[0].Image,record.imageId);
    return JSON.parse(docker(['exec','--user','1000:1000',live[0].Id,'node',VOLUME_HELPER,'probe']));
  }
  if (action!=='inspect') assert.equal(live.length,0,'Storage mutation/backup requires a stopped unique writer');
  const readonly = action === 'inspect' || action === 'backup';
  const args = ['run','--rm','--network','none','--read-only','--user', action === 'probe' ? '1000:1000' : '0:0',
    '--entrypoint','node','--mount',`type=volume,src=${safeName(volume)},dst=/app/data${readonly?',readonly':''}`];
  if (backup) {
    assert.ok(path.isAbsolute(backup) && !backup.includes(','), 'Unsafe backup path');
    args.push('--mount',`type=bind,src=${backup},dst=/backup${action==='restore'?',readonly':''}`);
  }
  args.push(record.imageId,VOLUME_HELPER,action);
  if (archiveSha256) args.push(archiveSha256);
  return JSON.parse(docker(args));
}
export function assertMaintenance(gate, current, volume, now = Date.now()) {
  assert.equal(gate.containerId,current.Id); assert.equal(gate.imageId,current.Image);
  assert.equal(gate.volume,volume);
  assert.ok(now-Date.parse(gate.observedAt)>=0 && now-Date.parse(gate.observedAt)<300_000,'Maintenance observation expired');
  for (const key of ['newSubmissionsBlocked','n8nIdle','proxyWorkersIdle']) assert.equal(gate[key],true,`Maintenance proof missing: ${key}`);
  assert.ok(gate.unknownSubmissionsResolved===true || (gate.unknownSubmissionsResolved===false && gate.historicalDisposition?.schemaVersion===1), 'Maintenance proof missing: unknownSubmissionsResolved');
}
// Historical exceptions preserve the original ledger. They never authorize a
// reservation, replay, affinity change or a new/current unresolved submission.
export function assertStorageQuiescent(storage, gate, current) {
  const tasks=storage.stores['image-task-store.json'];
  for(const [name,store] of Object.entries(storage.stores)) {
    const states=name==='image-task-store.json'?['reserved']:['reserved','processing','submission_unknown','receiving','uploading'];
    for(const status of states) assert.equal(store.statuses?.[status]||0,0,`Nonterminal ${status} requires reconciliation`);
  }
  const count=(tasks?.statuses?.processing||0)+(tasks?.statuses?.submission_unknown||0);
  if(!count) { assert.equal(gate.historicalDisposition?.records?.length||0,0,'Historical exception no longer matches ledger'); return; }
  const proof=gate.historicalDisposition;
  assert.equal(proof?.schemaVersion,1,'Explicit historical disposition required');
  assert.equal(proof.containerStartedAt,current.State.StartedAt,'Historical proof belongs to another process');
  assert.equal(proof.preserveRecords,true); assert.equal(proof.forbidReplay,true);
  assert.ok(typeof proof.approvalReference==='string' && proof.approvalReference.trim().length>0,'Historical disposition lacks approval');
  assert.equal(proof.storageContentHash,storage.contentHash,'Storage changed since reconciliation');
  assert.ok(Array.isArray(tasks.nonterminalRecords)); assert.equal(tasks.nonterminalRecords.length,count);
  assert.ok(Array.isArray(proof.records));assert.equal(proof.records.length,count,'Unreviewed historical tasks');
  const approved=new Map(proof.records.map(r=>[r.keyHash,r]));assert.equal(approved.size,count,'Duplicate exception');
  for(const record of tasks.nonterminalRecords) {
    const item=approved.get(record.keyHash); assert.ok(item,'Unapproved historical task');
    assert.match(record.keyHash,/^[a-f0-9]{64}$/);assert.match(record.recordHash,/^[a-f0-9]{64}$/);
    assert.equal(item.recordHash,record.recordHash,'Historical task changed');assert.equal(item.status,record.status);
    if(item.disposition==='remote_terminal') {
      assert.equal(record.status,'processing');assert.equal(record.hasHistoryId,true);
      assert.ok(['success','failed'].includes(item.remoteState));assert.match(item.evidenceSha256||'',/^[a-f0-9]{64}$/);
    } else {
      assert.equal(item.disposition,'ignore_preserve');assert.equal(item.explicitlyApproved,true);
      assert.ok(['processing','submission_unknown'].includes(record.status));
      // A pre-restart record has no in-memory submit worker in this process.
      // Current n8n/worker/ingress checks are still mandatory independently.
      const started=Date.parse(current.State.StartedAt);
      assert.ok(Date.parse(record.createdAt)<started && Date.parse(record.updatedAt)<started,'Cannot ignore a current-process task');
    }
  }
}
export async function deploymentPlan({ action, record, container, volume, selected, expectedImage, handoff = false }) {
  assertImage(record); safeName(volume);
  if (selected.name === 'production' && record.release) assert.equal(selected.container,record.release.containerName,'Target name must match the accepted release');
  if (selected.name === 'test') assert.ok(volume.startsWith('merchroute-jimeng-test-'),'Test profile requires an explicitly isolated test volume');
  const old = inspectContainer(container || selected.container);
  const exists = docker(['volume','inspect',volume],{allowMissing:true}) !== null;
  const liveWriters = writers(volume);
  if (action === 'install') {
    assert.equal(old,null,'Existing instance requires upgrade, not install');
    assert.equal(exists,false,'Install will never reuse an existing volume');
    assert.equal(liveWriters.length,0);
  } else {
    assert.ok(containerId(container),'Upgrade requires the exact previous container ID');
    assert.ok(old && exists,'Existing container and data volume are required');
    assert.equal(old.Image,expectedImage,'Previous image identity changed');
    assertContainer(old,{imageId:expectedImage},volume,selected,{healthy:false});
    assert.deepEqual(liveWriters.map((c)=>c.Id),[old.Id]);
    if (old.Name !== '/'+selected.container) assert.equal(handoff,true,'Manual-container handoff must be explicit');
  }
  const stable = inspectContainer(selected.container);
  assert.ok(!stable || stable.Id===old?.Id,'Stable container name belongs to another instance');
  return { action, old:summarize(old), targetImage:record.imageId, targetName:selected.container,
    volume, port:selected.port, profile:selected.name, dryRun:true,
    steps: action==='install' ? ['create-volume','initialize-owner','probe','start','verify'] :
      ['maintenance-gate','stop-exact-writer','consistent-backup','restore-drill','conditional-permission-migration','probe','retain-old-container','start','verify'],
    productionChanged:false };
}
async function privateDirectory(directory) {
  await mkdir(directory,{mode:0o700});
  if(process.platform==='win32') {
    const identity=execFileSync('whoami.exe',['/user','/fo','csv','/nh'],{encoding:'utf8',windowsHide:true});
    const sid=identity.match(/S-1-5-21(?:-\d+)+/)?.[0];assert.ok(sid,'Cannot determine backup owner SID');
    execFileSync('icacls.exe',[directory,'/inheritance:r','/grant:r',`*${sid}:(OI)(CI)F`,'*S-1-5-18:(OI)(CI)F'],{stdio:'pipe',windowsHide:true});
  }
}
export async function waitVerified(input) {
  let failure;
  for (let i=0;i<60;i++) {
    try { return await verify(input); } catch (error) { failure=error; }
    await setTimeout(1000);
  }
  throw failure;
}
export async function deploy(input) {
  const {stateDir,record,volume,selected,dryRun,execute,maintenanceFile,allowPermissionMigration} = input;
  const plan = await deploymentPlan(input);
  if (dryRun) return plan; // No mkdir, lock file, helper container, or volume creation.
  assert.equal(execute,true,'Mutation requires explicit --execute; default is read-only');
  await assertExternal(ROOT,stateDir);
  if(selected.name==='production') assert.equal(digest(JSON.stringify(await sourceFiles())),record.sourceHash,'Production candidate/tool source changed since build');
  return withCommandLock(stateDir,async()=>{
    const operationId=randomUUID();
    // A daemon-scoped name also excludes writers using a different state directory.
    const leaseId=docker(['create','--name',`merchroute-jimeng-lease-${digest(volume).slice(0,20)}`,
      '--label',`org.merchroute.operation=${operationId}`,'--network','none','--entrypoint','true',record.imageId]);
    assert.ok(containerId(leaseId));
    const journalFile=path.join(stateDir,`operation-${operationId}.jsonl`);
    const log=async(stage,details={})=>writeFile(journalFile,JSON.stringify({at:new Date().toISOString(),operationId,stage,...details})+'\n',{flag:'a',mode:0o600});
    let old, candidateId, storageBefore, oldStopped=false;
    try {
      await log('planned',{plan});
      await deploymentPlan(input); // Revalidate identities under the lease before any mutation.
      if (plan.old) {
        old=inspectContainer(plan.old.id);
        const gate=await json(maintenanceFile);
        assertMaintenance(gate,old,volume);
        const before=volumeAction(record,volume,'inspect');
        assertStorageQuiescent(before,gate,old);
        const free=await statfs(stateDir);
        assert.ok(Number(free.bavail)*Number(free.bsize)>Math.max(before.bytes*3,256*1024**2),'Insufficient backup disk space');
        await log('pre-stop',{old:summarize(old),storage:before});
        // Prevent an automatic restart while the retained container is not the writer.
        docker(['update','--restart=no',old.Id]);
        await log('restart-disabled',{id:old.Id});
        docker(['stop','--time','60',old.Id]); oldStopped=true;
        assert.equal(inspectContainer(old.Id).State.Running,false);
        assert.equal(writers(volume).length,0);
        const backup=path.join(stateDir,`backup-${operationId}`);
        await privateDirectory(backup);
        const snapshot=volumeAction(record,volume,'backup',{backup}); storageBefore=snapshot;
        await log('backed-up',{backup,snapshot});
        assert.equal(snapshot.contentHash,before.contentHash,'Storage changed across stop; preserve latest data and reassess');
        assertStorageQuiescent(snapshot,gate,old);
        const restoreVolume=`merchroute-jimeng-test-restore-${operationId}`;
        docker(['volume','create','--label',`org.merchroute.operation=${operationId}`,restoreVolume]);
        const restored=volumeAction(record,restoreVolume,'restore',{backup,archiveSha256:snapshot.archiveSha256});
        assert.equal(restored.metadataHash,snapshot.metadataHash);
        await log('restore-proved',{restoreVolume,restored}); // Keep recovery proof, do not delete the restored volume.
        if (!snapshot.permissionsCompatible) {
          assert.equal(allowPermissionMigration,true,'Permission migration needs explicit authorization');
          await log('permission-migration-intent',{volume});
          volumeAction(record,volume,'migrate');
        }
        if (old.Name==='/'+selected.container) {
          const retained=`${selected.container}-retained-${operationId.slice(0,8)}`;
          await log('rename-intent',{id:old.Id,retained}); docker(['rename',old.Id,retained]);
        }
      } else {
        await log('create-volume-intent',{volume});
        docker(['volume','create','--label',`org.merchroute.operation=${operationId}`,volume]);
        volumeAction(record,volume,'migrate');
      }
      volumeAction(record,volume,'probe');
      assert.equal(writers(volume).length,0);
      await log('start-intent',{imageId:record.imageId,name:selected.container});
      candidateId=docker(['run','--detach','--name',selected.container,'--restart','unless-stopped','--user','node',
        '--publish',`127.0.0.1:${selected.port}:8000`,'--mount',`type=volume,src=${volume},dst=/app/data`,
        '--env','IMAGE_TASK_STORE_DIR=/app/data','--label',`org.merchroute.operation=${operationId}`,
        '--label',`org.merchroute.jimeng.source-sha256=${record.sourceHash}`,
        ...(record.release ? ['--label',`org.merchroute.product.version=${record.release.productVersion}`,
          '--label',`org.opencontainers.image.version=${record.release.componentVersion}`] : []),record.imageId]);
      assert.ok(containerId(candidateId));
      await log('candidate-started',{candidateId});
      const verified=await waitVerified({record,container:candidateId,volume,selected});
      if(storageBefore) for(const [name,store] of Object.entries(storageBefore.stores)) {
        if(!store.missing) assert.ok(!verified.storage.stores[name]?.missing && verified.storage.stores[name].count>=store.count,'Historical storage unexpectedly disappeared');
      }
      await log('verified',{verified});
      return {ok:true,operationId,journalFile,containerId:candidateId,previousContainer:plan.old?.id || null,volume};
    } catch(error) {
      await log('failed',{message:error.message,candidateId:candidateId || null,oldStopped});
      // Failures preserve the latest volume and exact identities. Rollback is
      // explicit: never repeatedly blind-start a previous writer on uncertainty.
      throw new Error(`Deployment failed; inspect ${journalFile} before explicit rollback: ${error.message}`);
    } finally {
      const lease=inspectContainer(leaseId);
      assert.equal(lease.Config.Labels['org.merchroute.operation'],operationId);
      docker(['rm',leaseId]);
    }
  });
}

export async function rollback({journalFile,record,stateDir,execute=false,dryRun=true,maintenanceFile}) {
  await assertExternal(ROOT,journalFile);
  const entries=(await readFile(journalFile,'utf8')).trim().split('\n').map(JSON.parse);
  const first=entries[0],plan=first?.plan;
  assert.ok(plan?.old && first.stage==='planned','This journal has no previous container to restore');
  assert.ok(entries.every((e)=>e.operationId===first.operationId),'Mixed operation journal');
  assert.equal(record.imageId,plan.targetImage); assertImage(record);
  const selected=profile(plan.profile), volume=safeName(plan.volume);
  const old=inspectContainer(plan.old.id);
  assert.ok(old && old.Image===plan.old.imageId,'Retained previous identity changed');
  const candidateEntry=entries.find((e)=>e.stage==='candidate-started');
  let candidate=candidateEntry ? inspectContainer(candidateEntry.candidateId) : inspectContainer(plan.targetName);
  if(candidate?.Id===old.Id)candidate=null;
  if(candidate) {
    assert.equal(candidate.Image,record.imageId);
    assert.equal(candidate.Config.Labels?.['org.merchroute.operation'],first.operationId,'Unknown candidate owner');
  }
  const ownIds=new Set([old.Id,candidate?.Id]);
  assert.ok(writers(volume).every((w)=>ownIds.has(w.Id)),'Foreign data writer');
  const output={dryRun:true,previousContainer:old.Id,candidateContainer:candidate?.Id || null,volume,
    preservesLatestData:true,restoresOldSnapshot:false};
  if(dryRun || !execute)return output;
  await assertExternal(ROOT,stateDir);
  return withCommandLock(stateDir,async()=>{
    const leaseId=docker(['create','--name',`merchroute-jimeng-lease-${digest(volume).slice(0,20)}`,
      '--label',`org.merchroute.operation=${first.operationId}`,'--network','none','--entrypoint','true',record.imageId]);
    const log=(stage,details={})=>writeFile(journalFile,JSON.stringify({at:new Date().toISOString(),operationId:first.operationId,stage,...details})+'\n',{flag:'a',mode:0o600});
    try {
      if(entries.some((e)=>e.stage==='rollback-verified')) {
        assertContainer(inspectContainer(old.Id),{imageId:old.Image},volume,selected);
        assert.deepEqual(writers(volume).map((c)=>c.Id),[old.Id]);
        return {...output,dryRun:false,ok:true,reused:true};
      }
      if(candidate?.State.Running) {
        const gate=await json(maintenanceFile);
        assertMaintenance(gate,candidate,volume);
        const state=volumeAction(record,volume,'inspect');
        assertStorageQuiescent(state,gate,candidate);
        await log('rollback-stop-intent',{id:candidate.Id,storage:state});
        docker(['update','--restart=no',candidate.Id]); docker(['stop','--time','60',candidate.Id]);
      }
      assert.ok(writers(volume).every((w)=>w.Id===old.Id),'Unexpected writer during rollback');
      if(candidate && candidate.Name==='/'+plan.old.name)docker(['rename',candidate.Id,`${selected.container}-failed-${first.operationId.slice(0,8)}`]);
      const previous=inspectContainer(old.Id);
      if(previous.Name!=='/'+plan.old.name)docker(['rename',old.Id,plan.old.name]);
      await log('rollback-start-intent',{id:old.Id});
      docker(['update',`--restart=${plan.old.restart.Name}`,old.Id]);
      if(!previous.State.Running)docker(['start',old.Id]);
      let ready=false;
      for(let i=0;i<60;i++) {
        const current=inspectContainer(old.Id);
        if(current.State.Health?.Status==='healthy'){ready=true;break;}
        await setTimeout(1000);
      }
      assert.ok(ready,'Previous runtime not healthy after rollback');
      assertContainer(inspectContainer(old.Id),{imageId:old.Image},volume,selected);
      assert.deepEqual(writers(volume).map((c)=>c.Id),[old.Id]);
      const ping=await fetch(`http://127.0.0.1:${selected.port}/ping`,{signal:AbortSignal.timeout(3000)});
      assert.ok(ping.ok);assert.equal((await ping.text()).replaceAll('"','').trim(),'pong');
      await log('rollback-verified',{id:old.Id});
      return {...output,dryRun:false,ok:true,reused:false};
    } catch(error){await log('rollback-failed',{message:error.message});throw error;}
    finally {assert.equal(inspectContainer(leaseId).Config.Labels['org.merchroute.operation'],first.operationId);docker(['rm',leaseId]);}
  });
}
