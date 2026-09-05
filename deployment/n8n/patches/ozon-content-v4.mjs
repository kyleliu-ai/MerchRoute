import assert from 'node:assert/strict';
import { patchOzonTitleV4, TITLE_POLICY_NODES, TITLE_WORKFLOW_ID } from './ozon-title-v4.mjs';

export const POLICY_NODES = {
  [TITLE_WORKFLOW_ID]: TITLE_POLICY_NODES,
  stSK51IuxrMZlLjx: ['读取并校验本地媒体路径', '构建商品导入请求', '构建 MerchRoute 状态回写', '构建导入意图'],
  g3KK68BLXX7eShqa: ['选择待推进任务', '分析平台最终状态', '分析平台最终状态 2', '分析平台最终状态 3', '分析平台最终状态 4']
};

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
  return result;
}
