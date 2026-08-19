import { describe, expect, it } from 'vitest';
import type { ProductVariant } from '@n8n-media-review/shared';
import type { WbDictionaryValue, WbListing, WbMediaAsset } from './api/client';
import { applyWbMediaSuggestions, WB_COLOR_CHARACTERISTIC_ID } from './wb-media-suggestions';

const black = color('a'.repeat(64), 'Черный', '黑色');
const white = color('b'.repeat(64), 'Белый', '白色');
const productVariants: ProductVariant[] = [
  { variantId: '11111111-1111-4111-8111-111111111111', name: '黑色', wbColor: { colorKey: black.itemKey, nameRu: black.nameRu, nameZh: black.nameZh } },
  { variantId: '22222222-2222-4222-8222-222222222222', name: '白色', wbColor: { colorKey: white.itemKey, nameRu: white.nameRu, nameZh: white.nameZh } }
];

describe('WB media suggestions', () => {
  it('links variants by color and selects only the latest E005/E004 delivery batches', () => {
    const listing = baseListing([
      asset('black-old', 'image', productVariants[0]!, 'E005', 'old', '2026-07-18T00:00:00.000Z'),
      asset('black-2', 'image', productVariants[0]!, 'E005', 'new', '2026-07-19T00:00:00.000Z'),
      asset('black-1', 'image', productVariants[0]!, 'E005', 'new', '2026-07-19T00:00:00.000Z'),
      asset('black-video', 'video', productVariants[0]!, 'E004', 'video-new', '2026-07-19T00:01:00.000Z'),
      asset('white-1', 'image', productVariants[1]!, 'E005', 'white-new', '2026-07-19T00:02:00.000Z')
    ]);
    const result = applyWbMediaSuggestions(listing, productVariants, [black, white], { maxImages: 7, videoAllowed: true, colorSupported: true });
    expect(result.variants[0]).toMatchObject({ productVariantId: productVariants[0]!.variantId, productVariantName: '黑色' });
    expect(result.variantMedia[0]).toEqual({ variantId: listing.variants[0]!.variantId, imageAssetIds: ['black-1', 'black-2'], videoAssetId: 'black-video' });
    expect(result.variantMedia[1]!.imageAssetIds).toEqual(['white-1']);
    expect(result.report).toMatchObject({ changed: true, matchedVariants: 2, imagesAdded: 3, videosAdded: 1 });
  });

  it('uses a valid explicit E005 sortOrder instead of the file path', () => {
    const listing = baseListing([
      asset('image-01', 'image', productVariants[0]!, 'E005', 'ordered', '2026-08-10T00:00:00.000Z', 1),
      asset('image-04', 'image', productVariants[0]!, 'E005', 'ordered', '2026-08-10T00:00:00.000Z', 2),
      asset('image-07', 'image', productVariants[0]!, 'E005', 'ordered', '2026-08-10T00:00:00.000Z', 0)
    ]);

    const result = applyWbMediaSuggestions(listing, productVariants, [black, white], { maxImages: 7, videoAllowed: true, colorSupported: true });

    expect(result.variantMedia[0]!.imageAssetIds).toEqual(['image-07', 'image-01', 'image-04']);
    expect(result.report.warnings).toEqual([]);
  });

  it.each([
    ['部分缺失', [0, undefined], '全部声明 sortOrder'],
    ['重复', [0, 0], '重复的 sortOrder'],
    ['断号', [0, 2], '从 0 开始且连续'],
    ['非整数', [0, 1.5], '非负整数']
  ] as const)('blocks a latest E005 batch with %s sortOrder', (_label, orders, expectedMessage) => {
    const listing = baseListing([
      asset('image-a', 'image', productVariants[0]!, 'E005', 'invalid-order', '2026-08-10T00:00:00.000Z', orders[0]),
      asset('image-b', 'image', productVariants[0]!, 'E005', 'invalid-order', '2026-08-10T00:00:00.000Z', orders[1])
    ]);

    const result = applyWbMediaSuggestions(listing, productVariants, [black, white], { maxImages: 7, videoAllowed: true, colorSupported: true });

    expect(result.variantMedia[0]!.imageAssetIds).toEqual([]);
    expect(result.report.warnings.join('\n')).toContain(expectedMessage);
    expect(result.report.warnings.join('\n')).toContain('已停止自动匹配');
  });

  it('preserves manual order, avoids duplicates, respects maxImages and never overwrites a video', () => {
    const listing = baseListing([
      asset('black-1', 'image', productVariants[0]!, 'E005', 'new', '2026-07-19T00:00:00.000Z'),
      asset('black-2', 'image', productVariants[0]!, 'E005', 'new', '2026-07-19T00:00:00.000Z'),
      asset('black-video-new', 'video', productVariants[0]!, 'E004', 'new-video', '2026-07-19T00:00:00.000Z')
    ]);
    listing.variantMedia[0] = { variantId: listing.variants[0]!.variantId, imageAssetIds: ['manual-cover', 'black-1'], videoAssetId: 'manual-video' };
    const result = applyWbMediaSuggestions(listing, productVariants, [black, white], { maxImages: 3, videoAllowed: true, colorSupported: true });
    expect(result.variantMedia[0]).toEqual({ variantId: listing.variants[0]!.variantId, imageAssetIds: ['manual-cover', 'black-1', 'black-2'], videoAssetId: 'manual-video' });
  });

  it('keeps conflicting manual color/link values unchanged and warns instead of assigning media', () => {
    const listing = baseListing([asset('black-1', 'image', productVariants[0]!, 'E005', 'new', '2026-07-19T00:00:00.000Z')]);
    listing.variants[0] = { ...listing.variants[0]!, productVariantId: productVariants[0]!.variantId, productVariantName: '黑色', productVariantColor: productVariants[0]!.wbColor, characteristics: [{ id: WB_COLOR_CHARACTERISTIC_ID, value: ['Белый'] }] };
    const result = applyWbMediaSuggestions(listing, productVariants, [black, white], { maxImages: 7, videoAllowed: true, colorSupported: true });
    expect(result.variantMedia[0]!.imageAssetIds).toEqual([]);
    expect(result.report.warnings[0]).toContain('冲突');
  });

  it('leaves video unassigned when the latest E004 batch contains more than one file', () => {
    const listing = baseListing([
      asset('video-a', 'video', productVariants[0]!, 'E004', 'batch', '2026-07-19T00:00:00.000Z'),
      asset('video-b', 'video', productVariants[0]!, 'E004', 'batch', '2026-07-19T00:00:00.000Z')
    ]);
    const result = applyWbMediaSuggestions(listing, productVariants, [black, white], { maxImages: 7, videoAllowed: true, colorSupported: true });
    expect(result.variantMedia[0]!.videoAssetId).toBeUndefined();
    expect(result.report.warnings.some((warning) => warning.includes('2 个视频'))).toBe(true);
  });

  it('does not mark a saved draft dirty when PostgreSQL returns object keys in a different order', () => {
    const listing = baseListing([]);
    listing.variants = listing.variants.map((variant, index) => {
      const productVariant = productVariants[index]!;
      const color = productVariant.wbColor!;
      return {
        ...variant,
        productVariantId: productVariant.variantId,
        productVariantName: productVariant.name,
        productVariantColor: { nameRu: color.nameRu, nameZh: color.nameZh, colorKey: color.colorKey }
      };
    });

    const result = applyWbMediaSuggestions(listing, productVariants, [black, white], { maxImages: 7, videoAllowed: true, colorSupported: true });

    expect(Object.keys(listing.variants[0]!.productVariantColor!)).toEqual(['nameRu', 'nameZh', 'colorKey']);
    expect(Object.keys(result.variants[0]!.productVariantColor!)).toEqual(['colorKey', 'nameRu', 'nameZh']);
    expect(result.report).toMatchObject({ changed: false, matchedVariants: 2, imagesAdded: 0, videosAdded: 0 });
  });
});

