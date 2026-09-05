import { AppError, classifyOzonImportFailures, isExecutableOzonContentPolicyVersion, ozonErrorsAreTransient, ozonProductSchema, type OzonPublishRetryPlan, type OzonPublishRetryRequest } from '@n8n-media-review/shared';
import { ozonRetryRecord, ozonRetryToken, retryHash, retryObject, retryCredentialReady, retryRuntimeContractReady, type OzonRetryRepository, type OzonRetrySnapshot, type RetryRow } from '../../repositories/ozon-retry.js';
import type { OzonStoreService, OzonFrozenAutomaticPublicationPlan } from '../ozon-stores/index.js';
import type { OzonStoreGatewayService } from '../ozon-stores/gateway.js';

const WRITE_OPERATIONS = new Set(['importProduct', 'picturesImport', 'pricesWrite', 'stocksWrite', 'attributesUpdate']);
const stopped = new Set(['NEEDS_ATTENTION', 'FAILED', 'WAITING_MEDIA']);
const hasRemoteEvidence = (s: OzonRetrySnapshot): boolean => Boolean(s.job.import_task_id || s.job.ozon_product_id
  || retryObject(s.job.payload).importIntent || retryObject(s.job.payload).platformWriteAttempted
  || (s.publication?.product_ids || []).length
  || (s.job.product_links || []).some((link: RetryRow) => link.ozonProductId)
  || ['PROCESSING','SUCCESS'].includes(s.job.directory_stage)
  || s.gateways.some(g => WRITE_OPERATIONS.has(g.operation) && g.delivery_state !== 'NOT_SENT'));

function validFrozenProduct(s: OzonRetrySnapshot): boolean {
  const p = s.publication, product = retryObject(p?.materialized_product_snapshot);
  return Boolean(p && ozonProductSchema.safeParse(product).success && s.version
    && product.productCode === s.job.sku && Number(product.revision) === Number(p.revision)
    && product.storeAlias === p.store_alias_snapshot && String(product.warehouseId) === p.warehouse_id
    && product.currency === p.account_currency && product.fulfillmentMode === p.fulfillment_mode
    && product.contentPolicyVersion === p.content_policy_version && product.materialHash === p.material_hash
    && product.materialHashVersion === p.material_hash_version
    && p.material_hash === s.version.material_hash && p.content_policy_version === s.version.content_policy_version
    && retryHash(product.offers.map((o: RetryRow) => o.offerId)) === retryHash(p.offer_ids)
    && retryHash(s.job.offer_ids) === retryHash(p.offer_ids)
    && p.offer_contract_hash === retryHash({ storeId: p.store_id, generatedVersionId: p.generated_version_id, offerIds: [...p.offer_ids].sort() }));
}

function progressBlockedReason(s: OzonRetrySnapshot): string {
  const progress = retryObject(s.job.payload).priceStockWriteProgress;
  if (!progress) return '';
  for (const operation of ['pricesWrite', 'stocksWrite']) {
    const bucket = progress[operation];
    if (!bucket || !['succeededOfferIds', 'pendingOfferIds', 'failedOfferIds'].every(k => Array.isArray(bucket[k]))) return '价格库存检查点不完整，请人工核对';
    const all = [...bucket.succeededOfferIds, ...bucket.pendingOfferIds, ...bucket.failedOfferIds];
    if (all.length !== new Set(all).size || retryHash([...all].sort()) !== retryHash([...(s.publication?.offer_ids || [])].sort())) return '价格库存检查点与原 Offer 不一致，请人工核对';
    if (bucket.failedOfferIds.some((id: string) => !ozonErrorsAreTransient(bucket.errorsByOffer?.[id]))) return '存在平台明确拒绝的价格或库存，请修正业务数据后处理，不能直接重放';
  }
  return '';
}
const stageNames: Record<string, string> = {
  READY: '等待上品调度', UPLOADING_MEDIA: '继续上传媒体', SUBMITTING: '继续提交商品',
  IMPORTING: '核对原导入结果并继续上品', VERIFYING_IMAGES: '核验商品图片',
  UPDATING_PRICE: '继续设置价格', UPDATING_STOCK: '继续设置库存', MODERATING: '等待平台审核与最终核验'
};

