import { describe, expect, it } from 'vitest';
import type { OzonListingDraftInput, OzonMediaAsset } from '@n8n-media-review/shared';
import { applyOzonMediaSuggestions } from './ozon-media-suggestions';

const blackId = '11111111-1111-4111-8111-111111111111';
const whiteId = '22222222-2222-4222-8222-222222222222';
const blackColor = color('a', 'Черный', '黑色');
const whiteColor = color('b', 'Белый', '白色');

describe('OZON media suggestions', () => {
  it('selects the latest E005 batch in natural order and the single latest E004 video by exact variant id', () => {
    const offers = [offer(blackId, '01', blackColor, '黑色')];
    const assets = [
      asset('old-image', 'image', blackId, blackColor, '黑色', 'E005', 'old', '2026-07-18T00:00:00.000Z', '01.png'),
      asset('new-image-10', 'image', blackId, blackColor, '黑色', 'E005', 'new', '2026-07-19T00:00:00.000Z', '10.png'),
      asset('new-image-2', 'image', blackId, blackColor, '黑色', 'E005', 'new', '2026-07-19T00:00:00.000Z', '2.png'),
      asset('new-video', 'video', blackId, blackColor, '黑色', 'E004', 'video-new', '2026-07-19T00:01:00.000Z', 'main.mp4'),
      { ...asset('invalid-image', 'image', blackId, blackColor, '黑色', 'E005', 'new', '2026-07-19T00:00:00.000Z', '3.png'), validationStatus: 'INVALID' as const, validationError: 'broken' }
    ];

    const result = applyOzonMediaSuggestions(offers, assets);

    expect(result.offers[0]!.media.map((item) => item.assetId)).toEqual(['new-image-2', 'new-image-10', 'new-video']);
    expect(result.offers[0]!.media).toMatchObject([
      { assetId: 'new-image-2', sortOrder: 0, isPrimary: true },
      { assetId: 'new-image-10', sortOrder: 1, isPrimary: false },
      { assetId: 'new-video', sortOrder: 2, isPrimary: false }
    ]);
    expect(result.report).toMatchObject({ changed: true, matchedVariants: 1, imagesAdded: 2, videosAdded: 1 });
  });

  it('uses a valid explicit E005 sortOrder as the new offer media order', () => {
    const offers = [offer(blackId, '01', blackColor, '黑色')];
    const assets = [
      asset('image-01', 'image', blackId, blackColor, '黑色', 'E005', 'ordered', '2026-08-10T00:00:00.000Z', '01.png', 1),
      asset('image-04', 'image', blackId, blackColor, '黑色', 'E005', 'ordered', '2026-08-10T00:00:00.000Z', '04.png', 2),
      asset('image-07', 'image', blackId, blackColor, '黑色', 'E005', 'ordered', '2026-08-10T00:00:00.000Z', '07.png', 0)
    ];

    const result = applyOzonMediaSuggestions(offers, assets);

    expect(result.offers[0]!.media.map((item) => item.assetId)).toEqual(['image-07', 'image-01', 'image-04']);
    expect(result.offers[0]!.media).toMatchObject([
      { sortOrder: 0, isPrimary: true },
      { sortOrder: 1, isPrimary: false },
      { sortOrder: 2, isPrimary: false }
    ]);
    expect(result.report.warnings).toEqual([]);
  });

  it.each([
    ['部分缺失', [0, undefined], '全部声明 sortOrder'],
    ['重复', [0, 0], '重复的 sortOrder'],
    ['断号', [0, 2], '从 0 开始且连续'],
    ['非整数', [0, 1.5], '非负整数']
  ] as const)('blocks a latest E005 batch with %s sortOrder', (_label, orders, expectedMessage) => {
    const offers = [offer(blackId, '01', blackColor, '黑色')];
    const assets = [
      asset('image-a', 'image', blackId, blackColor, '黑色', 'E005', 'invalid-order', '2026-08-10T00:00:00.000Z', 'a.png', orders[0]),
      asset('image-b', 'image', blackId, blackColor, '黑色', 'E005', 'invalid-order', '2026-08-10T00:00:00.000Z', 'b.png', orders[1])
    ];

    const result = applyOzonMediaSuggestions(offers, assets);

    expect(result.offers[0]!.media).toEqual([]);
    expect(result.report.warnings.join('\n')).toContain(expectedMessage);
    expect(result.report.warnings.join('\n')).toContain('已停止自动匹配');
  });

  it('never falls back to color or name when an asset carries a different productVariantId', () => {
    const offers = [offer(blackId, '01', blackColor, '黑色')];
    const assets = [asset('wrong-id', 'image', whiteId, blackColor, '黑色', 'E005', 'batch', '2026-07-19T00:00:00.000Z', '01.png')];

    const result = applyOzonMediaSuggestions(offers, assets);

    expect(result.offers[0]!.media).toEqual([]);
    expect(result.report).toMatchObject({ changed: false, matchedVariants: 0, imagesAdded: 0 });
  });

  it('allows missing-id assets to fall back only through a unique color key or normalized variant name', () => {
    const black = offer(blackId, '01', blackColor, '黑色');
    const white = offer(whiteId, '02', whiteColor, 'Белый');
    const colorFallback = { ...asset('color-fallback', 'image', undefined, blackColor, 'unused', 'E005', 'black', '2026-07-19T00:00:00.000Z', '01.png'), productVariantName: undefined };
    const nameFallback = { ...asset('name-fallback', 'image', undefined, undefined, ' БЕЛЫЙ ', 'E005', 'white', '2026-07-19T00:00:00.000Z', '01.png') };

    const result = applyOzonMediaSuggestions([black, white], [colorFallback, nameFallback]);

    expect(result.offers[0]!.media.map((item) => item.assetId)).toEqual(['color-fallback']);
    expect(result.offers[1]!.media.map((item) => item.assetId)).toEqual(['name-fallback']);
  });

  it('does not guess when fallback identities map to more than one offer', () => {
    const first = offer(blackId, '01', blackColor, '黑色');
    const second = offer(whiteId, '02', blackColor, '黑色');
    const ambiguous = asset('ambiguous', 'image', undefined, blackColor, '黑色', 'E005', 'batch', '2026-07-19T00:00:00.000Z', '01.png');

    const result = applyOzonMediaSuggestions([first, second], [ambiguous]);

    expect(result.offers.every((item) => item.media.length === 0)).toBe(true);
    expect(result.report.warnings).toEqual(expect.arrayContaining([expect.stringContaining('对应多个变体')]));
  });

  it('preserves manual image order, respects the 15 image cap, and never replaces an existing video', () => {
    const current = offer(blackId, '01', blackColor, '黑色');
    current.media = [
      reference('manual-cover', 'image', 'manual-cover.png'),
      ...Array.from({ length: 13 }, (_, index) => reference(`manual-${index + 2}`, 'image', `manual-${index + 2}.png`)),
      reference('manual-video', 'video', 'manual.mp4')
    ];
    const assets = [
      asset('auto-1', 'image', blackId, blackColor, '黑色', 'E005', 'batch', '2026-07-19T00:00:00.000Z', '01.png'),
      asset('auto-2', 'image', blackId, blackColor, '黑色', 'E005', 'batch', '2026-07-19T00:00:00.000Z', '02.png'),
      asset('auto-video', 'video', blackId, blackColor, '黑色', 'E004', 'video', '2026-07-19T00:00:00.000Z', 'main.mp4')
    ];

    const first = applyOzonMediaSuggestions([current], assets);
    const second = applyOzonMediaSuggestions(first.offers, assets);

    expect(first.offers[0]!.media.filter((item) => item.kind === 'image')).toHaveLength(15);
    expect(first.offers[0]!.media.map((item) => item.assetId).slice(0, 2)).toEqual(['manual-cover', 'manual-2']);
    expect(first.offers[0]!.media.some((item) => item.assetId === 'auto-1')).toBe(true);
    expect(first.offers[0]!.media.some((item) => item.assetId === 'auto-2')).toBe(false);
    expect(first.offers[0]!.media.find((item) => item.kind === 'video')?.assetId).toBe('manual-video');
    expect(second.report).toMatchObject({ changed: false, imagesAdded: 0, videosAdded: 0 });
  });

  it('leaves video unselected when the latest E004 batch has more than one file', () => {
    const offers = [offer(blackId, '01', blackColor, '黑色')];
    const assets = [
      asset('video-a', 'video', blackId, blackColor, '黑色', 'E004', 'batch', '2026-07-19T00:00:00.000Z', 'a.mp4'),
      asset('video-b', 'video', blackId, blackColor, '黑色', 'E004', 'batch', '2026-07-19T00:00:00.000Z', 'b.mp4')
    ];

    const result = applyOzonMediaSuggestions(offers, assets);

    expect(result.offers[0]!.media).toEqual([]);
    expect(result.report.warnings).toEqual([expect.stringContaining('2 个视频')]);
  });
});

