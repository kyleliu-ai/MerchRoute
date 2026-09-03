import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, open, readFile, rename, unlink, realpath, lstat } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import { isWithin, digest } from '../lib/installed-release.mjs';

export const git = (root, ...args) => execFileSync('git', ['-C',root,...args], {encoding:'utf8',windowsHide:true,maxBuffer:64*1024*1024}).trim();
export const readJson = async (file) => JSON.parse(await readFile(file,'utf8'));
export function developmentHome(env=process.env) {
  const base = env.LOCALAPPDATA || (process.platform === 'darwin' ? path.join(os.homedir(),'Library','Application Support') : path.join(os.homedir(),'.local','share'));
  return env.MERCHROUTE_WORKFLOW_HOME || path.join(base,'MerchRoute','development');
}
export async function assertExternal(root, target) {
  if(!path.isAbsolute(target) || isWithin(root,target)) throw new Error('Workflow state must be outside the repository');
  let ancestor=target;
  while(true) {
    try {const resolved=await realpath(ancestor);if(isWithin(await realpath(root),resolved))throw new Error('Workflow state resolves into the repository');break;}
    catch(error){if(error.code!=='ENOENT')throw error;const next=path.dirname(ancestor);if(next===ancestor)throw error;ancestor=next;}
  }
}
export async function atomicJson(file, value) {
  await mkdir(path.dirname(file),{recursive:true,mode:0o700});
  const temp=file+'.'+randomUUID()+'.tmp';
  const handle=await open(temp,'wx',0o600);
  try {await handle.writeFile(JSON.stringify(value,null,2)+'\n');await handle.sync();}finally{await handle.close();}
  await rename(temp,file);
}
export async function withCommandLock(home, action) {
  const file=path.join(home,'command.lock');await mkdir(home,{recursive:true,mode:0o700});
  let handle;
  try{handle=await open(file,'wx',0o600);}catch(error){if(error.code==='EEXIST')throw new Error('Another command or stale lock exists; inspect and explicitly recover it, never auto-steal');throw error;}
  const token=randomUUID();
  await handle.writeFile(JSON.stringify({pid:process.pid,token,at:new Date().toISOString()}));await handle.close();
  try{return await action();}finally{const current=await readJson(file);assert.equal(current.token,token,'Command lock ownership changed');await unlink(file);}
}
export async function registration(root,home=developmentHome()) {
  await assertExternal(root,home);
  const config=await readJson(path.join(home,'machine.json'));
  if(config.schemaVersion!==1 || config.sourceAuthority!=='LOCAL' || await realpath(config.devRoot)!==await realpath(root)
    || !/^[a-f0-9]{40}$/.test(config.baseline?.commit||'') || !/^[a-f0-9]{40}$/.test(config.baseline?.tree||''))throw new Error('Fixed development directory or accepted baseline is not registered');
  const metadata=await lstat(path.join(root,'.git'));
  if(!metadata.isDirectory()||metadata.isSymbolicLink())throw new Error('An independent Git repository is required');
  try{await lstat(path.join(root,'.git/objects/info/alternates'));throw new Error('Git alternates are forbidden');}catch(error){if(error.code!=='ENOENT')throw error;}
  return config;
}
export async function readBatch(home) {
  try{return await readJson(path.join(home,'batch.json'));}catch(error){if(error.code==='ENOENT')return null;throw error;}
}
export async function assertBatch(root,home,taskId) {
  const batch=await readBatch(home);
  if(!taskId || !batch || batch.status!=='ACTIVE' || batch.taskId!==taskId || batch.branch!==git(root,'branch','--show-current'))throw new Error('Active batch ownership mismatch');
  return batch;
}
export function sourceIdentity(root) {return {commit:git(root,'rev-parse','HEAD'),tree:git(root,'rev-parse','HEAD^{tree}'),branch:git(root,'branch','--show-current'),status:git(root,'status','--porcelain=v1','--untracked-files=all')};}
export function requireApply(options) {if(!options.apply || !options.approved)throw new Error('Mutation requires --apply --approved and current-task user authorization');}

export async function recoverCommandLock(home,options) {
  const file=path.join(home,'command.lock'),bytes=await readFile(file),record=JSON.parse(bytes);
  if(digest(bytes)!==options['lock-sha256']||!Number.isInteger(record.pid)||record.pid<1)throw new Error('Explicit stale lock identity is required');
  let absent=false;try{process.kill(record.pid,0);}catch(error){if(error.code==='ESRCH')absent=true;}
  if(!absent)throw new Error('Lock owner is alive or cannot be inspected');
  if(options['dry-run'])return {dryRun:true,recoverable:true,pid:record.pid};
  requireApply(options);
  if(digest(await readFile(file))!==options['lock-sha256'])throw new Error('Lock changed during recovery');
  const archived=path.join(home,'recovered-lock-'+randomUUID()+'.json');await rename(file,archived);
  return {recovered:true,archived};
}
