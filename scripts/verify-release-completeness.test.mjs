import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import {
  collectContentIdentity,
  compareBranchInventory,
  evaluateGate,
  identityMatches,
  inspectFeatureSources,
  inspectValidationLog,
  validateManifest,
  verifyBuildIdentity,
  verifyEvidence
} from './verify-release-completeness.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(await readFile(path.join(repoRoot, 'config/release-features.json'), 'utf8'));
const digest = (value) => createHash('sha256').update(value).digest('hex');
const exampleIdentity = {
  commit: 'a'.repeat(40), headTreeHash: 'b'.repeat(40), scopeVersion: 1,
  fingerprints: { runtime: '1'.repeat(64), documentation: '2'.repeat(64), verification: '3'.repeat(64) },
  scopeContractSha256: '4'.repeat(64), agentsSha256: '5'.repeat(64), featureManifestSha256: '6'.repeat(64)
};
const noEvidence = { status: 'NOT_PROVIDED', errors: [], checks: [] };

async function tempDirectory(t, label) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'merchroute-release-' + label + '-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test('台账覆盖原 25 个本机分支，并只融合三组缺失功能', () => {
  assert.deepEqual(validateManifest(manifest), []);
  assert.equal(manifest.branches.length, 25);
  assert.deepEqual(manifest.features.filter((feature) => feature.action === 'INTEGRATE').map((feature) => feature.id).sort(),
    ['local-import-directory-status', 'project-release-guardrails', 'wb-restart-protection']);
  assert.equal(manifest.features.length, 12);
  const changed = structuredClone(manifest);
  changed.branches[0].featureId = 'unknown';
  assert.match(validateManifest(changed).join(' '), /未关联有效功能/);
  changed.features[0].sourceChecks[0].path = '../secret';
  assert.match(validateManifest(changed).join(' '), /仓库内相对路径/);
});

test('当前候选以外的分支移动、缺失或新增都要求重新审计', () => {
  const branches = manifest.branches.map(({ name, head }) => ({ name, head }));
  branches.push({ name: manifest.policy.currentBranch, head: 'c'.repeat(40) });
  assert.deepEqual(compareBranchInventory(manifest, branches, manifest.policy.currentBranch), []);
  const moved = structuredClone(branches);
  moved[0].head = 'd'.repeat(40);
  assert.match(compareBranchInventory(manifest, moved, manifest.policy.currentBranch).join(' '), /发生变化/);
  assert.match(compareBranchInventory(manifest, branches.slice(1), manifest.policy.currentBranch).join(' '), /缺失/);
  assert.match(compareBranchInventory(manifest, [...branches, { name: 'work/unreviewed', head: 'e'.repeat(40) }], manifest.policy.currentBranch).join(' '), /未纳入台账/);
  assert.match(compareBranchInventory(manifest, branches, 'main').join(' '), /独立候选/);
});

test('源码锚点成功不宣称行为通过，缺少字面表头会失败', async (t) => {
  const root = await tempDirectory(t, 'anchors');
  await writeFile(path.join(root, 'view.tsx'), '<span>选择</span><span>导入状态</span>');
  const fixture = { features: [{ id: 'table', action: 'INTEGRATE', sourceChecks: [{ path: 'view.tsx', includes: ['<span>选择</span>', '<span>导入状态</span>'] }] }] };
  const success = await inspectFeatureSources(root, fixture);
  assert.equal(success[0].sourceAnchors, 'PASS');
  assert.equal(success[0].behavior, 'NOT_RUN_BY_THIS_SCRIPT');
  await writeFile(path.join(root, 'view.tsx'), '<span /><span>导入状态</span>');
  assert.equal((await inspectFeatureSources(root, fixture))[0].sourceAnchors, 'FAIL');
});

test('规则来源文件不仅靠关键字，SHA 不一致会失败', async (t) => {
  const root = await tempDirectory(t, 'rules');
  await writeFile(path.join(root, 'AGENTS.md'), '规则');
  const fixture = { features: [{ id: 'rules', action: 'INTEGRATE', sourceChecks: [], sourceDocumentSha256: digest('规则') }] };
  assert.equal((await inspectFeatureSources(root, fixture))[0].sourceAnchors, 'PASS');
  await writeFile(path.join(root, 'AGENTS.md'), '规则被改写');
  assert.equal((await inspectFeatureSources(root, fixture))[0].sourceAnchors, 'FAIL');
});

