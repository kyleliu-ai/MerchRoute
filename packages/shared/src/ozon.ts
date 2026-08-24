import { z } from 'zod';
import {
  OZON_DESCRIPTION_MAX_LENGTH,
  OZON_DESCRIPTION_MAX_LENGTH_SOURCE,
  OZON_CONTENT_POLICY_VERSION,
  OZON_CONTENT_POLICY_V2,
  OZON_CONTENT_POLICY_V3,
  OZON_EXECUTABLE_CONTENT_POLICY_VERSIONS,
  OZON_LEGACY_UNKNOWN_CONTENT_POLICY_VERSION,
  OZON_TITLE_MAX_LENGTH,
  type OzonContentPolicyVersion,
  type OzonStoredContentPolicyVersion,
  hasOzonCjk,
  hasOzonInvalidPlatformCharacters,
  validateOzonDescription,
  validateOzonTitle
} from './ozon-content-policy.js';

export {
  OZON_DESCRIPTION_MAX_LENGTH,
  OZON_DESCRIPTION_MAX_LENGTH_SOURCE,
  OZON_CONTENT_POLICY_VERSION,
  OZON_CONTENT_POLICY_V2,
  OZON_CONTENT_POLICY_V3,
  OZON_EXECUTABLE_CONTENT_POLICY_VERSIONS,
  OZON_LEGACY_UNKNOWN_CONTENT_POLICY_VERSION,
  OZON_TITLE_MAX_LENGTH,
  hasOzonCjk,
  hasOzonInvalidPlatformCharacters,
  validateOzonDescription,
  validateOzonTitle
};

export const OZON_SHARED_MATERIAL_HASH_VERSION = 'ozon-shared-material-v1' as const;
export const ozonContentPolicyVersionSchema = z.enum(OZON_EXECUTABLE_CONTENT_POLICY_VERSIONS);
export const ozonStoredContentPolicyVersionSchema = z.union([
  ozonContentPolicyVersionSchema,
  z.literal(OZON_LEGACY_UNKNOWN_CONTENT_POLICY_VERSION)
]);
export const ozonSharedMaterialHashVersionSchema = z.literal(OZON_SHARED_MATERIAL_HASH_VERSION);
export const ozonSha256Schema = z.string().regex(/^sha256:[a-f0-9]{64}$/);

export const OZON_LISTING_STATUSES = [
  'DRAFT',
  'READY',
  'SUBMITTING',
  'IMPORTED',
  'MODERATING',
  'PUBLISHED',
  'NEEDS_ATTENTION',
  'FAILED',
  'CANCELLED'
] as const;

export const OZON_PUBLISH_JOB_STATES = [
  'WAITING_MEDIA',
  'READY',
  'UPLOADING_MEDIA',
  'SUBMITTING',
  'IMPORTING',
  'VERIFYING_IMAGES',
  'UPDATING_PRICE',
  'UPDATING_STOCK',
  'MODERATING',
  'SUCCEEDED',
  'NEEDS_ATTENTION',
  'FAILED',
  'CANCELLED'
] as const;

export const OZON_PUBLISH_TASK_KINDS = [
  'SHARED_PREPARATION',
  'STORE_PUBLICATION',
  'LEGACY'
] as const;
export const OZON_PREPARATION_FANOUT_PHASES = [
  'NOT_STARTED',
  'PLANNED',
  'MATERIALIZING',
  'PARTIAL',
  'COMPLETED',
  'NEEDS_ATTENTION',
  'CANCELLED'
] as const;
export const OZON_PREPARATION_RECOVERY_MODES = [
  'NONE',
  'RECHECK',
  'REPLAN_WITH_CURRENT_PRESET',
  'MANUAL_TAKEOVER',
  'READBACK_REQUIRED'
] as const;
export const ozonPublishTaskKindSchema = z.enum(OZON_PUBLISH_TASK_KINDS);
export const ozonPreparationFanoutSummarySchema = z.object({
  phase: z.enum(OZON_PREPARATION_FANOUT_PHASES),
  targetStoreCount: z.number().int().nonnegative(),
  publicationCount: z.number().int().nonnegative(),
  failureCount: z.number().int().nonnegative(),
  canRecheck: z.boolean(),
  canManualTakeover: z.boolean(),
  recoveryMode: z.enum(OZON_PREPARATION_RECOVERY_MODES),
  blockedReason: z.string().trim().min(1).max(4_000).optional()
}).strict().superRefine((value, context) => {
  if (value.publicationCount > value.targetStoreCount || value.failureCount > value.targetStoreCount) {
    context.addIssue({ code: 'custom', message: 'fan-out 计数不能超过目标店铺数' });
  }
  if (value.phase === 'COMPLETED'
    && (value.publicationCount !== value.targetStoreCount || value.failureCount !== 0)) {
    context.addIssue({ code: 'custom', path: ['phase'], message: 'COMPLETED 必须已为全部目标店铺创建 publication 且没有失败' });
  }
  if (value.recoveryMode === 'READBACK_REQUIRED' && value.canRecheck) {
    context.addIssue({ code: 'custom', path: ['canRecheck'], message: '需要平台回读时禁止直接重检写入' });
  }
});

export const OZON_CATEGORY_VERSION_STATUSES = ['DRAFT', 'PUBLISHED', 'ARCHIVED'] as const;
export const OZON_CATALOG_STATUSES = ['EMPTY', 'SYNCING', 'READY', 'STALE', 'FAILED'] as const;
export const OZON_CATALOG_TRIGGERS = ['MANUAL', 'SCHEDULED', 'STARTUP'] as const;
export const OZON_CATALOG_DICTIONARIES = ['countries', 'seasons', 'kinds', 'colors'] as const;
export const OZON_FULFILLMENT_MODES = ['FBS', 'RFBS'] as const;
export const OZON_VAT_RATES = ['0', '0.05', '0.07', '0.1', '0.2', '0.22'] as const;
export const OZON_AUTO_PUBLISH_MODES = ['CREATE_ONLY', 'COMPATIBLE_UPSERT'] as const;
export const OZON_VIDEO_PUBLISH_MODES = ['INTRO_AND_COVER', 'COVER_ONLY'] as const;
export const OZON_SIZE_MODES = ['sized', 'sizeless'] as const;
export const OZON_TITLE_TRANSLATION_WORKFLOW_ID = 'HDh0ZNLK2ps5qasR';
export const OZON_TITLE_TRANSLATION_WEBHOOK_PATH = '/webhook/ozon/translation-title';
export const OZON_SYSTEM_MEDIA_ATTRIBUTE_IDS = [21837, 21841, 21845, 22273] as const;
export const OZON_MANUAL_PURCHASE_ATTRIBUTE_BINDINGS = [
  {
    attributeId: 5299,
    purchaseField: 'productHeightCm',
    labelZh: '物体高度，厘米',
    labelRu: 'Высота, см',
    unit: 'cm'
  },
  {
    attributeId: 6573,
    purchaseField: 'productDepthCm',
    labelZh: '物体深度，厘米',
    labelRu: 'Глубина, см',
    unit: 'cm'
  },
  {
    attributeId: 5355,
    purchaseField: 'productWidthCm',
    labelZh: '物体宽度，厘米',
    labelRu: 'Ширина, см',
    unit: 'cm'
  },
  {
    attributeId: 4383,
    purchaseField: 'netWeightGrams',
    labelZh: '商品重量，克',
    labelRu: 'Вес товара, г',
    unit: 'g'
  }
] as const;
export const OZON_MANUAL_PURCHASE_ATTRIBUTE_IDS = OZON_MANUAL_PURCHASE_ATTRIBUTE_BINDINGS
  .map((binding) => binding.attributeId);

const ozonSystemMediaAttributeIdSet = new Set<number>(OZON_SYSTEM_MEDIA_ATTRIBUTE_IDS);

export function isOzonSystemMediaAttributeId(attributeId: unknown): boolean {
  return Number.isInteger(Number(attributeId)) && ozonSystemMediaAttributeIdSet.has(Number(attributeId));
}

export const ozonCategoryKeySchema = z.string()
  .trim()
  .min(2)
  .max(96)
  .regex(/^[a-z0-9][a-z0-9_-]*$/, '类目 Key 只能包含小写字母、数字、下划线和连字符');

export const ozonAttributeValueSchema = z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.array(z.union([z.string(), z.number()])).min(1)
]);

export const ozonAttributeValueInputSchema = z.object({
  attributeId: z.number().int().positive(),
  complexId: z.number().int().nonnegative().default(0),
  values: z.array(z.object({
    dictionaryValueId: z.number().int().nonnegative().optional(),
    value: z.string().trim().max(4_000).optional()
  }).superRefine((entry, context) => {
    if (!entry.dictionaryValueId && !entry.value) {
      context.addIssue({ code: 'custom', message: '属性值必须提供字典值 ID 或文本值' });
    }
  })).min(1)
});

const ozonManualPurchaseMeasurementValueSchema = z.string()
  .regex(/^(?:0|[1-9]\d*)(?:\.\d+)?$/, '采购尺寸或净重必须是规范化十进制数值')
  .refine((value) => Number.isFinite(Number(value)) && Number(value) > 0, '采购尺寸或净重必须大于 0')
  .nullable();

export const ozonManualPurchaseMeasurementsSchema = z.object({
  procurementVersionId: z.string().uuid(),
  procurementVersionNo: z.number().int().positive(),
  capturedAt: z.string().datetime(),
  productHeightCm: ozonManualPurchaseMeasurementValueSchema,
  productDepthCm: ozonManualPurchaseMeasurementValueSchema,
  productWidthCm: ozonManualPurchaseMeasurementValueSchema,
  netWeightGrams: ozonManualPurchaseMeasurementValueSchema
});

export const ozonCategoryAttributeSchema = z.object({
  id: z.number().int().positive(),
  name: z.string().trim().min(1).max(256),
  nameRu: z.string().trim().max(256).optional(),
  nameZh: z.string().trim().max(256).optional(),
  description: z.string().trim().max(2_000).default(''),
  type: z.enum(['String', 'Integer', 'Decimal', 'Boolean', 'Dictionary', 'Image', 'URL', 'Unknown']).default('Unknown'),
  required: z.boolean().default(false),
  dictionaryId: z.number().int().nonnegative().default(0),
  maxCount: z.number().int().positive().default(1),
  groupId: z.number().int().nonnegative().default(0),
  groupName: z.string().trim().max(256).default(''),
  complexId: z.number().int().nonnegative().default(0),
  isCollection: z.boolean().default(false)
});

export const ozonCategorySizingSchema = z.object({
  sizeMode: z.enum(OZON_SIZE_MODES).default('sizeless'),
  sizeAttributeKey: z.string().trim().regex(/^\d+:\d+$/, 'OZON 尺码属性唯一键格式无效').nullish()
}).superRefine((value, context) => {
  if (value.sizeMode === 'sized' && !value.sizeAttributeKey) {
    context.addIssue({ code: 'custom', path: ['sizeAttributeKey'], message: '有尺码类目必须选择 OZON 尺码属性' });
  }
  if (value.sizeMode === 'sizeless' && value.sizeAttributeKey) {
    context.addIssue({ code: 'custom', path: ['sizeAttributeKey'], message: '无尺码类目不能保留尺码属性' });
  }
});

const OZON_SIZE_NAME_ZH = /(?:尺码|鞋码|号型)/u;
const OZON_SIZE_NAME_RU = /(?:^|\s)размер(?:\s|$)/iu;

