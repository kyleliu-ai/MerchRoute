import { AppError, normalizeWbComparablePath, type WbMediaPolicy, type WbSubmissionMode } from '@n8n-media-review/shared';

type JsonRecord = Record<string, unknown>;
export type WbLocale = 'ru' | 'zh';
const CONTENT_READ_ACTIONS = new Set(['GET_PARENT_CATEGORIES', 'SEARCH_SUBJECTS', 'GET_SCHEMA', 'GET_DIRECTORY', 'CHECK_VENDOR_CODES']);
const REMOTE_INTAKE_ERROR_CODES = new Set([
  'STORE_READY_MARKER_MISSING', 'STORE_READY_MARKER_INVALID', 'STORE_READY_MARKER_MISMATCH',
  'SOURCE_CONTENT_MISMATCH', 'READY_SCOPE_CONFLICT', 'READY_WRITE_FAILED'
]);

export type WbVendorCodeMatch = {
  vendorCode: string;
  location: 'ACTIVE' | 'TRASH';
  nmId?: number;
  imtId?: number;
  subjectId?: number;
};
export type WbExistingCardBaseline = { vendorCode: string; nmID: string };
export type WbPartialCreateRecoveryResult = { taskId: string; state?: string; resumedState?: string; raw: JsonRecord };

export type WbRuntimeSyncResult = {
  status: 'synced' | 'pending' | 'disabled';
  remoteRootDirectory?: string;
  rootSyncHash?: string;
  message?: string;
  syncedAt?: string;
};

export class N8nWbClient {
  private readonly baseUrl = process.env.WB_AUTOMATION_BASE_URL?.trim().replace(/\/+$/, '');
  private readonly automationKey = process.env.WB_AUTOMATION_KEY?.trim();
  private readonly bridgeUrl = process.env.WB_P003_WEBHOOK_URL?.trim() || (this.baseUrl ? `${this.baseUrl}/webhook/wb/v1/admin` : undefined);
  private readonly jobsUrl = process.env.WB_P001_WEBHOOK_URL?.trim() || (this.baseUrl ? `${this.baseUrl}/webhook/wb/v1/jobs` : undefined);
  private readonly preflightUrl = process.env.WB_C001_WEBHOOK_URL?.trim() || (this.baseUrl ? `${this.baseUrl}/webhook/wb/v1/stores/preflight` : undefined);
  private readonly contentReadIntervalMs: number;
  private readonly contentReadRetryDelaysMs: number[];
  private readonly contentReadRetryWait: (delayMs: number) => Promise<void>;
  private readonly taskReadbackRetryDelaysMs: number[];
  private readonly taskReadbackRetryWait: (delayMs: number) => Promise<void>;
  private contentReadTail: Promise<void> = Promise.resolve();
  private lastContentReadAt = 0;

