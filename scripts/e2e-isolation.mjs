import path from 'node:path';
import { randomBytes } from 'node:crypto';

const inheritedVariablesToRemove = new Set([
  'MERCHROUTE_ENV_FILE', 'MERCHROUTE_RUNTIME_ENV_FILE', 'MERCHROUTE_LEGACY_DATA_ROOT',
  'MERCHROUTE_GITHUB_TOKEN', 'GITHUB_TOKEN', 'GH_TOKEN', 'GITHUB_SHA', 'GIT_SHA',
  'GIT_COMMIT', 'BUILD_SHA'
]);

export function configureE2eEnvironment(env, { root, databaseUrl, port = 4183 }) {
  if (!path.isAbsolute(root)) throw new Error('E2E root must be an absolute test directory');
  const database = new URL(databaseUrl);
  if (!['postgres:', 'postgresql:'].includes(database.protocol)
    || !['127.0.0.1', 'localhost', '[::1]'].includes(database.hostname)
    || !/^-c search_path=pixroute_e2e_[a-f0-9]{32},public$/.test(database.searchParams.get('options') || '')) {
    throw new Error('E2E requires an explicit loopback database URL with its generated isolated schema');
  }
  if (!Number.isInteger(port) || port < 1 || port > 65535 || [4173, 43173].includes(port)) {
    throw new Error('E2E requires an isolated valid HTTP port, never a production runtime port');
  }
  for (const key of Object.keys(env)) {
    const name = key.toUpperCase();
    if (/^(?:WB_|OZON_|N8N_|MERCHROUTE_BUILD_)/.test(name) || inheritedVariablesToRemove.has(name)) delete env[key];
  }
  Object.assign(env, {
    DATABASE_URL: database.toString(),
    APP_DATA_DIR: path.join(root, 'app'),
    MERCHROUTE_DATA_ROOT: path.join(root, 'roots'),
    DOWNLOAD_CONFIG_SYNC: 'false',
    MERCHROUTE_OZON_MULTISTORE_FLEET_READY: 'false',
    MERCHROUTE_OZON_SOURCE_MEDIA_CLEANUP_ENABLED: 'false',
    MERCHROUTE_RUNTIME_KEY: randomBytes(32).toString('base64url'),
    MERCHROUTE_CREDENTIAL_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
    HOST: '127.0.0.1',
    PORT: String(port),
    NODE_ENV: 'test'
  });
}

// Browser/API test requests run in Playwright's process. The E2E application
// itself must never contact n8n, marketplaces, paid generation or other HTTP APIs.
export function blockE2eOutboundHttp(target = globalThis) {
  const originalFetch = target.fetch;
  const blockedRequests = [];
  target.fetch = async (input, options) => {
    let origin = 'invalid-url';
    try { origin = new URL(typeof input === 'string' || input instanceof URL ? input : input.url).origin; } catch { /* Do not expose an untrusted URL. */ }
    const method = String(options?.method || input?.method || 'GET').toUpperCase();
    blockedRequests.push({ origin, method });
    const error = new Error(`E2E_OUTBOUND_HTTP_BLOCKED: ${method} ${origin}`);
    error.code = 'E2E_OUTBOUND_HTTP_BLOCKED';
    throw error;
  };
  return { blockedRequests, restore: () => { target.fetch = originalFetch; } };
}
