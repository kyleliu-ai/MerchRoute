import { z } from 'zod';
import {
  OZON_SHARED_MATERIAL_HASH_VERSION,
  ozonContentPolicyVersionSchema,
  ozonPublishTaskKindSchema,
  ozonSha256Schema,
  ozonSharedMaterialHashVersionSchema,
  type OzonListingDraft,
  type OzonPreparationFanoutSummary,
  type OzonProductLink,
  type OzonPublishEvent,
  type OzonPublishJob
} from './ozon.js';

export const OZON_DEFAULT_STORE_ID = '00000000-0000-4000-8000-000000000002' as const;
export const OZON_DEFAULT_STORE_ALIAS = 'default' as const;
export const OZON_GLOBAL_CONCURRENCY_DEFAULT = 2 as const;
export const OZON_GLOBAL_CONCURRENCY_MAX = 2 as const;
export const OZON_PER_STORE_CONCURRENCY = 1 as const;
export const OZON_PREFLIGHT_TTL_HOURS = 24 as const;
export const OZON_PREFLIGHT_DUE_HOURS = 18 as const;

export const OZON_CREDENTIAL_BINDING_MODES = [
  'VAULT',
  'LEGACY_PUBLICATION',
  'PURE_LEGACY'
] as const;
export const OZON_STORE_CREDENTIAL_STATES = ['MISSING', 'LEGACY_EXTERNAL', 'PENDING', 'ACTIVE'] as const;
export const OZON_STORE_PREFLIGHT_STATUSES = ['NOT_RUN', 'PENDING', 'PASSED', 'FAILED', 'STALE'] as const;
export const OZON_STORE_NETWORK_STATUSES = ['READY', 'WAITING', 'ERROR'] as const;
export const OZON_STORE_PUBLICATION_STATUSES = [
  'PLANNED',
  'MATERIALIZED',
  'QUEUED',
  'RUNNING',
  'SUCCEEDED',
  'FAILED',
  'NEEDS_ATTENTION',
  'PAUSED',
  'CANCELLED'
] as const;

export const ozonCredentialBindingModeSchema = z.enum(OZON_CREDENTIAL_BINDING_MODES);
export const ozonStoreCredentialStateSchema = z.enum(OZON_STORE_CREDENTIAL_STATES);
export const ozonStorePreflightStatusSchema = z.enum(OZON_STORE_PREFLIGHT_STATUSES);
export const ozonStoreNetworkStatusSchema = z.enum(OZON_STORE_NETWORK_STATUSES);
export const ozonStorePublicationStatusSchema = z.enum(OZON_STORE_PUBLICATION_STATUSES);

const windowsReservedName = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
export const ozonStoreAliasSchema = z.string().trim().min(2).max(32)
  .regex(/^[a-z0-9][a-z0-9-]*$/, '店铺别名只能包含小写字母、数字和连字符')
  .refine((value) => !windowsReservedName.test(value), '店铺别名不能使用 Windows 保留名称');

export const ozonStoreAutoPublishModeSchema = z.enum(['CREATE_ONLY', 'COMPATIBLE_UPSERT']);
export const ozonStoreFulfillmentModeSchema = z.enum(['FBS', 'RFBS']);
export const ozonAccountCurrencySchema = z.enum(['RUB', 'CNY']);

export const ozonStoreSystemSettingsPatchSchema = z.object({
  rowVersion: z.number().int().positive(),
  enabled: z.boolean().optional(),
  rootDirectory: z.string().trim().max(2_048).optional(),
  timezone: z.string().trim().min(1).max(64).optional(),
  globalConcurrency: z.number().int().min(1).max(OZON_GLOBAL_CONCURRENCY_MAX).optional(),
  taskApiWebhookUrl: z.string().url().or(z.literal('')).optional(),
  adminApiWebhookUrl: z.string().url().or(z.literal('')).optional(),
  preflightWebhookUrl: z.string().url().or(z.literal('')).optional(),
  imageUploaderWorkflowId: z.string().trim().max(128).optional(),
  storeGatewayWorkflowId: z.string().trim().max(128).optional(),
  imageUploadConcurrency: z.number().int().min(1).max(7).optional(),
  videoUploadConcurrency: z.number().int().min(1).max(2).optional(),
  videoPrewarmEnabled: z.boolean().optional()
}).strict();

const ozonStoreEditableFields = {
  displayName: z.string().trim().min(1).max(128),
  autoPublishEnabled: z.boolean().default(false),
  autoPublishMode: ozonStoreAutoPublishModeSchema.default('CREATE_ONLY'),
  defaultPresetId: z.string().uuid().nullable().optional(),
  warehouseId: z.string().trim().max(128).default(''),
  warehouseName: z.string().trim().max(256).default(''),
  fulfillmentMode: ozonStoreFulfillmentModeSchema.default('FBS'),
  accountCurrency: ozonAccountCurrencySchema.default('RUB'),
  maxDailyStyles: z.number().int().min(1).max(100_000).default(100)
};

export const ozonStoreCreateSchema = z.object({
  storeAlias: ozonStoreAliasSchema,
  ...ozonStoreEditableFields
}).strict();

export const ozonStoreUpdateSchema = z.object({
  displayName: ozonStoreEditableFields.displayName.optional(),
  autoPublishEnabled: z.boolean().optional(),
  autoPublishMode: ozonStoreAutoPublishModeSchema.optional(),
  defaultPresetId: z.string().uuid().nullable().optional(),
  warehouseId: z.string().trim().max(128).optional(),
  warehouseName: z.string().trim().max(256).optional(),
  fulfillmentMode: ozonStoreFulfillmentModeSchema.optional(),
  accountCurrency: ozonAccountCurrencySchema.optional(),
  maxDailyStyles: z.number().int().min(1).max(100_000).optional(),
  rowVersion: z.number().int().positive()
}).strict();

