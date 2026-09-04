/**
 * MerchRoute's portable OZON text contract.
 *
 * The description limit is deliberately a product safety default, not a claim
 * that every OZON category exposes the same server-side rule. Category
 * attributes remain authoritative for category-specific requirements.
 */
export const OZON_TITLE_MAX_LENGTH = 200;
export const OZON_DESCRIPTION_MAX_LENGTH = 6_000;
export const OZON_DESCRIPTION_MAX_LENGTH_SOURCE = 'MERCHROUTE_SAFE_DEFAULT' as const;
export const OZON_CONTENT_POLICY_V2 = 'merchroute-ozon-content-v2' as const;
export const OZON_CONTENT_POLICY_V3 = 'merchroute-ozon-content-v3' as const;
export const OZON_CONTENT_POLICY_V4 = 'merchroute-ozon-content-v4' as const;
export const OZON_EXECUTABLE_CONTENT_POLICY_VERSIONS = [
  OZON_CONTENT_POLICY_V2,
  OZON_CONTENT_POLICY_V3,
  OZON_CONTENT_POLICY_V4
] as const;
export const OZON_CONTENT_POLICY_VERSION = OZON_CONTENT_POLICY_V4;
export const OZON_LEGACY_UNKNOWN_CONTENT_POLICY_VERSION = 'LEGACY_UNKNOWN' as const;

export type OzonContentPolicyVersion = (typeof OZON_EXECUTABLE_CONTENT_POLICY_VERSIONS)[number];
export type OzonStoredContentPolicyVersion = OzonContentPolicyVersion | typeof OZON_LEGACY_UNKNOWN_CONTENT_POLICY_VERSION;

