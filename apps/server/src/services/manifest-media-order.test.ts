import { describe, expect, it } from 'vitest';
import { latestManifestImageOrderErrors, resolveManifestMediaOrder } from './manifest-media-order.js';

describe('resolveManifestMediaOrder', () => {
  it('uses explicit continuous sortOrder instead of file names', () => {
    const result = resolveManifestMediaOrder([
      { relativePath: 'variants/red/01.png', sortOrder: 1 },
      { relativePath: 'variants/red/07.png', sortOrder: 0 },
      { relativePath: 'variants/red/04.png', sortOrder: 2 }
    ]);

    expect(result).toMatchObject({ ok: true, mode: 'EXPLICIT' });
    if (result.ok) {
      expect(result.assets.map((asset) => asset.relativePath)).toEqual([
        'variants/red/07.png',
        'variants/red/01.png',
        'variants/red/04.png'
      ]);
    }
  });

  it('keeps the legacy natural path order only when the whole batch omits sortOrder', () => {
    const result = resolveManifestMediaOrder([
      { relativePath: 'variants/red/10.png' },
      { relativePath: 'variants/red/02.png' },
      { relativePath: 'variants/red/01.png' }
    ]);

    expect(result).toMatchObject({ ok: true, mode: 'LEGACY_PATH' });
    if (result.ok) {
      expect(result.assets.map((asset) => asset.relativePath)).toEqual([
        'variants/red/01.png',
        'variants/red/02.png',
        'variants/red/10.png'
      ]);
    }
  });

  it.each([
    {
      name: '部分缺失',
      assets: [{ relativePath: '01.png', sortOrder: 0 }, { relativePath: '02.png' }],
      reason: 'PARTIAL'
    },
    {
      name: '重复',
      assets: [{ relativePath: '01.png', sortOrder: 0 }, { relativePath: '02.png', sortOrder: 0 }],
      reason: 'DUPLICATE'
    },
    {
      name: '不连续',
      assets: [{ relativePath: '01.png', sortOrder: 0 }, { relativePath: '02.png', sortOrder: 2 }],
      reason: 'NON_CONTIGUOUS'
    },
    {
      name: '非整数',
      assets: [{ relativePath: '01.png', sortOrder: 0 }, { relativePath: '02.png', sortOrder: 1.5 }],
      reason: 'INVALID'
    }
  ])('rejects $name order without guessing', ({ assets, reason }) => {
    expect(resolveManifestMediaOrder(assets)).toMatchObject({ ok: false, reason });
  });

  it('validates only the latest submission for each variant in an accumulated manifest', () => {
    const common = { sourceStageId: 'E005', kind: 'image', variantId: 'red' };
    const errors = latestManifestImageOrderErrors([
      { ...common, submissionId: 'old', deliveredAt: '2026-08-09T00:00:00Z', relativePath: 'variants/red/old-1.png', sortOrder: 0 },
      { ...common, submissionId: 'old', deliveredAt: '2026-08-09T00:00:00Z', relativePath: 'variants/red/old-2.png' },
      { ...common, submissionId: 'new', deliveredAt: '2026-08-10T00:00:00Z', relativePath: 'variants/red/07.png', sortOrder: 0 },
      { ...common, submissionId: 'new', deliveredAt: '2026-08-10T00:00:00Z', relativePath: 'variants/red/01.png', sortOrder: 1 }
    ]);

    expect(errors).toEqual([]);
  });

  it('reports an invalid latest submission with its stable batch identity', () => {
    expect(latestManifestImageOrderErrors([
      { sourceStageId: 'E005', kind: 'image', variantId: 'red', submissionId: 'new', deliveredAt: '2026-08-10T00:00:00Z', relativePath: 'variants/red/01.png', sortOrder: 0 },
      { sourceStageId: 'E005', kind: 'image', variantId: 'red', submissionId: 'new', deliveredAt: '2026-08-10T00:00:00Z', relativePath: 'variants/red/02.png' }
    ])).toEqual([
      expect.objectContaining({ variantKey: 'variant:red', submissionId: 'new', reason: 'PARTIAL' })
    ]);
  });
});
