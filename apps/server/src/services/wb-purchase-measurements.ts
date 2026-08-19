import {
  AppError,
  WB_PURCHASE_CHARACTERISTIC_BINDINGS,
  WB_PURCHASE_CHARACTERISTIC_IDS,
  wbPurchaseMeasurementsSchema,
  type WbPurchaseMeasurements
} from '@n8n-media-review/shared';

type JsonRecord = Record<string, any>;

export type WbPurchaseMeasurementSource = {
  procurementVersionId: string;
  procurementVersionNo: number;
  productHeightCm?: string | number | null;
  productDepthCm?: string | number | null;
  productWidthCm?: string | number | null;
  netWeightGrams?: string | number | null;
};

export type WbPurchaseMeasurementIssue = {
  code: 'PURCHASE_MEASUREMENT_REQUIRED_MISSING';
  message: string;
  field: string;
  severity: 'ERROR';
  retryable: true;
};

export type WbPurchaseMeasurementProjection = {
  snapshot: WbPurchaseMeasurements;
  characteristics: Array<{ id: number; value: number }>;
  issues: WbPurchaseMeasurementIssue[];
};

const SYSTEM_IDS = new Set<number>(WB_PURCHASE_CHARACTERISTIC_IDS);

export function createWbPurchaseMeasurements(
  source: WbPurchaseMeasurementSource,
  capturedAt = new Date().toISOString()
): WbPurchaseMeasurements {
  const values = Object.fromEntries(WB_PURCHASE_CHARACTERISTIC_BINDINGS.map((binding) => [
    binding.purchaseField,
    measurementNumber(source[binding.purchaseField], binding.purchaseField)
  ]));
  return wbPurchaseMeasurementsSchema.parse({
    procurementVersionId: source.procurementVersionId,
    procurementVersionNo: source.procurementVersionNo,
    capturedAt,
    ...values
  });
}

export function projectWbPurchaseMeasurements(
  snapshot: WbPurchaseMeasurements,
  formConfigInput: unknown,
  liveSchemaInput: unknown
): WbPurchaseMeasurementProjection {
  const formConfig = asObject(formConfigInput);
  const fields = Array.isArray(formConfig.fields) ? formConfig.fields.map(asObject) : [];
  const schema = characteristicSchemaMap(liveSchemaInput);
  const characteristics: Array<{ id: number; value: number }> = [];
  const issues: WbPurchaseMeasurementIssue[] = [];

  for (const binding of WB_PURCHASE_CHARACTERISTIC_BINDINGS) {
    const field = fields.find((candidate) => Number(candidate.characteristicId) === binding.characteristicId);
    if (!field) continue;
    if (field.scope !== 'shared') {
      throw new AppError('CONFIG_INVALID', `${binding.labelZh} #${binding.characteristicId} 必须配置为所有变体共享字段`, {
        characteristicId: binding.characteristicId,
        scope: field.scope
      }, 409);
    }
    const descriptor = schema.get(binding.characteristicId);
    const charcType = Number(descriptor?.charcType ?? descriptor?.charc_type);
    if (descriptor && charcType !== 4) {
      throw new AppError('CONFIG_INVALID', `${binding.labelZh} #${binding.characteristicId} 必须是 WB 数值型 characteristic`, {
        characteristicId: binding.characteristicId,
        charcType
      }, 409);
    }
    const value = snapshot[binding.purchaseField];
    if (value !== null) characteristics.push({ id: binding.characteristicId, value });
    const required = field.required === true
      || descriptor?.required === true
      || descriptor?.required === 1
      || descriptor?.isRequired === true;
    if (required && value === null) {
      issues.push({
        code: 'PURCHASE_MEASUREMENT_REQUIRED_MISSING',
        message: `${binding.labelZh}是当前 WB 类目的必填属性，请先在采购管理补充`,
        field: `purchaseMeasurements.${binding.purchaseField}`,
        severity: 'ERROR',
        retryable: true
      });
    }
  }
  return { snapshot, characteristics, issues };
}

export function applyWbPurchaseMeasurementProjection(
  dataInput: unknown,
  projection: WbPurchaseMeasurementProjection
): JsonRecord {
  const data = { ...asObject(dataInput) };
  const shared = withoutSystemCharacteristics(data.sharedCharacteristics);
  data.sharedCharacteristics = [...shared, ...projection.characteristics];
  if (Array.isArray(data.variants)) {
    data.variants = data.variants.map((variantInput) => {
      const variant = asObject(variantInput);
      return { ...variant, characteristics: withoutSystemCharacteristics(variant.characteristics) };
    });
  }
  const initialization = asObject(data.initialization);
  const previousIssues = Array.isArray(initialization.issues)
    ? initialization.issues.filter((candidate) => !isPurchaseMeasurementIssue(candidate))
    : [];
  const issues = [...previousIssues, ...projection.issues];
  data.purchaseMeasurements = projection.snapshot;
  data.initialization = { ...initialization, purchaseMeasurements: projection.snapshot, issues };
  data.initializationIssues = issues;
  return data;
}

export function sameWbPurchaseMeasurementValues(leftInput: unknown, rightInput: unknown, formConfigInput: unknown): boolean {
  const formConfig = asObject(formConfigInput);
  const fields = Array.isArray(formConfig.fields) ? formConfig.fields.map(asObject) : [];
  const applicable = WB_PURCHASE_CHARACTERISTIC_BINDINGS.filter((binding) => (
    fields.some((field) => Number(field.characteristicId) === binding.characteristicId)
  ));
  if (!applicable.length) return true;
  const left = wbPurchaseMeasurementsSchema.safeParse(leftInput);
  const right = wbPurchaseMeasurementsSchema.safeParse(rightInput);
  if (!left.success || !right.success) return false;
  return applicable.every(
    (binding) => left.data[binding.purchaseField] === right.data[binding.purchaseField]
  );
}

export function withoutSystemCharacteristics(input: unknown): JsonRecord[] {
  return Array.isArray(input)
    ? input.map(asObject).filter((item) => !SYSTEM_IDS.has(Number(item.id)))
    : [];
}

export function containsSystemCharacteristic(input: unknown): boolean {
  return Array.isArray(input) && input.some((candidate) => SYSTEM_IDS.has(Number(asObject(candidate).id)));
}

function measurementNumber(input: unknown, field: string): number | null {
  if (input === undefined || input === null || String(input).trim() === '') return null;
  const value = Number(input);
  if (!Number.isFinite(value) || value <= 0) {
    throw new AppError('CONFIG_INVALID', `采购信息 ${field} 必须是大于 0 的数字或留空`, { field, value: input }, 409);
  }
  return value;
}

function characteristicSchemaMap(input: unknown): Map<number, JsonRecord> {
  const root = asObject(input);
  const candidates = Array.isArray(input)
    ? input
    : Array.isArray(root.data)
      ? root.data
      : Array.isArray(root.characteristics)
        ? root.characteristics
        : [];
  const entries: Array<[number, JsonRecord]> = [];
  for (const candidate of candidates) {
    const item = asObject(candidate);
    const id = Number(item.charcID || item.id);
    if (Number.isInteger(id) && id > 0) entries.push([id, item]);
  }
  return new Map(entries);
}

function isPurchaseMeasurementIssue(input: unknown): boolean {
  const issue = asObject(input);
  return issue.code === 'PURCHASE_MEASUREMENT_REQUIRED_MISSING'
    || String(issue.field || '').startsWith('purchaseMeasurements.');
}

function asObject(value: unknown): JsonRecord {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : {};
}
