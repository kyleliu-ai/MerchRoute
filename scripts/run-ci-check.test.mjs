import assert from 'node:assert/strict';
import { test } from 'node:test';
import path from 'node:path';
import os from 'node:os';
import { failureDiagnostics } from './ci-failure-diagnostics.mjs';
import { captureCommand, isolatedChildEnvironment } from './run-ci-check.mjs';
import { LEGACY_OZON_SKIPS, PERF_SKIP, POSIX_SKIP, assertCommand, assertOutside, parsePlaywrightReport, parseTestLog, validatePackageContract } from './ci-evidence-contract.mjs';

test('CI command IDs cannot be satisfied by echo, filtered suites or a wrong expected SHA', () => {
  assert.doesNotThrow(() => assertCommand('check', ['npm', 'run', 'check']));
  assert.throws(() => assertCommand('check', ['echo', 'PASS']));
  assert.throws(() => assertCommand('check', ['npm', 'run', 'check', '--', '-t', 'one test']));
  assert.throws(() => assertCommand('portable-source', ['node', '--import', 'tsx', 'scripts/verify-release-completeness.mjs', '--mode', 'ci', '--expected-commit', 'b'.repeat(40)], { commit: 'a'.repeat(40) }));
});

test('real log capture retains output privately and reports actual nonzero exit', async () => {
  const result = await captureCommand(process.execPath, ['-e', 'process.stdout.write("synthetic-secret"); process.exitCode=7'], { cwd: os.tmpdir(), env: process.env });
  assert.equal(result.exitCode, 7);
  assert.equal(result.output.toString(), 'synthetic-secret');
  assert.equal(result.oversized, false);
});

test('child test environment rejects production databases and removes external credentials', () => {
  const raw = path.join(os.tmpdir(), 'ci-only-raw');
  const input = { DATABASE_URL: 'postgresql://merchroute_ci@127.0.0.1:5432/merchroute_ci_test', WB_SOURCE_MEDIA_CLEANUP_TEST_DATABASE_URL: 'postgresql://merchroute_ci@127.0.0.1:5432/merchroute_ci_cleanup_test', WB_TOKEN: 'synthetic', OZON_KEY: 'synthetic', N8N_TOKEN: 'synthetic', GH_TOKEN: 'synthetic', MERCHROUTE_ENV_FILE: 'synthetic', DOWNLOAD_CONFIG_SYNC: 'false', MERCHROUTE_BUILD_SHA: 'a'.repeat(40) };
  const cleaned = isolatedChildEnvironment(input, raw, 'check');
  assert.equal(cleaned.DATABASE_URL, input.DATABASE_URL);
  assert.equal(cleaned.WB_SOURCE_MEDIA_CLEANUP_TEST_DATABASE_URL, input.WB_SOURCE_MEDIA_CLEANUP_TEST_DATABASE_URL);
  for (const key of ['WB_TOKEN', 'OZON_KEY', 'N8N_TOKEN', 'GH_TOKEN', 'MERCHROUTE_ENV_FILE', 'DOWNLOAD_CONFIG_SYNC', 'MERCHROUTE_BUILD_SHA']) assert.equal(cleaned[key], undefined);
  assert.equal(cleaned.MEDIA_INDEX_PERF_100K, '0');
  assert.throws(() => isolatedChildEnvironment({ ...input, DATABASE_URL: 'postgresql://real@127.0.0.1:5432/production' }, raw, 'check'));
  assert.throws(() => isolatedChildEnvironment({ ...input, WB_SOURCE_MEDIA_CLEANUP_TEST_DATABASE_URL: input.DATABASE_URL }, raw, 'check'));
  assert.throws(() => isolatedChildEnvironment({}, raw, 'postgres-integration'));
});

test('repository-local evidence is rejected', () => {
  const root = path.join(os.tmpdir(), 'candidate');
  assert.throws(() => assertOutside(root, path.join(root, 'evidence')));
  assert.doesNotThrow(() => assertOutside(root, path.join(os.tmpdir(), 'outside-evidence')));
});

test('failure diagnostics expose only tracked relative locations and fixed categories', () => {
  const file = 'scripts/package-release-candidate.test.mjs';
  const secret = 'synthetic-private-value-not-for-publication';
  const log = `not ok 1 - ${secret}\nAssertionError: ${secret}\n at /Users/private/checkout/${file}:52:9\n at C:\\private\\checkout\\scripts\\package-release-candidate.test.mjs:52:9\n at /private/credentials.json:1:2\n at scripts/untracked.test.mjs:5:6\nclean, committed`;
  const result = failureDiagnostics(log, { sourceFiles: [file] });
  assert.deepEqual(result.sourceLocations, [{ file, line: 52, column: 9 }]);
  assert.deepEqual(result.categories, ['ASSERTION', 'DIRTY_FIXTURE']);
  assert.equal(result.rawDetailsPublished, false);
  for (const forbidden of [secret, '/Users/', 'C:', 'credentials', 'untracked']) assert.ok(!JSON.stringify(result).includes(forbidden));
});

