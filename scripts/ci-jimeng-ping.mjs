import { execFileSync } from 'node:child_process';
import { setTimeout } from 'node:timers/promises';

if (process.env.GITHUB_ACTIONS !== 'true') throw new Error('This container-only check is for GitHub Actions');
const image = 'merchroute/jimeng-free-api-all:0.9.1-e002-20260813';
const container = execFileSync('docker', ['run', '--detach', '--rm', '--publish', '127.0.0.1:8000:8000', '--tmpfs', '/app/data:rw', image], { encoding: 'utf8', windowsHide: true }).trim();
if (!/^[a-f0-9]{64}$/.test(container)) throw new Error('Invalid owned test container identity');
let passed = false;
try {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      const response = await fetch('http://127.0.0.1:8000/ping', { signal: AbortSignal.timeout(1500) });
      if (response.ok && (await response.text()).replaceAll('"', '').trim() === 'pong') { passed = true; break; }
    } catch { /* Retry only the owned loopback test container. */ }
    await setTimeout(1000);
  }
} finally { execFileSync('docker', ['stop', container], { stdio: 'pipe', windowsHide: true }); }
console.log(JSON.stringify({ ok: passed, assertionsPassed: passed ? 1 : 0, assertionsFailed: passed ? 0 : 1, realCredentialsUsed: false }));
if (!passed) process.exitCode = 1;
