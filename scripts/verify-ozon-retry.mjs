import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { testEnvironment, withTestPostgres } from './workflow/verify.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = process.argv.find(arg => arg.startsWith('--output='))?.slice(9);
if (!output || !path.isAbsolute(output) || path.resolve(output).startsWith(root + path.sep)) throw new Error('Evidence directory must be outside repository');
await mkdir(output, { recursive: true });
const mode = process.argv.find(arg => arg.startsWith('--mode='))?.slice(7) || 'targeted';
async function check(database, cleanup) {
  const env = testEnvironment(process.env, database, cleanup);
  const pathKey = Object.keys(env).find(key => key.toUpperCase() === 'PATH');
  const previous = pathKey ? env[pathKey] : '';
  if (pathKey) delete env[pathKey];
  env.PATH = path.dirname(process.execPath) + path.delimiter + previous;
  env.PLAYWRIGHT_JSON_OUTPUT_FILE = path.join(output, 'playwright.json');
  env.MERCHROUTE_OZON_RETRY_UI_ONLY = '1';
  const tests = mode === 'browser' ? [
    ['browser-build', ['node_modules/vite/bin/vite.js', 'build'], path.join(root, 'apps/web')],
    ['browser', ['node_modules/@playwright/test/cli.js', 'test', '--config', 'playwright.ozon-retry.config.ts', '--reporter=list,json', '--output', path.join(output, 'browser-results')]]
  ] : [
    ['typecheck', ['node_modules/typescript/bin/tsc', '-b', '--pretty', 'false']],
    ['lint', ['node_modules/eslint/bin/eslint.js', 'apps/server/src/repositories/ozon-retry.ts', 'apps/server/src/repositories/ozon-stores.ts', 'apps/server/src/services/ozon-publishing/retry.ts', 'apps/server/src/services/ozon-stores/index.ts', 'apps/server/src/routes/ozon.ts', 'apps/web/src/ozon-retry.tsx', 'apps/web/src/ozon-listing.tsx', 'packages/shared/src/ozon-retry.ts']],
    ['ozon-retry', ['node_modules/vitest/vitest.mjs', 'run', 'apps/server/src/services/ozon-publishing/retry.test.ts', 'apps/server/src/repositories/ozon-retry.integration.test.ts', 'apps/server/src/routes/ozon-retry.test.ts']],
    ['ozon-regression', ['node_modules/vitest/vitest.mjs', 'run', 'apps/server/src/services/ozon-stores', 'apps/server/src/repositories/ozon-stores.test.ts', 'apps/server/src/services/ozon-publishing/auto-publishing.test.ts', 'apps/server/src/routes/ozon.test.ts', 'apps/web/src/ozon-listing.test.ts']],
    ['ozon-existing-integration', ['node_modules/vitest/vitest.mjs', 'run', 'apps/server/src/repositories/ozon-multistore-migration.integration.test.ts', 'apps/server/src/repositories/ozon-preparation-manual-takeover.integration.test.ts', 'apps/server/src/repositories/ozon-preparation-media-rescan-rebind.integration.test.ts', 'apps/server/src/routes/ozon-runtime.test.ts', 'apps/server/src/routes/ozon-stores.test.ts']],
    ['workflow-contract', ['--test', 'deployment/scripts/ozon-publish-retry.test.mjs']]
  ];
  for (const [name, args, cwd = root] of tests) {
    const argv = args.map((arg, index) => index === 0 && arg.startsWith('node_modules/') ? path.join(root, arg) : arg);
    console.log('Starting isolated ' + name);
    const result = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, argv, { cwd, env: name === 'browser-build' ? { ...env, NODE_ENV: 'production' } : env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      const chunks = [];
      child.stdout.on('data', chunk => chunks.push(chunk)); child.stderr.on('data', chunk => chunks.push(chunk));
      child.on('error', reject); child.on('close', code => resolve({ code, output: Buffer.concat(chunks) }));
    });
    await writeFile(path.join(output, name + '.log'), result.output);
    console.log(name + ' exit=' + result.code + ', evidence=' + path.join(output, name + '.log'));
    if (result.code !== 0) { console.log(result.output.toString().slice(-18000)); throw new Error(name + ' failed'); }
  }
}
await withTestPostgres(check);
