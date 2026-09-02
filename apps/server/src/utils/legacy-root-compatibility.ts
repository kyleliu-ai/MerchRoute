import path from 'node:path';
import { access, lstat, realpath } from 'node:fs/promises';
import { constants } from 'node:fs';
import { AppError } from '@n8n-media-review/shared';

export type LegacyRootCompatibilityReadiness = {
  enabled: boolean;
  required: boolean;
  status: 'DISABLED' | 'READY' | 'BLOCKED';
  legacyRoot?: string;
  canonicalRoot?: string;
  legacyPathPresent: boolean;
  canonicalRootReady: boolean;
  mappingSelfTest: boolean;
  legacyPathTargetsCanonicalRoot?: boolean;
  checkedAt: string;
  issues: string[];
};

export type LegacyRootCompatibilityOptions = {
  legacyRoot?: string;
  canonicalRoot?: string;
  required?: boolean;
};

export type CanonicalizedJson<T> = {
  value: T;
  changedStrings: number;
  changedKeys: number;
};

/**
 * Keeps immutable historical payloads untouched while deriving filesystem-safe
 * runtime paths from the configured canonical MerchRoute data root.
 */
export class LegacyRootCompatibility {
  readonly legacyRoot?: string;
  readonly canonicalRoot?: string;
  readonly required: boolean;
  private readonly flavor?: typeof path.win32 | typeof path.posix;

  constructor(options: LegacyRootCompatibilityOptions = {}) {
    this.legacyRoot = trimConfiguredRoot(options.legacyRoot);
    this.canonicalRoot = trimConfiguredRoot(options.canonicalRoot);
    this.required = options.required === true;
    this.flavor = pathFlavor(this.legacyRoot, this.canonicalRoot);
  }

  static fromEnvironment(environment: NodeJS.ProcessEnv = process.env, required = false): LegacyRootCompatibility {
    return new LegacyRootCompatibility({
      legacyRoot: environment.MERCHROUTE_LEGACY_DATA_ROOT,
      canonicalRoot: environment.MERCHROUTE_DATA_ROOT,
      required
    });
  }

  get enabled(): boolean {
    return Boolean(this.legacyRoot);
  }

  canonicalizePath(value: string): string {
    if (!this.legacyRoot || !this.canonicalRoot || !this.flavor || typeof value !== 'string') return value;
    const candidate = value;
    if (candidate !== candidate.trim()) return value;
    if (candidate.includes('\0')) {
      throw new AppError('INVALID_PATH', '路径包含 NUL 字符，已停止旧根映射', undefined, 400);
    }
    if (!isAbsoluteForFlavor(candidate, this.flavor)) return value;

    const legacy = this.flavor.resolve(this.legacyRoot);
    const resolved = this.flavor.resolve(candidate);
    const relative = this.flavor.relative(legacy, resolved);
    if (relative === '..' || relative.startsWith(`..${this.flavor.sep}`) || this.flavor.isAbsolute(relative)) return value;

    const mapped = relative ? this.flavor.resolve(this.canonicalRoot, relative) : this.flavor.resolve(this.canonicalRoot);
    return usesForwardSlashesOnly(candidate) && this.flavor === path.win32 ? mapped.replaceAll('\\', '/') : mapped;
  }

  lookupCandidates(value: string): string[] {
    const candidates = [this.canonicalizePath(value)];
    if (this.legacyRoot && this.canonicalRoot && this.flavor) {
      const canonical = new LegacyRootCompatibility({
        legacyRoot: this.canonicalRoot,
        canonicalRoot: this.legacyRoot
      }).canonicalizePath(candidates[0]!);
      candidates.push(canonical);
    }
    return [...new Set(candidates)];
  }

  canonicalizeJson<T>(input: T): T {
    return this.canonicalizeJsonWithStats(input).value;
  }

