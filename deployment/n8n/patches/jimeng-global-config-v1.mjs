import assert from 'node:assert/strict';

export const JIMENG_GLOBAL_CONFIG_TARGETS = Object.freeze({
  Wxng7hVbjMNhVOaO: {
    globalNodeId: 'b1fd5c56-b210-4f0d-88e9-8cf7afaf5cfc',
    source: 'Resolve Product Parameters',
    target: 'setParameter',
    httpEndpoints: {
      'Generate Cutout Image': '/v1/images/generations',
      'Generate Cutout Image Retry Once': '/v1/images/generations',
    },
  },
  HpCtxAZJdy9RgWk2: {
    globalNodeId: '11d281cd-f5de-4061-ad5a-ac24e0eea9cd',
    source: 'Parse Product Folder',
    target: 'setParameter',
    httpEndpoints: {
      'Submit View Tasks Async': '/v1/images/tasks/batch',
      'Check View Tasks Status': '/v1/images/tasks/status',
      'Submit Explicit Retry Tasks': '/v1/images/tasks/batch',
      'Check Retry Tasks Status': '/v1/images/tasks/status',
    },
  },
  ieWnRGeC7KdeS1GT: {
    globalNodeId: '0d9789cb-eb12-4a72-bff1-d4d1681825b3',
    source: 'ExecutedbyWorkflow',
    target: 'Normalize Batch Or Single Input',
    httpEndpoints: {
      'Submit Image Tasks Async': '/v1/images/tasks/batch',
      'Check Initial Tasks Status': '/v1/images/tasks/status',
      'Submit Explicit Retry Tasks': '/v1/images/tasks/batch',
      'Check Retry Tasks Status': '/v1/images/tasks/status',
    },
  },
});

const clone = (value) => structuredClone(value);

function requiredText(value, field) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text) throw new Error(`CONFIG_INVALID: Global Constants 缺少 ${field}`);
  return text;
}

export function validateJimengConstants(constants) {
  const jimengModel = requiredText(constants?.model?.jimengModel, 'constants.model.jimengModel');
  const rawUrl = requiredText(constants?.BaseUrl?.JimengUrl, 'constants.BaseUrl.JimengUrl');
  const jimengAuthorValue = requiredText(
    constants?.Authorization?.jimengAuthorValue,
    'constants.Authorization.jimengAuthorValue',
  );
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error('CONFIG_INVALID: constants.BaseUrl.JimengUrl 必须是合法的 HTTP(S) 服务根地址');
  }
  if (!['http:', 'https:'].includes(parsed.protocol)
    || !parsed.hostname
    || parsed.username
    || parsed.password
    || !['', '/'].includes(parsed.pathname)
    || parsed.search
    || parsed.hash) {
    throw new Error('CONFIG_INVALID: constants.BaseUrl.JimengUrl 必须是合法的 HTTP(S) 服务根地址');
  }
  return {
    jimengModel,
    jimengUrl: rawUrl.replace(/\/+$/, ''),
    jimengAuthorValue,
  };
}

export function jimengEndpoint(constants, endpoint) {
  assert.match(endpoint, /^\/v1\/images\/(?:generations|tasks\/(?:batch|status))$/);
  return validateJimengConstants(constants).jimengUrl + endpoint;
}

function requireNode(workflow, name) {
  const node = workflow.nodes.find((candidate) => candidate.name === name);
  if (!node) throw new Error(`${workflow.id} 缺少节点 ${name}`);
  return node;
}

function replaceExact(code, find, replacement, label) {
  const occurrences = code.split(find).length - 1;
  if (occurrences !== 1) throw new Error(`${label} 预期匹配 1 次，实际 ${occurrences} 次`);
  return code.replace(find, replacement);
}

