import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { afterEach, describe, expect, it } from 'vitest';
import { WbSourceMediaFiles } from './source-files.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture(sku = '0000123') {
  const root = await mkdtemp(path.join(os.tmpdir(), 'wb-source-cleanup-'));
  roots.push(root);
  const productRoot = path.join(root, 'inbox', sku);
  const mediaRelative = 'variants/red/images/batch/01.png';
  const media = Buffer.from('media-bytes');
  await mkdir(path.join(productRoot, 'variants', 'red', 'images', 'batch'), { recursive: true });
  await writeFile(path.join(productRoot, ...mediaRelative.split('/')), media);
  await writeFile(path.join(productRoot, 'variants', 'variant-media-manifest.json'), `${JSON.stringify({
    schemaVersion: 2,
    SKU: sku,
    productName: 'fixture',
    updatedAt: '2026-08-14T00:00:00.000Z',
    assets: [{
      submissionId: 'submission', sourceStageId: 'E005', variantId: 'variant', variantName: 'red', kind: 'image', sortOrder: 0,
      relativePath: mediaRelative, sizeBytes: media.length, sha256: createHash('sha256').update(media).digest('hex'),
      deliveredAt: '2026-08-14T00:00:00.000Z'
    }]
  }, null, 2)}\n`);
  return { root, productRoot, mediaRelative };
}

function identity(mediaSignature: string, rowVersion = 3) {
  return {
    cleanupId: '11111111-1111-4111-8111-111111111111',
    sku: '0000123',
    batchKey: 'manual:0000123:plan',
    rowVersion,
    mediaSignature
  };
}

describe('WbSourceMediaFiles', () => {
  it('freezes manifest and media, atomically quarantines the exact SKU directory, then deletes only quarantine', async () => {
    const { root, productRoot } = await fixture();
    const files = new WbSourceMediaFiles();
    await mkdir(path.join(root, 'success'), { recursive: true });
    await writeFile(path.join(root, 'success', 'sentinel'), 'keep');
    const snapshot = await files.snapshot(root, '0000123');
    expect(snapshot).toMatchObject({ exists: true, stagingEmpty: true, fileCount: 2 });
    expect(snapshot.mediaSignature).toMatch(/^sha256:[a-f0-9]{64}$/);

    const quarantined = await files.quarantine({ rootDirectory: root, ...identity(snapshot.mediaSignature!) });
    expect(quarantined).toEqual({
      state: 'QUARANTINED',
      quarantineRelPath: '.cleanup/11111111-1111-4111-8111-111111111111-0000123'
    });
    await expect(readFile(path.join(productRoot, 'variants', 'variant-media-manifest.json'))).rejects.toMatchObject({ code: 'ENOENT' });
    const deleted = await files.deleteQuarantine({
      rootDirectory: root,
      ...identity(snapshot.mediaSignature!, 4),
      quarantineRelPath: quarantined.quarantineRelPath
    });
    expect(deleted).toEqual({ deleted: true });
    await expect(readFile(path.join(root, 'success', 'sentinel'), 'utf8')).resolves.toBe('keep');
  });

  it('recovers after a crash between rename and the database quarantine transition', async () => {
    const { root } = await fixture();
    const files = new WbSourceMediaFiles();
    const snapshot = await files.snapshot(root, '0000123');
    const first = await files.quarantine({ rootDirectory: root, ...identity(snapshot.mediaSignature!, 7) });
    const recovered = await files.quarantine({
      rootDirectory: root,
      ...identity(snapshot.mediaSignature!, 12),
      expectedQuarantineRelPath: first.quarantineRelPath
    });
    expect(recovered.state).toBe('ALREADY_QUARANTINED');
    await expect(files.deleteQuarantine({
      rootDirectory: root,
      ...identity(snapshot.mediaSignature!, 13),
      quarantineRelPath: first.quarantineRelPath
    })).resolves.toEqual({ deleted: true });
  });

  it('refuses changed media and non-empty staging without moving the source directory', async () => {
    const { root, productRoot, mediaRelative } = await fixture();
    const files = new WbSourceMediaFiles();
    const snapshot = await files.snapshot(root, '0000123');
    await writeFile(path.join(productRoot, ...mediaRelative.split('/')), 'changed');
    await expect(files.quarantine({ rootDirectory: root, ...identity(snapshot.mediaSignature!) }))
      .rejects.toMatchObject({ code: 'WB_SOURCE_MEDIA_CHANGED' });
    await expect(readFile(path.join(productRoot, ...mediaRelative.split('/')))).resolves.toBeInstanceOf(Buffer);

    const fresh = await fixture('0000123');
    const freshSnapshot = await files.snapshot(fresh.root, '0000123');
    await mkdir(path.join(fresh.productRoot, '.staging'), { recursive: true });
    await writeFile(path.join(fresh.productRoot, '.staging', 'busy.tmp'), 'busy');
    await expect(files.quarantine({ rootDirectory: fresh.root, ...identity(freshSnapshot.mediaSignature!) }))
      .rejects.toMatchObject({ code: 'WB_SOURCE_MEDIA_CHANGED' });
  });

  it('fails closed for path escape and links inside the SKU tree', async () => {
    const { root, productRoot } = await fixture();
    const files = new WbSourceMediaFiles();
    const snapshot = await files.snapshot(root, '0000123');
    await expect(files.quarantine({
      rootDirectory: root,
      ...identity(snapshot.mediaSignature!),
      expectedQuarantineRelPath: '../outside'
    })).rejects.toMatchObject({ code: 'PATH_TRAVERSAL_BLOCKED' });

    const outside = path.join(root, 'outside.txt');
    await writeFile(outside, 'sentinel');
    try {
      await symlink(outside, path.join(productRoot, 'variants', 'escape-link'));
    } catch (error: any) {
      if (error?.code === 'EPERM') return;
      throw error;
    }
    await expect(files.snapshot(root, '0000123')).rejects.toMatchObject({ code: 'PATH_TRAVERSAL_BLOCKED' });
    await expect(readFile(outside, 'utf8')).resolves.toBe('sentinel');
  });

  it('classifies Windows occupied-file errors as retryable and keeps the quarantined directory', async () => {
    const { root } = await fixture();
    const busy = Object.assign(new Error('file is busy'), { code: 'EBUSY' });
    const files = new WbSourceMediaFiles({
      rename: async (...args) => (await import('node:fs/promises')).rename(...args),
      rm: async () => { throw busy; }
    });
    const snapshot = await files.snapshot(root, '0000123');
    const quarantined = await files.quarantine({ rootDirectory: root, ...identity(snapshot.mediaSignature!) });
    await expect(files.deleteQuarantine({
      rootDirectory: root,
      ...identity(snapshot.mediaSignature!, 4),
      quarantineRelPath: quarantined.quarantineRelPath
    })).rejects.toMatchObject({ code: 'WB_SOURCE_MEDIA_CLEANUP_RETRY', details: { filesystemCode: 'EBUSY', retryable: true } });
    await expect(readFile(path.join(root, quarantined.quarantineRelPath, '.wb-source-cleanup.json'), 'utf8')).resolves.toContain('0000123');
  });
});
