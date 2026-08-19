#!/usr/bin/env node
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const SCHEMA_VERSION = 1;
const HEARTBEAT_INTERVAL_MS = 10_000;
const STALE_HEARTBEAT_MS = 120_000;
const TRANSITION_LOCK_STALE_MS = 30_000;
const DEFAULT_RETRY_AFTER_MS = 5_000;
const MAX_BASE64_PAYLOAD_BYTES = 1024 * 1024;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const VERIFIED_NON_FATAL_STITCHES = new WeakSet();
const RETRYABLE_STATUSES = new Set([
  'profile_busy',
  'edge_profile_locked',
  'edge_default_profile_remote_debugging_blocked',
]);

function nowIso(now = Date.now()) {
  return new Date(now).toISOString();
}

function sha256(value) {
  return crypto.createHash('sha256').update(String(value), 'utf8').digest('hex');
}

function normalizePortablePath(value) {
  let text = String(value || '').trim();
  if (
    text.length >= 2
    && ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'")))
  ) {
    text = text.slice(1, -1).trim();
  }
  const hasUncPrefix = /^\\\\/.test(text) || text.startsWith('//');
  text = text.replace(/\\+/g, '/');
  if (hasUncPrefix) text = '//' + text.replace(/^\/+/, '').replace(/\/+/g, '/');
  else if (text.startsWith('//')) text = '//' + text.slice(2).replace(/\/+/g, '/');
  else text = text.replace(/\/+/g, '/');
  if (text.length > 1 && text.endsWith('/') && !/^[A-Za-z]:\/$/.test(text)) text = text.replace(/\/+$/, '');
  return text;
}

function normalizeFingerprintPath(value) {
  const normalized = normalizePortablePath(value);
  return /^[A-Za-z]:\//.test(normalized) || normalized.startsWith('//')
    ? normalized.toLowerCase()
    : normalized;
}

function pathEquals(left, right) {
  return normalizeFingerprintPath(left) === normalizeFingerprintPath(right);
}

function isUuid(value) {
  return UUID_PATTERN.test(String(value || '').trim());
}

function normalizeWorkflowCode(value) {
  const code = String(value || '').trim().toUpperCase();
  if (!/^[A-Z][A-Z0-9_-]{1,31}$/.test(code)) throw new Error('workflowCode is invalid.');
  return code;
}

function resolveNativeAbsolute(value, fieldName) {
  const normalized = normalizePortablePath(value);
  if (!normalized || !path.isAbsolute(normalized)) throw new Error(fieldName + ' must be an absolute native path.');
  return path.resolve(normalized);
}

function assertDescendant(target, parent, fieldName) {
  const relative = path.relative(parent, target);
  if (!relative || relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) {
    throw new Error(fieldName + ' must be a descendant of parentOutputDir.');
  }
}

function nativeRealpath(value) {
  return fs.realpathSync.native ? fs.realpathSync.native(value) : fs.realpathSync(value);
}

function isNativePathWithin(candidate, root, allowEqual = true) {
  const relative = path.relative(root, candidate);
  if (relative === '') return allowEqual;
  return relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
}

function assertNoSymlinkAncestors(target, fieldName) {
  let cursor = path.resolve(target);
  const filesystemRoot = path.parse(cursor).root;
  while (true) {
    let stat;
    try {
      stat = fs.lstatSync(cursor);
    } catch (error) {
      if (error?.code === 'ENOENT') throw new Error(fieldName + ' must already exist.');
      throw error;
    }
    if (stat.isSymbolicLink()) throw new Error(fieldName + ' must not contain a symbolic link or junction.');
    if (!stat.isDirectory()) throw new Error(fieldName + ' and all of its ancestors must be directories.');
    if (cursor === filesystemRoot) break;
    cursor = path.dirname(cursor);
  }
}

function assertSafeExistingDirectory(directory, parentRealpath, fieldName) {
  let stat;
  try {
    stat = fs.lstatSync(directory);
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(fieldName + ' must be a regular directory, not a symbolic link or junction.');
  }
  const resolved = nativeRealpath(directory);
  if (!isNativePathWithin(resolved, parentRealpath, true)) {
    throw new Error(fieldName + ' resolves outside parentOutputDir.');
  }
  return true;
}

function assertSafeExistingFile(filePath, jobRealpath, fieldName) {
  let stat;
  try {
    stat = fs.lstatSync(filePath);
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 1) {
    throw new Error(fieldName + ' must be a non-empty regular file, not a symbolic link or junction.');
  }
  if (!isNativePathWithin(nativeRealpath(filePath), jobRealpath, false)) {
    throw new Error(fieldName + ' resolves outside the idempotency job directory.');
  }
  return true;
}

function normalizeAllowedRoots(value) {
  return Array.isArray(value)
    ? [...new Set(value.map((entry) => String(entry || '').trim()).filter(Boolean))]
    : [];
}

function assertParentInsideAllowedRoots(parentOutputDir, allowedOutputRoots) {
  const roots = normalizeAllowedRoots(allowedOutputRoots);
  if (!roots.length) return;
  const parentRealpath = nativeRealpath(parentOutputDir);
  const accepted = roots.some((rootValue) => {
    try {
      const root = resolveNativeAbsolute(rootValue, 'allowedOutputRoots entry');
      const stat = fs.lstatSync(root);
      if (!stat.isDirectory() || stat.isSymbolicLink()) return false;
      return isNativePathWithin(parentRealpath, nativeRealpath(root), true);
    } catch {
      return false;
    }
  });
  if (!accepted) throw new Error('parentOutputDir realpath must be inside an existing allowedOutputRoots directory.');
}

function assertSafeStateLayout(paths, allowedOutputRoots = []) {
  assertNoSymlinkAncestors(paths.parentOutputDir, 'parentOutputDir');
  assertParentInsideAllowedRoots(paths.parentOutputDir, allowedOutputRoots);
  const parentRealpath = nativeRealpath(paths.parentOutputDir);
  for (const [directory, fieldName] of [
    [paths.stateBaseDir, '.download-idempotency'],
    [paths.versionDir, 'idempotency version directory'],
    [paths.rootDir, 'idempotency workflow directory'],
    [paths.jobDir, 'idempotency job directory'],
  ]) {
    assertSafeExistingDirectory(directory, parentRealpath, fieldName);
  }
  if (!fs.existsSync(paths.jobDir)) return true;
  const jobRealpath = nativeRealpath(paths.jobDir);
  for (const [filePath, fieldName] of [
    [paths.ownerPath, 'owner.json'],
    [paths.heartbeatPath, 'heartbeat.json'],
    [paths.receiptPath, 'receipt.json'],
  ]) {
    assertSafeExistingFile(filePath, jobRealpath, fieldName);
  }
  if (fs.existsSync(paths.transitionLockPath)) {
    assertSafeExistingDirectory(paths.transitionLockPath, jobRealpath, 'transition.lock');
    assertSafeExistingFile(transitionLockMetadataPath(paths), nativeRealpath(paths.transitionLockPath), 'transition lock metadata');
  }
  return true;
}

function ensureSafeStateRoot(paths) {
  for (const directory of [paths.stateBaseDir, paths.versionDir, paths.rootDir]) {
    assertSafeStateLayout(paths, paths.allowedOutputRoots);
    try {
      fs.mkdirSync(directory);
    } catch (error) {
      if (!error || error.code !== 'EEXIST') throw error;
    }
    assertSafeStateLayout(paths, paths.allowedOutputRoots);
  }
}

function buildFingerprint(params) {
  const identity = {
    schemaVersion: SCHEMA_VERSION,
    workflowCode: normalizeWorkflowCode(params.workflowCode),
    SKU: String(params.SKU || '').trim(),
    productName: String(params.productName || '').trim().normalize('NFC'),
    platformProductId: String(params.platformProductId || '').trim(),
    parentOutputDir: normalizeFingerprintPath(params.parentOutputDir),
  };
  return sha256(JSON.stringify(identity));
}

