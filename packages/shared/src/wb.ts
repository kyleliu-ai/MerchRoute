import { z } from 'zod';

export const WB_PURCHASE_CHARACTERISTIC_BINDINGS = [
  {
    characteristicId: 90630,
    purchaseField: 'productHeightCm',
    labelZh: '物体高度',
    labelRu: 'Высота предмета',
    unit: 'cm'
  },
  {
    characteristicId: 90652,
    purchaseField: 'productDepthCm',
    labelZh: '物体深度',
    labelRu: 'Глубина предмета',
    unit: 'cm'
  },
  {
    characteristicId: 90673,
    purchaseField: 'productWidthCm',
    labelZh: '物体宽度',
    labelRu: 'Ширина предмета',
    unit: 'cm'
  },
  {
    characteristicId: 89008,
    purchaseField: 'netWeightGrams',
    labelZh: '无包装重量',
    labelRu: 'Вес товара без упаковки (г)',
    unit: 'g'
  }
] as const;

export const WB_DESCRIPTION_MAX_LENGTH = 2_000;

export type WbPurchaseMeasurementField = typeof WB_PURCHASE_CHARACTERISTIC_BINDINGS[number]['purchaseField'];
export const WB_PURCHASE_CHARACTERISTIC_IDS = WB_PURCHASE_CHARACTERISTIC_BINDINGS.map((item) => item.characteristicId);
export function isWbPurchaseCharacteristicId(input: unknown): boolean {
  const id = Number(input);
  return Number.isInteger(id) && WB_PURCHASE_CHARACTERISTIC_IDS.includes(id as typeof WB_PURCHASE_CHARACTERISTIC_IDS[number]);
}

export const wbPurchaseMeasurementsSchema = z.object({
  procurementVersionId: z.string().uuid(),
  procurementVersionNo: z.number().int().positive(),
  capturedAt: z.string().datetime(),
  productHeightCm: z.number().positive().nullable(),
  productDepthCm: z.number().positive().nullable(),
  productWidthCm: z.number().positive().nullable(),
  netWeightGrams: z.number().positive().nullable()
});

export type WbPurchaseMeasurements = z.infer<typeof wbPurchaseMeasurementsSchema>;

export const WB_LISTING_STATUSES = [
  'DRAFT', 'STALE', 'GENERATING', 'GENERATED', 'SUBMITTING', 'WAITING_NETWORK', 'QUEUED', 'RUNNING',
  'SUCCEEDED', 'BLOCKED', 'FAILED', 'NEEDS_ATTENTION'
] as const;

export const WB_CATEGORY_VERSION_STATUSES = ['DRAFT', 'PUBLISHED', 'ARCHIVED'] as const;

export const wbPublishingConfigSchema = z.object({
  enabled: z.boolean().default(false),
  rootDirectory: z.string().default('')
});

export const wbCharacteristicScalarSchema = z.union([z.string(), z.number(), z.boolean()]);
export const wbCharacteristicValueSchema = z.union([
  wbCharacteristicScalarSchema,
  z.array(wbCharacteristicScalarSchema).min(1)
]);
export const wbCharacteristicSchema = z.object({
  id: z.number().int().positive(),
  value: wbCharacteristicValueSchema
});

export const wbColorIdentitySchema = z.object({
  colorKey: z.string().regex(/^[a-f0-9]{64}$/),
  nameRu: z.string().trim().min(1).max(256),
  nameZh: z.string().trim().min(1).max(256)
});

export const wbSizeDraftSchema = z.object({
  sizeId: z.string().uuid().optional(),
  techSize: z.string().max(128).optional(),
  wbSize: z.string().max(128).optional(),
  insoleLengthCm: z.number().positive().optional(),
  barcode: z.string().max(30).default(''),
  stock: z.number().int().nonnegative().default(0)
});

export const wbSizeSchema = z.object({
  techSize: z.string().trim().min(1).optional(),
  wbSize: z.string().trim().min(1).optional(),
  insoleLengthCm: z.number().positive().optional(),
  barcode: z.string().regex(/^(?:|[0-9]{8,30})$/, 'barcode 必须为空或 8 到 30 位数字').default(''),
  stock: z.number().int().nonnegative().default(0)
});

