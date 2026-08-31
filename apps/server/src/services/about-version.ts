import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

const DEFAULT_REPOSITORY = 'kyleliu-ai/MerchRoute';
const DEFAULT_REPOSITORY_URL = `https://github.com/${DEFAULT_REPOSITORY}`;
const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_CACHE_TTL_MS = 10 * 60_000;

export type AboutVersionStatus = 'UPDATE_AVAILABLE' | 'UP_TO_DATE' | 'LOCAL_AHEAD' | 'DIVERGED' | 'UNAVAILABLE';

export type AboutAvailableVersion = {
  source: 'release' | 'main';
  label: string;
  commitSha: string;
  publishedAt?: string;
  url: string;
  compareUrl?: string;
};

export type AboutVersionInfo = {
  repositoryUrl: string;
  current: {
    productVersion: string;
    configVersion: string;
    commitSha?: string;
  };
  available: AboutAvailableVersion | null;
  status: AboutVersionStatus;
  aheadBy: number;
  checkedAt: string;
  error?: string;
};

export type AboutVersionService = {
  check: () => Promise<AboutVersionInfo>;
};

type AboutVersionServiceOptions = {
  repoRoot: string;
  configVersion: string;
  productVersion?: string;
  fetchImpl?: typeof fetch;
  resolveCommit?: () => Promise<string | undefined>;
  now?: () => Date;
  timeoutMs?: number;
  cacheTtlMs?: number;
};

type GithubRelease = {
  tag_name?: string;
  html_url?: string;
  published_at?: string;
  draft?: boolean;
  prerelease?: boolean;
};

type GithubRepository = { default_branch?: string };
type GithubCommit = { sha?: string; html_url?: string; commit?: { committer?: { date?: string } } };
type GithubCompare = { status?: string; ahead_by?: number; html_url?: string };

export function createAboutVersionService(options: AboutVersionServiceOptions): AboutVersionService {
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? (() => new Date());
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const cacheTtlMs = options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
  const resolveCommit = options.resolveCommit ?? (() => resolveLocalCommit(options.repoRoot));
  let cached: { expiresAt: number; value: AboutVersionInfo } | undefined;
  let inFlight: Promise<AboutVersionInfo> | undefined;

  const githubJson = async <T>(endpoint: string, allowNotFound = false): Promise<T | undefined> => {
    const response = await fetchImpl(`https://api.github.com/repos/${DEFAULT_REPOSITORY}${endpoint}`, {
      headers: {
        accept: 'application/vnd.github+json',
        'user-agent': 'MerchRoute-version-checker',
        'x-github-api-version': '2022-11-28'
      },
      signal: AbortSignal.timeout(timeoutMs)
    });
    if (allowNotFound && response.status === 404) return undefined;
    if (!response.ok) throw new Error(`GitHub API 返回 ${response.status}`);
    return await response.json() as T;
  };

  const performCheck = async (): Promise<AboutVersionInfo> => {
    const productVersion = options.productVersion ?? await readProductVersion(options.repoRoot);
    let currentCommit: string | undefined;
    let currentError: string | undefined;
    try {
      currentCommit = normalizeSha(await resolveCommit());
      if (!currentCommit) currentError = '当前构建缺少可识别的 Git 提交信息';
    } catch {
      currentError = '当前构建缺少可读取的 Git 元数据';
    }

    const current = {
      productVersion,
      configVersion: options.configVersion,
      ...(currentCommit ? { commitSha: currentCommit } : {})
    };

    try {
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
      const targetSha = normalizeSha(targetCommit?.sha);
      if (!targetSha) throw new Error('GitHub 未返回有效的提交信息');
      if (source === 'main') {
        targetUrl = targetCommit?.html_url || `${DEFAULT_REPOSITORY_URL}/commit/${targetSha}`;
        publishedAt = targetCommit?.commit?.committer?.date;
      }

      const available: AboutAvailableVersion = {
        source,
        label,
        commitSha: targetSha,
        ...(publishedAt ? { publishedAt } : {}),
        url: targetUrl
      };

      if (!currentCommit) {
        return {
          repositoryUrl: DEFAULT_REPOSITORY_URL,
          current,
          available,
          status: 'UNAVAILABLE',
          aheadBy: 0,
          checkedAt: now().toISOString(),
          error: currentError
        };
      }

      const comparison = await githubJson<GithubCompare>(`/compare/${currentCommit}...${targetSha}`);
      if (comparison?.html_url) available.compareUrl = comparison.html_url;
      const aheadBy = Math.max(0, Number(comparison?.ahead_by) || 0);
      const status = mapComparisonStatus(comparison?.status);
      if (!status) throw new Error('GitHub 未返回可识别的版本差异状态');
      return {
        repositoryUrl: DEFAULT_REPOSITORY_URL,
        current,
        available,
        status,
        aheadBy,
        checkedAt: now().toISOString()
      };
    } catch (error) {
      const reason = error instanceof Error ? error.message : '未知错误';
      return {
        repositoryUrl: DEFAULT_REPOSITORY_URL,
        current,
        available: null,
        status: 'UNAVAILABLE',
        aheadBy: 0,
        checkedAt: now().toISOString(),
        error: currentError ? `${currentError}；${reason}` : `GitHub 版本信息暂时不可用：${reason}`
      };
    }
  };

  return {
    check: async () => {
      const timestamp = now().getTime();
      if (cached && cached.expiresAt > timestamp) return cached.value;
      if (inFlight) return await inFlight;
      inFlight = performCheck()
        .then((value) => {
          if (value.status !== 'UNAVAILABLE') cached = { expiresAt: now().getTime() + cacheTtlMs, value };
          return value;
        })
        .finally(() => { inFlight = undefined; });
      return await inFlight;
    }
  };
}

function mapComparisonStatus(status: string | undefined): Exclude<AboutVersionStatus, 'UNAVAILABLE'> | undefined {
  if (status === 'ahead') return 'UPDATE_AVAILABLE';
  if (status === 'identical') return 'UP_TO_DATE';
  if (status === 'behind') return 'LOCAL_AHEAD';
  if (status === 'diverged') return 'DIVERGED';
  return undefined;
}

function normalizeSha(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized && /^[0-9a-f]{40}$/i.test(normalized) ? normalized : undefined;
}

async function readProductVersion(repoRoot: string): Promise<string> {
  try {
    const packageJson = JSON.parse(await readFile(path.join(repoRoot, 'package.json'), 'utf8')) as { version?: unknown };
    return typeof packageJson.version === 'string' && packageJson.version.trim() ? packageJson.version.trim() : 'unknown';
  } catch {
    return 'unknown';
  }
}

async function resolveLocalCommit(repoRoot: string): Promise<string | undefined> {
  const environmentSha = process.env.MERCHROUTE_BUILD_SHA?.trim();
  if (normalizeSha(environmentSha)) return environmentSha;
  return await new Promise<string>((resolve, reject) => {
    execFile(
      'git',
      ['-C', repoRoot, 'rev-parse', 'HEAD'],
      { encoding: 'utf8', timeout: 3_000, windowsHide: true },
      (error, stdout) => error ? reject(error) : resolve(stdout.trim())
    );
  });
}