  constructor(options: {
    contentReadIntervalMs?: number;
    contentReadRetryDelaysMs?: number[];
    contentReadRetryWait?: (delayMs: number) => Promise<void>;
    taskReadbackRetryDelaysMs?: number[];
    taskReadbackRetryWait?: (delayMs: number) => Promise<void>;
  } = {}) {
    this.contentReadIntervalMs = Math.max(0, options.contentReadIntervalMs ?? 650);
    this.contentReadRetryDelaysMs = (options.contentReadRetryDelaysMs ?? [1_000, 3_000, 8_000])
      .map((value) => Math.max(0, Math.trunc(Number(value) || 0)));
    this.contentReadRetryWait = options.contentReadRetryWait || ((delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs)));
    this.taskReadbackRetryDelaysMs = (options.taskReadbackRetryDelaysMs ?? [0, 1_000, 3_000])
      .map((value) => Math.max(0, Math.trunc(Number(value) || 0)));
    this.taskReadbackRetryWait = options.taskReadbackRetryWait || ((delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs)));
  }

  get configured(): boolean { return Boolean(this.bridgeUrl && this.jobsUrl && this.automationKey); }
  get catalogConfigured(): boolean { return Boolean(this.bridgeUrl && this.automationKey); }

  async syncRuntimeRoot(rootDirectory: string): Promise<WbRuntimeSyncResult> {
    if (!this.bridgeUrl || !this.automationKey) return { status: 'disabled', message: '未配置 WB_AUTOMATION_BASE_URL/WB_P003_WEBHOOK_URL 或 WB_AUTOMATION_KEY' };
    let writeResponseUnknown = false;
    try {
      await this.bridge('UPSERT_RUNTIME_CONFIG', { importRoot: rootDirectory });
    } catch (error) {
      if (!isDeliveryUnknown(error)) {
        return { status: 'pending', message: error instanceof Error ? error.message : 'n8n 运行配置同步失败' };
      }
      writeResponseUnknown = true;
    }
    const readback = await this.readRuntimeRoot();
    if (readback.status !== 'synced') {
      return {
        ...readback,
        status: 'pending',
        message: writeResponseUnknown
          ? `n8n 运行配置写入响应未知，自动回读尚未确认${readback.message ? `：${readback.message}` : ''}`
          : readback.message
      };
    }
    const remoteRootDirectory = readback.remoteRootDirectory;
    if (!remoteRootDirectory || normalizeWbComparablePath(remoteRootDirectory) !== normalizeWbComparablePath(rootDirectory)) {
      return { ...readback, status: 'pending', message: 'n8n 回读的 import_root 与 MerchRoute 配置不一致' };
    }
    return {
      ...readback,
      status: 'synced',
      ...(writeResponseUnknown ? { message: 'n8n 写入响应未知，已通过运行配置回读确认同步成功' } : {})
    };
  }

  async readRuntimeRoot(): Promise<WbRuntimeSyncResult> {
    if (!this.bridgeUrl || !this.automationKey) return { status: 'disabled', message: '未配置 n8n WB 桥接访问参数' };
    try {
      const data = await this.bridge('GET_RUNTIME_CONFIG', {});
      return { status: 'synced', remoteRootDirectory: findImportRoot(data), rootSyncHash: findRootSyncHash(data), syncedAt: new Date().toISOString() };
    } catch (error) {
      return { status: 'pending', message: error instanceof Error ? error.message : 'n8n 运行配置回读失败' };
    }
  }

  async syncCategory(input: JsonRecord): Promise<JsonRecord> {
    await this.bridge('UPSERT_CATEGORY_PROJECTION', input);
    return asRecord(unwrapBridgeData(await this.bridge('GET_CATEGORY_PROJECTION', { categoryKey: input.categoryKey })));
  }

  async deleteCategory(categoryKey: string): Promise<JsonRecord> {
    return asRecord(unwrapBridgeData(await this.bridge('DELETE_CATEGORY_PROJECTION', { categoryKey })));
  }

  async getParentCategories(locale: WbLocale = 'ru'): Promise<unknown> {
    return unwrapBridgeData(await this.bridge('GET_PARENT_CATEGORIES', { locale }));
  }

  async searchSubjects(input: string | { name?: string; parentID?: number; limit?: number; offset?: number; locale?: WbLocale }): Promise<unknown> {
    const payload = typeof input === 'string' ? { name: input, locale: 'ru' } : {
      ...(input.name ? { name: input.name } : {}),
      ...(input.parentID ? { parentID: input.parentID } : {}),
      ...(input.limit ? { limit: input.limit } : {}),
      ...(input.offset !== undefined ? { offset: input.offset } : {}),
      locale: input.locale || 'ru'
    };
    return unwrapBridgeData(await this.bridge('SEARCH_SUBJECTS', payload));
  }

  async getSubjectSchema(subjectId: number, locale: WbLocale = 'ru'): Promise<unknown> {
    return unwrapBridgeData(await this.bridge('GET_SCHEMA', { subjectId, locale }));
  }

  async getDirectory(directory: string, input: { subjectId?: number; search?: string; locale?: WbLocale } = {}): Promise<unknown> {
    return unwrapBridgeData(await this.bridge('GET_DIRECTORY', { directory, locale: input.locale || 'ru', ...(input.subjectId ? { subjectId: input.subjectId } : {}), ...(input.search ? { search: input.search } : {}) }));
  }

  async checkVendorCodes(vendorCodes: string[], store?: {
    storeId: string;
    storeAlias: string;
    requestRef: string;
  }): Promise<{ matches: WbVendorCodeMatch[]; raw: JsonRecord }> {
    const unique = [...new Set(vendorCodes.map((value) => String(value || '').trim()).filter(Boolean))];
    if (!unique.length || unique.length > 100) throw new AppError('CONFIG_INVALID', 'CHECK_VENDOR_CODES 需要 1 到 100 个卖家商品编码');
    const raw = await this.checkVendorCodesWithRetry(unique, store);
    const data = asRecord(unwrapBridgeData(raw));
    const combined = Array.isArray(data.matches) ? data.matches : Array.isArray(raw.matches) ? raw.matches : undefined;
    const active = Array.isArray(data.activeMatches) ? data.activeMatches : Array.isArray(raw.activeMatches) ? raw.activeMatches : undefined;
    const trash = Array.isArray(data.trashMatches) ? data.trashMatches : Array.isArray(raw.trashMatches) ? raw.trashMatches : undefined;
    if (!combined && !active && !trash) {
      throw new AppError('VERIFY_FAILED', 'CHECK_VENDOR_CODES 未返回可验证的 matches/activeMatches/trashMatches 数组，已禁止自动上品', {
        deliveryUnknown: false, response: raw
      }, 502);
    }
    const candidates: Array<{ value: unknown; forcedLocation?: 'ACTIVE' | 'TRASH' }> = [
      ...(combined || []).map((value) => ({ value })),
      ...(active || []).map((value) => ({ value, forcedLocation: 'ACTIVE' as const })),
      ...(trash || []).map((value) => ({ value, forcedLocation: 'TRASH' as const }))
    ];
    const requested = new Set(unique);
    const matches = candidates.flatMap((candidate): WbVendorCodeMatch[] => {
      const item = asRecord(candidate.value);
      const vendorCode = typeof candidate.value === 'string' ? stringValue(candidate.value) : stringValue(item.vendorCode ?? item.vendor_code);
      if (!vendorCode || !requested.has(vendorCode)) return [];
      const locationRaw = String(item.location || item.source || item.cardLocation || '').toUpperCase();
      const location: 'ACTIVE' | 'TRASH' = candidate.forcedLocation || (locationRaw === 'TRASH' ? 'TRASH' : 'ACTIVE');
      const nmId = Number(item.nmID ?? item.nmId);
      const imtId = Number(item.imtID ?? item.imtId);
      const subjectId = Number(item.subjectID ?? item.subjectId);
      return [{
        vendorCode,
        location,
        ...(Number.isInteger(nmId) && nmId > 0 ? { nmId } : {}),
        ...(Number.isInteger(imtId) && imtId > 0 ? { imtId } : {}),
        ...(Number.isInteger(subjectId) && subjectId > 0 ? { subjectId } : {})
      }];
    });
    return { matches, raw };
  }

  private async checkVendorCodesWithRetry(vendorCodes: string[], store?: {
    storeId: string;
    storeAlias: string;
    requestRef: string;
  }): Promise<JsonRecord> {
    let requestAttempts = 0;
    while (true) {
      requestAttempts += 1;
      try {
        return await this.bridge('CHECK_VENDOR_CODES', { vendorCodes }, store);
      } catch (error) {
        const retryIndex = requestAttempts - 1;
        if (!isRetryableVendorCodeRead(error) || retryIndex >= this.contentReadRetryDelaysMs.length) {
          if (!(error instanceof AppError)) throw error;
          throw new AppError(error.code, error.message, {
            ...error.details,
            vendorCodes,
            requestAttempts,
            retryCount: requestAttempts - 1
          }, error.statusCode);
        }
        const configuredDelay = this.contentReadRetryDelaysMs[retryIndex] ?? 0;
        const retryAfterMs = Number(error.details?.retryAfterMs);
        const delayMs = Math.max(configuredDelay, Number.isFinite(retryAfterMs) && retryAfterMs >= 0 ? retryAfterMs : 0);
        if (delayMs > 0) await this.contentReadRetryWait(delayMs);
      }
    }
  }

  async submitListing(input: {
    folderName: string; revision: number; submissionMode?: WbSubmissionMode; mediaPolicy?: WbMediaPolicy;
    mediaTargetVendorCodes?: string[]; automationRunId?: string; existingCardBaseline?: WbExistingCardBaseline[];
    storeId?: string; storeAlias?: string; publicationId?: string; generatedVersionId?: string; credentialVersionId?: string;
    storeConfigVersion?: number; warehouseId?: string; idempotencyKey?: string;
    packageRelPath?: string; packageSignature?: string; materializationHash?: string;
  }): Promise<{ taskId: string; raw: JsonRecord }> {
    if (!this.jobsUrl || !this.automationKey) throw new AppError('CONFIG_INVALID', '未配置 WB_P001_WEBHOOK_URL/WB_AUTOMATION_BASE_URL 或 WB_AUTOMATION_KEY', undefined, 503);
    const expectedTaskId = input.storeAlias
      ? `${input.storeAlias}__${input.folderName}__r${input.revision}`
      : `${input.folderName}__r${input.revision}`;
    let raw: JsonRecord;
    try {
      raw = await this.request(this.jobsUrl, {
      folderName: input.folderName, revision: input.revision, priority: 100,
      submissionMode: input.submissionMode || 'UPSERT', mediaPolicy: input.mediaPolicy || 'MISSING_ONLY',
      mediaTargetVendorCodes: input.mediaTargetVendorCodes || [],
      ...(input.existingCardBaseline?.length ? { existingCardBaseline: input.existingCardBaseline } : {}),
      ...(input.automationRunId ? { automationRunId: input.automationRunId } : {}),
      ...(input.storeId ? { storeId: input.storeId } : {}),
      ...(input.storeAlias ? { storeAlias: input.storeAlias } : {}),
      ...(input.publicationId ? { publicationId: input.publicationId } : {}),
      ...(input.generatedVersionId ? { generatedVersionId: input.generatedVersionId } : {}),
      ...(input.credentialVersionId ? { credentialVersionId: input.credentialVersionId } : {}),
      ...(input.storeConfigVersion ? { storeConfigVersion: input.storeConfigVersion } : {}),
      ...(input.warehouseId ? { warehouseId: input.warehouseId } : {}),
      ...(input.packageRelPath ? { packageRelPath: input.packageRelPath } : {}),
      ...(input.packageSignature ? { packageSignature: input.packageSignature } : {}),
      ...(input.materializationHash ? { materializationHash: input.materializationHash } : {}),
      idempotencyKey: input.idempotencyKey || (input.storeAlias
        ? `${input.storeAlias}|${input.folderName}|${input.revision}${input.automationRunId ? `|${input.automationRunId}` : ''}`
        : input.automationRunId ? `${input.folderName}|${input.revision}|${input.automationRunId}` : `${input.folderName}|${input.revision}`)
      }, 180_000);
    } catch (error) {
      if (!isDeliveryUnknown(error)) throw error;
      return this.readBackSubmittedJob(expectedTaskId, input.folderName, input.revision, input.storeAlias, undefined, error);
    }
    const taskId = stringValue(raw.taskId) || stringValue(raw.id) || stringValue(asRecord(raw.data).taskId);
    if (!taskId) return this.readBackSubmittedJob(expectedTaskId, input.folderName, input.revision, input.storeAlias, raw);
    if (taskId !== expectedTaskId) {
      throw new AppError('VERIFY_FAILED', 'WB-P001 返回的 taskId 与预期幂等任务不一致，已拒绝继续', {
        deliveryUnknown: false,
        expectedTaskId,
        returnedTaskId: taskId,
        response: raw
      }, 502);
    }
    return { taskId, raw };
  }

  private async readBackSubmittedJob(
    expectedTaskId: string,
    folderName: string,
    revision: number,
    storeAlias?: string,
    submitResponse?: JsonRecord,
    submitError?: unknown
  ): Promise<{ taskId: string; raw: JsonRecord }> {
    let lastReadbackError: unknown;
    const delays = this.taskReadbackRetryDelaysMs.length ? this.taskReadbackRetryDelaysMs : [0];
    for (const delayMs of delays) {
      if (delayMs > 0) await this.taskReadbackRetryWait(delayMs);
      try {
        const job = await this.getJob(expectedTaskId);
        const taskId = stringValue(job.taskId) || stringValue(job.task_id);
        const productCode = stringValue(job.productCode) || stringValue(job.product_code);
        const returnedStoreAlias = stringValue(job.storeAlias) || stringValue(job.store_alias);
        const returnedRevision = Number(job.revision);
        if (taskId !== expectedTaskId || productCode !== folderName || returnedRevision !== revision
          || (storeAlias && returnedStoreAlias !== storeAlias)) {
          throw new AppError('VERIFY_FAILED', 'WB 任务回读身份与提交请求不一致，已拒绝继续', {
            deliveryUnknown: false,
            expectedTaskId,
            expectedProductCode: folderName,
            expectedRevision: revision,
            returnedTaskId: taskId,
            returnedProductCode: productCode,
            expectedStoreAlias: storeAlias,
            returnedStoreAlias,
            returnedRevision,
            response: job
          }, 502);
        }
        return {
          taskId: expectedTaskId,
          raw: {
            ...(submitResponse || {}),
            ok: true,
            taskId: expectedTaskId,
            recoveredByStatusReadback: true,
            statusReadback: job
          }
        };
      } catch (error) {
        if (error instanceof AppError && error.code === 'VERIFY_FAILED' && error.details?.deliveryUnknown === false) throw error;
        if (!(error instanceof AppError) || !['JOB_NOT_FOUND', 'VERIFY_FAILED', 'WEBHOOK_ROUTE_NOT_FOUND'].includes(error.code)) throw error;
        lastReadbackError = error;
      }
    }
    throw new AppError('WB_TASK_NOT_REGISTERED', 'WB-P001 未持久化预期幂等任务，已拒绝将提交标记为成功', {
      httpStatus: 502,
      deliveryUnknown: isDeliveryUnknown(submitError),
      expectedTaskId,
      productCode: folderName,
      revision,
      response: submitResponse,
      lastReadbackError: lastReadbackError instanceof Error ? lastReadbackError.message : undefined
    }, 502);
  }

  async preflightStore(input: {
    storeId: string;
    storeAlias: string;
    storeConfigVersion: number;
    credentialVersionId: string;
    accountCurrency: string;
    requestRef: string;
  }): Promise<{ accepted: boolean; raw?: JsonRecord; message?: string }> {
    if (!this.preflightUrl || !this.automationKey) {
      return { accepted: false, message: '未配置 WB_C001_WEBHOOK_URL/WB_AUTOMATION_BASE_URL 或 WB_AUTOMATION_KEY' };
    }
    const raw = await this.request(this.preflightUrl, input as unknown as JsonRecord, 30_000);
    return { accepted: raw.accepted !== false, raw };
  }

  async recoverPartialCreate(taskId: string): Promise<WbPartialCreateRecoveryResult> {
    if (!this.jobsUrl || !this.automationKey) throw new AppError('CONFIG_INVALID', '未配置 WB_P001_WEBHOOK_URL/WB_AUTOMATION_BASE_URL 或 WB_AUTOMATION_KEY', undefined, 503);
    const expectedTaskId = stringValue(taskId);
    if (!expectedTaskId) throw new AppError('CONFIG_INVALID', 'RECOVER_PARTIAL_CREATE 需要 taskId');
    const raw = await this.request(this.jobsUrl, { action: 'RECOVER_PARTIAL_CREATE', taskId: expectedTaskId });
    const data = asRecord(unwrapBridgeData(raw));
    const returnedTaskId = stringValue(raw.taskId) || stringValue(data.taskId);
    if (returnedTaskId !== expectedTaskId) {
      throw new AppError('VERIFY_FAILED', 'WB-P001 partial-create 恢复未返回匹配 taskId', { taskId: expectedTaskId, response: raw }, 502);
    }
    return {
      taskId: returnedTaskId,
      state: stringValue(raw.state) || stringValue(data.state),
      resumedState: stringValue(raw.resumedState) || stringValue(data.resumedState),
      raw
    };
  }

  async getJob(taskId: string): Promise<JsonRecord> {
    if (!this.jobsUrl || !this.automationKey) throw new AppError('CONFIG_INVALID', '未配置 WB 任务查询地址或密钥', undefined, 503);
    const url = `${this.jobsUrl}/status?taskId=${encodeURIComponent(taskId)}`;
    let response: Response;
    try {
      response = await fetch(url, { headers: { 'X-WB-Automation-Key': this.automationKey, accept: 'application/json' }, signal: AbortSignal.timeout(15_000) });
    } catch (error) {
      throw new AppError('VERIFY_FAILED', 'WB 任务回读网络状态未知', { deliveryUnknown: true, reason: error instanceof Error ? error.message : String(error) }, 502);
    }
    const body = await parseResponse(response);
    const record = asRecord(body);
    if (!response.ok) {
      const isTaskNotFound = response.status === 404
        && record.error === 'not_found'
        && stringValue(record.taskId) === taskId;
      if (isTaskNotFound) {
        throw new AppError('JOB_NOT_FOUND', 'n8n 尚未登记该 WB 幂等任务', {
          httpStatus: 404, taskId, deliveryUnknown: false, response: record
        }, 404);
      }
      if (response.status === 404) {
        throw new AppError('WEBHOOK_ROUTE_NOT_FOUND', 'WB 任务查询接口未部署或地址不正确', {
          httpStatus: 404, taskId, deliveryUnknown: true, response: record
        }, 502);
      }
      throw new AppError('VERIFY_FAILED', `WB 任务回读失败（HTTP ${response.status}）`, {
        httpStatus: response.status, taskId, deliveryUnknown: true, response: record
      }, 502);
    }
    return record;
  }

  private async bridge(operation: string, payload: JsonRecord, store?: {
    storeId: string;
    storeAlias: string;
    requestRef: string;
  }): Promise<JsonRecord> {
    if (!this.bridgeUrl || !this.automationKey) throw new AppError('CONFIG_INVALID', '未配置 n8n WB 桥接地址或密钥', undefined, 503);
    const request = () => this.request(this.bridgeUrl!, store
      ? { action: operation, ...payload, payload, ...store }
      : { action: operation, payload });
    return CONTENT_READ_ACTIONS.has(operation) ? this.serializeContentRead(request) : request();
  }

  private async serializeContentRead<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.contentReadTail;
    let release!: () => void;
    this.contentReadTail = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      const remaining = this.contentReadIntervalMs - (Date.now() - this.lastContentReadAt);
      if (remaining > 0) await new Promise((resolve) => setTimeout(resolve, remaining));
      this.lastContentReadAt = Date.now();
      return await operation();
    } finally {
      release();
    }
  }

  private async request(url: string, payload: JsonRecord, timeoutMs = 30_000): Promise<JsonRecord> {
    assertHttpUrl(url);
    let response: Response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json', 'X-WB-Automation-Key': this.automationKey! },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(timeoutMs)
      });
    } catch (error) {
      const action = stringValue(payload.action);
      const idempotencyKey = stringValue(payload.idempotencyKey);
      throw new AppError('VERIFY_FAILED', idempotencyKey
        ? 'n8n WB 上品请求结果未知，请通过幂等任务号回读'
        : `n8n WB 桥接请求失败${action ? `（${action}）` : ''}：网络超时或连接中断`, {
        deliveryUnknown: true,
        reason: error instanceof Error ? error.message : String(error),
        ...(action ? { action } : {}),
        ...(idempotencyKey ? { idempotencyKey } : {})
      }, 502);
    }
    const body = await parseResponse(response);
    const record = asRecord(body);
    if (!response.ok) {
      const remoteCode = (stringValue(record.code) || '').toUpperCase();
      const code = REMOTE_INTAKE_ERROR_CODES.has(remoteCode) ? remoteCode : 'VERIFY_FAILED';
      throw new AppError(code, stringValue(record.message) || `n8n WB 桥接请求失败（HTTP ${response.status}）`, {
        action: payload.action,
        httpStatus: response.status,
        deliveryUnknown: record.deliveryUnknown === true || asRecord(record.details).deliveryUnknown === true,
        retryAfterMs: retryDelayFromRecord(record) ?? retryDelayFromHeaders(response.headers),
        response: record
      }, response.status >= 500 ? 502 : response.status);
    }
    if (record.ok === false || record.success === false || record.error) {
      throw new AppError('VERIFY_FAILED', stringValue(record.message) || 'n8n WB 桥接返回失败', {
        action: payload.action,
        httpStatus: positiveStatus(record.httpStatus) || positiveStatus(record.wbStatus) || 0,
        deliveryUnknown: record.deliveryUnknown === true || asRecord(record.details).deliveryUnknown === true,
        retryAfterMs: retryDelayFromRecord(record) ?? retryDelayFromHeaders(response.headers),
        response: record
      }, 502);
    }
    return record;
  }
}