function statePaths(params) {
  const workflowCode = normalizeWorkflowCode(params.workflowCode);
  const downloadJobId = String(params.downloadJobId || '').trim().toLowerCase();
  if (!isUuid(downloadJobId)) throw new Error('downloadJobId must be a UUID.');
  const parentOutputDir = resolveNativeAbsolute(params.parentOutputDir, 'parentOutputDir');
  const stateBaseDir = path.join(parentOutputDir, '.download-idempotency');
  const versionDir = path.join(stateBaseDir, 'v1');
  const rootDir = path.join(versionDir, workflowCode);
  const jobDir = path.join(rootDir, sha256(downloadJobId));
  const paths = {
    workflowCode,
    downloadJobId,
    parentOutputDir,
    allowedOutputRoots: normalizeAllowedRoots(params.allowedOutputRoots),
    stateBaseDir,
    versionDir,
    rootDir,
    jobDir,
    ownerPath: path.join(jobDir, 'owner.json'),
    heartbeatPath: path.join(jobDir, 'heartbeat.json'),
    receiptPath: path.join(jobDir, 'receipt.json'),
    transitionLockPath: path.join(jobDir, 'transition.lock'),
  };
  assertSafeStateLayout(paths, params.allowedOutputRoots);
  return paths;
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function readJsonIfExists(filePath) {
  try {
    return readJson(filePath);
  } catch (error) {
    if (error && error.code === 'ENOENT') return null;
    throw error;
  }
}

function atomicWriteJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporaryPath = filePath + '.tmp-' + process.pid + '-' + Date.now() + '-' + crypto.randomUUID();
  let fileHandle = null;
  try {
    fileHandle = fs.openSync(temporaryPath, 'wx');
    fs.writeFileSync(fileHandle, JSON.stringify(value, null, 2) + '\n', { encoding: 'utf8' });
    fs.fsyncSync(fileHandle);
    fs.closeSync(fileHandle);
    fileHandle = null;
    fs.renameSync(temporaryPath, filePath);
    // Persist the directory entry where the host filesystem supports opening
    // and syncing directories. Windows commonly rejects this operation, so the
    // file fsync + same-directory rename remains the portable baseline.
    let directoryHandle = null;
    try {
      directoryHandle = fs.openSync(path.dirname(filePath), 'r');
      fs.fsyncSync(directoryHandle);
    } catch {}
    finally {
      if (directoryHandle !== null) {
        try { fs.closeSync(directoryHandle); } catch {}
      }
    }
  } finally {
    if (fileHandle !== null) {
      try { fs.closeSync(fileHandle); } catch {}
    }
    try {
      if (fs.existsSync(temporaryPath)) fs.unlinkSync(temporaryPath);
    } catch {}
  }
}

function removeFileIfExists(filePath) {
  try {
    fs.unlinkSync(filePath);
  } catch (error) {
    if (!error || error.code !== 'ENOENT') throw error;
  }
}

