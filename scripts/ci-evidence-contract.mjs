import path from 'node:path';

// These are independent required checks, not an arbitrary minimum job count.
export const CI_JOBS = ['deployment-contract', 'jimeng-source', 'verify', 'postgres-integration', 'browser-tests', 'source-integrity', 'windows-safety', 'candidate-package'];
export const CI_CHECKS = {
  'deployment-windows-workflow': { job: 'deployment-contract', command: ['npm', 'run', 'workflow:test'], kind: 'tests', platform: 'win32' },
  'deployment-macos-workflow': { job: 'deployment-contract', command: ['npm', 'run', 'workflow:test'], kind: 'tests', platform: 'darwin' },
  'deployment-windows-tests': { job: 'deployment-contract', command: ['npm', 'run', 'deployment:test'], kind: 'tests', platform: 'win32' },
  'deployment-windows-runtime': { job: 'deployment-contract', command: ['node', '--import', 'tsx', 'scripts/ci-regression-tests.mjs', '--suite', 'n8n-runtime'], kind: 'tests', platform: 'win32' },
  'deployment-windows-verify': { job: 'deployment-contract', command: ['npm', 'run', 'deployment:verify'], kind: 'exit', platform: 'win32' },
  'deployment-macos-tests': { job: 'deployment-contract', command: ['npm', 'run', 'deployment:test'], kind: 'tests', platform: 'darwin' },
  'deployment-macos-runtime': { job: 'deployment-contract', command: ['node', '--import', 'tsx', 'scripts/ci-regression-tests.mjs', '--suite', 'n8n-runtime'], kind: 'tests', platform: 'darwin' },
  'deployment-macos-verify': { job: 'deployment-contract', command: ['npm', 'run', 'deployment:verify'], kind: 'exit', platform: 'darwin' },
  'jimeng-tests': { job: 'jimeng-source', command: ['node', '--import', 'tsx', 'scripts/ci-regression-tests.mjs', '--suite', 'jimeng'], kind: 'tests' },
  'jimeng-image': { job: 'jimeng-source', command: ['npm', 'run', 'jimeng:build'], kind: 'exit' },
  'jimeng-ping': { job: 'jimeng-source', command: ['node', 'scripts/ci-jimeng-ping.mjs'], kind: 'assertions' },
  check: { job: 'verify', command: ['npm', 'run', 'check'], kind: 'tests' },
  'dependency-audit': { job: 'verify', command: ['npm', 'audit', '--omit=dev', '--audit-level=moderate'], kind: 'exit' },
  'postgres-integration': { job: 'postgres-integration', command: ['node', 'node_modules/vitest/vitest.mjs', 'run', '.integration.test.ts', '--root', 'apps/server', '--maxWorkers=2', '--reporter=verbose'], kind: 'tests' },
  'browser-build': { job: 'browser-tests', command: ['npm', 'run', 'build'], kind: 'exit' },
  e2e: { job: 'browser-tests', command: ['npm', 'run', 'test:e2e', '--', '--reporter=list,json'], kind: 'e2e' },
  'portable-source': { job: 'source-integrity', command: ['node', '--import', 'tsx', 'scripts/verify-release-completeness.mjs', '--mode', 'ci', '--expected-commit', '<commit>'], kind: 'static' },
  'ci-helper-tests': { job: 'source-integrity', command: ['node', '--import', 'tsx', '--test', 'scripts/run-ci-check.test.mjs', 'scripts/verify-ci-gate.test.mjs'], kind: 'tests' },
  'gitleaks-source': { job: 'source-integrity', command: ['gitleaks', 'dir', '.', '--redact=100', '--no-banner', '--no-color'], kind: 'exit' },
  'gitleaks-history': { job: 'source-integrity', command: ['gitleaks', 'git', '.', '--log-opts=--all', '--redact=100', '--no-banner', '--no-color'], kind: 'exit' },
  'restart-safety': { job: 'windows-safety', command: ['powershell.exe', '-NoProfile', '-File', 'scripts/test-restart-windows-safety.ps1'], kind: 'safety', platform: 'win32' },
  'retirement-safety': { job: 'windows-safety', command: ['pwsh', '-NoProfile', '-File', 'scripts/test-retire-n8n-global-junction-safety.ps1'], kind: 'safety', platform: 'win32' },
  'candidate-build': { job: 'candidate-package', command: ['npm', 'run', 'build'], kind: 'exit' },
  'candidate-static': { job: 'candidate-package', command: ['node', '--import', 'tsx', 'scripts/verify-release-completeness.mjs', '--mode', 'ci', '--expected-commit', '<commit>'], kind: 'static' },
  'candidate-package': { job: 'candidate-package', command: ['node', '--import', 'tsx', 'scripts/package-release-candidate.mjs', '--output', '<output>'], kind: 'package' }
};

