import path from 'node:path';
import { lstat, realpath } from 'node:fs/promises';
import { AppError } from '@n8n-media-review/shared';

export const toApiRelativePath = (value: string): string => value.split(path.sep).join('/');

export const fromApiRelativePath = (value: string): string => {
  if (!value || value.includes('\0') || path.posix.isAbsolute(value) || path.win32.isAbsolute(value)) {
    throw new AppError('INVALID_RELATIVE_PATH', '图片路径必须是产品目录内的相对路径', { relativePath: value });
  }
  const normalized = value.replaceAll('\\', '/');
  if (normalized.split('/').some((part) => part === '..')) {
    throw new AppError('PATH_TRAVERSAL_BLOCKED', '已阻止越过产品目录的路径访问', { relativePath: value });
  }
  return normalized.split('/').join(path.sep);
};

export const isPathInside = (root: string, candidate: string): boolean => {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  const outside = relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative);
  if (process.platform === 'win32') {
    const rootLower = path.resolve(root).toLocaleLowerCase('en-US');
    const candidateLower = path.resolve(candidate).toLocaleLowerCase('en-US');
    const relLower = path.relative(rootLower, candidateLower);
    return !(relLower === '..' || relLower.startsWith(`..${path.sep}`) || path.isAbsolute(relLower));
  }
  return !outside;
};

export const secureResolve = async (root: string, relativePath: string): Promise<string> => {
  const candidate = path.resolve(root, fromApiRelativePath(relativePath));
  if (!isPathInside(root, candidate)) {
    throw new AppError('PATH_TRAVERSAL_BLOCKED', '已阻止越过产品目录的路径访问', { relativePath });
  }
  const stat = await lstat(candidate).catch(() => null);
  if (!stat) throw new AppError('SOURCE_FILE_MISSING', '选中的文件已不存在', { relativePath }, 404);
  if (stat.isSymbolicLink()) throw new AppError('PATH_TRAVERSAL_BLOCKED', '不允许访问符号链接', { relativePath });
  const resolvedRoot = await realpath(root);
  const resolvedCandidate = await realpath(candidate);
  if (!isPathInside(resolvedRoot, resolvedCandidate)) {
    throw new AppError('PATH_TRAVERSAL_BLOCKED', '文件真实路径超出任务目录', { relativePath });
  }
  return resolvedCandidate;
};

export const normalizedTaskPath = (value: string): string => {
  const resolved = path.resolve(value);
  return process.platform === 'win32' ? resolved.toLocaleLowerCase('en-US') : resolved;
};
