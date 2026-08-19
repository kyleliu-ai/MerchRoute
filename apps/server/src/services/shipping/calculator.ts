import { Decimal } from 'decimal.js';
import {
  shippingCalculationInputSchema,
  shippingTemplateDefinitionSchema,
  type ShippingCalculationInput,
  type ShippingDecimalRange,
  type ShippingRule,
  type ShippingTemplateDefinitionV1,
  type ShippingTemplateType
} from '@n8n-media-review/shared';

export type ShippingTemplateContext = {
  templateId: string;
  versionId: string;
  versionNo: number;
  platformCode: string;
  scenarioCode: string;
  templateType?: ShippingTemplateType;
  carrierCode: string;
  carrierName: string;
  templateName: string;
};

export type ShippingRejectionCode =
  | 'SALE_PRICE_OUT_OF_RANGE'
  | 'DESTINATION_UNSUPPORTED'
  | 'WEIGHT_OUT_OF_RANGE'
  | 'SIDE_SUM_EXCEEDED'
  | 'LONGEST_SIDE_EXCEEDED'
  | 'DIMENSION_BOX_EXCEEDED'
  | 'DENSITY_TOO_LOW'
  | 'CHARGEABLE_WEIGHT_EXCEEDED';

export function calculateShipping(context: ShippingTemplateContext, definitionInput: unknown, inputValue: unknown) {
  const definition = shippingTemplateDefinitionSchema.parse(definitionInput);
  const input = shippingCalculationInputSchema.parse(inputValue);
  const actualWeightKg = new Decimal(input.actualWeightGrams).div(1000);
  const dimensions = [new Decimal(input.lengthCm), new Decimal(input.widthCm), new Decimal(input.heightCm)];
  const sortedDimensions = [...dimensions].sort((left, right) => right.comparedTo(left));
  const sideSumCm = dimensions.reduce((sum, value) => sum.plus(value), new Decimal(0));
  const volumeM3 = dimensions.reduce((product, value) => product.times(value), new Decimal(1)).div(1_000_000);
  const densityKgM3 = actualWeightKg.div(volumeM3);

  const quotes: Array<Record<string, unknown> & { freightAmountValue: Decimal; sortOrder: number }> = [];
  const rejections: Array<{ serviceCode: string; serviceName: string; reasonCodes: ShippingRejectionCode[]; details: Record<string, string> }> = [];

  for (const service of definition.services) {
    const candidates = service.rules.map((rule) => evaluateRule(rule, input, { actualWeightKg, sortedDimensions, sideSumCm, volumeM3, densityKgM3 }));
    const eligible = candidates.filter((candidate) => candidate.reasonCodes.length === 0);
    if (eligible.length > 1) throw new Error(`模板配置错误：渠道 ${service.code} 同时匹配多个规则`);
    if (!eligible.length) {
      const closest = [...candidates].sort((left, right) => rejectionScore(left.reasonCodes) - rejectionScore(right.reasonCodes))[0];
      rejections.push({
        serviceCode: service.code,
        serviceName: service.name,
        reasonCodes: closest?.reasonCodes || ['WEIGHT_OUT_OF_RANGE'],
        details: closest?.details || {}
      });
      continue;
    }
    const result = eligible[0]!;
    const freightAmount = result.chargeableWeightKg.times(result.rule.pricing.ratePerKg).plus(result.rule.pricing.fixedFee).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
    quotes.push({
      serviceCode: service.code,
      serviceName: service.name,
      channel: service.channel,
      deliveryMode: service.deliveryMode,
      transitTime: service.transitTime,
      returnService: service.returnService,
      notes: service.notes,
      productCategory: result.rule.productCategory,
      matchedRuleId: result.rule.id,
      actualWeightKg: decimalString(actualWeightKg),
      volumetricWeightKg: result.volumetricWeightKg ? decimalString(result.volumetricWeightKg) : null,
      chargeableWeightKg: decimalString(result.chargeableWeightKg),
      freightAmount: freightAmount.toFixed(2),
      currency: result.rule.pricing.currency,
      isCheapest: false,
      breakdown: {
        ratePerKg: result.rule.pricing.ratePerKg,
        fixedFee: result.rule.pricing.fixedFee,
        roundingStepKg: result.rule.chargeableWeight.roundingStepKg || null,
        formula: `${decimalString(result.chargeableWeightKg)} × ${result.rule.pricing.ratePerKg} + ${result.rule.pricing.fixedFee}`
      },
      freightAmountValue: freightAmount,
      sortOrder: service.sortOrder
    });
  }

  quotes.sort((left, right) => left.freightAmountValue.comparedTo(right.freightAmountValue) || left.sortOrder - right.sortOrder);
  const cheapest = quotes[0]?.freightAmountValue;
  const publicQuotes: Array<Record<string, any>> = quotes.map(({ freightAmountValue, sortOrder: _sortOrder, ...quote }) => ({ ...quote, isCheapest: Boolean(cheapest && freightAmountValue.equals(cheapest)) }));

  return {
    template: context,
    normalizedInput: {
      ...input,
      destinationCountryCode: input.destinationCountryCode || null,
      actualWeightKg: decimalString(actualWeightKg),
      sideSumCm: decimalString(sideSumCm),
      volumeM3: decimalString(volumeM3),
      densityKgM3: decimalString(densityKgM3),
      sortedDimensionsCm: sortedDimensions.map(decimalString)
    },
    summary: {
      eligibleCount: publicQuotes.length,
      cheapestServiceCode: publicQuotes.find((quote) => quote.isCheapest)?.serviceCode || null,
      cheapestFreightAmount: cheapest?.toFixed(2) || null,
      currency: definition.currency
    },
    quotes: publicQuotes,
    rejections,
    calculatedAt: new Date().toISOString()
  };
}

