import { createHash } from 'node:crypto';
import { lstat, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { CI_CHECKS, CI_JOBS, LEGACY_OZON_SKIPS, PERF_SKIP, POSIX_SKIP, assertOutside, identityEqual, publicCommand, validatePackageContract } from './ci-evidence-contract.mjs';
import { readCiIdentity } from './run-ci-check.mjs';

export function validateCiRecords({ needs, records, identity, runId, runAttempt, now = Date.now() }) {
  const errors = [];
  const seen = new Set();
  if (!needs || Object.keys(needs).length !== CI_JOBS.length || CI_JOBS.some((job) => needs[job]?.result !== 'success')) errors.push('Every required CI job must finish successfully; skipped/cancelled/missing jobs fail');
  for (const record of records) {
    const check = CI_CHECKS[record?.id];
    if (!check || seen.has(record.id)) { errors.push('Unknown or duplicate CI check record'); continue; }
    seen.add(record.id);
    if (record.schemaVersion !== 1 || record.job !== check.job || (check.platform && record.platform !== check.platform)) errors.push(record.id + ': wrong record schema/job/OS');
    if (record.runId !== runId || record.runAttempt !== runAttempt) errors.push(record.id + ': stale workflow run or attempt');
    if (!identityEqual(record.identity, identity)) errors.push(record.id + ': source identity, tree or independent document hash mismatch');
    if (JSON.stringify(record.command) !== JSON.stringify(publicCommand(record.id, identity.commit))) errors.push(record.id + ': command differs from the required contract');
    if (record.workingDirectory !== (record.id === 'gitleaks-source' ? 'CONTROLLED_HEAD_SNAPSHOT' : 'CHECKOUT')) errors.push(record.id + ': wrong check source directory');
    if (record.status !== 'PASS' || record.exitCode !== 0 || !Array.isArray(record.problems) || record.problems.length) errors.push(record.id + ': actual check did not pass');
    if (!/^[a-f0-9]{64}$/.test(record.logSha256 || '') || !(record.logBytes > 0) || record.rawLogPublished !== false) errors.push(record.id + ': invalid raw-log digest or unsafe publication');
    const started = Date.parse(record.startedAt);
    const finished = Date.parse(record.completedAt);
    if (!Number.isFinite(started) || !Number.isFinite(finished) || finished < started || finished > now + 60000) errors.push(record.id + ': invalid execution times');
    const summary = record.summary;
    if (!summary || !(summary.passed > 0) || summary.failed !== 0 || !Number.isInteger(summary.skipped) || summary.skipped < 0 || !Array.isArray(summary.allowedSkips)) {
      errors.push(record.id + ': missing actual successful summary'); continue;
    }
    if (summary.skipped !== summary.allowedSkips.length) errors.push(record.id + ': unexplained skipped cases');
    const skipKeys = new Set();
    for (const skip of summary.allowedSkips) {
      if (skipKeys.has(skip.title)) errors.push(record.id + ': duplicate skipped fixture');
      skipKeys.add(skip.title);
      const approved = (record.id === 'e2e' && skip.file === 'tests/e2e/ozon-listing.spec.ts' && LEGACY_OZON_SKIPS.includes(skip.title))
        || (['check', 'postgres-integration'].includes(record.id) && skip.file === 'src/repositories/media-index.integration.test.ts' && skip.title === PERF_SKIP)
        || (record.platform === 'win32' && ['check', 'deployment-windows-tests'].includes(record.id) && skip.title === POSIX_SKIP);
      if (!approved) errors.push(record.id + ': unapproved skipped fixture');
    }
  }
  for (const id of Object.keys(CI_CHECKS)) if (!seen.has(id)) errors.push('Missing actual CI evidence: ' + id);
  return { ok: errors.length === 0, errors, verifiedCheckCount: seen.size, expectedCheckCount: Object.keys(CI_CHECKS).length };
}

async function readRecords(root) {
  const result = [];
  async function visit(directory) {
    for (const name of await readdir(directory)) {
      const file = path.join(directory, name);
      const info = await lstat(file);
      if (info.isSymbolicLink()) throw new Error('Linked CI evidence is forbidden');
      if (info.isDirectory()) await visit(file);
      else if (info.isFile() && name.endsWith('.json')) result.push(JSON.parse(await readFile(file, 'utf8')));
      else throw new Error('Only sanitized JSON records may enter CI evidence artifacts');
    }
  }
  await visit(root);
  return result;
}

export function verifyPackageManifest(manifest, record, identity) {
  const errors = validatePackageContract(manifest);
  if (!identityEqual(manifest?.identity, identity)) errors.push('Candidate package has a different source identity');
  const expected = (manifest?.archives || []).map(({ name, bytes, sha256 }) => ({ name, bytes, sha256 }));
  if (JSON.stringify(expected) !== JSON.stringify(record?.summary?.archives)) errors.push('Package checksums disagree with the actual package check');
  return errors;
}

async function main() {
  const args = process.argv.slice(2);
  const options = {};
  for (let index = 0; index < args.length; index += 2) {
    const key = { '--expected-commit': 'expectedCommit', '--records': 'records', '--package-manifest': 'packageManifest', '--output': 'output' }[args[index]];
    if (!key || !args[index + 1]) throw new Error('Invalid CI gate arguments');
    options[key] = args[index + 1];
  }
  const root = process.cwd();
  for (const key of ['records', 'packageManifest', 'output']) assertOutside(root, options[key]);
  const identity = await readCiIdentity(root, options.expectedCommit);
  let records = [];
  const inputErrors = [];
  try { records = await readRecords(options.records); } catch { inputErrors.push('CI evidence artifacts could not be read completely'); }
  let needs;
  try { needs = JSON.parse(process.env.MERCHROUTE_CI_NEEDS_JSON || 'null'); } catch { inputErrors.push('CI needs status is invalid'); }
  const validation = validateCiRecords({ needs, records, identity, runId: process.env.GITHUB_RUN_ID, runAttempt: process.env.GITHUB_RUN_ATTEMPT });
  validation.errors.push(...inputErrors);
  try {
    const bytes = await readFile(options.packageManifest);
    const packageRecord = records.find((record) => record.id === 'candidate-package');
    if (createHash('sha256').update(bytes).digest('hex') !== packageRecord?.summary?.packageManifestSha256) validation.errors.push('Package manifest checksum mismatch');
    validation.errors.push(...verifyPackageManifest(JSON.parse(bytes), packageRecord, identity));
  } catch { validation.errors.push('Candidate package manifest missing or unreadable'); }
  const after = await readCiIdentity(root, options.expectedCommit);
  if (!identityEqual(after, identity)) validation.errors.push('Source changed during final CI gate');
  validation.ok = validation.errors.length === 0;
  const report = {
    schemaVersion: 1, gate: 'MerchRoute release gate', ...validation, identity,
    runId: process.env.GITHUB_RUN_ID, runAttempt: process.env.GITHUB_RUN_ATTEMPT,
    verifiedAt: new Date().toISOString(), sourceAuthority: 'LOCAL_CANDIDATE',
    localAudit: 'NOT_APPLICABLE', candidateValidated: false, releaseReady: false, published: false,
    ciChecksPassed: validation.ok,
    checks: records.map(({ id, status, summary, logSha256 }) => ({ id, status, summary, logSha256 })),
    notices: ['CI evidence binds this exact committed source; it does not publish main, a GitHub Release or the local 4173 service.', 'Raw test output remains in runner temp and is not uploaded.']
  };
  await writeFile(options.output, JSON.stringify(report, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  console.log(JSON.stringify(report, null, 2));
  if (!report.ok) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch(() => { console.error('MERCHROUTE_RELEASE_GATE_REJECTED: required evidence could not be safely verified.'); process.exitCode = 1; });
}
