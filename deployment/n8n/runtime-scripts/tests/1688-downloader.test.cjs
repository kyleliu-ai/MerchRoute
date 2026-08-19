'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { EventEmitter } = require('node:events');
const sharp = require('sharp');

const browserSession = require('../1688-browser-session.cjs');
const downloader = require('../1688-product-media-downloader.cjs');
const login = require('../1688-login.cjs');
const { DETAIL_FILE_PATTERN } = require('../1688-detail-image-stitcher.cjs');
const { finalize, preflight } = require('../download-idempotency-v1.cjs');

function withTempDir(action) {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'e007-downloader-')));
  return Promise.resolve()
    .then(() => action(directory))
    .finally(() => fs.rmSync(directory, { recursive: true, force: true }));
}

test('validates 1688 hosts and extracts offer ids from path and query id', () => {
  assert.deepEqual(
    downloader.validateProductUrl('https://detail.1688.com/offer/123456789.html#fragment'),
    {
      productUrl: 'https://detail.1688.com/offer/123456789.html',
      offerId: '123456789',
    },
  );
  assert.equal(
    downloader.validateProductUrl('https://m.1688.com/page/index.html?id=987654321').offerId,
    '987654321',
  );
  assert.throws(
    () => downloader.validateProductUrl('https://evil1688.com/offer/123456.html'),
    /hostname must be 1688\.com/,
  );
  assert.throws(
    () => downloader.validateProductUrl('file:///offer/123456.html'),
    /http or https/,
  );
  assert.throws(
    () => downloader.validateProductUrl('https://detail.1688.com/not-an-offer'),
    /numeric 1688 offerId/,
  );
});

test('normalizes download concurrency upward to a multiple of four between 4 and 16', () => {
  const cases = new Map([
    [undefined, 4],
    [1, 4],
    [4, 4],
    [5, 8],
    [10, 12],
    [16, 16],
    [99, 16],
  ]);
  for (const [input, expected] of cases) {
    assert.equal(downloader.normalizeDownloadConcurrency(input), expected);
  }
});

test('portable allowed-root checks reject sibling-prefix and traversal escapes', () => {
  assert.equal(downloader.isPathInsideAllowedRoots('G:/media/1688/task', ['G:/media']), true);
  assert.equal(downloader.isPathInsideAllowedRoots('G:/media2/task', ['G:/media']), false);
  assert.equal(downloader.isPathInsideAllowedRoots('G:/media/../outside', ['G:/media']), false);
  assert.equal(downloader.isPathInsideAllowedRoots('/srv/media/1688/task', ['/srv/media']), true);
  assert.equal(downloader.isPathInsideAllowedRoots('/srv/media-other/task', ['/srv/media']), false);
  assert.equal(downloader.isPathInsideAllowedRoots('/srv/media/../private', ['/srv/media']), false);
});

test('Base64 JSON parsing preserves Chinese text and paths with spaces', () => {
  const source = {
    SKU: '0000007',
    productName: '中文 产品 名称',
    parentOutputDir: 'G:/01 n8n/中文 输出',
  };
  const encoded = Buffer.from(JSON.stringify(source), 'utf8').toString('base64');
  assert.deepEqual(downloader.decodeParamsArg(encoded), { params: source, error: '' });
  assert.equal(login.parseLoginArgs([encoded]).productUrl, 'https://www.1688.com/');
});

test('E007 Base64 parsing rejects noncanonical, oversized, and non-object payloads', () => {
  assert.match(downloader.decodeParamsArg('e30').error, /canonical/i);
  assert.match(downloader.decodeParamsArg('e30=*').error, /canonical/i);
  assert.match(
    downloader.decodeParamsArg(Buffer.from('[]', 'utf8').toString('base64')).error,
    /JSON object/i,
  );
  assert.match(downloader.decodeParamsArg('A'.repeat(1_500_000)).error, /too large|canonical/i);
});

