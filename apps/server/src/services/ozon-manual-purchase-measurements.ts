import {
  AppError,
  OZON_MANUAL_PURCHASE_ATTRIBUTE_BINDINGS,
  OZON_MANUAL_PURCHASE_ATTRIBUTE_IDS,
  ozonManualPurchaseMeasurementsSchema,
  type OzonAttributeValueInput,
  type OzonCategoryAttribute,
  type OzonManualPurchaseMeasurementField,
  type OzonManualPurchaseMeasurementIssue,
  type OzonManualPurchaseMeasurements
} from '@n8n-media-review/shared';

export type OzonManualPurchaseMeasurementSource = {
  id: string;
  versionNo: number;
  createdAt?: string;
  productHeightCm?: string | number | null;
  productDepthCm?: string | number | null;
  productWidthCm?: string | number | null;
  netWeightGrams?: string | number | null;
};

export type OzonManualPurchaseProjectionResult = {
  snapshot: OzonManualPurchaseMeasurements;
  attributes: OzonAttributeValueInput[];
  fields: OzonManualPurchaseMeasurementField[];
  issues: OzonManualPurchaseMeasurementIssue[];
};

const MANAGED_ATTRIBUTE_IDS = new Set<number>(OZON_MANUAL_PURCHASE_ATTRIBUTE_IDS);

export function categoryUsesOzonManualPurchaseMeasurements(attributes: OzonCategoryAttribute[]): boolean {
  return attributes.some((attribute) => attribute.complexId === 0 && MANAGED_ATTRIBUTE_IDS.has(attribute.id));
}

export function createOzonManualPurchaseMeasurements(
  source: OzonManualPurchaseMeasurementSource,
  capturedAt = new Date().toISOString()
): OzonManualPurchaseMeasurements {
  const values = Object.fromEntries(OZON_MANUAL_PURCHASE_ATTRIBUTE_BINDINGS.map((binding) => [
    binding.purchaseField,
    normalizePurchaseDecimal(source[binding.purchaseField], binding.purchaseField)
  ]));
  const parsed = ozonManualPurchaseMeasurementsSchema.safeParse({
    procurementVersionId: source.id,
    procurementVersionNo: Number(source.versionNo),
    capturedAt,
    ...values
  });
  if (!parsed.success) {
    throw new AppError('CONFIG_INVALID', '采购管理的产品尺寸或净重快照无效', {
      issues: parsed.error.issues
    }, 409);
  }
  return parsed.data;
}

export function projectOzonManualPurchaseMeasurements(
  currentAttributes: OzonAttributeValueInput[],
  categoryAttributes: OzonCategoryAttribute[],
  snapshot: OzonManualPurchaseMeasurements
): OzonManualPurchaseProjectionResult {
  const categoryById = new Map(
    categoryAttributes
      .filter((attribute) => attribute.complexId === 0 && MANAGED_ATTRIBUTE_IDS.has(attribute.id))
      .map((attribute) => [attribute.id, attribute])
  );
  const attributes = currentAttributes
    .map(cloneAttribute)
    .filter((attribute) => !MANAGED_ATTRIBUTE_IDS.has(attribute.attributeId));
  const fields: OzonManualPurchaseMeasurementField[] = [];
  const issues: OzonManualPurchaseMeasurementIssue[] = [];

  for (const binding of OZON_MANUAL_PURCHASE_ATTRIBUTE_BINDINGS) {
    const descriptor = categoryById.get(binding.attributeId);
    const value = snapshot[binding.purchaseField];
    const applicable = Boolean(descriptor);
    const required = descriptor?.required === true;
    const status: OzonManualPurchaseMeasurementField['status'] = !applicable
      ? 'NOT_APPLICABLE'
      : value !== null
        ? 'AVAILABLE'
        : required
          ? 'REQUIRED_MISSING'
          : 'OPTIONAL_MISSING';
    fields.push({ ...binding, value, required, applicable, status });
    if (!descriptor) continue;
    if (value !== null) {
      attributes.push({
        attributeId: binding.attributeId,
        complexId: 0,
        values: [{ value }]
      });
      continue;
    }
    if (required) {
      issues.push({
        code: 'OZON_PURCHASE_MEASUREMENT_REQUIRED_MISSING',
        message: `${binding.labelZh}是当前 OZON 类目的必填属性，请先在采购管理补充`,
        field: `purchaseMeasurements.${binding.purchaseField}`,
        attributeId: binding.attributeId,
        severity: 'ERROR',
        retryable: true
      });
    }
  }
  return { snapshot, attributes, fields, issues };
}

export function assertOzonManualPurchaseMeasurementsReady(
  projection: Pick<OzonManualPurchaseProjectionResult, 'issues'>
): void {
  if (!projection.issues.length) return;
  throw new AppError(
    'CONFIG_INVALID',
    projection.issues.map((issue) => issue.message).join('；'),
    { issues: projection.issues },
    409
  );
}

export function sameOzonManualPurchaseMeasurementValues(
  left: OzonManualPurchaseMeasurements | undefined,
  right: OzonManualPurchaseMeasurements
): boolean {
  if (!left) return false;
  return left.procurementVersionId === right.procurementVersionId
    && left.procurementVersionNo === right.procurementVersionNo
    && OZON_MANUAL_PURCHASE_ATTRIBUTE_BINDINGS.every(
      (binding) => left[binding.purchaseField] === right[binding.purchaseField]
    );
}

export function sameOzonManualPurchaseAttributes(
  left: OzonAttributeValueInput[],
  right: OzonAttributeValueInput[]
): boolean {
  const managed = (attributes: OzonAttributeValueInput[]) => attributes
    .filter((attribute) => MANAGED_ATTRIBUTE_IDS.has(attribute.attributeId))
    .map((attribute) => ({
      attributeId: attribute.attributeId,
      complexId: attribute.complexId,
      values: attribute.values.map((value) => ({ ...value }))
    }))
    .sort((a, b) => a.attributeId - b.attributeId || a.complexId - b.complexId);
  return JSON.stringify(managed(left)) === JSON.stringify(managed(right));
}

function normalizePurchaseDecimal(input: unknown, field: string): string | null {
  if (input === undefined || input === null || String(input).trim() === '') return null;
  const raw = String(input).trim();
  if (!/^\d+(?:\.\d+)?$/.test(raw)) {
    throw new AppError('CONFIG_INVALID', `采购信息 ${field} 必须是大于 0 的十进制数字或留空`, { field, value: input }, 409);
  }
  const numeric = Number(raw);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    throw new AppError('CONFIG_INVALID', `采购信息 ${field} 必须是大于 0 的十进制数字或留空`, { field, value: input }, 409);
  }
  const [integerInput, fractionInput = ''] = raw.split('.');
  const integer = integerInput!.replace(/^0+(?=\d)/, '') || '0';
  const fraction = fractionInput.replace(/0+$/, '');
  return fraction ? `${integer}.${fraction}` : integer;
}

function cloneAttribute(attribute: OzonAttributeValueInput): OzonAttributeValueInput {
  return { ...attribute, values: attribute.values.map((value) => ({ ...value })) };
}
