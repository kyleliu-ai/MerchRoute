import { describe, expect, it } from 'vitest';
import {
  applyWbPurchaseMeasurementProjection,
  createWbPurchaseMeasurements,
  projectWbPurchaseMeasurements,
  sameWbPurchaseMeasurementValues
} from './wb-purchase-measurements.js';

const source = {
  procurementVersionId: '11111111-1111-4111-8111-111111111111',
  procurementVersionNo: 3,
  productHeightCm: '30.5',
  productDepthCm: '',
  productWidthCm: '39',
  netWeightGrams: '550'
};

const bagFields = {
  fields: [
    { fieldId: 'height', characteristicId: 90630, scope: 'shared', required: false },
    { fieldId: 'depth', characteristicId: 90652, scope: 'shared', required: false },
    { fieldId: 'width', characteristicId: 90673, scope: 'shared', required: false },
    { fieldId: 'weight', characteristicId: 89008, scope: 'shared', required: false }
  ]
};

const numericSchema = [
  { charcID: 90630, charcType: 4, required: false },
  { charcID: 90652, charcType: 4, required: false },
  { charcID: 90673, charcType: 4, required: false },
  { charcID: 89008, charcType: 4, required: false }
];

describe('WB purchase measurement projection', () => {
  it('uses only non-empty values from the latest procurement snapshot', () => {
    const snapshot = createWbPurchaseMeasurements(source, '2026-07-29T00:00:00.000Z');
    const projection = projectWbPurchaseMeasurements(snapshot, bagFields, numericSchema);

    expect(snapshot).toMatchObject({
      procurementVersionNo: 3,
      productHeightCm: 30.5,
      productDepthCm: null,
      productWidthCm: 39,
      netWeightGrams: 550
    });
    expect(projection.characteristics).toEqual([
      { id: 90630, value: 30.5 },
      { id: 90673, value: 39 },
      { id: 89008, value: 550 }
    ]);
  });

  it('removes preset, draft and variant fallback values before applying the source snapshot', () => {
    const projection = projectWbPurchaseMeasurements(
      createWbPurchaseMeasurements(source),
      bagFields,
      numericSchema
    );
    const data = applyWbPurchaseMeasurementProjection({
      sharedCharacteristics: [
        { id: 89008, value: 0 },
        { id: 123, value: ['保留'] }
      ],
      variants: [{
        variantId: 'variant-1',
        characteristics: [{ id: 90630, value: 999 }, { id: 456, value: ['保留'] }]
      }]
    }, projection);

    expect(data.sharedCharacteristics).toEqual([
      { id: 123, value: ['保留'] },
      { id: 90630, value: 30.5 },
      { id: 90673, value: 39 },
      { id: 89008, value: 550 }
    ]);
    expect(data.variants[0].characteristics).toEqual([{ id: 456, value: ['保留'] }]);
    expect(data.purchaseMeasurements.procurementVersionNo).toBe(3);
  });

  it('fails closed when a system-managed characteristic is configured as variant scope', () => {
    const snapshot = createWbPurchaseMeasurements(source);
    expect(() => projectWbPurchaseMeasurements(snapshot, {
      fields: [{ fieldId: 'height', characteristicId: 90630, scope: 'variant', required: false }]
    }, numericSchema)).toThrow('必须配置为所有变体共享字段');
  });

  it('records a blocking initialization issue when a future schema makes an empty value required', () => {
    const projection = projectWbPurchaseMeasurements(createWbPurchaseMeasurements(source), {
      fields: [{ fieldId: 'depth', characteristicId: 90652, scope: 'shared', required: true }]
    }, [{ charcID: 90652, charcType: 4, required: true }]);

    expect(projection.characteristics).toEqual([]);
    expect(projection.issues).toEqual([
      expect.objectContaining({
        code: 'PURCHASE_MEASUREMENT_REQUIRED_MISSING',
        field: 'purchaseMeasurements.productDepthCm',
        severity: 'ERROR'
      })
    ]);
  });

  it('detects drift only for characteristics present in the selected category', () => {
    const generated = createWbPurchaseMeasurements(source);
    const current = createWbPurchaseMeasurements({ ...source, productHeightCm: '31' });

    expect(sameWbPurchaseMeasurementValues(generated, current, bagFields)).toBe(false);
    expect(sameWbPurchaseMeasurementValues(generated, current, { fields: [] })).toBe(true);
  });
});
