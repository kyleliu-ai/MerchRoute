import { createHash } from 'node:crypto';
import {
  AppError,
  OZON_DEFAULT_STORE_ID,
  OZON_NO_BRAND_DICTIONARY_VALUE_ID,
  OZON_NO_BRAND_VALUE_RU,
  ozonGatewayLegacyReceiptSchema,
  ozonGatewayRequestSchema,
  type OzonGatewayResponse
} from '@n8n-media-review/shared';
import type { OzonGatewayIdentity, OzonStoreRepository } from '../../repositories/ozon-stores.js';
import type { OzonStoreService } from './index.js';

type JsonRecord = Record<string, unknown>;
type Operation = {
  endpoint: string;
  write: boolean;
  preflight: boolean;
  timeoutMs: number;
  body: JsonRecord;
};

export type OzonStoreOfferAbsenceInput = {
  storeId: string;
  expectedStoreConfigVersion: number;
  expectedCredentialVersionId: string;
  offerIds: string[];
};

export type OzonStoreOfferAbsenceProof = {
  absent: true;
  status: 'CONFIRMED_ABSENT';
  storeId: string;
  storeConfigVersion: number;
  credentialVersionId: string;
  offerIds: string[];
  checkedAt: string;
  operations: Array<{
    operation: 'infoList' | 'attributesInfo';
    endpoint: string;
    statusCode: 200 | 404;
    responseShape: 'ITEMS' | 'RESULT_ITEMS' | 'RESULT_ARRAY' | 'NOT_FOUND_ERROR';
    itemCount: 0;
    paginationComplete: true;
    errorCode?: '5';
  }>;
  evidenceHash: string;
};

export type OzonExactNoBrandDictionaryInput = {
  storeId: string;
  expectedStoreConfigVersion: number;
  expectedCredentialVersionId: string;
  categoryVersionId: string;
  presetRowVersion: number;
  descriptionCategoryId: number;
  typeId: number;
  attributeId: number;
  dictionaryId: number;
};

export type OzonExactNoBrandDictionaryProof = {
  storeId: string;
  categoryVersionId: string;
  presetRowVersion: number;
  attributeId: number;
  dictionaryId: number;
  dictionaryValueId: typeof OZON_NO_BRAND_DICTIONARY_VALUE_ID;
  value: typeof OZON_NO_BRAND_VALUE_RU;
  requestRef: string;
};

const OZON_API = 'https://api-seller.ozon.ru';
const OPERATIONS = Object.freeze({
  sellerInfo: { endpoint: '/v1/seller/info', write: false, preflight: true },
  limits: { endpoint: '/v4/product/info/limit', write: false, preflight: true },
  warehouses: { endpoint: '/v2/warehouse/list', write: false, preflight: true },
  categoryTree: { endpoint: '/v1/description-category/tree', write: false, preflight: false },
  categoryAttributes: { endpoint: '/v1/description-category/attribute', write: false, preflight: false },
  attributeValues: { endpoint: '/v1/description-category/attribute/values', write: false, preflight: false },
  attributeValuesSearch: { endpoint: '/v1/description-category/attribute/values/search', write: false, preflight: false },
  importProduct: { endpoint: '/v3/product/import', write: true, preflight: false },
  importInfo: { endpoint: '/v1/product/import/info', write: false, preflight: false },
  picturesImport: { endpoint: '/v1/product/pictures/import', write: true, preflight: false },
  picturesInfo: { endpoint: '/v2/product/pictures/info', write: false, preflight: false },
  listProducts: { endpoint: '/v3/product/list', write: false, preflight: false },
  infoList: { endpoint: '/v3/product/info/list', write: false, preflight: true },
  attributesInfo: { endpoint: '/v4/product/info/attributes', write: false, preflight: true },
  attributesUpdate: { endpoint: '/v1/product/attributes/update', write: true, preflight: false },
  pricesRead: { endpoint: '/v5/product/info/prices', write: false, preflight: true },
  stocksRead: { endpoint: '/v4/product/info/stocks', write: false, preflight: true },
  pricesWrite: { endpoint: '/v1/product/import/prices', write: true, preflight: false },
  stocksWrite: { endpoint: '/v2/products/stocks', write: true, preflight: false }
} satisfies Record<string, { endpoint: string; write: boolean; preflight: boolean }>);

const STORE_SCOPED_READ_OPERATIONS = new Set([
  'sellerInfo', 'limits', 'warehouses',
  'categoryTree', 'categoryAttributes', 'attributeValues', 'attributeValuesSearch',
  'infoList', 'attributesInfo', 'pricesRead', 'stocksRead'
]);

export class OzonStoreGatewayService {
  constructor(
    private readonly stores: OzonStoreRepository,
    private readonly storeService: OzonStoreService
  ) {}

