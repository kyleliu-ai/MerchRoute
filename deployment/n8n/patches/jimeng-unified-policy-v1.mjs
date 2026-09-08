import {createImageCompletionPolicy, imageCompletionPolicy as policy} from '../../../integrations/jimeng-free-api-all/src/api/services/image-completion-policy.mjs';
import {createHash} from 'node:crypto';

export const policyPrelude = `const imagePolicy = (${createImageCompletionPolicy.toString()})();\n`;
export const policyHash = createHash('sha256').update(policyPrelude).digest('hex');
const clone = value => structuredClone(value);
// Portable SHA-256 avoids changing the production n8n built-in-module allowlist.
// Used only for stable source identity, never credential encryption.
export function sourceFingerprint(value) {
  const text=unescape(encodeURIComponent(JSON.stringify(value)));
  const bytes=Array.from(text,ch=>ch.charCodeAt(0));const bitLength=bytes.length*8;
  bytes.push(128);while(bytes.length%64!==56)bytes.push(0);
  for(let i=7;i>=0;i--)bytes.push(i>=4?Math.floor(bitLength/2**(i*8))&255:(bitLength>>>i*8)&255);
  const h=[0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19];
  const k=[0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2];
  const rotr=(x,n)=>(x>>>n)|(x<<(32-n));
  for(let offset=0;offset<bytes.length;offset+=64){
    const w=Array(64).fill(0);for(let i=0;i<16;i++)for(let j=0;j<4;j++)w[i]=(w[i]<<8)|bytes[offset+i*4+j];
    for(let i=16;i<64;i++){const x=w[i-15],y=w[i-2];w[i]=(w[i-16]+(rotr(x,7)^rotr(x,18)^(x>>>3))+w[i-7]+(rotr(y,17)^rotr(y,19)^(y>>>10)))|0;}
    let [a,b,c,d,e,f,g,z]=h;
    for(let i=0;i<64;i++){const t1=(z+(rotr(e,6)^rotr(e,11)^rotr(e,25))+((e&f)^(~e&g))+k[i]+w[i])|0;const t2=((rotr(a,2)^rotr(a,13)^rotr(a,22))+((a&b)^(a&c)^(b&c)))|0;z=g;g=f;f=e;e=(d+t1)|0;d=c;c=b;b=a;a=(t1+t2)|0;}
    for(const [i,x]of [a,b,c,d,e,f,g,z].entries())h[i]=(h[i]+x)|0;
  }
  return h.map(x=>(x>>>0).toString(16).padStart(8,'0')).join('');
}
const nodeId = name => {
  const bytes = createHash('sha256').update('merchroute-image-v1:'+name).digest();
  bytes[6]=(bytes[6]&15)|64; bytes[8]=(bytes[8]&63)|128;
  const hex=bytes.subarray(0,16).toString('hex');
  return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
};
const code = (name, jsCode, index) => ({id:nodeId(name),name,type:'n8n-nodes-base.code',typeVersion:2,position:[400+index*220,300],parameters:{mode:'runOnceForAllItems',jsCode}});
const connect = (w, from, to, output=0) => {w.connections[from] ||= {main:[]};w.connections[from].main[output] = [{node:to,type:'main',index:0}];};
function replaceExact(text, before, after) {
  if(!text.includes(before)) throw new Error('Live workflow contract changed; candidate not generated');
  return text.replace(before,after);
}

