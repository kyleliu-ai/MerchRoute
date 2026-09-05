import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

test('OZON workflow policy tests run on a clean source fixture without shared dist', async () => {
  const root = fileURLToPath(new URL('../../', import.meta.url));
  const fixture = await mkdtemp(path.join(os.tmpdir(), 'merchroute-policy-clean-'));
  try {
    const tests = ['ozon-content-v4', 'ozon-title-readiness'].map(name => `deployment/scripts/${name}.test.mjs`);
    const files = ['package.json', 'packages/shared/package.json', 'packages/shared/src/ozon-content-policy.ts', ...tests,
      ...['ozon-content-v4', 'ozon-title-v4'].map(name => `deployment/n8n/patches/${name}.mjs`),
      ...['0FqozLuQ7vuabT8V', 'stSK51IuxrMZlLjx', 'g3KK68BLXX7eShqa', 'HDh0ZNLK2ps5qasR']
        .map(id => `deployment/n8n/workflows/ozon/${id}.json`)];
    for (const file of files) {
      const target = path.join(fixture, file);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, await readFile(path.join(root, file)), { flag: 'wx' });
    }
    await symlink(path.join(root, 'node_modules'), path.join(fixture, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
    assert.equal(existsSync(path.join(fixture, 'packages/shared/dist')), false);
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(?:NODE_OPTIONS|NODE_TEST_|DATABASE_URL|N8N_|WB_|OZON_|MERCHROUTE_)/i.test(key)));
    const result = spawnSync(process.execPath, ['--test', '--test-reporter=tap', ...tests], {
      cwd: fixture, env, encoding: 'utf8', windowsHide: true, timeout: 60_000, maxBuffer: 4 * 1024 * 1024
    });
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /# pass 10\b/);
    assert.match(result.stdout, /# fail 0\b/);
    assert.equal(existsSync(path.join(fixture, 'packages/shared/dist')), false);
  } finally {
    // Remove only this test's unique fixture; rm does not traverse the dependency link.
    await rm(fixture, { recursive: true, force: true });
  }
});
