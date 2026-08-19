import { createHash, randomUUID } from 'node:crypto';
import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { Pool, type PoolClient } from 'pg';
import { loadRuntimeEnvironment } from '../runtime-environment.js';

type JsonRecord = Record<string, any>;

const projectRoot = path.resolve(import.meta.dirname, '../../../..');
loadRuntimeEnvironment({ projectRoot });
const args = parseArgs(process.argv.slice(2));
const jobId = requiredUuid(args.get('--job-id'), '--job-id');
const expectedRowVersion = requiredPositiveInteger(args.get('--row-version'), '--row-version');
const apply = args.has('--apply');
if (!process.env.DATABASE_URL) throw new Error('未配置 DATABASE_URL');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const client = await pool.connect();
try {
  await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
  const parent = await loadParent(client, jobId, apply);
  const evidence = await inspectEvidence(client, parent, expectedRowVersion);
  if (!apply) {
    await client.query('ROLLBACK');
    process.stdout.write(`${JSON.stringify({
      mode: 'dry-run', eligible: true, jobId, expectedRowVersion,
      sku: parent.sku, ...evidence.summary,
      note: '只读核验完成；未修改数据库、目录或平台。apply 会重新串行化锁定全部证据。'
    })}\n`);
  } else {
    const completedAt = new Date().toISOString();
    for (const delivery of evidence.deliveries) {
      const updated = await client.query(`UPDATE ozon_media_deliveries SET
          job_id=$5::uuid,payload=payload || jsonb_build_object(
            'autoPublishDecision','FANNED_OUT','fanoutPublicationIds',$6::jsonb,
            'fanoutStoreIds',$7::jsonb,'fanoutGeneratedVersionId',$8::text,
            'fanoutCompletedAt',$9::text,'fanoutRecoveryMode','DEFERRED_LEDGER_EXACT_FROZEN_VERSION'
          ),updated_at=NOW()
        WHERE sku=$1 AND source_stage_id=$2 AND submission_id=$3 AND variant_id=$4
          AND job_id IS NULL AND payload=$10::jsonb`, [
        parent.sku, delivery.identity.sourceStageId, delivery.identity.submissionId,
        delivery.identity.variantId, jobId, JSON.stringify(evidence.publicationIds),
        JSON.stringify(evidence.storeIds), evidence.generatedVersionId, completedAt,
        JSON.stringify(delivery.payload)
      ]);
      if (updated.rowCount !== 1) throw new Error('媒体账本 CAS 未完整命中，已停止收口');
    }
    for (const publication of evidence.publications) {
      for (const delivery of evidence.deliveries) {
        const inserted = await client.query(`INSERT INTO ozon_store_media_consumptions(
            store_id,sku,source_stage_id,submission_id,variant_id,decision,publication_id,job_id,reason
          ) VALUES($1,$2,$3,$4,$5,'FANNED_OUT',$6,$7,$8)
          ON CONFLICT(store_id,sku,source_stage_id,submission_id,variant_id) DO UPDATE SET
            decision='FANNED_OUT',publication_id=EXCLUDED.publication_id,job_id=EXCLUDED.job_id,
            reason=EXCLUDED.reason,updated_at=NOW()
          WHERE (ozon_store_media_consumptions.publication_id IS NULL
              OR ozon_store_media_consumptions.publication_id=EXCLUDED.publication_id)
            AND (ozon_store_media_consumptions.job_id IS NULL
              OR ozon_store_media_consumptions.job_id=EXCLUDED.job_id)
          RETURNING store_id`, [
          publication.store_id, parent.sku, delivery.identity.sourceStageId,
          delivery.identity.submissionId, delivery.identity.variantId,
          publication.id, publication.job_id,
          '冻结稳定版本与成功 publication 精确证明该媒体投递已完成 fan-out'
        ]);
        if (inserted.rowCount !== 1) throw new Error('每店媒体消费记录已绑定其他 publication，已停止收口');
      }
    }
    const nextFanout = {
      completed: true,
      completedAt,
      publicationIds: evidence.publicationIds,
      storeIds: evidence.storeIds,
      failures: []
    };
    const nextSummary = {
      phase: 'SUCCEEDED', targetStoreCount: evidence.storeIds.length,
      publicationCount: evidence.publicationIds.length, failureCount: 0,
      canRecheck: false, canManualTakeover: false, recoveryMode: 'NONE'
    };
    const updatedParent = await client.query(`UPDATE ozon_publish_jobs SET
        state='SUCCEEDED',finished_at=NOW(),last_error_code=NULL,last_error_message=NULL,next_attempt_at=NULL,
        lease_owner=NULL,lease_token=NULL,lease_expires_at=NULL,
        payload=payload || jsonb_build_object('multistoreFanout',$3::jsonb,'fanoutSummary',$4::jsonb,
          'deferredLedgerFanoutRecovery',$5::jsonb),row_version=row_version+1,updated_at=NOW()
      WHERE id=$1 AND row_version=$2 AND state='NEEDS_ATTENTION' AND payload=$6::jsonb
      RETURNING row_version`, [
      jobId, expectedRowVersion, JSON.stringify(nextFanout), JSON.stringify(nextSummary),
      JSON.stringify({
        schemaVersion: 1, completed: true, completedAt,
        generatedVersionId: evidence.generatedVersionId,
        evidenceHash: evidence.summary.evidenceHash,
        platformWriteReplayed: false
      }), JSON.stringify(parent.payload)
    ]);
    if (updatedParent.rowCount !== 1) throw new Error('父准备任务 CAS 未命中，已停止收口');
    await client.query(`INSERT INTO ozon_publish_events(
        id,job_id,event_type,from_state,to_state,message,payload,store_id,publication_id
      ) VALUES($1,$2,'MULTISTORE_DEFERRED_LEDGER_RECONCILED','NEEDS_ATTENTION','SUCCEEDED',$3,$4::jsonb,$5,NULL)`, [
      randomUUID(), jobId,
      '已由冻结稳定版本、成功 publication 和成功归档原子证明并收口延迟媒体账本',
      JSON.stringify({ ...evidence.summary, completedAt, platformWriteReplayed: false }),
      parent.store_id
    ]);
    await client.query('COMMIT');
    process.stdout.write(`${JSON.stringify({
      mode: 'apply', reconciled: true, jobId, rowVersion: Number(updatedParent.rows[0].row_version),
      ...evidence.summary, platformWriteReplayed: false,
      note: '仅收口内部父协调任务与媒体账本；未调用 OZON API，未修改成功子任务身份。'
    })}\n`);
  }
} catch (error) {
  await client.query('ROLLBACK').catch(() => undefined);
  throw error;
} finally {
  client.release();
  await pool.end();
}