function addGlobalConstantsNode(workflow, template, definition) {
  if (workflow.nodes.some((node) => node.name === 'Global Constants')) {
    throw new Error(`${workflow.id} 已存在 Global Constants，拒绝重复插入`);
  }
  const source = requireNode(workflow, definition.source);
  const target = requireNode(workflow, definition.target);
  const sourceEdges = workflow.connections?.[definition.source]?.main?.[0];
  if (!Array.isArray(sourceEdges)
    || sourceEdges.length !== 1
    || sourceEdges[0].node !== definition.target
    || sourceEdges[0].index !== 0) {
    throw new Error(`${workflow.id} ${definition.source} → ${definition.target} 连接发生漂移`);
  }
  const node = {
    parameters: clone(template.parameters || {}),
    type: template.type,
    typeVersion: template.typeVersion,
    position: [
      Math.round((Number(source.position?.[0]) + Number(target.position?.[0])) / 2),
      Math.round((Number(source.position?.[1]) + Number(target.position?.[1])) / 2),
    ],
    id: definition.globalNodeId,
    name: 'Global Constants',
    credentials: clone(template.credentials),
  };
  assert.equal(node.type, 'n8n-nodes-globals.globalConstants');
  assert.equal(node.credentials?.globalConstantsApi?.name, 'modelProvider');
  workflow.nodes.push(node);
  sourceEdges[0] = { node: 'Global Constants', type: 'main', index: 0 };
  workflow.connections['Global Constants'] = {
    main: [[{ node: definition.target, type: 'main', index: 0 }]],
  };
}

function addSetAssignment(node, assignment) {
  const assignments = node.parameters?.assignments?.assignments;
  if (!Array.isArray(assignments)) throw new Error(`${node.name} assignments 结构无效`);
  if (assignments.some((item) => item.name === assignment.name)) {
    throw new Error(`${node.name} 已存在字段 ${assignment.name}`);
  }
  assignments.push(assignment);
}

function setAssignmentValue(node, name, value) {
  const assignment = node.parameters?.assignments?.assignments?.find((item) => item.name === name);
  if (!assignment) throw new Error(`${node.name} 缺少字段 ${name}`);
  assignment.value = value;
}

function patchHttpNode(node, endpoint) {
  node.parameters.url = `={{ String($json.constants.BaseUrl.JimengUrl).trim().replace(/\\/+$/, '') + '${endpoint}' }}`;
  node.parameters.authentication = 'none';
  delete node.parameters.genericAuthType;
  node.parameters.sendHeaders = true;
  const headers = node.parameters.headerParameters?.parameters;
  if (!Array.isArray(headers)) throw new Error(`${node.name} headerParameters 结构无效`);
  const authorization = headers.find((header) => String(header.name).toLowerCase() === 'authorization');
  if (authorization) authorization.value = '={{ $json.constants.Authorization.jimengAuthorValue }}';
  else headers.push({ name: 'Authorization', value: '={{ $json.constants.Authorization.jimengAuthorValue }}' });
  if (node.credentials?.httpBearerAuth) delete node.credentials.httpBearerAuth;
  if (node.credentials && Object.keys(node.credentials).length === 0) delete node.credentials;
}

const LEGACY_RUNTIME_URL_VALIDATION = `let parsedJimengUrl;
try { parsedJimengUrl = new URL(jimengUrl); } catch (error) {
  throw new Error('CONFIG_INVALID: constants.BaseUrl.JimengUrl 必须是合法的 HTTP(S) 服务根地址');
}
if (!['http:', 'https:'].includes(parsedJimengUrl.protocol) || !parsedJimengUrl.hostname || !['', '/'].includes(parsedJimengUrl.pathname) || parsedJimengUrl.search || parsedJimengUrl.hash) {
  throw new Error('CONFIG_INVALID: constants.BaseUrl.JimengUrl 必须是合法的 HTTP(S) 服务根地址');
}`;

const RUNTIME_URL_VALIDATION = `const jimengUrlMatch = /^(https?):\\/\\/(\\[[0-9a-f:.]+\\]|[a-z0-9.-]+)(?::([0-9]{1,5}))?\\/?$/i.exec(jimengUrl);
const jimengPort = jimengUrlMatch?.[3] ? Number(jimengUrlMatch[3]) : null;
if (!jimengUrlMatch || (jimengPort !== null && (jimengPort < 1 || jimengPort > 65535))) {
  throw new Error('CONFIG_INVALID: constants.BaseUrl.JimengUrl 必须是合法的 HTTP(S) 服务根地址');
}`;

