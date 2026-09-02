import os from 'node:os';
import path from 'node:path';
import { mkdtemp, mkdir, realpath, rm, symlink } from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppError } from '@n8n-media-review/shared';
import { LocalDirectoryOpener, directoryOpenCommand } from './local-directory-opener.js';

describe('LocalDirectoryOpener', () => {
  let root: string;
  let product: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'merchroute-open-folder-'));
    product = path.join(root, '0000167-中文 产品');
    await mkdir(product);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it.each([
    ['win32', 'explorer.exe'],
    ['darwin', '/usr/bin/open']
  ] as const)('uses one raw directory argument on %s', async (platform, command) => {
    const launch = vi.fn(async () => undefined);
    await new LocalDirectoryOpener({ platform, launch }).openTaskDirectory({ candidateRoot: root, sourceFolder: product });

    expect(launch).toHaveBeenCalledOnce();
    expect(launch).toHaveBeenCalledWith(command, [await realpath(product)], { windowsHide: false });
  });

  it('rejects unsupported operating systems before launch', async () => {
    const launch = vi.fn(async () => undefined);
    await expect(new LocalDirectoryOpener({ platform: 'linux', launch }).openTaskDirectory({ candidateRoot: root, sourceFolder: product }))
      .rejects.toMatchObject({ code: 'UNSUPPORTED_PLATFORM', statusCode: 501 });
    expect(launch).not.toHaveBeenCalled();
  });

  it('maps launcher failures to a stable API error', async () => {
    const opener = new LocalDirectoryOpener({ platform: 'win32', launch: vi.fn(async () => { throw new Error('spawn failed'); }) });
    await expect(opener.openTaskDirectory({ candidateRoot: root, sourceFolder: product }))
      .rejects.toMatchObject({ code: 'DIRECTORY_OPEN_FAILED', statusCode: 500 });
  });

  it('rejects directories outside the configured candidate root', async () => {
    const outside = await mkdtemp(path.join(os.tmpdir(), 'merchroute-open-folder-outside-'));
    try {
      await expect(new LocalDirectoryOpener({ platform: 'win32', launch: vi.fn() }).openTaskDirectory({ candidateRoot: root, sourceFolder: outside }))
        .rejects.toMatchObject({ code: 'PATH_TRAVERSAL_BLOCKED' });
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it('rejects symbolic-link product directories', async () => {
    const outside = await mkdtemp(path.join(os.tmpdir(), 'merchroute-open-folder-target-'));
    const linkedProduct = path.join(root, 'linked-product');
    try {
      await symlink(outside, linkedProduct, process.platform === 'win32' ? 'junction' : 'dir');
      await expect(new LocalDirectoryOpener({ platform: 'win32', launch: vi.fn() }).openTaskDirectory({ candidateRoot: root, sourceFolder: linkedProduct }))
        .rejects.toMatchObject({ code: 'PATH_TRAVERSAL_BLOCKED' });
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });
});

describe('directoryOpenCommand', () => {
  it('returns the native Windows and macOS launchers', () => {
    expect(directoryOpenCommand('win32')).toBe('explorer.exe');
    expect(directoryOpenCommand('darwin')).toBe('/usr/bin/open');
  });

  it('returns a typed error for unsupported platforms', () => {
    expect(() => directoryOpenCommand('linux')).toThrow(AppError);
  });
});
