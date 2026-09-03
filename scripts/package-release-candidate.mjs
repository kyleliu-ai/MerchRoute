import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { link, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { CREDENTIAL_DEFINITIONS } from '../deployment/n8n/credential-contract.mjs';
import {
  collectGithubTreeSnapshot,
  readFingerprintScopeContract,
  summarizeContentSnapshot
} from '../apps/server/src/services/content-fingerprint.ts';

const scopePath = 'config/content-fingerprint-scope.json';
const featurePath = 'config/release-features.json';
const requiredSourcePaths = ['AGENTS.md', scopePath, featurePath, 'package.json', 'package-lock.json', 'apps/server/src/index.ts', 'apps/web/src/main.tsx', 'packages/shared/src/index.ts'];
const buildRoots = ['apps/server/dist', 'apps/web/dist', 'packages/shared/dist'];
const requiredBuildPaths = ['apps/server/dist/index.js', 'apps/server/dist/build-info.json', 'apps/web/dist/index.html', 'packages/shared/dist/index.js'];
const scopes = ['runtime', 'documentation', 'verification'];
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const compareNames = (left, right) => Buffer.compare(Buffer.from(left.path, 'utf8'), Buffer.from(right.path, 'utf8'));

function git(root, args, input) {
  return execFileSync('git', ['-C', root, ...args], { input, windowsHide: true, maxBuffer: 512 * 1024 * 1024 });
}

export function validateArchivePath(value) {
  if (typeof value !== 'string' || !value || value.startsWith('/') || value.includes('\\')
    || [...value].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127 || character === ':')
    || value.split('/').some((part) => !part || part === '.' || part === '..' || /[. ]$/.test(part))) {
    throw new Error('Unsafe archive path');
  }
  return value;
}

export function isForbiddenPackagePath(value, { prebuilt = false } = {}) {
  validateArchivePath(value);
  const parts = value.split('/');
  const basename = parts.at(-1);
  const lower = parts.map((part) => part.toLowerCase());
  const forbiddenDirectories = new Set([
    '.git', 'node_modules', '.tools', '.codex-tmp', '.e2e-data', '.runtime-backups',
    '.cache', '.npm', 'app-data', 'browser-profiles', 'playwright-cache', 'playwright-report',
    'test-results', 'acceptance-results', 'coverage', 'database-backups', 'db-backups',
    'backups', 'logs', 'sessions', 'tmp', 'outputs', 'data-test'
  ]);
  if (lower.slice(0, -1).some((part) => forbiddenDirectories.has(part))) return true;
  if (!prebuilt && lower.slice(0, -1).includes('dist')) return true;
  if (lower[0] === 'deployment' && lower.includes('private')) return true;
  if (lower[0] === 'integrations' && lower.slice(1, -1).some((part) => ['data', 'backup'].includes(part))) return true;
  // This is a schema of logical credential requirements, never credential data.
  // Its contents are validated against the controlled definitions below.
  if (value === 'deployment/n8n/credential-requirements.json') return false;
  if (basename === '.env.example') return value !== '.env.example';
  return /(?:^|\.)env(?:[._-].*)?$/i.test(basename)
    || /^(?:cookies?|credentials?|secrets?|auth|tokens?)(?:[._-].*)?\.(?:json|jsonl|ndjson|txt|ya?ml|toml|ini|conf|env|enc|csv)$/i.test(basename)
    || /\.(?:db|db-journal|sqlite|sqlite3|pem|key|p12|pfx|p8|ppk|jks|keystore|dump|sql|tsbuildinfo)$/i.test(basename)
    || /\.(?:backup|bak|log)(?:[._-].*)?$/i.test(basename)
    || /\.(?:zip|tar|gz|tgz|bz2|xz|7z|rar)$/i.test(basename)
    || ['.DS_Store', 'Thumbs.db', 'Desktop.ini'].includes(basename);
}

