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
    const verified=await requireVerified(root,home);
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
      const response=await fetch(asset.browser_download_url,{signal:AbortSignal.timeout(60000)});
      if(!response.ok||digest(Buffer.from(await response.arrayBuffer()))!==artifact.sha256)throw new Error('Published asset differs from the accepted local build');
    }
    candidate={schemaVersion:2,...candidate,nodePath:config.nodePath,nodeSha256:config.nodeSha256,runtimeEndpoint:configuredEndpoint,
      ...config.production,releaseTag:'v'+candidate.productVersion,logDirectory:path.join(config.runtimeHome,'logs'),
      launcherSha256:digest(await readFile(path.join(candidate.root,'scripts/release-runtime.mjs'))),publicCommit:published.sha};
    candidate.bootstrapHashes={};
    for(const file of ['scripts/release-runtime.mjs','scripts/lib/installed-release.mjs','scripts/workflow/development.mjs','scripts/workflow/state.mjs'])candidate.bootstrapHashes[file]=digest(await readFile(path.join(candidate.root,file)));
  }
  if(previous.legacy===true){previous={...previous,schemaVersion:2,runtimeEndpoint:configuredEndpoint};}
  if(candidate.legacy===true){candidate={...candidate,schemaVersion:2,runtimeEndpoint:configuredEndpoint};}
  if(approval.expectedCurrentCommit!==previous.sourceCommit||approval.targetCommit!==candidate.sourceCommit)throw new Error('Approval is not bound to the current and target builds');
  const verifyTarget=binding=>binding.legacy?verifyLegacyRelease(binding):verifyInstalledRelease(binding.root,binding.manifestSha256);
  await verifyTarget(candidate);await verifyTarget(previous);
  await inspectBusinessIdle(previous);
  if(options['dry-run'])return {dryRun:true,from:previous.sourceCommit,to:candidate.sourceCommit,release:candidate.releaseTag};
  requireApply(options);
  const journalFile=path.join(home,'release-journal.json');
  try{const old=await readJson(journalFile);if(!['ACCEPTED','ROLLED_BACK'].includes(old.state))throw new Error('Interrupted release journal requires explicit recovery');}catch(error){if(error.code!=='ENOENT')throw error;}
  const outside=path.join(config.recoveryDirectory,'cutover-'+Date.now());await mkdir(outside,{recursive:true,mode:0o700});
  const shortcuts=[];
  for(const [index,file] of config.production.shortcuts.entries()){const backup=path.join(outside,'shortcut-'+index+'.lnk');await copyFile(file,backup);shortcuts.push({path:file,backup,sha256:digest(await readFile(backup))});}
  if(previous.legacy)previous.shortcutBackups=shortcuts;
  async function windows(action,data){const file=path.join(outside,'windows-input.json');await atomicJson(file,data);const result=execFileSync('powershell.exe',['-NoProfile','-File',path.join(root,'scripts/release-windows.ps1'),'-Action',action,'-InputFile',file],{encoding:'utf8',windowsHide:true});return result.trim()?JSON.parse(result):null;}
  const active=new Map();
  async function inspect(binding){return windows('Inspect',{entry:path.join(binding.root,'apps/server/dist/index.js'),nodePath:binding.nodePath,runtimeEndpoint:runtimeEndpointFromBinding(binding,{allowLegacy:true})});}
  const fixedLauncher=path.join(config.runtimeHome,'Start-MerchRoute.ps1'),pointer=path.join(config.runtimeHome,'current-release.json');
  return switchRelease({previous,candidate,
    check:async(old,next)=>{await inspectBusinessIdle(old);const live=await inspect(old);if(live.stopped){if(approval.expectedStopped!==true)throw new Error('Production process unexpectedly stopped');}else{if(live.pid!==approval.expectedPid)throw new Error('Production process changed');active.set(old.root,live);}await verifyTarget(next);},
    stop:async(binding)=>{const live=await inspect(binding);if(live.stopped)return;const expected=active.get(binding.root);if(!expected||expected.pid!==live.pid)throw new Error('Refusing to stop an unowned process');await inspectBusinessIdle(binding);await windows('Stop',live);},
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
      if(about.current.commitSha!==binding.sourceCommit||about.current.productVersion!==binding.productVersion||about.runtimeStatus!=='CURRENT'
        ||about.current.runtimeEndpoint?.origin!==endpoint.origin)throw new Error('About identity mismatch');
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