export function calculateShippingRuleCandidates(context: ShippingTemplateContext, definitionInput: unknown, inputValue: unknown) {
  const definition = shippingTemplateDefinitionSchema.parse(definitionInput);
  const input = shippingCalculationInputSchema.parse({
    shippingTemplateId: context.templateId,
    ...(inputValue as Record<string, unknown>)
  });
  const actualWeightKg = new Decimal(input.actualWeightGrams).div(1000);
  const dimensions = [new Decimal(input.lengthCm), new Decimal(input.widthCm), new Decimal(input.heightCm)];
  const sortedDimensions = [...dimensions].sort((left, right) => right.comparedTo(left));
  const sideSumCm = dimensions.reduce((sum, value) => sum.plus(value), new Decimal(0));
  const volumeM3 = dimensions.reduce((product, value) => product.times(value), new Decimal(1)).div(1_000_000);
  const densityKgM3 = actualWeightKg.div(volumeM3);
  const measures = { actualWeightKg, sortedDimensions, sideSumCm, volumeM3, densityKgM3 };
  const candidates: Array<Record<string, unknown> & { freightAmountValue: Decimal; salePriceRange?: ShippingDecimalRange }> = [];
  const rejections: Array<{ serviceCode: string; serviceName: string; matchedRuleId: string; reasonCodes: ShippingRejectionCode[] }> = [];
  for (const service of definition.services) {
    for (const rule of service.rules) {
      const result = evaluateRule(rule, input, measures, true);
      if (result.reasonCodes.length) {
        rejections.push({ serviceCode: service.code, serviceName: service.name, matchedRuleId: rule.id, reasonCodes: result.reasonCodes });
        continue;
      }
      const freightAmountValue = result.chargeableWeightKg.times(rule.pricing.ratePerKg).plus(rule.pricing.fixedFee).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
      candidates.push({
        template: context,
        serviceCode: service.code,
        serviceName: service.name,
        channel: service.channel,
        deliveryMode: service.deliveryMode,
        transitTime: service.transitTime,
        returnService: service.returnService,
        notes: service.notes,
        productCategory: rule.productCategory,
        matchedRuleId: rule.id,
        actualWeightKg: decimalString(actualWeightKg),
        volumetricWeightKg: result.volumetricWeightKg ? decimalString(result.volumetricWeightKg) : null,
        chargeableWeightKg: decimalString(result.chargeableWeightKg),
        freightAmount: freightAmountValue.toFixed(2),
        currency: rule.pricing.currency,
        salePriceRange: rule.constraints.salePrice || rule.constraints.salePriceRub,
        breakdown: { ratePerKg: rule.pricing.ratePerKg, fixedFee: rule.pricing.fixedFee, roundingStepKg: rule.chargeableWeight.roundingStepKg || null },
        serviceSortOrder: service.sortOrder,
        freightAmountValue
      });
    }
  }
  return { definition, input, candidates, rejections };
}