type Offer = OzonListingDraftInput['offers'][number] & {
  productVariantId?: string;
  productVariantName?: string;
  productVariantColor?: { colorKey: string; nameRu: string; nameZh: string };
};

function offer(variantId: string, variantCode: string, productVariantColor?: ReturnType<typeof color>, productVariantName?: string): Offer {
  return {
    variantId,
    productVariantId: variantId,
    productVariantName,
    productVariantColor,
    variantCode,
    offerId: `0000001-${variantCode}`,
    barcode: '',
    modelGroup: '0000001',
    price: 100,
    stock: 1,
    descriptionWarnings: [],
    attributes: [],
    media: []
  };
}

function color(seed: string, nameRu: string, nameZh: string) {
  return { colorKey: seed.repeat(64), nameRu, nameZh };
}

function asset(
  assetId: string,
  kind: 'image' | 'video',
  productVariantId: string | undefined,
  productVariantColor: ReturnType<typeof color> | undefined,
  productVariantName: string,
  sourceStageId: 'E004' | 'E005',
  sourceSubmissionId: string,
  deliveredAt: string,
  fileName: string,
  sortOrder?: number
): OzonMediaAsset {
  return {
    assetId,
    kind,
    relativePath: `variants/${productVariantName}/${kind}s/${sourceSubmissionId}/${fileName}`,
    mimeType: kind === 'image' ? 'image/png' : 'video/mp4',
    sizeBytes: 100,
    sha256: assetId.replace(/[^a-f0-9]/g, 'a').padEnd(64, '0').slice(0, 64),
    modifiedAt: deliveredAt,
    validationStatus: 'VALID',
    productVariantId,
    productVariantName,
    productVariantColor,
    sourceStageId,
    sourceSubmissionId,
    deliveredAt,
    ...(sortOrder === undefined ? {} : { sortOrder })
  };
}

function reference(assetId: string, kind: 'image' | 'video', relativePath: string) {
  return { assetId, kind, relativePath, sortOrder: 0, isPrimary: false };
}
