'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const test = require('node:test');
const {
  resolveStitchPaths,
  run,
  scanDetailDir,
} = require('../1688-detail-image-stitcher.cjs');

const execFileAsync = promisify(execFile);

function withTempDir(action) {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), '1688-detail-stitch-')));
  return Promise.resolve()
    .then(() => action(directory))
    .finally(() => fs.rmSync(directory, { recursive: true, force: true }));
}

function createFakeSharp(dimensions, capture = {}) {
  function fakeSharp(input) {
    let width;
    let height;
    let decodeError = null;
    let create = null;

    if (typeof input === 'string') {
      const specification = dimensions[path.basename(input)];
      if (specification instanceof Error) decodeError = specification;
      else if (specification) ({ width, height } = specification);
      else decodeError = new Error(`No fake dimensions for ${path.basename(input)}`);
    } else if (Buffer.isBuffer(input)) {
      ({ width, height } = input.fakeDimensions || {});
    } else if (input && input.create) {
      create = input.create;
      ({ width, height } = create);
    }

    const api = {
      rotate() { return api; },
      async metadata() {
        if (decodeError) throw decodeError;
        return { width, height };
      },
      resize(options) {
        const nextWidth = options.width;
        height = Math.max(1, Math.round(height * nextWidth / width));
        width = nextWidth;
        return api;
      },
      png() { return api; },
      composite(layers) {
        capture.layers = layers;
        capture.canvas = { ...create };
        return api;
      },
      async toBuffer(options = {}) {
        if (decodeError) throw decodeError;
        const data = Buffer.from(`fake:${width}x${height}`);
        data.fakeDimensions = { width, height };
        const info = { width, height, format: 'png' };
        return options.resolveWithObject ? { data, info } : data;
      },
      async toFile(filePath) {
        capture.temporaryOutputPath = filePath;
        fs.writeFileSync(filePath, `fake-png:${width}x${height}`);
        return { width, height, format: 'png' };
      },
    };
    return api;
  }
  fakeSharp.cache = (enabled) => { capture.cacheEnabled = enabled; };
  return fakeSharp;
}

test('scans only supported detail_# files and sorts by numeric index', () => withTempDir((root) => {
  const detailImageDir = path.join(root, 'detail-images');
  fs.mkdirSync(detailImageDir);
  for (const name of [
    'detail_10.jpg',
    'detail_2.PNG',
    'detail_001.avif',
    'detail_2.webp',
    'detail-3.jpeg',
    'detail_4.gif',
    'other_1.jpg',
  ]) fs.writeFileSync(path.join(detailImageDir, name), 'x');

  assert.deepEqual(
    scanDetailDir(detailImageDir).map((file) => path.basename(file)),
    ['detail_001.avif', 'detail_2.PNG', 'detail_2.webp', 'detail_10.jpg'],
  );
}));

test('rejects detail directories outside outputDir and unsafe output names', () => withTempDir((root) => {
  const outputDir = path.join(root, 'output');
  const inside = path.join(outputDir, 'detail-images');
  const outside = path.join(root, 'outside');
  fs.mkdirSync(inside, { recursive: true });
  fs.mkdirSync(outside);

  assert.throws(
    () => resolveStitchPaths({ outputDir, detailImageDir: outside }),
    (error) => error.code === 'DETAIL_DIR_OUTSIDE_OUTPUT',
  );
  assert.throws(
    () => resolveStitchPaths({ outputDir, detailImageDir: inside, outputFileName: '../escape.png' }),
    (error) => error.code === 'OUTPUT_FILE_NAME_UNSAFE',
  );
  assert.throws(
    () => resolveStitchPaths({ outputDir, detailImageDir: inside, outputFileName: 'long.jpg' }),
    (error) => error.code === 'OUTPUT_FILE_TYPE_INVALID',
  );
}));

