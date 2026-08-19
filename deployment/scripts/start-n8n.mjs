import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const defaultHome = process.platform === 'win32'
  ? path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'MerchRoute')
  : path.join(os.homedir(), 'Library', 'Application Support', 'MerchRoute');
const appHome = path.resolve(process.env.MERCHROUTE_APP_HOME || defaultHome);
const envPath = process.env.MERCHROUTE_N8N_ENV_FILE || path.join(appHome, 'secrets', 'n8n.env');
const content = await readFile(envPath, 'utf8');
const env = { ...process.env };
for (const rawLine of content.split(/\r?\n/)) {
  const line = rawLine.trim();
  if (!line || line.startsWith('#')) continue;
  const index = line.indexOf('=');
  if (index > 0) env[line.slice(0, index)] = line.slice(index + 1);
}
const command = process.env.N8N_COMMAND || (process.platform === 'win32' ? path.join(process.env.APPDATA || '', 'npm', 'n8n.cmd') : 'n8n');
const child = spawn(command, ['start'], { env, stdio: 'inherit', windowsHide: true });
child.on('error', (error) => { console.error(`n8n 启动失败：${error.message}`); process.exitCode = 1; });
child.on('close', (code) => { process.exitCode = code ?? 1; });
