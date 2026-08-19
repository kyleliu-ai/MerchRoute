import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  enforceOzonModelNameAttribute,
  enforceOzonOfferModelGroups,
  enforceOzonProductTypeAttribute,
  enforceOzonSkuIdentity
} from './ozon-sku-identity.js';

describe('OZON SKU model identity', () => {
  it('replaces legacy model names with the plain SKU and removes duplicate 9048 values', () => {
    expect(enforceOzonModelNameAttribute([
      { attributeId: 9048, complexId: 0, values: [{ value: 'Товар 0000049' }] },
      { attributeId: 85, complexId: 0, values: [{ value: 'Нет бренда' }] },
      { attributeId: 9048, complexId: 100, values: [{ value: 'duplicate' }] }
    ], '0000049', [{ id: 9048, complexId: 0 }])).toEqual([
      { attributeId: 9048, complexId: 0, values: [{ value: '0000049' }] },
      { attributeId: 85, complexId: 0, values: [{ value: 'Нет бренда' }] }
    ]);
  });

  it('adds 9048 only when the selected category supports it and forces every modelGroup', () => {
    const variantId = randomUUID();
    const base = {
      categoryKey: 'ozon_1_2',
      fulfillmentMode: 'FBS' as const,
      warehouseId: '',
      currency: 'RUB' as const,
      vat: '0.2' as const,
      titleRu: '',
      descriptionRu: '',
      brand: '',
      sharedAttributes: [],
      offers: [{
        variantId,
        variantCode: '01',
        offerId: '0000051-01',
        barcode: '',
        modelGroup: '0000051-model',
        price: 1,
        stock: 0,
        attributes: [],
        media: []
      }],
      mediaAssets: [],
      mediaSourceRoot: ''
    };
    expect(enforceOzonSkuIdentity(base, '0000051', [{ id: 9048, complexId: 0 }])).toMatchObject({
      sharedAttributes: [{ attributeId: 9048, complexId: 0, values: [{ value: '0000051' }] }],
      offers: [{ modelGroup: '0000051' }]
    });
    expect(enforceOzonSkuIdentity(base, '0000051', [])).toMatchObject({
      sharedAttributes: [],
      offers: [{ modelGroup: '0000051' }]
    });
    expect(enforceOzonOfferModelGroups([
      { modelGroup: 'legacy' },
      { modelGroup: '' }
    ], '0000051')).toEqual([
      { modelGroup: '0000051' },
      { modelGroup: '0000051' }
    ]);
  });

  it('authoritatively stores platform type 8229 as the category type dictionary value', () => {
    const normalized = enforceOzonProductTypeAttribute([
      { attributeId: 8229, complexId: 0, values: [{ value: '0000051' }] },
      { attributeId: 8229, complexId: 100, values: [{ dictionaryValueId: 1 }] },
      { attributeId: 9048, complexId: 0, values: [{ value: '0000051' }] }
    ], 970642857, [{ id: 8229, complexId: 0 }]);
    expect(normalized).toEqual([
      { attributeId: 8229, complexId: 0, values: [{ dictionaryValueId: 970642857 }] },
      { attributeId: 9048, complexId: 0, values: [{ value: '0000051' }] }
    ]);
    expect(normalized.find((attribute) => attribute.attributeId === 8229)?.values[0]).not.toHaveProperty('value');
  });
});
