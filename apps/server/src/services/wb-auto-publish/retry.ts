import { AppError, WB_RETRY_STAGE_LABELS, type WbPublishRetryDetail, type WbPublishRetryRequest } from '@n8n-media-review/shared';
import { ACTIVE_RETRY, retryRecord, retryStateToken, type WbAutoRetryRepository, type WbRetryClaim, type WbRetrySnapshot } from '../../repositories/wb-auto-retry.js';

type Row = Record<string, any>;
type Gateway = { execute(input: unknown): Promise<any> };
type RetryPlan = { stage: string; evidence: Row; cardAttempt?: number };
const object = (v: any): Row => {
  if (typeof v === 'string') { try { return JSON.parse(v); } catch { return { message: v }; } }
  return v && typeof v === 'object' ? v : {};
};
const stopped = new Set(['FAILED', 'NEEDS_ATTENTION', 'PAUSED', 'BLOCKED_CONFIG', 'BLOCKED_AUTH', 'BLOCKED_SCHEMA', 'BLOCKED_COMPLIANCE', 'BLOCKED_EXISTING_CARD']);
const retryableAuto = new Set(['WAITING_MEDIA', 'WAITING_STABLE', ...stopped, 'BLOCKED_EXISTING_CARD']);
function error(message: string, details?: Row): never { throw new AppError('WB_RETRY_UNSAFE', message, details, 409); }