function positiveStatus(value: unknown): number | undefined {
  const status = Number(value);
  return Number.isInteger(status) && status > 0 ? status : undefined;
}

function isDeliveryUnknown(error: unknown): boolean {
  return error instanceof AppError && error.details?.deliveryUnknown === true;
}

function isRetryableVendorCodeRead(error: unknown): error is AppError {
  if (!(error instanceof AppError)) return false;
  if (error.details?.deliveryUnknown === true) return true;
  const status = Number(error.details?.httpStatus);
  return status === 429 || (Number.isInteger(status) && status >= 500 && status <= 599);
}

function retryDelayFromRecord(record: JsonRecord): number | undefined {
  const nested = asRecord(record.details);
  for (const value of [record.retryAfterMs, nested.retryAfterMs]) {
    const milliseconds = Number(value);
    if (Number.isFinite(milliseconds) && milliseconds >= 0) return Math.ceil(milliseconds);
  }
  return undefined;
}

function assertHttpUrl(value: string): void {
  let url: URL;
  try { url = new URL(value); }
  catch { throw new AppError('CONFIG_INVALID', 'n8n WB 桥接地址格式无效'); }
  if (!['http:', 'https:'].includes(url.protocol)) throw new AppError('CONFIG_INVALID', 'n8n WB 桥接地址只支持 HTTP/HTTPS');
}

