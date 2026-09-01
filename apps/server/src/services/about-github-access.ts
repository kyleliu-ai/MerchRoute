import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import writeFileAtomic from 'write-file-atomic';
import { AppError } from '@n8n-media-review/shared';

const ACCESS_FILE_NAME = 'github-about-access.v1.json';
const ACCESS_FILE_SCHEMA_VERSION = 1;
const ENCRYPTION_KEY_VERSION = 1;
const ENCRYPTION_AAD = Buffer.from('merchroute:about-github-access:v1', 'utf8');
const DEFAULT_REPOSITORY = 'kyleliu-ai/MerchRoute';
const DEFAULT_TIMEOUT_MS = 10_000;

export type AboutGithubAccessMode = 'AUTHENTICATED' | 'ANONYMOUS';
export type AboutGithubAccessSource = 'MANAGED' | 'ENVIRONMENT' | 'NONE';
export type AboutGithubAccessState =
  | 'VERIFIED'
  | 'UNVERIFIED'
  | 'INVALID'
  | 'INSUFFICIENT_ACCESS'
  | 'RATE_LIMITED'
  | 'UNAVAILABLE';

export type AboutGithubRateLimit = {
  limit: number;
  remaining: number;
  resetAt?: string;
};

export type AboutGithubAccessStatus = {
  mode: AboutGithubAccessMode;
  source: AboutGithubAccessSource;
  state: AboutGithubAccessState;
  anonymousFallback: boolean;
  canManage: boolean;
  rateLimit?: AboutGithubRateLimit;
  checkedAt?: string;
};

export type AboutGithubCredential = {
  token?: string;
  source: AboutGithubAccessSource;
};

export type AboutGithubAccessService = {
  initialize: () => Promise<void>;
  current: () => AboutGithubCredential;
  status: (canManage?: boolean) => AboutGithubAccessStatus;
  save: (token: string) => Promise<AboutGithubAccessStatus>;
  useAnonymous: () => Promise<AboutGithubAccessStatus>;
  recordSuccess: (response: Response, options: { authenticated: boolean; fallback?: boolean }) => void;
  recordFailure: (state: AboutGithubAccessState, options: { authenticated: boolean; fallback?: boolean }) => void;
};

type EncryptedToken = {
  ciphertext: string;
  nonce: string;
  authTag: string;
  keyVersion: 1;
};

type PersistedAccessState =
  | { schemaVersion: 1; mode: 'managed'; savedAt: string; token: EncryptedToken }
  | { schemaVersion: 1; mode: 'anonymous'; savedAt: string };

type AccessObservation = {
  mode: AboutGithubAccessMode;
  state: AboutGithubAccessState;
  anonymousFallback: boolean;
  rateLimit?: AboutGithubRateLimit;
  checkedAt?: string;
};

type AboutGithubAccessServiceOptions = {
  appDataDir: string;
  encryptionKey?: string;
  legacyToken?: string;
  repository?: string;
  fetchImpl?: typeof fetch;
  now?: () => Date;
  timeoutMs?: number;
};

