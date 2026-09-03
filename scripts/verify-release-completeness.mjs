import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { lstat, readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { LEGACY_OZON_SKIPS, parsePlaywrightReport, parseTestLog } from './ci-evidence-contract.mjs';
import {
  collectLocalContentSnapshot,
  readFingerprintScopeContract,
  summarizeContentSnapshot
} from '../apps/server/src/services/content-fingerprint.ts';

export const MANIFEST_PATH = 'config/release-features.json';
export const REQUIRED_FEATURE_IDS = [
  'core-deployment', 'local-import-and-name-validation', 'purchase-product-query', 'purchase-url-query',
  'about-fingerprints', 'github-readonly-access', 'github-token-self-service', 'local-import-directory-status',
  'review-open-product-folder', 'wb-restart-protection', 'junction-retirement', 'project-release-guardrails'
];
export const REQUIRED_LOCAL_CHECK_IDS = [
  'check', 'postgres-integration', 'e2e', 'jimeng', 'deployment-verify', 'gitleaks', 'diff-check',
  'release-verifier-tests', 'restart-safety', 'retirement-safety', 'isolated-runtime'
];
const scopes = ['runtime', 'documentation', 'verification'];
const sha256 = (value) => createHash('sha256').update(value).digest('hex');

function git(root, args) {
  return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', windowsHide: true, maxBuffer: 32 * 1024 * 1024 }).trim();
}

export function validateManifest(manifest) {
  const errors = [];
  if (manifest?.schemaVersion !== 1) errors.push('功能台账版本必须为 1');
  if (!/^[0-9a-f]{40}$/i.test(manifest?.baseline?.commit || '')) errors.push('台账缺少明确本机基线');
  if (!manifest?.policy?.currentBranch?.startsWith('work/')) errors.push('台账缺少独立候选分支');
  for (const name of ['branches', 'features', 'requiredChecks']) {
    if (!Array.isArray(manifest?.[name]) || !manifest[name].length) errors.push('台账集合为空：' + name);
  }
  if (errors.length) return errors;
  const features = new Set(manifest.features.map((item) => item.id));
  const checks = new Set(manifest.requiredChecks.map((item) => item.id));
  for (const id of REQUIRED_FEATURE_IDS) if (!features.has(id)) errors.push('缺少必须保留的功能：' + id);
  for (const id of REQUIRED_LOCAL_CHECK_IDS) if (!checks.has(id)) errors.push('缺少本机严格检查：' + id);
  if (features.size !== manifest.features.length || checks.size !== manifest.requiredChecks.length) errors.push('功能或检查 ID 重复');
  if (new Set(manifest.branches.map((item) => item.name)).size !== manifest.branches.length) errors.push('审计分支重复');
  for (const branch of manifest.branches) {
    if (!features.has(branch.featureId) || !/^[0-9a-f]{40}$/i.test(branch.head || '')) errors.push('分支未关联有效功能和提交：' + branch.name);
  }
  if (!manifest.sourceCandidate?.branch?.startsWith('work/')
    || !/^[0-9a-f]{40}$/i.test(manifest.sourceCandidate?.commit || '')
    || !/^[0-9a-f]{40}$/i.test(manifest.sourceCandidate?.headTreeHash || '')
    || !manifest.branches.some((branch) => branch.name === manifest.sourceCandidate.branch && branch.head === manifest.sourceCandidate.commit)) {
    errors.push('缺少已提交阶段 1 候选及其审计分支身份');
  }
  for (const feature of manifest.features) {
    if (!['PRESERVE', 'INTEGRATE'].includes(feature.action)) errors.push('功能处理方式无效：' + feature.id);
    if (!feature.sourceChecks?.length || !feature.checkIds?.length || feature.checkIds.some((id) => !checks.has(id))) errors.push('功能缺少源码锚点或行为检查：' + feature.id);
    for (const check of feature.sourceChecks || []) {
      if (!check.path || path.isAbsolute(check.path) || check.path.includes('\\') || check.path.split('/').includes('..')) errors.push('源码锚点必须是仓库内相对路径：' + feature.id);
    }
  }
  return errors;
}

export function compareBranchInventory(manifest, liveBranches, currentBranch) {
  const errors = [];
  if (currentBranch !== manifest.policy.currentBranch || currentBranch === 'main') errors.push('当前分支不是台账绑定的独立候选');
  const expected = new Map(manifest.branches.map((item) => [item.name, item.head]));
  const actual = new Map(liveBranches.map((item) => [item.name, item.head]));
  for (const [name, head] of expected) {
    if (actual.get(name) !== head) errors.push('已审计分支发生变化或缺失，需重新审计：' + name);
  }
  for (const name of actual.keys()) {
    if (name !== currentBranch && !expected.has(name)) errors.push('发现未纳入台账的本机分支：' + name);
  }
  return errors;
}

export async function collectContentIdentity(root) {
  const contract = await readFingerprintScopeContract(root);
  const summary = summarizeContentSnapshot(await collectLocalContentSnapshot(root, contract));
  return {
    ...summary,
    scopeContractSha256: sha256(await readFile(path.join(root, 'config/content-fingerprint-scope.json'))),
    agentsSha256: sha256(await readFile(path.join(root, 'AGENTS.md'))),
    featureManifestSha256: sha256(await readFile(path.join(root, MANIFEST_PATH)))
  };
}

export async function inspectFeatureSources(root, manifest) {
  const results = [];
  for (const feature of manifest.features) {
    const missing = [];
    for (const check of feature.sourceChecks) {
      try {
        const file = path.join(root, check.path);
        if (!(await lstat(file)).isFile()) throw new Error('不是普通文件');
        if (check.includes?.length) {
          const source = await readFile(file, 'utf8');
          for (const value of check.includes) if (!source.includes(value)) missing.push(check.path + ' 缺少源码锚点 ' + value);
        }
      } catch {
        missing.push(check.path + ' 不可读取');
      }
    }
    if (feature.sourceDocumentSha256) {
      try {
        if (sha256(await readFile(path.join(root, 'AGENTS.md'))) !== feature.sourceDocumentSha256) missing.push('AGENTS.md 与已批准的来源规则文件 SHA-256 不一致');
      } catch {
        missing.push('AGENTS.md 来源规则哈希不可验证');
      }
    }
    results.push({ id: feature.id, action: feature.action, sourceAnchors: missing.length ? 'FAIL' : 'PASS', behavior: 'NOT_RUN_BY_THIS_SCRIPT', missing });
  }
  return results;
}

export function identityMatches(expected, actual) {
  if (!expected || !actual) return false;
  return ['commit', 'headTreeHash', 'scopeVersion', 'scopeContractSha256', 'agentsSha256', 'featureManifestSha256']
    .every((key) => expected[key] === actual[key])
    && scopes.every((scope) => expected.fingerprints?.[scope] === actual.fingerprints?.[scope]);
}

function isOutside(root, target) {
  const relative = path.relative(root, target);
  return relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative);
}

