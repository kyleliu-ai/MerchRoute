import { randomUUID } from 'node:crypto';
import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { Pool, type PoolClient } from 'pg';
import { loadRuntimeEnvironment } from '../runtime-environment.js';
import {
  inspectOzonProcessingPackageRecovery,
  writeOzonProcessingRecoveryPackage,
  type OzonProcessingPackageRecoveryInput
} from '../services/ozon-stores/index.js';

type JsonRecord = Record<string, unknown>;

const projectRoot = path.resolve(import.meta.dirname, '../../../..');
loadRuntimeEnvironment({ projectRoot });

const args = parseArgs(process.argv.slice(2));
const publicationId = requiredUuid(args.get('--publication-id'), '--publication-id');
const apply = args.has('--apply');
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('未配置 DATABASE_URL');

const pool = new Pool({ connectionString: databaseUrl });
const client = await pool.connect();
try {
  await client.query('BEGIN');
  const frozen = await loadFrozenAttempt(client, publicationId, apply);
  const blockers = await collectBlockers(client, frozen);
  const terminalExecutionId = args.get('--terminal-n8n-execution-id');
  const terminalLeaseProof = terminalExecutionId
    ? await proveTerminalN8nLease(frozen, terminalExecutionId)
    : undefined;
  if (terminalLeaseProof) removeOne(blockers, 'ACTIVE_JOB_LEASE');
  const input = toRecoveryInput(frozen);
  const inspection = await inspectOzonProcessingPackageRecovery(input);
  if (inspection.targetState === 'MATCHED') blockers.push('PROCESSING_TARGET_ALREADY_PRESENT');
  const response = {
    mode: apply ? 'apply' : 'dry-run',
    publicationId,
    jobId: frozen.job_id,
    taskId: frozen.task_id,
    sku: frozen.sku,
    state: frozen.state,
    publicationStatus: frozen.publication_status,
    importTaskId: frozen.import_task_id,
    workRelPath: frozen.work_rel_path,
    packageSignature: frozen.package_signature,
    mediaFileCount: inspection.mediaFileCount,
    mediaBytes: inspection.mediaBytes,
    ...(terminalLeaseProof ? { terminalLeaseProof } : {}),
    blockers,
    eligible: blockers.length === 0
  };
  if (!apply) {
    await client.query('ROLLBACK');
    process.stdout.write(`${JSON.stringify({
      ...response,
      note: '只读检查完成；未修改数据库、目录或平台。apply 会重新锁定并验证全部证据。'
    })}\n`);
  } else {
    if (blockers.length) throw new Error(`OZON processing 恢复被阻止：${blockers.join(', ')}`);
    const restored = await writeOzonProcessingRecoveryPackage(input);
    const existingEvent = await client.query(`SELECT 1 FROM ozon_publish_events
      WHERE publication_id=$1 AND event_type='PROCESSING_PACKAGE_RESTORED_FROM_FROZEN_SNAPSHOT' LIMIT 1`, [publicationId]);
    if (!existingEvent.rows[0]) {
      await client.query(`INSERT INTO ozon_publish_events(
        id,job_id,event_type,from_state,to_state,message,payload,store_id,publication_id
      ) VALUES($1,$2,'PROCESSING_PACKAGE_RESTORED_FROM_FROZEN_SNAPSHOT',$3,$3,$4,$5::jsonb,$6,$7)`, [
        randomUUID(), frozen.job_id, frozen.state,
        '缺失的 OZON processing 包已按原 publication 冻结快照和签名恢复',
        JSON.stringify({
          recoveryMode: 'LOCAL_PACKAGE_ONLY',
          taskId: frozen.task_id,
          workRelPath: frozen.work_rel_path,
          packageSignature: restored.packageSignature,
          generatedVersionId: frozen.generated_version_id,
          importTaskId: frozen.import_task_id,
          platformWriteReplayed: false
        }),
        frozen.store_id, publicationId
      ]);
    }
    await client.query('COMMIT');
    process.stdout.write(`${JSON.stringify({
      ...response,
      restored: true,
      targetDirectory: restored.targetDirectory,
      platformWriteReplayed: false,
      note: '仅恢复本地 processing 包；保留原 publication/job/task/importTaskId，未调用 OZON API。'
    })}\n`);
  }
} catch (error) {
  await client.query('ROLLBACK').catch(() => undefined);
  throw error;
} finally {
  client.release();
  await pool.end();
}