export function buildOzonRetryPlan(s: OzonRetrySnapshot, latest?: RetryRow): OzonPublishRetryPlan {
  const j = s.job, p = s.publication, payload = retryObject(j.payload);
  const importFailure = classifyOzonImportFailures(payload);
  const remote = hasRemoteEvidence(s);
  const frozenValid = validFrozenProduct(s);
  const mode = remote ? 'READBACK' : frozenValid ? 'RESUME' : 'REBUILD';
  let reason = '';
  if (!stopped.has(j.state)) reason = '任务正在执行、已成功或已取消，不能重复启动';
  else if (latest && ['CHECKING', 'RUNNING'].includes(latest.status)) reason = '已有重试正在执行';
  else if (payload.replanReplacement || payload.retryReplacements?.[s.store.id]) reason = '该任务已有替代任务，请打开接续任务';
  else if (!s.settings.enabled || !s.store.enabled || s.store.archived_at) reason = '请先启用 OZON 上品管理和当前店铺';
  else if (s.store.preflight_status !== 'PASSED' || !(new Date(s.store.preflight_expires_at).getTime() > Date.now())) reason = '请先在店铺设置重新检查连接，当前店铺预检未通过或已过期';
  else if (j.lease_expires_at && new Date(j.lease_expires_at).getTime()>Date.now() || payload.recoveryHold?.active) reason = '任务存在活动租约或恢复操作';
  else if (p && p.credential_binding_mode !== 'VAULT') reason = '历史任务缺少完整的多店冻结身份，仅支持人工核对';
  else if (!s.version || !isExecutableOzonContentPolicyVersion(s.version.content_policy_version)) reason = '原公共素材版本或内容策略不可执行，请处理资料后重新发布';
  else if (mode === 'REBUILD' && (!s.preset || !s.store.auto_publish_enabled || !s.store.active_credential_version_id)) reason = '当前店铺的自动上品预设或凭据不完整';
  else if (!retryCredentialReady(s, mode === 'REBUILD' ? s.store.active_credential_version_id : p?.credential_version_id)) reason = '本次上品使用的冻结凭据未通过有效期核验，请在店铺设置检查对应凭据；不能静默换用新凭据';
  else if (mode !== 'REBUILD' && (!p?.task_id || !p.materialization_hash || !p.plan_hash || !p.request_id)) reason = '原任务冻结合同不完整，不能安全续跑';
  else if (mode !== 'REBUILD' && !retryRuntimeContractReady(s)) reason = '原任务执行合同不完整或与发布快照不一致，不能进入调度';
  else if (mode !== 'REBUILD' && Number(p?.store_config_version) !== Number(s.store.config_version)) reason = '店铺配置已变化，原任务冻结配置不能继续写入，请先处理配置差异';
  else if (mode === 'READBACK' && !frozenValid) reason = '平台结果需核对，但原 Offer 或商品快照不完整，禁止重复创建';
  else if (mode === 'REBUILD' && s.gateways.length) reason = '旧任务已有网关证据，不能重建身份，请先人工核对';
  else if (importFailure.classification === 'DUPLICATE_PRODUCT_CARD') {
    const failedOffers = importFailure.blockedOffers.map((offer) => offer.offerId).filter(Boolean).join('、') || '当前 Offer';
    const conflicts = [...new Set(importFailure.blockedOffers.flatMap((offer) => offer.conflictOfferIds))].join('、') || '已有商品卡';
    reason = `商品卡重复：OZON 判定 ${failedOffers} 与已有商品卡 ${conflicts} 类似或重复。请在 OZON 后台处理后同步平台状态，或取消自动任务。`;
  } else if (importFailure.classification === 'PERMANENT') reason = '存在 OZON 明确拒绝的商品导入错误，请修正业务资料并创建新版本，不能直接重试';
  else if (progressBlockedReason(s)) reason = progressBlockedReason(s);
  const values = [
    ['预设', p?.preset_id, s.store.default_preset_id],
    ['预设版本', p?.preset_row_version, s.preset?.row_version],
    ['店铺配置版本', p?.store_config_version, s.store.config_version],
    ['仓库', p?.warehouse_id, s.store.warehouse_id],
    ['币种', p?.account_currency, s.store.account_currency],
    ['履约方式', p?.fulfillment_mode, s.store.fulfillment_mode],
    ['发布方式', p?.publication_mode, s.store.auto_publish_mode],
    ['凭据版本', p?.credential_version_id, s.store.active_credential_version_id]
  ];
  return { canRetry: !reason, ...(reason ? { blockedReason: reason } : {}),
    ...(importFailure.blockerCode ? { blockerCode: importFailure.blockerCode, blockedOffers: importFailure.blockedOffers } : {}),
    planHash: ozonRetryToken(s),
    sourceJobId: j.id, storeId: s.store.id, sku: j.sku, storeName: s.store.display_name || s.store.store_alias,
    mode, stage: mode === 'REBUILD' ? '重新生成当前店铺上品资料' : mode === 'READBACK' ? '核对平台结果后继续' : '恢复原发布包并继续上品',
    requiresConfirmation: mode === 'REBUILD', previousError: j.last_error_message || p?.error_message || '',
    offerIds: p?.offer_ids?.length ? p.offer_ids : (s.version?.snapshot?.data?.offers || []).map((o: RetryRow) => o.offerId),
    changes: values.map(([label, previous, current]) => ({ label: String(label), previous: String(previous ?? '未生成'), current: String(current ?? '未配置') })),
    ...(latest ? { latest: ozonRetryRecord(latest) } : {}) };
}

