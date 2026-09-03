import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import test from 'node:test';
import { blockE2eOutboundHttp, configureE2eEnvironment } from './e2e-isolation.mjs';
import { assertE2eSetupMayReplaceRoot, e2eDatabaseIdentity, isolatedE2eSchema, requestE2eShutdown, startE2eLifecycle } from './e2e-lifecycle.mjs';

const root = path.resolve('.e2e-data');
const database = new URL('postgresql://test_user@127.0.0.1:55483/test_database');
database.searchParams.set('options', `-c search_path=pixroute_e2e_${'a'.repeat(32)},public`);

test('replaces inherited production roots, keys and build overrides without keeping integration credentials', () => {
  const env = {
    PATH: 'preserved-toolchain-path', DATABASE_URL: 'postgresql://production.invalid/live',
    APP_DATA_DIR: 'production-app', MERCHROUTE_DATA_ROOT: 'production-media',
    MERCHROUTE_ENV_FILE: 'production.env', MERCHROUTE_RUNTIME_ENV_FILE: 'production-runtime.env',
    MERCHROUTE_LEGACY_DATA_ROOT: 'production-legacy', MERCHROUTE_BUILD_INFO_PATH: 'production-build.json',
    MERCHROUTE_BUILD_SHA: 'old-sha', GITHUB_SHA: 'old-github-sha', BUILD_SHA: 'old-build-sha',
    MERCHROUTE_GITHUB_TOKEN: 'synthetic-inherited-github-value', GH_TOKEN: 'synthetic-inherited-gh-value',
    WB_AUTOMATION_BASE_URL: 'http://127.0.0.1:5678', WB_AUTOMATION_KEY: 'synthetic-inherited-wb-value',
    WB_P003_WEBHOOK_URL: 'http://127.0.0.1:5678/webhook/admin',
    OZON_AUTOMATION_BASE_URL: 'http://127.0.0.1:5678', OZON_AUTOMATION_KEY: 'synthetic-inherited-ozon-value',
    N8N_API_KEY: 'synthetic-inherited-n8n-value', N8N_API_URL: 'http://127.0.0.1:5678',
    MERCHROUTE_RUNTIME_KEY: 'synthetic-inherited-runtime-value',
    MERCHROUTE_CREDENTIAL_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString('base64'),
    MERCHROUTE_OZON_MULTISTORE_FLEET_READY: 'true', MERCHROUTE_OZON_SOURCE_MEDIA_CLEANUP_ENABLED: 'true',
    HOST: '0.0.0.0', PORT: '4173', DOWNLOAD_CONFIG_SYNC: 'true'
  };
  configureE2eEnvironment(env, { root, databaseUrl: database.toString() });
  assert.equal(env.PATH, 'preserved-toolchain-path');
  assert.equal(env.DATABASE_URL, database.toString());
  assert.equal(env.APP_DATA_DIR, path.join(root, 'app'));
  assert.equal(env.MERCHROUTE_DATA_ROOT, path.join(root, 'roots'));
  assert.equal(env.HOST, '127.0.0.1');
  assert.equal(env.PORT, '4183');
  assert.equal(env.DOWNLOAD_CONFIG_SYNC, 'false');
  assert.equal(env.MERCHROUTE_OZON_MULTISTORE_FLEET_READY, 'false');
  assert.equal(env.MERCHROUTE_OZON_SOURCE_MEDIA_CLEANUP_ENABLED, 'false');
  assert.equal(env.MERCHROUTE_ENV_FILE, undefined);
  assert.equal(env.MERCHROUTE_RUNTIME_ENV_FILE, undefined);
  assert.equal(env.MERCHROUTE_LEGACY_DATA_ROOT, undefined);
  assert.equal(env.MERCHROUTE_GITHUB_TOKEN, undefined);
  assert.equal(env.GH_TOKEN, undefined);
  assert.equal(env.GITHUB_SHA, undefined);
  assert.equal(env.BUILD_SHA, undefined);
  assert.equal(Object.keys(env).some((key) => /^(WB_|OZON_|N8N_|MERCHROUTE_BUILD_)/.test(key)), false);
  assert.notEqual(env.MERCHROUTE_RUNTIME_KEY, 'synthetic-inherited-runtime-value');
  assert.notEqual(env.MERCHROUTE_CREDENTIAL_ENCRYPTION_KEY, Buffer.alloc(32, 1).toString('base64'));
  assert.equal(Buffer.from(env.MERCHROUTE_CREDENTIAL_ENCRYPTION_KEY, 'base64').length, 32);
  const firstKey = env.MERCHROUTE_RUNTIME_KEY;
  configureE2eEnvironment(env, { root, databaseUrl: database.toString() });
  assert.notEqual(env.MERCHROUTE_RUNTIME_KEY, firstKey);
});

