import { realpath } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { AppError } from '@n8n-media-review/shared';

export type DownloadPathFlavor = 'win32' | 'posix';

export interface DownloadPathInspection {
  normalizedPath: string;
  realPath?: string;
  exists?: boolean;
  flavor: DownloadPathFlavor;
}

export interface PathContainmentOptions {
  allowEqual?: boolean;
}

export interface RealPathContainmentOptions extends PathContainmentOptions {
  allowMissing?: boolean;
}

const UNSAFE_DOWNLOAD_ROOT_MESSAGE = '图片保存地址不能使用系统临时目录或测试目录';
const TEST_DIRECTORY_SEGMENT = /^n8n-review-/i;

type PathApi = typeof path.win32 | typeof path.posix;

/**
 * Validate and inspect an absolute Windows or POSIX path without depending on
 * the host platform's path parser. Missing leaf directories are projected
 * through their nearest existing ancestor so parent symlinks remain visible.
 */
export async function inspectAbsoluteDownloadPath(input: string): Promise<DownloadPathInspection> {
  const parsed = parseAbsolutePath(input);
  const resolved = await resolveThroughExistingAncestor(parsed.normalizedPath, parsed.flavor);
  return { ...parsed, ...resolved };
}

/**
 * Reject download roots that are relative, live in the host temporary
 * directory, resolve there through a symlink/junction, or contain an
 * n8n-review-* test directory segment.
 */
export async function assertSafeDownloadRoot(input: string): Promise<DownloadPathInspection> {
  const inspected = await inspectAbsoluteDownloadPath(input);
  if (hasTestDirectorySegment(inspected.normalizedPath)) {
    throw unsafeDownloadRoot(input, 'test_directory', inspected.normalizedPath);
  }

  const temp = parseAbsolutePath(os.tmpdir());
  if (sameFlavor(inspected, temp) && isPathContained(temp.normalizedPath, inspected.normalizedPath, { allowEqual: true })) {
    throw unsafeDownloadRoot(input, 'system_temp_directory', inspected.normalizedPath);
  }

  if (inspected.realPath) {
    if (hasTestDirectorySegment(inspected.realPath)) {
      throw unsafeDownloadRoot(input, 'resolved_test_directory', inspected.realPath);
    }
    const resolvedTemp = await resolveThroughExistingAncestor(temp.normalizedPath, temp.flavor);
    if (resolvedTemp.realPath && isPathContained(resolvedTemp.realPath, inspected.realPath, { allowEqual: true })) {
      throw unsafeDownloadRoot(input, 'resolved_system_temp_directory', inspected.realPath);
    }
  }

  return inspected;
}

/**
 * Lexical containment using the path's own flavor. Windows comparisons are
 * always case-insensitive, even when the code is being tested on macOS.
 */
export function isPathContained(parent: string, candidate: string, options: PathContainmentOptions = {}): boolean {
  const parsedParent = tryParseAbsolutePath(parent);
  const parsedCandidate = tryParseAbsolutePath(candidate);
  if (!parsedParent || !parsedCandidate || !sameFlavor(parsedParent, parsedCandidate)) return false;
  return compareContained(parsedParent.normalizedPath, parsedCandidate.normalizedPath, parsedParent.flavor, options.allowEqual ?? false);
}

/**
 * Canonical containment. By default both paths must exist. With allowMissing,
 * each missing suffix is projected from its nearest existing ancestor.
 */
export async function isRealPathContained(parent: string, candidate: string, options: RealPathContainmentOptions = {}): Promise<boolean> {
  const parsedParent = tryParseAbsolutePath(parent);
  const parsedCandidate = tryParseAbsolutePath(candidate);
  if (!parsedParent || !parsedCandidate || !sameFlavor(parsedParent, parsedCandidate)) return false;
  if (!isHostPathFlavor(parsedParent.flavor)) return false;

  const [resolvedParent, resolvedCandidate] = await Promise.all([
    resolveThroughExistingAncestor(parsedParent.normalizedPath, parsedParent.flavor),
    resolveThroughExistingAncestor(parsedCandidate.normalizedPath, parsedCandidate.flavor)
  ]);
  if (!resolvedParent.realPath || !resolvedCandidate.realPath) return false;
  if (!options.allowMissing && (resolvedParent.exists !== true || resolvedCandidate.exists !== true)) return false;
  return compareContained(resolvedParent.realPath, resolvedCandidate.realPath, parsedParent.flavor, options.allowEqual ?? false);
}

/**
 * Require both lexical and canonical containment. This blocks a child path
 * whose symlink or junction escapes the configured parent directory.
 */