test('三类指纹包含未暂存新增文件；规则与 scope 契约单独绑定；排除敏感运行文件', async (t) => {
  const root = await tempDirectory(t, 'snapshot');
  // A disposable empty Git repository only: no commits or user refs are created.
  execFileSync('git', ['init', '--quiet', root], { windowsHide: true });
  await mkdir(path.join(root, 'config'));
  await mkdir(path.join(root, 'docs'));
  await writeFile(path.join(root, 'config/content-fingerprint-scope.json'), await readFile(path.join(repoRoot, 'config/content-fingerprint-scope.json')));
  await writeFile(path.join(root, 'config/release-features.json'), '{}');
  await writeFile(path.join(root, 'AGENTS.md'), '规则');
  await writeFile(path.join(root, 'new-feature.ts'), 'export const feature = true;');
  await writeFile(path.join(root, 'new-feature.test.ts'), 'verification');
  const first = await collectContentIdentity(root);
  await writeFile(path.join(root, '.env'), 'TEST_ONLY_NOT_A_CREDENTIAL=changed');
  await writeFile(path.join(root, 'cookies.json'), '{"test":"not-real"}');
  assert.deepEqual(await collectContentIdentity(root), first);
  await writeFile(path.join(root, 'new-feature.ts'), 'export const feature = false;');
  const runtime = await collectContentIdentity(root);
  assert.notEqual(runtime.fingerprints.runtime, first.fingerprints.runtime);
  assert.equal(runtime.fingerprints.documentation, first.fingerprints.documentation);
  await writeFile(path.join(root, 'docs/new-guide.md'), '新增说明');
  const docs = await collectContentIdentity(root);
  assert.notEqual(docs.fingerprints.documentation, runtime.fingerprints.documentation);
  await writeFile(path.join(root, 'new-feature.test.ts'), 'new verification');
  const verification = await collectContentIdentity(root);
  assert.notEqual(verification.fingerprints.verification, docs.fingerprints.verification);
  await writeFile(path.join(root, 'AGENTS.md'), '更新规则');
  const rules = await collectContentIdentity(root);
  assert.notEqual(rules.agentsSha256, verification.agentsSha256);
  const scopePath = path.join(root, 'config/content-fingerprint-scope.json');
  await writeFile(scopePath, (await readFile(scopePath, 'utf8')) + '\n');
  const scope = await collectContentIdentity(root);
  assert.notEqual(scope.scopeContractSha256, rules.scopeContractSha256);
  assert.deepEqual(scope.fingerprints, rules.fingerprints);
});

test('证据必须绑定所有内容身份而非仅 HEAD 或 runtime 指纹', () => {
  assert.equal(identityMatches(exampleIdentity, structuredClone(exampleIdentity)), true);
  for (const key of ['commit', 'headTreeHash', 'scopeContractSha256', 'agentsSha256', 'featureManifestSha256']) {
    assert.equal(identityMatches(exampleIdentity, { ...exampleIdentity, [key]: 'changed' }), false);
  }
  for (const scope of ['runtime', 'documentation', 'verification']) {
    assert.equal(identityMatches(exampleIdentity, { ...exampleIdentity, fingerprints: { ...exampleIdentity.fingerprints, [scope]: 'changed' } }), false);
  }
});

test('证据要求完整检查及仓库外非空日志，并验证日志哈希', async (t) => {
  const root = await tempDirectory(t, 'repo');
  const logRoot = await tempDirectory(t, 'logs');
  const logPath = path.join(logRoot, 'run.log');
  const validLog = 'Tests  9 passed (9)\n';
  await writeFile(logPath, validLog);
  const requirement = { requiredChecks: [{ id: 'check' }] };
  const evidence = {
    schemaVersion: 1, identity: exampleIdentity,
    checks: [{ id: 'check', command: 'npm run check', exitCode: 0, completedAt: new Date().toISOString(), logPath, logSha256: digest(validLog) }]
  };
  assert.equal((await verifyEvidence(requirement, exampleIdentity, evidence, root)).status, 'PASS');
  assert.equal((await verifyEvidence(requirement, exampleIdentity, undefined, root)).status, 'NOT_PROVIDED');
  assert.equal((await verifyEvidence(requirement, exampleIdentity, { ...evidence, checks: [] }, root)).status, 'FAIL');
  assert.equal((await verifyEvidence(requirement, { ...exampleIdentity, agentsSha256: 'changed' }, evidence, root)).status, 'FAIL');
  const failed = structuredClone(evidence);
  failed.checks[0].exitCode = 1;
  assert.equal((await verifyEvidence(requirement, exampleIdentity, failed, root)).status, 'FAIL');
  const duplicate = structuredClone(evidence);
  duplicate.checks.push(duplicate.checks[0]);
  assert.equal((await verifyEvidence(requirement, exampleIdentity, duplicate, root)).status, 'FAIL');
  const internal = structuredClone(evidence);
  internal.checks[0].logPath = path.join(root, 'run.log');
  await writeFile(internal.checks[0].logPath, validLog);
  assert.equal((await verifyEvidence(requirement, exampleIdentity, internal, root)).status, 'FAIL');
  await writeFile(logPath, 'changed log');
  assert.equal((await verifyEvidence(requirement, exampleIdentity, evidence, root)).status, 'FAIL');
});