  async execute(input: unknown): Promise<OzonGatewayResponse> {
    const parsed = ozonGatewayRequestSchema.safeParse(input);
    if (!parsed.success) throw new AppError('CONFIG_INVALID', 'OZON 网关请求格式无效', { issues: parsed.error.issues });
    assertNoForbiddenPayload(parsed.data.payload);
    const requestedDefinition = OPERATIONS[parsed.data.operation as keyof typeof OPERATIONS];
    if (!requestedDefinition) throw new AppError('CONFIG_INVALID', 'OZON 网关 operation 不在允许列表中', { operation: parsed.data.operation });
    const identity = await this.stores.getGatewayIdentity({
      taskId: parsed.data.taskId,
      storeId: parsed.data.storeId,
      publicationId: parsed.data.publicationId,
      leaseToken: requestedDefinition.write ? parsed.data.leaseToken : undefined,
      requireActiveLease: requestedDefinition.write
    });
    let payloadIdentity = identity;
    const persistedProductIds = new Set(identity.productIds);
    const requestedProductIds = collectProductIds(parsed.data.payload);
    if (parsed.data.operation === 'picturesInfo' && identity.taskId && identity.publicationId
      && requestedProductIds.some((productId) => !persistedProductIds.has(productId))) {
      const provisionalProductIds = await this.stores.getProvisionalImportProductIds({
        taskId: identity.taskId,
        publicationId: identity.publicationId,
        storeId: identity.storeId
      });
      payloadIdentity = {
        ...identity,
        productIds: [...new Set([...identity.productIds, ...provisionalProductIds])]
      };
    }
    const payloadHash = sha256(parsed.data.payload);
    const requestHash = sha256({
      taskId: identity.taskId || null,
      publicationId: identity.publicationId || null,
      leaseToken: requestedDefinition.write ? parsed.data.leaseToken || null : null,
      storeId: identity.storeId,
      credentialVersionId: identity.credentialVersionId,
      operation: parsed.data.operation,
      payload: parsed.data.payload
    });
    const ledger = await this.stores.beginGatewayRequest({
      requestRef: parsed.data.requestRef,
      requestHash,
      payloadHash,
      identity,
      operation: parsed.data.operation,
      ...(requestedDefinition.write ? { leaseToken: parsed.data.leaseToken } : {})
    });
    if (ledger.existing && !gatewayLedgerMayRetry(ledger.existing)) {
      return responseFromLedger(ledger.existing, parsed.data.operation, parsed.data.requestRef);
    }

    let operation: Operation;
    try {
      operation = buildOperation(parsed.data.operation, parsed.data.payload, payloadIdentity, Boolean(parsed.data.storeId));
      if (operation.write && (!identity.storeEnabled || !identity.leaseActive)) {
        throw new AppError('OZON_STORE_WRITE_BLOCKED', '店铺已停用或任务租约无效，拒绝开始 OZON 写入', {
          storeId: identity.storeId,
          taskId: identity.taskId,
          storeEnabled: identity.storeEnabled,
          leaseActive: identity.leaseActive
        }, 409);
      }
      if (operation.write && !identity.taskId) {
        throw new AppError('TASK_ID_REQUIRED', 'OZON 写操作必须绑定不可变 taskId', undefined, 409);
      }
    } catch (error) {
      return this.rejectBeforeSend(parsed.data.requestRef, parsed.data.operation, error);
    }

    if (identity.credentialBindingMode !== 'VAULT') {
      if (identity.credentialBindingMode === 'PURE_LEGACY' && operation.write) {
        return this.rejectBeforeSend(parsed.data.requestRef, parsed.data.operation, new AppError(
          'OZON_STORE_WRITE_BLOCKED',
          'PURE_LEGACY 历史任务只允许只读回查，不得授权平台写入',
          undefined,
          409
        ));
      }
      if (identity.storeId !== OZON_DEFAULT_STORE_ID || !identity.taskId || !identity.publicationId) {
        return this.rejectBeforeSend(parsed.data.requestRef, parsed.data.operation, new AppError(
          'OZON_LEGACY_CREDENTIAL_REQUIRED',
          '仅固定 default 店且具有完整 publication 快照的任务可授权 legacy 分支',
          undefined,
          409
        ));
      }
      const authorized = await this.stores.markLegacyDelegationIntent(
        parsed.data.requestRef,
        operation.write ? parsed.data.leaseToken : undefined
      );
      if (!authorized) {
        const current = await this.stores.getGatewayRequest(parsed.data.requestRef);
        if (operation.write && gatewayLedgerMayRetry(current)) {
          return this.rejectBeforeSend(parsed.data.requestRef, parsed.data.operation, new AppError(
            'TASK_LOCKED', 'OZON 写入授权前租约已失效或被新 worker 接管', undefined, 409
          ));
        }
        return responseFromLedger(current, parsed.data.operation, parsed.data.requestRef);
      }
      return {
        ok: false,
        operation: parsed.data.operation,
        requestRef: parsed.data.requestRef,
        deliveryState: 'NOT_SENT',
        retryClass: 'NONE',
        statusCode: 428,
        result: {
          __merchRouteLegacy: {
            version: 1,
            bindingMode: identity.credentialBindingMode,
            storeId: identity.storeId,
            operation: parsed.data.operation,
            requestRef: parsed.data.requestRef,
            taskId: identity.taskId,
            publicationId: identity.publicationId,
            payloadHash
          }
        },
        error: { code: 'OZON_LEGACY_CREDENTIAL_REQUIRED', message: '已授权 n8n 使用固定 default 旧 Credential 执行一次' }
      };
    }

    let credential: { clientId: string; apiKey: string };
    try {
      if (!identity.credential || !identity.credentialVersionId) {
        throw new AppError('OZON_CREDENTIAL_MISSING', 'OZON 网关冻结凭据不存在', undefined, 409);
      }
      credential = this.storeService.decryptGatewayCredential(
        identity.credential,
        identity.storeId,
        identity.credentialVersionId
      );
    } catch (error) {
      return this.rejectBeforeSend(parsed.data.requestRef, parsed.data.operation, error);
    }

    const claimed = await this.stores.markGatewaySending(
      parsed.data.requestRef,
      operation.write ? parsed.data.leaseToken : undefined
    );
    if (!claimed) {
      const current = await this.stores.getGatewayRequest(parsed.data.requestRef);
      if (operation.write && gatewayLedgerMayRetry(current)) {
        return this.rejectBeforeSend(parsed.data.requestRef, parsed.data.operation, new AppError(
          'TASK_LOCKED', 'OZON 平台发送前租约已失效或被新 worker 接管', undefined, 409
        ));
      }
      return responseFromLedger(current, parsed.data.operation, parsed.data.requestRef);
    }
    let response: Response;
    try {
      response = await fetch(`${OZON_API}${operation.endpoint}`, {
        method: 'POST',
        headers: {
          accept: 'application/json',
          'content-type': 'application/json',
          'Client-Id': credential.clientId,
          'Api-Key': credential.apiKey
        },
        body: JSON.stringify(operation.body),
        signal: AbortSignal.timeout(operation.timeoutMs)
      });
    } catch (error) {
      const classified = classifyTransport(error, operation.write);
      const safe = { code: 'OZON_GATEWAY_TRANSPORT', message: safeErrorMessage(error) };
      await this.stores.completeGatewayRequest({
        requestRef: parsed.data.requestRef,
        deliveryState: classified.deliveryState,
        retryClass: classified.retryClass,
        statusCode: 0,
        response: safe
      });
      return {
        ok: false,
        operation: parsed.data.operation,
        requestRef: parsed.data.requestRef,
        deliveryState: classified.deliveryState,
        retryClass: classified.retryClass,
        statusCode: 0,
        result: {},
        error: safe
      };
    }

    const result = redact(await safeResponseBody(response));
    const retryAfterMs = parseRetryAfter(response.headers);
    const classified = classifyResponse(response.status, operation.write);
    await this.stores.completeGatewayRequest({
      requestRef: parsed.data.requestRef,
      deliveryState: classified.deliveryState,
      retryClass: classified.retryClass,
      ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
      statusCode: response.status,
      response: result
    });
    return {
      ok: response.ok,
      operation: parsed.data.operation,
      requestRef: parsed.data.requestRef,
      deliveryState: classified.deliveryState,
      retryClass: classified.retryClass,
      ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
      statusCode: response.status,
      result,
      ...(!response.ok ? { error: { code: `OZON_HTTP_${response.status}`, message: platformMessage(result, response.status) } } : {})
    };
  }

