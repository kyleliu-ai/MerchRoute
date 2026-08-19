import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { access, chmod, copyFile, cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  LOCAL_FILE_TRIGGER_CONTRACTS,
  assertCanonicalCategoryRulesPath,
  assertMaterializedLocalFileTriggerPaths,
  categoryRulesFilePath,
  verifyCategoryRulesFiles,
} from '../n8n/runtime-contract.mjs';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDir, '..', '..');
const command = process.argv[2] || 'help';
const options = new Map(process.argv.slice(3).map((item) => {
  const [key, ...rest] = item.replace(/^--/, '').split('=');
  return [key, rest.length ? rest.join('=') : 'true'];
}));
const dryRun = options.get('dry-run') === 'true';

const defaultHome = process.platform === 'win32'
  ? path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'MerchRoute')
  : path.join(os.homedir(), 'Library', 'Application Support', 'MerchRoute');
const appHome = path.resolve(options.get('app-home') || process.env.MERCHROUTE_APP_HOME || defaultHome);
const secretsDir = path.join(appHome, 'secrets');
const dataRoot = path.resolve(options.get('data-root') || process.env.MERCHROUTE_DATA_ROOT || path.join(appHome, 'files'));
const categoryRulesRuntimePath = categoryRulesFilePath(dataRoot);
const configDir = path.dirname(categoryRulesRuntimePath);
const categoryRulesRepositoryPath = path.join(projectRoot, 'deployment', 'n8n', 'config', 'category-scene-rules.json');
const localFileTriggerDirectories = LOCAL_FILE_TRIGGER_CONTRACTS.map((contract) => path.join(dataRoot, ...contract.relativePath.split('/')));
const tempDir = path.join(dataRoot, '.tmp');
const stateDir = path.join(appHome, 'deployment');
const n8nUserFolder = path.join(appHome, 'n8n');
const n8nRuntimeDir = path.join(appHome, 'n8n-runtime');
const n8nRuntimeScriptsDir = path.join(n8nRuntimeDir, 'scripts');
const deploymentEnvPath = path.join(secretsDir, 'deployment.env');
const merchrouteEnvPath = path.join(secretsDir, 'merchroute.env');
const n8nEnvPath = path.join(secretsDir, 'n8n.env');
const credentialsPath = path.join(secretsDir, 'credentials.local.json');
const statePath = path.join(stateDir, 'state.json');
const probeResultsPath = path.join(stateDir, 'credential-probes.json');
const existingN8nEnv = await readEnvIfPresent(n8nEnvPath);
const existingState = await readJsonIfPresent(statePath);
const persistedBrowserProfileRoots = [
  existingN8nEnv.MERCHROUTE_BROWSER_PROFILE_ROOT,
  existingState?.files?.browserProfileRoot,
].filter(Boolean).map((value) => path.resolve(String(value)));
if (persistedBrowserProfileRoots.some((value) => normalizedForComparison(value) !== normalizedForComparison(persistedBrowserProfileRoots[0]))) {
  throw new Error('仓库外 n8n.env 与 deployment/state.json 记录了不同的浏览器 Profile 根目录；已停止，禁止猜测或迁移登录状态');
}
const requestedBrowserProfileRoot = options.get('browser-profile-root') || process.env.MERCHROUTE_BROWSER_PROFILE_ROOT;
if (requestedBrowserProfileRoot && !path.isAbsolute(requestedBrowserProfileRoot)) throw new Error('--browser-profile-root / MERCHROUTE_BROWSER_PROFILE_ROOT 必须是绝对路径');
if (requestedBrowserProfileRoot && persistedBrowserProfileRoots[0]
  && normalizedForComparison(requestedBrowserProfileRoot) !== normalizedForComparison(persistedBrowserProfileRoots[0])) {
  throw new Error('请求的浏览器 Profile 根目录与已持久化目录不同；已停止，禁止用空目录覆盖现有登录 Profile');
}
const browserProfileRoot = path.resolve(requestedBrowserProfileRoot || persistedBrowserProfileRoots[0] || path.join(appHome, 'browser-profiles'));
const browserProfileStatePath = path.join(stateDir, 'browser-profiles.json');
const browserProfileContracts = Object.freeze([
  Object.freeze({ id: 'pdd', workflowCode: 'E006', directory: path.join(browserProfileRoot, 'pdd'), loginScript: 'pdd-login.cjs', loginUrl: 'https://mobile.yangkeduo.com/', lockSuffix: '.pdd.lock' }),
  Object.freeze({ id: '1688', workflowCode: 'E007', directory: path.join(browserProfileRoot, '1688'), loginScript: '1688-login.cjs', loginUrl: 'https://www.1688.com/', lockSuffix: '.e007.lock' }),
]);
const browserProfileDirectories = browserProfileContracts.map((contract) => contract.directory);
const browserExecutable = process.platform === 'darwin'
  ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
  : 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const merchrouteBaseUrl = String(options.get('merchroute-base-url') || 'http://127.0.0.1:4173').replace(/\/$/, '');
const merchrouteUrl = new URL(merchrouteBaseUrl);
if (merchrouteUrl.protocol !== 'http:' || !['127.0.0.1', 'localhost', '::1'].includes(merchrouteUrl.hostname)) {
  throw new Error('--merchroute-base-url 只允许本机 HTTP loopback 地址');
}
const merchrouteApiUrl = (pathname) => new URL(pathname, `${merchrouteBaseUrl}/`).toString();

