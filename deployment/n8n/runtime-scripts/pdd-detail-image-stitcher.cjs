#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { createRequire } = require('module');
const { atomicWriteJson, decodePayload, startHeartbeat } = require('./download-idempotency-v1.cjs');

const MAX_OUTPUT_PIXELS = 100_000_000;
let activeResultFilePath = '';

function codedError(code, message, cause) {
  const error = new Error(message, cause ? { cause } : undefined);
  error.code = code;
  return error;
}

function normalizePathInput(value) {
  let text = String(value || '').trim();
  if ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'"))) {
    text = text.slice(1, -1).trim();
  }
  const hasUncPrefix = /^\\\\/.test(text) || text.startsWith('//');
  text = text.replace(/\\+/g, '/').replace(/^([A-Za-z]:)\/+/, '$1/');
  return hasUncPrefix ? '//' + text.replace(/^\/+/, '') : text;
}

function resolveAbsolutePath(value, fieldName) {
  const normalized = normalizePathInput(value);
  if (!normalized || normalized.includes('\0') || !path.isAbsolute(normalized)) {
    throw new Error(fieldName + ' must be an absolute path without NUL bytes.');
  }
  return path.resolve(normalized);
}

function isPathWithin(candidate, root) {
  const relative = path.relative(root, candidate);
  return relative === '' || (relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative));
}

function nativeRealpath(value) {
  return fs.realpathSync.native ? fs.realpathSync.native(value) : fs.realpathSync(value);
}

function assertExistingDirectoryWithin(candidate, root, fieldName) {
  const candidateStat = fs.lstatSync(candidate);
  if (!candidateStat.isDirectory() || candidateStat.isSymbolicLink()) throw new Error(fieldName + ' must be a regular directory.');
  if (!isPathWithin(nativeRealpath(candidate), nativeRealpath(root))) {
    throw new Error(fieldName + ' resolves outside outputDir through a symbolic link or junction.');
  }
}

function validateOutputFileName(value) {
  const fileName = String(value || '详情长图.png').trim();
  if (!fileName || fileName !== path.basename(fileName) || /[/\\\0\u0000-\u001f]/u.test(fileName)) {
    throw new Error('outputFileName must be a plain file name without path separators.');
  }
  if (path.extname(fileName).toLowerCase() !== '.png') throw new Error('outputFileName must use the .png extension.');
  return fileName;
}

