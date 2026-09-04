import { createHash } from 'node:crypto';
import { copyFile, lstat, mkdir, readFile, realpath, rename } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  assertExternal,
  atomicJson,
  git,
  readBatch,
  readJson,
  registration,
  requireApply,
  sourceIdentity
} from './workflow/state.mjs';

const INTENT_NAME = 'development-root-migration-intent.json';
const COMPLETED_NAME = 'development-root-migration-completed.json';

export async function preflightDevelopmentRootMigration(root, home, options) {
  const fromRoot = await realpath(root);
  const toRoot = path.resolve(required(options, 'to-root'));
  const recoveryDirectory = path.resolve(required(options, 'recovery-directory'));
  assertAsciiPath(toRoot);
  assertSameVolume(fromRoot, toRoot);
  await assertMissing(toRoot, 'Target development root already exists');
  await realpath(path.dirname(toRoot));
  await assertExternal(fromRoot, home);
  await assertExternal(fromRoot, recoveryDirectory);
  if (isWithin(toRoot, recoveryDirectory)) throw new Error('Recovery directory must be outside the target repository');

  const config = await registration(fromRoot, home);
  const identity = sourceIdentity(fromRoot);
  assertExpectedIdentity(identity, options);
  const worktrees = git(fromRoot, 'worktree', 'list', '--porcelain')
    .split('\n')
    .filter((line) => line.startsWith('worktree '));
  if (worktrees.length !== 1) throw new Error('Development-root migration requires one independent worktree');
  const previousBatch = await readBatch(home);
  if (!previousBatch || previousBatch.status !== 'ACTIVE') throw new Error('An active previous batch is required for an audited rollover');

  const githubCommit = required(options, 'github-main-commit');
  const githubTree = required(options, 'github-main-tree');
  if (git(fromRoot, 'rev-parse', `${githubCommit}^{tree}`) !== githubTree || githubTree !== identity.tree) {
    throw new Error('GitHub main and the local authoritative source tree must match before migration');
  }

  const nextBatch = {
    schemaVersion: 1,
    name: required(options, 'name'),
    taskId: required(options, 'task-id'),
    branch: identity.branch,
    baseline: identity.commit,
    status: 'ACTIVE',
    startedAt: new Date().toISOString()
  };
  const summary = {
    schemaVersion: 1,
    status: 'PREFLIGHT_OK',
    fromRoot,
    toRoot,
    recoveryDirectory,
    source: identity,
    github: { repository: config.github.repository, mainCommit: githubCommit, mainTree: githubTree },
    previousBatch,
    nextBatch,
    mergedPr: Number(required(options, 'merged-pr')),
    createdAt: new Date().toISOString()
  };
  if (!Number.isSafeInteger(summary.mergedPr) || summary.mergedPr < 1) throw new Error('merged-pr must be a positive integer');
  if (!options.apply) return { dryRun: true, ...summary };
  requireApply(options);

  await mkdir(path.dirname(recoveryDirectory), { recursive: true, mode: 0o700 });
  await mkdir(recoveryDirectory, { recursive: false, mode: 0o700 });
  const backupDirectory = path.join(recoveryDirectory, 'external-state-before');
  await mkdir(backupDirectory, { mode: 0o700 });
  const files = [
    [path.join(home, 'machine.json'), 'machine.json'],
    [path.join(home, 'batch.json'), 'batch.json'],
    [config.acceptedReleaseFile, 'accepted-local-release.json'],
    [path.join(config.runtimeHome, 'current-release.json'), 'current-release.json'],
    [path.join(config.runtimeHome, 'Start-MerchRoute.ps1'), 'Start-MerchRoute.ps1']
  ];
  const backups = [];
  for (const [source, name] of files) {
    const target = path.join(backupDirectory, name);
    await copyFile(source, target);
    backups.push({ name, source, sha256: await fileDigest(target) });
  }
  const bundle = path.join(recoveryDirectory, 'development-repository.bundle');
  git(fromRoot, 'bundle', 'create', bundle, '--all');
  git(fromRoot, 'bundle', 'verify', bundle);
  const intent = { ...summary, backups, bundle: { path: bundle, sha256: await fileDigest(bundle) } };
  await atomicJson(path.join(home, INTENT_NAME), intent);
  await atomicJson(path.join(recoveryDirectory, INTENT_NAME), intent);
  return { created: true, ...intent };
}

