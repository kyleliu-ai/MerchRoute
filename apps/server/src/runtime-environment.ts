import { statSync } from 'node:fs';
import path from 'node:path';
import dotenv from 'dotenv';

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
  const runtimeEnvLoaded = loadEnvFile(runtimeEnvFile, env, Boolean(configuredRuntimeEnvFile));

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

  return { projectEnvFile, runtimeEnvFile, runtimeEnvLoaded };
}

function loadEnvFile(filePath: string, env: NodeJS.ProcessEnv, required: boolean): boolean {
  try {
    const info = statSync(filePath);
    if (!info.isFile()) throw new Error(`环境配置路径不是普通文件：${filePath}`);
  } catch (error: any) {
    if (!required && error?.code === 'ENOENT') return false;
    if (error?.code === 'ENOENT') throw new Error(`环境配置文件不存在：${filePath}`);
    throw error;
  }
  const result = dotenv.config({
    path: filePath,
    processEnv: env as Record<string, string>,
    override: false,
    quiet: true
  });
  if (result.error) throw new Error(`环境配置文件无法读取：${filePath}`);
  return true;
}

function assertCredentialEncryptionKey(value: string): void {
  const normalized = value.trim();
  const decoded = Buffer.from(normalized, 'base64');
  if (decoded.length !== 32 || decoded.toString('base64').replace(/=+$/, '') !== normalized.replace(/=+$/, '')) {
    throw new Error('MERCHROUTE_CREDENTIAL_ENCRYPTION_KEY 必须是 32 字节 Base64 密钥');
  }
}
