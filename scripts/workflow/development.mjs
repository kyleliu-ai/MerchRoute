import { createServer } from 'node:net';
import http from 'node:http';
import https from 'node:https';
import { syncBuiltinESMExports } from 'node:module';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { assertExternal } from './state.mjs';

export function developmentEnvironment(config, inherited=process.env) {
  const db=new URL(config.databaseUrl);
  if(!['postgres:','postgresql:'].includes(db.protocol) || !['127.0.0.1','localhost','[::1]'].includes(db.hostname)
    || db.pathname!=='/merchroute_dev' || db.username!=='merchroute_dev_app' || db.search || !db.password)throw new Error('Development requires its dedicated database and unprivileged role');
  if(!path.isAbsolute(config.sandboxRoot))throw new Error('Development sandbox must be absolute');
  if(config.runtimeKey!==undefined&&(typeof config.runtimeKey!=='string'||config.runtimeKey.length<32))throw new Error('Invalid development runtime key');
  if(config.encryptionKey!==undefined&&(typeof config.encryptionKey!=='string'||Buffer.from(config.encryptionKey,'base64').length!==32))throw new Error('Invalid development encryption key');
  const env={};
  for(const [key,value] of Object.entries(inherited))if(/^(PATH|PATHEXT|SYSTEMROOT|WINDIR|COMSPEC|TEMP|TMP|HOME|USERPROFILE|LOCALAPPDATA|APPDATA|LANG|LC_ALL)$/i.test(key))env[key]=value;
  return {...env,DATABASE_URL:db.toString(),APP_DATA_DIR:path.join(config.sandboxRoot,'app'),MERCHROUTE_DATA_ROOT:path.join(config.sandboxRoot,'media'),
    MERCHROUTE_RUNTIME_KEY:config.runtimeKey||randomBytes(32).toString('base64url'),MERCHROUTE_CREDENTIAL_ENCRYPTION_KEY:config.encryptionKey||randomBytes(32).toString('base64'),
    DOWNLOAD_CONFIG_SYNC:'false',MERCHROUTE_OZON_MULTISTORE_FLEET_READY:'false',MERCHROUTE_OZON_SOURCE_MEDIA_CLEANUP_ENABLED:'false',
    MERCHROUTE_SAFE_DEVELOPMENT:'1',HOST:'127.0.0.1',PORT:'4184',NODE_ENV:'development'};
}
export async function assertPortFree(port) {
  await new Promise((resolve,reject)=>{const server=createServer();server.once('error',()=>reject(new Error('Required isolated port is occupied: '+port)));server.listen(port,'127.0.0.1',()=>server.close(resolve));});
}
export function blockDevelopmentOutbound() {
  const original={fetch:globalThis.fetch,httpRequest:http.request,httpGet:http.get,httpsRequest:https.request,httpsGet:https.get};
  const fail=()=>{throw new Error('DEVELOPMENT_EXTERNAL_BUSINESS_REQUEST_BLOCKED');};
  globalThis.fetch=async()=>fail();http.request=fail;http.get=fail;https.request=fail;https.get=fail;syncBuiltinESMExports();
  return ()=>{globalThis.fetch=original.fetch;http.request=original.httpRequest;http.get=original.httpGet;https.request=original.httpsRequest;https.get=original.httpsGet;syncBuiltinESMExports();};
}
export async function assertDevelopmentConfig(root,config) {
  await assertExternal(root,config.sandboxRoot);
  return developmentEnvironment(config);
}
