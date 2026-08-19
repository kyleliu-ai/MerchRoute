'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');
const sharp = require('sharp');

const downloader = require('../pdd-product-media-downloader.cjs');
const login = require('../pdd-login.cjs');
const browserSession = require('../1688-browser-session.cjs');

const PRODUCT_URL = 'https://mobile.yangkeduo.com/goods.html?goods_id=978231634569';
const LOGIN_URL = `https://mobile.yangkeduo.com/login.html?from=${encodeURIComponent(PRODUCT_URL)}`;
const PRODUCT_IMAGE = 'https://img.pddpic.com/mms-goods-image/2026-04-13/60b5e3ea-2625-41ce-96aa-8ad0b09579ee.jpeg.a.jpeg?imageView2/2/w/1300/q/80';

test('profile busy is returned before E006 creates a product output directory', (t) => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pdd-profile-busy-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const profileDir = path.join(root, 'profile');
  const held = browserSession.acquireProfileLock(profileDir, {
    lockSuffix: '.pdd.lock',
    profileLabel: 'PDD',
    ownerRole: 'login',
  });
  t.after(() => held.release());
  const payload = {
    SKU: '0000024',
    productName: '锁测试商品',
    productUrl: PRODUCT_URL,
    parentOutputDir: root,
    n8nExecutionId: '99102',
    browserUserDataDir: profileDir,
    headless: true,
  };
  const encoded = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64');
  const run = spawnSync(process.execPath, [path.resolve(__dirname, '../pdd-product-media-downloader.cjs'), encoded], {
    encoding: 'utf8',
    timeout: 20_000,
  });
  assert.equal(run.status, 0, run.stderr);
  const result = JSON.parse(run.stdout.trim().split(/\r?\n/).filter(Boolean).at(-1));
  assert.equal(result.status, 'profile_busy');
  assert.equal(result.browserProfileBusy, true);
  assert.equal(result.outputDir, '');
  assert.equal(fs.existsSync(path.join(root, '0000024-锁测试商品-99102')), false);
});

test('E006 releases an acquired profile lock when the idempotency owner is lost before output reservation', (t) => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pdd-owner-lost-lock-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const profileDir = path.join(root, 'profile');
  const ownerLost = new Error('terminal receipt already exists');
  ownerLost.code = 'IDEMPOTENCY_OWNER_LOST';
  assert.throws(
    () => downloader.acquireOwnedPddProfileLock(profileDir, { assertOwned() { throw ownerLost; } }),
    (error) => error === ownerLost,
  );

  const reacquired = browserSession.acquireProfileLock(profileDir, {
    lockSuffix: '.pdd.lock',
    profileLabel: 'PDD',
    ownerRole: 'download',
  });
  reacquired.release();
  assert.equal(fs.existsSync(profileDir + '.pdd.lock'), false);
});

