import { execFileSync } from 'node:child_process';
import { setTimeout } from 'node:timers/promises';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { deploy, docker, inspectContainer, json, profile, volumeAction, waitVerified } from '../deployment/scripts/jimeng-deploy-lib.mjs';

if (process.env.GITHUB_ACTIONS !== 'true') throw new Error('This container-only check is for GitHub Actions');
const stateDir=process.env.JIMENG_BUILD_STATE_DIR;
assert.ok(stateDir && path.isAbsolute(stateDir),'Explicit CI build record directory required');
const names=(await readdir(stateDir)).filter(n=>/^build-rc\.\d+-[a-f0-9]+\.json$/.test(n));
assert.equal(names.length,1,'CI must use exactly its own build record');
const record=await json(path.join(stateDir,names[0]));
const selected=profile('test'), volume='merchroute-jimeng-test-ci-'+randomUUID();
const owned=await deploy({action:'install',record,stateDir,volume,selected,execute:true,dryRun:false});
const container = owned.containerId;
if (!/^[a-f0-9]{64}$/.test(container)) throw new Error('Invalid owned test container identity');
let ready = false;
let assertionsPassed = 0;
let assertionsFailed = 0;

async function assertHealth(check) {
  try {
    if (await check()) assertionsPassed += 1;
    else assertionsFailed += 1;
  } catch {
    assertionsFailed += 1;
  }
}

try {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      const response = await fetch('http://127.0.0.1:18001/ping', { signal: AbortSignal.timeout(1500) });
      if (response.ok && (await response.text()).replaceAll('"', '').trim() === 'pong') { ready = true; break; }
    } catch { /* Retry only the owned loopback test container. */ }
    await setTimeout(1000);
  }

  await assertHealth(async () => ready);
  await assertHealth(async () => {
    const response = await fetch('http://127.0.0.1:18001/', { signal: AbortSignal.timeout(1500) });
    const contentType = response.headers.get('content-type') || '';
    const body = await response.text();
    return response.ok && contentType.includes('text/html') && body.includes('jimeng-free-api已启动');
  });
  await assertHealth(async () => {
    const response = await fetch('http://127.0.0.1:18001/v1/models', { signal: AbortSignal.timeout(1500) });
    const body = await response.json();
    return response.ok && Array.isArray(body?.data) && body.data.some((model) => model?.id === 'jimeng');
  });
  volumeAction(record,volume,'probe');
  docker(['exec',container,'node','-e',"require('fs').writeFileSync('/app/data/ci-persistence','fixture',{flag:'wx',mode:0o600})"]);
  docker(['restart',container]);
  await waitVerified({record,container,volume,selected});
  assert.equal(docker(['exec',container,'node','-e',"process.stdout.write(require('fs').readFileSync('/app/data/ci-persistence','utf8'))"]),'fixture');
} finally {
  assert.equal(inspectContainer(container).Config.Labels['org.merchroute.operation'],owned.operationId);
  execFileSync('docker', ['stop', container], { stdio:'pipe',windowsHide:true });
  docker(['rm',container]);
  assert.equal(JSON.parse(docker(['volume','inspect',volume]))[0].Labels['org.merchroute.operation'],owned.operationId);
  docker(['volume','rm',volume]);
}
const passed = assertionsPassed === 3 && assertionsFailed === 0;
console.log(JSON.stringify({ ok: passed, assertionsPassed, assertionsFailed, realCredentialsUsed: false }));
if (!passed) process.exitCode = 1;