function resolveStitchPaths(params) {
  const outputDir = resolveAbsolutePath(params.outputDir, 'outputDir');
  if (!fs.existsSync(outputDir) || !fs.statSync(outputDir).isDirectory()) throw new Error('outputDir must be an existing directory.');
  if (fs.lstatSync(outputDir).isSymbolicLink()) throw new Error('outputDir must not be a symbolic link or junction.');
  const outputReal = nativeRealpath(outputDir);
  const detailImageDir = resolveAbsolutePath(params.detailImageDir || path.join(outputDir, 'detail-images'), 'detailImageDir');
  if (!isPathWithin(detailImageDir, outputDir)) throw new Error('detailImageDir must be inside outputDir.');
  if (fs.existsSync(detailImageDir)) assertExistingDirectoryWithin(detailImageDir, outputDir, 'detailImageDir');
  else {
    fs.mkdirSync(detailImageDir, { recursive: true });
    assertExistingDirectoryWithin(detailImageDir, outputDir, 'detailImageDir');
  }
  if (!isPathWithin(nativeRealpath(detailImageDir), outputReal)) throw new Error('detailImageDir resolves outside outputDir.');
  const outputFileName = validateOutputFileName(params.outputFileName);
  const outputPath = path.join(detailImageDir, outputFileName);
  if (!isPathWithin(outputPath, detailImageDir)) throw new Error('Detail long image output path escaped detailImageDir.');
  try {
    if (fs.lstatSync(outputPath).isSymbolicLink()) {
      throw new Error('Detail long image output path must not be a symbolic link or junction.');
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  const metadataDir = path.join(outputDir, 'metadata');
  fs.mkdirSync(metadataDir, { recursive: true });
  assertExistingDirectoryWithin(metadataDir, outputDir, 'metadataDir');
  const expectedResultFilePath = path.join(metadataDir, 'pdd-detail-stitch-result.json');
  return { outputDir, detailImageDir, outputFileName, outputPath, expectedResultFilePath };
}

function makeResult(overrides = {}) {
  return {
    schemaVersion: 1,
    success: false,
    status: 'error',
    nonFatal: false,
    skipped: false,
    n8nExecutionId: '',
    resultFilePath: '',
    detailImageDir: '',
    detailLongImagePath: '',
    detailLongImageFileName: '详情长图.png',
    detailLongImageWidth: 0,
    detailLongImageHeight: 0,
    detailLongImageSizeBytes: 0,
    inputImageCount: 0,
    stitchedImageCount: 0,
    inputImages: [],
    stitchedImages: [],
    path: '',
    fileName: '详情长图.png',
    width: 0,
    height: 0,
    sizeBytes: 0,
    inputCount: 0,
    errorCode: '',
    errorDetails: [],
    errors: [],
    warnings: [],
    ...overrides,
  };
}

function markNonFatalWarning(result, code, message) {
  result.success = false;
  result.status = 'warning';
  result.nonFatal = true;
  result.skipped = false;
  result.errorCode = code;
  result.errorDetails = [{ code, message }];
  result.errors = [];
  result.warnings = [message];
  return result;
}

function printResult(result) {
  const output = { ...result };
  if (activeResultFilePath) {
    output.resultFilePath = activeResultFilePath;
    try {
      atomicWriteJson(activeResultFilePath, output);
    } catch (error) {
      output.warnings = Array.isArray(output.warnings) ? [...output.warnings] : [];
      output.warnings.push('Could not write stitch result file: ' + (error.message || String(error)));
    }
  }
  process.stdout.write(JSON.stringify(output) + '\n');
}

function decodeParams() {
  const raw = process.argv[2] || '';
  if (!raw) return { params: null, error: 'Missing Base64 parameter payload.' };
  try {
    return {
      params: decodePayload(raw),
      error: '',
    };
  } catch (error) {
    return { params: null, error: 'Invalid Base64 parameter payload: ' + error.message };
  }
}

function candidateRequireRoots() {
  const roots = [
    __dirname,
    path.dirname(__dirname),
    process.cwd(),
  ];
  const home = process.env.USERPROFILE || process.env.HOME || '';
  const appData = process.env.APPDATA || '';
  if (home) roots.push(path.join(home, 'node_modules'));
  if (appData) roots.push(path.join(appData, 'npm', 'node_modules'));
  return roots.map(normalizePathInput).filter(Boolean);
}

function loadSharp() {
  try {
    return require('sharp');
  } catch (firstError) {
    for (const root of candidateRequireRoots()) {
      try {
        const resolved = require.resolve('sharp', { paths: [root] });
        return createRequire(resolved)('sharp');
      } catch (error) {}
    }
    const error = new Error('The sharp package is required to stitch jpg/png/webp detail images. Install sharp for the Node.js runtime or place it in a resolvable node_modules directory.');
    error.cause = firstError;
    throw error;
  }
}

function imageExt(filePath) {
  return path.extname(String(filePath || '')).toLowerCase();
}

function isSupportedImage(filePath) {
  return ['.jpg', '.jpeg', '.png', '.webp'].includes(imageExt(filePath));
}

function detailIndex(filePath) {
  const name = path.basename(filePath);
  const match = name.match(/^detail[_-](\d+)\.(?:jpe?g|png|webp)$/i);
  return match ? Number.parseInt(match[1], 10) : Number.MAX_SAFE_INTEGER;
}

function compareDetailFiles(a, b) {
  const ai = detailIndex(a);
  const bi = detailIndex(b);
  if (ai !== bi) return ai - bi;
  return path.basename(a).localeCompare(path.basename(b), 'en', { numeric: true, sensitivity: 'base' });
}

function uniqueExistingImages(paths, detailImageDir) {
  const seen = new Set();
  const output = [];
  for (const item of paths) {
    const normalized = normalizePathInput(item);
    if (!normalized || seen.has(normalized.toLowerCase())) continue;
    seen.add(normalized.toLowerCase());
    try {
      const stat = fs.lstatSync(normalized);
      if (stat.isFile() && !stat.isSymbolicLink() && stat.size > 0 && isSupportedImage(normalized)
        && isPathWithin(path.resolve(normalized), detailImageDir)
        && isPathWithin(nativeRealpath(normalized), nativeRealpath(detailImageDir))) {
        output.push(normalized);
      }
    } catch (error) {}
  }
  return output.sort(compareDetailFiles);
}

function scanDetailDir(detailImageDir) {
  try {
    if (!detailImageDir || !fs.existsSync(detailImageDir) || !fs.statSync(detailImageDir).isDirectory()) return [];
    return fs.readdirSync(detailImageDir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && !entry.isSymbolicLink() && /^detail[_-]\d+\.(?:jpe?g|png|webp)$/i.test(entry.name))
      .map((entry) => normalizePathInput(path.join(detailImageDir, entry.name)))
      .filter((filePath) => {
        try {
          const stat = fs.lstatSync(filePath);
          return stat.isFile() && !stat.isSymbolicLink() && stat.size > 0
            && isPathWithin(nativeRealpath(filePath), nativeRealpath(detailImageDir));
        } catch (error) {
          return false;
        }
      })
      .sort(compareDetailFiles);
  } catch (error) {
    return [];
  }
}

async function stitchImages({ sharp, files, outputPath }) {
  sharp.cache(false);
  const metadata = [];
  for (const file of files) {
    const meta = await sharp(file, { limitInputPixels: false }).rotate().metadata();
    if (!meta.width || !meta.height) throw new Error('Cannot read image dimensions: ' + file);
    metadata.push({ file, width: meta.width, height: meta.height });
  }

  const targetWidth = Math.max(...metadata.map((item) => item.width));
  const estimatedHeight = metadata.reduce((sum, item) => (
    sum + (item.width === targetWidth
      ? item.height
      : Math.max(1, Math.round(item.height * targetWidth / item.width)))
  ), 0);
  if (!Number.isSafeInteger(targetWidth) || targetWidth <= 0
    || !Number.isSafeInteger(estimatedHeight) || estimatedHeight <= 0) {
    throw codedError('OUTPUT_DIMENSIONS_INVALID', 'Calculated detail long image dimensions are invalid.');
  }
  if (targetWidth * estimatedHeight > MAX_OUTPUT_PIXELS) {
    throw codedError(
      'OUTPUT_PIXEL_LIMIT_EXCEEDED',
      `Detail long image exceeds the ${MAX_OUTPUT_PIXELS} pixel safety limit.`,
    );
  }

  let top = 0;
  const composite = [];
  const resizedWarnings = [];

  for (const item of metadata) {
    const nextHeight = item.width === targetWidth
      ? item.height
      : Math.max(1, Math.round(item.height * targetWidth / item.width));
    const image = sharp(item.file, { limitInputPixels: false }).rotate();
    const input = item.width === targetWidth
      ? await image.png().toBuffer()
      : await image.resize({ width: targetWidth }).png().toBuffer();
    if (item.width !== targetWidth) {
      resizedWarnings.push(path.basename(item.file) + ' resized from ' + item.width + 'px to ' + targetWidth + 'px width.');
    }
    composite.push({ input, left: 0, top });
    top += nextHeight;
  }

  if (!Number.isSafeInteger(top) || top <= 0 || targetWidth * top > MAX_OUTPUT_PIXELS) {
    throw codedError(
      'OUTPUT_PIXEL_LIMIT_EXCEEDED',
      `Rendered detail long image exceeds the ${MAX_OUTPUT_PIXELS} pixel safety limit.`,
    );
  }

  await sharp({
    create: {
      width: targetWidth,
      height: top,
      channels: 4,
      background: { r: 255, g: 255, b: 255, alpha: 0 },
    },
    limitInputPixels: false,
  })
    .composite(composite)
    .png()
    .toFile(outputPath);

  return {
    width: targetWidth,
    height: top,
    warnings: resizedWarnings,
  };
}

async function main() {
  const decoded = decodeParams();
  if (decoded.error) {
    printResult(makeResult({ errors: [decoded.error] }));
    return;
  }

  const params = decoded.params || {};
  let heartbeatGuard;
  try {
    heartbeatGuard = startHeartbeat(params.idempotency, 'detail_stitch');
  } catch (error) {
    printResult(makeResult({
      errors: ['Cannot start idempotency heartbeat: ' + (error.message || String(error))],
    }));
    return;
  }
  let paths;
  try {
    paths = resolveStitchPaths(params);
    heartbeatGuard.assertOwned();
  } catch (error) {
    heartbeatGuard.stop();
    printResult(makeResult({
      n8nExecutionId: String(params.n8nExecutionId || ''),
      errors: [error.message || String(error)],
    }));
    return;
  }
  const outputDir = normalizePathInput(paths.outputDir);
  const detailImageDir = normalizePathInput(paths.detailImageDir);
  const expectedResultFilePath = normalizePathInput(paths.expectedResultFilePath);
  const requestedResultFilePath = normalizePathInput(params.resultFilePath || expectedResultFilePath);
  const comparePath = (value) => process.platform === 'win32' ? value.toLowerCase() : value;
  if (requestedResultFilePath && comparePath(requestedResultFilePath) !== comparePath(expectedResultFilePath)) {
    heartbeatGuard.stop();
    printResult(makeResult({
      n8nExecutionId: String(params.n8nExecutionId || ''),
      errors: ['resultFilePath must point to metadata/pdd-detail-stitch-result.json inside outputDir.'],
    }));
    return;
  }
  activeResultFilePath = expectedResultFilePath;
  const outputFileName = paths.outputFileName;
  const outputPath = normalizePathInput(paths.outputPath);
  const result = makeResult({
    n8nExecutionId: String(params.n8nExecutionId || ''),
    resultFilePath: activeResultFilePath,
    detailImageDir,
    detailLongImagePath: outputPath,
    detailLongImageFileName: outputFileName,
    path: outputPath,
    fileName: outputFileName,
  });

  if (params.needLoginOrCaptcha) {
    heartbeatGuard.assertOwned();
    printResult(makeResult({
      skipped: true,
      n8nExecutionId: result.n8nExecutionId,
      resultFilePath: activeResultFilePath,
      detailImageDir,
      detailLongImagePath: outputPath,
      errors: ['Skipped detail long image stitching because the product page requires login, captcha, or risk-control verification.'],
    }));
    heartbeatGuard.stop();
    return;
  }

  if (!detailImageDir) {
    result.errors.push('detailImageDir is empty.');
    heartbeatGuard.assertOwned();
    printResult(result);
    heartbeatGuard.stop();
    return;
  }

  const fromDownloader = Array.isArray(params.detailImages)
    ? params.detailImages.map((item) => item && (item.localPath || item.path || item.filePath)).filter(Boolean)
    : [];
  const files = uniqueExistingImages(fromDownloader, paths.detailImageDir);
  const fallbackFiles = files.length ? files : scanDetailDir(detailImageDir);
  result.inputImages = fallbackFiles;
  result.inputImageCount = fallbackFiles.length;
  result.inputCount = fallbackFiles.length;

  if (!fallbackFiles.length) {
    result.skipped = true;
    result.errors.push('No detail images found to stitch in: ' + detailImageDir);
    heartbeatGuard.assertOwned();
    printResult(result);
    heartbeatGuard.stop();
    return;
  }

  try {
    heartbeatGuard.assertOwned();
    const sharp = loadSharp();
    const stitched = await stitchImages({ sharp, files: fallbackFiles, outputPath });
    heartbeatGuard.assertOwned();
    const stat = fs.statSync(outputPath);
    result.success = true;
    result.status = 'success';
    result.detailLongImageWidth = stitched.width;
    result.detailLongImageHeight = stitched.height;
    result.detailLongImageSizeBytes = stat.size;
    result.stitchedImageCount = fallbackFiles.length;
    result.stitchedImages = [...fallbackFiles];
    result.width = stitched.width;
    result.height = stitched.height;
    result.sizeBytes = stat.size;
    result.warnings.push(...stitched.warnings);
    heartbeatGuard.assertOwned();
    printResult(result);
    heartbeatGuard.stop();
  } catch (error) {
    result.success = false;
    if (error?.code === 'IDEMPOTENCY_OWNER_LOST') {
      result.errors.push('Idempotency ownership was lost; stitch output was not committed.');
      activeResultFilePath = '';
    } else if (error?.code === 'OUTPUT_PIXEL_LIMIT_EXCEEDED') {
      markNonFatalWarning(result, error.code, error.message || String(error));
      heartbeatGuard.assertOwned();
      printResult(result);
      heartbeatGuard.stop();
      return;
    }
    result.status = 'error';
    result.nonFatal = false;
    result.errorCode = error?.code || 'STITCH_FAILED';
    result.errorDetails.push({ code: result.errorCode, message: error.message || String(error) });
    result.errors.push(error.message || String(error));
    heartbeatGuard.stop();
    printResult(result);
  }
}

if (require.main === module) {
  main().catch((error) => {
    activeResultFilePath = '';
    printResult(makeResult({ errors: ['Fatal stitcher error: ' + (error.message || String(error))] }));
  });
}

module.exports = {
  MAX_OUTPUT_PIXELS,
  codedError,
  decodeParams,
  makeResult,
  markNonFatalWarning,
  normalizePathInput,
  resolveStitchPaths,
  scanDetailDir,
  stitchImages,
  uniqueExistingImages,
  validateOutputFileName,
};