export const ozonStoreCredentialInputSchema = z.object({
  clientId: z.string().trim().min(1).max(1_024),
  apiKey: z.string().trim().min(16).max(16_384),
  rowVersion: z.number().int().positive()
}).strict();

export const ozonStoreMutationSchema = z.object({ rowVersion: z.number().int().positive() }).strict();

export const ozonStorePreflightDispatchSchema = z.object({
  action: z.literal('preflight'),
  storeId: z.string().uuid(),
  storeAlias: ozonStoreAliasSchema,
  rowVersion: z.number().int().positive(),
  storeConfigVersion: z.number().int().positive(),
  credentialVersionId: z.string().uuid(),
  requestRef: z.string().trim().min(1).max(256)
}).strict();

export const ozonStorePreflightCheckSchema = z.object({
  code: z.string().trim().min(1).max(128),
  ok: z.boolean(),
  status: z.enum(['PASSED', 'FAILED', 'DEFERRED', 'RATE_LIMITED']),
  message: z.string().trim().max(4_000).optional(),
  details: z.record(z.string(), z.unknown()).default({})
}).strict();

export const ozonStoreWarehouseSchema = z.object({
  id: z.string().trim().min(1).max(128),
  name: z.string().trim().max(256).default(''),
  fulfillmentModes: z.array(ozonStoreFulfillmentModeSchema).min(1).max(2),
  status: z.string().trim().max(128).optional()
}).strict();

export const ozonCurrencyVerificationSchema = z.object({
  status: z.enum(['VERIFIED', 'DEFERRED_EMPTY_CATALOG', 'FAILED']),
  currency: ozonAccountCurrencySchema.optional(),
  source: z.string().trim().max(128).optional(),
  evidence: z.record(z.string(), z.unknown()).default({})
}).strict().superRefine((value, context) => {
  if (value.status === 'VERIFIED' && !value.currency) {
    context.addIssue({ code: 'custom', path: ['currency'], message: '币种验证通过时必须携带实际账户币种' });
  }
});

export const ozonStorePreflightReportSchema = z.object({
  storeId: z.string().uuid(),
  storeConfigVersion: z.number().int().positive(),
  credentialVersionId: z.string().uuid(),
  sellerId: z.string().trim().max(256).optional(),
  sellerName: z.string().trim().max(256).optional(),
  checks: z.array(ozonStorePreflightCheckSchema).max(200).default([]),
  warehouses: z.array(ozonStoreWarehouseSchema).max(1_000).default([]),
  permissions: z.array(z.string().trim().min(1).max(128)).max(200).default([]),
  limits: z.record(z.string(), z.unknown()).default({}),
  currencyVerified: z.boolean(),
  currencyVerification: ozonCurrencyVerificationSchema,
  retryAfterMs: z.number().int().nonnegative().max(86_400_000).optional(),
  observedAt: z.string().datetime(),
  ok: z.boolean(),
  errorCode: z.string().trim().max(128).optional(),
  errorMessage: z.string().trim().max(4_000).optional()
}).strict().superRefine((value, context) => {
  if (value.currencyVerified !== (value.currencyVerification.status === 'VERIFIED')) {
    context.addIssue({ code: 'custom', path: ['currencyVerified'], message: '币种验证布尔值与证据状态不一致' });
  }
  if (value.ok && value.checks.some((check) => !check.ok && check.status !== 'DEFERRED')) {
    context.addIssue({ code: 'custom', path: ['ok'], message: '预检存在失败项时不能标记为通过' });
  }
});

export const ozonRuntimeStorePreflightReportInputSchema = z.object({
  storeConfigVersion: z.number().int().positive(),
  credentialVersionId: z.string().uuid(),
  report: ozonStorePreflightReportSchema
}).strict();

export const ozonPublicationPlanInputSchema = z.object({
  draftVersion: z.number().int().positive(),
  storeIds: z.array(z.string().uuid()).min(1).max(100)
    .refine((items) => new Set(items).size === items.length, '不能重复选择同一店铺')
}).strict();

export const ozonPublicationCreateInputSchema = ozonPublicationPlanInputSchema.extend({
  planHash: ozonSha256Schema,
  requestId: z.string().uuid()
}).strict();

export const ozonPublicationRecheckInputSchema = z.object({
  rowVersion: z.number().int().positive(),
  planHash: ozonSha256Schema,
  requestId: z.string().uuid()
}).strict();

export const ozonPreparationRecheckPlanInputSchema = z.object({
  rowVersion: z.number().int().positive()
}).strict();

export const ozonPreparationRecheckInputSchema = z.object({
  rowVersion: z.number().int().positive(),
  planHash: ozonSha256Schema,
  requestId: z.string().uuid()
}).strict();

export const ozonPreparationManualSuccessReconcilePlanInputSchema = z.object({
  rowVersion: z.number().int().positive()
}).strict();

export const ozonPreparationManualSuccessReconcileInputSchema = z.object({
  rowVersion: z.number().int().positive(),
  planHash: ozonSha256Schema,
  requestId: z.string().uuid()
}).strict();

export const ozonFrozenContentBindingSchema = z.object({
  contentPolicyVersion: ozonContentPolicyVersionSchema,
  materialHash: ozonSha256Schema,
  materialHashVersion: ozonSharedMaterialHashVersionSchema
}).strict();

export const ozonPublicationPlanItemAttemptIdentitySchema = z.object({
  publicationId: z.string().uuid(),
  jobId: z.string().uuid(),
  plannedJobId: z.string().uuid(),
  taskId: z.string().trim().min(1).max(256)
}).strict().superRefine((value, context) => {
  if (value.jobId !== value.plannedJobId) {
    context.addIssue({ code: 'custom', path: ['plannedJobId'], message: 'plannedJobId 必须与固定 jobId 相同' });
  }
});

export const ozonPublicationAttemptResultSchema = z.object({
  storeId: z.string().uuid(),
  publicationId: z.string().uuid(),
  status: ozonStorePublicationStatusSchema,
  errorCode: z.string().trim().min(1).max(256).optional(),
  errorMessage: z.string().trim().min(1).max(4_000).optional()
}).strict();

