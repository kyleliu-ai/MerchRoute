import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, rm, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import {
  classifyContentPath,
  collectGithubTreeSnapshot,
  collectLocalContentSnapshot,
  countContentDifferences,
  readFingerprintScopeContract,
  type FingerprintScopeContract
} from './content-fingerprint.js';

const execFileAsync = promisify(execFile);
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('content fingerprint scope', () => {
  it('defaults new source paths to runtime while separating docs, tests and ignored secrets', async () => {
    const contract = await projectContract();
    expect(classifyContentPath('apps/server/src/new-feature.ts', contract)).toBe('runtime');
    expect(classifyContentPath('deployment/n8n/workflows/core/example.json', contract)).toBe('runtime');
    expect(classifyContentPath('integrations/jimeng-free-api-all/src/index.ts', contract)).toBe('runtime');
    expect(classifyContentPath('package-lock.json', contract)).toBe('runtime');
    expect(classifyContentPath('deployment/database/migrations/001-init.sql', contract)).toBe('runtime');
    expect(classifyContentPath('README.md', contract)).toBe('documentation');
    expect(classifyContentPath('docs/assets/ui/about.webp', contract)).toBe('documentation');
    expect(classifyContentPath('apps/server/src/example.test.ts', contract)).toBe('verification');
    expect(classifyContentPath('.github/workflows/check.yml', contract)).toBe('verification');
    expect(classifyContentPath('.env.runtime', contract)).toBe('excluded');
    expect(classifyContentPath('.env.example', contract)).toBe('runtime');
    expect(classifyContentPath('deployment/private/cookies.json', contract)).toBe('excluded');
    expect(classifyContentPath('integrations/jimeng-free-api-all/data/cookies.json', contract)).toBe('excluded');
    expect(classifyContentPath('backups/production.dump', contract)).toBe('excluded');
    expect(classifyContentPath('config/content-fingerprint-scope.json', contract)).toBe('excluded');
  });

  it('includes uncommitted additions and deletions and preserves cross-platform blob normalization', async () => {
    const root = await createRepository();
    const contract = await projectContract();
    await mkdir(path.join(root, 'apps'), { recursive: true });
    await writeFile(path.join(root, '.gitattributes'), '* text=auto eol=lf\n', 'utf8');
    await writeFile(path.join(root, 'apps', 'deleted.ts'), 'export const removed = true;\n', 'utf8');
    await writeFile(path.join(root, 'apps', 'stable.ts'), 'export const stable = true;\n', 'utf8');
    await git(root, ['add', '.gitattributes', 'apps/deleted.ts', 'apps/stable.ts']);
    await unlink(path.join(root, 'apps', 'deleted.ts'));
    await writeFile(path.join(root, 'apps', 'café.ts'), 'export const line = 1;\r\n', 'utf8');
    await writeFile(path.join(root, '.env'), 'SECRET=must-not-be-read\n', 'utf8');

    const local = await collectLocalContentSnapshot(root, contract);
    expect(local.scopes.runtime.files.has('apps/deleted.ts')).toBe(false);
    expect(local.scopes.runtime.files.has('apps/café.ts')).toBe(true);
    expect([...local.scopes.runtime.files.keys()]).not.toContain('.env');

    const normalizedPath = 'apps/cafe\u0301.ts'.normalize('NFD');
    const localHash = local.scopes.runtime.files.get('apps/café.ts');
    const remote = collectGithubTreeSnapshot([
      { path: '.gitattributes', type: 'blob', sha: local.scopes.runtime.files.get('.gitattributes') },
      { path: 'apps/stable.ts', type: 'blob', sha: local.scopes.runtime.files.get('apps/stable.ts') },
      { path: normalizedPath, type: 'blob', sha: localHash }
    ], contract);
    expect(countContentDifferences(local.scopes.runtime.files, remote.scopes.runtime.files)).toBe(0);
  }, 30_000);
});

async function projectContract(): Promise<FingerprintScopeContract> {
  return await readFingerprintScopeContract(path.resolve(import.meta.dirname, '../../../..'));
}

async function createRepository(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'merchroute-fingerprint-'));
  roots.push(root);
  await git(root, ['init', '--quiet']);
  return root;
}

async function git(root: string, args: string[]): Promise<void> {
  await execFileAsync('git', ['-C', root, ...args], { windowsHide: true });
}
