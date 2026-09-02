import os from 'node:os';
import path from 'node:path';
import { mkdtemp, mkdir, rm, symlink } from 'node:fs/promises';
import { afterEach, describe, expect, it } from 'vitest';
import { LegacyRootCompatibility } from './legacy-root-compatibility.js';

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('LegacyRootCompatibility', () => {
  it('maps only an exact Windows root or its descendants', () => {
    const compatibility = new LegacyRootCompatibility({
      legacyRoot: 'G:\\01_n8n-global',
      canonicalRoot: 'G:\\01_MerchRoute'
    });

    expect(compatibility.canonicalizePath('G:\\01_n8n-global')).toBe('G:\\01_MerchRoute');
    expect(compatibility.canonicalizePath('g:\\01_N8N-GLOBAL\\03_MediaDownload\\中文')).toBe('G:\\01_MerchRoute\\03_MediaDownload\\中文');
    expect(compatibility.canonicalizePath('G:/01_n8n-global/OZON-Auto-Publish/inbox')).toBe('G:/01_MerchRoute/OZON-Auto-Publish/inbox');
    expect(compatibility.canonicalizePath('G:\\01_n8n-global-copy\\file.jpg')).toBe('G:\\01_n8n-global-copy\\file.jpg');
    expect(compatibility.canonicalizePath('历史路径 G:\\01_n8n-global\\file.jpg')).toBe('历史路径 G:\\01_n8n-global\\file.jpg');
    expect(compatibility.canonicalizePath(' G:\\01_n8n-global\\file.jpg ')).toBe(' G:\\01_n8n-global\\file.jpg ');
    expect(compatibility.canonicalizePath('https://example.test/G:/01_n8n-global/file.jpg')).toBe('https://example.test/G:/01_n8n-global/file.jpg');
    expect(compatibility.canonicalizePath('G:\\01_n8n-global\\..\\outside')).toBe('G:\\01_n8n-global\\..\\outside');
    expect(() => compatibility.canonicalizePath('G:\\01_n8n-global\0file.jpg')).toThrow(/NUL/);
    expect(compatibility.lookupCandidates('G:\\01_MerchRoute\\03_MediaDownload\\SKU')).toEqual([
      'G:\\01_MerchRoute\\03_MediaDownload\\SKU',
      'G:\\01_n8n-global\\03_MediaDownload\\SKU'
    ]);
  });

  it('maps JSON string values and keys without mutating the historical input', () => {
    const compatibility = new LegacyRootCompatibility({
      legacyRoot: 'G:\\01_n8n-global',
      canonicalRoot: 'G:\\01_MerchRoute'
    });
    const input = {
      sourceFolder: 'G:\\01_n8n-global\\02_generateFolder\\E004',
      nested: {
        'G:/01_n8n-global/key': ['G:/01_n8n-global/value', 'unchanged']
      }
    };

    const result = compatibility.canonicalizeJsonWithStats(input);
    expect(result).toEqual({
      value: {
        sourceFolder: 'G:\\01_MerchRoute\\02_generateFolder\\E004',
        nested: {
          'G:/01_MerchRoute/key': ['G:/01_MerchRoute/value', 'unchanged']
        }
      },
      changedStrings: 2,
      changedKeys: 1
    });
    expect(input.sourceFolder).toBe('G:\\01_n8n-global\\02_generateFolder\\E004');
  });

  it('fails instead of overwriting when mapped object keys collide', () => {
    const compatibility = new LegacyRootCompatibility({
      legacyRoot: 'G:\\01_n8n-global',
      canonicalRoot: 'G:\\01_MerchRoute'
    });
    expect(() => compatibility.canonicalizeJson({
      'G:\\01_n8n-global\\same': 'legacy',
      'g:\\01_merchroute\\SAME': 'canonical'
    })).toThrow(/重复对象键/);
  });

  it('preserves distinct case-sensitive keys when neither key is remapped', () => {
    const compatibility = new LegacyRootCompatibility({
      legacyRoot: 'G:\\01_n8n-global',
      canonicalRoot: 'G:\\01_MerchRoute'
    });
    expect(compatibility.canonicalizeJson({ Foo: 1, foo: 2 })).toEqual({ Foo: 1, foo: 2 });
  });

  it('reports ready before and after the legacy Junction is removed', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'merchroute-legacy-root-'));
    temporaryRoots.push(root);
    const canonicalRoot = path.join(root, 'canonical');
    const legacyRoot = path.join(root, 'legacy');
    await mkdir(canonicalRoot);
    await symlink(canonicalRoot, legacyRoot, process.platform === 'win32' ? 'junction' : 'dir');
    const compatibility = new LegacyRootCompatibility({ legacyRoot, canonicalRoot });

    await expect(compatibility.readiness()).resolves.toMatchObject({
      enabled: true,
      status: 'READY',
      legacyPathPresent: true,
      canonicalRootReady: true,
      mappingSelfTest: true,
      legacyPathTargetsCanonicalRoot: true,
      issues: []
    });

    await rm(legacyRoot);
    await expect(compatibility.readiness()).resolves.toMatchObject({
      enabled: true,
      status: 'READY',
      legacyPathPresent: false,
      canonicalRootReady: true,
      mappingSelfTest: true,
      issues: []
    });
  });

  it('blocks a configured compatibility layer when the canonical root is unsafe', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'merchroute-legacy-root-blocked-'));
    temporaryRoots.push(root);
    const compatibility = new LegacyRootCompatibility({
      legacyRoot: path.join(root, 'legacy'),
      canonicalRoot: path.join(root, 'missing')
    });
    await expect(compatibility.readiness()).resolves.toMatchObject({ status: 'BLOCKED', canonicalRootReady: false });
    await expect(compatibility.assertReadyForRetirement()).rejects.toMatchObject({ code: 'LEGACY_ROOT_COMPATIBILITY_BLOCKED' });
  });

  it('reports a broken legacy link as BLOCKED instead of throwing a raw filesystem error', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'merchroute-legacy-root-broken-'));
    temporaryRoots.push(root);
    const canonicalRoot = path.join(root, 'canonical');
    const legacyRoot = path.join(root, 'legacy');
    await mkdir(canonicalRoot);
    const missingTarget = path.join(root, 'missing-target');
    await symlink(missingTarget, legacyRoot, process.platform === 'win32' ? 'junction' : 'dir');
    const compatibility = new LegacyRootCompatibility({ legacyRoot, canonicalRoot });

    await expect(compatibility.readiness()).resolves.toMatchObject({
      status: 'BLOCKED',
      legacyPathPresent: true,
      legacyPathTargetsCanonicalRoot: false,
      issues: [expect.stringContaining('无法解析目标')]
    });
    await expect(compatibility.assertOperational()).rejects.toMatchObject({ code: 'LEGACY_ROOT_COMPATIBILITY_BLOCKED' });
  });
});