async function proveTerminalN8nLease(row: any, executionId: string): Promise<{
  executionId: string;
  workflowId: string;
  status: string;
  stoppedAt: string;
  leaseOwner: string;
}> {
  if (!/^\d+$/.test(executionId)) throw new Error('--terminal-n8n-execution-id 必须是数字执行 ID');
  const expectedLeaseOwner = `n8n:ozon:p002:${executionId}`;
  if (String(row.lease_owner || '') !== expectedLeaseOwner
    || !row.lease_expires_at
    || new Date(row.lease_expires_at).getTime() <= Date.now()) {
    throw new Error('当前活动租约不属于指定的 n8n P002 执行');
  }
  const apiKey = String(process.env.N8N_API_KEY || '').trim();
  if (!apiKey) throw new Error('未配置 N8N_API_KEY，不能证明陈旧租约对应执行已终止');
  const base = String(process.env.N8N_API_URL || process.env.N8N_BASE_URL || 'http://127.0.0.1:5678').replace(/\/+$/, '');
  const response = await fetch(`${base}/api/v1/executions/${executionId}?includeData=false`, {
    headers: { 'X-N8N-API-KEY': apiKey }
  });
  if (!response.ok) throw new Error(`n8n 执行只读回查失败（HTTP ${response.status}）`);
  const execution = await response.json() as JsonRecord;
  const status = String(execution.status || '');
  const stoppedAt = String(execution.stoppedAt || '');
  if (String(execution.id || '') !== executionId
    || String(execution.workflowId || '') !== 'g3KK68BLXX7eShqa'
    || !['error', 'canceled', 'crashed'].includes(status)
    || !stoppedAt) {
    throw new Error('指定 n8n 执行不是已终止的 P002 错误执行，禁止忽略活动租约');
  }
  return {
    executionId,
    workflowId: String(execution.workflowId),
    status,
    stoppedAt,
    leaseOwner: expectedLeaseOwner
  };
}

async function loadFrozenAttempt(client: PoolClient, publicationId: string, lock: boolean): Promise<any> {
  const result = await client.query(`SELECT
      j.id job_id,j.sku,j.state,j.source,j.task_kind,j.row_version job_row_version,
      j.lease_owner,j.lease_expires_at,j.directory_stage,j.work_rel_path,j.directory_signature,
      j.import_task_id,j.payload job_payload,
      p.id publication_id,p.status publication_status,p.source publication_source,
      p.generated_version_id,p.revision,p.store_id,p.store_alias_snapshot,p.credential_binding_mode,
      p.credential_version_id,p.store_config_version,p.warehouse_id,p.plan_hash,p.content_policy_version,
      p.material_hash,p.material_hash_version,p.preset_row_version,p.publication_mode,
      p.materialization_hash,p.offer_contract_hash,p.task_id,p.package_signature,p.materialized_product_snapshot,
      settings.root_directory
    FROM ozon_store_publications p
    JOIN ozon_publish_jobs j ON j.id=p.planned_job_id AND j.publication_id=p.id
    JOIN ozon_system_settings settings ON settings.id='default'
    WHERE p.id=$1${lock ? ' FOR UPDATE OF p,j' : ''}`, [publicationId]);
  const row = result.rows[0];
  if (!row) throw new Error('publication 或固定 STORE_PUBLICATION job 不存在');
  return row;
}

