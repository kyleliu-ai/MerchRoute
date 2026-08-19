import { createHash } from 'node:crypto';
import { AppError, wbListingPresetDefinitionSchema } from '@n8n-media-review/shared';

type JsonRecord = Record<string, unknown>;

/**
 * Hash only the immutable inputs that can change the generated WB material.
 * Store identity, preset name, activation time and automation mode are
 * intentionally excluded: two stores may use cloned presets only when their
 * product/category/pricing dependency snapshots are byte-for-byte equivalent.
 */
export function wbMaterialPresetDefinitionHash(input: {
  presetSnapshot: unknown;
  dependencySnapshot: unknown;
}): string {
  const parsed = wbListingPresetDefinitionSchema.safeParse(input.presetSnapshot);
  if (!parsed.success) {
    throw new AppError('PRESET_VERSION_MISMATCH', 'WB 上品预设缺少可验证的生成定义快照', undefined, 409);
  }
  const materialDefinition = { ...parsed.data } as JsonRecord;
  delete materialDefinition.name;
  delete materialDefinition.description;
  delete materialDefinition.autoPublishEnabled;
  delete materialDefinition.autoPublishMode;
  // Historical API/DB snapshots may still contain this retired flag. It is
  // operational metadata and never changes generated WB material.
  delete materialDefinition.isDefault;
  const dependency = asObject(input.dependencySnapshot);
  const materialDependencies = {
    pricingTemplateVersionId: requiredUuid(dependency.pricingTemplateVersionId, 'pricingTemplateVersionId'),
    pricingTemplateVersionNo: requiredVersion(dependency.pricingTemplateVersionNo, 'pricingTemplateVersionNo'),
    shippingTemplateVersionId: requiredUuid(dependency.shippingTemplateVersionId, 'shippingTemplateVersionId'),
    shippingTemplateVersionNo: requiredVersion(dependency.shippingTemplateVersionNo, 'shippingTemplateVersionNo'),
    categoryVersionId: requiredUuid(dependency.categoryVersionId, 'categoryVersionId'),
    categoryVersionNo: requiredVersion(dependency.categoryVersionNo, 'categoryVersionNo')
  };
  return `sha256:${createHash('sha256').update(stableJson({
    definition: materialDefinition,
    dependencies: materialDependencies
  }), 'utf8').digest('hex')}`;
}

export function wbMaterialPresetDefinitionHashFromListingData(input: unknown): string | undefined {
  const initialization = asObject(asObject(input).initialization);
  if (!Object.keys(initialization).length) return undefined;
  try {
    return wbMaterialPresetDefinitionHash({
      presetSnapshot: initialization.presetSnapshot,
      dependencySnapshot: initialization.dependencySnapshot
    });
  } catch (error) {
    if (error instanceof AppError && error.code === 'PRESET_VERSION_MISMATCH') return undefined;
    throw error;
  }
}

function requiredUuid(input: unknown, field: string): string {
  const value = String(input || '').trim().toLowerCase();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value)) {
    throw new AppError('PRESET_VERSION_MISMATCH', `WB 上品预设缺少 ${field} 生成依赖快照`, undefined, 409);
  }
  return value;
}

function requiredVersion(input: unknown, field: string): number {
  const value = Number(input);
  if (!Number.isInteger(value) || value < 1) {
    throw new AppError('PRESET_VERSION_MISMATCH', `WB 上品预设缺少 ${field} 生成依赖快照`, undefined, 409);
  }
  return value;
}

function asObject(value: unknown): JsonRecord {
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