test('rejects non-isolated database URLs or production HTTP port before changing the environment', () => {
  for (const databaseUrl of ['postgresql://test_user@127.0.0.1:55483/test_database', database.toString().replace('127.0.0.1', 'production.invalid')]) {
    const env = { SENTINEL: 'unchanged' };
    assert.throws(() => configureE2eEnvironment(env, { root, databaseUrl }), /isolated schema/);
    assert.deepEqual(env, { SENTINEL: 'unchanged' });
  }
  assert.throws(() => configureE2eEnvironment({}, { root, databaseUrl: database.toString(), port: 4173 }), /never production port 4173/);
});

test('blocks n8n and marketplace HTTP calls without invoking the underlying fetch or leaking URL secrets', async () => {
  let actualCalls = 0;
  const originalFetch = async () => { actualCalls += 1; throw new Error('must not be invoked'); };
  const target = { fetch: originalFetch };
  const guard = blockE2eOutboundHttp(target);
  await assert.rejects(target.fetch('http://127.0.0.1:5678/webhook/e2e?token=synthetic-sensitive-value', { method: 'POST' }), (error) => {
    assert.equal(error.code, 'E2E_OUTBOUND_HTTP_BLOCKED');
    assert.equal(error.message.includes('synthetic-sensitive-value'), false);
    return true;
  });
  await assert.rejects(target.fetch(new Request('https://api-seller.ozon.ru/v3/product/import', { method: 'POST' })), { code: 'E2E_OUTBOUND_HTTP_BLOCKED' });
  await assert.rejects(target.fetch(new URL('https://content-api.wildberries.ru/content/v2/cards/upload'), { method: 'POST' }), { code: 'E2E_OUTBOUND_HTTP_BLOCKED' });
  assert.equal(actualCalls, 0);
  assert.deepEqual(guard.blockedRequests, [
    { origin: 'http://127.0.0.1:5678', method: 'POST' },
    { origin: 'https://api-seller.ozon.ru', method: 'POST' },
    { origin: 'https://content-api.wildberries.ru', method: 'POST' }
  ]);
  guard.restore();
  assert.equal(target.fetch, originalFetch);
});

async function lifecycleFixture(t) {
  const parent = await mkdtemp(path.join(os.tmpdir(), 'merchroute-e2e-lifecycle-'));
  const directory = path.join(parent, '.e2e-data');
  await mkdir(directory);
  t.after(() => rm(parent, { recursive: true, force: true }));
  return { root: directory, databaseUrl: database.toString(), pollIntervalMs: 5 };
}

test('E2E shutdown ACK follows app.close completion, and signal/repeated shutdown shares one close', async (t) => {
  const fixture = await lifecycleFixture(t);
  const events = [];
  let releaseClose;
  let signalCloseStarted;
  const closeStarted = new Promise((resolve) => { signalCloseStarted = resolve; });
  const gate = new Promise((resolve) => { releaseClose = resolve; });
  const lifecycle = await startE2eLifecycle({ ...fixture, close: async () => { events.push('close-start'); signalCloseStarted(); await gate; events.push('close-complete'); } });
  const stopped = requestE2eShutdown({ ...fixture, timeoutMs: 1_000 }).then(() => events.push('drop-schema-allowed'));
  await closeStarted;
  assert.deepEqual(events, ['close-start']);
  await assert.rejects(readFile(path.join(fixture.root, 'server-shutdown-ack.json')), { code: 'ENOENT' });
  const signalShutdown = lifecycle.shutdown('SIGTERM');
  releaseClose();
  await Promise.all([stopped, signalShutdown, lifecycle.shutdown('SIGINT')]);
  assert.deepEqual(events, ['close-start', 'close-complete', 'drop-schema-allowed']);
  const acknowledgement = JSON.parse(await readFile(path.join(fixture.root, 'server-shutdown-ack.json'), 'utf8'));
  assert.equal(acknowledgement.status, 'CLOSED');
  assert.equal(acknowledgement.pid, process.pid);
  assert.equal(acknowledgement.instanceId, lifecycle.identity.instanceId);
  assert.equal(acknowledgement.schema, isolatedE2eSchema(database.toString()));
});

test('E2E close failure and timeout never allow the schema-drop step', async (t) => {
  for (const mode of ['failure', 'timeout']) {
    const fixture = await lifecycleFixture(t);
    let releaseClose;
    const gate = new Promise((resolve) => { releaseClose = resolve; });
    const lifecycle = await startE2eLifecycle({ ...fixture, close: async () => {
      if (mode === 'failure') throw new Error('synthetic close failure');
      await gate;
    } });
    let dropped = false;
    await assert.rejects(requestE2eShutdown({ ...fixture, timeoutMs: 50 }).then(() => { dropped = true; }), /preserve the isolated schema/);
    assert.equal(dropped, false);
    assert.ok(await readFile(path.join(fixture.root, 'server-lifecycle.json')));
    releaseClose();
    await lifecycle.shutdown('TEST_CLEANUP').catch(() => {});
  }
});

