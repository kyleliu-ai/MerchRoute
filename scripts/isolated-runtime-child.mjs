import path from 'node:path';
import { mkdir } from 'node:fs/promises';
import { blockDevelopmentOutbound } from './workflow/development.mjs';
import { atomicJson } from './workflow/state.mjs';
const isolatedPort=Number(process.env.MERCHROUTE_ISOLATED_PACKAGE_PORT);
if(process.env.MERCHROUTE_ISOLATED_PACKAGE_TEST!=='1'||!Number.isInteger(isolatedPort)||String(isolatedPort)!==process.env.PORT
  ||[4173,4183,43173].includes(isolatedPort)||process.env.MERCHROUTE_ENV_FILE)throw new Error('Isolated package test authorization missing');
const database=new URL(process.env.DATABASE_URL);
if(database.hostname!=='127.0.0.1'||database.pathname!=='/merchroute_ci_test'||database.port==='5432')throw new Error('Disposable isolated database required');
blockDevelopmentOutbound();
await mkdir(process.env.APP_DATA_DIR,{recursive:true,mode:0o700});
const {createDefaultConfig}=await import('../packages/shared/dist/index.js');
await atomicJson(path.join(process.env.APP_DATA_DIR,'config.json'),createDefaultConfig(process.platform==='win32'?'win32':process.platform==='darwin'?'darwin':'other',process.env.MERCHROUTE_DATA_ROOT));
// Exercise the actual installed entrypoint and its manifest/environment gates,
// with only the disposable database and generated external sandbox config.
await import('../apps/server/dist/index.js');