export async function finalizeDevelopmentRootMigration(root, home, options) {
  const resolvedRoot = await realpath(root);
  const intent = await readJson(path.join(home, INTENT_NAME));
  if (intent.schemaVersion !== 1 || intent.status !== 'PREFLIGHT_OK') throw new Error('A valid migration preflight intent is required');
  if (!samePath(resolvedRoot, intent.toRoot)) throw new Error('The repository is not at the approved target root');
  assertAsciiPath(resolvedRoot);
  await assertMissing(intent.fromRoot, 'The previous development root still exists');
  const identity = sourceIdentity(resolvedRoot);
  if (identity.status || identity.commit !== intent.source.commit || identity.tree !== intent.source.tree || identity.branch !== intent.source.branch) {
    throw new Error('Repository identity changed during the filesystem move');
  }
  const machinePath = path.join(home, 'machine.json');
  const batchPath = path.join(home, 'batch.json');
  const machineBackup = intent.backups.find((item) => item.name === 'machine.json');
  const batchBackup = intent.backups.find((item) => item.name === 'batch.json');
  if (!machineBackup || !batchBackup || await fileDigest(machinePath) !== machineBackup.sha256 || await fileDigest(batchPath) !== batchBackup.sha256) {
    throw new Error('External registration changed after migration preflight');
  }
  if (await fileDigest(intent.bundle.path) !== intent.bundle.sha256) throw new Error('Recovery Git bundle changed after preflight');
  git(resolvedRoot, 'bundle', 'verify', intent.bundle.path);

  const machine = await readJson(machinePath);
  const nextMachine = {
    ...machine,
    devRoot: portableAbsolute(resolvedRoot),
    baseline: { commit: identity.commit, tree: identity.tree },
    github: { ...machine.github, baselineCommit: intent.github.mainCommit, baselineTree: intent.github.mainTree },
    recoveryDirectory: portableAbsolute(intent.recoveryDirectory)
  };
  const archivedBatch = {
    ...intent.previousBatch,
    status: 'MERGED_PENDING_RELEASE',
    mergedPr: intent.mergedPr,
    publicMainCommit: intent.github.mainCommit,
    sourceTree: intent.github.mainTree,
    supersededBy: intent.nextBatch.taskId,
    transitionedAt: new Date().toISOString()
  };
  const completed = { ...intent, status: 'COMPLETED', finalizedAt: new Date().toISOString() };
  const result = {
    dryRun: !options.apply,
    machine: nextMachine,
    archivedBatch,
    activeBatch: intent.nextBatch,
    completed
  };
  if (!options.apply) return result;
  requireApply(options);

  const completedDirectory = path.join(home, 'completed');
  await mkdir(completedDirectory, { recursive: true, mode: 0o700 });
  await atomicJson(path.join(completedDirectory, `${intent.previousBatch.branch.replaceAll('/', '_')}-merged-pending-release.json`), archivedBatch);
  await atomicJson(machinePath, nextMachine);
  await atomicJson(batchPath, intent.nextBatch);
  await atomicJson(path.join(intent.recoveryDirectory, COMPLETED_NAME), completed);
  await rename(path.join(home, INTENT_NAME), path.join(home, COMPLETED_NAME));
  await atomicJson(path.join(home, COMPLETED_NAME), completed);
  await registration(resolvedRoot, home);
  return { ...result, dryRun: false, finalized: true };
}

function assertExpectedIdentity(identity, options) {
  if (identity.status) throw new Error('Uncommitted changes block development-root migration');
  for (const [key, actual] of [['expected-branch', identity.branch], ['expected-commit', identity.commit], ['expected-tree', identity.tree]]) {
    if (required(options, key) !== actual) throw new Error(`${key} does not match the local source`);
  }
}

function assertAsciiPath(value) {
  if (!path.isAbsolute(value) || !/^[\x20-\x7e]+$/.test(value)) throw new Error('Target development root must be an absolute ASCII-only path');
}

function assertSameVolume(left, right) {
  if (process.platform === 'win32' && path.parse(left).root.toLocaleLowerCase('en-US') !== path.parse(right).root.toLocaleLowerCase('en-US')) {
    throw new Error('Development-root migration must stay on one volume for an atomic directory move');
  }
}

async function assertMissing(target, message) {
  try {
    await lstat(target);
    throw new Error(message);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}

function required(options, key) {
  const value = options[key];
  if (typeof value !== 'string' || !value.trim()) throw new Error(`--${key} is required`);
  return value.trim();
}

function isWithin(root, target) {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function samePath(left, right) {
  const normalize = (value) => process.platform === 'win32' ? path.resolve(value).toLocaleLowerCase('en-US') : path.resolve(value);
  return normalize(left) === normalize(right);
}

function portableAbsolute(value) {
  return path.resolve(value).replaceAll('\\', '/');
}

async function fileDigest(file) {
  return createHash('sha256').update(await readFile(file)).digest('hex');
}

function parseArgs(args) {
  const options = {};
  const positional = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg.startsWith('--')) {
      positional.push(arg);
      continue;
    }
    const key = arg.slice(2);
    if (key === 'apply' || key === 'approved') options[key] = true;
    else {
      if (!args[index + 1] || args[index + 1].startsWith('--')) throw new Error(`Missing option: ${key}`);
      options[key] = args[index + 1];
      index += 1;
    }
  }
  return { command: positional[0], options };
}

async function main() {
  const { command, options } = parseArgs(process.argv.slice(2));
  const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
  const home = options.home ? path.resolve(options.home) : path.join(process.env.LOCALAPPDATA || path.join(process.env.HOME, '.local', 'share'), 'MerchRoute', 'development');
  if (command === 'preflight') return preflightDevelopmentRootMigration(root, home, options);
  if (command === 'finalize') return finalizeDevelopmentRootMigration(root, home, options);
  throw new Error('Usage: migrate-development-root.mjs <preflight|finalize> [options]');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then((result) => process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack || error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
