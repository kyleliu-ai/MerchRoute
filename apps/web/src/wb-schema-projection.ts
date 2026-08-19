import type { WbCategoryFormConfig, WbFormField } from './api/client';

type JsonRecord = Record<string, unknown>;

export type WbSchemaSkipReason = 'deprecated' | 'named-field' | 'size-field';

export type WbSchemaSkippedField = {
  characteristicId: number;
  labelRu: string;
  reason: WbSchemaSkipReason;
};

export type WbSchemaProjection = {
  fields: WbFormField[];
  sourceCount: number;
  addedCount: number;
  retainedCount: number;
  removedCount: number;
  skipped: WbSchemaSkippedField[];
  tnvedCharacteristicId?: number;
  tnvedRequired: boolean;
};

type WbSchemaCharacteristic = {
  characteristicId: number;
  labelRu: string;
  labelZh?: string;
  subjectId?: number;
  required: boolean;
  maxCount: number;
  charcType?: number;
  isVariable: boolean;
  existNamedField: boolean;
};

const DIRECTORY_BY_NAME: Record<string, string> = {
  'цвет': 'colors',
  'пол': 'kinds',
  'страна производства': 'countries',
  'сезон': 'seasons',
  'ставка ндс': 'vat'
};

export function projectWbSubjectSchema(
  schema: unknown,
  existingFields: WbFormField[],
  expectedSubjectId?: number,
  labelZhById: ReadonlyMap<number, string> = new Map()
): WbSchemaProjection {
  const source = extractSchemaArray(schema);
  if (!source.length) throw new Error('WB_SCHEMA_EMPTY: WB 没有返回任何类目 characteristic');

  const characteristics = source.map((item, index) => {
    const characteristic = parseCharacteristic(item, index, expectedSubjectId);
    const labelZh = labelZhById.get(characteristic.characteristicId)?.trim();
    return labelZh ? { ...characteristic, labelZh } : characteristic;
  });
  const seenIds = new Set<number>();
  for (const characteristic of characteristics) {
    if (seenIds.has(characteristic.characteristicId)) {
      throw new Error(`WB_SCHEMA_DUPLICATE_ID: WB schema 中存在重复 characteristic ID ${characteristic.characteristicId}`);
    }
    seenIds.add(characteristic.characteristicId);
  }

  const skipped: WbSchemaSkippedField[] = [];
  const projectable: WbSchemaCharacteristic[] = [];
  let tnvedCharacteristicId: number | undefined;
  let tnvedRequired = false;
  for (const characteristic of characteristics) {
    const normalizedName = normalizeRussianName(characteristic.labelRu);
    if (characteristic.charcType === 0) {
      skipped.push(toSkipped(characteristic, 'deprecated'));
      continue;
    }
    if (characteristic.existNamedField) {
      skipped.push(toSkipped(characteristic, 'named-field'));
      continue;
    }
    if (characteristic.characteristicId === 14177453 || normalizedName === 'баркод') {
      skipped.push(toSkipped(characteristic, 'size-field'));
      continue;
    }
    if (isTnvedCharacteristic(characteristic)) {
      tnvedCharacteristicId = characteristic.characteristicId;
      tnvedRequired = characteristic.required;
    }
    projectable.push(characteristic);
  }

  const projectableIds = new Set(projectable.map((item) => item.characteristicId));
  const existingById = new Map(existingFields.map((field) => [field.characteristicId, field]));
  const retained = [...existingFields]
    .sort((left, right) => left.order - right.order)
    .filter((field) => projectableIds.has(field.characteristicId));
  const retainedIds = new Set(retained.map((field) => field.characteristicId));
  const newCharacteristics = projectable.filter((item) => !retainedIds.has(item.characteristicId));
  const orderedCharacteristics = [
    ...retained.map((field) => projectable.find((item) => item.characteristicId === field.characteristicId)!),
    ...newCharacteristics
  ];

  const fields = orderedCharacteristics.map((characteristic, index): WbFormField => {
    const existing = existingById.get(characteristic.characteristicId);
    const directory = existing?.directory || DIRECTORY_BY_NAME[normalizeRussianName(characteristic.labelRu)];
    return {
      fieldId: existing?.fieldId || `wb-charc-${characteristic.characteristicId}`,
      characteristicId: characteristic.characteristicId,
      labelRu: characteristic.labelRu,
      ...((characteristic.labelZh || existing?.labelZh) ? { labelZh: characteristic.labelZh || existing?.labelZh } : {}),
      scope: existing?.scope || (characteristic.isVariable ? 'variant' : 'shared'),
      control: existing?.control || inferControl(characteristic),
      required: isTnvedCharacteristic(characteristic)
        ? characteristic.required
        : Boolean(existing?.required || characteristic.required),
      order: (index + 1) * 10,
      ...(directory ? { directory } : {})
    };
  });

  return {
    fields,
    sourceCount: characteristics.length,
    addedCount: newCharacteristics.length,
    retainedCount: retained.length,
    removedCount: existingFields.filter((field) => !projectableIds.has(field.characteristicId)).length,
    skipped,
    tnvedRequired,
    ...(tnvedCharacteristicId ? { tnvedCharacteristicId } : {})
  };
}

