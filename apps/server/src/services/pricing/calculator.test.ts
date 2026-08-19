import { describe, expect, it } from 'vitest';
import { calculatePricingOptions } from './calculator.js';

const definition = {
  schemaVersion: '1' as const,
  costCurrencyCode: 'CNY', saleCurrencyCode: 'RUB', saleCurrencyPerCostCurrency: '11',
  storeDiscountRate: '0.5', strikePriceMultiplier: '2', defaultCommissionRate: '0.15', defaultTargetMarginRate: '0.3',
  fixedCosts: [{ code: 'LABEL', name: '代贴单费', amount: '3.5', enabled: true }],
  percentageDeductions: [
    { code: 'ADS', name: '广告费', rate: '0.1', enabled: true },
    { code: 'REFUND', name: '退款', rate: '0.1', enabled: true },
    { code: 'SETTLEMENT', name: '结汇', rate: '0.012', enabled: true }
  ]
};
const context = { templateId: 'pricing', versionId: 'version', versionNo: 1, templateName: 'WB', platformCode: 'WB', platformName: 'Wildberries' };
const currencies = { cost: { code: 'CNY', displayName: '人民币', symbol: '¥', decimalPlaces: 2 }, sale: { code: 'RUB', displayName: '俄罗斯卢布', symbol: '₽', decimalPlaces: 2 } };

describe('generic pricing calculator', () => {
  it('matches the WB workbook sample without double-counting label cost', () => {
    const result = calculatePricingOptions(context, definition, {
      sku: '0000001', productName: '雪地靴', purchaseCost: '34.6', domesticFreight: '0', actualWeightGrams: '550', lengthCm: '10', widthCm: '10', heightCm: '10'
    }, currencies, [{ template: { templateId: 'shipping' }, serviceCode: 'ECONOMY', serviceName: '陆运', channel: '陆运', matchedRuleId: 'STANDARD', actualWeightKg: '0.55', chargeableWeightKg: '0.6', freightAmount: '33.8', currency: 'CNY', breakdown: {} }]);
    expect(result.options[0]?.amounts.targetSale.costCurrency.displayValue).toBe('212.72');
    expect(result.options[0]?.amounts.targetSale.saleCurrency.displayValue).toBe('2339.94');
    expect(result.options[0]?.amounts.listing.costCurrency.displayValue).toBe('425.44');
    expect(result.options[0]?.amounts.strike.costCurrency.displayValue).toBe('850.89');
  });

  it('uses configured currency precision without currency-specific branches', () => {
    const result = calculatePricingOptions(context, { ...definition, saleCurrencyCode: 'VND', saleCurrencyPerCostCurrency: '3520' }, {
      sku: 'S1', productName: 'Shopee 商品', purchaseCost: '10', domesticFreight: '0', actualWeightGrams: '100', lengthCm: '10', widthCm: '10', heightCm: '10'
    }, { ...currencies, sale: { code: 'VND', displayName: '越南盾', symbol: '₫', decimalPlaces: 0 } }, [{ template: { templateId: 'shipping' }, serviceCode: 'S', serviceName: '渠道', channel: '渠道', matchedRuleId: 'R', actualWeightKg: '0.1', chargeableWeightKg: '0.1', freightAmount: '0', currency: 'CNY', breakdown: {} }]);
    expect(result.options[0]?.amounts.targetSale.saleCurrency.displayValue).toMatch(/^\d+$/);
  });

  it('同价时按模板选择顺序、渠道排序和渠道代码稳定推荐唯一最低价', () => {
    const common = { template: { templateId: 'shipping' }, serviceName: '同价渠道', channel: '测试', matchedRuleId: 'R', actualWeightKg: '0.1', chargeableWeightKg: '0.1', freightAmount: '10', currency: 'CNY', breakdown: {} };
    const result = calculatePricingOptions(context, definition, {
      sku: 'S2', productName: '同价商品', purchaseCost: '10', domesticFreight: '0', actualWeightGrams: '100', lengthCm: '10', widthCm: '10', heightCm: '10'
    }, currencies, [
      { ...common, serviceCode: 'B', templateSelectionOrder: 1, serviceSortOrder: 1 },
      { ...common, serviceCode: 'C', templateSelectionOrder: 0, serviceSortOrder: 20 },
      { ...common, serviceCode: 'A', templateSelectionOrder: 0, serviceSortOrder: 10 }
    ]);
    expect(result.options.map((option) => option.shipping.serviceCode)).toEqual(['A', 'C', 'B']);
    expect(result.options.filter((option) => option.recommended)).toHaveLength(1);
    expect(result.options[0]?.recommended).toBe(true);
  });
});
