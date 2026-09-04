import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { link, lstat, readFile, rm, writeFile } from 'node:fs/promises';

const identityKeys = ['schemaVersion', 'instanceId', 'databaseIdentitySha256', 'schema', 'pid', 'port', 'startedAt'];

export function e2eDatabaseIdentity(databaseUrl) {
  const database = new URL(databaseUrl);
  if (!['postgres:', 'postgresql:'].includes(database.protocol)
    || !['127.0.0.1', 'localhost', '[::1]'].includes(database.hostname)) {
    throw new Error('E2E lifecycle requires an explicit loopback PostgreSQL database');
  }
  // Credentials never enter the control records or diagnostics.
  return createHash('sha256').update(JSON.stringify({
    host: database.hostname.toLowerCase(), port: database.port || '5432', database: decodeURIComponent(database.pathname)
  })).digest('hex');
}

export function isolatedE2eSchema(databaseUrl) {
  const database = new URL(databaseUrl);
  const match = /^-c search_path=(pixroute_e2e_[a-f0-9]{32}),public$/.exec(database.searchParams.get('options') || '');
  if (!['postgres:', 'postgresql:'].includes(database.protocol)
    || !['127.0.0.1', 'localhost', '[::1]'].includes(database.hostname) || !match) {
    throw new Error('E2E lifecycle requires a loopback database and its exact isolated schema');
  }
  return match[1];
}

async function controlPaths(root) {
  const resolved = path.resolve(root);
  if (path.basename(resolved) !== '.e2e-data') throw new Error('E2E lifecycle control files must stay inside a real .e2e-data directory');
  const info = await lstat(resolved);
  if (path.basename(resolved) !== '.e2e-data' || !info.isDirectory() || info.isSymbolicLink()) {
    throw new Error('E2E lifecycle control files must stay inside a real .e2e-data directory');
  }
  return {
    identity: path.join(resolved, 'server-lifecycle.json'),
    request: path.join(resolved, 'server-shutdown-request.json'),
    acknowledgement: path.join(resolved, 'server-shutdown-ack.json')
  };
}

async function readControl(file) {
  const info = await lstat(file).catch((error) => {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  });
  if (!info) return undefined;
  if (!info.isFile() || info.isSymbolicLink()) throw new Error('E2E lifecycle rejects linked or non-file control records');
  return JSON.parse(await readFile(file, 'utf8'));
}

async function writeControl(file, value) {
  if (await readControl(file) !== undefined) throw new Error('E2E lifecycle refuses to replace an existing control record');
  const temporary = `${file}.${randomBytes(12).toString('hex')}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(value)}\n`, { flag: 'wx', mode: 0o600 });
    // Publish the complete file atomically without replacing a concurrent record.
    await link(temporary, file);
  } finally {
    await rm(temporary, { force: true });
  }
}

function validatePort(port) {
  if (!Number.isInteger(port) || port < 1 || port > 65535 || [4173, 43173].includes(port)) {
    throw new Error('E2E lifecycle forbids production runtime ports and requires a valid isolated port');
  }
}

function validateIdentity(identity, schema, port, databaseIdentitySha256) {
  validatePort(port);
  if (!identity || identity.schemaVersion !== 1 || !/^[a-f0-9]{64}$/.test(identity.instanceId)
    || !/^pixroute_e2e_[a-f0-9]{32}$/.test(identity.schema) || identity.schema !== schema || identity.port !== port
    || !/^[a-f0-9]{64}$/.test(identity.databaseIdentitySha256) || identity.databaseIdentitySha256 !== databaseIdentitySha256
    || !Number.isInteger(identity.pid) || identity.pid <= 0 || !Number.isFinite(Date.parse(identity.startedAt))) {
    throw new Error('E2E lifecycle identity does not match this isolated instance, schema and port');
  }
}

function assertSameIdentity(record, identity) {
  if (!record || identityKeys.some((key) => record[key] !== identity[key])) {
    throw new Error('E2E shutdown identity mismatch; preserve the isolated schema');
  }
}

