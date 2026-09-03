import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { lstat, readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  collectLocalContentSnapshot,
  readFingerprintScopeContract,
  summarizeContentSnapshot
} from '../apps/server/src/services/content-fingerprint.ts';

export const MANIFEST_PATH = 'config/release-features.json';
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
  if (features.size !== manifest.features.length || checks.size !== manifest.requiredChecks.length) errors.push('功能或检查 ID 重复');
  if (new Set(manifest.branches.map((item) => item.name)).size !== manifest.branches.length) errors.push('审计分支重复');
  for (const branch of manifest.branches) {
    if (!features.has(branch.featureId) || !/^[0-9a-f]{40}$/i.test(branch.head || '')) errors.push('分支未关联有效功能和提交：' + branch.name);
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

export function inspectValidationLog(id, command, log) {
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
      const validation = inspectValidationLog(check.id, check.command, content.toString('utf8'));
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

export async function runVerification({ root = process.cwd(), evidencePath, strict = false } = {}) {
  root = path.resolve(root);
  const manifest = JSON.parse(await readFile(path.join(root, MANIFEST_PATH), 'utf8'));
  const manifestErrors = validateManifest(manifest);
  if (manifestErrors.length) throw new Error(manifestErrors.join('; '));
  const commit = git(root, ['rev-parse', 'HEAD']);
  const headTreeHash = git(root, ['rev-parse', 'HEAD^{tree}']);
  const currentBranch = git(root, ['branch', '--show-current']);
  const dirty = Boolean(git(root, ['status', '--porcelain=v1', '--untracked-files=all']));
  const branches = git(root, ['for-each-ref', '--format=%(refname:short)|%(objectname)', 'refs/heads'])
    .split(/\r?\n/).filter(Boolean).map((line) => { const [name, head] = line.split('|'); return { name, head }; });
  const staticErrors = compareBranchInventory(manifest, branches, currentBranch);
  try {
    git(root, ['merge-base', '--is-ancestor', manifest.baseline.commit, commit]);
  } catch {
    staticErrors.push('候选没有继承用户授权的本机重建基线');
  }
  const identity = { commit, headTreeHash, ...await collectContentIdentity(root) };
  const features = await inspectFeatureSources(root, manifest);
  for (const feature of features) staticErrors.push(...feature.missing.map((missing) => feature.id + '：' + missing));
  if (evidencePath && (!path.isAbsolute(evidencePath) || !isOutside(root, path.resolve(evidencePath)))) {
    throw new Error('测试证据 JSON 必须使用仓库外的绝对路径');
  }
  const suppliedEvidence = evidencePath ? JSON.parse(await readFile(evidencePath, 'utf8')) : undefined;
  const evidence = await verifyEvidence(manifest, identity, suppliedEvidence, root);
  let buildInfo;
  if (strict) {
    try { buildInfo = JSON.parse(await readFile(path.join(root, 'apps/server/dist/build-info.json'), 'utf8')); }
    catch { /* evaluateGate reports the missing build without starting anything. */ }
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
  const gate = evaluateGate({ staticErrors, evidence, strict, dirty, buildErrors: strict ? verifyBuildIdentity(identity, buildInfo) : [] });
  return {
    schemaVersion: 1,
    candidateId: manifest.candidateId,
    mode: strict ? 'STRICT_PRE_RELEASE_CHECK' : 'DRAFT_CANDIDATE_CHECK',
    checkedAt: new Date().toISOString(),
    currentBranch,
    dirty,
    auditedBranchCount: manifest.branches.length,
    identity,
    ...gate,
    features,
    checks: evidence.checks,
    notices: [
      '源码锚点只是静态完整性检查，不代表功能行为通过；本脚本不执行测试。',
      '外部测试日志须来自本次真实执行，哈希绑定不能代替人工确认测试隔离和检查内容。',
      '本脚本不提交、不拉取、不推送、不集成、不重启服务、不修改启动入口。',
      'releaseReady 仅表示本机严格候选门禁通过，不授予发布权限，也不表示本机或 GitHub 已上线。'
    ]
  };
}

async function main() {
  const args = process.argv.slice(2);
  let strict = false;
  let evidencePath;
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === '--strict') strict = true;
    else if (args[index] === '--evidence' && args[index + 1]) evidencePath = path.resolve(args[++index]);
    else throw new Error('用法：node --import tsx scripts/verify-release-completeness.mjs [--evidence <仓库外文件>] [--strict]');
  }
  const report = await runVerification({ strict, evidencePath });
  console.log(JSON.stringify(report, null, 2));
  if (!report.ok) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error('候选完整性检查失败：' + error.message);
    process.exitCode = 1;
  });
}