test('fixed result contract always includes human, profile, and long-image defaults', () => {
  const result = downloader.makeResult();
  assert.equal(result.platform, '1688');
  assert.equal(result.humanVerificationResolved, false);
  assert.equal(result.browserProfileBusy, false);
  assert.equal(result.browserProfileLocked, false);
  assert.equal(result.browserRunMode, '');
  assert.equal(result.browserWindowMinimized, false);
  assert.equal(result.detailLongImageSkipped, false);
  assert.equal(result.detailLongImageSizeBytes, 0);
  assert.equal(result.detailLongImageInputCount, 0);
  assert.deepEqual(result.detailLongImageInputImages, []);
});

test('writes the downloader result atomically inside the reserved output directory', () => withTempDir((outputDir) => {
  const resultFilePath = path.join(outputDir, 'metadata', '1688-media-result.json');
  const result = downloader.makeResult({
    success: true,
    status: 'success',
    outputDir: outputDir.replace(/\\/g, '/'),
  });
  downloader.writeResultFile(resultFilePath, result);
  const saved = JSON.parse(fs.readFileSync(resultFilePath, 'utf8'));
  assert.equal(saved.success, true);
  assert.equal(saved.resultFilePath, resultFilePath.replace(/\\/g, '/'));
  assert.deepEqual(fs.readdirSync(path.dirname(resultFilePath)).sort(), ['1688-media-result.json']);
}));

test('media filename contract uses underscore and remains stitcher-compatible', () => {
  assert.equal(downloader.buildMediaBaseName('main', 0), 'main_01');
  assert.equal(downloader.buildMediaBaseName('detail', 79), 'detail_80');
  assert.equal(downloader.buildMediaBaseName('video', 2), 'video_03');
  assert.equal(DETAIL_FILE_PATTERN.test(`${downloader.buildMediaBaseName('detail', 0)}.jpg`), true);
  assert.equal(DETAIL_FILE_PATTERN.test(`${downloader.buildMediaBaseName('detail', 79)}.webp`), true);
});

test('launch options support headed and headless sandboxed sessions without stealth arguments', () => {
  const options = browserSession.buildLaunchOptions();
  assert.equal(options.headless, false);
  assert.equal(options.chromiumSandbox, true);
  assert.equal(Object.hasOwn(options, 'args'), false);
  assert.equal(browserSession.buildLaunchOptions({ headless: true }).headless, true);
  assert.equal(Object.hasOwn(options, 'userAgent'), false);
  assert.equal(Object.hasOwn(options, 'proxy'), false);
  assert.equal(JSON.stringify(options).match(/webdriver|disable-blink|stealth/i), null);
});

test('E007 defaults to the dedicated Chrome profile and trigger-selected run mode', () => {
  const validation = downloader.validateInput({
    SKU: '0000007',
    productName: '测试商品',
    n8nExecutionId: '12345',
    productUrl: 'https://detail.1688.com/offer/787069737862.html',
    parentOutputDir: process.platform === 'win32' ? 'G:/01_MerchRoute/03-1688ProductMedia' : '/tmp/1688',
    allowedOutputRoots: [process.platform === 'win32' ? 'G:/01_MerchRoute' : '/tmp'],
    headless: true,
  });
  assert.deepEqual(validation.errors, []);
  assert.equal(validation.value.browserUserDataDir.replace(/\\/g, '/'), process.platform === 'win32'
    ? 'D:/n8n-browser-profile/1688'
    : `${os.homedir().replace(/\\/g, '/')}/.n8n-browser-profile/1688`);
  assert.equal(validation.value.headless, true);
  assert.equal(validation.value.humanVerificationMode, 'failFast');
});

test('dedicated profile lock is atomic and releases cleanly', () => withTempDir((directory) => {
  const profileDir = path.join(directory, '1688-profile');
  const first = browserSession.acquireProfileLock(profileDir, { ownerRole: 'login' });
  assert.equal(first.owner.ownerRole, 'login');
  assert.throws(
    () => browserSession.acquireProfileLock(profileDir),
    (error) => error instanceof browserSession.ProfileBusyError && error.httpStatus === 409,
  );
  first.release();
  const second = browserSession.acquireProfileLock(profileDir);
  assert.equal(second.owner.ownerRole, 'download');
  second.release();
  assert.equal(fs.existsSync(`${profileDir}.e007.lock`), false);
}));