export const ozonPublicationCreateResultSchema = z.object({
  publications: z.array(z.object({
    id: z.string().uuid(),
    storeId: z.string().uuid(),
    status: ozonStorePublicationStatusSchema
  }).passthrough()).max(100),
  results: z.array(ozonPublicationAttemptResultSchema).max(100),
  accepted: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative()
}).strict().superRefine((value, context) => {
  if (value.accepted + value.failed !== value.results.length) {
    context.addIssue({ code: 'custom', path: ['accepted'], message: 'accepted + failed 必须等于逐店结果数' });
  }
  if (value.publications.length !== value.results.length) {
    context.addIssue({ code: 'custom', path: ['publications'], message: '每个逐店结果必须存在同一固定 publication attempt' });
  }
  const publicationKeys = new Set(value.publications.map((item) => `${item.storeId}:${item.id}`));
  if (value.results.some((item) => !publicationKeys.has(`${item.storeId}:${item.publicationId}`))) {
    context.addIssue({ code: 'custom', path: ['results'], message: '逐店结果与 publication 固定身份不一致' });
  }
});

export const ozonPublicationMutationSchema = z.object({
  rowVersion: z.number().int().positive()
}).strict();

export const ozonPublicationCompatibleAppendSchema = ozonPublicationMutationSchema.extend({
  planHash: z.string().regex(/^sha256:[a-f0-9]{64}$/)
}).strict();

export const ozonGatewayDeliveryStateSchema = z.enum(['NOT_SENT', 'UNKNOWN', 'RESPONDED']);
export const ozonGatewayRetryClassSchema = z.enum(['NONE', 'READBACK_REQUIRED', 'RETRYABLE', 'PERMANENT']);
const ozonGatewayWriteOperations = new Set(['importProduct', 'picturesImport', 'pricesWrite', 'stocksWrite', 'attributesUpdate']);
export const ozonGatewayRequestSchema = z.object({
  taskId: z.string().trim().min(1).max(256).optional(),
  storeId: z.string().uuid().optional(),
  publicationId: z.string().uuid().optional(),
  leaseToken: z.string().uuid().optional(),
  requestRef: z.string().trim().min(1).max(256),
  operation: z.string().trim().min(1).max(128),
  payload: z.record(z.string(), z.unknown()).default({})
}).strict().superRefine((value, context) => {
  if (Boolean(value.taskId) === Boolean(value.storeId)) {
    context.addIssue({ code: 'custom', path: ['taskId'], message: 'taskId 与 storeId 必须且只能提供一个' });
  }
  if (value.taskId && !value.publicationId) {
    context.addIssue({ code: 'custom', path: ['publicationId'], message: '任务网关请求必须携带 publicationId' });
  }
  if (value.taskId && ozonGatewayWriteOperations.has(value.operation) && !value.leaseToken) {
    context.addIssue({ code: 'custom', path: ['leaseToken'], message: '任务网关写请求必须携带当前租约 token' });
  }
  if (value.storeId && value.publicationId) {
    context.addIssue({ code: 'custom', path: ['publicationId'], message: '预检店铺请求不能携带 publicationId' });
  }
  if (value.storeId && value.leaseToken) {
    context.addIssue({ code: 'custom', path: ['leaseToken'], message: 'storeId 只读分支不能携带任务租约 token' });
  }
});

export const ozonGatewayLegacyReceiptSchema = z.object({
  requestRef: z.string().trim().min(1).max(256),
  operation: z.string().trim().min(1).max(128),
  payloadHash: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  statusCode: z.number().int().min(0).max(599),
  result: z.unknown(),
  deliveryState: ozonGatewayDeliveryStateSchema,
  retryClass: ozonGatewayRetryClassSchema,
  retryAfterMs: z.number().int().nonnegative().max(86_400_000).optional()
}).strict().superRefine((value, context) => {
  if (value.deliveryState === 'RESPONDED') {
    if (value.statusCode < 100) {
      context.addIssue({ code: 'custom', path: ['statusCode'], message: 'RESPONDED 回执必须包含 HTTP 状态码' });
    }
    const success = value.statusCode >= 200 && value.statusCode < 300;
    if (success && value.retryClass !== 'NONE') {
      context.addIssue({ code: 'custom', path: ['retryClass'], message: '2xx RESPONDED 回执必须是 NONE' });
    }
    if (!success && value.retryClass !== 'PERMANENT') {
      context.addIssue({ code: 'custom', path: ['retryClass'], message: '非 2xx RESPONDED 回执必须是 PERMANENT' });
    }
    if (value.statusCode === 408 || value.statusCode === 425 || value.statusCode === 429 || value.statusCode >= 500) {
      context.addIssue({ code: 'custom', path: ['deliveryState'], message: '408/425/429/5xx 不能伪装为已完成 RESPONDED' });
    }
  } else if (value.deliveryState === 'UNKNOWN') {
    if (!(value.statusCode === 0 || value.statusCode === 408 || value.statusCode >= 500)) {
      context.addIssue({ code: 'custom', path: ['statusCode'], message: 'UNKNOWN 仅允许无响应、408 或 5xx 证据' });
    }
    if (value.retryClass !== 'READBACK_REQUIRED') {
      context.addIssue({ code: 'custom', path: ['retryClass'], message: 'UNKNOWN 回执必须进入 READBACK_REQUIRED' });
    }
  } else {
    if (!(value.statusCode === 0 || value.statusCode === 408 || value.statusCode === 425
      || value.statusCode === 429 || value.statusCode >= 500)) {
      context.addIssue({ code: 'custom', path: ['statusCode'], message: 'NOT_SENT 仅允许无响应或明确未受理/可重试状态码' });
    }
    if (!['RETRYABLE', 'PERMANENT'].includes(value.retryClass)) {
      context.addIssue({ code: 'custom', path: ['retryClass'], message: 'NOT_SENT 回执必须明确可重试或永久拒绝' });
    }
    if (value.statusCode > 0 && value.retryClass !== 'RETRYABLE') {
      context.addIssue({ code: 'custom', path: ['retryClass'], message: '带 408/425/429/5xx 的 NOT_SENT 回执必须可重试' });
    }
    if (ozonGatewayWriteOperations.has(value.operation)
      && !(value.statusCode === 0 || value.statusCode === 425 || value.statusCode === 429)) {
      context.addIssue({
        code: 'custom',
        path: ['deliveryState'],
        message: 'legacy 写操作仅允许连接前失败、425 或 429 证明为 NOT_SENT；408/5xx 必须记为 UNKNOWN'
      });
    }
  }
  if (value.retryAfterMs !== undefined && value.retryClass !== 'RETRYABLE') {
    context.addIssue({ code: 'custom', path: ['retryAfterMs'], message: '仅 RETRYABLE 回执允许 retryAfterMs' });
  }
});

