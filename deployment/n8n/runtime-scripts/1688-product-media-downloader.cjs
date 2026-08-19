#!/usr/bin/env node
'use strict';

const dns = require('dns').promises;
const crypto = require('crypto');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const sharp = require('sharp');
const { atomicWriteJson, decodePayload, startHeartbeat } = require('./download-idempotency-v1.cjs');

const {
  DEFAULT_HUMAN_VERIFICATION_TIMEOUT_MS,
  ProfileBusyError,
  assertNativeAbsolutePath,
  createBrowserSession,
  detect1688AccessState,
  isPortableAbsolutePath,
  normalizePathInput,
  pathFlavor,
  sleep,
  waitForHumanVerification,
} = require('./1688-browser-session.cjs');

const PLATFORM = '1688';
const IMAGE_EXT_BY_TYPE = Object.freeze({
  'image/jpeg': '.jpg',
  'image/jpg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'image/gif': '.gif',
  'image/avif': '.avif',
});
const VIDEO_EXT_BY_TYPE = Object.freeze({
  'video/mp4': '.mp4',
  'application/mp4': '.mp4',
  'application/vnd.apple.mpegurl': '.m3u8',
  'application/x-mpegurl': '.m3u8',
});
const ALLOWED_IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif', '.avif']);
const ALLOWED_VIDEO_EXTENSIONS = new Set(['.mp4', '.m3u8']);
const BAD_MEDIA_CONTEXT = /(?:logo|avatar|icon|sprite|二维码|qrcode|qr-code|店铺|推荐|猜你喜欢|相似|评价|评论|买家秀|客服|广告|直播|榜单|更多商品|recommend|review|comment|advert|seller|store|shop)/i;
const SYNTHETIC_FAKE_IP_MEDIA_SUFFIXES = Object.freeze([
  '1688.com',
  'alicdn.com',
  'tbcdn.cn',
  'alibaba.com',
  'alibabausercontent.com',
  'cloud.video.taobao.com',
  'videodelivery.net',
  'cloudflarestream.com',
]);
const MIN_PRODUCT_IMAGE_WIDTH = 160;
const MIN_PRODUCT_IMAGE_HEIGHT = 160;
const MIN_DETAIL_IMAGE_BYTES = 50 * 1024;

class DownloadError extends Error {
  constructor(message, { code = 'DOWNLOAD_ERROR', status = 0, retryable = false } = {}) {
    super(message);
    this.name = 'DownloadError';
    this.code = code;
    this.status = status;
    this.retryable = retryable;
  }
}

function makeResult(overrides = {}) {
  return {
    success: false,
    status: 'not_started',
    httpStatus: 500,
    platform: PLATFORM,
    SKU: '',
    productName: '',
    productUrl: '',
    offerId: '',
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
    needHumanVerification: false,
    humanVerificationResolved: false,
    humanVerificationStatus: 'not_checked',
    humanVerificationScreenshotPath: '',
    browserProfileBusy: false,
    browserProfileLocked: false,
    profileStatus: 'not_started',
    browserChannel: 'chrome',
    browserRunMode: '',
    browserExecutablePath: '',
    browserUserDataDir: '',
    browserProfileDirectory: '',
    browserControlMode: 'persistentContext',
    sourceBrowserUserDataDir: '',
    sourceBrowserProfileDirectory: '',
    syncDefaultProfileBeforeRun: false,
    closeEdgeBeforeSync: false,
    preserveTargetLogin: false,
    profileMirrorSyncStatus: 'not_configured',
    edgeCloseStatus: 'not_requested',
    minimizeBrowserWindow: false,
    browserWindowMinimized: false,
    detailLongImageSuccess: false,
    detailLongImageSkipped: false,
    detailLongImagePath: '',
    detailLongImageFileName: '详情长图.png',
    detailLongImageWidth: 0,
    detailLongImageHeight: 0,
    detailLongImageSizeBytes: 0,
    detailLongImageInputCount: 0,
    detailLongImageInputImages: [],
    resultFilePath: '',
    errors: [],
    warnings: [],
    ...overrides,
  };
}

function printResult(result) {
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

function writeResultFile(resultFilePath, result) {
  const requestedPath = normalizePathInput(resultFilePath || '');
  if (!requestedPath) return '';
  assertNativeAbsolutePath(requestedPath, 'resultFilePath');
  if (!result.outputDir || !isPathInsideAllowedRoots(requestedPath, [result.outputDir])) {
    throw new Error('resultFilePath must be inside the reserved outputDir.');
  }
  const resolvedPath = path.resolve(requestedPath);
  fs.mkdirSync(path.dirname(resolvedPath), { recursive: true });
  result.resultFilePath = toPortablePath(resolvedPath);
  atomicWriteJson(resolvedPath, result);
  return result.resultFilePath;
}

function decodeParamsArg(argument = process.argv[2] || '') {
  if (!argument) return { params: null, error: 'Missing Base64 parameter payload.' };
  try {
    const params = decodePayload(argument);
    return { params, error: '' };
  } catch (error) {
    return { params: null, error: `Invalid Base64 parameter payload: ${error.message}` };
  }
}

function toInteger(value, fallback, min, max) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}

function normalizeDownloadConcurrency(value, fallback = 4) {
  const bounded = toInteger(value, fallback, 4, 16);
  return Math.min(16, Math.max(4, Math.ceil(bounded / 4) * 4));
}

function sanitizeFileName(value, fallback = 'product') {
  const cleaned = String(value || '')
    .trim()
    .normalize('NFC')
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, '_')
    .replace(/\s+/g, ' ')
    .replace(/[. ]+$/g, '')
    .slice(0, 80);
  return cleaned || fallback;
}

function toPortablePath(value) {
  return normalizePathInput(value).replace(/\\/g, '/');
}

function extractOfferId(productUrl) {
  try {
    const parsed = new URL(productUrl);
    const pathMatch = parsed.pathname.match(/\/offer\/(\d{5,30})(?:\.html)?(?:\/|$)/i);
    if (pathMatch) return pathMatch[1];
    for (const key of ['offerId', 'offer_id', 'id']) {
      const value = parsed.searchParams.get(key);
      if (/^\d{5,30}$/.test(String(value || ''))) return String(value);
    }
    return '';
  } catch (error) {
    return '';
  }
}

function validateProductUrl(value) {
  let parsed;
  try {
    parsed = new URL(String(value || '').trim());
  } catch (error) {
    throw new Error('productUrl must be a valid absolute URL.');
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error('productUrl must use http or https.');
  }
  if (parsed.username || parsed.password) {
    throw new Error('productUrl must not contain embedded credentials.');
  }
  const hostname = parsed.hostname.toLowerCase().replace(/\.$/, '');
  if (hostname !== '1688.com' && !hostname.endsWith('.1688.com')) {
    throw new Error('productUrl hostname must be 1688.com or one of its subdomains.');
  }
  const offerId = extractOfferId(parsed.toString());
  if (!offerId) {
    throw new Error('productUrl must contain a numeric 1688 offerId in /offer/<id>.html or offerId query parameter.');
  }
  parsed.hash = '';
  return { productUrl: parsed.toString(), offerId };
}

function portableResolve(value, flavor) {
  const text = normalizePathInput(value);
  return flavor === 'win32' ? path.win32.resolve(text) : path.posix.resolve(text);
}

function isPathInsideAllowedRoots(target, allowedRoots) {
  const targetFlavor = pathFlavor(target);
  if (!targetFlavor) return false;
  const targetResolved = portableResolve(target, targetFlavor);
  return allowedRoots.some((root) => {
    if (pathFlavor(root) !== targetFlavor) return false;
    const rootResolved = portableResolve(root, targetFlavor);
    const normalTarget = targetFlavor === 'win32' ? targetResolved.toLowerCase() : targetResolved;
    const normalRoot = targetFlavor === 'win32' ? rootResolved.toLowerCase() : rootResolved;
    const separator = targetFlavor === 'win32' ? '\\' : '/';
    return normalTarget === normalRoot || normalTarget.startsWith(normalRoot.replace(/[\\/]+$/, '') + separator);
  });
}