  /**
   * Resolves MerchRoute's system-owned no-brand value against the exact active
   * store credential before any automatic task is admitted. The gateway input
   * is deliberately storeId-only: a task/publication identity and lease token
   * do not exist yet and are forbidden on this read branch.
   */
  async proveExactNoBrandDictionaryValue(
    input: OzonExactNoBrandDictionaryInput
  ): Promise<OzonExactNoBrandDictionaryProof> {
    const normalized = normalizeExactNoBrandDictionaryInput(input);
    const exactIdentity = {
      storeId: normalized.storeId,
      expectedStoreConfigVersion: normalized.expectedStoreConfigVersion,
      expectedCredentialVersionId: normalized.expectedCredentialVersionId
    };
    const identity = await this.stores.getExactStoreReadbackIdentity(exactIdentity);
    if (!identity.credential || identity.credentialVersionId !== normalized.expectedCredentialVersionId) {
      throw noBrandDictionaryInvalid('OZON 无品牌字典只读验证未取得精确冻结凭据', normalized);
    }
    let credential: { clientId: string; apiKey: string };
    try {
      credential = this.storeService.decryptGatewayCredential(
        identity.credential,
        normalized.storeId,
        normalized.expectedCredentialVersionId
      );
    } catch (error) {
      throw noBrandDictionaryInvalid('OZON 无品牌字典只读验证无法解密冻结凭据', normalized, {
        causeCode: error instanceof AppError ? error.code : undefined
      });
    }
    const requestRef = `ozon-no-brand:${sha256({
      ...normalized,
      expectedDictionaryValueId: OZON_NO_BRAND_DICTIONARY_VALUE_ID,
      expectedValue: OZON_NO_BRAND_VALUE_RU
    }).slice('sha256:'.length)}`;
    const result = await executeExactNoBrandDictionaryRead({
      credential,
      input: normalized
    });
    if (!Array.isArray(result.result)
      || result.result.some((entry) => !entry || typeof entry !== 'object' || Array.isArray(entry))) {
      throw noBrandDictionaryInvalid('OZON 无品牌字典响应结构无效，禁止创建自动上品任务', normalized, {
        requestRef,
        responseShape: 'gateway.result.result must be an object array'
      });
    }
    const exactMatches = result.result.map(asRecord).filter((entry) => (
      normalizeDictionaryText(entry.value) === normalizeDictionaryText(OZON_NO_BRAND_VALUE_RU)
    ));
    if (exactMatches.length !== 1) {
      throw noBrandDictionaryInvalid('OZON 无品牌字典值缺失或不唯一，禁止创建自动上品任务', normalized, {
        requestRef,
        exactMatchCount: exactMatches.length,
        resultCount: result.result.length
      });
    }
    const dictionaryValueId = Number(exactMatches[0]!.id);
    if (!Number.isSafeInteger(dictionaryValueId)
      || dictionaryValueId !== OZON_NO_BRAND_DICTIONARY_VALUE_ID) {
      throw noBrandDictionaryInvalid('OZON 无品牌字典值 ID 与系统合同不一致，禁止创建自动上品任务', normalized, {
        requestRef,
        observedDictionaryValueId: Number.isFinite(dictionaryValueId) ? dictionaryValueId : null,
        expectedDictionaryValueId: OZON_NO_BRAND_DICTIONARY_VALUE_ID
      });
    }
    // Close the store/config/credential TOCTOU window after the remote read.
    await this.stores.getExactStoreReadbackIdentity(exactIdentity);
    return {
      storeId: normalized.storeId,
      categoryVersionId: normalized.categoryVersionId,
      presetRowVersion: normalized.presetRowVersion,
      attributeId: normalized.attributeId,
      dictionaryId: normalized.dictionaryId,
      dictionaryValueId: OZON_NO_BRAND_DICTIONARY_VALUE_ID,
      value: OZON_NO_BRAND_VALUE_RU,
      requestRef
    };
  }

