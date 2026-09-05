import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import path from 'node:path';
import { captureCommand, resolveCommand } from '../run-ci-check.mjs';
import { parsePlaywrightReport, parseTestLog } from '../ci-evidence-contract.mjs';
import { atomicJson, sourceIdentity, readJson } from './state.mjs';
import { digest } from '../lib/installed-release.mjs';
import { collectSourceFromHead } from '../package-release-candidate.mjs';
import { runVerification, REQUIRED_LOCAL_CHECK_IDS } from '../verify-release-completeness.mjs';
import { verifyDevelopmentDatabase } from './development-database.mjs';
import { candidateSnapshot, verifyAcceptedCandidate } from './candidate-acceptance.mjs';

export function commandTranscript(argv,result) {
  // Successful git diff --check is intentionally silent. Record the actual
  // capture metadata rather than inventing output or weakening the log gate.
  return Buffer.concat([Buffer.from('# Command capture: '+JSON.stringify({argv,exitCode:result.exitCode,signal:result.signal??null,outputBytes:result.output.length,oversized:result.oversized})+'\n'),result.output]);
}

export function testEnvironment(inherited, databaseUrl, cleanupUrl) {
  const allowed=new Set(['PATH','PATHEXT','SYSTEMROOT','WINDIR','COMSPEC','TEMP','TMP','HOME','USERPROFILE','LOCALAPPDATA','APPDATA','LANG','LC_ALL']);
  const env=Object.fromEntries(Object.entries(inherited).filter(([key])=>allowed.has(key.toUpperCase())));
  // Bound fixture concurrency without relaxing any assertion or test timeout.
  return {...env,DATABASE_URL:databaseUrl,WB_SOURCE_MEDIA_CLEANUP_TEST_DATABASE_URL:cleanupUrl,CI:'true',NODE_ENV:'test',MEDIA_INDEX_PERF_100K:'0',
    VITEST_MIN_THREADS:'1',VITEST_MAX_THREADS:'2',VITEST_MIN_FORKS:'1',VITEST_MAX_FORKS:'2'};
}
export async function withTestPostgres(action) {
  const name='merchroute-verify-'+randomUUID().slice(0,12);
  const docker=(args)=>execFileSync('docker',args,{encoding:'utf8',windowsHide:true,stdio:['ignore','pipe','pipe']}).trim();
  let id;
  try{
    id=docker(['run','--detach','--name',name,'--label','merchroute.owner='+name,'--publish','127.0.0.1::5432',
      '-e','POSTGRES_USER=merchroute_ci','-e','POSTGRES_DB=merchroute_ci_test','-e','POSTGRES_HOST_AUTH_METHOD=trust',
      '-e','POSTGRES_INITDB_ARGS=--encoding=UTF8 --locale-provider=icu --icu-locale=und','postgres:18.4-alpine']);
    let ready=false;
    // The image's temporary initialization server accepts Unix sockets before
    // restarting. TCP readiness waits for the final server, avoiding that race.
    for(let attempt=0;attempt<60;attempt++){try{docker(['exec',id,'pg_isready','-h','127.0.0.1','-U','merchroute_ci','-d','merchroute_ci_test']);ready=true;break;}catch{await new Promise(resolve=>setTimeout(resolve,500));}}
    if(!ready)throw new Error('Isolated PostgreSQL did not become ready');
    // Parallel repository suites may otherwise race on PostgreSQL's extension
    // catalog even when every migration uses CREATE EXTENSION IF NOT EXISTS.
    // Install the shared extension once before any test worker is started.
    docker(['exec',id,'psql','-U','merchroute_ci','-d','merchroute_ci_test','-v','ON_ERROR_STOP=1','-c','CREATE EXTENSION IF NOT EXISTS pg_trgm']);
    docker(['exec',id,'psql','-U','merchroute_ci','-d','merchroute_ci_test','-v','ON_ERROR_STOP=1','-c',"CREATE DATABASE merchroute_ci_cleanup_test TEMPLATE template0 ENCODING 'UTF8' LOCALE_PROVIDER icu ICU_LOCALE 'und'"]);
    const state=JSON.parse(docker(['inspect',id]))[0];
    const port=state.NetworkSettings.Ports['5432/tcp'][0].HostPort;
    return await action('postgresql://merchroute_ci@127.0.0.1:'+port+'/merchroute_ci_test','postgresql://merchroute_ci@127.0.0.1:'+port+'/merchroute_ci_cleanup_test',id);
  }finally{
    if(id){const owned=JSON.parse(docker(['inspect',id]))[0];assert.equal(owned.Config.Labels['merchroute.owner'],name,'Refusing to clean an unowned test container');docker(['rm','--force',id]);}
  }
}

