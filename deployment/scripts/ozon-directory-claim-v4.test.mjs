import assert from 'node:assert/strict';
import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import vm from 'node:vm';
import test from 'node:test';
import { patchOzonContentV4, POLICY_NODES, PATCH_NODES, DIRECTORY_FAILURE_NODE } from '../n8n/patches/ozon-content-v4.mjs';

const s000Id = '0FqozLuQ7vuabT8V', p002Id = 'g3KK68BLXX7eShqa';
const load = id => JSON.parse(fs.readFileSync(new URL(`../n8n/workflows/ozon/${id}.json`, import.meta.url), 'utf8'));
const nodeCode = (id, name) => load(id).nodes.find(node => node.name === name).parameters.jsCode;
const prepareName = '准备后端 intake 验证', claimName = '校验并认领任务目录';
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const digest = 'sha256:' + 'a'.repeat(64);
const uuid = digit => `${digit.repeat(8)}-${digit.repeat(4)}-4${digit.repeat(3)}-8${digit.repeat(3)}-${digit.repeat(12)}`;

// Entire S000 Code nodes run in a VM with an in-memory filesystem, no process,
// network, production paths or real directory operations (including Windows).
function fixture(paths = path.posix, policy = 'merchroute-ozon-content-v4', mode = 'VAULT') {
  const root = paths.resolve(paths.sep === '\\' ? 'X:/fixture/OZON' : '/fixture/OZON');
  const alias = mode === 'LEGACY_PUBLICATION' ? 'default' : 'fixture-store';
  const source = paths.join(root, 'stores', alias, 'inbox', '0000001');
  const productPath = paths.join(source, 'product.json');
  const markerPath = paths.join(source, '.ozon-intake.json');
  const input = {
    jobId: uuid('1'), taskId: alias + '__0000001__r1', storeId: mode === 'VAULT' ? uuid('2') : '00000000-0000-4000-8000-000000000002',
    publicationId: uuid('3'), credentialVersionId: mode === 'VAULT' ? uuid('4') : null,
    credentialBindingMode: mode, storeAlias: alias, sku: '0000001', revision: 1,
    storeConfigVersion: 1, warehouseId: 'fixture-warehouse', rowVersion: 10,
    leaseOwner: 'fixture-worker', leaseToken: uuid('5'), productJsonPath: productPath,
    contentPolicyVersion: policy, materialHash: digest, materialHashVersion: 'ozon-shared-material-v1',
    planHash: digest, presetRowVersion: 1, publicationMode: 'CREATE_ONLY',
    materializationHash: digest, offerContractHash: digest
  };
  const product = JSON.stringify({ schemaVersion: 2, productCode: input.sku, revision: 1, contentPolicyVersion: policy, offers: [{ offerId: '0000001-01' }] });
  const marker = { ...input, productContentHash: hash(product), ticket: 'hmac-sha256:' + 'b'.repeat(64) };
  const files = new Map([[productPath, Buffer.from(product)], [markerPath, Buffer.from(JSON.stringify(marker))],
    [paths.join(source, '_READY'), Buffer.from(JSON.stringify({ sku: input.sku, revision: 1 }))]]);
  const dirs = new Set(), symlinks = new Set(), moves = [];
  const mkdir = value => { for (let current = value; !dirs.has(current); current = paths.dirname(current)) { dirs.add(current); if (current === paths.dirname(current)) break; } };
  mkdir(source);
  const stat = value => {
    if (!files.has(value) && !dirs.has(value)) throw new Error('Unexpected fixture path: ' + value);
    return { isFile: () => files.has(value), isDirectory: () => dirs.has(value), isSymbolicLink: () => symlinks.has(value), mtimeMs: Date.now() };
  };
  const remove = value => {
    for (const target of [...files.keys(), ...dirs]) if (target === value || target.startsWith(value + paths.sep)) { files.delete(target); dirs.delete(target); }
  };
  const mockFs = {
    existsSync: value => files.has(value) || dirs.has(value), statSync: stat, lstatSync: stat,
    realpathSync: value => { stat(value); return value; },
    readFileSync: (value, encoding) => { assert.ok(files.has(value), 'Unexpected read: ' + value); return encoding ? files.get(value).toString(encoding) : files.get(value); },
    readdirSync: value => [...new Set([...dirs, ...files.keys()].filter(target => paths.dirname(target) === value && target !== value))]
      .map(target => ({ name: paths.basename(target), ...stat(target) })),
    mkdirSync: (value, options) => { if (dirs.has(value) && !options?.recursive) throw Object.assign(new Error('exists'), { code: 'EEXIST' }); mkdir(value); },
    writeFileSync: (value, data, options) => { if (options?.flag === 'wx') assert.ok(!files.has(value)); files.set(value, Buffer.from(data)); },
    renameSync: (from, to) => {
      assert.ok(dirs.has(from)); assert.ok(!dirs.has(to)); moves.push([from, to]);
      for (const target of [...dirs]) if (target === from || target.startsWith(from + paths.sep)) { dirs.delete(target); dirs.add(to + target.slice(from.length)); }
      for (const [target, bytes] of [...files]) if (target.startsWith(from + paths.sep)) { files.delete(target); files.set(to + target.slice(from.length), bytes); }
    },
    rmSync: remove
  };
  const evaluate = (name, snapshot = input, previous = {}) => vm.runInNewContext(`(function(){${nodeCode(s000Id, name)}\n})()`, {
    require: name => { const modules = { fs: mockFs, path: paths, crypto }; assert.ok(modules[name]); return modules[name]; },
    $: name => { assert.equal(name, 'When Executed by Another Workflow'); return { first: () => ({ json: snapshot }) }; },
    $input: { first: () => ({ json: previous }) }, $execution: { id: 'fixture-execution' }
  }, { timeout: 1000 });
  return { input, marker, markerPath, productPath, files, dirs, symlinks, moves, evaluate,
    saveMarker: () => files.set(markerPath, Buffer.from(JSON.stringify(marker))) };
}

