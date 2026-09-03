import { readFile, mkdir, open } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyInstalledRelease, digest } from './lib/installed-release.mjs';

export async function verifyBinding(binding) {
  if(binding.schemaVersion!==1||!path.isAbsolute(binding.root)||!path.isAbsolute(binding.nodePath)
    ||!path.isAbsolute(binding.runtimeEnvFile)||!path.isAbsolute(binding.appDataDir)||!path.isAbsolute(binding.logDirectory))throw new Error('Invalid external release binding');
  if(path.resolve(process.execPath).toLowerCase()!==path.resolve(binding.nodePath).toLowerCase()
    ||digest(await readFile(binding.nodePath))!==binding.nodeSha256)throw new Error('Untrusted runtime toolchain');
  const verified=await verifyInstalledRelease(binding.root,binding.manifestSha256);
  if(binding.releaseTag!=='v'+verified.manifest.productVersion)throw new Error('Release tag/version mismatch');
  return verified;
}
export function productionEnvironment(binding,inherited=process.env) {
  const env=Object.fromEntries(Object.entries(inherited).filter(([key])=>/^(PATH|PATHEXT|SYSTEMROOT|WINDIR|COMSPEC|TEMP|TMP|HOME|USERPROFILE|LOCALAPPDATA|APPDATA|LANG|LC_ALL)$/i.test(key)));
  return {...env,MERCHROUTE_ENV_FILE:binding.runtimeEnvFile,APP_DATA_DIR:binding.appDataDir,
    MERCHROUTE_INSTALLED_MANIFEST_SHA256:binding.manifestSha256,MERCHROUTE_RELEASE_TAG:binding.releaseTag,
    HOST:'127.0.0.1',PORT:'4173',NODE_ENV:'production'};
}
export async function startBoundRelease(binding) {
  await verifyBinding(binding);
  const {assertPortFree}=await import('./workflow/development.mjs');
  await assertPortFree(4173);
  await mkdir(binding.logDirectory,{recursive:true,mode:0o700});
  const name='runtime-'+Date.now();
  const stdout=await open(path.join(binding.logDirectory,name+'.out.log'),'ax',0o600);
  const stderr=await open(path.join(binding.logDirectory,name+'.err.log'),'ax',0o600);
  try{
    const child=spawn(binding.nodePath,[path.join(binding.root,'apps/server/dist/index.js')],{
      cwd:binding.root,env:productionEnvironment(binding),detached:true,windowsHide:true,stdio:['ignore',stdout.fd,stderr.fd]});
    await new Promise((resolve,reject)=>{child.once('spawn',resolve);child.once('error',reject);});
    child.unref();return {pid:child.pid,root:binding.root};
  }finally{await stdout.close();await stderr.close();}
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  try{
    if(process.argv[2]!=='start'||!path.isAbsolute(process.argv[3]||''))throw new Error('Use the fixed external launcher');
    const pointer=JSON.parse(await readFile(process.argv[3],'utf8'));
    console.log(JSON.stringify(await startBoundRelease(pointer)));
  }catch(error){console.error(error.message);process.exitCode=1;}
}
