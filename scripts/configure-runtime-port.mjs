import { constants } from 'node:fs';
import { copyFile, mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createRuntimeEndpoint, preflightRuntimeEndpoint } from './lib/runtime-endpoint.mjs';
import { assertPortFree } from './workflow/development.mjs';
import { isWithin } from './lib/installed-release.mjs';

export function updateEnvContent(content, values) {
  const newline = content.includes('\r\n') ? '\r\n' : '\n';
  const trailing = content.endsWith('\n');
  const lines = content.split(/\r?\n/);
  if (trailing) lines.pop();
  for (const [key, value] of Object.entries(values)) {
    const matches = lines.map((line, index) => line.startsWith(`${key}=`) ? index : -1).filter((index) => index >= 0);
    if (matches.length > 1) throw new Error(`${key} 在环境文件中重复`);
    if (matches.length) lines[matches[0]] = `${key}=${value}`;
    else lines.push(`${key}=${value}`);
  }
  return `${lines.join(newline)}${newline}`;
}

export function updateN8nContent(content, origin, filename) {
  if (/\.bat$/i.test(filename)) {
    // Keep the BAT file's original CRLF/LF layout. `\s` would also consume
    // line breaks and can silently turn CRLF into mixed line endings.
    const pattern = /^[ \t]*set[ \t]+"MERCHROUTE_RUNTIME_BASE_URL=[^"]*"[ \t]*$/gim;
    const matches = content.match(pattern) || [];
    if (matches.length !== 1) throw new Error('n8n BAT 必须且只能包含一条 MERCHROUTE_RUNTIME_BASE_URL');
    return content.replace(pattern, `set "MERCHROUTE_RUNTIME_BASE_URL=${origin}"`);
  }
  return updateEnvContent(content, { MERCHROUTE_RUNTIME_BASE_URL: origin });
}

async function atomicText(file, content) {
  const temp = `${file}.${randomUUID()}.tmp`;
  const handle = await open(temp, 'wx', 0o600);
  try { await handle.writeFile(content, 'utf8'); await handle.sync(); } finally { await handle.close(); }
  try { await rename(temp, file); } catch (error) { await rm(temp, { force: true }); throw error; }
}

async function main() {
  const options = new Map(process.argv.slice(2).map((argument) => {
    const [key, ...value] = argument.replace(/^--/, '').split('=');
    return [key, value.length ? value.join('=') : 'true'];
  }));
  const endpoint = createRuntimeEndpoint(options.get('port') || 43173);
  const merchrouteEnv = String(options.get('merchroute-env') || '');
  const n8nConfig = String(options.get('n8n-config') || '');
  const backupRoot = String(options.get('backup-root') || '');
  const apply = options.get('apply') === 'true';
  for (const [label, file] of [['merchroute-env', merchrouteEnv], ['n8n-config', n8nConfig]]) if (!path.isAbsolute(file)) throw new Error(`--${label} 必须是仓库外绝对路径`);
  const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  if ([merchrouteEnv, n8nConfig].some((file) => isWithin(projectRoot, file))) throw new Error('运行配置禁止位于 Git 仓库');
  const [merchrouteBefore, n8nBefore] = await Promise.all([readFile(merchrouteEnv, 'utf8'), readFile(n8nConfig, 'utf8')]);
  const merchrouteAfter = updateEnvContent(merchrouteBefore, {
    HOST: endpoint.host, PORT: String(endpoint.port), MERCHROUTE_PORT: String(endpoint.port), MERCHROUTE_RUNTIME_BASE_URL: endpoint.origin
  });
  const n8nAfter = updateN8nContent(n8nBefore, endpoint.origin, n8nConfig);
  const result = { endpoint, merchrouteChanged: merchrouteAfter !== merchrouteBefore, n8nChanged: n8nAfter !== n8nBefore, applied: false };
  if (!apply) return result;
  if (!path.isAbsolute(backupRoot) || isWithin(projectRoot, backupRoot)) throw new Error('--apply 必须提供仓库外绝对 --backup-root');
  await preflightRuntimeEndpoint(endpoint);
  await assertPortFree(5678).catch(() => { throw new Error('n8n 5678 仍在监听；必须正常停止 n8n 后再写入端口配置'); });
  await mkdir(backupRoot, { recursive: true, mode: 0o700 });
  const merchrouteBackup = path.join(backupRoot, 'merchroute.env.before');
  const n8nBackup = path.join(backupRoot, `${path.basename(n8nConfig)}.before`);
  await copyFile(merchrouteEnv, merchrouteBackup, constants.COPYFILE_EXCL);
  await copyFile(n8nConfig, n8nBackup, constants.COPYFILE_EXCL);
  try {
    await atomicText(merchrouteEnv, merchrouteAfter);
    await atomicText(n8nConfig, n8nAfter);
  } catch (error) {
    await atomicText(merchrouteEnv, merchrouteBefore);
    await atomicText(n8nConfig, n8nBefore);
    throw error;
  }
  return { ...result, applied: true, backupRoot };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { console.log(JSON.stringify(await main(), null, 2)); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