test('profile busy is returned before E007 creates a product output directory', () => withTempDir(async (root) => {
  const executionId = '99101';
  const payload = {
    SKU: '0000007',
    productName: '锁测试商品',
    n8nExecutionId: executionId,
    productUrl: 'https://detail.1688.com/offer/787069737862.html',
    parentOutputDir: root,
    allowedOutputRoots: [root],
    browserUserDataDir: path.join(root, 'profile'),
    headless: true,
  };
  const encoded = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64');
  const result = await downloader.runDownloader(encoded, {
    createBrowserSession: async () => { throw new browserSession.ProfileBusyError('busy'); },
  });
  assert.equal(result.status, 'profile_busy');
  assert.equal(result.outputDir, '');
  assert.equal(fs.existsSync(path.join(root, '0000007-锁测试商品-' + executionId)), false);
}));

test('E007 closes a newly acquired session when a same-token terminal receipt wins before output reservation', () => withTempDir(async (root) => {
  const executionId = '99103';
  const downloadJobId = '14141414-1414-4414-8414-141414141414';
  const request = {
    workflowCode: 'E007',
    isWebhook: true,
    downloadJobId,
    requestN8nExecutionId: executionId,
    parentOutputDir: root,
    allowedOutputRoots: [root],
    expectedOutputDir: path.join(root, '0000007-会话清理测试-' + executionId),
    SKU: '0000007',
    productName: '会话清理测试',
    productUrl: 'https://detail.1688.com/offer/787069737862.html',
    platformProductId: '787069737862',
  };
  const owned = preflight(request);
  let closeCount = 0;
  const payload = {
    SKU: request.SKU,
    productName: request.productName,
    n8nExecutionId: executionId,
    productUrl: request.productUrl,
    parentOutputDir: root,
    allowedOutputRoots: [root],
    browserUserDataDir: path.join(root, 'profile'),
    headless: true,
    idempotency: owned.idempotency,
  };
  const encoded = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64');
  const result = await downloader.runDownloader(encoded, {
    createBrowserSession: async () => {
      finalize({
        ...request,
        idempotency: owned.idempotency,
        result: { success: true, status: 'success', httpStatus: 200, outputDir: owned.outputDir, errors: [], warnings: [] },
      });
      return { close: async () => { closeCount += 1; } };
    },
  });
  assert.equal(result.status, 'idempotency_owner_lost');
  assert.equal(result.httpStatus, 409);
  assert.equal(closeCount, 1);
  assert.equal(result.outputDir, '');
  assert.equal(fs.existsSync(request.expectedOutputDir), false);
}));

test('closing the Playwright context releases the profile lock exactly once', async () => {
  const context = new EventEmitter();
  let releaseCount = 0;
  const lifecycle = browserSession.bindContextLockLifecycle(context, {
    release() { releaseCount += 1; },
  });
  context.emit('close');
  assert.deepEqual(await lifecycle.closed, { reason: 'context_closed' });
  lifecycle.release('session_close');
  context.emit('close');
  assert.equal(releaseCount, 1);
});

test('manual login completion cancels the terminal prompt when Chrome closes', async () => {
  let resolveClosed;
  let cancelled = 0;
  const session = { closed: new Promise((resolve) => { resolveClosed = resolve; }) };
  const prompt = { promise: new Promise(() => {}), cancel() { cancelled += 1; } };
  const completion = login.waitForLoginCompletion(session, prompt);
  resolveClosed({ reason: 'context_closed' });
  assert.deepEqual(await completion, { kind: 'browser_closed' });
  assert.equal(cancelled, 1);
});