export function assertSafeCredentialRequirements(data) {
  const value = JSON.parse(data.toString('utf8'));
  const allowedKeys = ['schemaVersion', 'source', 'communityNodes', 'requirements', 'bindings', 'generatedAt'];
  if (value.schemaVersion !== 1 || value.source !== 'live-n8n-bindings-with-identifiers-removed'
    || Object.keys(value).some((key) => !allowedKeys.includes(key))
    || !Array.isArray(value.requirements) || !Array.isArray(value.bindings)) throw new Error('Credential requirements schema is unsafe');
  const expected = Object.keys(CREDENTIAL_DEFINITIONS).sort().map((logicalAlias) => ({ logicalAlias, ...CREDENTIAL_DEFINITIONS[logicalAlias] }));
  if (JSON.stringify(value.requirements) !== JSON.stringify(expected)) throw new Error('Credential requirements contain values or unreviewed definitions');
  const expectedCommunity = [{ package: 'n8n-nodes-globals', version: '1.1.0', credentialType: 'globalConstantsApi' }];
  if (JSON.stringify(value.communityNodes) !== JSON.stringify(expectedCommunity)) throw new Error('Credential community-node declaration is not the controlled schema');
  for (const binding of value.bindings) {
    if (!binding || Object.keys(binding).sort().join(',') !== 'credentialType,logicalAlias,nodeName,workflowId'
      || !Object.values(binding).every((item) => typeof item === 'string')
      || CREDENTIAL_DEFINITIONS[binding.logicalAlias]?.type !== binding.credentialType) throw new Error('Credential binding contains non-schema data');
  }
  if (value.generatedAt !== undefined && !Number.isFinite(Date.parse(value.generatedAt))) throw new Error('Credential requirements timestamp is invalid');
}

export function validateSourceEntries(entries) {
  const names = new Set();
  for (const entry of entries) {
    validateArchivePath(entry.path);
    const portableKey = entry.path.normalize('NFC').toLowerCase();
    if (names.has(portableKey)) throw new Error('Duplicate or non-portable case-colliding archive path: ' + entry.path);
    names.add(portableKey);
    if (entry.type !== 'blob' || !['100644', '100755'].includes(entry.mode)) throw new Error('Symlink, submodule or unsupported Git mode: ' + entry.path);
    if (isForbiddenPackagePath(entry.path)) throw new Error('Sensitive or runtime path is tracked; packaging stopped: ' + entry.path);
  }
  for (const required of requiredSourcePaths) {
    if (!entries.some((entry) => entry.path === required)) throw new Error('Required controlled source missing: ' + required);
  }
}

export async function collectSourceFromHead(root) {
  const dirty = git(root, ['status', '--porcelain=v1', '--untracked-files=all']).toString('utf8').trim();
  if (dirty) throw new Error('Packaging requires a clean, committed working tree');
  const commit = git(root, ['rev-parse', 'HEAD']).toString('utf8').trim();
  const headTreeHash = git(root, ['rev-parse', 'HEAD^{tree}']).toString('utf8').trim();
  if (!/^[0-9a-f]{40,64}$/.test(commit)) throw new Error('Cannot determine real HEAD');
  const treeBytes = git(root, ['ls-tree', '-r', '-z', '--full-tree', commit]);
  const treeText = treeBytes.toString('utf8');
  if (!Buffer.from(treeText, 'utf8').equals(treeBytes)) throw new Error('Controlled paths are not valid UTF-8');
  const entries = treeText.split('\0').filter(Boolean).map((line) => {
    const separator = line.indexOf('\t');
    const [mode, type, oid] = line.slice(0, separator).split(' ');
    return { path: line.slice(separator + 1), mode, type, oid };
  }).sort(compareNames);
  validateSourceEntries(entries);
  const objectIds = [...new Set(entries.map((entry) => entry.oid))];
  const response = git(root, ['cat-file', '--batch'], objectIds.join('\n') + '\n');
  const objects = new Map();
  let offset = 0;
  for (const oid of objectIds) {
    const end = response.indexOf(10, offset);
    const header = response.subarray(offset, end).toString('ascii').split(' ');
    const size = Number(header[2]);
    if (end < 0 || header[0] !== oid || header[1] !== 'blob' || !Number.isSafeInteger(size) || size < 0) throw new Error('Git blob response is incomplete');
    const start = end + 1;
    if (start + size >= response.length || response[start + size] !== 10) throw new Error('Git blob size mismatch');
    objects.set(oid, response.subarray(start, start + size));
    offset = start + size + 1;
  }
  if (offset !== response.length) throw new Error('Unexpected Git blob data');
  const files = entries.map((entry) => ({ path: entry.path, mode: entry.mode, data: objects.get(entry.oid) }));
  const byPath = new Map(files.map((entry) => [entry.path, entry]));
  if (byPath.has('deployment/n8n/credential-requirements.json')) assertSafeCredentialRequirements(byPath.get('deployment/n8n/credential-requirements.json').data);
  const contract = JSON.parse(byPath.get(scopePath).data.toString('utf8'));
  const workingContract = await readFingerprintScopeContract(root);
  if (JSON.stringify(contract) !== JSON.stringify(workingContract)) throw new Error('Scope contract differs from controlled HEAD');
  const snapshot = collectGithubTreeSnapshot(entries.map((entry) => ({ path: entry.path, sha: entry.oid, type: 'blob' })), contract);
  const identity = {
    commit, headTreeHash, ...summarizeContentSnapshot(snapshot),
    agentsSha256: hash(byPath.get('AGENTS.md').data),
    scopeContractSha256: hash(byPath.get(scopePath).data),
    featureManifestSha256: hash(byPath.get(featurePath).data)
  };
  // All safe tracked blobs ship, including files excluded only from fingerprint
  // calculation (such as the scope contract). Unsafe paths fail closed above.
  return { files, identity };
}

