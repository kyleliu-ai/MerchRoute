import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, readFile, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { preflightDevelopmentRootMigration, finalizeDevelopmentRootMigration } from './migrate-development-root.mjs';
import { atomicJson, git, registration } from './workflow/state.mjs';

async function fixture(t) {
  const base = await realpath(await mkdtemp(path.join(os.tmpdir(), 'merchroute-root-migration-test-')));
  t.after(() => rm(base, { recursive: true, force: true }));
  const oldRoot = path.join(base, 'old-root');
  const newRoot = path.join(base, 'new-root');
  const runtimeHome = path.join(base, 'runtime');
  const home = path.join(runtimeHome, 'development');
  const recoveryDirectory = path.join(runtimeHome, 'recovery', 'root-migration');
  await mkdir(path.join(oldRoot, 'config'), { recursive: true });
  await mkdir(path.join(oldRoot, 'packages', 'shared'), { recursive: true });
  await mkdir(home, { recursive: true });
  git(oldRoot, 'init');
  git(oldRoot, 'config', 'user.name', 'MerchRoute Test');
  git(oldRoot, 'config', 'user.email', 'test@example.invalid');
  git(oldRoot, 'config', 'commit.gpgsign', 'false');
  await writeFile(path.join(oldRoot, 'config', 'release-features.json'), '{}\n');
  await writeFile(path.join(oldRoot, '.gitignore'), 'node_modules/\n');
  await writeFile(path.join(oldRoot, 'package.json'), '{"private":true,"workspaces":["packages/*"]}\n');
  await writeFile(path.join(oldRoot, 'packages', 'shared', 'package.json'), '{"name":"@n8n-media-review/shared"}\n');
  git(oldRoot, 'add', '.gitignore', 'package.json', 'config/release-features.json', 'packages/shared/package.json');
  git(oldRoot, 'commit', '-m', 'fixture');
  git(oldRoot, 'branch', 'work/previous');
  git(oldRoot, 'switch', '-c', 'work/english-path-migration-20260904-2242');
  const commit = git(oldRoot, 'rev-parse', 'HEAD');
  const tree = git(oldRoot, 'rev-parse', 'HEAD^{tree}');
  const workspaceLink = path.join(oldRoot, 'node_modules', '@n8n-media-review', 'shared');
  await mkdir(path.dirname(workspaceLink), { recursive: true });
  await symlink(path.join(oldRoot, 'packages', 'shared'), workspaceLink, process.platform === 'win32' ? 'junction' : 'dir');
  const acceptedReleaseFile = path.join(runtimeHome, 'accepted-local-release.json');
  await atomicJson(acceptedReleaseFile, { status: 'HISTORICAL' });
  await atomicJson(path.join(runtimeHome, 'current-release.json'), { productVersion: '0.1.4' });
  await writeFile(path.join(runtimeHome, 'Start-MerchRoute.ps1'), '# fixture\n');
  await atomicJson(path.join(home, 'machine.json'), {
    schemaVersion: 1,
    sourceAuthority: 'LOCAL',
    devRoot: oldRoot,
    baseline: { commit, tree },
    acceptedReleaseFile,
    runtimeHome,
    github: { repository: 'owner/repo', baselineCommit: commit, baselineTree: tree }
  });
  await atomicJson(path.join(home, 'batch.json'), {
    schemaVersion: 1,
    name: 'previous',
    taskId: 'previous-task',
    branch: 'work/previous',
    baseline: commit,
    status: 'ACTIVE',
    startedAt: '2026-09-03T00:00:00.000Z'
  });
  await atomicJson(path.join(home, 'publication.json'), { number: 29, localBatchBranch: 'work/previous' });
  await atomicJson(path.join(home, 'publication-intent.json'), { localBatchBranch: 'work/previous' });
  await atomicJson(path.join(home, 'verified.json'), { identity: { commit, tree } });
  const options = {
    'to-root': newRoot,
    'recovery-directory': recoveryDirectory,
    'expected-branch': 'work/english-path-migration-20260904-2242',
    'expected-commit': commit,
    'expected-tree': tree,
    'github-main-commit': commit,
    'github-main-tree': tree,
    'base-commit': commit,
    'base-tree': tree,
    'merged-pr': '29',
    name: 'english-path-migration',
    'task-id': 'english-path-migration-20260904-2242'
  };
  return { oldRoot, newRoot, home, recoveryDirectory, commit, tree, options };
}