function validateInput(params) {
  const errors = [];
  const SKU = String(params.SKU || '').trim();
  const productName = String(params.productName || '').trim();
  const n8nExecutionId = String(params.n8nExecutionId || '').trim();
  if (!/^\d{7}$/.test(SKU)) errors.push('SKU must be exactly 7 digits.');
  if (!productName) errors.push('productName is required.');
  if (n8nExecutionId && !/^\d+$/.test(n8nExecutionId)) errors.push('n8nExecutionId must contain digits only.');

  let validatedUrl = { productUrl: String(params.productUrl || '').trim(), offerId: '' };
  try {
    validatedUrl = validateProductUrl(params.productUrl);
  } catch (error) {
    errors.push(error.message);
  }

  const parentOutputDir = normalizePathInput(params.parentOutputDir || '');
  if (!parentOutputDir) errors.push('parentOutputDir is required.');
  else if (!isPortableAbsolutePath(parentOutputDir)) errors.push('parentOutputDir must be an absolute path.');

  const allowedOutputRoots = Array.isArray(params.allowedOutputRoots)
    ? params.allowedOutputRoots.map(normalizePathInput).filter(Boolean)
    : [];
  if (!allowedOutputRoots.length) errors.push('allowedOutputRoots must contain at least one absolute path.');
  for (const root of allowedOutputRoots) {
    if (!isPortableAbsolutePath(root)) errors.push(`allowedOutputRoots contains a non-absolute path: ${root}`);
  }
  if (
    parentOutputDir &&
    isPortableAbsolutePath(parentOutputDir) &&
    allowedOutputRoots.length &&
    !isPathInsideAllowedRoots(parentOutputDir, allowedOutputRoots)
  ) {
    errors.push('parentOutputDir must be inside one of allowedOutputRoots.');
  }

  const defaultProfile = process.platform === 'win32'
    ? 'D:/n8n-browser-profile/1688'
    : path.join(os.homedir(), '.n8n-browser-profile', '1688');
  const browserUserDataDir = normalizePathInput(params.browserUserDataDir || defaultProfile);
  try {
    assertNativeAbsolutePath(browserUserDataDir, 'browserUserDataDir');
  } catch (error) {
    errors.push(error.message);
  }

  try {
    if (parentOutputDir) assertNativeAbsolutePath(parentOutputDir, 'parentOutputDir');
    for (const root of allowedOutputRoots) assertNativeAbsolutePath(root, 'allowedOutputRoots item');
  } catch (error) {
    if (!errors.includes(error.message)) errors.push(error.message);
  }

  const warnings = [];
  for (const field of ['userAgent', 'proxy', 'proxies', 'proxyRotation', 'stealth', 'browserArgs']) {
    if (params[field] !== undefined && params[field] !== null && params[field] !== '') {
      warnings.push(`${field} was ignored because E007 does not hide automation features or bypass platform risk controls.`);
    }
  }

  const headless = params.headless === true || String(params.headless || '').trim().toLowerCase() === 'true';
  const requestedVerificationMode = String(params.humanVerificationMode || '').trim();
  const humanVerificationMode = ['failFast', 'interactive'].includes(requestedVerificationMode)
    ? requestedVerificationMode
    : (headless ? 'failFast' : 'interactive');

  return {
    errors,
    warnings,
    value: {
      SKU,
      productName,
      n8nExecutionId,
      safeProductName: sanitizeFileName(productName),
      productUrl: validatedUrl.productUrl,
      offerId: validatedUrl.offerId,
      parentOutputDir,
      allowedOutputRoots,
      browserUserDataDir,
      browserExecutablePath: normalizePathInput(params.browserExecutablePath || ''),
      headless,
      humanVerificationMode,
      idempotency: params.idempotency && typeof params.idempotency === 'object' && !Array.isArray(params.idempotency)
        ? { ...params.idempotency }
        : null,
      resultFilePath: normalizePathInput(params.resultFilePath || ''),
      ffmpegPath: normalizePathInput(params.ffmpegPath || ''),
      maxMainImages: toInteger(params.maxMainImages, 10, 1, 100),
      maxDetailImages: toInteger(params.maxDetailImages, 80, 0, 300),
      maxVideos: toInteger(params.maxVideos, 3, 0, 30),
      downloadConcurrency: normalizeDownloadConcurrency(params.downloadConcurrency, 4),
      pageTimeoutMs: toInteger(params.pageTimeoutMs, 60000, 10000, 180000),
      requestTimeoutMs: toInteger(params.requestTimeoutMs, 30000, 5000, 180000),
      humanVerificationTimeoutMs: toInteger(
        params.humanVerificationTimeoutMs,
        DEFAULT_HUMAN_VERIFICATION_TIMEOUT_MS,
        10000,
        DEFAULT_HUMAN_VERIFICATION_TIMEOUT_MS,
      ),
      scrollMaxTimes: toInteger(params.scrollMaxTimes, 16, 0, 80),
      scrollWaitMs: toInteger(params.scrollWaitMs, 650, 200, 5000),
      maxResponseBodyBytes: toInteger(params.maxResponseBodyBytes, 2 * 1024 * 1024, 64 * 1024, 5 * 1024 * 1024),
      maxMediaBytes: toInteger(params.maxMediaBytes, 256 * 1024 * 1024, 1024 * 1024, 512 * 1024 * 1024),
    },
  };
}

function htmlDecodeUrl(value) {
  return String(value || '')
    .replace(/&amp;/gi, '&')
    .replace(/\\u002f/gi, '/')
    .replace(/\\u003a/gi, ':')
    .replace(/\\\//g, '/')
    .trim();
}

function normalizeMediaUrl(value, baseUrl) {
  let text = htmlDecodeUrl(value);
  if (!text || /^(?:data|blob|javascript):/i.test(text)) return '';
  if (text.startsWith('//')) text = `https:${text}`;
  try {
    const parsed = new URL(text, baseUrl);
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) return '';
    parsed.hash = '';
    return parsed.toString();
  } catch (error) {
    return '';
  }
}

function stripAlibabaImageTransform(pathname) {
  const text = String(pathname || '');
  const imageExtension = /\.(?:jpe?g|png|webp|gif|avif)/ig;
  let match;
  while ((match = imageExtension.exec(text)) !== null) {
    const suffix = text.slice(match.index + match[0].length);
    if (!suffix) return text;
    if (/^(?:_?\.(?:webp|jpe?g|png|gif|avif)|[._](?:b|sum|summ|search|q\d+|\d{2,5}x\d{2,5}(?:q\d+)?))(?:[._-].*)?$/i.test(suffix)) {
      return text.slice(0, match.index + match[0].length);
    }
  }
  return text;
}

function hasAlibabaImageTransform(value) {
  try {
    const parsed = new URL(value);
    return stripAlibabaImageTransform(parsed.pathname) !== parsed.pathname;
  } catch (error) {
    return false;
  }
}

function mediaKey(value) {
  try {
    const parsed = new URL(value);
    for (const key of [
      'imageMogr2', 'thumbnail', 'quality', 'format', 'x-oss-process',
      'width', 'height', 'w', 'h', 'resize', '_t', 'timestamp',
    ]) parsed.searchParams.delete(key);
    if (/(?:^|\.)(?:alicdn\.com|tbcdn\.cn)$/i.test(parsed.hostname)) {
      parsed.pathname = stripAlibabaImageTransform(parsed.pathname);
    }
    const query = parsed.searchParams.toString();
    return `${parsed.origin}${parsed.pathname}${query ? `?${query}` : ''}`;
  } catch (error) {
    return String(value || '').split('#')[0];
  }
}