function buildOwner(params, paths, fingerprint, outputDirOverride = '', ownerExecutionIdOverride = '') {
  const expectedOutputDir = resolveNativeAbsolute(
    outputDirOverride || params.expectedOutputDir,
    'expectedOutputDir',
  );
  assertDescendant(expectedOutputDir, paths.parentOutputDir, 'expectedOutputDir');
  const timestamp = nowIso();
  return {
    schemaVersion: SCHEMA_VERSION,
    workflowCode: paths.workflowCode,
    downloadJobId: paths.downloadJobId,
    fingerprint,
    ownerToken: crypto.randomUUID(),
    ownerN8nExecutionId: String(ownerExecutionIdOverride || params.requestN8nExecutionId || '').trim(),
    outputDir: normalizePortablePath(expectedOutputDir),
    SKU: String(params.SKU || '').trim(),
    productName: String(params.productName || '').trim().normalize('NFC'),
    platformProductId: String(params.platformProductId || '').trim(),
    allowedOutputRoots: normalizeAllowedRoots(params.allowedOutputRoots).map(normalizePortablePath),
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

function buildHeartbeat(owner, phase, now = Date.now()) {
  return {
    schemaVersion: SCHEMA_VERSION,
    workflowCode: owner.workflowCode,
    downloadJobId: owner.downloadJobId,
    fingerprint: owner.fingerprint,
    ownerToken: owner.ownerToken,
    ownerN8nExecutionId: owner.ownerN8nExecutionId,
    phase: String(phase || 'preflight'),
    updatedAt: nowIso(now),
  };
}

function idempotencyContext(paths, owner) {
  return {
    enabled: true,
    schemaVersion: SCHEMA_VERSION,
    workflowCode: paths.workflowCode,
    downloadJobId: paths.downloadJobId,
    fingerprint: owner.fingerprint,
    ownerToken: owner.ownerToken,
    ownerN8nExecutionId: owner.ownerN8nExecutionId,
    parentOutputDir: normalizePortablePath(paths.parentOutputDir),
    allowedOutputRoots: normalizeAllowedRoots(owner.allowedOutputRoots),
  };
}

function terminalFields(paths, owner, state, replay, requestN8nExecutionId) {
  return {
    downloadJobId: paths.downloadJobId,
    idempotencyState: state,
    idempotencyReplay: Boolean(replay),
    ownerN8nExecutionId: String(owner?.ownerN8nExecutionId || ''),
    requestN8nExecutionId: String(requestN8nExecutionId || ''),
  };
}

function statusResponse(paths, owner, params, {
  status,
  httpStatus,
  idempotencyState,
  message,
  replay = false,
  retryAfterMs,
}) {
  const response = {
    success: false,
    status,
    httpStatus,
    platform: paths.workflowCode === 'E006' ? 'pdd' : '1688',
    SKU: String(params.SKU || owner?.SKU || ''),
    productName: String(params.productName || owner?.productName || ''),
    productUrl: String(params.productUrl || ''),
    outputDir: String(owner?.outputDir || ''),
    errors: message ? [message] : [],
    warnings: [],
    ...terminalFields(paths, owner, idempotencyState, replay, params.requestN8nExecutionId),
  };
  if (Number.isFinite(Number(retryAfterMs))) response.retryAfterMs = Number(retryAfterMs);
  return response;
}

function runningOutcome(paths, owner, params) {
  const response = statusResponse(paths, owner, params, {
    status: 'idempotency_in_progress',
    httpStatus: 202,
    idempotencyState: 'running',
    message: 'The original download execution is still running.',
    retryAfterMs: DEFAULT_RETRY_AFTER_MS,
  });
  return { action: 'running', response, idempotency: null };
}

function conflictOutcome(paths, owner, params, message, status = 'idempotency_conflict') {
  return {
    action: status === 'idempotency_orphaned' ? 'orphaned' : 'conflict',
    response: statusResponse(paths, owner, params, {
      status,
      httpStatus: 409,
      idempotencyState: 'failed',
      message,
    }),
    idempotency: null,
  };
}

function ownerOutcome(paths, owner, action = 'owner', downloadResult = null) {
  return {
    action,
    idempotency: idempotencyContext(paths, owner),
    ownerN8nExecutionId: owner.ownerN8nExecutionId,
    outputDir: owner.outputDir,
    downloadResult,
    response: null,
  };
}

function receiptOutcome(paths, receipt, params) {
  const owner = receipt.owner || {};
  const normalized = normalizeTerminalResultContract(receipt.result || {}, 'receipt replay');
  const state = normalized.success === true ? 'succeeded' : 'failed';
  const response = {
    ...normalized,
    ...terminalFields(paths, owner, state, true, params.requestN8nExecutionId),
  };
  return { action: 'replay', response, idempotency: null };
}

function persistOrphanReceipt(paths, owner, fingerprint, params, now, message, transitionToken) {
  const orphanResult = statusResponse(paths, owner, params, {
    status: 'idempotency_orphaned',
    httpStatus: 409,
    idempotencyState: 'failed',
    message,
  });
  assertTransitionLockOwner(paths, transitionToken);
  atomicWriteJson(paths.receiptPath, {
    schemaVersion: SCHEMA_VERSION,
    state: 'failed',
    fingerprint,
    owner,
    completedAt: nowIso(now),
    recoveredFromArtifacts: false,
    result: orphanResult,
  });
  atomicWriteJson(paths.heartbeatPath, buildHeartbeat(owner, 'finalized'));
  return { action: 'orphaned', response: orphanResult, idempotency: null };
}

function heartbeatIsFresh(heartbeat, now = Date.now(), staleMs = STALE_HEARTBEAT_MS) {
  const updatedAt = Date.parse(String(heartbeat?.updatedAt || ''));
  return Number.isFinite(updatedAt) && now - updatedAt <= staleMs;
}

function createJobState(paths, owner) {
  ensureSafeStateRoot(paths);
  const temporaryDir = paths.jobDir + '.claim-' + process.pid + '-' + crypto.randomUUID();
  fs.mkdirSync(temporaryDir);
  try {
    atomicWriteJson(path.join(temporaryDir, 'owner.json'), owner);
    atomicWriteJson(path.join(temporaryDir, 'heartbeat.json'), buildHeartbeat(owner, 'preflight'));
    fs.renameSync(temporaryDir, paths.jobDir);
    assertSafeStateLayout(paths, paths.allowedOutputRoots);
    return true;
  } catch (error) {
    try {
      fs.rmSync(temporaryDir, { recursive: true, force: true });
    } catch {}
    if (error && ['EEXIST', 'ENOTEMPTY', 'EPERM'].includes(error.code) && fs.existsSync(paths.jobDir)) return false;
    throw error;
  }
}

function transitionLockMetadataPath(paths) {
  return path.join(paths.transitionLockPath, 'lock.json');
}

function transitionLockAgeMs(paths, now = Date.now()) {
  const metadata = readJsonIfExists(transitionLockMetadataPath(paths));
  const acquiredAt = Date.parse(String(metadata?.acquiredAt || ''));
  if (Number.isFinite(acquiredAt)) return now - acquiredAt;
  try {
    return now - fs.statSync(paths.transitionLockPath).mtimeMs;
  } catch (error) {
    if (error && error.code === 'ENOENT') return Number.POSITIVE_INFINITY;
    throw error;
  }
}

function writeTransitionLock(paths, token, now) {
  atomicWriteJson(transitionLockMetadataPath(paths), {
    schemaVersion: SCHEMA_VERSION,
    token,
    acquiredAt: nowIso(now),
  });
}

function acquireTransitionLock(paths, {
  now = Date.now(),
  expectedOwnerToken = '',
  expectedFingerprint = '',
  staleMs = TRANSITION_LOCK_STALE_MS,
} = {}) {
  assertSafeStateLayout(paths, paths.allowedOutputRoots);
  const token = crypto.randomUUID();
  try {
    fs.mkdirSync(paths.transitionLockPath);
    writeTransitionLock(paths, token, now);
    assertSafeStateLayout(paths, paths.allowedOutputRoots);
    return token;
  } catch (error) {
    if (!error || error.code !== 'EEXIST') throw error;
  }

  if (transitionLockAgeMs(paths, now) <= staleMs) return '';

  // A stale transition lock is recoverable only after the durable job state is
  // re-read. Never reclaim while the real worker heartbeat is still fresh.
  const owner = readJsonIfExists(paths.ownerPath);
  const receipt = readJsonIfExists(paths.receiptPath);
  const heartbeat = readJsonIfExists(paths.heartbeatPath);
  if (!owner || owner.ownerToken !== expectedOwnerToken || owner.fingerprint !== expectedFingerprint) return '';
  if (receipt && (receipt.state === 'succeeded' || receipt.state === 'failed')) return '';
  if ((!receipt || receipt.state !== 'retryable') && heartbeatIsFresh(heartbeat, now, STALE_HEARTBEAT_MS)) return '';

  const tombstone = paths.transitionLockPath + '.stale-' + process.pid + '-' + token;
  try {
    fs.renameSync(paths.transitionLockPath, tombstone);
  } catch (error) {
    if (error && ['ENOENT', 'EEXIST', 'ENOTEMPTY', 'EPERM'].includes(error.code)) return '';
    throw error;
  }
  try {
    fs.mkdirSync(paths.transitionLockPath);
    writeTransitionLock(paths, token, now);
    assertSafeStateLayout(paths, paths.allowedOutputRoots);
  } catch (error) {
    try {
      if (!fs.existsSync(paths.transitionLockPath) && fs.existsSync(tombstone)) {
        fs.renameSync(tombstone, paths.transitionLockPath);
      }
    } catch {}
    if (error && ['EEXIST', 'ENOTEMPTY', 'EPERM'].includes(error.code)) return '';
    throw error;
  } finally {
    try {
      if (fs.existsSync(tombstone)) fs.rmSync(tombstone, { recursive: true, force: true });
    } catch {}
  }
  return token;
}

function releaseTransitionLock(paths, token) {
  const metadata = readJsonIfExists(transitionLockMetadataPath(paths));
  if (!metadata || metadata.token !== token) return false;
  const tombstone = paths.transitionLockPath + '.release-' + process.pid + '-' + token;
  try {
    fs.renameSync(paths.transitionLockPath, tombstone);
    fs.rmSync(tombstone, { recursive: true, force: true });
    return true;
  } catch (error) {
    if (error && error.code === 'ENOENT') return false;
    throw error;
  }
}

function assertTransitionLockOwner(paths, token) {
  const metadata = readJsonIfExists(transitionLockMetadataPath(paths));
  if (!metadata || metadata.token !== token) {
    const error = new Error('Idempotency transition lock ownership was lost.');
    error.code = 'IDEMPOTENCY_TRANSITION_LOST';
    throw error;
  }
}

function isPathWithin(target, root) {
  const resolvedTarget = resolveNativeAbsolute(target, 'media localPath');
  const resolvedRoot = resolveNativeAbsolute(root, 'media root');
  const relative = path.relative(resolvedRoot, resolvedTarget);
  return relative === '' || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative));
}

function isRealFileWithin(target, root) {
  let targetStat;
  let rootStat;
  try {
    targetStat = fs.lstatSync(target);
    rootStat = fs.lstatSync(root);
  } catch {
    return false;
  }
  if (!targetStat.isFile() || targetStat.isSymbolicLink() || targetStat.size < 1
    || !rootStat.isDirectory() || rootStat.isSymbolicLink()) return false;
  try {
    return isPathWithin(nativeRealpath(target), nativeRealpath(root));
  } catch {
    return false;
  }
}

function artifactSafetyError(message, cause) {
  const error = new Error(message, cause ? { cause } : undefined);
  error.code = 'IDEMPOTENCY_ARTIFACT_PATH_UNSAFE';
  return error;
}

function artifactInvalidError(message, cause) {
  const error = new Error(message, cause ? { cause } : undefined);
  error.code = 'IDEMPOTENCY_ARTIFACT_INVALID';
  return error;
}

function resolveSafeArtifactDirectory(directory, container, fieldName, { required = false } = {}) {
  let stat;
  try {
    stat = fs.lstatSync(directory);
  } catch (error) {
    if (error?.code === 'ENOENT' && !required) return '';
    if (error?.code === 'ENOENT') throw artifactSafetyError(fieldName + ' does not exist.');
    throw artifactSafetyError('Cannot inspect ' + fieldName + '.', error);
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw artifactSafetyError(fieldName + ' must be a regular directory, not a symbolic link or junction.');
  }
  try {
    assertNoSymlinkAncestors(directory, fieldName);
    const resolved = nativeRealpath(directory);
    const containerRealpath = nativeRealpath(container);
    if (!isNativePathWithin(resolved, containerRealpath, false)) {
      throw artifactSafetyError(fieldName + ' resolves outside its approved container.');
    }
    return resolved;
  } catch (error) {
    if (error?.code === 'IDEMPOTENCY_ARTIFACT_PATH_UNSAFE') throw error;
    throw artifactSafetyError(error.message || String(error), error);
  }
}