function inspectPlaywrightList(text, summary) {
  const problems = [];
  const entries = [];
  const skippedTitles = new Set();
  for (const line of text.split(/\r?\n/)) {
    const row = line.match(/^\s*(ok|✓|√|-)\s+(\d+)\s+\[[^\]]+\]\s+›\s+(.+?\.spec\.[cm]?[jt]sx?):\d+:\d+\s+›\s+(.+?)\s*$/);
    if (!row) continue;
    const [, marker, number, rawFile, fullTitle] = row;
    const file = rawFile.replaceAll('\\', '/');
    const skipped = marker === '-';
    const title = fullTitle.split(' › ').at(-1);
    entries.push({ number, skipped });
    if (skipped) {
      if (file !== 'tests/e2e/ozon-listing.spec.ts' || !LEGACY_OZON_SKIPS.includes(title) || skippedTitles.has(title)) {
        problems.push('E2E 含未批准或重复的跳过用例');
      }
      skippedTitles.add(title);
    } else if (!/\s+\([\d.]+(?:ms|s|m|h)\)$/.test(fullTitle)) {
      problems.push('E2E 用例缺少实际完成记录');
    }
  }
  const announced = [...text.matchAll(/^\s*Running\s+(\d+)\s+tests?\s+using\s+\d+\s+workers?\s*$/gm)];
  if (announced.length !== 1 || Number(announced[0]?.[1]) !== entries.length
    || new Set(entries.map((entry) => entry.number)).size !== entries.length
    || entries.filter((entry) => !entry.skipped).length !== summary.passed
    || entries.filter((entry) => entry.skipped).length !== summary.skipped || summary.failed !== 0) {
    problems.push('E2E 缺少完整逐用例记录，或逐项结果与汇总不一致');
  }
  return problems;
}