export const wbVariantDraftSchema = z.object({
  variantId: z.string().uuid(),
  productVariantId: z.string().uuid().optional(),
  productVariantName: z.string().trim().min(1).max(64).optional(),
  productVariantColor: wbColorIdentitySchema.optional(),
  variantCode: z.string().trim().min(1).max(128),
  vendorCode: z.string().trim().min(1).max(128),
  descriptionRu: z.string().max(5_000).optional(),
  characteristics: z.array(wbCharacteristicSchema).default([]),
  sizes: z.array(wbSizeDraftSchema).default([])
});

export const wbVariantMediaSchema = z.object({
  variantId: z.string().uuid(),
  imageAssetIds: z.array(z.string().min(1)).max(30).default([]),
  videoAssetId: z.string().min(1).optional()
}).superRefine((value, context) => {
  if (new Set(value.imageAssetIds).size !== value.imageAssetIds.length) {
    context.addIssue({ code: 'custom', path: ['imageAssetIds'], message: '同一变体不能重复选择同一张图片' });
  }
});

export const wbFormFieldSchema = z.object({
  fieldId: z.string().trim().min(1).max(128),
  characteristicId: z.number().int().positive(),
  labelRu: z.string().trim().min(1).max(256),
  labelZh: z.string().trim().max(256).optional(),
  scope: z.enum(['shared', 'variant']),
  control: z.enum(['text', 'number', 'select', 'multi-select', 'boolean']),
  required: z.boolean().default(false),
  order: z.number().int().nonnegative(),
  directory: z.string().trim().min(1).optional()
});

export const wbVideoUploadModeSchema = z.enum(['ORIGINAL', 'COMPRESSED_COPY']);

export const wbFormConfigSchema = z.object({
  fields: z.array(wbFormFieldSchema).default([]),
  sizeMode: z.enum(['sized', 'sizeless']).default('sized'),
  media: z.object({
    minImages: z.number().int().min(0).max(30).default(1),
    maxImages: z.number().int().min(1).max(30).default(30),
    videoAllowed: z.boolean().default(true),
    defaultVideoUploadMode: wbVideoUploadModeSchema.default('COMPRESSED_COPY')
  }).default({ minImages: 1, maxImages: 30, videoAllowed: true, defaultVideoUploadMode: 'COMPRESSED_COPY' }),
  compliance: z.object({
    tnvedCharacteristicId: z.number().int().positive().nullable().default(null),
    tnvedRequired: z.boolean().default(false)
  }).default({ tnvedCharacteristicId: null, tnvedRequired: false })
}).superRefine((value, context) => {
  if (value.media.minImages > value.media.maxImages) {
    context.addIssue({ code: 'custom', path: ['media', 'minImages'], message: '最少图片数不能大于最多图片数' });
  }
  const fieldIds = new Set<string>();
  const characteristicIds = new Set<number>();
  for (const [index, field] of value.fields.entries()) {
    if (fieldIds.has(field.fieldId)) context.addIssue({ code: 'custom', path: ['fields', index, 'fieldId'], message: '字段 ID 不能重复' });
    if (characteristicIds.has(field.characteristicId)) context.addIssue({ code: 'custom', path: ['fields', index, 'characteristicId'], message: 'WB characteristic ID 不能重复' });
    fieldIds.add(field.fieldId);
    characteristicIds.add(field.characteristicId);
  }
  if (value.compliance.tnvedRequired && value.compliance.tnvedCharacteristicId === null) {
    context.addIssue({ code: 'custom', path: ['compliance', 'tnvedRequired'], message: 'TNVED 必填规则必须关联有效的 characteristic ID' });
  }
});

export const wbCategoryKeySchema = z.string().trim().min(2).max(96).regex(/^[a-z0-9][a-z0-9_-]*$/, '类目 Key 只能包含小写字母、数字、下划线和连字符');

export const wbClubDiscountSchema = z.number().int().refine(
  (value) => value === 0 || (value >= 3 && value <= 31),
  'WB Club 专享折扣只能为 0（关闭）或 3 到 31 的整数'
);

export const wbAutoPublishModeSchema = z.enum(['CREATE_ONLY', 'COMPATIBLE_UPSERT']);

export const wbListingPresetPackagingSchema = z.object({
  grossWeightGrams: z.number().positive(),
  lengthCm: z.number().positive(),
  widthCm: z.number().positive(),
  heightCm: z.number().positive()
});

export const wbListingPresetSizeSchema = z.object({
  sizeId: z.string().uuid().optional(),
  techSize: z.string().trim().max(128).optional(),
  wbSize: z.string().trim().max(128).optional(),
  insoleLengthCm: z.number().positive().optional(),
  stock: z.number().int().nonnegative().default(0)
});

