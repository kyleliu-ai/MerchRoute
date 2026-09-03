import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, mkdtemp, mkdir, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import {
  assertSafeCredentialRequirements, collectPrebuiltFiles, collectSourceFromHead, crc32, createDeterministicZip,
  createPackageArtifacts, isForbiddenPackagePath, packageReleaseCandidate,
  validateArchivePath, validateBuildInfo, validateOutputDirectory,
  validateSourceEntries, writeArtifactsWithoutOverwrite
} from './package-release-candidate.mjs';

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sha = (value) => createHash('sha256').update(value).digest('hex');

async function fixtureDirectory(t, label) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'merchroute-package-' + label + '-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}
async function put(root, relative, content) {
  await mkdir(path.dirname(path.join(root, relative)), { recursive: true });
  await writeFile(path.join(root, relative), content);
}
function git(root, ...args) {
  return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}
async function sourceFixture(t) {
  const root = await fixtureDirectory(t, 'repository');
  // These disposable test refs never touch the user's repository or worktrees.
  git(root, 'init', '--quiet');
  const entries = {
    'AGENTS.md': '测试规则\n',
    'config/content-fingerprint-scope.json': await readFile(path.join(project, 'config/content-fingerprint-scope.json')),
    'config/release-features.json': '{}\n',
    'package.json': '{"type":"module","version":"0.1.0"}\n',
    'package-lock.json': '{}\n',
    'apps/server/src/index.ts': 'export const server = true;\n',
    'apps/web/src/main.tsx': 'export const web = true;\n',
    'packages/shared/src/index.ts': 'export const shared = true;\n',
    '.gitignore': '.env\nnode_modules/\n.tools/\n**/dist/\n',
    '.gitattributes': '* text=auto eol=lf\n*.ps1 text eol=crlf\n',
    '.env.example': '# EXAMPLE_ONLY=value\n',
    'scripts/example.ps1': 'Write-Output "测试"\r\n',
    'scripts/执行.sh': '#!/bin/sh\nprintf test\n',
    'docs/中文.bin': Buffer.from([0, 255, 17, 0, 128]),
    '.github/workflows/check.yml': 'name: fixture\n'
  };
  for (const [name, data] of Object.entries(entries)) await put(root, name, data);
  // Git's index bit alone leaves the POSIX worktree dirty. Exercise real file
  // permissions as well; Windows still needs the explicit index bit below.
  if (process.platform !== 'win32') await chmod(path.join(root, 'scripts/执行.sh'), 0o755);
  git(root, 'add', '--', ...Object.keys(entries));
  git(root, 'update-index', '--chmod=+x', 'scripts/执行.sh');
  git(root, '-c', 'user.name=Package Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '--quiet', '-m', 'Disposable packaging fixture');
  assert.equal(git(root, 'status', '--porcelain=v1'), '', 'Fixture must start clean on every OS');
  if (process.platform !== 'win32') assert.equal((await stat(path.join(root, 'scripts/执行.sh'))).mode & 0o111, 0o111);
  return root;
}
async function buildFixture(root, identity) {
  const info = {
    schemaVersion: 1, productVersion: '0.1.0', configVersion: 'v003',
    builtAt: '2026-09-03T00:00:00.000Z', commitSha: identity.commit, dirty: false,
    scopeVersion: identity.scopeVersion, fingerprints: identity.fingerprints, fileCounts: identity.fileCounts
  };
  for (const [name, content] of Object.entries({
    'apps/server/dist/index.js': 'console.log("fixture");\n',
    'apps/server/dist/build-info.json': JSON.stringify(info, null, 2) + '\n',
    'apps/server/dist/.tsbuildinfo': 'cache excluded',
    'apps/web/dist/index.html': '<script src="/assets/app.js"></script>',
    'apps/web/dist/assets/app.js': 'console.log("浏览器");\n',
    'packages/shared/dist/index.js': 'export const shared = true;\n',
    'packages/shared/dist/.tsbuildinfo': 'cache excluded'
  })) await put(root, name, content);
  return info;
}

function decodeZip(bytes) {
  const endOffset = bytes.length - 22;
  assert.equal(bytes.readUInt32LE(endOffset), 0x06054b50);
  const count = bytes.readUInt16LE(endOffset + 10);
  let cursor = bytes.readUInt32LE(endOffset + 16);
  const entries = [];
  for (let index = 0; index < count; index += 1) {
    assert.equal(bytes.readUInt32LE(cursor), 0x02014b50);
    assert.equal(bytes.readUInt16LE(cursor + 8), 0x800);
    assert.equal(bytes.readUInt16LE(cursor + 10), 0);
    assert.equal(bytes.readUInt16LE(cursor + 12), 0);
    assert.equal(bytes.readUInt16LE(cursor + 14), 33);
    const nameSize = bytes.readUInt16LE(cursor + 28);
    const size = bytes.readUInt32LE(cursor + 24);
    const name = bytes.subarray(cursor + 46, cursor + 46 + nameSize).toString('utf8');
    const local = bytes.readUInt32LE(cursor + 42);
    assert.equal(bytes.readUInt32LE(local), 0x04034b50);
    const start = local + 30 + bytes.readUInt16LE(local + 26) + bytes.readUInt16LE(local + 28);
    const data = bytes.subarray(start, start + size);
    assert.equal(crc32(data), bytes.readUInt32LE(cursor + 16));
    entries.push({ path: name, data, mode: (bytes.readUInt32LE(cursor + 38) >>> 16).toString(8) });
    cursor += 46 + nameSize + bytes.readUInt16LE(cursor + 30) + bytes.readUInt16LE(cursor + 32);
  }
  assert.equal(cursor, endOffset);
  return entries;
}

test('ZIP preserves binary, UTF-8, executable modes and is byte-identical regardless of input ordering', () => {
  assert.equal(crc32(Buffer.from('123456789')), 0xcbf43926);
  const files = [
    { path: '目录/二进制.bin', mode: '100644', data: Buffer.from([0, 1, 255, 128]) },
    { path: 'run.sh', mode: '100755', data: Buffer.from('#!/bin/sh\n') }
  ];
  const bytes = createDeterministicZip(files);
  assert.deepEqual(bytes, createDeterministicZip([...files].reverse()));
  const unpacked = decodeZip(bytes);
  assert.deepEqual(unpacked.map((entry) => entry.path), ['run.sh', '目录/二进制.bin']);
  for (const file of files) assert.deepEqual(unpacked.find((entry) => entry.path === file.path), file);
  const corrupted = Buffer.from(bytes);
  corrupted[30 + Buffer.byteLength('run.sh')] ^= 1;
  assert.throws(() => decodeZip(corrupted));
});

test('source is complete controlled HEAD blobs, not platform CRLF or ignored sensitive data', async (t) => {
  const root = await sourceFixture(t);
  await put(root, '.env', 'TEST_ONLY=never-pack\n');
  await put(root, 'node_modules/test/index.js', 'not bundled');
  const source = await collectSourceFromHead(root);
  assert.equal(source.files.length, 15);
  assert.equal(source.files.find((entry) => entry.path === 'scripts/example.ps1').data.toString('utf8'), 'Write-Output "测试"\n');
  assert.equal(source.files.find((entry) => entry.path === 'scripts/执行.sh').mode, '100755');
  assert.ok(source.files.some((entry) => entry.path === '.env.example'));
  assert.ok(source.files.some((entry) => entry.path === '.github/workflows/check.yml'));
  assert.ok(!source.files.some((entry) => entry.path === '.env' || entry.path.includes('node_modules')));
  assert.deepEqual(source.files.find((entry) => entry.path === 'docs/中文.bin').data, Buffer.from([0, 255, 17, 0, 128]));
  const originalOverride = process.env.MERCHROUTE_BUILD_SHA;
  try {
    process.env.MERCHROUTE_BUILD_SHA = 'a'.repeat(40);
    assert.equal((await collectSourceFromHead(root)).identity.commit, git(root, 'rev-parse', 'HEAD'));
  } finally {
    if (originalOverride === undefined) delete process.env.MERCHROUTE_BUILD_SHA;
    else process.env.MERCHROUTE_BUILD_SHA = originalOverride;
  }
  await put(root, 'apps/server/src/index.ts', 'changed');
  await assert.rejects(() => collectSourceFromHead(root), /clean, committed/);
});

test('required-source omissions, tracked secrets, links, submodules and unsafe archive paths stop packaging', async (t) => {
  const root = await sourceFixture(t);
  const source = await collectSourceFromHead(root);
  const entries = source.files.map((entry) => ({ ...entry, type: 'blob' }));
  validateSourceEntries(entries);
  assert.throws(() => validateSourceEntries(entries.filter((entry) => entry.path !== 'AGENTS.md')), /missing/);
  for (const name of ['.env', 'prod.env', 'prod.env.local', 'nested/.env.example', 'logs/session.txt', 'db-backups/archive.sql', 'private.dump', 'merchroute.sql', 'backup.tar.gz', 'data.bak.1', 'SECRETS.yaml', 'auth.toml', 'credentials.json', '.tools/tool.exe', 'node_modules/pkg/a.js']) {
    assert.equal(isForbiddenPackagePath(name), true, name);
    assert.throws(() => validateSourceEntries([...entries, { path: name, mode: '100644', type: 'blob' }]), /Sensitive or runtime/);
  }
  for (const mode of ['120000', '160000']) assert.throws(() => validateSourceEntries([...entries, { path: 'shortcut', mode, type: mode === '160000' ? 'commit' : 'blob' }]), /Symlink, submodule/);
  for (const name of ['../escape', '/absolute', 'C:/absolute', 'folder\\escape', 'double//file', 'bad\nname', 'trailing.']) assert.throws(() => validateArchivePath(name), /Unsafe/);
  assert.throws(() => createDeterministicZip([{ path: 'a', mode: '100644', data: Buffer.alloc(0) }, { path: 'A', mode: '100644', data: Buffer.alloc(0) }]), /Duplicate/);
});

test('only the exact sanitized credential requirements schema is permitted, never credential values', async () => {
  const bytes = await readFile(path.join(project, 'deployment/n8n/credential-requirements.json'));
  assert.equal(isForbiddenPackagePath('deployment/n8n/credential-requirements.json'), false);
  assertSafeCredentialRequirements(bytes);
  const changed = JSON.parse(bytes.toString('utf8'));
  changed.requirements[0].fields[0].value = 'TEST_ONLY_NOT_A_REAL_CREDENTIAL';
  assert.throws(() => assertSafeCredentialRequirements(Buffer.from(JSON.stringify(changed))), /values|unreviewed/);
  assert.equal(isForbiddenPackagePath('another/credential-requirements.json'), true);
});

test('build must match clean HEAD identity; corrupt metadata, missing outputs, secrets and links are refused', async (t) => {
  const root = await sourceFixture(t);
  const source = await collectSourceFromHead(root);
  const info = await buildFixture(root, source.identity);
  const built = await collectPrebuiltFiles(root, source.identity);
  assert.equal(built.length, 5);
  assert.ok(!built.some((entry) => entry.path.endsWith('.tsbuildinfo')));
  assert.throws(() => validateBuildInfo(source.identity, { ...info, dirty: true }), /does not match/);
  assert.throws(() => validateBuildInfo(source.identity, { ...info, commitSha: 'b'.repeat(40) }), /does not match/);
  assert.throws(() => validateBuildInfo(source.identity, { ...info, fingerprints: { ...info.fingerprints, documentation: 'stale' } }), /does not match/);
  assert.throws(() => validateBuildInfo(source.identity, { ...info, secret: 'forbidden' }), /unreviewed fields/);
  await put(root, 'apps/server/dist/build-info.json', '{corrupt');
  await assert.rejects(() => collectPrebuiltFiles(root, source.identity));
  await buildFixture(root, source.identity);
  await rm(path.join(root, 'apps/server/dist/index.js'));
  await assert.rejects(() => collectPrebuiltFiles(root, source.identity), /missing/);
  await buildFixture(root, source.identity);
  await put(root, 'apps/server/dist/.env', 'TEST_ONLY');
  await assert.rejects(() => collectPrebuiltFiles(root, source.identity), /Unsafe build/);
  await rm(path.join(root, 'apps/server/dist/.env'));
  const target = await fixtureDirectory(t, 'link-target');
  await symlink(target, path.join(root, 'apps/server/dist/link'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(() => collectPrebuiltFiles(root, source.identity), /Symlink|reparse|links/);
});

test('output must be outside every repository and cannot follow a filesystem link', async (t) => {
  const root = await fixtureDirectory(t, 'output-repository');
  await assert.rejects(() => validateOutputDirectory(root, 'relative-output'), /absolute/);
  await assert.rejects(() => validateOutputDirectory(root, path.parse(root).root), /dedicated/);
  await assert.rejects(() => validateOutputDirectory(root, path.join(root, 'artifacts')), /overlap/);
  const another = await fixtureDirectory(t, 'other-worktree');
  await assert.rejects(() => validateOutputDirectory(root, path.join(another, 'artifacts'), [another]), /overlap/);
  const outside = await fixtureDirectory(t, 'output-external');
  assert.equal(await validateOutputDirectory(root, path.join(outside, 'artifacts')), path.join(outside, 'artifacts'));
  await symlink(root, path.join(outside, 'alias'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(() => validateOutputDirectory(root, path.join(outside, 'alias', 'artifacts')), /Symlink|reparse/);
});

test('source and source-with-prebuilt manifests have exact file hashes and contain no local absolute paths', async (t) => {
  const root = await sourceFixture(t);
  const source = await collectSourceFromHead(root);
  await buildFixture(root, source.identity);
  const built = await collectPrebuiltFiles(root, source.identity);
  const result = createPackageArtifacts(source, built);
  const reordered = createPackageArtifacts({ ...source, files: [...source.files].reverse() }, [...built].reverse());
  assert.deepEqual(reordered.artifacts, result.artifacts);
  const output = await fixtureDirectory(t, 'full-output');
  await writeArtifactsWithoutOverwrite(output, result.artifacts);
  await writeArtifactsWithoutOverwrite(output, result.artifacts);
  assert.equal((await readdir(output)).length, 4);
  assert.ok(!JSON.stringify(result.manifest).includes(root));
  assert.equal(result.manifest.requiresDependencyInstallation, true);
  for (const archive of result.manifest.archives) {
    const file = await readFile(path.join(output, archive.name));
    assert.equal(sha(file), archive.sha256);
    const extracted = decodeZip(file);
    const expected = archive.kind === 'SOURCE_CANDIDATE' ? result.manifest.files.source : [...result.manifest.files.source, ...result.manifest.files.prebuilt];
    assert.equal(extracted.length, expected.length);
    for (const entry of expected) {
      const unpacked = extracted.find((item) => item.path === entry.path);
      assert.equal(unpacked.mode, entry.gitMode);
      assert.equal(unpacked.data.length, entry.bytes);
      assert.equal(sha(unpacked.data), entry.sha256);
    }
  }
  const conflicting = await fixtureDirectory(t, 'conflict-output');
  await writeFile(path.join(conflicting, result.artifacts[0].name), 'do not overwrite');
  await assert.rejects(() => writeArtifactsWithoutOverwrite(conflicting, result.artifacts), /Different output/);
  assert.equal(await readFile(path.join(conflicting, result.artifacts[0].name), 'utf8'), 'do not overwrite');
  assert.equal((await readdir(conflicting)).length, 1);
  const unrelated = await fixtureDirectory(t, 'unrelated-output');
  await writeFile(path.join(unrelated, 'unrelated.txt'), 'must never upload this');
  await assert.rejects(() => writeArtifactsWithoutOverwrite(unrelated, result.artifacts), /unrelated/);
  assert.deepEqual(await readdir(unrelated), ['unrelated.txt']);
  const packaged = await packageReleaseCandidate({ root, output });
  assert.equal(packaged.ok, true);
  assert.equal(packaged.published, false);
  assert.deepEqual(packaged.files.map((entry) => entry.name), result.artifacts.map((entry) => entry.name));
});
