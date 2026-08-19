import { createHash } from 'node:crypto';

const ALLOWED_TOP_LEVEL_KEYS = new Set(['id', 'name', 'active', 'nodes', 'connections', 'settings']);
const REMOVED_KEYS = /^(?:credentials?|webhookId)$/i;
const SENSITIVE_KEY = /(?:api[-_]?key|token|password|passwd|secret|authorization|auth[-_]?key|client[-_]?secret|access[-_]?key|private[-_]?key|cookie|session[-_]?key|encryption[-_]?key)/i;

const KNOWN_SECRET_PATTERNS = [
  { name: 'private-key', regex: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g },
  { name: 'bearer-token', regex: /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/gi },
  { name: 'openai-key', regex: /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}/g },
  { name: 'github-token', regex: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}/g },
  { name: 'aws-access-key', regex: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g },
  { name: 'google-api-key', regex: /\bAIza[0-9A-Za-z_-]{20,}/g },
];

function isSafeReference(value) {
  if (typeof value !== 'string') return false;
  const trimmed = value.trim();
  return (
    trimmed === '' ||
    trimmed === '__REDACTED__' ||
    /^=?\{\{[\s\S]*\}\}$/.test(trimmed) ||
    /^(?:Bearer\s+)?\{\{[\s\S]*\}\}$/i.test(trimmed) ||
    /^(?:Bearer\s+)?(?:process\.env|\$env)(?:\.[A-Za-z_][A-Za-z0-9_]*|\[['"][A-Za-z_][A-Za-z0-9_]*['"]\])$/i.test(trimmed) ||
    /^(?:YOUR_|CHANGE_ME|REPLACE_ME|EXAMPLE_|<[^>]+>)/i.test(trimmed)
  );
}

function recordRedaction(state, path, kind) {
  state.redactedLiterals += 1;
  state.redactionKinds[kind] = (state.redactionKinds[kind] || 0) + 1;
  state.redactionPaths.add(path);
}

function redactPattern(value, regex, replacement, state, path, kind) {
  let matched = false;
  const output = value.replace(regex, (...args) => {
    matched = true;
    return typeof replacement === 'function' ? replacement(...args) : replacement;
  });
  if (matched) recordRedaction(state, path, kind);
  return output;
}

function redactHighConfidenceLiterals(value, state, path) {
  if (isSafeReference(value)) return value;
  let output = value;

  output = redactPattern(
    output,
    /([a-z][a-z0-9+.-]*:\/\/)([^\s/:@]+):([^\s/@]+)@/gi,
    (_match, scheme) => `${scheme}__REDACTED__:__REDACTED__@`,
    state,
    path,
    'credential-url',
  );

  for (const pattern of KNOWN_SECRET_PATTERNS) {
    output = redactPattern(output, pattern.regex, '__REDACTED__', state, path, pattern.name);
  }

  output = redactPattern(
    output,
    /((?:api[-_]?key|access[-_]?token|refresh[-_]?token|password|passwd|client[-_]?secret|authorization|private[-_]?key|session[-_]?key)\s*[:=]\s*['"])([^'"\r\n]{6,})(['"])/gi,
    (_match, prefix, _secret, suffix) => `${prefix}__REDACTED__${suffix}`,
    state,
    path,
    'assigned-secret',
  );

  output = redactPattern(
    output,
    /([?&](?:api[-_]?key|access[-_]?token|refresh[-_]?token|token|password|secret)=)([^&#\s]{6,})/gi,
    (_match, prefix) => `${prefix}__REDACTED__`,
    state,
    path,
    'query-secret',
  );

  return output;
}

function sanitizeValue(value, path, state, key = '') {
  if (typeof value === 'string') {
    if (SENSITIVE_KEY.test(key) && !isSafeReference(value)) {
      recordRedaction(state, path, 'sensitive-field');
      return '__REDACTED__';
    }
    return redactHighConfidenceLiterals(value, state, path);
  }

  if (Array.isArray(value)) {
    return value.map((item, index) => sanitizeValue(item, `${path}[${index}]`, state));
  }

  if (!value || typeof value !== 'object') return value;

  const sensitiveNamedEntry = typeof value.name === 'string' && SENSITIVE_KEY.test(value.name);
  const output = {};

  for (const [childKey, childValue] of Object.entries(value)) {
    const childPath = path ? `${path}.${childKey}` : childKey;
    if (REMOVED_KEYS.test(childKey)) {
      if (/^credentials?$/i.test(childKey)) state.removedCredentialBindings += 1;
      else state.removedWebhookIds += 1;
      continue;
    }
    if (sensitiveNamedEntry && /^(?:value|headerValue)$/i.test(childKey) && typeof childValue === 'string' && !isSafeReference(childValue)) {
      recordRedaction(state, childPath, 'named-sensitive-field');
      output[childKey] = '__REDACTED__';
      continue;
    }
    output[childKey] = sanitizeValue(childValue, childPath, state, childKey);
  }

  return output;
}

export function sanitizeWorkflow(rawWorkflow, catalogEntry) {
  if (!rawWorkflow || typeof rawWorkflow !== 'object') throw new Error(`工作流 ${catalogEntry.id} 的 API 响应无效`);
  if (rawWorkflow.id !== catalogEntry.id) throw new Error(`工作流 ID 不匹配：期望 ${catalogEntry.id}`);
  if (!Array.isArray(rawWorkflow.nodes) || !rawWorkflow.connections || typeof rawWorkflow.connections !== 'object') {
    throw new Error(`工作流 ${catalogEntry.id} 缺少 nodes 或 connections`);
  }

  const state = {
    removedCredentialBindings: 0,
    removedWebhookIds: 0,
    redactedLiterals: 0,
    redactionKinds: {},
    redactionPaths: new Set(),
  };

  const workflow = {
    id: rawWorkflow.id,
    name: String(rawWorkflow.name || catalogEntry.label),
    active: Boolean(rawWorkflow.active),
    nodes: sanitizeValue(rawWorkflow.nodes, 'nodes', state),
    connections: sanitizeValue(rawWorkflow.connections, 'connections', state),
    settings: sanitizeValue(rawWorkflow.settings || {}, 'settings', state),
  };

  const findings = findUnsafeWorkflowContent(workflow);
  if (findings.length > 0) {
    throw new Error(`工作流 ${catalogEntry.id} 脱敏后仍有风险：${findings.slice(0, 5).join('; ')}`);
  }

  return {
    workflow,
    report: {
      removedCredentialBindings: state.removedCredentialBindings,
      removedWebhookIds: state.removedWebhookIds,
      redactedLiterals: state.redactedLiterals,
      redactionKinds: Object.fromEntries(Object.entries(state.redactionKinds).sort(([a], [b]) => a.localeCompare(b))),
      redactionPathCount: state.redactionPaths.size,
    },
  };
}

function inspectValue(value, path, findings, key = '') {
  if (typeof value === 'string') {
    if (SENSITIVE_KEY.test(key) && !isSafeReference(value)) findings.push(`${path}: 敏感字段仍含字面值`);
    if (isSafeReference(value)) return;
    if (/([a-z][a-z0-9+.-]*:\/\/)([^\s/:@]+):([^\s/@]+)@/i.test(value)) findings.push(`${path}: URL 含用户名和密码`);
    for (const pattern of KNOWN_SECRET_PATTERNS) {
      pattern.regex.lastIndex = 0;
      if (pattern.regex.test(value)) findings.push(`${path}: 命中 ${pattern.name}`);
      pattern.regex.lastIndex = 0;
    }
    if (/((?:api[-_]?key|access[-_]?token|refresh[-_]?token|password|passwd|client[-_]?secret|authorization|private[-_]?key|session[-_]?key)\s*[:=]\s*['"])(?!__REDACTED__)([^'"\r\n]{6,})(['"])/i.test(value)) {
      findings.push(`${path}: 代码中疑似硬编码密钥`);
    }
    if (/[?&](?:api[-_]?key|access[-_]?token|refresh[-_]?token|token|password|secret)=(?!__REDACTED__)[^&#\s]{6,}/i.test(value)) {
      findings.push(`${path}: URL 查询参数疑似含密钥`);
    }
    return;
  }

  if (Array.isArray(value)) {
    value.forEach((item, index) => inspectValue(item, `${path}[${index}]`, findings));
    return;
  }

  if (!value || typeof value !== 'object') return;
  const sensitiveNamedEntry = typeof value.name === 'string' && SENSITIVE_KEY.test(value.name);
  for (const [childKey, childValue] of Object.entries(value)) {
    const childPath = path ? `${path}.${childKey}` : childKey;
    if (REMOVED_KEYS.test(childKey)) findings.push(`${childPath}: 禁止字段仍存在`);
    if (sensitiveNamedEntry && /^(?:value|headerValue)$/i.test(childKey) && typeof childValue === 'string' && !isSafeReference(childValue)) {
      findings.push(`${childPath}: 敏感请求字段仍含字面值`);
    }
    inspectValue(childValue, childPath, findings, childKey);
  }
}

export function findUnsafeWorkflowContent(workflow) {
  const findings = [];
  inspectValue(workflow, '', findings);
  return [...new Set(findings)];
}

export function validateWorkflowShape(workflow, expectedId) {
  const findings = [];
  if (!workflow || typeof workflow !== 'object' || Array.isArray(workflow)) return ['根节点不是对象'];
  for (const key of Object.keys(workflow)) {
    if (!ALLOWED_TOP_LEVEL_KEYS.has(key)) findings.push(`禁止的顶层字段：${key}`);
  }
  for (const key of ALLOWED_TOP_LEVEL_KEYS) {
    if (!(key in workflow)) findings.push(`缺少顶层字段：${key}`);
  }
  if (workflow.id !== expectedId) findings.push(`ID 不匹配：${workflow.id || '(missing)'}`);
  if (!Array.isArray(workflow.nodes)) findings.push('nodes 不是数组');
  if (!workflow.connections || typeof workflow.connections !== 'object' || Array.isArray(workflow.connections)) findings.push('connections 不是对象');
  if (!workflow.settings || typeof workflow.settings !== 'object' || Array.isArray(workflow.settings)) findings.push('settings 不是对象');
  return [...findings, ...findUnsafeWorkflowContent(workflow)];
}

export function collectWorkflowDependencies(workflow, knownIds) {
  const found = new Set();
  const visit = (value) => {
    if (typeof value === 'string') {
      if (knownIds.has(value) && value !== workflow.id) found.add(value);
      return;
    }
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    if (value && typeof value === 'object') Object.values(value).forEach(visit);
  };
  visit(workflow);
  return [...found].sort();
}

export function sha256(content) {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}
