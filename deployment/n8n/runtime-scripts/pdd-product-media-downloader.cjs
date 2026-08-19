#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { atomicWriteJson, decodePayload, startHeartbeat } = require('./download-idempotency-v1.cjs');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const sharp = require('sharp');
const { reserveExecutionOutputDir, reserveVersionedOutputDir } = require('./pdd-output-dir-version.cjs');
const { evaluateWithNavigationRetry } = require('./playwright-navigation-retry.cjs');
const { acquireProfileLock, ProfileBusyError } = require('./1688-browser-session.cjs');

const MOBILE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1';
const DESKTOP_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36';
const IMAGE_EXT_BY_TYPE = {
  'image/jpeg': '.jpg',
  'image/jpg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'image/gif': '.gif',
};
const VIDEO_EXT_BY_TYPE = {
  'video/mp4': '.mp4',
  'application/vnd.apple.mpegurl': '.m3u8',
  'application/x-mpegurl': '.m3u8',
};
const PDD_BLOCKED_TEXT_RE = /登录|验证码|安全验证|滑块|拖动|风险|人机|异常|验证身份|账号验证|短信验证|login|captcha/i;
const PDD_BLOCKED_PATH_RE = /\/(?:login(?:\.html)?|captcha|verify|verification|risk(?:[-_]?control)?)(?:\/|$)/i;
const PDD_PRODUCT_UNAVAILABLE_TEXT_RE = /商品已售罄|商品已下架|商品不存在|商品已失效|暂不支持购买|暂时无法购买/;
const PDD_PLATFORM_BUSY_TEXT_RE = /系统繁忙|请稍后再试|请求过于频繁|操作频繁/;
const NON_PRODUCT_ASSET_RE = /(?:^|\/)(?:core-ui|personal|fonts?|promo)(?:\/|$)|\/(?:base\/)?(?:share_)?logo(?:[._/-]|$)|(?:spinner|loading|sprite|avatar|favicon|iconfont|qrcode|qr_code|captcha|badge|brand[_-]?(?:black[_-]?)?label|corner[_-]?mark)[._/-]|\/t\.gif(?:$|[?#])/i;
const PRODUCT_IMAGE_PATH_RE = /\/(?:mms-goods-image|open-gw|goods|gallery|thumb|image)(?:\/|[-_])/i;
const MAIN_FIELD_RE = /(?:^|_)(?:top_?)?(?:goods_?)?(?:gallery|gallery_urls?|thumb|thumb_url|hd_thumb_url|image_urls?|main_images?)(?:$|_)/i;
const DETAIL_FIELD_RE = /(?:^|_)(?:goods_?)?(?:detail|details|description|desc|content)(?:$|_)/i;
const VIDEO_FIELD_RE = /(?:^|_)(?:video|video_url|hd_url|play_url)(?:$|_)/i;
const BAD_CONTEXT_RE = /推荐|猜你喜欢|相似商品|店铺|评价|评论|客服|头像|广告|直播|榜单|精选|更多商品/;
const DETAIL_MARKER_RE = /商品详情|图文详情|宝贝详情|产品详情|规格参数/;
const RECOMMENDATION_RE = /猜你喜欢|推荐商品|相似商品|看了又看|店铺推荐/;
const MIN_PRODUCT_IMAGE_WIDTH = 300;
const MIN_PRODUCT_IMAGE_HEIGHT = 180;
const MIN_PRODUCT_IMAGE_BYTES = 1024;

function makeEmptyResult(overrides = {}) {
  return {
    success: false,
    status: 'pending',
    httpStatus: 500,
    productName: '',
    SKU: '',
    productUrl: '',
    goodsId: '',
    n8nExecutionId: '',
    outputDir: '',
    revision: 0,
    mainImageCount: 0,
    detailImageCount: 0,
    videoCount: 0,
    mainImages: [],
    detailImages: [],
    videos: [],
    metadataPath: '',
    browserProfileBusy: false,
    browserProfileLocked: false,
    profileStatus: 'not_started',
    needLoginOrCaptcha: false,
    needHumanVerification: false,
    humanVerificationResolved: false,
    humanVerificationStatus: 'not_required',
    navigationRetryCount: 0,
    finalPageUrl: '',
    pageTitle: '',
    blockReason: '',
    blockedScreenshotPath: '',
    pageVariant: 'unknown',
    mainImageSource: '',
    detailImageSource: '',
    expectedMainImageCount: 0,
    mainImageComplete: false,
    mainCompletenessVersion: 2,
    mainGallerySlotCount: 0,
    mainDuplicateContentCount: 0,
    mainFailedCandidateCount: 0,
    mainCandidateCount: 0,
    detailCandidateCount: 0,
    detailImageLimit: 50,
    detailImageComplete: false,
    detailImageTruncated: false,
    detailSkippedByLimitCount: 0,
    rejectedMedia: [],
    fallbackUsed: false,
    browserModeAttempts: [],
    selectedBrowserMode: '',
    canonicalProductUrl: '',
    activeProductUrl: '',
    initialUnavailableShellDetected: false,
    unavailableCanonicalRetryUsed: false,
    unavailableCanonicalRetryRecovered: false,
    unavailableClassification: 'not_unavailable',
    unavailableCanonicalRetryDelayMs: 12000,
    targetAvailabilityEvidence: [],
    productNavigationCount: 0,
    scrollSuppressed: false,
    scrollSuppressedReason: '',
    profileSessionStatus: 'not_checked',
    profileRefreshCommand: '',
    productUnavailableDetected: false,
    productUnavailableReason: '',
    unavailableScreenshotPaths: [],
    platformBusyDetected: false,
    platformBusyReason: '',
    platformBusyRetryCount: 0,
    platformBusyProbeUrl: '',
    mediaDiagnostics: {},
    queryThumbnailOnly: false,
    authoritativeMainCandidateCount: 0,
    authoritativeDetailCandidateCount: 0,
    retryReason: '',
    queryPreviewImages: [],
    scrollBehavior: 'natural',
    interactionSeed: '',
    scrollActionCount: 0,
    scrollActions: [],
    errors: [],
    warnings: [],
    ...overrides,
  };
}

function printResult(result) {
  process.stdout.write(JSON.stringify(result) + '\n');
}

function decodeParams() {
  const raw = process.argv[2] || '';
  if (!raw) {
    return { params: null, error: 'Missing Base64 parameter payload.' };
  }
  try {
    return { params: decodePayload(raw), error: '' };
  } catch (error) {
    return { params: null, error: 'Invalid Base64 parameter payload: ' + error.message };
  }
}

function toBool(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'boolean') return value;
  const text = String(value).trim().toLowerCase();
  if (['true', '1', 'yes', 'y'].includes(text)) return true;
  if (['false', '0', 'no', 'n'].includes(text)) return false;
  return fallback;
}

function toInt(value, fallback, min, max) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}

function normalizeScrollBehavior(value) {
  const text = String(value || '').trim().toLowerCase();
  return text === 'fixed' ? 'fixed' : 'natural';
}

function normalizeInteractionSeed(value) {
  const text = String(value || '').trim();
  return text || crypto.randomBytes(8).toString('hex');
}

function normalizeLimits(raw = {}) {
  return {
    requestTimeoutMs: toInt(raw.requestTimeoutMs, 30000, 5000, 180000),
    scrollMaxTimes: toInt(raw.scrollMaxTimes, 12, 0, 80),
    scrollWaitMs: toInt(raw.scrollWaitMs, 1200, 100, 10000),
    scrollBehavior: normalizeScrollBehavior(raw.scrollBehavior),
    interactionSeed: normalizeInteractionSeed(raw.interactionSeed),
    maxMainImages: toInt(raw.maxMainImages, 10, 0, 100),
    maxDetailImages: toInt(raw.maxDetailImages, 50, 0, 100),
    maxVideos: toInt(raw.maxVideos, 3, 0, 30),
    unavailableCanonicalRetryEnabled: toBool(raw.unavailableCanonicalRetryEnabled, true),
    unavailableCanonicalRetryDelayMs: toInt(raw.unavailableCanonicalRetryDelayMs, 12000, 0, 60000),
    unavailableCanonicalRetryJitterMs: toInt(raw.unavailableCanonicalRetryJitterMs, 3000, 0, 15000),
    unavailableCanonicalRetryMaxAttempts: toInt(raw.unavailableCanonicalRetryMaxAttempts, 1, 0, 1),
  };
}

function normalizePathInput(value) {
  let text = String(value || '').trim();
  if ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'"))) {
    text = text.slice(1, -1).trim();
  }
  return text.replace(/\\+/g, '/').replace(/^([A-Za-z]:)\/+/, '$1/');
}

function pathExists(filePath) {
  try {
    return !!filePath && fs.existsSync(filePath) && fs.statSync(filePath).isFile();
  } catch (error) {
    return false;
  }
}

function findBrowserExecutable(explicitPath = '') {
  const explicit = normalizePathInput(explicitPath);
  if (pathExists(explicit)) return explicit;

  const localAppData = process.env.LOCALAPPDATA || '';
  const programFiles = process.env.ProgramFiles || 'C:/Program Files';
  const programFilesX86 = process.env['ProgramFiles(x86)'] || 'C:/Program Files (x86)';
  const home = process.env.HOME || process.env.USERPROFILE || '';
  const candidates = [
    process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
    `${programFiles}/Google/Chrome/Application/chrome.exe`,
    `${programFilesX86}/Google/Chrome/Application/chrome.exe`,
    localAppData ? `${localAppData}/Google/Chrome/Application/chrome.exe` : '',
    `${programFiles}/Microsoft/Edge/Application/msedge.exe`,
    `${programFilesX86}/Microsoft/Edge/Application/msedge.exe`,
    localAppData ? `${localAppData}/Microsoft/Edge/Application/msedge.exe` : '',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    home ? `${home}/Applications/Google Chrome.app/Contents/MacOS/Google Chrome` : '',
  ].map(normalizePathInput);

  return candidates.find(pathExists) || '';
}

function buildPddLaunchOptions({ headless, mode = 'mobile', executablePath = '' }) {
  const desktop = mode === 'desktop';
  const options = {
    headless: Boolean(headless),
    userAgent: desktop ? DESKTOP_UA : MOBILE_UA,
    viewport: desktop ? { width: 1440, height: 900 } : { width: 390, height: 844 },
    isMobile: !desktop,
    hasTouch: !desktop,
    locale: 'zh-CN',
    timezoneId: 'Asia/Shanghai',
    ignoreHTTPSErrors: true,
    chromiumSandbox: true,
  };
  if (executablePath) options.executablePath = executablePath;
  return options;
}

function clampNumber(value, min, max) {
  return Math.max(min, Math.min(max, Number(value) || 0));
}