function failureTransition(failure, sourceOverrides = {}, sourceCount = 1) {
  const source = { ...fixture().input, stageStates: { import: 'RETRY_PENDING' }, ...sourceOverrides };
  const sources = [{ json: source }];
  if (sourceCount === 2) sources.push({ json: { ...source, jobId: uuid('6'), taskId: 'second__0000001__r1' } });
  return vm.runInNewContext(`(function(){${nodeCode(p002Id, DIRECTORY_FAILURE_NODE)}\n})()`, {
    $env: { MERCHROUTE_RUNTIME_BASE_URL: 'http://merchroute.invalid' },
    $: name => { assert.equal(name, '准备原目录认领'); return { all: () => sources }; },
    $input: { all: () => [{ json: failure, pairedItem: { item: 0 } }] }
  }, { timeout: 1000 })[0].json;
}

for (const [platform, paths] of [['Windows', path.win32], ['macOS/Linux', path.posix]]) {
  for (const version of [2, 3, 4]) {
    for (const mode of ['VAULT', 'LEGACY_PUBLICATION']) {
      test(`S000 ${platform} v${version} ${mode}: verify, claim and replay retain original identity`, () => {
        const f = fixture(paths, `merchroute-ozon-content-v${version}`, mode);
        const prepared = f.evaluate(prepareName)[0].json;
        assert.equal(prepared.requiresBackendVerification, true);
        for (const key of ['jobId', 'taskId', 'storeId', 'publicationId', 'contentPolicyVersion', 'rowVersion', 'leaseToken']) {
          assert.equal(prepared.verificationRequest[key], f.input[key]);
        }
        assert.equal(f.moves.length, 0);
        const receipt = f.evaluate('校验 intake 验证回执', f.input, { statusCode: 200, body: { verified: true } })[0].json;
        const claimed = f.evaluate(claimName, f.input, receipt)[0].json;
        assert.equal(claimed.directoryStage, 'PROCESSING');
        for (const key of ['jobId', 'taskId', 'storeId', 'publicationId', 'contentPolicyVersion', 'rowVersion']) assert.equal(claimed[key], f.input[key]);
        assert.equal(f.moves.length, 1);
        assert.equal(f.evaluate(prepareName)[0].json.requiresBackendVerification, true);
        assert.equal(f.evaluate(claimName, f.input, receipt)[0].json.workDirectory, claimed.workDirectory);
        assert.equal(f.moves.length, 1, 'replay must not create another directory');
      });
    }
  }
}

