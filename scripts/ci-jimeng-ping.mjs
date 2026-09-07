import { execFileSync } from 'node:child_process';
import { setTimeout } from 'node:timers/promises';

if (process.env.GITHUB_ACTIONS !== 'true') throw new Error('This container-only check is for GitHub Actions');
const image = 'merchroute/jimeng-free-api-all:0.9.1-e002-20260813';
const container = execFileSync('docker', ['run', '--detach', '--rm', '--publish', '127.0.0.1:8000:8000', '--tmpfs', '/app/data:rw', image], { encoding: 'utf8', windowsHide: true }).trim();
if (!/^[a-f0-9]{64}$/.test(container)) throw new Error('Invalid owned test container identity');
let ready = false;
let assertionsPassed = 0;
let assertionsFailed = 0;

async function assertHealth(check) {
  try {
    if (await check()) assertionsPassed += 1;
    else assertionsFailed += 1;
  } catch {
    assertionsFailed += 1;
  }
}

try {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      const response = await fetch('http://127.0.0.1:8000/ping', { signal: AbortSignal.timeout(1500) });
      if (response.ok && (await response.text()).replaceAll('"', '').trim() === 'pong') { ready = true; break; }
    } catch { /* Retry only the owned loopback test container. */ }
    await setTimeout(1000);
  }

  await assertHealth(async () => ready);
  await assertHealth(async () => {
    const response = await fetch('http://127.0.0.1:8000/', { signal: AbortSignal.timeout(1500) });
    const contentType = response.headers.get('content-type') || '';
    const body = await response.text();
    return response.ok && contentType.includes('text/html') && body.includes('jimeng-free-api已启动');
  });
  await assertHealth(async () => {
    const response = await fetch('http://127.0.0.1:8000/v1/models', { signal: AbortSignal.timeout(1500) });
    const body = await response.json();
    return response.ok && Array.isArray(body?.data) && body.data.some((model) => model?.id === 'jimeng');
  });
} finally { execFileSync('docker', ['stop', container], { stdio: 'pipe', windowsHide: true }); }
const passed = assertionsPassed === 3 && assertionsFailed === 0;
console.log(JSON.stringify({ ok: passed, assertionsPassed, assertionsFailed, realCredentialsUsed: false }));
if (!passed) process.exitCode = 1;
