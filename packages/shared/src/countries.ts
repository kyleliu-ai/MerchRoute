export type ChineseCountryCatalogItem = Readonly<{
  code: string;
  zhName: string;
}>;

const ISO_3166_ALPHA2_CODES = `
AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ
BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS BT BV BW BY BZ
CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ
DE DJ DK DM DO DZ
EC EE EG EH ER ES ET
FI FJ FK FM FO FR
GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS GT GU GW GY
HK HM HN HR HT HU
ID IE IL IM IN IO IQ IR IS IT
JE JM JO JP
KE KG KH KI KM KN KP KR KW KY KZ
LA LB LC LI LK LR LS LT LU LV LY
MA MC MD ME MF MG MH MK ML MM MN MO MP MQ MR MS MT MU MV MW MX MY MZ
NA NC NE NF NG NI NL NO NP NR NU NZ
OM
PA PE PF PG PH PK PL PM PN PR PS PT PW PY
QA
RE RO RS RU RW
SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS ST SV SX SY SZ
TC TD TF TG TH TJ TK TL TM TN TO TR TT TV TW TZ
UA UG UM US UY UZ
VA VC VE VG VI VN VU
WF WS
YE YT
ZA ZM ZW
`.trim().split(/\s+/);

const COMMON_CHINESE_NAME_OVERRIDES: Readonly<Record<string, string>> = Object.freeze({
  HK: '中国香港',
  MO: '中国澳门',
  TW: '中国台湾'
});

const regionNames = new Intl.DisplayNames(['zh-CN'], { type: 'region', fallback: 'none' });

export const chineseCountryCatalog: readonly ChineseCountryCatalogItem[] = Object.freeze(
  ISO_3166_ALPHA2_CODES
    .map((code) => Object.freeze({ code, zhName: COMMON_CHINESE_NAME_OVERRIDES[code] || regionNames.of(code) || code }))
    .sort((left, right) => left.zhName.localeCompare(right.zhName, 'zh-CN'))
);

const countryByCode = new Map(chineseCountryCatalog.map((country) => [country.code, country]));
const countryCodeByChineseName = new Map(chineseCountryCatalog.map((country) => [country.zhName, country.code]));

export function countryCodeToChineseName(value: string): string | undefined {
  return countryByCode.get(value.trim().toUpperCase())?.zhName;
}

export function chineseCountryNameToCode(value: string): string | undefined {
  return countryCodeByChineseName.get(value.trim());
}

export function resolveCountryCode(value: string): string | undefined {
  const normalized = value.trim();
  if (!normalized) return undefined;
  const code = normalized.toUpperCase();
  return countryByCode.has(code) ? code : chineseCountryNameToCode(normalized);
}

export function countryCodeToChineseLabel(value: string): string {
  const normalized = value.trim().toUpperCase();
  return countryCodeToChineseName(normalized) || `未知国家（${normalized || value.trim()}）`;
}