const wbListingPresetDefinitionObjectSchema = z.object({
  name: z.string().trim().min(1).max(128),
  description: z.string().trim().max(1_000).default(''),
  autoPublishEnabled: z.boolean().default(false),
  autoPublishMode: wbAutoPublishModeSchema.default('CREATE_ONLY'),
  pricingTemplateId: z.string().uuid(),
  shippingTemplateId: z.string().uuid(),
  shippingServiceCode: z.string().trim().min(1).max(64).regex(/^[A-Z0-9_-]+$/, '服务渠道代码格式无效').transform((value) => value.toUpperCase()),
  destinationCountryCode: z.string().trim().min(2).max(8).transform((value) => value.toUpperCase()).nullish(),
  packaging: wbListingPresetPackagingSchema,
  categoryKey: wbCategoryKeySchema,
  discountPercent: z.number().int().min(0).max(99).default(0),
  clubDiscount: wbClubDiscountSchema.nullable().default(null),
  tnved: z.string().trim().refine((value) => value === '' || /^\d{10}$/.test(value), 'TNVED 留空或填写 10 位数字'),
  brand: z.string().trim().max(256).default(''),
  titleTranslation: z.object({
    workflowId: z.string().trim().min(1).max(128).default('W2lSSXE3NUaLW1tD'),
    language: z.string().trim().min(1).max(64).default('俄文'),
    maxLength: z.number().int().min(1).max(60).default(60)
  }).default({ workflowId: 'W2lSSXE3NUaLW1tD', language: '俄文', maxLength: 60 }),
  descriptionSource: z.literal('E003').default('E003'),
  sharedCharacteristics: z.array(wbCharacteristicSchema).default([]),
  variantCharacteristics: z.array(wbCharacteristicSchema).default([]),
  sizes: z.array(wbListingPresetSizeSchema).min(1).max(100)
});

function validatePresetCharacteristicDuplicates(
  value: Pick<z.infer<typeof wbListingPresetDefinitionObjectSchema>, 'sharedCharacteristics' | 'variantCharacteristics'>,
  context: z.RefinementCtx
): void {
  const seen = new Map<number, 'sharedCharacteristics' | 'variantCharacteristics'>();
  for (const key of ['sharedCharacteristics', 'variantCharacteristics'] as const) {
    for (const [index, characteristic] of value[key].entries()) {
      const previous = seen.get(characteristic.id);
      if (previous) {
        context.addIssue({
          code: 'custom',
          path: [key, index, 'id'],
          message: previous === key
            ? '同一预设范围内的 characteristic ID 不能重复'
            : '同一 characteristic ID 不能同时配置为共享字段和变体字段'
        });
      } else {
        seen.set(characteristic.id, key);
      }
    }
  }
}

export const wbListingPresetDefinitionSchema = wbListingPresetDefinitionObjectSchema.superRefine(validatePresetCharacteristicDuplicates);

export const wbListingPresetUpdateSchema = wbListingPresetDefinitionObjectSchema.extend({
  rowVersion: z.number().int().positive()
}).superRefine(validatePresetCharacteristicDuplicates);

export const wbCategoryDraftInputSchema = z.object({
  nameRu: z.string().trim().min(1).max(256),
  nameZh: z.string().trim().max(256).default(''),
  subjectId: z.number().int().positive(),
  liveSchema: z.unknown(),
  formConfig: wbFormConfigSchema
});

export const wbListingDraftUpdateSchema = z.object({
  draftVersion: z.number().int().positive(),
  categoryKey: wbCategoryKeySchema.optional(),
  categoryVersionId: z.string().uuid().optional(),
  brand: z.string().max(256).optional(),
  titleRu: z.string().max(60).optional(),
  descriptionRu: z.string().max(5_000).optional(),
  descriptionProvenance: z.object({
    type: z.enum(['MANUAL_IMPORT', 'USER_EDIT']),
    fileName: z.string().trim().min(1).max(255).optional(),
    sha256: z.string().regex(/^[a-f0-9]{64}$/).optional()
  }).optional(),
  packaging: z.record(z.unknown()).optional(),
  priceCny: z.number().nonnegative().optional(),
  discountPercent: z.number().int().min(0).max(99).optional(),
  clubDiscount: wbClubDiscountSchema.nullable().optional(),
  videoUploadMode: wbVideoUploadModeSchema.optional(),
  compliance: z.object({
    tnved: z.string().trim().refine((value) => value === '' || /^\d{10}$/.test(value), 'TNVED 留空或填写 10 位数字').default(''),
    kizMarked: z.boolean().default(false)
  }).transform((value) => value.tnved ? value : { tnved: '', kizMarked: false }).optional(),
  sharedCharacteristics: z.array(wbCharacteristicSchema).optional(),
  variants: z.array(wbVariantDraftSchema).min(1).optional(),
  variantMedia: z.array(wbVariantMediaSchema).optional()
});

