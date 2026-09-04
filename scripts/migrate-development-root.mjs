import { createHash } from 'node:crypto';
import { copyFile, lstat, mkdir, readFile, readdir, realpath, rename, writeFile } from 'node:fs/promises';
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
  const baseCommit = required(options, 'base-commit');
  const baseTree = required(options, 'base-tree');
  const previousBatchHead = git(fromRoot, 'rev-parse', `refs/heads/${previousBatch.branch}`);
  if (git(fromRoot, 'rev-parse', `${githubCommit}^{tree}`) !== githubTree
    || git(fromRoot, 'rev-parse', `${baseCommit}^{tree}`) !== baseTree
    || githubTree !== baseTree
    || previousBatchHead !== baseCommit
    || !isAncestor(fromRoot, baseCommit, identity.commit)) {
    throw new Error('GitHub main and the approved local branch base must match before migration');
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
    branchBase: { commit: baseCommit, tree: baseTree },
    previousBatchHead,
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
  for (const name of ['publication.json', 'publication-intent.json', 'verified.json']) {
    const source = path.join(home, name);
    try {
      await lstat(source);
    } catch (error) {
      if (error.code === 'ENOENT') continue;
      throw error;
    }
    const target = path.join(backupDirectory, name);
    await copyFile(source, target);
    backups.push({ name, source, sha256: await fileDigest(target), previousBatchState: true });
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
  await assertDevelopmentDependenciesRebased(resolvedRoot);
  const machinePath = path.join(home, 'machine.json');
  const batchPath = path.join(home, 'batch.json');
  const machineBackup = intent.backups.find((item) => item.name === 'machine.json');
  const batchBackup = intent.backups.find((item) => item.name === 'batch.json');
  if (!machineBackup || !batchBackup || await fileDigest(machinePath) !== machineBackup.sha256 || await fileDigest(batchPath) !== batchBackup.sha256) {
    throw new Error('External registration changed after migration preflight');
  }
  const previousBatchState = intent.backups.filter((item) => item.previousBatchState === true);
  for (const item of previousBatchState) {
    if (await fileDigest(item.source) !== item.sha256) throw new Error(`Previous batch state changed after migration preflight: ${item.name}`);
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
  const featureManifestPath = path.join(resolvedRoot, 'config', 'release-features.json');
  const featureManifest = await readJson(featureManifestPath);
  featureManifest.completedBatches ||= [];
  if (featureManifest.branches?.some((item) => item.name === intent.previousBatch.branch)
    || featureManifest.completedBatches.some((item) => item.name === intent.previousBatch.branch)) {
    throw new Error('Previous batch already exists in the retained branch ledger');
  }
  featureManifest.completedBatches.push({
    name: intent.previousBatch.branch,
    head: intent.previousBatchHead,
    featureId: 'project-release-guardrails'
  });
  const completed = { ...intent, status: 'COMPLETED', finalizedAt: new Date().toISOString() };
  const result = {
    dryRun: !options.apply,
    machine: nextMachine,
    archivedBatch,
    activeBatch: intent.nextBatch,
    featureManifest,
    completed
  };
  if (!options.apply) return result;
  requireApply(options);

  const completedDirectory = path.join(home, 'completed');
  await mkdir(completedDirectory, { recursive: true, mode: 0o700 });
  await atomicJson(path.join(completedDirectory, `${intent.previousBatch.branch.replaceAll('/', '_')}-merged-pending-release.json`), archivedBatch);
  for (const item of previousBatchState) {
    await rename(item.source, path.join(completedDirectory, `${intent.previousBatch.name}-${item.name}`));
  }
  await writeFile(featureManifestPath, `${JSON.stringify(featureManifest, null, 2)}\n`);
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

function isAncestor(root, ancestor, descendant) {
  try {
    git(root, 'merge-base', '--is-ancestor', ancestor, descendant);
    return true;
  } catch {
    return false;
  }
}

export async function assertDevelopmentDependenciesRebased(root) {
  const modulesRoot = path.join(root, 'node_modules');
  let entries;
  try {
    entries = await readdir(modulesRoot, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') throw new Error('node_modules is missing after the move; run npm ci from the target root before finalize');
    throw error;
  }
  const candidates = [];
  for (const entry of entries) {
    if (entry.name === '.bin') continue;
    const absolute = path.join(modulesRoot, entry.name);
    if (entry.name.startsWith('@') && entry.isDirectory()) {
      for (const child of await readdir(absolute, { withFileTypes: true })) candidates.push(path.join(absolute, child.name));
    } else candidates.push(absolute);
  }
  for (const candidate of candidates) {
    const metadata = await lstat(candidate);
    if (!metadata.isSymbolicLink()) continue;
    let target;
    try {
      target = await realpath(candidate);
    } catch (error) {
      if (error.code === 'ENOENT') throw new Error(`A stale dependency link still points to the previous root; run npm ci before finalize: ${path.relative(root, candidate)}`);
      throw error;
    }
    if (!isWithin(root, target)) throw new Error(`An external dependency link is forbidden after migration: ${path.relative(root, candidate)}`);
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
