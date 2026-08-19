import { describe, expect, it } from 'vitest';
import type { WbFormField } from './api/client';
import { hasWbSchemaCharacteristics, normalizeWbFormConfigCompliance, projectWbBilingualSubjectSchema, projectWbSubjectSchema, resolveWbTnvedRequired } from './wb-schema-projection';

const schema = [
  { charcID: 14177449, subjectID: 138, name: 'Цвет', required: false, maxCount: 5, charcType: 1, isVariable: true, existNamedField: false },
  { charcID: 204557, subjectID: 138, name: 'Пол', required: true, maxCount: 1, charcType: 1, isVariable: false, existNamedField: false },
  { charcID: 89062, subjectID: 138, name: 'Вместимость рюкзака', required: false, maxCount: 0, charcType: 4, isVariable: false, existNamedField: false },
  { charcID: 14177446, subjectID: 138, name: 'Бренд', required: false, maxCount: 1, charcType: 1, existNamedField: true },
  { charcID: 14177452, subjectID: 138, name: 'Описание', required: false, maxCount: 1, charcType: 0, existNamedField: true },
  { charcID: 14177453, subjectID: 138, name: 'Баркод', required: false, maxCount: 0, charcType: 1, existNamedField: false },
  { charcID: 15004139, subjectID: 138, name: 'Код ТН ВЭД', required: false, maxCount: 1, charcType: 1, existNamedField: false }
];

const schemaZh = [
  { charcID: 204557, subjectID: 138, name: '性别' },
  { charcID: 14177449, subjectID: 138, name: '颜色' },
  { charcID: 89062, subjectID: 138, name: '背包容量' },
  { charcID: 14177446, subjectID: 138, name: '品牌' },
  { charcID: 14177452, subjectID: 138, name: '描述' },
  { charcID: 14177453, subjectID: 138, name: '条形码' },
  { charcID: 15004139, subjectID: 138, name: '海关编码' }
];

