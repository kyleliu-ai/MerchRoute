import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { collectContentIdentity } from './verify-release-completeness.mjs';
import { failureDiagnostics } from './ci-failure-diagnostics.mjs';
import { CI_CHECKS, assertCommand, assertOutside, identityEqual, parsePlaywrightReport, parseTestLog, publicCommand, validatePackageContract } from './ci-evidence-contract.mjs';

const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const git = (root, args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', windowsHide: true, maxBuffer: 32 * 1024 * 1024 }).trim();

export async function readCiIdentity(root, expectedCommit) {
  if (!/^[a-f0-9]{40}$/.test(expectedCommit || '')) throw new Error('Expected commit must be a full Git SHA');
  const commit = git(root, ['rev-parse', 'HEAD']);
  if (commit !== expectedCommit) throw new Error('Actual checkout differs from the event head SHA');
  if (git(root, ['status', '--porcelain=v1', '--untracked-files=all'])) throw new Error('CI requires a clean committed checkout');
  return { commit, headTreeHash: git(root, ['rev-parse', 'HEAD^{tree}']), ...await collectContentIdentity(root) };
}

export function isolatedChildEnvironment(env, rawDirectory, id) {
  const result = { ...env };
  for (const key of Object.keys(result)) {
    if (/^(?:WB_|OZON_|N8N_|MERCHROUTE_BUILD_)/i.test(key)
      || /^(?:GITHUB_TOKEN|GH_TOKEN|MERCHROUTE_GITHUB_TOKEN|MERCHROUTE_ENV_FILE|MERCHROUTE_RUNTIME_ENV_FILE|MERCHROUTE_LEGACY_DATA_ROOT|MERCHROUTE_RUNTIME_KEY|MERCHROUTE_CREDENTIAL_ENCRYPTION_KEY|DOWNLOAD_CONFIG_SYNC|NODE_OPTIONS)$/i.test(key)) delete result[key];
  }
  // The cleanup suite deliberately uses a different synthetic test database.
  if (env.WB_SOURCE_MEDIA_CLEANUP_TEST_DATABASE_URL) result.WB_SOURCE_MEDIA_CLEANUP_TEST_DATABASE_URL = env.WB_SOURCE_MEDIA_CLEANUP_TEST_DATABASE_URL;
  for (const key of ['DATABASE_URL', 'WB_SOURCE_MEDIA_CLEANUP_TEST_DATABASE_URL']) {
    if (!result[key]) continue;
    const url = new URL(result[key]);
    if (!['postgres:', 'postgresql:'].includes(url.protocol) || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
      || url.port !== '5432' || url.username !== 'merchroute_ci' || url.password || !['/merchroute_ci_test', '/merchroute_ci_cleanup_test'].includes(url.pathname)) {
      throw new Error('CI rejects a non-synthetic database target');
    }
  }
  if (['check', 'postgres-integration'].includes(id)) {
    if (!result.DATABASE_URL || !result.WB_SOURCE_MEDIA_CLEANUP_TEST_DATABASE_URL
      || new URL(result.DATABASE_URL).pathname === new URL(result.WB_SOURCE_MEDIA_CLEANUP_TEST_DATABASE_URL).pathname) throw new Error('Both distinct integration test databases are required');
  }
  return {
    ...result, CI: 'true',
    // Vite embeds NODE_ENV in the browser bundle. "test" makes rc-select use
    // duplicate TEST_OR_SSR IDs and disables real-browser layout behavior.
    // Test execution remains isolated; publishable/browser builds are production.
    NODE_ENV: ['browser-build', 'candidate-build'].includes(id) ? 'production' : 'test',
    MEDIA_INDEX_PERF_100K: '0',
    MERCHROUTE_OZON_MULTISTORE_FLEET_READY: 'false',
    MERCHROUTE_OZON_SOURCE_MEDIA_CLEANUP_ENABLED: 'false',
    PLAYWRIGHT_JSON_OUTPUT_FILE: path.join(rawDirectory, 'playwright-results.json')
  };
}

export async function resolveCommand(argv) {
  if (argv[0] === 'node') return { command: process.execPath, args: argv.slice(1) };
  if (argv[0] !== 'npm') return { command: argv[0], args: argv.slice(1) };
  const candidates = [
    process.env.npm_execpath,
    path.join(path.dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js'),
    path.join(path.dirname(process.execPath), '../lib/node_modules/npm/bin/npm-cli.js')
  ].filter(Boolean);
  for (const file of candidates) {
    try { if ((await stat(file)).isFile()) return { command: process.execPath, args: [await realpath(file), ...argv.slice(1)] }; } catch { /* Try the other pinned Node installation layout. */ }
  }
  throw new Error('Cannot locate npm CLI beside the pinned Node installation');
}

export async function captureCommand(command, args, options) {
  return new Promise((resolve) => {
    const chunks = [];
    let bytes = 0;
    let oversized = false;
    const child = spawn(command, args, { ...options, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const collect = (chunk) => {
      bytes += chunk.length;
      if (bytes <= 64 * 1024 * 1024) chunks.push(chunk);
      else oversized = true;
    };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    child.on('error', () => resolve({ exitCode: 1, signal: null, output: Buffer.from('CI_COMMAND_START_FAILED\n'), oversized: false }));
    child.on('close', (code, signal) => resolve({ exitCode: Number.isInteger(code) ? code : 1, signal, output: Buffer.concat(chunks), oversized }));
  });
}

export async function inspectCheckOutput(id, log, { platform, rawDirectory, outputDirectory, identity } = {}) {
  const kind = CI_CHECKS[id].kind;
  if (kind === 'tests') return parseTestLog(log, { id, platform });
  if (kind === 'e2e') return parsePlaywrightReport(JSON.parse(await readFile(path.join(rawDirectory, 'playwright-results.json'), 'utf8')), log);
  const problems = [];
  const summary = { kind, passed: 0, failed: 0, skipped: 0, allowedSkips: [] };
  if (['static', 'safety', 'assertions'].includes(kind)) {
    const result = JSON.parse(log.trim());
    if (result.ok !== true) problems.push('Structured check did not report success');
    if (kind === 'static' && (result.ciStaticAudit !== 'PASS' || result.localAudit !== 'NOT_APPLICABLE'
      || result.candidateValidated !== false || result.releaseReady !== false || result.published !== false || !identityEqual(result.identity, identity))) problems.push('Portable static audit identity or boundary mismatch');
    if (kind === 'assertions' && !(result.assertionsPassed > 0 && result.assertionsFailed === 0)) problems.push('No actual successful health assertions');
    summary.passed = kind === 'assertions' ? result.assertionsPassed : 1;
  } else if (kind === 'package') {
    const bytes = await readFile(path.join(outputDirectory, 'candidate-package-manifest.json'));
    const manifest = JSON.parse(bytes);
    if (!identityEqual(manifest.identity, identity)) problems.push('Package identity mismatch');
    problems.push(...validatePackageContract(manifest));
    for (const archive of manifest.archives || []) {
      if (!/^[a-zA-Z0-9._-]+\.zip$/.test(archive.name || '') || !/^[a-f0-9]{64}$/.test(archive.sha256 || '')) throw new Error('Unsafe candidate archive metadata');
      const contents = await readFile(path.join(outputDirectory, archive.name));
      if (contents.length !== archive.bytes || sha256(contents) !== archive.sha256) problems.push('Candidate archive does not match manifest');
    }
    summary.packageManifestSha256 = sha256(bytes);
    summary.archives = (manifest.archives || []).map(({ name, bytes, sha256: hash }) => ({ name, bytes, sha256: hash }));
    summary.passed = 1;
  } else summary.passed = 1; // Exit-only contracts are never called behavior tests.
  return { summary, problems };
}

async function createControlledHeadSnapshot(root, directory) {
  await mkdir(directory, { mode: 0o700 });
  const entries = execFileSync('git', ['-C', root, 'ls-tree', '-r', '-z', 'HEAD'], { encoding: 'utf8', windowsHide: true, maxBuffer: 32 * 1024 * 1024 }).split('\0').filter(Boolean);
  for (const entry of entries) {
    const tab = entry.indexOf('\t');
    const [mode, type, hash] = entry.slice(0, tab).split(' ');
    const name = entry.slice(tab + 1);
    if (!['100644', '100755'].includes(mode) || type !== 'blob' || !/^[a-f0-9]{40}$/.test(hash)
      || path.isAbsolute(name) || name.includes('\\') || name.split('/').includes('..')) throw new Error('Unsupported controlled source entry');
    const destination = path.resolve(directory, name);
    if (!destination.startsWith(path.resolve(directory) + path.sep)) throw new Error('Controlled source escaped its isolated scan root');
    await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
    const bytes = execFileSync('git', ['-C', root, 'cat-file', 'blob', hash], { windowsHide: true, maxBuffer: 128 * 1024 * 1024 });
    await writeFile(destination, bytes, { flag: 'wx', mode: 0o600 });
  }
}

export async function runCiCheck({ root = process.cwd(), id, expectedCommit, recordDirectory, argv, env = process.env }) {
  const check = CI_CHECKS[id];
  if (!check) throw new Error('Unknown CI check');
  if (env.GITHUB_ACTIONS !== 'true' || !/^\d+$/.test(env.GITHUB_RUN_ID || '') || !/^\d+$/.test(env.GITHUB_RUN_ATTEMPT || '')) throw new Error('This runner requires a real GitHub Actions run identity');
  if (env.GITHUB_JOB !== check.job || (check.platform && process.platform !== check.platform)) throw new Error('Check assigned to wrong CI job or OS');
  assertOutside(root, recordDirectory);
  const outputDirectory = check.kind === 'package' ? argv.at(-1) : undefined;
  if (outputDirectory) assertOutside(root, outputDirectory);
  assertCommand(id, argv, { commit: expectedCommit, output: outputDirectory });
  const identity = await readCiIdentity(root, expectedCommit);
  await mkdir(recordDirectory, { recursive: true, mode: 0o700 });
  const rawDirectory = path.join(path.dirname(recordDirectory), 'raw-' + id);
  await mkdir(rawDirectory, { recursive: true, mode: 0o700 });
  const childEnv = isolatedChildEnvironment(env, rawDirectory, id);
  const command = await resolveCommand(argv);
  const commandRoot = id === 'gitleaks-source' ? path.join(rawDirectory, 'controlled-head') : root;
  if (id === 'gitleaks-source') await createControlledHeadSnapshot(root, commandRoot);
  const startedAt = new Date().toISOString();
  const result = await captureCommand(command.command, command.args, { cwd: commandRoot, env: childEnv });
  const logFile = path.join(rawDirectory, 'command.log');
  const output = result.output.length ? result.output : Buffer.from(`CI_COMMAND_COMPLETED exitCode=${result.exitCode}\n`);
  await writeFile(logFile, output, { flag: 'wx', mode: 0o600 });
  let inspected;
  try { inspected = await inspectCheckOutput(id, output.toString('utf8'), { platform: process.platform, rawDirectory, outputDirectory, identity }); }
  catch { inspected = { summary: null, problems: ['Check result could not be verified; raw output stays in runner temp'] }; }
  if (result.exitCode !== 0 || result.signal) inspected.problems.push('Command exited unsuccessfully');
  if (result.oversized) inspected.problems.push('Command log exceeded the bounded capture limit');
  try { if (!identityEqual(identity, await readCiIdentity(root, expectedCommit))) inspected.problems.push('Source changed during check'); }
  catch { inspected.problems.push('Source changed or became dirty during check'); }
  let diagnostics;
  if (inspected.problems.length) {
    let report;
    if (check.kind === 'e2e') {
      try { report = JSON.parse(await readFile(path.join(rawDirectory, 'playwright-results.json'), 'utf8')); } catch { /* The gate already rejects missing evidence. */ }
    }
    diagnostics = failureDiagnostics(output.toString('utf8'), {
      sourceFiles: git(root, ['ls-tree', '-r', '--name-only', '-z', 'HEAD']).split('\0'), report
    });
  }
  const record = {
    schemaVersion: 1, id, job: check.job, platform: process.platform,
    runId: env.GITHUB_RUN_ID, runAttempt: env.GITHUB_RUN_ATTEMPT,
    identity, command: publicCommand(id, expectedCommit), workingDirectory: id === 'gitleaks-source' ? 'CONTROLLED_HEAD_SNAPSHOT' : 'CHECKOUT', startedAt, completedAt: new Date().toISOString(),
    exitCode: result.exitCode, logSha256: sha256(output), logBytes: output.length,
    rawLogPublished: false, summary: inspected.summary, ...(diagnostics ? { diagnostics } : {}),
    status: inspected.problems.length ? 'FAIL' : 'PASS', problems: inspected.problems
  };
  await writeFile(path.join(recordDirectory, id + '.json'), JSON.stringify(record, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  return record;
}

async function main() {
  const args = process.argv.slice(2);
  const delimiter = args.indexOf('--');
  if (delimiter < 0) throw new Error('Expected a fixed command after --');
  const options = {};
  for (let index = 0; index < delimiter; index += 2) {
    const name = { '--id': 'id', '--expected-commit': 'expectedCommit', '--record-dir': 'recordDirectory' }[args[index]];
    if (!name || !args[index + 1]) throw new Error('Invalid CI runner arguments');
    options[name] = args[index + 1];
  }
  const record = await runCiCheck({ ...options, argv: args.slice(delimiter + 1) });
  console.log(JSON.stringify(record, null, 2));
  if (record.status !== 'PASS') process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch(() => { console.error('CI_CHECK_REJECTED: inspect the runner-local diagnostic record; no raw logs are published.'); process.exitCode = 1; });
}