function isLikelyVideoUrl(value) {
  try {
    const parsed = new URL(value);
    let full = `${parsed.pathname}${parsed.search}`.toLowerCase();
    try { full = decodeURIComponent(full); } catch (error) {}
    if (BAD_MEDIA_CONTEXT.test(full)) return false;
    if (/(?:\{|\}|%7b|%7d|\$\{|<|>)/i.test(full)) return false;
    if (/(?:\.lib-video|\/videox\/|\/player\/|video[-_.]?(?:player|library|sdk))/i.test(full)) return false;
    if (/\.(?:jpe?g|png|webp|gif|avif|svg|ico|css|js|mjs|map|json|woff2?|ttf)(?:$|[?&#)])/i.test(full)) {
      return false;
    }
    return /\.(?:mp4|m3u8)(?:$|[?&#])/i.test(full);
  } catch (error) {
    return false;
  }
}

function isVerifiedVideoContentType(value) {
  const contentType = contentTypeWithoutParameters(value);
  return contentType.startsWith('video/') || Boolean(VIDEO_EXT_BY_TYPE[contentType]);
}

function isLikelyImageUrl(value) {
  try {
    const parsed = new URL(value);
    const full = `${parsed.hostname}${parsed.pathname}${parsed.search}`.toLowerCase();
    if (/\.(?:js|css|svg|ico|woff2?|ttf|map|json)(?:$|[?&#])/i.test(full)) return false;
    if (BAD_MEDIA_CONTEXT.test(full)) return false;
    if (/\.(?:jpe?g|png|webp|gif|avif)(?:$|[?&#])/i.test(full)) return true;
    return /(?:alicdn\.com|tbcdn\.cn|1688\.com|alibabausercontent\.com)/i.test(parsed.hostname) &&
      /(?:ibank|image|img|pic|photo|product|offer)/i.test(full);
  } catch (error) {
    return false;
  }
}

function createCandidateBuckets() {
  return {
    main: new Map(),
    detail: new Map(),
    video: new Map(),
    supplementalImage: new Map(),
    stats: {
      raw: { main: 0, detail: 0, videos: 0, supplementalImages: 0 },
      rejected: { invalid: 0, nonMedia: 0 },
    },
  };
}

function candidatePreferenceScore(candidate) {
  const source = String(candidate?.source || '');
  const sourceScore = source === 'network-media' ? 90
    : source.startsWith('dom-') ? 80
      : source === 'initial-json' || source === 'network-json' ? 65
        : source === 'page-meta' ? 55
          : source.includes('script') ? 35
            : source.includes('text') ? 25 : 40;
  return (candidate?.verifiedByContentType ? 200 : 0)
    + (hasAlibabaImageTransform(candidate?.url) ? 0 : 120)
    + sourceScore;
}

function addCandidate(buckets, kind, rawUrl, baseUrl, source, evidence = {}) {
  const url = normalizeMediaUrl(rawUrl, baseUrl);
  if (!url) {
    if (buckets.stats) buckets.stats.rejected.invalid += 1;
    return;
  }
  let targetKind = kind;
  const verifiedVideo = evidence.verifiedMediaType === 'video'
    && isVerifiedVideoContentType(evidence.contentType);
  if (isLikelyVideoUrl(url) || verifiedVideo) targetKind = 'video';
  else if (!isLikelyImageUrl(url)) {
    if (buckets.stats) buckets.stats.rejected.nonMedia += 1;
    return;
  }
  else if (!['main', 'detail'].includes(targetKind)) targetKind = 'supplementalImage';
  const bucket = buckets[targetKind];
  if (!bucket) return;
  const statKey = targetKind === 'video' ? 'videos'
    : targetKind === 'supplementalImage' ? 'supplementalImages' : targetKind;
  if (buckets.stats) buckets.stats.raw[statKey] += 1;
  const key = mediaKey(url);
  const candidate = {
    url,
    source: String(source || 'page'),
    contentType: contentTypeWithoutParameters(evidence.contentType),
    httpStatus: Number.isFinite(evidence.httpStatus) ? evidence.httpStatus : 0,
    verifiedByContentType: Boolean(verifiedVideo),
  };
  for (const [key, value] of Object.entries({
    width: evidence.width,
    height: evidence.height,
    top: evidence.top,
  })) {
    if (Number.isFinite(Number(value))) candidate[key] = Number(value);
  }
  if (typeof evidence.inDetail === 'boolean') candidate.inDetail = evidence.inDetail;
  if (typeof evidence.inGallery === 'boolean') candidate.inGallery = evidence.inGallery;
  if (evidence.context) candidate.context = String(evidence.context).replace(/\s+/g, ' ').trim().slice(0, 700);
  const existing = bucket.get(key);
  if (!existing || candidatePreferenceScore(candidate) > candidatePreferenceScore(existing)) {
    bucket.set(key, candidate);
  }
}

function inferMediaUrlDimensions(value) {
  const text = String(value || '');
  const match = text.match(/-(\d{1,5})-(\d{1,5})(?:\.(?:jpe?g|png|webp|gif|avif)|[?&#]|$)/i)
    || text.match(/[._](\d{1,5})x(\d{1,5})(?:q\d+)?(?:[._-]|\.(?:jpe?g|png|webp|gif|avif)|[?&#]|$)/i);
  if (!match) return null;
  const width = Number.parseInt(match[1], 10);
  const height = Number.parseInt(match[2], 10);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width < 1 || height < 1) return null;
  return { width, height, area: width * height };
}

function rankCandidates(items) {
  return items
    .map((item, index) => {
      const url = String(item.url || '').toLowerCase();
      return {
        item,
        index,
        dimensions: inferMediaUrlDimensions(item.url),
        productPath: /(?:\/ibank\/|cib)/i.test(url) ? 1 : 0,
        domSource: String(item.source || '').startsWith('dom-') ? 1 : 0,
        originalVariant: hasAlibabaImageTransform(item.url) ? 0 : 1,
      };
    })
    .sort((left, right) => right.productPath - left.productPath
      || right.originalVariant - left.originalVariant
      || right.domSource - left.domSource
      || (right.dimensions?.area || 0) - (left.dimensions?.area || 0)
      || left.index - right.index)
    .map((entry) => entry.item);
}

function isLikelyProductDetailCandidate(item) {
  try {
    const parsed = new URL(item?.url || '');
    const host = parsed.hostname.toLowerCase();
    const pathname = parsed.pathname.toLowerCase();
    return /(?:^|\.)alicdn\.com$/i.test(host)
      && pathname.includes('/img/ibank/')
      && !pathname.includes('overseas_pic')
      && !pathname.includes('/cms/upload/')
      && !BAD_MEDIA_CONTEXT.test(`${pathname}${parsed.search}`);
  } catch (error) {
    return false;
  }
}

function isLowValueDetailVariant(value) {
  try {
    const parsed = new URL(value || '');
    const pathname = parsed.pathname.toLowerCase();
    if (/[._](?:sum|summ|search)(?:[._-]|\.(?:jpe?g|png|webp|gif|avif)|$)/i.test(pathname)) return true;
    const variant = pathname.match(/[._](\d{1,5})x(\d{1,5})(?:q\d+)?(?:[._-]|\.(?:jpe?g|png|webp|gif|avif)|$)/i);
    if (!variant) return false;
    const width = Number.parseInt(variant[1], 10);
    const height = Number.parseInt(variant[2], 10);
    return Number.isFinite(width) && Number.isFinite(height) && Math.max(width, height) < 500;
  } catch (error) {
    return false;
  }
}

function candidateDimensions(item) {
  const width = Number(item?.width);
  const height = Number(item?.height);
  if (Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0) {
    return { width, height, area: width * height };
  }
  return inferMediaUrlDimensions(item?.url);
}

function isLikelyDetailFallbackCandidate(item, productSupplierId = '') {
  if (!isLikelyProductDetailCandidate(item)) return false;
  if (isLowValueDetailVariant(item?.url)) return false;
  if (BAD_MEDIA_CONTEXT.test(String(item?.context || ''))) return false;
  const supplierId = extractAlibabaSupplierId(item?.url);
  if (productSupplierId && supplierId && supplierId !== productSupplierId) return false;
  const dimensions = candidateDimensions(item);
  if (
    dimensions &&
    (dimensions.width < MIN_PRODUCT_IMAGE_WIDTH || dimensions.height < MIN_PRODUCT_IMAGE_HEIGHT)
  ) return false;
  return true;
}

function detailFallbackScore(item, productSupplierId = '') {
  const source = String(item?.source || '');
  const supplierId = extractAlibabaSupplierId(item?.url);
  const supplierScore = productSupplierId && supplierId === productSupplierId ? 400
    : supplierId ? 0 : 120;
  const sourceScore = source.startsWith('dom-') ? 90
    : source === 'initial-json' || source === 'network-json' ? 80
      : source === 'network-media' ? 70
        : source.includes('script') ? 55
          : source.includes('text') ? 15 : 45;
  const dimensions = candidateDimensions(item);
  const areaScore = Math.min(100, Math.floor((dimensions?.area || 0) / 10000));
  return supplierScore
    + (item?.inDetail ? 120 : 0)
    + (item?.inGallery ? -40 : 0)
    + (hasAlibabaImageTransform(item?.url) ? 0 : 80)
    + sourceScore
    + areaScore;
}

function rankDetailFallbackCandidates(items, productSupplierId = '') {
  return items
    .map((item, index) => ({ item, index }))
    .filter(({ item }) => isLikelyDetailFallbackCandidate(item, productSupplierId))
    .sort((left, right) => detailFallbackScore(right.item, productSupplierId)
      - detailFallbackScore(left.item, productSupplierId)
      || left.index - right.index)
    .map((entry) => entry.item);
}

function uniqueCandidatesByMediaKey(items) {
  const output = new Map();
  for (const item of items) {
    const key = mediaKey(item?.url);
    const existing = output.get(key);
    if (!existing || candidatePreferenceScore(item) > candidatePreferenceScore(existing)) {
      output.set(key, item);
    }
  }
  return Array.from(output.values());
}

function urlsFromText(text) {
  const output = [];
  const source = htmlDecodeUrl(String(text || ''));
  const regex = /(?:https?:)?\/\/[^"'\s<>]+/gi;
  for (const match of source.matchAll(regex)) {
    output.push(match[0].replace(/[),;\]}]+$/g, ''));
  }
  return output;
}

function hintFromKey(key, inherited = '') {
  const text = String(key || '').toLowerCase();
  if (/(?:video|movie|mediaurl|playurl|m3u8)/i.test(text)) return 'video';
  if (/(?:detail|description|desc|content|module|wirelessdesc|offerdescription)/i.test(text)) return 'detail';
  if (/(?:gallery|mainimage|main_image|images|image|thumb|pic|photo)/i.test(text)) return inherited === 'detail' ? 'detail' : 'main';
  return inherited;
}

function collectCandidatesFromObject(value, buckets, baseUrl, source, hint = '', seen = new Set(), depth = 0) {
  if (depth > 10 || value === null || value === undefined) return;
  if (typeof value === 'string') {
    const direct = normalizeMediaUrl(value, baseUrl);
    if (direct && (isLikelyImageUrl(direct) || isLikelyVideoUrl(direct))) {
      addCandidate(buckets, hint, direct, baseUrl, source);
    }
    for (const found of urlsFromText(value)) addCandidate(buckets, hint, found, baseUrl, source);
    return;
  }
  if (typeof value !== 'object' || seen.has(value)) return;
  seen.add(value);
  if (Array.isArray(value)) {
    for (const item of value) collectCandidatesFromObject(item, buckets, baseUrl, source, hint, seen, depth + 1);
    return;
  }
  for (const [key, item] of Object.entries(value)) {
    if (BAD_MEDIA_CONTEXT.test(key)) continue;
    collectCandidatesFromObject(item, buckets, baseUrl, source, hintFromKey(key, hint), seen, depth + 1);
  }
}

function contentTypeWithoutParameters(value) {
  return String(value || '').split(';')[0].trim().toLowerCase();
}

function isRelevantTextResponse(url, contentType) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch (error) {
    return false;
  }
  const host = parsed.hostname.toLowerCase();
  if (!/(?:1688\.com|alibaba\.com|alicdn\.com|tbcdn\.cn)$/i.test(host)) return false;
  if (!/(?:json|javascript|text|html)/i.test(contentType)) return false;
  return /(?:offer|detail|description|desc|module|data|async|api|product|media|image|video)/i.test(
    `${parsed.pathname}${parsed.search}`,
  );
}

function installNetworkCollector(page, buckets, baseUrl, maxResponseBodyBytes) {
  const pending = new Set();
  const diagnostics = { mediaResponses: 0, textResponsesRead: 0, textResponsesSkipped: 0 };

  const onResponse = (response) => {
    const url = response.url();
    const headers = response.headers();
    const httpStatus = response.status();
    const contentType = contentTypeWithoutParameters(headers['content-type']);
    const length = Number.parseInt(headers['content-length'], 10);
    const successful = httpStatus >= 200 && httpStatus < 300;
    if (successful && (isVerifiedVideoContentType(contentType) || isLikelyVideoUrl(url))) {
      diagnostics.mediaResponses += 1;
      addCandidate(buckets, 'video', url, baseUrl, 'network-media', {
        contentType,
        httpStatus,
        verifiedMediaType: isVerifiedVideoContentType(contentType) ? 'video' : '',
      });
    } else if (successful && contentType.startsWith('image/') && isLikelyImageUrl(url)) {
      diagnostics.mediaResponses += 1;
      addCandidate(buckets, '', url, baseUrl, 'network-media', { contentType, httpStatus });
    }

    if (!isRelevantTextResponse(url, contentType)) return;
    if (!Number.isFinite(length) || length < 0 || length > maxResponseBodyBytes) {
      diagnostics.textResponsesSkipped += 1;
      return;
    }
    const read = response.text()
      .then((text) => {
        diagnostics.textResponsesRead += 1;
        const bounded = text.slice(0, maxResponseBodyBytes);
        if (/json/i.test(contentType)) {
          try {
            collectCandidatesFromObject(JSON.parse(bounded), buckets, baseUrl, 'network-json');
            return;
          } catch (error) {}
        }
        const decodedText = htmlDecodeUrl(bounded);
        for (const found of urlsFromText(decodedText)) {
          const index = decodedText.indexOf(found);
          const context = index >= 0 ? decodedText.slice(Math.max(0, index - 100), index + found.length + 100) : '';
          addCandidate(buckets, hintFromKey(context, ''), found, baseUrl, 'network-text');
        }
      })
      .catch(() => {});
    pending.add(read);
    read.finally(() => pending.delete(read));
  };

  page.on('response', onResponse);
  return {
    diagnostics,
    async drain(timeoutMs = 5000) {
      const work = Promise.allSettled(Array.from(pending));
      await Promise.race([work, sleep(timeoutMs)]);
    },
    detach() {
      page.off('response', onResponse);
    },
  };
}

async function takeDomSnapshot(frame, { includeScripts = false, label = 'page' } = {}) {
  return frame.evaluate(({ includeScripts, label }) => {
    const compact = (value) => String(value || '').replace(/\s+/g, ' ').trim();
    const sourcesForImage = (image) => {
      const values = [
        image.currentSrc,
        image.src,
        image.getAttribute('data-src'),
        image.getAttribute('data-original'),
        image.getAttribute('data-lazy-src'),
        image.getAttribute('data-url'),
        image.getAttribute('data-image'),
      ].filter(Boolean);
      for (const srcset of [image.srcset, image.getAttribute('data-srcset')].filter(Boolean)) {
        for (const part of String(srcset).split(',')) {
          const candidate = part.trim().split(/\s+/)[0];
          if (candidate) values.push(candidate);
        }
      }
      return Array.from(new Set(values));
    };
    const contextFor = (element) => {
      const parts = [];
      let current = element;
      for (let depth = 0; depth < 6 && current; depth += 1, current = current.parentElement) {
        parts.push(current.id || '');
        parts.push(typeof current.className === 'string' ? current.className : '');
        parts.push(current.getAttribute && current.getAttribute('data-module') || '');
        parts.push(current.getAttribute && current.getAttribute('aria-label') || '');
      }
      return compact(parts.join(' ')).slice(0, 700);
    };
    const detailSelector = [
      '[class*="detail" i]', '[id*="detail" i]', '[class*="description" i]',
      '[id*="description" i]', '[class*="desc" i]', '[data-module*="detail" i]',
      '[class*="product-content" i]', '[class*="offer-content" i]',
      '[class*="description-content" i]', '[class*="detail-content" i]',
      '[class~="content"]',
    ].join(',');
    const gallerySelector = [
      '[class*="gallery" i]', '[id*="gallery" i]', '[class*="main-img" i]',
      '[class*="mainImage" i]', '[class*="offer-img" i]', '[class*="vertical-img" i]',
      '[class*="preview" i]', '[class*="carousel" i]', '[class*="slider" i]',
    ].join(',');
    const bad = /(?:logo|avatar|icon|sprite|二维码|qrcode|qr-code|店铺|推荐|猜你喜欢|相似|评价|评论|买家秀|客服|广告|直播|榜单|更多商品|recommend|review|comment)/i;
    const scrollY = window.scrollY || 0;
    const images = Array.from(document.images).slice(0, 700).map((image) => {
      const rect = image.getBoundingClientRect();
      const context = contextFor(image);
      const width = Math.max(Math.round(rect.width || 0), Number(image.naturalWidth || 0));
      const height = Math.max(Math.round(rect.height || 0), Number(image.naturalHeight || 0));
      const top = Math.round(rect.top + scrollY);
      const inDetail = Boolean(image.closest(detailSelector));
      const inGallery = Boolean(image.closest(gallerySelector));
      const excluded = bad.test(`${context} ${image.alt || ''}`);
      return {
        srcs: sourcesForImage(image),
        width,
        height,
        top,
        inDetail,
        inGallery,
        excluded,
        context,
      };
    });
    const videos = Array.from(document.querySelectorAll('video, video source, source[type*="video" i]'))
      .slice(0, 100)
      .map((element) => ({
        srcs: Array.from(new Set([
          element.currentSrc,
          element.src,
          element.getAttribute('src'),
          element.getAttribute('data-src'),
          element.poster,
          element.getAttribute('poster'),
        ].filter(Boolean))),
        context: contextFor(element),
      }));
    const metas = Array.from(document.querySelectorAll('meta[property], meta[name]'))
      .filter((meta) => /(?:image|video)/i.test(`${meta.getAttribute('property') || ''} ${meta.name || ''}`))
      .slice(0, 30)
      .map((meta) => ({ key: meta.getAttribute('property') || meta.name || '', value: meta.content || '' }));
    const scripts = [];
    if (includeScripts) {
      let total = 0;
      for (const script of Array.from(document.scripts)) {
        const text = String(script.textContent || '');
        const marker = `${script.type || ''} ${script.id || ''} ${script.className || ''}`;
        if (!/(?:json|ld\+json|init|data|offer|detail|product|image|video)/i.test(marker + text.slice(0, 5000))) continue;
        const bounded = text.slice(0, 750000);
        if (total + bounded.length > 2500000) break;
        scripts.push({ type: script.type || '', marker: marker.slice(0, 200), text: bounded });
        total += bounded.length;
      }
    }
    return { label, url: location.href, images, videos, metas, scripts };
  }, { includeScripts, label });
}

function consumeDomSnapshot(snapshot, buckets, productUrl) {
  const baseUrl = snapshot.url || productUrl;
  for (const image of snapshot.images || []) {
    if (image.excluded) continue;
    let kind = '';
    if (image.inGallery && Math.max(image.width, image.height) >= 100) kind = 'main';
    else if (image.inDetail && Math.max(image.width, image.height) >= 180) kind = 'detail';
    else if (image.top < 1800 && image.width >= 280 && image.height >= 180) kind = 'main';
    else if (image.width >= 400 && image.height >= 180 && !BAD_MEDIA_CONTEXT.test(image.context)) kind = 'detail';
    const evidence = {
      width: image.width,
      height: image.height,
      top: image.top,
      inDetail: image.inDetail,
      inGallery: image.inGallery,
      context: image.context,
    };
    for (const source of image.srcs || []) addCandidate(buckets, kind, source, baseUrl, `dom-${snapshot.label}`, evidence);
  }
  for (const video of snapshot.videos || []) {
    if (BAD_MEDIA_CONTEXT.test(video.context || '')) continue;
    for (const source of video.srcs || []) addCandidate(buckets, 'video', source, baseUrl, `dom-${snapshot.label}`);
  }
  for (const meta of snapshot.metas || []) {
    const hint = /video/i.test(meta.key) ? 'video' : 'main';
    addCandidate(buckets, hint, meta.value, baseUrl, 'page-meta');
  }
  for (const script of snapshot.scripts || []) {
    if (/json/i.test(script.type)) {
      try {
        collectCandidatesFromObject(JSON.parse(script.text), buckets, baseUrl, 'initial-json');
        continue;
      } catch (error) {}
    }
    const decodedText = htmlDecodeUrl(script.text);
    for (const found of urlsFromText(decodedText)) {
      const index = decodedText.indexOf(found);
      const context = index >= 0 ? decodedText.slice(Math.max(0, index - 120), index + found.length + 120) : '';
      addCandidate(buckets, hintFromKey(context, ''), found, baseUrl, 'initial-script');
    }
  }
}

async function clickDetailEntry(page) {
  for (const text of ['商品详情', '图文详情', '产品详情', '宝贝详情']) {
    try {
      const locator = page.getByText(text, { exact: true }).first();
      if (await locator.isVisible({ timeout: 800 })) {
        await locator.click({ timeout: 3000 });
        await page.waitForTimeout(600);
        return text;
      }
    } catch (error) {}
  }
  return '';
}

async function scrollForLazyMedia(page, times, waitMs) {
  for (let index = 0; index < times; index += 1) {
    if (page.isClosed()) break;
    await page.mouse.wheel(0, 720);
    await page.waitForTimeout(waitMs);
  }
}

function extractAlibabaSupplierId(value) {
  const text = String(value || '');
  const imageOwner = text.match(/!!(\d{6,})(?:-|\/|$)/);
  if (imageOwner) return imageOwner[1];
  const videoOwner = text.match(/\/play\/u\/(\d{6,})(?:\/|$)/i);
  return videoOwner ? videoOwner[1] : '';
}

function inferProductSupplier(main, detail) {
  const scores = new Map();
  const add = (item, weight) => {
    const supplierId = extractAlibabaSupplierId(item?.url);
    if (!supplierId) return;
    const sourceBonus = String(item?.source || '').startsWith('dom-') ? 2 : 0;
    scores.set(supplierId, (scores.get(supplierId) || 0) + weight + sourceBonus);
  };
  for (const item of main) add(item, 2);
  for (const item of detail) add(item, 5);
  const ranked = Array.from(scores.entries())
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]));
  return {
    id: ranked[0]?.[0] || '',
    candidates: ranked.map(([id, score]) => ({ id, score })),
  };
}

function videoSourceScore(item) {
  const source = String(item?.source || '');
  if (item?.verifiedByContentType && source === 'network-media') return 500;
  if (source === 'network-media') return 420;
  if (source.startsWith('dom-')) return 380;
  if (source === 'initial-json' || source === 'network-json') return 300;
  if (source === 'page-meta') return 240;
  if (source.includes('script')) return 120;
  if (source.includes('text')) return 80;
  return 160;
}

function rankVideoCandidates(items, productSupplierId = '') {
  const eligible = items.filter((item) => isLikelyVideoUrl(item.url) || item.verifiedByContentType);
  const ranked = eligible
    .map((item, index) => {
      const supplierId = extractAlibabaSupplierId(item.url);
      const supplierMatch = Boolean(productSupplierId && supplierId === productSupplierId);
      return { item: { ...item, supplierId, supplierMatch }, index, supplierMatch };
    })
    .sort((left, right) => Number(right.supplierMatch) - Number(left.supplierMatch)
      || videoSourceScore(right.item) - videoSourceScore(left.item)
      || left.index - right.index)
    .map((entry) => entry.item);
  const matching = ranked.filter((item) => item.supplierMatch);
  return productSupplierId && matching.length ? matching : ranked;
}

function selectCandidates(buckets, limits) {
  const main = rankCandidates(Array.from(buckets.main.values()));
  const directDetail = rankCandidates(Array.from(buckets.detail.values()).filter(isLikelyProductDetailCandidate));
  const supplemental = Array.from(buckets.supplementalImage.values())
    .filter((item) => item.source !== 'network-media');
  if (!main.length) main.push(...rankCandidates(supplemental).slice(0, limits.maxMainImages));

  const selectedMain = main.slice(0, limits.maxMainImages);
  const mainKeys = new Set(selectedMain.map((item) => mediaKey(item.url)));
  const supplier = inferProductSupplier(selectedMain, directDetail);
  const fallbackPool = uniqueCandidatesByMediaKey([
    ...Array.from(buckets.supplementalImage.values()),
    ...main.filter((item) => !mainKeys.has(mediaKey(item.url))),
  ]);
  const detailFallback = directDetail.length
    ? []
    : rankDetailFallbackCandidates(fallbackPool, supplier.id);
  const detail = directDetail.length ? directDetail : detailFallback;
  const cleanDetail = detail.filter((item) => !mainKeys.has(mediaKey(item.url)));
  const selectedDetail = cleanDetail.slice(0, limits.maxDetailImages);
  const rankedVideos = rankVideoCandidates(Array.from(buckets.video.values()), supplier.id);
  const selectedVideos = rankedVideos.slice(0, limits.maxVideos);
  return {
    main: selectedMain,
    detail: selectedDetail,
    videos: selectedVideos,
    diagnostics: {
      candidateStages: {
        raw: { ...(buckets.stats?.raw || {}) },
        filtered: {
          main: main.length,
          detail: detail.length,
          detailDirect: directDetail.length,
          detailFallback: detailFallback.length,
          videos: rankedVideos.length,
          supplementalImages: supplemental.length,
        },
        deduplicated: {
          main: buckets.main.size,
          detail: buckets.detail.size,
          videos: buckets.video.size,
          supplementalImages: buckets.supplementalImage.size,
        },
        selected: {
          main: selectedMain.length,
          detail: selectedDetail.length,
          videos: selectedVideos.length,
        },
      },
      productSupplier: {
        id: supplier.id,
        candidates: supplier.candidates,
        matchingVideoCandidates: rankedVideos.filter((item) => item.supplierMatch).length,
      },
    },
  };
}

async function extractMediaFromProductPage({ page, productUrl, offerId, limits, screenshotPath, deferHumanVerification = false }) {
  const buckets = createCandidateBuckets();
  const collector = installNetworkCollector(page, buckets, productUrl, limits.maxResponseBodyBytes);
  const snapshots = [];
  let detailEntryClicked = '';
  try {
    await page.goto(productUrl, { waitUntil: 'domcontentloaded', timeout: limits.pageTimeoutMs });
    await page.waitForTimeout(1200);

    const initialAccessState = await detect1688AccessState(page);
    const verification = initialAccessState.blocked && deferHumanVerification
      ? { required: true, resolved: false, status: 'switch_to_headed', kind: initialAccessState.kind, waitedMs: 0, screenshotPath: '' }
      : await waitForHumanVerification({ page, timeoutMs: limits.humanVerificationTimeoutMs, screenshotPath });
    if (!verification.resolved) {
      return {
        verification,
        selected: { main: [], detail: [], videos: [] },
        diagnostics: collector.diagnostics,
      };
    }

    if (verification.required) {
      await page.goto(productUrl, { waitUntil: 'domcontentloaded', timeout: limits.pageTimeoutMs });
      await page.waitForTimeout(1000);
      const state = await detect1688AccessState(page);
      if (state.blocked) {
        return {
          verification: { ...verification, resolved: false, status: 'challenge_returned' },
          selected: { main: [], detail: [], videos: [] },
          diagnostics: collector.diagnostics,
        };
      }
    }

    const finalUrl = page.url();
    const finalHost = new URL(finalUrl).hostname.toLowerCase().replace(/\.$/, '');
    if (finalHost !== '1688.com' && !finalHost.endsWith('.1688.com')) {
      throw new DownloadError('1688 redirected the product page to an unexpected hostname.', {
        code: 'UPSTREAM_REDIRECT',
      });
    }
    const finalOfferId = extractOfferId(finalUrl);
    if (finalOfferId && finalOfferId !== offerId) {
      throw new DownloadError('The final 1688 page does not match the requested offerId.', {
        code: 'OFFER_ID_MISMATCH',
      });
    }

    snapshots.push(await takeDomSnapshot(page.mainFrame(), { includeScripts: true, label: 'initial' }));
    detailEntryClicked = await clickDetailEntry(page);
    await scrollForLazyMedia(page, limits.scrollMaxTimes, limits.scrollWaitMs);
    snapshots.push(await takeDomSnapshot(page.mainFrame(), { includeScripts: false, label: 'scrolled' }));

    let frameIndex = 0;
    for (const frame of page.frames()) {
      if (frame === page.mainFrame()) continue;
      if (frameIndex >= 12) break;
      try {
        const snapshot = await takeDomSnapshot(frame, { includeScripts: false, label: `frame-${frameIndex + 1}` });
        snapshots.push(snapshot);
        frameIndex += 1;
      } catch (error) {}
    }

    for (const snapshot of snapshots) consumeDomSnapshot(snapshot, buckets, productUrl);
    await collector.drain();
    const bodyText = await page.locator('body').innerText().catch(() => '');
    const detailAccessRestricted = isDetailMediaRestricted(bodyText);
    if (detailAccessRestricted) buckets.detail.clear();
    const selected = selectCandidates(buckets, limits);
    const selectionDiagnostics = selected.diagnostics || {};
    delete selected.diagnostics;
    return {
      verification,
      selected,
      diagnostics: {
        ...collector.diagnostics,
        finalUrl,
        detailEntryClicked,
        detailAccessRestricted,
        snapshotCount: snapshots.length,
        candidateCounts: {
          main: buckets.main.size,
          detail: buckets.detail.size,
          videos: buckets.video.size,
          supplementalImages: buckets.supplementalImage.size,
        },
        ...selectionDiagnostics,
      },
    };
  } finally {
    collector.detach();
  }
}

function isNonPublicIpv4(address) {
  const octets = String(address || '').split('.').map((part) => Number(part));
  if (octets.length !== 4 || octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return true;
  const [a, b, c] = octets;
  if (a === 0 || a === 10 || a === 127 || a >= 224) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return true;
  if (a === 192 && b === 168) return true;
  if (a === 198 && (b === 18 || b === 19)) return true;
  if (a === 198 && b === 51 && c === 100) return true;
  if (a === 203 && b === 0 && c === 113) return true;
  return false;
}

function isBenchmarkFakeIpv4(address) {
  const octets = String(address || '').split('.').map((part) => Number(part));
  if (octets.length !== 4 || octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  return octets[0] === 198 && (octets[1] === 18 || octets[1] === 19);
}

function isSyntheticFakeIpResolutionAllowed(hostname, addresses) {
  const host = String(hostname || '').trim().toLowerCase().replace(/\.$/, '');
  const trustedHost = SYNTHETIC_FAKE_IP_MEDIA_SUFFIXES.some(
    (suffix) => host === suffix || host.endsWith('.' + suffix),
  );
  if (!trustedHost || !Array.isArray(addresses) || !addresses.length) return false;
  return addresses.every((entry) => isBenchmarkFakeIpv4(typeof entry === 'string' ? entry : entry?.address));
}

function isDetailMediaRestricted(text) {
  return /指定会员可见|仅限(?:指定)?会员(?:可见|查看)|联系商家(?:查看|获取)/i.test(String(text || ''));
}

function isNonPublicIp(address) {
  const raw = String(address || '').trim().toLowerCase().replace(/^\[|\]$/g, '');
  const family = net.isIP(raw);
  if (family === 4) return isNonPublicIpv4(raw);
  if (family !== 6) return true;
  const mapped = raw.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
  if (mapped) return isNonPublicIpv4(mapped[1]);
  if (raw === '::' || raw === '::1') return true;
  if (/^(?:fc|fd)/i.test(raw)) return true;
  if (/^fe[89ab]/i.test(raw)) return true;
  if (/^ff/i.test(raw)) return true;
  if (/^2001:db8(?::|$)/i.test(raw)) return true;
  return false;
}

function isBlockedHostname(hostname) {
  const host = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (!host) return true;
  if (host === 'localhost' || host === 'metadata.google.internal') return true;
  if (/\.(?:localhost|local|internal|home|lan)$/.test(host)) return true;
  return net.isIP(host) ? isNonPublicIp(host) : false;
}

async function assertPublicMediaUrl(value) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch (error) {
    throw new DownloadError('Media URL is invalid.', { code: 'INVALID_MEDIA_URL' });
  }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) {
    throw new DownloadError('Media URL must be an unauthenticated public HTTP(S) URL.', { code: 'INVALID_MEDIA_URL' });
  }
  if (isBlockedHostname(parsed.hostname)) {
    throw new DownloadError('Media URL points to a local, private, or reserved address.', { code: 'BLOCKED_MEDIA_HOST' });
  }
  if (!net.isIP(parsed.hostname.replace(/^\[|\]$/g, ''))) {
    let addresses;
    try {
      addresses = await dns.lookup(parsed.hostname, { all: true, verbatim: true });
    } catch (error) {
      throw new DownloadError('Media hostname could not be resolved.', {
        code: 'MEDIA_DNS_ERROR',
        retryable: true,
      });
    }
    const hasNonPublicAddress = !addresses.length || addresses.some((entry) => isNonPublicIp(entry.address));
    if (hasNonPublicAddress && !isSyntheticFakeIpResolutionAllowed(parsed.hostname, addresses)) {
      throw new DownloadError('Media hostname resolves to a local, private, or reserved address.', {
        code: 'BLOCKED_MEDIA_HOST',
      });
    }
  }
  return parsed.toString();
}

function shouldRetryHttpStatus(status) {
  return status === 429 || status >= 500;
}

async function disposeApiResponse(response) {
  if (!response || typeof response.dispose !== 'function') return;
  try {
    await response.dispose();
  } catch (error) {}
}

async function fetchMediaOnce({ request, url, headers, timeoutMs, maxMediaBytes }) {
  let currentUrl = url;
  for (let redirect = 0; redirect <= 5; redirect += 1) {
    currentUrl = await assertPublicMediaUrl(currentUrl);
    let response;
    try {
      response = await request.get(currentUrl, {
        headers,
        timeout: timeoutMs,
        failOnStatusCode: false,
        maxRedirects: 0,
      });
    } catch (error) {
      throw new DownloadError('Media request failed before receiving an HTTP response.', {
        code: 'MEDIA_NETWORK_ERROR',
        retryable: true,
      });
    }

    const status = response.status();
    if (status >= 300 && status < 400) {
      const location = response.headers().location || '';
      await disposeApiResponse(response);
      if (!location) {
        throw new DownloadError(`Media redirect returned HTTP ${status} without a Location header.`, {
          code: 'MEDIA_REDIRECT_ERROR',
          status,
        });
      }
      if (redirect >= 5) {
        throw new DownloadError('Media request exceeded the redirect limit.', { code: 'MEDIA_REDIRECT_LIMIT' });
      }
      currentUrl = normalizeMediaUrl(location, currentUrl);
      if (!currentUrl) throw new DownloadError('Media redirect target is invalid.', { code: 'INVALID_MEDIA_URL' });
      continue;
    }

    if (status < 200 || status >= 300) {
      await disposeApiResponse(response);
      throw new DownloadError(`Media request returned HTTP ${status}.`, {
        code: status === 401 || status === 403 ? 'MEDIA_ACCESS_DENIED' : 'MEDIA_HTTP_ERROR',
        status,
        retryable: shouldRetryHttpStatus(status),
      });
    }

    const responseHeaders = response.headers();
    const declaredLengthText = String(responseHeaders['content-length'] || '').trim();
    const declaredLength = /^\d+$/.test(declaredLengthText) ? Number(declaredLengthText) : Number.NaN;
    if (!Number.isSafeInteger(declaredLength) || declaredLength <= 0) {
      await disposeApiResponse(response);
      throw new DownloadError('Media response did not provide a valid positive Content-Length.', {
        code: 'MEDIA_LENGTH_REQUIRED',
      });
    }
    if (declaredLength > maxMediaBytes) {
      await disposeApiResponse(response);
      throw new DownloadError('Media response exceeds maxMediaBytes.', { code: 'MEDIA_TOO_LARGE' });
    }

    let buffer;
    try {
      buffer = await response.body();
    } catch (error) {
      await disposeApiResponse(response);
      throw new DownloadError('Media response body could not be read.', {
        code: 'MEDIA_NETWORK_ERROR',
        retryable: true,
      });
    }
    await disposeApiResponse(response);
    if (!buffer.length) throw new DownloadError('Media response body is empty.', { code: 'EMPTY_MEDIA' });
    if (buffer.length > maxMediaBytes) {
      throw new DownloadError('Media response exceeds maxMediaBytes.', { code: 'MEDIA_TOO_LARGE' });
    }
    return {
      buffer,
      contentType: contentTypeWithoutParameters(responseHeaders['content-type']),
      finalUrl: currentUrl,
    };
  }
  throw new DownloadError('Media request exceeded the redirect limit.', { code: 'MEDIA_REDIRECT_LIMIT' });
}

async function fetchMediaWithRetry(options) {
  let lastError;
  const retryDelayMs = Math.max(0, Number(options.retryDelayMs ?? 700));
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      return await fetchMediaOnce(options);
    } catch (error) {
      lastError = error;
      if (!error.retryable || attempt >= 3) break;
      await sleep(retryDelayMs * attempt);
    }
  }
  throw lastError;
}

function inferExtension(url, contentType, kind) {
  const type = contentTypeWithoutParameters(contentType);
  if (kind === 'image' && IMAGE_EXT_BY_TYPE[type]) return IMAGE_EXT_BY_TYPE[type];
  if (kind === 'video' && VIDEO_EXT_BY_TYPE[type]) return VIDEO_EXT_BY_TYPE[type];
  try {
    const extension = path.extname(new URL(url).pathname).toLowerCase();
    if (kind === 'image' && ALLOWED_IMAGE_EXTENSIONS.has(extension)) return extension === '.jpeg' ? '.jpg' : extension;
    if (kind === 'video' && ALLOWED_VIDEO_EXTENSIONS.has(extension)) return extension;
  } catch (error) {}
  return kind === 'video' ? '.mp4' : '.jpg';
}

function isM3u8Payload(url, contentType, buffer) {
  const type = contentTypeWithoutParameters(contentType);
  return /mpegurl/i.test(type) || /\.m3u8(?:$|[?#])/i.test(url) || /^\s*#EXTM3U/i.test(buffer.toString('utf8', 0, 100));
}

function extractM3u8References(manifestText, manifestUrl) {
  const references = [];
  let nextUriIsPlaylist = false;
  for (const rawLine of String(manifestText || '').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    if (line.startsWith('#')) {
      if (/^#EXT-X-STREAM-INF:/i.test(line)) nextUriIsPlaylist = true;
      const attributePattern = /\bURI=(?:"([^"]+)"|([^,\s]+))/gi;
      for (const match of line.matchAll(attributePattern)) {
        const rawUri = match[1] || match[2] || '';
        const url = normalizeMediaUrl(rawUri, manifestUrl);
        references.push({
          rawUri,
          url,
          isPlaylist: /^#EXT-X-I-FRAME-STREAM-INF:/i.test(line) || /\.m3u8(?:$|[?#])/i.test(rawUri),
        });
      }
      continue;
    }
    const url = normalizeMediaUrl(line, manifestUrl);
    references.push({
      rawUri: line,
      url,
      isPlaylist: nextUriIsPlaylist || /\.m3u8(?:$|[?#])/i.test(line),
    });
    nextUriIsPlaylist = false;
  }
  return references;
}

async function validateM3u8ManifestTree({
  request,
  manifestUrl,
  buffer,
  headers,
  timeoutMs,
  maxManifestBytes,
  visited = new Set(),
  depth = 0,
}) {
  if (depth > 4) {
    throw new DownloadError('m3u8 playlist nesting exceeds the validation depth limit.', {
      code: 'M3U8_DEPTH_LIMIT',
    });
  }
  const key = mediaKey(manifestUrl);
  if (visited.has(key)) return;
  if (visited.size >= 24) {
    throw new DownloadError('m3u8 playlist references too many nested playlists.', {
      code: 'M3U8_PLAYLIST_LIMIT',
    });
  }
  visited.add(key);
  const text = buffer.toString('utf8');
  if (!/^\s*#EXTM3U/i.test(text)) {
    throw new DownloadError('m3u8 response does not contain a valid EXTM3U header.', {
      code: 'INVALID_M3U8',
    });
  }
  const references = extractM3u8References(text, manifestUrl);
  if (references.length > 5000) {
    throw new DownloadError('m3u8 playlist contains too many URI references.', {
      code: 'M3U8_REFERENCE_LIMIT',
    });
  }
  for (const reference of references) {
    if (!reference.url) {
      throw new DownloadError('m3u8 playlist contains a non-HTTP(S) or invalid URI.', {
        code: 'M3U8_INVALID_URI',
      });
    }
    await assertPublicMediaUrl(reference.url);
  }
  for (const reference of references.filter((item) => item.isPlaylist)) {
    const child = await fetchMediaWithRetry({
      request,
      url: reference.url,
      headers,
      timeoutMs,
      maxMediaBytes: maxManifestBytes,
    });
    await validateM3u8ManifestTree({
      request,
      manifestUrl: child.finalUrl,
      buffer: child.buffer,
      headers,
      timeoutMs,
      maxManifestBytes,
      visited,
      depth: depth + 1,
    });
  }
}

function findFfmpegExecutable(explicitPath = '') {
  const explicit = normalizePathInput(explicitPath);
  if (explicit) {
    if (!isPortableAbsolutePath(explicit)) throw new Error('ffmpegPath must be an absolute path.');
    try {
      if (fs.statSync(explicit).isFile()) return path.resolve(explicit);
    } catch (error) {}
    throw new Error('ffmpegPath does not exist or is not a file.');
  }
  const probe = spawnSync('ffmpeg', ['-version'], {
    encoding: 'utf8',
    timeout: 5000,
    windowsHide: true,
  });
  return probe.status === 0 ? 'ffmpeg' : '';
}

function sanitizeHeaderValue(value) {
  return String(value || '').replace(/[\r\n]/g, ' ').trim();
}

async function runFfmpegForM3u8({
  executable,
  url,
  outputPath,
  referer,
  userAgent,
  cookies,
  timeoutMs,
  maxMediaBytes,
}) {
  const cookieHeader = cookies
    .map((cookie) => `${sanitizeHeaderValue(cookie.name)}=${sanitizeHeaderValue(cookie.value)}`)
    .join('; ');
  const headerLines = [
    `Referer: ${sanitizeHeaderValue(referer)}`,
    userAgent ? `User-Agent: ${sanitizeHeaderValue(userAgent)}` : '',
    cookieHeader ? `Cookie: ${cookieHeader}` : '',
  ].filter(Boolean).join('\r\n') + '\r\n';
  const tempPath = `${outputPath}.part-${process.pid}-${Date.now()}.mp4`;
  const args = [
    '-y',
    '-loglevel', 'error',
    '-headers', headerLines,
    '-protocol_whitelist', 'http,https,tcp,tls,crypto',
    '-i', url,
    '-map', '0:v:0?',
    '-map', '0:a:0?',
    '-c', 'copy',
    '-movflags', '+faststart',
    '-fs', String(maxMediaBytes),
    tempPath,
  ];

  await new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      stdio: ['ignore', 'ignore', 'ignore'],
      windowsHide: true,
      shell: false,
    });
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGKILL');
      reject(new DownloadError('ffmpeg timed out while converting the m3u8 video.', { code: 'FFMPEG_TIMEOUT' }));
    }, Math.max(120000, timeoutMs * 4));
    child.once('error', () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new DownloadError('ffmpeg could not be started.', { code: 'FFMPEG_START_ERROR' }));
    });
    child.once('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new DownloadError(`ffmpeg failed with exit code ${code}.`, { code: 'FFMPEG_FAILED' }));
    });
  }).catch((error) => {
    try {
      fs.rmSync(tempPath, { force: true });
    } catch (removeError) {}
    throw error;
  });

  const stat = fs.statSync(tempPath);
  if (!stat.isFile() || stat.size <= 0) {
    fs.rmSync(tempPath, { force: true });
    throw new DownloadError('ffmpeg created an empty output file.', { code: 'FFMPEG_EMPTY_OUTPUT' });
  }
  fs.renameSync(tempPath, outputPath);
}

function atomicWriteBuffer(targetPath, buffer) {
  const tempPath = `${targetPath}.part-${process.pid}-${Date.now()}`;
  try {
    fs.writeFileSync(tempPath, buffer, { flag: 'wx' });
    fs.renameSync(tempPath, targetPath);
  } catch (error) {
    try {
      fs.rmSync(tempPath, { force: true });
    } catch (removeError) {}
    throw error;
  }
}

async function validateProductImageBuffer(buffer) {
  let dimensions;
  try {
    dimensions = await sharp(buffer, { failOn: 'none' }).metadata();
  } catch (error) {
    throw new DownloadError('Image bytes could not be decoded for product-media checks.', {
      code: 'IMAGE_DECODE_ERROR',
    });
  }
  if (!Number.isInteger(dimensions.width) || !Number.isInteger(dimensions.height)
    || dimensions.width < MIN_PRODUCT_IMAGE_WIDTH
    || dimensions.height < MIN_PRODUCT_IMAGE_HEIGHT) {
    throw new DownloadError(
      `Image dimensions ${dimensions.width || 0}x${dimensions.height || 0} are below the product-media minimum.`,
      { code: 'IMAGE_DIMENSIONS_TOO_SMALL' },
    );
  }
  return dimensions;
}

function validateDetailImageBufferSize(buffer) {
  const sizeBytes = Buffer.isBuffer(buffer) ? buffer.length : 0;
  if (sizeBytes < MIN_DETAIL_IMAGE_BYTES) {
    throw new DownloadError(
      `Detail image size ${sizeBytes} bytes is below the 50KB minimum.`,
      { code: 'DETAIL_IMAGE_BYTES_TOO_SMALL' },
    );
  }
}

function buildMediaBaseName(prefix, zeroBasedIndex) {
  return `${prefix}_${String(zeroBasedIndex + 1).padStart(2, '0')}`;
}

async function downloadCandidate({
  context,
  page,
  candidate,
  index,
  kind,
  directory,
  prefix,
  referer,
  requestTimeoutMs,
  maxMediaBytes,
  ffmpegPath,
  nativeUserAgent,
}) {
  const response = await fetchMediaWithRetry({
    request: context.request,
    url: candidate.url,
    headers: {
      Referer: referer,
      ...(nativeUserAgent ? { 'User-Agent': nativeUserAgent } : {}),
      Accept: kind === 'image'
        ? 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8'
        : '*/*',
    },
    timeoutMs: requestTimeoutMs,
    maxMediaBytes,
  });

  const baseName = buildMediaBaseName(prefix, index);
  let localPath;
  let contentType = response.contentType;
  if (kind === 'video' && isM3u8Payload(response.finalUrl, response.contentType, response.buffer)) {
    const maxManifestBytes = Math.min(maxMediaBytes, 5 * 1024 * 1024);
    if (response.buffer.length > maxManifestBytes) {
      throw new DownloadError('m3u8 manifest exceeds the 5 MiB validation limit.', {
        code: 'M3U8_MANIFEST_TOO_LARGE',
      });
    }
    await validateM3u8ManifestTree({
      request: context.request,
      manifestUrl: response.finalUrl,
      buffer: response.buffer,
      headers: {
        Referer: referer,
        ...(nativeUserAgent ? { 'User-Agent': nativeUserAgent } : {}),
        Accept: '*/*',
      },
      timeoutMs: requestTimeoutMs,
      maxManifestBytes,
    });
    const executable = findFfmpegExecutable(ffmpegPath);
    if (!executable) {
      throw new DownloadError('ffmpeg is required to convert m3u8 video to MP4 but was not found.', {
        code: 'FFMPEG_NOT_FOUND',
      });
    }
    localPath = path.join(directory, `${baseName}.mp4`);
    const cookies = await context.cookies(response.finalUrl);
    await runFfmpegForM3u8({
      executable,
      url: response.finalUrl,
      outputPath: localPath,
      referer,
      userAgent: nativeUserAgent,
      cookies,
      timeoutMs: requestTimeoutMs,
      maxMediaBytes,
    });
    if (fs.statSync(localPath).size >= maxMediaBytes) {
      fs.rmSync(localPath, { force: true });
      throw new DownloadError('Converted video reached maxMediaBytes and may be truncated.', {
        code: 'MEDIA_TOO_LARGE',
      });
    }
    contentType = 'video/mp4';
  } else {
    if (kind === 'image' && !response.contentType.startsWith('image/')) {
      throw new DownloadError('Image URL returned a non-image Content-Type.', { code: 'UNEXPECTED_CONTENT_TYPE' });
    }
    if (
      kind === 'video' &&
      response.contentType &&
      !response.contentType.startsWith('video/') &&
      response.contentType !== 'application/octet-stream' &&
      response.contentType !== 'application/mp4'
    ) {
      throw new DownloadError('Video URL returned an unexpected Content-Type.', { code: 'UNEXPECTED_CONTENT_TYPE' });
    }
    if (kind === 'image') {
      if (prefix === 'detail') validateDetailImageBufferSize(response.buffer);
      await validateProductImageBuffer(response.buffer);
    }
    const extension = inferExtension(response.finalUrl, response.contentType, kind);
    localPath = path.join(directory, `${baseName}${extension}`);
    atomicWriteBuffer(localPath, response.buffer);
  }

  const stat = fs.statSync(localPath);
  return {
    index: index + 1,
    url: candidate.url,
    localPath: toPortablePath(localPath),
    fileName: path.basename(localPath),
    contentType,
    sizeBytes: stat.size,
    sha256: crypto.createHash('sha256').update(fs.readFileSync(localPath)).digest('hex'),
    source: candidate.source,
  };
}

async function mapLimit(items, limit, handler) {
  const output = new Array(items.length);
  let cursor = 0;
  const workerCount = Math.min(items.length, Math.max(1, limit));
  await Promise.all(Array.from({ length: workerCount }, async () => {
    while (true) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      output[index] = await handler(items[index], index);
    }
  }));
  return output;
}

async function downloadBatch({
  context,
  page,
  candidates,
  kind,
  directory,
  prefix,
  concurrency,
  referer,
  requestTimeoutMs,
  maxMediaBytes,
  ffmpegPath,
  nativeUserAgent,
}) {
  const failures = [];
  const results = await mapLimit(candidates, concurrency, async (candidate, index) => {
    try {
      return await downloadCandidate({
        context,
        page,
        candidate,
        index,
        kind,
        directory,
        prefix,
        referer,
        requestTimeoutMs,
        maxMediaBytes,
        ffmpegPath,
        nativeUserAgent,
      });
    } catch (error) {
      failures.push({
        index: index + 1,
        code: error.code || 'DOWNLOAD_ERROR',
        message: error.message || String(error),
      });
      return null;
    }
  });
  failures.sort((a, b) => a.index - b.index);
  return { files: results.filter(Boolean), failures };
}

function loadOutputReservation() {
  try {
    const moduleValue = require('./1688-output-dir-version.cjs');
    if (typeof moduleValue.reserveVersionedOutputDir !== 'function') throw new Error('missing export');
    if (typeof moduleValue.reserveExecutionOutputDir !== 'function') throw new Error('missing execution export');
    return moduleValue;
  } catch (error) {
    const wrapped = new Error('1688-output-dir-version.cjs is missing required output reservation exports.');
    wrapped.code = 'OUTPUT_RESERVATION_MODULE_ERROR';
    wrapped.cause = error;
    throw wrapped;
  }
}

function ensureOutputDirectories(outputDir) {
  const directories = {
    output: outputDir,
    main: path.join(outputDir, 'main-images'),
    detail: path.join(outputDir, 'detail-images'),
    videos: path.join(outputDir, 'videos'),
    metadata: path.join(outputDir, 'metadata'),
  };
  for (const directory of Object.values(directories)) fs.mkdirSync(directory, { recursive: true });
  return directories;
}

function writeMetadata(metadataPath, { input, extraction, selected, result }) {
  if (!metadataPath) return;
  const document = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    input: {
      SKU: input.SKU,
      productName: input.productName,
      productUrl: input.productUrl,
      offerId: input.offerId,
    },
    extraction: extraction || {},
    selected: selected || { main: [], detail: [], videos: [] },
    result,
  };
  atomicWriteJson(metadataPath, document);
}

function appendDownloadFailures(result, label, failures) {
  for (const failure of failures) {
    result.warnings.push(`${label} ${failure.index} failed [${failure.code}]: ${failure.message}`);
  }
}

function isLocalFilesystemFailureCode(code) {
  return new Set([
    'EACCES', 'EBUSY', 'EDQUOT', 'EFBIG', 'EIO', 'EISDIR', 'EMFILE',
    'ENFILE', 'ENOSPC', 'ENOTDIR', 'EPERM', 'EROFS',
  ]).has(String(code || '').toUpperCase());
}

function isLikelyOutputValidationError(error) {
  return /(?:SKU|safeProductName|parentOutputDir|allowedOutputRoots|absolute path|outside|inside|symlink|path traversal)/i.test(
    String(error && error.message || error),
  );
}

async function runDownloader(argument = process.argv[2] || '', dependencies = {}) {
  const decoded = decodeParamsArg(argument);
  if (decoded.error) {
    return makeResult({
      status: 'validation_error',
      httpStatus: 400,
      errors: [decoded.error],
    });
  }

  const validation = validateInput(decoded.params);
  const input = validation.value;
  const result = makeResult({
    SKU: input.SKU,
    productName: input.productName,
    productUrl: input.productUrl,
    offerId: input.offerId,
    n8nExecutionId: input.n8nExecutionId,
    browserRunMode: input.headless ? 'headless' : 'headed',
    browserExecutablePath: input.browserExecutablePath,
    browserUserDataDir: input.browserUserDataDir,
    warnings: [...validation.warnings],
  });
  if (validation.errors.length) {
    result.status = 'validation_error';
    result.httpStatus = 400;
    result.errors.push(...validation.errors);
    return result;
  }

  let session;
  let heartbeatGuard;
  try {
    heartbeatGuard = startHeartbeat(input.idempotency, 'downloader', {
      onOwnerLost: async () => {
        if (session) {
          const lostSession = session;
          session = null;
          try { await lostSession.close(); } catch {}
        }
      },
    });
  } catch (error) {
    result.status = 'idempotency_owner_lost';
    result.httpStatus = 409;
    result.errors.push('Cannot start idempotency heartbeat: ' + (error.message || String(error)));
    return result;
  }

  const sessionFactory = dependencies.createBrowserSession || createBrowserSession;
  try {
    session = await sessionFactory({
      userDataDir: input.browserUserDataDir,
      browserExecutablePath: input.browserExecutablePath,
      headless: input.headless,
      ownerRole: 'download',
    });
    result.profileStatus = 'in_use';
    heartbeatGuard.assertOwned();
  } catch (error) {
    heartbeatGuard.stop();
    if (session) {
      try { await session.close(); } catch {}
      session = null;
    }
    if (error instanceof ProfileBusyError || error.code === 'PROFILE_BUSY') {
      result.status = 'profile_busy';
      result.httpStatus = 409;
      result.profileStatus = 'busy';
      result.browserProfileBusy = true;
      result.browserProfileLocked = true;
      result.errors.push('The dedicated 1688 browser profile is already in use.');
    } else if (error?.code === 'IDEMPOTENCY_OWNER_LOST') {
      result.status = 'idempotency_owner_lost';
      result.httpStatus = 409;
      result.profileStatus = 'released';
      result.errors.push(error.message || String(error));
    } else {
      result.status = 'internal_error';
      result.httpStatus = 500;
      result.profileStatus = 'launch_failed';
      result.errors.push(`Cannot start the persistent browser: ${error.message || String(error)}`);
    }
    return result;
  }

  let directories;
  try {
    const reservationApi = loadOutputReservation();
    const reservationParams = {
      parentOutputDir: input.parentOutputDir,
      SKU: input.SKU,
      safeProductName: input.safeProductName,
      allowedOutputRoots: input.allowedOutputRoots,
    };
    const reservation = input.n8nExecutionId
      ? reservationApi.reserveExecutionOutputDir({ ...reservationParams, n8nExecutionId: input.n8nExecutionId })
      : reservationApi.reserveVersionedOutputDir(reservationParams);
    directories = ensureOutputDirectories(reservation.outputDir);
    result.outputDir = toPortablePath(reservation.outputDir);
    result.revision = reservation.revision;
    result.metadataPath = toPortablePath(path.join(directories.metadata, '1688-media-metadata.json'));
    heartbeatGuard.assertOwned();
  } catch (error) {
    try {
      await session.close();
    } catch {}
    heartbeatGuard.stop();
    result.status = error?.code === 'IDEMPOTENCY_OWNER_LOST'
      ? 'idempotency_owner_lost'
      : (isLikelyOutputValidationError(error) ? 'validation_error' : 'internal_error');
    result.httpStatus = result.status === 'idempotency_owner_lost' ? 409 : (result.status === 'validation_error' ? 400 : 500);
    result.errors.push(`Cannot reserve the output directory: ${error.message || String(error)}`);
    return result;
  }

  let extraction = null;
  let selectedForMetadata = { main: [], detail: [], videos: [] };

  if (session) {
    try {
      const screenshotPath = toPortablePath(path.join(directories.metadata, 'human-verification-timeout.png'));
      extraction = await extractMediaFromProductPage({
        page: session.page,
        productUrl: input.productUrl,
        offerId: input.offerId,
        limits: input,
        screenshotPath,
        deferHumanVerification: input.headless,
      });
      heartbeatGuard.assertOwned();
      if (
        extraction.verification?.status === 'switch_to_headed' &&
        input.humanVerificationMode === 'interactive'
      ) {
        await session.close();
        session = await sessionFactory({
          userDataDir: input.browserUserDataDir,
          browserExecutablePath: input.browserExecutablePath,
          headless: false,
        });
        result.warnings.push('Headless Chrome detected login or security verification; switched to a visible Chrome browser for manual handling.');
        extraction = await extractMediaFromProductPage({
          page: session.page,
          productUrl: input.productUrl,
          offerId: input.offerId,
          limits: input,
          screenshotPath,
          deferHumanVerification: false,
        });
        heartbeatGuard.assertOwned();
      }
      selectedForMetadata = {
        main: extraction.selected.main.map((item) => ({ url: item.url, source: item.source })),
        detail: extraction.selected.detail.map((item) => ({ url: item.url, source: item.source })),
        videos: extraction.selected.videos.map((item) => ({
          url: item.url,
          source: item.source,
          contentType: item.contentType || '',
          verifiedByContentType: Boolean(item.verifiedByContentType),
          supplierId: item.supplierId || '',
          supplierMatch: Boolean(item.supplierMatch),
        })),
      };

      result.needHumanVerification = Boolean(extraction.verification.required);
      result.humanVerificationResolved = Boolean(extraction.verification.resolved);
      result.humanVerificationStatus = extraction.verification.status;
      result.humanVerificationScreenshotPath = toPortablePath(extraction.verification.screenshotPath || '');
      if (!extraction.verification.resolved) {
        if (!result.humanVerificationScreenshotPath && !session.page.isClosed()) {
          try {
            await session.page.screenshot({ path: screenshotPath, fullPage: false });
            result.humanVerificationScreenshotPath = screenshotPath;
          } catch (error) {}
        }
        result.status = extraction.verification.status === 'timeout' ? 'human_verification_timeout' : 'human_verification_required';
        result.httpStatus = 409;
        result.errors.push(extraction.verification.status === 'timeout'
          ? '等待登录或验证超过 5 分钟'
          : '1688 login or security verification could not be completed.');
      } else {
        const selected = extraction.selected;
        if (!selected.main.length) result.warnings.push('No product main-image candidates were found.');
        if (input.maxDetailImages > 0 && !selected.detail.length) result.warnings.push('No product detail-image candidates were found.');
        if (input.maxVideos > 0 && !selected.videos.length) result.warnings.push('No product video candidates were found.');
        if (extraction.diagnostics?.detailAccessRestricted) {
          result.warnings.push('1688 detail media is restricted to designated members; detail download was skipped.');
        }

        const nativeUserAgent = await session.page.evaluate(() => navigator.userAgent).catch(() => '');
        const common = {
          context: session.context,
          page: session.page,
          concurrency: input.downloadConcurrency,
          referer: input.productUrl,
          requestTimeoutMs: input.requestTimeoutMs,
          maxMediaBytes: input.maxMediaBytes,
          ffmpegPath: input.ffmpegPath,
          nativeUserAgent,
        };
        heartbeatGuard.assertOwned();
        const mainDownload = await downloadBatch({
          ...common,
          candidates: selected.main,
          kind: 'image',
          directory: directories.main,
          prefix: 'main',
        });
        heartbeatGuard.assertOwned();
        const detailDownload = await downloadBatch({
          ...common,
          candidates: selected.detail,
          kind: 'image',
          directory: directories.detail,
          prefix: 'detail',
        });
        heartbeatGuard.assertOwned();
        const videoDownload = await downloadBatch({
          ...common,
          candidates: selected.videos,
          kind: 'video',
          directory: directories.videos,
          prefix: 'video',
        });

        heartbeatGuard.assertOwned();
        result.mainImages = mainDownload.files;
        result.detailImages = detailDownload.files;
        result.videos = videoDownload.files;
        result.mainImageCount = result.mainImages.length;
        result.detailImageCount = result.detailImages.length;
        result.videoCount = result.videos.length;
        appendDownloadFailures(result, 'main image', mainDownload.failures);
        appendDownloadFailures(result, 'detail image', detailDownload.failures);
        appendDownloadFailures(result, 'video', videoDownload.failures);

        const failedCount = mainDownload.failures.length + detailDownload.failures.length + videoDownload.failures.length;
        if (!result.mainImageCount) {
          if (mainDownload.failures.some((failure) => isLocalFilesystemFailureCode(failure.code))) {
            result.status = 'internal_error';
            result.httpStatus = 500;
            result.errors.push('Local storage failed while saving all product main images.');
          } else {
            result.status = 'upstream_error';
            result.httpStatus = 502;
            result.errors.push('No product main image could be downloaded from the 1688 page.');
          }
        } else {
          result.success = true;
          result.status = failedCount ? 'partial_success' : 'success';
          result.httpStatus = 200;
        }
      }
    } catch (error) {
      result.success = false;
      result.status = error?.code === 'IDEMPOTENCY_OWNER_LOST' ? 'idempotency_owner_lost' : 'upstream_error';
      result.httpStatus = error?.code === 'IDEMPOTENCY_OWNER_LOST' ? 409 : 502;
      result.errors.push(`1688 product-page processing failed: ${error.message || String(error)}`);
    } finally {
      try {
        await session.close();
        result.profileStatus = 'released';
      } catch (error) {
        result.profileStatus = 'released_with_close_warning';
        result.warnings.push('The browser reported an error while closing; the E007 profile lock was released.');
      }
    }
  }

  try {
    heartbeatGuard.assertOwned();
    writeMetadata(result.metadataPath, {
      input,
      extraction: extraction ? extraction.diagnostics : {},
      selected: selectedForMetadata,
      result,
    });
  } catch (error) {
    if (error?.code === 'IDEMPOTENCY_OWNER_LOST') {
      result.success = false;
      result.status = 'idempotency_owner_lost';
      result.httpStatus = 409;
      result.errors.push(error.message || String(error));
      heartbeatGuard.stop();
      return result;
    }
    result.warnings.push(`Could not write metadata JSON: ${error.message || String(error)}`);
    if (result.success) result.status = 'partial_success';
  }
  heartbeatGuard.stop();
  return result;
}

if (require.main === module) {
  const decodedForResultFile = decodeParamsArg();
  runDownloader()
    .then((result) => {
      try {
        if (result.status !== 'idempotency_owner_lost') {
          writeResultFile(decodedForResultFile.params?.resultFilePath, result);
        }
      } catch (error) {
        result.warnings.push(`Could not write result JSON: ${error.message || String(error)}`);
        if (result.success) result.status = 'partial_success';
      }
      printResult(result);
    })
    .catch((error) => printResult(makeResult({
      status: 'internal_error',
      httpStatus: 500,
      errors: [`Fatal downloader error: ${error.message || String(error)}`],
    })));
}

module.exports = {
  DownloadError,
  addCandidate,
  assertPublicMediaUrl,
  buildMediaBaseName,
  collectCandidatesFromObject,
  createCandidateBuckets,
  decodeParamsArg,
  extractMediaFromProductPage,
  extractM3u8References,
  extractOfferId,
  fetchMediaWithRetry,
  inferMediaUrlDimensions,
  extractAlibabaSupplierId,
  hasAlibabaImageTransform,
  isBlockedHostname,
  isLikelyImageUrl,
  isLikelyVideoUrl,
  isVerifiedVideoContentType,
  isLocalFilesystemFailureCode,
  isLikelyProductDetailCandidate,
  isNonPublicIp,
  isSyntheticFakeIpResolutionAllowed,
  isDetailMediaRestricted,
  isPathInsideAllowedRoots,
  makeResult,
  mediaKey,
  normalizeDownloadConcurrency,
  normalizeMediaUrl,
  rankCandidates,
  rankVideoCandidates,
  runDownloader,
  sanitizeFileName,
  selectCandidates,
  stripAlibabaImageTransform,
  shouldRetryHttpStatus,
  toPortablePath,
  validateProductImageBuffer,
  validateDetailImageBufferSize,
  validateM3u8ManifestTree,
  validateInput,
  validateProductUrl,
  writeResultFile,
};