async function assertNoLinksInPath(target) {
  const absolute = path.resolve(target);
  const parsed = path.parse(absolute);
  let current = parsed.root;
  for (const part of absolute.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    try {
      const info = await lstat(current);
      if (info.isSymbolicLink()) throw new Error('Symlink/reparse-point paths are not allowed');
    } catch (error) {
      if (error.code === 'ENOENT') break;
      throw error;
    }
  }
}

function containsPath(parent, child) {
  const relative = path.relative(parent, child);
  return !relative || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative));
}

export async function validateOutputDirectory(root, output, additionalRepositoryRoots = []) {
  if (!path.isAbsolute(output) || path.resolve(output) === path.parse(path.resolve(output)).root) throw new Error('Output must be a dedicated absolute directory outside the repository');
  const resolved = path.resolve(output);
  for (const repository of [root, ...additionalRepositoryRoots]) {
    if (containsPath(path.resolve(repository), resolved) || containsPath(resolved, path.resolve(repository))) throw new Error('Output may not overlap any repository or Git metadata directory');
  }
  await assertNoLinksInPath(resolved);
  await mkdir(resolved, { recursive: true, mode: 0o700 });
  if (!(await lstat(resolved)).isDirectory()) throw new Error('Output must be a directory');
  if ((await realpath(resolved)) !== resolved) {
    // realpath casing may differ on Windows; compare using the platform path key.
    const key = (value) => process.platform === 'win32' ? value.toLowerCase() : value;
    if (key(await realpath(resolved)) !== key(resolved)) throw new Error('Output resolves through a filesystem alias');
  }
  return resolved;
}

export function validateBuildInfo(identity, info) {
  const allowedKeys = ['schemaVersion', 'productVersion', 'configVersion', 'builtAt', 'commitSha', 'dirty', 'scopeVersion', 'fingerprints', 'fileCounts'];
  if (!info || info.schemaVersion !== 1 || Object.keys(info).some((key) => !allowedKeys.includes(key))) throw new Error('Build metadata is invalid or contains unreviewed fields');
  if (info.commitSha !== identity.commit || info.dirty !== false || info.scopeVersion !== identity.scopeVersion
    || !scopes.every((scope) => info.fingerprints?.[scope] === identity.fingerprints[scope] && info.fileCounts?.[scope] === identity.fileCounts[scope])) {
    throw new Error('Build metadata does not match this clean real HEAD and its three fingerprints');
  }
  if (!Number.isFinite(Date.parse(info.builtAt)) || typeof info.productVersion !== 'string' || typeof info.configVersion !== 'string') throw new Error('Build metadata is incomplete');
}

export async function collectPrebuiltFiles(root, identity) {
  const files = [];
  async function visit(relative) {
    validateArchivePath(relative);
    const absolute = path.join(root, relative);
    await assertNoLinksInPath(absolute);
    const info = await lstat(absolute);
    if (info.isSymbolicLink()) throw new Error('Build links are forbidden: ' + relative);
    if (info.isDirectory()) {
      if (isForbiddenPackagePath(relative + '/.path-check', { prebuilt: true })) throw new Error('Unsafe build artifact directory: ' + relative);
      for (const entry of (await readdir(absolute)).sort()) await visit(relative + '/' + entry);
    } else if (info.isFile()) {
      if (/\.tsbuildinfo$/i.test(relative)) return;
      if (isForbiddenPackagePath(relative, { prebuilt: true })) throw new Error('Unsafe build artifact: ' + relative);
      files.push({ path: relative, mode: '100644', data: await readFile(absolute) });
    } else throw new Error('Unsupported build artifact: ' + relative);
  }
  for (const directory of buildRoots) await visit(directory);
  files.sort(compareNames);
  for (const required of requiredBuildPaths) if (!files.some((entry) => entry.path === required)) throw new Error('Required build artifact missing: ' + required);
  const info = JSON.parse(files.find((entry) => entry.path === 'apps/server/dist/build-info.json').data.toString('utf8'));
  validateBuildInfo(identity, info);
  return files;
}