export function buildWbRetryPlan(snapshot: WbRetrySnapshot, receipts: Row[], readback: Row, unconsumedAttempt?: number): RetryPlan {
  const { auto: a, runtime: r, publication: p } = snapshot;
  if (!r || !p || r.task_id !== a.n8n_task_id || p.id !== a.publication_id || p.task_id !== r.task_id
    || r.store_id !== a.store_id || p.store_id !== a.store_id || r.publication_id !== p.id) error('原任务与店铺发布记录无法精确对应');
  const runtime = object(r.result_json);
  const product = object(runtime.product);
  if (runtime.automationRunId !== a.run_id || String(product.productCode || product.sku || r.product_code) !== a.sku
    || Number(product.revision) !== Number(r.revision) || !r.payload_signature || !p.generated_version_id) error('原任务冻结快照或版本证据不完整');
  if (!Array.isArray(product.variants) || !product.variants.length) error('原任务缺少冻结的商品变体');
  const expected: string[] = product.variants.map((v: Row) => String(v.vendorCode || ''));
  if (expected.some((v: string) => !v) || new Set(expected).size !== expected.length) error('原商品编码不完整或重复');
  if (readback.complete !== true) error('WB 回查不完整，暂不能重试');
  const active = (readback.active || []).filter((c: Row) => expected.includes(c.vendorCode));
  const trash = (readback.trash || []).filter((c: Row) => expected.includes(c.vendorCode));
  const failures: Row[] = (readback.errors || []).filter((c: Row) => expected.some(code =>
    (Array.isArray(c.vendorCodes) && c.vendorCodes.includes(code)) || c.vendorCode === code
      || Object.hasOwn(object(c.errors), code)));
  if (trash.length) error('回收站存在相同商品编码，请先处理归属冲突', { vendorCodes: trash.map((c: Row) => c.vendorCode) });
  const genericFailures = failures.filter(c => {
    const values = Array.isArray(c.errors) ? c.errors : typeof c.errors === 'string' ? [c.errors]
      : expected.flatMap(code => object(c.errors)[code] || []);
    return c.batchUUID && c.updatedAt && values.length > 0
      && values.every((value: unknown) => typeof value === 'string' && value.trim().toLowerCase() === 'internal server error');
  });
  if (genericFailures.length !== failures.length) error('WB 失败清单包含资料错误或无法确认的记录：' + JSON.stringify(failures).slice(0, 1500) + '；请核对字段，修正资料后通过新的发布操作提交', { failures });
  const failure = object(runtime.lastFailureCheckpoint);
  const audit = (Array.isArray(runtime.audit) ? runtime.audit : []).filter((v: Row) => v.event === 'HTTP_RESPONSE');
  const last = [...audit].reverse().find((v: Row) => Number(v.status) >= 400 || Number(v.status) === 0);
  const receipt = receipts.find(v => v.request_ref === (failure.requestRef || last?.requestRef));
  const stage = String(failure.stage || last?.stage || '');
  const evidence: Row = { complete: true, checkedAt: readback.checkedAt, requestRefs: readback.requestRefs,
    failedRequestRef: receipt?.request_ref, failedStage: stage,
    ignoredGenericFailureBatches: genericFailures.map(c => ({ batchUUID: c.batchUUID, updatedAt: c.updatedAt })) };

  if (active.length) {
    if (active.length !== expected.length || new Set(active.map((c: Row) => c.vendorCode)).size !== expected.length) error('仅部分商品卡存在，无法在原冻结合同下安全补建', { vendorCodes: active.map((c: Row) => c.vendorCode) });
    const recorded = new Map((Array.isArray(runtime.cards) ? runtime.cards : []).map((c: Row) => [c.vendorCode, c]));
    const barcodes = object(runtime.barcodes);
    for (const c of active) {
      const old: any = recorded.get(c.vendorCode);
      const variantIndex = expected.indexOf(c.vendorCode);
      const variant = product.variants[variantIndex];
      const originalCodes = (variant.sizes || []).map((s: Row, i: number) => String(s.barcode || barcodes[`${variantIndex}-${i}`] || ''));
      const frozen = (runtime.cardCreateIntent?.frozenPayload || []).flatMap((g: Row) => g.variants || []).find((v: Row) => v.vendorCode === c.vendorCode);
      const frozenCodes = frozen?.sizes?.flatMap((s: Row) => s.skus || []) || [];
      const codes = frozenCodes.length ? frozenCodes : originalCodes;
      const actualCodes = (c.sizes || []).flatMap((s: Row) => s.skus || []).map(String);
      const nm = Number(c.nmID ?? c.nmId);
      const subject = Number(c.subjectID ?? c.subjectId);
      const exactExisting = old && nm === Number(old.nmID ?? old.nmId) && nm > 0;
      const exactCreated = !old && codes.length && codes.every((v: string) => v && actualCodes.includes(v));
      if ((!exactExisting && !exactCreated) || subject !== Number(runtime.expectedSubjectId || product.category?.subjectId)) {
        error('WB 商品卡无法与原任务的条码、类目和商品身份对应', { vendorCode: c.vendorCode });
      }
    }
    // Keep checkpoint fields (media acceptance, image order, etc.) from the original runtime.
    evidence.cards = active.map((c: Row) => ({ ...c, ...object(recorded.get(c.vendorCode)),
      vendorCode: c.vendorCode, nmID: c.nmID ?? c.nmId, subjectID: c.subjectID ?? c.subjectId }));
    const resume = failure.state === 'FINALIZING' ? 'FINALIZING'
      : stage.startsWith('STOCK') ? 'STOCK_RECONCILING'
        : stage.startsWith('PRICE') ? 'PRICE_RECONCILING' : 'MEDIA_RECONCILING';
    if (resume === 'FINALIZING' && !(runtime.price?.verified && runtime.stock?.verified)) error('目录收尾缺少价格或库存完成证据');
    return { stage: resume, evidence };
  }

  const cardWrites = receipts.filter(v => ['CARD_UPLOAD', 'CARD_UPDATE', 'CARD_UPLOAD_ADD'].includes(v.operation));
  if (!cardWrites.length && !runtime.cardCreateIntent
    && ['VALIDATING', 'BARCODE_ALLOCATING', 'COMPLIANCE_RECONCILING', 'TNVED_LIST', 'BARCODES'].includes(String(failure.state || stage))) {
    return { stage: 'VALIDATING', evidence: { ...evidence, noCardWrite: true } };
  }
  if (stage !== 'CARD_WRITE') error('尚无商品卡，且没有可证明安全的建卡失败检查点');
  if (!receipt || receipt.operation !== 'CARD_UPLOAD') error('原建卡请求缺少完整网关回执');
  const intent = object(runtime.cardCreateIntent);
  if (intent.taskId !== r.task_id || intent.publicationId !== p.id || intent.revision !== r.revision
    || intent.idempotencyKey !== r.idempotency_key || !Array.isArray(intent.frozenPayload) || !intent.frozenPayloadHash
    || !intent.logicalIntentId || intent.logicalIntentId !== receipt.logical_intent_id) error('原建卡载荷或幂等身份不完整');
  if (!receipt.completed_at || receipt.delivery_state === 'UNKNOWN' || receipt.retry_class === 'READBACK_REQUIRED') {
    return { stage: 'CARD_SUBMITTING', evidence: { ...evidence, readbackOnly: true } };
  }
  const body = object(receipt.response_json);
  const additional = body.additionalErrors;
  if (additional && (typeof additional === 'string' ? additional.trim() : Object.keys(additional).length)) {
    error('WB 返回具体字段错误：' + JSON.stringify(additional).slice(0, 1500) + '；请修正资料后通过新的发布操作提交', { additionalErrors: additional });
  }
  const generic400 = Number(receipt.status_code) === 400
    && String(body.errorText || body.message || body.detail || '').trim().toLowerCase() === 'internal server error';
  const safeNotSent = receipt.delivery_state === 'NOT_SENT';
  const transientResponse = [408, 425, 429].includes(Number(receipt.status_code)) || Number(receipt.status_code) >= 500;
  if (!generic400 && !safeNotSent && !transientResponse) error('WB 资料错误：' + String(body.errorText || body.message || JSON.stringify(body)).slice(0, 1500) + '；请修正资料后通过新的发布操作提交', { response: body });
  // UNKNOWN is handled above; a responded generic 400 receives one explicit manual grant.
  const highest = Math.max(0, ...receipts.filter(v => v.operation === 'CARD_UPLOAD').map(v => Number(v.attempt_no || 0)));
  if (!highest || (highest !== Number(intent.attemptNo)
    && !(unconsumedAttempt === highest + 1 && Number(intent.attemptNo) === unconsumedAttempt))) error('原建卡尝试编号与网关记录不一致');
  return { stage: 'CARD_CREATE_READY', evidence: { ...evidence, cardAbsent: true }, cardAttempt: highest + 1 };
}

