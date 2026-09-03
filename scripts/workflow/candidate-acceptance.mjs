import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { digest, verifyInstalledRelease } from '../lib/installed-release.mjs';

export function candidateSnapshot(candidate) {
  if(!candidate||!path.isAbsolute(candidate.root||'')||!path.isAbsolute(candidate.artifactRoot||'')
    ||!/^[a-f0-9]{40}$/.test(candidate.sourceCommit||'')||!/^[a-f0-9]{40}$/.test(candidate.sourceTree||'')
    ||!/^[a-f0-9]{64}$/.test(candidate.manifestSha256||'')||!Array.isArray(candidate.artifacts)||!candidate.artifacts.length)throw new Error('Accepted candidate identity is missing or invalid');
  const artifacts=candidate.artifacts.map(({name,sha256})=>{
    if(!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(name||'')||!/^[a-f0-9]{64}$/.test(sha256||''))throw new Error('Invalid accepted artifact identity');
    return {name,sha256};
  }).sort((a,b)=>a.name.localeCompare(b.name,'en'));
  if(new Set(artifacts.map(x=>x.name)).size!==artifacts.length)throw new Error('Duplicate accepted artifacts');
  return {id:candidate.id,productVersion:candidate.productVersion,sourceCommit:candidate.sourceCommit,sourceTree:candidate.sourceTree,
    root:candidate.root,manifestSha256:candidate.manifestSha256,artifactRoot:candidate.artifactRoot,artifacts};
}

export function assertAcceptedCandidate(candidate,accepted) {
  const snapshot=candidateSnapshot(candidate);
  if(JSON.stringify(snapshot)!==JSON.stringify(candidateSnapshot(accepted)))throw new Error('Candidate differs from the fully accepted build; verify again');
  return snapshot;
}

export async function verifyAcceptedCandidate(candidate,accepted) {
  const snapshot=assertAcceptedCandidate(candidate,accepted);
  const verified=await verifyInstalledRelease(snapshot.root,snapshot.manifestSha256);
  if(verified.manifest.sourceCommit!==snapshot.sourceCommit||verified.manifest.sourceTree!==snapshot.sourceTree
    ||verified.manifest.productVersion!==snapshot.productVersion)throw new Error('Accepted package identity mismatch');
  for(const artifact of snapshot.artifacts){
    if(digest(await readFile(path.join(snapshot.artifactRoot,artifact.name)))!==artifact.sha256)throw new Error('Accepted artifact changed: '+artifact.name);
  }
  return snapshot;
}
