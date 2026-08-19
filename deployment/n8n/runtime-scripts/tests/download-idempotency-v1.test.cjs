'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const helperPath = path.resolve(__dirname, '../download-idempotency-v1.cjs');
const {
  TRANSITION_LOCK_STALE_MS,
  atomicWriteJson,
  finalize,
  mergeRecoveredResult,
  normalizeFingerprintPath,
  preflight,
  startHeartbeat,
  statePaths,
  touchHeartbeat,
} = require(helperPath);

function createRoot(t, prefix = '幂等 空格-') {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function request(root, overrides = {}) {
  const executionId = String(overrides.requestN8nExecutionId || '70001');
  return {
    workflowCode: 'E007',
    isWebhook: true,
    downloadJobId: '11111111-1111-4111-8111-111111111111',
    requestN8nExecutionId: executionId,
    parentOutputDir: root,
    allowedOutputRoots: [root],
    expectedOutputDir: path.join(root, '0000094-新款斜挎包-' + executionId),
    SKU: '0000094',
    productName: '新款斜挎包',
    productUrl: 'https://detail.1688.com/offer/123456789012.html?spm=tracking',
    platformProductId: '123456789012',
    ...overrides,
  };
}

function makeHeartbeat(owner, updatedAt) {
  return {
    schemaVersion: 1,
    workflowCode: owner.workflowCode,
    downloadJobId: owner.downloadJobId,
    fingerprint: owner.fingerprint,
    ownerToken: owner.ownerToken,
    ownerN8nExecutionId: owner.ownerN8nExecutionId,
    phase: 'downloader',
    updatedAt,
  };
}

function createVerifiedArtifacts(t, workflowCode, downloadJobId) {
  const root = createRoot(t, workflowCode.toLowerCase() + '-finalize-artifacts-');
  const isPdd = workflowCode === 'E006';
  const firstRequest = request(root, {
    workflowCode,
    downloadJobId,
    allowedOutputRoots: isPdd ? [] : [root],
    productUrl: isPdd
      ? 'https://mobile.yangkeduo.com/goods.html?goods_id=978231634569'
      : 'https://detail.1688.com/offer/123456789012.html',
    platformProductId: isPdd ? '978231634569' : '123456789012',
  });
  const first = preflight(firstRequest);
  assert.equal(first.action, 'owner');
  const paths = statePaths(firstRequest);
  const owner = JSON.parse(fs.readFileSync(paths.ownerPath, 'utf8'));
  const outputDir = owner.outputDir;
  const mainDir = path.join(outputDir, 'main-images');
  const detailDir = path.join(outputDir, 'detail-images');
  const videoDir = path.join(outputDir, 'videos');
  const metadataDir = path.join(outputDir, 'metadata');
  for (const directory of [mainDir, detailDir, videoDir, metadataDir]) fs.mkdirSync(directory, { recursive: true });
  const mainPath = path.join(mainDir, 'main_1.jpg');
  const detailPath = path.join(detailDir, 'detail_1.jpg');
  const videoPath = path.join(videoDir, 'video_1.mp4');
  const longPath = path.join(detailDir, '详情长图.png');
  fs.writeFileSync(mainPath, 'main');
  fs.writeFileSync(detailPath, 'detail');
  fs.writeFileSync(videoPath, 'video');
  fs.writeFileSync(longPath, 'long');
  const media = {
    success: true,
    status: 'success',
    httpStatus: 200,
    platform: isPdd ? 'pdd' : '1688',
    SKU: owner.SKU,
    productName: owner.productName,
    productUrl: firstRequest.productUrl,
    n8nExecutionId: owner.ownerN8nExecutionId,
    outputDir,
    mainImageCount: 1,
    detailImageCount: 1,
    videoCount: 1,
    mainImages: [{ localPath: mainPath }],
    detailImages: [{ localPath: detailPath }],
    videos: [{ localPath: videoPath }],
    errors: [],
    warnings: ['媒体清单来自原子 manifest'],
    ...(isPdd ? { goodsId: owner.platformProductId } : { offerId: owner.platformProductId }),
  };
  if (isPdd) {
    atomicWriteJson(path.join(metadataDir, 'pdd-media-metadata.json'), {
      params: { n8nExecutionId: owner.ownerN8nExecutionId },
      result: media,
    });
  } else {
    atomicWriteJson(path.join(metadataDir, '1688-media-result.json'), media);
  }
  const stitchName = isPdd ? 'pdd-detail-stitch-result.json' : '1688-detail-stitch-result.json';
  atomicWriteJson(path.join(metadataDir, stitchName), {
    success: true,
    skipped: false,
    n8nExecutionId: owner.ownerN8nExecutionId,
    detailLongImagePath: longPath,
    detailLongImageFileName: '详情长图.png',
    detailLongImageWidth: 800,
    detailLongImageHeight: 1600,
    detailLongImageSizeBytes: 4,
    inputImageCount: 1,
    inputImages: [detailPath],
    errors: [],
    warnings: ['长图清单来自原子 manifest'],
  });
  return {
    root,
    firstRequest,
    first,
    paths,
    owner,
    media,
    mediaPath: path.join(metadataDir, isPdd ? 'pdd-media-metadata.json' : '1688-media-result.json'),
    mainPath,
    detailPath,
    longPath,
    stitchPath: path.join(metadataDir, stitchName),
    reference: {
      mode: 'verified_artifacts',
      workflowCode,
      parentOutputDir: root,
      allowedOutputRoots: owner.allowedOutputRoots,
      outputDir,
      SKU: owner.SKU,
      productName: owner.productName,
      productUrl: firstRequest.productUrl,
      platformProductId: owner.platformProductId,
      ownerN8nExecutionId: owner.ownerN8nExecutionId,
    },
  };
}

function writeNonFatalStitch(fixture, overrides = {}) {
  const detailRoot = path.join(fixture.owner.outputDir, 'detail-images');
  fs.rmSync(fixture.longPath, { force: true });
  const inputImages = fixture.media.detailImages.map((item) => item.localPath);
  const warning = 'Detail long image exceeds the 100000000 pixel safety limit.';
  const result = {
    schemaVersion: 1,
    success: false,
    status: 'warning',
    nonFatal: true,
    skipped: false,
    n8nExecutionId: fixture.owner.ownerN8nExecutionId,
    detailImageDir: detailRoot,
    detailLongImagePath: fixture.longPath,
    detailLongImageFileName: path.basename(fixture.longPath),
    detailLongImageWidth: 0,
    detailLongImageHeight: 0,
    detailLongImageSizeBytes: 0,
    resultFilePath: fixture.stitchPath,
    inputImageCount: inputImages.length,
    stitchedImageCount: 0,
    inputImages,
    stitchedImages: [],
    path: fixture.longPath,
    fileName: path.basename(fixture.longPath),
    width: 0,
    height: 0,
    sizeBytes: 0,
    inputCount: inputImages.length,
    errorCode: 'OUTPUT_PIXEL_LIMIT_EXCEEDED',
    errorDetails: [{ code: 'OUTPUT_PIXEL_LIMIT_EXCEEDED', message: warning }],
    errors: [],
    warnings: [warning],
    ...overrides,
  };
  atomicWriteJson(fixture.stitchPath, result);
  return result;
}

function writeMediaArtifact(fixture) {
  if (fixture.firstRequest.workflowCode === 'E006') {
    atomicWriteJson(fixture.mediaPath, {
      params: { n8nExecutionId: fixture.owner.ownerN8nExecutionId },
      result: fixture.media,
    });
    return;
  }
  atomicWriteJson(fixture.mediaPath, fixture.media);
}

test('first request owns the job, a duplicate gets 202, and final replay keeps the owner execution', (t) => {
  const root = createRoot(t);
  const first = preflight(request(root));
  assert.equal(first.action, 'owner');
  assert.equal(first.idempotency.enabled, true);
  assert.equal(first.ownerN8nExecutionId, '70001');

  const duplicate = preflight(request(root, { requestN8nExecutionId: '70002' }));
  assert.equal(duplicate.action, 'running');
  assert.equal(duplicate.response.httpStatus, 202);
  assert.equal(duplicate.response.status, 'idempotency_in_progress');
  assert.equal(duplicate.response.idempotencyState, 'running');
  assert.ok(duplicate.response.retryAfterMs > 0);

  const completed = finalize({
    ...request(root),
    idempotency: first.idempotency,
    result: {
      success: true,
      status: 'success',
      httpStatus: 200,
      SKU: '0000094',
      outputDir: first.outputDir,
      errors: [],
      warnings: [],
    },
  });
  assert.equal(completed.idempotencyState, 'succeeded');
  assert.equal(completed.idempotencyReplay, false);

  const replay = preflight(request(root, { requestN8nExecutionId: '70003' }));
  assert.equal(replay.action, 'replay');
  assert.equal(replay.response.idempotencyReplay, true);
  assert.equal(replay.response.ownerN8nExecutionId, '70001');
  assert.equal(replay.response.requestN8nExecutionId, '70003');
  assert.equal(replay.response.outputDir, first.outputDir);
  assert.equal(fs.existsSync(request(root, { requestN8nExecutionId: '70002' }).expectedOutputDir), false);
});

test('same downloadJobId with a different identity is rejected with 409', (t) => {
  const root = createRoot(t);
  preflight(request(root));
  const conflict = preflight(request(root, { SKU: '0000095', requestN8nExecutionId: '70002' }));
  assert.equal(conflict.action, 'conflict');
  assert.equal(conflict.response.httpStatus, 409);
  assert.equal(conflict.response.status, 'idempotency_conflict');
});

test('E006 and E007 finalize verified manifests into one canonical receipt and exact replay', (t) => {
  for (const [workflowCode, downloadJobId] of [
    ['E006', '14141414-1414-4414-8414-141414141414'],
    ['E007', '15151515-1515-4515-8515-151515151515'],
  ]) {
    const fixture = createVerifiedArtifacts(t, workflowCode, downloadJobId);
    const finalized = finalize({
      ...fixture.firstRequest,
      idempotency: fixture.first.idempotency,
      resultReference: fixture.reference,
    });
    assert.equal(finalized.success, true, workflowCode);
    assert.equal(finalized.idempotencyState, 'succeeded', workflowCode);
    assert.equal(finalized.mainImages.length, 1, workflowCode);
    assert.equal(finalized.detailImages.length, 1, workflowCode);
    assert.equal(finalized.videos.length, 1, workflowCode);
    assert.equal(finalized.detailLongImageSuccess, true, workflowCode);
    assert.equal(finalized.downloadJobId, downloadJobId, workflowCode);
    const receipt = JSON.parse(fs.readFileSync(fixture.paths.receiptPath, 'utf8'));
    assert.deepEqual(receipt.result, finalized, workflowCode + ' receipt equals first response');

    const replay = preflight({ ...fixture.firstRequest, requestN8nExecutionId: '70099' });
    assert.equal(replay.action, 'replay', workflowCode);
    const expected = { ...finalized };
    const actual = { ...replay.response };
    delete expected.idempotencyReplay;
    delete expected.requestN8nExecutionId;
    delete actual.idempotencyReplay;
    delete actual.requestN8nExecutionId;
    assert.deepEqual(actual, expected, workflowCode + ' replay preserves canonical receipt');
    assert.equal(replay.response.idempotencyReplay, true, workflowCode);
    assert.equal(replay.response.requestN8nExecutionId, '70099', workflowCode);
  }
});

test('E006 and E007 finalize and exactly replay a verified non-fatal long-image warning as media success', (t) => {
  for (const [workflowCode, downloadJobId] of [
    ['E006', '20202020-2020-4020-8020-202020202020'],
    ['E007', '23232323-2323-4323-8323-232323232323'],
  ]) {
    const fixture = createVerifiedArtifacts(t, workflowCode, downloadJobId);
    fixture.media.status = 'partial_success';
    fixture.media.warnings.push('部分详情图被下载器过滤');
    writeMediaArtifact(fixture);
    const stitch = writeNonFatalStitch(fixture);

    const finalized = finalize({
      ...fixture.firstRequest,
      idempotency: fixture.first.idempotency,
      resultReference: fixture.reference,
    });
    assert.equal(finalized.success, true, workflowCode);
    assert.equal(finalized.status, 'partial_success', workflowCode);
    assert.equal(finalized.httpStatus, 200, workflowCode);
    assert.equal(finalized.idempotencyState, 'succeeded', workflowCode);
    assert.equal(finalized.detailLongImageSuccess, false, workflowCode);
    assert.equal(finalized.detailLongImageSkipped, false, workflowCode);
    assert.equal(finalized.detailLongImageInputCount, 1, workflowCode);
    assert.deepEqual(finalized.detailLongImageInputImages, stitch.inputImages, workflowCode);
    assert.deepEqual(finalized.errors, [], workflowCode);
    assert.ok(finalized.warnings.includes('部分详情图被下载器过滤'), workflowCode);
    assert.ok(finalized.warnings.includes(stitch.warnings[0]), workflowCode);

    const receipt = JSON.parse(fs.readFileSync(fixture.paths.receiptPath, 'utf8'));
    assert.equal(receipt.state, 'succeeded', workflowCode);
    assert.deepEqual(receipt.result, finalized, workflowCode);

    const replay = preflight({ ...fixture.firstRequest, requestN8nExecutionId: '70099' });
    assert.equal(replay.action, 'replay', workflowCode);
    const expected = { ...finalized };
    const actual = { ...replay.response };
    delete expected.idempotencyReplay;
    delete expected.requestN8nExecutionId;
    delete actual.idempotencyReplay;
    delete actual.requestN8nExecutionId;
    assert.deepEqual(actual, expected, workflowCode);
    assert.equal(replay.response.idempotencyReplay, true, workflowCode);
    assert.equal(replay.response.requestN8nExecutionId, '70099', workflowCode);
  }
});

test('stale E006 and E007 output with a verified non-fatal warning recovers without another download', (t) => {
  for (const [workflowCode, downloadJobId] of [
    ['E006', '21212121-2121-4121-8121-212121212121'],
    ['E007', '24242424-2424-4424-8424-242424242424'],
  ]) {
    const fixture = createVerifiedArtifacts(t, workflowCode, downloadJobId);
    fixture.media.status = 'partial_success';
    writeMediaArtifact(fixture);
    writeNonFatalStitch(fixture);
    atomicWriteJson(
      fixture.paths.heartbeatPath,
      makeHeartbeat(fixture.owner, new Date(Date.now() - 300_000).toISOString()),
    );

    const retryRequest = {
      ...fixture.firstRequest,
      requestN8nExecutionId: '70002',
      expectedOutputDir: path.join(fixture.root, 'unexpected-redownload-70002'),
    };
    const recovered = preflight(retryRequest);
    assert.equal(recovered.action, 'replay', workflowCode);
    assert.equal(recovered.response.success, true, workflowCode);
    assert.equal(recovered.response.status, 'partial_success', workflowCode);
    assert.equal(recovered.response.httpStatus, 200, workflowCode);
    assert.equal(recovered.response.idempotencyState, 'succeeded', workflowCode);
    assert.equal(recovered.response.idempotencyReplay, true, workflowCode);
    assert.equal(recovered.response.detailLongImageSuccess, false, workflowCode);
    assert.equal(recovered.response.detailLongImageSkipped, false, workflowCode);
    assert.equal(recovered.response.ownerN8nExecutionId, fixture.owner.ownerN8nExecutionId, workflowCode);
    assert.equal(recovered.response.outputDir, fixture.owner.outputDir, workflowCode);
    assert.equal(fs.existsSync(retryRequest.expectedOutputDir), false, workflowCode);
    const receipt = JSON.parse(fs.readFileSync(fixture.paths.receiptPath, 'utf8'));
    assert.equal(receipt.state, 'succeeded', workflowCode);
    assert.equal(receipt.recoveredFromArtifacts, true, workflowCode);
  }
});

test('E006 and E007 reject forged non-fatal manifests and identity, path, count, or input-set mismatches', (t) => {
  const cases = [
    ['contract', { nonFatal: false }],
    ['error code', { errorCode: 'STITCH_FAILED' }],
    ['missing error details', { errorDetails: [] }],
    ['extra error details', (fixture) => {
      const original = writeNonFatalStitch(fixture);
      return { errorDetails: [...original.errorDetails, { code: 'STITCH_FAILED', message: 'fatal' }] };
    }],
    ['unrelated warning', { warnings: ['unrelated warning'] }],
    ['execution', { n8nExecutionId: '999999' }],
    ['detail root', (fixture) => ({ detailImageDir: path.join(fixture.root, 'outside-detail-images') })],
    ['manifest path', (fixture) => ({ resultFilePath: path.join(fixture.owner.outputDir, 'metadata', 'other.json') })],
    ['missing alias path', { path: '' }],
    ['non-zero output', { detailLongImageSizeBytes: 1 }],
    ['string zero output', { width: '0' }],
    ['stitched output declared', (fixture) => ({ stitchedImageCount: 1, stitchedImages: [fixture.detailPath] })],
    ['string input count', { inputImageCount: '1', inputCount: '1' }],
    ['wrong long-image name', (fixture) => {
      const wrongPath = path.join(fixture.owner.outputDir, 'detail-images', 'other.png');
      return {
        detailLongImagePath: wrongPath,
        detailLongImageFileName: 'other.png',
        path: wrongPath,
        fileName: 'other.png',
      };
    }],
    ['detail count', { inputImageCount: 2, inputCount: 2 }],
    ['input set', (fixture) => ({ inputImages: [fixture.mainPath] })],
  ];

  for (const [workflowIndex, workflowCode] of ['E006', 'E007'].entries()) {
    for (const [index, [label, patch]] of cases.entries()) {
      const uniqueTail = (workflowIndex * cases.length + index + 3).toString(16).padStart(12, '0');
      const downloadJobId = `33333333-3333-4333-8333-${uniqueTail}`;
      const fixture = createVerifiedArtifacts(t, workflowCode, downloadJobId);
      writeNonFatalStitch(fixture, typeof patch === 'function' ? patch(fixture) : patch);
      const finalized = finalize({
        ...fixture.firstRequest,
        idempotency: fixture.first.idempotency,
        resultReference: fixture.reference,
      });
      assert.equal(finalized.success, false, workflowCode + ': ' + label);
      assert.equal(finalized.status, 'idempotency_finalize_artifacts_invalid', workflowCode + ': ' + label);
      assert.equal(finalized.idempotencyState, 'failed', workflowCode + ': ' + label);
    }
  }
});

test('merge does not trust an unverified non-fatal-shaped stitch object', () => {
  const media = {
    success: true,
    status: 'partial_success',
    httpStatus: 200,
    detailImageCount: 1,
    errors: [],
    warnings: [],
  };
  const stitch = {
    success: false,
    skipped: false,
    nonFatal: true,
    status: 'warning',
    errorCode: 'OUTPUT_PIXEL_LIMIT_EXCEEDED',
    errors: [],
    warnings: ['Detail long image exceeds the 100000000 pixel safety limit.'],
  };
  const merged = mergeRecoveredResult(media, stitch);
  assert.equal(merged.success, false);
  assert.equal(merged.status, 'detail_long_image_failed');
  assert.equal(merged.httpStatus, 500);
});

test('finalize identity mismatch fails closed, persists a terminal receipt, and keeps response identity', (t) => {
  const fixture = createVerifiedArtifacts(t, 'E007', '16161616-1616-4616-8616-161616161616');
  const finalized = finalize({
    ...fixture.firstRequest,
    idempotency: fixture.first.idempotency,
    resultReference: { ...fixture.reference, platformProductId: '999999999999' },
  });
  assert.equal(finalized.success, false);
  assert.equal(finalized.status, 'idempotency_finalize_artifacts_invalid');
  assert.equal(finalized.idempotencyState, 'failed');
  assert.equal(finalized.downloadJobId, fixture.firstRequest.downloadJobId);
  assert.equal(finalized.ownerN8nExecutionId, fixture.owner.ownerN8nExecutionId);
  assert.equal(finalized.requestN8nExecutionId, fixture.firstRequest.requestN8nExecutionId);
  const receipt = JSON.parse(fs.readFileSync(fixture.paths.receiptPath, 'utf8'));
  assert.deepEqual(receipt.result, finalized);
});

test('finalize turns a truncated manifest into a stable terminal failed receipt', (t) => {
  const fixture = createVerifiedArtifacts(t, 'E007', '19191919-1919-4919-8919-191919191919');
  const mediaPath = path.join(fixture.owner.outputDir, 'metadata', '1688-media-result.json');
  fs.writeFileSync(mediaPath, '{"success":true,"mainImages":[', 'utf8');
  const finalized = finalize({
    ...fixture.firstRequest,
    idempotency: fixture.first.idempotency,
    resultReference: fixture.reference,
  });
  assert.equal(finalized.success, false);
  assert.equal(finalized.status, 'idempotency_finalize_artifacts_invalid');
  assert.match(finalized.errors.join(' '), /incomplete|valid JSON|verification failed/i);
  const receipt = JSON.parse(fs.readFileSync(fixture.paths.receiptPath, 'utf8'));
  assert.equal(receipt.state, 'failed');
  assert.deepEqual(receipt.result, finalized);
  const replay = preflight({ ...fixture.firstRequest, requestN8nExecutionId: '70101' });
  assert.equal(replay.action, 'replay');
  assert.equal(replay.response.status, 'idempotency_finalize_artifacts_invalid');
  assert.equal(replay.response.idempotencyReplay, true);
  assert.equal(replay.response.downloadJobId, fixture.firstRequest.downloadJobId);
});

test('downstream failure preserves verified media when the long-image manifest is incomplete', (t) => {
  const fixture = createVerifiedArtifacts(t, 'E007', '17171717-1717-4717-8717-171717171717');
  fs.unlinkSync(fixture.stitchPath);
  const finalized = finalize({
    ...fixture.firstRequest,
    idempotency: fixture.first.idempotency,
    resultReference: fixture.reference,
    inlineResult: {
      success: false,
      status: 'detail_long_image_failed',
      httpStatus: 500,
      SKU: fixture.owner.SKU,
      outputDir: fixture.owner.outputDir,
      detailLongImageSuccess: false,
      detailLongImageSkipped: false,
      errors: ['stitch failed'],
      warnings: [],
    },
  });
  assert.equal(finalized.success, false);
  assert.equal(finalized.status, 'detail_long_image_failed');
  assert.equal(finalized.mainImages.length, 1);
  assert.equal(finalized.detailImages.length, 1);
  assert.equal(finalized.videos.length, 1);
  assert.equal(finalized.idempotencyState, 'failed');
});

test('manual finalize reads verified artifacts while a no-output failure remains inline', (t) => {
  const fixture = createVerifiedArtifacts(t, 'E006', '18181818-1818-4818-8818-181818181818');
  const completed = finalize({
    isWebhook: false,
    requestN8nExecutionId: fixture.owner.ownerN8nExecutionId,
    resultReference: fixture.reference,
  });
  assert.equal(completed.success, true);
  assert.equal(completed.downloadJobId, '');
  assert.equal(completed.mainImages.length, 1);
  const failed = finalize({
    isWebhook: false,
    requestN8nExecutionId: '70100',
    inlineResult: {
      success: false,
      status: 'profile_busy',
      httpStatus: 409,
      browserProfileBusy: true,
      errors: ['busy'],
      warnings: [],
    },
  });
  assert.equal(failed.status, 'profile_busy');
  assert.equal(failed.idempotencyState, 'failed');
  assert.equal(failed.ownerN8nExecutionId, '70100');
});

test('preflight rejects a junction or symlink idempotency root before writing outside parentOutputDir', (t) => {
  const root = createRoot(t, 'idempotency-link-parent-');
  const outside = createRoot(t, 'idempotency-link-outside-');
  const stateLink = path.join(root, '.download-idempotency');
  fs.symlinkSync(outside, stateLink, process.platform === 'win32' ? 'junction' : 'dir');
  const result = preflight(request(root, {
    downloadJobId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  }));
  assert.equal(result.action, 'invalid');
  assert.equal(result.response.httpStatus, 400);
  assert.match(result.response.errors[0], /symbolic link|junction/i);
  assert.deepEqual(fs.readdirSync(outside), []);
});

test('preflight rejects a parentOutputDir symlink even when it is lexically inside an allowed root', (t) => {
  const approvedRoot = createRoot(t, 'idempotency-approved-');
  const outside = createRoot(t, 'idempotency-parent-outside-');
  const linkedParent = path.join(approvedRoot, 'linked-parent');
  fs.symlinkSync(outside, linkedParent, process.platform === 'win32' ? 'junction' : 'dir');
  const result = preflight(request(linkedParent, {
    downloadJobId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    allowedOutputRoots: [approvedRoot],
  }));
  assert.equal(result.action, 'invalid');
  assert.equal(result.response.httpStatus, 400);
  assert.match(result.response.errors[0], /symbolic link|junction/i);
  assert.deepEqual(fs.readdirSync(outside), []);
});

test('preflight revalidates an existing jobDir and rejects a replacement junction or symlink', (t) => {
  const root = createRoot(t, 'idempotency-job-link-parent-');
  const outside = createRoot(t, 'idempotency-job-link-outside-');
  const firstRequest = request(root, { downloadJobId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd' });
  preflight(firstRequest);
  const paths = statePaths(firstRequest);
  fs.rmSync(paths.jobDir, { recursive: true, force: true });
  fs.symlinkSync(outside, paths.jobDir, process.platform === 'win32' ? 'junction' : 'dir');
  const result = preflight({ ...firstRequest, requestN8nExecutionId: '70002' });
  assert.equal(result.action, 'invalid');
  assert.equal(result.response.httpStatus, 400);
  assert.match(result.response.errors[0], /symbolic link|junction/i);
  assert.deepEqual(fs.readdirSync(outside), []);
});

test('artifact recovery persists and replays orphaned when outputDir is a junction', (t) => {
  const root = createRoot(t, 'idempotency-output-link-parent-');
  const outside = createRoot(t, 'idempotency-output-link-outside-');
  const firstRequest = request(root, { downloadJobId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee' });
  const first = preflight(firstRequest);
  const paths = statePaths(firstRequest);
  const owner = JSON.parse(fs.readFileSync(paths.ownerPath, 'utf8'));
  fs.mkdirSync(path.join(outside, 'main-images'), { recursive: true });
  fs.mkdirSync(path.join(outside, 'detail-images'), { recursive: true });
  fs.mkdirSync(path.join(outside, 'metadata'), { recursive: true });
  const mainPath = path.join(owner.outputDir, 'main-images', 'main_1.jpg');
  const longPath = path.join(owner.outputDir, 'detail-images', '详情长图.png');
  fs.writeFileSync(path.join(outside, 'main-images', 'main_1.jpg'), 'main');
  fs.writeFileSync(path.join(outside, 'detail-images', '详情长图.png'), 'long');
  atomicWriteJson(path.join(outside, 'metadata', '1688-media-result.json'), {
    success: true,
    status: 'success',
    httpStatus: 200,
    SKU: owner.SKU,
    productName: owner.productName,
    offerId: owner.platformProductId,
    n8nExecutionId: owner.ownerN8nExecutionId,
    outputDir: owner.outputDir,
    mainImageCount: 1,
    detailImageCount: 0,
    videoCount: 0,
    mainImages: [{ localPath: mainPath }],
    detailImages: [],
    videos: [],
  });
  atomicWriteJson(path.join(outside, 'metadata', '1688-detail-stitch-result.json'), {
    success: true,
    skipped: false,
    n8nExecutionId: owner.ownerN8nExecutionId,
    detailLongImagePath: longPath,
    detailLongImageSizeBytes: 4,
  });
  fs.symlinkSync(outside, owner.outputDir, process.platform === 'win32' ? 'junction' : 'dir');
  atomicWriteJson(paths.heartbeatPath, makeHeartbeat(owner, new Date(Date.now() - 300_000).toISOString()));
  const recovered = preflight({ ...firstRequest, requestN8nExecutionId: '70002' });
  assert.equal(recovered.action, 'orphaned');
  assert.equal(recovered.response.status, 'idempotency_orphaned');
  assert.match(recovered.response.errors[0], /unsafe|symbolic link|junction/i);
  assert.equal(fs.existsSync(paths.receiptPath), true);
  const replay = preflight({ ...firstRequest, requestN8nExecutionId: '70003' });
  assert.equal(replay.action, 'replay');
  assert.equal(replay.response.status, 'idempotency_orphaned');
  assert.equal(replay.response.idempotencyReplay, true);
  assert.throws(() => touchHeartbeat(first.idempotency, 'late_download'), (error) => error?.code === 'IDEMPOTENCY_OWNER_LOST');
});

test('artifact recovery persists and replays orphaned when metadata is a junction', (t) => {
  const root = createRoot(t, 'idempotency-metadata-link-parent-');
  const outsideMetadata = createRoot(t, 'idempotency-metadata-link-outside-');
  const firstRequest = request(root, { downloadJobId: 'ffffffff-ffff-4fff-8fff-ffffffffffff' });
  const first = preflight(firstRequest);
  const paths = statePaths(firstRequest);
  const owner = JSON.parse(fs.readFileSync(paths.ownerPath, 'utf8'));
  const outputDir = owner.outputDir;
  fs.mkdirSync(path.join(outputDir, 'main-images'), { recursive: true });
  fs.mkdirSync(path.join(outputDir, 'detail-images'), { recursive: true });
  const mainPath = path.join(outputDir, 'main-images', 'main_1.jpg');
  const longPath = path.join(outputDir, 'detail-images', '详情长图.png');
  fs.writeFileSync(mainPath, 'main');
  fs.writeFileSync(longPath, 'long');
  atomicWriteJson(path.join(outsideMetadata, '1688-media-result.json'), {
    success: true,
    status: 'success',
    httpStatus: 200,
    SKU: owner.SKU,
    productName: owner.productName,
    offerId: owner.platformProductId,
    n8nExecutionId: owner.ownerN8nExecutionId,
    outputDir,
    mainImageCount: 1,
    detailImageCount: 0,
    videoCount: 0,
    mainImages: [{ localPath: mainPath }],
    detailImages: [],
    videos: [],
  });
  atomicWriteJson(path.join(outsideMetadata, '1688-detail-stitch-result.json'), {
    success: true,
    skipped: false,
    n8nExecutionId: owner.ownerN8nExecutionId,
    detailLongImagePath: longPath,
    detailLongImageSizeBytes: 4,
  });
  fs.symlinkSync(outsideMetadata, path.join(outputDir, 'metadata'), process.platform === 'win32' ? 'junction' : 'dir');
  atomicWriteJson(paths.heartbeatPath, makeHeartbeat(owner, new Date(Date.now() - 300_000).toISOString()));
  const recovered = preflight({ ...firstRequest, requestN8nExecutionId: '70002' });
  assert.equal(recovered.action, 'orphaned');
  assert.equal(recovered.response.status, 'idempotency_orphaned');
  assert.match(recovered.response.errors[0], /unsafe|symbolic link|junction/i);
  assert.equal(fs.existsSync(paths.receiptPath), true);
  const replay = preflight({ ...firstRequest, requestN8nExecutionId: '70003' });
  assert.equal(replay.action, 'replay');
  assert.equal(replay.response.status, 'idempotency_orphaned');
  assert.throws(() => touchHeartbeat(first.idempotency, 'late_download'), (error) => error?.code === 'IDEMPOTENCY_OWNER_LOST');
});

test('a crash-truncated artifact manifest becomes 409 orphaned without a second output directory', (t) => {
  const root = createRoot(t, 'idempotency-truncated-artifact-');
  const firstRequest = request(root, { downloadJobId: '12121212-1212-4212-8212-121212121212' });
  const first = preflight(firstRequest);
  const paths = statePaths(firstRequest);
  fs.mkdirSync(path.join(first.outputDir, 'metadata'), { recursive: true });
  fs.writeFileSync(path.join(first.outputDir, 'metadata', '1688-media-result.json'), '{"success":true,"mainImages":[', 'utf8');
  const owner = JSON.parse(fs.readFileSync(paths.ownerPath, 'utf8'));
  atomicWriteJson(paths.heartbeatPath, makeHeartbeat(owner, new Date(Date.now() - 300_000).toISOString()));

  const retryRequest = request(root, { requestN8nExecutionId: '70002', downloadJobId: firstRequest.downloadJobId });
  const recovered = preflight(retryRequest);
  assert.equal(recovered.action, 'orphaned');
  assert.equal(recovered.response.status, 'idempotency_orphaned');
  assert.equal(recovered.response.httpStatus, 409);
  assert.match(recovered.response.errors[0], /unverifiable|incomplete|valid JSON/i);
  assert.equal(fs.existsSync(retryRequest.expectedOutputDir), false);
  assert.equal(fs.existsSync(paths.receiptPath), true);
  const replay = preflight({ ...firstRequest, requestN8nExecutionId: '70003' });
  assert.equal(replay.action, 'replay');
  assert.equal(replay.response.status, 'idempotency_orphaned');
  assert.equal(replay.response.idempotencyReplay, true);
  assert.throws(() => touchHeartbeat(first.idempotency, 'late_download'), (error) => error?.code === 'IDEMPOTENCY_OWNER_LOST');
});

test('retryable profile results rotate the token but preserve the first owner directory identity', (t) => {
  const root = createRoot(t);
  const first = preflight(request(root));
  const retryable = finalize({
    ...request(root),
    idempotency: first.idempotency,
    result: {
      success: false,
      status: 'profile_busy',
      httpStatus: 409,
      browserProfileBusy: true,
      outputDir: first.outputDir,
      errors: ['busy'],
      warnings: [],
    },
  });
  assert.equal(retryable.idempotencyState, 'retryable');
  assert.equal(fs.existsSync(first.outputDir), false);

  const second = preflight(request(root, { requestN8nExecutionId: '70002' }));
  assert.equal(second.action, 'owner');
  assert.equal(second.ownerN8nExecutionId, '70001');
  assert.equal(second.outputDir, first.outputDir);
  assert.notEqual(second.idempotency.ownerToken, first.idempotency.ownerToken);
  assert.equal(fs.existsSync(request(root, { requestN8nExecutionId: '70002' }).expectedOutputDir), false);
});

test('stale media output resumes only the stitch stage in the original owner directory', (t) => {
  const root = createRoot(t);
  const firstRequest = request(root);
  const first = preflight(firstRequest);
  const paths = statePaths(firstRequest);
  const owner = JSON.parse(fs.readFileSync(paths.ownerPath, 'utf8'));
  const outputDir = owner.outputDir;
  fs.mkdirSync(path.join(outputDir, 'main-images'), { recursive: true });
  fs.mkdirSync(path.join(outputDir, 'metadata'), { recursive: true });
  const mainPath = path.join(outputDir, 'main-images', 'main_1.jpg');
  fs.writeFileSync(mainPath, 'image');
  const media = {
    success: true,
    status: 'success',
    httpStatus: 200,
    SKU: owner.SKU,
    productName: owner.productName,
    n8nExecutionId: owner.ownerN8nExecutionId,
    offerId: owner.platformProductId,
    outputDir,
    mainImageCount: 1,
    detailImageCount: 0,
    videoCount: 0,
    mainImages: [{ localPath: mainPath }],
    detailImages: [],
    videos: [],
    errors: [],
    warnings: [],
  };
  atomicWriteJson(path.join(outputDir, 'metadata', '1688-media-result.json'), media);
  atomicWriteJson(paths.heartbeatPath, makeHeartbeat(owner, new Date(Date.now() - 300_000).toISOString()));

  const resumed = preflight(request(root, { requestN8nExecutionId: '70002' }));
  assert.equal(resumed.action, 'resume_stitch');
  assert.equal(resumed.downloadResult.outputDir, outputDir);
  assert.equal(resumed.ownerN8nExecutionId, '70001');
  assert.equal(resumed.outputDir, outputDir);
  assert.equal(fs.existsSync(request(root, { requestN8nExecutionId: '70002' }).expectedOutputDir), false);
});

test('a crash-left stale transition lock is reclaimed only after durable state revalidation', (t) => {
  const root = createRoot(t);
  const firstRequest = request(root);
  preflight(firstRequest);
  const paths = statePaths(firstRequest);
  const owner = JSON.parse(fs.readFileSync(paths.ownerPath, 'utf8'));
  atomicWriteJson(paths.heartbeatPath, makeHeartbeat(owner, new Date(Date.now() - 300_000).toISOString()));
  fs.mkdirSync(paths.transitionLockPath);
  atomicWriteJson(path.join(paths.transitionLockPath, 'lock.json'), {
    schemaVersion: 1,
    token: 'dead-process-token',
    acquiredAt: new Date(Date.now() - TRANSITION_LOCK_STALE_MS - 10_000).toISOString(),
  });

  const recovered = preflight(request(root, { requestN8nExecutionId: '70002' }));
  assert.equal(recovered.action, 'orphaned');
  assert.equal(recovered.response.status, 'idempotency_orphaned');
  assert.equal(fs.existsSync(paths.transitionLockPath), false);
});

test('atomic JSON replacement overwrites an existing file and heartbeat CAS rejects stale owners', (t) => {
  const root = createRoot(t);
  const filePath = path.join(root, 'existing.json');
  atomicWriteJson(filePath, { value: 1 });
  atomicWriteJson(filePath, { value: 2, text: '中文 空格' });
  assert.deepEqual(JSON.parse(fs.readFileSync(filePath, 'utf8')), { value: 2, text: '中文 空格' });

  const firstRequest = request(root, { downloadJobId: '33333333-3333-4333-8333-333333333333' });
  const first = preflight(firstRequest);
  assert.equal(touchHeartbeat(first.idempotency, 'test'), true);
  assert.throws(
    () => touchHeartbeat({ ...first.idempotency, ownerToken: '44444444-4444-4444-8444-444444444444' }, 'test'),
    /owner mismatch/,
  );
});

test('late finalize from a replaced retryable owner is rejected and cannot replace the new receipt', (t) => {
  const root = createRoot(t);
  const firstRequest = request(root, { downloadJobId: '66666666-6666-4666-8666-666666666666' });
  const first = preflight(firstRequest);
  finalize({
    ...firstRequest,
    idempotency: first.idempotency,
    result: { success: false, status: 'profile_busy', httpStatus: 409, browserProfileBusy: true, errors: [], warnings: [] },
  });
  const secondRequest = { ...firstRequest, requestN8nExecutionId: '70002' };
  const second = preflight(secondRequest);
  const late = finalize({
    ...firstRequest,
    idempotency: first.idempotency,
    result: { success: true, status: 'success', httpStatus: 200, outputDir: first.outputDir, errors: [], warnings: [] },
  });
  assert.equal(late.status, 'idempotency_owner_lost');
  const completed = finalize({
    ...secondRequest,
    idempotency: second.idempotency,
    result: { success: true, status: 'success', httpStatus: 200, outputDir: second.outputDir, errors: [], warnings: [] },
  });
  assert.equal(completed.idempotencyState, 'succeeded');
  assert.equal(completed.ownerN8nExecutionId, '70001');
});

test('heartbeat guard latches owner loss and triggers fail-closed cancellation', (t) => {
  const root = createRoot(t);
  const firstRequest = request(root, { downloadJobId: '99999999-9999-4999-8999-999999999999' });
  const first = preflight(firstRequest);
  let cancelled = 0;
  const guard = startHeartbeat(first.idempotency, 'test', {
    intervalMs: 60_000,
    onOwnerLost: () => { cancelled += 1; },
    onError: () => {},
  });
  finalize({
    ...firstRequest,
    idempotency: first.idempotency,
    result: { success: false, status: 'profile_busy', httpStatus: 409, browserProfileBusy: true, errors: [], warnings: [] },
  });
  preflight({ ...firstRequest, requestN8nExecutionId: '70002' });
  assert.throws(() => guard.assertOwned(), /owner mismatch/);
  assert.equal(guard.ownerLostError?.code, 'IDEMPOTENCY_OWNER_LOST');
  assert.equal(cancelled, 1);
  guard.stop();
});

test('a same-token terminal receipt invalidates heartbeat CAS before any late side effect', (t) => {
  const root = createRoot(t, 'idempotency-terminal-cas-');
  const firstRequest = request(root, { downloadJobId: '13131313-1313-4313-8313-131313131313' });
  const first = preflight(firstRequest);
  const paths = statePaths(firstRequest);
  const owner = JSON.parse(fs.readFileSync(paths.ownerPath, 'utf8'));
  atomicWriteJson(paths.heartbeatPath, makeHeartbeat(owner, new Date(Date.now() - 300_000).toISOString()));

  const terminal = preflight({ ...firstRequest, requestN8nExecutionId: '70002' });
  assert.equal(terminal.action, 'orphaned');
  let lateSideEffects = 0;
  assert.throws(() => {
    touchHeartbeat(first.idempotency, 'before_output_reservation');
    lateSideEffects += 1;
  }, (error) => error?.code === 'IDEMPOTENCY_OWNER_LOST');
  assert.equal(lateSideEffects, 0);
});

test('a skipped stitch receipt cannot complete recovery when detail media exists', (t) => {
  const root = createRoot(t);
  const firstRequest = request(root, { downloadJobId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' });
  preflight(firstRequest);
  const paths = statePaths(firstRequest);
  const owner = JSON.parse(fs.readFileSync(paths.ownerPath, 'utf8'));
  const outputDir = owner.outputDir;
  fs.mkdirSync(path.join(outputDir, 'main-images'), { recursive: true });
  fs.mkdirSync(path.join(outputDir, 'detail-images'), { recursive: true });
  fs.mkdirSync(path.join(outputDir, 'metadata'), { recursive: true });
  const mainPath = path.join(outputDir, 'main-images', 'main_1.jpg');
  const detailPath = path.join(outputDir, 'detail-images', 'detail_1.jpg');
  fs.writeFileSync(mainPath, 'main');
  fs.writeFileSync(detailPath, 'detail');
  atomicWriteJson(path.join(outputDir, 'metadata', '1688-media-result.json'), {
    success: true,
    status: 'success',
    httpStatus: 200,
    SKU: owner.SKU,
    productName: owner.productName,
    offerId: owner.platformProductId,
    n8nExecutionId: owner.ownerN8nExecutionId,
    outputDir,
    mainImageCount: 1,
    detailImageCount: 1,
    videoCount: 0,
    mainImages: [{ localPath: mainPath }],
    detailImages: [{ localPath: detailPath }],
    videos: [],
    errors: [],
    warnings: [],
  });
  atomicWriteJson(path.join(outputDir, 'metadata', '1688-detail-stitch-result.json'), {
    success: false,
    skipped: true,
    n8nExecutionId: owner.ownerN8nExecutionId,
    errorCode: '',
    warnings: [],
  });
  atomicWriteJson(paths.heartbeatPath, makeHeartbeat(owner, new Date(Date.now() - 300_000).toISOString()));
  const recovered = preflight({ ...firstRequest, requestN8nExecutionId: '70002' });
  assert.equal(recovered.action, 'resume_stitch');
  assert.equal(recovered.outputDir, outputDir);
});

test('artifact recovery rejects a lying media count and a symlink escape', (t) => {
  const root = createRoot(t);
  const firstRequest = request(root, { downloadJobId: '77777777-7777-4777-8777-777777777777' });
  preflight(firstRequest);
  const paths = statePaths(firstRequest);
  const owner = JSON.parse(fs.readFileSync(paths.ownerPath, 'utf8'));
  const outputDir = owner.outputDir;
  const mainDir = path.join(outputDir, 'main-images');
  fs.mkdirSync(path.join(outputDir, 'metadata'), { recursive: true });
  fs.mkdirSync(mainDir, { recursive: true });
  const mainPath = path.join(mainDir, 'main_1.jpg');
  fs.writeFileSync(mainPath, 'image');
  const media = {
    success: true,
    status: 'success',
    httpStatus: 200,
    SKU: owner.SKU,
    productName: owner.productName,
    offerId: owner.platformProductId,
    n8nExecutionId: owner.ownerN8nExecutionId,
    outputDir,
    mainImageCount: 99,
    detailImageCount: 0,
    videoCount: 0,
    mainImages: [{ localPath: mainPath }],
    detailImages: [],
    videos: [],
  };
  atomicWriteJson(path.join(outputDir, 'metadata', '1688-media-result.json'), media);
  atomicWriteJson(paths.heartbeatPath, makeHeartbeat(owner, new Date(Date.now() - 300_000).toISOString()));
  const lying = preflight({ ...firstRequest, requestN8nExecutionId: '70002' });
  assert.equal(lying.action, 'orphaned');

  if (process.platform !== 'win32') {
    const secondRequest = request(root, {
      downloadJobId: '88888888-8888-4888-8888-888888888888',
      requestN8nExecutionId: '70003',
    });
    preflight(secondRequest);
    const secondPaths = statePaths(secondRequest);
    const secondOwner = JSON.parse(fs.readFileSync(secondPaths.ownerPath, 'utf8'));
    const secondOutput = secondOwner.outputDir;
    const outside = path.join(root, 'outside.jpg');
    fs.writeFileSync(outside, 'outside');
    fs.mkdirSync(path.join(secondOutput, 'main-images'), { recursive: true });
    fs.mkdirSync(path.join(secondOutput, 'metadata'), { recursive: true });
    const link = path.join(secondOutput, 'main-images', 'main_1.jpg');
    fs.symlinkSync(outside, link);
    atomicWriteJson(path.join(secondOutput, 'metadata', '1688-media-result.json'), {
      ...media,
      n8nExecutionId: secondOwner.ownerN8nExecutionId,
      outputDir: secondOutput,
      mainImageCount: 1,
      mainImages: [{ localPath: link }],
    });
    atomicWriteJson(secondPaths.heartbeatPath, makeHeartbeat(secondOwner, new Date(Date.now() - 300_000).toISOString()));
    assert.equal(preflight({ ...secondRequest, requestN8nExecutionId: '70004' }).action, 'orphaned');
  }
});

test('CLI accepts Base64 JSON with Chinese spaces and path fingerprints are cross-platform stable', (t) => {
  const root = createRoot(t);
  const payload = Buffer.from(JSON.stringify(request(root, {
    downloadJobId: '55555555-5555-4555-8555-555555555555',
  })), 'utf8').toString('base64');
  const completed = spawnSync(process.execPath, [helperPath, 'preflight', payload], { encoding: 'utf8' });
  assert.equal(completed.status, 0, completed.stderr);
  assert.equal(JSON.parse(completed.stdout.trim()).action, 'owner');
  assert.equal(normalizeFingerprintPath('C:\\Media\\中文 商品\\'), 'c:/media/中文 商品');
  assert.equal(normalizeFingerprintPath('\\\\Server\\Share\\SKU'), '//server/share/sku');
  assert.equal(normalizeFingerprintPath('/srv/merchroute-fixtures/中文 商品/'), '/srv/merchroute-fixtures/中文 商品');
});
