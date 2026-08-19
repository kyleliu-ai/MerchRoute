import { describe, expect, it } from 'vitest';
import type { OzonCatalogDictionaryValue, ProductVariant, VariantSelectionGroup } from '@n8n-media-review/shared';
import {
  applyOzonColorChange,
  applyWbColorChange,
  exactOzonColorForRussianName,
  filterOzonColors,
  reconcileVariantOzonColors
} from './e001-variant-colors';

const wbBlack = { itemKey: 'a'.repeat(64), nameZh: '黑色', nameRu: 'чёрный', fullNameZh: '黑色', fullNameRu: 'чёрный' };
const wbWhite = { itemKey: 'b'.repeat(64), nameZh: '白色', nameRu: 'белый', fullNameZh: '白色', fullNameRu: 'белый' };
const ozonBlack = color('black', 61577, '黑色', 'черный');
const ozonSapphire = color('sapphire', 972075931, '黑蓝宝石', 'черный сапфир');

describe('E001 dual-platform variant colors', () => {
  it('matches one OZON color by normalized Russian name and does not match ambiguities', () => {
    expect(exactOzonColorForRussianName(' ЧЁРНЫЙ ', [ozonBlack, ozonSapphire])).toEqual(ozonBlack);
    expect(exactOzonColorForRussianName('черный', [ozonBlack, { ...ozonBlack, itemKey: 'other', valueId: 8 }])).toBeUndefined();
  });

  it('recomputes automatic OZON colors after a WB change but preserves manual choices', () => {
    const automatic = [group({ wbColor: { colorKey: wbBlack.itemKey, nameZh: '黑色', nameRu: 'чёрный' }, ozonColor: identity(ozonBlack, 'AUTO_EXACT_RU') })];
    const changed = applyWbColorChange(automatic, 'group-1', wbWhite, [ozonBlack, color('white', 10, '白色', 'белый')]);
    expect(changed[0]?.ozonColor).toMatchObject({ valueId: 10, source: 'AUTO_EXACT_RU' });

    const manual = applyOzonColorChange(automatic, 'group-1', ozonSapphire);
    const preserved = applyWbColorChange(manual, 'group-1', wbWhite, [ozonBlack, ozonSapphire]);
    expect(preserved[0]?.ozonColor).toMatchObject({ valueId: ozonSapphire.valueId, source: 'MANUAL_E001' });
  });

  it('keeps an explicit optional clear and can restore a persisted product mapping', () => {
    const cleared = applyOzonColorChange([group({ wbColor: { colorKey: wbBlack.itemKey, nameZh: '黑色', nameRu: 'чёрный' } })], 'group-1');
    expect(cleared[0]).toMatchObject({ ozonColorSuppressed: true });
    expect(reconcileVariantOzonColors(cleared, [], [ozonBlack])).toBe(cleared);

    const productVariants: ProductVariant[] = [{
      variantId: '11111111-1111-4111-8111-111111111111',
      name: '黑色',
      wbColor: { colorKey: wbBlack.itemKey, nameZh: '黑色', nameRu: 'чёрный' },
      ozonColor: identity(ozonSapphire, 'MANUAL_E001')
    }];
    const restored = reconcileVariantOzonColors([group({ wbColor: productVariants[0]!.wbColor })], productVariants, [ozonBlack, ozonSapphire]);
    expect(restored[0]?.ozonColor).toMatchObject({ valueId: ozonSapphire.valueId, source: 'MANUAL_E001' });
  });

  it('searches Chinese and Russian locally, excludes missing Chinese and returns at most 30 rows', () => {
    expect(filterOzonColors([ozonBlack, ozonSapphire], 'сапфир').map((item) => item.itemKey)).toEqual(['sapphire']);
    expect(filterOzonColors([ozonBlack, ozonSapphire], '黑').map((item) => item.itemKey)).toEqual(['black', 'sapphire']);
    const many = Array.from({ length: 40 }, (_, index) => color(`color-${index}`, 1_000 + index, `颜色${index}`, `цвет ${index}`));
    many.push({ ...ozonBlack, itemKey: 'missing-zh', valueId: 999, nameZh: '' });
    expect(filterOzonColors(many, '')).toHaveLength(30);
    expect(filterOzonColors(many, '').some((item) => item.itemKey === 'missing-zh')).toBe(false);
  });
});

function color(itemKey: string, valueId: number, nameZh: string, nameRu: string): OzonCatalogDictionaryValue {
  return { directory: 'colors', itemKey, attributeId: 10096, dictionaryId: 1494, valueId, nameZh, nameRu };
}

function identity(item: OzonCatalogDictionaryValue, source: 'AUTO_EXACT_RU' | 'MANUAL_E001') {
  return { itemKey: item.itemKey, dictionaryId: item.dictionaryId, valueId: item.valueId, nameZh: item.nameZh, nameRu: item.nameRu, source };
}

function group(input: Partial<VariantSelectionGroup>): VariantSelectionGroup {
  return { groupId: 'group-1', variantName: '黑色', selectedRelativePaths: ['01.png'], ...input };
}