const VALIDATE_INPUT_CONSTANTS = `const constants = input.constants;
function requireConstant(value, field) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text) throw new Error('CONFIG_INVALID: Global Constants 缺少 ' + field);
  return text;
}
const jimengModel = requireConstant(constants?.model?.jimengModel, 'constants.model.jimengModel');
const jimengUrl = requireConstant(constants?.BaseUrl?.JimengUrl, 'constants.BaseUrl.JimengUrl');
requireConstant(constants?.Authorization?.jimengAuthorValue, 'constants.Authorization.jimengAuthorValue');
${RUNTIME_URL_VALIDATION}`;

const VALIDATE_ROOT_CONSTANTS = VALIDATE_INPUT_CONSTANTS.replaceAll('input.constants', 'root.constants');

function migrateRuntimeUrlValidation(workflow) {
  const nodeName = workflow.id === 'Wxng7hVbjMNhVOaO'
    ? 'Build Jimeng Tasks'
    : workflow.id === 'HpCtxAZJdy9RgWk2'
      ? 'Build View Tasks'
      : 'Normalize Batch Or Single Input';
  const node = requireNode(workflow, nodeName);
  const code = node.parameters?.jsCode;
  if (typeof code !== 'string') throw new Error(`${workflow.id}/${nodeName} jsCode 无效`);
  if (code.includes(LEGACY_RUNTIME_URL_VALIDATION)) {
    node.parameters.jsCode = replaceExact(
      code,
      LEGACY_RUNTIME_URL_VALIDATION,
      RUNTIME_URL_VALIDATION,
      `${workflow.id}/${nodeName} URL 运行时校验`,
    );
  } else if (!code.includes(RUNTIME_URL_VALIDATION)) {
    throw new Error(`${workflow.id}/${nodeName} URL 运行时校验发生漂移`);
  }
}

function addPollingConstants(node, find, replacement, marker, label) {
  const code = node.parameters?.jsCode;
  if (typeof code !== 'string') throw new Error(`${label} jsCode 无效`);
  if (code.includes(marker)) return;
  node.parameters.jsCode = replaceExact(code, find, replacement, label);
}

function migratePollingConstants(workflow) {
  if (workflow.id === 'HpCtxAZJdy9RgWk2') {
    addPollingConstants(
      requireNode(workflow, 'Evaluate View Tasks'),
      `return [{ json: {
  ...input,
  phase: 'initial',`,
      `return [{ json: {
  ...input,
  constants: $('Build Async Submit Batch').first().json.constants,
  phase: 'initial',`,
      `constants: $('Build Async Submit Batch').first().json.constants,`,
      `${workflow.id}/Evaluate View Tasks constants`,
    );
    addPollingConstants(
      requireNode(workflow, 'Evaluate Retry Tasks'),
      `return [{ json: {
  ...input,
  phase: 'retry',`,
      `return [{ json: {
  ...input,
  constants: retryPlan.constants,
  phase: 'retry',`,
      'constants: retryPlan.constants,',
      `${workflow.id}/Evaluate Retry Tasks constants`,
    );
  } else if (workflow.id === 'ieWnRGeC7KdeS1GT') {
    addPollingConstants(
      requireNode(workflow, 'Evaluate Initial Tasks'),
      `return [{ json: {
  ...carriedState,
  ok: true,`,
      `return [{ json: {
  ...carriedState,
  constants: batch.constants,
  ok: true,`,
      'constants: batch.constants,',
      `${workflow.id}/Evaluate Initial Tasks constants`,
    );
    addPollingConstants(
      requireNode(workflow, 'Evaluate Retry Tasks'),
      `return [{ json: {
  ...carriedState,
  ok: true,`,
      `return [{ json: {
  ...carriedState,
  constants: retryBatch.constants,
  ok: true,`,
      'constants: retryBatch.constants,',
      `${workflow.id}/Evaluate Retry Tasks constants`,
    );
  }
}