  /**
   * Proves that an exact set of Offer IDs is absent from one Seller account.
   * This is deliberately outside the gateway ledger: it creates no publication,
   * job, lease or write intent and only calls two allow-listed read endpoints.
   */
  async proveStoreOfferAbsence(input: OzonStoreOfferAbsenceInput): Promise<OzonStoreOfferAbsenceProof> {
    const normalized = normalizeStoreOfferAbsenceInput(input);
    const identity = await this.stores.getExactStoreReadbackIdentity(normalized);
    if (!identity.credential || identity.credentialVersionId !== normalized.expectedCredentialVersionId) {
      throw remoteStateUnproven('OZON 逐店只读证明未取得精确的冻结凭据', {
        storeId: normalized.storeId,
        expectedCredentialVersionId: normalized.expectedCredentialVersionId
      });
    }
    let credential: { clientId: string; apiKey: string };
    try {
      credential = this.storeService.decryptGatewayCredential(
        identity.credential,
        normalized.storeId,
        normalized.expectedCredentialVersionId
      );
    } catch (error) {
      throw remoteStateUnproven('OZON 逐店只读证明无法解密冻结凭据', {
        storeId: normalized.storeId,
        expectedCredentialVersionId: normalized.expectedCredentialVersionId,
        causeCode: error instanceof AppError ? error.code : undefined
      });
    }

    const operations = await Promise.all([
      executeStoreAbsenceRead({
        operation: 'infoList',
        payload: { offer_id: normalized.offerIds },
        credential,
        offerIds: normalized.offerIds
      }),
      executeStoreAbsenceRead({
        operation: 'attributesInfo',
        payload: { filter: { offer_id: normalized.offerIds }, limit: 100 },
        credential,
        offerIds: normalized.offerIds
      })
    ]);

    // Close the read/config TOCTOU window. A config version is monotonic, so a
    // switch away and back cannot silently produce the same frozen tuple.
    let current: Awaited<ReturnType<OzonStoreRepository['getExactStoreReadbackIdentity']>>;
    try {
      current = await this.stores.getExactStoreReadbackIdentity(normalized);
    } catch (error) {
      throw remoteStateUnproven('OZON 逐店只读证明期间店铺或凭据版本发生变化', {
        storeId: normalized.storeId,
        expectedStoreConfigVersion: normalized.expectedStoreConfigVersion,
        expectedCredentialVersionId: normalized.expectedCredentialVersionId,
        causeCode: error instanceof AppError ? error.code : undefined
      });
    }
    if (current.storeConfigVersion !== identity.storeConfigVersion
      || current.credentialVersionId !== identity.credentialVersionId) {
      throw remoteStateUnproven('OZON 逐店只读证明期间店铺或凭据版本发生变化', {
        storeId: normalized.storeId,
        expectedStoreConfigVersion: normalized.expectedStoreConfigVersion,
        expectedCredentialVersionId: normalized.expectedCredentialVersionId
      });
    }
    const checkedAt = new Date().toISOString();
    const proof = {
      absent: true as const,
      status: 'CONFIRMED_ABSENT' as const,
      storeId: normalized.storeId,
      storeConfigVersion: normalized.expectedStoreConfigVersion,
      credentialVersionId: normalized.expectedCredentialVersionId,
      offerIds: normalized.offerIds,
      checkedAt,
      operations
    };
    // checkedAt is audit metadata, not part of the remote-state contract.  A
    // PRE_PLAN apply must perform a fresh read while still being able to prove
    // that the second read returned the same store/config/Offer evidence as the
    // dry-run.  Keeping the timestamp out of evidenceHash makes that comparison
    // possible without weakening any semantic field.
    const { checkedAt: _checkedAt, ...semanticProof } = proof;
    void _checkedAt;
    return { ...proof, evidenceHash: sha256(semanticProof) };
  }

  async recordLegacyReceipt(input: unknown): Promise<OzonGatewayResponse> {
    const parsed = ozonGatewayLegacyReceiptSchema.safeParse(input);
    if (!parsed.success) throw new AppError('CONFIG_INVALID', 'OZON legacy 网关回执格式无效', { issues: parsed.error.issues });
    const row = await this.stores.recordLegacyGatewayReceipt(parsed.data);
    return responseFromLedger(row, parsed.data.operation, parsed.data.requestRef);
  }

  private async rejectBeforeSend(requestRef: string, operation: string, error: unknown): Promise<OzonGatewayResponse> {
    const code = error instanceof AppError ? error.code : 'CONFIG_INVALID';
    const message = error instanceof Error ? error.message : 'OZON 网关请求在发送前被拒绝';
    const safe = { code, message: message.slice(0, 1_000) };
    await this.stores.completeGatewayRequest({
      requestRef,
      deliveryState: 'NOT_SENT',
      retryClass: 'PERMANENT',
      statusCode: error instanceof AppError ? error.statusCode : 400,
      response: safe
    });
    return {
      ok: false,
      operation,
      requestRef,
      deliveryState: 'NOT_SENT',
      retryClass: 'PERMANENT',
      statusCode: error instanceof AppError ? error.statusCode : 400,
      result: {},
      error: safe
    };
  }
}

function normalizeExactNoBrandDictionaryInput(
  input: OzonExactNoBrandDictionaryInput
): OzonExactNoBrandDictionaryInput {
  const normalized = {
    storeId: String(input?.storeId || '').trim(),
    expectedStoreConfigVersion: Number(input?.expectedStoreConfigVersion),
    expectedCredentialVersionId: String(input?.expectedCredentialVersionId || '').trim(),
    categoryVersionId: String(input?.categoryVersionId || '').trim(),
    presetRowVersion: Number(input?.presetRowVersion),
    descriptionCategoryId: Number(input?.descriptionCategoryId),
    typeId: Number(input?.typeId),
    attributeId: Number(input?.attributeId),
    dictionaryId: Number(input?.dictionaryId)
  };
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  if (!uuid.test(normalized.storeId)
    || !uuid.test(normalized.expectedCredentialVersionId)
    || !uuid.test(normalized.categoryVersionId)
    || !Number.isSafeInteger(normalized.expectedStoreConfigVersion) || normalized.expectedStoreConfigVersion < 1
    || !Number.isSafeInteger(normalized.presetRowVersion) || normalized.presetRowVersion < 1
    || !Number.isSafeInteger(normalized.descriptionCategoryId) || normalized.descriptionCategoryId < 1
    || !Number.isSafeInteger(normalized.typeId) || normalized.typeId < 1
    || ![31, 85].includes(normalized.attributeId)
    || !Number.isSafeInteger(normalized.dictionaryId) || normalized.dictionaryId < 1) {
    throw noBrandDictionaryInvalid('OZON 无品牌字典只读验证输入合同无效', normalized);
  }
  return normalized;
}

function normalizeDictionaryText(value: unknown): string {
  return String(value || '').normalize('NFKC').trim().replace(/\s+/gu, ' ').toLocaleLowerCase('ru-RU');
}

