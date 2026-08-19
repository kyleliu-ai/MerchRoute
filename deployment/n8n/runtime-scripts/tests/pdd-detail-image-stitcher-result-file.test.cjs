'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const sharp = require('sharp');

const scriptPath = path.resolve(__dirname, '../pdd-detail-image-stitcher.cjs');
const stitcher = require(scriptPath);

function createFakeSharp(dimensions) {
  let renderCalls = 0;
  const sharp = (input) => {
    if (typeof input === 'string') {
      const metadata = dimensions[path.basename(input)];
      return {
        rotate() { return this; },
        metadata: async () => metadata,
        resize() { return this; },
        png() { return this; },
        toBuffer: async () => Buffer.from(path.basename(input)),
      };
    }
    return {
      composite() { renderCalls += 1; return this; },
      png() { return this; },
      toFile: async () => {},
    };
  };
  sharp.cache = () => {};
  sharp.renderCalls = () => renderCalls;
  return sharp;
}

test('PDD stitch path validation rejects traversal names and symlink escapes', (t) => {
  assert.throws(() => stitcher.validateOutputFileName('../escape.png'), /plain file name/);
  assert.throws(() => stitcher.validateOutputFileName('escape.jpg'), /\.png extension/);
  const outputDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pdd-stitch-path-')));
  t.after(() => fs.rmSync(outputDir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(outputDir, 'detail-images'));
  assert.throws(
    () => stitcher.resolveStitchPaths({ outputDir, outputFileName: '../escape.png' }),
    /plain file name/,
  );
  if (process.platform !== 'win32') {
    const outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pdd-stitch-outside-')));
    t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
    const linkedOutput = path.join(outputDir, 'detail-images', 'linked-output.png');
    fs.symlinkSync(path.join(outside, 'outside.png'), linkedOutput);
    assert.throws(
      () => stitcher.resolveStitchPaths({ outputDir, outputFileName: 'linked-output.png' }),
      /symbolic link|junction/,
    );
  }
});

test('PDD detail stitcher allows exactly 100MP and rejects larger output before rendering', async () => {
  const files = ['detail_01.jpg', 'detail_02.jpg'];
  const boundarySharp = createFakeSharp({
    'detail_01.jpg': { width: 10_000, height: 5_000 },
    'detail_02.jpg': { width: 10_000, height: 5_000 },
  });
  const boundary = await stitcher.stitchImages({
    sharp: boundarySharp,
    files,
    outputPath: '详情长图.png',
  });
  assert.equal(boundary.width * boundary.height, stitcher.MAX_OUTPUT_PIXELS);
  assert.equal(boundarySharp.renderCalls(), 1);

  const oversizedSharp = createFakeSharp({
    'detail_01.jpg': { width: 10_000, height: 6_000 },
    'detail_02.jpg': { width: 10_000, height: 6_000 },
  });
  await assert.rejects(
    stitcher.stitchImages({ sharp: oversizedSharp, files, outputPath: '详情长图.png' }),
    (error) => error?.code === 'OUTPUT_PIXEL_LIMIT_EXCEEDED'
      && /100000000 pixel safety limit/.test(error.message),
  );
  assert.equal(oversizedSharp.renderCalls(), 0);
});

test('PDD 100MP warning uses the strict non-fatal result contract', () => {
  const message = 'Detail long image exceeds the 100000000 pixel safety limit.';
  const result = stitcher.markNonFatalWarning(
    stitcher.makeResult({
      n8nExecutionId: '89218',
      inputImageCount: 2,
      inputCount: 2,
      inputImages: ['detail_01.jpg', 'detail_02.jpg'],
    }),
    'OUTPUT_PIXEL_LIMIT_EXCEEDED',
    message,
  );
  assert.equal(result.schemaVersion, 1);
  assert.equal(result.success, false);
  assert.equal(result.status, 'warning');
  assert.equal(result.nonFatal, true);
  assert.equal(result.skipped, false);
  assert.equal(result.errorCode, 'OUTPUT_PIXEL_LIMIT_EXCEEDED');
  assert.deepEqual(result.errorDetails, [{ code: 'OUTPUT_PIXEL_LIMIT_EXCEEDED', message }]);
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.warnings, [message]);
});

test('PDD detail stitcher writes an atomic result file alongside stdout', async (t) => {
  const outputDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pdd-stitch-result-')));
  t.after(() => fs.rmSync(outputDir, { recursive: true, force: true }));
  const detailImageDir = path.join(outputDir, 'detail-images');
  const resultFilePath = path.join(outputDir, 'metadata', 'pdd-detail-stitch-result.json');
  fs.mkdirSync(detailImageDir, { recursive: true });
  await sharp({ create: { width: 100, height: 200, channels: 3, background: '#ff0000' } })
    .jpeg()
    .toFile(path.join(detailImageDir, 'detail_01.jpg'));
  await sharp({ create: { width: 100, height: 300, channels: 3, background: '#0000ff' } })
    .png()
    .toFile(path.join(detailImageDir, 'detail_02.png'));

  const payload = Buffer.from(JSON.stringify({
    outputDir,
    detailImageDir,
    outputFileName: '详情长图.png',
    n8nExecutionId: '89218',
    resultFilePath,
  }), 'utf8').toString('base64');
  const run = spawnSync(process.execPath, [scriptPath, payload], { encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  const stdoutResult = JSON.parse(run.stdout.trim());
  const fileResult = JSON.parse(fs.readFileSync(resultFilePath, 'utf8'));

  assert.equal(stdoutResult.success, true);
  assert.equal(fileResult.success, true);
  assert.equal(fileResult.status, 'success');
  assert.equal(fileResult.nonFatal, false);
  assert.equal(fileResult.n8nExecutionId, '89218');
  assert.equal(path.normalize(fileResult.resultFilePath), path.normalize(resultFilePath));
  assert.equal(fileResult.detailLongImageWidth, 100);
  assert.equal(fileResult.detailLongImageHeight, 500);
  assert.equal(fileResult.inputImageCount, 2);
  assert.equal(fs.existsSync(path.join(detailImageDir, '详情长图.png')), true);
  assert.deepEqual(
    fs.readdirSync(path.dirname(resultFilePath)).filter((name) => name.includes('.part-')),
    [],
  );
});
