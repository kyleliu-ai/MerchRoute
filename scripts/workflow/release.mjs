import { mkdir, readFile, copyFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { atomicJson, readJson, requireApply, assertExternal, sourceIdentity } from './state.mjs';
import { githubJson, requireVerified } from './publish.mjs';
import { prepareInstalledRelease } from './release-package.mjs';
import { verifyInstalledRelease, digest } from '../lib/installed-release.mjs';
import { startBoundRelease } from '../release-runtime.mjs';
import { switchRelease } from './release-transaction.mjs';
import { inspectBusinessIdle } from './business-gate.mjs';
import { verifyLegacyRelease } from './legacy-release.mjs';
import { probeReadOnlyPages } from './read-only-pages.mjs';
import { assertAcceptedCandidate } from './candidate-acceptance.mjs';
import { createRuntimeEndpoint, runtimeEndpointFromBinding } from '../lib/runtime-endpoint.mjs';

const V014_OPERATOR_MODE='v0.1.4-prestop-unicode';
const V014_OPERATOR_COMMIT='2b4d9ff3c9cd479bb8be3a4e726c0f2db30adb3b';
const V014_OPERATOR_FILES=Object.freeze([
  'AGENTS.md',
  'scripts/release-windows.ps1',
  'scripts/workflow/launcher.test.mjs',
  'scripts/workflow/publish.mjs',
  'scripts/workflow/release.mjs'
]);

export function assertV014OperatorHardening(identity,candidate,mode) {
  if(mode!==V014_OPERATOR_MODE||identity.commit!==V014_OPERATOR_COMMIT||identity.tree!==candidate?.sourceTree
    ||candidate?.sourceCommit!==V014_OPERATOR_COMMIT||candidate?.productVersion!=='0.1.4')throw new Error('Operator hardening is not bound to the accepted v0.1.4 candidate');
  const entries=String(identity.status||'').split(/\r?\n/).filter(Boolean);
  const files=entries.map(line=>{
    let file;
    if([' M','M ','MM'].includes(line.slice(0,2))&&line[2]===' ')file=line.slice(3);
    else if(line.startsWith('M '))file=line.slice(2); // state.mjs trims the leading space from the first unstaged entry
    else throw new Error('Operator hardening contains an unsupported Git state');
    if(!file||file.includes(' -> '))throw new Error('Operator hardening contains an ambiguous path');
    return file;
  }).sort();
  const expected=[...V014_OPERATOR_FILES].sort();
  if(files.length!==expected.length||files.some((file,index)=>file!==expected[index]))throw new Error('Operator hardening contains files outside the approved local patch');
  return files;
}

export function createPublishedBinding(candidate,fields) {
  if(!fields?.runtimeEndpoint)throw new Error('Published binding requires an explicit runtime endpoint');
  return {...candidate,...fields,schemaVersion:2,runtimeEndpoint:fields.runtimeEndpoint};
}

export async function downloadAcceptedArtifact(asset,artifact,{fetchImpl=fetch,sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms))}={}) {
  let lastError;
  for(let attempt=1;attempt<=3;attempt++){
    try{
      const response=await fetchImpl(asset.browser_download_url,{signal:AbortSignal.timeout(60000)});
      if(!response.ok)throw new Error('Release asset request failed with HTTP '+response.status);
      const bytes=Buffer.from(await response.arrayBuffer());
      if(digest(bytes)!==artifact.sha256)throw new Error('Published asset differs from the accepted local build');
      return {attempts:attempt,bytes:bytes.length};
    }catch(error){
      if(String(error.message).includes('differs from the accepted local build'))throw error;
      lastError=error;
      if(attempt<3)await sleep(attempt*1000);
    }
  }
  throw new Error('Release asset download failed after 3 attempts: '+String(lastError?.message||lastError));
}

