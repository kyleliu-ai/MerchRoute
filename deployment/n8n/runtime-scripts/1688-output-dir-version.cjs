'use strict';

const fs = require('node:fs');
const path = require('node:path');

const WINDOWS_RESERVED_NAME = /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\..*)?$/i;

function codedError(code, message, cause) {
  const error = new Error(message, cause ? { cause } : undefined);
  error.code = code;
  return error;
}

function stripMatchingQuotes(value) {
  let text = String(value ?? '').trim();
  if (text.length >= 2) {
    const first = text[0];
    const last = text[text.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      text = text.slice(1, -1).trim();
    }
  }
  return text;
}

function resolveAbsoluteDirectory(value, fieldName) {
  const text = stripMatchingQuotes(value);
  if (!text) throw codedError('PATH_EMPTY', `${fieldName} is empty.`);
  if (text.includes('\0')) throw codedError('PATH_INVALID', `${fieldName} contains a NUL byte.`);
  if (!path.isAbsolute(text)) {
    throw codedError('PATH_NOT_ABSOLUTE', `${fieldName} must be an absolute path for the current operating system.`);
  }
  return path.resolve(text);
}

function comparablePath(value) {
  const resolved = path.resolve(value);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function isPathWithinRoot(candidate, root) {
  const relative = path.relative(comparablePath(root), comparablePath(candidate));
  return relative === '' || (
    relative !== '..'
    && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative)
  );
}

function realpath(value) {
  return fs.realpathSync.native ? fs.realpathSync.native(value) : fs.realpathSync(value);
}

