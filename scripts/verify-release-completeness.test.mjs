import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { LEGACY_OZON_SKIPS, POSIX_SKIP } from './ci-evidence-contract.mjs';
import {
  collectContentIdentity,
  compareBranchInventory,
  compareInventorySnapshots,
  evaluateCiGate,
  evaluateGate,
  identityMatches,
  inspectFeatureSources,
  inspectModeConstraints,
  inspectValidationLog,
  parseVerificationArguments,
  parseLocalTree,
  githubRepositoryFromPackage,
  REQUIRED_FEATURE_IDS,
  REQUIRED_LOCAL_CHECK_IDS,
  validateManifest,
  verifyBuildIdentity,
  verifyExpectedCommit,
  verifyGithubMainMapping,
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
const candidateBranch = 'work/new-acceptance-candidate';

async function tempDirectory(t, label) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'merchroute-release-' + label + '-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test('原 29 个来源及 12 项功能完整保留，追加优化基线与审核投递可靠性', () => {
  assert.deepEqual(validateManifest(manifest), []);
  assert.equal(manifest.branches.length, 30);
  assert.equal(digest(JSON.stringify(manifest.branches.slice(0, 25))), '7fa2eea22e55675c5cdf373683a07ebe15b7eb2c110987708574f7c74cf835bf');
  assert.deepEqual(manifest.branches[25], {
    name: 'work/merchroute-complete-release-20260903-0951', head: '26235db67baa4b99d15952571f152af8c6c65c9d',
    featureId: 'core-deployment', relation: 'COMMITTED_COMPLETE_CANDIDATE'
  });
  assert.equal(manifest.sourceCandidate.commit, manifest.branches[25].head);
  assert.equal(manifest.sourceCandidate.headTreeHash, '188f6431b2587ec3a4ad9a34f315c6a2c5cdb4ec');
  assert.equal(manifest.policy.currentBranch, undefined);
  assert.equal(manifest.policy.candidateBinding, 'EXPLICIT_EXPECTED_COMMIT');
  assert.deepEqual(manifest.branches.slice(26, 29).map(({ name, head }) => [name, head]), [
    ['work/merchroute-github-publish-20260903-1108', 'cbcec116aa57e13c3c212c45e112f12bb0649ba1'],
    ['work/pr23-ci-fix-20260903-1336', '4315999b0c23f4651412b597bfbdc1455d85c212'],
    ['work/pr23-ci-publish-20260903-1336', 'e8c357247173a912fb588d92ce3d30e11ed09e91']
  ]);
  assert.equal(manifest.integrationParent.commit, manifest.branches[27].head);
  assert.equal(manifest.integrationParent.headTreeHash, '22ecc597f1230bcc280d63b032e06b4c72bfee23');
  assert.deepEqual(manifest.features.filter((feature) => feature.action === 'INTEGRATE').map((feature) => feature.id).sort(),
    ['local-import-directory-status', 'project-release-guardrails', 'review-delivery-reliability', 'wb-restart-protection']);
  assert.equal(manifest.features.length, 13);
  assert.equal(digest(JSON.stringify(manifest.branches.slice(0, 29))), "b85410e26bdba57eb6adc9760f42c64e84ddee52b0e5d2f308fb9bbd8df70870");
  assert.deepEqual(manifest.branches[29], { name: 'work/release-acceptance-gates-20260903-1432', head: '8568914f30a9d639f7df92590808d887f4f0809e', featureId: 'core-deployment', relation: 'USER_CONFIRMED_LOCAL_BASELINE' });
  const changed = structuredClone(manifest);
  changed.branches[0].featureId = 'unknown';
  assert.match(validateManifest(changed).join(' '), /未关联有效功能/);
  changed.features[0].sourceChecks[0].path = '../secret';
  assert.match(validateManifest(changed).join(' '), /仓库内相对路径/);
});

