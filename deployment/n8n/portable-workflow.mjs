const TEMPLATE_REPLACEMENTS = [
  ['G:/AI_Program_Files/codex-data/n8n_Project', '__MERCHROUTE_N8N_RUNTIME_DIR__'],
  ['G:\\AI_Program_Files\\codex-data\\n8n_Project', '__MERCHROUTE_N8N_RUNTIME_DIR__'],
  ['G:/01_MerchRoute', '__MERCHROUTE_DATA_ROOT__'],
  ['G:\\01_MerchRoute', '__MERCHROUTE_DATA_ROOT__'],
  ['G:/01_n8n-global', '__MERCHROUTE_DATA_ROOT__'],
  ['G:\\01_n8n-global', '__MERCHROUTE_DATA_ROOT__'],
  ['D:/n8n-browser-profile', '__MERCHROUTE_BROWSER_PROFILE_ROOT__'],
  ['D:\\n8n-browser-profile', '__MERCHROUTE_BROWSER_PROFILE_ROOT__'],
  ['C:/Program Files/Google/Chrome/Application/chrome.exe', '__MERCHROUTE_BROWSER_EXECUTABLE__'],
  ['C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', '__MERCHROUTE_BROWSER_EXECUTABLE__'],
  ['C:/Windows/Temp', '__MERCHROUTE_TEMP_DIR__'],
  ['C:\\Windows\\Temp', '__MERCHROUTE_TEMP_DIR__'],
];

const LEGACY_POSIX_SH_QUOTE = String.raw`text.replace(/'/g, "'\''")`;
const PORTABLE_POSIX_SH_QUOTE = String.raw`text.replace(/'/g, "'\"'\"'")`;

export const WORKFLOW_TEMPLATE_KEYS = Object.freeze([
  'MERCHROUTE_N8N_RUNTIME_DIR',
  'MERCHROUTE_DATA_ROOT',
  'MERCHROUTE_BROWSER_PROFILE_ROOT',
  'MERCHROUTE_BROWSER_EXECUTABLE',
  'MERCHROUTE_TEMP_DIR',
]);

function replaceStrings(value, replacements) {
  if (typeof value === 'string') {
    return replacements.reduce((result, [from, to]) => result.replaceAll(from, to), value);
  }
  if (Array.isArray(value)) return value.map((item) => replaceStrings(item, replacements));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, replaceStrings(item, replacements)]));
  }
  return value;
}

function escapeSingleQuotedJavaScript(value) {
  return String(value)
    .replaceAll('\\', '\\\\')
    .replaceAll("'", "\\'")
    .replaceAll('\r', '\\r')
    .replaceAll('\n', '\\n')
    .replaceAll('\u2028', '\\u2028')
    .replaceAll('\u2029', '\\u2029');
}

function materializeStrings(value, replacements, parentKey = '') {
  if (typeof value === 'string') {
    return replacements.reduce((result, [from, to]) => {
      const replacement = parentKey === 'jsCode' ? escapeSingleQuotedJavaScript(to) : to;
      return result.replaceAll(from, replacement);
    }, value);
  }
  if (Array.isArray(value)) return value.map((item) => materializeStrings(item, replacements, parentKey));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, materializeStrings(item, replacements, key)]));
  }
  return value;
}

function isStandalonePathTemplate(value) {
  return /^__MERCHROUTE_[A-Z0-9_]+__(?:[\\/][^\r\n]*)?$/.test(value);
}

function normalizeStandalonePathTemplates(value) {
  if (typeof value === 'string') {
    return isStandalonePathTemplate(value) ? value.replaceAll('\\', '/') : value;
  }
  if (Array.isArray(value)) return value.map((item) => normalizeStandalonePathTemplates(item));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, normalizeStandalonePathTemplates(item)]));
  }
  return value;
}

export function normalizeWorkflowCodeContracts(value, parentKey = '') {
  if (typeof value === 'string') {
    return parentKey === 'jsCode'
      ? value.replaceAll(LEGACY_POSIX_SH_QUOTE, PORTABLE_POSIX_SH_QUOTE)
      : value;
  }
  if (Array.isArray(value)) return value.map((item) => normalizeWorkflowCodeContracts(item));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [
      key,
      normalizeWorkflowCodeContracts(item, key),
    ]));
  }
  return value;
}

export function makeWorkflowPortable(workflow) {
  return normalizeWorkflowCodeContracts(
    normalizeStandalonePathTemplates(replaceStrings(workflow, TEMPLATE_REPLACEMENTS)),
  );
}

export function materializeWorkflow(workflow, runtimeValues) {
  const missing = WORKFLOW_TEMPLATE_KEYS.filter((key) => !String(runtimeValues[key] || '').trim());
  if (missing.length) throw new Error(`缺少工作流跨平台路径：${missing.join(', ')}`);
  const replacements = WORKFLOW_TEMPLATE_KEYS.map((key) => [
    `__${key}__`,
    String(runtimeValues[key]).replaceAll('\\', '/').replace(/\/$/, ''),
  ]);
  // Only standalone path-template values are normalized. Code, expressions,
  // regular expressions and documentation retain their original escaping.
  // jsCode placeholders are known single-quoted string literals and therefore
  // receive JavaScript-literal escaping without touching unrelated code.
  const materialized = normalizeWorkflowCodeContracts(
    materializeStrings(normalizeStandalonePathTemplates(workflow), replacements),
  );
  const serialized = JSON.stringify(materialized);
  const unresolved = serialized.match(/__MERCHROUTE_[A-Z0-9_]+__/g);
  if (unresolved) throw new Error(`工作流仍含未解析路径占位符：${[...new Set(unresolved)].join(', ')}`);
  return materialized;
}

export function findLegacyRuntimePaths(workflow) {
  const serialized = JSON.stringify(workflow);
  return TEMPLATE_REPLACEMENTS
    .map(([legacy]) => legacy)
    .filter((legacy) => serialized.includes(legacy));
}
