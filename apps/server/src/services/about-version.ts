import { readFile } from 'node:fs/promises';
import path from 'node:path';
import {
  CONTENT_FINGERPRINT_CONTRACT_PATH,
  collectGithubTreeSnapshot,
  collectLocalContentSnapshot,
  countContentDifferences,
  readFingerprintScopeContract,
  type ContentFingerprintSnapshot,
  type ContentScope,
  type FingerprintScopeContract,
  type GithubTreeEntry
} from './content-fingerprint.js';

const DEFAULT_REPOSITORY = 'kyleliu-ai/MerchRoute';
const DEFAULT_REPOSITORY_URL = `https://github.com/${DEFAULT_REPOSITORY}`;
const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_CACHE_TTL_MS = 10 * 60_000;
const BUILD_INFO_SCHEMA_VERSION = 1;

export type AboutSyncStatus = 'SYNCED' | 'LOCAL_ONLY' | 'REMOTE_ONLY' | 'DIVERGED' | 'UNAVAILABLE';
export type AboutRuntimeStatus = 'CURRENT' | 'REBUILD_REQUIRED' | 'UNKNOWN';
export type AboutHistoryStatus = 'IDENTICAL' | 'AHEAD' | 'BEHIND' | 'DIVERGED' | 'UNKNOWN';
export type AboutContentMatchStatus = 'MATCH' | 'DIFFERENT' | 'UNAVAILABLE';

export type AboutAvailableVersion = {
  source: 'release' | 'main';
  label: string;
  commitSha: string;
  publishedAt?: string;
  url: string;
  compareUrl?: string;
};

export type AboutContentComparison = Record<ContentScope, {
  status: AboutContentMatchStatus;
  differenceCount?: number;
}>;

export type AboutBuildInfo = {
  schemaVersion: 1;
  productVersion: string;
  configVersion: string;
  builtAt: string;
  commitSha?: string;
  dirty: boolean;
  scopeVersion: number;
  fingerprints: Record<ContentScope, string>;
  fileCounts: Record<ContentScope, number>;
};

export type AboutVersionInfo = {
  repositoryUrl: string;
  scopeVersion: number;
  current: {
    productVersion: string;
    configVersion: string;
    commitSha?: string;
    builtAt?: string;
    dirty?: boolean;
  };
  available: AboutAvailableVersion | null;
  syncStatus: AboutSyncStatus;
  runtimeStatus: AboutRuntimeStatus;
  contentComparison: AboutContentComparison;
  historyComparison: {
    status: AboutHistoryStatus;
    localOnlyCommits?: number;
    remoteOnlyCommits?: number;
  };
  checkedAt: string;
  error?: string;
};

export type AboutVersionService = {
  check: (options?: { refresh?: boolean }) => Promise<AboutVersionInfo>;
};

type AboutVersionServiceOptions = {
  repoRoot: string;
  configVersion: string;
  productVersion?: string;
  githubToken?: string;
  fetchImpl?: typeof fetch;
  now?: () => Date;
  timeoutMs?: number;
  cacheTtlMs?: number;
  readContract?: () => Promise<FingerprintScopeContract>;
  collectLocalSnapshot?: (contract: FingerprintScopeContract) => Promise<ContentFingerprintSnapshot>;
  readBuildInfo?: () => Promise<AboutBuildInfo | undefined>;
};

type GithubRelease = {
  tag_name?: string;
  html_url?: string;
  published_at?: string;
  draft?: boolean;
  prerelease?: boolean;
};
type GithubRepository = { default_branch?: string };
type GithubCommit = {
  sha?: string;
  html_url?: string;
  commit?: { committer?: { date?: string }; tree?: { sha?: string } };
};
type GithubCompare = {
  status?: string;
  ahead_by?: number;
  behind_by?: number;
  html_url?: string;
  merge_base_commit?: GithubCommit;
};
type GithubTree = { sha?: string; truncated?: boolean; tree?: GithubTreeEntry[] };
type GithubBlob = { encoding?: string; content?: string };