export function createAboutGithubAccessService(options: AboutGithubAccessServiceOptions): AboutGithubAccessService {
  const accessFile = path.join(path.resolve(options.appDataDir), ACCESS_FILE_NAME);
  const legacyToken = String(options.legacyToken ?? process.env.MERCHROUTE_GITHUB_TOKEN ?? '').trim();
  const encryptionKeyInput = String(options.encryptionKey ?? process.env.MERCHROUTE_CREDENTIAL_ENCRYPTION_KEY ?? '').trim();
  const fetchImpl = options.fetchImpl ?? fetch;
  const repository = options.repository ?? DEFAULT_REPOSITORY;
  const now = options.now ?? (() => new Date());
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  let persisted: PersistedAccessState | undefined;
  let managedToken: string | undefined;
  let storageError: string | undefined;
  let observation: AccessObservation | undefined;
  let initialized = false;
  let mutationChain: Promise<void> = Promise.resolve();

  const current = (): AboutGithubCredential => {
    if (persisted?.mode === 'anonymous') return { source: 'NONE' };
    if (persisted?.mode === 'managed') return { ...(managedToken ? { token: managedToken } : {}), source: 'MANAGED' };
    if (legacyToken) return { token: legacyToken, source: 'ENVIRONMENT' };
    return { source: 'NONE' };
  };

  const status = (canManage = true): AboutGithubAccessStatus => {
    const credential = current();
    const fallbackFromStorageError = Boolean(storageError && credential.source === 'MANAGED' && !credential.token);
    const base: AccessObservation = observation ?? {
      mode: credential.token ? 'AUTHENTICATED' : 'ANONYMOUS',
      state: storageError ? 'UNAVAILABLE' : 'UNVERIFIED',
      anonymousFallback: fallbackFromStorageError
    };
    return {
      mode: base.mode,
      source: credential.source,
      state: base.state,
      anonymousFallback: base.anonymousFallback,
      canManage,
      ...(base.rateLimit ? { rateLimit: base.rateLimit } : {}),
      ...(base.checkedAt ? { checkedAt: base.checkedAt } : {})
    };
  };

  const initialize = async (): Promise<void> => {
    if (initialized) return;
    initialized = true;
    try {
      const raw = await readFile(accessFile, 'utf8');
      const parsed = parsePersistedState(JSON.parse(raw));
      persisted = parsed;
      if (parsed.mode === 'managed') managedToken = decryptToken(parsed.token, requireEncryptionKey(encryptionKeyInput));
    } catch (error: any) {
      if (error?.code === 'ENOENT') return;
      persisted = persisted ?? {
        schemaVersion: ACCESS_FILE_SCHEMA_VERSION,
        mode: 'managed',
        savedAt: now().toISOString(),
        token: { ciphertext: '', nonce: '', authTag: '', keyVersion: ENCRYPTION_KEY_VERSION }
      };
      managedToken = undefined;
      storageError = 'GitHub Access Token 安全存储无法读取，请重新配置';
    }
  };

  const recordSuccess = (response: Response, context: { authenticated: boolean; fallback?: boolean }): void => {
    const rateLimit = parseRateLimit(response);
    if (context.fallback) {
      observation = {
        mode: 'ANONYMOUS',
        state: isCredentialFailure(observation?.state) ? observation!.state : 'UNAVAILABLE',
        anonymousFallback: true,
        ...(rateLimit ? { rateLimit } : {}),
        checkedAt: now().toISOString()
      };
      return;
    }
    observation = {
      mode: context.authenticated ? 'AUTHENTICATED' : 'ANONYMOUS',
      state: 'VERIFIED',
      anonymousFallback: false,
      ...(rateLimit ? { rateLimit } : {}),
      checkedAt: now().toISOString()
    };
  };

  const recordFailure = (stateValue: AboutGithubAccessState, context: { authenticated: boolean; fallback?: boolean }): void => {
    const preserveCredentialFailure = Boolean(context.fallback && isCredentialFailure(observation?.state));
    observation = {
      mode: context.fallback || !context.authenticated ? 'ANONYMOUS' : 'AUTHENTICATED',
      state: preserveCredentialFailure ? observation!.state : stateValue,
      anonymousFallback: Boolean(context.fallback),
      ...(observation?.rateLimit ? { rateLimit: observation.rateLimit } : {}),
      checkedAt: now().toISOString()
    };
  };

  const save = async (tokenInput: string): Promise<AboutGithubAccessStatus> => {
    let result: AboutGithubAccessStatus | undefined;
    await enqueueMutation(async () => {
      const token = normalizeFineGrainedToken(tokenInput);
      const response = await validateRepositoryReadAccess(fetchImpl, repository, token, timeoutMs);
      const key = requireEncryptionKey(encryptionKeyInput);
      const next: PersistedAccessState = {
        schemaVersion: ACCESS_FILE_SCHEMA_VERSION,
        mode: 'managed',
        savedAt: now().toISOString(),
        token: encryptToken(token, key)
      };
      await persistAccessState(accessFile, next);
      persisted = next;
      managedToken = token;
      storageError = undefined;
      recordSuccess(response, { authenticated: true });
      result = status(true);
    });
    return result!;
  };

  const useAnonymous = async (): Promise<AboutGithubAccessStatus> => {
    let result: AboutGithubAccessStatus | undefined;
    await enqueueMutation(async () => {
      const next: PersistedAccessState = {
        schemaVersion: ACCESS_FILE_SCHEMA_VERSION,
        mode: 'anonymous',
        savedAt: now().toISOString()
      };
      await persistAccessState(accessFile, next);
      persisted = next;
      managedToken = undefined;
      storageError = undefined;
      observation = { mode: 'ANONYMOUS', state: 'UNVERIFIED', anonymousFallback: false };
      result = status(true);
    });
    return result!;
  };

  const enqueueMutation = async (operation: () => Promise<void>): Promise<void> => {
    const next = mutationChain.catch(() => undefined).then(operation);
    mutationChain = next;
    await next;
  };

  return { initialize, current, status, save, useAnonymous, recordSuccess, recordFailure };
}