test('manual login completion keeps the Enter path distinct from browser close', async () => {
  const session = { closed: new Promise(() => {}) };
  let cancelled = 0;
  const prompt = { promise: Promise.resolve({ kind: 'enter' }), cancel() { cancelled += 1; } };
  assert.deepEqual(await login.waitForLoginCompletion(session, prompt), { kind: 'enter' });
  assert.equal(cancelled, 0);
});

test('a dead same-host profile owner is recovered without deleting live locks', () => withTempDir((directory) => {
  const profileDir = path.join(directory, '1688-profile');
  const lockDir = `${profileDir}.e007.lock`;
  fs.mkdirSync(lockDir, { recursive: true });
  fs.writeFileSync(path.join(lockDir, 'owner.json'), JSON.stringify({
    pid: 2147483647,
    hostname: os.hostname(),
    token: 'stale',
  }));
  const acquired = browserSession.acquireProfileLock(profileDir);
  assert.notEqual(acquired.owner.token, 'stale');
  acquired.release();
}));

test('private, local, reserved, and metadata hosts are blocked', () => {
  for (const host of [
    '127.0.0.1', '10.0.0.1', '172.16.0.1', '192.168.1.1',
    '169.254.169.254', '198.18.1.3', '::1', 'fc00::1', 'metadata.google.internal', 'service.local',
  ]) {
    assert.equal(downloader.isBlockedHostname(host), true, host);
  }
  assert.equal(downloader.isBlockedHostname('8.8.8.8'), false);
});

test('synthetic fake-IP DNS is allowed only for approved media CDN hostnames', () => {
  const fakeIp = [{ address: '198.18.1.3', family: 4 }];
  assert.equal(downloader.isSyntheticFakeIpResolutionAllowed('img.alicdn.com', fakeIp), true);
  assert.equal(downloader.isSyntheticFakeIpResolutionAllowed('cbu01.alicdn.com', fakeIp), true);
  assert.equal(downloader.isSyntheticFakeIpResolutionAllowed('cloud.video.taobao.com', fakeIp), true);
  assert.equal(downloader.isSyntheticFakeIpResolutionAllowed('videodelivery.net', fakeIp), true);
  assert.equal(downloader.isSyntheticFakeIpResolutionAllowed('evil.example', fakeIp), false);
  assert.equal(downloader.isSyntheticFakeIpResolutionAllowed('evil.video.taobao.com', fakeIp), false);
  assert.equal(downloader.isSyntheticFakeIpResolutionAllowed('picasso-work.alibaba-inc.com', fakeIp), false);
  assert.equal(downloader.isSyntheticFakeIpResolutionAllowed('img.alicdn.com', [{ address: '10.0.0.1', family: 4 }]), false);
  assert.equal(downloader.isSyntheticFakeIpResolutionAllowed('img.alicdn.com', [
    { address: '198.18.1.3', family: 4 },
    { address: '8.8.8.8', family: 4 },
  ]), false);
});

test('detects designated-member detail restrictions without treating them as captcha', () => {
  assert.equal(downloader.isDetailMediaRestricted('指定会员可见，请联系商家'), true);
  assert.equal(downloader.isDetailMediaRestricted('商品详情 透气运动鞋'), false);
});

test('keeps tiny CDN assets out of product media', async () => {
  const tiny = await sharp({
    create: { width: 80, height: 80, channels: 3, background: { r: 255, g: 255, b: 255 } },
  }).png().toBuffer();
  await assert.rejects(
    () => downloader.validateProductImageBuffer(tiny),
    (error) => error.code === 'IMAGE_DIMENSIONS_TOO_SMALL',
  );

  const product = await sharp({
    create: { width: 200, height: 300, channels: 3, background: { r: 255, g: 255, b: 255 } },
  }).png().toBuffer();
  const dimensions = await downloader.validateProductImageBuffer(product);
  assert.deepEqual({ width: dimensions.width, height: dimensions.height }, { width: 200, height: 300 });
});

