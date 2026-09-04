import { readFile, readdir, lstat } from 'node:fs/promises';
import path from 'node:path';
import { git } from './state.mjs';
import { digest, safeRelative } from '../lib/installed-release.mjs';

// Only for returning to the already accepted, retained pre-migration checkout.
// New releases may never use this exception instead of an installed manifest.
export async function verifyLegacyRelease(binding) {
  if(binding.legacy!==true||!Array.isArray(binding.fileHashes)||!binding.fileHashes.length
    ||!binding.previousAcceptedFile||!binding.previousAcceptedSha256)throw new Error('Legacy recovery inventory is missing');
  if(git(binding.root,'rev-parse','HEAD')!==binding.sourceCommit||git(binding.root,'rev-parse','HEAD^{tree}')!==binding.sourceTree
    ||git(binding.root,'status','--porcelain=v1','--untracked-files=all'))throw new Error('Retained legacy checkout changed');
  for(const [file,pin] of [[binding.launcher,binding.launcherSha256],[binding.nodePath,binding.nodeSha256],[binding.previousAcceptedFile,binding.previousAcceptedSha256]]){
    if(!path.isAbsolute(file)||digest(await readFile(file))!==pin)throw new Error('Legacy toolchain, launcher or recovery record changed');
  }
  const expected=new Map(binding.fileHashes.map(x=>[safeRelative(x.path),x.sha256]));
  if(expected.size!==binding.fileHashes.length)throw new Error('Duplicate legacy files');
  const actual=[];
  async function visit(relative){
    for(const entry of await readdir(path.join(binding.root,relative),{withFileTypes:true})){
      const name=relative+'/'+entry.name,info=await lstat(path.join(binding.root,name));
      if(info.isSymbolicLink())throw new Error('Legacy build link is not allowed');
      if(info.isDirectory())await visit(name);else if(info.isFile()&&!name.endsWith('.tsbuildinfo')){
        actual.push(name);if(digest(await readFile(path.join(binding.root,name)))!==expected.get(name))throw new Error('Legacy build changed or contains undeclared files');
      }
    }
  }
  for(const root of ['apps/server/dist','apps/web/dist','packages/shared/dist'])await visit(root);
  if(actual.sort().join('\n')!==[...expected.keys()].sort().join('\n'))throw new Error('Legacy build files are missing');
  const build=JSON.parse(await readFile(path.join(binding.root,'apps/server/dist/build-info.json')));
  if(build.commitSha!==binding.sourceCommit||build.dirty||build.productVersion!==binding.productVersion)throw new Error('Legacy build identity mismatch');
  return {legacy:true,build};
}
