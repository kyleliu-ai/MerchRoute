import { decodeDescriptionTxt } from './description-txt-utils';

const MAX_DESCRIPTION_LENGTH = 5_000;

export function decodeWbDescriptionTxt(fileName: string, buffer: ArrayBuffer): string {
  return decodeDescriptionTxt(fileName, buffer, {
    maxLength: MAX_DESCRIPTION_LENGTH,
    fieldLabel: '俄文产品详情'
  });
}

export function calculateWbDiscountAudit(listingPriceCny: number, discountPercent: number, targetSalePriceCny?: number) {
  const estimatedDiscountedPriceCny = Math.round((listingPriceCny * (1 - discountPercent / 100) + Number.EPSILON) * 100) / 100;
  const differenceCny = targetSalePriceCny === undefined || !Number.isFinite(targetSalePriceCny)
    ? undefined
    : Math.round((estimatedDiscountedPriceCny - targetSalePriceCny + Number.EPSILON) * 100) / 100;
  return { estimatedDiscountedPriceCny, differenceCny, mismatch: differenceCny !== undefined && Math.abs(differenceCny) >= 0.01 };
}
