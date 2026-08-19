import type { ShippingRule, ShippingService, ShippingTemplateDefinitionV1, ShippingTemplateType } from '@n8n-media-review/shared';

type SeedTemplate = {
  id: string;
  versionId: string;
  versionNo: number;
  name: string;
  platformCode: 'OZON' | 'WB';
  templateType: ShippingTemplateType;
  definition: ShippingTemplateDefinitionV1;
  sourceReference: Record<string, string>;
  historicalVersions: Array<{
    versionId: string;
    versionNo: number;
    definition: ShippingTemplateDefinitionV1;
    sourceReference: Record<string, string>;
  }>;
};

const sourceFileV523 = 'CEL产品资费表 V5.23(1).xlsx';
const sourceFileV724 = 'CEL产品资费表 V7.24(15).xlsx';

const decimalRange = (min?: string, max?: string, includeMin = true, includeMax = true) => ({ min, max, includeMin, includeMax });
const actual = (roundingStepKg?: string) => ({ mode: 'ACTUAL' as const, ...(roundingStepKg ? { roundingStepKg } : {}) });
const volumetric = (maxChargeableWeightKg: string, extra: Partial<ShippingRule['chargeableWeight']> = {}) => ({
  mode: 'MAX_ACTUAL_VOLUMETRIC' as const,
  volumetricDivisor: '12000',
  ...extra,
  maxChargeableWeightKg
});

type Category = {
  id: string;
  label: string;
  sale: ReturnType<typeof decimalRange>;
  weight: ReturnType<typeof decimalRange>;
  maxSideSumCm: string;
  maxLongestSideCm: string;
  maxDimensionBoxCm?: [string, string, string];
  chargeableWeight: ShippingRule['chargeableWeight'];
};

const rfbsCategories: Record<string, Category> = {
  EXTRA_SMALL: { id: 'EXTRA_SMALL', label: 'Extra Small（超级轻小件）', sale: decimalRange(undefined, '1500'), weight: decimalRange(undefined, '0.5'), maxSideSumCm: '90', maxLongestSideCm: '60', chargeableWeight: actual() },
  BUDGET: { id: 'BUDGET', label: 'Budget（低客单价标准件）', sale: decimalRange(undefined, '1500'), weight: decimalRange('0.5', '30', false), maxSideSumCm: '150', maxLongestSideCm: '60', chargeableWeight: actual() },
  SMALL: { id: 'SMALL', label: 'Small（小件）', sale: decimalRange('1500', '7000', false), weight: decimalRange(undefined, '2'), maxSideSumCm: '150', maxLongestSideCm: '60', chargeableWeight: actual() },
  BIG: { id: 'BIG', label: 'Big（大件）', sale: decimalRange('1500', '7000', false), weight: decimalRange('2', '30', false), maxSideSumCm: '310', maxLongestSideCm: '150', chargeableWeight: volumetric('31') },
  PREMIUM_SMALL: { id: 'PREMIUM_SMALL', label: 'Premium Small（高客单价小件）', sale: decimalRange('7000', '250000', false), weight: decimalRange(undefined, '5'), maxSideSumCm: '250', maxLongestSideCm: '150', chargeableWeight: actual() },
  PREMIUM_BIG: { id: 'PREMIUM_BIG', label: 'Premium Big（高客单价大件）', sale: decimalRange('7000', '250000', false), weight: decimalRange('5', '30', false), maxSideSumCm: '310', maxLongestSideCm: '150', maxDimensionBoxCm: ['150', '80', '80'], chargeableWeight: volumetric('80') }
};

function categoryRule(category: Category, serviceCode: string, ratePerKg: string, fixedFee: string, destinationCountryCodes: string[] = []): ShippingRule {
  return {
    id: `${serviceCode}_${category.id}`,
    productCategory: category.label,
    destinationCountryCodes,
    constraints: {
      salePrice: category.sale,
      actualWeightKg: category.weight,
      maxSideSumCm: category.maxSideSumCm,
      maxLongestSideCm: category.maxLongestSideCm,
      ...(category.maxDimensionBoxCm ? { maxDimensionBoxCm: category.maxDimensionBoxCm } : {}),
      ...(category.chargeableWeight.mode === 'MAX_ACTUAL_VOLUMETRIC' ? { maxChargeableWeightKg: (category.chargeableWeight as any).maxChargeableWeightKg } : {})
    },
    chargeableWeight: omitSeedOnlyFields(category.chargeableWeight),
    pricing: { ratePerKg, fixedFee, currency: 'CNY' }
  };
}

