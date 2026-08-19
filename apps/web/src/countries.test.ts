import { describe, expect, it } from 'vitest';
import { allChineseCountryOptions, chineseCountryNameForExport, countryCodeFromChineseNameOrCode, countryOptionsForCodes, countryOptionsWithLegacyCodes } from './countries';

describe('Chinese country select helpers', () => {
  it('builds Chinese labels while keeping ISO codes as values', () => {
    expect(countryOptionsForCodes(['KZ', 'BY', 'BY'])).toEqual([
      { value: 'BY', label: '白俄罗斯' },
      { value: 'KZ', label: '哈萨克斯坦' }
    ]);
    expect(allChineseCountryOptions).toContainEqual({ value: 'US', label: '美国' });
  });

  it('accepts standard Chinese names and legacy ISO codes for imports', () => {
    expect(countryCodeFromChineseNameOrCode(' 白俄罗斯 ')).toBe('BY');
    expect(countryCodeFromChineseNameOrCode('by')).toBe('BY');
    expect(countryCodeFromChineseNameOrCode('随便填写')).toBeUndefined();
    expect(chineseCountryNameForExport('KZ')).toBe('哈萨克斯坦');
  });

  it('keeps unknown historical codes visible without offering arbitrary new values', () => {
    expect(countryOptionsWithLegacyCodes(['ZZ']).at(-1)).toEqual({ value: 'ZZ', label: '未知国家（ZZ）' });
  });
});