const crcTable = Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) value = (value & 1) ? (0xedb88320 ^ (value >>> 1)) : (value >>> 1);
  return value >>> 0;
});

export function crc32(data) {
  let crc = 0xffffffff;
  for (const value of data) crc = crcTable[(crc ^ value) & 255] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

// ZIP method 0 (stored) avoids compressor-version variability. UTF-8 names,
// fixed 1980-01-01 timestamp and Git Unix file modes make byte output stable.
export function createDeterministicZip(input) {
  const entries = [...input].sort(compareNames);
  if (entries.length > 65535) throw new Error('ZIP64 is deliberately unsupported');
  const localParts = [];
  const centralParts = [];
  const seen = new Set();
  let offset = 0;
  for (const entry of entries) {
    validateArchivePath(entry.path);
    if (!['100644', '100755'].includes(entry.mode) || !Buffer.isBuffer(entry.data)) throw new Error('Invalid ZIP entry');
    const portableKey = entry.path.normalize('NFC').toLowerCase();
    if (seen.has(portableKey)) throw new Error('Duplicate ZIP entry');
    seen.add(portableKey);
    const name = Buffer.from(entry.path, 'utf8');
    const size = entry.data.length;
    if (name.length > 65535 || size > 0xffffffff) throw new Error('ZIP entry exceeds supported limits');
    const crc = crc32(entry.data);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(0x800, 6);
    header.writeUInt16LE(0, 8);
    header.writeUInt16LE(0, 10);
    header.writeUInt16LE(33, 12);
    header.writeUInt32LE(crc, 14);
    header.writeUInt32LE(size, 18);
    header.writeUInt32LE(size, 22);
    header.writeUInt16LE(name.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE((3 << 8) | 20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x800, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(33, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(size, 20);
    central.writeUInt32LE(size, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE((Number.parseInt(entry.mode, 8) << 16) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    localParts.push(header, name, entry.data);
    centralParts.push(central, name);
    offset += header.length + name.length + size;
    if (offset > 0xffffffff) throw new Error('ZIP64 is deliberately unsupported');
  }
  const central = Buffer.concat(centralParts);
  if (central.length > 0xffffffff) throw new Error('ZIP64 is deliberately unsupported');
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(central.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...localParts, central, end]);
}

const describeFiles = (files) => files.map((entry) => ({ path: entry.path, gitMode: entry.mode, bytes: entry.data.length, sha256: hash(entry.data) }));

export function createPackageArtifacts(source, prebuilt) {
  const sourceFiles = [...source.files].sort(compareNames);
  const prebuiltFiles = [...prebuilt].sort(compareNames);
  const prefix = 'merchroute-' + source.identity.commit.slice(0, 12);
  const sourceName = prefix + '-source.zip';
  const prebuiltName = prefix + '-source-with-prebuilt.zip';
  const sourceBytes = createDeterministicZip(sourceFiles);
  const prebuiltBytes = createDeterministicZip([...sourceFiles, ...prebuiltFiles]);
  const archives = [
    { name: sourceName, kind: 'SOURCE_CANDIDATE', bytes: sourceBytes.length, sha256: hash(sourceBytes), fileCount: source.files.length },
    { name: prebuiltName, kind: 'SOURCE_WITH_PREBUILT_CANDIDATE', bytes: prebuiltBytes.length, sha256: hash(prebuiltBytes), fileCount: source.files.length + prebuilt.length }
  ];
  const manifest = {
    schemaVersion: 1,
    artifactRole: 'REVIEWABLE_CANDIDATE_NOT_INSTALLED_OR_PUBLISHED_RELEASE',
    sourceDirty: false,
    buildDirty: false,
    requiresDependencyInstallation: true,
    includesCredentialsOrRuntimeConfiguration: false,
    reproducibility: 'IDENTICAL_HEAD_BLOBS_AND_IDENTICAL_PREBUILT_BYTES',
    zipFormat: { method: 'STORE', filenameEncoding: 'UTF-8', timestamp: '1980-01-01T00:00:00Z', paths: 'repository-relative', fileModes: 'Git Unix modes' },
    identity: source.identity,
    archives,
    files: { source: describeFiles(sourceFiles), prebuilt: describeFiles(prebuiltFiles) }
  };
  const manifestBytes = Buffer.from(JSON.stringify(manifest, null, 2) + '\n', 'utf8');
  const artifacts = [
    { name: sourceName, data: sourceBytes },
    { name: prebuiltName, data: prebuiltBytes },
    { name: 'candidate-package-manifest.json', data: manifestBytes }
  ];
  const checksums = artifacts.map((entry) => hash(entry.data) + '  ' + entry.name).join('\n') + '\n';
  artifacts.push({ name: 'SHA256SUMS', data: Buffer.from(checksums, 'utf8') });
  return { artifacts, manifest };
}

export async function writeArtifactsWithoutOverwrite(output, artifacts) {
  const expectedNames = new Set(artifacts.map((entry) => entry.name));
  if ((await readdir(output)).some((name) => !expectedNames.has(name))) throw new Error('Output directory contains unrelated files; use a dedicated directory');
  for (const entry of artifacts) {
    validateArchivePath(entry.name);
    if (entry.name.includes('/')) throw new Error('Artifact output must be a basename');
    try {
      const destination = path.join(output, entry.name);
      const info = await lstat(destination);
      if (!info.isFile() || info.isSymbolicLink() || !(await readFile(destination)).equals(entry.data)) throw new Error('Different output already exists: ' + entry.name);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  const staging = await mkdtemp(path.join(output, '.merchroute-package-stage-'));
  try {
    for (const entry of artifacts) {
      const staged = path.join(staging, entry.name);
      await writeFile(staged, entry.data, { flag: 'wx', mode: 0o600 });
      const destination = path.join(output, entry.name);
      try {
        // Same-filesystem hardlink creates a complete file atomically and never
        // replaces another writer's destination (unlike POSIX rename).
        await link(staged, destination);
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
        const info = await lstat(destination);
        if (!info.isFile() || info.isSymbolicLink() || !(await readFile(destination)).equals(entry.data)) throw new Error('Output changed concurrently: ' + entry.name);
      }
    }
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
  if ((await readdir(output)).some((name) => !expectedNames.has(name))) throw new Error('Unrelated output files appeared during packaging');
}

export async function packageReleaseCandidate({ root = process.cwd(), output }) {
  root = path.resolve(root);
  if (!output) throw new Error('Missing --output');
  const source = await collectSourceFromHead(root);
  const prebuilt = await collectPrebuiltFiles(root, source.identity);
  const otherRoots = git(root, ['worktree', 'list', '--porcelain', '-z']).toString('utf8').split('\0')
    .filter((value) => value.startsWith('worktree ')).map((value) => value.slice(9));
  otherRoots.push(git(root, ['rev-parse', '--path-format=absolute', '--git-common-dir']).toString('utf8').trim());
  const destination = await validateOutputDirectory(root, output, otherRoots);
  const prepared = createPackageArtifacts(source, prebuilt);
  const finalSource = await collectSourceFromHead(root);
  const finalPrebuilt = await collectPrebuiltFiles(root, finalSource.identity);
  if (JSON.stringify(source.identity) !== JSON.stringify(finalSource.identity)
    || JSON.stringify(describeFiles(prebuilt)) !== JSON.stringify(describeFiles(finalPrebuilt))) throw new Error('Source/build changed during packaging');
  await writeArtifactsWithoutOverwrite(destination, prepared.artifacts);
  return {
    ok: true, published: false, commit: source.identity.commit,
    files: prepared.artifacts.map((entry) => ({ name: entry.name, bytes: entry.data.length, sha256: hash(entry.data) }))
  };
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length !== 2 || args[0] !== '--output') throw new Error('Usage: node --import tsx scripts/package-release-candidate.mjs --output <absolute directory outside repository>');
  console.log(JSON.stringify(await packageReleaseCandidate({ output: args[1] }), null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => { console.error('Candidate packaging failed: ' + error.message); process.exitCode = 1; });
}
