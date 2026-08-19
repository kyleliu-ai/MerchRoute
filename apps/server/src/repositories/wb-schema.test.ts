import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { canonicalizeWbLiveSchema, computeWbLiveSchemaHash, deriveCategoryVersion, normalizeWbFormConfigTnvedPolicy, resolveWbTnvedPolicy } from './wb.js';

describe('WB live schema canonical hash', () => {
  it('sorts characteristics by numeric charcID while preserving nested array order', () => {
    const left = [
      { name: 'B', charcID: '20', values: ['z', 'a'] },
      { id: 3, name: 'A', values: ['2', '1'] }
    ];
    const right = [left[1], left[0]];
    expect(canonicalizeWbLiveSchema(left)).toEqual(right);
    expect(computeWbLiveSchemaHash(left)).toBe(computeWbLiveSchemaHash(right));
    const canonical = '[{"id":3,"name":"A","values":["2","1"]},{"charcID":"20","name":"B","values":["z","a"]}]';
    expect(computeWbLiveSchemaHash(left)).toBe(`sha256:${createHash('sha256').update(canonical).digest('hex')}`);
  });

  it('canonicalizes a WB response object without reordering unrelated arrays', () => {
    const input = { data: [{ charcID: 2 }, { charcID: 1 }], directories: ['b', 'a'] };
    expect(canonicalizeWbLiveSchema(input)).toEqual({ data: [{ charcID: 1 }, { charcID: 2 }], directories: ['b', 'a'] });
  });

  it('derives the TNVED characteristic ID from live schema instead of trusting a product code', () => {
    const derived = deriveCategoryVersion({
      nameRu: 'Кроссовки',
      nameZh: '运动鞋',
      subjectId: 105,
      liveSchema: [
        { charcID: 204557, name: 'Пол' },
        { charcID: 15000001, name: 'ТНВЭД' }
      ],
      formConfig: {
        fields: [
          { fieldId: 'gender', characteristicId: 204557, labelRu: 'Пол', scope: 'shared', control: 'select', required: false, order: 10 },
          { fieldId: 'tnved', characteristicId: 15000001, labelRu: 'ТНВЭД', scope: 'shared', control: 'select', required: false, order: 20 }
        ],
        sizeMode: 'sized',
        media: { minImages: 1, maxImages: 30, videoAllowed: true },
        compliance: { tnvedCharacteristicId: 6404199000 }
      }
    });

    expect(derived.formConfig.compliance).toEqual({ tnvedCharacteristicId: 15000001, tnvedRequired: false });
  });

  it('derives TNVED required only from the WB live schema and normalizes historical form configs', () => {
    const optionalSchema = [{ charcID: 15004139, name: 'Код ТН ВЭД', required: false }];
    const requiredSchema = [{ charcID: 15004139, name: 'Код ТН ВЭД', required: true }];
    const legacyFormConfig = {
      fields: [{ fieldId: 'tnved', characteristicId: 15004139, labelRu: 'Код ТН ВЭД', scope: 'shared', control: 'select', required: true, order: 1 }],
      compliance: { tnvedCharacteristicId: 15004139, tnvedRequired: true }
    };

    expect(resolveWbTnvedPolicy(legacyFormConfig, optionalSchema)).toEqual({
      characteristicId: 15004139, supported: true, required: false
    });
    expect(normalizeWbFormConfigTnvedPolicy(legacyFormConfig, optionalSchema)).toMatchObject({
      compliance: { tnvedCharacteristicId: 15004139, tnvedRequired: false }
    });
    expect(resolveWbTnvedPolicy({ ...legacyFormConfig, compliance: {} }, requiredSchema)).toEqual({
      characteristicId: 15004139, supported: true, required: true
    });
    expect(resolveWbTnvedPolicy({ fields: [], compliance: { tnvedCharacteristicId: 15004139 } }, requiredSchema)).toEqual({
      characteristicId: null, supported: false, required: false
    });
  });
});
