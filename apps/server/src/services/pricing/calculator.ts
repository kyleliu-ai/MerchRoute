import { Decimal } from 'decimal.js';
import {
  AppError,
  pricingCalculationItemSchema,
  pricingTemplateDefinitionSchema,
  type PricingCalculationItem,
  type PricingTemplateDefinitionV1,
  type ShippingDecimalRange
} from '@n8n-media-review/shared';

export type PricingCurrency = { code: string; displayName: string; symbol: string; decimalPlaces: number };
export type PricingTemplateContext = {
  templateId: string;
  versionId: string;
  versionNo: number;
  templateName: string;
  platformCode: string;
  platformName: string;
};
export type FreightCandidate = {
  template: Record<string, unknown>;
  serviceCode: string;
  serviceName: string;
  channel: string;
  productCategory?: string;
  matchedRuleId: string;
  actualWeightKg: string;
  volumetricWeightKg?: string | null;
  chargeableWeightKg: string;
  freightAmount: string;
  currency: string;
  salePriceRange?: ShippingDecimalRange;
  breakdown: Record<string, unknown>;
  templateSelectionOrder?: number;
  serviceSortOrder?: number;
};

export function calculatePricingOptions(
  context: PricingTemplateContext,
  definitionInput: unknown,
  itemInput: unknown,
  currencies: { cost: PricingCurrency; sale: PricingCurrency },
  freightCandidates: FreightCandidate[]
) {
  const definition = pricingTemplateDefinitionSchema.parse(definitionInput);
  const item = pricingCalculationItemSchema.parse(itemInput);
  assertCurrencies(definition, currencies);
  const commissionRate = new Decimal(item.commissionRate || definition.defaultCommissionRate);
  const targetMarginRate = new Decimal(item.targetMarginRate || definition.defaultTargetMarginRate);
  const deductions = definition.percentageDeductions.filter((entry) => entry.enabled);
  const fixedCostEntries = definition.fixedCosts.filter((entry) => entry.enabled);
  const percentageDeductionRate = deductions.reduce((sum, entry) => sum.plus(entry.rate), new Decimal(0));
  const totalRate = commissionRate.plus(targetMarginRate).plus(percentageDeductionRate);
  if (totalRate.gte(1)) throw new AppError('PRICING_RATE_INVALID', '佣金、目标毛利和比例成本合计必须小于 100%');
  const exchangeRate = new Decimal(definition.saleCurrencyPerCostCurrency);
  const options = freightCandidates.filter((candidate) => candidate.currency === definition.costCurrencyCode).map((candidate) => {
    const { templateSelectionOrder = 0, serviceSortOrder = 0, ...publicCandidate } = candidate;
    const fixedComponents = fixedCostEntries.map((entry) => ({ code: entry.code, name: entry.name, amount: money(entry.amount, currencies.cost) }));
    const fixedTemplateCost = fixedCostEntries.reduce((sum, entry) => sum.plus(entry.amount), new Decimal(0));
    const totalFixedCost = new Decimal(item.purchaseCost).plus(item.domesticFreight).plus(candidate.freightAmount).plus(fixedTemplateCost);
    const targetSaleCost = totalFixedCost.div(new Decimal(1).minus(totalRate));
    const listingCost = targetSaleCost.div(new Decimal(1).minus(definition.storeDiscountRate));
    const strikeCost = listingCost.times(definition.strikePriceMultiplier);
    const targetSaleCurrency = targetSaleCost.times(exchangeRate);
    if (candidate.salePriceRange && !inRange(targetSaleCurrency, candidate.salePriceRange)) return null;
    const amounts = {
      targetSale: currencyPair(targetSaleCost, targetSaleCurrency, currencies),
      listing: currencyPair(listingCost, listingCost.times(exchangeRate), currencies),
      strike: currencyPair(strikeCost, strikeCost.times(exchangeRate), currencies)
    };
    return {
      optionId: `${String((candidate.template as any).templateId)}:${candidate.serviceCode}:${candidate.matchedRuleId}`,
      recommended: false,
      shipping: { ...publicCandidate, freightAmount: money(candidate.freightAmount, currencies.cost) },
      costs: {
        purchase: money(item.purchaseCost, currencies.cost),
        domesticFreight: money(item.domesticFreight, currencies.cost),
        crossBorderFreight: money(candidate.freightAmount, currencies.cost),
        fixedComponents,
        totalFixedCost: money(totalFixedCost, currencies.cost)
      },
      rates: {
        commissionRate: decimalString(commissionRate),
        targetMarginRate: decimalString(targetMarginRate),
        percentageDeductions: deductions.map((entry) => ({ code: entry.code, name: entry.name, rate: entry.rate })),
        totalRate: decimalString(totalRate)
      },
      amounts,
      sortValue: targetSaleCurrency,
      sortTemplateOrder: templateSelectionOrder,
      sortServiceOrder: serviceSortOrder,
      sortServiceCode: candidate.serviceCode
    };
  }).filter((option): option is NonNullable<typeof option> => Boolean(option));
  options.sort((left, right) => left.sortValue.comparedTo(right.sortValue)
    || left.sortTemplateOrder - right.sortTemplateOrder
    || left.sortServiceOrder - right.sortServiceOrder
    || left.sortServiceCode.localeCompare(right.sortServiceCode));
  const publicOptions = options.map(({ sortValue: _sortValue, sortTemplateOrder: _sortTemplateOrder, sortServiceOrder: _sortServiceOrder, sortServiceCode: _sortServiceCode, ...option }, index) => ({ ...option, recommended: index === 0 }));
  return {
    pricingTemplate: { ...context, definition: { ...definition, costCurrency: currencies.cost, saleCurrency: currencies.sale } },
    item,
    summary: { optionCount: publicOptions.length, recommendedOptionId: publicOptions[0]?.optionId || null },
    options: publicOptions,
    calculatedAt: new Date().toISOString()
  };
}

function assertCurrencies(definition: PricingTemplateDefinitionV1, currencies: { cost: PricingCurrency; sale: PricingCurrency }) {
  if (definition.costCurrencyCode !== currencies.cost.code || definition.saleCurrencyCode !== currencies.sale.code) {
    throw new AppError('CURRENCY_MISMATCH', '定价模板引用的币种与币种资料不一致');
  }
}

function currencyPair(costValue: Decimal, saleValue: Decimal, currencies: { cost: PricingCurrency; sale: PricingCurrency }) {
  return { costCurrency: money(costValue, currencies.cost), saleCurrency: money(saleValue, currencies.sale) };
}

function money(value: Decimal.Value, currency: PricingCurrency) {
  const decimal = new Decimal(value);
  return { currencyCode: currency.code, value: decimalString(decimal), displayValue: decimal.toDecimalPlaces(currency.decimalPlaces, Decimal.ROUND_HALF_UP).toFixed(currency.decimalPlaces) };
}

function inRange(value: Decimal, range: ShippingDecimalRange) {
  if (range.min !== undefined) {
    const compared = value.comparedTo(range.min);
    if (compared < 0 || (compared === 0 && !range.includeMin)) return false;
  }
  if (range.max !== undefined) {
    const compared = value.comparedTo(range.max);
    if (compared > 0 || (compared === 0 && !range.includeMax)) return false;
  }
  return true;
}

function decimalString(value: Decimal) {
  const fixed = value.toFixed(Math.min(12, Math.max(0, value.decimalPlaces())));
  return fixed.includes('.') ? fixed.replace(/0+$/, '').replace(/\.$/, '') : fixed;
}

export type { PricingCalculationItem };
