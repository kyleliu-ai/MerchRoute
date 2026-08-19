import { chineseCountryCatalog, countryCodeToChineseLabel, countryCodeToChineseName, resolveCountryCode } from '@n8n-media-review/shared';

export type CountrySelectOption = Readonly<{ value: string; label: string }>;

export const allChineseCountryOptions: readonly CountrySelectOption[] = chineseCountryCatalog.map((country) => ({
  value: country.code,
  label: country.zhName
}));

export function countryOptionsForCodes(codes: readonly string[]): CountrySelectOption[] {
  return [...new Set(codes.map((code) => code.trim().toUpperCase()).filter(Boolean))]
    .map((code) => ({ value: code, label: countryCodeToChineseLabel(code) }))
    .sort((left, right) => left.label.localeCompare(right.label, 'zh-CN'));
}

export function countryOptionsWithLegacyCodes(codes: readonly string[]): CountrySelectOption[] {
  const unknownOptions = countryOptionsForCodes(codes).filter((option) => !countryCodeToChineseName(option.value));
  return [...allChineseCountryOptions, ...unknownOptions];
}

export function countryCodeFromChineseNameOrCode(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  return resolveCountryCode(String(value));
}

export function chineseCountryNameForExport(code: string | null | undefined): string {
  return code ? countryCodeToChineseLabel(code) : '';
}