test('E006 publishes every metadata result through the shared fsync-and-rename writer', () => {
  const source = fs.readFileSync(path.resolve(__dirname, '../pdd-product-media-downloader.cjs'), 'utf8');
  assert.doesNotMatch(source, /fs\.writeFileSync\(result\.metadataPath/);
  const writes = source.match(/atomicWriteJson\(result\.metadataPath/g) || [];
  assert.equal(writes.length, 5);
});

test('manual login helper launches ordinary Chrome without Playwright or remote debugging', () => {
  const source = fs.readFileSync(path.resolve(__dirname, '../pdd-login.cjs'), 'utf8');
  assert.equal(source.includes("require('playwright')"), false);
  assert.equal(/remote-debugging|AutomationControlled|navigator\.webdriver/i.test(source), false);
  assert.equal(login.DEFAULT_CHROME_USER_DATA_DIR, 'D:/n8n-browser-profile/pdd');
  assert.equal(login.validatePddUrl('https://mobile.yangkeduo.com/'), 'https://mobile.yangkeduo.com/');
  assert.throws(() => login.validatePddUrl('https://example.com/'), /yangkeduo\.com/);
});

test('builds sandboxed mobile and desktop launch options without custom args', () => {
  const mobile = downloader.buildPddLaunchOptions({ headless: true, mode: 'mobile' });
  assert.equal(mobile.headless, true);
  assert.equal(mobile.isMobile, true);
  assert.equal(mobile.hasTouch, true);
  assert.deepEqual(mobile.viewport, { width: 390, height: 844 });
  assert.equal(mobile.chromiumSandbox, true);
  assert.equal('args' in mobile, false);

  const desktop = downloader.buildPddLaunchOptions({ headless: false, mode: 'desktop' });
  assert.equal(desktop.headless, false);
  assert.equal(desktop.isMobile, false);
  assert.equal(desktop.hasTouch, false);
  assert.deepEqual(desktop.viewport, { width: 1440, height: 900 });
  assert.match(desktop.userAgent, /Windows NT 10\.0/);
  assert.equal(desktop.chromiumSandbox, true);
  assert.equal('args' in desktop, false);
});

test('passes the configured Chrome executable without adding stealth launch arguments', () => {
  const chrome = downloader.buildPddLaunchOptions({
    headless: false,
    mode: 'mobile',
    executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  });
  assert.equal(chrome.executablePath, 'C:/Program Files/Google/Chrome/Application/chrome.exe');
  assert.equal('args' in chrome, false);
  assert.equal(JSON.stringify(chrome).match(/AutomationControlled|webdriver|stealth/i), null);
});

test('detects unavailable product pages without treating login pages as product fallback', () => {
  const unavailable = downloader.detectPddProductUnavailableFromSignals({
    finalUrl: PRODUCT_URL,
    title: '拼多多',
    text: '商品已售罄，推荐以下相似商品',
  });
  assert.equal(unavailable.unavailable, true);
  assert.equal(unavailable.reason, '商品已售罄');

  const login = downloader.detectPddProductUnavailableFromSignals({
    finalUrl: LOGIN_URL,
    title: '登录',
    text: '手机号码登录',
  });
  assert.equal(login.unavailable, false);
});

test('detects PDD platform-busy pages separately from sold-out and login pages', () => {
  const busy = downloader.detectPddPlatformBusyFromSignals({
    finalUrl: 'https://mobile.yangkeduo.com/search_result.html?search_key=test',
    title: '拼多多',
    text: '系统繁忙，请稍后再试',
  });
  assert.equal(busy.busy, true);
  assert.equal(busy.reason, '系统繁忙');

  assert.equal(downloader.detectPddPlatformBusyFromSignals({
    finalUrl: PRODUCT_URL,
    title: '拼多多',
    text: '商品已售罄，推荐以下相似商品',
  }).busy, false);
  assert.equal(downloader.detectPddPlatformBusyFromSignals({
    finalUrl: LOGIN_URL,
    title: '登录',
    text: '手机号码登录',
  }).busy, false);
});

test('builds a same-origin PDD search health URL from the original product query', () => {
  const productUrl = `${PRODUCT_URL}&_x_query=${encodeURIComponent('尼龙牛津布托特包')}&refer_page_name=search_result`;
  const healthUrl = new URL(downloader.buildPddSearchHealthUrl(productUrl));
  assert.equal(healthUrl.origin, 'https://mobile.yangkeduo.com');
  assert.equal(healthUrl.pathname, '/search_result.html');
  assert.equal(healthUrl.searchParams.get('search_key'), '尼龙牛津布托特包');
  assert.equal(downloader.buildPddSearchHealthUrl(PRODUCT_URL), '');
});

test('retries unavailable pages only when the final URL is still bound to the target goods', () => {
  const unavailable = {
    needLoginOrCaptcha: false,
    main: [],
    productUnavailable: true,
    loginState: { finalUrl: PRODUCT_URL, sampleText: '商品已售罄' },
  };
  assert.equal(downloader.shouldRetryUnavailableProduct({
    extracted: unavailable,
    goodsId: '978231634569',
    productUrl: PRODUCT_URL,
  }), true);
  assert.equal(downloader.shouldRetryUnavailableProduct({
    extracted: unavailable,
    goodsId: '111111111111',
    productUrl: PRODUCT_URL,
  }), false);
  assert.equal(downloader.shouldRetryUnavailableProduct({
    extracted: { ...unavailable, needLoginOrCaptcha: true },
    goodsId: '978231634569',
    productUrl: PRODUCT_URL,
  }), false);
  assert.equal(downloader.shouldRetryUnavailableProduct({
    extracted: { ...unavailable, main: [{ url: PRODUCT_IMAGE }] },
    goodsId: '978231634569',
    productUrl: PRODUCT_URL,
  }), false);
});

test('detects a delayed navigation from a product page to login', async () => {
  const states = [
    { finalUrl: PRODUCT_URL, title: '商品详情', text: '' },
    { finalUrl: LOGIN_URL, title: '登录', text: '手机号登录' },
  ];
  const page = {
    url: () => PRODUCT_URL,
    waitForTimeout: async () => {},
    evaluate: async () => states.shift() || states.at(-1),
  };

  const state = await downloader.waitForPddPageToSettle(page, [], {
    maxWaitMs: 100,
    minObserveMs: 0,
    sampleMs: 0,
  });

  assert.equal(state.blocked, true);
  assert.equal(state.reason, 'login_redirect');
});

test('login navigation wins even when the page exposes image assets', () => {
  const state = downloader.detectPddBlockedStateFromSignals({
    finalUrl: PRODUCT_URL,
    title: '拼多多',
    text: '',
    navigationUrls: [PRODUCT_URL, LOGIN_URL],
  });
  assert.equal(state.blocked, true);
  assert.equal(state.reason, 'login_redirect');
});

test('rejects execution 20619 page URLs and login-shell assets', () => {
  const rejected = [
    PRODUCT_URL,
    LOGIN_URL,
    'https://funimg.pddpic.com/core-ui/spinner.png',
    'https://funimg.pddpic.com/personal/login_footer.png',
    'https://funimg.pddpic.com/personal/phone_sprite_v2.png',
    'https://funimg.pddpic.com/base/share_logo.jpg',
    'https://funimg.pddpic.com/base/logo.jpg',
    'https://th.yangkeduo.com/t.gif',
  ];
  for (const url of rejected) {
    assert.equal(downloader.isImageUrl(url), false, url);
    assert.equal(downloader.isLikelyProductImageUrl(url), false, url);
  }
  assert.equal(downloader.isImageUrl(PRODUCT_IMAGE), true);
  assert.equal(downloader.isLikelyProductImageUrl(PRODUCT_IMAGE), true);
});

test('keeps oak gallery as a product-image fallback without weakening login detection', () => {
  const url = `${PRODUCT_URL}&_oak_gallery=${encodeURIComponent(PRODUCT_IMAGE)}`;
  assert.deepEqual(downloader.parseUrlParamList(url, '_oak_gallery'), [PRODUCT_IMAGE]);
  assert.equal(downloader.detectPddBlockedStateFromSignals({ finalUrl: LOGIN_URL }).blocked, true);
});

test('does not treat query oak gallery as an authoritative structured gallery', () => {
  const preview = 'https://img.pddpic.com/mms-material-img/2024-09-01/preview.jpeg';
  const payload = {
    store: {
      initDataObj: {
        goods_id: '645970516274',
        queries: {
          _oak_gallery: preview,
          thumb_url: `${preview}?imageView2/2/w/400/q/80`,
        },
      },
    },
  };
  const structured = downloader.extractStructuredMediaCandidates(payload, '645970516274', {
    source: 'structured_data',
    sourcePath: '$window.rawData',
  });

  assert.equal(structured.length, 1);
  assert.equal(structured[0].source, 'query_parameter');
  assert.equal(structured[0].fieldRole, 'thumb');
  assert.equal(structured[0].authoritative, false);

  const selected = downloader.selectMediaCandidates({ structured, maxMainImages: 10 });
  assert.equal(selected.main.length, 0);
  assert.equal(selected.queryPreviewImages.length, 1);
  assert.equal(selected.queryThumbnailOnly, true);
  assert.equal(selected.expectedMainImageCount, 0);
  assert.equal(selected.mainImageSource, '');
  assert.equal(selected.pageVariant, 'query_thumbnail_only');
});

test('validates decoded image dimensions before writing product media', async () => {
  const valid = await sharp({
    create: { width: 600, height: 600, channels: 3, background: '#ffffff' },
  }).jpeg().toBuffer();
  const tiny = await sharp({
    create: { width: 32, height: 32, channels: 3, background: '#ffffff' },
  }).png().toBuffer();

  const metadata = await downloader.validateProductImageBuffer(valid);
  assert.equal(metadata.width, 600);
  await assert.rejects(() => downloader.validateProductImageBuffer(tiny), /too small|below/i);
});

test('defaults detail images to 50 and caps explicit values at 100', () => {
  assert.equal(downloader.normalizeLimits({}).maxDetailImages, 50);
  assert.equal(downloader.normalizeLimits({ maxDetailImages: 80 }).maxDetailImages, 80);
  assert.equal(downloader.normalizeLimits({ maxDetailImages: 150 }).maxDetailImages, 100);
  assert.equal(downloader.normalizeLimits({ maxDetailImages: 0 }).maxDetailImages, 0);
});

test('defaults to natural scrolling and preserves fixed scrolling as a fallback', () => {
  assert.equal(downloader.normalizeLimits({}).scrollBehavior, 'natural');
  assert.equal(downloader.normalizeLimits({ scrollBehavior: 'fixed' }).scrollBehavior, 'fixed');
  assert.equal(downloader.normalizeLimits({ scrollBehavior: 'unknown' }).scrollBehavior, 'natural');
  assert.equal(downloader.normalizeLimits({ interactionSeed: 'seed-001' }).interactionSeed, 'seed-001');
});

test('builds reproducible natural scroll plans from a fixed seed', () => {
  const firstRandom = downloader.createSeededRandom('seed-001:mobile:goods');
  const secondRandom = downloader.createSeededRandom('seed-001:mobile:goods');
  const first = downloader.buildScrollActionPlan({
    scrollBehavior: 'natural',
    scrollWaitMs: 1200,
    viewportHeight: 844,
    viewportWidth: 390,
    browserMode: 'mobile',
    iteration: 2,
    random: firstRandom,
  });
  const second = downloader.buildScrollActionPlan({
    scrollBehavior: 'natural',
    scrollWaitMs: 1200,
    viewportHeight: 844,
    viewportWidth: 390,
    browserMode: 'mobile',
    iteration: 2,
    random: secondRandom,
  });

  assert.deepEqual(first, second);
  assert.equal(first.behavior, 'natural');
  assert.equal(first.method, 'smooth_window');
  assert.ok(first.steps.length >= 2 && first.steps.length <= 5);
  assert.ok(first.finalWaitMs >= 100 && first.finalWaitMs <= 10000);
  assert.ok(first.steps.every((step) => step.deltaY > 0 && step.delayMs >= 90 && step.delayMs <= 260));
});

test('fixed scroll plan keeps the previous single-step distance', () => {
  const plan = downloader.buildScrollActionPlan({
    scrollBehavior: 'fixed',
    scrollWaitMs: 1200,
    viewportHeight: 844,
    browserMode: 'mobile',
    random: downloader.createSeededRandom('fixed'),
  });

  assert.equal(plan.behavior, 'fixed');
  assert.equal(plan.method, 'fixed_window');
  assert.deepEqual(plan.steps, [{ deltaY: 675, delayMs: 1200 }]);
  assert.equal(plan.finalWaitMs, 1200);
});

test('compacts successful image files to continuous numeric names', () => {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pdd-media-')));
  try {
    const second = path.join(directory, 'main_02.jpg');
    const fourth = path.join(directory, 'main_04.png');
    fs.writeFileSync(second, 'second');
    fs.writeFileSync(fourth, 'fourth');
    const compacted = downloader.compactMediaFiles([
      null,
      { url: 'https://img.pddpic.com/goods/a.jpg', localPath: second },
      null,
      { url: 'https://img.pddpic.com/goods/b.png', localPath: fourth },
    ], 'main');

    assert.deepEqual(compacted.map((item) => path.basename(item.localPath)), ['main_01.jpg', 'main_02.png']);
    assert.equal(fs.existsSync(path.join(directory, 'main_01.jpg')), true);
    assert.equal(fs.existsSync(path.join(directory, 'main_02.png')), true);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('does not stop at recommendation text before detail collection starts', () => {
  assert.equal(downloader.shouldStopDetailScroll({
    detailStarted: false,
    recommendationVisible: true,
    noGrowth: 10,
    atBottom: false,
  }), false);
  assert.equal(downloader.shouldStopDetailScroll({
    detailStarted: true,
    recommendationVisible: true,
    noGrowth: 0,
    atBottom: false,
  }), true);
  assert.equal(downloader.shouldStopDetailScroll({
    detailStarted: true,
    recommendationVisible: false,
    noGrowth: 3,
    atBottom: false,
  }), true);
});

test('extracts structured media only from the target goods object', () => {
  const targetMain = 'https://img.pddpic.com/mms-goods-image/target-main.jpeg';
  const targetDetail = 'https://img.pddpic.com/mms-goods-image/target-detail.jpeg';
  const otherMain = 'https://img.pddpic.com/mms-goods-image/other-main.jpeg';
  const payload = {
    goods: {
      goods_id: '887732936702',
      gallery: [{ url: targetMain }],
      detail: { images: [targetDetail] },
    },
    recommendations: [{
      goods_id: '100000000001',
      gallery: [{ url: otherMain }],
    }],
  };
  const candidates = downloader.extractStructuredMediaCandidates(payload, '887732936702', {
    source: 'network_response',
  });

  assert.deepEqual(candidates.map((item) => item.url), [targetMain, targetDetail]);
  assert.deepEqual(candidates.map((item) => item.role), ['main', 'detail']);
  assert.equal(candidates.every((item) => item.goodsIdMatched), true);
});

test('canonicalizes PDD host and image transformation variants for URL dedupe', () => {
  const original = 'https://img.pddpic.com/mms-material-img/a.jpeg';
  const transformed = 'https://img-2.pddpic.com/mms-material-img/a.jpeg?imageView2/2/w/1300/q/80';
  assert.equal(downloader.mediaKey(original), downloader.mediaKey(transformed));
});

test('keeps authoritative candidates ahead of URL fallback and excludes unrelated pools', () => {
  const structured = [
    downloader.createMediaCandidate('https://img.pddpic.com/mms-goods-image/a.jpeg', 'main', 'network_response', '$.gallery[0]', 0, true, 'gallery'),
    downloader.createMediaCandidate('https://img.pddpic.com/mms-goods-image/b.jpeg', 'main', 'network_response', '$.gallery[1]', 1, true, 'gallery'),
  ];
  const urlMain = [
    downloader.createMediaCandidate('https://img.pddpic.com/open-gw/thumb.jpeg', 'main', 'url_parameter', '$url', 0, true, 'thumb'),
  ];
  const selected = downloader.selectMediaCandidates({ structured, urlMain, maxMainImages: 10 });

  assert.equal(selected.mainImageSource, 'network_response');
  assert.equal(selected.expectedMainImageCount, 2);
  assert.equal(selected.pageVariant, 'structured_gallery');
  assert.deepEqual(selected.main.map((item) => item.url), [structured[0].url, structured[1].url]);
  assert.deepEqual(selected.queryPreviewImages.map((item) => item.url), [urlMain[0].url]);
  assert.equal(selected.queryThumbnailOnly, false);
});

test('retries query-thumbnail-only pages without retrying login pages', () => {
  assert.equal(downloader.shouldRetryQueryThumbnailOnly({
    extracted: {
      needLoginOrCaptcha: false,
      queryThumbnailOnly: true,
      authoritativeMainCandidateCount: 0,
      queryPreviewImages: [{ url: PRODUCT_IMAGE }],
    },
  }), true);
  assert.equal(downloader.shouldRetryQueryThumbnailOnly({
    extracted: {
      needLoginOrCaptcha: true,
      queryThumbnailOnly: true,
      authoritativeMainCandidateCount: 0,
      queryPreviewImages: [{ url: PRODUCT_IMAGE }],
    },
  }), false);
  assert.equal(downloader.shouldRetryQueryThumbnailOnly({
    extracted: {
      needLoginOrCaptcha: false,
      queryThumbnailOnly: false,
      authoritativeMainCandidateCount: 2,
      queryPreviewImages: [{ url: PRODUCT_IMAGE }],
    },
  }), false);
});

test('continues after invalid candidates until the valid main-image limit is filled', async () => {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pdd-media-backfill-')));
  const originalFetch = global.fetch;
  try {
    const tiny = await sharp({
      create: { width: 32, height: 32, channels: 3, background: '#ffffff' },
    }).jpeg().toBuffer();
    const valid = await Promise.all(Array.from({ length: 10 }, (_, index) => sharp({
      create: {
        width: 600,
        height: 600,
        channels: 3,
        background: { r: index * 20, g: 100, b: 200 },
      },
    }).jpeg().toBuffer()));
    const buffers = new Map();
    const candidates = [];
    for (let index = 0; index < 13; index += 1) {
      const url = `https://img.pddpic.com/mms-goods-image/${index}.jpeg`;
      buffers.set(url, index < 3 ? tiny : valid[index - 3]);
      candidates.push(downloader.createMediaCandidate(url, 'main', 'main_carousel', '$dom', index, true, 'gallery'));
    }
    global.fetch = async (url) => {
      const buffer = buffers.get(String(url));
      return {
        ok: true,
        status: 200,
        headers: { get: () => 'image/jpeg' },
        arrayBuffer: async () => buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength),
      };
    };

    const downloaded = await downloader.downloadValidatedCandidates({
      candidates,
      max: 10,
      concurrency: 8,
      prefix: 'main',
      dir: directory,
      referer: PRODUCT_URL,
      timeoutMs: 30000,
    });

    assert.equal(downloaded.records.length, 10);
    assert.equal(downloaded.rejected.length, 3);
    assert.equal(downloaded.attemptedCount, 13);
    assert.equal(downloaded.skippedByLimitCount, 0);
    assert.equal(downloaded.limitReached, false);
    assert.deepEqual(
      downloaded.records.map((item) => path.basename(item.localPath)),
      Array.from({ length: 10 }, (_, index) => `main_${String(index + 1).padStart(2, '0')}.jpg`),
    );
  } finally {
    global.fetch = originalFetch;
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('reports candidates skipped after the validated image limit is reached', async () => {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pdd-media-limit-')));
  const originalFetch = global.fetch;
  try {
    const buffers = new Map();
    const candidates = [];
    for (let index = 0; index < 6; index += 1) {
      const url = `https://img.pddpic.com/mms-goods-image/limit-${index}.jpeg`;
      const buffer = await sharp({
        create: {
          width: 600,
          height: 600,
          channels: 3,
          background: { r: index * 30, g: 120, b: 220 },
        },
      }).jpeg().toBuffer();
      buffers.set(url, buffer);
      candidates.push(downloader.createMediaCandidate(url, 'detail', 'detail_dom', '$dom', index, true, 'detail'));
    }
    global.fetch = async (url) => {
      const buffer = buffers.get(String(url));
      return {
        ok: true,
        status: 200,
        headers: { get: () => 'image/jpeg' },
        arrayBuffer: async () => buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength),
      };
    };

    const downloaded = await downloader.downloadValidatedCandidates({
      candidates,
      max: 4,
      concurrency: 4,
      prefix: 'detail',
      dir: directory,
      referer: PRODUCT_URL,
      timeoutMs: 30000,
    });

    assert.equal(downloaded.records.length, 4);
    assert.equal(downloaded.attemptedCount, 4);
    assert.equal(downloaded.unattemptedCount, 2);
    assert.equal(downloaded.skippedByLimitCount, 2);
    assert.equal(downloaded.limitReached, true);
  } finally {
    global.fetch = originalFetch;
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
