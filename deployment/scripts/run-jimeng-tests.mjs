import { spawn } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const integrationRoot = path.join(projectRoot, 'integrations', 'jimeng-free-api-all');
const versions = JSON.parse(await readFile(path.join(projectRoot, 'deployment/runtime-versions.json'), 'utf8')).jimeng;
const pkg = JSON.parse(await readFile(path.join(integrationRoot, 'package.json'), 'utf8'));
if (versions.node !== pkg.engines.node || versions.npm !== pkg.engines.npm) {
  throw new Error('Jimeng runtime manifest and package engines disagree');
}
const names = await readdir(path.join(integrationRoot, 'tests'));
if (!names.some((name) => name.endsWith('.test.ts')) || !names.some((name) => name.endsWith('.test.cjs'))) {
  throw new Error('Jimeng test inventory unexpectedly empty');
}

function docker(args) {
  return new Promise((resolve, reject) => {
    const child = spawn('docker', args, {
      cwd: integrationRoot, stdio: 'inherit', windowsHide: true, shell: false,
      env: { ...process.env, DOCKER_BUILDKIT: '1' },
    });
    child.on('error', reject);
    child.on('close', (code, signal) => code === 0 ? resolve() : reject(new Error(`Jimeng Docker tests failed: ${code ?? signal}`)));
  });
}

// The test stage is a required ancestor of the runtime build. Use its immutable
// ID, never a shared mutable test tag or a host Node fallback.
const testHome = await mkdtemp(path.join(os.tmpdir(), 'merchroute-jimeng-node20-'));
try {
  const idFile = path.join(testHome, 'image-id');
  await docker(['build', '--target', 'test', '--build-arg', `NODE_IMAGE=node:${versions.node}-bookworm`, '--iidfile', idFile, '.']);
  const imageId = (await readFile(idFile, 'utf8')).trim();
  if (!/^sha256:[a-f0-9]{64}$/.test(imageId)) throw new Error('Invalid test image identity');
  console.log(JSON.stringify({ jimengTestRuntime: { node: versions.node, npm: versions.npm, imageId, network: 'none', productionVolumes: false } }));
  // Run even on a build-cache hit: CI consumes raw TAP, not BuildKit prefixes.
  await docker(['run', '--rm', '--network', 'none', '--entrypoint', 'npm', imageId, 'test']);
} finally {
  // Only this invocation's mkdtemp directory, never user/runtime data.
  await rm(testHome, { recursive: true, force: true });
}