test('两种模式共用不可删减的 13 项关键功能与本机 11 类检查契约', () => {
  assert.deepEqual(manifest.features.map((feature) => feature.id), REQUIRED_FEATURE_IDS);
  assert.deepEqual(manifest.requiredChecks.map((check) => check.id), REQUIRED_LOCAL_CHECK_IDS);
  for (const id of REQUIRED_FEATURE_IDS) {
    const changed = structuredClone(manifest);
    changed.features = changed.features.filter((feature) => feature.id !== id);
    assert.match(validateManifest(changed).join(' '), /缺少必须保留的功能/);
  }
  for (const id of REQUIRED_LOCAL_CHECK_IDS) {
    const changed = structuredClone(manifest);
    changed.requiredChecks = changed.requiredChecks.filter((check) => check.id !== id);
    assert.match(validateManifest(changed).join(' '), /缺少本机严格检查/);
  }
  const missingSource = structuredClone(manifest);
  delete missingSource.sourceCandidate;
  assert.match(validateManifest(missingSource).join(' '), /已提交阶段 1/);
  const missingParent = structuredClone(manifest);
  delete missingParent.integrationParent;
  assert.match(validateManifest(missingParent).join(' '), /已审计本机来源/);
  const oldBinding = structuredClone(manifest);
  oldBinding.policy.currentBranch = 'work/obsolete-branch';
  assert.match(validateManifest(oldBinding).join(' '), /不能硬编码/);
});

test('当前候选以真实提交绑定；历史移动、缺失或未知新提交仍阻断', () => {
  const branches = manifest.branches.map(({ name, head }) => ({ name, head }));
  branches.push({ name: candidateBranch, head: exampleIdentity.commit });
  const inspect = (items, current = candidateBranch, expected = exampleIdentity.commit) => compareBranchInventory(manifest, items, current, expected);
  assert.deepEqual(inspect(branches), []);
  const moved = structuredClone(branches);
  moved[0].head = 'd'.repeat(40);
  assert.match(inspect(moved).join(' '), /发生变化/);
  assert.match(inspect(branches.slice(1)).join(' '), /缺失/);
  assert.match(inspect([...branches, { name: 'work/unreviewed', head: 'e'.repeat(40) }]).join(' '), /未纳入台账/);
  assert.match(inspect(branches, 'main').join(' '), /独立候选/);
  assert.match(inspect(branches, '').join(' '), /独立候选/);
  assert.match(inspect(branches, candidateBranch, 'b'.repeat(40)).join(' '), /expected-commit/);
  assert.match(compareBranchInventory(manifest, branches, candidateBranch).join(' '), /expected-commit/);
});

test('新 Worktree 的同提交别名必须显式声明；不能豁免历史分支或不同提交', () => {
  const alias = 'work/explicit-same-commit-alias';
  const branches = [...manifest.branches, { name: candidateBranch, head: exampleIdentity.commit }, { name: alias, head: exampleIdentity.commit }];
  const inspect = (items, aliases) => compareBranchInventory(manifest, items, candidateBranch, exampleIdentity.commit, aliases);
  assert.match(inspect(branches, []).join(' '), /未纳入台账/);
  assert.deepEqual(inspect(branches, [alias]), []);
  assert.match(inspect(branches, [alias, alias]).join(' '), /重复/);
  assert.match(inspect(branches, [alias, 'work/missing']).join(' '), /完全相同提交/);
  assert.match(inspect(branches, [alias, manifest.branches[0].name]).join(' '), /非历史条目/);
  const movedAlias = structuredClone(branches);
  movedAlias.at(-1).head = 'e'.repeat(40); // Even an equal tree is not an equal commit.
  assert.match(inspect(movedAlias, [alias]).join(' '), /完全相同提交/);
  const movedHistorical = structuredClone(branches);
  movedHistorical[0].head = exampleIdentity.commit;
  assert.match(inspect(movedHistorical, [alias, movedHistorical[0].name]).join(' '), /发生变化/);
});