test('creates a gapless PNG layout, includes AVIF, and publishes through a temporary file', () => withTempDir(async (root) => {
  const outputDir = path.join(root, '产品 output');
  const detailImageDir = path.join(outputDir, 'detail-images');
  fs.mkdirSync(detailImageDir, { recursive: true });
  fs.writeFileSync(path.join(detailImageDir, 'detail_1.jpg'), 'one');
  fs.writeFileSync(path.join(detailImageDir, 'detail_2.avif'), 'two');

  const capture = {};
  const sharp = createFakeSharp({
    'detail_1.jpg': { width: 100, height: 10 },
    'detail_2.avif': { width: 50, height: 10 },
  }, capture);
  const result = await run({ outputDir, detailImageDir }, { sharpLoader: () => sharp });

  assert.equal(result.success, true);
  assert.equal(result.status, 'success');
  assert.equal(result.detailLongImageFileName, '详情长图.png');
  assert.equal(result.detailLongImageWidth, 100);
  assert.equal(result.detailLongImageHeight, 30);
  assert.equal(result.inputImageCount, 2);
  assert.equal(result.stitchedImageCount, 2);
  assert.deepEqual(capture.layers.map(({ top }) => top), [0, 10]);
  assert.deepEqual(capture.canvas, {
    width: 100,
    height: 30,
    channels: 4,
    background: { r: 255, g: 255, b: 255, alpha: 0 },
  });
  assert.equal(capture.cacheEnabled, false);
  assert.ok(fs.existsSync(path.join(detailImageDir, '详情长图.png')));
  assert.match(capture.temporaryOutputPath, /\.tmp\.png$/);
}));

test('skips an unreadable image but still succeeds when another detail image is usable', () => withTempDir(async (root) => {
  const outputDir = path.join(root, 'output');
  const detailImageDir = path.join(outputDir, 'detail-images');
  fs.mkdirSync(detailImageDir, { recursive: true });
  fs.writeFileSync(path.join(detailImageDir, 'detail_1.avif'), 'bad');
  fs.writeFileSync(path.join(detailImageDir, 'detail_2.png'), 'good');
  const sharp = createFakeSharp({
    'detail_1.avif': new Error('AVIF input is not supported by this Sharp build'),
    'detail_2.png': { width: 80, height: 20 },
  });

  const result = await run({ outputDir }, { sharpLoader: () => sharp });
  assert.equal(result.success, true);
  assert.equal(result.inputImageCount, 2);
  assert.equal(result.stitchedImageCount, 1);
  assert.match(result.warnings[0], /IMAGE_METADATA_UNREADABLE.*detail_1\.avif/);
}));

test('returns a structured warning before rendering when final pixels exceed 100MP', () => withTempDir(async (root) => {
  const outputDir = path.join(root, 'output');
  const detailImageDir = path.join(outputDir, 'detail-images');
  fs.mkdirSync(detailImageDir, { recursive: true });
  fs.writeFileSync(path.join(detailImageDir, 'detail_1.jpg'), 'one');
  fs.writeFileSync(path.join(detailImageDir, 'detail_2.png'), 'two');
  const sharp = createFakeSharp({
    'detail_1.jpg': { width: 10_000, height: 6_000 },
    'detail_2.png': { width: 10_000, height: 6_000 },
  });

  const result = await run({ outputDir }, { sharpLoader: () => sharp });
  assert.equal(result.success, false);
  assert.equal(result.nonFatal, true);
  assert.equal(result.errorCode, 'OUTPUT_PIXEL_LIMIT_EXCEEDED');
  assert.equal(result.errors.length, 0);
  assert.match(result.warnings[0], /100000000 pixel safety limit/);
}));

test('returns a structured warning when an input dimension exceeds 32768px', () => withTempDir(async (root) => {
  const outputDir = path.join(root, 'output');
  const detailImageDir = path.join(outputDir, 'detail-images');
  fs.mkdirSync(detailImageDir, { recursive: true });
  fs.writeFileSync(path.join(detailImageDir, 'detail_1.webp'), 'one');
  const sharp = createFakeSharp({
    'detail_1.webp': { width: 40_000, height: 10 },
  });

  const result = await run({ outputDir }, { sharpLoader: () => sharp });
  assert.equal(result.success, false);
  assert.equal(result.errorCode, 'INPUT_DIMENSION_LIMIT_EXCEEDED');
  assert.match(result.warnings[0], /32768px per-dimension safety limit/);
}));

