#!/usr/bin/env node
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { isPathWithinRoot } = require('./1688-output-dir-version.cjs');
const { atomicWriteJson, decodePayload, startHeartbeat } = require('./download-idempotency-v1.cjs');

const DEFAULT_OUTPUT_FILE_NAME = '详情长图.png';
const DETAIL_FILE_PATTERN = /^detail_(\d+)\.(jpe?g|png|webp|avif)$/i;
const MAX_INPUT_PIXELS = 100_000_000;
const MAX_INPUT_DIMENSION = 32_768;
const MAX_OUTPUT_PIXELS = 100_000_000;
const MAX_OUTPUT_WIDTH = 16_384;
const MAX_OUTPUT_HEIGHT = 250_000;

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

function toPortablePath(value) {
  return String(value || '').replace(/\\/g, '/');
}

function makeResult(overrides = {}) {
  return {
    schemaVersion: 1,
    success: false,
    status: 'warning',
    nonFatal: true,
    skipped: false,
    n8nExecutionId: '',
    detailImageDir: '',
    detailLongImagePath: '',
    detailLongImageFileName: DEFAULT_OUTPUT_FILE_NAME,
    detailLongImageWidth: 0,
    detailLongImageHeight: 0,
    detailLongImageSizeBytes: 0,
    resultFilePath: '',
    inputImageCount: 0,
    stitchedImageCount: 0,
    inputImages: [],
    stitchedImages: [],
    // Short aliases keep the Execute Command parser simple while the explicit
    // detailLongImage* fields remain compatible with the final workflow result.
    path: '',
    fileName: DEFAULT_OUTPUT_FILE_NAME,
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

function markWarning(result, code, message, { skipped = false } = {}) {
  result.success = false;
  result.status = 'warning';
  result.nonFatal = true;
  result.skipped = skipped;
  result.errorCode = code;
  result.errorDetails.push({ code, message });
  // Detail-long-image failures are explicitly non-fatal for the parent media
  // download. Keep errors empty so a generic parent aggregator cannot
  // accidentally turn a successful download into a failed task.
  result.warnings.push(message);
  return result;
}

function printResult(result) {
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

function writeResultFile(params, result) {
  const requestedPath = stripMatchingQuotes(params?.resultFilePath || '');
  if (!requestedPath) return '';
  const outputDir = resolveAbsolutePath(params.outputDir, 'outputDir');
  const resolvedPath = resolveAbsolutePath(requestedPath, 'resultFilePath');
  if (!isPathWithinRoot(resolvedPath, outputDir)) {
    throw codedError('RESULT_PATH_OUTSIDE_OUTPUT', 'resultFilePath must be inside outputDir.');
  }
  fs.mkdirSync(path.dirname(resolvedPath), { recursive: true });
  if (!isPathWithinRoot(realpath(path.dirname(resolvedPath)), realpath(outputDir))) {
    throw codedError('RESULT_PATH_SYMLINK_ESCAPE', 'resultFilePath resolves outside outputDir through a symbolic link or junction.');
  }
  if (fs.existsSync(resolvedPath) && fs.lstatSync(resolvedPath).isSymbolicLink()) {
    throw codedError('RESULT_PATH_SYMLINK_ESCAPE', 'resultFilePath must not be a symbolic link or junction.');
  }
  result.resultFilePath = toPortablePath(resolvedPath);
  atomicWriteJson(resolvedPath, result);
  return result.resultFilePath;
}

function decodeParams(argv = process.argv) {
  const raw = String(argv[2] || '');
  if (!raw) {
    return { params: null, error: codedError('PARAMS_MISSING', 'Missing Base64 parameter payload.') };
  }
  try {
    const params = decodePayload(raw);
    return { params, error: null };
  } catch (error) {
    if (error && error.code === 'PARAMS_INVALID') return { params: null, error };
    return {
      params: null,
      error: codedError('PARAMS_INVALID', `Invalid Base64 JSON parameter payload: ${error.message || String(error)}`, error),
    };
  }
}

function resolveAbsolutePath(value, fieldName) {
  const text = stripMatchingQuotes(value);
  if (!text) throw codedError('PATH_EMPTY', `${fieldName} is empty.`);
  if (text.includes('\0')) throw codedError('PATH_INVALID', `${fieldName} contains a NUL byte.`);
  if (!path.isAbsolute(text)) {
    throw codedError('PATH_NOT_ABSOLUTE', `${fieldName} must be an absolute path for the current operating system.`);
  }
  return path.resolve(text);
}

function validateOutputFileName(value) {
  const fileName = String(value || DEFAULT_OUTPUT_FILE_NAME).trim();
  if (!fileName || fileName !== path.basename(fileName) || /[/\\\0\u0000-\u001f]/u.test(fileName)) {
    throw codedError('OUTPUT_FILE_NAME_UNSAFE', 'outputFileName must be a plain file name without path separators.');
  }
  if (path.extname(fileName).toLowerCase() !== '.png') {
    throw codedError('OUTPUT_FILE_TYPE_INVALID', 'outputFileName must use the .png extension.');
  }
  return fileName;
}

function realpath(value) {
  return fs.realpathSync.native ? fs.realpathSync.native(value) : fs.realpathSync(value);
}

function resolveStitchPaths(params) {
  const outputDir = resolveAbsolutePath(params.outputDir, 'outputDir');
  if (!fs.existsSync(outputDir) || !fs.statSync(outputDir).isDirectory()) {
    throw codedError('OUTPUT_DIR_NOT_FOUND', `outputDir is not an existing directory: ${outputDir}`);
  }
  if (fs.lstatSync(outputDir).isSymbolicLink()) {
    throw codedError('OUTPUT_DIR_SYMLINK_UNSAFE', 'outputDir must not be a symbolic link or junction.');
  }

  const detailImageDir = params.detailImageDir
    ? resolveAbsolutePath(params.detailImageDir, 'detailImageDir')
    : path.join(outputDir, 'detail-images');
  if (!isPathWithinRoot(detailImageDir, outputDir)) {
    throw codedError('DETAIL_DIR_OUTSIDE_OUTPUT', 'detailImageDir must be outputDir itself or one of its descendants.');
  }

  if (fs.existsSync(detailImageDir)) {
    if (!fs.statSync(detailImageDir).isDirectory()) {
      throw codedError('DETAIL_DIR_NOT_DIRECTORY', `detailImageDir is not a directory: ${detailImageDir}`);
    }
    if (!isPathWithinRoot(realpath(detailImageDir), realpath(outputDir))) {
      throw codedError(
        'DETAIL_DIR_SYMLINK_ESCAPE',
        'detailImageDir resolves outside outputDir through a symbolic link or junction.',
      );
    }
  }

  const outputFileName = validateOutputFileName(params.outputFileName);
  const outputPath = path.join(detailImageDir, outputFileName);
  if (!isPathWithinRoot(outputPath, detailImageDir)) {
    throw codedError('OUTPUT_PATH_OUTSIDE_DETAIL_DIR', 'Detail long image output path escaped detailImageDir.');
  }
  if (fs.existsSync(outputPath) && fs.lstatSync(outputPath).isSymbolicLink()) {
    throw codedError('OUTPUT_PATH_SYMLINK_ESCAPE', 'Detail long image output path must not be a symbolic link or junction.');
  }
  return { outputDir, detailImageDir, outputFileName, outputPath };
}

function detailIndex(filePath) {
  const match = path.basename(String(filePath || '')).match(DETAIL_FILE_PATTERN);
  return match ? Number.parseInt(match[1], 10) : Number.MAX_SAFE_INTEGER;
}

function compareDetailFiles(a, b) {
  const indexDifference = detailIndex(a) - detailIndex(b);
  if (indexDifference !== 0) return indexDifference;
  return path.basename(a).localeCompare(path.basename(b), 'en', { numeric: true, sensitivity: 'base' });
}

function scanDetailDir(detailImageDir) {
  if (!fs.existsSync(detailImageDir)) return [];
  let entries;
  try {
    entries = fs.readdirSync(detailImageDir, { withFileTypes: true });
  } catch (error) {
    throw codedError('DETAIL_DIR_READ_FAILED', `Cannot read detailImageDir: ${error.message || String(error)}`, error);
  }
  return entries
    .filter((entry) => entry.isFile() && DETAIL_FILE_PATTERN.test(entry.name))
    .map((entry) => path.join(detailImageDir, entry.name))
    .sort(compareDetailFiles);
}

function loadSharp() {
  const candidates = ['sharp'];
  const nodePathRoots = String(process.env.NODE_PATH || '').split(path.delimiter).filter(Boolean);
  for (const root of nodePathRoots) candidates.push(path.join(root, 'sharp'));

  const home = process.env.USERPROFILE || process.env.HOME || '';
  const appData = process.env.APPDATA || '';
  if (appData) candidates.push(path.join(appData, 'npm', 'node_modules', 'sharp'));
  if (home) {
    candidates.push(path.join(home, '.npm-global', 'lib', 'node_modules', 'sharp'));
    candidates.push(path.join(home, 'node_modules', 'sharp'));
  }
  candidates.push('/opt/homebrew/lib/node_modules/sharp', '/usr/local/lib/node_modules/sharp');

  let firstError;
  for (const candidate of candidates) {
    try {
      return require(candidate);
    } catch (error) {
      if (!firstError) firstError = error;
    }
  }
  throw codedError(
    'SHARP_NOT_AVAILABLE',
    'The sharp package is required to stitch jpg/jpeg/png/webp/avif detail images. Install project dependencies for this operating system.',
    firstError,
  );
}

async function decodeImageToPng(sharp, file) {
  let metadata;
  try {
    metadata = await sharp(file, { limitInputPixels: MAX_INPUT_PIXELS, failOn: 'error' }).metadata();
  } catch (error) {
    const code = /pixel limit/i.test(error.message || '')
      ? 'INPUT_PIXEL_LIMIT_EXCEEDED'
      : 'IMAGE_METADATA_UNREADABLE';
    throw codedError(code, `Cannot inspect ${path.basename(file)}: ${error.message || String(error)}`, error);
  }
  if (!metadata.width || !metadata.height) {
    throw codedError('IMAGE_DIMENSIONS_INVALID', `Cannot read image dimensions: ${file}`);
  }
  if (metadata.width > MAX_INPUT_DIMENSION || metadata.height > MAX_INPUT_DIMENSION) {
    throw codedError(
      'INPUT_DIMENSION_LIMIT_EXCEEDED',
      `${path.basename(file)} exceeds the ${MAX_INPUT_DIMENSION}px per-dimension safety limit.`,
    );
  }
  if (metadata.width * metadata.height > MAX_INPUT_PIXELS) {
    throw codedError(
      'INPUT_PIXEL_LIMIT_EXCEEDED',
      `${path.basename(file)} exceeds the ${MAX_INPUT_PIXELS} pixel safety limit.`,
    );
  }

  let converted;
  try {
    converted = await sharp(file, { limitInputPixels: MAX_INPUT_PIXELS, failOn: 'error' })
      .rotate()
      .png()
      .toBuffer({ resolveWithObject: true });
  } catch (error) {
    const code = /pixel limit/i.test(error.message || '')
      ? 'INPUT_PIXEL_LIMIT_EXCEEDED'
      : 'IMAGE_DECODE_FAILED';
    throw codedError(code, `Cannot decode ${path.basename(file)}: ${error.message || String(error)}`, error);
  }
  if (!converted.info || !converted.info.width || !converted.info.height) {
    throw codedError('IMAGE_DIMENSIONS_INVALID', `Cannot read image dimensions: ${file}`);
  }
  return {
    file,
    data: converted.data,
    width: converted.info.width,
    height: converted.info.height,
  };
}

function replaceFileAtomically(temporaryPath, outputPath) {
  try {
    fs.renameSync(temporaryPath, outputPath);
    return;
  } catch (error) {
    if (!fs.existsSync(outputPath) || !['EEXIST', 'EPERM', 'EACCES'].includes(error.code)) throw error;
  }

  const backupPath = `${outputPath}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.old`;
  fs.renameSync(outputPath, backupPath);
  try {
    fs.renameSync(temporaryPath, outputPath);
    fs.rmSync(backupPath, { force: true });
  } catch (error) {
    if (!fs.existsSync(outputPath) && fs.existsSync(backupPath)) fs.renameSync(backupPath, outputPath);
    throw error;
  }
}

async function stitchImages({ sharp, files, outputPath }) {
  if (typeof sharp.cache === 'function') sharp.cache(false);
  const decoded = [];
  const warnings = [];
  const decodeFailures = [];

  for (const file of files) {
    try {
      decoded.push(await decodeImageToPng(sharp, file));
    } catch (error) {
      const code = error.code || 'IMAGE_UNREADABLE';
      const message = `Skipped ${path.basename(file)}: ${error.message || String(error)}`;
      decodeFailures.push({ code, message });
      warnings.push(`[${code}] ${message}`);
    }
  }
  if (!decoded.length) {
    const safetyFailure = decodeFailures.find(({ code }) => code.endsWith('_LIMIT_EXCEEDED'));
    if (safetyFailure) throw codedError(safetyFailure.code, safetyFailure.message);
    throw codedError('NO_READABLE_DETAIL_IMAGES', 'No readable detail images were available for stitching.');
  }

  const targetWidth = Math.max(...decoded.map((item) => item.width));
  const estimatedHeight = decoded.reduce((sum, item) => (
    sum + (item.width === targetWidth
      ? item.height
      : Math.max(1, Math.round(item.height * targetWidth / item.width)))
  ), 0);
  if (targetWidth > MAX_OUTPUT_WIDTH) {
    throw codedError(
      'OUTPUT_WIDTH_LIMIT_EXCEEDED',
      `Detail long image width ${targetWidth}px exceeds the ${MAX_OUTPUT_WIDTH}px safety limit.`,
    );
  }
  if (estimatedHeight > MAX_OUTPUT_HEIGHT) {
    throw codedError(
      'OUTPUT_HEIGHT_LIMIT_EXCEEDED',
      `Detail long image height ${estimatedHeight}px exceeds the ${MAX_OUTPUT_HEIGHT}px safety limit.`,
    );
  }
  if (targetWidth * estimatedHeight > MAX_OUTPUT_PIXELS) {
    throw codedError(
      'OUTPUT_PIXEL_LIMIT_EXCEEDED',
      `Detail long image exceeds the ${MAX_OUTPUT_PIXELS} pixel safety limit.`,
    );
  }

  const prepared = [];
  for (const item of decoded) {
    if (item.width === targetWidth) {
      prepared.push(item);
      continue;
    }
    const resized = await sharp(item.data, { limitInputPixels: MAX_INPUT_PIXELS, failOn: 'error' })
      .resize({ width: targetWidth })
      .png()
      .toBuffer({ resolveWithObject: true });
    if (!resized.info || !resized.info.width || !resized.info.height) {
      throw codedError('IMAGE_RESIZE_FAILED', `Cannot determine resized dimensions: ${item.file}`);
    }
    prepared.push({
      ...item,
      data: resized.data,
      width: resized.info.width,
      height: resized.info.height,
    });
    warnings.push(`${path.basename(item.file)} resized from ${item.width}px to ${targetWidth}px width.`);
  }

  let top = 0;
  const composite = prepared.map((item) => {
    const layer = { input: item.data, left: 0, top };
    top += item.height;
    return layer;
  });
  if (!Number.isSafeInteger(targetWidth) || targetWidth <= 0 || !Number.isSafeInteger(top) || top <= 0) {
    throw codedError('OUTPUT_DIMENSIONS_INVALID', 'Calculated detail long image dimensions are invalid.');
  }
  if (targetWidth > MAX_OUTPUT_WIDTH || top > MAX_OUTPUT_HEIGHT || targetWidth * top > MAX_OUTPUT_PIXELS) {
    throw codedError('OUTPUT_PIXEL_LIMIT_EXCEEDED', 'Rendered detail long image exceeds configured dimension or pixel safety limits.');
  }

  const temporaryPath = path.join(
    path.dirname(outputPath),
    `.${path.basename(outputPath)}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp.png`,
  );
  try {
    await sharp({
      create: {
        width: targetWidth,
        height: top,
        channels: 4,
        background: { r: 255, g: 255, b: 255, alpha: 0 },
      },
    })
      .composite(composite)
      .png({ compressionLevel: 9, adaptiveFiltering: true })
      .toFile(temporaryPath);
    replaceFileAtomically(temporaryPath, outputPath);
  } finally {
    fs.rmSync(temporaryPath, { force: true });
  }

  return {
    width: targetWidth,
    height: top,
    warnings,
    stitchedFiles: prepared.map((item) => item.file),
  };
}

function provisionalHumanVerificationResult(params) {
  const outputDir = stripMatchingQuotes(params.outputDir || '');
  const detailImageDir = stripMatchingQuotes(
    params.detailImageDir || (outputDir ? path.join(outputDir, 'detail-images') : ''),
  );
  let outputFileName = String(params.outputFileName || DEFAULT_OUTPUT_FILE_NAME).trim();
  if (!outputFileName || /[/\\]/u.test(outputFileName)) outputFileName = DEFAULT_OUTPUT_FILE_NAME;
  const outputPath = detailImageDir ? path.join(detailImageDir, outputFileName) : '';
  return makeResult({
    skipped: true,
    n8nExecutionId: String(params.n8nExecutionId || ''),
    detailImageDir: toPortablePath(detailImageDir),
    detailLongImagePath: toPortablePath(outputPath),
    detailLongImageFileName: outputFileName,
    path: toPortablePath(outputPath),
    fileName: outputFileName,
  });
}

async function run(params, { sharpLoader = loadSharp } = {}) {
  if (params.needLoginOrCaptcha === true) {
    return markWarning(
      provisionalHumanVerificationResult(params),
      'HUMAN_VERIFICATION_REQUIRED',
      'Skipped detail long image stitching because the product page requires login, captcha, or risk-control verification.',
      { skipped: true },
    );
  }

  let paths;
  try {
    paths = resolveStitchPaths(params);
  } catch (error) {
    return markWarning(makeResult(), error.code || 'PATH_VALIDATION_FAILED', error.message || String(error));
  }

  const result = makeResult({
    n8nExecutionId: String(params.n8nExecutionId || ''),
    detailImageDir: toPortablePath(paths.detailImageDir),
    detailLongImagePath: toPortablePath(paths.outputPath),
    detailLongImageFileName: paths.outputFileName,
    path: toPortablePath(paths.outputPath),
    fileName: paths.outputFileName,
  });

  let files;
  try {
    files = scanDetailDir(paths.detailImageDir);
  } catch (error) {
    return markWarning(result, error.code || 'DETAIL_DIR_READ_FAILED', error.message || String(error));
  }
  result.inputImages = files.map(toPortablePath);
  result.inputImageCount = files.length;
  result.inputCount = files.length;
  if (!files.length) {
    return markWarning(
      result,
      'NO_DETAIL_IMAGES',
      `No detail_# jpg/jpeg/png/webp/avif images found in: ${toPortablePath(paths.detailImageDir)}`,
      { skipped: true },
    );
  }

  try {
    const sharp = sharpLoader();
    const stitched = await stitchImages({ sharp, files, outputPath: paths.outputPath });
    const stat = fs.statSync(paths.outputPath);
    result.success = true;
    result.status = 'success';
    result.skipped = false;
    result.detailLongImageWidth = stitched.width;
    result.detailLongImageHeight = stitched.height;
    result.detailLongImageSizeBytes = stat.size;
    result.stitchedImages = stitched.stitchedFiles.map(toPortablePath);
    result.stitchedImageCount = stitched.stitchedFiles.length;
    result.width = stitched.width;
    result.height = stitched.height;
    result.sizeBytes = stat.size;
    result.warnings.push(...stitched.warnings);
    return result;
  } catch (error) {
    return markWarning(result, error.code || 'STITCH_FAILED', error.message || String(error));
  }
}

async function main(argv = process.argv) {
  const decoded = decodeParams(argv);
  if (decoded.error) {
    printResult(markWarning(makeResult(), decoded.error.code, decoded.error.message));
    return;
  }
  let heartbeatGuard;
  try {
    heartbeatGuard = startHeartbeat(decoded.params.idempotency, 'detail_stitch');
  } catch (error) {
    printResult(markWarning(
      makeResult(),
      error.code || 'IDEMPOTENCY_OWNER_LOST',
      `Cannot start idempotency heartbeat: ${error.message || String(error)}`,
    ));
    return;
  }
  let result;
  try {
    heartbeatGuard.assertOwned();
    result = await run(decoded.params);
    heartbeatGuard.assertOwned();
  } catch (error) {
    heartbeatGuard.stop();
    printResult(markWarning(
      makeResult({ n8nExecutionId: String(decoded.params.n8nExecutionId || '') }),
      error.code || 'IDEMPOTENCY_OWNER_LOST',
      `Idempotency ownership check failed: ${error.message || String(error)}`,
    ));
    return;
  }
  try {
    heartbeatGuard.assertOwned();
    writeResultFile(decoded.params, result);
  } catch (error) {
    markWarning(result, error.code || 'RESULT_FILE_WRITE_FAILED', error.message || String(error));
  }
  heartbeatGuard.stop();
  printResult(result);
}

if (require.main === module) {
  main().catch((error) => {
    printResult(markWarning(
      makeResult(),
      error.code || 'STITCHER_UNEXPECTED_FAILURE',
      `Unexpected detail stitcher failure: ${error.message || String(error)}`,
    ));
  });
}

module.exports = {
  DETAIL_FILE_PATTERN,
  MAX_INPUT_DIMENSION,
  MAX_INPUT_PIXELS,
  MAX_OUTPUT_HEIGHT,
  MAX_OUTPUT_PIXELS,
  MAX_OUTPUT_WIDTH,
  compareDetailFiles,
  decodeParams,
  detailIndex,
  loadSharp,
  makeResult,
  resolveStitchPaths,
  run,
  scanDetailDir,
  stitchImages,
  validateOutputFileName,
  writeResultFile,
};
