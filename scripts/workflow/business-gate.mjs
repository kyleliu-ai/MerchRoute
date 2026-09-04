import { readFile } from 'node:fs/promises';
import path from 'node:path';
import pg from 'pg';
import dotenv from 'dotenv';
import { digest } from '../lib/installed-release.mjs';

const predicates={
  downloadActive:["download_jobs","status IN ('QUEUED','WAITING_RESOURCE','RUNNING')"],
  downloadLeases:['download_jobs','lease_expires_at > now()'],
  wbActive:['wb_publish_jobs',"finished_at IS NULL AND state NOT IN ('SUCCEEDED','FAILED','NEEDS_ATTENTION','BLOCKED_AUTH','BLOCKED_CONFIG','BLOCKED_SCHEMA','BLOCKED_COMPLIANCE','BLOCKED_EXISTING_CARD','PAUSED','CANCELLED')"],
  wbLeases:['wb_publish_jobs','lease_expires_at > now()'],
  wbAutomaticActive:['wb_auto_publish_jobs',"state IN ('WAITING_MEDIA','WAITING_STABLE','WAITING_GENERATION_TURN','CHECKING','INITIALIZING','GENERATING','SUBMITTING','QUEUED','RUNNING')"],
  ozonActive:['ozon_publish_jobs',"state IN ('WAITING_MEDIA','READY','UPLOADING_MEDIA','SUBMITTING','IMPORTING','VERIFYING_IMAGES','UPDATING_PRICE','UPDATING_STOCK','MODERATING')"],
  ozonLeases:['ozon_publish_jobs','lease_expires_at > now()'],
  ozonSlots:['ozon_publish_slots','lease_expires_at > now()'],
  ozonRefreshLeases:['ozon_platform_status_refresh_leases','lease_expires_at > now()'],
  wbCleanupInFlight:['wb_source_media_cleanup_batches',"status = 'QUARANTINED'"],
  wbCleanupLeases:['wb_source_media_cleanup_batches','lease_expires_at > now()'],
  ozonCleanupInFlight:['ozon_source_media_cleanup_batches',"state IN ('QUARANTINING','QUARANTINED')"],
  ozonCleanupLeases:['ozon_source_media_cleanup_batches','lease_expires_at > now()'],
  localImport:['local_imports',"status = 'COPYING'"]
};
export function assertNoActivity(counts) {
  if(!Object.keys(counts).length||Object.values(counts).some(x=>!Number.isInteger(x)||x!==0))throw new Error('Business activity is active or unknown; cutover is blocked');
}
export async function inspectBusinessIdle(binding) {
  const envBytes=await readFile(binding.runtimeEnvFile),env=dotenv.parse(envBytes);
  const db=JSON.parse(await readFile(path.join(binding.appDataDir,'db.json'),'utf8'));
  const configBytes=await readFile(path.join(binding.appDataDir,'config.json'));
  const {appConfigSchema}=await import('../../packages/shared/dist/index.js');
  if(!appConfigSchema.safeParse(JSON.parse(configBytes)).success)throw new Error('Production config cannot be validated');
  const client=new pg.Client({connectionString:env.DATABASE_URL,connectionTimeoutMillis:10000,options:'-c default_transaction_read_only=on -c statement_timeout=15000'});
  const counts={};
  try{
    await client.connect();await client.query('BEGIN READ ONLY');
    for(const [name,[table,predicate]] of Object.entries(predicates))counts[name]=Number((await client.query('SELECT count(*)::int AS n FROM '+table+' WHERE '+predicate)).rows[0].n);
    counts.advisoryLocks=Number((await client.query("SELECT count(*)::int AS n FROM pg_locks WHERE locktype='advisory' AND granted AND database=(SELECT oid FROM pg_database WHERE datname=current_database())")).rows[0].n);
    await client.query('ROLLBACK');
  }finally{await client.end();}
  for(const [key,states] of Object.entries({pendingSubmissions:['PACKAGING'],submissionBatches:['RUNNING','PACKAGING'],reviewOperations:['QUEUED','RUNNING','RETRY_WAIT','NEEDS_ATTENTION']})){
    if(!Array.isArray(db[key]))throw new Error('Business state shape is unknown: '+key);
    counts[key]=db[key].filter(x=>states.includes(x.status||x.state)).length;
  }
  assertNoActivity(counts);
  return {counts,envSha256:digest(envBytes),configSha256:digest(configBytes),checkedAt:new Date().toISOString()};
}