const CJK_PATTERN = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
// eslint-disable-next-line no-control-regex -- marketplace text excludes controls and private-use code points.
const INVALID_PLATFORM_TEXT_PATTERN = /[\p{Extended_Pictographic}\p{Private_Use}\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/u;
const HIDDEN_FORMAT_PATTERN = /[\u00A0\p{Cf}]/u;
const TITLE_ALLOWED_CHARACTERS = /^[A-Za-zА-Яа-яЁё0-9 .,:;()\-/&"!?]+$/u;
const TITLE_FORBIDDEN_SYMBOL_PATTERN = /[™©®[\]=\\«»]/u;
const HTML_TAG_PATTERN = /<[^>]*>/u;
const HTML_TAGS_PATTERN = /<[^>]*>/gu;
const URL_PATTERN = /(?:https?:\/\/|www\.)\S+|\b[a-z0-9-]+\.(?:ru|com|net|org|io|shop|store)\b/iu;
const EMAIL_PATTERN = /[\p{L}\p{N}._%+-]+@[\p{L}\p{N}.-]+\.[\p{L}]{2,}/u;
const CONTACT_HINT_PATTERN = /(?:тел(?:ефон)?|звоните|whatsapp|viber|telegram)\s*[:.-]?\s*(?:\+?\d[\d\s().-]{6,}\d)/iu;
const PHONE_CANDIDATE_PATTERN = /\+?\d[\d\s().-]{6,}\d/gu;
const ADVERTISING_PATTERN = /(?:^|[^\p{L}])(?:акци[яи]|распродаж\p{L}*|скидк\p{L}*|выгодн(?:ое|ые)\s+предложени\p{L}*|лучший\s+(?:товар|выбор)|сам(?:ый|ая|ое|ые)\s+лучший|топ(?:[- ]?товар)?|хит продаж|sale|discount|best price)(?=$|[^\p{L}])/iu;
const PRICE_PATTERN = /(?:^|[^\p{L}\p{N}])(?:цен[аы]|(?:от\s+)?\d[\d\s.,]*\s*(?:₽|руб\.?|р\.?|usd|eur))(?=$|[^\p{L}\p{N}])|[$€]/iu;
const IMITATION_PATTERN_V2 = /(?:^|[^\p{L}\p{N}])(?:аналог\p{L}*|реплик\p{L}*|копи[яи]\p{L}*|подделк\p{L}*|имитац\p{L}*|1\s*:\s*1|replica|imitation|counterfeit)(?=$|[^\p{L}\p{N}])/iu;
const IMITATION_PATTERN_V3 = /(?:^|[^\p{L}\p{N}])(?:аналог(?:а|у|ом|е|и|ов|ам|ами|ах)?|реплик\p{L}*|копи[яи]\p{L}*|подделк\p{L}*|имитац\p{L}*|1\s*:\s*1|replica|imitation|counterfeit)(?=$|[^\p{L}\p{N}])/iu;

export type OzonTextPolicyIssue =
  | 'EMPTY'
  | 'TOO_LONG'
  | 'MULTILINE'
  | 'CJK'
  | 'INVALID_CHARACTER'
  | 'HIDDEN_CHARACTER'
  | 'UNSUPPORTED_HTML'
  | 'UNBALANCED_HTML'
  | 'INVALID_TITLE_CHARACTER'
  | 'FORBIDDEN_SYMBOL'
  | 'TITLE_INITIAL_NOT_UPPERCASE'
  | 'TITLE_WORD_TOO_LONG'
  | 'EXTERNAL_LINK'
  | 'CONTACT_INFORMATION'
  | 'ADVERTISING'
  | 'PRICE_INFORMATION'
  | 'IMITATION_CLAIM'
  | 'KEYWORD_STUFFING'
  | 'UNSUPPORTED_CONTENT_POLICY_VERSION';

export type OzonTextPolicyResult = {
  valid: boolean;
  policyVersion: OzonContentPolicyVersion | string;
  normalizedForValidation: string;
  normalizedForSubmission: string;
  length: number;
  issues: OzonTextPolicyIssue[];
  warnings: OzonTextPolicyIssue[];
};

export function isExecutableOzonContentPolicyVersion(value: unknown): value is OzonContentPolicyVersion {
  return OZON_EXECUTABLE_CONTENT_POLICY_VERSIONS.includes(value as OzonContentPolicyVersion);
}

export function assertExecutableOzonContentPolicyVersion(value: unknown): OzonContentPolicyVersion {
  if (!isExecutableOzonContentPolicyVersion(value)) {
    throw new Error(`OZON 内容策略版本不可执行: ${String(value ?? '') || '(empty)'}`);
  }
  return value;
}

function imitationPatternForPolicy(policyVersion: string): RegExp | undefined {
  if (policyVersion === OZON_CONTENT_POLICY_V2) return IMITATION_PATTERN_V2;
  if (policyVersion === OZON_CONTENT_POLICY_V3 || policyVersion === OZON_CONTENT_POLICY_V4) return IMITATION_PATTERN_V3;
  return undefined;
}

/** Counts Unicode code points, matching the existing title workflow contract. */
export function countOzonTextCharacters(value: unknown): number {
  return Array.from(String(value ?? '')).length;
}

/**
 * Normalization is validation-only. Callers must keep the original source
 * string when persisting product.json, so literal `\\n` and physical newlines
 * have equivalent validation semantics without rewriting the artifact.
 */
export function normalizeOzonDescriptionForSubmission(value: unknown): string {
  return String(value ?? '')
    .normalize('NFC')
    .replace(/\\n/g, '\n')
    .replace(/\r\n?/g, '\n')
    .replace(/\n/g, '<br>')
    // Only canonicalize the exact allow-list forms. All other markup remains
    // visible to validation and is rejected instead of being repaired.
    .replace(/<br\s*\/?>/giu, '<br>')
    .replace(/<(ul|li)\s*>/giu, (_tag, name: string) => `<${name.toLowerCase()}>`)
    .replace(/<\/(ul|li)\s*>/giu, (_tag, name: string) => `</${name.toLowerCase()}>`);
}

/** @deprecated Use normalizeOzonDescriptionForSubmission for the shared contract. */
export function normalizeOzonDescriptionForValidation(value: unknown): string {
  return normalizeOzonDescriptionForSubmission(value);
}

export function hasOzonCjk(value: unknown): boolean {
  return CJK_PATTERN.test(String(value ?? ''));
}

export function hasOzonInvalidPlatformCharacters(value: unknown): boolean {
  return INVALID_PLATFORM_TEXT_PATTERN.test(String(value ?? ''));
}

export function validateOzonTitle(
  value: unknown,
  policyVersionInput: string = OZON_CONTENT_POLICY_VERSION
): OzonTextPolicyResult {
  const policyVersion = String(policyVersionInput || '');
  const imitationPattern = imitationPatternForPolicy(policyVersion);
  const normalizedForValidation = String(value ?? '');
  const issues: OzonTextPolicyIssue[] = [];
  if (!imitationPattern) issues.push('UNSUPPORTED_CONTENT_POLICY_VERSION');
  const length = countOzonTextCharacters(normalizedForValidation);
  if (!normalizedForValidation) issues.push('EMPTY');
  if (length > OZON_TITLE_MAX_LENGTH) issues.push('TOO_LONG');
  if (/[\r\n]/.test(normalizedForValidation) || /\\n/.test(normalizedForValidation)) issues.push('MULTILINE');
  if (hasOzonCjk(normalizedForValidation)) issues.push('CJK');
  if (hasOzonInvalidPlatformCharacters(normalizedForValidation)) issues.push('INVALID_CHARACTER');
  if (HIDDEN_FORMAT_PATTERN.test(normalizedForValidation)) issues.push('HIDDEN_CHARACTER');
  if (HTML_TAG_PATTERN.test(normalizedForValidation)) issues.push('UNSUPPORTED_HTML');
  if (URL_PATTERN.test(normalizedForValidation)) issues.push('EXTERNAL_LINK');
  if (ADVERTISING_PATTERN.test(normalizedForValidation)) issues.push('ADVERTISING');
  if (PRICE_PATTERN.test(normalizedForValidation)) issues.push('PRICE_INFORMATION');
  if (imitationPattern?.test(normalizedForValidation)) issues.push('IMITATION_CLAIM');
  if (TITLE_FORBIDDEN_SYMBOL_PATTERN.test(normalizedForValidation)) issues.push('FORBIDDEN_SYMBOL');
  if (!TITLE_ALLOWED_CHARACTERS.test(normalizedForValidation)) issues.push('INVALID_TITLE_CHARACTER');
  if (normalizedForValidation && !/^[A-ZА-ЯЁ]/u.test(normalizedForValidation)) issues.push('TITLE_INITIAL_NOT_UPPERCASE');
  if (normalizedForValidation.split(' ').some((word) => countOzonTextCharacters(word) > 27)) issues.push('TITLE_WORD_TOO_LONG');
  if (hasTitleKeywordStuffing(normalizedForValidation)) issues.push('KEYWORD_STUFFING');
  return { valid: issues.length === 0, policyVersion, normalizedForValidation, normalizedForSubmission: normalizedForValidation, length, issues, warnings: [] };
}

export function validateOzonDescription(
  value: unknown,
  policyVersionInput: string = OZON_CONTENT_POLICY_VERSION
): OzonTextPolicyResult {
  const policyVersion = String(policyVersionInput || '');
  const imitationPattern = imitationPatternForPolicy(policyVersion);
  const normalizedForSubmission = normalizeOzonDescriptionForSubmission(value);
  const normalizedForValidation = normalizedForSubmission;
  const issues: OzonTextPolicyIssue[] = [];
  const warnings: OzonTextPolicyIssue[] = [];
  if (!imitationPattern) issues.push('UNSUPPORTED_CONTENT_POLICY_VERSION');
  const length = countOzonTextCharacters(normalizedForValidation);
  if (!normalizedForValidation.trim()) issues.push('EMPTY');
  if (length > OZON_DESCRIPTION_MAX_LENGTH) issues.push('TOO_LONG');
  if (hasOzonCjk(normalizedForValidation)) issues.push('CJK');
  if (hasOzonInvalidPlatformCharacters(normalizedForValidation)) issues.push('INVALID_CHARACTER');
  if (HIDDEN_FORMAT_PATTERN.test(normalizedForValidation)) issues.push('HIDDEN_CHARACTER');
  if (URL_PATTERN.test(normalizedForValidation)) issues.push('EXTERNAL_LINK');
  if (hasContactInformation(normalizedForValidation)) issues.push('CONTACT_INFORMATION');
  if (ADVERTISING_PATTERN.test(normalizedForValidation)) issues.push('ADVERTISING');
  if (PRICE_PATTERN.test(normalizedForValidation)) issues.push('PRICE_INFORMATION');
  if (imitationPattern?.test(normalizedForValidation)) issues.push('IMITATION_CLAIM');
  validateDescriptionHtml(normalizedForValidation, issues);
  if (hasDescriptionKeywordStuffing(normalizedForValidation)) {
    if (policyVersion === OZON_CONTENT_POLICY_V4) warnings.push('KEYWORD_STUFFING');
    else issues.push('KEYWORD_STUFFING');
  }
  return { valid: issues.length === 0, policyVersion, normalizedForValidation, normalizedForSubmission, length, issues, warnings };
}

export function assertOzonTitle(value: unknown, policyVersion: string = OZON_CONTENT_POLICY_VERSION): string {
  const result = validateOzonTitle(value, policyVersion);
  if (!result.valid) throw new Error(`OZON 标题不符合内容合同: ${result.issues.join(', ')}`);
  return String(value ?? '');
}

function validateDescriptionHtml(value: string, issues: OzonTextPolicyIssue[]): void {
  const tags = value.match(HTML_TAGS_PATTERN) || [];
  if (/[<>]/u.test(value.replace(HTML_TAGS_PATTERN, ''))) issues.push('UNSUPPORTED_HTML');
  if (!tags.length) return;
  const stack: Array<'ul' | 'li'> = [];
  for (const tag of tags) {
    const normalized = tag.toLowerCase();
    if (/^<br\s*\/?>$/u.test(normalized)) continue;
    if (/^<ul\s*>$/u.test(normalized)) {
      if (stack.length && stack.at(-1) !== 'li') issues.push('UNBALANCED_HTML');
      stack.push('ul');
      continue;
    }
    if (/^<\/ul\s*>$/u.test(normalized)) {
      if (stack.pop() !== 'ul') issues.push('UNBALANCED_HTML');
      continue;
    }
    if (/^<li\s*>$/u.test(normalized)) {
      if (stack.at(-1) !== 'ul') issues.push('UNBALANCED_HTML');
      stack.push('li');
      continue;
    }
    if (/^<\/li\s*>$/u.test(normalized)) {
      if (stack.pop() !== 'li') issues.push('UNBALANCED_HTML');
      continue;
    }
    issues.push('UNSUPPORTED_HTML');
  }
  if (stack.length) issues.push('UNBALANCED_HTML');
}

function hasContactInformation(value: string): boolean {
  if (EMAIL_PATTERN.test(value) || CONTACT_HINT_PATTERN.test(value)) return true;
  return [...value.matchAll(PHONE_CANDIDATE_PATTERN)].some((candidate) => (
    candidate[0].startsWith('+') || (candidate[0].match(/\d/gu) || []).length >= 10
  ));
}

function eligibleKeywordWords(value: string): string[] {
  return value.toLocaleLowerCase('ru-RU').match(/[a-zа-яё]{4,}/giu) || [];
}

function hasTitleKeywordStuffing(value: string): boolean {
  const counts = new Map<string, number>();
  for (const word of eligibleKeywordWords(value)) {
    const count = (counts.get(word) || 0) + 1;
    if (count >= 3) return true;
    counts.set(word, count);
  }
  return false;
}

function hasDescriptionKeywordStuffing(value: string): boolean {
  const words = eligibleKeywordWords(value);
  const counts = new Map<string, number>();
  for (let index = 0; index < words.length; index += 1) {
    if (index >= 12) {
      const expired = words[index - 12]!;
      const remaining = (counts.get(expired) || 0) - 1;
      if (remaining > 0) counts.set(expired, remaining);
      else counts.delete(expired);
    }
    const word = words[index]!;
    const count = (counts.get(word) || 0) + 1;
    if (count >= 3) return true;
    counts.set(word, count);
  }
  return false;
}

export function assertOzonDescription(value: unknown, policyVersion: string = OZON_CONTENT_POLICY_VERSION): string {
  const result = validateOzonDescription(value, policyVersion);
  if (!result.valid) throw new Error(`OZON 商品详情不符合内容合同: ${result.issues.join(', ')}`);
  return result.normalizedForSubmission;
}
