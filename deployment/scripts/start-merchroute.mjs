import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const defaultHome = process.platform === 'win32'
  ? path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'MerchRoute')
  : path.join(os.homedir(), 'Library', 'Application Support', 'MerchRoute');
const appHome = path.resolve(process.env.MERCHROUTE_APP_HOME || defaultHome);
const envPath = process.env.MERCHROUTE_ENV_FILE || path.join(appHome, 'secrets', 'merchroute.env');
const content = await readFile(envPath, 'utf8');
const env = { ...process.env, MERCHROUTE_ENV_FILE: envPath };
for (const rawLine of content.split(/\r?\n/)) {
  const line = rawLine.trim();
  if (!line || line.startsWith('#')) continue;
  const index = line.indexOf('=');
  if (index > 0 && env[line.slice(0, index)] === undefined) env[line.slice(0, index)] = line.slice(index + 1);
}
const child = spawn(process.execPath, [path.join(projectRoot, 'apps', 'server', 'dist', 'index.js')], {
  cwd: projectRoot,
  env,
  stdio: 'inherit',
  windowsHide: true,
});
child.on('error', (error) => { console.error(`MerchRoute 启动失败：${error.message}`); process.exitCode = 1; });
child.on('close', (code) => { process.exitCode = code ?? 1; });
