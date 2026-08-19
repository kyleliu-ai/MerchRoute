import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { OzonAttributeValueInput, OzonCategoryAttribute } from '@n8n-media-review/shared';
import {
  assertOzonManualPurchaseMeasurementsReady,
  createOzonManualPurchaseMeasurements,
  projectOzonManualPurchaseMeasurements,
  sameOzonManualPurchaseAttributes,
  sameOzonManualPurchaseMeasurementValues
} from './ozon-manual-purchase-measurements.js';

const categoryAttributes = [
  { id: 5299, complexId: 0, required: false },
  { id: 6573, complexId: 0, required: true },
  { id: 5355, complexId: 0, required: false },
  { id: 4383, complexId: 0, required: false },
  { id: 23249, complexId: 0, required: false }
] as OzonCategoryAttribute[];

function snapshot(input: Partial<Record<'productHeightCm' | 'productDepthCm' | 'productWidthCm' | 'netWeightGrams', unknown>> = {}) {
  return createOzonManualPurchaseMeasurements({
    id: randomUUID(),
    versionNo: 7,
    productHeightCm: '016.000',
    productDepthCm: '11.500',
    productWidthCm: '20.000',
    netWeightGrams: '350.000',
    ...input
  });
}

describe('OZON manual purchase measurements', () => {
  it('normalizes and projects the four managed attributes while preserving #23249', () => {
    const current: OzonAttributeValueInput[] = [
      { attributeId: 5299, complexId: 0, values: [{ value: '999' }] },
      { attributeId: 6573, complexId: 99, values: [{ value: '伪造值' }] },
      { attributeId: 23249, complexId: 0, values: [{ value: '8' }] }
    ];
    const projection = projectOzonManualPurchaseMeasurements(current, categoryAttributes, snapshot());

    expect(projection.attributes).toEqual([
      { attributeId: 23249, complexId: 0, values: [{ value: '8' }] },
      { attributeId: 5299, complexId: 0, values: [{ value: '16' }] },
      { attributeId: 6573, complexId: 0, values: [{ value: '11.5' }] },
      { attributeId: 5355, complexId: 0, values: [{ value: '20' }] },
      { attributeId: 4383, complexId: 0, values: [{ value: '350' }] }
    ]);
    expect(projection.issues).toEqual([]);
  });

  it('omits optional missing values and reports required missing values', () => {
    const projection = projectOzonManualPurchaseMeasurements([], categoryAttributes, snapshot({
      productHeightCm: null,
      productDepthCm: null
    }));

    expect(projection.attributes.some((attribute) => attribute.attributeId === 5299)).toBe(false);
    expect(projection.attributes.some((attribute) => attribute.attributeId === 6573)).toBe(false);
    expect(projection.fields.find((field) => field.attributeId === 5299)?.status).toBe('OPTIONAL_MISSING');
    expect(projection.fields.find((field) => field.attributeId === 6573)?.status).toBe('REQUIRED_MISSING');
    expect(() => assertOzonManualPurchaseMeasurementsReady(projection)).toThrowError(/OZON 类目的必填属性/);
  });

  it('rejects zero, negative, exponent and non-numeric purchase values', () => {
    for (const invalid of ['0', '-1', '1e3', 'abc']) {
      expect(() => snapshot({ productHeightCm: invalid })).toThrowError(/productHeightCm/);
    }
  });

  it('compares semantic snapshots and managed attributes without capturedAt churn', () => {
    const id = randomUUID();
    const first = createOzonManualPurchaseMeasurements({
      id, versionNo: 2, productHeightCm: '16', productDepthCm: null, productWidthCm: '20', netWeightGrams: '350'
    }, '2026-08-05T01:00:00.000Z');
    const second = createOzonManualPurchaseMeasurements({
      id, versionNo: 2, productHeightCm: '16.000', productDepthCm: null, productWidthCm: '20.0', netWeightGrams: '350.000'
    }, '2026-08-05T02:00:00.000Z');
    expect(sameOzonManualPurchaseMeasurementValues(first, second)).toBe(true);

    const left = projectOzonManualPurchaseMeasurements([], categoryAttributes, first).attributes;
    const right = projectOzonManualPurchaseMeasurements([{ attributeId: 23249, complexId: 0, values: [{ value: '6' }] }], categoryAttributes, second).attributes;
    expect(sameOzonManualPurchaseAttributes(left, right)).toBe(true);
  });
});