function normalizedForComparison(value) {
  const resolved = path.resolve(value).replace(/[\\/]+$/, '');
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function containsPath(parent, child) {
  const base = normalizedForComparison(parent);
  const candidate = normalizedForComparison(child);
  return candidate === base || candidate.startsWith(`${base}${path.sep}`);
}

if (options.get('app-home') && !path.isAbsolute(options.get('app-home'))) throw new Error('--app-home 必须是绝对路径');
if (options.get('data-root') && !path.isAbsolute(options.get('data-root'))) throw new Error('--data-root 必须是绝对路径');
if (containsPath(projectRoot, appHome) || containsPath(appHome, projectRoot)) throw new Error('应用状态目录不得与 Git 仓库重叠');
if (containsPath(projectRoot, dataRoot) || containsPath(dataRoot, projectRoot)) throw new Error('业务媒体根目录不得与 Git 仓库重叠');
if (containsPath(dataRoot, secretsDir) || containsPath(dataRoot, n8nUserFolder)) throw new Error('业务媒体根目录不得包含凭据目录或 n8n 用户目录');
if (containsPath(projectRoot, browserProfileRoot) || containsPath(browserProfileRoot, projectRoot)) throw new Error('浏览器 Profile 根目录不得与 Git 仓库重叠');
if (containsPath(dataRoot, browserProfileRoot) || containsPath(browserProfileRoot, dataRoot)) throw new Error('浏览器 Profile 根目录不得与业务媒体目录重叠');
if (containsPath(browserProfileRoot, secretsDir) || containsPath(secretsDir, browserProfileRoot)
  || containsPath(browserProfileRoot, n8nUserFolder) || containsPath(n8nUserFolder, browserProfileRoot)) {
  throw new Error('浏览器 Profile 根目录不得与凭据目录或 n8n 用户目录重叠');
}

function parseEnv(content) {
  const output = {};
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const index = line.indexOf('=');
    if (index > 0) output[line.slice(0, index)] = line.slice(index + 1);
  }
  return output;
}

function serializeEnv(values, header) {
  return `${header}\n${Object.entries(values).map(([key, value]) => `${key}=${value}`).join('\n')}\n`;
}

async function exists(target) {
  try { await access(target); return true; } catch { return false; }
}

async function readEnvIfPresent(target) {
  return await exists(target) ? parseEnv(await readFile(target, 'utf8')) : {};
}

async function readJsonIfPresent(target) {
  if (!await exists(target)) return null;
  try {
    return JSON.parse(await readFile(target, 'utf8'));
  } catch (error) {
    throw new Error(`无法读取已有部署状态 ${target}：${error instanceof Error ? error.message : String(error)}`);
  }
}

function newSecret(bytes = 32) {
  return randomBytes(bytes).toString('base64url');
}

function databasePasswordFromUrl(value) {
  if (!value) return '';
  try {
    const url = new URL(value);
    return decodeURIComponent(url.password || '');
  } catch {
    throw new Error('已有 MerchRoute DATABASE_URL 无效；已停止，禁止据此重写数据库凭据');
  }
}

function expectedE007Stage(root = dataRoot) {
  return {
    id: 'E007',
    alias: '1688下载',
    groupId: 'downloads',
    displayName: '1688产品媒体下载',
    workflowName: 'E007-v01-1688产品媒体下载',
    description: '下载 1688 产品主图、详情图和视频',
    enabled: true,
    reviewEnabled: true,
    mediaTypes: ['image', 'video'],
    candidateRoot: path.join(root, '03-1688ProductMedia'),
    approvedArchiveRoot: path.join(root, '04_已审核图片目录', 'E007-已经审核'),
    targets: [{
      targetStageId: 'E001',
      targetQueueRoot: path.join(root, '01_monitorFolder', 'E001-抠图-监听'),
      folderNameTemplate: '{sourceName}-已经审核',
      packageMode: 'preserve-relative',
      copyRootMetadata: true,
    }],
    download: {
      webhookUrl: 'http://localhost:5678/webhook/1688-product-media-download',
      timeoutMs: 900_000,
      isDefault: false,
      recoveryMode: 'IDEMPOTENT_REPLAY',
    },
  };
}

async function requestJson(url, init) {
  const response = await fetch(url, { ...init, signal: AbortSignal.timeout(15_000) });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`${init?.method || 'GET'} ${url} 失败（HTTP ${response.status}）：${body?.error?.message || '无错误详情'}`);
  return body;
}

function samePath(left, right) {
  return normalizedForComparison(left) === normalizedForComparison(right);
}

function e007ConfigMismatches(stage, expected) {
  if (!stage) return ['missing'];
  const mismatches = [];
  if (stage.displayName !== expected.displayName) mismatches.push('displayName');
  if (stage.workflowName !== expected.workflowName) mismatches.push('workflowName');
  if (!samePath(stage.candidateRoot || '', expected.candidateRoot)) mismatches.push('candidateRoot');
  if (stage.download?.webhookUrl !== expected.download.webhookUrl) mismatches.push('download.webhookUrl');
  if (stage.download?.timeoutMs !== expected.download.timeoutMs) mismatches.push('download.timeoutMs');
  if (stage.download?.isDefault !== false) mismatches.push('download.isDefault');
  if (stage.download?.recoveryMode !== 'IDEMPOTENT_REPLAY') mismatches.push('download.recoveryMode');
  return mismatches;
}