function noBrandDictionaryInvalid(
  message: string,
  input: Pick<OzonExactNoBrandDictionaryInput,
    'storeId' | 'categoryVersionId' | 'presetRowVersion' | 'descriptionCategoryId' | 'typeId' | 'attributeId' | 'dictionaryId'>,
  details: JsonRecord = {}
): AppError {
  return new AppError('CONFIG_INVALID', message, {
    storeId: input.storeId,
    categoryVersionId: input.categoryVersionId,
    presetRowVersion: input.presetRowVersion,
    descriptionCategoryId: input.descriptionCategoryId,
    typeId: input.typeId,
    attributeId: input.attributeId,
    dictionaryId: input.dictionaryId,
    attributeNameZh: input.attributeId === 31 ? '服装和鞋类品牌' : '品牌',
    attributeNameRu: input.attributeId === 31 ? 'Бренд одежды и обуви' : 'Бренд',
    expectedValue: OZON_NO_BRAND_VALUE_RU,
    expectedDictionaryValueId: OZON_NO_BRAND_DICTIONARY_VALUE_ID,
    ...details
  }, 409);
}

function normalizeStoreOfferAbsenceInput(input: OzonStoreOfferAbsenceInput): OzonStoreOfferAbsenceInput {
  const storeId = String(input?.storeId || '').trim();
  const expectedCredentialVersionId = String(input?.expectedCredentialVersionId || '').trim();
  const offerIds = Array.isArray(input?.offerIds)
    ? input.offerIds.map((value) => String(value || '').trim())
    : [];
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  if (!uuid.test(storeId) || !uuid.test(expectedCredentialVersionId)
    || !Number.isSafeInteger(input?.expectedStoreConfigVersion)
    || input.expectedStoreConfigVersion < 1
    || offerIds.length < 1
    || offerIds.length > 100
    || offerIds.some((offerId) => !offerId || offerId.length > 100 || [...offerId].some((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint <= 0x1f || codePoint === 0x7f;
    }))
    || new Set(offerIds).size !== offerIds.length) {
    throw new AppError('CONFIG_INVALID', 'OZON 逐店只读 Offer absence 输入合同无效', {
      storeId,
      expectedStoreConfigVersion: input?.expectedStoreConfigVersion,
      expectedCredentialVersionId,
      offerCount: offerIds.length
    }, 400);
  }
  return {
    storeId,
    expectedStoreConfigVersion: input.expectedStoreConfigVersion,
    expectedCredentialVersionId,
    offerIds: [...offerIds].sort()
  };
}

async function executeExactNoBrandDictionaryRead(input: {
  input: OzonExactNoBrandDictionaryInput;
  credential: { clientId: string; apiKey: string };
}): Promise<JsonRecord> {
  const definition = OPERATIONS.attributeValuesSearch;
  let response: Response;
  try {
    response = await fetch(`${OZON_API}${definition.endpoint}`, {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
        'Client-Id': input.credential.clientId,
        'Api-Key': input.credential.apiKey
      },
      body: JSON.stringify({
        description_category_id: input.input.descriptionCategoryId,
        type_id: input.input.typeId,
        attribute_id: input.input.attributeId,
        value: OZON_NO_BRAND_VALUE_RU,
        limit: 100
      }),
      signal: AbortSignal.timeout(60_000)
    });
  } catch (error) {
    throw noBrandDictionaryInvalid('OZON 无品牌字典只读验证未取得确定响应', input.input, {
      endpoint: definition.endpoint,
      outcome: 'UNKNOWN',
      causeCode: String(asRecord(error).code || asRecord(error).name || '') || undefined,
      causeMessage: safeErrorMessage(error)
    });
  }
  if (response.status !== 200 || !response.ok) {
    throw noBrandDictionaryInvalid('OZON 无品牌字典只读验证未返回严格 HTTP 200', input.input, {
      endpoint: definition.endpoint,
      outcome: 'UNKNOWN',
      statusCode: response.status
    });
  }
  try {
    return await strictJsonResponse(response, 'attributeValuesSearch');
  } catch (error) {
    throw noBrandDictionaryInvalid('OZON 无品牌字典只读响应合同无效', input.input, {
      endpoint: definition.endpoint,
      outcome: 'UNKNOWN',
      causeCode: error instanceof AppError ? error.code : undefined
    });
  }
}

async function executeStoreAbsenceRead(input: {
  operation: 'infoList' | 'attributesInfo';
  payload: JsonRecord;
  credential: { clientId: string; apiKey: string };
  offerIds: string[];
}): Promise<OzonStoreOfferAbsenceProof['operations'][number]> {
  const definition = OPERATIONS[input.operation];
  let response: Response;
  try {
    response = await fetch(`${OZON_API}${definition.endpoint}`, {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
        'Client-Id': input.credential.clientId,
        'Api-Key': input.credential.apiKey
      },
      body: JSON.stringify(input.payload),
      signal: AbortSignal.timeout(60_000)
    });
  } catch (error) {
    throw remoteStateUnproven('OZON 逐店只读 Offer absence 请求未取得确定响应', {
      operation: input.operation,
      endpoint: definition.endpoint,
      outcome: 'UNKNOWN',
      causeCode: String(asRecord(error).code || asRecord(error).name || '') || undefined,
      causeMessage: safeErrorMessage(error)
    });
  }
  if (input.operation === 'attributesInfo' && response.status === 404) {
    await strictAttributesNotFoundResponse(response);
    return {
      operation: input.operation,
      endpoint: definition.endpoint,
      statusCode: 404,
      responseShape: 'NOT_FOUND_ERROR',
      itemCount: 0,
      paginationComplete: true,
      errorCode: '5'
    };
  }
  if (response.status !== 200 || !response.ok) {
    throw remoteStateUnproven('OZON 逐店只读 Offer absence 未返回严格 HTTP 200', {
      operation: input.operation,
      endpoint: definition.endpoint,
      outcome: 'UNKNOWN',
      statusCode: response.status
    });
  }
  const body = await strictJsonResponse(response, input.operation);
  const extracted = strictEmptyOfferResult(body, input.operation, input.offerIds);
  return {
    operation: input.operation,
    endpoint: definition.endpoint,
    statusCode: 200,
    responseShape: extracted.responseShape,
    itemCount: 0,
    paginationComplete: true
  };
}