test('E2E shutdown rejects a mismatched instance, PID or schema acknowledgement', async (t) => {
  for (const field of ['instanceId', 'pid', 'schema', 'databaseIdentitySha256']) {
    const fixture = await lifecycleFixture(t);
    const lifecycle = await startE2eLifecycle({ ...fixture, pollIntervalMs: 10_000, close: async () => {} });
    const acknowledgement = { ...lifecycle.identity, status: 'CLOSED', closedAt: new Date().toISOString() };
    acknowledgement[field] = field === 'pid' ? process.pid + 1 : 'mismatched';
    await writeFile(path.join(fixture.root, 'server-shutdown-ack.json'), JSON.stringify(acknowledgement));
    await assert.rejects(requestE2eShutdown({ ...fixture, timeoutMs: 100 }), /identity mismatch/);
    await lifecycle.shutdown('TEST_CLEANUP').catch(() => {});
  }
});

test('E2E lifecycle rejects production port, foreign schema, wrong control directory and missing server identity', async (t) => {
  const fixture = await lifecycleFixture(t);
  await assert.rejects(startE2eLifecycle({ ...fixture, port: 4173, close: async () => {} }), /production port 4173/);
  await assert.rejects(startE2eLifecycle({ ...fixture, root: path.dirname(fixture.root), close: async () => {} }), /real .e2e-data/);
  await assert.rejects(requestE2eShutdown(fixture), /identity does not match/);
  const lifecycle = await startE2eLifecycle({ ...fixture, close: async () => {} });
  const foreign = new URL(database);
  foreign.searchParams.set('options', `-c search_path=pixroute_e2e_${'b'.repeat(32)},public`);
  await assert.rejects(requestE2eShutdown({ ...fixture, databaseUrl: foreign.toString() }), /identity does not match/);
  await assert.rejects(readFile(path.join(fixture.root, 'server-shutdown-request.json')), { code: 'ENOENT' });
  await lifecycle.shutdown('TEST_CLEANUP');
});

test('E2E lifecycle does not overwrite stale records and rejects a foreign shutdown request', async (t) => {
  const stale = await lifecycleFixture(t);
  await writeFile(path.join(stale.root, 'server-shutdown-ack.json'), 'null');
  await assert.rejects(startE2eLifecycle({ ...stale, close: async () => {} }), /stale control records/);
  assert.equal(await readFile(path.join(stale.root, 'server-shutdown-ack.json'), 'utf8'), 'null');

  const fixture = await lifecycleFixture(t);
  const lifecycle = await startE2eLifecycle({ ...fixture, close: async () => {} });
  await writeFile(path.join(fixture.root, 'server-shutdown-request.json'), JSON.stringify({
    ...lifecycle.identity, pid: process.pid + 1, requestedAt: new Date().toISOString()
  }));
  await assert.rejects(requestE2eShutdown({ ...fixture, timeoutMs: 100 }), /identity mismatch/);
  await lifecycle.shutdown('TEST_CLEANUP').catch(() => {});
});

test('E2E lifecycle binds the database endpoint and name without storing credentials', async (t) => {
  const fixture = await lifecycleFixture(t);
  const lifecycle = await startE2eLifecycle({ ...fixture, close: async () => {} });
  for (const field of ['port', 'pathname']) {
    const foreign = new URL(database);
    foreign[field] = field === 'port' ? '55484' : '/different_test_database';
    await assert.rejects(requestE2eShutdown({ ...fixture, databaseUrl: foreign.toString() }), /identity does not match/);
  }
  const differentCredentials = new URL(database);
  differentCredentials.username = 'another_test_user';
  differentCredentials.password = 'synthetic-test-password';
  assert.equal(e2eDatabaseIdentity(differentCredentials.toString()), e2eDatabaseIdentity(database.toString()));
  const serialized = await readFile(path.join(fixture.root, 'server-lifecycle.json'), 'utf8');
  assert.equal(serialized.includes('synthetic-test-password'), false);
  assert.equal(serialized.includes('test_user'), false);
  await assert.rejects(readFile(path.join(fixture.root, 'server-shutdown-request.json')), { code: 'ENOENT' });
  await lifecycle.shutdown('TEST_CLEANUP');
});

test('E2E setup preserves an unclosed instance or retained schema and only replaces a closed clean run', async (t) => {
  const fixture = await lifecycleFixture(t);
  await assertE2eSetupMayReplaceRoot(fixture);
  const lifecycle = await startE2eLifecycle({ ...fixture, close: async () => {} });
  await assert.rejects(assertE2eSetupMayReplaceRoot(fixture), /identity mismatch/);
  await lifecycle.shutdown('TEST_CLEANUP');
  await assertE2eSetupMayReplaceRoot(fixture);
  await writeFile(path.join(fixture.root, 'database-schema.txt'), lifecycle.identity.schema);
  await assert.rejects(assertE2eSetupMayReplaceRoot(fixture), /retained schema/);
  assert.equal(await readFile(path.join(fixture.root, 'database-schema.txt'), 'utf8'), lifecycle.identity.schema);
});