describe('WB subject schema projection', () => {
  it('generates active category fields and routes WB metadata to form controls', () => {
    const result = projectWbSubjectSchema(schema, [], 138);

    expect(result).toMatchObject({
      sourceCount: 7,
      addedCount: 4,
      retainedCount: 0,
      removedCount: 0,
      tnvedCharacteristicId: 15004139,
      tnvedRequired: false
    });
    expect(result.fields).toEqual([
      expect.objectContaining({ characteristicId: 14177449, fieldId: 'wb-charc-14177449', labelRu: 'Цвет', scope: 'variant', control: 'multi-select', required: false, directory: 'colors', order: 10 }),
      expect.objectContaining({ characteristicId: 204557, fieldId: 'wb-charc-204557', labelRu: 'Пол', scope: 'shared', control: 'select', required: true, directory: 'kinds', order: 20 }),
      expect.objectContaining({ characteristicId: 89062, fieldId: 'wb-charc-89062', scope: 'shared', control: 'number', order: 30 }),
      expect.objectContaining({ characteristicId: 15004139, fieldId: 'wb-charc-15004139', scope: 'shared', control: 'select', order: 40 })
    ]);
    expect(result.skipped).toEqual([
      { characteristicId: 14177446, labelRu: 'Бренд', reason: 'named-field' },
      { characteristicId: 14177452, labelRu: 'Описание', reason: 'deprecated' },
      { characteristicId: 14177453, labelRu: 'Баркод', reason: 'size-field' }
    ]);
  });

  it('preserves manual configuration and relative order while removing stale IDs', () => {
    const existing: WbFormField[] = [
      { fieldId: 'manual-gender', characteristicId: 204557, labelRu: '旧名称', scope: 'variant', control: 'text', required: false, order: 10, directory: 'custom-gender' },
      { fieldId: 'manual-color', characteristicId: 14177449, labelRu: '旧颜色', scope: 'shared', control: 'text', required: true, order: 20, directory: 'custom-color' },
      { fieldId: 'stale', characteristicId: 999, labelRu: '已删除字段', scope: 'shared', control: 'text', required: false, order: 30 }
    ];
    const result = projectWbSubjectSchema({ data: schema }, existing, 138);

    expect(result).toMatchObject({ addedCount: 2, retainedCount: 2, removedCount: 1 });
    expect(result.fields.map((field) => field.characteristicId)).toEqual([204557, 14177449, 89062, 15004139]);
    expect(result.fields[0]).toMatchObject({ fieldId: 'manual-gender', labelRu: 'Пол', scope: 'variant', control: 'text', required: true, directory: 'custom-gender', order: 10 });
    expect(result.fields[1]).toMatchObject({ fieldId: 'manual-color', labelRu: 'Цвет', scope: 'shared', control: 'text', required: true, directory: 'custom-color', order: 20 });
  });

  it('projects Chinese labels by charcID while keeping the Russian schema untouched', () => {
    const russianSnapshot = structuredClone(schema);
    const shuffledChineseSchema = [schemaZh[2], schemaZh[0], schemaZh[6], schemaZh[1]];
    const result = projectWbBilingualSubjectSchema(schema, shuffledChineseSchema, [], 138);

    expect(result.fields).toEqual([
      expect.objectContaining({ characteristicId: 14177449, labelRu: 'Цвет', labelZh: '颜色' }),
      expect.objectContaining({ characteristicId: 204557, labelRu: 'Пол', labelZh: '性别' }),
      expect.objectContaining({ characteristicId: 89062, labelRu: 'Вместимость рюкзака', labelZh: '背包容量' }),
      expect.objectContaining({ characteristicId: 15004139, labelRu: 'Код ТН ВЭД', labelZh: '海关编码' })
    ]);
    expect(schema).toEqual(russianSnapshot);
  });

  it('falls back to retained labels when the Chinese schema omits a characteristic', () => {
    const existing: WbFormField[] = [
      { fieldId: 'manual-color', characteristicId: 14177449, labelRu: '旧俄文', labelZh: '旧中文颜色', scope: 'variant', control: 'text', required: false, order: 10 }
    ];
    const result = projectWbBilingualSubjectSchema(schema, [{ charcID: 204557, subjectID: 138, name: '性别' }], existing, 138);

    expect(result.fields.find((field) => field.characteristicId === 14177449)).toMatchObject({ labelRu: 'Цвет', labelZh: '旧中文颜色' });
    expect(result.fields.find((field) => field.characteristicId === 204557)).toMatchObject({ labelZh: '性别' });
  });

  it('replaces a mistaken product TNVED code with the characteristic ID detected from schema', () => {
    const fields = projectWbSubjectSchema(schema, [], 138).fields;
    const formConfig = normalizeWbFormConfigCompliance(schema, {
      fields,
      media: { minImages: 1, maxImages: 30, videoAllowed: true },
      compliance: { tnvedCharacteristicId: 6404199000 }
    }, 138);

    expect(formConfig.compliance).toEqual({ tnvedCharacteristicId: 15004139, tnvedRequired: false });
  });

  it('takes TNVED requiredness only from the live WB schema', () => {
    const existing: WbFormField[] = [{
      fieldId: 'tnved', characteristicId: 15004139, labelRu: '旧 TNVED', scope: 'shared', control: 'select', required: true, order: 10
    }];
    const optional = projectWbSubjectSchema(schema, existing, 138);
    expect(optional.tnvedRequired).toBe(false);
    expect(optional.fields.find((field) => field.characteristicId === 15004139)?.required).toBe(false);

    const requiredSchema = schema.map((item) => item.charcID === 15004139 ? { ...item, required: true } : item);
    const required = projectWbSubjectSchema(requiredSchema, [{ ...existing[0]!, required: false }], 138);
    expect(required.tnvedRequired).toBe(true);
    expect(required.fields.find((field) => field.characteristicId === 15004139)?.required).toBe(true);
    expect(normalizeWbFormConfigCompliance(requiredSchema, { fields: required.fields }, 138).compliance)
      .toEqual({ tnvedCharacteristicId: 15004139, tnvedRequired: true });
  });

  it('marks TNVED as unsupported when the live schema has no TNVED characteristic', () => {
    const schemaWithoutTnved = schema.filter((item) => item.charcID !== 15004139);
    const fields = projectWbSubjectSchema(schemaWithoutTnved, [], 138).fields;
    const formConfig = normalizeWbFormConfigCompliance(schemaWithoutTnved, {
      fields,
      compliance: { tnvedCharacteristicId: 15004139, tnvedRequired: true }
    }, 138);

    expect(formConfig.compliance).toEqual({ tnvedRequired: false });
  });

  it('recovers TNVED requiredness for historical versions and fails closed without a readable snapshot', () => {
    const legacyConfig = {
      fields: projectWbSubjectSchema(schema, [], 138).fields,
      compliance: { tnvedCharacteristicId: 15004139 }
    };
    expect(resolveWbTnvedRequired(legacyConfig, schema, 138)).toBe(false);
    expect(resolveWbTnvedRequired(legacyConfig, schema.map((item) => item.charcID === 15004139 ? { ...item, required: true } : item), 138)).toBe(true);
    expect(resolveWbTnvedRequired(legacyConfig, {}, 138)).toBe(true);
    expect(resolveWbTnvedRequired({ ...legacyConfig, compliance: { ...legacyConfig.compliance, tnvedRequired: false } }, schema.map((item) => ({ ...item, required: true })), 138)).toBe(false);
  });

  it('fails closed for empty, duplicated, or wrong-subject schema', () => {
    expect(hasWbSchemaCharacteristics({ data: schema })).toBe(true);
    expect(hasWbSchemaCharacteristics({ data: [] })).toBe(false);
    expect(() => projectWbSubjectSchema([], [], 138)).toThrow('WB_SCHEMA_EMPTY');
    expect(() => projectWbSubjectSchema([...schema, schema[0]], [], 138)).toThrow('WB_SCHEMA_DUPLICATE_ID');
    expect(() => projectWbSubjectSchema([{ ...schema[0], subjectID: 105 }], [], 138)).toThrow('WB_SCHEMA_SUBJECT_MISMATCH');
    expect(() => projectWbBilingualSubjectSchema(schema, [{ ...schemaZh[0], subjectID: 105 }], [], 138)).toThrow('WB_SCHEMA_ZH_SUBJECT_MISMATCH');
    expect(() => projectWbBilingualSubjectSchema(schema, [schemaZh[0], schemaZh[0]], [], 138)).toThrow('WB_SCHEMA_ZH_DUPLICATE_ID');
  });
});
