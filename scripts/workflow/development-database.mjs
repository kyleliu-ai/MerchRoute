import path from 'node:path';
import pg from 'pg';
import { readJson, atomicJson } from './state.mjs';
import { assertDevelopmentConfig } from './development.mjs';
export async function verifyDevelopmentDatabase(root,home) {
  let config;try{config=await readJson(path.join(home,'database.json'));}catch(error){if(error.code==='ENOENT')throw new Error('Development database is not initialized; provide administrator input locally before publishing');throw error;}
  const env=await assertDevelopmentConfig(root,config);
  const client=new pg.Client({connectionString:env.DATABASE_URL,connectionTimeoutMillis:8000,options:'-c default_transaction_read_only=on -c statement_timeout=8000'});
  try{
    await client.connect();await client.query('BEGIN READ ONLY');
    const identity=(await client.query('SELECT current_database() AS database, current_user AS role')).rows[0];
    if(identity.database!=='merchroute_dev'||identity.role!=='merchroute_dev_app')throw new Error('Development database identity mismatch');
    const flags=(await client.query('SELECT rolsuper,rolcreatedb,rolcreaterole,rolreplication,rolbypassrls FROM pg_roles WHERE rolname=current_user')).rows[0];
    if(Object.values(flags).some(Boolean))throw new Error('Development role is privileged');
    const memberships=(await client.query('SELECT count(*)::int n FROM pg_auth_members WHERE member=(SELECT oid FROM pg_roles WHERE rolname=current_user)')).rows[0].n;
    if(memberships!==0)throw new Error('Development role has unexpected memberships');
    const production=(await client.query("SELECT datname,has_database_privilege(current_user,oid,'CONNECT') allowed FROM pg_database WHERE datname IN ('merchroute','merchroute_n8n')")).rows;
    if(production.some(x=>x.allowed))throw new Error('Development role can access a production database');
    await client.query('ROLLBACK');
    const result={schemaVersion:1,ok:true,identity,productionAccess:false,checkedAt:new Date().toISOString()};await atomicJson(path.join(home,'development-ready.json'),result);return result;
  }finally{await client.end();}
}