async function configureMerchRouteE007() {
  const runtime = dryRun ? { merchroute: {}, n8n: {} } : await loadRuntime();
  const configuredDataRoot = path.resolve(
    options.get('data-root')
      || process.env.MERCHROUTE_DATA_ROOT
      || runtime.merchroute.MERCHROUTE_DATA_ROOT
      || runtime.n8n.MERCHROUTE_DATA_ROOT
      || dataRoot,
  );
  if (containsPath(projectRoot, configuredDataRoot) || containsPath(configuredDataRoot, projectRoot)) throw new Error('业务媒体根目录不得与 Git 仓库重叠');
  if (containsPath(configuredDataRoot, secretsDir) || containsPath(configuredDataRoot, n8nUserFolder)) throw new Error('业务媒体根目录不得包含凭据目录或 n8n 用户目录');
  const expected = expectedE007Stage(configuredDataRoot);
  if (dryRun) {
    console.log(JSON.stringify({ dryRun: true, action: 'configure-merchroute', workflowCode: 'E007', candidateRoot: expected.candidateRoot }, null, 2));
    return;
  }
  await Promise.all([
    mkdir(expected.candidateRoot, { recursive: true }),
    mkdir(expected.approvedArchiveRoot, { recursive: true }),
    mkdir(expected.targets[0].targetQueueRoot, { recursive: true }),
  ]);

  const configView = await requestJson(merchrouteApiUrl('/api/v1/config'));
  const config = configView.config;
  if (!config?.stages || !Array.isArray(config.stages)) throw new Error('MerchRoute 未返回有效的系统配置');
  let e007 = config.stages.find((stage) => stage.id === 'E007');
  if (!e007) {
    const e006Index = config.stages.findIndex((stage) => stage.id === 'E006');
    if (e006Index < 0) throw new Error('MerchRoute 配置缺少 E006，不能安全推导 E007 的插入位置');
    const stages = [...config.stages];
    stages.splice(e006Index + 1, 0, expected);
    const saved = await requestJson(merchrouteApiUrl('/api/v1/config'), {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...config, stages }),
    });
    e007 = saved.config?.stages?.find((stage) => stage.id === 'E007');
  }

  const mismatches = e007ConfigMismatches(e007, expected);
  if (mismatches.length) throw new Error(`E007 已存在但配置与部署契约不一致：${mismatches.join(', ')}；已停止，未覆盖现有配置`);

  const parameterView = await requestJson(merchrouteApiUrl('/api/v1/workflow-parameters/E007'));
  const parameters = parameterView.parameters || {};
  if (parameters.parentOutputDir && !samePath(parameters.parentOutputDir, expected.candidateRoot)) {
    throw new Error('E007 工作流参数 parentOutputDir 已存在且与部署数据目录不一致；已停止，未覆盖现有值');
  }
  const requiredParameters = {
    ...parameters,
    SKU: '',
    productName: '',
    productUrl: parameters.productUrl ?? '',
    parentOutputDir: expected.candidateRoot,
    maxImagesPerTask: parameters.maxImagesPerTask ?? '4',
  };
  if (JSON.stringify(requiredParameters) !== JSON.stringify(parameters)) {
    await requestJson(merchrouteApiUrl('/api/v1/workflow-parameters/E007'), {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ parameters: requiredParameters, parameterOptions: parameterView.parameterOptions || {} }),
    });
  }

  const projection = await requestJson(merchrouteApiUrl('/api/v1/download-workflows?includeDisabled=true'));
  const projectedE007 = projection.items?.find((item) => item.code === 'E007');
  const projectionMatches = projectedE007
    && projectedE007.webhookUrl === expected.download.webhookUrl
    && samePath(projectedE007.parentOutputDir || '', expected.candidateRoot)
    && projectedE007.recoveryMode === expected.download.recoveryMode;
  if (!projectionMatches) throw new Error('PostgreSQL 下载配置投影未正确包含 E007');
  console.log(JSON.stringify({ configured: true, workflowCode: 'E007', databaseProjection: 'synced', n8nActivationChanged: false }, null, 2));
}

async function writePrivate(target, content, { overwrite = false } = {}) {
  if (!overwrite && await exists(target)) return false;
  await writeFile(target, content, { encoding: 'utf8', mode: 0o600 });
  await chmod(target, 0o600).catch(() => undefined);
  hardenWindowsAcl(target, false);
  return true;
}

function hardenWindowsAcl(target, directory) {
  if (process.platform !== 'win32') return;
  const identity = `${process.env.USERDOMAIN || ''}\\${process.env.USERNAME || ''}`.replace(/^\\|\\$/g, '')
    || execFileSync('whoami', [], { encoding: 'utf8', windowsHide: true }).trim();
  const rule = directory ? '(OI)(CI)F' : 'F';
  execFileSync('icacls.exe', [target, '/inheritance:r', '/grant:r', `${identity}:${rule}`], { stdio: 'ignore', windowsHide: true });
}