  canonicalizeJsonWithStats<T>(input: T): CanonicalizedJson<T> {
    const stats = { changedStrings: 0, changedKeys: 0 };
    const seen = new WeakMap<object, unknown>();
    const visit = (value: unknown): unknown => {
      if (typeof value === 'string') {
        const mapped = this.canonicalizePath(value);
        if (mapped !== value) stats.changedStrings += 1;
        return mapped;
      }
      if (!value || typeof value !== 'object') return value;
      if (value instanceof Date || value instanceof RegExp || Buffer.isBuffer(value)) return value;
      const previous = seen.get(value);
      if (previous) return previous;
      if (Array.isArray(value)) {
        const output: unknown[] = [];
        seen.set(value, output);
        for (const item of value) output.push(visit(item));
        return output;
      }
      const output: Record<string, unknown> = {};
      const mappedKeyIndex = new Map<string, { key: string; changed: boolean }>();
      seen.set(value, output);
      for (const [key, item] of Object.entries(value)) {
        const mappedKey = this.canonicalizePath(key);
        const changed = mappedKey !== key;
        if (changed) stats.changedKeys += 1;
        const identity = this.flavor === path.win32 ? mappedKey.toLocaleLowerCase('en-US') : mappedKey;
        const existing = mappedKeyIndex.get(identity);
        if (existing && (existing.changed || changed)) {
          throw new AppError('LEGACY_PATH_KEY_COLLISION', '旧数据根目录映射产生重复对象键，已停止读取以避免覆盖历史数据', {
            legacyKey: key,
            effectiveKey: mappedKey,
            conflictingKey: existing.key
          }, 409);
        }
        mappedKeyIndex.set(identity, { key: mappedKey, changed });
        output[mappedKey] = visit(item);
      }
      return output;
    };
    return { value: visit(input) as T, ...stats };
  }

  async readiness(): Promise<LegacyRootCompatibilityReadiness> {
    const checkedAt = new Date().toISOString();
    if (!this.legacyRoot) {
      return {
        enabled: false,
        required: this.required,
        status: this.required ? 'BLOCKED' : 'DISABLED',
        legacyPathPresent: false,
        canonicalRootReady: false,
        mappingSelfTest: false,
        checkedAt,
        issues: [`MERCHROUTE_LEGACY_DATA_ROOT 未配置${this.required ? '，但本机已经进入旧根退役流程' : ''}`]
      };
    }

    const issues: string[] = [];
    if (!this.canonicalRoot) issues.push('MERCHROUTE_DATA_ROOT 未配置');
    if (!this.flavor) issues.push('旧根与当前数据根必须是同一种绝对路径格式');
    if (issues.length || !this.canonicalRoot || !this.flavor) {
      return {
        enabled: true,
        required: this.required,
        status: 'BLOCKED',
        legacyRoot: this.legacyRoot,
        canonicalRoot: this.canonicalRoot,
        legacyPathPresent: false,
        canonicalRootReady: false,
        mappingSelfTest: false,
        checkedAt,
        issues
      };
    }

    const rootsOverlap = rootsOverlapUnsafely(this.legacyRoot, this.canonicalRoot, this.flavor);
    if (rootsOverlap) issues.push('旧根与当前数据根不能相同或互为父子目录');
    const probeSuffix = ['.merchroute-legacy-root-self-test', 'probe.txt'];
    const expectedProbe = this.flavor.join(this.canonicalRoot, ...probeSuffix);
    const mappedProbe = this.canonicalizePath(this.flavor.join(this.legacyRoot, ...probeSuffix));
    const mappingSelfTest = sameResolvedPath(expectedProbe, mappedProbe, this.flavor);
    if (!mappingSelfTest) issues.push('旧根路径映射自检失败');

    const canonicalInfo = await lstat(this.canonicalRoot).catch(() => undefined);
    let canonicalRootReady = Boolean(canonicalInfo?.isDirectory() && !canonicalInfo.isSymbolicLink());
    if (canonicalRootReady) {
      canonicalRootReady = await access(this.canonicalRoot, constants.R_OK | constants.W_OK).then(() => true).catch(() => false);
    }
    if (!canonicalRootReady) issues.push('MERCHROUTE_DATA_ROOT 必须是存在的真实目录，不能是文件、符号链接或 Junction');

    const legacyInfo = await lstat(this.legacyRoot).catch(() => undefined);
    const legacyPathPresent = Boolean(legacyInfo);
    let legacyPathTargetsCanonicalRoot: boolean | undefined;
    if (legacyInfo && canonicalRootReady) {
      const [legacyResult, canonicalResult] = await Promise.allSettled([
        realpath(this.legacyRoot),
        realpath(this.canonicalRoot)
      ]);
      if (legacyResult.status === 'rejected') {
        legacyPathTargetsCanonicalRoot = false;
        issues.push('旧根存在但无法解析目标，可能是损坏的 Junction、目标离线或访问被拒绝');
      } else if (canonicalResult.status === 'rejected') {
        legacyPathTargetsCanonicalRoot = false;
        issues.push('MERCHROUTE_DATA_ROOT 无法解析真实路径');
      } else {
        legacyPathTargetsCanonicalRoot = sameResolvedPath(legacyResult.value, canonicalResult.value, this.flavor);
        if (!legacyPathTargetsCanonicalRoot) issues.push('旧根当前没有指向 MERCHROUTE_DATA_ROOT');
      }
    }

    return {
      enabled: true,
      required: this.required,
      status: issues.length ? 'BLOCKED' : 'READY',
      legacyRoot: this.legacyRoot,
      canonicalRoot: this.canonicalRoot,
      legacyPathPresent,
      canonicalRootReady,
      mappingSelfTest,
      ...(legacyPathTargetsCanonicalRoot === undefined ? {} : { legacyPathTargetsCanonicalRoot }),
      checkedAt,
      issues
    };
  }