export const ozonRuntimeClaimSchema = z.object({
  leaseOwner: z.string().trim().min(1).max(256),
  leaseSeconds: z.number().int().min(30).max(3_600).default(600),
  limit: z.number().int().min(1).max(OZON_GLOBAL_CONCURRENCY_MAX).default(OZON_GLOBAL_CONCURRENCY_DEFAULT),
  states: z.array(z.string().trim().min(1).max(64)).min(1).max(32).optional()
}).strict();

export const OZON_RUNTIME_CLAIM_JOB_STATES = [
  'READY',
  'UPLOADING_MEDIA',
  'SUBMITTING',
  'IMPORTING',
  'VERIFYING_IMAGES',
  'UPDATING_PRICE',
  'UPDATING_STOCK',
  'MODERATING'
] as const;

const ozonRuntimeClaimHashSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const ozonRuntimeClaimDirectoryStageSchema = z.enum(['INBOX', 'PROCESSING', 'SUCCESS']);

/** Exact backend-to-P002 lease snapshot. Keep this strict so SQL projection drift fails closed. */
export const ozonRuntimeClaimJobSchema = z.object({
  id: z.string().uuid(),
  sku: z.string().regex(/^\d{7}$/),
  state: z.enum(OZON_RUNTIME_CLAIM_JOB_STATES),
  source: z.enum(['MANUAL', 'AUTO']),
  taskKind: ozonPublishTaskKindSchema,
  taskId: z.string().trim().min(1).max(256),
  storeId: z.string().uuid(),
  storeAlias: ozonStoreAliasSchema,
  publicationId: z.string().uuid(),
  credentialVersionId: z.string().uuid().optional(),
  credentialBindingMode: z.enum(['VAULT', 'LEGACY_PUBLICATION']),
  storeConfigVersion: z.number().int().positive(),
  warehouseId: z.string().trim().min(1).max(128),
  offerContractHash: ozonRuntimeClaimHashSchema,
  materializationHash: ozonRuntimeClaimHashSchema,
  contentPolicyVersion: ozonContentPolicyVersionSchema.optional(),
  publicationContentPolicyVersion: ozonContentPolicyVersionSchema.optional(),
  materialHash: ozonSha256Schema.optional(),
  materialHashVersion: ozonSharedMaterialHashVersionSchema.optional(),
  publicationMaterialHash: ozonSha256Schema.optional(),
  publicationMaterialHashVersion: ozonSharedMaterialHashVersionSchema.optional(),
  planHash: ozonSha256Schema.optional(),
  presetRowVersion: z.number().int().positive().optional(),
  publicationMode: ozonStoreAutoPublishModeSchema.optional(),
  revision: z.number().int().positive(),
  offerIds: z.array(z.string().trim().min(1).max(256)).min(1).max(1_000),
  payload: z.record(z.string(), z.unknown()),
  stageStates: z.record(z.string(), z.unknown()),
  importTaskId: z.string().trim().min(1).max(256).optional(),
  ozonProductId: z.string().trim().min(1).max(256).optional(),
  ozonProductLinks: z.array(z.record(z.string(), z.unknown())).max(1_000),
  taskFolder: z.string().trim().min(1).max(256),
  workRelPath: z.string().trim().min(1).max(2_048),
  directoryStage: ozonRuntimeClaimDirectoryStageSchema,
  directorySignature: ozonRuntimeClaimHashSchema,
  rowVersion: z.number().int().positive(),
  leaseOwner: z.string().trim().min(1).max(256),
  leaseToken: z.string().uuid(),
  leaseExpiresAt: z.string().datetime(),
  retryCount: z.number().int().nonnegative(),
  lastErrorCode: z.string().trim().min(1).max(256).optional(),
  lastErrorMessage: z.string().trim().min(1).max(4_000).optional(),
  nextAttemptAt: z.string().datetime().optional()
}).strict().superRefine((value, context) => {
  if (value.taskKind === 'SHARED_PREPARATION') {
    context.addIssue({ code: 'custom', path: ['taskKind'], message: '共享准备协调任务不得进入 P002 平台发布 claim' });
  }
  if (value.taskKind === 'STORE_PUBLICATION') {
    for (const field of [
      'contentPolicyVersion', 'publicationContentPolicyVersion',
      'materialHash', 'materialHashVersion',
      'publicationMaterialHash', 'publicationMaterialHashVersion',
      'planHash', 'presetRowVersion', 'publicationMode'
    ] as const) {
      if (!value[field]) context.addIssue({ code: 'custom', path: [field], message: `新式店铺 publication claim 缺少冻结字段 ${field}` });
    }
    if (value.contentPolicyVersion !== value.publicationContentPolicyVersion) {
      context.addIssue({ code: 'custom', path: ['publicationContentPolicyVersion'], message: 'publication 数据库策略版本与 job 冻结版本不一致' });
    }
    if (value.materialHash !== value.publicationMaterialHash) {
      context.addIssue({ code: 'custom', path: ['publicationMaterialHash'], message: 'publication 数据库素材哈希与 job 冻结素材哈希不一致' });
    }
    if (value.materialHashVersion !== value.publicationMaterialHashVersion) {
      context.addIssue({ code: 'custom', path: ['publicationMaterialHashVersion'], message: 'publication 数据库素材哈希版本与 job 冻结版本不一致' });
    }
  }
  if (value.credentialBindingMode === 'VAULT' && !value.credentialVersionId) {
    context.addIssue({ code: 'custom', path: ['credentialVersionId'], message: 'VAULT claim 必须冻结 credentialVersionId' });
  }
  if (value.credentialBindingMode === 'LEGACY_PUBLICATION' && value.credentialVersionId) {
    context.addIssue({ code: 'custom', path: ['credentialVersionId'], message: 'LEGACY_PUBLICATION claim 不得携带 VAULT 凭据版本' });
  }
  if (value.credentialBindingMode === 'VAULT') {
    const expectedTaskId = `${value.storeAlias}__${value.sku}__r${value.revision}`;
    if (value.taskId !== expectedTaskId) {
      context.addIssue({ code: 'custom', path: ['taskId'], message: 'VAULT claim taskId 与 storeAlias/SKU/revision 不一致' });
    }
  }
  if (value.taskFolder !== `${value.sku}__r${value.revision}`) {
    context.addIssue({ code: 'custom', path: ['taskFolder'], message: 'claim taskFolder 与 SKU/revision 不一致' });
  }
  const payloadOfferContractHash = value.payload.offerContractHash;
  if (payloadOfferContractHash !== undefined && payloadOfferContractHash !== value.offerContractHash) {
    context.addIssue({ code: 'custom', path: ['payload', 'offerContractHash'], message: 'payload Offer 合同哈希与冻结 claim 不一致' });
  }
  const payloadOfferIds = value.payload.offerIds;
  if (payloadOfferIds !== undefined
    && (!Array.isArray(payloadOfferIds)
      || JSON.stringify(payloadOfferIds) !== JSON.stringify(value.offerIds))) {
    context.addIssue({ code: 'custom', path: ['payload', 'offerIds'], message: 'payload Offer 集合与冻结 claim 不一致' });
  }
  // offerContractHash is also the immutable publication binding hash. A lone
  // hash does not opt a normal schema-v3 publication into the older dual-set
  // contract. Once any semantic dual-set field is present, however, all five
  // semantic fields must be present and the hash must remain the claim hash.
  const dualSetFields = [
    'offerContractVersion',
    'expectedOfferIds',
    'submittedOfferIds',
    'publishOfferIds',
    'expectedOfferSnapshots'
  ] as const;
  const presentDualSetFields = dualSetFields.filter((field) => value.payload[field] !== undefined);
  const hashOnlySchemaV3Publication = value.payload.offerContractHash !== undefined
    && presentDualSetFields.length === 0
    && Number(value.payload.schemaVersion) >= 3
    && value.payload.mode === 'MULTISTORE_PUBLICATION';
  if (value.payload.offerContractHash !== undefined
    && presentDualSetFields.length === 0
    && !hashOnlySchemaV3Publication) {
    context.addIssue({ code: 'custom', path: ['payload'], message: '仅 schema-v3 多店 publication 允许独立 binding Offer 哈希' });
  }
  if (presentDualSetFields.length > 0 && presentDualSetFields.length !== dualSetFields.length) {
    context.addIssue({ code: 'custom', path: ['payload'], message: 'payload 双集合 Offer 合同字段不完整' });
  }
});

