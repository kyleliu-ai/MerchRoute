import { describe, expect, it } from 'vitest';
import { wbMaterialPresetDefinitionHash } from './material-hash.js';

const dependencySnapshot = {
  pricingTemplateVersionId: '11111111-1111-4111-8111-111111111111', pricingTemplateVersionNo: 1,
  shippingTemplateVersionId: '22222222-2222-4222-8222-222222222222', shippingTemplateVersionNo: 2,
  categoryVersionId: '33333333-3333-4333-8333-333333333333', categoryVersionNo: 3,
  capturedAt: '2026-08-10T08:00:00.000Z'
};

function preset(name: string, discountPercent: number) {
  return {
    name, description: name, autoPublishEnabled: name === 'A', autoPublishMode: name === 'A' ? 'CREATE_ONLY' : 'COMPATIBLE_UPSERT',
    pricingTemplateId: '41111111-1111-4111-8111-111111111111',
    shippingTemplateId: '42222222-2222-4222-8222-222222222222', shippingServiceCode: 'CEL_WB_ECONOMY',
    packaging: { grossWeightGrams: 750, lengthCm: 30, widthCm: 15, heightCm: 10 }, categoryKey: 'shoes',
    discountPercent, clubDiscount: 5, tnved: '6404199000', brand: '',
    titleTranslation: { workflowId: 'W2lSSXE3NUaLW1tD', language: '俄文', maxLength: 60 }, descriptionSource: 'E003',
    sharedCharacteristics: [], variantCharacteristics: [],
    sizes: [{ sizeId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', techSize: '40', wbSize: '40', stock: 3 }]
  };
}

describe('WB generated material preset definition hash', () => {
  it('ignores store-operational metadata but changes when a material field changes', () => {
    const first = wbMaterialPresetDefinitionHash({ presetSnapshot: preset('A', 40), dependencySnapshot });
    const operationalClone = wbMaterialPresetDefinitionHash({
      presetSnapshot: preset('B', 40),
      dependencySnapshot: { ...dependencySnapshot, capturedAt: '2026-08-11T08:00:00.000Z' }
    });
    const changedMaterial = wbMaterialPresetDefinitionHash({ presetSnapshot: preset('B', 55), dependencySnapshot });

    expect(first).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(operationalClone).toBe(first);
    expect(changedMaterial).not.toBe(first);
  });

  it('ignores every historical isDefault representation', () => {
    const definition = preset('A', 49);
    const absent = wbMaterialPresetDefinitionHash({ presetSnapshot: definition, dependencySnapshot });
    const enabled = wbMaterialPresetDefinitionHash({ presetSnapshot: { ...definition, isDefault: true }, dependencySnapshot });
    const disabled = wbMaterialPresetDefinitionHash({ presetSnapshot: { ...definition, isDefault: false }, dependencySnapshot });

    expect(enabled).toBe(absent);
    expect(disabled).toBe(absent);
  });
});