  async assertReadyForRetirement(): Promise<void> {
    const status = await this.readiness();
    if (status.status !== 'READY') {
      throw new AppError('LEGACY_ROOT_COMPATIBILITY_BLOCKED', '旧数据根目录兼容层未就绪，已阻止下载和发布操作', status, 503);
    }
  }

  async assertOperational(): Promise<void> {
    const status = await this.readiness();
    if (status.status === 'DISABLED' && !status.required) return;
    if (status.status !== 'READY') {
      throw new AppError('LEGACY_ROOT_COMPATIBILITY_BLOCKED', '旧数据根目录兼容层未就绪，已阻止下载和发布操作', status, 503);
    }
  }
}

function trimConfiguredRoot(value: unknown): string | undefined {
  const normalized = String(value || '').trim();
  if (!normalized) return undefined;
  if (/^[A-Za-z]:[\\/]+$/.test(normalized)) return `${normalized[0]}:\\`;
  if (normalized === '/') return normalized;
  return normalized.replace(/[\\/]+$/, '');
}

function pathFlavor(legacyRoot?: string, canonicalRoot?: string): typeof path.win32 | typeof path.posix | undefined {
  if (!legacyRoot) return undefined;
  const legacyIsWindows = path.win32.isAbsolute(legacyRoot);
  const legacyIsPosix = path.posix.isAbsolute(legacyRoot);
  if (!legacyIsWindows && !legacyIsPosix) return undefined;
  if (!canonicalRoot) return legacyIsWindows ? path.win32 : path.posix;
  if (legacyIsWindows && path.win32.isAbsolute(canonicalRoot)) return path.win32;
  if (legacyIsPosix && path.posix.isAbsolute(canonicalRoot)) return path.posix;
  return undefined;
}

function isAbsoluteForFlavor(value: string, flavor: typeof path.win32 | typeof path.posix): boolean {
  return flavor.isAbsolute(value);
}

function usesForwardSlashesOnly(value: string): boolean {
  return value.includes('/') && !value.includes('\\');
}

function sameResolvedPath(left: string, right: string, flavor: typeof path.win32 | typeof path.posix): boolean {
  const leftResolved = flavor.resolve(left);
  const rightResolved = flavor.resolve(right);
  return flavor === path.win32
    ? leftResolved.toLocaleLowerCase('en-US') === rightResolved.toLocaleLowerCase('en-US')
    : leftResolved === rightResolved;
}

function rootsOverlapUnsafely(legacyRoot: string, canonicalRoot: string, flavor: typeof path.win32 | typeof path.posix): boolean {
  const left = flavor.resolve(legacyRoot);
  const right = flavor.resolve(canonicalRoot);
  if (sameResolvedPath(left, right, flavor)) return true;
  const leftToRight = flavor.relative(left, right);
  const rightToLeft = flavor.relative(right, left);
  return isContainedRelative(leftToRight, flavor) || isContainedRelative(rightToLeft, flavor);
}

function isContainedRelative(relative: string, flavor: typeof path.win32 | typeof path.posix): boolean {
  return Boolean(relative) && relative !== '..' && !relative.startsWith(`..${flavor.sep}`) && !flavor.isAbsolute(relative);
}
