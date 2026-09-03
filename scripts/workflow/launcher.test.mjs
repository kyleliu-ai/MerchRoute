import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { digest } from '../lib/installed-release.mjs';
import { atomicJson, recoverCommandLock } from './state.mjs';
import { npmForNode } from './toolchain.mjs';
import { verifyDevelopmentDatabase } from './development-database.mjs';
import { verifyLegacyRelease } from './legacy-release.mjs';
import { testEnvironment } from './verify.mjs';

test('full local regression bounds workers without relaxing timeouts or inheriting credentials',()=>{
  const env=testEnvironment({VITEST_MAX_THREADS:'100',VITEST_MAX_FORKS:'100',MERCHROUTE_ENV_FILE:'production',DATABASE_URL:'production'},'synthetic','cleanup');
  assert.equal(env.VITEST_MAX_THREADS,'2');assert.equal(env.VITEST_MAX_FORKS,'2');
  assert.equal(env.VITEST_MIN_THREADS,'1');assert.equal(env.VITEST_MIN_FORKS,'1');
  assert.equal(env.MERCHROUTE_ENV_FILE,undefined);assert.equal(env.DATABASE_URL,'synthetic');
});

test('docs preserve local authority, serial ownership, phase boundary and production isolation',async()=>{
  const root=path.resolve(import.meta.dirname,'../..');
  for(const file of ['AGENTS.md','docs/SINGLE_DEVELOPER_WORKFLOW.zh-CN.md','deployment/AGENT_INSTALL_PROMPT.zh-CN.md','deployment/AGENT_UPDATE_PROMPT.zh-CN.md']){
    const text=await readFile(path.join(root,file),'utf8');
    for(const marker of ['批次','4173','4184','0.1.2'])assert.ok(text.includes(marker),file+' missing '+marker);
  }
  const vite=await readFile(path.join(root,'apps/web/vite.config.ts'),'utf8');assert.ok(vite.includes('http://127.0.0.1:4184'));assert.ok(!vite.includes(':4173'));assert.ok(vite.includes('strictPort: true'));
});
test('stale-lock recovery requires exact hash and explicit approval',async t=>{
  const home=await mkdtemp(path.join(os.tmpdir(),'merchroute-lock-recovery-'));t.after(()=>rm(home,{recursive:true,force:true}));
  const file=path.join(home,'command.lock');await atomicJson(file,{pid:2147483647,token:'fixture'});const pin=digest(await readFile(file));
  await assert.rejects(recoverCommandLock(home,{'lock-sha256':'bad'}),/identity/);
  await assert.rejects(recoverCommandLock(home,{'lock-sha256':pin}),/requires/);
  assert.equal((await recoverCommandLock(home,{'lock-sha256':pin,'dry-run':true})).recoverable,true);
  assert.equal((await recoverCommandLock(home,{'lock-sha256':pin,apply:true,approved:true})).recovered,true);
});
if(process.platform==='win32')for(const shell of ['powershell.exe','pwsh']){
  test('fixed launcher parses and refuses changed bindings in '+shell,async t=>{
    const root=await mkdtemp(path.join(os.tmpdir(),'merchroute-launcher-test-'));t.after(()=>rm(root,{recursive:true,force:true}));
    await mkdir(path.join(root,'scripts'));const entry=path.join(root,'scripts/release-runtime.mjs');await writeFile(entry,'throw new Error("must not execute")');
    const pointer=path.join(root,'pointer.json'),binding={root,nodePath:process.execPath,nodeSha256:digest(await readFile(process.execPath)),launcherSha256:digest(await readFile(entry))};
    binding.bootstrapHashes={};
    for(const file of ['scripts/release-runtime.mjs','scripts/lib/installed-release.mjs','scripts/workflow/development.mjs','scripts/workflow/state.mjs']){
      const target=path.join(root,file);await mkdir(path.dirname(target),{recursive:true});if(target!==entry)await writeFile(target,'// fixture');binding.bootstrapHashes[file]=digest(await readFile(target));
    }
    await atomicJson(pointer,binding);const script=path.resolve(import.meta.dirname,'../Start-MerchRoute.ps1');
    const run=()=>execFileSync(shell,['-NoProfile','-File',script,'-ReleasePointer',pointer,'-CheckOnly'],{encoding:'utf8',windowsHide:true,stdio:['ignore','pipe','pipe']});
    assert.match(run(),/Launcher binding verified/);await writeFile(path.join(root,'scripts/lib/installed-release.mjs'),'changed verifier');assert.throws(run);
  });
}
test('npm lookup supports Windows and macOS archive layouts without relying on PATH',async t=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'merchroute-toolchain-test-'));t.after(()=>rm(root,{recursive:true,force:true}));
  for(const [binary,npm] of [['windows/node.exe','windows/node_modules/npm/bin/npm-cli.js'],['mac/bin/node','mac/lib/node_modules/npm/bin/npm-cli.js']]){
    await mkdir(path.dirname(path.join(root,npm)),{recursive:true});await writeFile(path.join(root,npm),'// fixture');assert.equal(await npmForNode(path.join(root,binary)),path.join(root,npm));
  }
  await assert.rejects(npmForNode(path.join(root,'missing/node')),/not found/);
});
test('missing local database input and missing legacy inventory fail before service mutation',async t=>{
  const home=await mkdtemp(path.join(os.tmpdir(),'merchroute-preflight-test-'));t.after(()=>rm(home,{recursive:true,force:true}));
  await assert.rejects(verifyDevelopmentDatabase(path.resolve(import.meta.dirname,'../..'),home),/not initialized/);
  await assert.rejects(verifyLegacyRelease({legacy:true}),/inventory is missing/);
});
