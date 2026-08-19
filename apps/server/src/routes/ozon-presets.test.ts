import { describe, expect, it } from 'vitest';
import type { PricingRepository } from '../repositories/pricing.js';
import type { ShippingRepository } from '../repositories/shipping.js';
import { assertOzonPresetPricingChain } from './ozon.js';

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
});