function omitSeedOnlyFields(input: ShippingRule['chargeableWeight'] & { maxChargeableWeightKg?: string }): ShippingRule['chargeableWeight'] {
  const chargeableWeight = { ...input };
  delete chargeableWeight.maxChargeableWeightKg;
  return chargeableWeight;
}

function rfbsService(code: string, name: string, channel: string, transitTime: string, rates: Array<[keyof typeof rfbsCategories, string, string]>, sortOrder: number, useDetailedReturnService = false): ShippingService {
  const categoryIds = rates.map(([category]) => category);
  const returnService = [
    categoryIds.some((category) => category === 'EXTRA_SMALL' || category === 'BUDGET')
      ? 'Extra Small / Budget：免费销毁、无改派、无退回'
      : '',
    categoryIds.some((category) => category !== 'EXTRA_SMALL' && category !== 'BUDGET')
      ? 'Small / Big / Premium：免费销毁、支持改派、支持退回（收取正向运价 1.5 倍）'
      : ''
  ].filter(Boolean).join('；');
  return {
    code, name, channel, deliveryMode: 'PUDO 到取货点 / Courier 到门', transitTime,
    returnService: useDetailedReturnService ? returnService : '以对应产品分类的承运规则为准', sortOrder,
    rules: rates.map(([category, rate, fee]) => categoryRule(rfbsCategories[category]!, code, rate, fee))
  };
}

const ozonRfbsDefinitionV523: ShippingTemplateDefinitionV1 = {
  schemaVersion: '1', currency: 'CNY', salePriceCurrencyCode: 'RUB', services: [
    rfbsService('CEL_RFBS_EXPRESS', 'CEL Express', '陆空特快', '5-10天', [
      ['EXTRA_SMALL', '46.8', '3.12'], ['BUDGET', '34.32', '23.92'], ['SMALL', '46.8', '16.64'], ['PREMIUM_SMALL', '46.8', '22.88']
    ], 10),
    rfbsService('CEL_RFBS_STANDARD', 'CEL Standard', '陆空标准', '10-15天', [
      ['EXTRA_SMALL', '36.4', '3.12'], ['BUDGET', '26', '23.92'], ['SMALL', '36.4', '16.64'], ['BIG', '26', '37.44'], ['PREMIUM_SMALL', '36.4', '22.88'], ['PREMIUM_BIG', '29.12', '64.48']
    ], 20),
    rfbsService('CEL_RFBS_ECONOMY', 'CEL Economy', '陆运经济', '15-25天', [
      ['EXTRA_SMALL', '26', '3.12'], ['BUDGET', '17.68', '23.92'], ['SMALL', '26', '16.64'], ['BIG', '17.68', '37.44'], ['PREMIUM_SMALL', '26', '22.88'], ['PREMIUM_BIG', '23.92', '64.48']
    ], 30),
    {
      code: 'CEL_RFBS_HK', name: 'CEL Express HK', channel: '香港空运', deliveryMode: 'PUDO 到取货点 / Courier 到门', transitTime: '7-12天', sortOrder: 40,
      returnService: '免费销毁；支持改派；退运收取正向运价 1.5 倍',
      rules: [{
        id: 'CEL_RFBS_HK_GENERAL', productCategory: 'HK（中国香港）', destinationCountryCodes: [],
        constraints: { salePrice: decimalRange(undefined, '500000'), actualWeightKg: decimalRange(undefined, '25'), maxSideSumCm: '310', maxLongestSideCm: '150' },
        chargeableWeight: { mode: 'MAX_ACTUAL_VOLUMETRIC', volumetricDivisor: '6000', volumetricTriggerSideSumCm: '60', volumetricRoundingStepKg: '0.1', roundingStepKg: '0.1' },
        pricing: { ratePerKg: '96', fixedFee: '19', currency: 'CNY' }
      }]
    }
  ]
};

