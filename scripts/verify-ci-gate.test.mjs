import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { CI_CHECKS, CI_JOBS, publicCommand } from './ci-evidence-contract.mjs';
import { validateCiRecords, verifyPackageManifest } from './verify-ci-gate.mjs';

const identity = { commit: 'a'.repeat(40), headTreeHash: 'b'.repeat(40), scopeVersion: 1, agentsSha256: 'c'.repeat(64), scopeContractSha256: 'd'.repeat(64), featureManifestSha256: 'e'.repeat(64), fingerprints: { runtime: '1'.repeat(64), documentation: '2'.repeat(64), verification: '3'.repeat(64) } };
function fixture() {
  const needs = Object.fromEntries(CI_JOBS.map((job) => [job, { result: 'success' }]));
  const records = Object.entries(CI_CHECKS).map(([id, check]) => ({
    schemaVersion: 1, id, job: check.job, platform: check.platform || 'linux', runId: '123', runAttempt: '2', identity: structuredClone(identity),
    command: publicCommand(id, identity.commit), workingDirectory: id === 'gitleaks-source' ? 'CONTROLLED_HEAD_SNAPSHOT' : 'CHECKOUT',
    startedAt: '2026-09-03T00:00:00Z', completedAt: '2026-09-03T00:01:00Z', exitCode: 0,
    logSha256: 'f'.repeat(64), logBytes: 12, rawLogPublished: false, status: 'PASS', problems: [],
    summary: { passed: 1, failed: 0, skipped: 0, allowedSkips: [] }
  }));
  return { needs, records, identity, runId: '123', runAttempt: '2', now: Date.parse('2026-09-03T00:02:00Z') };
}

test('final gate accepts a complete successful exact-identity attempt', () => {
  const result = validateCiRecords(fixture());
  assert.equal(result.ok, true);
  assert.equal(result.verifiedCheckCount, Object.keys(CI_CHECKS).length);
});

test('each failed cancelled skipped or missing job blocks the always gate', () => {
  for (const status of ['failure', 'cancelled', 'skipped', undefined]) {
    const value = fixture();
    value.needs.verify.result = status;
    assert.equal(validateCiRecords(value).ok, false);
  }
});

test('records cannot be missing, duplicated, unknown, stale or from a wrong source', () => {
  for (const mutate of [
    (value) => value.records.pop(),
    (value) => value.records.push(value.records[0]),
    (value) => { value.records[0].id = 'unreviewed-check'; },
    (value) => { value.records[0].runAttempt = '1'; },
    (value) => { value.records[0].identity.commit = '0'.repeat(40); },
    (value) => { value.records[0].identity.headTreeHash = '0'.repeat(40); },
    (value) => { value.records[0].identity.agentsSha256 = '0'.repeat(64); },
    (value) => { value.records[0].identity.fingerprints.verification = '0'.repeat(64); }
  ]) {
    const value = fixture(); mutate(value);
    assert.equal(validateCiRecords(value).ok, false);
  }
});

test('passing job labels cannot hide missing commands, failures, arbitrary skips or raw logs', () => {
  for (const mutate of [
    (record) => { record.command = ['echo', 'PASS']; },
    (record) => { record.exitCode = 1; },
    (record) => { record.summary.passed = 0; },
    (record) => { record.summary.failed = 1; },
    (record) => { record.summary.skipped = 1; record.summary.allowedSkips = [{ title: '新功能未测试' }]; },
    (record) => { record.logSha256 = ''; },
    (record) => { record.rawLogPublished = true; },
    (record) => { record.workingDirectory = 'OTHER_WORKTREE'; }
  ]) {
    const value = fixture(); mutate(value.records[0]);
    assert.equal(validateCiRecords(value).ok, false);
  }
});

test('package manifest cannot swap identity or archive checksum', () => {
  const archives = [{ name: 'source.zip', kind: 'SOURCE_CANDIDATE', bytes: 12, sha256: 'c'.repeat(64) }, { name: 'prebuilt.zip', kind: 'SOURCE_WITH_PREBUILT_CANDIDATE', bytes: 24, sha256: 'd'.repeat(64) }];
  const manifest = { schemaVersion: 1, artifactRole: 'REVIEWABLE_CANDIDATE_NOT_INSTALLED_OR_PUBLISHED_RELEASE', sourceDirty: false, buildDirty: false, includesCredentialsOrRuntimeConfiguration: false, identity, archives };
  const record = { summary: { archives: archives.map(({ name, bytes, sha256 }) => ({ name, bytes, sha256 })) } };
  assert.deepEqual(verifyPackageManifest(manifest, record, identity), []);
  assert.ok(verifyPackageManifest({ ...manifest, identity: { ...identity, commit: '0'.repeat(40) } }, record, identity).length);
  assert.ok(verifyPackageManifest(manifest, { summary: { archives: [] } }, identity).length);
});

test('workflow preserves read-only permissions, explicit PR HEAD and non-skippable aggregate gate', async () => {
  const yaml = await readFile(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8');
  assert.match(yaml, /permissions:\s+contents: read/);
  assert.doesNotMatch(yaml, /pull_request_target|contents: write|secrets: inherit|if:.*draft/);
  assert.match(yaml, /branches: \[main, 'work\/merchroute-github-publish-\*'\]/);
  assert.equal((yaml.match(/ref: \$\{\{ github.event.pull_request.head.sha \|\| github.sha \}\}/g) || []).length, 9);
  assert.match(yaml, /name: MerchRoute release gate\s+if: \$\{\{ always\(\) \}\}/);
  assert.match(yaml, /POSTGRES_INITDB_ARGS: --encoding=UTF8 --locale-provider=icu --icu-locale=und/);
  assert.match(yaml, /WB_SOURCE_MEDIA_CLEANUP_TEST_DATABASE_URL:.*merchroute_ci_cleanup_test/);
  assert.doesNotMatch(yaml, /path: playwright-report|path:.*raw-|gh release|git push|npm publish/);
  for (const id of Object.keys(CI_CHECKS).filter((id) => !id.startsWith('deployment-'))) assert.ok(yaml.includes('--id ' + id + ' '), id);
});