export class WbAutoPublishRetryService {
  constructor(readonly repository: WbAutoRetryRepository, private readonly gateway: Gateway,
    private readonly validatePreparation: (storeId: string, sku: string) => Promise<void>,
    private readonly waitForRead: (milliseconds: number) => Promise<void> = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))) {}

  async detail(storeId: string, sku: string): Promise<WbPublishRetryDetail> {
    const snapshot = await this.repository.snapshot(storeId, sku);
    const latest = await this.repository.latest(storeId, sku, snapshot.auto.run_id);
    const active = latest && ACTIVE_RETRY.includes(latest.status);
    const enabled = await this.repository.enabled();
    const runningLease = new Date(snapshot.auto.lease_until || 0).getTime() > Date.now()
      || (snapshot.runtime?.lease_owner && new Date(snapshot.runtime.lease_expires_at || 0).getTime() > Date.now());
    const reason = active ? '已有重试正在执行' : snapshot.auto.state === 'SUCCEEDED' ? '任务已完成，无需重试'
      : snapshot.auto.state === 'CANCELLED' ? '任务已取消，不能重试'
        : runningLease || !retryableAuto.has(snapshot.auto.state) ? '原任务正在执行，请等待最新进度'
          : !enabled ? '重试上品配套工作流尚未核验启用' : '';
    return { canRetry: !reason, reason, expectedStateToken: retryStateToken(snapshot), ...(latest ? { latest: retryRecord(latest) } : {}) };
  }

  async request(sku: string, input: WbPublishRetryRequest) {
    const result = await this.repository.request(sku, input);
    return { outcome: result.existing ? 'EXISTING' as const : 'ACCEPTED' as const, retry: retryRecord(result.row) };
  }

  async blocksNormalWorker(storeId: string, sku: string, runId: string): Promise<boolean> {
    const retry = await this.repository.latest(storeId, sku, runId);
    return Boolean(retry && ACTIVE_RETRY.includes(retry.status) && retry.stage !== 'CHECKING_PREPARATION');
  }

  async runPending(): Promise<void> {
    // Bounded work: other normal jobs retain their scheduler turns.
    for (let i = 0; i < 2; i++) {
      const claim = await this.repository.claim();
      if (!claim) return;
      try { await this.advance(claim); }
      catch (cause) {
        if (cause instanceof AppError && ['TASK_LOCKED', 'VERSION_CONFLICT'].includes(cause.code)) {
          await this.repository.defer(claim, '任务状态变化，正在重新核对');
        } else if (cause instanceof AppError && cause.code === 'WB_RETRY_READBACK_PENDING') {
          await this.repository.defer(claim, cause.message, 30);
        } else {
          await this.repository.settle(claim, 'BLOCKED', cause instanceof Error ? cause.message : '暂不能安全重试', cause instanceof AppError ? cause.code : 'WB_RETRY_CHECK_FAILED');
        }
      }
    }
  }

  private async advance(claim: WbRetryClaim): Promise<void> {
    const snapshot = await this.repository.snapshot(claim.store_id, claim.sku);
    if (snapshot.auto.run_id !== claim.run_id || snapshot.auto.id !== claim.job_id) error('自动任务轮次已变化');
    if (snapshot.auto.state === 'CANCELLED') return this.repository.settle(claim, 'BLOCKED', '原自动任务已取消', 'TASK_CANCELLED');
    const identity = object(claim.snapshot);
    if (identity.taskId && (snapshot.runtime?.task_id !== identity.taskId
      || snapshot.runtime?.payload_signature !== identity.payloadSignature
      || snapshot.publication?.generated_version_id !== identity.generatedVersionId)) error('原任务冻结版本已变化');
    if (claim.status === 'RUNNING') {
      const runtime = snapshot.runtime;
      if (claim.authorized_attempt && !claim.consumed_at
        && (runtime?.last_error_code === 'WB_CARD_RETRY_PROOF_EXPIRED'
          || (['CARD_CREATE_READY', 'CARD_SUBMITTING'].includes(runtime?.state) && Date.now() - Date.parse(claim.evidence.checkedAt) > 8 * 60_000))) {
        return this.repository.refreshUnconsumed(claim);
      }
      const state = claim.stage === 'CHECKING_PREPARATION' ? snapshot.auto.state : snapshot.runtime?.state;
      if (state === 'SUCCEEDED') return this.repository.settle(claim, 'SUCCEEDED', '已确认上品完成');
      if (state && (stopped.has(state) || ['BLOCKED', 'WAITING_MEDIA', 'CANCELLED'].includes(state))) {
        const source = claim.stage === 'CHECKING_PREPARATION' ? snapshot.auto : snapshot.runtime!;
        return this.repository.settle(claim, state === 'FAILED' ? 'FAILED' : 'BLOCKED',
          source.last_error_message || '任务暂不能继续，请检查资料或配置', source.last_error_code || 'WB_RETRY_STOPPED');
      }
      return this.repository.defer(claim, WB_RETRY_STAGE_LABELS[snapshot.runtime?.state] || WB_RETRY_STAGE_LABELS[claim.stage] || '原任务正在继续执行');
    }
    if (!await this.repository.enabled()) return this.repository.defer(claim, '重试能力暂未启用，保留当前检查进度', 30);
    await this.validatePreparation(claim.store_id, claim.sku);
    if (!snapshot.auto.n8n_task_id) return this.repository.preparation(claim);
    if (!snapshot.runtime) error('原上品任务记录不存在');
    if (snapshot.runtime.state === 'SUCCEEDED') return this.repository.settle(claim, 'SUCCEEDED', '已确认上品完成');
    if (!stopped.has(snapshot.runtime.state)) return this.repository.defer(claim, '原任务仍在执行，已同步最新进度');
    if (snapshot.runtime.lease_owner && new Date(snapshot.runtime.lease_expires_at).getTime() > Date.now()) return this.repository.defer(claim, '原任务仍持有执行租约');
    const receipts = await this.repository.receipts(snapshot.runtime.task_id);
    const vendorCodes = object(snapshot.runtime.result_json).product?.variants?.map((v: Row) => String(v.vendorCode || '')) || [];
    const readback = await this.readback(claim, vendorCodes);
    const plan = buildWbRetryPlan(snapshot, receipts, readback, claim.consumed_at ? undefined : claim.authorized_attempt);
    await this.repository.resume(claim, snapshot, plan.stage, plan.evidence, plan.cardAttempt);
  }

  private async readback(claim: WbRetryClaim, vendorCodes: string[]): Promise<Row> {
    if (!vendorCodes.length || vendorCodes.some(code => !code) || vendorCodes.length > 30) error('原任务商品编码不完整');
    const result: Row = { complete: false, active: [], trash: [], errors: [], requestRefs: [] };
    const checks = [...new Set(vendorCodes)].flatMap(vendorCode => [
      { operation: 'CARDS_LIST_ACTIVE', field: 'active', vendorCode },
      { operation: 'CARDS_LIST_TRASH', field: 'trash', vendorCode }
    ]).concat([{ operation: 'CARDS_ERROR_LIST', field: 'errors', vendorCode: '' }]);
    for (const [lookupIndex, { operation, field, vendorCode }] of checks.entries()) {
      let cursor: Row = { limit: 100 };
      const seen = new Set<string>();
      let complete = false;
      for (let page = 0; page < 100; page++) {
        await this.repository.heartbeat(claim);
        // Reads share WB's Content quota. Space sequential requests instead of
        // restarting a multi-variant proof every time the burst quota is spent.
        if (page > 0 || lookupIndex > 0) await this.waitForRead(field === 'errors' && page > 0 ? 6_000 : 600);
        const payload = field === 'errors' ? { body: { cursor, order: { ascending: false } } }
          : { body: { settings: { sort: { ascending: false }, filter: { textSearch: vendorCode, ...(field === 'active' ? { withPhoto: -1 } : {}) }, cursor } } };
        const requestRef = `retry-read:${claim.id}:${claim.lease_token}:${operation}:${lookupIndex}:${page}`;
        const response = await this.gateway.execute({ taskId: claim.task_id, storeId: claim.store_id, requestRef, operation, payload });
        if ([401, 403].includes(response.statusCode)) {
          throw new AppError('WB_RETRY_CREDENTIAL_UNAVAILABLE', '原任务的店铺凭据或 WB 权限不可用，请处理后再重试', { status: response.statusCode }, 409);
        }
        if (response.statusCode >= 400 && response.statusCode < 500 && ![408, 425, 429].includes(response.statusCode)) {
          throw new AppError('WB_RETRY_READBACK_REJECTED', 'WB 拒绝本次回查：' + String(object(response.body).errorText || object(response.body).message || response.statusCode).slice(0, 1500), undefined, 409);
        }
        if (!response.ok || response.statusCode !== 200) throw new AppError('WB_RETRY_READBACK_PENDING', 'WB 回查暂不可用，将继续核对原任务，不提交新写入', undefined, 503);
        const body = object(response.body);
        const entries = field === 'errors' ? body.data?.items : body.cards;
        if (!Array.isArray(entries)) error('WB 回查响应格式不完整，无法确认商品归属');
        result[field].push(...entries);
        result.requestRefs.push(requestRef);
        const next = object(field === 'errors' ? body.data?.cursor : body.cursor);
        if (field === 'errors' ? next.next === false
          : Number.isInteger(next.total) && next.total >= 0 && next.total < 100) { complete = true; break; }
        if (!Object.keys(next).length || seen.has(JSON.stringify(next))) error('WB 分页回查未完成，暂不能重试');
        seen.add(JSON.stringify(next));
        cursor = { ...next, limit: 100 };
        delete cursor.next;
        delete cursor.total;
      }
      if (!complete) error('WB 回查超过分页上限，暂不能重试');
    }
    for (const field of ['active', 'trash']) result[field] = [...new Map(result[field].map((card: Row) =>
      [String(card.vendorCode) + '|' + String(card.nmID ?? card.nmId), card])).values()];
    return { ...result, complete: true, checkedAt: new Date().toISOString() };
  }
}