test('rejects detail images smaller than 50KB before saving', () => {
  assert.throws(
    () => downloader.validateDetailImageBufferSize(Buffer.alloc((50 * 1024) - 1)),
    (error) => error.code === 'DETAIL_IMAGE_BYTES_TOO_SMALL',
  );
  assert.doesNotThrow(() => downloader.validateDetailImageBufferSize(Buffer.alloc(50 * 1024)));
});

test('ranks URL-encoded product dimensions before placeholder assets', () => {
  assert.deepEqual(
    downloader.inferMediaUrlDimensions('https://img.alicdn.com/imgextra/item-750-750.png'),
    { width: 750, height: 750, area: 562500 },
  );
  const ranked = downloader.rankCandidates([
    { url: 'https://gw.alicdn.com/item-1412-1408.png', source: 'network-text' },
    { url: 'https://cbu01.alicdn.com/img/ibank/item-750-750.png', source: 'page' },
    { url: 'https://img.alicdn.com/item-324-396.png', source: 'dom-after-scroll' },
  ]);
  assert.match(ranked[0].url, /750-750/);
  assert.match(ranked[1].url, /324-396/);
  assert.match(ranked[2].url, /1412-1408/);
});

test('limits detail media to supplier product-image paths', () => {
  assert.equal(downloader.isLikelyProductDetailCandidate({
    url: 'https://cbu01.alicdn.com/img/ibank/O1CN01abc-0-cib.jpg',
  }), true);
  assert.equal(downloader.isLikelyProductDetailCandidate({
    url: 'https://img.alicdn.com/imgextra/O1CN01abc-2-tps-800-800.png',
  }), false);
  assert.equal(downloader.isLikelyProductDetailCandidate({
    url: 'https://cbu01.alicdn.com/img/ibank/O1CN01abc-overseas_pic.png',
  }), false);
});

test('candidate extraction classifies initial JSON detail images and videos', () => {
  const buckets = downloader.createCandidateBuckets();
  downloader.collectCandidatesFromObject({
    imageList: ['https://cbu01.alicdn.com/img/ibank/main.jpg'],
    detailImages: ['https://cbu01.alicdn.com/img/ibank/detail.webp'],
    videoUrl: 'https://cloud.video.taobao.com/path/video.mp4',
  }, buckets, 'https://detail.1688.com/offer/123456.html', 'initial-json');
  assert.equal(buckets.main.size, 1);
  assert.equal(buckets.detail.size, 1);
  assert.equal(buckets.video.size, 1);
});

test('candidate extraction skips recommendation, review, store, and advertising subtrees', () => {
  const buckets = downloader.createCandidateBuckets();
  downloader.collectCandidatesFromObject({
    gallery: ['https://cbu01.alicdn.com/img/ibank/product.jpg'],
    recommendList: [{ images: ['https://cbu01.alicdn.com/img/ibank/recommended.jpg'] }],
    reviewData: { images: ['https://cbu01.alicdn.com/img/ibank/review.jpg'] },
    sellerStore: { logo: 'https://cbu01.alicdn.com/img/ibank/store.jpg' },
    advertisement: { videoUrl: 'https://cloud.video.taobao.com/path/ad-video.mp4' },
  }, buckets, 'https://detail.1688.com/offer/123456.html', 'initial-json');
  assert.equal(buckets.main.size, 1);
  assert.equal(buckets.detail.size, 0);
  assert.equal(buckets.video.size, 0);
  assert.equal(buckets.supplementalImage.size, 0);
});