function patchE001(workflow, template) {
  const definition = JIMENG_GLOBAL_CONFIG_TARGETS[workflow.id];
  addGlobalConstantsNode(workflow, template, definition);
  setAssignmentValue(requireNode(workflow, 'setParameter'), 'model', '={{ $json.constants.model.jimengModel }}');

  const builder = requireNode(workflow, 'Build Jimeng Tasks');
  builder.parameters.jsCode = replaceExact(
    builder.parameters.jsCode,
    `const concurrent = Math.max(1, Math.floor(Number(input.concurrent || 8)));
const modelInput = String(input.model || '即梦4.5').trim();
const modelApiName = modelInput === '即梦4.5' ? 'jimeng-4.5' : modelInput;
const basePrompt = String(input.prompt || '').trim();`,
    `const concurrent = Math.max(1, Math.floor(Number(input.concurrent || 8)));
${VALIDATE_INPUT_CONSTANTS}
const basePrompt = String(input.prompt || '').trim();`,
    `${workflow.id}/Build Jimeng Tasks 模型配置`,
  );
  builder.parameters.jsCode = replaceExact(
    builder.parameters.jsCode,
    '      modelApiName,\n',
    '',
    `${workflow.id}/Build Jimeng Tasks modelApiName 输出`,
  );

  for (const [name, endpoint] of Object.entries(definition.httpEndpoints)) {
    const node = requireNode(workflow, name);
    patchHttpNode(node, endpoint);
    node.parameters.jsonBody = node.parameters.jsonBody.replace('$json.modelApiName', '$json.constants.model.jimengModel');
  }
}

function patchE002(workflow, template) {
  const definition = JIMENG_GLOBAL_CONFIG_TARGETS[workflow.id];
  addGlobalConstantsNode(workflow, template, definition);
  const setNode = requireNode(workflow, 'setParameter');
  setAssignmentValue(setNode, 'model', '={{ $json.constants.model.jimengModel }}');
  addSetAssignment(setNode, {
    id: 'merchroute-jimeng-global-constants-e002',
    name: 'constants',
    value: '={{ $json.constants }}',
    type: 'object',
  });

  const taskBuilder = requireNode(workflow, 'Build View Tasks');
  taskBuilder.parameters.jsCode = replaceExact(
    taskBuilder.parameters.jsCode,
    `const modelInput = String(input.model || '即梦4.5').trim();
const modelApiName = modelInput === '即梦4.5' ? 'jimeng-4.5' : modelInput;
const folderPath =`,
    `${VALIDATE_INPUT_CONSTANTS}
const folderPath =`,
    `${workflow.id}/Build View Tasks 模型配置`,
  );
  taskBuilder.parameters.jsCode = replaceExact(
    taskBuilder.parameters.jsCode,
    '    modelApiName,\n',
    '',
    `${workflow.id}/Build View Tasks modelApiName 输出`,
  );

  const batchBuilder = requireNode(workflow, 'Build Async Submit Batch');
  batchBuilder.parameters.jsCode = replaceExact(
    batchBuilder.parameters.jsCode,
    `return [{ json: {
  batchKey,`,
    `return [{ json: {
  constants: first.constants,
  batchKey,`,
    `${workflow.id}/Build Async Submit Batch constants`,
  );
  batchBuilder.parameters.jsCode = replaceExact(
    batchBuilder.parameters.jsCode,
    `    model: String(first.modelApiName || ''),`,
    `    model: String(first.constants?.model?.jimengModel || ''),`,
    `${workflow.id}/Build Async Submit Batch model`,
  );

  const initial = requireNode(workflow, 'Initialize View Polling');
  initial.parameters.jsCode = replaceExact(
    initial.parameters.jsCode,
    `  ...response,
  batchKey: batch.batchKey,`,
    `  ...response,
  constants: batch.constants,
  batchKey: batch.batchKey,`,
    `${workflow.id}/Initialize View Polling constants`,
  );
  const retryBuilder = requireNode(workflow, 'Build Explicit Retry Batch');
  retryBuilder.parameters.jsCode = replaceExact(
    retryBuilder.parameters.jsCode,
    `return [{ json: {
  firstResults,`,
    `return [{ json: {
  constants: sourceBatch.constants,
  firstResults,`,
    `${workflow.id}/Build Explicit Retry Batch constants`,
  );
  const retryInitial = requireNode(workflow, 'Initialize Retry Polling');
  retryInitial.parameters.jsCode = replaceExact(
    retryInitial.parameters.jsCode,
    `  ...response,
  batchKey: retryBatch.batchKey,`,
    `  ...response,
  constants: retryBatch.constants,
  batchKey: retryBatch.batchKey,`,
    `${workflow.id}/Initialize Retry Polling constants`,
  );

  for (const [name, endpoint] of Object.entries(definition.httpEndpoints)) {
    patchHttpNode(requireNode(workflow, name), endpoint);
  }
}