test('S000 v4 preserves all required frozen fields at both gates', () => {
  const common = ['jobId', 'taskId', 'storeId', 'storeAlias', 'publicationId', 'credentialVersionId',
    'storeConfigVersion', 'warehouseId', 'rowVersion', 'leaseToken', 'contentPolicyVersion',
    'materialHash', 'materialHashVersion', 'planHash', 'presetRowVersion', 'publicationMode'];
  for (const name of [prepareName, claimName]) {
    for (const field of [...common, ...(name === claimName ? ['leaseOwner', 'offerContractHash', 'materializationHash'] : [])]) {
      const f = fixture(), snapshot = { ...f.input };
      delete snapshot[field];
      assert.throws(() => f.evaluate(name, snapshot, { intakeVerified: true }), /OZON_/, `${name}/${field}`);
      assert.equal(f.moves.length, 0);
    }
  }
});

test('S000 rejects unsupported policy versions at both gates', () => {
  for (const policy of ['', 'merchroute-ozon-content-v1', 'merchroute-ozon-content-v99']) {
    const f = fixture(path.posix, policy);
    assert.throws(() => f.evaluate(prepareName), /OZON_INTAKE_VERIFY_SNAPSHOT_INVALID/);
    assert.throws(() => f.evaluate(claimName, f.input, { intakeVerified: true }), /OZON_FROZEN_SNAPSHOT_INCOMPLETE/);
    assert.equal(f.moves.length, 0);
  }
});

test('S000 v4 still rejects conflicting marker bindings and product bytes', () => {
  for (const [field, value] of [['contentPolicyVersion', 'merchroute-ozon-content-v3'], ['warehouseId', 'other'],
    ['planHash', 'sha256:' + 'c'.repeat(64)], ['materialHash', 'sha256:' + 'c'.repeat(64)],
    ['presetRowVersion', 2], ['publicationMode', 'COMPATIBLE_UPSERT']]) {
    const f = fixture(); f.marker[field] = value; f.saveMarker();
    assert.throws(() => f.evaluate(prepareName), /OZON_INTAKE_VERIFY_MARKER_SNAPSHOT_MISMATCH/);
    assert.throws(() => f.evaluate(claimName, f.input, { intakeVerified: true }), /OZON_INTAKE_MARKER_CONFLICT/);
    assert.equal(f.moves.length, 0);
  }
  const f = fixture(); f.files.set(f.productPath, Buffer.from('{}'));
  assert.throws(() => f.evaluate(prepareName), /OZON_INTAKE_PRODUCT_CONTENT_HASH_MISMATCH/);
});

test('S000 preserves backend verification and symlink safety', () => {
  const f = fixture();
  assert.throws(() => f.evaluate(claimName), /OZON_INTAKE_BACKEND_VERIFY_REQUIRED/);
  f.symlinks.add(f.markerPath);
  assert.throws(() => f.evaluate(prepareName), /OZON_INTAKE_VERIFY_MARKER_INVALID/);
  assert.equal(f.moves.length, 0);
});

test('PURE_LEGACY bypass remains explicit and does not require v4', () => {
  const f = fixture();
  assert.equal(f.evaluate(prepareName, { credentialBindingMode: 'PURE_LEGACY' })[0].json.requiresBackendVerification, false);
  assert.throws(() => f.evaluate(prepareName, {}), /OZON_LEGACY_MODE_INVALID/);
});

test('S000 contract errors survive n8n message-only serialization and clear pending retries', () => {
  for (const name of [prepareName, claimName]) {
    const f = fixture(); const invalid = { ...f.input, contentPolicyVersion: 'future' };
    let error;
    try { f.evaluate(name, invalid, { intakeVerified: true }); } catch (caught) { error = caught; }
    assert.ok(error?.code);
    const result = failureTransition({ error: error.message + ' [line 6]' }, {
      jobPayload: { networkRecovery: { schemaVersion: 1, phase: 'DIRECTORY_CLAIM', status: 'WAITING_NETWORK', attempt: 4 } }
    });
    assert.equal(result.update.state, 'NEEDS_ATTENTION');
    assert.equal(result.update.eventType, 'OZON_DIRECTORY_CLAIM_REJECTED');
    assert.equal(result.update.errorCode, error.code);
    assert.equal(result.update.nextAttemptAt, null);
    assert.equal(result.update.networkRecovery, null);
    assert.equal(result.update.jobPayload.networkRecovery, null);
    assert.equal(result.update.stageStates.import, 'FAILED');
    assert.equal(result.jobId, f.input.jobId);
    assert.equal(result.update.rowVersion, f.input.rowVersion);
  }
});