function readSafeArtifactJsonIfExists(filePath, containerRealpath, fieldName) {
  let stat;
  try {
    stat = fs.lstatSync(filePath);
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw artifactSafetyError('Cannot inspect ' + fieldName + '.', error);
  }
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw artifactSafetyError(fieldName + ' must be a regular file, not a symbolic link or junction.');
  }
  if (stat.size < 1) {
    throw artifactInvalidError(fieldName + ' is empty and cannot be used for artifact recovery.');
  }
  try {
    if (!isNativePathWithin(nativeRealpath(filePath), containerRealpath, false)) {
      throw artifactSafetyError(fieldName + ' resolves outside the metadata directory.');
    }
    const parsed = readJson(filePath);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw artifactInvalidError(fieldName + ' must contain a JSON object.');
    }
    return parsed;
  } catch (error) {
    if (error?.code === 'IDEMPOTENCY_ARTIFACT_PATH_UNSAFE') throw error;
    if (error?.code === 'IDEMPOTENCY_ARTIFACT_INVALID') throw error;
    if (error instanceof SyntaxError) throw artifactInvalidError(fieldName + ' is incomplete or is not valid JSON.', error);
    throw artifactSafetyError('Cannot read ' + fieldName + ' safely.', error);
  }
}

function resolveArtifactLayout(paths, owner) {
  const outputDir = resolveNativeAbsolute(owner.outputDir, 'owner.outputDir');
  assertDescendant(outputDir, paths.parentOutputDir, 'owner.outputDir');
  if (!fs.existsSync(outputDir)) return null;
  const outputRealpath = resolveSafeArtifactDirectory(
    outputDir,
    paths.parentOutputDir,
    'owner.outputDir',
    { required: true },
  );
  const metadataDir = path.join(outputDir, 'metadata');
  const metadataRealpath = resolveSafeArtifactDirectory(
    metadataDir,
    outputDir,
    'metadata directory',
  );
  return { outputDir, outputRealpath, metadataDir, metadataRealpath };
}

function validateMediaList(items, declaredCount, expectedRoot) {
  const parsedCount = Number(declaredCount);
  if (!Number.isSafeInteger(parsedCount) || parsedCount < 0 || !Array.isArray(items) || parsedCount !== items.length) return false;
  if (items.length) {
    let rootStat;
    try {
      rootStat = fs.lstatSync(expectedRoot);
    } catch {
      return false;
    }
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) return false;
  }
  for (const item of items) {
    const localPath = String(item?.localPath || item?.path || item?.filePath || '');
    if (!localPath || !isPathWithin(localPath, expectedRoot) || !isRealFileWithin(localPath, expectedRoot)) return false;
    let stat;
    try {
      stat = fs.statSync(localPath);
    } catch {
      return false;
    }
    if (!stat.isFile() || stat.size < 1) return false;
    if (Number(item?.sizeBytes || 0) > 0 && Number(item.sizeBytes) !== stat.size) return false;
    const expectedHash = String(item?.sha256 || item?.contentHash || item?.hash || '').trim().toLowerCase();
    if (expectedHash && !/^[0-9a-f]{64}$/.test(expectedHash)) return false;
    if (expectedHash) {
      const actualHash = crypto.createHash('sha256').update(fs.readFileSync(localPath)).digest('hex');
      if (actualHash !== expectedHash) return false;
    }
  }
  return true;
}

function readMediaResult(paths, owner) {
  const layout = resolveArtifactLayout(paths, owner);
  if (!layout || !layout.metadataRealpath) return null;
  const { outputDir, metadataDir, metadataRealpath } = layout;
  const metadataName = paths.workflowCode === 'E006' ? 'pdd-media-metadata.json' : '1688-media-metadata.json';
  const resultName = paths.workflowCode === 'E006' ? '' : '1688-media-result.json';
  let result = null;
  let metadata = null;
  if (resultName) result = readSafeArtifactJsonIfExists(path.join(metadataDir, resultName), metadataRealpath, resultName);
  if (!result) {
    metadata = readSafeArtifactJsonIfExists(path.join(metadataDir, metadataName), metadataRealpath, metadataName);
    result = metadata && metadata.result && typeof metadata.result === 'object' ? metadata.result : null;
  }
  if (!result || result.success !== true) return null;
  if (String(result.SKU || '') !== String(owner.SKU || '')) return null;
  const resultProductId = paths.workflowCode === 'E006' ? result.goodsId : result.offerId;
  if (String(resultProductId || '') !== String(owner.platformProductId || '')) return null;
  if (String(result.productName || '').trim().normalize('NFC') !== String(owner.productName || '').trim().normalize('NFC')) return null;
  const executionIdentity = String(result.n8nExecutionId || metadata?.params?.n8nExecutionId || metadata?.input?.n8nExecutionId || '').trim();
  if (!executionIdentity || executionIdentity !== String(owner.ownerN8nExecutionId || '')) return null;
  if (!pathEquals(result.outputDir, owner.outputDir)) return null;
  if (!validateMediaList(result.mainImages, result.mainImageCount, path.join(outputDir, 'main-images'))) return null;
  if (Number(result.mainImageCount || 0) < 1) return null;
  if (!validateMediaList(result.detailImages || [], result.detailImageCount, path.join(outputDir, 'detail-images'))) return null;
  if (!validateMediaList(result.videos || [], result.videoCount, path.join(outputDir, 'videos'))) return null;
  return result;
}

function mediaItemLocalPath(item) {
  return String(item?.localPath || item?.path || item?.filePath || '');
}

function normalizedVerifiedPathSet(values, expectedRoot) {
  if (!Array.isArray(values)) return null;
  const normalized = [];
  const seen = new Set();
  for (const value of values) {
    const localPath = String(value || '');
    try {
      if (!localPath || !isPathWithin(localPath, expectedRoot) || !isRealFileWithin(localPath, expectedRoot)) return null;
    } catch {
      return null;
    }
    const fingerprint = normalizeFingerprintPath(localPath);
    if (seen.has(fingerprint)) return null;
    seen.add(fingerprint);
    normalized.push(fingerprint);
  }
  return normalized.sort();
}

