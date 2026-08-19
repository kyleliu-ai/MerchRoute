import { mkdtemp, mkdir, rm, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  assertSafeDownloadRoot,
  inspectAbsoluteDownloadPath,
  isPathContained,
  isPathSafelyContained,
  isRealPathContained
} from './download-path-safety.js';

const cleanupPaths: string[] = [];

afterEach(async () => {
  await Promise.all(cleanupPaths.splice(0).reverse().map((item) => rm(item, { recursive: true, force: true })));
});

describe('download root safety', () => {
  it('requires a fully qualified Windows or POSIX absolute path', async () => {
    for (const value of ['', 'relative/downloads', '.\\downloads', 'C:downloads', '\\downloads']) {
      await expect(assertSafeDownloadRoot(value)).rejects.toMatchObject({
        code: 'DOWNLOAD_ROOT_UNSAFE',
        statusCode: 409,
        details: { reason: 'not_absolute' }
      });
    }
  });

  it('rejects the host temporary directory and every lexical descendant', async () => {
    await expect(assertSafeDownloadRoot(os.tmpdir())).rejects.toMatchObject({
      code: 'DOWNLOAD_ROOT_UNSAFE',
      details: { reason: 'system_temp_directory' }
    });
    await expect(assertSafeDownloadRoot(path.join(os.tmpdir(), 'downloads', 'E006'))).rejects.toMatchObject({
      code: 'DOWNLOAD_ROOT_UNSAFE',
      details: { reason: 'system_temp_directory' }
    });
  });

  it('rejects n8n-review-* in any path segment with case-insensitive matching', async () => {
    const unsafe = process.platform === 'win32'
      ? 'G:\\media\\N8N-REVIEW-legacy-ZyZNPB\\E006\\candidate'
      : '/Volumes/media/N8N-REVIEW-legacy-ZyZNPB/E006/candidate';
    await expect(assertSafeDownloadRoot(unsafe)).rejects.toMatchObject({
      code: 'DOWNLOAD_ROOT_UNSAFE',
      details: { reason: 'test_directory' }
    });
  });

  it('accepts a safe missing directory and projects its canonical path through an existing ancestor', async () => {
    const fixture = await createSafeFixture('.download-root-safe-');
    const safeMissing = path.join(fixture, 'future');
    const inspected = await assertSafeDownloadRoot(safeMissing);
    expect(inspected.normalizedPath).toBe(path.normalize(safeMissing));
    expect(inspected.exists).toBe(false);
    expect(inspected.realPath).toBeTruthy();
  });

  it('rejects a safe-looking path whose existing parent resolves into the temporary directory', async () => {
    const fixture = await createSafeFixture('.download-root-alias-');
    const tempTarget = await mkdtemp(path.join(os.tmpdir(), 'download-root-target-'));
    cleanupPaths.push(tempTarget);
    const alias = path.join(fixture, 'media-alias');
    await symlink(tempTarget, alias, process.platform === 'win32' ? 'junction' : 'dir');

    await expect(assertSafeDownloadRoot(path.join(alias, 'not-created-yet'))).rejects.toMatchObject({
      code: 'DOWNLOAD_ROOT_UNSAFE',
      details: { reason: 'resolved_system_temp_directory' }
    });
  });
});

describe('download path containment', () => {
  it('compares Windows paths without case sensitivity and blocks prefix siblings', () => {
    expect(isPathContained('C:\\Media\\PDD', 'c:\\media\\pdd\\0000089')).toBe(true);
    expect(isPathContained('C:\\Media\\PDD', 'c:\\media\\pdd-other\\0000089')).toBe(false);
    expect(isPathContained('C:\\Media\\PDD', 'c:\\media\\pdd')).toBe(false);
    expect(isPathContained('C:\\Media\\PDD', 'c:\\media\\pdd', { allowEqual: true })).toBe(true);
  });

  it('keeps POSIX containment case-sensitive', () => {
    expect(isPathContained('/Users/kyle/media', '/Users/kyle/media/0000089')).toBe(true);
    expect(isPathContained('/Users/kyle/media', '/Users/kyle/media-other/0000089')).toBe(false);
    expect(isPathContained('/Users/kyle/media', '/Users/Kyle/media/0000089')).toBe(false);
  });

  it('requires canonical containment and detects a junction or symlink escape', async () => {
    const fixture = await createSafeFixture('.download-containment-');
    const root = path.join(fixture, 'root');
    const outside = path.join(fixture, 'outside');
    await Promise.all([mkdir(root), mkdir(outside)]);
    const alias = path.join(root, 'escaped');
    await symlink(outside, alias, process.platform === 'win32' ? 'junction' : 'dir');
    const candidate = path.join(alias, 'future-product');

    expect(isPathContained(root, candidate)).toBe(true);
    await expect(isRealPathContained(root, candidate, { allowMissing: true })).resolves.toBe(false);
    await expect(isPathSafelyContained(root, candidate, { allowMissing: true })).resolves.toBe(false);
  });

  it('allows an existing canonical child but not an equal path by default', async () => {
    const fixture = await createSafeFixture('.download-contained-');
    const child = path.join(fixture, 'product');
    await mkdir(child);

    await expect(isPathSafelyContained(fixture, child)).resolves.toBe(true);
    await expect(isPathSafelyContained(fixture, fixture)).resolves.toBe(false);
    await expect(isPathSafelyContained(fixture, fixture, { allowEqual: true })).resolves.toBe(true);
    const inspected = await inspectAbsoluteDownloadPath(child);
    expect(inspected).toMatchObject({ exists: true, realPath: path.normalize(child) });
  });
});

async function createSafeFixture(prefix: string): Promise<string> {
  for (const parent of [process.cwd(), os.homedir()]) {
    if (isSystemTempPath(parent)) continue;
    try {
      const fixture = await mkdtemp(path.join(parent, prefix));
      cleanupPaths.push(fixture);
      return fixture;
    } catch {
      // Try the next non-temporary, user-writable fixture parent.
    }
  }
  throw new Error('No writable fixture parent outside the system temporary directory');
}

function isSystemTempPath(value: string): boolean {
  const relative = path.relative(path.resolve(os.tmpdir()), path.resolve(value));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}
