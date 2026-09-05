import { z } from 'zod';
import { wbAutoPublishModeSchema } from './wb.js';

export const WB_DEFAULT_STORE_ID = '00000000-0000-4000-8000-000000000001' as const;
export const WB_DEFAULT_STORE_ALIAS = 'default' as const;
export const WB_GLOBAL_CONCURRENCY_MAX = 2 as const;
export const WB_PER_STORE_CONCURRENCY = 1 as const;

export const wbStoreAliasSchema = z.string().trim().min(2).max(32)
  .regex(/^[a-z0-9][a-z0-9-]*$/, '店铺别名只能包含小写字母、数字和连字符');

export const wbSystemSettingsPatchSchema = z.object({
  enabled: z.boolean().optional(),
  rootDirectory: z.string().trim().max(2_048).optional(),
  timezone: z.string().trim().min(1).max(64).optional(),
  globalConcurrency: z.number().int().min(1).max(WB_GLOBAL_CONCURRENCY_MAX).optional(),
  rowVersion: z.number().int().positive()
}).strict();

const wbStoreEditableFields = {
  displayName: z.string().trim().min(1).max(128),
  autoPublishEnabled: z.boolean().default(false),
  autoPublishMode: wbAutoPublishModeSchema.default('CREATE_ONLY'),
  defaultPresetId: z.string().uuid().nullable().optional(),
  warehouseId: z.string().trim().max(128).default(''),
  warehouseName: z.string().trim().max(256).default(''),
  accountCurrency: z.string().trim().length(3).regex(/^[A-Z]{3}$/).default('CNY'),
  maxDailyStyles: z.number().int().min(1).max(100_000).default(100)
};

export const wbStoreCreateSchema = z.object({
  storeAlias: wbStoreAliasSchema,
  ...wbStoreEditableFields
}).strict();

export const wbStoreUpdateSchema = z.object({
  displayName: wbStoreEditableFields.displayName.optional(),
  autoPublishEnabled: z.boolean().optional(),
  autoPublishMode: wbAutoPublishModeSchema.optional(),
  defaultPresetId: z.string().uuid().nullable().optional(),
  warehouseId: z.string().trim().max(128).optional(),
  warehouseName: z.string().trim().max(256).optional(),
  accountCurrency: z.string().trim().length(3).regex(/^[A-Z]{3}$/).optional(),
  maxDailyStyles: z.number().int().min(1).max(100_000).optional(),
  rowVersion: z.number().int().positive()
}).strict();

export const wbStoreCredentialInputSchema = z.object({
  token: z.string().trim().min(20).max(16_384),
  rowVersion: z.number().int().positive()
}).strict();

export const wbStoreMutationSchema = z.object({
  rowVersion: z.number().int().positive()
}).strict();

export const wbStorePreflightReportSchema = z.object({
  ok: z.boolean(),
  sellerId: z.string().trim().max(256).optional(),
  sellerName: z.string().trim().max(256).optional(),
  permissions: z.array(z.string().trim().min(1).max(128)).max(100).default([]),
  accountCurrency: z.string().trim().length(3).regex(/^[A-Z]{3}$/).optional(),
  warehouses: z.array(z.object({
    id: z.string().trim().min(1).max(128),
    name: z.string().trim().max(256).default('')
  }).strict()).max(1_000).default([]),
  errorCode: z.string().trim().max(128).optional(),
  errorMessage: z.string().trim().max(4_000).optional(),
  checkedAt: z.string().datetime().optional(),
  details: z.record(z.string(), z.unknown()).default({})
}).strict();

export const wbRuntimeStorePreflightReportInputSchema = z.object({
  report: wbStorePreflightReportSchema,
  storeConfigVersion: z.number().int().positive(),
  credentialVersionId: z.string().uuid()
}).strict();

export const wbPublicationStoreSelectionSchema = z.object({
  storeId: z.string().uuid()
}).strict();

export const wbPublicationPlanInputSchema = z.object({
  draftVersion: z.number().int().positive(),
  stores: z.array(wbPublicationStoreSelectionSchema).min(1).max(100)
    .refine((items) => new Set(items.map((item) => item.storeId)).size === items.length, '不能重复选择同一店铺')
}).strict();

export const wbPublicationCreateInputSchema = wbPublicationPlanInputSchema.extend({
  planHash: z.string().regex(/^sha256:[a-f0-9]{64}$/)
}).strict();

export const wbGatewayDeliveryStateSchema = z.enum(['NOT_SENT', 'UNKNOWN', 'RESPONDED']);
export const wbGatewayRetryClassSchema = z.enum(['NONE', 'READBACK_REQUIRED', 'RETRYABLE', 'PERMANENT']);
export const wbGatewayRequestSchema = z.object({
  taskId: z.string().trim().min(1).max(256).optional(),
  storeId: z.string().uuid().optional(),
  requestRef: z.string().trim().min(1).max(256),
  operation: z.string().trim().min(1).max(128),
  logicalIntentId: z.string().trim().min(1).max(256).optional(),
  attemptNo: z.number().int().min(1).max(2147483647).optional(),
  payload: z.record(z.string(), z.unknown()).default({})
}).strict().superRefine((value, context) => {
  if (!value.taskId && !value.storeId) {
    context.addIssue({ code: 'custom', path: ['taskId'], message: 'taskId 与 storeId 至少提供一个' });
  }
  if ((value.logicalIntentId === undefined) !== (value.attemptNo === undefined)) {
    context.addIssue({ code: 'custom', path: ['logicalIntentId'], message: 'logicalIntentId 与 attemptNo 必须同时提供' });
  }
});