function color(itemKey: string, nameRu: string, nameZh: string): WbDictionaryValue {
  return { itemKey, nameRu, nameZh, fullNameRu: '', fullNameZh: '', parentNameRu: nameRu, parentNameZh: nameZh };
}

function asset(assetId: string, kind: 'image' | 'video', variant: ProductVariant, sourceStageId: 'E004' | 'E005', sourceSubmissionId: string, deliveredAt: string, sortOrder?: number): WbMediaAsset {
  return {
    assetId, kind, relativePath: `variants/${variant.name}/${kind}s/${sourceSubmissionId}/${assetId}.${kind === 'image' ? 'png' : 'mp4'}`,
    mimeType: kind === 'image' ? 'image/png' : 'video/mp4', sizeBytes: 100, sha256: assetId.padEnd(64, '0').slice(0, 64), modifiedAt: deliveredAt,
    validationStatus: 'VALID', productVariantId: variant.variantId, productVariantName: variant.name, productVariantColor: variant.wbColor,
    sourceStageId, sourceSubmissionId, deliveredAt, ...(sortOrder === undefined ? {} : { sortOrder })
  };
}

function baseListing(mediaAssets: WbMediaAsset[]): WbListing {
  const variants = [
    { variantId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', variantCode: '0000001-01', vendorCode: '0000001-01', characteristics: [{ id: WB_COLOR_CHARACTERISTIC_ID, value: ['Черный'] }], sizes: [] },
    { variantId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', variantCode: '0000001-02', vendorCode: '0000001-02', characteristics: [{ id: WB_COLOR_CHARACTERISTIC_ID, value: ['Белый'] }], sizes: [] }
  ];
  return {
    sku: '0000001', productName: '测试鞋', status: 'DRAFT', draftVersion: 1, brand: '', titleRu: '', descriptionRu: '', packaging: {}, priceCny: 1,
    discountPercent: 0, videoUploadMode: 'ORIGINAL', compliance: {}, sharedCharacteristics: [], variants, mediaAssets,
    variantMedia: variants.map((variant) => ({ variantId: variant.variantId, imageAssetIds: [] }))
  };
}