export function createAboutVersionService(options: AboutVersionServiceOptions): AboutVersionService {
  const fetchImpl = options.fetchImpl ?? fetch;
  const githubToken = options.githubToken?.trim() || process.env.MERCHROUTE_GITHUB_TOKEN?.trim();
  const now = options.now ?? (() => new Date());
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const cacheTtlMs = options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
  const readContract = options.readContract ?? (() => readFingerprintScopeContract(options.repoRoot));
  const collectLocalSnapshot = options.collectLocalSnapshot ?? ((contract) => collectLocalContentSnapshot(options.repoRoot, contract));
  const readBuildInfo = options.readBuildInfo ?? (() => readBuildInfoFile(options.repoRoot));
  let cached: { expiresAt: number; value: AboutVersionInfo } | undefined;
  let inFlight: Promise<AboutVersionInfo> | undefined;

  const githubJson = async <T>(endpoint: string, allowNotFound = false): Promise<T | undefined> => {
    const headers: Record<string, string> = {
      accept: 'application/vnd.github+json',
      'user-agent': 'MerchRoute-content-version-checker',
      'x-github-api-version': '2022-11-28'
    };
    if (githubToken) headers.authorization = `Bearer ${githubToken}`;
    const response = await fetchImpl(`https://api.github.com/repos/${DEFAULT_REPOSITORY}${endpoint}`, {
      headers,
      signal: AbortSignal.timeout(timeoutMs)
    });
    if (allowNotFound && response.status === 404) return undefined;
    if (response.status === 401 && githubToken) throw new Error('GitHub 只读令牌无效或已过期');
    if (response.status === 403 && githubToken) throw new Error('GitHub 只读令牌权限不足或受到访问限制');
    if (response.status === 403) throw new Error('GitHub 匿名 API 配额已耗尽');
    if (!response.ok) throw new Error(`GitHub API 返回 ${response.status}`);
    return await response.json() as T;
  };

  const readRemoteTree = async (treeSha: string, contract: FingerprintScopeContract, checkContract: boolean): Promise<ContentFingerprintSnapshot> => {
    const response = await githubJson<GithubTree>(`/git/trees/${encodeURIComponent(treeSha)}?recursive=1`);
    if (!response || response.truncated !== false || !Array.isArray(response.tree)) throw new Error('GitHub 文件树不完整，无法核验内容');
    if (checkContract) await assertRemoteScopeCompatibility(response.tree, contract, githubJson);
    return collectGithubTreeSnapshot(response.tree, contract);
  };

  const performCheck = async (): Promise<AboutVersionInfo> => {
    const checkedAt = now().toISOString();
    const productVersion = options.productVersion ?? await readProductVersion(options.repoRoot);
    let contract: FingerprintScopeContract;
    try {
      contract = await readContract();
    } catch (error) {
      return unavailableResult({
        checkedAt,
        productVersion,
        configVersion: options.configVersion,
        scopeVersion: 0,
        runtimeStatus: 'UNKNOWN',
        error: safeReason(error, '内容指纹范围契约不可用')
      });
    }

    const buildInfo = await readBuildInfo().catch(() => undefined);
    const current = {
      productVersion: buildInfo?.productVersion ?? productVersion,
      configVersion: buildInfo?.configVersion ?? options.configVersion,
      ...(buildInfo?.commitSha ? { commitSha: buildInfo.commitSha } : {}),
      ...(buildInfo?.builtAt ? { builtAt: buildInfo.builtAt } : {}),
      ...(buildInfo ? { dirty: buildInfo.dirty } : {})
    };

    let localSnapshot: ContentFingerprintSnapshot | undefined;
    let localError: string | undefined;
    try {
      localSnapshot = await collectLocalSnapshot(contract);
    } catch (error) {
      localError = safeReason(error, '本机源码指纹无法计算');
    }
    const runtimeStatus = resolveRuntimeStatus(buildInfo, localSnapshot, contract.schemaVersion);
    let available: AboutAvailableVersion | null = null;

    try {
      const target = await resolveGithubTarget(githubJson);
      available = target.available;
      const remoteSnapshot = await readRemoteTree(target.treeSha, contract, true);
      const contentComparison = compareContent(localSnapshot, remoteSnapshot);
      let historyComparison: AboutVersionInfo['historyComparison'] = { status: 'UNKNOWN' };
      let baseSnapshot: ContentFingerprintSnapshot | undefined;

      if (current.commitSha && normalizeObjectId(current.commitSha)) {
        if (current.commitSha.toLowerCase() === available.commitSha.toLowerCase()) {
          historyComparison = { status: 'IDENTICAL', localOnlyCommits: 0, remoteOnlyCommits: 0 };
          baseSnapshot = remoteSnapshot;
        } else {
          try {
            const comparison = await githubJson<GithubCompare>(`/compare/${current.commitSha}...${available.commitSha}`);
            historyComparison = parseHistoryComparison(comparison);
            if (comparison?.html_url) available.compareUrl = comparison.html_url;
            const mergeBaseTreeSha = normalizeObjectId(comparison?.merge_base_commit?.commit?.tree?.sha);
            if (mergeBaseTreeSha) baseSnapshot = await readRemoteTree(mergeBaseTreeSha, contract, false);
          } catch {
            historyComparison = { status: 'UNKNOWN' };
          }
        }
      }

      const syncStatus = resolveSyncStatus(localSnapshot, remoteSnapshot, baseSnapshot, contentComparison, historyComparison);
      const error = syncStatus === 'UNAVAILABLE'
        ? localError ?? '运行与部署内容不同，但暂时无法完整判定差异方向'
        : undefined;
      return {
        repositoryUrl: DEFAULT_REPOSITORY_URL,
        scopeVersion: contract.schemaVersion,
        current,
        available,
        syncStatus,
        runtimeStatus,
        contentComparison,
        historyComparison,
        checkedAt,
        ...(error ? { error } : {})
      };
    } catch (error) {
      return {
        repositoryUrl: DEFAULT_REPOSITORY_URL,
        scopeVersion: contract.schemaVersion,
        current,
        available,
        syncStatus: 'UNAVAILABLE',
        runtimeStatus,
        contentComparison: unavailableContentComparison(),
        historyComparison: { status: 'UNKNOWN' },
        checkedAt,
        error: localError ?? safeReason(error, 'GitHub 内容暂时无法核验')
      };
    }
  };

  const cacheResult = (value: AboutVersionInfo): AboutVersionInfo => {
    cached = { expiresAt: now().getTime() + cacheTtlMs, value };
    return value;
  };

  return {
    check: async ({ refresh = false } = {}) => {
      if (refresh) return cacheResult(await performCheck());
      const timestamp = now().getTime();
      if (cached && cached.expiresAt > timestamp) return cached.value;
      if (inFlight) return await inFlight;
      inFlight = performCheck().then(cacheResult).finally(() => { inFlight = undefined; });
      return await inFlight;
    }
  };
}

