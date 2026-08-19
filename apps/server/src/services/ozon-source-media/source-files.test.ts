import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { lstat, mkdir, readFile, rename, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import { OzonSourceMediaFiles, type OzonFrozenMediaFile } from './source-files.js';

const roots: string[] = [];
const cleanupId = '11111111-1111-4111-8111-111111111111';
const sku = '0000123';
const mediaIdentityHash = `sha256:${'a'.repeat(64)}`;

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('OzonSourceMediaFiles', () => {
  it('只隔离精确版本目录，并在提交隔离凭据后立即删除', async () => {
    const fixture = await createFixture(`shared/${sku}/22222222-2222-4222-8222-222222222222`);
    await mkdir(path.join(fixture.directory, '.staging'));
    await writeFile(path.join(fixture.directory, 'product.json'), '{}\n');
    const files = new OzonSourceMediaFiles();
    const snapshot = await files.snapshot({
      rootDirectory: fixture.root,
      sourceRelPath: fixture.relPath,
      mediaIdentityHash,
      frozenMedia: fixture.frozenMedia
    });
    expect(snapshot.stagingEmpty).toBe(true);

    const quarantined = await files.quarantine({
      rootDirectory: fixture.root,
      cleanupId,
      sku,
      kind: 'SHARED_VERSION',
      sourceRelPath: fixture.relPath,
      mediaIdentityHash,
      expectedDirectorySignature: snapshot.directorySignature,
      frozenMedia: fixture.frozenMedia
    });
    expect(quarantined.state).toBe('QUARANTINED');
    await expect(readFile(path.join(fixture.root, quarantined.quarantineRelPath, '.ozon-source-cleanup.json'), 'utf8'))
      .resolves.toContain(cleanupId);

    await files.deleteQuarantine({
      rootDirectory: fixture.root,
      cleanupId,
      sku,
      kind: 'SHARED_VERSION',
      sourceRelPath: fixture.relPath,
      quarantineRelPath: quarantined.quarantineRelPath,
      mediaIdentityHash,
      directorySignature: snapshot.directorySignature
    });
    await expect(files.quarantineExists(fixture.root, quarantined.quarantineRelPath)).resolves.toBe(false);
    await expect(lstat(path.join(fixture.root, '.cleanup', cleanupId))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(files.snapshot({
      rootDirectory: fixture.root,
      sourceRelPath: fixture.relPath,
      mediaIdentityHash,
      frozenMedia: fixture.frozenMedia
    })).resolves.toMatchObject({ exists: false });
  });

  it('拒绝稳定版本之外的新媒体以及非空 staging', async () => {
    const fixture = await createFixture(`inbox/${sku}`);
    const files = new OzonSourceMediaFiles();
    await writeFile(path.join(fixture.directory, 'variants/extra.png'), 'new-media');
    await expect(files.snapshot({
      rootDirectory: fixture.root,
      sourceRelPath: fixture.relPath,
      mediaIdentityHash,
      frozenMedia: fixture.frozenMedia
    })).rejects.toMatchObject({ code: 'OZON_SOURCE_MEDIA_CLEANUP_BLOCKED' });

    await rm(path.join(fixture.directory, 'variants/extra.png'));
    await mkdir(path.join(fixture.directory, '.staging'), { recursive: true });
    await writeFile(path.join(fixture.directory, '.staging/partial.tmp'), 'partial');
    const snapshot = await files.snapshot({
      rootDirectory: fixture.root,
      sourceRelPath: fixture.relPath,
      mediaIdentityHash,
      frozenMedia: fixture.frozenMedia
    });
    expect(snapshot.stagingEmpty).toBe(false);
    await expect(files.quarantine({
      rootDirectory: fixture.root,
      cleanupId,
      sku,
      kind: 'RAW_INBOX',
      sourceRelPath: fixture.relPath,
      mediaIdentityHash,
      expectedDirectorySignature: snapshot.directorySignature,
      frozenMedia: fixture.frozenMedia
    })).rejects.toMatchObject({ code: 'OZON_SOURCE_MEDIA_BUSY' });
  });

  it('恢复 rename 后数据库提交前的隔离目录，但绝不覆盖同时存在的源目录', async () => {
    const fixture = await createFixture(`inbox/${sku}`);
    const files = new OzonSourceMediaFiles();
    const snapshot = await files.snapshot({
      rootDirectory: fixture.root,
      sourceRelPath: fixture.relPath,
      mediaIdentityHash,
      frozenMedia: fixture.frozenMedia
    });
    const quarantineRelPath = `.cleanup/${cleanupId}/RAW_INBOX`;
    const quarantinePath = path.join(fixture.root, ...quarantineRelPath.split('/'));
    await mkdir(path.dirname(quarantinePath), { recursive: true });
    await rename(fixture.directory, quarantinePath);

    await expect(files.quarantine({
      rootDirectory: fixture.root,
      cleanupId,
      sku,
      kind: 'RAW_INBOX',
      sourceRelPath: fixture.relPath,
      mediaIdentityHash,
      expectedDirectorySignature: snapshot.directorySignature,
      expectedQuarantineRelPath: quarantineRelPath,
      frozenMedia: fixture.frozenMedia
    })).resolves.toMatchObject({ state: 'ALREADY_QUARANTINED' });

    await mkdir(fixture.directory, { recursive: true });
    await expect(files.quarantine({
      rootDirectory: fixture.root,
      cleanupId,
      sku,
      kind: 'RAW_INBOX',
      sourceRelPath: fixture.relPath,
      mediaIdentityHash,
      expectedDirectorySignature: snapshot.directorySignature,
      expectedQuarantineRelPath: quarantineRelPath,
      frozenMedia: fixture.frozenMedia
    })).rejects.toMatchObject({ code: 'OZON_SOURCE_MEDIA_CLEANUP_BLOCKED' });
  });

  it('数据库已隔离但只有源目录存在时禁止误判为已删除', async () => {
    const fixture = await createFixture(`inbox/${sku}`);
    await expect(new OzonSourceMediaFiles().deleteQuarantine({
      rootDirectory: fixture.root,
      cleanupId,
      sku,
      kind: 'RAW_INBOX',
      sourceRelPath: fixture.relPath,
      quarantineRelPath: `.cleanup/${cleanupId}/RAW_INBOX`,
      mediaIdentityHash,
      directorySignature: `sha256:${'b'.repeat(64)}`
    })).rejects.toMatchObject({ code: 'OZON_SOURCE_MEDIA_CLEANUP_BLOCKED' });
  });

  it('仅回收超时且原进程不存在的文件锁', async () => {
    const fixture = await createFixture(`inbox/${sku}`);
    const files = new OzonSourceMediaFiles();
    const snapshot = await files.snapshot({
      rootDirectory: fixture.root,
      sourceRelPath: fixture.relPath,
      mediaIdentityHash,
      frozenMedia: fixture.frozenMedia
    });
    const lockDirectory = path.join(fixture.root, '.locks');
    const lockPath = path.join(lockDirectory, `ozon-source-media-cleanup-${sku}.lock`);
    await mkdir(lockDirectory, { recursive: true });
    await writeFile(lockPath, JSON.stringify({ pid: 2_147_483_000, sku }));
    const old = new Date(Date.now() - 20 * 60_000);
    await utimes(lockPath, old, old);
    await expect(files.quarantine({
      rootDirectory: fixture.root,
      cleanupId,
      sku,
      kind: 'RAW_INBOX',
      sourceRelPath: fixture.relPath,
      mediaIdentityHash,
      expectedDirectorySignature: snapshot.directorySignature,
      frozenMedia: fixture.frozenMedia
    })).resolves.toMatchObject({ state: 'QUARANTINED' });
  });

  it('拒绝目录中的符号链接或 junction', async () => {
    const fixture = await createFixture(`inbox/${sku}`);
    const outside = path.join(fixture.root, 'outside');
    await mkdir(outside);
    try {
      await symlink(outside, path.join(fixture.directory, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
    } catch (error: any) {
      if (error?.code === 'EPERM') return;
      throw error;
    }
    await expect(new OzonSourceMediaFiles().snapshot({
      rootDirectory: fixture.root,
      sourceRelPath: fixture.relPath,
      mediaIdentityHash,
      frozenMedia: fixture.frozenMedia
    })).rejects.toMatchObject({ code: 'OZON_SOURCE_MEDIA_CLEANUP_BLOCKED' });
  });
});

async function createFixture(relPath: string): Promise<{
  root: string;
  relPath: string;
  directory: string;
  frozenMedia: OzonFrozenMediaFile[];
}> {
  const root = await import('node:fs/promises').then(({ mkdtemp }) => mkdtemp(path.join(os.tmpdir(), 'ozon-source-cleanup-')));
  roots.push(root);
  const directory = path.join(root, ...relPath.split('/'));
  const media = Buffer.from('exact-media');
  const relativePath = 'variants/01/image.png';
  await mkdir(path.join(directory, 'variants/01'), { recursive: true });
  await writeFile(path.join(directory, ...relativePath.split('/')), media);
  return {
    root,
    relPath,
    directory,
    frozenMedia: [{
      relativePath,
      kind: 'IMAGE',
      sizeBytes: media.length,
      sha256: createHash('sha256').update(media).digest('hex')
    }]
  };
}
