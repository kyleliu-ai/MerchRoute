import { createHash } from 'node:crypto';

export const CREDENTIAL_DEFINITIONS = Object.freeze({
  'jimeng-session': {
    credentialId: 'mrJimengSession01',
    type: 'httpBearerAuth',
    displayName: 'MerchRoute / Jimeng session',
    fields: [{ name: 'token', required: true, secret: true, description: '即梦 sessionid；不要添加 Bearer 前缀' }],
    probe: { kind: 'jimeng-token-check', method: 'POST', url: 'http://127.0.0.1:8000/token/check', sideEffect: 'none' },
  },
  'siliconflow-api': {
    credentialId: 'mrSiliconFlow01',
    type: 'httpBearerAuth',
    displayName: 'MerchRoute / SiliconFlow API',
    fields: [{ name: 'token', required: true, secret: true, description: 'SiliconFlow API Key' }],
    probe: { kind: 'bearer-model-list', method: 'GET', url: 'https://api.siliconflow.cn/v1/models', sideEffect: 'none' },
  },
  'qwen-runtime': {
    credentialId: 'mrQwenRuntime001',
    type: 'globalConstantsApi',
    displayName: 'MerchRoute / Qwen runtime',
    fields: [
      { name: 'model', required: true, secret: false, description: 'OpenAI 兼容模型名' },
      { name: 'baseUrl', required: true, secret: false, description: 'OpenAI 兼容 chat/completions URL' },
      { name: 'apiKey', required: true, secret: true, description: '模型服务 API Key' },
    ],
    probe: { kind: 'openai-compatible-model-list', method: 'GET', sideEffect: 'none' },
  },
  'merchroute-runtime': {
    credentialId: 'mrRuntimeKey0001',
    type: 'httpHeaderAuth',
    displayName: 'MerchRoute / Runtime API',
    fields: [{ name: 'runtimeKey', required: true, secret: true, generated: true, description: '从 MERCHROUTE_RUNTIME_KEY 自动读取' }],
    probe: { kind: 'merchroute-runtime-read', method: 'GET', url: 'http://127.0.0.1:4173/api/v1/wb/runtime/config', sideEffect: 'none' },
  },
  'wb-seller-api': {
    credentialId: 'mrWbSellerApi001',
    type: 'httpHeaderAuth',
    displayName: 'MerchRoute / WB Seller API',
    fields: [{ name: 'token', required: true, secret: true, description: 'Wildberries Seller API Token' }],
    probe: { kind: 'wb-parent-categories', method: 'GET', url: 'https://content-api.wildberries.ru/content/v2/object/parent/all', sideEffect: 'none' },
  },
  'ozon-seller-api': {
    credentialId: 'mrOzonSeller001',
    type: 'httpCustomAuth',
    displayName: 'MerchRoute / OZON Seller API',
    fields: [
      { name: 'clientId', required: true, secret: true, description: 'OZON Client-Id' },
      { name: 'apiKey', required: true, secret: true, description: 'OZON Api-Key' },
    ],
    probe: { kind: 'ozon-category-tree', method: 'POST', url: 'https://api-seller.ozon.ru/v1/description-category/tree', sideEffect: 'none' },
  },
});

function classifyBinding(type, workflowId, nodeName) {
  if (type === 'globalConstantsApi') return 'qwen-runtime';
  if (type === 'httpCustomAuth' && workflowId === '3hyAiON1l3fEHBzA') return 'ozon-seller-api';
  if (type === 'httpBearerAuth') {
    if (['Wxng7hVbjMNhVOaO', 'HpCtxAZJdy9RgWk2', 'ieWnRGeC7KdeS1GT'].includes(workflowId)) return 'jimeng-session';
    if (['5fKlIwJWfXJM1y4E', 'JEl0xCKTgtiIP9UT', 'uKkH5O0dpfzFuAag'].includes(workflowId)) return 'siliconflow-api';
  }
  if (type === 'httpHeaderAuth') {
    if (/^WB (?:Search|Get|List|Probe|Read|Check|JSON|Media)/i.test(nodeName)) return 'wb-seller-api';
    return 'merchroute-runtime';
  }
  throw new Error(`未识别凭据绑定：${workflowId}/${nodeName}/${type}`);
}