async function verifyV014OperatorHardening(root,config,identity,candidate,mode) {
  const files=assertV014OperatorHardening(identity,candidate,mode);
  if(digest(await readFile(config.nodePath))!==config.nodeSha256)throw new Error('Pinned Node toolchain changed before operator verification');
  execFileSync('git',['-C',root,'diff','--check'],{encoding:'utf8',windowsHide:true,stdio:['ignore','pipe','pipe']});
  execFileSync(config.gitleaksPath,['dir',root,'--redact=100','--no-banner','--no-color'],{encoding:'utf8',windowsHide:true,stdio:['ignore','pipe','pipe'],maxBuffer:32*1024*1024});
  execFileSync(config.nodePath,['--import','tsx','--test','scripts/workflow/launcher.test.mjs'],{cwd:root,encoding:'utf8',windowsHide:true,stdio:['ignore','pipe','pipe'],maxBuffer:32*1024*1024});
  const patch=execFileSync('git',['-C',root,'diff','--binary','HEAD','--',...files],{windowsHide:true,maxBuffer:32*1024*1024});
  return {schemaVersion:1,mode,baseCommit:identity.commit,baseTree:identity.tree,patchSha256:digest(patch),verifiedAt:new Date().toISOString(),
    files:await Promise.all(files.map(async file=>({path:file,sha256:digest(await readFile(path.join(root,file)))})))};
}

export function stopProcessInput(binding, live) {
  if(!live||live.stopped||!Number.isInteger(live.pid)||!live.createdAt)throw new Error('Live process identity is incomplete');
  return {
    pid:live.pid,
    createdAt:live.createdAt,
    entry:path.join(binding.root,'apps/server/dist/index.js'),
    nodePath:binding.nodePath,
    runtimeEndpoint:runtimeEndpointFromBinding(binding,{allowLegacy:true})
  };
}

export function assertAboutIdentity(binding,about) {
  const endpoint=runtimeEndpointFromBinding(binding,{allowLegacy:true});
  const endpointMatches=binding.legacy===true||about?.current?.runtimeEndpoint?.origin===endpoint.origin;
  if(about?.current?.commitSha!==binding.sourceCommit||about?.current?.productVersion!==binding.productVersion
    ||about?.runtimeStatus!=='CURRENT'||!endpointMatches)throw new Error('About identity mismatch');
  return true;
}

export function assertRecoverablePreStopJournal(journal,{previous,currentLive,expectedPid,pointerExists,acceptedCommit}) {
  const samePrevious=journal?.previous?.root===previous.root
    &&journal?.previous?.sourceCommit===previous.sourceCommit
    &&journal?.previous?.productVersion===previous.productVersion;
  if(journal?.state!=='FAILED'||!journal.error||!samePrevious||pointerExists
    ||currentLive?.stopped||currentLive?.pid!==expectedPid||acceptedCommit!==previous.sourceCommit){
    throw new Error('Interrupted release journal is not a proven pre-stop failure');
  }
  return true;
}

