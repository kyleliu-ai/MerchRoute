import assert from 'node:assert/strict';
import { patchOzonTitleV4, TITLE_POLICY_NODES, TITLE_WORKFLOW_ID } from './ozon-title-v4.mjs';

export const POLICY_NODES = {
  [TITLE_WORKFLOW_ID]: TITLE_POLICY_NODES,
  '0FqozLuQ7vuabT8V': ['准备后端 intake 验证', '校验并认领任务目录'],
  stSK51IuxrMZlLjx: ['读取并校验本地媒体路径', '构建商品导入请求', '构建 MerchRoute 状态回写', '构建导入意图'],
  g3KK68BLXX7eShqa: ['选择待推进任务', '分析平台最终状态', '分析平台最终状态 2', '分析平台最终状态 3', '分析平台最终状态 4']
};

export const DIRECTORY_FAILURE_NODE = '构建目录认领失败回写';
export const PATCH_NODES = {
  ...POLICY_NODES,
  g3KK68BLXX7eShqa: [...POLICY_NODES.g3KK68BLXX7eShqa, DIRECTORY_FAILURE_NODE]
};

// Only known contract failures are terminal here. Lock contention, unavailable
// files, unknown backend outcomes and transport errors retain their retry path.
const permanentDirectoryCodes = [
  'OZON_LEGACY_MODE_INVALID', 'OZON_INTAKE_VERIFY_MODE_INVALID',
  'OZON_INTAKE_VERIFY_SNAPSHOT_INVALID', 'OZON_INTAKE_VERIFY_CONTEXT_INVALID',
  'OZON_INTAKE_VERIFY_PATH_INVALID', 'OZON_INTAKE_VERIFY_MARKER_INVALID',
  'OZON_INTAKE_VERIFY_MARKER_SNAPSHOT_MISMATCH', 'OZON_INTAKE_VERIFY_PRODUCT_INVALID',
  'OZON_INTAKE_PRODUCT_CONTENT_HASH_MISMATCH', 'OZON_INTAKE_MATERIALIZATION_HASH_MISMATCH',
  'OZON_INTAKE_TICKET_INVALID', 'OZON_INTAKE_VERIFY_HASH_INVALID',
  'OZON_INTAKE_BACKEND_VERIFY_REQUIRED', 'OZON_JOB_ID_INVALID', 'OZON_PRODUCT_PATH_INVALID',
  'OZON_REVISION_INVALID', 'OZON_STORE_SNAPSHOT_INVALID', 'OZON_CREDENTIAL_VERSION_REQUIRED',
  'OZON_TASK_ID_SCOPE_INVALID', 'OZON_LEGACY_SCOPE_INVALID', 'OZON_FROZEN_SNAPSHOT_INCOMPLETE',
  'OZON_PRODUCT_PATH_SCOPE_INVALID', 'OZON_STORE_PATH_MISMATCH', 'OZON_PATH_SYMLINK',
  'OZON_STORE_PATH_ESCAPE', 'OZON_INBOX_PATH_ESCAPE', 'OZON_LIFECYCLE_PATH_ESCAPE',
  'OZON_TASK_PATH_ESCAPE', 'OZON_INTAKE_FILE_INVALID', 'OZON_PRODUCT_JSON_INVALID',
  'OZON_READY_INVALID', 'OZON_PRODUCT_IDENTITY_MISMATCH', 'OZON_READY_IDENTITY_MISMATCH',
  'OZON_OFFER_ID_INVALID', 'OZON_PRODUCT_SIGNATURE_MISMATCH', 'OZON_INTAKE_MARKER_INVALID',
  'OZON_INTAKE_MARKER_CONFLICT', 'OZON_LIFECYCLE_NAME_INVALID', 'OZON_INTAKE_PATH_ESCAPE',
  'OZON_INTAKE_DUPLICATE'
];