test('preflight, atomic move and finalize preserve identity and roll the active batch forward', async (t) => {
  const fixtureValue = await fixture(t);
  const dryRun = await preflightDevelopmentRootMigration(fixtureValue.oldRoot, fixtureValue.home, fixtureValue.options);
  assert.equal(dryRun.dryRun, true);
  const intent = await preflightDevelopmentRootMigration(fixtureValue.oldRoot, fixtureValue.home, { ...fixtureValue.options, apply: true, approved: true });
  assert.equal(intent.created, true);
  await rename(fixtureValue.oldRoot, fixtureValue.newRoot);
  await assert.rejects(finalizeDevelopmentRootMigration(fixtureValue.newRoot, fixtureValue.home, {}), /npm ci/);
  await rm(path.join(fixtureValue.newRoot, 'node_modules'), { recursive: true, force: true });
  const workspaceLink = path.join(fixtureValue.newRoot, 'node_modules', '@n8n-media-review', 'shared');
  await mkdir(path.dirname(workspaceLink), { recursive: true });
  await symlink(path.join(fixtureValue.newRoot, 'packages', 'shared'), workspaceLink, process.platform === 'win32' ? 'junction' : 'dir');
  const finalizeDryRun = await finalizeDevelopmentRootMigration(fixtureValue.newRoot, fixtureValue.home, {});
  assert.equal(finalizeDryRun.dryRun, true);
  const result = await finalizeDevelopmentRootMigration(fixtureValue.newRoot, fixtureValue.home, { apply: true, approved: true });
  assert.equal(result.finalized, true);
  const machine = JSON.parse(await readFile(path.join(fixtureValue.home, 'machine.json'), 'utf8'));
  const batch = JSON.parse(await readFile(path.join(fixtureValue.home, 'batch.json'), 'utf8'));
  assert.equal(path.resolve(machine.devRoot), path.resolve(fixtureValue.newRoot));
  assert.deepEqual(machine.baseline, { commit: fixtureValue.commit, tree: fixtureValue.tree });
  assert.equal(batch.taskId, 'english-path-migration-20260904-2242');
  assert.equal(batch.status, 'ACTIVE');
  const archived = JSON.parse(await readFile(path.join(fixtureValue.home, 'completed', 'work_previous-merged-pending-release.json'), 'utf8'));
  assert.equal(archived.status, 'MERGED_PENDING_RELEASE');
  assert.equal(archived.mergedPr, 29);
  for (const name of ['publication.json', 'publication-intent.json', 'verified.json']) {
    await assert.rejects(readFile(path.join(fixtureValue.home, name)), /ENOENT/);
    await readFile(path.join(fixtureValue.home, 'completed', `previous-${name}`));
  }
  const featureManifest = JSON.parse(await readFile(path.join(fixtureValue.newRoot, 'config', 'release-features.json'), 'utf8'));
  assert.deepEqual(featureManifest.completedBatches, [{
    name: 'work/previous',
    head: fixtureValue.commit,
    featureId: 'project-release-guardrails'
  }]);
  await registration(fixtureValue.newRoot, fixtureValue.home);
});

test('migration rejects non-ASCII targets and a dirty source', async (t) => {
  const fixtureValue = await fixture(t);
  await assert.rejects(
    preflightDevelopmentRootMigration(fixtureValue.oldRoot, fixtureValue.home, { ...fixtureValue.options, 'to-root': path.join(path.dirname(fixtureValue.newRoot), '中文') }),
    /ASCII-only/
  );
  await writeFile(path.join(fixtureValue.oldRoot, 'dirty.txt'), 'dirty');
  await assert.rejects(preflightDevelopmentRootMigration(fixtureValue.oldRoot, fixtureValue.home, fixtureValue.options), /Uncommitted/);
});