async function prepare() {
  const planned = [appHome, secretsDir, dataRoot, configDir, ...localFileTriggerDirectories, tempDir, stateDir, n8nUserFolder, n8nRuntimeScriptsDir, browserProfileRoot, ...browserProfileDirectories];
  if (dryRun) {
    console.log(JSON.stringify({ dryRun: true, action: 'prepare', directories: planned, repository: projectRoot }, null, 2));
    return;
  }
  for (const directory of planned) {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await chmod(directory, 0o700).catch(() => undefined);
    hardenWindowsAcl(directory, true);
  }

  const previous = await readEnvIfPresent(deploymentEnvPath);
  const previousMerchRoute = await readEnvIfPresent(merchrouteEnvPath);
  const previousN8n = await readEnvIfPresent(n8nEnvPath);
  const assertSameSecret = (name, candidates) => {
    const values = candidates.filter(Boolean);
    if (values.some((value) => value !== values[0])) {
      throw new Error(`${name} 在已有仓库外配置中不一致；已停止，禁止覆盖或重新生成`);
    }
  };
  const previousMerchRouteDbPassword = databasePasswordFromUrl(previousMerchRoute.DATABASE_URL);
  assertSameSecret('N8N_ENCRYPTION_KEY', [previous.N8N_ENCRYPTION_KEY, previousN8n.N8N_ENCRYPTION_KEY]);
  assertSameSecret('N8N_DB_PASSWORD', [previous.N8N_DB_PASSWORD, previousN8n.DB_POSTGRESDB_PASSWORD]);
  assertSameSecret('MERCHROUTE_DB_PASSWORD', [previous.MERCHROUTE_DB_PASSWORD, previousMerchRouteDbPassword]);
  assertSameSecret('MERCHROUTE_RUNTIME_KEY', [previous.MERCHROUTE_RUNTIME_KEY, previousMerchRoute.MERCHROUTE_RUNTIME_KEY, previousN8n.MERCHROUTE_RUNTIME_KEY]);
  assertSameSecret('MERCHROUTE_CREDENTIAL_ENCRYPTION_KEY', [previous.MERCHROUTE_CREDENTIAL_ENCRYPTION_KEY, previousMerchRoute.MERCHROUTE_CREDENTIAL_ENCRYPTION_KEY]);
  const values = {
    POSTGRES_ADMIN_PASSWORD: previous.POSTGRES_ADMIN_PASSWORD || newSecret(36),
    MERCHROUTE_DB_PASSWORD: previous.MERCHROUTE_DB_PASSWORD || previousMerchRouteDbPassword || newSecret(36),
    N8N_DB_PASSWORD: previous.N8N_DB_PASSWORD || previousN8n.DB_POSTGRESDB_PASSWORD || newSecret(36),
    N8N_ENCRYPTION_KEY: previous.N8N_ENCRYPTION_KEY || previousN8n.N8N_ENCRYPTION_KEY || newSecret(32), // gitleaks:allow - generated at runtime and stored outside Git
    MERCHROUTE_RUNTIME_KEY: previous.MERCHROUTE_RUNTIME_KEY || previousMerchRoute.MERCHROUTE_RUNTIME_KEY || previousN8n.MERCHROUTE_RUNTIME_KEY || newSecret(32),
    MERCHROUTE_CREDENTIAL_ENCRYPTION_KEY: previous.MERCHROUTE_CREDENTIAL_ENCRYPTION_KEY || previousMerchRoute.MERCHROUTE_CREDENTIAL_ENCRYPTION_KEY || randomBytes(32).toString('base64'),
  };
  await writePrivate(deploymentEnvPath, serializeEnv(values, '# MerchRoute deployment secrets. Never commit or paste into chat.'), { overwrite: true });

  const databaseUrl = `postgresql://merchroute_app:${encodeURIComponent(values.MERCHROUTE_DB_PASSWORD)}@127.0.0.1:5432/merchroute`;
  const merchrouteEnv = {
    ...previousMerchRoute,
    HOST: '127.0.0.1',
    PORT: '4173',
    DATABASE_URL: databaseUrl,
    APP_DATA_DIR: path.join(appHome, 'app-data'),
    MERCHROUTE_DATA_ROOT: dataRoot,
    MERCHROUTE_RUNTIME_BASE_URL: 'http://127.0.0.1:4173',
    MERCHROUTE_RUNTIME_KEY: values.MERCHROUTE_RUNTIME_KEY,
    MERCHROUTE_CREDENTIAL_ENCRYPTION_KEY: values.MERCHROUTE_CREDENTIAL_ENCRYPTION_KEY,
    MERCHROUTE_OZON_MULTISTORE_FLEET_READY: 'false',
    WB_AUTOMATION_BASE_URL: 'http://127.0.0.1:5678',
    WB_AUTOMATION_KEY: values.MERCHROUTE_RUNTIME_KEY,
    OZON_AUTOMATION_BASE_URL: 'http://127.0.0.1:5678',
    OZON_AUTOMATION_KEY: values.MERCHROUTE_RUNTIME_KEY,
  };
  await writePrivate(merchrouteEnvPath, serializeEnv(merchrouteEnv, '# MerchRoute runtime. Repository-external and private.'), { overwrite: true });

  const n8nEnv = {
    ...previousN8n,
    N8N_USER_FOLDER: n8nUserFolder,
    N8N_ENCRYPTION_KEY: values.N8N_ENCRYPTION_KEY,
    DB_TYPE: 'postgresdb',
    DB_POSTGRESDB_HOST: '127.0.0.1',
    DB_POSTGRESDB_PORT: '5432',
    DB_POSTGRESDB_DATABASE: 'merchroute_n8n',
    DB_POSTGRESDB_USER: 'merchroute_n8n',
    DB_POSTGRESDB_PASSWORD: values.N8N_DB_PASSWORD,
    N8N_HOST: '127.0.0.1',
    N8N_LISTEN_ADDRESS: '127.0.0.1',
    N8N_PORT: '5678',
    N8N_PROTOCOL: 'http',
    N8N_GRACEFUL_SHUTDOWN_TIMEOUT: '1200',
    N8N_BLOCK_ENV_ACCESS_IN_NODE: 'false',
    NODES_EXCLUDE: '[]',
    NODE_FUNCTION_ALLOW_BUILTIN: 'fs,path,crypto,http,https,url,child_process,zlib',
    N8N_RESTRICT_FILE_ACCESS_TO: dataRoot,
    MERCHROUTE_DATA_ROOT: dataRoot,
    MERCHROUTE_N8N_RUNTIME_DIR: n8nRuntimeDir,
    MERCHROUTE_BROWSER_PROFILE_ROOT: browserProfileRoot,
    MERCHROUTE_BROWSER_EXECUTABLE: browserExecutable,
    MERCHROUTE_TEMP_DIR: tempDir,
    MERCHROUTE_RUNTIME_BASE_URL: 'http://127.0.0.1:4173',
    MERCHROUTE_RUNTIME_KEY: values.MERCHROUTE_RUNTIME_KEY,
    MERCHROUTE_CATEGORY_RULES_FILE: categoryRulesRuntimePath,
    GENERIC_TIMEZONE: 'Asia/Shanghai',
    TZ: 'Asia/Shanghai',
  };
  await writePrivate(n8nEnvPath, serializeEnv(n8nEnv, '# Global n8n runtime. Repository-external and private.'), { overwrite: true });

  if (!await exists(credentialsPath)) {
    const credentialTemplate = {
      schemaVersion: 1,
      instructions: '先按仓库 deployment/CREDENTIAL_SETUP.zh-CN.md 获取五组平台凭据，只在本机编辑此文件。merchroute-runtime.runtimeKey 保持为空，由部署脚本自动填充。禁止提交 Git、粘贴到聊天或截图分享。',
      credentialGuide: 'deployment/CREDENTIAL_SETUP.zh-CN.md',
      credentials: {
        'jimeng-session': { token: '' },
        'siliconflow-api': { token: '' },
        'qwen-runtime': { model: 'qwen3.7-plus', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions', apiKey: '' },
        'merchroute-runtime': { runtimeKey: '' },
        'wb-seller-api': { token: '' },
        'ozon-seller-api': { clientId: '', apiKey: '' },
      },
    };
    await writePrivate(credentialsPath, `${JSON.stringify(credentialTemplate, null, 2)}\n`);
  }

  // The copy is intentionally refreshed on every prepare run. Verification of
  // both JSON parsing and the byte-for-byte SHA prevents a partial/stale E003
  // rules file from reaching the workflow import step.
  await copyFile(categoryRulesRepositoryPath, categoryRulesRuntimePath);
  await chmod(categoryRulesRuntimePath, 0o600).catch(() => undefined);
  hardenWindowsAcl(categoryRulesRuntimePath, false);
  const categoryRules = await verifyCategoryRulesFiles(categoryRulesRepositoryPath, categoryRulesRuntimePath);
  await cp(path.join(projectRoot, 'deployment', 'n8n', 'runtime-scripts'), n8nRuntimeScriptsDir, {
    recursive: true,
    force: true,
    filter: (source) => !source.split(path.sep).includes('node_modules'),
  });
  const state = {
    schemaVersion: 1,
    preparedAt: new Date().toISOString(),
    platform: `${process.platform}-${process.arch}`,
    projectRoot,
    appHome,
    dataRoot,
    files: {
      deploymentEnvPath,
      merchrouteEnvPath,
      n8nEnvPath,
      credentialsPath,
      n8nRuntimeScriptsDir,
      categoryRulesFile: categoryRulesRuntimePath,
      browserProfileRoot,
      browserProfiles: Object.fromEntries(browserProfileContracts.map((contract) => [contract.id, contract.directory])),
    },
    categoryRulesSha256: categoryRules.sha256,
    localFileTriggerDirectories,
    secretsRecorded: false,
    workflowPolicy: 'all-imported-inactive',
  };
  await writePrivate(statePath, `${JSON.stringify(state, null, 2)}\n`, { overwrite: true });
  console.log(JSON.stringify({
    prepared: true,
    appHome,
    dataRoot,
    credentialsPath,
    credentialGuidePath: path.join(projectRoot, 'deployment', 'CREDENTIAL_SETUP.zh-CN.md'),
    runtimeKeyUserAction: 'leave-empty-auto-generated',
    merchrouteEnvPath,
    n8nEnvPath,
    categoryRulesFile: categoryRulesRuntimePath,
    categoryRulesSha256: categoryRules.sha256,
    localFileTriggerDirectories,
    browserProfileRoot,
    browserProfiles: Object.fromEntries(browserProfileContracts.map((contract) => [contract.id, contract.directory])),
  }, null, 2));
}

function selectedBrowserProfileContracts() {
  const requested = String(options.get('profile') || 'all').trim().toLowerCase();
  if (requested === 'all') return [...browserProfileContracts];
  const selected = browserProfileContracts.find((contract) => contract.id === requested);
  if (!selected) throw new Error('--profile 只允许 pdd、1688 或 all');
  return [selected];
}

async function browserCookieDatabasePresent(profileDirectory) {
  const candidates = [
    path.join(profileDirectory, 'Default', 'Network', 'Cookies'),
    path.join(profileDirectory, 'Default', 'Cookies'),
  ];
  for (const candidate of candidates) {
    if (await exists(candidate)) return true;
  }
  return false;
}

async function runInteractiveHelper(args, { captureStdout = false } = {}) {
  return await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      cwd: n8nRuntimeScriptsDir,
      env: process.env,
      stdio: ['inherit', captureStdout ? 'pipe' : 'inherit', 'inherit'],
      windowsHide: false,
    });
    let stdout = '';
    if (captureStdout) child.stdout.on('data', (chunk) => { stdout += String(chunk); });
    child.once('error', reject);
    child.once('close', (status, signal) => resolve({ status, signal, stdout }));
  });
}