function isVerifiedNonFatalStitch(paths, owner, media, stitch, layout, manifestPath) {
  if (!['E006', 'E007'].includes(paths.workflowCode)) return false;
  if (
    stitch.schemaVersion !== SCHEMA_VERSION
    || stitch.success !== false
    || stitch.skipped !== false
    || stitch.nonFatal !== true
    || stitch.status !== 'warning'
  ) return false;
  if (String(stitch.n8nExecutionId || '') !== String(owner.ownerN8nExecutionId || '')) return false;
  if (stitch.errorCode !== 'OUTPUT_PIXEL_LIMIT_EXCEEDED') return false;
  if (!Array.isArray(stitch.errorDetails) || stitch.errorDetails.length !== 1) return false;
  const [errorDetail] = stitch.errorDetails;
  if (
    !errorDetail
    || errorDetail.code !== 'OUTPUT_PIXEL_LIMIT_EXCEEDED'
    || !String(errorDetail.message || '').trim()
  ) return false;
  if (!Array.isArray(stitch.errors) || stitch.errors.length !== 0) return false;
  if (
    !Array.isArray(stitch.warnings)
    || stitch.warnings.length !== 1
    || stitch.warnings[0] !== errorDetail.message
  ) return false;

  const detailRoot = path.join(layout.outputDir, 'detail-images');
  if (!pathEquals(stitch.detailImageDir, detailRoot)) return false;
  if (!pathEquals(stitch.resultFilePath, manifestPath)) return false;

  const expectedLongImagePath = path.join(detailRoot, '详情长图.png');
  const longImagePath = String(stitch.detailLongImagePath || '');
  try {
    if (!pathEquals(longImagePath, expectedLongImagePath)) return false;
    const resolvedLongImagePath = resolveNativeAbsolute(longImagePath, 'detailLongImagePath');
    if (String(stitch.detailLongImageFileName || '') !== '详情长图.png') return false;
    if (!pathEquals(stitch.path, resolvedLongImagePath)) return false;
    if (String(stitch.fileName || '') !== '详情长图.png') return false;
    try {
      fs.lstatSync(resolvedLongImagePath);
      return false;
    } catch (error) {
      if (error?.code !== 'ENOENT') return false;
    }
  } catch {
    return false;
  }

  const zeroOutputFields = [
    'detailLongImageWidth',
    'detailLongImageHeight',
    'detailLongImageSizeBytes',
    'width',
    'height',
    'sizeBytes',
  ];
  if (zeroOutputFields.some((field) => !Number.isSafeInteger(stitch[field]) || stitch[field] !== 0)) return false;
  if (!Number.isSafeInteger(stitch.stitchedImageCount) || stitch.stitchedImageCount !== 0) return false;
  if (!Array.isArray(stitch.stitchedImages) || stitch.stitchedImages.length !== 0) return false;

  const inputImageCount = stitch.inputImageCount;
  const detailImageCount = media?.detailImageCount;
  if (
    !Number.isSafeInteger(inputImageCount)
    || inputImageCount < 1
    || !Number.isSafeInteger(detailImageCount)
    || inputImageCount !== detailImageCount
    || !Array.isArray(stitch.inputImages)
    || stitch.inputImages.length !== inputImageCount
  ) return false;
  if (!Number.isSafeInteger(stitch.inputCount) || stitch.inputCount !== inputImageCount) return false;

  const expectedInputs = normalizedVerifiedPathSet(
    Array.isArray(media.detailImages) ? media.detailImages.map(mediaItemLocalPath) : null,
    detailRoot,
  );
  const manifestInputs = normalizedVerifiedPathSet(stitch.inputImages, detailRoot);
  if (!expectedInputs || !manifestInputs || JSON.stringify(manifestInputs) !== JSON.stringify(expectedInputs)) return false;

  return true;
}

function readStitchResult(paths, owner, media) {
  const layout = resolveArtifactLayout(paths, owner);
  if (!layout || !layout.metadataRealpath) return null;
  const { outputDir, metadataDir, metadataRealpath } = layout;
  const fileName = paths.workflowCode === 'E006'
    ? 'pdd-detail-stitch-result.json'
    : '1688-detail-stitch-result.json';
  const manifestPath = path.join(metadataDir, fileName);
  const stitch = readSafeArtifactJsonIfExists(manifestPath, metadataRealpath, fileName);
  if (!stitch) return null;
  if (String(stitch.n8nExecutionId || '') !== String(owner.ownerN8nExecutionId || '')) return null;
  const verifiedNonFatal = isVerifiedNonFatalStitch(paths, owner, media, stitch, layout, manifestPath);
  if (stitch.success !== true && stitch.skipped !== true && !verifiedNonFatal) return null;
  if (verifiedNonFatal) VERIFIED_NON_FATAL_STITCHES.add(stitch);
  if (stitch.skipped === true && Number(media?.detailImageCount || 0) > 0) return null;
  if (stitch.success === true) {
    const longImagePath = String(stitch.detailLongImagePath || stitch.path || '');
    const detailRoot = path.join(outputDir, 'detail-images');
    if (!longImagePath || !isPathWithin(longImagePath, detailRoot) || !isRealFileWithin(longImagePath, detailRoot)) return null;
    const stat = fs.statSync(longImagePath);
    if (Number(stitch.detailLongImageSizeBytes || stitch.sizeBytes || 0) > 0
      && Number(stitch.detailLongImageSizeBytes || stitch.sizeBytes) !== stat.size) return null;
  }
  return stitch;
}

function mergeRecoveredResult(media, stitch) {
  const nonFatalStitch = VERIFIED_NON_FATAL_STITCHES.has(stitch)
    && stitch.success === false
    && stitch.skipped === false
    && stitch.nonFatal === true
    && stitch.status === 'warning'
    && stitch.errorCode === 'OUTPUT_PIXEL_LIMIT_EXCEEDED';
  const fatalStitch = !stitch.success
    && !stitch.skipped
    && !nonFatalStitch
    && Number(media.detailImageCount || 0) > 0;
  const errors = Array.isArray(media.errors) ? [...media.errors] : [];
  const warnings = Array.isArray(media.warnings) ? [...media.warnings] : [];
  if (Array.isArray(stitch.warnings)) warnings.push(...stitch.warnings);
  if (fatalStitch && Array.isArray(stitch.errors)) errors.push(...stitch.errors);
  return {
    ...media,
    success: fatalStitch ? false : Boolean(media.success),
    status: fatalStitch ? 'detail_long_image_failed' : String(media.status || 'success'),
    httpStatus: fatalStitch ? 500 : Number(media.httpStatus || 200),
    detailLongImageSuccess: Boolean(stitch.success),
    detailLongImageSkipped: Boolean(stitch.skipped),
    detailLongImagePath: String(stitch.detailLongImagePath || stitch.path || ''),
    detailLongImageFileName: String(stitch.detailLongImageFileName || stitch.fileName || '详情长图.png'),
    detailLongImageWidth: Number(stitch.detailLongImageWidth || stitch.width || 0),
    detailLongImageHeight: Number(stitch.detailLongImageHeight || stitch.height || 0),
    detailLongImageSizeBytes: Number(stitch.detailLongImageSizeBytes || stitch.sizeBytes || 0),
    detailLongImageInputCount: Number(stitch.inputImageCount || stitch.inputCount || 0),
    detailLongImageInputImages: Array.isArray(stitch.inputImages) ? stitch.inputImages : [],
    errors: [...new Set(errors.filter(Boolean).map(String))],
    warnings: [...new Set(warnings.filter(Boolean).map(String))],
  };
}

function inspectArtifacts(paths, owner) {
  const media = readMediaResult(paths, owner);
  if (!media) return { state: 'none', media: null, stitch: null };
  const stitch = readStitchResult(paths, owner, media);
  if (!stitch) return { state: 'media_complete', media, stitch: null };
  return { state: 'complete', media, stitch };
}

function replaceOwner(paths, params, fingerprint, priorOwner, transitionToken) {
  assertTransitionLockOwner(paths, transitionToken);
  const owner = buildOwner(
    params,
    paths,
    fingerprint,
    priorOwner.outputDir,
    priorOwner.ownerN8nExecutionId,
  );
  atomicWriteJson(paths.ownerPath, owner);
  atomicWriteJson(paths.heartbeatPath, buildHeartbeat(owner, 'recovery'));
  removeFileIfExists(paths.receiptPath);
  return owner;
}

