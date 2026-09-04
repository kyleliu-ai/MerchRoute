import assert from 'node:assert/strict';
import { readFile, mkdtemp, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { prepareInstalledRelease } from './workflow/release-package.mjs';
import { verifyInstalledRelease } from './lib/installed-release.mjs';
import { probeReadOnlyPages } from './workflow/read-only-pages.mjs';
import { createRuntimeEndpoint, preflightRuntimeEndpoint } from './lib/runtime-endpoint.mjs';
const root=path.resolve(import.meta.dirname,'..'),home=process.argv[2];
if(!path.isAbsolute(home||''))throw new Error('External development home is required');
const config=JSON.parse(await readFile(path.join(home,'machine.json')));
const candidate=await prepareInstalledRelease(root,home,config);
const isolatedPort=Number(process.env.MERCHROUTE_ISOLATED_PACKAGE_PORT);
if(!Number.isInteger(isolatedPort)||[4173,4183,43173].includes(isolatedPort))throw new Error('Explicit non-production isolated package port is required');
const endpoint=createRuntimeEndpoint(isolatedPort);
await preflightRuntimeEndpoint(endpoint);
const outside=await mkdtemp(path.join(home,'isolated-runtime-'));
const env={...process.env,APP_DATA_DIR:path.join(outside,'app'),MERCHROUTE_DATA_ROOT:path.join(outside,'media'),MERCHROUTE_ISOLATED_PACKAGE_TEST:'1',
  MERCHROUTE_RUNTIME_KEY:randomBytes(32).toString('base64url'),MERCHROUTE_CREDENTIAL_ENCRYPTION_KEY:randomBytes(32).toString('base64'),
  MERCHROUTE_INSTALLED_MANIFEST_SHA256:candidate.manifestSha256,PORT:String(endpoint.port),MERCHROUTE_PORT:String(endpoint.port),
  MERCHROUTE_RUNTIME_BASE_URL:endpoint.origin,HOST:endpoint.host,DOWNLOAD_CONFIG_SYNC:'false'};
delete env.MERCHROUTE_ENV_FILE;delete env.MERCHROUTE_RUNTIME_ENV_FILE;
const child=spawn(config.nodePath,[path.join(candidate.root,'scripts/isolated-runtime-child.mjs')],{cwd:candidate.root,env,windowsHide:true,stdio:['ignore','pipe','pipe']});
let log='';child.stdout.on('data',data=>{log+=data;});child.stderr.on('data',data=>{log+=data;});
try{
  let ready=false;
  for(let i=0;i<120;i++){if(child.exitCode!==null)throw new Error('Isolated runtime exited');try{const response=await fetch(endpoint.origin+'/api/v1/health',{signal:AbortSignal.timeout(1000)});if(response.ok){ready=true;break;}}catch{/* Wait only for this owned child to start. */}await new Promise(resolve=>setTimeout(resolve,500));}
  assert.equal(ready,true);
  const about=await (await fetch(endpoint.origin+'/api/v1/about/version',{signal:AbortSignal.timeout(60000)})).json();
  assert.equal(about.current.productVersion,candidate.productVersion);assert.equal(about.current.commitSha,candidate.sourceCommit);
  assert.equal(about.current.buildChannel,'candidate');assert.equal(about.runtimeStatus,'CURRENT');
  assert.equal(about.current.runtimeEndpoint?.origin,endpoint.origin);
  await probeReadOnlyPages(endpoint.origin);
  await verifyInstalledRelease(candidate.root,candidate.manifestSha256);
  console.log(JSON.stringify({assertionsPassed:9,assertionsFailed:0,gitFree:true,productVersion:candidate.productVersion,sourceCommit:candidate.sourceCommit,productionTouched:false}));
}finally{
  if(child.exitCode===null){child.kill();await new Promise(resolve=>{child.once('exit',resolve);setTimeout(resolve,10000).unref();});}
  await writeFile(path.join(outside,'runtime.log'),log,{mode:0o600});
}