async function initializeBrowserProfiles() {
  const selected = selectedBrowserProfileContracts();
  const plan = selected.map((contract) => ({
    id: contract.id,
    workflowCode: contract.workflowCode,
    directory: contract.directory,
    loginHelper: path.join(n8nRuntimeScriptsDir, contract.loginScript),
    loginUrl: contract.loginUrl,
    browserExecutable,
  }));
  if (dryRun) {
    console.log(JSON.stringify({ dryRun: true, action: 'browser-profiles', profiles: plan, networkProbe: false, workflowActivationChanged: false }, null, 2));
    return;
  }
  if (!await exists(n8nEnvPath)) throw new Error(`先执行 prepare：${n8nEnvPath}`);
  if (!await exists(browserExecutable)) throw new Error(`Google Chrome 不存在：${browserExecutable}`);
  const force = options.get('force') === 'true';
  const previous = await exists(browserProfileStatePath)
    ? JSON.parse(await readFile(browserProfileStatePath, 'utf8'))
    : { schemaVersion: 1, profiles: {} };
  const persistState = async () => {
    previous.schemaVersion = 1;
    previous.updatedAt = new Date().toISOString();
    previous.browserExecutable = browserExecutable;
    previous.secretValuesIncluded = false;
    await writePrivate(browserProfileStatePath, `${JSON.stringify(previous, null, 2)}\n`, { overwrite: true });
  };
  const results = [];
  for (const contract of selected) {
    await mkdir(contract.directory, { recursive: true, mode: 0o700 });
    await chmod(contract.directory, 0o700).catch(() => undefined);
    hardenWindowsAcl(contract.directory, true);
    const lockDirectory = `${contract.directory}${contract.lockSuffix}`;
    if (await exists(lockDirectory)) {
      throw new Error(`${contract.workflowCode} 专用 Profile 正被占用：${lockDirectory}。先结束真实占用进程；不得直接删除活动锁。`);
    }
    const alreadyPrepared = previous.profiles?.[contract.id]?.manualLoginCompleted === true
      && await browserCookieDatabasePresent(contract.directory);
    if (alreadyPrepared && !force) {
      results.push({ id: contract.id, workflowCode: contract.workflowCode, directory: contract.directory, manualLoginCompleted: true, reused: true });
      continue;
    }
    const helper = path.join(n8nRuntimeScriptsDir, contract.loginScript);
    if (!await exists(helper)) throw new Error(`${contract.workflowCode} 登录助手不存在：${helper}`);
    let loginStatus = 'cookie-database-detected';
    if (contract.id === '1688') {
      const child = await runInteractiveHelper([helper, contract.loginUrl, contract.directory, browserExecutable], { captureStdout: true });
      if (child.status !== 0) throw new Error(`E007 1688 专用 Profile 登录助手失败（exit ${child.status ?? child.signal}）`);
      const lines = child.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
      let result;
      try { result = JSON.parse(lines.at(-1) || '{}'); }
      catch { throw new Error('E007 登录助手没有返回可解析的脱敏结果'); }
      if (result.success !== true || result.status !== 'login_saved') {
        throw new Error(`E007 登录状态未通过只读回读：${String(result.status || 'unknown')}`);
      }
      loginStatus = result.status;
    } else {
      const child = await runInteractiveHelper([helper, contract.loginUrl, contract.directory, browserExecutable, 'Default']);
      if (child.status !== 0) throw new Error(`E006 PDD 专用 Profile 登录助手失败（exit ${child.status ?? child.signal}）`);
    }
    const cookieDatabasePresent = await browserCookieDatabasePresent(contract.directory);
    if (!cookieDatabasePresent) throw new Error(`${contract.workflowCode} 专用 Profile 未生成 Chrome Cookie 数据库；请重新运行并在专用窗口完成登录。`);
    const completedAt = new Date().toISOString();
    previous.profiles ||= {};
    previous.profiles[contract.id] = {
      workflowCode: contract.workflowCode,
      directory: contract.directory,
      manualLoginCompleted: true,
      loginStatus,
      cookieDatabasePresent: true,
      completedAt,
      secretValuesIncluded: false,
    };
    // Persist each completed human checkpoint so a later platform failure can
    // resume without asking the user to repeat the successful login.
    await persistState();
    results.push({ id: contract.id, workflowCode: contract.workflowCode, directory: contract.directory, manualLoginCompleted: true, reused: false });
  }
  await persistState();
  console.log(JSON.stringify({ initialized: true, profiles: results, stateFile: browserProfileStatePath, cookieValuesRead: false, workflowActivationChanged: false }, null, 2));
}