function patchS003(workflow, template) {
  const definition = JIMENG_GLOBAL_CONFIG_TARGETS[workflow.id];
  addGlobalConstantsNode(workflow, template, definition);

  const normalizer = requireNode(workflow, 'Normalize Batch Or Single Input');
  normalizer.parameters.jsCode = replaceExact(
    normalizer.parameters.jsCode,
    `const root = $input.first()?.json || {};
const sourceItems =`,
    `const root = $input.first()?.json || {};
${VALIDATE_ROOT_CONSTANTS}
const sourceItems =`,
    `${workflow.id}/Normalize Batch constants validation`,
  );
  normalizer.parameters.jsCode = replaceExact(
    normalizer.parameters.jsCode,
    `const rootModel = pick(root, ['model'], 'jimeng-4.5');`,
    `const rootModel = jimengModel;`,
    `${workflow.id}/Normalize Batch model`,
  );
  normalizer.parameters.jsCode = replaceExact(
    normalizer.parameters.jsCode,
    `      ...task,
      originalIndex,`,
    `      ...task,
      constants: root.constants,
      originalIndex,`,
    `${workflow.id}/Normalize Batch constants output`,
  );
  normalizer.parameters.jsCode = replaceExact(
    normalizer.parameters.jsCode,
    `      model: pick(task, ['model'], rootModel),`,
    `      model: rootModel,`,
    `${workflow.id}/Normalize Batch task model`,
  );

  const prepareImages = requireNode(workflow, 'Generate Base64 Image');
  prepareImages.parameters.jsCode = replaceExact(
    prepareImages.parameters.jsCode,
    `  'batchIndex', 'generationConcurrency', 'originalIndex', 'imageInputMode'
];`,
    `  'batchIndex', 'generationConcurrency', 'originalIndex', 'imageInputMode', 'constants'
];`,
    `${workflow.id}/Generate Base64 Image constants passthrough`,
  );
  prepareImages.parameters.jsCode = replaceExact(
    prepareImages.parameters.jsCode,
    `      model: source.model || 'jimeng-4.5',`,
    `      model: source.constants.model.jimengModel,`,
    `${workflow.id}/Generate Base64 Image model`,
  );

  const batchBuilder = requireNode(workflow, 'Build Async Submit Batch');
  batchBuilder.parameters.jsCode = replaceExact(
    batchBuilder.parameters.jsCode,
    `const first = items[0];
const n8nExecutionId =`,
    `const first = items[0];
const jimengModel = text(first.constants?.model?.jimengModel);
if (!jimengModel) throw new Error('CONFIG_INVALID: Global Constants 缺少 constants.model.jimengModel');
const n8nExecutionId =`,
    `${workflow.id}/Build Async Submit Batch model validation`,
  );
  batchBuilder.parameters.jsCode = replaceExact(
    batchBuilder.parameters.jsCode,
    `const tasks = items.map((item, index) => {
  const prompt =`,
    `const tasks = items.map((item, index) => {
  const { constants: _constants, ...taskInput } = item;
  const prompt =`,
    `${workflow.id}/Build Async Submit Batch strip constants`,
  );
  batchBuilder.parameters.jsCode = replaceExact(
    batchBuilder.parameters.jsCode,
    `  return {
    ...item,
    taskBaseId,`,
    `  return {
    ...taskInput,
    taskBaseId,`,
    `${workflow.id}/Build Async Submit Batch task input`,
  );
  batchBuilder.parameters.jsCode = replaceExact(
    batchBuilder.parameters.jsCode,
    `  json: {
    batchKey:`,
    `  json: {
    constants: first.constants,
    batchKey:`,
    `${workflow.id}/Build Async Submit Batch constants output`,
  );
  batchBuilder.parameters.jsCode = replaceExact(
    batchBuilder.parameters.jsCode,
    `      model: text(first.model) || 'jimeng-4.5',`,
    `      model: jimengModel,`,
    `${workflow.id}/Build Async Submit Batch model`,
  );

  const initial = requireNode(workflow, 'Initialize Initial Polling');
  initial.parameters.jsCode = replaceExact(
    initial.parameters.jsCode,
    `  ok: true,
  batchKey: batch.batchKey,`,
    `  ok: true,
  constants: batch.constants,
  batchKey: batch.batchKey,`,
    `${workflow.id}/Initialize Initial Polling constants`,
  );
  const retryBuilder = requireNode(workflow, 'Build Explicit Retry Batch');
  retryBuilder.parameters.jsCode = replaceExact(
    retryBuilder.parameters.jsCode,
    `return [{ json: {
  firstResults,`,
    `return [{ json: {
  constants: sourceBatch.constants,
  firstResults,`,
    `${workflow.id}/Build Explicit Retry Batch constants`,
  );
  const retryInitial = requireNode(workflow, 'Initialize Retry Polling');
  retryInitial.parameters.jsCode = replaceExact(
    retryInitial.parameters.jsCode,
    `  ok: true,
  batchKey: retryBatch.batchKey,`,
    `  ok: true,
  constants: retryBatch.constants,
  batchKey: retryBatch.batchKey,`,
    `${workflow.id}/Initialize Retry Polling constants`,
  );

  for (const [name, endpoint] of Object.entries(definition.httpEndpoints)) {
    patchHttpNode(requireNode(workflow, name), endpoint);
  }
}