test('detail images shared with the main candidate pool survive when they are not selected as main images', () => {
  const buckets = downloader.createCandidateBuckets();
  const baseUrl = 'https://detail.1688.com/offer/123456.html';
  const cover = 'https://cbu01.alicdn.com/img/ibank/O1CN-cover_!!2219307265287-0-cib.jpg';
  const sharedDetail = 'https://cbu01.alicdn.com/img/ibank/O1CN-detail_!!2219307265287-0-cib.jpg';
  downloader.addCandidate(buckets, 'main', cover, baseUrl, 'dom-initial');
  downloader.addCandidate(buckets, 'main', sharedDetail, baseUrl, 'initial-json');
  downloader.addCandidate(buckets, 'detail', sharedDetail, baseUrl, 'dom-scrolled');

  const selected = downloader.selectCandidates(buckets, {
    maxMainImages: 1,
    maxDetailImages: 10,
    maxVideos: 3,
  });
  assert.equal(selected.main[0].url, cover);
  assert.deepEqual(selected.detail.map((item) => item.url), [sharedDetail]);
});

test('detail fallback uses supplemental and unselected product-like images when direct detail is empty', () => {
  const buckets = downloader.createCandidateBuckets();
  const baseUrl = 'https://detail.1688.com/offer/123456.html';
  const cover = 'https://cbu01.alicdn.com/img/ibank/O1CN-cover_!!2219307265287-0-cib.jpg';
  const selectedDuplicate = `${cover}_.webp`;
  const unselectedMain = 'https://cbu01.alicdn.com/img/ibank/O1CN-unselected_!!2219307265287-0-cib.jpg';
  const supplementalDetail = 'https://cbu01.alicdn.com/img/ibank/O1CN-supplemental_!!2219307265287-0-cib.jpg';
  const otherSupplier = 'https://cbu01.alicdn.com/img/ibank/O1CN-other_!!9999999999999-0-cib.jpg';

  downloader.addCandidate(buckets, 'main', cover, baseUrl, 'dom-initial');
  downloader.addCandidate(buckets, 'main', unselectedMain, baseUrl, 'initial-script');
  downloader.addCandidate(buckets, '', selectedDuplicate, baseUrl, 'network-media');
  downloader.addCandidate(buckets, '', supplementalDetail, baseUrl, 'network-media');
  downloader.addCandidate(buckets, '', otherSupplier, baseUrl, 'network-media');

  const selected = downloader.selectCandidates(buckets, {
    maxMainImages: 1,
    maxDetailImages: 10,
    maxVideos: 3,
  });
  assert.deepEqual(new Set(selected.detail.map((item) => item.url)), new Set([unselectedMain, supplementalDetail]));
  assert.equal(selected.diagnostics.candidateStages.filtered.detailDirect, 0);
  assert.equal(selected.diagnostics.candidateStages.filtered.detailFallback, 3);
});

test('direct detail candidates take precedence over supplemental fallback candidates', () => {
  const buckets = downloader.createCandidateBuckets();
  const baseUrl = 'https://detail.1688.com/offer/123456.html';
  const cover = 'https://cbu01.alicdn.com/img/ibank/O1CN-cover_!!2219307265287-0-cib.jpg';
  const directDetail = 'https://cbu01.alicdn.com/img/ibank/O1CN-direct_!!2219307265287-0-cib.jpg';
  const supplementalDetail = 'https://cbu01.alicdn.com/img/ibank/O1CN-supplemental_!!2219307265287-0-cib.jpg';

  downloader.addCandidate(buckets, 'main', cover, baseUrl, 'dom-initial');
  downloader.addCandidate(buckets, 'detail', directDetail, baseUrl, 'dom-scrolled');
  downloader.addCandidate(buckets, '', supplementalDetail, baseUrl, 'network-media');

  const selected = downloader.selectCandidates(buckets, {
    maxMainImages: 1,
    maxDetailImages: 10,
    maxVideos: 3,
  });
  assert.deepEqual(selected.detail.map((item) => item.url), [directDetail]);
  assert.equal(selected.diagnostics.candidateStages.filtered.detailDirect, 1);
  assert.equal(selected.diagnostics.candidateStages.filtered.detailFallback, 0);
});

