import { execFileSync } from 'node:child_process';
import { statfs } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { canListen } from './preflight-lib.mjs';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const dryRun = process.argv.includes('--dry-run');
const checks = [];

function commandVersion(command, args = ['--version']) {
  try {
    const value = execFileSync(command, args, { encoding: 'utf8', windowsHide: true }).trim().split(/\r?\n/)[0];
    return { ok: true, value };
  } catch { return { ok: false }; }
}

async function knownService(url, expectedText = '') {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(2_000) });
    const text = await response.text();
    return response.ok && (!expectedText || text.includes(expectedText));
  } catch { return false; }
}

function knownPostgresContainer() {
  try {
    const output = execFileSync('docker', ['ps', '--filter', 'label=com.docker.compose.project=merchroute-postgres', '--format', '{{.ID}}'], { encoding: 'utf8', windowsHide: true });
    return Boolean(output.trim());
  } catch { return false; }
}

const supportedPlatform = process.platform === 'win32' || (process.platform === 'darwin' && process.arch === 'arm64');
checks.push({ name: 'supported-platform', ok: supportedPlatform, value: `${process.platform}-${process.arch}` });

const filesystem = await statfs(projectRoot);
const freeBytes = Number(filesystem.bavail) * Number(filesystem.bsize);
checks.push({ name: 'free-disk-at-least-10-gib', ok: freeBytes >= 10 * 1024 ** 3, freeGiB: Math.floor(freeBytes / 1024 ** 3) });

for (const [name, command, args] of [
  ['git', 'git', ['--version']],
  ['node', 'node', ['--version']],
  ['npm', process.platform === 'win32' ? 'npm.cmd' : 'npm', ['--version']],
  ['docker', 'docker', ['--version']],
]) {
  const result = commandVersion(command, args);
  checks.push({ name: `${name}-available`, ...result });
}

for (const service of [
  { name: 'postgres', port: 5432 },
  { name: 'merchroute', port: 4173, url: 'http://127.0.0.1:4173/api/v1/health', expected: 'ok' },
  { name: 'n8n', port: 5678, url: 'http://127.0.0.1:5678/healthz', expected: 'ok' },
  { name: 'jimeng', port: 8000, url: 'http://127.0.0.1:8000/ping', expected: 'pong' },
]) {
  const free = await canListen(service.port);
  const recognized = !free && (service.url ? await knownService(service.url, service.expected) : knownPostgresContainer());
  checks.push({ name: `${service.name}-port-${service.port}`, ok: free || recognized, state: free ? 'free' : recognized ? 'known-service' : 'occupied' });
}

const failed = checks.filter((item) => !item.ok);
console.log(JSON.stringify({ dryRun, checks }, null, 2));
if (failed.length) process.exitCode = 1;
