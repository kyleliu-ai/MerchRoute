import { createHash } from 'node:crypto';
import { lstat, readFile } from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';

export const CONTENT_FINGERPRINT_SCOPE_VERSION = 1;
export const CONTENT_FINGERPRINT_CONTRACT_PATH = 'config/content-fingerprint-scope.json';

export type ContentScope = 'runtime' | 'documentation' | 'verification';
export type FingerprintScopeContract = {
  schemaVersion: number;
  strategy: 'default-include';
  documentation: ScopeRuleSet;
  verification: ScopeRuleSet;
  excluded: ScopeRuleSet;
};
export type ContentScopeSnapshot = {
  fingerprint: string;
  fileCount: number;
  files: ReadonlyMap<string, string>;
};
export type ContentFingerprintSnapshot = {
  scopeVersion: number;
  scopes: Record<ContentScope, ContentScopeSnapshot>;
};
export type ContentFingerprintSummary = {
  scopeVersion: number;
  fingerprints: Record<ContentScope, string>;
  fileCounts: Record<ContentScope, number>;
};
export type GithubTreeEntry = { path?: string; mode?: string; type?: string; sha?: string };

type ScopeRuleSet = {
  prefixes?: string[];
  directoryNames?: string[];
  extensions?: string[];
  basenames?: string[];
  basenamePrefixes?: string[];
  fileInfixes?: string[];
};

export async function readFingerprintScopeContract(repoRoot: string): Promise<FingerprintScopeContract> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(path.join(repoRoot, CONTENT_FINGERPRINT_CONTRACT_PATH), 'utf8'));
  } catch {
    throw new Error('内容指纹范围契约不可读取');
  }
  if (!isScopeContract(parsed)) throw new Error('内容指纹范围契约格式无效');
  if (parsed.schemaVersion !== CONTENT_FINGERPRINT_SCOPE_VERSION) throw new Error('内容指纹范围契约版本不兼容');
  return parsed;
}