test('检查结束重新核对完整分支集合，不能遗漏并发新增、删除或移动', () => {
  const branches = [{ name: candidateBranch, head: exampleIdentity.commit }];
  assert.deepEqual(compareInventorySnapshots(branches, structuredClone(branches)), []);
  for (const after of [[], [...branches, { name: 'work/new', head: exampleIdentity.commit }], [{ ...branches[0], head: 'f'.repeat(40) }]]) {
    assert.match(compareInventorySnapshots(branches, after).join(' '), /检查期间变化/);
  }
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

test('实际命令与日志汇总双检，全跳过、未知跳过和有失败的测试不算通过', () => {
  const pgCommand = 'node.exe F:/project/node_modules/vitest/vitest.mjs run .integration.test.ts --maxWorkers=2';
  assert.deepEqual(inspectValidationLog('postgres-integration', pgCommand, ' Tests  23 passed (23)\n'), {
    problems: [], summary: { passed: 23, failed: 0, skipped: 0 }
  });
  assert.notEqual(inspectValidationLog('postgres-integration', pgCommand, ' Tests  23 passed | 11 skipped (34)\n').problems.length, 0);
  assert.notEqual(inspectValidationLog('postgres-integration', pgCommand, ' Tests  11 skipped (11)\n').problems.length, 0);
  assert.notEqual(inspectValidationLog('postgres-integration', pgCommand, ' Tests  1 failed | 23 passed (24)\n').problems.length, 0);
  assert.notEqual(inspectValidationLog('postgres-integration', 'echo success', ' Tests  23 passed (23)\n').problems.length, 0);
  assert.notEqual(inspectValidationLog('e2e', 'npm run test:e2e', 'Started tests, no summary').problems.length, 0);
  assert.deepEqual(inspectValidationLog('e2e', 'npm run test:e2e', '  27 passed (1.2m)\n  2 skipped\n').summary, { passed: 27, failed: 0, skipped: 2 });
  assert.notEqual(inspectValidationLog('e2e', 'npm run test:e2e', '  27 passed (1.2m)\n  2 skipped\n').problems.length, 0);
  const crashedAfterTests = '[WebServer] error: relation "ozon_system_settings" does not exist\n[WebServer] Node.js v22.23.1\n  11 skipped\n  167 passed (9.0m)\n';
  assert.match(inspectValidationLog('e2e', 'npm run test:e2e', crashedAfterTests).problems.join(' '), /测试服务异常退出/);
  assert.match(inspectValidationLog('e2e', 'npm run test:e2e', '[WebServer] npm error Lifecycle script failed\n  1 passed\n').problems.join(' '), /测试服务异常退出/);
  assert.deepEqual(inspectValidationLog('release-verifier-tests', 'node --import tsx --test scripts/verify-release-completeness.test.mjs', '# pass 10\n# fail 0\n# skipped 0\n').problems, []);
  assert.deepEqual(inspectValidationLog('isolated-runtime', 'node C:/temp/isolated-runtime.mjs', '{"assertionsPassed": 12, "assertionsFailed": 0}').problems, []);
  assert.notEqual(inspectValidationLog('isolated-runtime', 'node C:/temp/isolated-runtime.mjs', '{"assertionsPassed": 0, "assertionsFailed": 0}').problems.length, 0);
});

test('本机门禁拒绝部分通过混入 TODO、取消、额外关键跳过及重复白名单跳过', () => {
  for (const log of [
    '# pass 1\n# fail 0\n# skipped 0\n# todo 1',
    '# pass 1\n# fail 0\n# skipped 0\n# cancelled 1',
    'ok 2 - 关键目录状态 # TODO\n# pass 1\n# fail 0\n# skipped 0',
    'Tests 1 passed | 1 todo', 'Tests 1 passed | 1 pending',
    'ok 2 - 关键目录状态 # SKIP\n# pass 1\n# fail 0\n# skipped 1'
  ]) assert.notEqual(inspectValidationLog('check', 'npm run check', log).problems.length, 0, log);
  const perf = '✓ src/repositories/media-index.integration.test.ts (9 tests | 1 skipped)\nTests 8 passed | 1 skipped (9)\n';
  assert.deepEqual(inspectValidationLog('check', 'npm run check', perf).problems, []);
  assert.notEqual(inspectValidationLog('check', 'npm run check', perf.replace('media-index.integration', 'local-imports.integration')).problems.length, 0);
  assert.notEqual(inspectValidationLog('check', 'npm run check', perf + perf).problems.length, 0);
  const posix = `ok 1 - ${POSIX_SKIP} # SKIP\n# pass 1\n# fail 0\n# skipped 1\n`;
  assert.deepEqual(inspectValidationLog('check', 'npm run check', posix + perf, { platform: 'win32' }).problems, []);
  assert.notEqual(inspectValidationLog('check', 'npm run check', posix, { platform: 'darwin' }).problems.length, 0);
  assert.notEqual(inspectValidationLog('jimeng', 'npm run jimeng:test', posix, { platform: 'win32' }).problems.length, 0);
});

function playwrightList(skips = LEGACY_OZON_SKIPS) {
  return `Running ${skips.length + 1} tests using 1 worker\n`
    + '  ok 1 [chromium] › tests\\e2e\\local-import.spec.ts:10:3 › 本地导入 › 目录状态 (1.4s)\n'
    + skips.map((title, index) => `  - ${index + 2} [chromium] › tests\\e2e\\ozon-listing.spec.ts:2257:8 › OZON 独立上品工作区 › ${title}\n`).join('')
    + `  ${skips.length} skipped\n  1 passed (1.4s)\n`;
}

test('旧 E2E list 证据保持兼容，但仅允许完整记录的 11 项精确历史跳过', () => {
  const log = playwrightList();
  assert.deepEqual(inspectValidationLog('e2e', 'npm run test:e2e', log).problems, []);
  for (const changed of [
    log.replace(LEGACY_OZON_SKIPS[0], '目录状态新功能'),
    log.replaceAll('ozon-listing.spec.ts', 'fake-ozon-listing.spec.ts'),
    log.replace('  1 passed (1.4s)', '  2 passed (1.4s)'),
    log.replace('Running 12 tests', 'Running 13 tests'),
    log.replace(/^ {2}ok 1 .+\n/m, ''),
    log + '  1 interrupted\n',
    playwrightList([LEGACY_OZON_SKIPS[0], LEGACY_OZON_SKIPS[0]])
  ]) assert.notEqual(inspectValidationLog('e2e', 'npm run test:e2e', changed).problems.length, 0);
});

test('E2E JSON 证据须为仓库外哈希绑定的完整报告，不能仅靠成功汇总', async (t) => {
  const root = await tempDirectory(t, 'e2e-repo');
  const logs = await tempDirectory(t, 'e2e-logs');
  const log = '  1 skipped\n  1 passed (1.4s)\n';
  const logPath = path.join(logs, 'e2e.log');
  await writeFile(logPath, log);
  const report = { errors: [], stats: { expected: 1, skipped: 1, unexpected: 0, flaky: 0 }, suites: [{ file: 'ozon-listing.spec.ts', specs: [
    { title: '实际执行用例', tests: [{ expectedStatus: 'passed', status: 'expected', results: [{ status: 'passed' }] }] },
    { title: LEGACY_OZON_SKIPS[0], tests: [{ expectedStatus: 'skipped', status: 'skipped', results: [{ status: 'skipped' }] }] }
  ] }] };
  const reportBytes = JSON.stringify(report);
  const reportPath = path.join(logs, 'playwright-results.json');
  await writeFile(reportPath, reportBytes);
  const evidence = { schemaVersion: 1, identity: exampleIdentity, checks: [{
    id: 'e2e', command: 'npm run test:e2e -- --reporter=list,json', exitCode: 0, completedAt: new Date().toISOString(),
    logPath, logSha256: digest(log), playwrightReportPath: reportPath, playwrightReportSha256: digest(reportBytes)
  }] };
  const requirement = { requiredChecks: [{ id: 'e2e' }] };
  assert.equal((await verifyEvidence(requirement, exampleIdentity, evidence, root)).status, 'PASS');
  for (const mutate of [
    (value) => { value.checks[0].playwrightReportSha256 = 'f'.repeat(64); },
    (value) => { delete value.checks[0].playwrightReportSha256; },
    (value) => { value.checks[0].playwrightReportPath = path.join(root, 'report.json'); }
  ]) {
    const changed = structuredClone(evidence); mutate(changed);
    assert.equal((await verifyEvidence(requirement, exampleIdentity, changed, root)).status, 'FAIL');
  }
  for (const mutate of [
    (value) => { value.suites[0].specs[1].title = '目录状态关键测试'; },
    (value) => { value.suites[0].specs[0].tests[0].results = []; },
    (value) => { value.stats.expected = 2; }
  ]) {
    const changed = structuredClone(report); mutate(changed);
    assert.notEqual(inspectValidationLog('e2e', evidence.checks[0].command, log, { playwrightReport: changed }).problems.length, 0);
  }
  assert.notEqual(inspectValidationLog('e2e', evidence.checks[0].command, log, { playwrightReport: null }).problems.length, 0);
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

test('local 与 CI 均显式绑定完整 expected commit，不能隐式猜测验收身份', () => {
  assert.throws(() => parseVerificationArguments([]), /expected-commit/);
  assert.throws(() => parseVerificationArguments(['--strict']), /expected-commit/);
  assert.deepEqual(parseVerificationArguments(['--expected-commit', exampleIdentity.commit]), {
    mode: 'local', strict: false, evidencePath: undefined, expectedCommit: exampleIdentity.commit, candidateAliases: [], githubCommit: undefined
  });
  const local = parseVerificationArguments(['--mode', 'local', '--strict', '--expected-commit', exampleIdentity.commit]);
  assert.equal(local.strict, true);
  assert.equal(local.mode, 'local');
  const ci = parseVerificationArguments(['--mode', 'ci', '--expected-commit', exampleIdentity.commit]);
  assert.equal(ci.mode, 'ci');
  assert.equal(ci.strict, false);
  assert.throws(() => parseVerificationArguments(['--mode', 'ci']), /expected-commit/);
  assert.throws(() => parseVerificationArguments(['--mode', 'ci', '--expected-commit', 'short']), /完整/);
  assert.throws(() => parseVerificationArguments(['--mode', 'ci', '--strict']), /不接受/);
  assert.throws(() => parseVerificationArguments(['--mode', 'ci', '--evidence', '/old-local-evidence.json']), /不接受/);
  assert.throws(() => parseVerificationArguments(['--mode', 'unknown']), /local 或 ci/);
});

test('CI 不依赖本机 refs 或分支名，但错误真实 HEAD 与 dirty 源码必须失败', () => {
  const input = { mode: 'ci', manifest, branches: [], currentBranch: '', expectedCommit: exampleIdentity.commit, commit: exampleIdentity.commit, dirty: false };
  assert.deepEqual(inspectModeConstraints(input), []);
  assert.match(inspectModeConstraints({ ...input, commit: 'f'.repeat(40) }).join(' '), /真实 Git HEAD/);
  assert.match(inspectModeConstraints({ ...input, dirty: true }).join(' '), /干净且已提交/);
  assert.match(inspectModeConstraints({ ...input, expectedCommit: undefined }).join(' '), /expected-commit/);
  assert.match(inspectModeConstraints({ ...input, mode: 'local', currentBranch: candidateBranch }).join(' '), /分支发生变化或缺失/);
  assert.deepEqual(verifyExpectedCommit(undefined, exampleIdentity.commit), []);
  assert.notDeepEqual(verifyExpectedCommit(exampleIdentity.commit, 'f'.repeat(40)), []);
});

test('GitHub 映射只能附加到有实际证据的 local strict，不能让 CI 冒充本机验收', () => {
  const args = ['--expected-commit', exampleIdentity.commit, '--github-commit', 'c'.repeat(40)];
  assert.throws(() => parseVerificationArguments(args), /local --strict/);
  assert.throws(() => parseVerificationArguments([...args, '--strict']), /实际证据/);
  assert.throws(() => parseVerificationArguments([...args, '--mode', 'ci']), /local --strict/);
  assert.throws(() => parseVerificationArguments(['--mode', 'ci', '--expected-commit', exampleIdentity.commit, '--candidate-alias', 'work/alias']), /不接受/);
  const parsed = parseVerificationArguments([...args, '--strict', '--evidence', '/external/evidence.json', '--candidate-alias', 'work/alias']);
  assert.equal(parsed.githubCommit, 'c'.repeat(40));
  assert.deepEqual(parsed.candidateAliases, ['work/alias']);
});

test('只从受控仓库声明读取 GitHub 身份；Git tree 使用 NUL 分隔保留完整文件名', () => {
  assert.equal(githubRepositoryFromPackage({ repository: { url: 'git+https://github.com/owner/repo.git' } }), 'owner/repo');
  for (const url of ['https://elsewhere/owner/repo', 'git+https://token@github.com/owner/repo.git', 'git+https://github.com/owner/repo.git?token=x']) {
    assert.throws(() => githubRepositoryFromPackage({ repository: { url } }), /明确声明/);
  }
  assert.deepEqual(parseLocalTree('100644 blob ' + 'd'.repeat(40) + '\t中文\nfile.md\0'), [
    { mode: '100644', type: 'blob', sha: 'd'.repeat(40), path: '中文\nfile.md' }
  ]);
  assert.throws(() => parseLocalTree('invalid'), /无法解析/);
});

test('只读 main 映射允许不同提交相同源码，但仍逐项核对 tree 和并发 main', async () => {
  const main = 'c'.repeat(40);
  const entries = [{ path: 'AGENTS.md', mode: '100644', type: 'blob', sha: 'd'.repeat(40) }];
  const fixture = () => [
    { object: { type: 'commit', sha: main } },
    { sha: main, tree: { sha: exampleIdentity.headTreeHash } },
    { sha: exampleIdentity.headTreeHash, truncated: false, tree: structuredClone(entries) },
    { object: { type: 'commit', sha: main } }
  ];
  const run = async (responses, calls = []) => verifyGithubMainMapping({
    repository: 'owner/repo', expectedGithubCommit: main, identity: exampleIdentity, localEntries: entries,
    readJson: async (endpoint) => { calls.push(endpoint); return responses.shift(); }
  });
  const calls = [];
  const result = await run(fixture(), calls);
  assert.equal(result.status, 'PASS');
  assert.equal(result.localCommit, exampleIdentity.commit);
  assert.equal(result.githubMainCommit, main);
  assert.equal(result.published, false);
  assert.deepEqual(calls, [
    'repos/owner/repo/git/ref/heads/main', 'repos/owner/repo/git/commits/' + main,
    'repos/owner/repo/git/trees/' + exampleIdentity.headTreeHash + '?recursive=1', 'repos/owner/repo/git/ref/heads/main'
  ]);
  const cases = [
    (rows) => { rows[0].object.sha = 'f'.repeat(40); },
    (rows) => { rows[1].tree.sha = 'f'.repeat(40); },
    (rows) => { rows[2].truncated = true; },
    (rows) => { rows[2].tree[0].path = 'renamed.md'; },
    (rows) => { rows[2].tree[0].mode = '100755'; },
    (rows) => { rows[2].tree[0].sha = 'f'.repeat(40); },
    (rows) => { rows[2].tree.push(rows[2].tree[0]); },
    (rows) => { rows[3].object.sha = 'f'.repeat(40); }
  ];
  for (const mutate of cases) {
    const rows = fixture(); mutate(rows);
    await assert.rejects(run(rows));
  }
  await assert.rejects(verifyGithubMainMapping({
    repository: 'owner/repo', expectedGithubCommit: main, identity: exampleIdentity, localEntries: entries,
    readJson: async () => { throw new Error('read denied'); }
  }), /read denied/);
});

test('CI 静态通过永不宣称本机行为验收或发布；缺锚点与过期构建均拒绝', () => {
  const pass = evaluateCiGate({ staticErrors: [] });
  assert.equal(pass.ok, true);
  assert.equal(pass.ciStaticAudit, 'PASS');
  assert.equal(pass.localAudit, 'NOT_APPLICABLE');
  assert.equal(pass.behaviorEvidence, 'NOT_RUN_BY_THIS_SCRIPT');
  for (const name of ['candidateValidated', 'releaseReady', 'published']) assert.equal(pass[name], false);
  assert.equal(evaluateCiGate({ staticErrors: ['缺少导入状态源码锚点'] }).ok, false);
  const staleBuild = { commitSha: 'f'.repeat(40), dirty: false, scopeVersion: 1, fingerprints: exampleIdentity.fingerprints };
  assert.equal(evaluateCiGate({ staticErrors: [], buildErrors: verifyBuildIdentity(exampleIdentity, staleBuild) }).ok, false);
  assert.equal(evaluateGate({ staticErrors: [], evidence: noEvidence, strict: true, dirty: false }).ok, false);
});

test('未提交旧 identity 不能在提交后换标签复用，即使三类内容指纹相同', async (t) => {
  const root = await tempDirectory(t, 'committed-identity');
  const old = { ...exampleIdentity, commit: '8a52c7760032167d86b26f36b045a849a6b0569f', headTreeHash: 'f'.repeat(40) };
  const committed = { ...exampleIdentity, commit: manifest.sourceCandidate.commit, headTreeHash: manifest.sourceCandidate.headTreeHash };
  assert.deepEqual(old.fingerprints, committed.fingerprints);
  assert.equal(identityMatches(committed, old), false);
  const result = await verifyEvidence(manifest, committed, { schemaVersion: 1, identity: old, checks: [] }, root);
  assert.equal(result.status, 'FAIL');
  assert.match(result.errors.join(' '), /不是当前候选内容/);
  assert.equal(result.errors.filter((error) => error.startsWith('缺少实际测试证据')).length, 11);
});
