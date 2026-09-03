import { mkdir } from 'node:fs/promises';
import { blockDevelopmentOutbound } from './workflow/development.mjs';
if(process.env.MERCHROUTE_SAFE_DEVELOPMENT!=='1'||process.env.PORT!=='4184'||process.env.MERCHROUTE_ENV_FILE||process.env.MERCHROUTE_RUNTIME_ENV_FILE)throw new Error('Use the registered safe development launcher');
blockDevelopmentOutbound();
await mkdir(process.env.APP_DATA_DIR,{recursive:true});
// Never import index.ts: that production entrypoint loads external credentials.
const {buildApp}=await import('../apps/server/src/app.ts');
const app=await buildApp({databaseUrl:process.env.DATABASE_URL});
await app.listen({host:'127.0.0.1',port:4184});
for(const signal of ['SIGTERM','SIGINT'])process.once(signal,()=>{void app.close().then(()=>process.exit(0));});
