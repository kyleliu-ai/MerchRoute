import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { mkdir, access } from 'node:fs/promises';
import { developmentHome, registration, readJson, atomicJson } from './workflow/state.mjs';
import { assertDevelopmentConfig, assertPortFree } from './workflow/development.mjs';
const root=path.resolve(import.meta.dirname,'..');
const home=developmentHome();
await registration(root,home);
const config=await readJson(path.join(home,'database.json'));
const env=await assertDevelopmentConfig(root,config);
await assertPortFree(4184);
const serverOnly=process.argv.includes('--server-only');
if(!serverOnly)await assertPortFree(5173);
await mkdir(env.APP_DATA_DIR,{recursive:true,mode:0o700});
const npmCli=path.join(path.dirname(process.execPath),'node_modules/npm/bin/npm-cli.js');
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
