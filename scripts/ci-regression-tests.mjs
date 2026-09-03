import { spawn } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { resolveCommand } from './run-ci-check.mjs';

const suite = process.argv[2] === '--suite' ? process.argv[3] : undefined;
if ((process.env.GITHUB_ACTIONS !== 'true' && process.env.MERCHROUTE_LOCAL_REGRESSION !== '1') || !['jimeng', 'n8n-runtime'].includes(suite)) throw new Error('Fixed CI or explicitly requested local regression suite required');
async function run(argv) {
  const resolved = await resolveCommand(argv);
  await new Promise((resolve, reject) => {
    const child = spawn(resolved.command, resolved.args, { cwd: process.cwd(), env: process.env, stdio: 'inherit', windowsHide: true, shell: false });
    child.on('error', reject);
    child.on('close', (code) => code === 0 ? resolve() : reject(new Error('CI regression command failed')));
  });
}

// Keep the public npm regression command, including its pinned installation.
// Its dot reporter cannot prove counts, so rerun the same real tests with TAP.
await run(['npm', 'run', suite === 'jimeng' ? 'jimeng:test' : 'n8n-runtime:test']);
if (suite === 'jimeng') {
  const base = 'integrations/jimeng-free-api-all';
  const names = await readdir(path.join(base, 'tests'));
  const ts = names.filter((name) => name.endsWith('.test.ts')).sort().map((name) => path.join(base, 'tests', name));
  const cjs = names.filter((name) => name.endsWith('.test.cjs')).sort().map((name) => path.join(base, 'tests', name));
  if (!ts.length || !cjs.length) throw new Error('Jimeng test inventory unexpectedly empty');
  // Keep each test file isolated, but serialize files to avoid the pinned Node
  // reporter IPC failure reproduced under parallel multilingual route logging.
  await run(['node', path.join(base, 'node_modules/tsx/dist/cli.mjs'), '--test', '--test-concurrency=1', '--test-reporter=tap', ...ts]);
  await run(['node', '--test', '--test-reporter=tap', ...cjs]);
} else {
  const files = ['1688-detail-image-stitcher.test.cjs', '1688-downloader.test.cjs', '1688-output-dir-version.test.cjs', 'download-idempotency-v1.test.cjs', 'pdd-detail-image-stitcher-result-file.test.cjs', 'pdd-output-dir-version.test.cjs', 'pdd-product-media-downloader.test.cjs', 'playwright-navigation-retry.test.cjs'];
  await run(['node', '--test', '--test-reporter=tap', ...files.map((name) => path.join('deployment/n8n/runtime-scripts/tests', name))]);
}