export function isOzonCategorySizeAttribute(attribute: Pick<z.infer<typeof ozonCategoryAttributeSchema>, 'id' | 'complexId' | 'name' | 'nameRu' | 'nameZh' | 'type'>): boolean {
  if (attribute.complexId !== 0) return false;
  if (attribute.type === 'Image' || attribute.type === 'URL' || isOzonSystemMediaAttributeId(attribute.id)) return false;
  const nameZh = String(attribute.nameZh || '');
  const nameRu = String(attribute.nameRu || attribute.name || '');
  return OZON_SIZE_NAME_ZH.test(nameZh) || OZON_SIZE_NAME_RU.test(nameRu);
}

export function ozonCategorySizeAttributeCandidates<T extends Pick<z.infer<typeof ozonCategoryAttributeSchema>, 'id' | 'complexId' | 'name' | 'nameRu' | 'nameZh' | 'type' | 'required' | 'dictionaryId'>>(attributes: readonly T[]): T[] {
  return attributes.filter(isOzonCategorySizeAttribute).sort((left, right) => {
    const leftScore = (left.required ? 0 : 2) + (left.dictionaryId ? 0 : 1);
    const rightScore = (right.required ? 0 : 2) + (right.dictionaryId ? 0 : 1);
    return leftScore - rightScore;
  });
}

export function inferOzonCategorySizing(attributes: readonly z.infer<typeof ozonCategoryAttributeSchema>[]): z.infer<typeof ozonCategorySizingSchema> {
  const required = ozonCategorySizeAttributeCandidates(attributes).find((attribute) => attribute.required);
  return required
    ? { sizeMode: 'sized', sizeAttributeKey: `${required.id}:${required.complexId}` }
    : { sizeMode: 'sizeless' };
}

export const ozonCategoryAttributeOrderInputSchema = z.object({
  rowVersion: z.number().int().positive(),
  defaultVideoUploadMode: z.enum(['ORIGINAL', 'COMPRESSED_COPY']).default('COMPRESSED_COPY'),
  // Optional only for compatibility with an older served bundle. The server
  // preserves the snapshot's current rule when this field is absent.
  sizing: ozonCategorySizingSchema.optional(),
  attributeKeys: z.array(
    z.string().trim().regex(/^\d+:\d+$/, 'OZON 属性唯一键格式无效')
  ).max(1_000)
}).superRefine((value, context) => {
  if (new Set(value.attributeKeys).size !== value.attributeKeys.length) {
    context.addIssue({ code: 'custom', path: ['attributeKeys'], message: 'OZON 属性顺序中不能包含重复项' });
  }
});

export const ozonCategoryTemplateInputSchema = z.object({
  categoryKey: ozonCategoryKeySchema,
  nameRu: z.string().trim().min(1).max(256),
  nameZh: z.string().trim().max(256).default(''),
  descriptionCategoryId: z.number().int().positive(),
  typeId: z.number().int().positive(),
  attributes: z.array(ozonCategoryAttributeSchema).default([]),
  dictionarySnapshot: z.record(z.array(z.object({
    id: z.number().int().nonnegative(),
    value: z.string().trim().min(1).max(1_000),
    info: z.string().trim().max(1_000).optional(),
    valueRu: z.string().trim().max(1_000).optional(),
    valueZh: z.string().trim().max(1_000).optional()
  }))).default({}),
  media: z.object({
    defaultVideoUploadMode: z.enum(['ORIGINAL', 'COMPRESSED_COPY']).default('COMPRESSED_COPY')
  }).default({ defaultVideoUploadMode: 'COMPRESSED_COPY' }),
  sizing: ozonCategorySizingSchema.default({ sizeMode: 'sizeless' }),
  sourceSnapshot: z.unknown().optional(),
  confirmedBy: z.string().trim().max(128).default('')
});

export const ozonCategoryFromCatalogInputSchema = z.object({
  catalogEntryId: z.string().trim().regex(/^\d+:\d+$/, 'OZON 本地类目录项格式无效')
});

export const ozonDimensionsSchema = z.object({
  length: z.number().positive(),
  width: z.number().positive(),
  height: z.number().positive(),
  dimensionUnit: z.enum(['mm', 'cm', 'in']).default('mm'),
  weight: z.number().positive(),
  weightUnit: z.enum(['g', 'kg', 'lb']).default('g')
});

export const ozonMediaReferenceSchema = z.object({
  assetId: z.string().trim().min(1).max(256),
  relativePath: z.string().trim().min(1).max(2_000),
  kind: z.enum(['image', 'video']).default('image'),
  sortOrder: z.number().int().min(0).max(19),
  isPrimary: z.boolean().default(false)
});

