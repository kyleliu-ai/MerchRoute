import { execFileSync } from 'node:child_process';
import { readFile, mkdir, writeFile, mkdtemp } from 'node:fs/promises';
import path from 'node:path';
import { git, readJson, sourceIdentity, atomicJson, requireApply, assertExternal } from './state.mjs';
import { isForbiddenPackagePath } from '../package-release-candidate.mjs';
import { digest } from '../lib/installed-release.mjs';
import { verifyDevelopmentDatabase } from './development-database.mjs';
import { verifyAcceptedCandidate } from './candidate-acceptance.mjs';

export function github(config,args){return execFileSync(config.githubCli||'gh',args,{encoding:'utf8',windowsHide:true,stdio:['ignore','pipe','pipe'],maxBuffer:32*1024*1024}).trim();}
export function githubJson(config,endpoint){return JSON.parse(github(config,['api','--method','GET',endpoint]));}
export async function requireVerified(root,home){
  await verifyDevelopmentDatabase(root,home);
  const identity=sourceIdentity(root), record=await readJson(path.join(home,'verified.json'));
  if(identity.status || record.level!=='full'||record.ok!==true||!record.publishable
    || record.identity.commit!==identity.commit||record.identity.tree!==identity.tree)throw new Error('Current clean candidate has not passed full verification');
  const required=['check','postgres-integration','browser-build','e2e','jimeng','isolated-runtime','release-verifier-tests','restart-safety','retirement-safety','gitleaks','gitleaks-files','diff-check','deployment-verify'];
  for(const id of required){const entry=record.records.find(x=>x.id===id);if(!entry||entry.exitCode!==0||digest(await readFile(entry.log))!==entry.sha256)throw new Error('Verification evidence missing or changed: '+id);}
  const strict=await readFile(record.strictResult);
  if(digest(strict)!==record.strictSha256||!JSON.parse(strict).releaseReady||JSON.parse(strict).identity.commit!==identity.commit)throw new Error('Strict retained-feature acceptance is missing or changed');
  if(record.candidate?.sourceCommit!==identity.commit||record.candidate?.sourceTree!==identity.tree)throw new Error('Accepted runtime build does not match current source');
  await verifyAcceptedCandidate(await readJson(path.join(home,'candidate.json')),record.candidate);
  return {identity,record};
}
export async function publishBatch(root,home,config,batch,options){
  let identity=sourceIdentity(root);
  if(identity.status){
    if(!options['files-json']||!options.message)throw new Error('Selective commit requires --files-json and --message');
    await assertExternal(root,options['files-json']);
    const files=await readJson(options['files-json']);
    if(!Array.isArray(files)||!files.length||new Set(files).size!==files.length||files.some(f=>isForbiddenPackagePath(f)))throw new Error('Invalid or forbidden selective file list');
    const staged=git(root,'diff','--cached','--name-only','-z').split('\0').filter(Boolean);
    if(staged.some(file=>!files.includes(file)))throw new Error('Index contains files outside this batch');
    if(options['dry-run'])return {dryRun:true,selectiveFiles:files,next:'commit, then full verification; no push'};
    requireApply(options);
    git(root,'add','--',...files);git(root,'diff','--cached','--check');
    const scanRoot=await mkdtemp(path.join(home,'precommit-scan-'));
    const indexTree=git(root,'write-tree');
    const entries=git(root,'ls-tree','-r','-z',indexTree).split('\0').filter(Boolean).map(line=>{const split=line.indexOf('\t');const [mode,type,sha]=line.slice(0,split).split(' ');return {path:line.slice(split+1),mode,type,sha};});
    const objects=execFileSync('git',['-C',root,'cat-file','--batch'],{input:entries.map(x=>x.sha).join('\n')+'\n',maxBuffer:512*1024*1024,windowsHide:true});
    let offset=0;
    for(const entry of entries){
      if(isForbiddenPackagePath(entry.path)||entry.type!=='blob'||!['100644','100755'].includes(entry.mode))throw new Error('Forbidden tracked path: '+entry.path);
      const end=objects.indexOf(10,offset),[sha,type,sizeText]=objects.subarray(offset,end).toString('ascii').split(' '),size=Number(sizeText);
      if(end<0||sha!==entry.sha||type!=='blob'||!Number.isSafeInteger(size)||size<0||objects[end+size+1]!==10)throw new Error('Incomplete index scan');
      const data=objects.subarray(end+1,end+1+size);offset=end+size+2;
      const target=path.join(scanRoot,entry.path);await mkdir(path.dirname(target),{recursive:true});await writeFile(target,data,{flag:'wx'});
    }
    if(offset!==objects.length||git(root,'write-tree')!==indexTree)throw new Error('Index changed during security scan');
    const scan=execFileSync(config.gitleaksPath,['dir',scanRoot,'--redact=100','--no-banner','--no-color'],{encoding:'utf8',windowsHide:true,stdio:['ignore','pipe','pipe']});
    await writeFile(path.join(home,'precommit-scan.log'),scan,{mode:0o600});
    if(git(root,'write-tree')!==indexTree)throw new Error('Index changed after security scan');
    git(root,'commit','-m',options.message);
    return {committed:sourceIdentity(root).commit,pushed:false,next:'Run full verification, then publish again'};
  }
  const verified=await requireVerified(root,home);identity=verified.identity;
  const repository='kyleliu-ai/MerchRoute',prefix='repos/'+repository;
  if(config.github?.repository!==repository)throw new Error('Unapproved repository');
  const main=githubJson(config,prefix+'/git/ref/heads/main').object.sha;
  if(main!==config.github.baselineCommit)throw new Error('GitHub main moved outside this batch; inspect differences without overwriting local code');
  const base=githubJson(config,prefix+'/git/commits/'+main);
  if(base.tree.sha!==config.github.baselineTree)throw new Error('Public baseline tree changed');
  let previous=null;try{previous=await readJson(path.join(home,'publication.json'));}catch(error){if(error.code!=='ENOENT')throw error;}
  let intent=null;try{intent=await readJson(path.join(home,'publication-intent.json'));}catch(error){if(error.code!=='ENOENT')throw error;}
  const resumable=intent?.sourceCommit===identity.commit&&intent?.tree===identity.tree&&intent?.branch===batch.branch&&intent?.parent===(previous?.publicCommit||main);
  if(previous&&previous.branch!==batch.branch)throw new Error('Publication state belongs to another batch');
  if(previous){const pr=githubJson(config,prefix+'/pulls/'+previous.number);if(pr.state!=='open'||!pr.draft||![previous.publicCommit,...(resumable?[intent.publicCommit]:[])].includes(pr.head.sha))throw new Error('PR changed, merged or is no longer Draft; do not reuse it');}
  if(previous?.sourceCommit===identity.commit)return {unchanged:true,...previous};
  if(options['dry-run'])return {dryRun:true,sourceCommit:identity.commit,sourceTree:identity.tree,publicParent:previous?.publicCommit||main,branch:batch.branch,base:'main',draft:true};
  requireApply(options);
  const user=githubJson(config,'user');
  const expectedEmail=user.id+'+'+user.login+'@users.noreply.github.com';
  if(git(root,'config','user.email')!==expectedEmail)throw new Error('Public commits require the verified GitHub noreply email');
  const parent=previous?.publicCommit||main;
  // Fetch supplies public history only; it never updates working files or local HEAD.
  git(root,'fetch','--no-tags','origin',parent);
  const changed=git(root,'diff','--name-only','-z',main,identity.commit).split('\0').filter(Boolean).sort();
  if(!changed.length)throw new Error('No source changes; refusing an empty PR');
  if(changed.some(f=>isForbiddenPackagePath(f)))throw new Error('Public candidate contains a forbidden path');
  const message='chore(workflow): single-developer isolated release workflow\n\nLocal source: '+identity.commit+'\nExact source tree: '+identity.tree+'\nLocal authority; public history only.\n';
  const publicCommit=resumable?intent.publicCommit:execFileSync('git',['-C',root,'commit-tree',identity.tree,'-p',parent],{input:message,encoding:'utf8',windowsHide:true}).trim();
  if(git(root,'show','-s','--format=%T',publicCommit)!==identity.tree||git(root,'show','-s','--format=%P',publicCommit)!==parent)throw new Error('Publication recovery identity is invalid');
  git(root,'update-ref','refs/merchroute/publications/'+batch.name,publicCommit);
  await atomicJson(path.join(home,'publication-intent.json'),{branch:batch.branch,publicCommit,parent,sourceCommit:identity.commit,tree:identity.tree,changed});
  git(root,'push','origin',publicCommit+':refs/heads/'+batch.branch);
  const remote=githubJson(config,prefix+'/git/commits/'+publicCommit);
  if(remote.tree.sha!==identity.tree)throw new Error('Published source tree does not match local candidate');
  let number=previous?.number;
  if(!number){const existing=githubJson(config,prefix+'/pulls?state=open&head='+encodeURIComponent(user.login+':'+batch.branch));if(existing.length>1)throw new Error('Ambiguous existing PR');number=existing[0]?.number;}
  if(!number){
    const body=path.join(home,'pr-body.md');await mkdir(home,{recursive:true});
    await writeFile(body,'## 本机权威候选\n\n固定目录串行开发、隔离开发环境、独立运行包和版本 0.1.2 候选。\n\n本机提交：'+identity.commit+'；源码树：'+identity.tree+'。\n\n完整检查、PostgreSQL、E2E、Jimeng、Gitleaks 和禁入扫描已通过。正式 4173、启动入口、生产配置和工作流保持不变。\n\n保持 Draft，不合并 main；用户合并并发布 v0.1.2 后另行进行本机切换。\n');
    const url=github(config,['pr','create','--repo',repository,'--head',batch.branch,'--base','main','--draft','--title','chore(workflow): 单人串行开发与独立发布迁移','--body-file',body]);
    number=Number(url.match(/\/pull\/(\d+)/)?.[1]);if(!number)throw new Error('Cannot resolve created PR');
  }
  const pr=JSON.parse(github(config,['pr','view',String(number),'--repo',repository,'--json','isDraft,state,baseRefName,headRefOid,files,url']));
  if(!pr.isDraft||pr.state!=='OPEN'||pr.baseRefName!=='main'||pr.headRefOid!==publicCommit
    || JSON.stringify(pr.files.map(x=>x.path).sort())!==JSON.stringify(changed))throw new Error('PR readback failed; stop without modifying local source');
  const publication={number,url:pr.url,branch:batch.branch,publicCommit,sourceCommit:identity.commit,tree:identity.tree,base:main,draft:true,files:changed,ci:'PENDING'};
  await atomicJson(path.join(home,'publication.json'),publication);
  return publication;
}