async function collectBlockers(client: PoolClient, row: any): Promise<string[]> {
  const blockers: string[] = [];
  if (row.task_kind !== 'STORE_PUBLICATION') blockers.push('TASK_KIND_MISMATCH');
  if (row.source !== 'AUTO' || row.publication_source !== 'AUTOMATION') blockers.push('SOURCE_MISMATCH');
  if (row.state !== 'IMPORTING' || row.publication_status !== 'RUNNING') blockers.push('STATE_MISMATCH');
  if (row.directory_stage !== 'PROCESSING') blockers.push('DIRECTORY_STAGE_MISMATCH');
  if (!row.import_task_id || String((row.job_payload as JsonRecord)?.importTaskId || '') !== String(row.import_task_id)) {
    blockers.push('IMPORT_TASK_ID_MISMATCH');
  }
  if (!row.package_signature || row.package_signature !== row.directory_signature) blockers.push('PACKAGE_SIGNATURE_MISMATCH');
  if (!row.materialized_product_snapshot || !Object.keys(row.materialized_product_snapshot).length) blockers.push('FROZEN_PRODUCT_MISSING');
  if (row.lease_expires_at && new Date(row.lease_expires_at).getTime() > Date.now()) blockers.push('ACTIVE_JOB_LEASE');

  const evidence = await client.query(`SELECT
      EXISTS(SELECT 1 FROM ozon_publish_slots WHERE job_id=$1 AND lease_expires_at>NOW()) active_slot,
      EXISTS(SELECT 1 FROM ozon_platform_status_refresh_leases WHERE job_id=$1 AND lease_expires_at>NOW()) active_status_refresh,
      COUNT(*) FILTER(WHERE delivery_state<>'RESPONDED' OR retry_class='READBACK_REQUIRED') nonresponded_gateway_count,
      COUNT(*) FILTER(WHERE delivery_state='UNKNOWN' OR retry_class='READBACK_REQUIRED') unknown_gateway_count
    FROM ozon_gateway_requests WHERE publication_id=$2`, [row.job_id, row.publication_id]);
  const current = evidence.rows[0] || {};
  if (current.active_slot) blockers.push('ACTIVE_RUNTIME_SLOT');
  if (current.active_status_refresh) blockers.push('ACTIVE_STATUS_REFRESH');
  if (Number(current.nonresponded_gateway_count || 0) > 0) blockers.push('NONRESPONDED_GATEWAY_REQUEST');
  if (Number(current.unknown_gateway_count || 0) > 0) blockers.push('UNKNOWN_OR_READBACK_REQUIRED');

  const root = path.resolve(String(row.root_directory || ''));
  const storeInbox = path.join(root, 'stores', String(row.store_alias_snapshot), 'inbox', String(row.sku));
  if (await stat(storeInbox).catch(() => undefined)) blockers.push('STORE_INBOX_STILL_PRESENT');
  const successRoot = path.join(root, 'success');
  const successDates = await readdir(successRoot, { withFileTypes: true }).catch(() => []);
  for (const date of successDates.filter((entry) => entry.isDirectory())) {
    if (await stat(path.join(successRoot, date.name, String(row.task_id))).catch(() => undefined)) {
      blockers.push('SUCCESS_ARCHIVE_ALREADY_PRESENT');
      break;
    }
  }
  return blockers;
}

function toRecoveryInput(row: any): OzonProcessingPackageRecoveryInput {
  return {
    rootDirectory: String(row.root_directory),
    workRelPath: String(row.work_rel_path),
    sku: String(row.sku),
    generatedVersionId: String(row.generated_version_id),
    revision: Number(row.revision),
    publicationId: String(row.publication_id),
    jobId: String(row.job_id),
    taskId: String(row.task_id),
    storeId: String(row.store_id),
    storeAlias: String(row.store_alias_snapshot),
    credentialBindingMode: row.credential_binding_mode,
    ...(row.credential_version_id ? { credentialVersionId: String(row.credential_version_id) } : {}),
    storeConfigVersion: Number(row.store_config_version),
    warehouseId: String(row.warehouse_id),
    planHash: String(row.plan_hash),
    contentPolicyVersion: String(row.content_policy_version),
    materialHash: String(row.material_hash),
    materialHashVersion: String(row.material_hash_version),
    ...(row.preset_row_version ? { presetRowVersion: Number(row.preset_row_version) } : {}),
    publicationMode: row.publication_mode,
    materializationHash: String(row.materialization_hash),
    offerContractHash: String(row.offer_contract_hash),
    packageSignature: String(row.package_signature),
    product: row.materialized_product_snapshot
  };
}

function parseArgs(values: string[]): Map<string, string> {
  const result = new Map<string, string>();
  for (const argument of values.filter((value) => value.startsWith('--'))) {
    const [key, ...rest] = argument.split('=');
    if (key) result.set(key, rest.join('=') || 'true');
  }
  return result;
}

function requiredUuid(value: string | undefined, name: string): string {
  const normalized = String(value || '');
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(normalized)) {
    throw new Error(`${name} 必须是有效 UUID`);
  }
  return normalized;
}

function removeOne(values: string[], value: string): void {
  const index = values.indexOf(value);
  if (index >= 0) values.splice(index, 1);
}
