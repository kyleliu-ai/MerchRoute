import { createHash, randomBytes } from 'node:crypto';
import { copyFile, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import writeFileAtomic from 'write-file-atomic';

const variableName = 'MERCHROUTE_CREDENTIAL_ENCRYPTION_KEY';
const fileArgument = process.argv.find((argument) => argument.startsWith('--file='));
const filePath = fileArgument ? path.resolve(fileArgument.slice('--file='.length)) : '';

if (!filePath || !path.isAbsolute(filePath)) {
  throw new Error('必须通过 --file=<absolute-path> 指定现有 runtime env 文件');
}

const info = await stat(filePath);
if (!info.isFile() || info.size > 64 * 1024) {
  throw new Error('runtime env 必须是小于 64 KiB 的普通文件');
}

const content = await readFile(filePath, 'utf8');
const newline = content.includes('\r\n') ? '\r\n' : '\n';
const matches = content.split(/\r?\n/).filter((line) => line.startsWith(`${variableName}=`));
if (matches.length > 1) throw new Error(`${variableName} 存在重复定义`);

if (matches.length === 1) {
  const existing = matches[0].slice(variableName.length + 1).trim();
  assertKey(existing);
  console.log(JSON.stringify({
    ok: true,
    created: false,
    filePath,
    fingerprint: fingerprint(existing)
  }, null, 2));
  process.exit(0);
}

const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
const backupPath = `${filePath}.pre-credential-key-${timestamp}.bak`;
await copyFile(filePath, backupPath, 1);

const generated = randomBytes(32).toString('base64');
assertKey(generated);
const separator = content.length === 0 || content.endsWith('\n') ? '' : newline;
await writeFileAtomic(filePath, `${content}${separator}${variableName}=${generated}${newline}`, {
  encoding: 'utf8',
  mode: info.mode
});

const persisted = await readFile(filePath, 'utf8');
const persistedMatches = persisted.split(/\r?\n/).filter((line) => line.startsWith(`${variableName}=`));
if (persistedMatches.length !== 1) throw new Error(`${variableName} 持久化校验失败`);
const persistedValue = persistedMatches[0].slice(variableName.length + 1).trim();
assertKey(persistedValue);
if (persistedValue !== generated) throw new Error(`${variableName} 写后读回不一致`);

console.log(JSON.stringify({
  ok: true,
  created: true,
  filePath,
  backupPath,
  fingerprint: fingerprint(persistedValue),
  decodedBytes: 32
}, null, 2));

function assertKey(value) {
  const decoded = Buffer.from(value, 'base64');
  if (decoded.length !== 32 || decoded.toString('base64') !== value) {
    throw new Error(`${variableName} 必须是规范的 32 字节 Base64`);
  }
}

function fingerprint(value) {
  return `sha256:${createHash('sha256').update(value).digest('hex').slice(0, 16)}`;
}