const ozonRfbsDefinitionV724: ShippingTemplateDefinitionV1 = {
  schemaVersion: '1', currency: 'CNY', salePriceCurrencyCode: 'RUB', services: [
    rfbsService('CEL_RFBS_EXPRESS', 'CEL Express', '陆空特快', '5-10天', [
      ['EXTRA_SMALL', '50.5', '3.37'], ['BUDGET', '37.1', '25.83'], ['SMALL', '50.5', '17.97'], ['PREMIUM_SMALL', '50.5', '24.71']
    ], 10, true),
    rfbsService('CEL_RFBS_STANDARD', 'CEL Standard', '陆空标准', '10-15天', [
      ['EXTRA_SMALL', '39.3', '3.37'], ['BUDGET', '28.1', '25.83'], ['SMALL', '39.3', '17.97'], ['BIG', '28.1', '40.44'], ['PREMIUM_SMALL', '39.3', '24.71'], ['PREMIUM_BIG', '31.4', '69.64']
    ], 20, true),
    rfbsService('CEL_RFBS_ECONOMY', 'CEL Economy', '陆运经济', '15-25天', [
      ['EXTRA_SMALL', '28.1', '3.37'], ['BUDGET', '19.1', '25.83'], ['SMALL', '28.1', '17.97'], ['BIG', '19.1', '40.44'], ['PREMIUM_SMALL', '28.1', '24.71'], ['PREMIUM_BIG', '25.8', '69.64']
    ], 30, true),
    {
      code: 'CEL_RFBS_HK', name: 'CEL Express HK', channel: '香港空运', deliveryMode: 'PUDO 到取货点 / Courier 到门', transitTime: '7-12天', sortOrder: 40,
      returnService: '免费销毁；支持改派；退运收取正向运价 1.5 倍',
      rules: [{
        id: 'CEL_RFBS_HK_GENERAL', productCategory: 'HK（中国香港）', destinationCountryCodes: [],
        constraints: { salePrice: decimalRange(undefined, '500000'), actualWeightKg: decimalRange(undefined, '25'), maxSideSumCm: '310', maxLongestSideCm: '150' },
        chargeableWeight: { mode: 'MAX_ACTUAL_VOLUMETRIC', volumetricDivisor: '6000', volumetricTriggerSideSumCm: '60', volumetricRoundingStepKg: '0.1', roundingStepKg: '0.1' },
        pricing: { ratePerKg: '96', fixedFee: '19', currency: 'CNY' }
      }]
    }
  ]
};

function cisCategories(): Record<string, Category> {
  return {
    ...rfbsCategories,
    PREMIUM_SMALL: { ...rfbsCategories.PREMIUM_SMALL!, sale: decimalRange('7000', '18000', false) },
    PREMIUM_BIG: { ...rfbsCategories.PREMIUM_BIG!, sale: decimalRange('7000', '18000', false) }
  };
}

function cisService(countryCode: 'BY' | 'KZ', countryName: string, standard: boolean, sortOrder: number): ShippingService {
  const categories = cisCategories();
  const mode = standard ? 'STANDARD' : 'ECONOMY';
  const code = `CEL_CIS_${countryCode}_${mode}`;
  const rates: Record<string, [string, string]> = standard
    ? { EXTRA_SMALL: ['36.4', '3.12'], BUDGET: ['26', '23.92'], SMALL: ['36.4', '16.64'], BIG: ['26', '37.44'], PREMIUM_SMALL: ['36.4', '22.88'], PREMIUM_BIG: ['29.12', '64.48'] }
    : { EXTRA_SMALL: ['26', '3.12'], BUDGET: ['17.68', '23.92'], SMALL: ['26', '16.64'], BIG: ['17.68', '37.44'], PREMIUM_SMALL: ['26', '22.88'], PREMIUM_BIG: ['23.92', '64.48'] };
  return {
    code,
    name: `CEL ${countryName} ${standard ? 'Standard' : 'Economy'}`,
    channel: standard ? '陆空标准' : '陆运经济',
    transitTime: countryCode === 'BY' ? (standard ? '15-20天' : '25-30天') : (standard ? '10-15天' : '20-25天'),
    returnService: '销毁；部分产品支持退回', sortOrder,
    rules: Object.entries(rates).map(([categoryId, [rate, fee]]) => categoryRule(categories[categoryId]!, code, rate, fee, [countryCode]))
  };
}

const ozonCisDefinition: ShippingTemplateDefinitionV1 = {
  schemaVersion: '1', currency: 'CNY', salePriceCurrencyCode: 'RUB', services: [
    cisService('BY', '白俄罗斯', true, 10), cisService('BY', '白俄罗斯', false, 20),
    cisService('KZ', '哈萨克斯坦', true, 30), cisService('KZ', '哈萨克斯坦', false, 40)
  ]
};

