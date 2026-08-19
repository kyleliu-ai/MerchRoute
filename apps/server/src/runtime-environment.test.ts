import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadRuntimeEnvironment } from './runtime-environment.js';

const credentialKey = Buffer.alloc(32, 7).toString('base64');
const otherCredentialKey = Buffer.alloc(32, 9).toString('base64');

describe('loadRuntimeEnvironment', () => {
  let root = '';

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'merchroute-runtime-env-'));
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    if (root) await rm(root, { recursive: true, force: true });
  });

  it('loads .env first and the default .env.runtime without overriding existing values', async () => {
    await writeFile(path.join(root, '.env'), 'DATABASE_URL=postgresql://example.invalid/db\n', 'utf8');
    await writeFile(path.join(root, '.env.runtime'), [
      'MERCHROUTE_RUNTIME_KEY=file-runtime-key',
      `MERCHROUTE_CREDENTIAL_ENCRYPTION_KEY=${credentialKey}`,
      'MERCHROUTE_OZON_MULTISTORE_FLEET_READY=true',
      'MERCHROUTE_OZON_SOURCE_MEDIA_CLEANUP_ENABLED=true',
      ''
    ].join('\n'), 'utf8');
    const env: NodeJS.ProcessEnv = { MERCHROUTE_RUNTIME_KEY: 'injected-runtime-key' };

    const result = loadRuntimeEnvironment({ projectRoot: root, env });

    expect(result).toEqual({
      projectEnvFile: path.join(root, '.env'),
      runtimeEnvFile: path.join(root, '.env.runtime'),
      runtimeEnvLoaded: true
    });
    expect(env).toMatchObject({
      DATABASE_URL: 'postgresql://example.invalid/db',
      MERCHROUTE_RUNTIME_KEY: 'injected-runtime-key',
      MERCHROUTE_CREDENTIAL_ENCRYPTION_KEY: credentialKey,
      MERCHROUTE_OZON_MULTISTORE_FLEET_READY: 'true',
      MERCHROUTE_OZON_SOURCE_MEDIA_CLEANUP_ENABLED: 'true'
    });
  });

  it('honors an absolute MERCHROUTE_RUNTIME_ENV_FILE loaded from .env', async () => {
    const custom = path.join(root, 'private', 'runtime.env');
    await writeFile(path.join(root, '.env'), `MERCHROUTE_RUNTIME_ENV_FILE=${custom.replace(/\\/g, '/')}\n`, 'utf8');
    await mkdir(path.dirname(custom), { recursive: true });
    await writeFile(custom, [
      'MERCHROUTE_RUNTIME_KEY=custom-runtime-key',
      `MERCHROUTE_CREDENTIAL_ENCRYPTION_KEY=${credentialKey}`,
      ''
    ].join('\n'), 'utf8');
    const env: NodeJS.ProcessEnv = {};

    const result = loadRuntimeEnvironment({ projectRoot: root, env });

    expect(result.runtimeEnvFile).toBe(custom);
    expect(env.MERCHROUTE_RUNTIME_KEY).toBe('custom-runtime-key');
  });

  it('prefers the canonical MERCHROUTE_ENV_FILE and accepts the legacy alias only when both agree', async () => {
    const custom = path.join(root, 'private', 'runtime.env');
    await mkdir(path.dirname(custom), { recursive: true });
    await writeFile(custom, [
      'MERCHROUTE_RUNTIME_KEY=canonical-runtime-key',
      `MERCHROUTE_CREDENTIAL_ENCRYPTION_KEY=${credentialKey}`,
      ''
    ].join('\n'), 'utf8');
    const env: NodeJS.ProcessEnv = {
      MERCHROUTE_ENV_FILE: custom,
      MERCHROUTE_RUNTIME_ENV_FILE: custom
    };

    const result = loadRuntimeEnvironment({ projectRoot: root, env });

    expect(result.runtimeEnvFile).toBe(custom);
    expect(env.MERCHROUTE_RUNTIME_KEY).toBe('canonical-runtime-key');
  });

  it('rejects conflicting canonical and legacy runtime env files', () => {
    expect(() => loadRuntimeEnvironment({
      projectRoot: root,
      env: {
        MERCHROUTE_ENV_FILE: path.join(root, 'one.env'),
        MERCHROUTE_RUNTIME_ENV_FILE: path.join(root, 'two.env')
      }
    })).toThrow(/不能指向不同文件/);
  });

  it('keeps process-injected runtime values when the runtime file contains different values', async () => {
    await writeFile(path.join(root, '.env.runtime'), [
      'MERCHROUTE_RUNTIME_KEY=file-runtime-key',
      `MERCHROUTE_CREDENTIAL_ENCRYPTION_KEY=${credentialKey}`,
      'MERCHROUTE_OZON_MULTISTORE_FLEET_READY=true',
      ''
    ].join('\n'), 'utf8');
    const env: NodeJS.ProcessEnv = {
      MERCHROUTE_RUNTIME_KEY: 'injected-runtime-key',
      MERCHROUTE_CREDENTIAL_ENCRYPTION_KEY: otherCredentialKey,
      MERCHROUTE_OZON_MULTISTORE_FLEET_READY: 'false'
    };

    loadRuntimeEnvironment({ projectRoot: root, env });

    expect(env).toMatchObject({
      MERCHROUTE_RUNTIME_KEY: 'injected-runtime-key',
      MERCHROUTE_CREDENTIAL_ENCRYPTION_KEY: otherCredentialKey,
      MERCHROUTE_OZON_MULTISTORE_FLEET_READY: 'false'
    });
  });

  it('fails closed when either required runtime secret is missing', () => {
    expect(() => loadRuntimeEnvironment({
      projectRoot: root,
      env: { MERCHROUTE_CREDENTIAL_ENCRYPTION_KEY: credentialKey }
    })).toThrow(/MERCHROUTE_RUNTIME_KEY 未配置/);
    expect(() => loadRuntimeEnvironment({
      projectRoot: root,
      env: { MERCHROUTE_RUNTIME_KEY: 'runtime-key' }
    })).toThrow(/MERCHROUTE_CREDENTIAL_ENCRYPTION_KEY 未配置/);
  });

  it('rejects invalid encryption, fleet, and source-cleanup configuration without exposing values', () => {
    const runtimeSecret = 'runtime-secret-must-not-be-logged';
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    expect(() => loadRuntimeEnvironment({
      projectRoot: root,
      env: {
        MERCHROUTE_RUNTIME_KEY: runtimeSecret,
        MERCHROUTE_CREDENTIAL_ENCRYPTION_KEY: 'not-base64'
      }
    })).toThrow(/32 字节 Base64/);
    expect(() => loadRuntimeEnvironment({
      projectRoot: root,
      env: {
        MERCHROUTE_RUNTIME_KEY: runtimeSecret,
        MERCHROUTE_CREDENTIAL_ENCRYPTION_KEY: credentialKey,
        MERCHROUTE_OZON_MULTISTORE_FLEET_READY: 'sometimes'
      }
    })).toThrow(/必须是布尔值/);
    expect(() => loadRuntimeEnvironment({
      projectRoot: root,
      env: {
        MERCHROUTE_RUNTIME_KEY: runtimeSecret,
        MERCHROUTE_CREDENTIAL_ENCRYPTION_KEY: credentialKey,
        MERCHROUTE_OZON_SOURCE_MEDIA_CLEANUP_ENABLED: 'sometimes'
      }
    })).toThrow(/必须是布尔值/);

    expect(JSON.stringify([...log.mock.calls, ...error.mock.calls])).not.toContain(runtimeSecret);
  });

  it('rejects a missing explicitly configured runtime file', () => {
    expect(() => loadRuntimeEnvironment({
      projectRoot: root,
      env: {
        MERCHROUTE_RUNTIME_ENV_FILE: path.join(root, 'missing-runtime.env'),
        MERCHROUTE_RUNTIME_KEY: 'runtime-key',
        MERCHROUTE_CREDENTIAL_ENCRYPTION_KEY: credentialKey
      }
    })).toThrow(/环境配置文件不存在/);
  });

  it('requires an absolute custom runtime file path', () => {
    expect(() => loadRuntimeEnvironment({
      projectRoot: root,
      env: {
        MERCHROUTE_RUNTIME_ENV_FILE: 'relative/runtime.env',
        MERCHROUTE_RUNTIME_KEY: 'runtime-key',
        MERCHROUTE_CREDENTIAL_ENCRYPTION_KEY: credentialKey
      }
    })).toThrow(/必须是绝对路径/);
    expect(() => loadRuntimeEnvironment({
      projectRoot: root,
      env: {
        MERCHROUTE_ENV_FILE: 'relative/runtime.env',
        MERCHROUTE_RUNTIME_KEY: 'runtime-key',
        MERCHROUTE_CREDENTIAL_ENCRYPTION_KEY: credentialKey
      }
    })).toThrow(/必须是绝对路径/);
  });
});