function prepareExisting(w, profile) {
  const build=w.nodes.find(n=>n.name==='Build Async Submit Batch');
  if(!build) throw new Error('Missing original task builder');
  build.parameters.jsCode = `const originalBuild = () => {\n${build.parameters.jsCode}\n};\n${policyPrelude}
const output=originalBuild();
for(const item of output) {
 if(${JSON.stringify(profile)}==='S003') item.json.completionPolicy={targetImageCount:imagePolicy.targetImageCount,minimumSuccessImageCount:imagePolicy.minimumSuccessImageCount,attemptTimeoutMs:imagePolicy.profiles.S003.initialMs};
 for(const task of item.json.tasks || []) {
 task.policyVersion=imagePolicy.version; task.workflowProfile=${JSON.stringify(profile)};
 if(item.json.completionPolicy)task.completionPolicy={...item.json.completionPolicy};
 }
}
return output;`;
  const retry=w.nodes.find(n=>n.name==='Build Explicit Retry Batch');
  let js=retry.parameters.jsCode;
  const start=js.indexOf('const explicitFailures = firstResults.filter(');
  const end=profile==='E002'?js.indexOf(';',start)+1:js.indexOf('\n});',start)+4;
  if(start<0||end<start)throw new Error('Retry predicate changed');
  js=js.slice(0,start)+`const explicitFailures = firstResults.filter(task => task.canRetry === true && imagePolicy.evaluate({...task, retryAttempt: Number(task.context?.retryAttempt || 0)}).canRetry);`+js.slice(end);
  retry.parameters.jsCode=`${policyPrelude}const originalRetry=()=>{\n${js}\n};
const output=originalRetry();
for(const item of output) for(const task of item.json.tasks || []) {
 task.policyVersion=imagePolicy.version; task.workflowProfile=${JSON.stringify(profile)};
 task.parentIdempotencyKey=String(task.idempotencyKey).replace(/:attempt-1$/,':attempt-0');
}
return output;`;
  for(const n of w.nodes){
    if(n.type==='n8n-nodes-base.httpRequest' && /Submit/.test(n.name)){n.retryOnFail=false;n.maxTries=1;}
    if(profile==='S003' && n.type==='n8n-nodes-base.code' && n.parameters.jsCode?.includes('function normalizeTask(task, nowMs)')) {
      const old=n.parameters.jsCode;const a=old.indexOf('function normalizeTask(task, nowMs)');const b=old.indexOf('\n}\n',a)+3;
      if(b<a)throw new Error('Normalization boundary changed');
      const fn=`function normalizeTask(task, nowMs) {
 const source=sourceByTaskId.get(String(task?.taskId || '')) || {};
 const context={...source,...(task?.context || {})};
 const started=Number(task?.context?.attemptStartedAtMs || context.attemptPreparedAtMs || Date.parse(task?.createdAt || ''));
 if(!Number.isFinite(started)||started<=0)throw new Error('Missing stable task timestamp');
 const timing=imagePolicy.timing('S003',Number(context.retryAttempt || 0),started,nowMs);
 const result=imagePolicy.evaluate({...task, imageUrls:urlsOf(task), referenceImages:$('Build Async Submit Batch').first().json.images, deadlineReached:timing.deadlineReached, retryAttempt:Number(context.retryAttempt || 0)});
 return {...task,...result,status:result.state==='processing'&&['reserved','submission_unknown'].includes(task.status)?task.status:result.state,context,
  attemptStartedAtMs:started,attemptDeadlineAtMs:timing.deadlineAtMs,deadlineReached:timing.deadlineReached};
}`;
      n.parameters.jsCode=policyPrelude+old.slice(0,a)+fn+old.slice(b);
      n.parameters.jsCode=n.parameters.jsCode.replace('const terminalOrLimit = statusQueryFailed || tasks.every(', 'const terminalOrLimit = tasks.every(');
    }
    if(profile==='E002' && /^Evaluate (View|Retry) Tasks$/.test(n.name)) {
      const old=n.parameters.jsCode;
      n.parameters.jsCode=policyPrelude+old.replace('const tasks = Array.isArray(input.tasks) ? input.tasks : [];',`const tasks = Array.isArray(input.tasks) ? input.tasks.map(task=>{
 const result=imagePolicy.evaluate({...task,deadlineReached:Number(input.pollCount || 0)+1>=Number(input.maxPollCount || 120),retryAttempt:Number(task.context?.retryAttempt || 0)});
 return {...task,...result,status:result.state==='processing'&&['reserved','submission_unknown'].includes(task.status)?task.status:result.state};
}) : [];`);
      // Preserve local completion results in the output, not the original input.
      n.parameters.jsCode=n.parameters.jsCode.replace('  ...input,','  ...input,\n  tasks,');
      const waitName=n.name==='Evaluate View Tasks'?'Wait View Tasks':'Wait Retry Tasks';
      n.parameters.jsCode=n.parameters.jsCode.replace('const input = $input.first().json || {};',`const response=$input.first().json || {};
const carried=$(${JSON.stringify(waitName)}).first().json;
const valid=response.ok===true && Array.isArray(response.tasks) && response.tasks.length===carried.tasks.length;
const input={...(valid?response:carried),ok:true,code:undefined,pollCount:carried.pollCount,maxPollCount:120,queryFailed:!valid};`);
    }
    if(n.type==='n8n-nodes-base.httpRequest' && /^Check .* Tasks Status$/.test(n.name)){
      n.retryOnFail=false;n.maxTries=1;n.onError='continueRegularOutput';
      // Error output is now the regular output, preventing duplicate deliveries.
      if(w.connections[n.name]?.main?.length>1)w.connections[n.name].main=w.connections[n.name].main.slice(0,1);
      if(profile==='S003')n.parameters.options.timeout='={{ Math.max(1, Math.min(15000, Number($json.attemptDeadlineAtMs || 0) - Date.now())) }}';
    }
    if(profile==='S003' && n.name==='Return Image URLs') {
      n.parameters.jsCode=policyPrelude+n.parameters.jsCode.replace('  const urls = urlsOf(task);\n  const success = urls.length >= 1;',`  const result=imagePolicy.evaluate({...task,imageUrls:urlsOf(task),referenceImages:sourceBatch.images,deadlineReached:task.deadlineReached===true,retryAttempt:Number(task.context?.retryAttempt || 0)});
  const success=result.state==='success';
  const urls=success?result.imageUrls:[];`);
    }
    if(profile==='S003' && n.type==='n8n-nodes-base.code' && n.parameters.jsCode?.startsWith(policyPrelude) && n.parameters.jsCode.lastIndexOf('function urlKey(value)')>=policyPrelude.length) {
      const js=n.parameters.jsCode;const start=js.lastIndexOf('function urlKey(value)');const end=js.indexOf('\n}\n',start)+3;
      if(end<start)throw new Error('URL normalization boundary changed');
      // All reference/result identity decisions use the same maintained policy.
      n.parameters.jsCode=js.slice(0,start)+'function urlKey(value) { return imagePolicy.urlKey(value); }'+js.slice(end);
    }
    if(profile==='E002' && n.name==='Build Download Batch') {
      n.parameters.jsCode=policyPrelude+n.parameters.jsCode.replace('    count: Number(result.count || 0),','    count: Number(result.count || 0),\n    policyVersion: imagePolicy.version,\n    partial: Boolean(result.partial),\n    completionReason: String(result.completionReason || ""),\n    canRetry: Boolean(result.canRetry),');
    }
  }
}

