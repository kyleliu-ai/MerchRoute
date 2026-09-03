import { spawn } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const integrationRoot = path.join(projectRoot, 'integrations', 'jimeng-free-api-all');
const testsRoot = path.join(integrationRoot, 'tests');
const npmCli = process.env.npm_execpath;
const nodeExecutable = process.env.npm_node_execpath || process.execPath;
if (!npmCli) throw new Error('请通过 npm run jimeng:test 执行，以保持固定 npm 版本');

function run(args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(nodeExecutable, args, {
      cwd: projectRoot,
      env: { ...process.env, npm_config_engine_strict: 'false' },
      stdio: 'inherit',
      windowsHide: true,
      ...options,
    });
    child.on('error', reject);
    child.on('close', (code) => code === 0 ? resolve() : reject(new Error(`Jimeng 测试命令失败：${code}`)));
  });
}

await run([npmCli, 'ci', '--prefix', integrationRoot, '--engine-strict=false', '--no-audit', '--no-fund']);
const names = await readdir(testsRoot);
const tsTests = names.filter((name) => name.endsWith('.test.ts')).sort().map((name) => path.join(testsRoot, name));
const cjsTests = names.filter((name) => name.endsWith('.test.cjs')).sort().map((name) => path.join(testsRoot, name));
// Serial files retain process isolation and every test while avoiding the
// pinned Node reporter IPC failure seen during parallel route-test logging.
await run([path.join(integrationRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs'), '--test', '--test-concurrency=1', '--test-reporter=dot', ...tsTests]);
await run(['--test', '--test-reporter=dot', ...cjsTests]);