/**
 * WB 两种 locale 返回的 characteristic 顺序不是合同。这里只以俄文 schema
 * 为业务合同，再按 charcID 投影中文显示名；不会把中文 schema 写入 liveSchema。
 */
export function projectWbBilingualSubjectSchema(
  schemaRu: unknown,
  schemaZh: unknown,
  existingFields: WbFormField[],
  expectedSubjectId?: number
): WbSchemaProjection {
  const labelZhById = extractLocalizedLabels(schemaZh, expectedSubjectId);
  return projectWbSubjectSchema(schemaRu, existingFields, expectedSubjectId, labelZhById);
}

export function hasWbSchemaCharacteristics(schema: unknown): boolean {
  try {
    return extractSchemaArray(schema).length > 0;
  } catch {
    return false;
  }
}

/**
 * TNVED characteristic ID 是 WB schema 元数据，不是业务人员填写的商品 TNVED 编码。
 * 保存模板前始终以实时俄文 schema 为准，避免旧页面或误输入污染模板配置。
 */
export function normalizeWbFormConfigCompliance(
  schema: unknown,
  formConfig: WbCategoryFormConfig,
  expectedSubjectId?: number
): WbCategoryFormConfig {
  const projection = projectWbSubjectSchema(schema, formConfig.fields, expectedSubjectId);
  const detectedId = projection.tnvedCharacteristicId;
  const isVisibleField = detectedId !== undefined && formConfig.fields.some((field) => field.characteristicId === detectedId);
  return {
    ...formConfig,
    compliance: isVisibleField
      ? { tnvedCharacteristicId: detectedId, tnvedRequired: projection.tnvedRequired }
      : { tnvedRequired: false }
  };
}

/**
 * 历史已发布版本可能只保存了 TNVED characteristic ID。这种情况下从同版本
 * liveSchema 恢复 required；如果快照也无法读取，则对已支持 TNVED 的类目 fail-closed。
 */
export function resolveWbTnvedRequired(
  formConfig: WbCategoryFormConfig,
  liveSchema: unknown,
  expectedSubjectId?: number
): boolean {
  const characteristicId = formConfig.compliance?.tnvedCharacteristicId;
  if (!Number.isInteger(characteristicId) || Number(characteristicId) < 1) return false;
  if (typeof formConfig.compliance?.tnvedRequired === 'boolean') return formConfig.compliance.tnvedRequired;
  try {
    const projection = projectWbSubjectSchema(liveSchema, formConfig.fields, expectedSubjectId);
    if (projection.tnvedCharacteristicId === characteristicId) return projection.tnvedRequired;
  } catch {
    // 旧快照丢失时不得把可能必填的 TNVED 静默降级为非必填。
  }
  return true;
}

function extractSchemaArray(schema: unknown): unknown[] {
  if (Array.isArray(schema)) return schema;
  const root = asRecord(schema);
  for (const key of ['data', 'characteristics', 'items']) {
    const value = root[key];
    if (Array.isArray(value)) return value;
    if (value && typeof value === 'object') {
      const nested = asRecord(value);
      if (Array.isArray(nested.characteristics)) return nested.characteristics;
      if (Array.isArray(nested.items)) return nested.items;
    }
  }
  return [];
}

