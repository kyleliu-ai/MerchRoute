import {
  AppError,
  ozonDimensionsSchema,
  ozonGrossWeightResolutionSchema,
  type OzonGrossWeightResolution,
  type OzonPresetInput
} from '@n8n-media-review/shared';

export type OzonGrossWeightProcurementInput = {
  id: string;
  versionNo: number;
  grossWeightGrams?: unknown;
};

type OzonDimensions = OzonPresetInput['dimensions'];

export function resolveOzonGrossWeight(
  procurement: OzonGrossWeightProcurementInput,
  presetDimensions: OzonDimensions,
  capturedAt = new Date().toISOString()
): OzonGrossWeightResolution {
  const dimensions = parseDimensions(presetDimensions);
  const presetGrossWeightGrams = dimensions.weight * weightUnitMultiplier(dimensions.weightUnit);
  const procurementGrossWeightGrams = positiveNumber(procurement.grossWeightGrams) ?? null;
  return parseResolution({
    source: procurementGrossWeightGrams === null ? 'PRESET_FALLBACK' : 'PROCUREMENT',
    effectiveGrossWeightGrams: procurementGrossWeightGrams ?? presetGrossWeightGrams,
    procurementGrossWeightGrams,
    presetGrossWeightGrams,
    procurementVersionId: procurement.id,
    procurementVersionNo: procurement.versionNo,
    procurementCapturedAt: capturedAt
  });
}

export function applyOzonGrossWeightToDimensions(
  presetDimensions: OzonDimensions,
  resolutionInput: OzonGrossWeightResolution
): OzonDimensions {
  const dimensions = parseDimensions(presetDimensions);
  const resolution = parseResolution(resolutionInput);
  return {
    length: dimensions.length,
    width: dimensions.width,
    height: dimensions.height,
    dimensionUnit: dimensions.dimensionUnit,
    weight: resolution.effectiveGrossWeightGrams,
    weightUnit: 'g'
  };
}

/**
 * Reads either an initialization object containing grossWeightResolution or a
 * resolution value itself. Historical initialization objects without the field
 * return undefined; once the field exists, invalid audit data is rejected.
 */
export function readOzonGrossWeightResolution(input: unknown): OzonGrossWeightResolution | undefined {
  if (input === undefined) return undefined;
  if (isRecord(input) && Object.hasOwn(input, 'grossWeightResolution')) {
    return parseResolution(input.grossWeightResolution);
  }
  if (isRecord(input) && (
    Object.hasOwn(input, 'status')
    || Object.hasOwn(input, 'initializedAt')
    || Object.hasOwn(input, 'issues')
  )) {
    return undefined;
  }
  return parseResolution(input);
}

function parseDimensions(input: unknown): OzonDimensions {
  const parsed = ozonDimensionsSchema.safeParse(input);
  if (!parsed.success) {
    throw new AppError('CONFIG_INVALID', 'OZON 上品预设的包装尺寸或兜底毛重无效', {
      issues: parsed.error.issues
    }, 409);
  }
  return parsed.data;
}

function parseResolution(input: unknown): OzonGrossWeightResolution {
  const parsed = ozonGrossWeightResolutionSchema.safeParse(input);
  if (!parsed.success) throw invalidResolution(input, parsed.error.issues);
  return parsed.data;
}

function invalidResolution(input: unknown, issues?: unknown[]): AppError {
  return new AppError('CONFIG_INVALID', 'OZON 采购毛重审计快照无效', {
    input,
    ...(issues ? { issues } : {})
  }, 409);
}

function positiveNumber(input: unknown): number | undefined {
  if (typeof input === 'number') return Number.isFinite(input) && input > 0 ? input : undefined;
  if (typeof input !== 'string') return undefined;
  const normalized = input.trim();
  if (!normalized || !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(normalized)) return undefined;
  const value = Number(normalized);
  return Number.isFinite(value) && value > 0 ? value : undefined;
}

function weightUnitMultiplier(unit: OzonDimensions['weightUnit']): number {
  if (unit === 'kg') return 1_000;
  if (unit === 'lb') return 453.59237;
  return 1;
}

function isRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === 'object' && input !== null && !Array.isArray(input);
}