export function assertJimengGlobalConfigWorkflow(workflow) {
  const definition = JIMENG_GLOBAL_CONFIG_TARGETS[workflow.id];
  if (!definition) throw new Error(`不支持的工作流 ${workflow.id}`);
  const globalNode = requireNode(workflow, 'Global Constants');
  assert.equal(globalNode.id, definition.globalNodeId);
  assert.equal(globalNode.type, 'n8n-nodes-globals.globalConstants');
  if (globalNode.credentials !== undefined) {
    assert.equal(globalNode.credentials?.globalConstantsApi?.name, 'modelProvider');
  }
  assert.deepEqual(
    workflow.connections?.[definition.source]?.main?.[0],
    [{ node: 'Global Constants', type: 'main', index: 0 }],
  );
  assert.deepEqual(
    workflow.connections?.['Global Constants']?.main?.[0],
    [{ node: definition.target, type: 'main', index: 0 }],
  );
  const executable = workflow.nodes.filter((node) => node.type !== 'n8n-nodes-base.stickyNote');
  const serialized = JSON.stringify(executable);
  assert.equal(serialized.includes('http://localhost:8000'), false, `${workflow.id} 仍包含固定即梦 URL`);
  assert.equal(serialized.includes("'jimeng-4.5'"), false, `${workflow.id} 仍包含固定 jimeng-4.5`);
  assert.equal(serialized.includes('即梦4.5'), false, `${workflow.id} 仍包含固定即梦4.5`);
  assert.equal(serialized.includes('httpBearerAuth'), false, `${workflow.id} 仍包含 Bearer Auth`);
  assert.equal(serialized.includes('HLj0jZorJzbM5kel'), false, `${workflow.id} 仍包含旧即梦凭证`);
  assert.equal(serialized.includes('new URL(jimengUrl)'), false, `${workflow.id} 仍依赖 Code Runner 不可用的 URL 构造器`);
  assert.equal(serialized.includes('const jimengUrlMatch ='), true, `${workflow.id} 缺少 Code Runner 兼容的 URL 校验`);
  for (const [name, endpoint] of Object.entries(definition.httpEndpoints)) {
    const node = requireNode(workflow, name);
    assert.equal(node.parameters.authentication, 'none');
    assert.equal(node.parameters.url, `={{ String($json.constants.BaseUrl.JimengUrl).trim().replace(/\\/+$/, '') + '${endpoint}' }}`);
    const authorization = node.parameters.headerParameters.parameters.find((header) => header.name === 'Authorization');
    assert.equal(authorization?.value, '={{ $json.constants.Authorization.jimengAuthorValue }}');
    assert.equal(node.credentials?.httpBearerAuth, undefined);
  }
  if (workflow.id === 'Wxng7hVbjMNhVOaO') {
    const assignments = requireNode(workflow, 'setParameter').parameters.assignments.assignments;
    assert.equal(assignments.find((item) => item.name === 'model')?.value, '={{ $json.constants.model.jimengModel }}');
    assert.match(requireNode(workflow, 'Build Jimeng Tasks').parameters.jsCode, /constants\?\.model\?\.jimengModel/);
  } else if (workflow.id === 'HpCtxAZJdy9RgWk2') {
    const assignments = requireNode(workflow, 'setParameter').parameters.assignments.assignments;
    assert.equal(assignments.find((item) => item.name === 'model')?.value, '={{ $json.constants.model.jimengModel }}');
    assert.equal(assignments.find((item) => item.name === 'constants')?.value, '={{ $json.constants }}');
    assert.match(requireNode(workflow, 'Build View Tasks').parameters.jsCode, /constants\?\.model\?\.jimengModel/);
    assert.match(requireNode(workflow, 'Build Async Submit Batch').parameters.jsCode, /constants: first\.constants/);
    assert.match(requireNode(workflow, 'Initialize View Polling').parameters.jsCode, /constants: batch\.constants/);
    assert.match(requireNode(workflow, 'Evaluate View Tasks').parameters.jsCode, /constants: \$\('Build Async Submit Batch'\)\.first\(\)\.json\.constants/);
    assert.match(requireNode(workflow, 'Build Explicit Retry Batch').parameters.jsCode, /constants: sourceBatch\.constants/);
    assert.match(requireNode(workflow, 'Initialize Retry Polling').parameters.jsCode, /constants: retryBatch\.constants/);
    assert.match(requireNode(workflow, 'Evaluate Retry Tasks').parameters.jsCode, /constants: retryPlan\.constants/);
  } else {
    assert.match(requireNode(workflow, 'Normalize Batch Or Single Input').parameters.jsCode, /constants: root\.constants/);
    assert.match(requireNode(workflow, 'Generate Base64 Image').parameters.jsCode, /'constants'/);
    assert.match(requireNode(workflow, 'Build Async Submit Batch').parameters.jsCode, /const \{ constants: _constants, \.\.\.taskInput \} = item/);
    assert.match(requireNode(workflow, 'Initialize Initial Polling').parameters.jsCode, /constants: batch\.constants/);
    assert.match(requireNode(workflow, 'Evaluate Initial Tasks').parameters.jsCode, /constants: batch\.constants/);
    assert.match(requireNode(workflow, 'Build Explicit Retry Batch').parameters.jsCode, /constants: sourceBatch\.constants/);
    assert.match(requireNode(workflow, 'Initialize Retry Polling').parameters.jsCode, /constants: retryBatch\.constants/);
    assert.match(requireNode(workflow, 'Evaluate Retry Tasks').parameters.jsCode, /constants: retryBatch\.constants/);
  }
  return true;
}

export function patchJimengGlobalConfigWorkflow(workflow, globalNodeTemplate) {
  const patched = clone(workflow);
  if (!JIMENG_GLOBAL_CONFIG_TARGETS[patched.id]) throw new Error(`不支持的工作流 ${patched.id}`);
  if (!globalNodeTemplate?.credentials?.globalConstantsApi) throw new Error('Global Constants 模板缺少 modelProvider 凭证绑定');
  if (patched.nodes.some((node) => node.name === 'Global Constants')) {
    migrateRuntimeUrlValidation(patched);
    migratePollingConstants(patched);
    assertJimengGlobalConfigWorkflow(patched);
    return patched;
  }
  if (patched.id === 'Wxng7hVbjMNhVOaO') patchE001(patched, globalNodeTemplate);
  else if (patched.id === 'HpCtxAZJdy9RgWk2') patchE002(patched, globalNodeTemplate);
  else patchS003(patched, globalNodeTemplate);
  assertJimengGlobalConfigWorkflow(patched);
  return patched;
}