test('E2E diagnostics locate failures without leaking titles, errors or attachments', () => {
  const report = playwright();
  const spec = report.suites[0].specs[0];
  spec.title = 'synthetic-private-title';
  spec.line = 123;
  spec.tests[0] = { status: 'unexpected', results: [{ status: 'timedOut', errors: [{ message: 'TimeoutError: synthetic-private-token' }], attachments: [{ path: '/private/screenshot.png' }] }] };
  const result = failureDiagnostics('', { sourceFiles: ['tests/e2e/ozon-listing.spec.ts'], report });
  assert.deepEqual(result.failedCases, [{ file: 'tests/e2e/ozon-listing.spec.ts', line: 123 }]);
  assert.deepEqual(result.categories, ['TIMEOUT']);
  assert.ok(!JSON.stringify(result).includes('private'));
  assert.deepEqual(failureDiagnostics('', { sourceFiles: [], report }).failedCases, []);
});

test('test logs need nonzero passes and reject failures, all skips, TODO and cancellation', () => {
  assert.equal(parseTestLog('# pass 3\n# fail 0\n# skipped 0\n', { id: 'ci-helper-tests' }).problems.length, 0);
  for (const log of ['# pass 0\n# fail 0\n# skipped 1', '# pass 1\n# fail 1\n# skipped 0', '# pass 1\n# fail 0\n# skipped 0\n# todo 1', '# pass 1\n# fail 0\n# skipped 0\n# cancelled 1', '# pass 1\nok 2 - feature # TODO\n# fail 0', 'Tests 1 passed | 1 todo']) {
    assert.ok(parseTestLog(log, { id: 'check' }).problems.length, log);
  }
});

test('only identified optional 100k fixture and Windows POSIX fixture may skip', () => {
  const perf = `✓ src/repositories/media-index.integration.test.ts (9 tests | 1 skipped)\nTests 8 passed | 1 skipped (9)`;
  const result = parseTestLog(perf, { id: 'check', platform: 'linux' });
  assert.equal(result.problems.length, 0);
  assert.equal(result.summary.allowedSkips[0].title, PERF_SKIP);
  assert.ok(parseTestLog(perf.replace('1 skipped', '2 skipped'), { id: 'check' }).problems.length);
  assert.ok(parseTestLog(perf.replace('media-index.integration', 'local-imports.integration'), { id: 'check' }).problems.length);
  const tap = `ok 1 - ${POSIX_SKIP} # SKIP\n# pass 1\n# fail 0\n# skipped 1`;
  assert.equal(parseTestLog(tap, { id: 'deployment-windows-tests', platform: 'win32' }).problems.length, 0);
  assert.ok(parseTestLog(tap, { id: 'deployment-macos-tests', platform: 'darwin' }).problems.length);
});

function playwright(file = 'ozon-listing.spec.ts', skippedTitle = LEGACY_OZON_SKIPS[0]) {
  return { errors: [], stats: { expected: 1, skipped: 1, unexpected: 0, flaky: 0 }, suites: [{ file, specs: [
    { title: 'active behavior', tests: [{ expectedStatus: 'passed', status: 'expected', results: [{ status: 'passed' }] }] },
    { title: skippedTitle, tests: [{ expectedStatus: 'skipped', status: 'skipped', results: [{ status: 'skipped' }] }] }
  ] }] };
}

test('E2E skips require exact legacy file/title and executed test results', () => {
  assert.equal(parsePlaywrightReport(playwright(), '').problems.length, 0);
  assert.ok(parsePlaywrightReport(playwright('fake-ozon-listing.spec.ts'), '').problems.length);
  assert.ok(parsePlaywrightReport(playwright('ozon-listing.spec.ts', '新增目录状态场景'), '').problems.length);
  assert.ok(parsePlaywrightReport(playwright(), '[WebServer] Node.js v22.23.1').problems.length);
  const incomplete = playwright();
  incomplete.suites[0].specs[0].tests[0].results = [];
  assert.ok(parsePlaywrightReport(incomplete, '').problems.length);
});

test('package requires clean review-only role and two distinct archive kinds', () => {
  const manifest = { schemaVersion: 1, artifactRole: 'REVIEWABLE_CANDIDATE_NOT_INSTALLED_OR_PUBLISHED_RELEASE', sourceDirty: false, buildDirty: false, includesCredentialsOrRuntimeConfiguration: false, archives: [{ name: 'source.zip', kind: 'SOURCE_CANDIDATE' }, { name: 'prebuilt.zip', kind: 'SOURCE_WITH_PREBUILT_CANDIDATE' }] };
  assert.deepEqual(validatePackageContract(manifest), []);
  assert.ok(validatePackageContract({ ...manifest, archives: [manifest.archives[0], manifest.archives[0]] }).length);
  assert.ok(validatePackageContract({ ...manifest, buildDirty: true }).length);
});