export function inspectValidationLog(id, command, log, { playwrightReport, platform = process.platform } = {}) {
  const patterns = {
    check: /npm(?:-cli\.js|\.cmd)?["']?\s+run\s+check(?:\s|$)/i,
    'postgres-integration': /vitest\.mjs["']?\s+run\s+\.integration\.test\.ts(?:\s|$)/i,
    e2e: /npm(?:-cli\.js|\.cmd)?["']?\s+run\s+test:e2e(?:\s|$)/i,
    jimeng: /npm(?:-cli\.js|\.cmd)?["']?\s+run\s+jimeng:test(?:\s|$)/i,
    'deployment-verify': /npm(?:-cli\.js|\.cmd)?["']?\s+run\s+deployment:verify(?:\s|$)/i,
    gitleaks: /gitleaks(?:\.exe)?(?:["']|\s|$)/i,
    'diff-check': /^git(?:\.exe)?\s+diff\s+--check(?:\s|$)/i,
    'release-verifier-tests': /--test\s+scripts[\\/]verify-release-completeness\.test\.mjs(?:\s|$)/i,
    'restart-safety': /test-restart-windows-safety\.ps1(?:["']|\s|$)/i,
    'retirement-safety': /test-retire-n8n-global-junction-safety\.ps1(?:["']|\s|$)/i,
    'isolated-runtime': /isolated-runtime[^\s]*\.(?:mjs|cjs|js|ts)(?:["']|\s|$)/i
  };
  const problems = [];
  if (!patterns[id]?.test(command || '') || /^\s*(?:echo|printf|Write-Output)\b/i.test(command)) problems.push('实际命令与检查 ID 不符');
  const text = log.replace(new RegExp(String.fromCharCode(27) + '\\[[0-?]*[ -/]*[@-~]', 'g'), '');
  const summary = { passed: 0, failed: 0, skipped: 0 };
  let recognized = false;
  for (const line of text.split(/\r?\n/)) {
    if (/^\s*#\s+(?:todo|cancelled)\s+[1-9]\d*\s*$/i.test(line) || /^\s*(?:not )?ok\b.*#\s+TODO\b/i.test(line)
      || (/^\s*Tests\s+/.test(line) && /[1-9]\d*\s+(?:todo|pending|cancelled)/i.test(line))
      || /^\s*[1-9]\d*\s+(?:interrupted|flaky|did not run)\b/i.test(line)) problems.push('存在 TODO、取消或未完整执行的测试');
    const tap = line.match(/^\s*#\s+(pass|fail|skipped)\s+(\d+)\s*$/);
    if (tap) {
      summary[tap[1] === 'pass' ? 'passed' : tap[1] === 'fail' ? 'failed' : 'skipped'] += Number(tap[2]);
      recognized = true;
    }
    if (/^\s*Tests\s+/.test(line)) {
      for (const item of line.matchAll(/(\d+)\s+(passed|failed|skipped)/g)) summary[item[2]] += Number(item[1]);
      recognized = true;
    }
    const playwright = line.match(/^\s*(\d+)\s+(passed|failed|skipped)(?:\s+\(|\s*$)/);
    if (playwright) { summary[playwright[2]] += Number(playwright[1]); recognized = true; }
  }
  if (['check', 'postgres-integration', 'e2e', 'jimeng', 'release-verifier-tests'].includes(id)) {
    if (!recognized || summary.passed < 1 || summary.failed > 0) problems.push('日志没有实际通过用例，存在失败，或整套测试被跳过');
  }
  if (['check', 'postgres-integration', 'jimeng', 'release-verifier-tests'].includes(id)) {
    const parsed = parseTestLog(text, { id, platform });
    problems.push(...parsed.problems);
    const skips = parsed.summary.allowedSkips.map(({ file = '', title }) => file + ':' + title);
    if (new Set(skips).size !== skips.length) problems.push('同一已批准跳过用例重复出现');
  }
  if (id === 'e2e') {
    if (playwrightReport !== undefined) {
      const parsed = parsePlaywrightReport(playwrightReport, text);
      problems.push(...parsed.problems);
      if (['passed', 'failed', 'skipped'].some((key) => summary[key] !== parsed.summary[key])) {
        problems.push('E2E JSON 逐用例结果与日志汇总不一致');
      }
    } else problems.push(...inspectPlaywrightList(text, summary));
  }
  if (id === 'e2e' && /^\[WebServer\]\s+(?:Node\.js v\d|npm (?:error|ERR!)\b|(?:Unhandled|uncaught)\b)/im.test(text)) {
    problems.push('E2E 测试服务异常退出；即使用例汇总通过也不能作为验收证据');
  }
  if (['restart-safety', 'retirement-safety'].includes(id) && !/"ok"\s*:\s*true/.test(text)) problems.push('缺少安全测试成功结果');
  if (id === 'isolated-runtime') {
    const passed = text.match(/"assertionsPassed"\s*:\s*(\d+)/);
    const failed = text.match(/"assertionsFailed"\s*:\s*(\d+)/);
    if (!passed || Number(passed[1]) < 1 || !failed || Number(failed[1]) !== 0) problems.push('缺少隔离运行实际断言成功汇总');
  }
  return { problems, summary: recognized ? summary : undefined };
}

export async function verifyEvidence(manifest, identity, evidence, root, now = Date.now()) {
  if (!evidence) return { status: 'NOT_PROVIDED', errors: [], checks: [] };
  const errors = [];
  if (evidence.schemaVersion !== 1) errors.push('测试证据版本必须为 1');
  if (!identityMatches(identity, evidence.identity)) errors.push('测试证据不是当前候选内容；提交、三类指纹、规则及范围哈希必须全部匹配');
  if (!Array.isArray(evidence.checks)) return { status: 'FAIL', errors: [...errors, '缺少测试证据列表'], checks: [] };
  const seen = new Set();
  const required = new Set(manifest.requiredChecks.map((item) => item.id));
  const checks = [];
  for (const check of evidence.checks) {
    const problems = [];
    let summary;
    if (!required.has(check.id) || seen.has(check.id)) problems.push('未知或重复的检查 ID');
    seen.add(check.id);
    if (check.exitCode !== 0 || !check.command?.trim()) problems.push('缺少成功退出码或实际执行命令');
    const completedAt = Date.parse(check.completedAt);
    if (!Number.isFinite(completedAt) || completedAt > now + 300000) problems.push('完成时间无效或位于未来');
    try {
      if (!path.isAbsolute(check.logPath || '') || !isOutside(root, path.resolve(check.logPath))) throw new Error('日志必须位于仓库外');
      const file = await lstat(check.logPath);
      if (!file.isFile() || file.size === 0) throw new Error('日志为空或不是普通文件');
      const content = await readFile(check.logPath);
      if (!/^[0-9a-f]{64}$/i.test(check.logSha256 || '') || sha256(content) !== check.logSha256.toLowerCase()) throw new Error('日志哈希不匹配');
      let playwrightReport;
      if (check.id === 'e2e' && (check.playwrightReportPath !== undefined || check.playwrightReportSha256 !== undefined)) {
        if (!path.isAbsolute(check.playwrightReportPath || '') || !isOutside(root, path.resolve(check.playwrightReportPath))) throw new Error('E2E JSON 报告必须位于仓库外');
        const reportInfo = await lstat(check.playwrightReportPath);
        if (!reportInfo.isFile() || reportInfo.size === 0) throw new Error('E2E JSON 报告为空或不是普通文件');
        const reportBytes = await readFile(check.playwrightReportPath);
        if (!/^[0-9a-f]{64}$/i.test(check.playwrightReportSha256 || '') || sha256(reportBytes) !== check.playwrightReportSha256.toLowerCase()) throw new Error('E2E JSON 报告哈希不匹配');
        playwrightReport = JSON.parse(reportBytes.toString('utf8'));
      }
      const validation = inspectValidationLog(check.id, check.command, content.toString('utf8'), { playwrightReport });
      problems.push(...validation.problems);
      summary = validation.summary;
    } catch (error) {
      problems.push(error.message);
    }
    checks.push({ id: check.id, status: problems.length ? 'FAIL' : 'PASS', summary, problems });
    errors.push(...problems.map((problem) => check.id + '：' + problem));
  }
  for (const id of required) if (!seen.has(id)) errors.push('缺少实际测试证据：' + id);
  return { status: errors.length ? 'FAIL' : 'PASS', errors, checks };
}

export function verifyBuildIdentity(identity, buildInfo) {
  if (!buildInfo) return ['缺少构建信息；先从候选生成生产产物'];
  const errors = [];
  if (buildInfo.commitSha !== identity.commit || buildInfo.scopeVersion !== identity.scopeVersion) errors.push('构建提交或范围版本与候选不匹配');
  if (buildInfo.dirty !== false) errors.push('严格检查要求产物从已提交干净候选构建');
  if (!scopes.every((scope) => buildInfo.fingerprints?.[scope] === identity.fingerprints[scope])) errors.push('构建三类指纹与候选不匹配');
  return errors;
}

export function evaluateGate({ staticErrors, evidence, strict, dirty, buildErrors = [] }) {
  const errors = [...staticErrors, ...evidence.errors];
  if (strict) {
    if (dirty) errors.push('严格检查要求干净且已提交的候选；阶段 1 不自动提交');
    if (evidence.status !== 'PASS') errors.push('严格检查要求完整、同身份的实际测试证据');
    errors.push(...buildErrors);
  }
  return {
    ok: errors.length === 0,
    errors,
    staticAudit: staticErrors.length ? 'FAIL' : 'PASS',
    behaviorEvidence: evidence.status,
    candidateValidated: errors.length === 0 && evidence.status === 'PASS',
    releaseReady: Boolean(strict && errors.length === 0),
    published: false
  };
}

export function verifyExpectedCommit(expectedCommit, actualCommit, required = false) {
  if (expectedCommit === undefined && !required) return [];
  if (!/^[0-9a-f]{40}$/i.test(expectedCommit || '')) return ['CI 检查必须显式提供有效的 --expected-commit，其他模式提供时也必须是完整 SHA'];
  return expectedCommit.toLowerCase() === actualCommit ? [] : ['真实 Git HEAD 与 --expected-commit 不匹配，拒绝环境覆盖或旧提交身份'];
}

export function inspectModeConstraints({ mode = 'local', manifest, branches = [], currentBranch, expectedCommit, commit, dirty }) {
  if (!['local', 'ci'].includes(mode)) throw new Error('mode 只能为 local 或 ci');
  const errors = verifyExpectedCommit(expectedCommit, commit, mode === 'ci');
  if (mode === 'local') errors.push(...compareBranchInventory(manifest, branches, currentBranch));
  else if (dirty) errors.push('CI 静态检查要求干净且已提交的源码');
  return errors;
}

export function evaluateCiGate({ staticErrors, buildErrors = [] }) {
  const errors = [...staticErrors, ...buildErrors];
  return {
    ok: errors.length === 0,
    errors,
    staticAudit: errors.length ? 'FAIL' : 'PASS',
    ciStaticAudit: errors.length ? 'FAIL' : 'PASS',
    localAudit: 'NOT_APPLICABLE',
    behaviorEvidence: 'NOT_RUN_BY_THIS_SCRIPT',
    candidateValidated: false,
    releaseReady: false,
    published: false
  };
}

export async function runVerification({ root = process.cwd(), evidencePath, strict = false, mode = 'local', expectedCommit } = {}) {
  if (!['local', 'ci'].includes(mode)) throw new Error('mode 只能为 local 或 ci');
  if (mode === 'ci' && (strict || evidencePath)) throw new Error('CI 静态模式不接受 --strict 或本机 --evidence；不能冒充本机完整验收');
  root = path.resolve(root);
  const manifest = JSON.parse(await readFile(path.join(root, MANIFEST_PATH), 'utf8'));
  const manifestErrors = validateManifest(manifest);
  if (manifestErrors.length) throw new Error(manifestErrors.join('; '));
  const commit = git(root, ['rev-parse', 'HEAD']);
  const headTreeHash = git(root, ['rev-parse', 'HEAD^{tree}']);
  const currentBranch = git(root, ['branch', '--show-current']);
  const dirty = Boolean(git(root, ['status', '--porcelain=v1', '--untracked-files=all']));
  const branches = mode === 'local' ? git(root, ['for-each-ref', '--format=%(refname:short)|%(objectname)', 'refs/heads'])
    .split(/\r?\n/).filter(Boolean).map((line) => { const [name, head] = line.split('|'); return { name, head }; }) : [];
  const staticErrors = inspectModeConstraints({ mode, manifest, branches, currentBranch, expectedCommit, commit, dirty });
  if (mode === 'local') {
    for (const [source, label] of [[manifest.baseline.commit, '用户授权的本机重建基线'], [manifest.sourceCandidate.commit, '已提交阶段 1 完整候选']]) {
      try { git(root, ['merge-base', '--is-ancestor', source, commit]); }
      catch { staticErrors.push('候选没有继承' + label); }
    }
    try {
      if (git(root, ['rev-parse', `${manifest.sourceCandidate.commit}^{tree}`]) !== manifest.sourceCandidate.headTreeHash) {
        staticErrors.push('已提交阶段 1 候选 tree 与台账不一致');
      }
    } catch { staticErrors.push('已提交阶段 1 候选 tree 无法读取'); }
  }
  const identity = { commit, headTreeHash, ...await collectContentIdentity(root) };
  const features = await inspectFeatureSources(root, manifest);
  for (const feature of features) staticErrors.push(...feature.missing.map((missing) => feature.id + '：' + missing));
  if (evidencePath && (!path.isAbsolute(evidencePath) || !isOutside(root, path.resolve(evidencePath)))) {
    throw new Error('测试证据 JSON 必须使用仓库外的绝对路径');
  }
  const suppliedEvidence = evidencePath ? JSON.parse(await readFile(evidencePath, 'utf8')) : undefined;
  const evidence = mode === 'local' ? await verifyEvidence(manifest, identity, suppliedEvidence, root) : { status: 'NOT_RUN_BY_THIS_SCRIPT', errors: [], checks: [] };
  let buildInfo;
  let buildPresent = false;
  const buildErrors = [];
  if (strict || mode === 'ci') {
    try {
      const buildPath = path.join(root, 'apps/server/dist/build-info.json');
      const info = await lstat(buildPath).catch((error) => { if (error.code === 'ENOENT') return undefined; throw error; });
      if (info) {
        buildPresent = true;
        if (!info.isFile()) throw new Error('构建信息不是普通文件');
        buildInfo = JSON.parse(await readFile(buildPath, 'utf8'));
      }
    } catch { buildErrors.push('构建信息存在但不可读取或格式无效'); }
    if (strict || buildPresent) buildErrors.push(...verifyBuildIdentity(identity, buildInfo));
  }
  const finalIdentity = {
    commit: git(root, ['rev-parse', 'HEAD']),
    headTreeHash: git(root, ['rev-parse', 'HEAD^{tree}']),
    ...await collectContentIdentity(root)
  };
  if (!identityMatches(identity, finalIdentity)
    || currentBranch !== git(root, ['branch', '--show-current'])
    || dirty !== Boolean(git(root, ['status', '--porcelain=v1', '--untracked-files=all']))) {
    staticErrors.push('候选内容或工作树在检查期间变化；冻结并发修改后重新验证');
  }
  const localGate = mode === 'local' ? evaluateGate({ staticErrors, evidence, strict, dirty, buildErrors }) : undefined;
  const gate = mode === 'ci' ? evaluateCiGate({ staticErrors, buildErrors }) : { ...localGate, localAudit: localGate.ok ? 'PASS' : 'FAIL' };
  return {
    schemaVersion: 1,
    candidateId: manifest.candidateId,
    mode,
    auditKind: mode === 'ci' ? 'PORTABLE_CI_STATIC_CHECK' : strict ? 'STRICT_PRE_RELEASE_CHECK' : 'DRAFT_CANDIDATE_CHECK',
    checkedAt: new Date().toISOString(),
    currentBranch,
    dirty,
    auditedBranchCount: mode === 'local' ? manifest.branches.length : 0,
    declaredBranchCount: manifest.branches.length,
    expectedCommit: expectedCommit?.toLowerCase(),
    buildAudit: buildErrors.length ? 'FAIL' : strict || buildPresent ? 'PASS' : mode === 'ci' ? 'NOT_PROVIDED' : 'NOT_CHECKED',
    identity,
    ...gate,
    features,
    checks: evidence.checks,
    notices: [
      ...(mode === 'ci' ? [
        '本次只执行可移植 CI 静态检查；本机分支/旧祖先/外部行为证据审计未执行（localAudit=NOT_APPLICABLE）。',
        'CI 静态通过不等于真实 CI 作业全部通过；真实作业证据由独立 CI gate 汇总，本机候选验收仍须 local --strict。'
      ] : []),
      '源码锚点只是静态完整性检查，不代表功能行为通过；本脚本不执行测试。',
      '外部测试日志须来自本次真实执行，哈希绑定不能代替人工确认测试隔离和检查内容。',
      '本脚本不提交、不拉取、不推送、不集成、不重启服务、不修改启动入口。',
      'releaseReady 仅表示本机严格候选门禁通过，不授予发布权限，也不表示本机或 GitHub 已上线。'
    ]
  };
}

export function parseVerificationArguments(args) {
  let strict = false;
  let evidencePath;
  let mode = 'local';
  let expectedCommit;
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === '--strict') strict = true;
    else if (args[index] === '--evidence' && args[index + 1]) evidencePath = path.resolve(args[++index]);
    else if (args[index] === '--mode' && args[index + 1]) mode = args[++index];
    else if (args[index] === '--expected-commit' && args[index + 1]) expectedCommit = args[++index];
    else throw new Error('用法：node --import tsx scripts/verify-release-completeness.mjs [--mode local|ci] [--expected-commit <SHA>] [--evidence <仓库外文件>] [--strict]');
  }
  if (!['local', 'ci'].includes(mode)) throw new Error('mode 只能为 local 或 ci');
  if (mode === 'ci' && (strict || evidencePath)) throw new Error('CI 静态模式不接受 --strict 或本机 --evidence');
  if ((mode === 'ci' || expectedCommit !== undefined) && !/^[0-9a-f]{40}$/i.test(expectedCommit || '')) {
    throw new Error('必须显式提供有效的完整 --expected-commit SHA');
  }
  return { strict, evidencePath, mode, expectedCommit };
}

async function main() {
  const report = await runVerification(parseVerificationArguments(process.argv.slice(2)));
  console.log(JSON.stringify(report, null, 2));
  if (!report.ok) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error('候选完整性检查失败：' + error.message);
    process.exitCode = 1;
  });
}
