import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import dotenv from 'dotenv';
import { resolveRuntimeEndpoint, type RuntimeEndpoint } from './runtime-endpoint.js';

const REQUIRED_RUNTIME_VARIABLES = [
  'MERCHROUTE_RUNTIME_KEY',
  'MERCHROUTE_CREDENTIAL_ENCRYPTION_KEY'
] as const;

const BOOLEAN_RUNTIME_VARIABLES = [
  'MERCHROUTE_OZON_MULTISTORE_FLEET_READY',
  'MERCHROUTE_OZON_SOURCE_MEDIA_CLEANUP_ENABLED'
] as const;

type RuntimeEnvironmentOptions = {
  projectRoot: string;
  env?: NodeJS.ProcessEnv;
};

export type RuntimeEnvironmentResult = {
  projectEnvFile: string;
  runtimeEnvFile: string;
  runtimeEnvLoaded: boolean;
  runtimeEndpoint: RuntimeEndpoint;
};

export function loadRuntimeEnvironment(options: RuntimeEnvironmentOptions): RuntimeEnvironmentResult {
  const env = options.env ?? process.env;
  const projectRoot = path.resolve(options.projectRoot);
  const projectEnvFile = path.join(projectRoot, '.env');
  loadEnvFile(projectEnvFile, env, false);

  const configuredEnvFile = String(env.MERCHROUTE_ENV_FILE || '').trim();
  const legacyRuntimeEnvFile = String(env.MERCHROUTE_RUNTIME_ENV_FILE || '').trim();
  if (configuredEnvFile && legacyRuntimeEnvFile && path.resolve(configuredEnvFile) !== path.resolve(legacyRuntimeEnvFile)) {
    throw new Error('MERCHROUTE_ENV_FILE 与 MERCHROUTE_RUNTIME_ENV_FILE 不能指向不同文件');
  }
  const configuredRuntimeEnvFile = configuredEnvFile || legacyRuntimeEnvFile;
  if (configuredRuntimeEnvFile && !path.isAbsolute(configuredRuntimeEnvFile)) {
    throw new Error('MERCHROUTE_ENV_FILE（或兼容变量 MERCHROUTE_RUNTIME_ENV_FILE）必须是绝对路径');
  }
  const runtimeEnvFile = configuredRuntimeEnvFile
    ? path.resolve(configuredRuntimeEnvFile)
    : path.join(projectRoot, '.env.runtime');
  const runtimeFileValues = readEnvFile(runtimeEnvFile, Boolean(configuredRuntimeEnvFile));
  const runtimeEnvLoaded = Boolean(runtimeFileValues);
  if (runtimeFileValues) applyEnvValues(runtimeFileValues, env);

  const runtimeEndpoint = resolveRuntimeEndpoint(env);
  for (const [key, expected] of Object.entries({
    HOST: runtimeEndpoint.host,
    PORT: String(runtimeEndpoint.port),
    MERCHROUTE_PORT: String(runtimeEndpoint.port),
    MERCHROUTE_RUNTIME_BASE_URL: runtimeEndpoint.origin
  })) {
    const rawFromFile = String(runtimeFileValues?.[key] || '').trim();
    const fromFile = key === 'MERCHROUTE_RUNTIME_BASE_URL' ? rawFromFile.replace(/\/$/, '') : rawFromFile;
    if (fromFile && fromFile !== expected) throw new Error(`${key} 与已验收发布绑定不一致`);
  }
  env.HOST = runtimeEndpoint.host;
  env.PORT = String(runtimeEndpoint.port);
  env.MERCHROUTE_PORT = String(runtimeEndpoint.port);
  env.MERCHROUTE_RUNTIME_BASE_URL = runtimeEndpoint.origin;

  for (const variable of REQUIRED_RUNTIME_VARIABLES) {
    if (!String(env[variable] || '').trim()) {
      throw new Error(`${variable} 未配置；MerchRoute runtime 服务拒绝启动`);
    }
  }
  assertCredentialEncryptionKey(String(env.MERCHROUTE_CREDENTIAL_ENCRYPTION_KEY));

  for (const variable of BOOLEAN_RUNTIME_VARIABLES) {
    const value = String(env[variable] || '').trim();
    if (value && !/^(?:1|true|yes|on|0|false|no|off)$/i.test(value)) {
      throw new Error(`${variable} 必须是布尔值`);
    }
  }

  return { projectEnvFile, runtimeEnvFile, runtimeEnvLoaded, runtimeEndpoint };
}

function loadEnvFile(filePath: string, env: NodeJS.ProcessEnv, required: boolean): boolean {
  const values = readEnvFile(filePath, required);
  if (!values) return false;
  applyEnvValues(values, env);
  return true;
}

function readEnvFile(filePath: string, required: boolean): Record<string, string> | undefined {
  try {
    const info = statSync(filePath);
    if (!info.isFile()) throw new Error(`环境配置路径不是普通文件：${filePath}`);
  } catch (error: any) {
    if (!required && error?.code === 'ENOENT') return undefined;
    if (error?.code === 'ENOENT') throw new Error(`环境配置文件不存在：${filePath}`);
    throw error;
  }
  try { return dotenv.parse(readFileSync(filePath)); }
  catch { throw new Error(`环境配置文件无法读取：${filePath}`); }
}

function applyEnvValues(values: Record<string, string>, env: NodeJS.ProcessEnv): void {
  for (const [key, value] of Object.entries(values)) if (env[key] === undefined) env[key] = value;
}

function assertCredentialEncryptionKey(value: string): void {
  const normalized = value.trim();
  const decoded = Buffer.from(normalized, 'base64');
  if (decoded.length !== 32 || decoded.toString('base64').replace(/=+$/, '') !== normalized.replace(/=+$/, '')) {
    throw new Error('MERCHROUTE_CREDENTIAL_ENCRYPTION_KEY 必须是 32 字节 Base64 密钥');
  }
}