test('all stitch failures are structured non-fatal warnings with an empty errors array', async () => withTempDir(async (root) => {
  const outputDir = path.join(root, 'output');
  fs.mkdirSync(outputDir);
  const result = await run({ outputDir });

  assert.equal(result.success, false);
  assert.equal(result.status, 'warning');
  assert.equal(result.nonFatal, true);
  assert.equal(result.skipped, true);
  assert.equal(result.errorCode, 'NO_DETAIL_IMAGES');
  assert.equal(result.errors.length, 0);
  assert.equal(result.warnings.length, 1);
}));

test('human-verification skip takes precedence even when outputDir is empty', async () => {
  const result = await run({ outputDir: '', needLoginOrCaptcha: true });
  assert.equal(result.skipped, true);
  assert.equal(result.errorCode, 'HUMAN_VERIFICATION_REQUIRED');
  assert.equal(result.detailLongImageFileName, '详情长图.png');
  assert.equal(result.errors.length, 0);
});

test('CLI always prints one parseable warning JSON line and exits zero on missing params', async () => {
  const script = path.resolve(__dirname, '../1688-detail-image-stitcher.cjs');
  const { stdout } = await execFileAsync(process.execPath, [script]);
  const lines = stdout.trim().split(/\r?\n/u);
  assert.equal(lines.length, 1);
  const result = JSON.parse(lines[0]);
  assert.equal(result.status, 'warning');
  assert.equal(result.nonFatal, true);
  assert.equal(result.errorCode, 'PARAMS_MISSING');
});

test('CLI decodes Base64 JSON containing a Chinese path with spaces', () => withTempDir(async (root) => {
  const outputDir = path.join(root, '中文 产品 output');
  fs.mkdirSync(outputDir);
  const resultFilePath = path.join(outputDir, 'metadata', '1688-detail-stitch-result.json');
  const payload = Buffer.from(JSON.stringify({ outputDir, resultFilePath }), 'utf8').toString('base64');
  const script = path.resolve(__dirname, '../1688-detail-image-stitcher.cjs');
  const { stdout } = await execFileAsync(process.execPath, [script, payload]);
  const result = JSON.parse(stdout.trim());

  assert.equal(result.errorCode, 'NO_DETAIL_IMAGES');
  assert.equal(result.detailLongImageFileName, '详情长图.png');
  assert.match(result.detailImageDir, /中文 产品 output\/detail-images$/u);
  assert.equal(result.errors.length, 0);
  assert.equal(result.resultFilePath, resultFilePath.replace(/\\/g, '/'));
  assert.deepEqual(JSON.parse(fs.readFileSync(resultFilePath, 'utf8')), result);
}));

test('real Sharp output is a readable gapless PNG when Sharp is installed', async (t) => {
  let sharp;
  try {
    sharp = require('sharp');
  } catch (error) {
    t.skip('Sharp is not installed in this working tree yet.');
    return;
  }

  await withTempDir(async (root) => {
    const outputDir = path.join(root, 'output');
    const detailImageDir = path.join(outputDir, 'detail-images');
    fs.mkdirSync(detailImageDir, { recursive: true });
    await sharp({ create: { width: 20, height: 10, channels: 3, background: '#ff0000' } })
      .jpeg()
      .toFile(path.join(detailImageDir, 'detail_1.jpg'));
    await sharp({ create: { width: 10, height: 10, channels: 3, background: '#00ff00' } })
      .webp()
      .toFile(path.join(detailImageDir, 'detail_2.webp'));

    const result = await run({ outputDir }, { sharpLoader: () => sharp });
    assert.equal(result.success, true);
    const metadata = await sharp(path.join(detailImageDir, '详情长图.png')).metadata();
    assert.equal(metadata.format, 'png');
    assert.equal(metadata.width, 20);
    assert.equal(metadata.height, 30);
  });
});