export const ozonRuntimeClaimResultSchema = z.object({
  items: z.array(ozonRuntimeClaimJobSchema).max(OZON_GLOBAL_CONCURRENCY_MAX),
  globalConcurrency: z.literal(OZON_GLOBAL_CONCURRENCY_DEFAULT),
  perStoreConcurrency: z.literal(OZON_PER_STORE_CONCURRENCY)
}).strict().superRefine((value, context) => {
  const storeIds = value.items.map((item) => item.storeId);
  if (new Set(storeIds).size !== storeIds.length) {
    context.addIssue({ code: 'custom', path: ['items'], message: '同一 claim 批次不得重复 storeId' });
  }
});

export const ozonRuntimePreflightClaimSchema = z.object({
  leaseOwner: z.string().trim().min(1).max(256),
  limit: z.number().int().min(1).max(50).default(10)
}).strict();

export const ozonRuntimeBindingSchema = z.object({
  storeId: z.string().uuid(),
  publicationId: z.string().uuid().optional(),
  credentialVersionId: z.string().uuid().optional(),
  credentialBindingMode: ozonCredentialBindingModeSchema,
  storeConfigVersion: z.number().int().positive(),
  warehouseId: z.string().trim().max(128),
  offerContractHash: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  materializationHash: z.string().regex(/^sha256:[a-f0-9]{64}$/).optional(),
  contentPolicyVersion: ozonContentPolicyVersionSchema,
  materialHash: ozonSha256Schema,
  materialHashVersion: ozonSharedMaterialHashVersionSchema
}).strict();

export const ozonRuntimeTransitionBindingSchema = ozonRuntimeBindingSchema.extend({
  rowVersion: z.number().int().positive(),
  leaseOwner: z.string().trim().min(1).max(256),
  leaseToken: z.string().uuid()
}).strict();

