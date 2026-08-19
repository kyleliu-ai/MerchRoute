import { copyFile, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import writeFileAtomic from 'write-file-atomic';

const runtimeName = 'MERCHROUTE_RUNTIME_KEY';
const credentialName = 'MERCHROUTE_CREDENTIAL_ENCRYPTION_KEY';
const projectRoot = path.resolve(import.meta.dirname, '..');
const sharedPath = absoluteArgument('--shared-file=');
const serverPath = absoluteArgument('--server-file=');
const preferServer = process.argv.includes('--prefer-server');

if (path.dirname(serverPath).toLowerCase() !== projectRoot.toLowerCase()
  || path.basename(serverPath).toLowerCase() !== '.env.runtime') {
  throw new Error('server runtime env 必须是项目根目录下的 .env.runtime');
}
if (sharedPath.toLowerCase() === serverPath.toLowerCase()) {
  throw new Error('shared/server runtime env 不能是同一文件');
}

const sharedInfo = await regularEnvFile(sharedPath, true);
const sharedContent = await readFile(sharedPath, 'utf8');
const existingServerInfo = await regularEnvFile(serverPath, false);
const serverContent = existingServerInfo ? await readFile(serverPath, 'utf8') : '';
const shared = parseEnv(sharedContent, sharedPath);
const server = parseEnv(serverContent, serverPath);
const runtimeKey = requiredValue(shared, runtimeName, sharedPath);
const sourceCredentialKey = shared.values.get(credentialName);
const targetCredentialKey = server.values.get(credentialName);
const credentialKey = preferServer && targetCredentialKey
  ? targetCredentialKey
  : sourceCredentialKey || targetCredentialKey;

if (!credentialKey) throw new Error(`${credentialName} 在 shared/server runtime env 中均不存在`);
assertCredentialKey(credentialKey);
if (sourceCredentialKey && targetCredentialKey && sourceCredentialKey !== targetCredentialKey && !preferServer) {
  throw new Error(`${credentialName} 在 shared/server runtime env 中不一致`);
}
const targetRuntimeKey = server.values.get(runtimeName);
if (targetRuntimeKey && targetRuntimeKey !== runtimeKey) {
  throw new Error(`${runtimeName} 在 shared/server runtime env 中不一致`);
}

if (!sourceCredentialKey) {
  if (!targetRuntimeKey) throw new Error(`${runtimeName} 尚未写入 server runtime env`);
  console.log(JSON.stringify({
    ok: true,
    changed: false,
    sharedPath,
    serverPath,
    sharedVariables: [...shared.values.keys()].sort(),
    serverVariables: [...server.values.keys()].sort()
  }, null, 2));
  process.exit(0);
}

const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
const sharedBackupPath = `${serverPath}.shared-pre-separation-${timestamp}.bak`;
const serverBackupPath = existingServerInfo ? `${serverPath}.pre-separation-${timestamp}.bak` : undefined;
// The shared backup deliberately lives beside the server-only env on F:, not
// under n8n's readable G: work root.
await copyFile(sharedPath, sharedBackupPath, 1);
if (serverBackupPath) await copyFile(serverPath, serverBackupPath, 1);

const serverLines = withoutVariables(server.lines, new Set([runtimeName, credentialName]));
serverLines.push(`${runtimeName}=${runtimeKey}`, `${credentialName}=${credentialKey}`);
await writeEnv(serverPath, serverLines, existingServerInfo?.mode ?? 0o600, server.newline || shared.newline);
const persistedServer = parseEnv(await readFile(serverPath, 'utf8'), serverPath);
if (requiredValue(persistedServer, runtimeName, serverPath) !== runtimeKey
  || requiredValue(persistedServer, credentialName, serverPath) !== credentialKey) {
  throw new Error('server runtime env 写后读回不一致');
}

const sharedLines = withoutVariables(shared.lines, new Set([credentialName]));
await writeEnv(sharedPath, sharedLines, sharedInfo.mode, shared.newline);
const persistedShared = parseEnv(await readFile(sharedPath, 'utf8'), sharedPath);
if (requiredValue(persistedShared, runtimeName, sharedPath) !== runtimeKey
  || persistedShared.values.has(credentialName)) {
  throw new Error('shared runtime env 分离写后读回不一致');
}

console.log(JSON.stringify({
  ok: true,
  changed: true,
  sharedPath,
  serverPath,
  sharedBackupPath,
  ...(serverBackupPath ? { serverBackupPath } : {}),
  sharedVariables: [...persistedShared.values.keys()].sort(),
  serverVariables: [...persistedServer.values.keys()].sort()
}, null, 2));

function absoluteArgument(prefix) {
  const argument = process.argv.find((value) => value.startsWith(prefix));
  const value = argument ? path.resolve(argument.slice(prefix.length)) : '';
  if (!value || !path.isAbsolute(value)) throw new Error(`缺少 ${prefix}<absolute-path>`);
  return value;
}

async function regularEnvFile(filePath, required) {
  try {
    const info = await stat(filePath);
    if (!info.isFile() || info.size > 64 * 1024) throw new Error(`${filePath} 必须是小于 64 KiB 的普通文件`);
    return info;
  } catch (error) {
    if (!required && error?.code === 'ENOENT') return undefined;
    throw error;
  }
}

function parseEnv(content, filePath) {
  const newline = content.includes('\r\n') ? '\r\n' : '\n';
  const lines = content.split(/\r?\n/).filter((line, index, all) => line || index < all.length - 1);
  const values = new Map();
  for (const line of lines) {
    if (!line || /^\s*#/.test(line)) continue;
    const match = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line);
    if (!match) throw new Error(`${filePath} 含无法安全保留的 env 行`);
    if (values.has(match[1])) throw new Error(`${filePath} 重复定义 ${match[1]}`);
    values.set(match[1], match[2].trim());
  }
  return { lines, values, newline };
}

function requiredValue(parsed, name, filePath) {
  const value = parsed.values.get(name);
  if (!value) throw new Error(`${filePath} 缺少 ${name}`);
  return value;
}

function assertCredentialKey(value) {
  const decoded = Buffer.from(value, 'base64');
  if (decoded.length !== 32 || decoded.toString('base64') !== value) {
    throw new Error(`${credentialName} 必须是规范的 32 字节 Base64`);
  }
}

function withoutVariables(lines, names) {
  return lines.filter((line) => {
    const match = /^([A-Z][A-Z0-9_]*)=/.exec(line);
    return !match || !names.has(match[1]);
  });
}

async function writeEnv(filePath, lines, mode, newline) {
  const content = `${lines.join(newline)}${newline}`;
  await writeFileAtomic(filePath, content, { encoding: 'utf8', mode });
}