export type WbSystemSettingsPatch = z.infer<typeof wbSystemSettingsPatchSchema>;
export type WbStoreCreate = z.infer<typeof wbStoreCreateSchema>;
export type WbStoreUpdate = z.infer<typeof wbStoreUpdateSchema>;
export type WbStoreCredentialInput = z.infer<typeof wbStoreCredentialInputSchema>;
export type WbStorePreflightReport = z.infer<typeof wbStorePreflightReportSchema>;
export type WbRuntimeStorePreflightReportInput = z.infer<typeof wbRuntimeStorePreflightReportInputSchema>;
export type WbPublicationPlanInput = z.infer<typeof wbPublicationPlanInputSchema>;
export type WbPublicationCreateInput = z.infer<typeof wbPublicationCreateInputSchema>;
export type WbGatewayRequest = z.infer<typeof wbGatewayRequestSchema>;
export type WbGatewayDeliveryState = z.infer<typeof wbGatewayDeliveryStateSchema>;
export type WbGatewayRetryClass = z.infer<typeof wbGatewayRetryClassSchema>;

export type WbSystemSettings = {
  enabled: boolean;
  rootDirectory: string;
  timezone: string;
  globalConcurrency: number;
  perStoreConcurrency: 1;
  rowVersion: number;
  createdAt: string;
  updatedAt: string;
};

export type WbStoreReadiness = { ready: boolean; blockers: string[] };
export type WbStore = {
  id: string;
  storeAlias: string;
  displayName: string;
  enabled: boolean;
  autoPublishEnabled: boolean;
  autoPublishActivatedAt?: string;
  autoPublishMode: z.infer<typeof wbAutoPublishModeSchema>;
  defaultPresetId?: string;
  warehouseId: string;
  warehouseName: string;
  accountCurrency: string;
  maxDailyStyles: number;
  credential: {
    state: 'MISSING' | 'LEGACY_EXTERNAL' | 'PENDING' | 'ACTIVE';
    configured: boolean;
    activeVersionId?: string;
    pendingVersionId?: string;
    fingerprint?: string;
    version?: number;
    updatedAt?: string;
  };
  seller: { id?: string; name?: string };
  permissions: string[];
  preflight: {
    status: 'NOT_RUN' | 'PENDING' | 'PASSED' | 'FAILED' | 'STALE';
    currencyVerification?: 'VERIFIED' | 'DEFERRED_EMPTY_CATALOG';
    currencyVerified?: boolean;
    checkedAt?: string;
    errorCode?: string;
    errorMessage?: string;
  };
  network: { status: 'READY' | 'WAITING' | 'ERROR'; nextAttemptAt?: string; errorCode?: string; errorMessage?: string };
  readiness: WbStoreReadiness;
  activeTaskCount: number;
  queuedTaskCount: number;
  configVersion: number;
  rowVersion: number;
  createdAt: string;
  updatedAt: string;
  archivedAt?: string;
};

export type WbPublicationPlanItem = {
  storeId: string;
  storeAlias: string;
  displayName: string;
  presetId?: string;
  presetName?: string;
  presetDefinitionHash: string;
  materializationHash: string;
  discountPercent?: number;
  expectedPriceCny?: number;
  categoryKey?: string;
  categoryName?: string;
  packaging?: { grossWeightGrams: number; lengthCm: number; widthCm: number; heightCm: number };
  autoPublishMode: z.infer<typeof wbAutoPublishModeSchema>;
  ready: boolean;
  blockers: string[];
  storeRowVersion: number;
  storeConfigVersion: number;
  credentialVersionId?: string;
  warehouseId: string;
};

export type WbPublicationPlan = {
  planHash: string;
  sku: string;
  draftVersion: number;
  createdAt: string;
  items: WbPublicationPlanItem[];
};

export type WbStorePublication = {
  id: string;
  sku: string;
  generatedVersionId: string;
  storeId: string;
  storeAlias: string;
  storeDisplayName?: string;
  status: 'PLANNED' | 'DISPATCHING' | 'QUEUED' | 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'NEEDS_ATTENTION' | 'PAUSED';
  source: 'MANUAL' | 'AUTOMATION';
  taskId?: string;
  revision: number;
  presetId?: string;
  presetName?: string;
  presetRowVersion?: number;
  operationMode?: z.infer<typeof wbAutoPublishModeSchema>;
  draftVersion?: number;
  sourcePresetExists?: boolean;
  presetDefinitionHash: string;
  planHash?: string;
  materializationHash?: string;
  packageRelPath?: string;
  packageSignature?: string;
  configSnapshot: Record<string, unknown>;
  credentialVersionId?: string;
  nmIds: Array<string | number>;
  productUrls: string[];
  productLinks?: Array<{ nmId: string; url: string; variantCode?: string }>;
  result: Record<string, unknown>;
  errorCode?: string;
  errorMessage?: string;
  rowVersion: number;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
};

export type WbGatewayResponse = {
  ok: boolean;
  statusCode: number;
  body: unknown;
  deliveryState: WbGatewayDeliveryState;
  retryClass: WbGatewayRetryClass;
  retryAfterMs?: number;
  requestRef: string;
  idempotent?: boolean;
};