function nearestExistingAncestor(value) {
  let current = path.resolve(value);
  while (!fs.existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return current;
}

function normalizeAllowedRoots(allowedOutputRoots) {
  if (allowedOutputRoots === undefined || allowedOutputRoots === null) return [];
  if (!Array.isArray(allowedOutputRoots) || allowedOutputRoots.length === 0) {
    throw codedError('ALLOWED_ROOTS_INVALID', 'allowedOutputRoots must be a non-empty array when provided.');
  }

  const roots = allowedOutputRoots.map((root, index) => (
    resolveAbsoluteDirectory(root, `allowedOutputRoots[${index}]`)
  ));
  return [...new Set(roots.map(comparablePath))].map((comparable) => (
    roots.find((root) => comparablePath(root) === comparable)
  ));
}

function assertLexicallyAllowed(candidate, allowedRoots) {
  if (!allowedRoots.length) return allowedRoots;
  const matchingRoots = allowedRoots.filter((root) => isPathWithinRoot(candidate, root));
  if (!matchingRoots.length) {
    throw codedError('OUTPUT_PATH_OUTSIDE_ALLOWED_ROOT', 'parentOutputDir is outside allowedOutputRoots.');
  }
  return matchingRoots;
}

function assertNoExistingSymlinkEscape(candidate, matchingRoots) {
  if (!matchingRoots.length) return;
  const candidateAncestor = nearestExistingAncestor(candidate);
  const candidateAncestorReal = realpath(candidateAncestor);

  const safe = matchingRoots.some((root) => {
    if (fs.existsSync(root)) {
      let stat;
      try {
        stat = fs.statSync(root);
      } catch (error) {
        throw codedError('ALLOWED_ROOT_UNREADABLE', `Cannot inspect allowed output root: ${root}`, error);
      }
      if (!stat.isDirectory()) {
        throw codedError('ALLOWED_ROOT_NOT_DIRECTORY', `Allowed output root is not a directory: ${root}`);
      }
      return isPathWithinRoot(candidateAncestorReal, realpath(root));
    }

    const rootAncestor = nearestExistingAncestor(root);
    return comparablePath(realpath(rootAncestor)) === comparablePath(candidateAncestorReal);
  });

  if (!safe) {
    throw codedError(
      'OUTPUT_PATH_SYMLINK_ESCAPE',
      'parentOutputDir resolves outside allowedOutputRoots through an existing symbolic link or junction.',
    );
  }
}

function assertRealpathAllowed(candidate, matchingRoots) {
  if (!matchingRoots.length) return;
  const candidateReal = realpath(candidate);
  const safe = matchingRoots.some((root) => (
    fs.existsSync(root)
    && fs.statSync(root).isDirectory()
    && isPathWithinRoot(candidateReal, realpath(root))
  ));
  if (!safe) {
    throw codedError(
      'OUTPUT_PATH_SYMLINK_ESCAPE',
      'parentOutputDir resolves outside allowedOutputRoots through a symbolic link or junction.',
    );
  }
}

function validateSafeProductName(value) {
  const name = String(value ?? '').trim();
  if (!name) throw codedError('PRODUCT_NAME_EMPTY', 'safeProductName is empty.');
  if (name === '.' || name === '..') {
    throw codedError('PRODUCT_NAME_UNSAFE', 'safeProductName cannot be a dot path segment.');
  }
  if (name.length > 120) {
    throw codedError('PRODUCT_NAME_TOO_LONG', 'safeProductName must be at most 120 characters.');
  }
  if (/[/\\\0<>:"|?*\u0000-\u001F]/u.test(name) || /[ .]$/u.test(name) || WINDOWS_RESERVED_NAME.test(name)) {
    throw codedError(
      'PRODUCT_NAME_UNSAFE',
      'safeProductName must be one cross-platform-safe directory name without reserved characters.',
    );
  }
  return name;
}

function validateSku(value) {
  const sku = String(value ?? '');
  if (!/^\d{7}$/.test(sku)) throw codedError('SKU_INVALID', 'SKU must be exactly 7 digits.');
  return sku;
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function findMaxRevision(parentOutputDir, SKU) {
  const parent = resolveAbsoluteDirectory(parentOutputDir, 'parentOutputDir');
  const sku = validateSku(SKU);
  const pattern = new RegExp(`^${escapeRegExp(sku)}-.+-R([1-9]\\d*)$`);
  let maximum = 0;

  for (const entry of fs.readdirSync(parent, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const match = entry.name.match(pattern);
    if (!match) continue;
    const revision = Number(match[1]);
    if (Number.isSafeInteger(revision) && revision > maximum) maximum = revision;
  }
  return maximum;
}

function reserveVersionedOutputDir({ parentOutputDir, SKU, safeProductName, allowedOutputRoots } = {}) {
  const parent = resolveAbsoluteDirectory(parentOutputDir, 'parentOutputDir');
  const sku = validateSku(SKU);
  const productName = validateSafeProductName(safeProductName);
  const roots = normalizeAllowedRoots(allowedOutputRoots);
  const matchingRoots = assertLexicallyAllowed(parent, roots);

  assertNoExistingSymlinkEscape(parent, matchingRoots);
  fs.mkdirSync(parent, { recursive: true });
  if (!fs.statSync(parent).isDirectory()) {
    throw codedError('OUTPUT_PARENT_NOT_DIRECTORY', `parentOutputDir is not a directory: ${parent}`);
  }
  assertRealpathAllowed(parent, matchingRoots);

  let revision = findMaxRevision(parent, sku) + 1;
  for (let attempt = 0; attempt < 100000; attempt += 1, revision += 1) {
    const folderName = `${sku}-${productName}-R${revision}`;
    const outputDir = path.join(parent, folderName);
    try {
      // mkdir with recursive:false is the atomic reservation primitive. Competing
      // processes can calculate the same revision, but only one can create it.
      fs.mkdirSync(outputDir, { recursive: false });
      if (!isPathWithinRoot(realpath(outputDir), realpath(parent))) {
        fs.rmSync(outputDir, { recursive: true, force: true });
        throw codedError('OUTPUT_PATH_SYMLINK_ESCAPE', 'Reserved output directory escaped parentOutputDir.');
      }
      return { outputDir, folderName, revision };
    } catch (error) {
      if (error && error.code === 'EEXIST') continue;
      throw error;
    }
  }

  throw codedError('REVISION_EXHAUSTED', `Unable to reserve a revision directory for SKU ${sku}.`);
}

function reserveExecutionOutputDir({
  parentOutputDir,
  SKU,
  safeProductName,
  n8nExecutionId,
  allowedOutputRoots,
} = {}) {
  const parent = resolveAbsoluteDirectory(parentOutputDir, 'parentOutputDir');
  const sku = validateSku(SKU);
  const productName = validateSafeProductName(safeProductName);
  const executionId = String(n8nExecutionId ?? '').trim();
  if (!/^\d+$/.test(executionId)) {
    throw codedError('EXECUTION_ID_INVALID', 'n8nExecutionId must contain digits only.');
  }

  const roots = normalizeAllowedRoots(allowedOutputRoots);
  const matchingRoots = assertLexicallyAllowed(parent, roots);
  assertNoExistingSymlinkEscape(parent, matchingRoots);
  fs.mkdirSync(parent, { recursive: true });
  if (!fs.statSync(parent).isDirectory()) {
    throw codedError('OUTPUT_PARENT_NOT_DIRECTORY', `parentOutputDir is not a directory: ${parent}`);
  }
  assertRealpathAllowed(parent, matchingRoots);

  const folderName = `${sku}-${productName}-${executionId}`;
  const outputDir = path.join(parent, folderName);
  try {
    fs.mkdirSync(outputDir, { recursive: false });
  } catch (error) {
    if (error && error.code === 'EEXIST') {
      throw codedError(
        'OUTPUT_DIR_EXISTS',
        `Output directory already exists for n8n execution ${executionId}: ${outputDir}`,
      );
    }
    throw error;
  }

  if (!isPathWithinRoot(realpath(outputDir), realpath(parent))) {
    fs.rmSync(outputDir, { recursive: true, force: true });
    throw codedError('OUTPUT_PATH_SYMLINK_ESCAPE', 'Reserved output directory escaped parentOutputDir.');
  }
  return { outputDir, folderName, revision: 1, n8nExecutionId: executionId };
}

module.exports = {
  findMaxRevision,
  isPathWithinRoot,
  reserveExecutionOutputDir,
  reserveVersionedOutputDir,
  validateSafeProductName,
};