export const wbPackagingSchema = z.object({
  lengthCm: z.number().positive(),
  widthCm: z.number().positive(),
  heightCm: z.number().positive(),
  weightKg: z.number().positive()
});

const wbProductDescriptionSchema = z.string().trim().min(1).refine(
  (value) => wbTextLength(value) <= WB_DESCRIPTION_MAX_LENGTH,
  `产品详情不能超过 ${WB_DESCRIPTION_MAX_LENGTH} 字符`
);

export const wbProductV2Schema = z.object({
  schemaVersion: z.literal(2),
  productCode: z.string().regex(/^\d{7}$/),
  revision: z.number().int().positive(),
  category: z.object({
    key: wbCategoryKeySchema,
    subjectId: z.number().int().positive(),
    templateVersion: z.number().int().positive(),
    schemaHash: z.string().regex(/^sha256:[a-f0-9]{64}$/)
  }),
  brand: z.string(),
  titleRu: z.string().trim().min(1).max(60),
  descriptionRu: wbProductDescriptionSchema,
  packaging: wbPackagingSchema,
  priceCny: z.number().positive(),
  discountPercent: z.number().int().min(0).max(99),
  clubDiscount: wbClubDiscountSchema.optional(),
  videoUploadMode: wbVideoUploadModeSchema.default('ORIGINAL'),
  compliance: z.object({ tnved: z.string().trim().regex(/^\d{10}$/, 'TNVED 必须为 10 位数字'), kizMarked: z.boolean() }).optional(),
  variants: z.array(z.object({
    variantCode: z.string().trim().min(1).max(128).regex(/^[A-Za-z0-9._-]+$/, 'variantCode 只能包含 ASCII 字母、数字、点、下划线和连字符'),
    vendorCode: z.string().trim().min(1).max(128).regex(/^[A-Za-z0-9._-]+$/, 'vendorCode 只能包含 ASCII 字母、数字、点、下划线和连字符'),
    descriptionRu: wbProductDescriptionSchema.optional(),
    characteristics: z.array(wbCharacteristicSchema).min(1),
    images: z.array(z.string().min(1)).min(1).max(30),
    video: z.string().min(1).optional(),
    sizes: z.array(wbSizeSchema).min(1, '每个变体至少需要一个条码/库存 SKU 行')
  })).min(1)
}).superRefine((value, context) => {
  if (/[\r\n]/.test(value.descriptionRu)) {
    context.addIssue({ code: 'custom', path: ['descriptionRu'], message: '产品详情不能包含真实回车或换行' });
  }
  const variantCodes = new Set<string>();
  const vendorCodes = new Set<string>();
  const barcodes = new Set<string>();
  for (const [variantIndex, variant] of value.variants.entries()) {
    if (variant.descriptionRu && /[\r\n]/.test(variant.descriptionRu)) {
      context.addIssue({ code: 'custom', path: ['variants', variantIndex, 'descriptionRu'], message: '变体产品详情不能包含真实回车或换行' });
    }
    if (variantCodes.has(variant.variantCode)) context.addIssue({ code: 'custom', path: ['variants', variantIndex, 'variantCode'], message: 'variantCode 必须在商品内唯一' });
    if (vendorCodes.has(variant.vendorCode)) context.addIssue({ code: 'custom', path: ['variants', variantIndex, 'vendorCode'], message: 'vendorCode 必须在商品内唯一' });
    if (!variant.vendorCode.startsWith(value.productCode)) context.addIssue({ code: 'custom', path: ['variants', variantIndex, 'vendorCode'], message: 'vendorCode 必须以 productCode 开头' });
    variantCodes.add(variant.variantCode);
    vendorCodes.add(variant.vendorCode);
    const ids = variant.characteristics.map((item) => item.id);
    if (new Set(ids).size !== ids.length) {
      context.addIssue({ code: 'custom', path: ['variants', variantIndex, 'characteristics'], message: '同一变体的 characteristic ID 不能重复' });
    }
    if (new Set(variant.images).size !== variant.images.length) context.addIssue({ code: 'custom', path: ['variants', variantIndex, 'images'], message: '同一变体不能重复引用同一图片' });
    for (const [sizeIndex, size] of variant.sizes.entries()) {
      if (size.barcode && barcodes.has(size.barcode)) context.addIssue({ code: 'custom', path: ['variants', variantIndex, 'sizes', sizeIndex, 'barcode'], message: 'barcode 必须在商品内唯一' });
      if (size.barcode) barcodes.add(size.barcode);
    }
  }
});