function patchDirectoryFailure(source) {
  const oldClassification = "  const permanent = /签名冲突|marker.*冲突|逃逸|符号链接|身份或版本无效|多个匹配|同时存在/i.test(message);";
  const newClassification = `  const contractFailureCodes = new Set(${JSON.stringify(permanentDirectoryCodes)});
  // Execute Workflow may serialize an Error to its message and discard .code.
  const reportedCode = String(failure.error?.code || failure.code || '').trim();
  const messageCode = message.match(/\\bOZON_[A-Z0-9_]+\\b/)?.[0] || '';
  const legacySnapshotCode = /票据验证缺少完整 .*冻结快照/.test(message)
    ? 'OZON_INTAKE_VERIFY_SNAPSHOT_INVALID'
    : /店铺任务不可变快照不完整/.test(message) ? 'OZON_FROZEN_SNAPSHOT_INCOMPLETE' : '';
  const contractCode = [reportedCode, messageCode, legacySnapshotCode].find(code => contractFailureCodes.has(code));
  const permanent = Boolean(contractCode) || /签名冲突|marker.*冲突|逃逸|符号链接|身份或版本无效|多个匹配|同时存在/i.test(message);`;
  source = replaceOnce(source, oldClassification, newClassification);
  return replaceOnce(source,
    "errorCode: permanent ? 'OZON_DIRECTORY_CLAIM_REJECTED' : undefined",
    "errorCode: permanent ? (contractCode || 'OZON_DIRECTORY_CLAIM_REJECTED') : undefined");
}

function replaceOnce(source, before, after) {
  if (source.includes(after)) return source;
  assert.equal(source.split(before).length, 2, `Policy patch guard drift: ${before}`);
  return source.replace(before, after);
}

export function patchOzonContentV4(input) {
  if (input.id === TITLE_WORKFLOW_ID) return patchOzonTitleV4(input);
  const expected = POLICY_NODES[input.id];
  assert.ok(expected, 'Unsupported workflow');
  const result = structuredClone(input);
  for (const name of expected) {
    const nodes = result.nodes.filter(node => node.name === name);
    assert.equal(nodes.length, 1, `${name}: node must be unique`);
    const node = nodes[0];
    assert.equal(node.type, 'n8n-nodes-base.code');
    let code = node.parameters.jsCode;
    const policies = name === '构建 MerchRoute 状态回写'
      ? "['merchroute-ozon-content-v2', 'merchroute-ozon-content-v3']"
      : input.id === 'g3KK68BLXX7eShqa' && name !== '选择待推进任务'
        ? "['merchroute-ozon-content-v1','merchroute-ozon-content-v2','merchroute-ozon-content-v3']"
        : "['merchroute-ozon-content-v2','merchroute-ozon-content-v3']";
    code = replaceOnce(code, policies, policies.slice(0, -1) + ",'merchroute-ozon-content-v4']");
    if (input.id === '0FqozLuQ7vuabT8V') {
      code = replaceOnce(code,
        'function fail(code, message) { const error = new Error(message); error.code = code; throw error; }',
        "function fail(code, message) { const error = new Error(code + ': ' + message); error.code = code; throw error; }");
    }
    if (input.id === 'stSK51IuxrMZlLjx' && name !== '构建 MerchRoute 状态回写') {
      code = replaceOnce(code,
        "descriptionPolicyVersion === 'merchroute-ozon-content-v3' ? imitationPatternV3 : imitationPatternV2",
        "descriptionPolicyVersion === 'merchroute-ozon-content-v2' ? imitationPatternV2 : imitationPatternV3");
      const value = name === '构建导入意图' ? 'expectedSubmitted' : 'submitted';
      code = replaceOnce(code, `if (hasKeywordStuffing(${value})) issues.push('KEYWORD_STUFFING');`,
        `if (descriptionPolicyVersion !== 'merchroute-ozon-content-v4' && hasKeywordStuffing(${value})) issues.push('KEYWORD_STUFFING');`);
    }
    if (input.id === 'g3KK68BLXX7eShqa' && name !== '选择待推进任务') {
      // Keep the persisted diagnostic name, but require the complete binding for v4 too.
      code = replaceOnce(code, "const incompleteV3PolicyContract = descriptionPolicyVersion === 'merchroute-ozon-content-v3'",
        "const incompleteV3PolicyContract = ['merchroute-ozon-content-v3','merchroute-ozon-content-v4'].includes(descriptionPolicyVersion)");
    }
    const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
    new AsyncFunction(code);
    node.parameters.jsCode = code;
  }
  if (input.id === 'g3KK68BLXX7eShqa') {
    const nodes = result.nodes.filter(node => node.name === DIRECTORY_FAILURE_NODE);
    assert.equal(nodes.length, 1, `${DIRECTORY_FAILURE_NODE}: node must be unique`);
    assert.equal(nodes[0].type, 'n8n-nodes-base.code');
    nodes[0].parameters.jsCode = patchDirectoryFailure(nodes[0].parameters.jsCode);
    const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
    new AsyncFunction(nodes[0].parameters.jsCode);
  }
  return result;
}