export async function releaseCommand(command,{root,home,config,options}) {
  const configuredEndpoint=createRuntimeEndpoint(config.production?.port||43173);
  if(command==='prepare'){
    const identity=sourceIdentity(root);
    if(identity.status)throw new Error('Commit and build the clean local candidate before preparing a release');
    if(options['dry-run'])return {dryRun:true,source:identity,productionChanged:false};
    requireApply(options);
    return prepareInstalledRelease(root,home,config);
  }
  if(!['activate','rollback'].includes(command))throw new Error('Unknown release operation');
  if(process.platform!=='win32')throw new Error('This host cutover adapter supports Windows only; macOS uses its reviewed deployment procedure');
  if(!options['approval-file'])throw new Error('Cutover requires a current user-approved external migration file');
  await assertExternal(root,options['approval-file']);
  const approval=await readJson(options['approval-file']);
  if(approval.operation!==command||approval.productionRestartApproved!==true||approval.releasePublishedApproved!==true
    ||!Number.isFinite(Date.parse(approval.expiresAt))||Date.parse(approval.expiresAt)<Date.now())throw new Error('Cutover authorization is missing or expired');
  let previous=await readJson(command==='rollback'?path.join(config.runtimeHome,'current-release.json'):path.join(home,'runtime-before-switch.json'));
  let candidate=await readJson(path.join(home,'candidate.json'));
  if(command==='rollback'){
    const saved=await readJson(path.join(home,'previous-release.json'));candidate=saved;
    if(approval.noBusinessStateRestore!==true)throw new Error('Rollback must not restore historical database or review state');
  }else{
    const identity=sourceIdentity(root);
    const operatorPatch=identity.status?await verifyV014OperatorHardening(root,config,identity,candidate,options['operator-hardening']):null;
    const verified=await requireVerified(root,home,{allowDirty:Boolean(operatorPatch)});
    assertAcceptedCandidate(candidate,verified.record.candidate);
    const publication=await readJson(path.join(home,'publication.json'));
    const pr=githubJson(config,'repos/'+config.github.repository+'/pulls/'+publication.number);
    const release=githubJson(config,'repos/'+config.github.repository+'/releases/tags/v'+candidate.productVersion);
    const published=githubJson(config,'repos/'+config.github.repository+'/commits/v'+candidate.productVersion);
    if(!pr.merged||release.draft||release.prerelease||published.commit.tree.sha!==candidate.sourceTree)throw new Error('Merged PR, final Release and local source tree are not aligned');
    const checks=githubJson(config,'repos/'+config.github.repository+'/commits/'+pr.head.sha+'/check-runs?filter=latest&per_page=100');
    if(!checks.check_runs?.length||checks.check_runs.some(x=>x.status!=='completed'||x.conclusion!=='success'))throw new Error('Published PR CI is not completely successful');
    for(const artifact of candidate.artifacts){
      const asset=release.assets.find(x=>x.name===artifact.name);
      if(!asset)throw new Error('An accepted release asset is missing: '+artifact.name);
      await downloadAcceptedArtifact(asset,artifact);
    }
    candidate=createPublishedBinding(candidate,{nodePath:config.nodePath,nodeSha256:config.nodeSha256,runtimeEndpoint:configuredEndpoint,
      ...config.production,releaseTag:'v'+candidate.productVersion,logDirectory:path.join(config.runtimeHome,'logs'),
      launcherSha256:digest(await readFile(path.join(candidate.root,'scripts/release-runtime.mjs'))),publicCommit:published.sha,
      ...(operatorPatch?{operatorPatch}:{})});
    candidate.bootstrapHashes={};
    for(const file of ['scripts/release-runtime.mjs','scripts/lib/installed-release.mjs','scripts/workflow/development.mjs','scripts/workflow/state.mjs'])candidate.bootstrapHashes[file]=digest(await readFile(path.join(candidate.root,file)));
  }
  if(previous.legacy===true){previous={...previous,schemaVersion:2,runtimeEndpoint:configuredEndpoint};}
  if(candidate.legacy===true){candidate={...candidate,schemaVersion:2,runtimeEndpoint:configuredEndpoint};}
  if(approval.expectedCurrentCommit!==previous.sourceCommit||approval.targetCommit!==candidate.sourceCommit)throw new Error('Approval is not bound to the current and target builds');
  const verifyTarget=binding=>binding.legacy?verifyLegacyRelease(binding):verifyInstalledRelease(binding.root,binding.manifestSha256);
  await verifyTarget(candidate);await verifyTarget(previous);
  await inspectBusinessIdle(previous);
  const journalFile=path.join(home,'release-journal.json');
  let interruptedJournal=null;
  try{
    const old=await readJson(journalFile);
    if(!['ACCEPTED','ROLLED_BACK'].includes(old.state)){
      if(old.state!=='FAILED'||approval.recoverFailedPreStopApproved!==true)throw new Error('Interrupted release journal requires explicit recovery');
      interruptedJournal=old;
    }
  }catch(error){if(error.code!=='ENOENT')throw error;}
  if(options['dry-run'])return {dryRun:true,from:previous.sourceCommit,to:candidate.sourceCommit,release:candidate.releaseTag,journalRecovery:interruptedJournal?'PRE_STOP_PROOF_REQUIRED':null};
  requireApply(options);
  const outside=path.join(config.recoveryDirectory,'cutover-'+Date.now());await mkdir(outside,{recursive:true,mode:0o700});
  const shortcuts=[];
  for(const [index,file] of config.production.shortcuts.entries()){const backup=path.join(outside,'shortcut-'+index+'.lnk');await copyFile(file,backup);shortcuts.push({path:file,backup,sha256:digest(await readFile(backup))});}
  if(previous.legacy)previous.shortcutBackups=shortcuts;
  async function windows(action,data){const file=path.join(outside,'windows-input.json');await atomicJson(file,data);const result=execFileSync('powershell.exe',['-NoProfile','-File',path.join(root,'scripts/release-windows.ps1'),'-Action',action,'-InputFile',file],{encoding:'utf8',windowsHide:true});return result.trim()?JSON.parse(result):null;}
  const active=new Map();
  async function inspect(binding){return windows('Inspect',{entry:path.join(binding.root,'apps/server/dist/index.js'),nodePath:binding.nodePath,runtimeEndpoint:runtimeEndpointFromBinding(binding,{allowLegacy:true})});}
  const fixedLauncher=path.join(config.runtimeHome,'Start-MerchRoute.ps1'),pointer=path.join(config.runtimeHome,'current-release.json');
  if(interruptedJournal){
    const currentLive=await inspect(previous);
    let pointerExists=true;try{await readJson(pointer);}catch(error){if(error.code==='ENOENT')pointerExists=false;else throw error;}
    const accepted=await readJson(config.acceptedReleaseFile);
    assertRecoverablePreStopJournal(interruptedJournal,{previous,currentLive,expectedPid:approval.expectedPid,pointerExists,acceptedCommit:accepted.local?.commit});
    await atomicJson(path.join(outside,'failed-journal-before-retry.json'),interruptedJournal);
  }
  return switchRelease({previous,candidate,
    check:async(old,next)=>{await inspectBusinessIdle(old);const live=await inspect(old);if(live.stopped){if(approval.expectedStopped!==true)throw new Error('Production process unexpectedly stopped');}else{if(live.pid!==approval.expectedPid)throw new Error('Production process changed');active.set(old.root,live);}await verifyTarget(next);},
    stop:async(binding)=>{const live=await inspect(binding);if(live.stopped)return;const expected=active.get(binding.root);if(!expected||expected.pid!==live.pid)throw new Error('Refusing to stop an unowned process');await inspectBusinessIdle(binding);await windows('Stop',stopProcessInput(binding,live));},
    bind:async(binding)=>{
      if(binding.legacy){await windows('RestoreShortcuts',{shortcuts:binding.shortcutBackups});await atomicJson(pointer,binding);return;}
      await copyFile(path.join(binding.root,'scripts/Start-MerchRoute.ps1'),fixedLauncher);
      await atomicJson(pointer,binding);
      const shortcutBindings=config.production.shortcuts.map(file=>({path:file,openBrowser:!file.toLowerCase().includes('\\startup\\')}));
      await windows('Bind',{launcher:fixedLauncher,launcherSha256:digest(await readFile(fixedLauncher)),shortcuts:shortcutBindings});
    },
    start:async(binding)=>{
      const started=binding.legacy?(await windows('StartLegacy',binding),null):await startBoundRelease(binding);
      for(let i=0;i<60;i++){await new Promise(resolve=>setTimeout(resolve,1000));const live=await inspect(binding);if(!live.stopped){if(started&&live.pid!==started.pid)throw new Error('Unexpected runtime PID');active.set(binding.root,live);return live;}}
      throw new Error('New runtime did not listen on '+runtimeEndpointFromBinding(binding,{allowLegacy:true}).port);
    },
    probe:async(binding,running,cycle)=>{
      if(cycle===2)await new Promise(resolve=>setTimeout(resolve,15000));
      const live=await inspect(binding);if(live.pid!==running.pid)throw new Error('Runtime did not remain alive');
      await verifyTarget(binding);
      const endpoint=runtimeEndpointFromBinding(binding,{allowLegacy:true});
      const health=await fetch(endpoint.origin+'/api/v1/health',{signal:AbortSignal.timeout(30000)});
      if(!health.ok)throw new Error('Read-only health check failed');
      await probeReadOnlyPages(endpoint.origin);
      const about=await (await fetch(endpoint.origin+'/api/v1/about/version',{signal:AbortSignal.timeout(60000)})).json();
      assertAboutIdentity(binding,about);
    },
    accept:async(binding,running)=>{
      const accepted=await readJson(config.acceptedReleaseFile);
      await atomicJson(path.join(outside,'accepted-before.json'),accepted);
      await atomicJson(path.join(home,'previous-release.json'),previous);
      if(binding.legacy){await atomicJson(config.acceptedReleaseFile,{...await readJson(binding.previousAcceptedFile),rolledBackAt:new Date().toISOString(),running});return;}
      await atomicJson(config.acceptedReleaseFile,{...accepted,releaseTag:binding.releaseTag,
        local:{...accepted.local,root,branch:sourceIdentity(root).branch,commit:binding.sourceCommit,sourceRoot:binding.root,identity:binding.identity},
        github:{...accepted.github,mainCommit:binding.publicCommit},installed:binding,running,acceptedAt:new Date().toISOString()});
    },
    journal:value=>atomicJson(journalFile,value),
    rollbackCheck:async(old,next)=>{if(approval.rollbackApproved!==true)throw new Error('Rollback was not authorized');await inspectBusinessIdle(next);await verifyTarget(old);}
  });
}