async function strictAttributesNotFoundResponse(response: Response): Promise<void> {
  let text: string;
  try {
    text = await response.text();
  } catch (error) {
    throw remoteStateUnproven('OZON attributesInfo 404 响应体读取失败', {
      operation: 'attributesInfo',
      outcome: 'UNKNOWN',
      causeMessage: safeErrorMessage(error)
    });
  }
  if (!text || Buffer.byteLength(text, 'utf8') > 2_000_000) {
    throw remoteStateUnproven('OZON attributesInfo 404 响应体为空或超过安全上限', {
      operation: 'attributesInfo',
      outcome: 'UNKNOWN',
      responseBytes: Buffer.byteLength(text || '', 'utf8')
    });
  }
  let body: JsonRecord;
  try {
    const parsed = JSON.parse(text) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('response is not an object');
    body = parsed as JsonRecord;
  } catch {
    throw remoteStateUnproven('OZON attributesInfo 404 响应不是有效 JSON 对象', {
      operation: 'attributesInfo',
      outcome: 'UNKNOWN'
    });
  }
  const detailsValid = body.details === undefined || (Array.isArray(body.details) && body.details.length === 0);
  const hasAmbiguousProductData = [body.result, body.items, body.products]
    .some((value) => value !== undefined && value !== null);
  if (String(body.code ?? '') !== '5'
    || body.message !== 'item not found'
    || !detailsValid
    || hasAmbiguousProductData) {
    throw remoteStateUnproven('OZON attributesInfo 404 不符合精确的商品不存在合同', {
      operation: 'attributesInfo',
      outcome: 'UNKNOWN',
      statusCode: 404,
      errorCode: String(body.code ?? '') || undefined,
      responseShape: 'UNPROVEN_ERROR'
    });
  }
}

async function strictJsonResponse(response: Response, operation: string): Promise<JsonRecord> {
  let text: string;
  try {
    text = await response.text();
  } catch (error) {
    throw remoteStateUnproven('OZON 逐店只读响应体读取失败', {
      operation,
      outcome: 'UNKNOWN',
      causeMessage: safeErrorMessage(error)
    });
  }
  if (!text || Buffer.byteLength(text, 'utf8') > 2_000_000) {
    throw remoteStateUnproven('OZON 逐店只读响应体为空或超过安全上限', {
      operation,
      outcome: 'UNKNOWN',
      responseBytes: Buffer.byteLength(text || '', 'utf8')
    });
  }
  try {
    const parsed = JSON.parse(text) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('response is not an object');
    const object = parsed as JsonRecord;
    const result = asRecord(object.result);
    const errorMarkers = [object.error, object.errors, object.error_code, object.errorCode, result.error, result.errors]
      .filter((value) => value !== undefined && value !== null && value !== '' && (!Array.isArray(value) || value.length));
    if (errorMarkers.length || (object.code !== undefined && Number(object.code) !== 0)) {
      throw remoteStateUnproven('OZON 逐店只读 HTTP 200 响应包含应用层错误', {
        operation,
        outcome: 'UNKNOWN'
      });
    }
    return object;
  } catch {
    throw remoteStateUnproven('OZON 逐店只读响应不是有效 JSON 对象', {
      operation,
      outcome: 'UNKNOWN'
    });
  }
}

function strictEmptyOfferResult(
  body: JsonRecord,
  operation: 'infoList' | 'attributesInfo',
  offerIds: string[]
): { responseShape: 'ITEMS' | 'RESULT_ITEMS' | 'RESULT_ARRAY' } {
  const result = asRecord(body.result);
  const candidates: Array<{ responseShape: 'ITEMS' | 'RESULT_ITEMS' | 'RESULT_ARRAY'; items: unknown[] }> = [];
  if (Array.isArray(body.items)) candidates.push({ responseShape: 'ITEMS', items: body.items });
  if (Array.isArray(result.items)) candidates.push({ responseShape: 'RESULT_ITEMS', items: result.items });
  if (Array.isArray(body.result)) candidates.push({ responseShape: 'RESULT_ARRAY', items: body.result });
  if (candidates.length !== 1 || candidates[0]!.items.some((item) => !item || typeof item !== 'object' || Array.isArray(item))) {
    throw remoteStateUnproven('OZON 逐店只读响应的商品数组合同无效或有歧义', {
      operation,
      outcome: 'UNKNOWN',
      candidateCount: candidates.length
    });
  }
  const selected = candidates[0]!;
  if (selected.items.length) {
    const requested = new Set(offerIds);
    const observed = selected.items.map((item) => {
      const record = asRecord(item);
      return String(record.offer_id ?? record.offerId ?? '').trim();
    });
    const matching = observed.filter((offerId) => offerId && requested.has(offerId));
    if (matching.length) {
      throw new AppError('OZON_REMOTE_STATE_PRESENT', 'OZON 已返回目标 Offer，禁止 PRE_PLAN 恢复', {
        operation,
        offerIds: [...new Set(matching)].sort()
      }, 409);
    }
    throw remoteStateUnproven('OZON 逐店只读响应包含无法归属的意外商品记录', {
      operation,
      outcome: 'UNKNOWN',
      observedOfferIds: observed.filter(Boolean).slice(0, 100),
      recordCount: selected.items.length
    });
  }
  assertTerminalPagination(body, result, operation);
  return { responseShape: selected.responseShape };
}

function assertTerminalPagination(body: JsonRecord, result: JsonRecord, operation: string): void {
  for (const container of [body, result]) {
    for (const key of ['has_next', 'hasNext']) {
      if (Object.prototype.hasOwnProperty.call(container, key) && container[key] !== false) {
        throw remoteStateUnproven('OZON 逐店只读响应仍有未读取分页', {
          operation,
          outcome: 'UNKNOWN',
          paginationField: key
        });
      }
    }
    for (const key of ['cursor', 'next_cursor', 'nextCursor', 'last_id', 'lastId']) {
      if (!Object.prototype.hasOwnProperty.call(container, key)) continue;
      const value = container[key];
      if (value !== null && value !== undefined && value !== '' && value !== 0 && value !== '0') {
        throw remoteStateUnproven('OZON 逐店只读响应仍有未读取分页', {
          operation,
          outcome: 'UNKNOWN',
          paginationField: key
        });
      }
    }
    if (Object.prototype.hasOwnProperty.call(container, 'total')
      && (!Number.isSafeInteger(Number(container.total)) || Number(container.total) !== 0)) {
      throw remoteStateUnproven('OZON 逐店只读响应 total 不能证明结果为空', {
        operation,
        outcome: 'UNKNOWN'
      });
    }
  }
}