async function resolveGithubTarget(githubJson: <T>(endpoint: string, allowNotFound?: boolean) => Promise<T | undefined>): Promise<{ available: AboutAvailableVersion; treeSha: string }> {
  let source: AboutAvailableVersion['source'] = 'main';
  let label = 'main';
  let publishedAt: string | undefined;
  let targetUrl = DEFAULT_REPOSITORY_URL;
  let targetRef = 'main';
  const release = await githubJson<GithubRelease>('/releases/latest', true);
  if (release?.tag_name && !release.draft && !release.prerelease) {
    source = 'release';
    label = release.tag_name;
    targetRef = release.tag_name;
    targetUrl = release.html_url || `${DEFAULT_REPOSITORY_URL}/releases/tag/${encodeURIComponent(release.tag_name)}`;
    publishedAt = release.published_at;
  } else {
    const repository = await githubJson<GithubRepository>('');
    targetRef = repository?.default_branch || 'main';
    label = targetRef;
  }

  const targetCommit = await githubJson<GithubCommit>(`/commits/${encodeURIComponent(targetRef)}`);
  const targetSha = normalizeObjectId(targetCommit?.sha);
  const treeSha = normalizeObjectId(targetCommit?.commit?.tree?.sha);
  if (!targetSha || !treeSha) throw new Error('GitHub 未返回完整的提交与文件树信息');
  if (source === 'main') {
    targetUrl = targetCommit?.html_url || `${DEFAULT_REPOSITORY_URL}/commit/${targetSha}`;
    publishedAt = targetCommit?.commit?.committer?.date;
  }
  return {
    available: {
      source,
      label,
      commitSha: targetSha,
      ...(publishedAt ? { publishedAt } : {}),
      url: targetUrl
    },
    treeSha
  };
}