export function normalizeRepositoryPath(value: string): string {
  const normalized = value.replaceAll('\\', '/').replace(/^\.\//, '').replace(/^\/+/, '').normalize('NFC');
  if (!normalized || normalized.includes('\0') || normalized.includes('\n') || normalized.split('/').includes('..')) {
    throw new Error('仓库包含无法安全规范化的文件路径');
  }
  return normalized;
}

export function classifyContentPath(value: string, contract: FingerprintScopeContract): ContentScope | 'excluded' {
  const repositoryPath = normalizeRepositoryPath(value);
  if (repositoryPath === CONTENT_FINGERPRINT_CONTRACT_PATH || isSensitiveOrRuntimeDataPath(repositoryPath) || matchesRules(repositoryPath, contract.excluded)) return 'excluded';
  if (matchesRules(repositoryPath, contract.verification)) return 'verification';
  if (matchesRules(repositoryPath, contract.documentation) || isLicenseName(path.posix.basename(repositoryPath))) return 'documentation';
  return 'runtime';
}

export async function collectLocalContentSnapshot(repoRoot: string, contract: FingerprintScopeContract): Promise<ContentFingerprintSnapshot> {
  const rawOutput = await runGit(repoRoot, ['ls-files', '-z', '--cached', '--others', '--exclude-standard']);
  const candidates = rawOutput.split('\0').filter(Boolean).map((rawPath) => ({ rawPath, normalizedPath: normalizeRepositoryPath(rawPath) }));
  const included: Array<{ rawPath: string; normalizedPath: string; scope: ContentScope }> = [];
  for (const candidate of candidates) {
    const scope = classifyContentPath(candidate.normalizedPath, contract);
    if (scope === 'excluded') continue;
    try {
      const file = await lstat(path.join(repoRoot, ...candidate.rawPath.split('/')));
      if (!file.isFile() && !file.isSymbolicLink()) continue;
      included.push({ ...candidate, scope });
    } catch (error) {
      const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
      if (code !== 'ENOENT') throw new Error('本机源码文件状态无法读取');
    }
  }

  included.sort((left, right) => compareText(left.normalizedPath, right.normalizedPath));
  const hashes = included.length
    ? (await runGit(repoRoot, ['hash-object', '--stdin-paths'], `${included.map((item) => item.rawPath).join('\n')}\n`)).trim().split(/\r?\n/)
    : [];
  if (hashes.length !== included.length || hashes.some((hash) => !isObjectId(hash))) {
    throw new Error('本机源码 Git blob 哈希计算不完整');
  }

  const files = createEmptyScopeMaps();
  included.forEach((item, index) => files[item.scope].set(item.normalizedPath, hashes[index]!.toLowerCase()));
  return createContentSnapshot(files, contract.schemaVersion);
}

export function collectGithubTreeSnapshot(entries: GithubTreeEntry[], contract: FingerprintScopeContract): ContentFingerprintSnapshot {
  const files = createEmptyScopeMaps();
  for (const entry of entries) {
    if (entry.type !== 'blob') continue;
    if (typeof entry.path !== 'string' || typeof entry.sha !== 'string' || !isObjectId(entry.sha)) {
      throw new Error('GitHub 文件树数据不完整');
    }
    const repositoryPath = normalizeRepositoryPath(entry.path);
    const scope = classifyContentPath(repositoryPath, contract);
    if (scope !== 'excluded') files[scope].set(repositoryPath, entry.sha.toLowerCase());
  }
  return createContentSnapshot(files, contract.schemaVersion);
}

export function summarizeContentSnapshot(snapshot: ContentFingerprintSnapshot): ContentFingerprintSummary {
  return {
    scopeVersion: snapshot.scopeVersion,
    fingerprints: mapScopes((scope) => snapshot.scopes[scope].fingerprint),
    fileCounts: mapScopes((scope) => snapshot.scopes[scope].fileCount)
  };
}

export function countContentDifferences(left: ReadonlyMap<string, string>, right: ReadonlyMap<string, string>): number {
  const paths = new Set([...left.keys(), ...right.keys()]);
  let differences = 0;
  for (const repositoryPath of paths) {
    if (left.get(repositoryPath) !== right.get(repositoryPath)) differences += 1;
  }
  return differences;
}

export async function readWorkingTreeDirty(repoRoot: string): Promise<boolean> {
  return Boolean((await runGit(repoRoot, ['status', '--porcelain=v1', '--untracked-files=all'])).trim());
}

export async function readRepositoryCommit(repoRoot: string): Promise<string | undefined> {
  const environmentSha = process.env.MERCHROUTE_BUILD_SHA?.trim();
  if (environmentSha && isObjectId(environmentSha)) return environmentSha.toLowerCase();
  const value = (await runGit(repoRoot, ['rev-parse', 'HEAD'])).trim();
  return isObjectId(value) ? value.toLowerCase() : undefined;
}

function createContentSnapshot(files: Record<ContentScope, Map<string, string>>, scopeVersion: number): ContentFingerprintSnapshot {
  return {
    scopeVersion,
    scopes: mapScopes((scope) => ({
      fingerprint: fingerprintFiles(files[scope]),
      fileCount: files[scope].size,
      files: new Map(files[scope])
    }))
  };
}

function fingerprintFiles(files: ReadonlyMap<string, string>): string {
  const hash = createHash('sha256');
  const entries = [...files.entries()].sort(([left], [right]) => compareText(left, right));
  for (const [repositoryPath, blobHash] of entries) hash.update(repositoryPath).update('\0').update(blobHash).update('\n');
  return hash.digest('hex');
}

function createEmptyScopeMaps(): Record<ContentScope, Map<string, string>> {
  return { runtime: new Map(), documentation: new Map(), verification: new Map() };
}

function mapScopes<T>(mapper: (scope: ContentScope) => T): Record<ContentScope, T> {
  return {
    runtime: mapper('runtime'),
    documentation: mapper('documentation'),
    verification: mapper('verification')
  };
}

function matchesRules(repositoryPath: string, rules: ScopeRuleSet): boolean {
  const basename = path.posix.basename(repositoryPath);
  const segments = repositoryPath.split('/');
  return Boolean(
    rules.prefixes?.some((prefix) => repositoryPath.startsWith(prefix))
    || rules.directoryNames?.some((name) => segments.slice(0, -1).includes(name))
    || rules.extensions?.some((extension) => repositoryPath.toLowerCase().endsWith(extension.toLowerCase()))
    || rules.basenames?.includes(basename)
    || rules.basenamePrefixes?.some((prefix) => basename.startsWith(prefix))
    || rules.fileInfixes?.some((infix) => basename.includes(infix))
  );
}

function isLicenseName(basename: string): boolean {
  return /^(license|notice)(\..+)?$/i.test(basename);
}

function isSensitiveOrRuntimeDataPath(repositoryPath: string): boolean {
  const basename = path.posix.basename(repositoryPath);
  const segments = repositoryPath.split('/');
  if (basename === '.env.example') return false;
  if (/^\.env(?:[._-].*)?$/i.test(basename) || basename === '.merchroute-runtime.env') return true;
  if (/^(cookies?|credentials?|secrets?|auth|tokens?)([._-].*)?\.(json|txt)$/i.test(basename)) return true;
  if (segments[0] === 'integrations' && segments.some((segment) => ['data', 'data-test', 'sessions', 'logs', 'tmp', 'backup', 'playwright-cache'].includes(segment))) return true;
  if (segments[0] === 'deployment' && segments.includes('private')) return true;
  return false;
}

function compareText(left: string, right: string): number {
  return left === right ? 0 : left < right ? -1 : 1;
}

function isObjectId(value: string): boolean {
  return /^[0-9a-f]{40}([0-9a-f]{24})?$/i.test(value.trim());
}

function isScopeContract(value: unknown): value is FingerprintScopeContract {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<FingerprintScopeContract>;
  return Number.isInteger(candidate.schemaVersion)
    && candidate.strategy === 'default-include'
    && isRuleSet(candidate.documentation)
    && isRuleSet(candidate.verification)
    && isRuleSet(candidate.excluded);
}

function isRuleSet(value: unknown): value is ScopeRuleSet {
  if (!value || typeof value !== 'object') return false;
  return Object.values(value).every((item) => Array.isArray(item) && item.every((entry) => typeof entry === 'string'));
}

function runGit(repoRoot: string, args: string[], input?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', ['-C', repoRoot, ...args], { cwd: repoRoot, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
    child.on('error', () => reject(new Error('Git 命令无法启动')));
    child.on('close', (code) => {
      if (code === 0) resolve(Buffer.concat(stdout).toString('utf8'));
      else reject(new Error(stderr.length ? 'Git 无法读取仓库内容' : 'Git 命令执行失败'));
    });
    child.stdin.end(input);
  });
}