async function validateRepositoryReadAccess(fetchImpl: typeof fetch, repository: string, token: string, timeoutMs: number): Promise<Response> {
  let response: Response;
  try {
    response = await fetchImpl(`https://api.github.com/repos/${repository}/git/trees/main?recursive=0`, {
      headers: githubHeaders(token, 'MerchRoute-token-configurator'),
      signal: AbortSignal.timeout(timeoutMs)
    });
  } catch {
    throw new AppError('GITHUB_ACCESS_UNAVAILABLE', '无法连接 GitHub，原 Access Token 配置未更改', undefined, 503);
  }
  if (response.status === 401) throw new AppError('GITHUB_TOKEN_INVALID', 'Access Token 无效或已过期，原配置未更改', undefined, 401);
  if (response.status === 403 && response.headers.get('x-ratelimit-remaining') === '0') {
    throw new AppError('GITHUB_RATE_LIMITED', 'GitHub 认证额度暂时耗尽，原配置未更改', undefined, 429);
  }
  if (response.status === 403 || response.status === 404) {
    throw new AppError('GITHUB_TOKEN_INSUFFICIENT_ACCESS', 'Access Token 无法只读访问 MerchRoute 仓库，请检查仓库范围和 Contents 权限', undefined, 403);
  }
  if (!response.ok) throw new AppError('GITHUB_ACCESS_UNAVAILABLE', `GitHub 验证返回 HTTP ${response.status}，原配置未更改`, undefined, 503);
  return response;
}

function normalizeFineGrainedToken(input: string): string {
  const token = String(input || '').trim();
  if (!/^github_pat_[A-Za-z0-9_]{20,400}$/.test(token)) {
    throw new AppError('CONFIG_INVALID', '请输入以 github_pat_ 开头的完整细粒度 Access Token');
  }
  return token;
}

function requireEncryptionKey(input: string): Buffer {
  const decoded = Buffer.from(input, 'base64');
  if (!input || decoded.length !== 32 || decoded.toString('base64').replace(/=+$/, '') !== input.replace(/=+$/, '')) {
    throw new AppError('CONFIG_INVALID', 'MerchRoute 凭据加密密钥不可用，Access Token 未保存', undefined, 503);
  }
  return decoded;
}

function encryptToken(token: string, key: Buffer): EncryptedToken {
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(ENCRYPTION_AAD);
  const ciphertext = Buffer.concat([cipher.update(token, 'utf8'), cipher.final()]);
  return {
    ciphertext: ciphertext.toString('base64'),
    nonce: nonce.toString('base64'),
    authTag: cipher.getAuthTag().toString('base64'),
    keyVersion: ENCRYPTION_KEY_VERSION
  };
}

function decryptToken(encrypted: EncryptedToken, key: Buffer): string {
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(encrypted.nonce, 'base64'));
    decipher.setAAD(ENCRYPTION_AAD);
    decipher.setAuthTag(Buffer.from(encrypted.authTag, 'base64'));
    return Buffer.concat([
      decipher.update(Buffer.from(encrypted.ciphertext, 'base64')),
      decipher.final()
    ]).toString('utf8');
  } catch {
    throw new AppError('CREDENTIAL_DECRYPT_FAILED', 'GitHub Access Token 无法解密');
  }
}

function parsePersistedState(value: unknown): PersistedAccessState {
  if (!value || typeof value !== 'object') throw new Error('invalid access state');
  const candidate = value as Record<string, unknown>;
  if (candidate.schemaVersion !== ACCESS_FILE_SCHEMA_VERSION || typeof candidate.savedAt !== 'string') throw new Error('invalid access state');
  if (candidate.mode === 'anonymous') return candidate as PersistedAccessState;
  if (candidate.mode !== 'managed' || !candidate.token || typeof candidate.token !== 'object') throw new Error('invalid access state');
  const token = candidate.token as Record<string, unknown>;
  if (token.keyVersion !== ENCRYPTION_KEY_VERSION || !['ciphertext', 'nonce', 'authTag'].every((key) => typeof token[key] === 'string' && token[key])) {
    throw new Error('invalid encrypted token');
  }
  return candidate as PersistedAccessState;
}

async function persistAccessState(file: string, state: PersistedAccessState): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFileAtomic(file, `${JSON.stringify(state, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
}

function githubHeaders(token: string | undefined, userAgent: string): Record<string, string> {
  return {
    accept: 'application/vnd.github+json',
    ...(token ? { authorization: `Bearer ${token}` } : {}),
    'user-agent': userAgent,
    'x-github-api-version': '2022-11-28'
  };
}

function parseRateLimit(response: Response): AboutGithubRateLimit | undefined {
  const limit = Number(response.headers.get('x-ratelimit-limit'));
  const remaining = Number(response.headers.get('x-ratelimit-remaining'));
  if (!Number.isFinite(limit) || !Number.isFinite(remaining)) return undefined;
  const reset = Number(response.headers.get('x-ratelimit-reset'));
  return {
    limit: Math.max(0, Math.trunc(limit)),
    remaining: Math.max(0, Math.trunc(remaining)),
    ...(Number.isFinite(reset) && reset > 0 ? { resetAt: new Date(reset * 1000).toISOString() } : {})
  };
}

function isCredentialFailure(state: AboutGithubAccessState | undefined): boolean {
  return state === 'INVALID' || state === 'INSUFFICIENT_ACCESS' || state === 'RATE_LIMITED';
}

export function aboutGithubRequestHeaders(token?: string): Record<string, string> {
  return githubHeaders(token, 'MerchRoute-content-version-checker');
}