export function fixedPortE2eDockerArgs({archive,evidenceDirectory,postgresContainer,databaseUrl}) {
  if(!path.isAbsolute(archive)||!path.isAbsolute(evidenceDirectory)||!/^[a-f0-9]{64}$/.test(postgresContainer))throw new Error('Fixed-port E2E container inputs are invalid');
  const database=new URL(databaseUrl);database.hostname='127.0.0.1';database.port='5432';
  const command=[
    'set -euo pipefail','mkdir -p /work/repo','tar -xf /input/source.tar -C /work/repo','cd /work/repo',
    'npm ci --no-audit --no-fund','npm run build -w packages/shared','npm run build -w apps/web','npm run build -w apps/server',
    `DATABASE_URL=${JSON.stringify(database.toString())} PLAYWRIGHT_JSON_OUTPUT_FILE=/evidence/playwright.json npm run test:e2e -- --reporter=list,json`
  ].join(' && ');
  return ['docker','run','--rm','--network','container:'+postgresContainer,
    '--mount',`type=bind,source=${archive},target=/input/source.tar,readonly`,
    '--mount',`type=bind,source=${evidenceDirectory},target=/evidence`,
    '--tmpfs','/work:exec,size=4294967296','merchroute-e2e:node22.23.1-playwright1.61.1','bash','-lc',command];
}