export async function isPathSafelyContained(parent: string, candidate: string, options: RealPathContainmentOptions = {}): Promise<boolean> {
  if (!isPathContained(parent, candidate, options)) return false;
  return isRealPathContained(parent, candidate, options);
}

function parseAbsolutePath(input: string): DownloadPathInspection {
  const value = String(input ?? '').trim();
  const flavor = detectPathFlavor(value);
  if (!value || value.includes('\0') || !flavor) throw unsafeDownloadRoot(input, 'not_absolute');
  if (/^(?:\\\\[?.]\\|\/\/[?.]\/)/.test(value)) throw unsafeDownloadRoot(input, 'device_namespace');
  return { normalizedPath: normalizeForFlavor(value, flavor), flavor };
}

function tryParseAbsolutePath(input: string): DownloadPathInspection | undefined {
  try {
    return parseAbsolutePath(input);
  } catch {
    return undefined;
  }
}

function detectPathFlavor(value: string): DownloadPathFlavor | undefined {
  if (/^[a-zA-Z]:[\\/]/.test(value)) return 'win32';
  if (/^[\\/]{2}[^\\/]+[\\/][^\\/]+(?:[\\/]|$)/.test(value)) return 'win32';
  if (value.startsWith('/')) return 'posix';
  return undefined;
}

function normalizeForFlavor(value: string, flavor: DownloadPathFlavor): string {
  const api = pathApi(flavor);
  const normalized = stripWindowsDevicePrefix(api.normalize(value), flavor);
  return flavor === 'win32' ? normalized.replace(/^([a-z]):/i, (_, drive: string) => `${drive.toUpperCase()}:`) : normalized;
}

function compareContained(parent: string, candidate: string, flavor: DownloadPathFlavor, allowEqual: boolean): boolean {
  const api = pathApi(flavor);
  const comparableParent = comparable(parent, flavor);
  const comparableCandidate = comparable(candidate, flavor);
  const relative = api.relative(comparableParent, comparableCandidate);
  if (!relative) return allowEqual;
  return relative !== '..' && !relative.startsWith(`..${api.sep}`) && !api.isAbsolute(relative);
}

function comparable(value: string, flavor: DownloadPathFlavor): string {
  const normalized = normalizeForFlavor(value, flavor);
  return flavor === 'win32' ? normalized.toLocaleLowerCase('en-US') : normalized;
}

function hasTestDirectorySegment(value: string): boolean {
  return value.split(/[\\/]+/).some((segment) => TEST_DIRECTORY_SEGMENT.test(segment));
}

async function resolveThroughExistingAncestor(
  value: string,
  flavor: DownloadPathFlavor
): Promise<Pick<DownloadPathInspection, 'realPath' | 'exists'>> {
  if (!isHostPathFlavor(flavor)) return { exists: undefined };
  const api = pathApi(flavor);
  let cursor = value;
  const missingSegments: string[] = [];

  while (true) {
    try {
      const resolved = normalizeForFlavor(await realpath(cursor), flavor);
      return {
        exists: missingSegments.length === 0,
        realPath: missingSegments.length ? api.join(resolved, ...missingSegments) : resolved
      };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT' && code !== 'ENOTDIR') {
        throw unsafeDownloadRoot(value, 'realpath_check_failed', cursor, error instanceof Error ? error.message : String(error));
      }
      const parent = api.dirname(cursor);
      if (parent === cursor) return { exists: false };
      missingSegments.unshift(api.basename(cursor));
      cursor = parent;
    }
  }
}

function isHostPathFlavor(flavor: DownloadPathFlavor): boolean {
  return process.platform === 'win32' ? flavor === 'win32' : flavor === 'posix';
}

function sameFlavor(left: Pick<DownloadPathInspection, 'flavor'>, right: Pick<DownloadPathInspection, 'flavor'>): boolean {
  return left.flavor === right.flavor;
}

function pathApi(flavor: DownloadPathFlavor): PathApi {
  return flavor === 'win32' ? path.win32 : path.posix;
}

function stripWindowsDevicePrefix(value: string, flavor: DownloadPathFlavor): string {
  if (flavor !== 'win32') return value;
  if (value.startsWith('\\\\?\\UNC\\')) return `\\\\${value.slice(8)}`;
  if (value.startsWith('\\\\?\\')) return value.slice(4);
  return value;
}

function unsafeDownloadRoot(input: string, reason: string, checkedPath?: string, cause?: string): AppError {
  return new AppError('DOWNLOAD_ROOT_UNSAFE', UNSAFE_DOWNLOAD_ROOT_MESSAGE, {
    parentOutputDir: String(input ?? ''),
    reason,
    ...(checkedPath ? { checkedPath } : {}),
    ...(cause ? { cause } : {})
  }, 409);
}