test('detail fallback rejects obvious Alibaba thumbnail variants', () => {
  const buckets = downloader.createCandidateBuckets();
  const baseUrl = 'https://detail.1688.com/offer/123456.html';
  const cover = 'https://cbu01.alicdn.com/img/ibank/O1CN-cover_!!2219307265287-0-cib.jpg';
  const original = 'https://cbu01.alicdn.com/img/ibank/O1CN-original_!!2219307265287-0-cib.jpg';
  const smallVariant = 'https://cbu01.alicdn.com/img/ibank/O1CN-small_!!2219307265287-0-cib.220x220.jpg';
  const searchVariant = 'https://cbu01.alicdn.com/img/ibank/O1CN-search_!!2219307265287-0-cib.search.jpg';

  downloader.addCandidate(buckets, 'main', cover, baseUrl, 'dom-initial');
  downloader.addCandidate(buckets, '', original, baseUrl, 'network-media');
  downloader.addCandidate(buckets, '', smallVariant, baseUrl, 'initial-script');
  downloader.addCandidate(buckets, '', searchVariant, baseUrl, 'initial-script');

  const selected = downloader.selectCandidates(buckets, {
    maxMainImages: 1,
    maxDetailImages: 10,
    maxVideos: 3,
  });
  assert.deepEqual(selected.detail.map((item) => item.url), [original]);
});

test('Alibaba thumbnail variants collapse to one image and prefer the original URL', () => {
  const original = 'https://cbu01.alicdn.com/img/ibank/O1CN01abc_!!2219307265287-0-cib.jpg';
  const webpVariant = `${original}_.webp`;
  const sizedVariant = `${original}_300x300.jpg`;
  assert.equal(downloader.mediaKey(original), downloader.mediaKey(webpVariant));
  assert.equal(downloader.mediaKey(original), downloader.mediaKey(sizedVariant));

  const buckets = downloader.createCandidateBuckets();
  for (const url of [webpVariant, sizedVariant, original]) {
    downloader.addCandidate(buckets, 'detail', url, 'https://detail.1688.com/offer/123456.html', 'dom-scrolled');
  }
  assert.equal(buckets.detail.size, 1);
  assert.equal(Array.from(buckets.detail.values())[0].url, original);
});

test('video classification rejects placeholders, player libraries, and image-backed CSS tokens', () => {
  for (const url of [
    'https://videodelivery.net/%7Bid%7D/manifest/video.m3u8',
    'https://g.alicdn.com/mtb/videox/0.4.25/',
    'https://gw.alicdn.com/tfs/TB1A2bRSFXXXXahXXXXXXXXXXXX-80-80.png)%7D.lib-video',
  ]) assert.equal(downloader.isLikelyVideoUrl(url), false, url);
});

test('video ranking prefers the current product supplier over recommendation videos', () => {
  const productVideo = 'https://cloud.video.taobao.com/play/u/2219307265287/p/2/e/6/t/1/518414917634.mp4';
  const recommendation = 'https://cloud.video.taobao.com/play/u/9999999999999/p/2/e/6/t/1/111.mp4';
  const ranked = downloader.rankVideoCandidates([
    { url: recommendation, source: 'network-media', verifiedByContentType: true },
    { url: productVideo, source: 'initial-script', verifiedByContentType: false },
  ], '2219307265287');
  assert.deepEqual(ranked.map((item) => item.url), [productVideo]);
  assert.equal(ranked[0].supplierMatch, true);
});

test('a successful video Content-Type admits media URLs without a standard extension', () => {
  const buckets = downloader.createCandidateBuckets();
  const url = 'https://media.example.com/stream?id=abc123';
  downloader.addCandidate(buckets, 'video', url, 'https://detail.1688.com/offer/123456.html', 'network-media', {
    contentType: 'video/mp4; charset=binary',
    httpStatus: 200,
    verifiedMediaType: 'video',
  });
  assert.equal(buckets.video.size, 1);
  const candidate = Array.from(buckets.video.values())[0];
  assert.equal(candidate.verifiedByContentType, true);
  assert.equal(candidate.contentType, 'video/mp4');
});

