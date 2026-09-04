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
export function validateV012Rollover(previous,{main,baseTree,oldPr,oldRelease,oldPublishedTree}){
  if(!previous||previous.number!==26||previous.sourceCommit!=='922b08f444977edd480d1a020cf4a90c4f513809')throw new Error('GitHub main moved outside the approved v0.1.2 rollover; inspect without overwriting local code');
  if(oldPr?.merged!==true||oldPr?.state!=='closed'||oldPr?.base?.ref!=='main'||oldPr?.head?.sha!==previous.publicCommit
    ||oldRelease?.draft!==false||oldRelease?.prerelease!==false||oldRelease?.tag_name!=='v0.1.2'
    ||baseTree!==previous.tree||oldPublishedTree!==previous.tree){
    throw new Error('PR #26, v0.1.2, GitHub main and the accepted local v0.1.2 tree are not aligned');
  }
  return {publication:previous,main,tree:baseTree,releaseTag:'v0.1.2',status:'PUBLISHED_NOT_ACTIVATED',reason:'PORT_EXCLUDED'};
}
export function validateV013Rollover(previous,{main,baseTree,oldPr,oldRelease,oldPublishedTree}){
  if(!previous||previous.number!==27||previous.sourceCommit!=='360bc9557df5c902af6da0d3d048bde7f0029c51')throw new Error('GitHub main moved outside the approved v0.1.3 rollover; inspect without overwriting local code');
  if(oldPr?.merged!==true||oldPr?.state!=='closed'||oldPr?.base?.ref!=='main'||oldPr?.head?.sha!==previous.publicCommit
    ||oldRelease?.draft!==false||oldRelease?.prerelease!==false||oldRelease?.tag_name!=='v0.1.3'
    ||baseTree!==previous.tree||oldPublishedTree!==previous.tree){
    throw new Error('PR #27, v0.1.3, GitHub main and the accepted local v0.1.3 tree are not aligned');
  }
  return {publication:previous,main,tree:baseTree,releaseTag:'v0.1.3',status:'PUBLISHED_NOT_ACTIVATED',reason:'RELEASE_TOOL_PRE_STOP_PAYLOAD_BUG'};
}
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
  const base=githubJson(config,prefix+'/git/commits/'+main);
  let previous=null;try{previous=await readJson(path.join(home,'publication.json'));}catch(error){if(error.code!=='ENOENT')throw error;}
  let intent=null;try{intent=await readJson(path.join(home,'publication-intent.json'));}catch(error){if(error.code!=='ENOENT')throw error;}
  let rollover=null;
  if(main!==config.github.baselineCommit||base.tree.sha!==config.github.baselineTree){
    if(!previous||![26,27].includes(previous.number))throw new Error('GitHub main moved outside the approved release rollover; inspect without overwriting local code');
    const oldPr=githubJson(config,prefix+'/pulls/'+previous.number);
    const priorVersion=previous.number===27?'0.1.3':'0.1.2';
    const oldRelease=githubJson(config,prefix+'/releases/tags/v'+priorVersion);
    const oldPublished=githubJson(config,prefix+'/commits/v'+priorVersion);
    const input={main,baseTree:base.tree.sha,oldPr,oldRelease,oldPublishedTree:oldPublished.commit.tree.sha};
    rollover=previous.number===27?validateV013Rollover(previous,input):validateV012Rollover(previous,input);
    previous=null;
    if(intent?.sourceCommit!==identity.commit)intent=null;
  }else if([26,27].includes(previous?.number)){
    throw new Error('Merged release PR requires the explicit publication rollover contract before another publication');
  }
  const defaultPublicBranch='work/release-tool-fix-v014-'+new Date().toISOString().replace(/[-:TZ.]/g,'').slice(0,12);
  const publicBranch=intent?.branch||defaultPublicBranch;
  const resumable=intent?.sourceCommit===identity.commit&&intent?.tree===identity.tree&&intent?.branch===publicBranch&&intent?.parent===(previous?.publicCommit||main);
  if(previous&&previous.localBatchBranch!==batch.branch)throw new Error('Publication state belongs to another batch');
  if(previous){const pr=githubJson(config,prefix+'/pulls/'+previous.number);if(pr.state!=='open'||!pr.draft||![previous.publicCommit,...(resumable?[intent.publicCommit]:[])].includes(pr.head.sha))throw new Error('PR changed, merged or is no longer Draft; do not reuse it');}
  if(previous?.sourceCommit===identity.commit)return {unchanged:true,...previous};
  if(options['dry-run'])return {dryRun:true,sourceCommit:identity.commit,sourceTree:identity.tree,publicParent:previous?.publicCommit||main,branch:publicBranch,base:'main',draft:true,rollover};
  requireApply(options);
  if(rollover)await atomicJson(path.join(home,'completed',rollover.releaseTag.slice(1)+'-publication-not-activated.json'),{...rollover,archivedAt:new Date().toISOString()});
  const user=githubJson(config,'user');
  const expectedEmail=user.id+'+'+user.login+'@users.noreply.github.com';
  if(git(root,'config','user.email')!==expectedEmail)throw new Error('Public commits require the verified GitHub noreply email');
  const parent=previous?.publicCommit||main;
  // Fetch supplies public history only; it never updates working files or local HEAD.
  git(root,'fetch','--no-tags','origin',parent);
  const changed=git(root,'diff','--name-only','-z',main,identity.commit).split('\0').filter(Boolean).sort();
  if(!changed.length)throw new Error('No source changes; refusing an empty PR');
  if(changed.some(f=>isForbiddenPackagePath(f)))throw new Error('Public candidate contains a forbidden path');
  const message='fix(release): preserve runtime endpoint during v0.1.4 cutover\n\nLocal source: '+identity.commit+'\nExact source tree: '+identity.tree+'\nLocal authority; public history only.\n';
  const publicCommit=resumable?intent.publicCommit:execFileSync('git',['-C',root,'commit-tree',identity.tree,'-p',parent],{input:message,encoding:'utf8',windowsHide:true}).trim();
  if(git(root,'show','-s','--format=%T',publicCommit)!==identity.tree||git(root,'show','-s','--format=%P',publicCommit)!==parent)throw new Error('Publication recovery identity is invalid');
  git(root,'update-ref','refs/merchroute/publications/'+batch.name+'-v014',publicCommit);
  await atomicJson(path.join(home,'publication-intent.json'),{branch:publicBranch,localBatchBranch:batch.branch,publicCommit,parent,sourceCommit:identity.commit,tree:identity.tree,changed});
  git(root,'push','origin',publicCommit+':refs/heads/'+publicBranch);
  const remote=githubJson(config,prefix+'/git/commits/'+publicCommit);
  if(remote.tree.sha!==identity.tree)throw new Error('Published source tree does not match local candidate');
  let number=previous?.number;
  if(!number){const existing=githubJson(config,prefix+'/pulls?state=open&head='+encodeURIComponent(user.login+':'+publicBranch));if(existing.length>1)throw new Error('Ambiguous existing PR');number=existing[0]?.number;}
  if(!number){
    const body=path.join(home,'pr-body.md');await mkdir(home,{recursive:true});
    await writeFile(body,'## 本机权威候选\n\nMerchRoute v0.1.4 修复正式切换时停止进程遗漏 `runtimeEndpoint`，并允许旧版回滚在 About 尚未提供端点字段时完成严格身份验收。\n\n本机提交：'+identity.commit+'；源码树：'+identity.tree+'。\n\n本次不改写 v0.1.3 标签或资产，不改业务逻辑、n8n 工作流、数据库或 43173 配置；v0.1.3 记录为已发布但因发布工具预停止阶段缺陷未激活。\n\n完整检查、PostgreSQL、E2E、Jimeng、Gitleaks 和禁入扫描通过后才可合并。保持 Draft，不直接推送或合并 main；用户合并并发布 v0.1.4 后另行正式切换。\n');
    const url=github(config,['pr','create','--repo',repository,'--head',publicBranch,'--base','main','--draft','--title','fix(release): 修复 v0.1.4 正式切换工具','--body-file',body]);
    number=Number(url.match(/\/pull\/(\d+)/)?.[1]);if(!number)throw new Error('Cannot resolve created PR');
  }
  const pr=JSON.parse(github(config,['pr','view',String(number),'--repo',repository,'--json','isDraft,state,baseRefName,headRefOid,files,url']));
  if(!pr.isDraft||pr.state!=='OPEN'||pr.baseRefName!=='main'||pr.headRefOid!==publicCommit
    || JSON.stringify(pr.files.map(x=>x.path).sort())!==JSON.stringify(changed))throw new Error('PR readback failed; stop without modifying local source');
  const publication={number,url:pr.url,branch:publicBranch,localBatchBranch:batch.branch,publicCommit,sourceCommit:identity.commit,tree:identity.tree,base:main,draft:true,files:changed,ci:'PENDING'};
  await atomicJson(path.join(home,'publication.json'),publication);
  return publication;
}
