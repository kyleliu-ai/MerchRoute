import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { withTestPostgres, testEnvironment } from './workflow/verify.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = process.argv.find(arg => arg.startsWith('--output='))?.slice(9);
if (!output || !path.isAbsolute(output) || path.resolve(output).startsWith(root + path.sep)) throw new Error('--output must be an absolute evidence directory outside the repository');
await mkdir(output, { recursive: true });
const full = process.argv.includes('--full');
await withTestPostgres(async (database, cleanup) => {
  const env = testEnvironment(process.env, database, cleanup);
  const pathKey = Object.keys(env).find(key => key.toUpperCase() === 'PATH');
  const inheritedPath = pathKey ? env[pathKey] : '';
  if (pathKey) delete env[pathKey];
  env.PATH = path.dirname(process.execPath) + path.delimiter + inheritedPath;
  env.PLAYWRIGHT_JSON_OUTPUT_FILE = path.join(output, 'playwright.json');
  const commands = full ? [
    ['check', [path.join(path.dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js'), 'run', 'check']],
    ['browser-build', [path.join(path.dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js'), 'run', 'build']],
    ['e2e', [path.join(root, 'node_modules/@playwright/test/cli.js'), 'test', '--reporter=list,json']]
  ] : [
    ['typecheck', [path.join(root, 'node_modules/typescript/bin/tsc'), '-b', '--pretty', 'false']],
    ['wb-retry', [path.join(root, 'node_modules/vitest/vitest.mjs'), 'run',
      'apps/server/src/services/wb-auto-publish/retry.test.ts',
      'apps/server/src/repositories/wb-auto-retry.integration.test.ts',
      'apps/server/src/services/wb-auto-publish/index.test.ts',
      'apps/server/src/repositories/wb-stores.test.ts']],
    ['workflow', ['--test', 'deployment/scripts/wb-publish-retry.test.mjs']]
  ];
  for (const [name, args] of commands) {
    console.log('Starting isolated ' + name);
    const log = createWriteStream(path.join(output, name + '.log'));
    const result = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, args, { cwd: root, env: name === 'browser-build' ? { ...env, NODE_ENV: 'production' } : env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      const chunks = [];
      const record = chunk => { chunks.push(chunk); log.write(chunk); };
      child.stdout.on('data', record); child.stderr.on('data', record);
      child.on('error', cause => { log.end(); reject(cause); });
      child.on('close', code => log.end(() => resolve({ code, output: Buffer.concat(chunks) })));
    });
    await writeFile(path.join(output, name + '.log'), result.output);
    console.log(name + ' exit=' + result.code + ', evidence=' + path.join(output, name + '.log'));
    if (result.code !== 0) { console.log(result.output.toString().slice(-12000)); throw new Error(name + ' failed'); }
  }
});