export const ozonIntakeVerifySchema = z.object({
  jobId: z.string().uuid(),
  taskId: z.string().trim().min(1).max(256),
  storeId: z.string().uuid(),
  storeAlias: ozonStoreAliasSchema,
  publicationId: z.string().uuid(),
  credentialVersionId: z.string().uuid().nullable(),
  credentialBindingMode: ozonCredentialBindingModeSchema,
  storeConfigVersion: z.number().int().positive(),
  warehouseId: z.string().trim().max(128),
  sku: z.string().regex(/^\d{7}$/),
  revision: z.number().int().positive(),
  productContentHash: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  materializationHash: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  contentPolicyVersion: ozonContentPolicyVersionSchema,
  materialHash: ozonSha256Schema,
  materialHashVersion: ozonSharedMaterialHashVersionSchema,
  planHash: ozonSha256Schema,
  presetRowVersion: z.number().int().positive(),
  publicationMode: ozonStoreAutoPublishModeSchema,
  offerContractHash: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  ticket: z.string().regex(/^hmac-sha256:[a-f0-9]{64}$/),
  rowVersion: z.number().int().positive(),
  leaseToken: z.string().uuid()
}).strict();

export type OzonCredentialBindingMode = z.infer<typeof ozonCredentialBindingModeSchema>;
export type OzonStoreCreate = z.infer<typeof ozonStoreCreateSchema>;
export type OzonStoreUpdate = z.infer<typeof ozonStoreUpdateSchema>;
export type OzonStoreCredentialInput = z.infer<typeof ozonStoreCredentialInputSchema>;
export type OzonStorePreflightDispatch = z.infer<typeof ozonStorePreflightDispatchSchema>;
export type OzonStorePreflightReport = z.infer<typeof ozonStorePreflightReportSchema>;
export type OzonRuntimeStorePreflightReportInput = z.infer<typeof ozonRuntimeStorePreflightReportInputSchema>;
export type OzonPublicationPlanInput = z.infer<typeof ozonPublicationPlanInputSchema>;
export type OzonPublicationCreateInput = z.infer<typeof ozonPublicationCreateInputSchema>;
export type OzonPublicationRecheckInput = z.infer<typeof ozonPublicationRecheckInputSchema>;
export type OzonPreparationRecheckPlanInput = z.infer<typeof ozonPreparationRecheckPlanInputSchema>;
export type OzonPreparationRecheckInput = z.infer<typeof ozonPreparationRecheckInputSchema>;
export type OzonPreparationManualSuccessReconcilePlanInput = z.infer<typeof ozonPreparationManualSuccessReconcilePlanInputSchema>;
export type OzonPreparationManualSuccessReconcileInput = z.infer<typeof ozonPreparationManualSuccessReconcileInputSchema>;
export type OzonFrozenContentBinding = z.infer<typeof ozonFrozenContentBindingSchema>;
export type OzonPublicationPlanItemAttemptIdentity = z.infer<typeof ozonPublicationPlanItemAttemptIdentitySchema>;
export type OzonGatewayRequest = z.infer<typeof ozonGatewayRequestSchema>;
export type OzonGatewayLegacyReceipt = z.infer<typeof ozonGatewayLegacyReceiptSchema>;
export type OzonGatewayDeliveryState = z.infer<typeof ozonGatewayDeliveryStateSchema>;
export type OzonGatewayRetryClass = z.infer<typeof ozonGatewayRetryClassSchema>;
export type OzonIntakeVerify = z.infer<typeof ozonIntakeVerifySchema>;
export type OzonRuntimePreflightClaim = z.infer<typeof ozonRuntimePreflightClaimSchema>;
export type OzonRuntimeClaimJob = z.infer<typeof ozonRuntimeClaimJobSchema>;
export type OzonRuntimeClaimResult = z.infer<typeof ozonRuntimeClaimResultSchema>;
export type OzonStoreSystemSettingsPatch = z.infer<typeof ozonStoreSystemSettingsPatchSchema>;

export type OzonStoreSystemSettings = {
  enabled: boolean;
  rootDirectory: string;
  timezone: string;
  globalConcurrency: number;
  perStoreConcurrency: 1;
  taskApiWebhookUrl: string;
  adminApiWebhookUrl: string;
  preflightWebhookUrl: string;
  imageUploaderWorkflowId: string;
  storeGatewayWorkflowId: string;
  imageUploadConcurrency: number;
  videoUploadConcurrency: number;
  videoPrewarmEnabled: boolean;
  videoUploadReady: boolean;
  /** Read-only capability: true only after the controlled P003 fleet contract is deployed. */
  publicationReadbackEnabled: boolean;
  videoUploadCheckedAt?: string;
  videoUploadMessage?: string;
  preflightTtlHours: 24;
  preflightDueHours: 18;
  rowVersion: number;
  createdAt: string;
  updatedAt: string;
};

export type OzonStoreReadiness = {
  ready: boolean;
  score: number;
  blockers: string[];
};

export type OzonStore = {
  id: string;
  storeAlias: string;
  displayName: string;
  enabled: boolean;
  autoPublishEnabled: boolean;
  autoPublishActivatedAt?: string;
  autoPublishMode: z.infer<typeof ozonStoreAutoPublishModeSchema>;
  defaultPresetId?: string;
  warehouseId: string;
  warehouseName: string;
  fulfillmentMode: z.infer<typeof ozonStoreFulfillmentModeSchema>;
  accountCurrency: z.infer<typeof ozonAccountCurrencySchema>;
  maxDailyStyles: number;
  credential: {
    state: z.infer<typeof ozonStoreCredentialStateSchema>;
    bindingMode: OzonCredentialBindingMode;
    configured: boolean;
    activeVersionId?: string;
    pendingVersionId?: string;
    fingerprint?: string;
    version?: number;
    updatedAt?: string;
  };
  seller: { id?: string; name?: string };
  permissions: string[];
  limits: Record<string, unknown>;
  warehouses: z.infer<typeof ozonStoreWarehouseSchema>[];
  preflight: {
    status: z.infer<typeof ozonStorePreflightStatusSchema>;
    currencyVerification?: z.infer<typeof ozonCurrencyVerificationSchema>['status'];
    currencyVerified: boolean;
    checkedAt?: string;
    expiresAt?: string;
    dueAt?: string;
    errorCode?: string;
    errorMessage?: string;
  };
  network: {
    status: z.infer<typeof ozonStoreNetworkStatusSchema>;
    nextAttemptAt?: string;
    errorCode?: string;
    errorMessage?: string;
  };
  readiness: OzonStoreReadiness;
  taskLoad: { running: number; queued: number };
  configVersion: number;
  rowVersion: number;
  createdAt: string;
  updatedAt: string;
  archivedAt?: string;
};