async function loadParent(client: PoolClient, jobId: string, lock: boolean): Promise<JsonRecord> {
  const result = await client.query(`SELECT j.*,settings.root_directory FROM ozon_publish_jobs j
    JOIN ozon_system_settings settings ON settings.id='default'
    WHERE j.id=$1${lock ? ' FOR UPDATE OF j' : ''}`, [jobId]);
  if (!result.rows[0]) throw new Error('父准备任务不存在');
  return result.rows[0];
}

async function inspectEvidence(client: PoolClient, parent: JsonRecord, expectedRowVersion: number) {
  if (Number(parent.row_version) !== expectedRowVersion) throw new Error('父准备任务 rowVersion 已变化');
  if (parent.task_kind !== 'SHARED_PREPARATION' || parent.source !== 'AUTO'
    || parent.state !== 'NEEDS_ATTENTION' || parent.last_error_code !== 'OZON_AUTOMATIC_FANOUT_INCOMPLETE') {
    throw new Error('父准备任务状态或错误身份不符合延迟账本收口条件');
  }
  if (parent.lease_expires_at && new Date(parent.lease_expires_at).getTime() > Date.now()) {
    throw new Error('父准备任务仍有活动租约');
  }
  const payload = asRecord(parent.payload);
  const fanout = asRecord(payload.multistoreFanout);
  const plan = asRecord(payload.fanoutPlan);
  const failures = asArray(fanout.failures);
  if (failures.length !== 1 || failures[0]?.code !== 'OZON_MEDIA_DELIVERY_IDENTITY_DRIFT') {
    throw new Error('父准备任务不只包含已知媒体账本漂移，禁止自动收口');
  }
  const identities = asArray(failures[0]?.deliveryIdentities).map((identity) => ({
    sourceStageId: String(identity.sourceStageId || ''),
    submissionId: String(identity.submissionId || ''),
    variantId: String(identity.variantId || '')
  }));
  if (!identities.length || identities.some((identity) => !['E004', 'E005'].includes(identity.sourceStageId)
    || !identity.submissionId || !identity.variantId)) throw new Error('媒体漂移身份不完整');
  const publicationIds = uniqueStrings(fanout.publicationIds).sort();
  const storeIds = uniqueStrings(fanout.storeIds).sort();
  const planItems = asArray(plan.items);
  if (!publicationIds.length || publicationIds.length !== storeIds.length
    || stableJson(uniqueStrings(planItems.map((item) => item.publicationId)).sort()) !== stableJson(publicationIds)
    || stableJson(uniqueStrings(planItems.map((item) => item.storeId)).sort()) !== stableJson(storeIds)) {
    throw new Error('冻结计划与父任务 publication/store 集合不一致');
  }
  const publicationsResult = await client.query(`SELECT p.*,j.id job_id,j.state job_state,j.directory_stage,
      j.directory_signature,j.task_id job_task_id,j.lease_expires_at
    FROM ozon_store_publications p JOIN ozon_publish_jobs j ON j.id=p.planned_job_id
    WHERE p.id=ANY($1::uuid[]) ORDER BY p.id FOR UPDATE OF p,j`, [publicationIds]);
  const publications = publicationsResult.rows;
  if (publications.length !== publicationIds.length || publications.some((publication) => (
    publication.preparation_job_id !== parent.id || publication.status !== 'SUCCEEDED'
    || publication.job_state !== 'SUCCEEDED' || publication.directory_stage !== 'SUCCESS'
    || publication.directory_signature !== publication.package_signature
    || publication.job_task_id !== publication.task_id
    || (publication.lease_expires_at && new Date(publication.lease_expires_at).getTime() > Date.now())
    || !asArray(publication.product_ids).length || !asArray(publication.ozon_skus).length
  ))) throw new Error('子 publication/job 尚未全部成功或冻结签名不一致');
  if (stableJson(uniqueStrings(publications.map((publication) => publication.store_id)).sort()) !== stableJson(storeIds)) {
    throw new Error('成功 publication 店铺集合与冻结计划不一致');
  }
  const runtimeBlockers = await client.query(`SELECT
      EXISTS(SELECT 1 FROM ozon_publish_slots WHERE job_id=ANY($1::uuid[]) AND lease_expires_at>NOW()) active_slot,
      EXISTS(SELECT 1 FROM ozon_platform_status_refresh_leases WHERE job_id=ANY($1::uuid[]) AND lease_expires_at>NOW()) active_refresh,
      EXISTS(SELECT 1 FROM ozon_gateway_requests WHERE publication_id=ANY($2::uuid[])
        AND (delivery_state<>'RESPONDED' OR retry_class='READBACK_REQUIRED')) uncertain_gateway`, [
      publications.map((publication) => publication.job_id), publicationIds
    ]);
  if (Object.values(runtimeBlockers.rows[0] || {}).some(Boolean)) throw new Error('仍有活动运行租约或不确定平台请求');

  const generatedVersionId = String(payload.generatedVersionId || plan.generatedVersionId || '');
  const versionResult = await client.query('SELECT * FROM ozon_listing_versions WHERE id=$1 FOR SHARE', [generatedVersionId]);
  const version = versionResult.rows[0];
  if (!version || version.sku !== parent.sku || String(version.material_hash) !== String(payload.materialHash || '')) {
    throw new Error('冻结稳定版本与父任务身份不一致');
  }
  const versionData = asRecord(asRecord(version.snapshot).data);
  const assets = asArray(versionData.mediaAssets);
  const referencedAssetIds = new Set(asArray(versionData.offers)
    .flatMap((offer) => asArray(offer.media).map((media) => String(media.assetId || ''))));
  const deliveries: Array<{ identity: typeof identities[number]; payload: JsonRecord }> = [];
  for (const identity of identities) {
    const locked = await client.query(`SELECT * FROM ozon_media_deliveries
      WHERE sku=$1 AND source_stage_id=$2 AND submission_id=$3 AND variant_id=$4 FOR UPDATE`, [
      parent.sku, identity.sourceStageId, identity.submissionId, identity.variantId
    ]);
    const row = locked.rows[0];
    const deliveryPayload = asRecord(row?.payload);
    if (locked.rows.length !== 1 || row.job_id !== null
      || deliveryPayload.autoPublishDecision !== 'DEFERRED'
      || deliveryPayload.autoPublishDeferredReason !== 'ACTIVE_JOB_FROZEN'
      || String(deliveryPayload.blockingJobId || '') !== parent.id
      || String(deliveryPayload.blockingJobState || '') !== 'NEEDS_ATTENTION'
      || !String(deliveryPayload.autoPublishAcceptanceId || '')
      || !String(deliveryPayload.autoPublishAcceptedPresetId || '')
      || !String(deliveryPayload.autoPublishAcceptedDefinitionHash || '')) {
      throw new Error('延迟媒体账本状态、归属或接受证据已变化');
    }
    const representedAssets = assets.filter((asset) => (
      asset.sourceStageId === identity.sourceStageId
      && asset.sourceSubmissionId === identity.submissionId
      && asset.productVariantId === identity.variantId
      && referencedAssetIds.has(String(asset.assetId || ''))
      && asset.validationStatus === 'VALID'
    ));
    const selected = uniqueStrings(deliveryPayload.selectedRelativePaths).sort();
    const representedNames = uniqueStrings(representedAssets.map((asset) => path.posix.basename(String(asset.relativePath || '').replaceAll('\\', '/')))).sort();
    if (!representedAssets.length || stableJson(selected) !== stableJson(representedNames)) {
      throw new Error('稳定版本引用的媒体集合与延迟投递清单不一致');
    }
    deliveries.push({ identity, payload: deliveryPayload });
  }
  const root = path.resolve(String(parent.root_directory || ''));
  for (const publication of publications) {
    const archive = await findSuccessArchive(root, String(publication.task_id));
    if (!archive) throw new Error(`成功归档不存在：${publication.task_id}`);
    const [productBytes, intakeRaw] = await Promise.all([
      readFile(path.join(archive, 'product.json')),
      readFile(path.join(archive, '.ozon-intake.json'), 'utf8')
    ]);
    const signature = `sha256:${createHash('sha256').update(productBytes).digest('hex')}`;
    const intake = asRecord(JSON.parse(intakeRaw));
    if (signature !== publication.package_signature || intake.productContentHash !== signature
      || intake.publicationId !== publication.id || intake.jobId !== publication.job_id
      || intake.taskId !== publication.task_id) throw new Error(`成功归档签名不一致：${publication.task_id}`);
  }
  const summary = {
    generatedVersionId,
    publicationIds,
    storeIds,
    deliveryIdentities: identities,
    evidenceHash: `sha256:${createHash('sha256').update(stableJson({
      jobId: parent.id, sku: parent.sku, expectedRowVersion, generatedVersionId,
      publicationIds, storeIds, deliveryIdentities: identities,
      packageSignatures: publications.map((publication) => publication.package_signature).sort()
    })).digest('hex')}`
  };
  return { publications, publicationIds, storeIds, deliveries, generatedVersionId, summary };
}

async function findSuccessArchive(root: string, taskId: string): Promise<string | undefined> {
  const success = path.join(root, 'success');
  const dates = await readdir(success, { withFileTypes: true });
  const matches: string[] = [];
  for (const date of dates.filter((entry) => entry.isDirectory())) {
    const candidate = path.join(success, date.name, taskId);
    if ((await stat(candidate).catch(() => undefined))?.isDirectory()) matches.push(candidate);
  }
  if (matches.length > 1) throw new Error(`同一 taskId 存在多个成功归档：${taskId}`);
  return matches[0];
}

function asRecord(value: unknown): JsonRecord { return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : {}; }
function asArray(value: unknown): JsonRecord[] { return Array.isArray(value) ? value.map(asRecord) : []; }
function uniqueStrings(value: unknown): string[] {
  const values = Array.isArray(value) ? value : [];
  return [...new Set(values.map((entry) => String(entry || '')).filter(Boolean))];
}
function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const object = value as JsonRecord;
    return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${stableJson(object[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
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
function requiredPositiveInteger(value: string | undefined, name: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error(`${name} 必须是正整数`);
  return parsed;
}