/** Select an existing executor branch. Never reset a possibly delivered import to READY. */
export function ozonRetryResume(s: OzonRetrySnapshot): { state: string; payload: RetryRow } {
  const p = retryObject(s.job.payload);
  const importFailure = classifyOzonImportFailures(p);
  if (importFailure.blockerCode || importFailure.classification === 'PERMANENT') {
    throw new AppError(importFailure.blockerCode || 'OZON_IMPORT_FAILURE_UNCLASSIFIED', importFailure.classification === 'DUPLICATE_PRODUCT_CARD'
      ? 'OZON 已明确拒绝重复商品卡，不能恢复原导入任务'
      : importFailure.blockerCode
        ? 'OZON 已明确拒绝商品导入，不能恢复原导入任务'
        : 'OZON 商品导入失败证据不完整，不能恢复原导入任务');
  }
  const blocked = progressBlockedReason(s);
  if (blocked) throw new AppError('OZON_RETRY_PROGRESS_INVALID', blocked);
  if (hasRemoteEvidence(s)) {
    const patch: RetryRow = {};
    if (p.imageRecovery?.phase === 'REUPLOAD_PENDING') return { state: 'MODERATING', payload: patch };
    // Only transient failures may re-enter pending. Explicit business errors must
    // retain their evidence and stop in the existing executor, never be erased.
    if (p.priceStockWriteProgress) {
      const progress = structuredClone(p.priceStockWriteProgress);
      for (const operation of ['pricesWrite', 'stocksWrite']) {
        const bucket = progress[operation];
        if (!bucket) continue;
        const recoverable = (bucket.failedOfferIds || []).filter((id: string) => {
          const errors = bucket.errorsByOffer?.[id];
          return ozonErrorsAreTransient(errors);
        });
        bucket.pendingOfferIds = [...new Set([...(bucket.pendingOfferIds || []), ...recoverable])];
        bucket.failedOfferIds = (bucket.failedOfferIds || []).filter((id: string) => !recoverable.includes(id));
      }
      patch.priceStockWriteProgress = progress;
    }
    return { state: 'IMPORTING', payload: patch };
  }
  return { state: 'READY', payload: {} };
}

export class OzonPublishRetryService {
  private timer?: NodeJS.Timeout;
  private running?: Promise<void>;
  constructor(readonly repository: OzonRetryRepository, private readonly stores: OzonStoreService,
    private readonly gateway: Pick<OzonStoreGatewayService, 'proveStoreOfferAbsence'>,
    private readonly logger: { error: (...args: any[]) => void } = console) {}

  async plan(jobId: string, storeId: string): Promise<OzonPublishRetryPlan> {
    const snapshot = await this.repository.snapshot(jobId, storeId);
    const plan = buildOzonRetryPlan(snapshot, await this.repository.latest(snapshot.job.id, storeId));
    if (!this.stores.repository.isFleetCapabilityReady()) return { ...plan, canRetry: false, blockedReason: 'OZON 多店执行链尚未核验启用' };
    return plan;
  }

  async request(jobId: string, input: OzonPublishRetryRequest) {
    const previous = await this.repository.byRequest(input.requestId);
    if (previous) {
      if (![previous.source_job_id, previous.root_job_id].includes(jobId) || previous.store_id !== input.storeId || previous.plan_hash !== input.planHash) throw new AppError('VERSION_CONFLICT', '重试请求 ID 已绑定其他任务或计划', undefined, 409);
      return { retry: ozonRetryRecord(previous), idempotent: true };
    }
    const plan = await this.plan(jobId, input.storeId);
    const record = await this.repository.accept(jobId, input, plan);
    return { retry: ozonRetryRecord(record), idempotent: false };
  }