export const ozonMediaAssetSchema = z.object({
  assetId: z.string().trim().min(1).max(256),
  relativePath: z.string().trim().min(1).max(2_000),
  kind: z.enum(['image', 'video']),
  sortOrder: z.number().int().min(0).optional(),
  mimeType: z.string().trim().min(1).max(128),
  sizeBytes: z.number().int().positive(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  modifiedAt: z.string().datetime(),
  validationStatus: z.enum(['VALID', 'INVALID']),
  validationError: z.string().trim().max(1_000).optional(),
  productVariantId: z.string().uuid().optional(),
  productVariantName: z.string().trim().max(256).optional(),
  productVariantColor: z.object({
    colorKey: z.string().regex(/^[a-f0-9]{64}$/),
    nameRu: z.string().trim().min(1).max(256),
    nameZh: z.string().trim().min(1).max(256)
  }).optional(),
  sourceStageId: z.enum(['E004', 'E005']).optional(),
  sourceSubmissionId: z.string().trim().max(256).optional(),
  deliveredAt: z.string().datetime().optional(),
  durationSeconds: z.number().positive().optional()
});

export const ozonProductMediaAssetSchema = ozonMediaAssetSchema.pick({
  assetId: true,
  relativePath: true,
  kind: true,
  mimeType: true,
  sizeBytes: true,
  sha256: true,
  durationSeconds: true
});

export const ozonDescriptionSourceSchema = z.object({
  type: z.enum(['E003', 'MANUAL', 'SHARED']),
  workflowCode: z.literal('E003').optional(),
  executionId: z.number().int().positive().optional(),
  fileName: z.string().trim().max(512).optional(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  productVariantId: z.string().uuid().optional()
});

export const ozonPresetSizeSchema = z.object({
  sizeId: z.string().uuid().optional(),
  value: z.string().trim().max(256).default(''),
  stock: z.number().int().nonnegative().default(0)
});

const ozonPresetDefinitionShape = {
  name: z.string().trim().min(1).max(128),
  description: z.string().trim().max(1_000).default(''),
  categoryKey: ozonCategoryKeySchema,
  pricingTemplateId: z.string().uuid(),
  shippingTemplateId: z.string().uuid(),
  shippingServiceCode: z.string().trim().min(1, '请选择 OZON 服务渠道').max(64).regex(/^[A-Z0-9_-]+$/, '服务渠道代码格式无效').transform((value) => value.toUpperCase()),
  destinationCountryCode: z.string().trim().min(2).max(8).transform((value) => value.toUpperCase()).nullish(),
  vat: z.enum(OZON_VAT_RATES).default('0.2'),
  defaultStock: z.number().int().nonnegative().default(0),
  dimensions: ozonDimensionsSchema,
  sharedAttributes: z.array(ozonAttributeValueInputSchema).default([]),
  variantAttributes: z.array(ozonAttributeValueInputSchema).default([]),
  titleTranslation: z.object({
    workflowId: z.string().trim().min(1).max(128).default(OZON_TITLE_TRANSLATION_WORKFLOW_ID),
    language: z.string().trim().min(1).max(64).default('俄文'),
    maxLength: z.number().int().min(1).max(OZON_TITLE_MAX_LENGTH).default(OZON_TITLE_MAX_LENGTH)
  }).default({ workflowId: OZON_TITLE_TRANSLATION_WORKFLOW_ID, language: '俄文', maxLength: OZON_TITLE_MAX_LENGTH }),
  descriptionSource: z.literal('E003').default('E003'),
  sizeAttributeKey: z.string().trim().regex(/^\d+:\d+$/, '尺码属性唯一键格式无效').nullish(),
  sizes: z.array(ozonPresetSizeSchema).min(1).max(99).default([{ value: '', stock: 0 }]),
  mediaPolicy: z.enum(['REPLACE_ALL', 'KEEP_ORDER']).default('REPLACE_ALL')
} satisfies z.ZodRawShape;

/**
 * Current authoring contract. Store routing and automation policy deliberately
 * live in OZON store settings, so legacy store-level keys are rejected rather
 * than silently stripped from writes.
 */
const ozonPresetObjectSchema = z.object(ozonPresetDefinitionShape).strict();

function validateOzonPresetSizes(value: z.infer<typeof ozonPresetObjectSchema>, context: z.RefinementCtx): void {
  if (!value.sizeAttributeKey) {
    if (value.sizes.length !== 1 || value.sizes[0]?.value) {
      context.addIssue({ code: 'custom', path: ['sizes'], message: '无尺码预设只能保留一行空尺码库存' });
    }
    return;
  }
  const seen = new Set<string>();
  const seenIds = new Set<string>();
  value.sizes.forEach((size, index) => {
    if (!size.value) {
      context.addIssue({ code: 'custom', path: ['sizes', index, 'value'], message: '有尺码预设的每一行都必须填写尺码值' });
      return;
    }
    if (seen.has(size.value)) {
      context.addIssue({ code: 'custom', path: ['sizes', index, 'value'], message: `尺码值不能重复：${size.value}` });
    }
    seen.add(size.value);
    if (size.sizeId) {
      if (seenIds.has(size.sizeId)) {
        context.addIssue({ code: 'custom', path: ['sizes', index, 'sizeId'], message: `尺码身份不能重复：${size.sizeId}` });
      }
      seenIds.add(size.sizeId);
    }
  });
}

export const ozonPresetInputSchema = ozonPresetObjectSchema.superRefine(validateOzonPresetSizes);

/**
 * Read-only parser for immutable historical snapshots created before store
 * settings became the only routing authority. Never use this schema for a
 * create/update API.
 */
export const ozonLegacyPresetInputSchema = z.object({
  ...ozonPresetDefinitionShape,
  autoPublishEnabled: z.boolean().default(false),
  autoPublishMode: z.enum(OZON_AUTO_PUBLISH_MODES).default('CREATE_ONLY'),
  fulfillmentMode: z.enum(OZON_FULFILLMENT_MODES).default('FBS'),
  warehouseId: z.string().trim().max(128).default(''),
  currency: z.enum(['RUB', 'CNY']).default('RUB'),
  isDefault: z.boolean().default(false)
}).passthrough();

export const ozonPresetUpdateSchema = z.object({
  ...ozonPresetDefinitionShape,
  rowVersion: z.number().int().positive()
}).strict().superRefine(validateOzonPresetSizes);

export const OZON_REQUIRED_ATTRIBUTE_SOURCES = ['PRESET', 'SIZE', 'COLOR', 'SYSTEM'] as const;
export const OZON_NO_BRAND_DICTIONARY_VALUE_ID = 126745801;
export const OZON_NO_BRAND_VALUE_RU = 'Нет бренда';

export type OzonPresetRequiredAttributeCoverage = {
  attributeId: number;
  complexId: number;
  attributeKey: string;
  name: string;
  nameRu: string;
  nameZh: string;
  required: true;
  source: (typeof OZON_REQUIRED_ATTRIBUTE_SOURCES)[number];
  covered: boolean;
  reason?: string;
  systemValue?: {
    kind: 'NO_BRAND' | 'MAIN_SKU' | 'AUTO';
    labelZh: string;
    labelRu: string;
  };
};

type OzonPresetRequiredAttributeInput = Pick<
  z.infer<typeof ozonPresetInputSchema>,
  'sharedAttributes' | 'variantAttributes' | 'sizeAttributeKey' | 'sizes'
>;

const OZON_PRODUCT_COLOR_ATTRIBUTE_ID = 10096;
const OZON_SYSTEM_NO_BRAND_ATTRIBUTE_IDS = new Set([31, 85]);
const OZON_SYSTEM_MAIN_SKU_ATTRIBUTE_ID = 8292;
const OZON_SYSTEM_AUTO_ATTRIBUTE_IDS = new Set([
  8229, 9024, 9048, 4180, 4191,
  ...OZON_MANUAL_PURCHASE_ATTRIBUTE_IDS,
  ...OZON_SYSTEM_MEDIA_ATTRIBUTE_IDS
]);

function ozonAttributeHasValue(attribute: z.infer<typeof ozonAttributeValueInputSchema> | undefined): boolean {
  return Boolean(attribute?.values.some((entry) => (
    Number(entry.dictionaryValueId || 0) > 0 || Boolean(String(entry.value || '').trim())
  )));
}

/**
 * Projects every required catalog attribute to its authoring/materialization
 * source. Requiredness always comes from the published category snapshot; the
 * small system ID set only describes values that MerchRoute itself owns.
 */
export function projectOzonPresetRequiredAttributeCoverage(
  category: Pick<z.infer<typeof ozonCategoryTemplateInputSchema>, 'attributes' | 'sizing'>,
  preset: OzonPresetRequiredAttributeInput
): OzonPresetRequiredAttributeCoverage[] {
  const explicit = new Map<string, z.infer<typeof ozonAttributeValueInputSchema>>(
    [...preset.sharedAttributes, ...preset.variantAttributes]
      .map((attribute) => [`${attribute.attributeId}:${attribute.complexId}`, attribute] as const)
  );
  const selectedSizeKey = String(preset.sizeAttributeKey || '').trim();
  const configuredSizesReady = Boolean(selectedSizeKey)
    && preset.sizes.length > 0
    && preset.sizes.every((size) => Boolean(String(size.value || '').trim()));

  return category.attributes.filter((attribute) => attribute.required).map((attribute) => {
    const attributeKey = `${attribute.id}:${attribute.complexId}`;
    const identity = {
      attributeId: attribute.id,
      complexId: attribute.complexId,
      attributeKey,
      name: attribute.name,
      nameRu: String(attribute.nameRu || attribute.name || ''),
      nameZh: String(attribute.nameZh || ''),
      required: true as const
    };
    if (attributeKey === category.sizing.sizeAttributeKey) {
      const covered = configuredSizesReady && selectedSizeKey === attributeKey;
      return {
        ...identity,
        source: 'SIZE' as const,
        covered,
        ...(!covered ? { reason: '请在“尺码与默认库存”中选择该必填尺码属性并填写尺码' } : {})
      };
    }
    if (attribute.id === OZON_PRODUCT_COLOR_ATTRIBUTE_ID) {
      return { ...identity, source: 'COLOR' as const, covered: true };
    }
    if (attribute.complexId === 0 && OZON_SYSTEM_NO_BRAND_ATTRIBUTE_IDS.has(attribute.id)) {
      return {
        ...identity,
        source: 'SYSTEM' as const,
        covered: true,
        systemValue: { kind: 'NO_BRAND' as const, labelZh: '无品牌（系统自动生成）', labelRu: 'Нет бренда' }
      };
    }
    if (attribute.complexId === 0 && attribute.id === OZON_SYSTEM_MAIN_SKU_ATTRIBUTE_ID) {
      return {
        ...identity,
        source: 'SYSTEM' as const,
        covered: true,
        systemValue: { kind: 'MAIN_SKU' as const, labelZh: '主 SKU（系统自动生成）', labelRu: 'Основной SKU' }
      };
    }
    if (OZON_SYSTEM_AUTO_ATTRIBUTE_IDS.has(attribute.id)) {
      return {
        ...identity,
        source: 'SYSTEM' as const,
        covered: true,
        systemValue: { kind: 'AUTO' as const, labelZh: '系统自动生成', labelRu: 'Формируется системой' }
      };
    }
    const covered = ozonAttributeHasValue(explicit.get(attributeKey));
    return {
      ...identity,
      source: 'PRESET' as const,
      covered,
      ...(!covered ? {
        reason: `必填目录属性 ${identity.nameZh || identity.nameRu || identity.name} / ${identity.nameRu || identity.name} · #${attribute.id} 必须在上品预设中填写`
      } : {})
    };
  });
}

export function findUncoveredOzonPresetRequiredAttributes(
  category: Pick<z.infer<typeof ozonCategoryTemplateInputSchema>, 'attributes' | 'sizing'>,
  preset: OzonPresetRequiredAttributeInput
): OzonPresetRequiredAttributeCoverage[] {
  return projectOzonPresetRequiredAttributeCoverage(category, preset).filter((attribute) => !attribute.covered);
}

export const ozonGrossWeightResolutionSchema = z.object({
  source: z.enum(['PROCUREMENT', 'PRESET_FALLBACK']),
  effectiveGrossWeightGrams: z.number().finite().positive(),
  procurementGrossWeightGrams: z.number().finite().positive().nullable(),
  presetGrossWeightGrams: z.number().finite().positive(),
  procurementVersionId: z.string().uuid(),
  procurementVersionNo: z.number().int().positive(),
  procurementCapturedAt: z.string().datetime()
}).superRefine((value, context) => {
  if (value.source === 'PROCUREMENT') {
    if (value.procurementGrossWeightGrams === null) {
      context.addIssue({
        code: 'custom',
        path: ['procurementGrossWeightGrams'],
        message: '采购毛重来源必须保存有效采购毛重'
      });
    } else if (value.effectiveGrossWeightGrams !== value.procurementGrossWeightGrams) {
      context.addIssue({
        code: 'custom',
        path: ['effectiveGrossWeightGrams'],
        message: '采购毛重来源的有效毛重必须与采购毛重一致'
      });
    }
    return;
  }
  if (value.procurementGrossWeightGrams !== null) {
    context.addIssue({
      code: 'custom',
      path: ['procurementGrossWeightGrams'],
      message: '预设兜底来源不能保存有效采购毛重'
    });
  }
  if (value.effectiveGrossWeightGrams !== value.presetGrossWeightGrams) {
    context.addIssue({
      code: 'custom',
      path: ['effectiveGrossWeightGrams'],
      message: '预设兜底来源的有效毛重必须与预设毛重一致'
    });
  }
});

export const ozonPresetSnapshotSchema = z.object({
  presetId: z.string().uuid(),
  presetName: z.string().trim().min(1).max(128),
  presetRowVersion: z.number().int().positive(),
  capturedAt: z.string().datetime(),
  definition: z.union([ozonPresetInputSchema, ozonLegacyPresetInputSchema])
});

export const ozonPricingResolutionSchema = z.object({
  targetCurrency: z.enum(['RUB', 'CNY']),
  pricingTemplateId: z.string().uuid(),
  pricingTemplateVersionId: z.string().uuid(),
  pricingTemplateVersionNo: z.number().int().positive(),
  shippingTemplateId: z.string().uuid(),
  shippingTemplateVersionId: z.string().uuid(),
  shippingTemplateVersionNo: z.number().int().positive(),
  shippingServiceCode: z.string().trim().min(1).max(64)
    .regex(/^[A-Z0-9_-]+$/, '服务渠道代码格式无效')
    .transform((value) => value.toUpperCase()),
  optionId: z.string().trim().min(1).max(512),
  capturedAt: z.string().datetime()
});

export const ozonInitializationIssueSchema = z.object({
  code: z.string().trim().min(1).max(128),
  message: z.string().trim().min(1).max(2_000),
  field: z.string().trim().min(1).max(512).optional(),
  retryable: z.boolean()
});

export const ozonListingInitializationSchema = z.object({
  status: z.enum(['COMPLETE', 'PARTIAL']),
  initializedAt: z.string().datetime(),
  lastRetriedAt: z.string().datetime().optional(),
  issues: z.array(ozonInitializationIssueSchema).max(200).default([]),
  title: z.object({
    workflowId: z.string().trim().min(1).max(128),
    language: z.string().trim().min(1).max(64),
    maxLength: z.number().int().min(1).max(OZON_TITLE_MAX_LENGTH),
    cached: z.boolean(),
    model: z.string().trim().max(256).optional()
  }).optional(),
  description: z.object({
    workflowCode: z.literal('E003'),
    executionId: z.number().int().positive().optional(),
    fileName: z.string().trim().max(512).optional(),
    sha256: z.string().regex(/^[a-f0-9]{64}$/).optional()
  }).optional(),
  grossWeightResolution: ozonGrossWeightResolutionSchema.optional(),
  presetSnapshot: ozonPresetSnapshotSchema.optional(),
  pricingResolution: ozonPricingResolutionSchema.optional()
});

export const ozonDescriptionSanitizationWarningSchema = z.object({
  code: z.literal('OZON_DESCRIPTION_CJK_REMOVED'),
  fieldPath: z.string().trim().min(1).max(512),
  removedFragments: z.array(z.string().min(1).max(512)).min(1).max(100),
  beforeSha256: z.string().regex(/^[a-f0-9]{64}$/),
  afterSha256: z.string().regex(/^[a-f0-9]{64}$/)
});

const ozonOfferObjectSchema = z.object({
  variantId: z.string().uuid(),
  productVariantId: z.string().uuid().optional(),
  productVariantName: z.string().trim().min(1).max(256).optional(),
  productVariantColor: z.object({
    colorKey: z.string().regex(/^[a-f0-9]{64}$/),
    nameRu: z.string().trim().min(1).max(256),
    nameZh: z.string().trim().min(1).max(256)
  }).optional(),
  variantCode: z.string().trim().min(1).max(64),
  offerId: z.string().trim().min(1).max(50).regex(/^[A-Za-z0-9._-]+$/, 'offerId 只能包含 ASCII 字母、数字、点、下划线和连字符'),
  barcode: z.string().trim().max(64).default(''),
  modelGroup: z.string().trim().max(128).default(''),
  price: z.number().positive(),
  oldPrice: z.number().positive().optional(),
  minPrice: z.number().nonnegative().optional(),
  stock: z.number().int().nonnegative(),
  descriptionRu: z.string().superRefine((value, context) => {
    const result = validateOzonDescription(value);
    if (!result.valid) context.addIssue({ code: 'custom', message: `OZON 商品详情不符合内容合同: ${result.issues.join(', ')}` });
  }).optional(),
  descriptionSource: ozonDescriptionSourceSchema.optional(),
  descriptionWarnings: z.array(ozonDescriptionSanitizationWarningSchema).max(100).default([]),
  attributes: z.array(ozonAttributeValueInputSchema).default([]),
  media: z.array(ozonMediaReferenceSchema).max(20).default([])
});

function validateOzonOffer(value: z.infer<typeof ozonOfferObjectSchema>, context: z.RefinementCtx) {
  if (value.oldPrice !== undefined && value.oldPrice < value.price) {
    context.addIssue({ code: 'custom', path: ['oldPrice'], message: '划线价不能低于销售价' });
  }
  if (value.minPrice !== undefined && value.minPrice > value.price) {
    context.addIssue({ code: 'custom', path: ['minPrice'], message: '最低价不能高于销售价' });
  }
  if (new Set(value.media.map((item) => item.assetId)).size !== value.media.length) {
    context.addIssue({ code: 'custom', path: ['media'], message: '同一 Offer 不能重复使用同一媒体' });
  }
  if (value.media.filter((item) => item.kind === 'image').length > 15) {
    context.addIssue({ code: 'custom', path: ['media'], message: '同一 Offer 最多只能使用 15 张图片' });
  }
  if (value.media.filter((item) => item.kind === 'video').length > 1) {
    context.addIssue({ code: 'custom', path: ['media'], message: '同一 Offer 最多只能使用 1 个产品视频' });
  }
  if (value.media.some((item) => item.kind === 'video' && item.isPrimary)) {
    context.addIssue({ code: 'custom', path: ['media'], message: '产品视频/封面不能标记为图片主图' });
  }
  if (value.media.filter((item) => item.kind === 'image' && item.isPrimary).length > 1) {
    context.addIssue({ code: 'custom', path: ['media'], message: '同一 Offer 最多只能指定一张主图' });
  }
}

/** Draft offer contract: media may be completed in a later editing session. */
export const ozonOfferSchema = ozonOfferObjectSchema.superRefine(validateOzonOffer);

// Product JSON remains a portable marketplace contract; local matching identity stays in the draft only.
const ozonProductOfferBaseSchema = ozonOfferObjectSchema.omit({
  productVariantId: true,
  productVariantName: true,
  productVariantColor: true
});

/** Publish contract: every offer must provide at least one locally retained image. */
const ozonProductOfferSchema = ozonProductOfferBaseSchema.extend({
  media: z.array(ozonMediaReferenceSchema).min(1, '每个 Offer 至少需要一张图片').max(20)
}).superRefine((value, context) => {
  validateOzonOffer(value, context);
  if (!value.media.some((item) => item.kind === 'image')) {
    context.addIssue({ code: 'custom', path: ['media'], message: '每个 Offer 至少需要一张图片' });
  }
  if (value.media.filter((item) => item.kind === 'video').length !== 1) {
    context.addIssue({ code: 'custom', path: ['media'], message: '每个 Offer 必须配置恰好 1 个产品视频' });
  }
});

const ozonProductOfferV2Schema = ozonProductOfferBaseSchema.extend({
  titleRu: z.string().superRefine((value, context) => {
    const result = validateOzonTitle(value);
    if (!result.valid) context.addIssue({ code: 'custom', message: `OZON 标题不符合内容合同: ${result.issues.join(', ')}` });
  }),
  media: z.array(ozonMediaReferenceSchema).min(1, '每个 Offer 至少需要一张图片').max(20)
}).superRefine((value, context) => {
  validateOzonOffer(value, context);
  if (!value.media.some((item) => item.kind === 'image')) {
    context.addIssue({ code: 'custom', path: ['media'], message: '每个 Offer 至少需要一张图片' });
  }
  if (value.media.filter((item) => item.kind === 'video').length !== 1) {
    context.addIssue({ code: 'custom', path: ['media'], message: '每个 Offer 必须配置恰好 1 个产品视频' });
  }
});

export const ozonListingDraftInputSchema = z.object({
  rowVersion: z.number().int().positive(),
  categoryKey: ozonCategoryKeySchema.optional(),
  categoryVersionId: z.string().uuid().optional(),
  fulfillmentMode: z.enum(OZON_FULFILLMENT_MODES).default('FBS'),
  warehouseId: z.string().trim().max(128).default(''),
  currency: z.enum(['RUB', 'CNY']).default('RUB'),
  vat: z.enum(OZON_VAT_RATES).default('0.2'),
  titleRu: z.string().superRefine((value, context) => {
    if (!value) return;
    const result = validateOzonTitle(value);
    if (!result.valid) context.addIssue({ code: 'custom', message: `OZON 标题不符合内容合同: ${result.issues.join(', ')}` });
  }).default(''),
  descriptionRu: z.string().superRefine((value, context) => {
    if (!value) return;
    const result = validateOzonDescription(value);
    if (!result.valid) context.addIssue({ code: 'custom', message: `OZON 商品详情不符合内容合同: ${result.issues.join(', ')}` });
  }).default(''),
  descriptionSource: ozonDescriptionSourceSchema.optional(),
  descriptionWarnings: z.array(ozonDescriptionSanitizationWarningSchema).max(100).default([]),
  initialization: ozonListingInitializationSchema.optional(),
  brand: z.string().trim().max(256).default(''),
  dimensions: ozonDimensionsSchema.optional(),
  purchaseMeasurements: ozonManualPurchaseMeasurementsSchema.optional(),
  sharedAttributes: z.array(ozonAttributeValueInputSchema).default([]),
  offers: z.array(ozonOfferSchema).max(100).default([]),
  mediaAssets: z.array(ozonMediaAssetSchema).max(2_000).default([]),
  mediaSourceRoot: z.string().trim().max(2_000).default(''),
  videoUploadMode: z.enum(['ORIGINAL', 'COMPRESSED_COPY']).default('COMPRESSED_COPY')
}).superRefine((value, context) => {
  if (new Set(value.mediaAssets.map((asset) => asset.assetId)).size !== value.mediaAssets.length) {
    context.addIssue({ code: 'custom', path: ['mediaAssets'], message: 'OZON 共享媒体库不能包含重复资源 ID' });
  }
  const assets = new Map(value.mediaAssets.map((asset) => [asset.assetId, asset]));
  if (!assets.size) return;
  value.offers.forEach((offer, offerIndex) => {
    offer.media.forEach((reference, mediaIndex) => {
      const asset = assets.get(reference.assetId);
      if (!asset) {
        context.addIssue({ code: 'custom', path: ['offers', offerIndex, 'media', mediaIndex], message: '变体引用了共享媒体库中不存在的资源' });
      } else if (asset.relativePath !== reference.relativePath || asset.kind !== reference.kind) {
        context.addIssue({ code: 'custom', path: ['offers', offerIndex, 'media', mediaIndex], message: '变体媒体引用与共享媒体资源不一致' });
      } else if (asset.validationStatus !== 'VALID') {
        context.addIssue({ code: 'custom', path: ['offers', offerIndex, 'media', mediaIndex], message: '不能使用校验失败的共享媒体资源' });
      }
    });
  });
});

/**
 * Authoring contract shared by manual and automatic OZON preparation.
 * Marketplace fields are deliberately absent: they are materialized from the
 * selected store's frozen preset and store configuration at publication time.
 */
export const ozonSharedMaterialVariantInputSchema = z.object({
  variantId: z.string().uuid(),
  productVariantId: z.string().uuid(),
  productVariantName: z.string().trim().min(1).max(256),
  productVariantColor: z.object({
    colorKey: z.string().regex(/^[a-f0-9]{64}$/),
    nameRu: z.string().trim().min(1).max(256),
    nameZh: z.string().trim().min(1).max(256)
  }).optional(),
  descriptionRu: z.string().superRefine((value, context) => {
    if (!value) return;
    const result = validateOzonDescription(value);
    if (!result.valid) context.addIssue({ code: 'custom', message: `OZON 变体商品详情不符合内容合同: ${result.issues.join(', ')}` });
  }).default(''),
  descriptionSource: ozonDescriptionSourceSchema.optional(),
  media: z.array(ozonMediaReferenceSchema).max(20).default([])
}).strict();

export const ozonSharedMaterialDraftInputSchema = z.object({
  rowVersion: z.number().int().positive(),
  descriptionRu: z.string().superRefine((value, context) => {
    if (!value) return;
    const result = validateOzonDescription(value);
    if (!result.valid) context.addIssue({ code: 'custom', message: `OZON 商品详情不符合内容合同: ${result.issues.join(', ')}` });
  }).default(''),
  descriptionSource: ozonDescriptionSourceSchema.optional(),
  variants: z.array(ozonSharedMaterialVariantInputSchema).min(1).max(99),
  initializationIssues: z.array(ozonInitializationIssueSchema).max(200).default([])
}).strict().superRefine((value, context) => {
  const variantIds = value.variants.map((variant) => variant.variantId);
  const productVariantIds = value.variants.map((variant) => variant.productVariantId);
  if (new Set(variantIds).size !== variantIds.length) {
    context.addIssue({ code: 'custom', path: ['variants'], message: '公共素材不能包含重复的稳定变体身份' });
  }
  if (new Set(productVariantIds).size !== productVariantIds.length) {
    context.addIssue({ code: 'custom', path: ['variants'], message: '公共素材不能包含重复的产品变体身份' });
  }
  value.variants.forEach((variant, variantIndex) => {
    if (new Set(variant.media.map((item) => item.assetId)).size !== variant.media.length) {
      context.addIssue({ code: 'custom', path: ['variants', variantIndex, 'media'], message: '同一产品变体不能重复使用同一媒体' });
    }
    if (variant.media.filter((item) => item.kind === 'image').length > 15) {
      context.addIssue({ code: 'custom', path: ['variants', variantIndex, 'media'], message: '同一产品变体最多只能使用 15 张图片' });
    }
    if (variant.media.filter((item) => item.kind === 'video').length > 1) {
      context.addIssue({ code: 'custom', path: ['variants', variantIndex, 'media'], message: '同一产品变体最多只能使用 1 个产品视频' });
    }
    const sortOrders = variant.media.map((item) => item.sortOrder).sort((left, right) => left - right);
    if (sortOrders.some((sortOrder, index) => sortOrder !== index)) {
      context.addIssue({ code: 'custom', path: ['variants', variantIndex, 'media'], message: '产品变体媒体顺序必须唯一且从 0 连续递增' });
    }
  });
});

const ozonSharedMaterialAssetSchema = ozonMediaAssetSchema.omit({
  sortOrder: true,
  modifiedAt: true,
  validationError: true
}).extend({
  validationStatus: z.literal('VALID')
}).strict();

const ozonSharedMaterialProjectionVariantSchema = ozonSharedMaterialVariantInputSchema.extend({
  descriptionRu: z.string().default('')
}).strict();

/**
 * Exact canonical body used by listing versions. Marketplace materialization
 * fields never enter this projection, so two stores can safely share one
 * immutable source version while producing different publication packages.
 */
export const ozonSharedMaterialProjectionSchema = z.object({
  schemaVersion: z.literal(1),
  hashVersion: ozonSharedMaterialHashVersionSchema,
  contentPolicyVersion: ozonContentPolicyVersionSchema,
  sku: z.string().regex(/^\d{7}$/),
  productName: z.string().trim().min(1).max(512),
  materialRevision: z.number().int().positive(),
  rowVersion: z.number().int().positive(),
  descriptionRu: z.string().default(''),
  descriptionSource: ozonDescriptionSourceSchema.optional(),
  variants: z.array(ozonSharedMaterialProjectionVariantSchema).min(1).max(99),
  mediaAssets: z.array(ozonSharedMaterialAssetSchema).max(2_000).default([]),
  initializationIssues: z.array(ozonInitializationIssueSchema).max(200).default([])
}).strict().superRefine((value, context) => {
  const descriptionResult = validateOzonDescription(value.descriptionRu, value.contentPolicyVersion);
  if (value.descriptionRu && !descriptionResult.valid) {
    context.addIssue({ code: 'custom', path: ['descriptionRu'], message: `OZON 商品详情不符合冻结内容合同: ${descriptionResult.issues.join(', ')}` });
  }
  value.variants.forEach((variant, variantIndex) => {
    const result = validateOzonDescription(variant.descriptionRu, value.contentPolicyVersion);
    if (variant.descriptionRu && !result.valid) {
      context.addIssue({ code: 'custom', path: ['variants', variantIndex, 'descriptionRu'], message: `OZON 变体商品详情不符合冻结内容合同: ${result.issues.join(', ')}` });
    }
    const sortOrders = variant.media.map((item) => item.sortOrder).sort((left, right) => left - right);
    if (sortOrders.some((sortOrder, index) => sortOrder !== index)) {
      context.addIssue({ code: 'custom', path: ['variants', variantIndex, 'media'], message: '产品变体媒体顺序必须唯一且从 0 连续递增' });
    }
  });
  const variantIds = value.variants.map((variant) => variant.variantId);
  const productVariantIds = value.variants.map((variant) => variant.productVariantId);
  if (new Set(variantIds).size !== variantIds.length) {
    context.addIssue({ code: 'custom', path: ['variants'], message: '公共素材不能包含重复的稳定变体身份' });
  }
  if (new Set(productVariantIds).size !== productVariantIds.length) {
    context.addIssue({ code: 'custom', path: ['variants'], message: '公共素材不能包含重复的产品变体身份' });
  }
  validateSharedMaterialMediaReferences(value, context);
});

export const ozonSharedMaterialRevisionMetadataSchema = z.object({
  generatedVersionId: z.string().uuid(),
  materialRevision: z.number().int().positive(),
  rowVersion: z.number().int().positive(),
  materialHash: ozonSha256Schema,
  materialHashVersion: ozonSharedMaterialHashVersionSchema,
  dataSignature: ozonSha256Schema,
  contentPolicyVersion: ozonContentPolicyVersionSchema
}).strict();

type SharedMaterialWithMedia = {
  variants: Array<{ media: Array<z.infer<typeof ozonMediaReferenceSchema>> }>;
  mediaAssets: Array<Pick<z.infer<typeof ozonMediaAssetSchema>, 'assetId' | 'relativePath' | 'kind'>>;
};

function validateSharedMaterialMediaReferences(value: SharedMaterialWithMedia, context: z.RefinementCtx): void {
  const assetIds = value.mediaAssets.map((asset) => asset.assetId);
  if (new Set(assetIds).size !== assetIds.length) {
    context.addIssue({ code: 'custom', path: ['mediaAssets'], message: '公共素材不能包含重复媒体资源' });
  }
  const assets = new Map(value.mediaAssets.map((asset) => [asset.assetId, asset]));
  const referenced = new Set<string>();
  value.variants.forEach((variant, variantIndex) => {
    variant.media.forEach((reference, mediaIndex) => {
      referenced.add(reference.assetId);
      const asset = assets.get(reference.assetId);
      if (!asset) {
        context.addIssue({ code: 'custom', path: ['variants', variantIndex, 'media', mediaIndex], message: '产品变体引用了公共素材中不存在的媒体资源' });
      } else if (asset.relativePath !== reference.relativePath || asset.kind !== reference.kind) {
        context.addIssue({ code: 'custom', path: ['variants', variantIndex, 'media', mediaIndex], message: '产品变体媒体引用与公共素材资源身份不一致' });
      }
    });
  });
  value.mediaAssets.forEach((asset, assetIndex) => {
    if (!referenced.has(asset.assetId)) {
      context.addIssue({ code: 'custom', path: ['mediaAssets', assetIndex], message: '公共素材只能保存产品变体实际引用的媒体资源' });
    }
  });
}

function stableOzonMaterialJsonValue(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableOzonMaterialJsonValue).join(',')}]`;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableOzonMaterialJsonValue(record[key])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

export function canonicalOzonSharedMaterialJson(value: unknown): string {
  return stableOzonMaterialJsonValue(ozonSharedMaterialProjectionSchema.parse(value));
}

export const ozonSystemSettingsInputSchema = z.object({
  rowVersion: z.number().int().positive(),
  enabled: z.boolean().default(false),
  rootDirectory: z.string().trim().max(2_000).default(''),
  taskApiWebhookUrl: z.string().url().or(z.literal('')).default(''),
  adminApiWebhookUrl: z.string().url().or(z.literal('')).default(''),
  preflightWebhookUrl: z.string().url().or(z.literal('')).default(''),
  imageUploaderWorkflowId: z.string().trim().max(128).default(''),
  storeGatewayWorkflowId: z.string().trim().max(128).default(''),
  imageUploadConcurrency: z.number().int().min(1).max(7).default(7),
  videoUploadConcurrency: z.number().int().min(1).max(2).default(2),
  videoPrewarmEnabled: z.boolean().default(false)
}).strict();

const ozonProductBaseShape = {
  storeAlias: z.string().trim().min(1).max(128),
  productCode: z.string().trim().min(1).max(128),
  productName: z.string().trim().min(1).max(512),
  revision: z.number().int().positive(),
  /** Optional only for immutable pre-v3 artifacts; every newly materialized package must provide it. */
  contentPolicyVersion: ozonContentPolicyVersionSchema.optional(),
  materialHash: ozonSha256Schema.optional(),
  materialHashVersion: ozonSharedMaterialHashVersionSchema.optional(),
  fulfillmentMode: z.enum(OZON_FULFILLMENT_MODES),
  warehouseId: z.string().trim().min(1).max(128),
  category: z.object({
    categoryKey: ozonCategoryKeySchema,
    descriptionCategoryId: z.number().int().positive(),
    typeId: z.number().int().positive(),
    templateVersion: z.number().int().positive(),
    schemaHash: z.string().regex(/^sha256:[a-f0-9]{64}$/)
  }),
  currency: z.enum(['RUB', 'CNY']),
  vat: z.enum(OZON_VAT_RATES),
  titleRu: z.string().superRefine((value, context) => {
    const result = validateOzonTitle(value);
    if (!result.valid) context.addIssue({ code: 'custom', message: `OZON 标题不符合内容合同: ${result.issues.join(', ')}` });
  }),
  descriptionRu: z.string().superRefine((value, context) => {
    const result = validateOzonDescription(value);
    if (!result.valid) context.addIssue({ code: 'custom', message: `OZON 商品详情不符合内容合同: ${result.issues.join(', ')}` });
  }),
  descriptionWarnings: z.array(ozonDescriptionSanitizationWarningSchema).max(100).default([]),
  brand: z.string().trim().max(256),
  videoUploadMode: z.enum(['ORIGINAL', 'COMPRESSED_COPY']).default('COMPRESSED_COPY'),
  runtime: z.object({
    imageUploadConcurrency: z.number().int().min(1).max(7).default(7),
    videoUploadConcurrency: z.number().int().min(1).max(2).default(2),
    videoPrewarmEnabled: z.boolean().default(false),
    videoCompressionProfileVersion: z.string().trim().min(1).max(64).default('ozon-h264-aac-v1')
  }).default({
    imageUploadConcurrency: 7,
    videoUploadConcurrency: 2,
    videoPrewarmEnabled: false,
    videoCompressionProfileVersion: 'ozon-h264-aac-v1'
  }),
  dimensions: ozonDimensionsSchema,
  sharedAttributes: z.array(ozonAttributeValueInputSchema)
};

const ozonVideoAttributeBindingSchema = z.object({
  complexId: z.number().int().positive(),
  attributeId: z.number().int().positive()
});

const ozonProductIntroductionVideoCapabilitySchema = z.object({
  complexId: z.number().int().positive(),
  linkAttributeId: z.number().int().positive(),
  titleAttributeId: z.number().int().positive()
});

export const ozonProductV1Schema = z.object({
  schemaVersion: z.literal(1),
  ...ozonProductBaseShape,
  mediaCapabilities: z.object({
    videoCover: ozonVideoAttributeBindingSchema.optional()
  }).default({}),
  offers: z.array(ozonProductOfferSchema).min(1).max(100)
});

export const ozonProductV2Schema = z.object({
  schemaVersion: z.literal(2),
  ...ozonProductBaseShape,
  mediaCapabilities: z.object({
    videoCover: ozonVideoAttributeBindingSchema,
    productIntroductionVideo: ozonProductIntroductionVideoCapabilitySchema.optional()
  }),
  videoPolicy: z.object({
    source: z.literal('SAME_MP4'),
    titleSource: z.literal('OFFER_TITLE_RU'),
    mode: z.enum(OZON_VIDEO_PUBLISH_MODES)
  }),
  mediaAssets: z.array(ozonProductMediaAssetSchema).min(1).max(2_000),
  offers: z.array(ozonProductOfferV2Schema).min(1).max(100)
}).superRefine((value, context) => {
  const introduction = value.mediaCapabilities.productIntroductionVideo;
  if (value.videoPolicy.mode === 'INTRO_AND_COVER' && !introduction) {
    context.addIssue({
      code: 'custom',
      path: ['mediaCapabilities', 'productIntroductionVideo'],
      message: 'INTRO_AND_COVER 模式必须声明产品介绍视频属性'
    });
  }
  if (value.videoPolicy.mode === 'COVER_ONLY' && introduction) {
    context.addIssue({
      code: 'custom',
      path: ['mediaCapabilities', 'productIntroductionVideo'],
      message: 'COVER_ONLY 模式不能声明产品介绍视频属性'
    });
  }
  if (new Set(value.mediaAssets.map((asset) => asset.assetId)).size !== value.mediaAssets.length) {
    context.addIssue({ code: 'custom', path: ['mediaAssets'], message: 'product.json v2 不能包含重复媒体资源' });
  }
  const assets = new Map(value.mediaAssets.map((asset) => [asset.assetId, asset]));
  const referencedIds = new Set<string>();
  value.offers.forEach((offer, offerIndex) => {
    offer.media.forEach((reference, mediaIndex) => {
      referencedIds.add(reference.assetId);
      const asset = assets.get(reference.assetId);
      if (!asset) {
        context.addIssue({
          code: 'custom',
          path: ['offers', offerIndex, 'media', mediaIndex],
          message: 'Offer 引用了 mediaAssets 中不存在的资源'
        });
      } else if (asset.relativePath !== reference.relativePath || asset.kind !== reference.kind) {
        context.addIssue({
          code: 'custom',
          path: ['offers', offerIndex, 'media', mediaIndex],
          message: 'Offer 媒体引用与 mediaAssets 元数据不一致'
        });
      }
    });
  });
  value.mediaAssets.forEach((asset, assetIndex) => {
    if (!referencedIds.has(asset.assetId)) {
      context.addIssue({
        code: 'custom',
        path: ['mediaAssets', assetIndex],
        message: 'product.json v2 只能包含 Offer 实际引用的媒体资源'
      });
    }
    if (asset.kind === 'video' && asset.durationSeconds === undefined) {
      context.addIssue({
        code: 'custom',
        path: ['mediaAssets', assetIndex, 'durationSeconds'],
        message: 'MP4 媒体必须包含已校验的时长'
      });
    }
  });
});

export const ozonProductSchema = z.union([
  ozonProductV1Schema,
  ozonProductV2Schema
]);

export function stableOzonOfferId(skuInput: string, variantCodeInput: string): string {
  const raw = `${String(skuInput).trim()}-${String(variantCodeInput).trim()}`;
  const slug = raw
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (slug === raw && slug.length <= 50) return slug;
  let hash = 2_166_136_261;
  for (let index = 0; index < raw.length; index += 1) {
    hash ^= raw.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  const suffix = (hash >>> 0).toString(16).padStart(8, '0');
  return `${(slug || 'offer').slice(0, 41)}-${suffix}`;
}

export function isOzonSequentialVariantCode(value: unknown): boolean {
  return /^(?:0[1-9]|[1-9]\d)$/.test(String(value || '').trim());
}

export function nextOzonVariantCode(existingCodes: Iterable<string>): string | undefined {
  const used = new Set(Array.from(existingCodes, (value) => String(value || '').trim()));
  for (let value = 1; value <= 99; value += 1) {
    const code = String(value).padStart(2, '0');
    if (!used.has(code)) return code;
  }
  return undefined;
}

export function ozonProductUrl(ozonSkuInput: unknown, preferredUrl?: unknown): string | undefined {
  const ozonSku = String(ozonSkuInput || '').trim();
  if (!/^\d+$/.test(ozonSku)) return undefined;
  const candidate = String(preferredUrl || '').trim();
  if (candidate) {
    try {
      const parsed = new URL(candidate);
      const host = parsed.hostname.toLowerCase();
      const pathMatchesSku = new RegExp(`(?:-|/)${ozonSku}/?$`).test(parsed.pathname);
      if (parsed.protocol === 'https:' && ['ozon.ru', 'www.ozon.ru'].includes(host)
        && parsed.pathname.startsWith('/product/') && pathMatchesSku) {
        return parsed.toString();
      }
    } catch {
      // 无效或非 OZON 商品链接时使用稳定的前台 SKU 地址。
    }
  }
  return `https://www.ozon.ru/product/${ozonSku}/`;
}