function preflight(params, options = {}) {
  const isWebhook = params?.isWebhook === true;
  if (!isWebhook) {
    return {
      action: 'owner',
      idempotency: { enabled: false },
      ownerN8nExecutionId: String(params?.requestN8nExecutionId || ''),
      outputDir: String(params?.expectedOutputDir || ''),
      downloadResult: null,
      response: null,
    };
  }

  let paths;
  try {
    paths = statePaths(params);
  } catch (error) {
    const fallbackPaths = {
      workflowCode: String(params?.workflowCode || ''),
      downloadJobId: String(params?.downloadJobId || ''),
    };
    return {
      action: 'invalid',
      response: {
        success: false,
        status: 'validation_error',
        httpStatus: 400,
        errors: [error.message || String(error)],
        warnings: [],
        ...terminalFields(fallbackPaths, null, 'failed', false, params?.requestN8nExecutionId),
      },
      idempotency: null,
    };
  }

  const fingerprint = buildFingerprint(params);
  ensureSafeStateRoot(paths);
  const freshOwner = buildOwner(params, paths, fingerprint);
  if (!fs.existsSync(paths.jobDir) && createJobState(paths, freshOwner)) {
    return ownerOutcome(paths, freshOwner);
  }

  let owner = readJsonIfExists(paths.ownerPath);
  let receipt = readJsonIfExists(paths.receiptPath);
  if (!owner) return conflictOutcome(paths, null, params, 'The idempotency state has no verifiable owner.', 'idempotency_orphaned');
  if (owner.fingerprint !== fingerprint) {
    return conflictOutcome(paths, owner, params, 'downloadJobId is already bound to a different request identity.');
  }
  if (receipt && receipt.fingerprint !== fingerprint) {
    return conflictOutcome(paths, owner, params, 'The saved receipt does not match this request identity.');
  }
  if (receipt && receipt.owner?.ownerToken !== owner.ownerToken) {
    return conflictOutcome(paths, owner, params, 'The saved receipt owner token does not match the current owner.', 'idempotency_orphaned');
  }
  if (receipt && (receipt.state === 'succeeded' || receipt.state === 'failed')) {
    return receiptOutcome(paths, receipt, params);
  }

  const heartbeat = readJsonIfExists(paths.heartbeatPath);
  const now = Number.isFinite(Number(options.now)) ? Number(options.now) : Date.now();
  const staleMs = Number.isFinite(Number(options.staleMs)) ? Number(options.staleMs) : STALE_HEARTBEAT_MS;
  if (!receipt && heartbeatIsFresh(heartbeat, now, staleMs)) return runningOutcome(paths, owner, params);

  const transitionToken = acquireTransitionLock(paths, {
    now,
    expectedOwnerToken: owner.ownerToken,
    expectedFingerprint: fingerprint,
  });
  if (!transitionToken) return runningOutcome(paths, owner, params);
  try {
    owner = readJsonIfExists(paths.ownerPath);
    receipt = readJsonIfExists(paths.receiptPath);
    if (!owner || owner.fingerprint !== fingerprint) {
      return conflictOutcome(paths, owner, params, 'The idempotency owner changed during recovery.');
    }
    if (receipt && (receipt.state === 'succeeded' || receipt.state === 'failed')) {
      return receiptOutcome(paths, receipt, params);
    }
    const currentHeartbeat = readJsonIfExists(paths.heartbeatPath);
    if (!receipt && heartbeatIsFresh(currentHeartbeat, now, staleMs)) return runningOutcome(paths, owner, params);

    if (receipt && receipt.state === 'retryable') {
      const replacement = replaceOwner(paths, params, fingerprint, owner, transitionToken);
      return ownerOutcome(paths, replacement);
    }

    let artifacts;
    try {
      artifacts = inspectArtifacts(paths, owner);
    } catch (error) {
      if (!['IDEMPOTENCY_ARTIFACT_PATH_UNSAFE', 'IDEMPOTENCY_ARTIFACT_INVALID'].includes(error?.code)) throw error;
      return persistOrphanReceipt(
        paths,
        owner,
        fingerprint,
        params,
        now,
        'Artifact recovery was blocked because output evidence is unsafe or unverifiable: ' + (error.message || String(error)),
        transitionToken,
      );
    }
    if (artifacts.state === 'complete') {
      let result = normalizeTerminalResultContract(
        mergeRecoveredResult(artifacts.media, artifacts.stitch),
        'artifact recovery result',
      );
      const state = result.success ? 'succeeded' : 'failed';
      result = {
        ...result,
        ...terminalFields(paths, owner, state, true, params.requestN8nExecutionId),
      };
      const recoveredReceipt = {
        schemaVersion: SCHEMA_VERSION,
        state,
        fingerprint,
        owner,
        completedAt: nowIso(now),
        recoveredFromArtifacts: true,
        result,
      };
      assertTransitionLockOwner(paths, transitionToken);
      atomicWriteJson(paths.receiptPath, recoveredReceipt);
      return receiptOutcome(paths, recoveredReceipt, params);
    }
    if (artifacts.state === 'media_complete') {
      const replacement = replaceOwner(paths, params, fingerprint, owner, transitionToken);
      return ownerOutcome(paths, replacement, 'resume_stitch', artifacts.media);
    }

    return persistOrphanReceipt(
      paths,
      owner,
      fingerprint,
      params,
      now,
      'The prior execution became stale without verifiable media output; automatic re-download is blocked.',
      transitionToken,
    );
  } finally {
    releaseTransitionLock(paths, transitionToken);
  }
}

function isRetryableResult(result) {
  return Boolean(result?.browserProfileBusy) || RETRYABLE_STATUSES.has(String(result?.status || ''));
}

function normalizeTerminalResultContract(result, source = 'terminal result') {
  const normalized = result && typeof result === 'object' && !Array.isArray(result)
    ? { ...result }
    : {};
  const httpStatus = Number(normalized.httpStatus);
  const validHttpStatus = Number.isInteger(httpStatus) && httpStatus >= 100 && httpStatus <= 599;
  const successfulHttpStatus = validHttpStatus && httpStatus >= 200 && httpStatus < 300 && httpStatus !== 202;
  const errors = Array.isArray(normalized.errors) ? normalized.errors.filter(Boolean).map(String) : [];
  const warnings = Array.isArray(normalized.warnings) ? normalized.warnings.filter(Boolean).map(String) : [];
  const violation = normalized.success === true
    ? !successfulHttpStatus
    : !validHttpStatus || (httpStatus >= 200 && httpStatus < 300);
  if (!violation) {
    return {
      ...normalized,
      httpStatus,
      errors: [...new Set(errors)],
      warnings: [...new Set(warnings)],
    };
  }
  const message = normalized.success === true
    ? `${source} is contradictory: success=true cannot use HTTP ${validHttpStatus ? httpStatus : 'INVALID'}.`
    : `${source} is contradictory: success=false cannot use HTTP ${validHttpStatus ? httpStatus : 'INVALID'}.`;
  return {
    ...normalized,
    success: false,
    status: 'idempotency_terminal_contract_error',
    httpStatus: 500,
    errors: [...new Set([...errors, message])],
    warnings: [...new Set(warnings)],
    terminalContractViolation: {
      source,
      originalSuccess: normalized.success === true,
      originalStatus: String(normalized.status || ''),
      originalHttpStatus: validHttpStatus ? httpStatus : null,
    },
  };
}

function invalidFinalizeResult(message, params = {}) {
  const reference = params?.resultReference && typeof params.resultReference === 'object'
    ? params.resultReference
    : {};
  const inline = params?.inlineResult && typeof params.inlineResult === 'object' && !Array.isArray(params.inlineResult)
    ? params.inlineResult
    : {};
  const errors = Array.isArray(inline.errors) ? inline.errors.map(String) : [];
  return {
    ...inline,
    success: false,
    status: 'idempotency_finalize_artifacts_invalid',
    httpStatus: 500,
    platform: String(inline.platform || (reference.workflowCode === 'E006' ? 'pdd' : '1688')),
    SKU: String(inline.SKU || reference.SKU || ''),
    productName: String(inline.productName || reference.productName || ''),
    productUrl: String(inline.productUrl || reference.productUrl || ''),
    outputDir: String(inline.outputDir || reference.outputDir || ''),
    errors: [...new Set([...errors, String(message || 'Finalize artifacts are incomplete or unverifiable.')])],
    warnings: Array.isArray(inline.warnings) ? inline.warnings.map(String) : [],
  };
}