function e001Seed(items, executionId, imagePolicy) {
  const batches=[];const groups=new Map();const identities=new Set();
  for(const [index,item] of items.entries()) {
    const source=item.json;
    const images=source.imageUrls;
    if(!Array.isArray(images)||!images.length)throw new Error('Missing cutout references');
    const sourceSubmissionId=String(source.sourceSubmissionId || '').trim();
    if(!sourceSubmissionId)throw new Error('Missing durable source submission identity; do not replace it with a new execution ID');
    const common={model:source.constants.model.jimengModel,ratio:source.ratio||'1:1',resolution:source.resolution||'2k',sourceSubmissionId};
    const key=JSON.stringify([images,common]);
    let group=groups.get(key);
    if(!group || group.tasks.length===7){
      const groupSubmissionId=sourceSubmissionId+':group-'+batches.length;
      group={images,common:{...common,sourceSubmissionId:groupSubmissionId},uploadKey:`E002:v1:${groupSubmissionId}:source-images`,sourceImages:images.map((_,i)=>({sourceFileName:source.sourceFileName || `reference-${i+1}.png`,originalIndex:i})),tasks:[],sources:[],constants:source.constants,batchKey:`E001:unified:${sourceSubmissionId}:batch-${batches.length}:attempt-0`,concurrency:Math.min(5,Number(source.concurrent||5))};
      batches.push(group);groups.set(key,group);
    }
    // eslint-disable-next-line @typescript-eslint/no-unused-vars -- Omit credentials from the persisted task context.
    const {constants,...context}=source;
    // Do not send unrelated product inputs or credentials into the proxy ledger.
    const taskId=String(source.taskId||index+1);
    const task={taskId,sourceSubmissionId:group.common.sourceSubmissionId,originalIndex:index,prompt:source.viewPrompt,retryAttempt:0,
      policyVersion:imagePolicy.version,workflowProfile:'E001',
      idempotencyKey:`E001:unified:${sourceSubmissionId}:${taskId}:attempt-0`};
    if(identities.has(task.idempotencyKey))throw new Error('Duplicate cutout task');
    identities.add(task.idempotencyKey);
    group.tasks.push(task);group.sources.push(context);
  }
  return [{json:{batches,batchIndex:0,results:[]}}];
}