export type OzonPublicationPlanItem = OzonPublicationPlanItemAttemptIdentity & {
  storeId: string;
  storeAlias: string;
  displayName: string;
  presetId?: string;
  presetRowVersion?: number;
  presetDefinitionHash?: string;
  publicationMode: z.infer<typeof ozonStoreAutoPublishModeSchema>;
  ready: boolean;
  blockers: string[];
  errorCode?: string;
  errorDetails?: Record<string, unknown>;
  storeRowVersion: number;
  storeConfigVersion: number;
  credentialVersionId?: string;
  credentialBindingMode: OzonCredentialBindingMode;
  warehouseId: string;
  warehouseName: string;
  fulfillmentMode: z.infer<typeof ozonStoreFulfillmentModeSchema>;
  accountCurrency: z.infer<typeof ozonAccountCurrencySchema>;
  offerIds: string[];
  offerContractHash: string;
  materializationHash: string;
};

export type OzonVariantColorAuthority = {
  schemaVersion: 1;
  source: 'E001_REVIEW';
  hash: string;
  variants: Array<{
    productVariantId: string;
    itemKey: string;
    dictionaryId: number;
    valueId: number;
    nameRu: string;
    source: 'AUTO_EXACT_RU' | 'MANUAL_E001' | 'MANUAL_OZON';
  }>;
};

export type OzonPublicationPlan = {
  planHash: string;
  contentPolicyVersion: z.infer<typeof ozonContentPolicyVersionSchema>;
  materialHash: string;
  materialHashVersion: typeof OZON_SHARED_MATERIAL_HASH_VERSION;
  sourceMediaIdentityHash: string;
  variantColorAuthority: OzonVariantColorAuthority;
  sku: string;
  draftVersion: number;
  generatedVersionId: string;
  revision: number;
  createdAt: string;
  items: OzonPublicationPlanItem[];
};

export type OzonStorePublication = {
  id: string;
  sku: string;
  generatedVersionId: string;
  revision: number;
  storeId: string;
  storeAliasSnapshot: string;
  storeDisplayNameSnapshot: string;
  status: z.infer<typeof ozonStorePublicationStatusSchema>;
  source: 'MANUAL' | 'AUTOMATION';
  credentialBindingMode: OzonCredentialBindingMode;
  credentialVersionId?: string;
  storeConfigVersion: number;
  presetId?: string;
  presetRowVersion?: number;
  presetDefinitionHash?: string;
  presetDefinitionSnapshot?: Record<string, unknown>;
  publicationMode?: z.infer<typeof ozonStoreAutoPublishModeSchema>;
  preparationJobId?: string;
  plannedJobId?: string;
  requestId?: string;
  planHash?: string;
  contentPolicyVersion?: z.infer<typeof ozonContentPolicyVersionSchema> | 'LEGACY_UNKNOWN';
  materialHash?: string;
  materialHashVersion?: typeof OZON_SHARED_MATERIAL_HASH_VERSION;
  taskId?: string;
  warehouseId: string;
  warehouseName: string;
  fulfillmentMode: z.infer<typeof ozonStoreFulfillmentModeSchema>;
  accountCurrency: z.infer<typeof ozonAccountCurrencySchema>;
  offerIds: string[];
  offerContractHash: string;
  materializationHash: string;
  packageRelPath?: string;
  packageSignature?: string;
  productIds: string[];
  ozonSkus: string[];
  productLinks: string[];
  result: Record<string, unknown>;
  errorCode?: string;
  errorMessage?: string;
  rowVersion: number;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
};

export const OZON_SOURCE_MEDIA_CLEANUP_STATES = [
  'WAITING_TARGETS',
  'READY',
  'QUARANTINING',
  'QUARANTINED',
  'CLEANED',
  'SUPERSEDED',
  'RETRY_WAIT',
  'BLOCKED'
] as const;

export type OzonSourceMediaCleanupState = (typeof OZON_SOURCE_MEDIA_CLEANUP_STATES)[number];
export type OzonSourceMediaCleanupArtifactKind = 'RAW_INBOX' | 'SHARED_VERSION';

export type OzonSourceMediaCleanupArtifactSummary = {
  kind: OzonSourceMediaCleanupArtifactKind;
  state: OzonSourceMediaCleanupState;
  sourceRelPath: string;
  quarantineRelPath?: string;
  directorySignature?: string;
  mediaIdentityHash: string;
  fileCount: number;
  totalBytes: number;
  reclaimedBytes: number;
  cleanedAt?: string;
  blockedReason?: string;
};

export type OzonSourceMediaCleanupSummary = {
  cleanupId: string;
  generatedVersionId: string;
  sku: string;
  revision: number;
  source: 'MANUAL' | 'AUTOMATION' | 'HISTORICAL';
  state: OzonSourceMediaCleanupState;
  targetStoreCount: number;
  reclaimedBytes: number;
  artifacts: OzonSourceMediaCleanupArtifactSummary[];
  blockedReason?: string;
  cleanedAt?: string;
  createdAt: string;
  updatedAt: string;
};

export type OzonPublicationTaskSummary = {
  publicationId: string;
  jobId?: string;
  taskId?: string;
  sku: string;
  generatedVersionId: string;
  revision: number;
  planHash?: string;
  storeId: string;
  storeAlias: string;
  storeDisplayName: string;
  status: z.infer<typeof ozonStorePublicationStatusSchema>;
  publicationMode?: z.infer<typeof ozonStoreAutoPublishModeSchema>;
  presetBinding?: {
    presetId: string;
    presetName?: string;
    presetRowVersion?: number;
    sourcePresetExists: boolean;
  };
  offerIds: string[];
  productLinks: OzonProductLink[];
  legacyProductUrls: string[];
  linkWarning?: string;
  errorCode?: string;
  errorMessage?: string;
  rowVersion: number;
  createdAt: string;
  updatedAt: string;
  currentMaterialRevision?: number;
  currentGeneratedVersionId?: string;
  sourceMediaCleanup?: OzonSourceMediaCleanupSummary;
  capabilities: {
    canOpenWorkspace: true;
    canRepublish: boolean;
    canCompatibleAppend: boolean;
    blockedReason?: string;
  };
};