function remoteStateUnproven(message: string, details?: JsonRecord): AppError {
  return new AppError('OZON_REMOTE_STATE_UNPROVEN', message, details, 409);
}

function buildOperation(name: string, payload: JsonRecord, identity: OzonGatewayIdentity, storeScope: boolean): Operation {
  const definition = OPERATIONS[name as keyof typeof OPERATIONS];
  if (!definition) throw new AppError('CONFIG_INVALID', 'OZON 网关 operation 不在允许列表中', { operation: name });
  if (storeScope && (definition.write || !STORE_SCOPED_READ_OPERATIONS.has(name))) {
    throw new AppError('CONFIG_INVALID', 'OZON storeId 分支只允许固定只读 operation', { operation: name }, 409);
  }
  const body = structuredClone(payload);
  assertOperationPayload(name, body, identity, storeScope);
  return {
    ...definition,
    timeoutMs: definition.write ? 120_000 : 60_000,
    body
  };
}

function assertOperationPayload(name: string, body: JsonRecord, identity: OzonGatewayIdentity, storeScope: boolean): void {
  if (containsRemovedImageFields(body)) {
    throw new AppError('CONFIG_INVALID', 'OZON images360/photo_360 已移除，不允许出现在请求中');
  }
  if (name === 'importProduct') {
    const items = Array.isArray(body.items) ? body.items : [];
    if (!items.length || items.some((item) => !String(asRecord(item).offer_id || '').trim())) {
      throw new AppError('CONFIG_INVALID', '/v3/product/import 的每个 item 都必须提供 offer_id');
    }
  }
  if (name === 'importInfo') {
    if (!positiveInteger(body.task_id)) throw new AppError('CONFIG_INVALID', 'importInfo.task_id 必须是正整数');
    if (!storeScope && (!identity.importTaskId || String(body.task_id) !== identity.importTaskId)) {
      throw new AppError('VERSION_CONFLICT', 'importInfo.task_id 不属于当前冻结任务', undefined, 409);
    }
  }
  if (name === 'attributesUpdate') {
    const items = Array.isArray(body.items) ? body.items : [];
    if (!items.length || items.some((entry) => {
      const item = asRecord(entry);
      const attributes = Array.isArray(item.attributes) ? item.attributes : [];
      const ids = attributes.map((attribute) => Number(asRecord(attribute).id));
      return !String(item.offer_id || '').trim()
        || attributes.length !== 2
        || ids.length !== new Set(ids).size
        || !ids.includes(10096)
        || !ids.includes(10097);
    })) {
      throw new AppError('CONFIG_INVALID', 'attributesUpdate 仅允许为每个 Offer 更新 10096 与 10097 两个颜色属性');
    }
  }
  if (name === 'stocksWrite') {
    const stocks = Array.isArray(body.stocks) ? body.stocks : [];
    if (!stocks.length) throw new AppError('CONFIG_INVALID', 'stocksWrite.stocks 不能为空');
    body.stocks = stocks.map((entry) => {
      const stock = asRecord(entry);
      const supplied = String(stock.warehouse_id ?? '').trim();
      if (supplied && supplied !== identity.warehouseId) {
        throw new AppError('VERSION_CONFLICT', 'stocksWrite warehouse_id 与任务冻结仓库不一致', {
          expected: identity.warehouseId
        }, 409);
      }
      return { ...stock, warehouse_id: numericOrString(identity.warehouseId) };
    });
  }
  const offerIds = collectOfferIds(body);
  if (!storeScope && identity.offerIds.length) {
    const allowed = new Set(identity.offerIds);
    const unexpected = offerIds.filter((offerId) => !allowed.has(offerId));
    if (unexpected.length) {
      throw new AppError('VERSION_CONFLICT', 'OZON 网关 payload 的 offer_id 超出任务 Offer 合同', { unexpected }, 409);
    }
  }
  if (!storeScope && new Set([
    'importProduct', 'listProducts', 'infoList', 'attributesInfo', 'attributesUpdate', 'pricesRead', 'stocksRead', 'pricesWrite', 'stocksWrite'
  ]).has(name) && !offerIds.length) {
    throw new AppError('CONFIG_INVALID', `${name} 必须携带当前 publication 冻结的 offer_id`, undefined, 409);
  }
  if (!storeScope && (name === 'picturesImport' || name === 'picturesInfo')) {
    const productIds = collectProductIds(body);
    if (!productIds.length) {
      throw new AppError('CONFIG_INVALID', `${name} 必须携带已冻结映射的 product_id`, undefined, 409);
    }
    const allowed = new Set(identity.productIds);
    const unexpected = productIds.filter((productId) => !allowed.has(productId));
    if (!allowed.size || unexpected.length) {
      throw new AppError('VERSION_CONFLICT', `${name}.product_id 不属于当前 publication`, { unexpected }, 409);
    }
  }
}