export const LEGACY_OZON_SKIPS = [
  '手动资料只读显示采购尺寸净重，并保持 #23249 为普通类目字段',
  '采购毛重联动草稿锁定克数与单位，保留尺寸编辑和服务端审计',
  '预设兜底草稿显示兜底来源，历史草稿保持毛重与单位可编辑',
  '类目要求未支持的视频商品字段时降级为仅封面，旧 V1 文件只作迁移提示',
  '手动资料的中文类目文本和字典选择会进入保存请求',
  '两个变体固定显示并保存 SKU 模型分组，俄文标题变化不影响属性 9048',
  '新草稿将类目类型显示为系统只读中俄名称并保存 typeId',
  '四类 OZON 本地双语字典可用于手动资料和预设共享字段',
  '迁移前结果保持只读展示且不再触发 SKU 级平台刷新',
  '手动历史 RUB 草稿显示服务端 CNY 投影并可直接保存为新修订',
  '手动价格投影不可用时不把 RUB 原值冒充 CNY 并阻止保存'
];
export const PERF_SKIP = 'MediaIndexRepository 100k-file performance > writes, activates, and loads an isolated 100k-file snapshot';
export const POSIX_SKIP = 'POSIX shell executes every generated quote helper with spaces, Chinese, and a single quote';
const ansi = new RegExp(String.fromCharCode(27) + '\\[[0-?]*[ -/]*[@-~]', 'g');
export const stripAnsi = (text) => text.replace(ansi, '');

export function commandFor(id, { commit, output } = {}) {
  const check = CI_CHECKS[id];
  if (!check) throw new Error('Unknown CI check ID');
  return check.command.map((arg) => arg === '<commit>' ? commit : arg === '<output>' ? output : arg);
}

export function assertCommand(id, argv, { commit, output } = {}) {
  const expected = commandFor(id, { commit, output });
  if (!Array.isArray(argv) || expected.some((arg) => typeof arg !== 'string') || JSON.stringify(argv) !== JSON.stringify(expected)) {
    throw new Error('CI command does not match its fixed check contract');
  }
}

export function publicCommand(id, commit) {
  return commandFor(id, { commit, output: '<runner-temp>/candidate-package' });
}

export function identityEqual(left, right) {
  if (!left || !right) return false;
  return ['commit', 'headTreeHash', 'scopeVersion', 'scopeContractSha256', 'agentsSha256', 'featureManifestSha256'].every((key) => left[key] === right[key])
    && ['runtime', 'documentation', 'verification'].every((scope) => left.fingerprints?.[scope] === right.fingerprints?.[scope]);
}

export function assertOutside(root, target) {
  if (!path.isAbsolute(target)) throw new Error('CI evidence/output requires an absolute outside directory');
  const relative = path.relative(path.resolve(root), path.resolve(target));
  if (!(relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative))) throw new Error('CI evidence/output must remain outside the checkout');
}