test('m3u8 parser resolves relative HTTP(S) references and rejects non-HTTP schemes later', () => {
  const manifest = [
    '#EXTM3U',
    '#EXT-X-STREAM-INF:BANDWIDTH=800000',
    'variants/low.m3u8',
    '#EXT-X-KEY:METHOD=AES-128,URI="https://cdn.example.com/key.bin"',
    '#EXTINF:6,',
    'segments/0001.ts',
    '#EXT-X-MAP:URI="file:///tmp/init.mp4"',
  ].join('\n');
  const references = downloader.extractM3u8References(manifest, 'https://cdn.example.com/master.m3u8');
  assert.equal(references[0].url, 'https://cdn.example.com/variants/low.m3u8');
  assert.equal(references[0].isPlaylist, true);
  assert.equal(references.some((item) => item.url === 'https://cdn.example.com/segments/0001.ts'), true);
  assert.equal(references.some((item) => item.rawUri.startsWith('file:') && item.url === ''), true);
});

function fakeResponse(status, body = Buffer.alloc(0), headers = {}) {
  return {
    status: () => status,
    headers: () => ({
      'content-type': 'image/jpeg',
      'content-length': String(body.length),
      ...headers,
    }),
    body: async () => body,
    dispose: async () => {},
  };
}

test('BrowserContext.request retry contract retries only 429/5xx up to two times', async () => {
  const responses = [
    fakeResponse(500),
    fakeResponse(429),
    fakeResponse(200, Buffer.from([0xff, 0xd8, 0xff])),
  ];
  let calls = 0;
  const request = {
    get: async () => {
      const response = responses[calls];
      calls += 1;
      return response;
    },
  };
  const result = await downloader.fetchMediaWithRetry({
    request,
    url: 'https://8.8.8.8/media.jpg',
    headers: {},
    timeoutMs: 1000,
    maxMediaBytes: 1024,
    retryDelayMs: 0,
  });
  assert.equal(calls, 3);
  assert.equal(result.buffer.length, 3);
});

test('401 and 403 do not retry', async () => {
  for (const status of [401, 403]) {
    let calls = 0;
    const request = {
      get: async () => {
        calls += 1;
        return fakeResponse(status);
      },
    };
    await assert.rejects(
      downloader.fetchMediaWithRetry({
        request,
        url: 'https://8.8.8.8/media.jpg',
        headers: {},
        timeoutMs: 1000,
        maxMediaBytes: 1024,
        retryDelayMs: 0,
      }),
      (error) => error.status === status && error.retryable === false,
    );
    assert.equal(calls, 1);
  }
});

test('classifies local storage failures as internal runtime errors', () => {
  for (const code of ['ENOSPC', 'EACCES', 'EPERM', 'EROFS', 'EMFILE']) {
    assert.equal(downloader.isLocalFilesystemFailureCode(code), true, code);
  }
  for (const code of ['MEDIA_HTTP_ERROR', 'MEDIA_ACCESS_DENIED', 'FFMPEG_FAILED']) {
    assert.equal(downloader.isLocalFilesystemFailureCode(code), false, code);
  }
});

test('download source contains no Node fetch fallback or automation-hiding switches', () => {
  const source = fs.readFileSync(path.resolve(__dirname, '../1688-product-media-downloader.cjs'), 'utf8');
  const sessionSource = fs.readFileSync(path.resolve(__dirname, '../1688-browser-session.cjs'), 'utf8');
  const loginSource = fs.readFileSync(path.resolve(__dirname, '../1688-login.cjs'), 'utf8');
  assert.equal(/\bfetch\s*\(/.test(source), false);
  assert.equal(/AutomationControlled|navigator\.webdriver|disable-blink-features/i.test(source + sessionSource), false);
  assert.equal(/protocol_whitelist[^\n]*file,/i.test(source), false);
  assert.match(source, /context\.request/);
  assert.match(source, /'-fs', String\(maxMediaBytes\)/);
  assert.match(loginSource, /\['SIGINT', 'SIGTERM', 'SIGHUP'\]/);
  assert.match(loginSource, /process\.removeListener/);
});