function manualFinalizeArtifactContext(reference) {
  for (const field of ['workflowCode', 'parentOutputDir', 'outputDir', 'SKU', 'productName', 'platformProductId', 'ownerN8nExecutionId']) {
    if (!String(reference?.[field] || '').trim()) {
      throw artifactInvalidError('Manual finalize result reference ' + field + ' is required.');
    }
  }
  if (!Array.isArray(reference.allowedOutputRoots)) {
    throw artifactInvalidError('Manual finalize result reference allowedOutputRoots must be an array.');
  }
  const workflowCode = normalizeWorkflowCode(reference.workflowCode);
  const parentOutputDir = resolveNativeAbsolute(reference.parentOutputDir, 'resultReference.parentOutputDir');
  assertNoSymlinkAncestors(parentOutputDir, 'resultReference.parentOutputDir');
  const allowedOutputRoots = normalizeAllowedRoots(reference.allowedOutputRoots);
  assertParentInsideAllowedRoots(parentOutputDir, allowedOutputRoots);
  const outputDir = resolveNativeAbsolute(reference.outputDir, 'resultReference.outputDir');
  assertDescendant(outputDir, parentOutputDir, 'resultReference.outputDir');
  const owner = {
    workflowCode,
    outputDir: normalizePortablePath(outputDir),
    SKU: String(reference.SKU || '').trim(),
    productName: String(reference.productName || '').trim().normalize('NFC'),
    platformProductId: String(reference.platformProductId || '').trim(),
    ownerN8nExecutionId: String(reference.ownerN8nExecutionId || '').trim(),
    allowedOutputRoots,
  };
  return {
    paths: { workflowCode, parentOutputDir, allowedOutputRoots },
    owner,
  };
}

function assertFinalizeReferenceMatchesOwner(reference, paths, owner) {
  if (!reference || reference.mode !== 'verified_artifacts') {
    throw artifactInvalidError('Finalize requires a verified_artifacts result reference.');
  }
  for (const field of ['workflowCode', 'parentOutputDir', 'outputDir', 'SKU', 'productName', 'platformProductId', 'ownerN8nExecutionId']) {
    if (!String(reference[field] || '').trim()) {
      throw artifactInvalidError('Finalize result reference ' + field + ' is required.');
    }
  }
  if (!Array.isArray(reference.allowedOutputRoots)) {
    throw artifactInvalidError('Finalize result reference allowedOutputRoots must be an array.');
  }
  if (normalizeWorkflowCode(reference.workflowCode) !== paths.workflowCode) {
    throw artifactInvalidError('Finalize result reference workflowCode does not match the owner.');
  }
  if (!pathEquals(reference.parentOutputDir, paths.parentOutputDir)) {
    throw artifactInvalidError('Finalize result reference parentOutputDir does not match the owner.');
  }
  const referenceRoots = normalizeAllowedRoots(reference.allowedOutputRoots).map(normalizeFingerprintPath).sort();
  const ownerRoots = normalizeAllowedRoots(owner.allowedOutputRoots).map(normalizeFingerprintPath).sort();
  if (JSON.stringify(referenceRoots) !== JSON.stringify(ownerRoots)) {
    throw artifactInvalidError('Finalize result reference allowedOutputRoots do not match the owner.');
  }
  if (!pathEquals(reference.outputDir, owner.outputDir)) {
    throw artifactInvalidError('Finalize result reference outputDir does not match the owner.');
  }
  if (String(reference.ownerN8nExecutionId) !== String(owner.ownerN8nExecutionId || '')) {
    throw artifactInvalidError('Finalize result reference execution does not match the owner.');
  }
  if (String(reference.SKU) !== String(owner.SKU || '')) {
    throw artifactInvalidError('Finalize result reference SKU does not match the owner.');
  }
  if (String(reference.productName).trim().normalize('NFC') !== String(owner.productName || '').trim().normalize('NFC')) {
    throw artifactInvalidError('Finalize result reference productName does not match the owner.');
  }
  if (String(reference.platformProductId) !== String(owner.platformProductId || '')) {
    throw artifactInvalidError('Finalize result reference platform product ID does not match the owner.');
  }
}

function resolveFinalizeResult(params, paths = null, owner = null) {
  if (params?.result && typeof params.result === 'object' && !Array.isArray(params.result)) {
    return { ...params.result };
  }
  const reference = params?.resultReference;
  const inline = params?.inlineResult && typeof params.inlineResult === 'object' && !Array.isArray(params.inlineResult)
    ? { ...params.inlineResult }
    : null;
  if (!reference || reference.mode !== 'verified_artifacts') {
    return inline || invalidFinalizeResult('Finalize requires a result object or verified artifact reference.', params);
  }

  try {
    let artifactPaths = paths;
    let artifactOwner = owner;
    if (artifactPaths && artifactOwner) {
      assertFinalizeReferenceMatchesOwner(reference, artifactPaths, artifactOwner);
    } else {
      const manualContext = manualFinalizeArtifactContext(reference);
      artifactPaths = manualContext.paths;
      artifactOwner = manualContext.owner;
    }
    const artifacts = inspectArtifacts(artifactPaths, artifactOwner);
    // A downstream parser is allowed to downgrade an otherwise valid media
    // manifest (for example partial/invalid gallery validation). Preserve the
    // durable media arrays when available, but let the bounded failure patch
    // win for status, counts and diagnostics so it can never become success.
    if (inline && inline.success !== true) {
      if (artifacts.state === 'complete') {
        return {
          ...mergeRecoveredResult(artifacts.media, artifacts.stitch),
          ...inline,
          success: false,
        };
      }
      if (artifacts.state === 'media_complete') {
        return {
          ...artifacts.media,
          ...inline,
          success: false,
        };
      }
      return inline;
    }
    if (artifacts.state === 'complete') return mergeRecoveredResult(artifacts.media, artifacts.stitch);
    if (inline && inline.success !== true) return inline;
    return invalidFinalizeResult(
      artifacts.state === 'media_complete'
        ? 'Finalize found verified media output but no complete long-image manifest.'
        : 'Finalize found no complete, verifiable media output.',
      params,
    );
  } catch (error) {
    return invalidFinalizeResult(
      'Finalize artifact verification failed: ' + (error?.message || String(error)),
      params,
    );
  }
}