async function assertRemoteScopeCompatibility(
  entries: GithubTreeEntry[],
  contract: FingerprintScopeContract,
  githubJson: <T>(endpoint: string, allowNotFound?: boolean) => Promise<T | undefined>
): Promise<void> {
  const contractEntry = entries.find((entry) => entry.type === 'blob' && entry.path?.replaceAll('\\', '/').normalize('NFC') === CONTENT_FINGERPRINT_CONTRACT_PATH);
  if (!contractEntry) return;
  const blobSha = normalizeObjectId(contractEntry.sha);
  if (!blobSha) throw new Error('GitHub 指纹范围契约数据不完整');
  const blob = await githubJson<GithubBlob>(`/git/blobs/${blobSha}`);
  if (!blob?.content || blob.encoding !== 'base64') throw new Error('GitHub 指纹范围契约无法读取');
  let remoteVersion: unknown;
  try {
    remoteVersion = (JSON.parse(Buffer.from(blob.content.replace(/\s/g, ''), 'base64').toString('utf8')) as { schemaVersion?: unknown }).schemaVersion;
  } catch {
    throw new Error('GitHub 指纹范围契约格式无效');
  }
  if (remoteVersion !== contract.schemaVersion) throw new Error('本机与 GitHub 的指纹范围契约版本不兼容');
}

function resolveRuntimeStatus(buildInfo: AboutBuildInfo | undefined, localSnapshot: ContentFingerprintSnapshot | undefined, scopeVersion: number): AboutRuntimeStatus {
  if (!buildInfo || !localSnapshot || buildInfo.schemaVersion !== BUILD_INFO_SCHEMA_VERSION || buildInfo.scopeVersion !== scopeVersion) return 'UNKNOWN';
  const buildFingerprint = buildInfo.fingerprints.runtime;
  return buildFingerprint && buildFingerprint === localSnapshot.scopes.runtime.fingerprint ? 'CURRENT' : 'REBUILD_REQUIRED';
}

function compareContent(local: ContentFingerprintSnapshot | undefined, remote: ContentFingerprintSnapshot | undefined): AboutContentComparison {
  if (!local || !remote || local.scopeVersion !== remote.scopeVersion) return unavailableContentComparison();
  return mapScopes((scope) => {
    const differenceCount = countContentDifferences(local.scopes[scope].files, remote.scopes[scope].files);
    return { status: differenceCount === 0 ? 'MATCH' : 'DIFFERENT', differenceCount };
  });
}

function resolveSyncStatus(
  local: ContentFingerprintSnapshot | undefined,
  remote: ContentFingerprintSnapshot | undefined,
  base: ContentFingerprintSnapshot | undefined,
  comparison: AboutContentComparison,
  history: AboutVersionInfo['historyComparison']
): AboutSyncStatus {
  if (!local || !remote || comparison.runtime.status === 'UNAVAILABLE') return 'UNAVAILABLE';
  if (comparison.runtime.status === 'MATCH') return 'SYNCED';
  if (base && base.scopeVersion === local.scopeVersion) {
    const direction = classifyDirectionalDifferences(local.scopes.runtime.files, remote.scopes.runtime.files, base.scopes.runtime.files);
    if (direction.localOnly > 0 && direction.remoteOnly === 0 && direction.conflicting === 0) return 'LOCAL_ONLY';
    if (direction.localOnly === 0 && direction.remoteOnly > 0 && direction.conflicting === 0) return 'REMOTE_ONLY';
    if (direction.conflicting > 0 || (direction.localOnly > 0 && direction.remoteOnly > 0)) return 'DIVERGED';
  }
  if (history.status === 'IDENTICAL' || history.status === 'AHEAD') return 'LOCAL_ONLY';
  if (history.status === 'BEHIND') return 'REMOTE_ONLY';
  if (history.status === 'DIVERGED') return 'DIVERGED';
  return 'UNAVAILABLE';
}

function classifyDirectionalDifferences(
  local: ReadonlyMap<string, string>,
  remote: ReadonlyMap<string, string>,
  base: ReadonlyMap<string, string>
): { localOnly: number; remoteOnly: number; conflicting: number } {
  const result = { localOnly: 0, remoteOnly: 0, conflicting: 0 };
  const paths = new Set([...local.keys(), ...remote.keys(), ...base.keys()]);
  for (const repositoryPath of paths) {
    const localHash = local.get(repositoryPath);
    const remoteHash = remote.get(repositoryPath);
    if (localHash === remoteHash) continue;
    const baseHash = base.get(repositoryPath);
    if (remoteHash === baseHash && localHash !== baseHash) result.localOnly += 1;
    else if (localHash === baseHash && remoteHash !== baseHash) result.remoteOnly += 1;
    else result.conflicting += 1;
  }
  return result;
}

