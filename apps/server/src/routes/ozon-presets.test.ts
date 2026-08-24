import { describe, expect, it } from 'vitest';
import type { OzonPreset } from '@n8n-media-review/shared';
import type { OzonRepository } from '../repositories/ozon.js';
import type { PricingRepository } from '../repositories/pricing.js';
import type { ShippingRepository } from '../repositories/shipping.js';
import { assertOzonPresetPricingChain, ozonPresetApiView } from './ozon.js';

const definition = {
  pricingTemplateId: '11111111-1111-4111-8111-111111111111',
  shippingTemplateId: '22222222-2222-4222-8222-222222222222',
  shippingServiceCode: 'CEL_RFBS_ECONOMY'
};

function dependencies(pricingPlatform = 'OZON', shippingPlatform = 'OZON', serviceCode = 'CEL_RFBS_ECONOMY') {
  return {
    pricing: {
      getTemplate: async () => ({
        active: true,
        platformCode: pricingPlatform,
        versions: [{ status: 'PUBLISHED', definition: {} }]
      })
    } as unknown as PricingRepository,
    shipping: {
      getTemplate: async () => ({
        active: true,
        carrierActive: true,
        platformCode: shippingPlatform,
        versions: [{ status: 'PUBLISHED', definition: { services: [{ code: serviceCode, rules: [] }] } }]
      })
    } as unknown as ShippingRepository
  };
}

describe('OZON preset pricing-chain validation', () => {
  it('accepts only a service from the selected published OZON templates', async () => {
    const valid = dependencies();
    await expect(assertOzonPresetPricingChain(valid.pricing, valid.shipping, definition)).resolves.toBeUndefined();

    const wbPricing = dependencies('WB');
    await expect(assertOzonPresetPricingChain(wbPricing.pricing, wbPricing.shipping, definition)).rejects.toMatchObject({ code: 'PRICING_PLATFORM_MISMATCH' });

    const wbShipping = dependencies('OZON', 'WB');
    await expect(assertOzonPresetPricingChain(wbShipping.pricing, wbShipping.shipping, definition)).rejects.toMatchObject({ code: 'SHIPPING_PLATFORM_MISMATCH' });

    const wrongService = dependencies('OZON', 'OZON', 'CEL_RFBS_EXPRESS');
    await expect(assertOzonPresetPricingChain(wrongService.pricing, wrongService.shipping, definition)).rejects.toMatchObject({ code: 'SHIPPING_SERVICE_NOT_FOUND' });
  });

  it('returns published required attributes with structured PRESET/SIZE/COLOR/SYSTEM sources', async () => {
    const attribute = (id: number, nameZh: string, nameRu: string, dictionaryId = 0) => ({
      id, name: nameRu, nameRu, nameZh, description: '', type: dictionaryId ? 'Dictionary' : 'String',
      required: true, dictionaryId, maxCount: 1, groupId: 0, groupName: '', complexId: 0, isCollection: false
    });
    const categoryKey = 'ozon_15621048_91248';
    const preset = {
      id: '10000000-0000-4000-8000-000000000001',
      categoryKey,
      sharedAttributes: [{ attributeId: 9163, complexId: 0, values: [{ dictionaryValueId: 22880 }] }],
      variantAttributes: [],
      sizeAttributeKey: '4298:0',
      sizes: [{ value: 'dict:23539', stock: 1 }]
    } as unknown as OzonPreset;
    const repository = {
      getCategory: async () => ({
        publishedVersion: {
          snapshot: {
            categoryKey,
            sizing: { sizeMode: 'sized', sizeAttributeKey: '4298:0' },
            attributes: [
              attribute(31, '服装和鞋类品牌', 'Бренд', 28732849),
              attribute(9163, '性别', 'Пол', 320),
              attribute(10096, '商品颜色', 'Цвет товара', 1494),
              attribute(8292, '合并至一张卡片', 'Объединить на одной карточке'),
              attribute(4298, '俄罗斯尺码', 'Российский размер', 361),
              attribute(7777, '必填测试字段', 'Обязательное поле')
            ]
          }
        }
      })
    } as unknown as OzonRepository;

    const result = await ozonPresetApiView(repository, preset);

    expect(result.requiredAttributeCoverage).toEqual(expect.arrayContaining([
      expect.objectContaining({ attributeId: 31, nameZh: '服装和鞋类品牌', nameRu: 'Бренд', required: true, source: 'SYSTEM', covered: true }),
      expect.objectContaining({ attributeId: 9163, source: 'PRESET', covered: true }),
      expect.objectContaining({ attributeId: 10096, source: 'COLOR', covered: true }),
      expect.objectContaining({ attributeId: 8292, source: 'SYSTEM', covered: true }),
      expect.objectContaining({ attributeId: 4298, source: 'SIZE', covered: true }),
      expect.objectContaining({ attributeId: 7777, source: 'PRESET', covered: false, reason: expect.stringContaining('#7777') })
    ]));
  });
});