function finalize(params) {
  if (params?.isWebhook !== true || params?.idempotency?.enabled !== true) {
    const result = normalizeTerminalResultContract(resolveFinalizeResult(params), 'finalize result');
    const state = result.success ? 'succeeded' : 'failed';
    const isWebhook = params?.isWebhook === true;
    return {
      ...result,
      downloadJobId: isWebhook ? String(params?.downloadJobId || '') : '',
      idempotencyState: state,
      idempotencyReplay: false,
      ownerN8nExecutionId: String(params?.ownerN8nExecutionId || params?.requestN8nExecutionId || ''),
      requestN8nExecutionId: String(params?.requestN8nExecutionId || ''),
    };
  }

  const context = params.idempotency;
  const paths = statePaths({
    workflowCode: context.workflowCode,
    downloadJobId: context.downloadJobId,
    parentOutputDir: context.parentOutputDir,
    allowedOutputRoots: context.allowedOutputRoots,
  });
  let owner = readJsonIfExists(paths.ownerPath);
  const transitionToken = acquireTransitionLock(paths, {
    expectedOwnerToken: context.ownerToken,
    expectedFingerprint: context.fingerprint,
  });
  if (!transitionToken) {
    return statusResponse(paths, owner, params, {
      status: 'idempotency_in_progress',
      httpStatus: 202,
      idempotencyState: 'running',
      message: 'Another execution is changing the idempotency state; retry finalize through the same job.',
      retryAfterMs: DEFAULT_RETRY_AFTER_MS,
    });
  }
  try {
    // CAS is intentionally checked again inside the transition lock. This
    // prevents an old execution from writing a receipt after recovery takeover.
    owner = readJsonIfExists(paths.ownerPath);
    const existingReceipt = readJsonIfExists(paths.receiptPath);
    if (
      !owner
      || owner.ownerToken !== context.ownerToken
      || owner.fingerprint !== context.fingerprint
      || owner.downloadJobId !== paths.downloadJobId
    ) {
      return statusResponse(paths, owner, params, {
        status: 'idempotency_owner_lost',
        httpStatus: 409,
        idempotencyState: 'failed',
        message: 'This execution no longer owns the idempotency record; its late result was rejected.',
      });
    }
    if (
      existingReceipt
      && (existingReceipt.state === 'succeeded' || existingReceipt.state === 'failed')
      && existingReceipt.owner?.ownerToken === owner.ownerToken
    ) {
      const normalized = normalizeTerminalResultContract(existingReceipt.result || {}, 'existing receipt');
      const state = normalized.success === true ? 'succeeded' : 'failed';
      return {
        ...normalized,
        ...terminalFields(paths, owner, state, true, params.requestN8nExecutionId),
      };
    }

    const result = normalizeTerminalResultContract(
      resolveFinalizeResult(params, paths, owner),
      'finalize result',
    );
    const retryable = isRetryableResult(result);
    const state = retryable ? 'retryable' : (result.success ? 'succeeded' : 'failed');
    const enriched = {
      ...result,
      ...terminalFields(paths, owner, state, false, params.requestN8nExecutionId),
    };
    const receipt = {
      schemaVersion: SCHEMA_VERSION,
      state,
      fingerprint: owner.fingerprint,
      owner,
      completedAt: nowIso(),
      recoveredFromArtifacts: false,
      result: enriched,
    };
    assertTransitionLockOwner(paths, transitionToken);
    atomicWriteJson(paths.receiptPath, receipt);
    atomicWriteJson(paths.heartbeatPath, buildHeartbeat(owner, 'finalized'));
    return enriched;
  } finally {
    releaseTransitionLock(paths, transitionToken);
  }
}

function touchHeartbeat(context, phase = 'running') {
  if (!context || context.enabled !== true) return false;
  const paths = statePaths({
    workflowCode: context.workflowCode,
    downloadJobId: context.downloadJobId,
    parentOutputDir: context.parentOutputDir,
    allowedOutputRoots: context.allowedOutputRoots,
  });
  const transitionToken = acquireTransitionLock(paths, {
    expectedOwnerToken: context.ownerToken,
    expectedFingerprint: context.fingerprint,
  });
  if (!transitionToken) {
    const error = new Error('Idempotency transition is busy while refreshing heartbeat.');
    error.code = 'IDEMPOTENCY_TRANSITION_BUSY';
    throw error;
  }
  try {
    const owner = readJsonIfExists(paths.ownerPath);
    const receipt = readJsonIfExists(paths.receiptPath);
    if (
      !owner
      || owner.ownerToken !== context.ownerToken
      || owner.fingerprint !== context.fingerprint
      || owner.downloadJobId !== paths.downloadJobId
      || Boolean(receipt)
    ) {
      const error = new Error('Idempotency heartbeat owner mismatch.');
      error.code = 'IDEMPOTENCY_OWNER_LOST';
      throw error;
    }
    assertTransitionLockOwner(paths, transitionToken);
    atomicWriteJson(paths.heartbeatPath, buildHeartbeat(owner, phase));
    return true;
  } finally {
    releaseTransitionLock(paths, transitionToken);
  }
}

function startHeartbeat(context, phase = 'running', options = {}) {
  if (!context || context.enabled !== true) return { enabled: false, stop() {}, assertOwned() { return true; }, ownerLostError: null };
  touchHeartbeat(context, phase);
  const intervalMs = Number.isFinite(Number(options.intervalMs))
    ? Math.max(100, Number(options.intervalMs))
    : HEARTBEAT_INTERVAL_MS;
  const onError = typeof options.onError === 'function'
    ? options.onError
    : (error) => process.stderr.write('[idempotency-heartbeat] ' + (error.message || String(error)) + '\n');
  let ownerLostError = null;
  let stopped = false;
  const reportError = (error) => {
    if (error?.code === 'IDEMPOTENCY_OWNER_LOST') {
      ownerLostError = error;
      stopped = true;
      clearInterval(timer);
      if (typeof options.onOwnerLost === 'function') {
        Promise.resolve(options.onOwnerLost(error)).catch(() => {});
      }
    }
    onError(error);
  };
  const timer = setInterval(() => {
    try {
      touchHeartbeat(context, phase);
    } catch (error) {
      reportError(error);
    }
  }, intervalMs);
  if (typeof timer.unref === 'function') timer.unref();
  return {
    enabled: true,
    stop() {
      stopped = true;
      clearInterval(timer);
    },
    assertOwned() {
      if (ownerLostError) throw ownerLostError;
      if (stopped) return true;
      try {
        return touchHeartbeat(context, phase);
      } catch (error) {
        reportError(error);
        throw error;
      }
    },
    get ownerLostError() {
      return ownerLostError;
    },
  };
}

function decodePayload(value) {
  const raw = String(value || '');
  if (!raw) throw new Error('Missing Base64 JSON payload.');
  if (raw.length > Math.ceil(MAX_BASE64_PAYLOAD_BYTES / 3) * 4) throw new Error('Base64 JSON payload is too large.');
  if (raw.length % 4 !== 0 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(raw)) {
    throw new Error('Base64 JSON payload is not canonical RFC 4648 Base64.');
  }
  const buffer = Buffer.from(raw, 'base64');
  if (buffer.length > MAX_BASE64_PAYLOAD_BYTES || buffer.toString('base64') !== raw) {
    throw new Error('Base64 JSON payload is not canonical or exceeds the size limit.');
  }
  const decoded = JSON.parse(buffer.toString('utf8'));
  if (!decoded || typeof decoded !== 'object' || Array.isArray(decoded)) {
    throw new Error('Base64 payload must decode to a JSON object.');
  }
  return decoded;
}

function main(argv = process.argv) {
  const command = String(argv[2] || '').trim();
  try {
    const payload = decodePayload(argv[3]);
    const output = command === 'preflight'
      ? preflight(payload)
      : command === 'finalize'
        ? finalize(payload)
        : (() => { throw new Error('Unknown command: ' + command); })();
    process.stdout.write(JSON.stringify(output) + '\n');
  } catch (error) {
    process.stdout.write(JSON.stringify({
      success: false,
      status: 'idempotency_helper_error',
      httpStatus: 500,
      errors: [error.message || String(error)],
      warnings: [],
      downloadJobId: '',
      idempotencyState: 'failed',
      idempotencyReplay: false,
      ownerN8nExecutionId: '',
      requestN8nExecutionId: '',
    }) + '\n');
    process.exitCode = 1;
  }
}

if (require.main === module) main();

module.exports = {
  DEFAULT_RETRY_AFTER_MS,
  HEARTBEAT_INTERVAL_MS,
  MAX_BASE64_PAYLOAD_BYTES,
  SCHEMA_VERSION,
  STALE_HEARTBEAT_MS,
  TRANSITION_LOCK_STALE_MS,
  acquireTransitionLock,
  assertTransitionLockOwner,
  atomicWriteJson,
  buildFingerprint,
  decodePayload,
  finalize,
  heartbeatIsFresh,
  inspectArtifacts,
  isUuid,
  mergeRecoveredResult,
  normalizeFingerprintPath,
  normalizePortablePath,
  normalizeTerminalResultContract,
  preflight,
  releaseTransitionLock,
  resolveFinalizeResult,
  validateMediaList,
  startHeartbeat,
  statePaths,
  touchHeartbeat,
};