type Measures = {
  actualWeightKg: Decimal;
  sortedDimensions: Decimal[];
  sideSumCm: Decimal;
  volumeM3: Decimal;
  densityKgM3: Decimal;
};

function evaluateRule(rule: ShippingRule, input: ShippingCalculationInput, measures: Measures, ignoreSalePrice = false) {
  const reasonCodes: ShippingRejectionCode[] = [];
  const details: Record<string, string> = {};
  const constraints = rule.constraints;
  const salePriceRange = constraints.salePrice || constraints.salePriceRub;
  const salePrice = input.salePrice || input.salePriceRub;
  if (!ignoreSalePrice && salePriceRange && (!salePrice || !inRange(new Decimal(salePrice), salePriceRange))) {
    reasonCodes.push('SALE_PRICE_OUT_OF_RANGE');
  }
  if (rule.destinationCountryCodes.length && !rule.destinationCountryCodes.includes(input.destinationCountryCode || '')) {
    reasonCodes.push('DESTINATION_UNSUPPORTED');
    details.supportedDestinations = rule.destinationCountryCodes.join(',');
  }
  if (constraints.actualWeightKg && !inRange(measures.actualWeightKg, constraints.actualWeightKg)) reasonCodes.push('WEIGHT_OUT_OF_RANGE');
  if (constraints.maxSideSumCm && measures.sideSumCm.gt(constraints.maxSideSumCm)) reasonCodes.push('SIDE_SUM_EXCEEDED');
  if (constraints.maxLongestSideCm && measures.sortedDimensions[0]!.gt(constraints.maxLongestSideCm)) reasonCodes.push('LONGEST_SIDE_EXCEEDED');
  if (constraints.maxDimensionBoxCm && constraints.maxDimensionBoxCm.some((limit, index) => measures.sortedDimensions[index]!.gt(limit))) reasonCodes.push('DIMENSION_BOX_EXCEEDED');
  if (constraints.minDensityKgM3 && measures.densityKgM3.lte(constraints.minDensityKgM3)) reasonCodes.push('DENSITY_TOO_LOW');

  let volumetricWeightKg: Decimal | undefined;
  if (rule.chargeableWeight.mode === 'MAX_ACTUAL_VOLUMETRIC') {
    const trigger = rule.chargeableWeight.volumetricTriggerSideSumCm;
    if (!trigger || measures.sideSumCm.gt(trigger)) {
      volumetricWeightKg = measures.volumeM3.times(1_000_000).div(rule.chargeableWeight.volumetricDivisor!);
      if (rule.chargeableWeight.volumetricRoundingStepKg) volumetricWeightKg = roundUp(volumetricWeightKg, new Decimal(rule.chargeableWeight.volumetricRoundingStepKg));
    }
  }
  let chargeableWeightKg = volumetricWeightKg ? Decimal.max(measures.actualWeightKg, volumetricWeightKg) : measures.actualWeightKg;
  if (rule.chargeableWeight.roundingStepKg) chargeableWeightKg = roundUp(chargeableWeightKg, new Decimal(rule.chargeableWeight.roundingStepKg));
  if (constraints.maxChargeableWeightKg && chargeableWeightKg.gt(constraints.maxChargeableWeightKg)) reasonCodes.push('CHARGEABLE_WEIGHT_EXCEEDED');
  return { rule, reasonCodes, details, volumetricWeightKg, chargeableWeightKg };
}