export function buildCredentialRequirements(rawWorkflows) {
  const opaqueGroups = new Map();
  const bindings = [];

  for (const workflow of rawWorkflows) {
    for (const node of workflow.nodes || []) {
      for (const [credentialType, reference] of Object.entries(node.credentials || {})) {
        const logicalAlias = classifyBinding(credentialType, workflow.id, String(node.name || node.id || 'unnamed'));
        const definition = CREDENTIAL_DEFINITIONS[logicalAlias];
        if (definition.type !== credentialType) throw new Error(`${logicalAlias} 的凭据类型不一致`);
        const opaqueKey = `${credentialType}:${String(reference?.id || reference?.name || `${workflow.id}:${node.id}`)}`;
        const previousAlias = opaqueGroups.get(opaqueKey);
        if (previousAlias && previousAlias !== logicalAlias) throw new Error(`同一现有凭据被分类为 ${previousAlias} 与 ${logicalAlias}`);
        opaqueGroups.set(opaqueKey, logicalAlias);
        bindings.push({
          workflowId: workflow.id,
          nodeName: String(node.name || node.id || 'unnamed'),
          credentialType,
          logicalAlias,
        });
      }
    }
  }

  const requiredAliases = [...new Set(bindings.map((binding) => binding.logicalAlias))].sort();
  for (const alias of Object.keys(CREDENTIAL_DEFINITIONS)) {
    if (!requiredAliases.includes(alias)) throw new Error(`实时工作流未使用预期凭据 ${alias}`);
  }

  return {
    schemaVersion: 1,
    source: 'live-n8n-bindings-with-identifiers-removed',
    communityNodes: [{ package: 'n8n-nodes-globals', version: '1.1.0', credentialType: 'globalConstantsApi' }],
    requirements: requiredAliases.map((logicalAlias) => ({ logicalAlias, ...CREDENTIAL_DEFINITIONS[logicalAlias] })),
    bindings: bindings.sort((a, b) => `${a.workflowId}:${a.nodeName}:${a.credentialType}`.localeCompare(`${b.workflowId}:${b.nodeName}:${b.credentialType}`)),
  };
}

export function credentialRequirementsHash(requirements) {
  return createHash('sha256').update(JSON.stringify(requirements), 'utf8').digest('hex');
}

export function buildCredentialImportData(input, runtimeKey) {
  const credentials = input?.credentials || {};
  const requireValue = (alias, field, fallback = '') => {
    const configured = String(credentials[alias]?.[field] ?? '').trim();
    const value = configured || String(fallback).trim();
    if (!value) throw new Error(`缺少 credentials.${alias}.${field}`);
    return value;
  };
  const qwenBaseUrl = requireValue('qwen-runtime', 'baseUrl');
  const qwenApiKey = requireValue('qwen-runtime', 'apiKey').replace(/^Bearer\s+/i, '').trim();
  if (!qwenApiKey) throw new Error('缺少 credentials.qwen-runtime.apiKey');
  return {
    'jimeng-session': { token: requireValue('jimeng-session', 'token') },
    'siliconflow-api': { token: requireValue('siliconflow-api', 'token') },
    'qwen-runtime': {
      format: 'json',
      globalConstants: JSON.stringify({
        model: { Model_Run: requireValue('qwen-runtime', 'model') },
        BaseUrl: { BaseUrl_Run: qwenBaseUrl },
        Authorization: { APIKey_Run: `Bearer ${qwenApiKey}` },
      }),
    },
    'merchroute-runtime': { name: 'X-MerchRoute-Runtime-Key', value: requireValue('merchroute-runtime', 'runtimeKey', runtimeKey) },
    'wb-seller-api': { name: 'Authorization', value: requireValue('wb-seller-api', 'token') },
    'ozon-seller-api': {
      json: JSON.stringify({ headers: {
        'Client-Id': requireValue('ozon-seller-api', 'clientId'),
        'Api-Key': requireValue('ozon-seller-api', 'apiKey'),
      } }),
    },
  };
}
