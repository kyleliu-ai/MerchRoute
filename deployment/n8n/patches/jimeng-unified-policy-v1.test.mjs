import assert from 'node:assert/strict';
import test from 'node:test';
import {createHash} from 'node:crypto';
import {sourceFingerprint,buildUnifiedImageWorkflow} from './jimeng-unified-policy-v1.mjs';

test('portable source identity matches SHA-256 for ASCII, Unicode and multi-block inputs',()=>{
  for(const value of ['', 'abc', '中文目录/测试', 'x'.repeat(2000), {folder:'/商品/测试',files:['1.png','2.png']}]) {
    assert.equal(sourceFingerprint(value),createHash('sha256').update(JSON.stringify(value)).digest('hex'));
  }
});

function cutoutFixture(){
 const code=(name,jsCode='return $input.all();')=>({id:name,name,type:'n8n-nodes-base.code',typeVersion:2,parameters:{jsCode},position:[0,0]});
 return {versionId:'fixture-only',nodes:[
  code('Parse Folder Stable Result',`const summary=JSON.parse($input.first().json.stdout);
const trigger = $('Dedupe Folder Path').first().json || {};
return [{json:{
    folderStable: true,
}}];`),
  code('Parse Product Folder',`const productName='fixture';return [{json:{
    productName,
}}];`),
  code('Build Jimeng Tasks'),code('Build Download Batch'),
  {id:'old-http',name:'Generate Cutout Image',type:'n8n-nodes-base.httpRequest',typeVersion:4.2,parameters:{method:'POST',sendBody:true,specifyBody:'json'},position:[0,0]},
  ...['Build Retry Plan','Has Retry Items','Expand Retry Items','Generate Cutout Image Retry Once','Merge Generation Results'].map(x=>code(x)),
 ],connections:{'Build Jimeng Tasks':{main:[[{node:'Generate Cutout Image',type:'main',index:0}]]}}};
}

test('E001 source identity survives a new execution and changes only with source intent',()=>{
 const w=buildUnifiedImageWorkflow(cutoutFixture(),'E001').workflow;
 const js=w.nodes.find(n=>n.name==='Parse Folder Stable Result').parameters.jsCode;
 const fn=new Function('$input','$',js);
 const summary={latestMtimeMs:1700000000000,totalBytes:1200,files:['参考图.png']};
 const run=(snapshot=summary,trigger={productFolderPath:'/商品/测试'})=>fn({first:()=>({json:{stdout:JSON.stringify(snapshot)}})},()=>({first:()=>({json:trigger})}))[0].json.sourceSubmissionId;
 assert.equal(run(),run());assert.match(run(),/^E001:source-v1:[a-f0-9]{64}$/);
 assert.notEqual(run(),run({...summary,latestMtimeMs:summary.latestMtimeMs+1}));
 assert.equal(run(summary,{productFolderPath:'/商品/测试',sourceSubmissionId:'explicit-new-intent'}),'explicit-new-intent');
 assert.throws(()=>run({...summary,latestMtimeMs:0}),/Missing stable source fingerprint/);
 const seed=w.nodes.find(n=>n.name==='MR Build Batches').parameters.jsCode;
 assert.throws(()=>new Function('$input','$execution',seed)({all:()=>[{json:{imageUrls:['https://fixture.invalid/ref.png']}}]},{id:'new-execution'}),/durable source submission identity/);
 for(const node of w.nodes.filter(n=>n.name.startsWith('MR ')))assert.match(node.id,/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
});

test('a nominal success without valid images remains unconfirmed and never becomes a retry',()=>{
  const w=buildUnifiedImageWorkflow(cutoutFixture(),'E001').workflow;
  const js=w.nodes.find(n=>n.name==='MR Evaluate').parameters.jsCode;
  const state={attempt:0,pollCount:0,images:[],attemptStartedAtMs:1000,tasks:[{taskId:'t',status:'success',rawStatus:50,imageUrls:[],context:{attemptStartedAtMs:1000}}]};
  const evaluate=now=>new Function('$input','Date',js)({first:()=>({json:state})},class extends Date{static now(){return now;}})[0].json;
  assert.equal(evaluate(2000).pending,true);
  const final=evaluate(61000);assert.equal(final.pending,false);assert.equal(final.tasks[0].status,'processing');assert.equal(final.tasks[0].canRetry,false);
  const timeout=w.nodes.find(n=>n.name==='MR Query Tasks').parameters.options.timeout;
  assert.match(timeout,/attemptDeadlineAtMs/);assert.match(timeout,/Math\.max\(1,/);
});
