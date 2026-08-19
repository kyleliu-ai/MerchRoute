import { describe, expect, it } from 'vitest';
import { calculateShipping, validateShippingDefinition } from './calculator.js';
import { CEL_SHIPPING_SEEDS } from './seed.js';

const context = (index: number) => {
  const seed = CEL_SHIPPING_SEEDS[index]!;
  return { templateId: seed.id, versionId: seed.versionId, versionNo: seed.versionNo, platformCode: seed.platformCode, scenarioCode: seed.templateType, templateType: seed.templateType, carrierCode: 'CEL', carrierName: 'CEL 物流', templateName: seed.name };
};

const input = (overrides: Record<string, unknown> = {}) => ({
  platformCode: 'OZON', templateType: 'OZON_RFBS', carrierCode: 'CEL', actualWeightGrams: '100',
  lengthCm: '10', widthCm: '10', heightCm: '10', salePriceRub: '1500', destinationCountryCode: null,
  ...overrides
});

describe('shipping calculator', () => {
  it('reproduces the CEL OZON-rFBS sample prices', () => {
    const result = calculateShipping(context(0), CEL_SHIPPING_SEEDS[0]!.definition, input());
    const prices = Object.fromEntries(result.quotes.map((quote) => [quote.serviceCode, quote.freightAmount]));
    expect(prices).toMatchObject({ CEL_RFBS_EXPRESS: '8.42', CEL_RFBS_STANDARD: '7.30', CEL_RFBS_ECONOMY: '6.18' });
    expect(result.summary.cheapestServiceCode).toBe('CEL_RFBS_ECONOMY');
  });

  it('uses the selected CIS destination and hides other-country channels', () => {
    const result = calculateShipping(context(1), CEL_SHIPPING_SEEDS[1]!.definition, input({ templateType: 'OZON_CIS', destinationCountryCode: 'BY' }));
    expect(result.quotes.map((quote) => quote.serviceCode)).toEqual(['CEL_CIS_BY_ECONOMY', 'CEL_CIS_BY_STANDARD']);
    expect(result.rejections.map((item) => item.serviceCode)).toEqual(expect.arrayContaining(['CEL_CIS_KZ_STANDARD', 'CEL_CIS_KZ_ECONOMY']));
  });

  it('applies WB hundred-gram rounding and tiered economy rates', () => {
    const result = calculateShipping(context(2), CEL_SHIPPING_SEEDS[2]!.definition, input({ platformCode: 'WB', templateType: 'WB', actualWeightGrams: '200', salePriceRub: undefined }));
    const prices = Object.fromEntries(result.quotes.map((quote) => [quote.serviceCode, quote.freightAmount]));
    expect(prices).toEqual({ CEL_WB_ECONOMY: '13.60', CEL_WB_EXPRESS: '18.60' });
    expect(result.quotes.every((quote) => quote.chargeableWeightKg === '0.2')).toBe(true);
  });

  it('rejects WB Express when density is not greater than 70kg/m3', () => {
    const result = calculateShipping(context(2), CEL_SHIPPING_SEEDS[2]!.definition, input({ platformCode: 'WB', templateType: 'WB', actualWeightGrams: '100', lengthCm: '20', widthCm: '20', heightCm: '20', salePriceRub: undefined }));
    expect(result.quotes.map((quote) => quote.serviceCode)).not.toContain('CEL_WB_EXPRESS');
    expect(result.rejections.find((item) => item.serviceCode === 'CEL_WB_EXPRESS')?.reasonCodes).toContain('DENSITY_TOO_LOW');
  });

  it('charges OZON Big by the larger volumetric weight', () => {
    const result = calculateShipping(context(0), CEL_SHIPPING_SEEDS[0]!.definition, input({ actualWeightGrams: '3000', lengthCm: '50', widthCm: '40', heightCm: '30', salePriceRub: '2000' }));
    const standard = result.quotes.find((quote) => quote.serviceCode === 'CEL_RFBS_STANDARD')!;
    expect(standard.volumetricWeightKg).toBe('5');
    expect(standard.chargeableWeightKg).toBe('5');
    expect(standard.freightAmount).toBe('180.94');
  });

  it('applies the HK /6000 divisor and 0.1kg rounding only above 60cm side sum', () => {
    const result = calculateShipping(context(0), CEL_SHIPPING_SEEDS[0]!.definition, input({ actualWeightGrams: '100', lengthCm: '30', widthCm: '20', heightCm: '20' }));
    const hk = result.quotes.find((quote) => quote.serviceCode === 'CEL_RFBS_HK')!;
    expect(hk.volumetricWeightKg).toBe('2');
    expect(hk.chargeableWeightKg).toBe('2');
    expect(hk.freightAmount).toBe('211.00');
  });

  it('enforces the sorted Premium Big 150x80x80 dimension box', () => {
    const result = calculateShipping(context(0), CEL_SHIPPING_SEEDS[0]!.definition, input({ actualWeightGrams: '6000', lengthCm: '149', widthCm: '100', heightCm: '10', salePriceRub: '8000' }));
    expect(result.rejections.find((item) => item.serviceCode === 'CEL_RFBS_STANDARD')?.reasonCodes).toContain('DIMENSION_BOX_EXCEEDED');
  });

  it('keeps category boundaries exact at 0.5kg, 1500/1501 RUB, 7000/7001 RUB and 5kg', () => {
    const cases = [
      { actualWeightGrams: '500', salePriceRub: '1500', expected: 'Extra Small（超级轻小件）' },
      { actualWeightGrams: '501', salePriceRub: '1500', expected: 'Budget（低客单价标准件）' },
      { actualWeightGrams: '500', salePriceRub: '1501', expected: 'Small（小件）' },
      { actualWeightGrams: '5000', salePriceRub: '7001', expected: 'Premium Small（高客单价小件）' },
      { actualWeightGrams: '5001', salePriceRub: '7001', expected: 'Premium Big（高客单价大件）' }
    ];
    for (const item of cases) {
      const result = calculateShipping(context(0), CEL_SHIPPING_SEEDS[0]!.definition, input(item));
      expect(result.quotes.find((quote) => quote.serviceCode === 'CEL_RFBS_STANDARD')?.productCategory).toBe(item.expected);
    }
  });

  it('returns exclusions instead of a fabricated quote when all WB channels are oversized', () => {
    const result = calculateShipping(context(2), CEL_SHIPPING_SEEDS[2]!.definition, input({ platformCode: 'WB', templateType: 'WB', actualWeightGrams: '200', lengthCm: '100', widthCm: '100', heightCm: '100', salePriceRub: undefined }));
    expect(result.quotes).toEqual([]);
    expect(result.rejections).toHaveLength(2);
    expect(result.rejections.every((item) => item.reasonCodes.includes('SIDE_SUM_EXCEEDED'))).toBe(true);
  });

  it('validates every seeded definition and rejects overlapping tiers', () => {
    for (const seed of CEL_SHIPPING_SEEDS) expect(() => validateShippingDefinition(seed.definition, seed.templateType)).not.toThrow();
    const invalid = structuredClone(CEL_SHIPPING_SEEDS[2]!.definition);
    invalid.services[1]!.rules[1]!.constraints.actualWeightKg = { max: '20', includeMin: true, includeMax: true };
    expect(() => validateShippingDefinition(invalid, 'WB')).toThrow(/存在重叠/);
  });

  it('tracks V7.24 as version 2 while retaining the V5.23 seed history', () => {
    for (const seed of CEL_SHIPPING_SEEDS) {
      expect(seed).toMatchObject({ versionNo: 2, sourceReference: { file: 'CEL产品资费表 V7.24(15).xlsx', version: 'V7.24' } });
      expect(seed.historicalVersions).toEqual(expect.arrayContaining([
        expect.objectContaining({ versionNo: 1, sourceReference: expect.objectContaining({ file: 'CEL产品资费表 V5.23(1).xlsx', version: 'V5.23' }) })
      ]));
    }
  });
});