function parseHistoryComparison(comparison: GithubCompare | undefined): AboutVersionInfo['historyComparison'] {
  const status = mapHistoryStatus(comparison?.status);
  if (status === 'UNKNOWN') return { status };
  return {
    status,
    localOnlyCommits: Math.max(0, Number(comparison?.behind_by) || 0),
    remoteOnlyCommits: Math.max(0, Number(comparison?.ahead_by) || 0)
  };
}

function mapHistoryStatus(status: string | undefined): AboutHistoryStatus {
  if (status === 'identical') return 'IDENTICAL';
  if (status === 'ahead') return 'BEHIND';
  if (status === 'behind') return 'AHEAD';
  if (status === 'diverged') return 'DIVERGED';
  return 'UNKNOWN';
}

function unavailableContentComparison(): AboutContentComparison {
  return mapScopes(() => ({ status: 'UNAVAILABLE' }));
}

function unavailableResult(input: {
  checkedAt: string;
  productVersion: string;
  configVersion: string;
  scopeVersion: number;
  runtimeStatus: AboutRuntimeStatus;
  error: string;
}): AboutVersionInfo {
  return {
    repositoryUrl: DEFAULT_REPOSITORY_URL,
    scopeVersion: input.scopeVersion,
    current: { productVersion: input.productVersion, configVersion: input.configVersion },
    available: null,
    syncStatus: 'UNAVAILABLE',
    runtimeStatus: input.runtimeStatus,
    contentComparison: unavailableContentComparison(),
    historyComparison: { status: 'UNKNOWN' },
    checkedAt: input.checkedAt,
    error: input.error
  };
}

function mapScopes<T>(mapper: (scope: ContentScope) => T): Record<ContentScope, T> {
  return {
    runtime: mapper('runtime'),
    documentation: mapper('documentation'),
    verification: mapper('verification')
  };
}

function normalizeObjectId(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized && /^[0-9a-f]{40}([0-9a-f]{24})?$/i.test(normalized) ? normalized.toLowerCase() : undefined;
}

function safeReason(error: unknown, fallback: string): string {
  return error instanceof Error && error.message && !/[A-Z]:[\\/]|\/Users\/|\/home\//i.test(error.message) ? error.message : fallback;
}

async function readProductVersion(repoRoot: string): Promise<string> {
  try {
    const packageJson = JSON.parse(await readFile(path.join(repoRoot, 'package.json'), 'utf8')) as { version?: unknown };
    return typeof packageJson.version === 'string' && packageJson.version.trim() ? packageJson.version.trim() : 'unknown';
  } catch {
    return 'unknown';
  }
}

async function readBuildInfoFile(repoRoot: string): Promise<AboutBuildInfo | undefined> {
  const configuredPath = process.env.MERCHROUTE_BUILD_INFO_PATH?.trim();
  const buildInfoPath = configuredPath || path.join(repoRoot, 'apps/server/dist/build-info.json');
  try {
    const parsed = JSON.parse(await readFile(buildInfoPath, 'utf8')) as unknown;
    return isBuildInfo(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function isBuildInfo(value: unknown): value is AboutBuildInfo {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<AboutBuildInfo>;
  return candidate.schemaVersion === BUILD_INFO_SCHEMA_VERSION
    && typeof candidate.productVersion === 'string'
    && typeof candidate.configVersion === 'string'
    && typeof candidate.builtAt === 'string'
    && typeof candidate.dirty === 'boolean'
    && Number.isInteger(candidate.scopeVersion)
    && isScopeRecord(candidate.fingerprints, (item) => typeof item === 'string' && /^[0-9a-f]{64}$/i.test(item))
    && isScopeRecord(candidate.fileCounts, (item) => Number.isInteger(item) && Number(item) >= 0)
    && (candidate.commitSha === undefined || Boolean(normalizeObjectId(candidate.commitSha)));
}

function isScopeRecord<T>(value: unknown, validate: (item: unknown) => boolean): value is Record<ContentScope, T> {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Record<string, unknown>;
  return ['runtime', 'documentation', 'verification'].every((scope) => validate(candidate[scope]));
}
