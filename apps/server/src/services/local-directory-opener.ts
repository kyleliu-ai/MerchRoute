import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { lstat, realpath } from 'node:fs/promises';
import path from 'node:path';
import { AppError } from '@n8n-media-review/shared';
import { isPathInside } from '../utils/paths.js';

export type DirectoryLaunchOptions = {
  windowsHide: boolean;
};

export type DirectoryLaunch = (command: string, args: string[], options: DirectoryLaunchOptions) => Promise<void>;

export type LocalDirectoryOpenerOptions = {
  platform?: NodeJS.Platform;
  launch?: DirectoryLaunch;
};

export type OpenTaskDirectoryInput = {
  candidateRoot: string;
  sourceFolder: string;
};

export class LocalDirectoryOpener {
  private readonly platform: NodeJS.Platform;
  private readonly launch: DirectoryLaunch;

  constructor(options: LocalDirectoryOpenerOptions = {}) {
    this.platform = options.platform ?? process.platform;
    this.launch = options.launch ?? launchDetached;
  }

  async openTaskDirectory(input: OpenTaskDirectoryInput): Promise<void> {
    const sourceInfo = await lstat(input.sourceFolder).catch(() => null);
    if (!sourceInfo) {
      throw new AppError('SOURCE_FOLDER_MISSING', '产品任务不存在或已被移动', { sourceFolder: input.sourceFolder }, 404);
    }
    if (sourceInfo.isSymbolicLink()) {
      throw new AppError('PATH_TRAVERSAL_BLOCKED', '不允许打开符号链接产品目录', { sourceFolder: input.sourceFolder });
    }
    if (!sourceInfo.isDirectory()) {
      throw new AppError('SOURCE_FOLDER_MISSING', '产品任务不存在或已被移动', { sourceFolder: input.sourceFolder }, 404);
    }

    let resolvedRoot: string;
    let resolvedSource: string;
    try {
      [resolvedRoot, resolvedSource] = await Promise.all([realpath(input.candidateRoot), realpath(input.sourceFolder)]);
    } catch {
      throw new AppError('SOURCE_FOLDER_MISSING', '产品任务不存在或已被移动', { sourceFolder: input.sourceFolder }, 404);
    }

    const relative = path.relative(resolvedRoot, resolvedSource);
    if (!isPathInside(resolvedRoot, resolvedSource) || !relative || relative === '.' || relative.split(path.sep).length !== 1) {
      throw new AppError('PATH_TRAVERSAL_BLOCKED', '产品目录不属于当前流程候选根目录', { sourceFolder: input.sourceFolder });
    }

    const command = directoryOpenCommand(this.platform);
    try {
      await this.launch(command, [resolvedSource], { windowsHide: false });
    } catch (error) {
      throw new AppError('DIRECTORY_OPEN_FAILED', '无法打开产品文件夹', {
        platform: this.platform,
        reason: error instanceof Error ? error.message : String(error)
      }, 500);
    }
  }
}

export function directoryOpenCommand(platform: NodeJS.Platform): string {
  if (platform === 'win32') return 'explorer.exe';
  if (platform === 'darwin') return '/usr/bin/open';
  throw new AppError('UNSUPPORTED_PLATFORM', '当前操作系统不支持打开本地产品文件夹', { platform }, 501);
}

async function launchDetached(command: string, args: string[], options: DirectoryLaunchOptions): Promise<void> {
  const child = spawn(command, args, {
    detached: true,
    shell: false,
    stdio: 'ignore',
    windowsHide: options.windowsHide
  });
  await once(child, 'spawn');
  child.unref();
}