async function verifyBrowserProfiles() {
  const selected = selectedBrowserProfileContracts();
  const plan = selected.map((contract) => ({ id: contract.id, workflowCode: contract.workflowCode, directory: contract.directory }));
  if (dryRun) {
    console.log(JSON.stringify({ dryRun: true, action: 'verify-browser-profiles', profiles: plan, navigation: 'offline-data-url', workflowActivationChanged: false }, null, 2));
    return;
  }
  if (!await exists(browserProfileStatePath)) throw new Error(`先执行 browser-profiles：${browserProfileStatePath}`);
  const state = JSON.parse(await readFile(browserProfileStatePath, 'utf8'));
  const smokeScript = path.join(n8nRuntimeScriptsDir, 'browser-profile-smoke.cjs');
  if (!await exists(smokeScript)) throw new Error(`浏览器 Profile 烟测脚本不存在：${smokeScript}`);
  const results = [];
  for (const contract of selected) {
    const recorded = state.profiles?.[contract.id];
    if (recorded?.manualLoginCompleted !== true || !samePath(recorded.directory || '', contract.directory)) {
      throw new Error(`${contract.workflowCode} 专用 Profile 尚未完成当前机器的人工初始化`);
    }
    if (!await browserCookieDatabasePresent(contract.directory)) throw new Error(`${contract.workflowCode} 专用 Profile 缺少 Chrome Cookie 数据库`);
    const lockDirectory = `${contract.directory}${contract.lockSuffix}`;
    if (await exists(lockDirectory)) throw new Error(`${contract.workflowCode} 专用 Profile 正被占用：${lockDirectory}`);
    const payload = Buffer.from(JSON.stringify({ profileId: contract.id, userDataDir: contract.directory, browserExecutablePath: browserExecutable }), 'utf8').toString('base64');
    const child = spawnSync(process.execPath, [smokeScript, payload], {
      cwd: n8nRuntimeScriptsDir,
      env: process.env,
      encoding: 'utf8',
      windowsHide: true,
      timeout: 60_000,
    });
    let smoke;
    try { smoke = JSON.parse(String(child.stdout || '').trim() || '{}'); }
    catch { throw new Error(`${contract.workflowCode} headless Profile 烟测没有返回可解析结果`); }
    if (child.status !== 0 || smoke.success !== true || smoke.offline !== true || smoke.headless !== true) {
      throw new Error(`${contract.workflowCode} headless Profile 复用失败：${String(smoke.status || child.error?.code || child.status)}`);
    }
    if (await exists(lockDirectory)) throw new Error(`${contract.workflowCode} headless 烟测结束后未释放 Profile 锁`);
    const verifiedAt = new Date().toISOString();
    state.profiles[contract.id] = { ...recorded, headlessReuseVerified: true, headlessReuseVerifiedAt: verifiedAt };
    results.push({ id: contract.id, workflowCode: contract.workflowCode, directory: contract.directory, headlessReuseVerified: true, offline: true });
  }
  state.updatedAt = new Date().toISOString();
  state.secretValuesIncluded = false;
  await writePrivate(browserProfileStatePath, `${JSON.stringify(state, null, 2)}\n`, { overwrite: true });
  console.log(JSON.stringify({ verified: true, profiles: results, cookieValuesRead: false, externalRequests: 0, workflowActivationChanged: false }, null, 2));
}

async function loadRuntime() {
  const deployment = await readEnvIfPresent(deploymentEnvPath);
  const merchroute = await readEnvIfPresent(merchrouteEnvPath);
  const n8n = await readEnvIfPresent(n8nEnvPath);
  return { deployment, merchroute, n8n };
}

async function runImport() {
  await configureMerchRouteE007();
  const { deployment, merchroute, n8n } = await loadRuntime();
  if (!Object.keys(n8n).length) throw new Error(`先执行 prepare：${n8nEnvPath}`);
  const env = { ...process.env, ...deployment, ...merchroute, ...n8n, MERCHROUTE_CREDENTIAL_INPUT_FILE: credentialsPath };
  const node = process.execPath;
  const importer = path.join(projectRoot, 'deployment', 'n8n', 'scripts', 'import-workflows.mjs');
  const importArgs = [importer, `--credentials-file=${credentialsPath}`];
  if (dryRun) importArgs.push('--dry-run');
  await new Promise((resolve, reject) => {
    const child = spawn(node, importArgs, { cwd: projectRoot, env, stdio: 'inherit', windowsHide: true });
    child.on('error', reject);
    child.on('close', (code) => code === 0 ? resolve() : reject(new Error(`工作流导入失败：${code}`)));
  });
}