export type WbPublishingConfig = z.infer<typeof wbPublishingConfigSchema>;
export type WbFormConfig = z.infer<typeof wbFormConfigSchema>;
export type WbCategoryDraftInput = z.infer<typeof wbCategoryDraftInputSchema>;
export type WbListingDraftUpdate = z.infer<typeof wbListingDraftUpdateSchema>;
export const WB_SOURCE_MEDIA_STATES = ['AVAILABLE', 'CLEANUP_PENDING', 'CLEANED'] as const;
export const wbSourceMediaStateSchema = z.enum(WB_SOURCE_MEDIA_STATES);
export type WbSourceMediaState = z.infer<typeof wbSourceMediaStateSchema>;
export type WbProductV2 = z.infer<typeof wbProductV2Schema>;
export type WbVariantDraft = z.infer<typeof wbVariantDraftSchema>;
export type WbVariantMedia = z.infer<typeof wbVariantMediaSchema>;
export type WbListingPresetDefinition = z.infer<typeof wbListingPresetDefinitionSchema>;
export type WbListingPresetUpdate = z.infer<typeof wbListingPresetUpdateSchema>;

export const WB_AUTO_PUBLISH_STATES = [
  'WAITING_MEDIA', 'WAITING_STABLE', 'WAITING_NETWORK', 'WAITING_GENERATION_TURN', 'CHECKING', 'INITIALIZING', 'GENERATING', 'SUBMITTING',
  'QUEUED', 'RUNNING', 'SUCCEEDED', 'NEEDS_ATTENTION', 'PAUSED', 'BLOCKED_EXISTING_CARD',
  'FAILED', 'CANCELLED'
] as const;

export const wbAutoPublishStateSchema = z.enum(WB_AUTO_PUBLISH_STATES);
export const wbNetworkDeliveryStateSchema = z.enum(['NOT_SENT', 'UNKNOWN', 'RESPONDED']);
export const wbNetworkRecoverySchema = z.object({
  phase: z.string().trim().min(1),
  resumeState: z.string().trim().min(1),
  deliveryState: wbNetworkDeliveryStateSchema,
  attempt: z.number().int().positive(),
  firstFailureAt: z.string().datetime(),
  lastFailureAt: z.string().datetime(),
  nextAttemptAt: z.string().datetime(),
  lastErrorCode: z.string().trim().min(1),
  lastErrorMessage: z.string(),
  retryAfterMs: z.number().int().nonnegative().optional(),
  checkpoint: z.string().trim().min(1).optional(),
  readableAmbiguityElapsedMs: z.number().int().nonnegative().optional(),
  readableAmbiguityLastObservedAt: z.string().datetime().optional()
});
export const wbSubmissionModeSchema = z.enum(['UPSERT', 'CREATE_ONLY', 'COMPATIBLE_UPSERT']);
export const wbMediaPolicySchema = z.enum(['MISSING_ONLY', 'REPLACE_SELECTED']);
export type WbAutoPublishState = z.infer<typeof wbAutoPublishStateSchema>;
export type WbAutoPublishMode = z.infer<typeof wbAutoPublishModeSchema>;
export type WbNetworkDeliveryState = z.infer<typeof wbNetworkDeliveryStateSchema>;
export type WbNetworkRecovery = z.infer<typeof wbNetworkRecoverySchema>;
export type WbSubmissionMode = z.infer<typeof wbSubmissionModeSchema>;
export type WbMediaPolicy = z.infer<typeof wbMediaPolicySchema>;

export type WbMediaMatchAsset = {
  productVariantId?: string;
  productVariantColor?: { colorKey: string };
};