function assertNoForbiddenPayload(value: unknown, depth = 0): void {
  if (depth > 20) throw new AppError('CONFIG_INVALID', 'OZON 网关 payload 层级过深');
  if (!value || typeof value !== 'object') {
    if (typeof value === 'string' && /^Bearer\s+[A-Za-z0-9._-]{8,}$/i.test(value.trim())) {
      throw new AppError('CONFIG_INVALID', 'OZON 网关 payload 不得携带认证值');
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((entry) => assertNoForbiddenPayload(entry, depth + 1));
    return;
  }
  const forbidden = /^(?:authorization|client[-_]?id|api[-_]?key|token|cookie|credentials?|url|method|headers?|is[-_]?write|store[-_]?id|store[-_]?alias|credential[-_]?version[-_]?id|store[-_]?config[-_]?version)$/i;
  for (const [key, child] of Object.entries(value as JsonRecord)) {
    if (forbidden.test(key)) throw new AppError('CONFIG_INVALID', 'OZON 网关 payload 含认证、URL 或店铺覆盖字段', { field: key });
    assertNoForbiddenPayload(child, depth + 1);
  }
}

function collectOfferIds(value: unknown, result = new Set<string>()): string[] {
  if (!value || typeof value !== 'object') return [...result];
  if (Array.isArray(value)) {
    value.forEach((entry) => collectOfferIds(entry, result));
    return [...result];
  }
  for (const [key, child] of Object.entries(value as JsonRecord)) {
    if (key === 'offer_id') {
      if (Array.isArray(child)) child.forEach((entry) => String(entry || '').trim() && result.add(String(entry).trim()));
      else if (String(child || '').trim()) result.add(String(child).trim());
    } else collectOfferIds(child, result);
  }
  return [...result];
}

function collectProductIds(value: unknown, result = new Set<string>()): string[] {
  if (!value || typeof value !== 'object') return [...result];
  if (Array.isArray(value)) {
    value.forEach((entry) => collectProductIds(entry, result));
    return [...result];
  }
  for (const [key, child] of Object.entries(value as JsonRecord)) {
    if (key === 'product_id') {
      if (Array.isArray(child)) child.forEach((entry) => String(entry || '').trim() && result.add(String(entry).trim()));
      else if (String(child || '').trim()) result.add(String(child).trim());
    } else collectProductIds(child, result);
  }
  return [...result];
}

function containsRemovedImageFields(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  if (Array.isArray(value)) return value.some(containsRemovedImageFields);
  return Object.entries(value as JsonRecord).some(([key, child]) => (
    key === 'images360' || key === 'photo_360' || containsRemovedImageFields(child)
  ));
}

function classifyTransport(error: unknown, write: boolean): { deliveryState: 'NOT_SENT' | 'UNKNOWN'; retryClass: 'RETRYABLE' | 'READBACK_REQUIRED' } {
  const code = String(asRecord(error).code || '').toUpperCase();
  const definitelyNotSent = ['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'UND_ERR_CONNECT_TIMEOUT'].includes(code);
  if (definitelyNotSent || !write) return { deliveryState: 'NOT_SENT', retryClass: 'RETRYABLE' };
  return { deliveryState: 'UNKNOWN', retryClass: 'READBACK_REQUIRED' };
}

function classifyResponse(status: number, write: boolean): {
  deliveryState: 'NOT_SENT' | 'RESPONDED' | 'UNKNOWN';
  retryClass: 'NONE' | 'RETRYABLE' | 'READBACK_REQUIRED' | 'PERMANENT';
} {
  if (status >= 200 && status < 300) return { deliveryState: 'RESPONDED', retryClass: 'NONE' };
  if (status === 408 || status >= 500) {
    return write
      ? { deliveryState: 'UNKNOWN', retryClass: 'READBACK_REQUIRED' }
      : { deliveryState: 'NOT_SENT', retryClass: 'RETRYABLE' };
  }
  if (status === 425 || status === 429) return { deliveryState: 'NOT_SENT', retryClass: 'RETRYABLE' };
  return { deliveryState: 'RESPONDED', retryClass: 'PERMANENT' };
}

function gatewayLedgerMayRetry(row: JsonRecord): boolean {
  return row.delivery_state === 'NOT_SENT'
    && ['NONE', 'RETRYABLE'].includes(String(row.retry_class || ''))
    && String(row.delegation_state || 'NONE') === 'NONE';
}

function responseFromLedger(row: JsonRecord, operation: string, requestRef: string): OzonGatewayResponse {
  const result = redact(row.response_json ?? {});
  const statusCode = Number(row.status_code || 0);
  const deliveryState = row.delivery_state as OzonGatewayResponse['deliveryState'];
  return {
    ok: deliveryState === 'RESPONDED' && statusCode >= 200 && statusCode < 300,
    operation,
    requestRef,
    deliveryState,
    retryClass: row.retry_class as OzonGatewayResponse['retryClass'],
    ...(row.retry_after_ms !== null && row.retry_after_ms !== undefined ? { retryAfterMs: Number(row.retry_after_ms) } : {}),
    ...(statusCode ? { statusCode } : {}),
    result,
    idempotent: true
  };
}

async function safeResponseBody(response: Response): Promise<unknown> {
  const text = (await response.text()).slice(0, 2_000_000);
  if (!text) return {};
  try { return JSON.parse(text); } catch { return { raw: text.slice(0, 4_000) }; }
}

function parseRetryAfter(headers: Headers): number | undefined {
  const value = headers.get('retry-after');
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(86_400_000, Math.round(seconds * 1_000));
  const date = new Date(value).getTime();
  return Number.isFinite(date) ? Math.max(0, Math.min(86_400_000, date - Date.now())) : undefined;
}

function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value as JsonRecord).map(([key, child]) => [
    key,
    /authorization|client[-_]?id|api[-_]?key|token|cookie|secret|credential/i.test(key) ? '[REDACTED]' : redact(child)
  ]));
}

function platformMessage(value: unknown, status: number): string {
  const row = asRecord(value);
  return String(row.message || asRecord(row.error).message || `OZON HTTP ${status}`).slice(0, 1_000);
}

function safeErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message.slice(0, 1_000) : 'OZON 网关传输失败';
}

function positiveInteger(value: unknown): boolean {
  return Number.isSafeInteger(Number(value)) && Number(value) > 0;
}

function numericOrString(value: string): number | string {
  return /^\d+$/.test(value) ? Number(value) : value;
}

function asRecord(value: unknown): JsonRecord {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : {};
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const object = value as JsonRecord;
    return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${stableJson(object[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function sha256(value: unknown): string {
  return `sha256:${createHash('sha256').update(stableJson(value)).digest('hex')}`;
}