  start(): void {
    if (this.timer || !this.stores.repository.configured) return;
    this.timer = setInterval(() => { void this.runPending().catch(err => this.logger.error({ err }, 'OZON 重试执行检查失败')); }, 5_000);
    this.timer.unref();
  }
  async stop(): Promise<void> { if (this.timer) clearInterval(this.timer); this.timer = undefined; await this.running; }
  runPending(): Promise<void> {
    if (this.running) return this.running;
    this.running = this.advanceNext().finally(() => { this.running = undefined; });
    return this.running;
  }
  private async advanceNext(): Promise<void> {
    if (!this.stores.repository.isFleetCapabilityReady()) return;
    const r = await this.repository.claim();
    if (!r) return;
    try {
      if (r.status === 'RUNNING') {
        const job = await this.repository.effectiveJob(r);
        if (!job) throw new AppError('OZON_RETRY_TARGET_MISSING', '接续任务不存在');
        if (job.state === 'SUCCEEDED') await this.repository.settle(r, 'SUCCEEDED', '上品已完成并通过平台核验');
        else if (['FAILED', 'NEEDS_ATTENTION', 'CANCELLED'].includes(job.state)) await this.repository.settle(r, 'FAILED', job.last_error_message || '本轮上品停止，请检查任务详情', job.last_error_code || 'OZON_RETRY_STOPPED');
        else await this.repository.defer(r, job.state, stageNames[job.state] || '正在继续执行原上品任务');
        return;
      }
      const s = await this.repository.snapshot(r.source_job_id, r.store_id);
      const original = r.snapshot as OzonRetrySnapshot;
      if (retryHash(s.store) !== retryHash(original.store) || retryHash(s.preset) !== retryHash(original.preset)
        || retryHash(s.settings) !== retryHash(original.settings)) throw new AppError('VERSION_CONFLICT', '确认后的店铺、预设或系统配置已变化，请重新重试', undefined, 409);
      if (retryObject(s.job.payload).recoveryHold?.retryId !== r.id) throw new AppError('TASK_LOCKED', '原任务的重试保护已变化');
      if (r.mode === 'REBUILD') {
        await this.stores.assertRetrySourceAvailable(original.version!.id);
        const reserved = await this.repository.reserveVersion(r);
        let frozen = r.checkpoint.frozenPlan as OzonFrozenAutomaticPublicationPlan | undefined;
        if (!frozen) {
          await this.repository.checkpoint(r, {}, 'PREPARING', '正在重新生成当前店铺的标题和上品资料');
          frozen = await this.stores.automaticPublicationPlan(r.sku, reserved.draftVersion, [r.store_id], { prepareSharedSource: true });
          if (frozen.items.length !== 1 || frozen.items[0]!.storeId !== r.store_id || !frozen.items[0]!.ready) {
            throw new AppError('OZON_RETRY_MATERIAL_INVALID', frozen.items[0]?.blockers.join('；') || '当前店铺上品资料校验失败');
          }
          await this.repository.checkpoint(r, { frozenPlan: frozen }, 'CHECKING_ABSENCE', '核对当前店铺是否已经存在同 Offer 商品');
        }
        if (frozen.generatedVersionId !== reserved.versionId) throw new AppError('VERSION_CONFLICT', '重建期间公共素材版本发生变化');
        const originalOffers = (original.version!.snapshot?.data?.offers || []).map((offer: RetryRow) => offer.offerId).sort();
        if (retryHash([...frozen.items[0]!.offerIds].sort()) !== retryHash(originalOffers)) throw new AppError('VERSION_CONFLICT', '重建后的 Offer 集合与原公共素材不一致，请通过新版本发布处理');
        await this.gateway.proveStoreOfferAbsence({ storeId: r.store_id, expectedStoreConfigVersion: frozen.items[0]!.storeConfigVersion,
          expectedCredentialVersionId: String(frozen.items[0]!.credentialVersionId || ''), offerIds: frozen.items[0]!.offerIds });
        await this.repository.checkpoint(r, {}, 'MATERIALIZING', '正在生成当前店铺的独立发布包');
        const result = await this.stores.createRetryPublicationFromFrozenPlan(frozen, r.id, r.lease_token);
        if (result.failed || result.publications.length !== 1) throw new AppError('OZON_RETRY_MATERIALIZATION_FAILED', result.failures[0]?.message || '当前店铺发布包生成失败');
        await this.repository.releaseToRuntime(r, frozen.items[0]!.plannedJobId);
      } else {
        const p = s.publication!;
        if (r.mode === 'RESUME') {
          await this.repository.checkpoint(r, {}, 'CHECKING_ABSENCE', '核对当前店铺是否已被手动上品，防止重复创建');
          await this.gateway.proveStoreOfferAbsence({ storeId: r.store_id, expectedStoreConfigVersion: p.store_config_version,
            expectedCredentialVersionId: p.credential_version_id, offerIds: p.offer_ids });
        }
        if (r.mode === 'RESUME' && !s.gateways.length && ['PLANNED', 'NEEDS_ATTENTION'].includes(p.status)) {
          await this.stores.recheckPublication(p.id, { rowVersion: p.row_version, planHash: p.plan_hash, requestId: p.request_id }, r.id, r.lease_token);
        }
        const current = await this.repository.snapshot(r.source_job_id, r.store_id);
        await this.stores.validateRetryPackage(current.job, current.publication!);
        const resume = ozonRetryResume(current);
        await this.repository.releaseToRuntime(r, current.job.id, resume.state, resume.payload);
      }
    } catch (error) {
      await this.repository.settle(r, 'BLOCKED', error instanceof Error ? error.message : '重试条件未通过', error instanceof AppError ? error.code : 'OZON_RETRY_CHECK_FAILED');
    }
  }
}