// The application owns its ACK: it is published only after all app.close hooks,
// worker stops and database-pool closes have completed. No PID/port is killed.
export async function startE2eLifecycle({ root, databaseUrl, port = 4183, pid = process.pid, close, onResult = () => {}, pollIntervalMs = 50 }) {
  const schema = isolatedE2eSchema(databaseUrl);
  const databaseIdentitySha256 = e2eDatabaseIdentity(databaseUrl);
  const identity = { schemaVersion: 1, instanceId: randomBytes(32).toString('hex'), databaseIdentitySha256, schema, pid, port, startedAt: new Date().toISOString() };
  validateIdentity(identity, schema, port, databaseIdentitySha256);
  const files = await controlPaths(root);
  for (const file of Object.values(files)) {
    if (await readControl(file) !== undefined) throw new Error('E2E lifecycle found stale control records; preserve the isolated schema');
  }
  await writeControl(files.identity, identity);
  let closing;
  let reading = false;
  const timer = setInterval(() => { void poll(); }, pollIntervalMs);
  timer.unref();

  function shutdown(reason, controlError) {
    if (closing) return closing;
    clearInterval(timer);
    closing = (async () => {
      let failure = controlError;
      try { await close(reason); } catch (error) { failure ||= error; }
      try {
        await writeControl(files.acknowledgement, {
          ...identity, status: failure ? 'FAILED' : 'CLOSED', closedAt: new Date().toISOString(), reason
        });
      } catch (error) { failure ||= error; }
      onResult(failure ? 1 : 0, failure);
      if (failure) throw failure;
      return identity;
    })();
    return closing;
  }

  async function poll() {
    if (reading || closing) return;
    reading = true;
    try {
      assertSameIdentity(await readControl(files.identity), identity);
      const request = await readControl(files.request);
      if (request !== undefined) {
        assertSameIdentity(request, identity);
        if (!Number.isFinite(Date.parse(request.requestedAt))) throw new Error('Invalid E2E shutdown request timestamp');
        void shutdown('GLOBAL_TEARDOWN').catch(() => {});
      }
    } catch (error) {
      void shutdown('CONTROL_ERROR', error).catch(() => {});
    } finally { reading = false; }
  }
  return { identity, shutdown };
}

export async function requestE2eShutdown({ root, databaseUrl, port = 4183, timeoutMs = 15_000, pollIntervalMs = 50 }) {
  const schema = isolatedE2eSchema(databaseUrl);
  const files = await controlPaths(root);
  const identity = await readControl(files.identity);
  validateIdentity(identity, schema, port, e2eDatabaseIdentity(databaseUrl));
  const existing = await readControl(files.request);
  if (existing !== undefined) assertSameIdentity(existing, identity);
  else await writeControl(files.request, { ...identity, requestedAt: new Date().toISOString() });
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    assertSameIdentity(await readControl(files.identity), identity);
    const acknowledgement = await readControl(files.acknowledgement);
    if (acknowledgement !== undefined) {
      assertSameIdentity(acknowledgement, identity);
      if (acknowledgement.status !== 'CLOSED' || !Number.isFinite(Date.parse(acknowledgement.closedAt))) {
        throw new Error('E2E application did not close successfully; preserve the isolated schema');
      }
      return acknowledgement;
    }
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }
  throw new Error('E2E graceful shutdown timed out; preserve the isolated schema');
}

export async function assertE2eSetupMayReplaceRoot({ root }) {
  const files = await controlPaths(root).catch((error) => {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  });
  if (!files) return;
  for (const name of ['database-url.txt', 'database-schema.txt']) {
    const existing = await lstat(path.join(path.resolve(root), name)).catch((error) => {
      if (error.code === 'ENOENT') return undefined;
      throw error;
    });
    if (existing) throw new Error('Previous E2E database metadata still exists; preserve .e2e-data and resolve the retained schema before setup');
  }
  const identity = await readControl(files.identity);
  const request = await readControl(files.request);
  const acknowledgement = await readControl(files.acknowledgement);
  if (identity === undefined && request === undefined && acknowledgement === undefined) return;
  validateIdentity(identity, identity?.schema, identity?.port, identity?.databaseIdentitySha256);
  assertSameIdentity(acknowledgement, identity);
  if (acknowledgement.status !== 'CLOSED' || !Number.isFinite(Date.parse(acknowledgement.closedAt))) {
    throw new Error('Previous E2E instance is not CLOSED; preserve .e2e-data before setup');
  }
  if (request !== undefined) assertSameIdentity(request, identity);
}