function parseCharacteristic(input: unknown, index: number, expectedSubjectId?: number): WbSchemaCharacteristic {
  const item = asRecord(input);
  const characteristicId = Number(item.charcID ?? item.id);
  const labelRu = String(item.name ?? item.label ?? '').trim();
  const subjectIdValue = item.subjectID ?? item.subjectId;
  const subjectId = subjectIdValue === undefined || subjectIdValue === null || subjectIdValue === '' ? undefined : Number(subjectIdValue);
  if (!Number.isInteger(characteristicId) || characteristicId < 1) {
    throw new Error(`WB_SCHEMA_INVALID_ID: 第 ${index + 1} 个 characteristic 缺少有效 charcID`);
  }
  if (!labelRu) throw new Error(`WB_SCHEMA_INVALID_NAME: characteristic ${characteristicId} 缺少俄文名称`);
  if (subjectId !== undefined && (!Number.isInteger(subjectId) || subjectId < 1)) {
    throw new Error(`WB_SCHEMA_INVALID_SUBJECT: characteristic ${characteristicId} 的 subjectID 无效`);
  }
  if (expectedSubjectId && subjectId !== undefined && subjectId !== expectedSubjectId) {
    throw new Error(`WB_SCHEMA_SUBJECT_MISMATCH: characteristic ${characteristicId} 属于 subject ${subjectId}，当前模板为 ${expectedSubjectId}`);
  }
  const charcTypeValue = item.charcType ?? item.charc_type;
  const charcType = charcTypeValue === undefined || charcTypeValue === null || charcTypeValue === '' ? undefined : Number(charcTypeValue);
  if (charcType !== undefined && !Number.isInteger(charcType)) {
    throw new Error(`WB_SCHEMA_INVALID_TYPE: characteristic ${characteristicId} 的 charcType 无效`);
  }
  const maxCountValue = Number(item.maxCount ?? item.max_count ?? 1);
  return {
    characteristicId,
    labelRu,
    ...(subjectId ? { subjectId } : {}),
    required: item.required === true || item.required === 1 || item.isRequired === true,
    maxCount: Number.isInteger(maxCountValue) && maxCountValue >= 0 ? maxCountValue : 1,
    ...(charcType === undefined ? {} : { charcType }),
    isVariable: item.isVariable === true || item.isVariable === 1,
    existNamedField: item.existNamedField === true || item.existNamedField === 1
  };
}

function extractLocalizedLabels(schema: unknown, expectedSubjectId?: number): Map<number, string> {
  const source = extractSchemaArray(schema);
  const labels = new Map<number, string>();
  const seenIds = new Set<number>();
  for (let index = 0; index < source.length; index += 1) {
    const item = asRecord(source[index]);
    const characteristicId = Number(item.charcID ?? item.id);
    const subjectIdValue = item.subjectID ?? item.subjectId;
    const subjectId = subjectIdValue === undefined || subjectIdValue === null || subjectIdValue === '' ? undefined : Number(subjectIdValue);
    if (!Number.isInteger(characteristicId) || characteristicId < 1) {
      throw new Error(`WB_SCHEMA_ZH_INVALID_ID: 中文 schema 第 ${index + 1} 个 characteristic 缺少有效 charcID`);
    }
    if (seenIds.has(characteristicId)) {
      throw new Error(`WB_SCHEMA_ZH_DUPLICATE_ID: 中文 schema 中存在重复 characteristic ID ${characteristicId}`);
    }
    seenIds.add(characteristicId);
    if (subjectId !== undefined && (!Number.isInteger(subjectId) || subjectId < 1)) {
      throw new Error(`WB_SCHEMA_ZH_INVALID_SUBJECT: characteristic ${characteristicId} 的 subjectID 无效`);
    }
    if (expectedSubjectId && subjectId !== undefined && subjectId !== expectedSubjectId) {
      throw new Error(`WB_SCHEMA_ZH_SUBJECT_MISMATCH: characteristic ${characteristicId} 属于 subject ${subjectId}，当前模板为 ${expectedSubjectId}`);
    }
    const labelZh = String(item.name ?? item.label ?? '').trim();
    if (labelZh) labels.set(characteristicId, labelZh);
  }
  return labels;
}

function inferControl(characteristic: WbSchemaCharacteristic): WbFormField['control'] {
  if (characteristic.charcType === 4) return 'number';
  if (characteristic.charcType === 1) return characteristic.maxCount === 1 ? 'select' : 'multi-select';
  return 'text';
}

function isTnvedCharacteristic(characteristic: WbSchemaCharacteristic): boolean {
  const name = normalizeRussianName(characteristic.labelRu);
  return characteristic.characteristicId === 15004139 || name.includes('тн вэд') || name.includes('тнвэд');
}

function normalizeRussianName(input: string): string {
  return input.trim().toLocaleLowerCase('ru-RU').replaceAll('ё', 'е').replace(/[\s_-]+/g, ' ');
}

function toSkipped(characteristic: WbSchemaCharacteristic, reason: WbSchemaSkipReason): WbSchemaSkippedField {
  return { characteristicId: characteristic.characteristicId, labelRu: characteristic.labelRu, reason };
}

function asRecord(input: unknown): JsonRecord {
  return input && typeof input === 'object' && !Array.isArray(input) ? input as JsonRecord : {};
}