function prepareFixedPortE2eContainer(root,out) {
  const image='merchroute-e2e:node22.23.1-playwright1.61.1';
  execFileSync('docker',['build','--pull=false','--tag',image,'--file',path.join(root,'deployment','Dockerfile.e2e'),path.join(root,'deployment')],{cwd:root,encoding:'utf8',windowsHide:true,stdio:['ignore','pipe','pipe'],maxBuffer:32*1024*1024});
  const version=execFileSync('docker',['run','--rm',image,'node','--version'],{encoding:'utf8',windowsHide:true,stdio:['ignore','pipe','pipe']}).trim();
  if(version!=='v22.23.1')throw new Error('Fixed-port E2E image does not contain Node 22.23.1');
  const archive=path.join(out,'e2e-source.tar');
  execFileSync('git',['-C',root,'archive','--format=tar','--output',archive,'HEAD'],{windowsHide:true,stdio:['ignore','pipe','pipe']});
  return archive;
}
export async function verifyBatch(root,home,options) {
  const identity=sourceIdentity(root);
  if(options.full&&identity.status)throw new Error('Full verification requires a clean committed candidate');
  if(options.full)await verifyDevelopmentDatabase(root,home);
  const out=path.join(home,'verification',identity.commit+'-'+Date.now());await mkdir(out,{recursive:true,mode:0o700});
  const records=[];
  async function run(id,argv,env,kind) {
    console.error('Checking '+id);
    const command=await resolveCommand(argv);
    const result=await captureCommand(command.command,command.args,{cwd:root,env});
    const transcript=commandTranscript(argv,result);
    const file=path.join(out,id+'.log');await writeFile(file,transcript,{mode:0o600});
    let summary;
    if(result.exitCode===0&&kind==='tests')summary=parseTestLog(result.output.toString('utf8'),{id,platform:process.platform});
    if(result.exitCode===0&&kind==='e2e')summary=parsePlaywrightReport(JSON.parse(await readFile(path.join(out,'playwright.json'),'utf8')),result.output.toString('utf8'));
    const record={id,argv,exitCode:result.exitCode,log:file,sha256:digest(transcript),summary,completedAt:new Date().toISOString()};records.push(record);
    await atomicJson(path.join(out,'progress.json'),{identity,records});
    if(result.exitCode!==0||result.oversized)throw new Error('Verification failed: '+id+'; private log: '+file);
    if(summary?.problems?.length)throw new Error('Verification evidence rejected: '+id);
  }
  if(!options.full){
    const env=testEnvironment(process.env,undefined,undefined);
    await run('workflow',['npm','run','workflow:test'],env,'tests');
    await run('deployment-verify',['npm','run','deployment:verify'],env);
    return {ok:true,level:'quick',identity,records,publishable:false};
  }
  let acceptedCandidate;
  await withTestPostgres(async(database,cleanup,postgresContainer)=>{
    const env=testEnvironment(process.env,database,cleanup);
    env.PLAYWRIGHT_JSON_OUTPUT_FILE=path.join(out,'playwright.json');
    await run('check',['npm','run','check'],env,'tests');
    await run('postgres-integration',['node','node_modules/vitest/vitest.mjs','run','.integration.test.ts','--root','apps/server','--maxWorkers=2','--reporter=verbose'],env,'tests');
    // Browser bundles must have real production rc-select IDs, never test IDs.
    await run('browser-build',['npm','run','build'],{...env,NODE_ENV:'production'});
    if(process.platform==='win32'){
      const archive=prepareFixedPortE2eContainer(root,out);
      await run('e2e',fixedPortE2eDockerArgs({archive,evidenceDirectory:out,postgresContainer,databaseUrl:database}),env,'e2e');
    }else await run('e2e',['npm','run','test:e2e','--','--reporter=list,json'],env,'e2e');
    await run('jimeng',['node','--import','tsx','scripts/ci-regression-tests.mjs','--suite','jimeng'],{...env,MERCHROUTE_LOCAL_REGRESSION:'1'},'tests');
    await run('isolated-runtime',['node','--import','tsx','scripts/isolated-runtime-package.mjs',home],{...env,MERCHROUTE_ISOLATED_PACKAGE_PORT:'44183'});
    acceptedCandidate=candidateSnapshot(await readJson(path.join(home,'candidate.json')));
    if(acceptedCandidate.sourceCommit!==identity.commit||acceptedCandidate.sourceTree!==identity.tree)throw new Error('Runtime acceptance belongs to another source');
  });
  const env=testEnvironment(process.env,undefined,undefined);
  await run('release-verifier-tests',['node','--import','tsx','--test','scripts/verify-release-completeness.test.mjs'],env,'tests');
  if(process.platform!=='win32')throw new Error('Local full migration acceptance also requires Windows safety checks; CI is a separate portable gate');
  await run('restart-safety',['powershell.exe','-NoProfile','-File','scripts/test-restart-windows-safety.ps1'],env);
  await run('retirement-safety',['pwsh','-NoProfile','-File','scripts/test-retire-n8n-global-junction-safety.ps1'],env);
  const config=JSON.parse(await readFile(path.join(home,'machine.json'),'utf8'));
  if(!config.gitleaksPath)throw new Error('Pinned Gitleaks executable is not registered');
  await run('gitleaks-version',[config.gitleaksPath,'version'],env);
  if(!(await readFile(path.join(out,'gitleaks-version.log'),'utf8')).split('\n').slice(1).join('\n').trim().match(/^8\.30\.1$/))throw new Error('Gitleaks version must be 8.30.1');
  await run('gitleaks',[config.gitleaksPath,'git','--redact','--no-banner','--log-opts='+config.baseline.commit+'..HEAD','.'],env);
  const scanRoot=path.join(out,'controlled-source');
  for(const file of (await collectSourceFromHead(root)).files){const target=path.join(scanRoot,file.path);await mkdir(path.dirname(target),{recursive:true});await writeFile(target,file.data,{flag:'wx'});}
  await run('gitleaks-files',[config.gitleaksPath,'dir','--redact','--no-banner','--max-target-megabytes','10',scanRoot],env);
  await run('diff-check',['git','diff','--check',config.baseline.commit,'HEAD'],env);
  await run('deployment-verify',['npm','run','deployment:verify'],env);
  const source=await collectSourceFromHead(root);
  const evidence={schemaVersion:1,identity:source.identity,checks:records.filter(x=>REQUIRED_LOCAL_CHECK_IDS.includes(x.id)).map(x=>({id:x.id,command:x.argv.join(' '),exitCode:x.exitCode,completedAt:x.completedAt,logPath:x.log,logSha256:x.sha256,
    ...(x.id==='e2e'?{playwrightReportPath:path.join(out,'playwright.json'),playwrightReportSha256:undefined}:{})}))};
  evidence.checks.find(x=>x.id==='e2e').playwrightReportSha256=digest(await readFile(path.join(out,'playwright.json')));
  const evidencePath=path.join(out,'release-evidence.json');await atomicJson(evidencePath,evidence);
  const strict=await runVerification({root,evidencePath,strict:true,expectedCommit:identity.commit});await atomicJson(path.join(out,'strict-result.json'),strict);
  if(!strict.ok)throw new Error('Strict retained-feature release gate failed: '+strict.errors.join('; '));
  if(JSON.stringify(sourceIdentity(root))!==JSON.stringify(identity))throw new Error('Candidate changed during verification');
  await verifyAcceptedCandidate(await readJson(path.join(home,'candidate.json')),acceptedCandidate);
  const record={schemaVersion:1,ok:true,level:'full',identity,candidate:acceptedCandidate,records,strictResult:path.join(out,'strict-result.json'),strictSha256:digest(await readFile(path.join(out,'strict-result.json'))),completedAt:new Date().toISOString(),publishable:true};
  await atomicJson(path.join(out,'result.json'),record);
  await atomicJson(path.join(home,'verified.json'),record);
  return record;
}