function prepareE001(w) {
  const stable=w.nodes.find(n=>n.name==='Parse Folder Stable Result');
  stable.parameters.jsCode=`const sourceFingerprint=(${sourceFingerprint.toString()});\n`+stable.parameters.jsCode;
  stable.parameters.jsCode=replaceExact(stable.parameters.jsCode,'    folderStable: true,',`    folderStable: true,
    sourceSubmissionId: String(trigger.sourceSubmissionId || '').trim() || 'E001:source-v1:'+sourceFingerprint({
      folder:String(trigger.productFolderPath || '').replace(/\\\\/g,'/'),
      latestMtimeMs:summary.latestMtimeMs,totalBytes:summary.totalBytes,files:summary.files,
    }),`);
  stable.parameters.jsCode=replaceExact(stable.parameters.jsCode,"const trigger = $('Dedupe Folder Path').first().json || {};",`const trigger = $('Dedupe Folder Path').first().json || {};
if(!Number.isFinite(Number(summary.latestMtimeMs)) || Number(summary.latestMtimeMs)<=0 || !Array.isArray(summary.files) || !summary.files.length)throw new Error('Missing stable source fingerprint; no generation submitted');`);
  const parse=w.nodes.find(n=>n.name==='Parse Product Folder');
  parse.parameters.jsCode=replaceExact(parse.parameters.jsCode,'    productName,',"    sourceSubmissionId: $('Parse Folder Stable Result').first().json.sourceSubmissionId,\n    productName,");
  const remove=new Set(['Generate Cutout Image','Build Retry Plan','Has Retry Items','Expand Retry Items','Generate Cutout Image Retry Once','Merge Generation Results']);
  const template=clone(w.nodes.find(n=>n.name==='Generate Cutout Image'));
  if(!template)throw new Error('Missing E001 generation node');
  w.nodes=w.nodes.filter(n=>!remove.has(n.name));for(const name of remove)delete w.connections[name];
  const add=(name,js)=>{w.nodes.push(code(name,policyPrelude+js,w.nodes.length));};
  add('MR Build Batches',`return (${e001Seed.toString()})($input.all(),String($execution.id||''),imagePolicy);`);
  add('MR Select Batch',`const state=$input.first().json;const batch=state.batches[state.batchIndex];return [{json:{...state,...batch,attempt:0,pollCount:0,firstResults:[],currentSources:batch.sources}}];`);
  add('MR Request Context',`return $input.all();`);
  function http(name,route,body){
    const n=clone(template);n.id=nodeId(name);n.name=name;n.retryOnFail=false;n.maxTries=1;n.onError='continueRegularOutput';
    n.parameters.url="={{ String($json.constants.BaseUrl.JimengUrl).trim().replace(/\\/+$/, '') + '"+route+"' }}";
    n.parameters.jsonBody='={{ JSON.stringify('+body+') }}';
    n.parameters.options={response:{response:{neverError:true,responseFormat:'json'}},timeout:15000};
    if(name==='MR Query Tasks')n.parameters.options.timeout='={{ Math.max(1, Math.min(15000, Math.min(...$json.tasks.filter(t => !t.terminal && !t.deadlineReached).map(t => t.attemptDeadlineAtMs)) - Date.now())) }}';
    w.nodes.push(n);
  }
  http('MR Submit Tasks','/v1/images/tasks/batch','{batchKey:$json.batchKey,uploadKey:$json.uploadKey,concurrency:$json.concurrency,common:$json.common,images:$json.images,sourceImages:$json.sourceImages,tasks:$json.tasks}');
  http('MR Query Tasks','/v1/images/tasks/status','{batchKey:$json.batchKey,uploadKey:$json.uploadKey,recovery:{uploadKey:$json.uploadKey,common:$json.common,images:$json.images,sourceImages:$json.sourceImages},phase:$json.attempt?"retry":"initial",pollCount:$json.pollCount,concurrency:4,tasks:$json.tasks.map(t=>({taskId:t.taskId,idempotencyKey:t.idempotencyKey,historyId:t.historyId||""}))}');
  add('MR Initialize',`const state=$('MR Request Context').first().json;const response=$input.first().json;
if(!Array.isArray(response.tasks)&&response.ok===false&&response.code)throw new Error('Cutout submission rejected; no automatic resubmission: '+String(response.code));
const now=Date.now();const tasks=Array.isArray(response.tasks)?response.tasks:state.tasks.map(t=>({...t,status:'submission_unknown',context:{...t,attemptStartedAtMs:now}}));
if(tasks.length!==state.tasks.length)throw new Error('Unexpected cutout submission task count');
return [{json:{...state,tasks,pollCount:0,attemptStartedAtMs:now,queryFailed:!Array.isArray(response.tasks)}}];`);
  const evaluate=`const now=Date.now();const tasks=state.tasks.map(task=>{
 const started=Number(task.context?.attemptStartedAtMs||state.attemptStartedAtMs);
 const timing=imagePolicy.timing('E001',state.attempt,started,now,state.pollCount);
 const result=imagePolicy.evaluate({...task,referenceImages:state.images,retryAttempt:state.attempt,deadlineReached:timing.deadlineReached});
 return {...task,...result,status:result.state==='processing'&&['reserved','submission_unknown'].includes(task.status)?task.status:result.state,deadlineReached:timing.deadlineReached,attemptDeadlineAtMs:timing.deadlineAtMs};
});const pending=tasks.some(t=>!t.terminal&&!t.deadlineReached&&t.status!=='submission_unknown');
return [{json:{...state,tasks,pending}}];`;
  add('MR Evaluate',`const state=$input.first().json;${evaluate}`);
  function condition(name,field){w.nodes.push({id:nodeId(name),name,type:'n8n-nodes-base.if',typeVersion:2.2,position:[900,300],parameters:{conditions:{options:{typeValidation:'strict',version:2},conditions:[{id:nodeId(name+':condition'),leftValue:'={{ $json.'+field+' }}',operator:{type:'boolean',operation:'true',singleValue:true}}],combinator:'and'},options:{}}});}
  condition('MR Pending','pending');condition('MR Retry Needed','retryNeeded');condition('MR More Batches','moreBatches');
  w.nodes.push({id:nodeId('MR Wait'),name:'MR Wait',type:'n8n-nodes-base.wait',typeVersion:1.1,position:[1100,300],parameters:{resume:'timeInterval',amount:'={{ Math.max(0.001, Math.min(10, (Math.min(...$json.tasks.filter(t => !t.terminal && !t.deadlineReached).map(t => t.attemptDeadlineAtMs)) - Date.now()) / 1000)) }}',unit:'seconds'}});
  add('MR Carry Status',`const state=$('MR Wait').first().json;const response=$input.first().json;
const ok=response.ok===true&&Array.isArray(response.tasks)&&response.tasks.length===state.tasks.length;
return [{json:{...state,tasks:ok?response.tasks:state.tasks,pollCount:state.pollCount+1,queryFailed:!ok}}];`);
  add('MR Retry Plan',`const state=$input.first().json;const failed=state.attempt===0?state.tasks.filter(t=>t.canRetry===true):[];
if(!failed.length)return [{json:{...state,retryNeeded:false}}];
const batch=state.batches[state.batchIndex];const byKey=new Map(batch.tasks.map(t=>[t.idempotencyKey,t]));
const retryTasks=failed.map(t=>({...byKey.get(t.idempotencyKey),parentIdempotencyKey:t.idempotencyKey,retryAttempt:1,idempotencyKey:t.idempotencyKey.replace(/:attempt-0$/,':attempt-1')}));
return [{json:{...state,firstResults:state.tasks,tasks:retryTasks,attempt:1,pollCount:0,batchKey:batch.batchKey.replace(/:attempt-0$/,':attempt-1'),retryNeeded:true}}];`);
  add('MR Collect Batch',`const state=$input.first().json;const batch=state.batches[state.batchIndex];
const byId=new Map(state.firstResults.map(t=>[t.taskId,t]));for(const task of state.tasks)byId.set(task.taskId,task);
const rows=batch.tasks.map((original,i)=>{
 const task=byId.get(original.taskId);if(!task)throw new Error('Missing cutout result');
 return {...batch.sources[i],...task,originalIndex:original.originalIndex,ok:task.status==='success',success:task.status==='success',
  retryAttempt:Number(task.context?.retryAttempt||0),image_urls:task.imageUrls,urls:task.imageUrls,data:task.imageUrls.map(url=>({url})),
  finalFailureReason:task.completionReason,taskId:original.taskId};
});const results=[...state.results,...rows];const batchIndex=state.batchIndex+1;
return [{json:{batches:state.batches,batchIndex,results,moreBatches:batchIndex<state.batches.length}}];`);
  add('MR Final Results',`return $input.first().json.results.sort((a,b)=>a.originalIndex-b.originalIndex).map((json,i)=>({json,pairedItem:{item:0}}));`);
  for(const [a,b,o] of [
    ['Build Jimeng Tasks','MR Build Batches'],['MR Build Batches','MR Select Batch'],['MR Select Batch','MR Request Context'],['MR Request Context','MR Submit Tasks'],['MR Submit Tasks','MR Initialize'],['MR Initialize','MR Evaluate'],['MR Evaluate','MR Pending'],['MR Pending','MR Wait'],['MR Pending','MR Retry Plan',1],['MR Wait','MR Query Tasks'],['MR Query Tasks','MR Carry Status'],['MR Carry Status','MR Evaluate'],['MR Retry Plan','MR Retry Needed'],['MR Retry Needed','MR Request Context'],['MR Retry Needed','MR Collect Batch',1],['MR Collect Batch','MR More Batches'],['MR More Batches','MR Select Batch'],['MR More Batches','MR Final Results',1],['MR Final Results','Build Download Batch']
  ])connect(w,a,b,o||0);
}

export function buildUnifiedImageWorkflow(original,profile) {
  if(!['E001','E002','S003'].includes(profile))throw new Error('Unsupported workflow');
  const w=clone(original);
  if(profile==='E001')prepareE001(w);else prepareExisting(w,profile);
  const names=new Set(w.nodes.map(n=>n.name));
  const AsyncFunction=Object.getPrototypeOf(async function(){}).constructor;
  for(const node of w.nodes) if(node.type==='n8n-nodes-base.code') {
    try {new AsyncFunction(node.parameters.jsCode);}catch{throw new Error('Candidate Code syntax failed: '+node.name);}
  }
  for(const [source,outputs] of Object.entries(w.connections))for(const branch of outputs.main||[])for(const edge of branch||[])if(!names.has(source)||!names.has(edge.node))throw new Error('Dangling workflow connection');
  return {workflow:w,sourceVersionId:original.versionId,policyVersion:policy.version,policyHash};
}
