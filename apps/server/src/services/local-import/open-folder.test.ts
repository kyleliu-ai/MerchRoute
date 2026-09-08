import os from 'node:os';
import path from 'node:path';
import { mkdtemp, mkdir, rename, rm, symlink } from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConfigService } from '../../config/service.js';
import type { PurchaseRepository } from '../../repositories/purchases.js';
import { LocalDirectoryOpener } from '../local-directory-opener.js';
import { LocalImportService } from './index.js';

describe('local import folder opening', () => {
  let root: string;
  let sourceRoot: string;
  let service: LocalImportService;
  let stage: { id: string; enabled: boolean; inputQueueRoot: string };
  let configHash: string;
  const relativePath = "PDD/938669001556-R1 中文 & '特殊'";

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'merchroute-variant-open-'));
    sourceRoot = path.join(root, 'source');
    await mkdir(path.join(sourceRoot, relativePath), { recursive: true });
    stage = { id: 'E000', enabled: true, inputQueueRoot: sourceRoot };
    service = new LocalImportService({ get: () => ({ stages: [stage] }) } as unknown as ConfigService, {} as PurchaseRepository, vi.fn());
    configHash = (await service.listDirectories()).configHash;
  });
  afterEach(async () => { await rm(root, { recursive: true, force: true }); });

  it.each([['win32', 'explorer.exe'], ['darwin', '/usr/bin/open']] as const)('opens a leaf variant on %s with one unchanged visible-window argument', async (platform, command) => {
    const launch = vi.fn(async () => undefined);
    const directory = await service.resolveDirectoryToOpen({ relativePath, configHash });
    await new LocalDirectoryOpener({ platform, launch }).openValidatedDirectory(directory, '变体目录');
    expect(launch).toHaveBeenCalledExactlyOnceWith(command, [path.join(sourceRoot, relativePath)], { windowsHide: false });
  });

  it.each(['', 'PDD', 'PDD/item/child', '../escape', 'PDD/..', '/PDD/item', 'C:/item', 'C:item', '\\\\server\\share', 'PDD\\item', 'PDD//item', 'PDD/.hidden', 'PDD/~temp', 'PDD/item\0'])('rejects invalid or out-of-scope directory %j', async (relativePath) => {
    await expect(service.resolveDirectoryToOpen({ relativePath, configHash })).rejects.toMatchObject({ code: 'LOCAL_IMPORT_PATH_INVALID' });
  });

  it('rejects missing input and stale configuration', async () => {
    await expect(service.resolveDirectoryToOpen(undefined)).rejects.toMatchObject({ code: 'LOCAL_IMPORT_PATH_INVALID' });
    await expect(service.resolveDirectoryToOpen({ relativePath, configHash: 'old' })).rejects.toMatchObject({ code: 'LOCAL_IMPORT_CONFIG_CHANGED' });
    stage.inputQueueRoot = path.join(root, 'other-source');
    await mkdir(path.join(stage.inputQueueRoot, relativePath), { recursive: true });
    await expect(service.resolveDirectoryToOpen({ relativePath, configHash })).rejects.toMatchObject({ code: 'LOCAL_IMPORT_CONFIG_CHANGED' });
  });

  it('rejects a moved variant and a disabled workflow', async () => {
    await rename(path.join(sourceRoot, relativePath), path.join(root, 'moved'));
    await expect(service.resolveDirectoryToOpen({ relativePath, configHash })).rejects.toMatchObject({ code: 'LOCAL_IMPORT_PATH_UNSAFE' });
    stage.enabled = false;
    await expect(service.resolveDirectoryToOpen({ relativePath, configHash })).rejects.toMatchObject({ code: 'LOCAL_IMPORT_DISABLED' });
  });

  it.each(['platform', 'variant'])('rejects a linked %s directory', async (level) => {
    const outside = path.join(root, 'outside');
    await mkdir(path.join(outside, 'product'), { recursive: true });
    const link = level === 'platform' ? path.join(sourceRoot, 'LINK') : path.join(sourceRoot, 'PDD', 'LINK');
    await symlink(outside, link, process.platform === 'win32' ? 'junction' : 'dir');
    await expect(service.resolveDirectoryToOpen({ relativePath: level === 'platform' ? 'LINK/product' : 'PDD/LINK', configHash }))
      .rejects.toMatchObject({ code: 'LOCAL_IMPORT_PATH_UNSAFE' });
  });

  it('reports native startup errors and unsupported platforms', async () => {
    const directory = await service.resolveDirectoryToOpen({ relativePath, configHash });
    const launch = vi.fn(async () => { throw new Error('spawn failed'); });
    await expect(new LocalDirectoryOpener({ platform: 'win32', launch }).openValidatedDirectory(directory, '变体目录'))
      .rejects.toMatchObject({ code: 'DIRECTORY_OPEN_FAILED', message: '无法打开变体目录' });
    launch.mockClear();
    await expect(new LocalDirectoryOpener({ platform: 'linux', launch }).openValidatedDirectory(directory, '变体目录'))
      .rejects.toMatchObject({ code: 'UNSUPPORTED_PLATFORM' });
    expect(launch).not.toHaveBeenCalled();
  });
});
