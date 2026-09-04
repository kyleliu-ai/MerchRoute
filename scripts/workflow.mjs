import { mkdir, writeFile, rename } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { developmentHome, registration, readBatch, assertBatch, sourceIdentity, git, atomicJson, withCommandLock, requireApply, readJson, recoverCommandLock } from './workflow/state.mjs';
import { createRuntimeEndpoint } from './lib/runtime-endpoint.mjs';

export function parseOptions(args) {
  const options={}; const positional=[];
  for(let i=0;i<args.length;i++){
    const arg=args[i];
    if(!arg.startsWith('--')){positional.push(arg);continue;}
    const key=arg.slice(2);
    if(['apply','approved','dry-run','full','quick'].includes(key))options[key]=true;
    else {if(!args[i+1]||args[i+1].startsWith('--'))throw new Error('Missing option: '+key);options[key]=args[++i];}
  }
  return {options,positional};
}
export async function beginBatch(root,home,options) {
  const config=await registration(root,home), identity=sourceIdentity(root), old=await readBatch(home);
  if(!/^[a-z0-9][a-z0-9-]{1,70}$/.test(options.name||'') || !options['task-id'])throw new Error('begin requires --name and --task-id');
  if(old?.status==='ACTIVE'){
    if(old.taskId===options['task-id'] && old.name===options.name && old.branch===identity.branch)return {resumed:true,batch:old};
    throw new Error('A different batch is active; finish it or explicitly approve a separate worktree');
  }
  if(identity.status)throw new Error('Uncommitted changes block a new batch');
  if(options.baseline!==config.baseline.commit || identity.commit!==config.baseline.commit || identity.tree!==config.baseline.tree)throw new Error('Explicit accepted local baseline mismatch');
  const stamp=new Date().toISOString().replace(/[-:]/g,'').slice(0,13).replace('T','-');
  const branch='work/'+options.name+'-'+stamp;
  if(options['dry-run'])return {dryRun:true,branch,baseline:identity.commit};
  requireApply(options);
  git(root,'switch','-c',branch,identity.commit);
  if(old?.status==='CLOSED'){
    const manifestPath=path.join(root,'config/release-features.json');
    const manifest=await readJson(manifestPath);
    manifest.completedBatches ||= [];
    if(!manifest.completedBatches.some(x=>x.name===old.branch))manifest.completedBatches.push({name:old.branch,head:old.acceptedCommit,featureId:'project-release-guardrails'});
    await writeFile(manifestPath,JSON.stringify(manifest,null,2)+'\n');
  }
  const batch={schemaVersion:1,name:options.name,taskId:options['task-id'],branch,baseline:identity.commit,status:'ACTIVE',startedAt:new Date().toISOString()};
  await atomicJson(path.join(home,'batch.json'),batch);
  return {created:true,batch};
}
export async function runWorkflow(args,{root=path.resolve(import.meta.dirname,'..'),home=developmentHome()}={}) {
  const {options,positional}=parseOptions(args), command=positional[0]||'status';
  const config=await registration(root,home);
  if(command==='recover-lock')return recoverCommandLock(home,options);
  if(command==='status'){
    const endpoint=createRuntimeEndpoint(config.production?.port||43173);
    let production;try{const response=await fetch(endpoint.origin+'/api/v1/about/version',{signal:AbortSignal.timeout(15000)});if(!response.ok)throw new Error();const result=await response.json();production={current:result.current,runtimeStatus:result.runtimeStatus,syncStatus:result.syncStatus,runtimeEndpoint:endpoint};}catch{production={unavailable:true,runtimeEndpoint:endpoint};}
    return {source:sourceIdentity(root),batch:await readBatch(home),baseline:config.baseline,github:config.github,production};
  }
  return withCommandLock(home,async()=>{
    if(command==='begin')return beginBatch(root,home,options);
    const batch=await assertBatch(root,home,options['task-id']);
    if(command==='verify'){
      const {verifyBatch}=await import('./workflow/verify.mjs');
      return verifyBatch(root,home,options);
    }
    if(command==='publish'){
      const {publishBatch}=await import('./workflow/publish.mjs');
      return publishBatch(root,home,config,batch,options);
    }
    if(command==='release'){
      const {releaseCommand}=await import('./workflow/release.mjs');
      return releaseCommand(positional[1],{root,home,config,batch,options});
    }
    if(command==='finish'){
      const accepted=await readJson(config.acceptedReleaseFile),identity=sourceIdentity(root);
      if(identity.status||accepted.local?.commit!==identity.commit||accepted.local?.identity?.headTreeHash!==identity.tree)throw new Error('Only the accepted, clean local release can close its batch');
      if(options['dry-run'])return {dryRun:true,canClose:true};
      requireApply(options);
      await mkdir(path.join(home,'completed'),{recursive:true});
      const completed={...batch,status:'CLOSED',acceptedCommit:identity.commit,closedAt:new Date().toISOString()};
      await atomicJson(path.join(home,'completed',batch.branch.replaceAll('/','_')+'.json'),completed);
      for(const name of ['publication.json','publication-intent.json','verified.json']){
        try{await rename(path.join(home,name),path.join(home,'completed',batch.name+'-'+name));}catch(error){if(error.code!=='ENOENT')throw error;}
      }
      await atomicJson(path.join(home,'machine.json'),{...config,baseline:{commit:identity.commit,tree:identity.tree},github:{...config.github,baselineCommit:accepted.github.mainCommit,baselineTree:identity.tree}});
      await atomicJson(path.join(home,'batch.json'),completed);
      return {closed:true,acceptedCommit:identity.commit};
    }
    throw new Error('Unknown workflow operation');
  });
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  try{console.log(JSON.stringify(await runWorkflow(process.argv.slice(2)),null,2));}catch(error){console.error(error.message);process.exitCode=1;}
}