function retryDelayFromHeaders(headers: Headers): number | undefined {
  const retryAfter = headers.get('retry-after');
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds * 1_000);
    const date = Date.parse(retryAfter);
    if (Number.isFinite(date)) return Math.max(0, date - Date.now());
  }
  for (const name of ['x-ratelimit-retry', 'x-ratelimit-reset']) {
    const value = Number(headers.get(name));
    if (Number.isFinite(value) && value > 0) return value > 1_000_000_000 ? Math.max(0, value * 1_000 - Date.now()) : Math.ceil(value * 1_000);
  }
  return undefined;
}

async function parseResponse(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return {};
  try { return JSON.parse(text); }
  catch { return { rawText: text.slice(0, 2_000) }; }
}

function findImportRoot(input: JsonRecord): string | undefined {
  const candidates = [
    input.import_root, input.importRoot, asRecord(input.config).import_root, asRecord(input.config).importRoot,
    asRecord(input.data).import_root, asRecord(input.data).importRoot, asRecord(asRecord(input.data).config).import_root
  ];
  return candidates.find((value): value is string => typeof value === 'string' && Boolean(value.trim()))?.trim();
}

function findRootSyncHash(input: JsonRecord): string | undefined {
  const candidates = [input.rootSyncHash, asRecord(input.data).rootSyncHash, asRecord(input.config).rootSyncHash];
  return candidates.find((value): value is string => typeof value === 'string' && Boolean(value.trim()))?.trim();
}

function asRecord(value: unknown): JsonRecord { return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : {}; }
function stringValue(value: unknown): string | undefined { return typeof value === 'string' && value.trim() ? value.trim() : undefined; }
function unwrapBridgeData(value: JsonRecord): unknown { return Object.hasOwn(value, 'data') ? value.data : value; }