function createSeededRandom(seed) {
  const hash = crypto.createHash('sha256').update(String(seed || 'pdd-scroll')).digest();
  let state = hash.readUInt32LE(0) || 0x9e3779b9;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

function randomBetween(random, min, max) {
  return min + (max - min) * random();
}

function randomInt(random, min, max) {
  return Math.floor(randomBetween(random, min, max + 1));
}

function buildScrollActionPlan({
  scrollBehavior = 'natural',
  scrollWaitMs = 1200,
  viewportHeight = 844,
  viewportWidth = 390,
  browserMode = 'mobile',
  iteration = 0,
  random = Math.random,
} = {}) {
  const behavior = normalizeScrollBehavior(scrollBehavior);
  const viewportH = clampNumber(viewportHeight, 320, 2200);
  const viewportW = clampNumber(viewportWidth, 240, 2400);
  if (behavior === 'fixed') {
    return {
      behavior,
      method: 'fixed_window',
      steps: [{ deltaY: Math.max(520, Math.floor(viewportH * 0.8)), delayMs: scrollWaitMs }],
      reverseDeltaY: 0,
      hoverMs: 0,
      mouseMoves: [],
      finalWaitMs: scrollWaitMs,
    };
  }

  const stepCount = randomInt(random, 2, 5);
  const totalDeltaY = Math.round(viewportH * randomBetween(random, 0.62, 0.96));
  const steps = [];
  let remaining = totalDeltaY;
  for (let index = 0; index < stepCount; index += 1) {
    const slots = stepCount - index;
    const base = remaining / slots;
    const deltaY = index === stepCount - 1
      ? remaining
      : Math.max(80, Math.round(base * randomBetween(random, 0.72, 1.26)));
    remaining -= deltaY;
    steps.push({
      deltaY,
      delayMs: randomInt(random, 90, 260),
    });
  }

  const reverseDeltaY = iteration > 0 && random() < 0.18
    ? -Math.round(viewportH * randomBetween(random, 0.08, 0.18))
    : 0;
  const hoverMs = random() < 0.28 ? randomInt(random, 180, 620) : 0;
  const finalWaitMs = clampNumber(Math.round(scrollWaitMs * randomBetween(random, 0.75, 1.55) + randomBetween(random, 0, 220)), 100, 10000);
  const mouseMoves = browserMode === 'desktop'
    ? Array.from({ length: randomInt(random, 1, 3) }, () => ({
      x: Math.round(viewportW * randomBetween(random, 0.26, 0.74)),
      y: Math.round(viewportH * randomBetween(random, 0.24, 0.82)),
      steps: randomInt(random, 4, 12),
    }))
    : [];

  return {
    behavior,
    method: browserMode === 'desktop' ? 'mouse_wheel' : 'smooth_window',
    steps,
    reverseDeltaY,
    hoverMs,
    mouseMoves,
    finalWaitMs,
  };
}

async function performScrollInteraction({ page, evaluatePage, limits, browserMode, iteration, random }) {
  const metrics = await evaluatePage(() => ({
    viewportHeight: window.innerHeight || 844,
    viewportWidth: window.innerWidth || 390,
    scrollY: window.scrollY || 0,
  }));
  const plan = buildScrollActionPlan({
    scrollBehavior: limits.scrollBehavior,
    scrollWaitMs: limits.scrollWaitMs,
    viewportHeight: metrics.viewportHeight,
    viewportWidth: metrics.viewportWidth,
    browserMode,
    iteration,
    random,
  });

  if (plan.behavior === 'fixed') {
    await evaluatePage((deltaY) => window.scrollBy(0, deltaY), plan.steps[0].deltaY);
    await page.waitForTimeout(plan.finalWaitMs);
  } else if (browserMode === 'desktop') {
    for (const move of plan.mouseMoves) await page.mouse.move(move.x, move.y, { steps: move.steps });
    for (const step of plan.steps) {
      await page.mouse.wheel(0, step.deltaY);
      await page.waitForTimeout(step.delayMs);
    }
    if (plan.reverseDeltaY) {
      await page.mouse.wheel(0, plan.reverseDeltaY);
      await page.waitForTimeout(randomInt(random, 120, 320));
    }
    if (plan.hoverMs) await page.waitForTimeout(plan.hoverMs);
    await page.waitForTimeout(plan.finalWaitMs);
  } else {
    for (const step of plan.steps) {
      await evaluatePage((deltaY) => window.scrollBy({ top: deltaY, left: 0, behavior: 'smooth' }), step.deltaY);
      await page.waitForTimeout(step.delayMs);
    }
    if (plan.reverseDeltaY) {
      await evaluatePage((deltaY) => window.scrollBy({ top: deltaY, left: 0, behavior: 'smooth' }), plan.reverseDeltaY);
      await page.waitForTimeout(randomInt(random, 120, 320));
    }
    if (plan.hoverMs) await page.waitForTimeout(plan.hoverMs);
    await page.waitForTimeout(plan.finalWaitMs);
  }

  const after = await evaluatePage(() => ({ scrollY: window.scrollY || 0 }));
  return {
    iteration,
    behavior: plan.behavior,
    method: plan.method,
    stepCount: plan.steps.length,
    totalDeltaY: plan.steps.reduce((sum, step) => sum + step.deltaY, 0),
    reverseDeltaY: plan.reverseDeltaY,
    finalWaitMs: plan.finalWaitMs,
    beforeScrollY: Math.round(metrics.scrollY || 0),
    afterScrollY: Math.round(after.scrollY || 0),
  };
}

function isMissingPlaywrightBrowserError(error) {
  const message = String(error && (error.message || error.stack) || error);
  return /Executable doesn't exist|playwright install|browserType\.launchPersistentContext/i.test(message);
}

function isProfileBusyLaunchError(error) {
  if (error instanceof ProfileBusyError || error?.code === 'PROFILE_BUSY') return true;
  return /(?:profile.*(?:in use|locked)|user data directory.*(?:in use|already)|singleton(?:lock|cookie|socket)|process singleton)/i.test(
    String(error?.message || error || ''),
  );
}

function acquireOwnedPddProfileLock(browserUserDataDir, heartbeatGuard, acquire = acquireProfileLock) {
  let lock;
  try {
    lock = acquire(browserUserDataDir, {
      lockSuffix: '.pdd.lock',
      profileLabel: 'PDD',
      ownerRole: 'download',
    });
    heartbeatGuard.assertOwned();
    return lock;
  } catch (error) {
    if (lock) {
      try { lock.release(); } catch {}
    }
    throw error;
  }
}

function sanitizeFileName(value, fallback = 'product') {
  const cleaned = String(value || '')
    .trim()
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, '_')
    .replace(/[. ]+$/g, '')
    .replace(/\s+/g, ' ');
  return cleaned || fallback;
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function extractGoodsId(productUrl) {
  try {
    const u = new URL(productUrl);
    return u.searchParams.get('goods_id') || u.searchParams.get('goodsId') || '';
  } catch (error) {
    const match = String(productUrl || '').match(/[?&](?:goods_id|goodsId)=([^&#]+)/);
    return match ? decodeURIComponent(match[1]) : '';
  }
}

function buildCanonicalPddProductUrl(goodsId) {
  const normalized = String(goodsId || '').trim();
  if (!/^\d+$/.test(normalized)) return '';
  return `https://mobile.yangkeduo.com/goods.html?goods_id=${normalized}`;
}

function computeUnavailableRetryDelayMs(limits, random = Math.random) {
  const base = Number(limits?.unavailableCanonicalRetryDelayMs || 0);
  const jitter = Math.max(0, Number(limits?.unavailableCanonicalRetryJitterMs || 0));
  if (!jitter) return Math.max(0, Math.round(base));
  return Math.max(0, Math.round(base + ((random() * 2) - 1) * jitter));
}

function parseUrlParamList(productUrl, key) {
  try {
    const u = new URL(productUrl);
    const raw = u.searchParams.get(key);
    if (!raw) return [];
    const values = [];
    const decoded = decodeURIComponent(raw);
    if (decoded.trim().startsWith('[')) {
      try {
        const parsed = JSON.parse(decoded);
        collectUrls(parsed, values);
      } catch (error) {}
    }
    decoded.split(/[,\s]+/).forEach((part) => {
      if (/^https?:\/\//i.test(part)) values.push(part);
    });
    return values;
  } catch (error) {
    return [];
  }
}

function htmlDecodeUrl(value) {
  return String(value || '')
    .replace(/&amp;/g, '&')
    .replace(/\\u002F/gi, '/')
    .replace(/\\\//g, '/')
    .replace(/%5Cu002F/gi, '/')
    .trim();
}

function collectUrls(value, output, seen = new Set(), depth = 0) {
  if (depth > 7 || value === null || value === undefined) return;
  if (typeof value === 'string') {
    const text = htmlDecodeUrl(value);
    if (/^https?:\/\//i.test(text)) output.push(text);
    const re = /https?:\\?\/\\?\/[^"'\s<>\\]+/gi;
    for (const match of text.matchAll(re)) output.push(htmlDecodeUrl(match[0]));
    return;
  }
  if (typeof value !== 'object') return;
  if (seen.has(value)) return;
  seen.add(value);
  if (Array.isArray(value)) {
    value.forEach((item) => collectUrls(item, output, seen, depth + 1));
    return;
  }
  for (const [key, item] of Object.entries(value)) {
    if (/gallery|thumb|image|img|video|hd_url|video_url|url/i.test(key)) {
      collectUrls(item, output, seen, depth + 1);
    } else if (depth < 3) {
      collectUrls(item, output, seen, depth + 1);
    }
  }
}

function normalizeMediaUrl(raw, baseUrl) {
  let text = htmlDecodeUrl(raw);
  if (!text || text.startsWith('data:') || text.startsWith('blob:')) return '';
  text = text.replace(/^\/\//, 'https://');
  try {
    return new URL(text, baseUrl).toString();
  } catch (error) {
    return '';
  }
}

function mediaKey(raw) {
  try {
    const u = new URL(raw);
    const removable = [
      'imageMogr2',
      'thumbnail',
      'quality',
      'format',
      'x-oss-process',
      'width',
      'height',
      'w',
      'h',
    ];
    removable.forEach((key) => u.searchParams.delete(key));
    for (const key of Array.from(u.searchParams.keys())) {
      if (/^(?:imageView2|imageMogr2|x-oss-process)(?:\/|$)/i.test(key)) u.searchParams.delete(key);
    }
    const hostname = /^img(?:-\d+)?\.pddpic\.com$/i.test(u.hostname) ? 'img.pddpic.com' : u.hostname;
    const query = u.searchParams.toString();
    return `${u.protocol}//${hostname}${u.port ? `:${u.port}` : ''}${u.pathname}${query ? `?${query}` : ''}`;
  } catch (error) {
    return String(raw || '').split('#')[0];
  }
}

function dedupeUrls(urls, baseUrl) {
  const output = [];
  const seen = new Set();
  for (const raw of urls) {
    const normalized = normalizeMediaUrl(raw, baseUrl);
    if (!normalized) continue;
    const key = mediaKey(normalized);
    if (seen.has(key)) continue;
    seen.add(key);
    output.push(normalized);
  }
  return output;
}

function isQueryParameterPath(pathText, key = '') {
  const segments = String(`${pathText || ''}.${key || ''}`)
    .split(/[.[\]]+/)
    .map((segment) => segment.replace(/^['"]|['"]$/g, '').trim().toLowerCase())
    .filter(Boolean);
  return segments.some((segment) => ['query', 'queries', 'params', 'urlparams', 'searchparams'].includes(segment));
}

function isQueryPreviewField(key, pathText = '') {
  const field = String(key || '').trim();
  return /^(?:_?oak_gallery|thumb_url)$/i.test(field) || isQueryParameterPath(pathText, field);
}

function defaultCandidateAuthority(role, source, sourcePath, fieldRole) {
  if (isQueryParameterPath(sourcePath)) return false;
  if (source === 'url_parameter' || source === 'query_parameter') return false;
  if (role === 'main') {
    if (source === 'main_carousel') return true;
    return ['structured_data', 'network_response'].includes(source) && fieldRole === 'gallery';
  }
  if (role === 'detail') return source === 'detail_dom' || ['structured_data', 'network_response'].includes(source);
  if (role === 'video') return source !== 'url_parameter' && source !== 'query_parameter';
  return false;
}

function createMediaCandidate(url, role, source, sourcePath = '', order = 0, goodsIdMatched = false, fieldRole = '', extra = {}) {
  const authoritative = Object.prototype.hasOwnProperty.call(extra, 'authoritative')
    ? Boolean(extra.authoritative)
    : defaultCandidateAuthority(role, source, sourcePath, fieldRole);
  return { url, role, source, sourcePath, order, goodsIdMatched, fieldRole, authoritative, ...extra };
}

function dedupeCandidates(candidates, baseUrl, predicate = () => true) {
  const output = [];
  const seen = new Set();
  for (const candidate of candidates || []) {
    if (!candidate || !predicate(candidate.url)) continue;
    const url = normalizeMediaUrl(candidate.url, baseUrl);
    if (!url) continue;
    const key = `${candidate.role || ''}:${mediaKey(url)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    output.push({ ...candidate, url, order: output.length });
  }
  return output;
}

function directGoodsId(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return '';
  for (const [key, item] of Object.entries(value)) {
    if (/^(?:goods_?id|goodsId)$/i.test(key) && item !== null && item !== undefined) return String(item);
  }
  return '';
}

function explicitBoolean(value) {
  if (typeof value === 'boolean') return value;
  if (value === 1 || value === '1' || String(value).toLowerCase() === 'true') return true;
  if (value === 0 || value === '0' || String(value).toLowerCase() === 'false') return false;
  return null;
}

function extractTargetAvailabilityEvidence(payload, goodsId, options = {}) {
  const source = String(options.source || 'structured_data');
  const sourcePath = String(options.sourcePath || '$');
  const rootBound = Boolean(options.rootBound);
  const targetGoodsId = String(goodsId || '');
  const evidence = [];
  const visited = new Set();
  const rejectedContext = /recommend|similar|guess|mall|shop|store|review|comment|avatar|icon|logo|promo|feed/i;
  const unavailableText = /商品已售罄|商品已下架|商品不存在|商品已失效|暂不支持购买|暂时无法购买|sold\s*out|off\s*sale|unavailable/i;

  function add(pathText, field, value, reason) {
    evidence.push({
      goodsId: targetGoodsId,
      goodsIdMatched: true,
      source,
      sourcePath: `${pathText}.${field}`,
      field,
      value,
      reason,
    });
  }

  function walk(value, pathText, inheritedBound, depth) {
    if (depth > 14 || value === null || value === undefined || typeof value !== 'object') return;
    if (visited.has(value)) return;
    visited.add(value);

    const ownGoodsId = directGoodsId(value);
    const bound = ownGoodsId ? ownGoodsId === targetGoodsId : inheritedBound;
    const entries = Array.isArray(value) ? value.entries() : Object.entries(value);
    for (const [rawKey, item] of entries) {
      const key = String(rawKey);
      const childPath = Array.isArray(value) ? `${pathText}[${key}]` : `${pathText}.${key}`;
      if (bound && !Array.isArray(value)) {
        const booleanValue = explicitBoolean(item);
        if (/^(?:is_?sold_?out|sold_?out|is_?off_?shelf|off_?shelf)$/i.test(key) && booleanValue === true) {
          add(pathText, key, item, 'explicit_sold_out_true');
        } else if (/^(?:is_?on_?sale|on_?sale|is_?available|available)$/i.test(key) && booleanValue === false) {
          add(pathText, key, item, 'explicit_on_sale_false');
        } else if (/^(?:goods_?status|sale_?status|availability_?text|status_?text|status_?desc|goods_?status_?desc|sale_?status_?desc)$/i.test(key)
          && typeof item === 'string' && unavailableText.test(item)) {
          add(pathText, key, item.slice(0, 160), 'explicit_unavailable_status_text');
        }
      }
      if (rejectedContext.test(key)) continue;
      walk(item, childPath, bound, depth + 1);
    }
  }

  walk(payload, sourcePath, rootBound, 0);
  const seen = new Set();
  return evidence.filter((item) => {
    const key = `${item.sourcePath}:${item.reason}:${String(item.value)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function classifyUnavailableOutcome({
  initialUnavailableShellDetected,
  currentUnavailable,
  mainCandidateCount,
  targetAvailabilityEvidence,
  platformBusy,
  needLoginOrCaptcha,
}) {
  if (needLoginOrCaptcha) return 'login_required';
  if (platformBusy) return 'platform_busy';
  if (!initialUnavailableShellDetected) return 'not_unavailable';
  if (Number(mainCandidateCount || 0) > 0) return 'recovered';
  if (Array.isArray(targetAvailabilityEvidence) && targetAvailabilityEvidence.length > 0) return 'confirmed_sold_out';
  if (currentUnavailable) return 'session_degraded';
  return 'unsupported_after_canonical';
}

function classifyStructuredField(key, pathText) {
  const field = String(key || '');
  const context = `${pathText}.${field}`;
  if (/recommend|similar|mall|shop|review|comment|avatar|icon|logo|promo/i.test(context)) return null;
  const queryPreview = isQueryPreviewField(field, pathText);
  if (VIDEO_FIELD_RE.test(field)) return { role: 'video', fieldRole: 'video', authoritative: true };
  if (DETAIL_FIELD_RE.test(field)) return { role: 'detail', fieldRole: 'detail', authoritative: true };
  if (MAIN_FIELD_RE.test(field)) {
    return {
      role: 'main',
      fieldRole: queryPreview ? 'thumb' : (/gallery|image_urls?|main_images?/i.test(field) ? 'gallery' : 'thumb'),
      sourceOverride: queryPreview ? 'query_parameter' : '',
      authoritative: !queryPreview && /gallery|image_urls?|main_images?/i.test(field),
    };
  }
  return null;
}

function extractStructuredMediaCandidates(payload, goodsId, options = {}) {
  const source = options.source || 'structured_data';
  const sourcePath = options.sourcePath || '$';
  const rootBound = Boolean(options.rootBound);
  const candidates = [];
  const visited = new Set();
  let sequence = 0;

  function walk(value, pathText, inheritedBound, depth) {
    if (depth > 14 || value === null || value === undefined || typeof value !== 'object') return;
    if (visited.has(value)) return;
    visited.add(value);

    const ownGoodsId = directGoodsId(value);
    const bound = ownGoodsId ? ownGoodsId === String(goodsId) : inheritedBound;
    const entries = Array.isArray(value) ? value.entries() : Object.entries(value);
    for (const [rawKey, item] of entries) {
      const key = String(rawKey);
      const childPath = Array.isArray(value) ? `${pathText}[${key}]` : `${pathText}.${key}`;
      const classification = Array.isArray(value) ? null : classifyStructuredField(key, pathText);
      if (bound && classification) {
        const urls = [];
        collectUrls(item, urls);
        for (const url of urls) {
          const valid = classification.role === 'video' ? isVideoUrl(url) : isLikelyProductImageUrl(url);
          if (!valid) continue;
          candidates.push(createMediaCandidate(
            url,
            classification.role,
            classification.sourceOverride || source,
            childPath,
            sequence++,
            true,
            classification.fieldRole,
            { authoritative: classification.authoritative },
          ));
        }
      }
      walk(item, childPath, bound, depth + 1);
    }
  }

  walk(payload, sourcePath, rootBound, 0);
  return dedupeCandidates(candidates, 'https://mobile.yangkeduo.com/', (url) => isLikelyProductImageUrl(url) || isVideoUrl(url));
}

function parseStructuredResponseText(text) {
  const input = String(text || '').trim();
  if (!input || input.length > 5000000) return null;
  try {
    return JSON.parse(input);
  } catch (error) {}
  const start = Math.min(...['{', '['].map((token) => {
    const index = input.indexOf(token);
    return index < 0 ? Number.POSITIVE_INFINITY : index;
  }));
  const objectEnd = input.lastIndexOf('}');
  const arrayEnd = input.lastIndexOf(']');
  const end = Math.max(objectEnd, arrayEnd);
  if (!Number.isFinite(start) || end <= start) return null;
  try {
    return JSON.parse(input.slice(start, end + 1));
  } catch (error) {
    return null;
  }
}

function responseIsBoundToGoods(responseUrl, goodsId) {
  const text = String(responseUrl || '');
  if (!goodsId) return false;
  try {
    const parsed = new URL(text);
    return [parsed.searchParams.get('goods_id'), parsed.searchParams.get('goodsId'), parsed.searchParams.get('goods_id_list')]
      .filter(Boolean)
      .some((value) => String(value).split(/[,\[\]"]/).includes(String(goodsId)));
  } catch (error) {
    return new RegExp(`(?:goods_id|goodsId)[^0-9]{0,8}${String(goodsId)}`).test(text);
  }
}

function shouldStopDetailScroll({ detailStarted, recommendationVisible, noGrowth, atBottom }) {
  if (atBottom) return true;
  return Boolean(detailStarted) && (Boolean(recommendationVisible) || Number(noGrowth || 0) >= 3);
}

function isAuthoritativeCandidate(item) {
  return Boolean(item && item.goodsIdMatched === true && item.authoritative === true);
}

function selectMediaCandidates({ structured = [], domMain = [], domDetail = [], urlMain = [], maxMainImages = 10 }) {
  const structuredMain = structured.filter((item) => item.role === 'main' && item.source === 'structured_data' && isAuthoritativeCandidate(item));
  const responseMain = structured.filter((item) => item.role === 'main' && item.source === 'network_response' && isAuthoritativeCandidate(item));
  const structuredDetail = structured.filter((item) => item.role === 'detail');
  const structuredVideo = structured.filter((item) => item.role === 'video');
  const authoritativeDomMain = domMain.filter(isAuthoritativeCandidate);
  const queryPreviewImages = dedupeCandidates([
    ...structured.filter((item) => item.role === 'main' && (item.source === 'query_parameter' || item.source === 'url_parameter' || !isAuthoritativeCandidate(item))),
    ...urlMain,
  ], 'https://mobile.yangkeduo.com/', (url) => isLikelyProductImageUrl(url));
  const sourceGroups = [
    ['structured_data', structuredMain],
    ['main_carousel', authoritativeDomMain],
    ['network_response', responseMain],
  ];
  const main = dedupeCandidates(sourceGroups.flatMap((entry) => entry[1]), 'https://mobile.yangkeduo.com/', (url) => isLikelyProductImageUrl(url));
  const reliableGroup = sourceGroups.find((entry) => entry[1].length);
  const anyGroup = sourceGroups.find((entry) => entry[1].length);
  const mainImageSource = reliableGroup ? reliableGroup[0] : (anyGroup ? anyGroup[0] : '');
  const reliableCandidates = reliableGroup
    ? dedupeCandidates(reliableGroup[1], 'https://mobile.yangkeduo.com/', (url) => isLikelyProductImageUrl(url))
    : [];
  const expectedMainImageCount = reliableCandidates.length
    ? Math.min(maxMainImages, reliableCandidates.length)
    : 0;
  const mainKeys = new Set(main.map((item) => mediaKey(item.url)));
  const details = dedupeCandidates([...structuredDetail, ...domDetail], 'https://mobile.yangkeduo.com/', (url) => isLikelyProductImageUrl(url))
    .filter((item) => !mainKeys.has(mediaKey(item.url)));
  const videos = dedupeCandidates(structuredVideo, 'https://mobile.yangkeduo.com/', (url) => isVideoUrl(url));
  const queryThumbnailOnly = !main.length && queryPreviewImages.length > 0;
  return {
    main,
    details,
    videos,
    queryPreviewImages,
    queryThumbnailOnly,
    authoritativeMainCandidateCount: main.length,
    authoritativeDetailCandidateCount: details.length,
    mainImageSource,
    detailImageSource: structuredDetail.length ? structuredDetail[0].source : (domDetail.length ? 'detail_dom' : ''),
    expectedMainImageCount,
    pageVariant: reliableGroup
      ? (reliableGroup[0] === 'main_carousel' ? 'dom_gallery' : 'structured_gallery')
      : (queryThumbnailOnly ? 'query_thumbnail_only' : 'unsupported'),
    fallbackUsed: !reliableGroup,
  };
}

function isBlockedNavigationUrl(rawUrl) {
  try {
    const parsed = new URL(String(rawUrl || ''));
    return PDD_BLOCKED_PATH_RE.test(parsed.pathname);
  } catch (error) {
    return false;
  }
}

function isNonProductAssetUrl(rawUrl) {
  try {
    const parsed = new URL(normalizeMediaUrl(rawUrl, 'https://mobile.yangkeduo.com/'));
    const pathname = parsed.pathname.toLowerCase();
    if (/\.(?:html?|php)(?:$|[?#])/i.test(pathname)) return true;
    if (parsed.hostname.toLowerCase() === 'th.yangkeduo.com') return true;
    return NON_PRODUCT_ASSET_RE.test(pathname + parsed.search);
  } catch (error) {
    return true;
  }
}

function isLikelyProductImageUrl(rawUrl) {
  try {
    const parsed = new URL(normalizeMediaUrl(rawUrl, 'https://mobile.yangkeduo.com/'));
    const host = parsed.hostname.toLowerCase();
    if (isNonProductAssetUrl(parsed.toString())) return false;
    if (!/(?:^|\.)(?:pddpic\.com|yangkeduo\.com|pinduoduo\.com)$/i.test(host)) return false;
    const pathname = parsed.pathname.toLowerCase();
    return PRODUCT_IMAGE_PATH_RE.test(pathname)
      || (/\.(?:jpe?g|png|webp)(?:$|\.)/i.test(pathname) && host.endsWith('pddpic.com'));
  } catch (error) {
    return false;
  }
}

function isImageUrl(url) {
  try {
    const parsed = new URL(normalizeMediaUrl(url, 'https://mobile.yangkeduo.com/'));
    const host = parsed.hostname.toLowerCase();
    const pathname = parsed.pathname.toLowerCase();
    const full = (parsed.pathname + parsed.search).toLowerCase();
    if (isNonProductAssetUrl(parsed.toString())) return false;
    if (isApiUrl(parsed.toString())) return false;
    if (isStaticAssetUrl(parsed.toString())) return false;
    if (/\.(?:html?|php)(?:$|\.)/i.test(pathname)) return false;
    if (/\.(?:jpe?g|png|webp)(?:$|\.)/i.test(pathname)) return true;
    if (!/(?:pddpic\.com|yangkeduo\.com|pinduoduo\.com)$/i.test(host)) return false;
    return /(?:image|img|mms|material|goods|gallery|thumb|imageview|imagemogr|x-oss-process)/i.test(full);
  } catch (error) {
    return false;
  }
}

function isVideoUrl(url) {
  return /\.(?:mp4|m3u8)(?:[?#].*)?$/i.test(url);
}

function isStaticAssetUrl(url) {
  try {
    const parsed = new URL(normalizeMediaUrl(url, 'https://mobile.yangkeduo.com/'));
    const pathname = parsed.pathname.toLowerCase();
    return /\.(?:js|css|ttf|otf|woff2?|eot|map|ico|svg|json)(?:$|[?#])/i.test(pathname);
  } catch (error) {
    return true;
  }
}

function isApiUrl(url) {
  try {
    const parsed = new URL(normalizeMediaUrl(url, 'https://mobile.yangkeduo.com/'));
    return /\/(?:api|proxy)\//i.test(parsed.pathname);
  } catch (error) {
    return false;
  }
}

function detectPddBlockedStateFromSignals(signals = {}) {
  const finalUrl = String(signals.finalUrl || signals.url || '');
  const title = String(signals.title || '');
  const text = String(signals.text || signals.sampleText || '');
  const navigationUrls = Array.isArray(signals.navigationUrls) ? signals.navigationUrls : [];
  const blockedNavigationUrl = [finalUrl, ...navigationUrls].find(isBlockedNavigationUrl) || '';
  if (blockedNavigationUrl) {
    return {
      blocked: true,
      reason: 'login_redirect',
      finalUrl,
      title,
      sampleText: text.slice(0, 500),
      blockedNavigationUrl,
    };
  }
  if (PDD_BLOCKED_TEXT_RE.test(`${title}\n${text}`)) {
    return {
      blocked: true,
      reason: /验证码|安全验证|滑块|拖动|风险|人机|异常|验证身份|captcha/i.test(`${title}\n${text}`)
        ? 'security_verification'
        : 'login_required',
      finalUrl,
      title,
      sampleText: text.slice(0, 500),
      blockedNavigationUrl: '',
    };
  }
  return {
    blocked: false,
    reason: '',
    finalUrl,
    title,
    sampleText: text.slice(0, 500),
    blockedNavigationUrl: '',
  };
}

function detectPddProductUnavailableFromSignals(signals = {}) {
  const finalUrl = String(signals.finalUrl || signals.url || '');
  const title = String(signals.title || '');
  const text = String(signals.text || signals.sampleText || '');
  const match = `${title}\n${text}`.match(PDD_PRODUCT_UNAVAILABLE_TEXT_RE);
  return {
    unavailable: Boolean(match),
    reason: match ? match[0] : '',
    finalUrl,
    title,
  };
}

function detectPddPlatformBusyFromSignals(signals = {}) {
  const finalUrl = String(signals.finalUrl || signals.url || '');
  const title = String(signals.title || '');
  const text = String(signals.text || signals.sampleText || '');
  const match = `${title}\n${text}`.match(PDD_PLATFORM_BUSY_TEXT_RE);
  return {
    busy: Boolean(match),
    reason: match ? match[0] : '',
    finalUrl,
    title,
  };
}

function evaluateInitialPddPageGate({ initialState, structuredCandidates = [] }) {
  const unavailableState = detectPddProductUnavailableFromSignals(initialState || {});
  const busyState = detectPddPlatformBusyFromSignals(initialState || {});
  const authoritativeMainCount = structuredCandidates
    .filter((item) => item?.role === 'main' && isAuthoritativeCandidate(item)).length;
  const suppressScroll = (unavailableState.unavailable || busyState.busy) && authoritativeMainCount === 0;
  return {
    suppressScroll,
    unavailableState,
    busyState,
    authoritativeMainCount,
    reason: suppressScroll
      ? (unavailableState.unavailable ? 'initial_unavailable_shell' : 'initial_platform_busy')
      : '',
  };
}

function buildPddSearchHealthUrl(productUrl) {
  try {
    const parsed = new URL(String(productUrl || ''));
    const searchTerm = parsed.searchParams.get('_x_query') || parsed.searchParams.get('_oak_search_term') || '';
    if (!searchTerm.trim()) return '';
    const searchUrl = new URL('/search_result.html', parsed.origin);
    searchUrl.searchParams.set('search_key', searchTerm.trim());
    return searchUrl.toString();
  } catch (error) {
    return '';
  }
}

function shouldRetryUnavailableProduct({ extracted, goodsId, productUrl }) {
  if (!extracted || extracted.needLoginOrCaptcha) return false;
  if (Array.isArray(extracted.main) && extracted.main.length > 0) return false;
  const unavailable = extracted.productUnavailable
    || detectPddProductUnavailableFromSignals(extracted.loginState || {}).unavailable;
  if (!unavailable) return false;
  const finalUrl = String(extracted.loginState?.finalUrl || extracted.diagnostics?.finalPageUrl || productUrl || '');
  return Boolean(goodsId) && extractGoodsId(finalUrl) === String(goodsId);
}

function shouldRetryQueryThumbnailOnly({ extracted }) {
  if (!extracted || extracted.needLoginOrCaptcha) return false;
  return Boolean(extracted.queryThumbnailOnly)
    && Number(extracted.authoritativeMainCandidateCount || 0) === 0
    && Array.isArray(extracted.queryPreviewImages)
    && extracted.queryPreviewImages.length > 0;
}

async function probePddSearchHealth(page, productUrl, requestTimeoutMs = 30000) {
  const searchUrl = buildPddSearchHealthUrl(productUrl);
  if (!searchUrl) return { checked: false, busy: false, reason: '', searchUrl: '' };
  await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: requestTimeoutMs });
  await page.waitForTimeout(3500);
  const state = await readPddPageState(page, [searchUrl]);
  const busy = detectPddPlatformBusyFromSignals(state);
  return {
    checked: true,
    busy: busy.busy,
    reason: busy.reason,
    searchUrl,
    finalUrl: state.finalUrl,
  };
}

async function readPddPageState(page, navigationUrls = []) {
  const state = await evaluateWithNavigationRetry(page, () => ({
    finalUrl: location.href || '',
    title: document.title || '',
    text: document.body ? (document.body.innerText || '').slice(0, 5000) : '',
  }), undefined, {
    maxAttempts: 3,
    loadTimeoutMs: 10000,
    stableMs: 400,
  });
  return detectPddBlockedStateFromSignals({ ...state, navigationUrls });
}

async function waitForPddPageToSettle(page, navigationUrls = [], options = {}) {
  const maxWaitMs = Number.isFinite(options.maxWaitMs) ? options.maxWaitMs : 8000;
  const minObserveMs = Number.isFinite(options.minObserveMs) ? options.minObserveMs : 2500;
  const sampleMs = Number.isFinite(options.sampleMs) ? options.sampleMs : 500;
  const startedAt = Date.now();
  let previousUrl = '';
  let stableSamples = 0;
  let lastState = detectPddBlockedStateFromSignals({ finalUrl: page.url(), navigationUrls });

  while (Date.now() - startedAt < maxWaitMs) {
    await page.waitForTimeout(sampleMs);
    lastState = await readPddPageState(page, navigationUrls);
    if (lastState.blocked) return lastState;
    if (lastState.finalUrl === previousUrl) stableSamples += 1;
    else stableSamples = 0;
    previousUrl = lastState.finalUrl;
    if (Date.now() - startedAt >= minObserveMs && stableSamples >= 2) return lastState;
  }
  return lastState;
}

async function validateProductImageBuffer(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < MIN_PRODUCT_IMAGE_BYTES) {
    throw new Error('Image file is too small to be product media.');
  }
  let metadata;
  try {
    metadata = await sharp(buffer, { failOn: 'none' }).metadata();
  } catch (error) {
    throw new Error('Image bytes could not be decoded.');
  }
  const width = Number(metadata.width || 0);
  const height = Number(metadata.height || 0);
  if (width < MIN_PRODUCT_IMAGE_WIDTH || height < MIN_PRODUCT_IMAGE_HEIGHT) {
    throw new Error(`Image dimensions ${width}x${height} are below ${MIN_PRODUCT_IMAGE_WIDTH}x${MIN_PRODUCT_IMAGE_HEIGHT}.`);
  }
  return { width, height, format: metadata.format || '' };
}

function inferExt(url, contentType, kind) {
  const type = String(contentType || '').split(';')[0].trim().toLowerCase();
  if (kind === 'image' && IMAGE_EXT_BY_TYPE[type]) return IMAGE_EXT_BY_TYPE[type];
  if (kind === 'video' && VIDEO_EXT_BY_TYPE[type]) return VIDEO_EXT_BY_TYPE[type];
  try {
    const pathname = new URL(url).pathname;
    const ext = path.extname(pathname).toLowerCase();
    if (kind === 'image' && ['.jpg', '.jpeg', '.png', '.webp', '.gif'].includes(ext)) {
      return ext === '.jpeg' ? '.jpg' : ext;
    }
    if (kind === 'video' && ['.mp4', '.m3u8'].includes(ext)) return ext;
  } catch (error) {}
  return kind === 'video' ? '.mp4' : '.jpg';
}

async function downloadFile({ url, fileBase, dir, kind, referer, timeoutMs, ffmpegPath }) {
  const isM3u8 = kind === 'video' && /\.m3u8(?:[?#].*)?$/i.test(url);
  if (isM3u8) {
    const ffmpeg = normalizePathInput(ffmpegPath || '');
    if (ffmpeg) {
      const target = path.join(dir, fileBase + '.mp4');
      const headers = 'User-Agent: ' + MOBILE_UA + '\r\nReferer: ' + referer + '\r\n';
      const run = spawnSync(ffmpeg, ['-y', '-headers', headers, '-i', url, '-c', 'copy', target], {
        encoding: 'utf8',
        timeout: Math.max(timeoutMs * 4, 120000),
        windowsHide: true,
      });
      if (run.status === 0 && fs.existsSync(target) && fs.statSync(target).size > 0) {
        const saved = fs.readFileSync(target);
        return {
          url,
          localPath: target,
          convertedFromM3u8: true,
          sizeBytes: saved.length,
          contentHash: crypto.createHash('sha256').update(saved).digest('hex'),
        };
      }
      throw new Error('ffmpeg failed for m3u8: ' + (run.stderr || run.stdout || 'unknown error').slice(0, 500));
    }
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response;
  try {
    response = await fetch(url, {
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        'User-Agent': MOBILE_UA,
        Referer: referer,
        Accept: kind === 'video' ? '*/*' : 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
      },
    });
  } finally {
    clearTimeout(timer);
  }
  if (!response || !response.ok) {
    throw new Error('HTTP ' + (response ? response.status : 'NO_RESPONSE'));
  }
  const contentType = response.headers.get('content-type') || '';
  if (kind === 'image' && !/^image\//i.test(contentType)) {
    throw new Error('Unexpected image content-type: ' + (contentType || 'unknown'));
  }
  if (kind === 'video' && !isM3u8 && contentType && !/^(video\/|application\/octet-stream)/i.test(contentType)) {
    throw new Error('Unexpected video content-type: ' + contentType);
  }
  const ext = inferExt(url, contentType, kind);
  const target = path.join(dir, fileBase + ext);
  const buffer = Buffer.from(await response.arrayBuffer());
  if (!buffer.length) throw new Error('Downloaded empty file.');
  let imageMetadata;
  if (kind === 'image') imageMetadata = await validateProductImageBuffer(buffer);
  fs.writeFileSync(target, buffer);
  return {
    url,
    localPath: target,
    savedM3u8WithoutFfmpeg: isM3u8,
    sizeBytes: buffer.length,
    contentHash: crypto.createHash('sha256').update(buffer).digest('hex'),
    ...(imageMetadata || {}),
  };
}

async function mapLimit(items, limit, handler) {
  const results = [];
  let index = 0;
  const workers = Array.from({ length: Math.max(1, limit) }, async () => {
    while (index < items.length) {
      const currentIndex = index++;
      results[currentIndex] = await handler(items[currentIndex], currentIndex);
    }
  });
  await Promise.all(workers);
  return results;
}

function compactMediaFiles(records, prefix) {
  return records.filter(Boolean).map((record, index) => {
    if (!record.localPath) return record;
    const extension = path.extname(record.localPath).toLowerCase();
    const target = path.join(path.dirname(record.localPath), `${prefix}_${String(index + 1).padStart(2, '0')}${extension}`);
    if (path.resolve(record.localPath) !== path.resolve(target)) fs.renameSync(record.localPath, target);
    return { ...record, localPath: target };
  });
}

async function downloadValidatedCandidates({ candidates, max, concurrency, prefix, dir, referer, timeoutMs }) {
  const accepted = [];
  const rejected = [];
  const candidateOutcomes = [];
  const seenHashes = new Set();
  const limit = Math.max(0, Number(max || 0));
  const batchSize = Math.max(1, Number(concurrency || 1));
  let attemptedCount = 0;
  let skippedDownloadedCount = 0;

  for (let offset = 0; offset < candidates.length && accepted.length < limit; offset += batchSize) {
    const batch = candidates.slice(offset, offset + batchSize);
    const downloaded = await mapLimit(batch, batchSize, async (candidate, batchIndex) => {
      const candidateIndex = offset + batchIndex;
      try {
        const record = await downloadFile({
          url: candidate.url,
          fileBase: `${prefix}_candidate_${String(candidateIndex + 1).padStart(4, '0')}`,
          dir,
          kind: 'image',
          referer,
          timeoutMs,
        });
        return { candidate, candidateIndex, record };
      } catch (error) {
        return { candidate, candidateIndex, error: error.message || String(error) };
      }
    });
    attemptedCount += downloaded.length;

    for (const item of downloaded) {
      if (item.error) {
        rejected.push({ ...item.candidate, reason: item.error });
        const validationFailure = /(?:image file is too small|image bytes could not be decoded|image dimensions|unexpected image content-type|downloaded empty file)/i.test(item.error);
        candidateOutcomes.push({
          candidateIndex: item.candidateIndex,
          url: item.candidate.url,
          source: item.candidate.source,
          sourcePath: item.candidate.sourcePath,
          outcome: validationFailure ? 'validation_failed' : 'download_failed',
          reason: item.error,
        });
        continue;
      }
      if (accepted.length >= limit) {
        skippedDownloadedCount += 1;
        candidateOutcomes.push({
          candidateIndex: item.candidateIndex,
          url: item.candidate.url,
          source: item.candidate.source,
          sourcePath: item.candidate.sourcePath,
          outcome: 'skipped_by_limit',
          reason: `max_${prefix}_images_reached`,
        });
        try { fs.unlinkSync(item.record.localPath); } catch (error) {}
        continue;
      }
      if (item.record.contentHash && seenHashes.has(item.record.contentHash)) {
        rejected.push({ ...item.candidate, reason: 'duplicate_content' });
        candidateOutcomes.push({
          candidateIndex: item.candidateIndex,
          url: item.candidate.url,
          source: item.candidate.source,
          sourcePath: item.candidate.sourcePath,
          outcome: 'duplicate_content',
          reason: 'duplicate_content',
          contentHash: item.record.contentHash,
        });
        try { fs.unlinkSync(item.record.localPath); } catch (error) {}
        continue;
      }
      if (item.record.contentHash) seenHashes.add(item.record.contentHash);
      candidateOutcomes.push({
        candidateIndex: item.candidateIndex,
        url: item.candidate.url,
        source: item.candidate.source,
        sourcePath: item.candidate.sourcePath,
        outcome: 'accepted',
        reason: '',
        contentHash: item.record.contentHash || '',
      });
      accepted.push({
        ...item.record,
        source: item.candidate.source,
        sourcePath: item.candidate.sourcePath,
        goodsIdMatched: Boolean(item.candidate.goodsIdMatched),
      });
    }
  }

  const unattemptedCount = Math.max(0, candidates.length - attemptedCount);
  for (let candidateIndex = attemptedCount; candidateIndex < candidates.length; candidateIndex += 1) {
    const candidate = candidates[candidateIndex];
    candidateOutcomes.push({
      candidateIndex,
      url: candidate.url,
      source: candidate.source,
      sourcePath: candidate.sourcePath,
      outcome: 'skipped_by_limit',
      reason: `max_${prefix}_images_reached`,
    });
  }
  const skippedByLimitCount = skippedDownloadedCount + unattemptedCount;
  candidateOutcomes.sort((left, right) => left.candidateIndex - right.candidateIndex);
  const duplicateContentCount = candidateOutcomes.filter((item) => item.outcome === 'duplicate_content').length;
  const failedCandidateCount = candidateOutcomes.filter((item) => ['download_failed', 'validation_failed'].includes(item.outcome)).length;
  const effectiveExpectedCount = accepted.length >= limit
    ? limit
    : Math.min(limit, accepted.length + failedCandidateCount);
  const complete = accepted.length > 0
    && (accepted.length >= limit || (unattemptedCount === 0 && failedCandidateCount === 0));
  return {
    records: compactMediaFiles(accepted, prefix),
    rejected,
    candidateOutcomes,
    attemptedCount,
    unattemptedCount,
    skippedByLimitCount,
    limitReached: skippedByLimitCount > 0,
    duplicateContentCount,
    failedCandidateCount,
    effectiveExpectedCount,
    complete,
  };
}

function pickUrlsWithLimit(urls, max, enabled, predicate = () => true) {
  if (!enabled) return [];
  return urls.filter(predicate).slice(0, max);
}

async function extractFromPage(page, productUrl, goodsId, limits, browserMode = 'mobile') {
  const responseImageUrls = new Set();
  const responseTextUrls = new Set();
  const responseVideoUrls = new Set();
  const structuredCandidates = [];
  const structuredAvailabilityEvidence = [];
  const navigationUrls = new Set();
  const pendingResponseReads = new Set();
  const scrollActions = [];
  const interactionRandom = createSeededRandom(`${limits.interactionSeed}:${browserMode}:${goodsId || ''}`);
  let navigationRetryCount = 0;
  const evaluatePage = (pageFunction, arg) => evaluateWithNavigationRetry(page, pageFunction, arg, {
    maxAttempts: 3,
    loadTimeoutMs: 10000,
    stableMs: 300,
    onRetry: () => { navigationRetryCount += 1; },
  });

  const diagnostics = (overrides = {}) => ({
    snapshotCount: 0,
    scriptImageCount: 0,
    scriptVideoCount: 0,
    responseImageCount: responseImageUrls.size,
    responseTextUrlCount: responseTextUrls.size,
    responseVideoCount: responseVideoUrls.size,
    structuredCandidateCount: structuredCandidates.length,
    targetAvailabilityEvidenceCount: structuredAvailabilityEvidence.length,
    navigationRetryCount,
    navigationUrls: Array.from(navigationUrls),
    scrollBehavior: limits.scrollBehavior,
    interactionSeed: limits.interactionSeed,
    scrollActionCount: scrollActions.length,
    scrollActions: scrollActions.slice(0, 24),
    candidateSources: {},
    ...overrides,
  });
  const blockedResult = (state) => ({
    needLoginOrCaptcha: true,
    loginState: state,
    main: [],
    details: [],
    videos: [],
    posters: [],
    diagnostics: diagnostics({ blockedReason: state.reason || 'login_required' }),
  });

  const responseHandler = (response) => {
    const url = response.url();
    const headers = response.headers();
    const contentType = String(headers['content-type'] || '').toLowerCase();
    if (response.request().isNavigationRequest()) navigationUrls.add(url);
    if (contentType.startsWith('image/') && isLikelyProductImageUrl(url)) {
      responseImageUrls.add(url);
    }
    if (isVideoUrl(url)) responseVideoUrls.add(url);
    if (
      response.request().method() === 'GET' &&
      /(?:json|text|javascript|html)/i.test(contentType) &&
      /(?:yangkeduo|pddpic|pinduoduo)/i.test(url) &&
      !isStaticAssetUrl(url)
    ) {
      const read = response.text()
        .then((text) => {
          const urls = [];
          collectUrls(text.slice(0, 3000000), urls);
          for (const found of urls) {
            if (isImageUrl(found) || isVideoUrl(found)) responseTextUrls.add(found);
          }
          const payload = parseStructuredResponseText(text);
          if (payload) {
            const rootBound = responseIsBoundToGoods(url, goodsId);
            structuredCandidates.push(...extractStructuredMediaCandidates(payload, goodsId, {
              source: 'network_response',
              sourcePath: '$response',
              rootBound,
            }));
            structuredAvailabilityEvidence.push(...extractTargetAvailabilityEvidence(payload, goodsId, {
              source: 'network_response',
              sourcePath: '$response',
              rootBound,
            }));
          }
        })
        .catch(() => {});
      pendingResponseReads.add(read);
      read.finally(() => pendingResponseReads.delete(read));
    }
  };

  page.on('response', responseHandler);
  try {
    await page.goto(productUrl, { waitUntil: 'domcontentloaded', timeout: limits.requestTimeoutMs });
    const initialState = await waitForPddPageToSettle(page, Array.from(navigationUrls));
    if (initialState.blocked) return blockedResult(initialState);

    const mainFromUrl = [
      ...parseUrlParamList(productUrl, 'thumb_url'),
      ...parseUrlParamList(productUrl, '_oak_gallery'),
    ].filter(isLikelyProductImageUrl);

    const snapshots = [];
    async function takeSnapshot(label) {
      const snap = await evaluatePage(({ label, goodsId }) => {
        const badKeywords = /推荐|猜你喜欢|相似商品|店铺|评价|评论|客服|头像|广告|直播|榜单|精选|更多商品/;
        const detailKeywords = /商品详情|图文详情|宝贝详情|产品详情|规格参数/;
        const recommendationKeywords = /猜你喜欢|推荐商品|相似商品|看了又看|店铺推荐/;
        const viewportH = window.innerHeight || 844;
        const scrollY = window.scrollY || 0;
        const scriptsText = Array.from(document.scripts).map((s) => s.textContent || '').join('\n');
        const htmlText = document.documentElement ? document.documentElement.innerHTML.slice(0, 1200000) : '';
        const urlRegex = /https?:\\?\/\\?\/[^"'\s<>\\]+/gi;
        const urlHits = [];
        for (const source of [scriptsText, htmlText]) {
          for (const match of source.matchAll(urlRegex)) urlHits.push(match[0]);
        }
        const images = Array.from(document.images).map((img) => {
          const rect = img.getBoundingClientRect();
          const ancestorText = [];
          let el = img;
          let carouselLike = false;
          for (let i = 0; i < 5 && el; i += 1) {
            const text = (el.innerText || el.getAttribute?.('aria-label') || '').trim();
            if (text) ancestorText.push(text.slice(0, 80));
            const classText = `${el.className || ''} ${el.id || ''} ${el.getAttribute?.('role') || ''}`;
            const style = window.getComputedStyle(el);
            if (/swiper|carousel|slider|banner|gallery/i.test(classText)
              || ((style.display === 'flex' || /auto|scroll/.test(style.overflowX || '')) && el.scrollWidth > el.clientWidth * 1.2)) {
              carouselLike = true;
            }
            el = el.parentElement;
          }
          const srcs = [
            img.currentSrc,
            img.src,
            img.getAttribute('data-src'),
            img.getAttribute('data-original'),
            img.getAttribute('data-lazy-src'),
            img.getAttribute('srcset'),
          ].filter(Boolean);
          const contextText = ancestorText.join(' ');
          const width = Math.round(rect.width || img.naturalWidth || 0);
          const height = Math.round(rect.height || img.naturalHeight || 0);
          const top = Math.round(rect.top + scrollY);
          const isSmall = Math.max(width, img.naturalWidth || 0) < 300 || Math.max(height, img.naturalHeight || 0) < 180;
          const badContext = badKeywords.test(contextText);
          return {
            srcs,
            width,
            height,
            naturalWidth: img.naturalWidth || 0,
            naturalHeight: img.naturalHeight || 0,
            top,
            contextText,
            carouselLike,
            mainLike: !badContext && !isSmall && top < 1200 && width >= 240 && height >= 180,
            detailLike: !badContext && !isSmall && top > 450 && width >= 280 && height >= 180,
          };
        });
        const videos = Array.from(document.querySelectorAll('video, video source, source')).map((el) => ({
          src: el.currentSrc || el.src || el.getAttribute('src') || '',
          poster: el.poster || el.getAttribute('poster') || '',
        }));
        const bodyText = document.body ? document.body.innerText || '' : '';
        const visibleTextElements = Array.from(document.querySelectorAll('h1,h2,h3,h4,section,div,span'));
        const visibleMarker = (pattern) => visibleTextElements.some((element) => {
          const text = (element.innerText || '').trim();
          if (!text || text.length > 40 || !pattern.test(text)) return false;
          const rect = element.getBoundingClientRect();
          return rect.bottom > 0 && rect.top < viewportH && rect.width > 0 && rect.height > 0;
        });
        const structuredJson = [];
        if (label === 'initial') {
          for (const name of ['rawData', '__INITIAL_STATE__', '__NEXT_DATA__', '__NUXT__', '__PRELOADED_STATE__']) {
            try {
              const value = window[name];
              if (!value || typeof value !== 'object') continue;
              const json = JSON.stringify(value);
              if (json && json.length <= 3000000) structuredJson.push({ name, json });
            } catch (error) {}
          }
        }
        const documentHeight = Math.max(document.documentElement?.scrollHeight || 0, document.body?.scrollHeight || 0);
        return {
          label,
          goodsId,
          scrollY,
          viewportH,
          documentHeight,
          images,
          videos,
          urlHits,
          structuredJson,
          recommendationVisible: visibleMarker(recommendationKeywords),
          detailMarkerVisible: visibleMarker(detailKeywords),
          hasDetailMarker: detailKeywords.test(bodyText),
          atBottom: scrollY + viewportH >= documentHeight - 12,
        };
      }, { label, goodsId });
      snapshots.push(snap);
      return snap;
    }

    const initialSnapshot = await takeSnapshot('initial');
    for (const entry of initialSnapshot.structuredJson || []) {
      const payload = parseStructuredResponseText(entry.json);
      if (!payload) continue;
      structuredCandidates.push(...extractStructuredMediaCandidates(payload, goodsId, {
        source: 'structured_data',
        sourcePath: `$window.${entry.name}`,
        rootBound: false,
      }));
      structuredAvailabilityEvidence.push(...extractTargetAvailabilityEvidence(payload, goodsId, {
        source: 'structured_data',
        sourcePath: `$window.${entry.name}`,
        rootBound: false,
      }));
    }
    await Promise.allSettled(Array.from(pendingResponseReads));
    const initialGate = evaluateInitialPddPageGate({ initialState, structuredCandidates });
    const initialUnavailableState = initialGate.unavailableState;
    const initialBusyState = initialGate.busyState;
    if (initialGate.suppressScroll) {
      const unavailableShell = initialUnavailableState.unavailable;
      const pageVariant = unavailableShell ? 'initial_unavailable_shell' : 'platform_busy';
      const scrollSuppressedReason = initialGate.reason;
      return {
        needLoginOrCaptcha: false,
        loginState: initialState,
        main: [],
        details: [],
        videos: [],
        posters: [],
        pageVariant,
        mainImageSource: '',
        detailImageSource: '',
        expectedMainImageCount: 0,
        fallbackUsed: false,
        queryThumbnailOnly: false,
        authoritativeMainCandidateCount: 0,
        authoritativeDetailCandidateCount: 0,
        queryPreviewImages: [],
        productUnavailable: unavailableShell,
        productUnavailableReason: initialUnavailableState.reason,
        initialUnavailableShellDetected: unavailableShell,
        platformBusy: initialBusyState.busy,
        platformBusyReason: initialBusyState.reason,
        targetAvailabilityEvidence: structuredAvailabilityEvidence,
        scrollSuppressed: true,
        scrollSuppressedReason,
        diagnostics: diagnostics({
          snapshotCount: 1,
          hasDetailMarker: Boolean(initialSnapshot.hasDetailMarker),
          detailStarted: false,
          pageVariant,
          mainImageSource: '',
          detailImageSource: '',
          expectedMainImageCount: 0,
          queryThumbnailOnly: false,
          authoritativeMainCandidateCount: 0,
          authoritativeDetailCandidateCount: 0,
          queryPreviewImageCount: 0,
          productUnavailable: unavailableShell,
          productUnavailableReason: initialUnavailableState.reason,
          initialUnavailableShellDetected: unavailableShell,
          platformBusy: initialBusyState.busy,
          platformBusyReason: initialBusyState.reason,
          targetAvailabilityEvidence: structuredAvailabilityEvidence,
          scrollSuppressed: true,
          scrollSuppressedReason,
          finalPageUrl: initialState.finalUrl,
          pageTitle: initialState.title,
        }),
      };
    }
    let previousDetailCount = 0;
    let noGrowth = 0;
    let detailStarted = Boolean(initialSnapshot.detailMarkerVisible);
    for (let i = 0; i < limits.scrollMaxTimes; i += 1) {
      const stateBeforeScroll = await readPddPageState(page, Array.from(navigationUrls));
      if (stateBeforeScroll.blocked) return blockedResult(stateBeforeScroll);
      const scrollAction = await performScrollInteraction({
        page,
        evaluatePage,
        limits,
        browserMode,
        iteration: i,
        random: interactionRandom,
      });
      scrollActions.push(scrollAction);
      const stateAfterScroll = await readPddPageState(page, Array.from(navigationUrls));
      if (stateAfterScroll.blocked) return blockedResult(stateAfterScroll);
      const snap = await takeSnapshot('scroll_' + String(i + 1).padStart(2, '0'));
      const detailUrlsSeen = new Set(snapshots.flatMap((snapshot) => snapshot.images)
        .filter((image) => image.detailLike)
        .flatMap((image) => image.srcs || []));
      const count = detailUrlsSeen.size;
      detailStarted = detailStarted || snap.detailMarkerVisible || (snap.scrollY > snap.viewportH && count > 0);
      if (detailStarted && count <= previousDetailCount) noGrowth += 1;
      else if (count > previousDetailCount) noGrowth = 0;
      previousDetailCount = count;
      if (shouldStopDetailScroll({
        detailStarted,
        recommendationVisible: snap.recommendationVisible,
        noGrowth,
        atBottom: snap.atBottom,
      })) break;
    }
    await Promise.allSettled(Array.from(pendingResponseReads));

    const finalState = await readPddPageState(page, Array.from(navigationUrls));
    if (finalState.blocked) return blockedResult(finalState);
    const unavailableState = detectPddProductUnavailableFromSignals(finalState);

    const scriptUrls = [];
    const mainDom = [];
    const detailDom = [];
    const videoDom = [];
    const posterUrls = [];
    for (const snap of snapshots) {
      scriptUrls.push(...snap.urlHits);
      for (const image of snap.images) {
        const srcs = image.srcs.flatMap((src) => String(src).split(/\s+/).filter((part) => !/^\d+w$/.test(part)));
        if (image.mainLike) {
          mainDom.push(...srcs.map((url) => createMediaCandidate(url, 'main', 'main_carousel', `$dom.${snap.label}`, mainDom.length, true, 'gallery')));
        }
        if (image.detailLike) {
          detailDom.push(...srcs.map((url) => createMediaCandidate(url, 'detail', 'detail_dom', `$dom.${snap.label}`, detailDom.length, true, 'detail')));
        }
      }
      for (const video of snap.videos) {
        if (video.src) videoDom.push(createMediaCandidate(video.src, 'video', 'network_response', `$dom.${snap.label}.video`, videoDom.length, true, 'video'));
        if (video.poster) posterUrls.push(video.poster);
      }
    }

    scriptUrls.push(...Array.from(responseTextUrls));
    const allScriptUrls = dedupeUrls(scriptUrls, page.url());
    const scriptImages = allScriptUrls.filter(isLikelyProductImageUrl);
    const scriptVideos = allScriptUrls.filter(isVideoUrl);
    const networkImages = dedupeUrls(Array.from(responseImageUrls), page.url()).filter(isLikelyProductImageUrl);
    const filteredMainDom = dedupeCandidates(mainDom, page.url(), isLikelyProductImageUrl);
    const filteredDetailDom = dedupeCandidates(detailDom, page.url(), isLikelyProductImageUrl);
    const urlCandidates = mainFromUrl.map((url, index) => createMediaCandidate(url, 'main', 'url_parameter', '$url', index, true, 'thumb'));
    const selection = selectMediaCandidates({
      structured: dedupeCandidates(structuredCandidates, page.url(), (url) => isLikelyProductImageUrl(url) || isVideoUrl(url)),
      domMain: filteredMainDom,
      domDetail: filteredDetailDom,
      urlMain: urlCandidates,
      maxMainImages: limits.maxMainImages,
    });
    const videos = dedupeCandidates([
      ...selection.videos,
      ...videoDom,
      ...scriptVideos.map((url, index) => createMediaCandidate(url, 'video', 'network_response', '$script.video', index, false, 'video')),
      ...Array.from(responseVideoUrls).map((url, index) => createMediaCandidate(url, 'video', 'network_response', '$response.video', index, false, 'video')),
    ], page.url(), (url) => isVideoUrl(url));

    return {
      needLoginOrCaptcha: false,
      loginState: finalState,
      main: selection.main,
      details: selection.details,
      videos,
      posters: dedupeUrls(posterUrls, page.url()).filter(isLikelyProductImageUrl),
      pageVariant: selection.pageVariant,
      mainImageSource: selection.mainImageSource,
      detailImageSource: selection.detailImageSource,
      expectedMainImageCount: selection.expectedMainImageCount,
      fallbackUsed: selection.fallbackUsed,
      queryThumbnailOnly: selection.queryThumbnailOnly,
      authoritativeMainCandidateCount: selection.authoritativeMainCandidateCount,
      authoritativeDetailCandidateCount: selection.authoritativeDetailCandidateCount,
      queryPreviewImages: selection.queryPreviewImages,
      productUnavailable: unavailableState.unavailable,
      productUnavailableReason: unavailableState.reason,
      initialUnavailableShellDetected: false,
      platformBusy: false,
      platformBusyReason: '',
      targetAvailabilityEvidence: structuredAvailabilityEvidence,
      scrollSuppressed: false,
      scrollSuppressedReason: '',
      diagnostics: diagnostics({
        snapshotCount: snapshots.length,
        scriptImageCount: scriptImages.length,
        scriptVideoCount: scriptVideos.length,
        candidateSources: {
          urlParameters: mainFromUrl.length,
          mainDom: filteredMainDom.length,
          detailDom: filteredDetailDom.length,
          structuredMain: structuredCandidates.filter((item) => item.role === 'main').length,
          structuredDetail: structuredCandidates.filter((item) => item.role === 'detail').length,
          structuredAndResponseText: scriptImages.length,
          networkImages: networkImages.length,
        },
        hasDetailMarker: snapshots.some((snapshot) => snapshot.hasDetailMarker),
        detailStarted,
        pageVariant: selection.pageVariant,
        mainImageSource: selection.mainImageSource,
        detailImageSource: selection.detailImageSource,
        expectedMainImageCount: selection.expectedMainImageCount,
        queryThumbnailOnly: selection.queryThumbnailOnly,
        authoritativeMainCandidateCount: selection.authoritativeMainCandidateCount,
        authoritativeDetailCandidateCount: selection.authoritativeDetailCandidateCount,
        queryPreviewImageCount: selection.queryPreviewImages.length,
        productUnavailable: unavailableState.unavailable,
        productUnavailableReason: unavailableState.reason,
        initialUnavailableShellDetected: false,
        platformBusy: false,
        platformBusyReason: '',
        targetAvailabilityEvidence: structuredAvailabilityEvidence,
        scrollSuppressed: false,
        scrollSuppressedReason: '',
        ignoredUnboundScriptImageCount: scriptImages.length,
        ignoredUnboundNetworkImageCount: networkImages.length,
        finalPageUrl: finalState.finalUrl,
        pageTitle: finalState.title,
      }),
    };
  } finally {
    page.off('response', responseHandler);
  }
}

async function waitForPddHumanVerification(page, productUrl, timeoutMs = 300000) {
  await page.goto(productUrl, { waitUntil: 'domcontentloaded', timeout: Math.min(180000, timeoutMs) });
  const startedAt = Date.now();
  let navigationRetryCount = 0;
  let consecutiveUnblockedChecks = 0;
  while (Date.now() - startedAt < timeoutMs) {
    let state;
    try {
      state = await readPddPageState(page);
    } catch (error) {
      navigationRetryCount += 1;
      state = { blocked: true, reason: 'navigation_unstable' };
    }
    if (state.blocked) consecutiveUnblockedChecks = 0;
    else consecutiveUnblockedChecks += 1;
    if (consecutiveUnblockedChecks >= 2) {
      return { resolved: true, waitedMs: Date.now() - startedAt, navigationRetryCount, finalState: state };
    }
    await page.waitForTimeout(2000);
  }
  return { resolved: false, waitedMs: Date.now() - startedAt, navigationRetryCount };
}

async function captureBlockedPageScreenshot(page, metadataDir) {
  const screenshotPath = path.join(metadataDir, 'pdd-blocked-page.png');
  await page.screenshot({ path: screenshotPath, fullPage: true, animations: 'disabled' });
  return normalizePathInput(screenshotPath);
}

async function captureUnavailablePageScreenshot(page, metadataDir, browserMode) {
  const safeMode = String(browserMode || 'unknown').replace(/[^a-z0-9_-]+/gi, '-');
  const screenshotPath = path.join(metadataDir, `pdd-product-unavailable-${safeMode}.png`);
  await page.screenshot({ path: screenshotPath, fullPage: false, animations: 'disabled' });
  return normalizePathInput(screenshotPath);
}

async function main() {
  const decoded = decodeParams();
  if (decoded.error) {
    printResult(makeEmptyResult({ errors: [decoded.error] }));
    return;
  }

  const raw = decoded.params || {};
  const result = makeEmptyResult({
    productName: String(raw.productName || ''),
    SKU: String(raw.SKU || '').trim(),
    productUrl: String(raw.productUrl || ''),
    goodsId: String(raw.goodsId || extractGoodsId(raw.productUrl || '')),
    n8nExecutionId: String(raw.n8nExecutionId || '').trim(),
  });

  const errors = [];
  if (!result.productUrl.trim()) errors.push('productUrl is empty.');
  if (!result.productName.trim()) errors.push('productName is empty.');
  if (!/^\d{7}$/.test(result.SKU)) errors.push('SKU must be exactly 7 digits.');
  if (result.productUrl && !result.goodsId) errors.push('productUrl does not contain goods_id.');

  const safeProductName = sanitizeFileName(result.productName, 'product');
  const parentOutputDir = normalizePathInput(raw.parentOutputDir || '');
  if (!parentOutputDir) errors.push('parentOutputDir is empty.');
  if (parentOutputDir && !path.isAbsolute(parentOutputDir)) errors.push('parentOutputDir must be an absolute path.');

  if (errors.length) {
    result.errors = errors;
    printResult(result);
    return;
  }

  let context;
  let heartbeatGuard;
  try {
    heartbeatGuard = startHeartbeat(raw.idempotency, 'downloader', {
      onOwnerLost: async () => {
        if (context) {
          const lostContext = context;
          context = undefined;
          try { await lostContext.close(); } catch {}
        }
      },
    });
  } catch (error) {
    result.status = 'idempotency_owner_lost';
    result.httpStatus = 409;
    result.errors = ['Cannot start idempotency heartbeat: ' + (error.message || String(error))];
    printResult(result);
    return;
  }

  let playwright;
  try {
    playwright = require('playwright');
  } catch (error) {
    result.errors.push('Playwright is not installed or cannot be resolved. Install it in the n8n runtime environment before running this workflow.');
    heartbeatGuard.stop();
    printResult(result);
    return;
  }

  const limits = normalizeLimits(raw);
  result.scrollBehavior = limits.scrollBehavior;
  result.interactionSeed = limits.interactionSeed;
  result.canonicalProductUrl = buildCanonicalPddProductUrl(result.goodsId);
  result.activeProductUrl = result.productUrl;
  result.unavailableCanonicalRetryDelayMs = limits.unavailableCanonicalRetryDelayMs;
  const enabled = {
    main: toBool(raw.downloadMainImages, true),
    detail: toBool(raw.downloadDetailImages, true),
    videos: toBool(raw.downloadVideos, true),
  };
  let downloadConcurrency = toInt(raw.downloadConcurrency, 8, 4, 64);
  if (downloadConcurrency % 4 !== 0) downloadConcurrency = Math.min(64, Math.ceil(downloadConcurrency / 4) * 4);
  const browserUserDataDir = normalizePathInput(raw.browserUserDataDir || 'D:/n8n-browser-profile/pdd');
  const browserExecutablePath = findBrowserExecutable(raw.browserExecutablePath || '');
  const headless = toBool(raw.headless, false);
  const humanVerificationMode = String(raw.humanVerificationMode || (headless ? 'failFast' : 'interactive')).trim().toLowerCase() === 'interactive'
    ? 'interactive'
    : 'failFast';
  const humanVerificationTimeoutMs = toInt(raw.humanVerificationTimeoutMs, 300000, 60000, 1800000);
  const debugOnFailure = toBool(raw.debugOnFailure, true);
  result.profileRefreshCommand = `node "${normalizePathInput(path.join(__dirname, 'pdd-login.cjs'))}" "https://mobile.yangkeduo.com/" "${browserUserDataDir}" "${browserExecutablePath}"`;

  let profileLock;
  try {
    profileLock = acquireOwnedPddProfileLock(browserUserDataDir, heartbeatGuard);
    result.profileStatus = 'in_use';
  } catch (error) {
    heartbeatGuard.stop();
    if (isProfileBusyLaunchError(error) && !result.outputDir) {
      result.status = 'profile_busy';
      result.httpStatus = 409;
      result.browserProfileBusy = true;
      result.browserProfileLocked = true;
      result.profileStatus = 'busy';
      result.errors.push('The dedicated PDD browser profile is already in use.');
    } else if (isProfileBusyLaunchError(error)) {
      result.status = 'browser_session_failed_after_output_reservation';
      result.httpStatus = 500;
      result.profileStatus = 'launch_failed';
      result.errors.push('The PDD browser session became unavailable after output reservation.');
    } else if (error?.code === 'IDEMPOTENCY_OWNER_LOST') {
      result.status = 'idempotency_owner_lost';
      result.httpStatus = 409;
      result.errors.push(error.message || String(error));
    } else {
      result.status = 'internal_error';
      result.httpStatus = 500;
      result.profileStatus = 'launch_failed';
      result.errors.push('Cannot acquire the PDD browser profile lock: ' + (error.message || String(error)));
    }
    printResult(result);
    return;
  }

  let reservation;
  let dirs;
  try {
    ensureDir(browserUserDataDir);
    let page;
    let extracted;
    let activeBrowserMode = 'mobile';
    let activeHeadless = headless;
    let queryThumbnailFallbackTriggered = false;
    const extractionAttempts = [];

    const launchBrowser = async (runHeadless, mode = 'mobile') => {
      const launchOptions = buildPddLaunchOptions({
        headless: runHeadless,
        mode,
        executablePath: browserExecutablePath,
      });
      try {
        heartbeatGuard.assertOwned();
        const launchedContext = await playwright.chromium.launchPersistentContext(browserUserDataDir, launchOptions);
        context = launchedContext;
        heartbeatGuard.assertOwned();
        return launchedContext;
      } catch (error) {
        if (isProfileBusyLaunchError(error)) {
          const busy = new ProfileBusyError('The dedicated PDD browser profile is already in use.');
          busy.cause = error;
          throw busy;
        }
        if (!browserExecutablePath && isMissingPlaywrightBrowserError(error)) {
          throw new Error('Playwright browser executable is missing and no installed Chrome/Edge/Chromium browser was found. Install a browser, set browserExecutablePath, or run: npx playwright install chromium');
        }
        throw error;
      }
    };

    // Prove that the persistent profile can be opened before reserving the
    // product directory. A busy profile therefore has zero product-output
    // side effects and remains safely retryable with the same job UUID.
    context = await launchBrowser(headless, 'mobile');
    page = context.pages()[0] || await context.newPage();
    heartbeatGuard.assertOwned();

    const n8nExecutionId = String(raw.n8nExecutionId || '').trim();
    reservation = n8nExecutionId
      ? reserveExecutionOutputDir({ parentOutputDir, SKU: result.SKU, safeProductName, n8nExecutionId })
      : reserveVersionedOutputDir({ parentOutputDir, SKU: result.SKU, safeProductName });
    const outputDir = normalizePathInput(reservation.outputDir);
    dirs = {
      output: outputDir,
      main: path.join(outputDir, 'main-images'),
      detail: path.join(outputDir, 'detail-images'),
      videos: path.join(outputDir, 'videos'),
      metadata: path.join(outputDir, 'metadata'),
    };
    result.outputDir = dirs.output;
    result.revision = reservation.revision;
    result.metadataPath = normalizePathInput(path.join(dirs.metadata, 'pdd-media-metadata.json'));
    Object.values(dirs).forEach(ensureDir);
    heartbeatGuard.assertOwned();

    const closeContext = async () => {
      if (!context) return;
      await context.close();
      context = undefined;
      page = undefined;
    };

    const syncExtractionResult = (value) => {
      result.navigationRetryCount += Number(value.diagnostics?.navigationRetryCount || 0);
      result.finalPageUrl = String(value.loginState?.finalUrl || value.diagnostics?.finalPageUrl || page?.url() || '');
      result.pageTitle = String(value.loginState?.title || value.diagnostics?.pageTitle || '');
      result.blockReason = String(value.loginState?.reason || value.diagnostics?.blockedReason || '');
      result.pageVariant = String(value.pageVariant || 'unknown');
      result.mainImageSource = String(value.mainImageSource || '');
      result.detailImageSource = String(value.detailImageSource || '');
      result.expectedMainImageCount = Number(value.expectedMainImageCount || 0);
      result.mainGallerySlotCount = Number(value.expectedMainImageCount || 0);
      result.fallbackUsed = Boolean(value.fallbackUsed);
      result.queryThumbnailOnly = Boolean(value.queryThumbnailOnly);
      result.authoritativeMainCandidateCount = Number(value.authoritativeMainCandidateCount || 0);
      result.authoritativeDetailCandidateCount = Number(value.authoritativeDetailCandidateCount || 0);
      result.queryPreviewImages = Array.isArray(value.queryPreviewImages) ? value.queryPreviewImages : [];
      result.scrollBehavior = String(value.diagnostics?.scrollBehavior || limits.scrollBehavior);
      result.interactionSeed = String(value.diagnostics?.interactionSeed || limits.interactionSeed);
      result.scrollActionCount = Number(value.diagnostics?.scrollActionCount || 0);
      result.scrollActions = Array.isArray(value.diagnostics?.scrollActions) ? value.diagnostics.scrollActions : [];
      result.productUnavailableDetected = Boolean(value.productUnavailable);
      result.productUnavailableReason = String(value.productUnavailableReason || '');
      result.initialUnavailableShellDetected = result.initialUnavailableShellDetected || Boolean(value.initialUnavailableShellDetected);
      result.scrollSuppressed = result.scrollSuppressed || Boolean(value.scrollSuppressed);
      if (!result.scrollSuppressedReason && value.scrollSuppressedReason) {
        result.scrollSuppressedReason = String(value.scrollSuppressedReason);
      }
      const availabilityEvidence = [
        ...(Array.isArray(result.targetAvailabilityEvidence) ? result.targetAvailabilityEvidence : []),
        ...(Array.isArray(value.targetAvailabilityEvidence) ? value.targetAvailabilityEvidence : []),
      ];
      const availabilityEvidenceKeys = new Set();
      result.targetAvailabilityEvidence = availabilityEvidence.filter((item) => {
        const key = JSON.stringify([item?.sourcePath, item?.reason, item?.value]);
        if (availabilityEvidenceKeys.has(key)) return false;
        availabilityEvidenceKeys.add(key);
        return true;
      });
      if (value.platformBusy) {
        result.platformBusyDetected = true;
        result.platformBusyReason = String(value.platformBusyReason || '系统繁忙');
      }
      result.selectedBrowserMode = `${activeBrowserMode}_${activeHeadless ? 'headless' : 'headed'}`;
      result.mediaDiagnostics = {
        ...(value.diagnostics || {}),
        browserModeAttempts: extractionAttempts,
        selectedBrowserMode: result.selectedBrowserMode,
        platformBusyDetected: result.platformBusyDetected,
        platformBusyReason: result.platformBusyReason,
        platformBusyRetryCount: result.platformBusyRetryCount,
        platformBusyProbeUrl: result.platformBusyProbeUrl,
      };
    };

    const recordExtractionAttempt = async () => {
      const attempt = {
        mode: result.selectedBrowserMode,
        finalPageUrl: result.finalPageUrl,
        pageTitle: result.pageTitle,
        pageVariant: result.pageVariant,
        mainCandidateCount: Array.isArray(extracted.main) ? extracted.main.length : 0,
        queryThumbnailOnly: Boolean(extracted.queryThumbnailOnly),
        authoritativeMainCandidateCount: Number(extracted.authoritativeMainCandidateCount || 0),
        queryPreviewImageCount: Array.isArray(extracted.queryPreviewImages) ? extracted.queryPreviewImages.length : 0,
        scrollBehavior: result.scrollBehavior,
        scrollActionCount: result.scrollActionCount,
        productUnavailable: Boolean(extracted.productUnavailable),
        productUnavailableReason: String(extracted.productUnavailableReason || ''),
        initialUnavailableShellDetected: Boolean(extracted.initialUnavailableShellDetected),
        platformBusy: Boolean(extracted.platformBusy),
        targetAvailabilityEvidenceCount: Array.isArray(extracted.targetAvailabilityEvidence) ? extracted.targetAvailabilityEvidence.length : 0,
        scrollSuppressed: Boolean(extracted.scrollSuppressed),
        scrollSuppressedReason: String(extracted.scrollSuppressedReason || ''),
        productUrl: result.activeProductUrl,
        navigationKind: result.unavailableCanonicalRetryUsed ? 'canonical' : 'original',
        needLoginOrCaptcha: Boolean(extracted.needLoginOrCaptcha),
        screenshotPath: '',
      };
      if (debugOnFailure && extracted.productUnavailable && page) {
        try {
          attempt.screenshotPath = await captureUnavailablePageScreenshot(
            page,
            dirs.metadata,
            `${attempt.mode}-${attempt.navigationKind}`,
          );
          result.unavailableScreenshotPaths.push(attempt.screenshotPath);
        } catch (error) {
          result.warnings.push('Could not save unavailable-product screenshot: ' + (error.message || String(error)));
        }
      }
      extractionAttempts.push(attempt);
      result.browserModeAttempts = extractionAttempts;
      result.mediaDiagnostics = {
        ...(result.mediaDiagnostics || {}),
        browserModeAttempts: extractionAttempts,
        selectedBrowserMode: result.selectedBrowserMode,
        platformBusyDetected: result.platformBusyDetected,
        platformBusyReason: result.platformBusyReason,
        platformBusyRetryCount: result.platformBusyRetryCount,
        platformBusyProbeUrl: result.platformBusyProbeUrl,
      };
    };

    const runExtraction = async (mode, runHeadless, productUrl = result.productUrl, options = {}) => {
      heartbeatGuard.assertOwned();
      if (!context || activeBrowserMode !== mode || activeHeadless !== runHeadless) {
        await closeContext();
        context = await launchBrowser(runHeadless, mode);
        page = context.pages()[0] || await context.newPage();
      } else if (options.replacePage) {
        if (page) {
          try { await page.close(); } catch {}
        }
        page = await context.newPage();
      }
      activeBrowserMode = mode;
      activeHeadless = runHeadless;
      result.activeProductUrl = String(productUrl || result.productUrl);
      result.productNavigationCount += 1;
      extracted = await extractFromPage(page, result.activeProductUrl, result.goodsId, limits, mode);
      heartbeatGuard.assertOwned();
      syncExtractionResult(extracted);
      await recordExtractionAttempt();
      return extracted;
    };

    await runExtraction('mobile', headless, result.productUrl);
    if (extracted.initialUnavailableShellDetected
      && shouldRetryUnavailableProduct({ extracted, goodsId: result.goodsId, productUrl: result.productUrl })) {
      if (limits.unavailableCanonicalRetryEnabled
        && limits.unavailableCanonicalRetryMaxAttempts > 0
        && result.canonicalProductUrl) {
        result.unavailableCanonicalRetryUsed = true;
        const retryRandom = createSeededRandom(`${limits.interactionSeed}:unavailable-canonical:${result.goodsId}`);
        const retryDelayMs = computeUnavailableRetryDelayMs(limits, retryRandom);
        result.unavailableCanonicalRetryDelayMs = retryDelayMs;
        result.warnings.push(`Initial unavailable shell detected; suppressed scrolling and will retry the canonical product URL once after ${retryDelayMs}ms.`);
        if (page) {
          try { await page.close(); } catch {}
          page = undefined;
        }
        await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
        heartbeatGuard.assertOwned();
        page = await context.newPage();
        await runExtraction('mobile', headless, result.canonicalProductUrl);
        result.unavailableCanonicalRetryRecovered = Array.isArray(extracted.main)
          && extracted.main.length > 0
          && !extracted.productUnavailable
          && !extracted.needLoginOrCaptcha;
      } else {
        result.warnings.push('Initial unavailable shell detected; canonical retry is disabled or unavailable.');
      }
    }
    if (!result.initialUnavailableShellDetected && !result.platformBusyDetected && shouldRetryQueryThumbnailOnly({ extracted })) {
      queryThumbnailFallbackTriggered = true;
      result.retryReason = 'query_thumbnail_only';
      result.warnings.push('Mobile product page exposed only a query thumbnail; retrying the exact product URL in desktop headless mode.');
      await runExtraction('desktop', true, result.productUrl);
    }

    if (extracted.needLoginOrCaptcha) {
      result.needLoginOrCaptcha = true;
      result.needHumanVerification = true;
      result.humanVerificationStatus = 'required';
      if (debugOnFailure) {
        try {
          result.blockedScreenshotPath = await captureBlockedPageScreenshot(page, dirs.metadata);
        } catch (error) {
          result.warnings.push('Could not save blocked-page screenshot: ' + (error.message || String(error)));
        }
      }
      const effectiveHumanVerificationMode = humanVerificationMode;
      if (effectiveHumanVerificationMode !== 'interactive') {
        result.status = 'login_required';
        result.httpStatus = 409;
        result.errors.push('拼多多要求登录或安全验证，请先使用 Manual Trigger 完成人工登录。');
        heartbeatGuard.assertOwned();
        atomicWriteJson(result.metadataPath, { params: raw, extracted, result });
        printResult(result);
        return;
      }
      if (activeHeadless) {
        await runExtraction(activeBrowserMode, false);
        result.warnings.push('Headless browser detected login or security verification; switched to a visible browser for manual handling.');
      }
      const verification = await waitForPddHumanVerification(page, result.productUrl, humanVerificationTimeoutMs);
      result.navigationRetryCount += Number(verification.navigationRetryCount || 0);
      result.humanVerificationResolved = verification.resolved;
      result.humanVerificationStatus = verification.resolved ? 'completed' : 'timeout';
      if (!verification.resolved) {
        result.status = 'human_verification_timeout';
        result.httpStatus = 409;
        result.errors.push('等待登录或验证超过 5 分钟');
        heartbeatGuard.assertOwned();
        atomicWriteJson(result.metadataPath, { params: raw, extracted, verification, result });
        printResult(result);
        return;
      }
      extracted = await extractFromPage(page, result.productUrl, result.goodsId, limits, activeBrowserMode);
      syncExtractionResult(extracted);
      await recordExtractionAttempt();
      if (extracted.needLoginOrCaptcha) {
        result.status = 'human_verification_required';
        result.httpStatus = 409;
        result.errors.push('登录或安全验证完成后页面仍处于受限状态。');
        heartbeatGuard.assertOwned();
        atomicWriteJson(result.metadataPath, { params: raw, extracted, result });
        printResult(result);
        return;
      }
      result.needLoginOrCaptcha = false;
      result.blockReason = '';
    }

    const mainCandidates = enabled.main ? extracted.main : [];
    const detailCandidates = enabled.detail ? extracted.details : [];
    const videoCandidates = enabled.videos ? extracted.videos.slice(0, limits.maxVideos) : [];
    result.mainCandidateCount = mainCandidates.length;
    result.detailCandidateCount = detailCandidates.length;
    const unavailableClassification = classifyUnavailableOutcome({
      initialUnavailableShellDetected: result.initialUnavailableShellDetected,
      currentUnavailable: Boolean(extracted.productUnavailable),
      mainCandidateCount: mainCandidates.length,
      targetAvailabilityEvidence: result.targetAvailabilityEvidence,
      platformBusy: result.platformBusyDetected,
      needLoginOrCaptcha: extracted.needLoginOrCaptcha,
    });
    result.unavailableClassification = unavailableClassification;
    if (unavailableClassification === 'recovered') result.profileSessionStatus = 'healthy';
    if (unavailableClassification === 'session_degraded') result.profileSessionStatus = 'degraded';
    const platformBusyFailure = unavailableClassification === 'platform_busy' && !mainCandidates.length;
    const queryThumbnailOnlyAfterRetry = shouldRetryQueryThumbnailOnly({ extracted });

    if (!mainCandidates.length) {
      result.errors.push(platformBusyFailure
        ? '拼多多当前对自动化浏览器会话返回“系统繁忙/请求频繁”，等待并重试后仍无法获取目标商品主图。'
        : unavailableClassification === 'confirmed_sold_out'
          ? '目标商品结构化数据明确显示商品已售罄或已下架。'
          : unavailableClassification === 'session_degraded'
            ? '当前 PDD Chrome 会话连续返回售罄壳页，但没有目标商品真实下架证据；请人工确认或重新登录专用 profile。'
          : 'No goods-bound main image source was found.');
    }
    if (!detailCandidates.length) result.warnings.push('No goods-bound detail images found.');
    if (!videoCandidates.length) result.warnings.push('No videos found.');

    heartbeatGuard.assertOwned();
    const mainDownload = await downloadValidatedCandidates({
      candidates: mainCandidates,
      max: limits.maxMainImages,
      concurrency: downloadConcurrency,
      prefix: 'main',
      dir: dirs.main,
      referer: result.activeProductUrl,
      timeoutMs: limits.requestTimeoutMs,
    });
    heartbeatGuard.assertOwned();
    const detailDownload = await downloadValidatedCandidates({
      candidates: detailCandidates,
      max: limits.maxDetailImages,
      concurrency: downloadConcurrency,
      prefix: 'detail',
      dir: dirs.detail,
      referer: result.activeProductUrl,
      timeoutMs: limits.requestTimeoutMs,
    });
    heartbeatGuard.assertOwned();
    const videoErrors = [];
    const videos = await mapLimit(videoCandidates, downloadConcurrency, async (candidate, i) => {
      try {
        return await downloadFile({
          url: candidate.url,
          fileBase: 'video_' + String(i + 1).padStart(2, '0'),
          dir: dirs.videos,
          kind: 'video',
          referer: result.activeProductUrl,
          timeoutMs: limits.requestTimeoutMs,
          ffmpegPath: raw.ffmpegPath,
        });
      } catch (error) {
        videoErrors.push({ ...candidate, reason: error.message || String(error) });
        return null;
      }
    });

    heartbeatGuard.assertOwned();
    result.mainImages = mainDownload.records;
    result.detailImages = detailDownload.records;
    result.videos = videos.filter(Boolean);
    result.mainImageCount = result.mainImages.length;
    result.detailImageCount = result.detailImages.length;
    result.videoCount = result.videos.length;
    result.detailImageLimit = limits.maxDetailImages;
    result.detailSkippedByLimitCount = detailDownload.skippedByLimitCount;
    result.detailImageTruncated = detailDownload.limitReached;
    result.detailImageComplete = !enabled.detail || !detailDownload.limitReached;
    result.mainCompletenessVersion = 2;
    result.mainDuplicateContentCount = mainDownload.duplicateContentCount;
    result.mainFailedCandidateCount = mainDownload.failedCandidateCount;
    result.expectedMainImageCount = mainDownload.effectiveExpectedCount;
    result.mainImageComplete = mainDownload.complete;
    result.rejectedMedia = [
      ...mainDownload.rejected.map((item) => ({ ...item, role: 'main' })),
      ...detailDownload.rejected.map((item) => ({ ...item, role: 'detail' })),
      ...videoErrors.map((item) => ({ ...item, role: 'video' })),
    ];
    if (result.rejectedMedia.length) {
      result.warnings.push(`${result.rejectedMedia.length} media candidates were rejected; see rejectedMedia in metadata.`);
    }
    if (result.detailImageTruncated) {
      result.warnings.push(
        `Detail image download reached maxDetailImages=${result.detailImageLimit}; `
        + `${result.detailSkippedByLimitCount} candidates were skipped by the configured limit.`,
      );
    }
    result.mediaDiagnostics = {
      ...(result.mediaDiagnostics || {}),
      mainDownload: {
        attemptedCount: mainDownload.attemptedCount,
        unattemptedCount: mainDownload.unattemptedCount,
        skippedByLimitCount: mainDownload.skippedByLimitCount,
        duplicateContentCount: mainDownload.duplicateContentCount,
        failedCandidateCount: mainDownload.failedCandidateCount,
        effectiveExpectedCount: mainDownload.effectiveExpectedCount,
        complete: mainDownload.complete,
        candidateOutcomes: mainDownload.candidateOutcomes,
      },
    };
    if (result.videos.some((video) => video.savedM3u8WithoutFfmpeg)) {
      result.warnings.push('m3u8 video saved without conversion because ffmpegPath is empty.');
    }
    const detailIncomplete = enabled.detail
      && Boolean(extracted.diagnostics?.hasDetailMarker)
      && result.detailImageCount === 0;
    if (platformBusyFailure) {
      result.success = false;
      result.status = 'platform_busy_or_rate_limited';
      result.httpStatus = 429;
    } else if (unavailableClassification === 'confirmed_sold_out') {
      result.success = false;
      result.status = 'product_unavailable_confirmed';
      result.httpStatus = 410;
    } else if (unavailableClassification === 'session_degraded') {
      result.success = false;
      result.status = 'profile_session_degraded';
      result.httpStatus = 409;
    } else if (queryThumbnailOnlyAfterRetry || (queryThumbnailFallbackTriggered && !mainCandidates.length)) {
      result.success = false;
      result.status = 'unsupported_page_variant';
      result.httpStatus = 422;
      result.queryThumbnailOnly = true;
      if (!result.errors.some((item) => /query thumbnail|URL thumbnail|查询预览图/i.test(item))) {
        result.errors.push('Only query thumbnail preview images were available; the product gallery could not be verified.');
      }
    } else if (!mainCandidates.length || !result.mainImageSource) {
      result.success = false;
      result.status = 'unsupported_page_variant';
      result.httpStatus = 422;
    } else if (!result.expectedMainImageCount) {
      result.success = false;
      result.status = 'unsupported_page_variant';
      result.httpStatus = 422;
      result.errors.push('Only a URL thumbnail fallback was available; the product gallery could not be verified.');
    } else if (!result.mainImageCount) {
      result.success = false;
      result.status = 'download_failed';
      result.httpStatus = 500;
      if (!result.errors.some((item) => item.includes('main images'))) result.errors.push('No main images downloaded.');
    } else if (!result.mainImageComplete) {
      result.success = false;
      result.status = 'main_image_download_incomplete';
      result.httpStatus = 502;
      result.errors.push(`Main image download incomplete: expected ${result.expectedMainImageCount}, downloaded ${result.mainImageCount}.`);
    } else if (detailIncomplete) {
      result.success = false;
      result.status = 'detail_image_download_incomplete';
      result.httpStatus = 502;
      result.errors.push('The page exposed a product-detail marker but no valid detail image was downloaded.');
    } else {
      result.success = result.errors.length === 0;
      result.status = result.success ? 'success' : 'download_failed';
      result.httpStatus = result.success ? 200 : 500;
    }

    heartbeatGuard.assertOwned();
    atomicWriteJson(result.metadataPath, {
      params: raw,
      extracted,
      selected: { mainCandidates, detailCandidates, videoCandidates },
      result,
    });
    printResult(result);
  } catch (error) {
    result.success = false;
    if (isProfileBusyLaunchError(error) && !result.outputDir) {
      result.status = 'profile_busy';
      result.httpStatus = 409;
      result.browserProfileBusy = true;
      result.browserProfileLocked = true;
      result.profileStatus = 'busy';
    } else if (isProfileBusyLaunchError(error)) {
      result.status = 'browser_session_failed_after_output_reservation';
      result.httpStatus = 500;
      result.profileStatus = 'launch_failed';
    } else if (error?.code === 'IDEMPOTENCY_OWNER_LOST') {
      result.status = 'idempotency_owner_lost';
      result.httpStatus = 409;
    } else if (error && error.code === 'navigation_not_settled') {
      result.status = 'navigation_not_settled';
      result.navigationRetryCount += Number(error.retryCount || 0);
    }
    result.errors.push(error.message || String(error));
    try {
      if (result.status !== 'idempotency_owner_lost' && result.metadataPath) {
        atomicWriteJson(result.metadataPath, { params: raw, result, fatalError: String(error.stack || error) });
      }
    } catch (writeError) {}
    printResult(result);
  } finally {
    heartbeatGuard.stop();
    if (context) {
      try {
        await context.close();
      } catch (error) {}
    }
    try { profileLock.release(); } catch {}
    if (result.profileStatus === 'in_use') result.profileStatus = 'released';
  }
}

if (require.main === module) {
  main().catch((error) => {
    printResult(makeEmptyResult({ errors: ['Fatal downloader error: ' + (error.message || String(error))] }));
  });
}

module.exports = {
  acquireOwnedPddProfileLock,
  buildCanonicalPddProductUrl,
  buildPddLaunchOptions,
  buildScrollActionPlan,
  compactMediaFiles,
  computeUnavailableRetryDelayMs,
  createMediaCandidate,
  createSeededRandom,
  dedupeCandidates,
  detectPddBlockedStateFromSignals,
  detectPddPlatformBusyFromSignals,
  detectPddProductUnavailableFromSignals,
  classifyUnavailableOutcome,
  downloadValidatedCandidates,
  buildPddSearchHealthUrl,
  extractGoodsId,
  extractTargetAvailabilityEvidence,
  evaluateInitialPddPageGate,
  extractStructuredMediaCandidates,
  isBlockedNavigationUrl,
  isImageUrl,
  isLikelyProductImageUrl,
  isNonProductAssetUrl,
  mediaKey,
  normalizeLimits,
  normalizeMediaUrl,
  normalizeScrollBehavior,
  parseUrlParamList,
  parseStructuredResponseText,
  responseIsBoundToGoods,
  selectMediaCandidates,
  shouldRetryQueryThumbnailOnly,
  shouldRetryUnavailableProduct,
  shouldStopDetailScroll,
  validateProductImageBuffer,
  waitForPddPageToSettle,
};
