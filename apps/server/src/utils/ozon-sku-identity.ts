import type {
  OzonAttributeValueInput,
  OzonCategoryAttribute,
  OzonListingDraft
} from '@n8n-media-review/shared';

export const OZON_MODEL_NAME_ATTRIBUTE_ID = 9048;
export const OZON_PRODUCT_TYPE_ATTRIBUTE_ID = 8229;

type OzonCategoryAttributeIdentity = Pick<OzonCategoryAttribute, 'id' | 'complexId'>;

export function enforceOzonModelNameAttribute(
  attributes: OzonAttributeValueInput[],
  skuInput: string,
  categoryAttributes: OzonCategoryAttributeIdentity[] = []
): OzonAttributeValueInput[] {
  const sku = normalizedSku(skuInput);
  const supported = categoryAttributes
    .filter((attribute) => attribute.id === OZON_MODEL_NAME_ATTRIBUTE_ID)
    .sort((left, right) => Number(left.complexId !== 0) - Number(right.complexId !== 0));
  const preferredComplexId = supported[0]?.complexId;
  let modelNameWritten = false;
  const normalized = attributes.flatMap((attribute) => {
    if (attribute.attributeId !== OZON_MODEL_NAME_ATTRIBUTE_ID) {
      return [{ ...attribute, values: attribute.values.map((value) => ({ ...value })) }];
    }
    if (modelNameWritten) return [];
    modelNameWritten = true;
    return [{
      attributeId: OZON_MODEL_NAME_ATTRIBUTE_ID,
      complexId: preferredComplexId ?? attribute.complexId,
      values: [{ value: sku }]
    }];
  });
  if (!modelNameWritten && preferredComplexId !== undefined) {
    normalized.push({
      attributeId: OZON_MODEL_NAME_ATTRIBUTE_ID,
      complexId: preferredComplexId,
      values: [{ value: sku }]
    });
  }
  return normalized;
}

export function enforceOzonOfferModelGroups<T extends { modelGroup?: string }>(
  offers: T[],
  skuInput: string
): Array<T & { modelGroup: string }> {
  const sku = normalizedSku(skuInput);
  return offers.map((offer) => ({ ...offer, modelGroup: sku }));
}

export function enforceOzonProductTypeAttribute(
  attributes: OzonAttributeValueInput[],
  typeIdInput: number | undefined,
  categoryAttributes: OzonCategoryAttributeIdentity[] = []
): OzonAttributeValueInput[] {
  const typeId = Number(typeIdInput);
  if (!Number.isSafeInteger(typeId) || typeId <= 0) {
    return attributes.map((attribute) => ({
      ...attribute,
      values: attribute.values.map((value) => ({ ...value }))
    }));
  }
  const supported = categoryAttributes.some((attribute) => (
    attribute.id === OZON_PRODUCT_TYPE_ATTRIBUTE_ID && attribute.complexId === 0
  ));
  const hasExisting = attributes.some((attribute) => attribute.attributeId === OZON_PRODUCT_TYPE_ATTRIBUTE_ID);
  if (!supported && !hasExisting) {
    return attributes.map((attribute) => ({
      ...attribute,
      values: attribute.values.map((value) => ({ ...value }))
    }));
  }
  let typeWritten = false;
  const normalized = attributes.flatMap((attribute) => {
    if (attribute.attributeId !== OZON_PRODUCT_TYPE_ATTRIBUTE_ID) {
      return [{ ...attribute, values: attribute.values.map((value) => ({ ...value })) }];
    }
    if (typeWritten) return [];
    typeWritten = true;
    return [{
      attributeId: OZON_PRODUCT_TYPE_ATTRIBUTE_ID,
      complexId: 0,
      values: [{ dictionaryValueId: typeId }]
    }];
  });
  if (!typeWritten && supported) {
    normalized.push({
      attributeId: OZON_PRODUCT_TYPE_ATTRIBUTE_ID,
      complexId: 0,
      values: [{ dictionaryValueId: typeId }]
    });
  }
  return normalized;
}

export function enforceOzonSkuIdentity(
  data: OzonListingDraft['data'],
  skuInput: string,
  categoryAttributes: OzonCategoryAttributeIdentity[] = [],
  categoryTypeId?: number
): OzonListingDraft['data'] {
  return {
    ...data,
    sharedAttributes: enforceOzonProductTypeAttribute(
      enforceOzonModelNameAttribute(
        Array.isArray(data.sharedAttributes) ? data.sharedAttributes : [],
        skuInput,
        categoryAttributes
      ),
      categoryTypeId,
      categoryAttributes
    ),
    offers: enforceOzonOfferModelGroups(
      Array.isArray(data.offers) ? data.offers : [],
      skuInput
    )
  };
}

function normalizedSku(value: string): string {
  const sku = String(value || '').trim();
  if (!sku) throw new Error('OZON SKU 不能为空');
  return sku;
}