export function parseTestLog(log, { id, platform = process.platform } = {}) {
  const text = stripAnsi(log);
  const summary = { passed: 0, failed: 0, skipped: 0, allowedSkips: [] };
  const problems = [];
  const vitestSkipFiles = [];
  const verboseSkipFiles = new Set();
  const tapSkips = [];
  let recognized = false;
  for (const line of text.split(/\r?\n/)) {
    if (/^\s*#\s+(?:todo|cancelled)\s+[1-9]\d*\s*$/.test(line) || /^\s*(?:not )?ok\b.*#\s+TODO\b/i.test(line)
      || (/^\s*Tests\s+/.test(line) && /[1-9]\d*\s+(?:todo|pending|cancelled)/i.test(line))) problems.push('Unexecuted TODO or cancelled test');
    const tap = line.match(/^\s*#\s+(pass|fail|skipped)\s+(\d+)\s*$/);
    if (tap) { summary[tap[1] === 'pass' ? 'passed' : tap[1] === 'fail' ? 'failed' : 'skipped'] += Number(tap[2]); recognized = true; }
    if (/^\s*Tests\s+/.test(line)) {
      for (const item of line.matchAll(/(\d+)\s+(passed|failed|skipped)/g)) summary[item[2]] += Number(item[1]);
      recognized = true;
    }
    const skippedTap = line.match(/^\s*ok\s+\d+\s+-\s+(.+?)\s+#\s+SKIP\b/i);
    if (skippedTap) tapSkips.push(skippedTap[1]);
    const skippedFile = line.match(/(?:✓|↓|√|·|[-])?\s*(src\/[^\s]+\.(?:test|spec)\.ts)\s+\(\d+ tests?\s*\|\s*(\d+) skipped\)/);
    if (skippedFile) vitestSkipFiles.push({ file: skippedFile[1], count: Number(skippedFile[2]) });
    const verboseSkip = line.match(/^\s*↓\s+(src\/[^\s]+\.(?:test|spec)\.ts)\s+>\s+(.+)$/);
    if (verboseSkip) {
      if (['check', 'postgres-integration'].includes(id) && verboseSkip[1] === 'src/repositories/media-index.integration.test.ts' && verboseSkip[2] === PERF_SKIP) verboseSkipFiles.add(verboseSkip[1]);
      else problems.push('Unapproved skipped Vitest case');
    }
  }
  for (const title of tapSkips) {
    if (platform === 'win32' && title === POSIX_SKIP && ['check', 'deployment-windows-tests'].includes(id)) {
      summary.allowedSkips.push({ title, reason: 'Windows does not execute the POSIX shell fixture' });
    } else problems.push('Unapproved TAP skipped test');
  }
  for (const skipped of vitestSkipFiles) {
    // This suite's only optional branch is forced off by the CI wrapper. Any
    // extra skipped case, different file or missing per-file evidence fails.
    if (['check', 'postgres-integration'].includes(id) && skipped.file === 'src/repositories/media-index.integration.test.ts' && skipped.count === 1) {
      summary.allowedSkips.push({ title: PERF_SKIP, file: skipped.file, reason: 'MEDIA_INDEX_PERF_100K=0; optional 100k performance fixture' });
    } else problems.push('Unapproved Vitest skipped suite');
  }
  for (const file of verboseSkipFiles) if (!vitestSkipFiles.some((item) => item.file === file)) summary.allowedSkips.push({ title: PERF_SKIP, file, reason: 'MEDIA_INDEX_PERF_100K=0; optional 100k performance fixture' });
  if (!recognized || summary.passed < 1) problems.push('No executed passing tests');
  if (summary.failed) problems.push('Failed tests');
  if (summary.skipped !== summary.allowedSkips.length) problems.push('Skipped count lacks exact approved fixture evidence');
  if (/^\[WebServer\]\s+(?:Node\.js v\d|npm (?:error|ERR!)\b|(?:Unhandled|uncaught)\b)/im.test(text)) problems.push('Test application exited abnormally');
  return { summary, problems };
}

export function parsePlaywrightReport(report, log) {
  const summary = { passed: 0, failed: 0, skipped: 0, allowedSkips: [] };
  const problems = [];
  const seenSkips = new Set();
  function visit(suite, inheritedFile = '') {
    const file = (suite.file || inheritedFile).replaceAll('\\', '/');
    for (const spec of suite.specs || []) {
      for (const test of spec.tests || []) {
        const statuses = (test.results || []).map((result) => result.status);
        if (test.expectedStatus === 'skipped' && statuses.length && statuses.every((status) => status === 'skipped')) {
          summary.skipped += 1;
          if (['ozon-listing.spec.ts', 'tests/e2e/ozon-listing.spec.ts'].includes(file) && LEGACY_OZON_SKIPS.includes(spec.title) && !seenSkips.has(spec.title)) {
            seenSkips.add(spec.title);
            summary.allowedSkips.push({ file: 'tests/e2e/ozon-listing.spec.ts', title: spec.title, reason: 'Approved legacy SKU editor replaced by per-store frozen publishing snapshots' });
          } else problems.push('Unapproved skipped E2E case');
        } else if (test.status === 'expected' && statuses.length && statuses.every((status) => status === 'passed')) summary.passed += 1;
        else { summary.failed += 1; problems.push('Failed, flaky, interrupted or unexecuted E2E case'); }
      }
    }
    for (const child of suite.suites || []) visit(child, file);
  }
  for (const suite of report?.suites || []) visit(suite);
  if (!summary.passed || summary.failed || report?.errors?.length) problems.push('E2E lacks successful complete execution');
  if (report?.stats?.expected !== summary.passed || report?.stats?.skipped !== summary.skipped || report?.stats?.unexpected !== 0 || report?.stats?.flaky !== 0) problems.push('E2E summary and individual results disagree');
  if (/^\[WebServer\]\s+(?:Node\.js v\d|npm (?:error|ERR!)\b|(?:Unhandled|uncaught)\b)/im.test(stripAnsi(log))) problems.push('Test application exited abnormally');
  return { summary, problems };
}

export function validatePackageContract(manifest) {
  const errors = [];
  if (manifest?.schemaVersion !== 1 || manifest?.artifactRole !== 'REVIEWABLE_CANDIDATE_NOT_INSTALLED_OR_PUBLISHED_RELEASE'
    || manifest?.sourceDirty !== false || manifest?.buildDirty !== false || manifest?.includesCredentialsOrRuntimeConfiguration !== false) errors.push('Unsafe candidate package role or cleanliness boundary');
  const archives = manifest?.archives;
  if (!Array.isArray(archives) || archives.length !== 2) return [...errors, 'Both candidate archive kinds are required'];
  const kinds = archives.map((archive) => archive.kind).sort();
  if (JSON.stringify(kinds) !== JSON.stringify(['SOURCE_CANDIDATE', 'SOURCE_WITH_PREBUILT_CANDIDATE']) || new Set(archives.map((archive) => archive.name)).size !== 2) errors.push('Candidate archive kinds or names are duplicated');
  return errors;
}
