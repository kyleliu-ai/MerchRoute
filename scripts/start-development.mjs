import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { mkdir, access } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { developmentHome, registration, readJson, atomicJson } from './workflow/state.mjs';
import { assertDevelopmentConfig, assertPortFree } from './workflow/development.mjs';
import { npmForNode } from './workflow/toolchain.mjs';
const root=path.resolve(import.meta.dirname,'..');
const home=developmentHome();
await registration(root,home);
const config=await readJson(path.join(home,'database.json'));
let env=await assertDevelopmentConfig(root,config);
await assertPortFree(4184);
const serverOnly=process.argv.includes('--server-only');
if(!serverOnly)await assertPortFree(5173);
if(!config.runtimeKey||!config.encryptionKey){
  if(config.runtimeKey||config.encryptionKey)throw new Error('Incomplete development keys; do not replace existing credentials');
  try{await access(path.join(env.APP_DATA_DIR,'db.json'));throw new Error('Existing development state has no registered keys; explicit recovery is required');}catch(error){if(error.code!=='ENOENT')throw error;}
  config.runtimeKey=randomBytes(32).toString('base64url');config.encryptionKey=randomBytes(32).toString('base64');
  await atomicJson(path.join(home,'database.json'),config);env=await assertDevelopmentConfig(root,config);
}
await mkdir(env.APP_DATA_DIR,{recursive:true,mode:0o700});
const npmCli=await npmForNode(process.execPath);
execFileSync(process.execPath,[npmCli,'run','build','-w','packages/shared'],{cwd:root,env,windowsHide:true,stdio:'inherit'});
const configFile=path.join(env.APP_DATA_DIR,'config.json');
try{await access(configFile);}catch(error){if(error.code!=='ENOENT')throw error;const {createDefaultConfig}=await import('../packages/shared/dist/index.js');await atomicJson(configFile,createDefaultConfig(process.platform==='win32'?'win32':process.platform==='darwin'?'darwin':'other',env.MERCHROUTE_DATA_ROOT));}
const children=[];
function start(args){const child=spawn(process.execPath,args,{cwd:root,env,windowsHide:true,stdio:'inherit'});children.push(child);child.on('error',()=>stop(1));child.on('exit',code=>stop(code||0));}
let stopping=false;
function stop(code){if(stopping)return;stopping=true;for(const child of children)if(child.exitCode===null)child.kill();process.exitCode=code;}
for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>stop(0));
start(['--import','tsx','scripts/development-server.mjs']);
if(!serverOnly)start(['node_modules/vite/bin/vite.js','--config','apps/web/vite.config.ts','apps/web']);
console.log('MerchRoute isolated development: UI 5173, API 4184; production 4173 is untouched.');