export function validateShippingDefinition(input: unknown, _templateType?: ShippingTemplateType): ShippingTemplateDefinitionV1 {
  const definition = shippingTemplateDefinitionSchema.parse(input);
  if (!definition.services.length) throw new Error('模板至少需要一个服务渠道');
  const serviceCodes = new Set<string>();
  const ruleIds = new Set<string>();
  for (const service of definition.services) {
    if (serviceCodes.has(service.code)) throw new Error(`渠道代码重复：${service.code}`);
    serviceCodes.add(service.code);
    for (const rule of service.rules) {
      if (ruleIds.has(rule.id)) throw new Error(`规则 ID 重复：${rule.id}`);
      ruleIds.add(rule.id);
      validateRange(rule.constraints.actualWeightKg, `${rule.id} 重量区间`);
      validateRange(rule.constraints.salePrice || rule.constraints.salePriceRub, `${rule.id} 售价区间`);
      if (rule.constraints.maxDimensionBoxCm) {
        const [longest, middle, shortest] = rule.constraints.maxDimensionBoxCm.map((value) => new Decimal(value));
        if (longest!.lt(middle!) || middle!.lt(shortest!)) throw new Error(`${rule.id} 的最大尺寸盒必须按最长边、次长边、最短边填写`);
      }
      if (rule.chargeableWeight.mode === 'MAX_ACTUAL_VOLUMETRIC' && !rule.chargeableWeight.volumetricDivisor) throw new Error(`${rule.id} 缺少体积重除数`);
    }
    for (let left = 0; left < service.rules.length; left += 1) {
      for (let right = left + 1; right < service.rules.length; right += 1) {
        if (rulesCouldOverlap(service.rules[left]!, service.rules[right]!)) throw new Error(`渠道 ${service.code} 的规则 ${service.rules[left]!.id} 与 ${service.rules[right]!.id} 存在重叠`);
      }
    }
  }
  return definition;
}

function rulesCouldOverlap(left: ShippingRule, right: ShippingRule) {
  const destinationsOverlap = !left.destinationCountryCodes.length || !right.destinationCountryCodes.length || left.destinationCountryCodes.some((code) => right.destinationCountryCodes.includes(code));
  return destinationsOverlap && rangesOverlap(left.constraints.actualWeightKg, right.constraints.actualWeightKg) && rangesOverlap(left.constraints.salePrice || left.constraints.salePriceRub, right.constraints.salePrice || right.constraints.salePriceRub);
}

function rangesOverlap(left?: ShippingDecimalRange, right?: ShippingDecimalRange) {
  if (!left || !right) return true;
  if (left.max !== undefined && right.min !== undefined) {
    const compared = new Decimal(left.max).comparedTo(right.min);
    if (compared < 0 || (compared === 0 && (!left.includeMax || !right.includeMin))) return false;
  }
  if (right.max !== undefined && left.min !== undefined) {
    const compared = new Decimal(right.max).comparedTo(left.min);
    if (compared < 0 || (compared === 0 && (!right.includeMax || !left.includeMin))) return false;
  }
  return true;
}

function validateRange(range: ShippingDecimalRange | undefined, label: string) {
  if (!range?.min || !range.max) return;
  const compared = new Decimal(range.min).comparedTo(range.max);
  if (compared > 0 || (compared === 0 && (!range.includeMin || !range.includeMax))) throw new Error(`${label} 无效`);
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

function roundUp(value: Decimal, step: Decimal) {
  return value.div(step).ceil().times(step);
}

function rejectionScore(reasons: ShippingRejectionCode[]) {
  const weights: Record<ShippingRejectionCode, number> = {
    SALE_PRICE_OUT_OF_RANGE: 10,
    DESTINATION_UNSUPPORTED: 10,
    WEIGHT_OUT_OF_RANGE: 5,
    SIDE_SUM_EXCEEDED: 1,
    LONGEST_SIDE_EXCEEDED: 1,
    DIMENSION_BOX_EXCEEDED: 1,
    DENSITY_TOO_LOW: 1,
    CHARGEABLE_WEIGHT_EXCEEDED: 1
  };
  return reasons.reduce((total, reason) => total + weights[reason], 0);
}

function decimalString(value: Decimal) {
  const fixed = value.toFixed(Math.min(8, Math.max(0, value.decimalPlaces())));
  return fixed.includes('.') ? fixed.replace(/0+$/, '').replace(/\.$/, '') : fixed;
}
