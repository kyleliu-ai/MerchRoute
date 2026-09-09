// Shared by the runtime and offline volume helper. Never infer a remote result.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const ARCHIVE_FILE = 'image-task-archive.json';
const DISPOSITION = 'archived_no_replay';
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
function canonical(value) {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort()
    .map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}';
  return JSON.stringify(value);
}
const recordDigest = value => sha(canonical(value));
const keyDigest = key => sha(String(key));
function rowsOf(store) {
  const rows = Array.isArray(store) ? store : store?.schemaVersion === 2 ? store.records : null;
  assert.ok(Array.isArray(rows), 'Unsupported task ledger');
  assert.equal(new Set(rows.map(r => r.idempotencyKey)).size, rows.length, 'Duplicate task keys');
  return rows;
}
function readRegular(file) {
  const stat = fs.lstatSync(file);
  assert.ok(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1, 'Unsafe archive storage file');
  return fs.readFileSync(file, 'utf8');
}
function validateArchive(store, archive) {
  const rows = rowsOf(store), byKey = new Map(rows.map(r => [keyDigest(r.idempotencyKey), r]));
  if (!archive) {
    assert.ok(!store.archiveSha256, 'Required task archive is missing');
    return new Map();
  }
  assert.equal(archive.schemaVersion, 1, 'Unsupported archive schema');
  assert.equal(store.archiveSha256, recordDigest(archive), 'Archive binding changed or incomplete');
  assert.ok(Array.isArray(archive.records) && archive.records.length > 0, 'Empty archive');
  const result = new Map();
  for (const item of archive.records) {
    assert.equal(item.disposition, DISPOSITION);
    assert.equal(item.forbidReplay, true);
    assert.ok(typeof item.reason === 'string' && item.reason.trim());
    assert.ok(typeof item.approvalReference === 'string' && item.approvalReference.trim());
    assert.ok(Number.isFinite(Date.parse(item.archivedAt)));
    assert.ok(!result.has(item.keyHash), 'Duplicate archived key');
    const original = item.originalRecord, current = byKey.get(item.keyHash);
    assert.ok(original && current, 'Archived task is missing');
    assert.ok(['processing', 'submission_unknown'].includes(original.status), 'Only unresolved tasks may be archived');
    assert.equal(item.keyHash, keyDigest(original.idempotencyKey));
    assert.equal(item.recordHash, recordDigest(original), 'Original archive snapshot changed');
    assert.equal(item.recordHash, recordDigest(current), 'Archived task changed');
    result.set(item.keyHash, item);
  }
  return result;
}
function readArchive(storeDir, store) {
  const file = path.join(storeDir, ARCHIVE_FILE);
  const archive = fs.existsSync(file) ? JSON.parse(readRegular(file)) : null;
  return { archive, entries: validateArchive(store, archive) };
}
function publicDisposition(item) {
  return { state: DISPOSITION, archivedAt: item.archivedAt, forbidReplay: true,
    reason: item.reason, remoteResultConfirmed: false };
}
function atomicWrite(file, value) {
  const temp = file + '.' + crypto.randomUUID() + '.tmp';
  const fd = fs.openSync(temp, 'wx', 0o600);
  try { fs.writeFileSync(fd, JSON.stringify(value, null, 2) + '\n'); fs.fsyncSync(fd); }
  finally { fs.closeSync(fd); }
  fs.renameSync(temp, file);
  // Windows cannot fsync a directory. Linux volume writes can and must.
  if (process.platform !== 'win32') {
    const dir = fs.openSync(path.dirname(file), 'r');
    try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); }
  }
}
// Offline only: the deployment wrapper must exclude writers and back up first.
// A crash between the two atomic renames fails closed at startup. Repeating the
// same approved operation completes the binding without altering any task row.
function archiveTasks({ storeDir, approval, execute = false, now = Date.now() }) {
  assert.equal(approval?.schemaVersion, 1);
  assert.equal(approval.operation, DISPOSITION);
  assert.equal(approval.preserveRecords, true);
  assert.equal(approval.forbidReplay, true);
  assert.ok(typeof approval.approvalReference === 'string' && approval.approvalReference.trim());
  assert.ok(typeof approval.reason === 'string' && approval.reason.trim());
  assert.ok(Number.isFinite(Date.parse(approval.approvedAt)) && Date.parse(approval.approvedAt) <= now);
  assert.ok(Array.isArray(approval.records) && approval.records.length > 0);
  assert.equal(new Set(approval.records.map(r => r.keyHash)).size, approval.records.length);
  const storeFile = path.join(storeDir, 'image-task-store.json');
  const bytes = readRegular(storeFile), store = JSON.parse(bytes), rows = rowsOf(store);
  const archiveFile = path.join(storeDir, ARCHIVE_FILE);
  const existing = fs.existsSync(archiveFile) ? JSON.parse(readRegular(archiveFile)) : null;
  const byKey = new Map(rows.map(r => [keyDigest(r.idempotencyKey), r]));
  const entries = approval.records.map(request => {
    const row = byKey.get(request.keyHash);
    assert.ok(row && ['processing', 'submission_unknown'].includes(row.status), 'Approved unresolved record missing');
    assert.equal(request.recordHash, recordDigest(row), 'Approved record changed');
    return { keyHash: request.keyHash, recordHash: request.recordHash, originalRecord: row,
      disposition: DISPOSITION, forbidReplay: true, archivedAt: approval.approvedAt,
      reason: approval.reason, approvalReference: approval.approvalReference };
  });
  const alreadyIncluded = existing && entries.every(item => existing.records?.some(old => canonical(old) === canonical(item)));
  if (alreadyIncluded && store.archiveSha256 === recordDigest(existing)) {
    validateArchive(store, existing);
    return { ok: true, reused: true, count: entries.length, archiveSha256: store.archiveSha256 };
  }
  assert.equal(sha(bytes), approval.storeSha256, 'Approved ledger snapshot changed');
  assert.ok(Date.parse(approval.expiresAt) > now, 'Archive approval expired');
  // Only the exact interrupted first write is recoverable without a valid old binding.
  const interrupted = existing && !store.archiveSha256 && canonical(existing) === canonical({ schemaVersion: 1, records: entries });
  if (!interrupted) validateArchive(store, existing);
  assert.ok(!existing || interrupted, 'Archive dispositions are immutable; automatic expansion is forbidden');
  const archive = interrupted ? existing : { schemaVersion: 1, records: entries };
  const updated = { ...(Array.isArray(store) ? { schemaVersion: 2, records: rows } : store), archiveSha256: recordDigest(archive) };
  validateArchive(updated, archive);
  if (execute) {
    assert.equal(readRegular(storeFile), bytes, 'Task ledger changed before archive write');
    if (!interrupted) atomicWrite(archiveFile, archive);
    atomicWrite(storeFile, updated);
    validateArchive(JSON.parse(readRegular(storeFile)), JSON.parse(readRegular(archiveFile)));
  }
  return { ok: true, dryRun: !execute, reused: false, count: entries.length, archiveSha256: updated.archiveSha256 };
}
export default { ARCHIVE_FILE, DISPOSITION, sha, recordDigest, keyDigest, rowsOf,
  validateArchive, readArchive, publicDisposition, archiveTasks };