export type WbMediaMatchVariant = {
  variantId: string;
  wbColor?: { colorKey: string };
};

/**
 * Stable-identity media matching shared by the manual workbench and automatic publisher.
 * When an asset has a productVariantId, a mismatch must not fall back to color or name.
 */
export function wbMediaMatchesVariant(asset: WbMediaMatchAsset, variant: WbMediaMatchVariant): boolean {
  if (asset.productVariantId) return asset.productVariantId === variant.variantId;
  return Boolean(asset.productVariantColor?.colorKey && variant.wbColor?.colorKey
    && asset.productVariantColor.colorKey === variant.wbColor.colorKey);
}

export function latestWbMediaDeliveryBatch<T extends { sourceSubmissionId?: string; deliveredAt?: string }>(assets: T[]): T[] {
  if (!assets.length) return [];
  const groups = new Map<string, T[]>();
  for (const asset of assets) {
    const key = asset.sourceSubmissionId || '__legacy__';
    groups.set(key, [...(groups.get(key) || []), asset]);
  }
  const latest = [...groups.entries()].sort((left, right) => wbMediaBatchSortValue(right).localeCompare(wbMediaBatchSortValue(left)))[0];
  return latest?.[1] || [];
}

function wbMediaBatchSortValue<T extends { deliveredAt?: string }>(entry: [string, T[]]): string {
  const deliveredAt = entry[1].map((asset) => asset.deliveredAt || '').sort().at(-1) || '';
  return `${deliveredAt}\0${entry[0]}`;
}

export function normalizeWbDescription(input: string): string {
  const normalized = String(input ?? '')
    .trim()
    .replace(/\r\n?/g, '\n')
    .replace(/\\r\\n|\\r|\\n/g, '\n')
    .replace(/[ \t]*\n+[ \t]*/g, '\\n\\n')
    .replace(/(?:\\n\\n)+/g, '\\n\\n')
    .replace(/^(?:\\n\\n)+|(?:\\n\\n)+$/g, '');
  if (/[\r\n]/.test(normalized)) throw new Error('产品详情规范化失败');
  return normalized;
}

export type WbDescriptionLimitResult = {
  value: string;
  originalLength: number;
  finalLength: number;
  truncated: boolean;
  maxLength: number;
  limitSource: 'WB_SAFE_DEFAULT';
};

export function limitWbDescription(input: string, maxLength = WB_DESCRIPTION_MAX_LENGTH): WbDescriptionLimitResult {
  const normalized = normalizeWbDescription(input);
  if (!Number.isInteger(maxLength) || maxLength < 1) throw new Error('WB 描述长度上限无效');
  const originalLength = wbTextLength(normalized);
  if (originalLength <= maxLength) {
    return {
      value: normalized,
      originalLength,
      finalLength: originalLength,
      truncated: false,
      maxLength,
      limitSource: 'WB_SAFE_DEFAULT'
    };
  }
  const paragraphs = normalized.split('\\n\\n').filter(Boolean);
  let value = '';
  for (const paragraph of paragraphs) {
    const candidate = value ? `${value}\\n\\n${paragraph}` : paragraph;
    if (wbTextLength(candidate) > maxLength) break;
    value = candidate;
  }
  if (!value) value = truncateWbText(normalized, maxLength);
  if (wbTextLength(value) > maxLength) value = truncateWbText(value, maxLength);
  value = value.replace(/(?:\\n\\n)+$/g, '').trim();
  if (wbTextLength(value) > maxLength) value = truncateWbText(value, maxLength).replace(/(?:\\n\\n)+$/g, '').trim();
  if (/[\r\n]/.test(value)) throw new Error('产品详情长度处理失败');
  return {
    value,
    originalLength,
    finalLength: wbTextLength(value),
    truncated: true,
    maxLength,
    limitSource: 'WB_SAFE_DEFAULT'
  };
}

function wbTextLength(input: string): number {
  return Array.from(input).length;
}

function truncateWbText(input: string, maxLength: number): string {
  return Array.from(input).slice(0, maxLength).join('');
}

export function normalizeWbComparablePath(input: string): string {
  const normalized = String(input || '').trim().replaceAll('\\', '/').replace(/\/+$/, '');
  const isWindowsPath = /^[a-zA-Z]:\//.test(normalized) || /^\/\/[^/]+\/[^/]+/.test(normalized);
  return isWindowsPath ? normalized.toLocaleLowerCase('en-US') : normalized;
}
