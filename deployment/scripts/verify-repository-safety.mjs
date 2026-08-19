import { execFileSync } from 'node:child_process';
import { access, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const errors = [];

async function exists(target) {
  try { await access(target); return true; } catch { return false; }
}

async function listFiles(root) {
  const output = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (['.git', 'node_modules', 'dist', 'playwright-cache', 'data', 'data-test', 'backup', 'backups', 'sessions'].includes(entry.name)) continue;
    const absolute = path.join(root, entry.name);
    if (entry.isDirectory()) output.push(...await listFiles(absolute));
    else output.push(absolute);
  }
  return output;
}

if (await exists(path.join(projectRoot, 'README.en.md'))) errors.push('README.en.md 必须删除，只维护中文 README.md');

const candidateOutput = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { cwd: projectRoot, encoding: 'utf8' });
const candidates = candidateOutput.split('\0').filter(Boolean);
const forbiddenPath = /(?:^|\/)(?:\.env(?:[.-].*)?|auth\.json|tokens?\.json|cookies?[^/]*|sessions?|browser-profiles?|chrome-user-data|playwright-cache|database-backups?|db-backups?)(?:\/|$)|\.(?:dump|sql|sql\.gz|sqlite|sqlite3|db|pem|key|p12|pfx|bak)$/i;
const retiredBrandPattern = new RegExp(['Pix', 'Route'].join(''));
for (const relative of candidates) {
  const normalized = relative.replace(/\\/g, '/');
  if (normalized === '.env.example') continue;
  if (forbiddenPath.test(normalized)) errors.push(`Git 候选包含禁止路径：${normalized}`);
}

const requirements = JSON.parse(await readFile(path.join(projectRoot, 'deployment', 'n8n', 'credential-requirements.json'), 'utf8'));
if (requirements.requirements?.length !== 6 || requirements.bindings?.length !== 32) errors.push('凭据需求清单必须是 6 组逻辑凭据、32 处绑定');
const requirementText = JSON.stringify(requirements);
if (/original(?:Credential)?(?:Id|Name)/i.test(requirementText)) errors.push('凭据需求清单包含原凭据标识');

const jimengRoot = path.join(projectRoot, 'integrations', 'jimeng-free-api-all');
for (const file of await listFiles(jimengRoot)) {
  const relative = path.relative(jimengRoot, file).replace(/\\/g, '/');
  if (/(?:^|\/)(?:curl[^/]*\.txt|cookie[^/]*\.txt)|\.bak(?:\.|$)/i.test(relative)) errors.push(`Jimeng 集成含禁止文件：${relative}`);
}

const runtimeScriptsRoot = path.join(projectRoot, 'deployment', 'n8n', 'runtime-scripts');
const runtimeSourceFiles = (await readdir(runtimeScriptsRoot)).filter((name) => name.endsWith('.cjs'));
if (runtimeSourceFiles.length !== 12) errors.push(`n8n 外部运行源码必须恰好 12 个，实际 ${runtimeSourceFiles.length} 个`);
if (!await exists(path.join(runtimeScriptsRoot, 'package-lock.json'))) errors.push('n8n 外部运行源码缺少 package-lock.json');

for (const relative of candidates.filter((item) => /^(?:deployment|integrations)\//.test(item.replace(/\\/g, '/')))) {
  const absolute = path.join(projectRoot, relative);
  try {
    const content = await readFile(absolute, 'utf8');
    // `/Users/example/` is the single approved anonymous macOS fixture used
    // by deployment tests and documentation. Every other user profile stays
    // forbidden, including real local usernames.
    const withoutAnonymousMacFixture = content.replaceAll('/Users/example/', '/__ANONYMOUS_MAC_FIXTURE__/');
    if (/C:\\Users\\[^\\\s]+|\/Users\/[^/\s]+/i.test(withoutAnonymousMacFixture)) errors.push(`部署候选含个人用户路径：${relative}`);
  } catch {
    // Binary files are covered by path checks and gitleaks.
  }
}

for (const relative of candidates) {
  const absolute = path.join(projectRoot, relative);
  try {
    const content = await readFile(absolute, 'utf8');
    if (retiredBrandPattern.test(content)) errors.push(`Git 候选仍含旧品牌名称：${relative}`);
  } catch {
    // Binary files are not user-facing text and are checked by forbidden paths/gitleaks.
  }
}

if (errors.length) {
  console.error(`仓库安全验证失败（${errors.length} 项）：`);
  errors.forEach((error) => console.error(`- ${error}`));
  process.exitCode = 1;
} else {
  console.log(`仓库安全验证通过：${candidates.length} 个 Git 候选，Jimeng 运行数据与真实凭据均未进入候选范围。`);
}
