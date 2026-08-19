import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const runtimeRoot = path.join(projectRoot, 'deployment', 'n8n', 'runtime-scripts');
const npmCli = process.env.npm_execpath;
const nodeExecutable = process.env.npm_node_execpath || process.execPath;
if (!npmCli) throw new Error('请通过 npm run n8n-runtime:test 执行，以保持固定 npm 版本');

function run(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(nodeExecutable, args, {
      cwd: projectRoot,
      env: process.env,
      stdio: 'inherit',
      windowsHide: true,
    });
    child.on('error', reject);
    child.on('close', (code) => code === 0 ? resolve() : reject(new Error(`n8n 运行脚本测试命令失败：${code}`)));
  });
}

await run([npmCli, 'ci', '--prefix', runtimeRoot, '--no-audit', '--no-fund']);
await run(['--test', '--test-reporter=dot', ...[
  '1688-detail-image-stitcher.test.cjs',
  '1688-downloader.test.cjs',
  '1688-output-dir-version.test.cjs',
  'download-idempotency-v1.test.cjs',
  'pdd-detail-image-stitcher-result-file.test.cjs',
  'pdd-output-dir-version.test.cjs',
  'pdd-product-media-downloader.test.cjs',
  'playwright-navigation-retry.test.cjs',
].map((name) => path.join(runtimeRoot, 'tests', name))]);