const OZON_DANGLING_CONNECTOR = '(?:из-за|из-под|через|перед|между|около|возле|против|после|вокруг|вместо|для|при|без|под|над|за|из|от|до|по|на|со|об|во|с|к|у|о|в)';

export type OzonDescriptionCleanupResult = {
  value: string;
  removedFragments: string[];
  changed: boolean;
};

/** OZON-only deterministic cleanup. It never translates or mutates source E003 files. */
export function cleanupOzonDescription(valueInput: unknown): OzonDescriptionCleanupResult {
  const original = String(valueInput || '').normalize('NFC');
  const removedFragments: string[] = [];
  const cjkRun = '[\\p{Script=Han}\\p{Script=Hiragana}\\p{Script=Katakana}\\p{Script=Hangul}]+';
  let value = original.replace(
    new RegExp(`(^|[\\s([{—–-])(${OZON_DANGLING_CONNECTOR})\\s*(${cjkRun})`, 'giu'),
    (match, prefix: string) => {
      removedFragments.push(String(match).slice(String(prefix).length));
      return prefix;
    }
  );
  value = value.replace(new RegExp(cjkRun, 'gu'), (fragment) => {
    removedFragments.push(fragment);
    return '';
  });
  value = value
    .replace(/[ \t]+/g, ' ')
    .replace(/\s+([,.;:!?])/g, '$1')
    .replace(/([,.;:!?])\1+/g, '$1')
    .replace(/\(\s*\)|\[\s*\]|\{\s*\}|（\s*）|【\s*】|［\s*］/g, '')
    .replace(/\s{2,}/g, ' ')
    .replace(/\s+([)\]}])/g, '$1')
    .replace(/([([{])\s+/g, '$1')
    .trim();
  return { value, removedFragments, changed: value !== original };
}

export function findMissingOzonRequiredAttributes(
  attributes: OzonCategoryAttribute[],
  sharedAttributes: Array<z.infer<typeof ozonAttributeValueInputSchema>>,
  offers: Array<Pick<z.infer<typeof ozonOfferSchema>, 'offerId' | 'attributes'>>
): Array<{ offerId: string; attributeIds: number[] }> {
  const requiredKeys = attributes
    .filter((attribute) => attribute.required && !isOzonSystemMediaAttributeId(attribute.id))
    .map((attribute) => ({ id: attribute.id, key: `${attribute.id}:${attribute.complexId}` }));
  const sharedKeys = new Set(sharedAttributes.map((attribute) => `${attribute.attributeId}:${attribute.complexId}`));
  return offers.flatMap((offer) => {
    const offerKeys = new Set(offer.attributes.map((attribute) => `${attribute.attributeId}:${attribute.complexId}`));
    const attributeIds = requiredKeys
      .filter((attribute) => !sharedKeys.has(attribute.key) && !offerKeys.has(attribute.key))
      .map((attribute) => attribute.id);
    return attributeIds.length ? [{ offerId: offer.offerId, attributeIds }] : [];
  });
}

export type OzonListingStatus = (typeof OZON_LISTING_STATUSES)[number];
export type OzonListingManagementSource = 'AUTO' | 'MANUAL';
export type OzonPublishJobState = (typeof OZON_PUBLISH_JOB_STATES)[number];
export type OzonPublishTaskKind = z.infer<typeof ozonPublishTaskKindSchema>;
export type OzonPreparationFanoutSummary = z.infer<typeof ozonPreparationFanoutSummarySchema>;
export type OzonFulfillmentMode = (typeof OZON_FULFILLMENT_MODES)[number];
export type OzonCategoryVersionStatus = (typeof OZON_CATEGORY_VERSION_STATUSES)[number];
export type OzonCatalogStatusName = (typeof OZON_CATALOG_STATUSES)[number];
export type OzonCatalogTrigger = (typeof OZON_CATALOG_TRIGGERS)[number];
export type OzonCatalogDictionaryName = (typeof OZON_CATALOG_DICTIONARIES)[number];
export type OzonCategoryAttribute = z.infer<typeof ozonCategoryAttributeSchema>;
export type OzonCategorySizing = z.infer<typeof ozonCategorySizingSchema>;
export type OzonAttributeValueInput = z.infer<typeof ozonAttributeValueInputSchema>;
export type OzonCategoryAttributeOrderInput = z.infer<typeof ozonCategoryAttributeOrderInputSchema>;
export type OzonCategoryTemplateInput = z.infer<typeof ozonCategoryTemplateInputSchema>;
export type OzonCategoryFromCatalogInput = z.infer<typeof ozonCategoryFromCatalogInputSchema>;
export type OzonManualPurchaseMeasurements = z.infer<typeof ozonManualPurchaseMeasurementsSchema>;
export type OzonManualPurchaseMeasurementSource = 'LATEST_PURCHASE' | 'SNAPSHOT';
export type OzonManualPurchaseMeasurementIssue = {
  code: 'OZON_PURCHASE_MEASUREMENT_REQUIRED_MISSING';
  message: string;
  field: string;
  attributeId: number;
  severity: 'ERROR';
  retryable: true;
};
export type OzonManualPurchaseMeasurementField = {
  attributeId: number;
  purchaseField: (typeof OZON_MANUAL_PURCHASE_ATTRIBUTE_BINDINGS)[number]['purchaseField'];
  labelZh: string;
  labelRu: string;
  unit: 'cm' | 'g';
  value: string | null;
  required: boolean;
  applicable: boolean;
  status: 'AVAILABLE' | 'OPTIONAL_MISSING' | 'REQUIRED_MISSING' | 'NOT_APPLICABLE';
};
export type OzonManualPurchaseMeasurementProjection = {
  source: OzonManualPurchaseMeasurementSource;
  snapshot: OzonManualPurchaseMeasurements;
  fields: OzonManualPurchaseMeasurementField[];
  issues: OzonManualPurchaseMeasurementIssue[];
  warning?: string;
};
export type OzonListingPriceProjection = {
  status: 'STORED' | 'RECALCULATED' | 'UNAVAILABLE';
  sourceCurrency: 'RUB' | 'CNY';
  targetCurrency: 'CNY';
  pendingSave: boolean;
  offers: Array<{
    offerId: string;
    price: number;
    oldPrice?: number;
    minPrice?: number;
  }>;
  reason?: string;
};
export type OzonListingDraftInput = z.infer<typeof ozonListingDraftInputSchema>;
export type OzonSharedMaterialDraftInput = z.input<typeof ozonSharedMaterialDraftInputSchema>;
export type OzonSharedMaterialProjection = z.infer<typeof ozonSharedMaterialProjectionSchema>;
export type OzonSharedMaterialRevisionMetadata = z.infer<typeof ozonSharedMaterialRevisionMetadataSchema>;
export type OzonInitializationIssue = z.infer<typeof ozonInitializationIssueSchema>;
export type OzonListingInitialization = z.infer<typeof ozonListingInitializationSchema>;
export type OzonPricingResolution = z.infer<typeof ozonPricingResolutionSchema>;
export type OzonGrossWeightResolution = z.infer<typeof ozonGrossWeightResolutionSchema>;
export type OzonPresetSnapshot = z.infer<typeof ozonPresetSnapshotSchema>;
export type OzonMediaAsset = z.infer<typeof ozonMediaAssetSchema>;
export type OzonProductMediaAsset = z.infer<typeof ozonProductMediaAssetSchema>;
export type OzonPresetInput = z.infer<typeof ozonPresetInputSchema>;
export type OzonLegacyPresetInput = z.infer<typeof ozonLegacyPresetInputSchema>;
export type OzonPresetUpdate = z.infer<typeof ozonPresetUpdateSchema>;
export type OzonSystemSettingsInput = z.infer<typeof ozonSystemSettingsInputSchema>;
export type OzonProductV1 = z.infer<typeof ozonProductV1Schema>;
export type OzonProductV2 = z.infer<typeof ozonProductV2Schema>;
export type OzonProduct = z.infer<typeof ozonProductSchema>;
export type OzonVideoPublishMode = (typeof OZON_VIDEO_PUBLISH_MODES)[number];

export type OzonCategoryVersion = {
  id: string;
  categoryKey: string;
  versionNo: number;
  status: OzonCategoryVersionStatus;
  schemaHash: string;
  snapshot: OzonCategoryTemplateInput;
  confirmedBy: string;
  createdAt: string;
  updatedAt: string;
  publishedAt?: string;
};

export type OzonCategoryTemplate = {
  categoryKey: string;
  nameRu: string;
  nameZh: string;
  descriptionCategoryId: number;
  typeId: number;
  rowVersion: number;
  createdAt: string;
  updatedAt: string;
  draftVersion?: OzonCategoryVersion;
  publishedVersion?: OzonCategoryVersion;
  versions?: OzonCategoryVersion[];
  catalogActive?: boolean;
  catalogIssue?: string;
};

export type OzonCatalogEntry = {
  catalogEntryId: string;
  descriptionCategoryId: number;
  typeId: number;
  categoryNameZh: string;
  typeNameZh: string;
  categoryNameRu: string;
  typeNameRu: string;
  pathZh: string[];
  pathRu: string[];
  displayPathZh: string;
  displayPathRu: string;
  active: boolean;
  missingSyncCount: number;
  updatedAt: string;
};

export type OzonCatalogSyncRun = {
  runId: string;
  trigger: OzonCatalogTrigger;
  status: 'RUNNING' | 'SUCCEEDED' | 'FAILED';
  scheduleKey?: string;
  processedEntries: number;
  totalEntries: number;
  chineseMissingCount: number;
  snapshotPath?: string;
  sourceHash?: string;
  errorCode?: string;
  errorMessage?: string;
  startedAt: string;
  heartbeatAt: string;
  completedAt?: string;
};

export type OzonCatalogStatus = {
  status: OzonCatalogStatusName;
  entryCount: number;
  chineseMissingCount: number;
  dictionaryCounts: Record<OzonCatalogDictionaryName, number>;
  lastSuccessfulAt?: string;
  lastError?: string;
  lastErrorCode?: string;
  currentRun?: OzonCatalogSyncRun;
  latestRun?: OzonCatalogSyncRun;
  nextScheduledAt: string;
  isStale: boolean;
};

export type OzonCatalogDictionaryValue = {
  directory: OzonCatalogDictionaryName;
  itemKey: string;
  attributeId: number;
  dictionaryId: number;
  valueId: number;
  nameRu: string;
  nameZh: string;
  infoRu?: string;
  infoZh?: string;
};

export type OzonCatalogDictionaryResult = {
  directory: OzonCatalogDictionaryName;
  dictionaryId?: number;
  items: OzonCatalogDictionaryValue[];
  catalog: OzonCatalogStatus;
};

export type OzonListingDraft = {
  sku: string;
  productName: string;
  managementSource: OzonListingManagementSource;
  status: OzonListingStatus;
  rowVersion: number;
  revision: number;
  materialRevision?: number;
  generatedVersionId?: string;
  materialHash?: string;
  materialHashVersion?: typeof OZON_SHARED_MATERIAL_HASH_VERSION;
  contentPolicyVersion?: OzonStoredContentPolicyVersion;
  sourceMediaIdentityHash?: string;
  data: Omit<OzonListingDraftInput, 'rowVersion'>;
  lastTaskId?: string;
  lastErrorCode?: string;
  lastErrorMessage?: string;
  createdAt: string;
  updatedAt: string;
  ozonProductLinks?: OzonProductLink[];
};

/**
 * Projects a legacy-shaped listing draft onto the only fields permitted in a
 * new shared-material version. Parsing fails closed when stable product/media
 * identities are missing instead of borrowing marketplace defaults.
 */
export function projectOzonSharedMaterialDraft(
  draft: OzonListingDraft,
  contentPolicyVersion: OzonContentPolicyVersion = OZON_CONTENT_POLICY_VERSION
): OzonSharedMaterialProjection {
  const variants = draft.data.offers.map((offer) => ({
    variantId: offer.variantId,
    productVariantId: offer.productVariantId,
    productVariantName: offer.productVariantName,
    ...(offer.productVariantColor ? { productVariantColor: offer.productVariantColor } : {}),
    descriptionRu: offer.descriptionRu ?? draft.data.descriptionRu,
    ...(offer.descriptionSource ?? draft.data.descriptionSource
      ? { descriptionSource: offer.descriptionSource ?? draft.data.descriptionSource }
      : {}),
    media: [...offer.media].sort((left, right) => left.sortOrder - right.sortOrder)
  }));
  const referencedAssetIds = new Set(variants.flatMap((variant) => variant.media.map((media) => media.assetId)));
  const mediaAssets = draft.data.mediaAssets
    .filter((asset) => referencedAssetIds.has(asset.assetId))
    .map((asset) => ({
      assetId: asset.assetId,
      relativePath: asset.relativePath,
      kind: asset.kind,
      mimeType: asset.mimeType,
      sizeBytes: asset.sizeBytes,
      sha256: asset.sha256,
      validationStatus: asset.validationStatus,
      ...(asset.productVariantId ? { productVariantId: asset.productVariantId } : {}),
      ...(asset.productVariantName ? { productVariantName: asset.productVariantName } : {}),
      ...(asset.productVariantColor ? { productVariantColor: asset.productVariantColor } : {}),
      ...(asset.sourceStageId ? { sourceStageId: asset.sourceStageId } : {}),
      ...(asset.sourceSubmissionId ? { sourceSubmissionId: asset.sourceSubmissionId } : {}),
      ...(asset.deliveredAt ? { deliveredAt: asset.deliveredAt } : {}),
      ...(asset.durationSeconds !== undefined ? { durationSeconds: asset.durationSeconds } : {})
    }))
    .sort((left, right) => left.assetId.localeCompare(right.assetId));
  return ozonSharedMaterialProjectionSchema.parse({
    schemaVersion: 1,
    hashVersion: OZON_SHARED_MATERIAL_HASH_VERSION,
    contentPolicyVersion,
    sku: draft.sku,
    productName: draft.productName,
    materialRevision: draft.revision,
    rowVersion: draft.rowVersion,
    descriptionRu: draft.data.descriptionRu,
    ...(draft.data.descriptionSource ? { descriptionSource: draft.data.descriptionSource } : {}),
    variants,
    mediaAssets,
    initializationIssues: draft.data.initialization?.issues ?? []
  });
}

export type OzonPreset = OzonPresetInput & {
  id: string;
  rowVersion: number;
  createdAt: string;
  updatedAt: string;
  /**
   * API-only projection from the currently published category snapshot. It is
   * deliberately not part of OzonPresetInput, so clients can never persist a
   * stale requiredness/source decision back into the preset definition.
   */
  requiredAttributeCoverage?: OzonPresetRequiredAttributeCoverage[];
};

export type OzonAutoPresetBinding = {
  schemaVersion: 1;
  presetId: string;
  presetName: string;
  presetRowVersion: number;
  activationStartedAt: string;
  boundAt: string;
  definition: OzonLegacyPresetInput;
  definitionHash: string;
};

export type OzonMaterialSnapshot = {
  schemaVersion: 1;
  capturedAt: string;
  preset: {
    id: string;
    name: string;
    rowVersion: number;
    definitionHash?: string;
  };
  category: {
    key: string;
    versionId: string;
    versionNo: number;
    schemaHash: string;
  };
  procurement: {
    versionId: string;
    versionNo: number;
    capturedAt: string;
    productHeightCm: number | null;
    productDepthCm: number | null;
    productWidthCm: number | null;
    netWeightGrams: number | null;
  };
  packaging: {
    lengthCm: number;
    widthCm: number;
    heightCm: number;
    grossWeightGrams: number;
    grossWeightSource: OzonGrossWeightResolution['source'];
  };
  pricing: {
    pricingTemplateId: string;
    shippingTemplateId: string;
    shippingServiceCode: string;
    optionId: string | null;
  };
  store: {
    storeAlias: string;
    warehouseId: string;
    currency: 'RUB' | 'CNY';
    fulfillmentMode: OzonFulfillmentMode;
  };
  offers: {
    count: number;
    ids: string[];
  };
  artifact: {
    revision: number | null;
    signature: string | null;
  };
  warnings: string[];
};

export type OzonNetworkDeliveryState = 'NOT_SENT' | 'UNKNOWN' | 'RESPONDED';

export type OzonNetworkRecovery = {
  schemaVersion: 1;
  status: 'WAITING_NETWORK';
  phase: string;
  resumeState: OzonPublishJobState;
  deliveryState: OzonNetworkDeliveryState;
  attempt: number;
  firstFailureAt: string;
  lastFailureAt: string;
  nextAttemptAt: string;
  errorCode: string;
  errorMessage: string;
  retryAfterMs?: number;
  checkpoint?: Record<string, unknown>;
};

export type OzonPublishJobPayload = Record<string, unknown> & {
  contentPolicyVersion?: OzonStoredContentPolicyVersion;
  materialHash?: string;
  materialHashVersion?: typeof OZON_SHARED_MATERIAL_HASH_VERSION;
  planHash?: string;
  requestId?: string;
  fanoutSummary?: OzonPreparationFanoutSummary;
  materialSnapshot?: OzonMaterialSnapshot;
  networkRecovery?: OzonNetworkRecovery;
  platformStatusRefresh?: {
    readAt?: string;
    businessState?: OzonPlatformBusinessState;
    offers?: OzonPlatformOfferStatus[];
    warnings?: string[];
  };
};

export type OzonPublishEvent = {
  id: string;
  jobId: string;
  eventType: string;
  fromState?: OzonPublishJobState;
  toState?: OzonPublishJobState;
  message: string;
  payload?: Record<string, unknown>;
  createdAt: string;
};

export type OzonTaskDirectoryStage = 'INBOX' | 'PROCESSING' | 'SUCCESS';

export type OzonPublishStageStates =
  Record<'import' | 'moderation' | 'images' | 'video' | 'price' | 'stock', string>
  & Partial<Record<'videoCover' | 'productVideo', string>>;

export type OzonOfferVideoVerification = {
  offerId: string;
  mode: OzonVideoPublishMode;
  sourceAssetId?: string;
  sameSource: boolean;
  coverStatus: string;
  introductionStatus: string;
  requiredAttributeIds: number[];
  presentAttributeIds: number[];
};

export type OzonMediaOptimization = {
  requestedMode?: 'ORIGINAL' | 'COMPRESSED_COPY';
  actualMode?: 'ORIGINAL' | 'COMPRESSED_COPY';
  profileVersion: string;
  profileKey?: string;
  sourceSha256: string;
  outputSha256: string;
  sourceSizeBytes: number;
  outputSizeBytes: number;
  compressionRatio: number;
  cacheHit: boolean;
  durationMs: number;
  relativeCachePath?: string;
  status?: string;
  fallbackReason?: string;
};

export type OzonVideoUploadAssignment = {
  offerId: string;
  variantCode: string;
  usage: 'PRODUCT_VIDEO' | 'VIDEO_COVER';
};

export type OzonMediaUploadAudit = {
  uploadKey?: string;
  sourceFileName: string;
  inputIndex: number;
  mediaType: 'image' | 'video';
  sourceSha256: string;
  uploadedSha256: string;
  sourceSizeBytes: number;
  uploadedSizeBytes: number;
  cacheHit: boolean;
  compressionRatio: number;
  url: string;
  durationMs: number;
  assignments?: OzonVideoUploadAssignment[];
  uploadCount?: number;
  urlVerifiedAt?: string;
  urlVerificationStatus?: string;
};

export type OzonPublishTimings = Partial<Record<
  'media' | 'import' | 'moderation' | 'finalVerification' | 'total',
  number
>>;

export type OzonPublishJob = {
  id: string;
  taskKind: OzonPublishTaskKind;
  sku: string;
  offerId?: string;
  offerIds: string[];
  storeAlias: string;
  storeId?: string;
  publicationId?: string;
  credentialVersionId?: string;
  credentialBindingMode?: 'VAULT' | 'LEGACY_PUBLICATION' | 'PURE_LEGACY';
  storeConfigVersion?: number;
  warehouseId?: string;
  offerContractHash?: string;
  materializationHash?: string;
  materialHash?: string;
  materialHashVersion?: typeof OZON_SHARED_MATERIAL_HASH_VERSION;
  contentPolicyVersion?: OzonStoredContentPolicyVersion;
  planHash?: string;
  requestId?: string;
  preparationJobId?: string;
  publicationMode?: 'CREATE_ONLY' | 'COMPATIBLE_UPSERT';
  presetBinding?: {
    presetId: string;
    presetName?: string;
    presetRowVersion?: number;
    sourcePresetExists: boolean;
  };
  revision?: number;
  state: OzonPublishJobState;
  source: 'MANUAL' | 'AUTO';
  payload?: OzonPublishJobPayload;
  timings?: OzonPublishTimings;
  mediaUploadAudit?: OzonMediaUploadAudit[];
  taskId?: string;
  importTaskId?: string;
  ozonProductId?: string;
  ozonProductUrl?: string;
  ozonProductLinks: OzonProductLink[];
  taskFolder?: string;
  workRelPath?: string;
  directoryStage?: OzonTaskDirectoryStage;
  directorySignature?: string;
  stageStates: OzonPublishStageStates;
  retryCount: number;
  rowVersion: number;
  leaseOwner?: string;
  leaseExpiresAt?: string;
  leaseToken?: string;
  lastErrorCode?: string;
  lastErrorMessage?: string;
  nextAttemptAt?: string;
  createdAt: string;
  updatedAt: string;
  finishedAt?: string;
  events?: OzonPublishEvent[];
  fanoutSummary?: OzonPreparationFanoutSummary;
};

const OZON_REMOTE_PROGRESS_STATES = new Set<OzonPublishJobState>([
  'UPLOADING_MEDIA',
  'SUBMITTING',
  'IMPORTING',
  'VERIFYING_IMAGES',
  'UPDATING_PRICE',
  'UPDATING_STOCK',
  'MODERATING'
]);

const OZON_AUTO_CANCELLABLE_STATES = new Set<OzonPublishJobState>([
  'WAITING_MEDIA',
  'READY',
  'NEEDS_ATTENTION',
  'FAILED'
]);

export type OzonRemoteProgressJob = Pick<OzonPublishJob, 'state'>
  & Partial<Pick<OzonPublishJob, 'taskId' | 'importTaskId' | 'ozonProductId' | 'directoryStage' | 'leaseOwner' | 'leaseToken' | 'leaseExpiresAt' | 'revision' | 'offerIds' | 'payload'>>
  & {
    ozonProductLinks?: ReadonlyArray<Partial<Pick<OzonProductLink, 'ozonProductId' | 'ozonSku' | 'url'>>>;
  };

export function ozonJobHasRemoteProgress(job: OzonRemoteProgressJob): boolean {
  const payload = job.payload && typeof job.payload === 'object' ? job.payload : {};
  const fixedPublicationTaskIdentity = Number(payload.schemaVersion) === 4
    && payload.mode === 'MULTISTORE_PUBLICATION'
    && Boolean(String(payload.publicationId || '').trim())
    && Boolean(String(payload.planHash || '').trim());
  const hasProductLink = (job.ozonProductLinks || []).some((link) => Boolean(
    String(link.ozonProductId || '').trim()
    || String(link.ozonSku || '').trim()
    || String(link.url || '').trim()
  ));
  return Boolean(
    (String(job.taskId || '').trim() && !fixedPublicationTaskIdentity)
    || String(job.importTaskId || '').trim()
    || String(job.ozonProductId || '').trim()
    || hasProductLink
    || job.directoryStage === 'PROCESSING'
    || OZON_REMOTE_PROGRESS_STATES.has(job.state)
  );
}

export function ozonJobHasActiveLease(
  job: Pick<OzonRemoteProgressJob, 'leaseExpiresAt'>,
  nowInput: number | Date = Date.now()
): boolean {
  const expiresAt = Date.parse(String(job.leaseExpiresAt || ''));
  const now = nowInput instanceof Date ? nowInput.getTime() : Number(nowInput);
  return Number.isFinite(expiresAt) && Number.isFinite(now) && expiresAt > now;
}

export function ozonJobHasLocalGenerationClaim(job: OzonRemoteProgressJob): boolean {
  const payload = job.payload && typeof job.payload === 'object' ? job.payload : {};
  return Boolean(
    Number(job.revision || 0) > 0
    || (job.offerIds || []).length > 0
    || String(payload.autoPreparedByJobId || '').trim()
    || Number(payload.autoPreparedListingRevision || 0) > 0
    || Number(payload.revision || 0) > 0
    || (Array.isArray(payload.expectedOfferIds) && payload.expectedOfferIds.length > 0)
    || String(payload.offerContractHash || '').trim()
  );
}

export function ozonAutoJobCanCancel(
  job: OzonRemoteProgressJob & Pick<OzonPublishJob, 'source'>,
  nowInput: number | Date = Date.now()
): boolean {
  return job.source === 'AUTO'
    && OZON_AUTO_CANCELLABLE_STATES.has(job.state)
    && !ozonJobHasRemoteProgress(job)
    && !ozonJobHasLocalGenerationClaim(job)
    && !ozonJobHasActiveLease(job, nowInput);
}

export type OzonJobRecoveryAction = 'RECHECK' | 'RETURN_TO_EDIT' | 'NONE';

export type OzonOfferWriteProgress = {
  offerId: string;
  priceStatus: 'SUCCEEDED' | 'PENDING' | 'FAILED' | 'UNKNOWN';
  stockStatus: 'SUCCEEDED' | 'PENDING' | 'FAILED' | 'UNKNOWN';
  errors?: Array<{ operation: 'pricesWrite' | 'stocksWrite'; code: string; message: string }>;
};

export type OzonJobRecovery = {
  action: OzonJobRecoveryAction;
  retryable: boolean;
  reason: string;
  resumeState?: OzonPublishJobState;
  attempt: number;
  maxAttempts: number;
  startedAt?: string;
  deadlineAt?: string;
  nextAttemptAt?: string;
  offers: OzonOfferWriteProgress[];
};

export type OzonActiveJobSummary = Pick<
  OzonPublishJob,
  'id' | 'taskKind' | 'source' | 'state' | 'taskId' | 'importTaskId' | 'ozonProductId' | 'nextAttemptAt' | 'createdAt' | 'updatedAt'
> & { recoveryAction?: OzonJobRecoveryAction; networkRecovery?: OzonNetworkRecovery };

export type OzonManualJobDetail = {
  job: OzonPublishJob;
  recovery: OzonJobRecovery;
};

export type OzonListingDetail = {
  listing: OzonListingDraft;
  activeJob?: OzonActiveJobSummary;
  canManualTakeover: boolean;
  /** Always returned by current manual-listing APIs; optional for older clients and cached responses. */
  priceProjection?: OzonListingPriceProjection;
  purchaseMeasurementProjection?: OzonManualPurchaseMeasurementProjection;
  generatedProductSummary?: {
    schemaVersion: 1 | 2;
    videoMode?: OzonVideoPublishMode;
    revision: number;
    generatedAt?: string;
    isCurrent: boolean;
  };
  sourceMediaCleanup?: import('./ozon-multistore.js').OzonSourceMediaCleanupSummary;
};

export type OzonManualSubmissionResult = {
  listing: OzonListingDraft;
  job: OzonPublishJob;
  productJsonPath: string;
  dispatched: boolean;
  supersededJobId?: string;
};

export const ozonCompatibleAppendInputSchema = z.object({
  rowVersion: z.number().int().positive(),
  planHash: z.string().regex(/^sha256:[a-f0-9]{64}$/)
});

export const ozonCompatibleAppendPlanSchema = z.object({
  mode: z.literal('COMPATIBLE_APPEND'),
  sku: z.string().regex(/^\d{7}$/),
  rowVersion: z.number().int().positive(),
  planHash: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  manifestSignature: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  canAppend: z.boolean(),
  blockedReason: z.string().trim().min(1).max(2_000).optional(),
  preservedOffers: z.array(z.object({
    offerId: z.string().trim().min(1).max(50),
    variantId: z.string().uuid().optional(),
    variantName: z.string().trim().min(1).max(256).optional(),
    ozonProductId: z.string().trim().min(1).optional(),
    ozonSku: z.string().trim().min(1).optional()
  })).max(100),
  newOffers: z.array(z.object({
    offerId: z.string().trim().min(1).max(50),
    variantId: z.string().uuid(),
    variantName: z.string().trim().min(1).max(256),
    imageCount: z.number().int().nonnegative(),
    hasVideo: z.boolean()
  })).max(99),
  preservedOfferIds: z.array(z.string().trim().min(1).max(50)).max(100),
  submittedOfferIds: z.array(z.string().trim().min(1).max(50)).max(99)
});

export type OzonCompatibleAppendInput = z.infer<typeof ozonCompatibleAppendInputSchema>;
export type OzonCompatibleAppendPlan = z.infer<typeof ozonCompatibleAppendPlanSchema>;
export type OzonCompatibleAppendResult = {
  mode: 'COMPATIBLE_APPEND';
  job: OzonPublishJob;
  listing: OzonListingDraft;
  dispatched: boolean;
  preservedOfferIds: string[];
  submittedOfferIds: string[];
  variants: Array<{ variantId: string; variantName: string; offerId: string }>;
};

export const OZON_PLATFORM_OFFER_DISPLAY_STATES = [
  'ON_SALE',
  'MODERATING',
  'OUT_OF_STOCK',
  'NOT_FOR_SALE',
  'ERROR',
  'HIDDEN',
  'ARCHIVED',
  'NOT_FOUND',
  'UNKNOWN'
] as const;

export type OzonPlatformOfferDisplayState = (typeof OZON_PLATFORM_OFFER_DISPLAY_STATES)[number];
export type OzonPlatformBusinessState = 'PUBLISHED' | 'MODERATING' | 'NEEDS_ATTENTION';

export type OzonPlatformStatusSnapshot = {
  displayState: OzonPlatformOfferDisplayState;
  businessState: OzonPlatformBusinessState;
  readAt: string;
  missingConfirmationCount: number;
  statusName?: string;
  statusDescription?: string;
  moderateStatus?: string;
  validationStatus?: string;
  isCreated?: boolean;
  visible?: boolean;
  hasPrice?: boolean;
  hasStock?: boolean;
  imageCount?: number;
  errorCodes?: string[];
  warnings?: string[];
};

export type OzonPlatformOfferStatus = OzonPlatformStatusSnapshot & {
  offerId: string;
  ozonProductId?: string;
  ozonSku?: string;
  confirmed: boolean;
  platformMessage?: string;
};

export type OzonPlatformStatusRefreshResult = {
  listing: OzonListingDraft;
  job?: OzonPublishJob;
  storeAlias: string;
  businessState: OzonPlatformBusinessState;
  offers: OzonPlatformOfferStatus[];
  warnings: string[];
  refreshedAt: string;
  changed: boolean;
};

export type OzonProductLink = {
  offerId: string;
  ozonProductId: string;
  ozonSku?: string;
  url: string;
  displayState?: OzonPlatformOfferDisplayState;
  platformMessage?: string;
  warnings?: string[];
  lastVerifiedAt?: string;
};

export type OzonProductMapping = {
  storeAlias: string;
  offerId: string;
  sku: string;
  ozonProductId?: string;
  ozonSku?: string;
  warehouseId?: string;
  lastAppliedRevision: number;
  status: string;
  statusSnapshot?: Record<string, unknown>;
  lastVerifiedAt?: string;
  updatedAt: string;
};

export type OzonProductMappingInput = {
  offerId: string;
  ozonProductId: string;
  ozonSku?: string;
  warehouseId?: string;
  platformStatus?: string;
  statusSnapshot?: Record<string, unknown>;
};

export type OzonSystemSettings = Omit<OzonSystemSettingsInput, 'rowVersion'> & {
  rowVersion: number;
  /** Internal read-only sentinel for immutable pre-migration task snapshots. */
  defaultStoreAlias: string;
  credentialReady: boolean;
  sellerId?: string;
  sellerName?: string;
  accountCurrency?: string;
  lastPreflightAt?: string;
  lastPreflightStatus?: 'NOT_RUN' | 'READY' | 'FAILED';
  lastPreflightMessage?: string;
  videoUploadReady: boolean;
  videoUploadCheckedAt?: string;
  videoUploadMessage?: string;
  updatedAt: string;
};