async function probe() {
  if (options.get('allow-network-probes') !== 'true') throw new Error('真实接口探测必须显式传入 --allow-network-probes=true');
  const input = JSON.parse(await readFile(credentialsPath, 'utf8'));
  const { merchroute } = await loadRuntime();
  const credentials = input.credentials || {};
  const request = async (url, init = {}) => {
    let lastError;
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      try { return await fetch(url, { ...init, signal: AbortSignal.timeout(10_000) }); }
      catch (error) { lastError = error; }
    }
    throw lastError;
  };
  const probes = [
    ['jimeng', async () => {
      const response = await request('http://127.0.0.1:8000/token/check', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: credentials['jimeng-session']?.token }) });
      const body = response.ok ? await response.json().catch(() => ({})) : {};
      return { ok: response.ok && body.live === true, status: response.status };
    }],
    ['siliconflow', async () => request('https://api.siliconflow.cn/v1/models', { headers: { authorization: `Bearer ${credentials['siliconflow-api']?.token || ''}` } })],
    ['qwen', async () => {
      const target = String(credentials['qwen-runtime']?.baseUrl || '').replace(/\/chat\/completions\/?$/, '/models');
      return request(target, { headers: { authorization: `Bearer ${credentials['qwen-runtime']?.apiKey || ''}` } });
    }],
    ['merchroute-runtime', async () => request(merchrouteApiUrl('/api/v1/wb/runtime/config'), { headers: { 'x-merchroute-runtime-key': merchroute.MERCHROUTE_RUNTIME_KEY || '' } })],
    ['wb', async () => request('https://content-api.wildberries.ru/content/v2/object/parent/all', { headers: { authorization: credentials['wb-seller-api']?.token || '' } })],
    ['ozon', async () => request('https://api-seller.ozon.ru/v1/description-category/tree', { method: 'POST', headers: { 'content-type': 'application/json', 'Client-Id': credentials['ozon-seller-api']?.clientId || '', 'Api-Key': credentials['ozon-seller-api']?.apiKey || '' }, body: JSON.stringify({ language: 'DEFAULT' }) })],
  ];
  const results = [];
  for (const [name, execute] of probes) {
    try {
      const response = await execute();
      results.push({ name, ok: response.ok, status: response.status });
    } catch (error) {
      results.push({ name, ok: false, error: error?.code || error?.name || 'REQUEST_FAILED' });
    }
  }
  const failed = results.filter((item) => !item.ok);
  const sanitized = { verifiedAt: new Date().toISOString(), probes: results, secretValuesLogged: false, sideEffects: 'none' };
  await writePrivate(probeResultsPath, `${JSON.stringify(sanitized, null, 2)}\n`, { overwrite: true });
  console.log(JSON.stringify(sanitized, null, 2));
  if (failed.length) process.exitCode = 1;
}

