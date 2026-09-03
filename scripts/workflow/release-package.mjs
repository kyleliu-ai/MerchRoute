import { mkdir, readFile, writeFile, lstat } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { collectSourceFromHead, collectPrebuiltFiles, createPackageArtifacts, writeArtifactsWithoutOverwrite } from '../package-release-candidate.mjs';
import { atomicJson, assertExternal, readJson } from './state.mjs';
import { inventoryRelease, verifyInstalledRelease, INSTALLED_MANIFEST, digest, gitBlob, assertPlainRoot } from '../lib/installed-release.mjs';
import { npmForNode } from './toolchain.mjs';

export async function verifyToolchain(config) {
  if (!path.isAbsolute(config.nodePath) || (await lstat(config.nodePath)).isSymbolicLink()
    || digest(await readFile(config.nodePath)) !== config.nodeSha256) throw new Error('Pinned Node executable changed');
  const version=execFileSync(config.nodePath,['--version'],{encoding:'utf8',windowsHide:true}).trim();
  if(version!=='v22.23.1')throw new Error('Node 22.23.1 is required');
}
export async function prepareInstalledRelease(root,home,config) {
  await verifyToolchain(config);
  await assertExternal(root,config.releasesRoot);
  const source=await collectSourceFromHead(root),prebuilt=await collectPrebuiltFiles(root,source.identity);
  const build=JSON.parse(prebuilt.find(x=>x.path==='apps/server/dist/build-info.json').data);
  const version=JSON.parse(source.files.find(x=>x.path==='package.json').data).version;
  if(version!==build.productVersion||build.buildChannel!=='candidate')throw new Error('Candidate product/build version mismatch');
  const id=version+'-'+source.identity.commit.slice(0,12)+'-'+digest(Buffer.concat(prebuilt.map(x=>x.data))).slice(0,12);
  const target=path.join(config.releasesRoot,id),receiptFile=path.join(home,'candidates',id+'.json');
  try{
    const receipt=await readJson(receiptFile);
    if(receipt.root!==target||receipt.sourceCommit!==source.identity.commit)throw new Error('Candidate registration changed');
    await verifyInstalledRelease(target,receipt.manifestSha256);
    return receipt;
  }catch(error){if(error.code!=='ENOENT')throw error;}
  // Never overwrite an unknown or interrupted installation. Its intent and files
  // stay available for inspection; a verified receipt is the only resume path.
  await mkdir(config.releasesRoot,{recursive:true,mode:0o700});await assertPlainRoot(config.releasesRoot);
  await mkdir(target,{mode:0o700});
  await atomicJson(path.join(home,'candidate-intent.json'),{root:target,sourceCommit:source.identity.commit,state:'PREPARING'});
  for(const file of [...source.files,...prebuilt]){
    const destination=path.join(target,file.path);await mkdir(path.dirname(destination),{recursive:true});
    await writeFile(destination,file.data,{flag:'wx',mode:file.mode==='100755'?0o755:0o644});
  }
  const npmCli=await npmForNode(config.nodePath);
  const env=Object.fromEntries(Object.entries(process.env).filter(([key])=>/^(PATH|PATHEXT|SYSTEMROOT|WINDIR|COMSPEC|TEMP|TMP|HOME|USERPROFILE|LOCALAPPDATA|APPDATA)$/i.test(key)));
  env.PATH=path.dirname(config.nodePath)+path.delimiter+(env.PATH||env.Path||'');
  // The frontend is already bundled. Install only server/shared runtime
  // dependencies, not a second copy of all browser libraries and their sources.
  execFileSync(config.nodePath,[npmCli,'ci','--omit=dev','--workspace','apps/server','--include-workspace-root','--no-audit','--no-fund'],{cwd:target,env,windowsHide:true,stdio:'pipe',maxBuffer:16*1024*1024});
  const files=await inventoryRelease(target,{onProgress:value=>console.error('Release integrity: '+value.filesRead+'/'+value.total)}),programNames=new Set([...source.files,...prebuilt].map(x=>x.path));
  if(files.some(x=>!programNames.has(x.path)&&!x.path.split('/').includes('node_modules')))throw new Error('Dependency installation created an undeclared program file');
  const manifest={schemaVersion:1,kind:'MERCHROUTE_INSTALLED_RELEASE',productVersion:version,
    sourceCommit:source.identity.commit,sourceTree:source.identity.headTreeHash,builtAt:build.builtAt,
    platform:process.platform,arch:process.arch,nodeVersion:process.versions.node,
    sourceFiles:source.files.map(x=>({path:x.path,mode:x.mode,sha:gitBlob(x.data)})),files};
  await atomicJson(path.join(target,INSTALLED_MANIFEST),manifest);
  const manifestSha256=digest(await readFile(path.join(target,INSTALLED_MANIFEST)));
  await verifyInstalledRelease(target,manifestSha256);
  const artifactRoot=path.join(home,'artifacts',id);await mkdir(artifactRoot,{recursive:true,mode:0o700});
  const {artifacts}=createPackageArtifacts(source,prebuilt);
  await writeArtifactsWithoutOverwrite(artifactRoot,artifacts);
  const receipt={schemaVersion:1,id,root:target,productVersion:version,sourceCommit:source.identity.commit,
    sourceTree:source.identity.headTreeHash,identity:source.identity,manifestSha256,build,artifactRoot,
    artifacts:artifacts.map(x=>({name:x.name,sha256:digest(x.data)})),preparedAt:new Date().toISOString(),status:'CANDIDATE_NOT_ACTIVE'};
  await atomicJson(receiptFile,receipt);await atomicJson(path.join(home,'candidate.json'),receipt);
  return receipt;
}