export type OzonPublicationAttemptResult = z.infer<typeof ozonPublicationAttemptResultSchema>;

export type OzonPublicationCreateResult = {
  publications: OzonStorePublication[];
  results: OzonPublicationAttemptResult[];
  accepted: number;
  failed: number;
};

export type OzonPublicationFrozenContract = {
  storeConfigVersion: number;
  credentialVersionId?: string;
  presetId?: string;
  presetRowVersion?: number;
  presetDefinitionHash?: string;
  presetDefinitionSnapshot?: Record<string, unknown>;
  warehouseId: string;
  fulfillmentMode: z.infer<typeof ozonStoreFulfillmentModeSchema>;
  accountCurrency: z.infer<typeof ozonAccountCurrencySchema>;
  publicationMode?: z.infer<typeof ozonStoreAutoPublishModeSchema>;
  contentPolicyVersion?: z.infer<typeof ozonContentPolicyVersionSchema> | 'LEGACY_UNKNOWN';
  materialHash?: string;
  materialHashVersion?: typeof OZON_SHARED_MATERIAL_HASH_VERSION;
  materializationHash: string;
  planHash?: string;
  requestId?: string;
};

export type OzonPublicationTaskDetail = {
  publication: OzonStorePublication;
  job?: OzonPublishJob;
  events: OzonPublishEvent[];
  frozenContract: OzonPublicationFrozenContract;
  readback?: Record<string, unknown>;
  recovery: {
    canRecheck: boolean;
    canManualTakeover: boolean;
    recoveryMode: 'NONE' | 'RECHECK' | 'MANUAL_TAKEOVER' | 'READBACK_REQUIRED';
    blockedReason?: string;
  };
  sourceMediaCleanup?: OzonSourceMediaCleanupSummary;
};

export type OzonPreparationRecoveryCapability = {
  canRecheck: boolean;
  canManualTakeover: boolean;
  canReconcileManualSuccess?: boolean;
  recoveryMode: 'NONE' | 'RECHECK' | 'REPLAN_WITH_CURRENT_PRESET' | 'MANUAL_TAKEOVER' | 'MANUAL_SUCCESS_RECONCILE' | 'READBACK_REQUIRED';
  blockedReason?: string;
};

export type OzonPreparationManualSuccessReconcileTarget = {
  storeId: string;
  storeAlias: string;
  storeDisplayName: string;
  publicationId: string;
  publicationRowVersion: number;
  manualJobId: string;
  manualJobRowVersion: number;
  offerIds: string[];
  productLinks: OzonProductLink[];
  completedAt: string;
};

export type OzonPreparationManualSuccessReconcilePlan = OzonPreparationRecoveryCapability & {
  rowVersion: number;
  listingRowVersion: number;
  listingRevision: number;
  eligibilityAt: string;
  planHash: string;
  requestId: string;
  targetStores: OzonPreparationManualSuccessReconcileTarget[];
  blockers: string[];
};

export type OzonPreparationManualSuccessReconcileResult = {
  job: OzonPublishJob;
  reconciliation: {
    requestId: string;
    planHash: string;
    appliedAt: string;
    targetStores: OzonPreparationManualSuccessReconcileTarget[];
  };
};

export type OzonPreparationRecheckPlan = OzonPreparationRecoveryCapability & {
  rowVersion: number;
  planHash: string;
  requestId: string;
  frozen: Record<string, unknown>;
};

export type OzonPreparationTaskDetail = {
  job: OzonPublishJob;
  events: OzonPublishEvent[];
  fanoutSummary: OzonPreparationFanoutSummary;
  frozenContract: Record<string, unknown>;
  recovery: OzonPreparationRecoveryCapability;
  manualSuccessReconcilePlan?: OzonPreparationManualSuccessReconcilePlan;
  materialSnapshot?: OzonListingDraft & { generatedVersionId?: string };
  sourceMediaCleanup?: OzonSourceMediaCleanupSummary;
};

/**
 * Read-only evidence returned when the operator opens listing material from an
 * automatic, store-scoped task. The listing is the immutable generated-version
 * snapshot; account-currency prices are kept separate so consumers must merge
 * them by offerId instead of trusting the store-neutral draft prices.
 */
export type OzonAutomaticListingSnapshot = {
  mode: 'AUTO_TASK_SNAPSHOT';
  readOnly: true;
  jobId: string;
  publicationId: string;
  generatedVersionId: string;
  sku: string;
  revision: number;
  store: {
    id: string;
    storeAlias: string;
    displayName: string;
    accountCurrency: z.infer<typeof ozonAccountCurrencySchema>;
    currentAccountCurrency?: z.infer<typeof ozonAccountCurrencySchema>;
    accountCurrencyChanged: boolean;
  };
  listing: OzonListingDraft & { generatedVersionId: string };
  pricing: {
    currency: z.infer<typeof ozonAccountCurrencySchema>;
    offers: Array<{
      offerId: string;
      price: number;
      oldPrice?: number;
      minPrice?: number;
    }>;
  };
};

export type OzonGatewayResponse = {
  ok: boolean;
  operation: string;
  requestRef: string;
  deliveryState: OzonGatewayDeliveryState;
  retryClass: OzonGatewayRetryClass;
  retryAfterMs?: number;
  statusCode?: number;
  result: unknown;
  error?: { code: string; message: string };
  idempotent?: boolean;
};