test('P002 handles structured and legacy message-only snapshot errors', () => {
  for (const failure of [
    { error: { code: 'OZON_INTAKE_VERIFY_SNAPSHOT_INVALID', message: 'snapshot invalid' } },
    { code: 'OZON_FROZEN_SNAPSHOT_INCOMPLETE', message: 'snapshot invalid' },
    { error: '票据验证缺少完整 job/store/alias/credential/config/warehouse/rowVersion/leaseToken 冻结快照 [line 6]' },
    { error: '店铺任务不可变快照不完整' },
    { error: 'OZON_INTAKE_VERIFY_MARKER_SNAPSHOT_MISMATCH: invalid binding' },
    { error: 'OZON_INTAKE_PRODUCT_CONTENT_HASH_MISMATCH: product bytes changed' },
    { error: 'OZON_INTAKE_TICKET_INVALID: invalid ticket' }
  ]) assert.equal(failureTransition(failure).update.state, 'NEEDS_ATTENTION');
});

test('P002 preserves network, lock and unknown-outcome backoff instead of treating them as contract failures', () => {
  for (const failure of [{ error: 'fetch failed' }, { error: { code: 'ETIMEDOUT', message: 'request timeout' } },
    { error: 'OZON_INTAKE_LOCKED: 任务目录已被其他执行认领' },
    { error: 'OZON_INTAKE_BACKEND_VERIFY_FAILED: 后端 intake 票据验证未返回 2xx verified' }]) {
    const result = failureTransition(failure);
    assert.equal(result.update.state, 'SUBMITTING');
    assert.equal(result.update.eventType, 'OZON_DIRECTORY_CLAIM_RETRY_SCHEDULED');
    assert.equal(result.update.networkRecovery.status, 'WAITING_NETWORK');
    assert.equal(result.update.networkRecovery.deliveryState, 'NOT_SENT');
    assert.equal(result.update.stageStates.import, 'RETRY_PENDING');
  }
  const result = failureTransition({ error: 'fetch failed' }, { jobPayload: { networkRecovery: {
    schemaVersion: 1, phase: 'DIRECTORY_CLAIM', status: 'WAITING_NETWORK', attempt: 4, firstFailureAt: '2026-01-01T00:00:00.000Z'
  } } });
  assert.equal(result.update.networkRecovery.attempt, 5);
  assert.equal(result.update.networkRecovery.firstFailureAt, '2026-01-01T00:00:00.000Z');
  assert.equal(Date.parse(result.update.nextAttemptAt) - Date.parse(result.update.networkRecovery.lastFailureAt), 900000);
});

test('P002 failure mapping still refuses cross-job and store identity conflicts', () => {
  assert.throws(() => failureTransition({ jobId: uuid('6'), taskId: fixture().input.taskId, error: 'fetch failed' }, {}, 2), /不同冻结任务/);
  assert.throws(() => failureTransition({ storeId: uuid('7'), error: 'fetch failed' }), /冻结任务快照冲突/);
});

test('S000 and P002 patches are idempotent, narrowly scoped and fail closed on guard drift', () => {
  for (const id of [s000Id, p002Id]) {
    const workflow = load(id);
    assert.deepEqual(patchOzonContentV4(workflow), workflow);
    const old = structuredClone(workflow);
    for (const node of old.nodes.filter(node => POLICY_NODES[id].includes(node.name))) {
      node.parameters.jsCode = node.parameters.jsCode.replace(",'merchroute-ozon-content-v4'", '')
        .replace("new Error(code + ': ' + message)", 'new Error(message)');
    }
    const patched = patchOzonContentV4(old);
    assert.deepEqual(patched, workflow);
    for (let i = 0; i < old.nodes.length; i++) if (!PATCH_NODES[id].includes(old.nodes[i].name)) assert.deepEqual(patched.nodes[i], old.nodes[i]);
    assert.deepEqual(patched.connections, old.connections);
    const missing = structuredClone(old); missing.nodes = missing.nodes.filter(node => node.name !== POLICY_NODES[id][0]);
    assert.throws(() => patchOzonContentV4(missing), /unique/);
  }
  const drift = load(s000Id);
  drift.nodes.find(node => node.name === prepareName).parameters.jsCode = 'return [];';
  assert.throws(() => patchOzonContentV4(drift), /guard drift/);
});