const wbDefinitionV523: ShippingTemplateDefinitionV1 = {
  schemaVersion: '1', currency: 'CNY', services: [
    {
      code: 'CEL_WB_EXPRESS', name: 'CEL Wb-Express', channel: '陆空联运', deliveryMode: '珲春仓备货 / 到达取货点', transitTime: '10天', sortOrder: 10,
      notes: '包裹送仓地址需要与平台出单仓库一致；单件包裹密度需大于 70kg/m³',
      rules: [{
        id: 'CEL_WB_EXPRESS_STANDARD', productCategory: '标准包裹', destinationCountryCodes: [],
        constraints: { actualWeightKg: decimalRange(undefined, '20'), maxSideSumCm: '200', maxLongestSideCm: '115', minDensityKgM3: '70' },
        chargeableWeight: actual('0.1'), pricing: { ratePerKg: '48', fixedFee: '9', currency: 'CNY' }
      }]
    },
    {
      code: 'CEL_WB_ECONOMY', name: 'CEL Wb-Economy', channel: '陆运', deliveryMode: '前端仓库 / 到达取货点', transitTime: '20天', sortOrder: 20,
      rules: [
        { id: 'CEL_WB_ECONOMY_LIGHT', productCategory: '轻小包裹', destinationCountryCodes: [], constraints: { actualWeightKg: decimalRange(undefined, '0.3'), maxSideSumCm: '200', maxLongestSideCm: '115' }, chargeableWeight: actual('0.1'), pricing: { ratePerKg: '58', fixedFee: '2', currency: 'CNY' } },
        { id: 'CEL_WB_ECONOMY_STANDARD', productCategory: '标准包裹', destinationCountryCodes: [], constraints: { actualWeightKg: decimalRange('0.3', '20', false), maxSideSumCm: '200', maxLongestSideCm: '115' }, chargeableWeight: actual('0.1'), pricing: { ratePerKg: '43', fixedFee: '8', currency: 'CNY' } }
      ]
    }
  ]
};

const wbDefinitionV724: ShippingTemplateDefinitionV1 = {
  ...wbDefinitionV523,
  services: wbDefinitionV523.services.map((service) => ({
    ...service,
    returnService: '派送失败退回 WB 官方仓：我司不承运、不收费；清关失败退货：42 元/票'
  }))
};

export const CEL_SHIPPING_SEEDS: SeedTemplate[] = [
  {
    id: '6d8c5d9a-6ea7-4f28-9ba0-000000000001', versionId: '6d8c5d9a-6ea7-4f28-9ba0-200000000001', versionNo: 2,
    name: 'CEL OZON-rFBS V7.24', platformCode: 'OZON', templateType: 'OZON_RFBS', definition: ozonRfbsDefinitionV724,
    sourceReference: { file: sourceFileV724, sheet: 'OZON-rFBS', range: 'A2:P19', version: 'V7.24' },
    historicalVersions: [{ versionId: '6d8c5d9a-6ea7-4f28-9ba0-100000000001', versionNo: 1, definition: ozonRfbsDefinitionV523, sourceReference: { file: sourceFileV523, sheet: 'OZON-rFBS', range: 'A2:P19', version: 'V5.23' } }]
  },
  {
    id: '6d8c5d9a-6ea7-4f28-9ba0-000000000002', versionId: '6d8c5d9a-6ea7-4f28-9ba0-200000000002', versionNo: 2,
    name: 'CEL OZON-CIS V7.24', platformCode: 'OZON', templateType: 'OZON_CIS', definition: ozonCisDefinition,
    sourceReference: { file: sourceFileV724, sheet: 'OZON CIS 独联体国家', range: 'A2:L27', version: 'V7.24' },
    historicalVersions: [{ versionId: '6d8c5d9a-6ea7-4f28-9ba0-100000000002', versionNo: 1, definition: ozonCisDefinition, sourceReference: { file: sourceFileV523, sheet: 'OZON CIS 独联体国家', range: 'A2:L27', version: 'V5.23' } }]
  },
  {
    id: '6d8c5d9a-6ea7-4f28-9ba0-000000000003', versionId: '6d8c5d9a-6ea7-4f28-9ba0-200000000003', versionNo: 2,
    name: 'CEL WB V7.24', platformCode: 'WB', templateType: 'WB', definition: wbDefinitionV724,
    sourceReference: { file: sourceFileV724, sheet: 'WB', range: 'A2:K7', version: 'V7.24' },
    historicalVersions: [{ versionId: '6d8c5d9a-6ea7-4f28-9ba0-100000000003', versionNo: 1, definition: wbDefinitionV523, sourceReference: { file: sourceFileV523, sheet: 'WB', range: 'A2:K7', version: 'V5.23' } }]
  }
];