async function verify() {
  const state = JSON.parse(await readFile(statePath, 'utf8'));
  const verifiedDataRoot = path.resolve(state.dataRoot || dataRoot);
  const manifest = JSON.parse(await readFile(path.join(projectRoot, 'deployment', 'n8n', 'manifest.json'), 'utf8'));
  const versions = JSON.parse(await readFile(path.join(projectRoot, 'deployment', 'runtime-versions.json'), 'utf8'));
  const probeResults = JSON.parse(await readFile(probeResultsPath, 'utf8'));
  const { deployment, merchroute, n8n } = await loadRuntime();
  const checks = [];
  const browserProfileReport = [];
  checks.push({ name: 'workflow-count', ok: manifest.workflowCount === 36 && manifest.uniqueWorkflowCount === 36 });
  checks.push({ name: 'secret-root-outside-repository', ok: !path.resolve(secretsDir).startsWith(projectRoot + path.sep) });
  checks.push({ name: 'workflow-policy', ok: state.workflowPolicy === 'all-imported-inactive' });
  checks.push({ name: 'credential-probes', ok: probeResults.probes?.length === 6 && probeResults.probes.every((item) => item.ok) });
  try {
    const browserProfiles = JSON.parse(await readFile(browserProfileStatePath, 'utf8'));
    for (const contract of browserProfileContracts) {
      const profile = browserProfiles.profiles?.[contract.id];
      checks.push({
        name: `browser-profile-${contract.id}`,
        ok: profile?.manualLoginCompleted === true
          && profile?.headlessReuseVerified === true
          && profile?.cookieDatabasePresent === true
          && samePath(profile?.directory || '', contract.directory),
        directory: contract.directory,
        cookieValuesRead: false,
      });
      browserProfileReport.push({
        id: contract.id,
        workflowCode: contract.workflowCode,
        directory: contract.directory,
        manualLoginCompleted: profile?.manualLoginCompleted === true,
        headlessReuseVerified: profile?.headlessReuseVerified === true,
        cookieValuesRead: false,
      });
    }
  } catch (error) {
    for (const contract of browserProfileContracts) {
      checks.push({ name: `browser-profile-${contract.id}`, ok: false, error: error instanceof Error ? error.message : String(error) });
      browserProfileReport.push({ id: contract.id, workflowCode: contract.workflowCode, directory: contract.directory, manualLoginCompleted: false, headlessReuseVerified: false, cookieValuesRead: false });
    }
  }
  try {
    const configuredRulesPath = assertCanonicalCategoryRulesPath(verifiedDataRoot, n8n.MERCHROUTE_CATEGORY_RULES_FILE);
    const rules = await verifyCategoryRulesFiles(categoryRulesRepositoryPath, configuredRulesPath);
    checks.push({ name: 'category-scene-rules-file', ok: rules.sha256 === state.categoryRulesSha256, sha256: rules.sha256 });
  } catch (error) {
    checks.push({ name: 'category-scene-rules-file', ok: false, error: error instanceof Error ? error.message : String(error) });
  }
  const composePrefix = ['compose', '--env-file', deploymentEnvPath, '-f', path.join(projectRoot, 'deployment', 'postgres', 'compose.yaml'), 'exec', '-T', 'postgres', 'sh', '-eu', '-c'];
  const databaseCheck = (script) => spawnSync('docker', [...composePrefix, script], { cwd: projectRoot, encoding: 'utf8', windowsHide: true });
  const merchrouteOwn = databaseCheck('PGPASSWORD="$MERCHROUTE_DB_PASSWORD" psql -h 127.0.0.1 -U merchroute_app -d merchroute -Atqc "select current_user || chr(58) || current_database()"');
  const n8nOwn = databaseCheck('PGPASSWORD="$N8N_DB_PASSWORD" psql -h 127.0.0.1 -U merchroute_n8n -d merchroute_n8n -Atqc "select current_user || chr(58) || current_database()"');
  const merchrouteCross = databaseCheck('PGPASSWORD="$MERCHROUTE_DB_PASSWORD" psql -h 127.0.0.1 -U merchroute_app -d merchroute_n8n -Atqc "select 1"');
  const n8nCross = databaseCheck('PGPASSWORD="$N8N_DB_PASSWORD" psql -h 127.0.0.1 -U merchroute_n8n -d merchroute -Atqc "select 1"');
  checks.push({ name: 'merchroute-database-role', ok: merchrouteOwn.status === 0 && merchrouteOwn.stdout.trim() === 'merchroute_app:merchroute' });
  checks.push({ name: 'n8n-database-role', ok: n8nOwn.status === 0 && n8nOwn.stdout.trim() === 'merchroute_n8n:merchroute_n8n' });
  checks.push({ name: 'database-role-isolation', ok: merchrouteCross.status !== 0 && n8nCross.status !== 0 });
  for (const [name, url] of [['merchroute', merchrouteApiUrl('/api/v1/health')], ['n8n', 'http://127.0.0.1:5678/healthz'], ['jimeng', 'http://127.0.0.1:8000/ping']]) {
    try { const response = await fetch(url); checks.push({ name: `${name}-health`, ok: response.ok, status: response.status }); }
    catch { checks.push({ name: `${name}-health`, ok: false }); }
  }
  const expectedE007 = expectedE007Stage(verifiedDataRoot);
  try {
    const configView = await requestJson(merchrouteApiUrl('/api/v1/config'));
    const e007 = configView.config?.stages?.find((stage) => stage.id === 'E007');
    checks.push({ name: 'merchroute-e007-config', ok: e007ConfigMismatches(e007, expectedE007).length === 0 });
    checks.push({ name: 'download-projection-sync-state', ok: configView.downloadSync?.status === 'synced' });
  } catch (error) {
    checks.push({ name: 'merchroute-e007-config', ok: false, error: error instanceof Error ? error.message : String(error) });
    checks.push({ name: 'download-projection-sync-state', ok: false });
  }
  try {
    const parameterView = await requestJson(merchrouteApiUrl('/api/v1/workflow-parameters/E007'));
    checks.push({
      name: 'merchroute-e007-parameters',
      ok: parameterView.parameters?.SKU === ''
        && parameterView.parameters?.productName === ''
        && parameterView.parameters?.productUrl === ''
        && samePath(parameterView.parameters?.parentOutputDir || '', expectedE007.candidateRoot),
    });
  } catch (error) {
    checks.push({ name: 'merchroute-e007-parameters', ok: false, error: error instanceof Error ? error.message : String(error) });
  }
  try {
    const projection = await requestJson(merchrouteApiUrl('/api/v1/download-workflows?includeDisabled=true'));
    const e007 = projection.items?.find((item) => item.code === 'E007');
    checks.push({
      name: 'postgres-e007-download-projection',
      ok: Boolean(e007)
        && e007.webhookUrl === expectedE007.download.webhookUrl
        && samePath(e007.parentOutputDir || '', expectedE007.candidateRoot)
        && e007.recoveryMode === expectedE007.download.recoveryMode,
    });
  } catch (error) {
    checks.push({ name: 'postgres-e007-download-projection', ok: false, error: error instanceof Error ? error.message : String(error) });
  }
  const n8nCommand = process.env.N8N_COMMAND || (process.platform === 'win32' ? path.join(process.env.APPDATA || '', 'npm', 'n8n.cmd') : 'n8n');
  const exportRoot = await mkdtemp(path.join(stateDir, '.workflow-readback-'));
  try {
    execFileSync(n8nCommand, ['export:workflow', '--backup', `--output=${exportRoot}`], {
      cwd: projectRoot,
      env: { ...process.env, ...deployment, ...merchroute, ...n8n },
      encoding: 'utf8',
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const workflowFiles = (await readdir(exportRoot)).filter((file) => file.endsWith('.json'));
    const workflows = await Promise.all(workflowFiles.map(async (file) => JSON.parse(await readFile(path.join(exportRoot, file), 'utf8'))));
    const expectedWorkflowIds = [...manifest.workflows.map((workflow) => workflow.id)].sort();
    const actualWorkflowIds = [...workflows.map((workflow) => workflow.id)].sort();
    const e007 = workflows.find((workflow) => workflow.id === 'G8MSbp9u0dudSgba');
    checks.push({ name: 'n8n-workflow-readback', ok: workflows.length === 36, count: workflows.length });
    checks.push({ name: 'n8n-workflow-id-set', ok: JSON.stringify(actualWorkflowIds) === JSON.stringify(expectedWorkflowIds) });
    checks.push({ name: 'n8n-all-inactive', ok: workflows.length === 36 && workflows.every((workflow) => workflow.active === false) });
    checks.push({ name: 'n8n-e007-inactive', ok: e007?.name === 'E007-v01-1688产品媒体下载' && e007.active === false });
    checks.push({ name: 'n8n-e007-timeout', ok: e007?.settings?.executionTimeout === 1200, seconds: e007?.settings?.executionTimeout ?? null });
    try {
      assertMaterializedLocalFileTriggerPaths(workflows, verifiedDataRoot);
      checks.push({ name: 'n8n-e001-e005-local-trigger-paths', ok: true });
    } catch (error) {
      checks.push({ name: 'n8n-e001-e005-local-trigger-paths', ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  } finally {
    await rm(exportRoot, { recursive: true, force: true });
  }
  const failed = checks.filter((item) => !item.ok);
  const report = {
    schemaVersion: 1,
    verifiedAt: new Date().toISOString(),
    platform: `${process.platform}-${process.arch}`,
    gitCommit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: projectRoot, encoding: 'utf8' }).trim(),
    appHome,
    dataRoot: verifiedDataRoot,
    versions,
    services: {
      merchroute: merchrouteBaseUrl,
      n8n: 'http://127.0.0.1:5678',
      jimeng: 'http://127.0.0.1:8000',
      postgresql: '127.0.0.1:5432',
    },
    checks,
    workflowCount: manifest.workflowCount,
    workflowActivation: 'inactive',
    credentialProbes: probeResults.probes,
    browserProfiles: browserProfileReport,
    secretsIncluded: false,
  };
  await writePrivate(path.join(stateDir, 'deployment-report.json'), `${JSON.stringify(report, null, 2)}\n`, { overwrite: true });
  console.log(JSON.stringify(report, null, 2));
  if (failed.length) process.exitCode = 1;
}

switch (command) {
  case 'prepare': await prepare(); break;
  case 'browser-profiles': await initializeBrowserProfiles(); break;
  case 'verify-browser-profiles': await verifyBrowserProfiles(); break;
  case 'configure-merchroute': await configureMerchRouteE007(); break;
  case 'import-n8n': await runImport(); break;
  case 'probe': await probe(); break;
  case 'verify': await verify(); break;
  default:
    console.log('用法: node deployment/scripts/bootstrap.mjs prepare|browser-profiles|verify-browser-profiles|configure-merchroute|import-n8n|probe|verify [--dry-run] [--profile=pdd|1688|all] [--force] [--app-home=ABS] [--data-root=ABS] [--browser-profile-root=ABS]');
}