test('实际命令与日志汇总双检，全跳过和有失败的测试不算通过；已有 skip 数量必须披露', () => {
  const pgCommand = 'node.exe F:/project/node_modules/vitest/vitest.mjs run .integration.test.ts --maxWorkers=2';
  assert.deepEqual(inspectValidationLog('postgres-integration', pgCommand, ' Tests  23 passed | 11 skipped (34)\n'), {
    problems: [], summary: { passed: 23, failed: 0, skipped: 11 }
  });
  assert.notEqual(inspectValidationLog('postgres-integration', pgCommand, ' Tests  11 skipped (11)\n').problems.length, 0);
  assert.notEqual(inspectValidationLog('postgres-integration', pgCommand, ' Tests  1 failed | 23 passed (24)\n').problems.length, 0);
  assert.notEqual(inspectValidationLog('postgres-integration', 'echo success', ' Tests  23 passed (23)\n').problems.length, 0);
  assert.notEqual(inspectValidationLog('e2e', 'npm run test:e2e', 'Started tests, no summary').problems.length, 0);
  assert.deepEqual(inspectValidationLog('e2e', 'npm run test:e2e', '  27 passed (1.2m)\n  2 skipped\n').summary, { passed: 27, failed: 0, skipped: 2 });
  const crashedAfterTests = '[WebServer] error: relation "ozon_system_settings" does not exist\n[WebServer] Node.js v22.23.1\n  11 skipped\n  167 passed (9.0m)\n';
  assert.match(inspectValidationLog('e2e', 'npm run test:e2e', crashedAfterTests).problems.join(' '), /测试服务异常退出/);
  assert.match(inspectValidationLog('e2e', 'npm run test:e2e', '[WebServer] npm error Lifecycle script failed\n  1 passed\n').problems.join(' '), /测试服务异常退出/);
  assert.deepEqual(inspectValidationLog('release-verifier-tests', 'node --import tsx --test scripts/verify-release-completeness.test.mjs', '# pass 10\n# fail 0\n# skipped 0\n').problems, []);
  assert.deepEqual(inspectValidationLog('isolated-runtime', 'node C:/temp/isolated-runtime.mjs', '{"assertionsPassed": 12, "assertionsFailed": 0}').problems, []);
  assert.notEqual(inspectValidationLog('isolated-runtime', 'node C:/temp/isolated-runtime.mjs', '{"assertionsPassed": 0, "assertionsFailed": 0}').problems.length, 0);
});

test('阶段 1 允许 dirty 候选但绝不报告已发布；严格模式要求干净、行为证据和同身份构建', () => {
  const draft = evaluateGate({ staticErrors: [], evidence: noEvidence, strict: false, dirty: true });
  assert.equal(draft.ok, true);
  assert.equal(draft.staticAudit, 'PASS');
  assert.equal(draft.candidateValidated, false);
  assert.equal(draft.releaseReady, false);
  assert.equal(draft.published, false);
  const passed = { status: 'PASS', errors: [], checks: [] };
  const validated = evaluateGate({ staticErrors: [], evidence: passed, strict: false, dirty: true });
  assert.equal(validated.candidateValidated, true);
  assert.equal(validated.releaseReady, false);
  assert.equal(evaluateGate({ staticErrors: [], evidence: passed, strict: true, dirty: true }).ok, false);
  assert.equal(evaluateGate({ staticErrors: [], evidence: noEvidence, strict: true, dirty: false }).ok, false);
  assert.equal(evaluateGate({ staticErrors: [], evidence: passed, strict: true, dirty: false, buildErrors: ['stale build'] }).ok, false);
  const release = evaluateGate({ staticErrors: [], evidence: passed, strict: true, dirty: false, buildErrors: [] });
  assert.equal(release.releaseReady, true);
  assert.equal(release.published, false);
});

test('严格构建必须匹配真实提交、三类指纹和范围版本，不能用版本号替代', () => {
  const build = { commitSha: exampleIdentity.commit, dirty: false, scopeVersion: 1, fingerprints: exampleIdentity.fingerprints };
  assert.deepEqual(verifyBuildIdentity(exampleIdentity, build), []);
  assert.notDeepEqual(verifyBuildIdentity(exampleIdentity, undefined), []);
  assert.notDeepEqual(verifyBuildIdentity(exampleIdentity, { ...build, dirty: true }), []);
  assert.notDeepEqual(verifyBuildIdentity(exampleIdentity, { ...build, commitSha: 'stale' }), []);
  assert.notDeepEqual(verifyBuildIdentity(exampleIdentity, { ...build, fingerprints: { ...build.fingerprints, documentation: 'stale' } }), []);
});
