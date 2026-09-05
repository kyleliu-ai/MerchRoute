import assert from 'node:assert/strict';

export const TITLE_WORKFLOW_ID = 'HDh0ZNLK2ps5qasR';
export const TITLE_POLICY_NODES = ['Validate Translation Request', 'Parse Initial Translation', 'Parse Shortened Translation'];
const oldPolicies = "['merchroute-ozon-content-v2','merchroute-ozon-content-v3']";
const newPolicies = "['merchroute-ozon-content-v2','merchroute-ozon-content-v3','merchroute-ozon-content-v4']";
const oldSelection = "contentPolicyVersion === 'merchroute-ozon-content-v3' ? titleImitationV3 : titleImitationV2";
const newSelection = "contentPolicyVersion === 'merchroute-ozon-content-v2' ? titleImitationV2 : titleImitationV3";

// Patch the freshly read LOCAL definition, never replace it with a repository export.
export function patchOzonTitleV4(input) {
  assert.equal(input.id, TITLE_WORKFLOW_ID);
  const result = structuredClone(input);
  for (const name of TITLE_POLICY_NODES) {
    const nodes = result.nodes.filter(node => node.name === name);
    assert.equal(nodes.length, 1, `${name}: node must be unique`);
    const node = nodes[0];
    assert.equal(node.type, 'n8n-nodes-base.code');
    let source = node.parameters.jsCode;
    if (!source.includes(newPolicies)) {
      assert.equal(source.split(oldPolicies).length, 2, `${name}: policy guard drift`);
      source = source.replace(oldPolicies, newPolicies);
    }
    if (name !== TITLE_POLICY_NODES[0] && !source.includes(newSelection)) {
      assert.equal(source.split(oldSelection).length, 2, `${name}: title rule drift`);
      source = source.replace(oldSelection, newSelection);
    }
    new Function(source);
    node.parameters.jsCode = source;
  }
  return result;
}
