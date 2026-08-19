#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { randomUUID } = require('crypto');

const DEFAULT_HUMAN_VERIFICATION_TIMEOUT_MS = 5 * 60 * 1000;
const DEFAULT_HUMAN_VERIFICATION_POLL_MS = 2000;

class ProfileBusyError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'ProfileBusyError';
    this.code = 'PROFILE_BUSY';
    this.httpStatus = 409;
    this.details = details;
  }
}

function normalizePathInput(value) {
  let text = String(value || '').trim();
  if (
    (text.startsWith('"') && text.endsWith('"')) ||
    (text.startsWith("'") && text.endsWith("'"))
  ) {
    text = text.slice(1, -1).trim();
  }
  if (text === '~') return os.homedir();
  if (text.startsWith('~/') || text.startsWith('~\\')) {
    return path.join(os.homedir(), text.slice(2));
  }
  return text;
}

function pathFlavor(value) {
  const text = normalizePathInput(value);
  if (/^[A-Za-z]:[\\/]/.test(text) || /^\\\\[^\\]/.test(text)) return 'win32';
  if (text.startsWith('/')) return 'posix';
  return '';
}

function isPortableAbsolutePath(value) {
  const text = normalizePathInput(value);
  return path.win32.isAbsolute(text) || path.posix.isAbsolute(text);
}

function assertNativeAbsolutePath(value, label) {
  const text = normalizePathInput(value);
  if (!text) throw new Error(`${label} is empty.`);
  if (!isPortableAbsolutePath(text)) throw new Error(`${label} must be an absolute path.`);
  const flavor = pathFlavor(text);
  if (process.platform === 'win32' && flavor === 'posix') {
    throw new Error(`${label} must use a Windows absolute path on Windows.`);
  }
  if (process.platform !== 'win32' && flavor === 'win32') {
    throw new Error(`${label} must use a POSIX absolute path on ${process.platform}.`);
  }
  return path.resolve(text);
}

function isExistingFile(filePath) {
  try {
    return Boolean(filePath) && fs.statSync(filePath).isFile();
  } catch (error) {
    return false;
  }
}

function findBrowserExecutable(explicitPath = '') {
  const explicit = normalizePathInput(explicitPath);
  if (explicit) {
    if (!isPortableAbsolutePath(explicit)) {
      throw new Error('browserExecutablePath must be an absolute path.');
    }
    if (!isExistingFile(explicit)) {
      throw new Error('browserExecutablePath does not exist or is not a file.');
    }
    return path.resolve(explicit);
  }

  const localAppData = process.env.LOCALAPPDATA || '';
  const programFiles = process.env.ProgramFiles || 'C:/Program Files';
  const programFilesX86 = process.env['ProgramFiles(x86)'] || 'C:/Program Files (x86)';
  const home = os.homedir();
  const candidates = [
    process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || '',
    path.join(programFiles, 'Google/Chrome/Application/chrome.exe'),
    path.join(programFilesX86, 'Google/Chrome/Application/chrome.exe'),
    localAppData ? path.join(localAppData, 'Google/Chrome/Application/chrome.exe') : '',
    path.join(programFiles, 'Microsoft/Edge/Application/msedge.exe'),
    path.join(programFilesX86, 'Microsoft/Edge/Application/msedge.exe'),
    localAppData ? path.join(localAppData, 'Microsoft/Edge/Application/msedge.exe') : '',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    home ? path.join(home, 'Applications/Google Chrome.app/Contents/MacOS/Google Chrome') : '',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
  ].filter(Boolean);

  return candidates.find(isExistingFile) || '';
}

function buildLaunchOptions({ browserExecutablePath = '', headless = false } = {}) {
  const executablePath = findBrowserExecutable(browserExecutablePath);
  const options = {
    headless: Boolean(headless),
    viewport: null,
    locale: 'zh-CN',
    acceptDownloads: false,
    chromiumSandbox: true,
  };
  if (executablePath) options.executablePath = executablePath;
  return options;
}

function isProcessAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error && error.code === 'EPERM';
  }
}

function readLockOwner(lockDir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(lockDir, 'owner.json'), 'utf8'));
  } catch (error) {
    return null;
  }
}

function removeStaleLocalLock(lockDir) {
  const owner = readLockOwner(lockDir);
  if (!owner || owner.hostname !== os.hostname() || isProcessAlive(Number(owner.pid))) {
    return { removed: false, owner };
  }
  try {
    fs.rmSync(lockDir, { recursive: true, force: false });
    return { removed: true, owner };
  } catch (error) {
    return { removed: false, owner };
  }
}

function acquireProfileLock(userDataDir, options = {}) {
  const profileDir = assertNativeAbsolutePath(userDataDir, 'browserUserDataDir');
  fs.mkdirSync(path.dirname(profileDir), { recursive: true });
  const requestedSuffix = String(options.lockSuffix || '.e007.lock').trim().toLowerCase();
  const lockSuffix = /^\.[a-z0-9_-]+\.lock$/.test(requestedSuffix) ? requestedSuffix : '.e007.lock';
  const profileLabel = String(options.profileLabel || '1688').trim() || '1688';
  const lockDir = `${profileDir}${lockSuffix}`;
  const token = randomUUID();
  const ownerRole = options.ownerRole === 'login' ? 'login' : 'download';
  const owner = {
    pid: process.pid,
    hostname: os.hostname(),
    createdAt: new Date().toISOString(),
    ownerRole,
    token,
  };

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      fs.mkdirSync(lockDir, { recursive: false });
      try {
        fs.writeFileSync(
          path.join(lockDir, 'owner.json'),
          JSON.stringify(owner, null, 2),
          { encoding: 'utf8', flag: 'wx' },
        );
      } catch (error) {
        fs.rmSync(lockDir, { recursive: true, force: true });
        throw error;
      }

      let released = false;
      return {
        profileDir,
        lockDir,
        owner,
        release() {
          if (released) return;
          released = true;
          const currentOwner = readLockOwner(lockDir);
          if (!currentOwner || currentOwner.token !== token) return;
          fs.rmSync(lockDir, { recursive: true, force: true });
        },
      };
    } catch (error) {
      if (!error || error.code !== 'EEXIST') throw error;
      const stale = removeStaleLocalLock(lockDir);
      if (stale.removed && attempt === 0) continue;
      const currentOwner = stale.owner || readLockOwner(lockDir) || {};
      throw new ProfileBusyError(`The dedicated ${profileLabel} browser profile is already in use.`, {
        lockDir,
        ownerPid: Number.isSafeInteger(Number(currentOwner.pid)) ? Number(currentOwner.pid) : null,
        ownerHostname: currentOwner.hostname || '',
        ownerCreatedAt: currentOwner.createdAt || '',
      });
    }
  }

  throw new ProfileBusyError(`The dedicated ${profileLabel} browser profile is already in use.`, { lockDir });
}

function bindContextLockLifecycle(context, lock) {
  let settled = false;
  let resolveClosed;
  const closed = new Promise((resolve) => {
    resolveClosed = resolve;
  });
  const release = (reason = 'session_close') => {
    if (settled) return;
    settled = true;
    try {
      lock.release();
    } finally {
      resolveClosed({ reason });
    }
  };
  context.once('close', () => release('context_closed'));
  return { closed, release };
}

function loadPlaywright() {
  try {
    return require('playwright');
  } catch (error) {
    const wrapped = new Error(
      'Playwright is not installed or cannot be resolved. Install it in the n8n runtime before running E007.',
    );
    wrapped.code = 'PLAYWRIGHT_NOT_INSTALLED';
    wrapped.cause = error;
    throw wrapped;
  }
}

function isMissingBrowserExecutableError(error) {
  return /Executable doesn't exist|playwright install|browserType\.launchPersistentContext/i.test(
    String(error && (error.message || error.stack) || error),
  );
}

async function createBrowserSession({
  userDataDir,
  browserExecutablePath = '',
  headless = false,
  ownerRole = 'download',
}) {
  const lock = acquireProfileLock(userDataDir, { ownerRole });
  let context;
  try {
    fs.mkdirSync(lock.profileDir, { recursive: true });
    const { chromium } = loadPlaywright();
    const launchOptions = buildLaunchOptions({ browserExecutablePath, headless });
    try {
      context = await chromium.launchPersistentContext(lock.profileDir, launchOptions);
    } catch (error) {
      if (!launchOptions.executablePath && isMissingBrowserExecutableError(error)) {
        const wrapped = new Error(
          'No usable Chrome/Edge/Chromium executable was found. Install a browser, set browserExecutablePath, or run npx playwright install chromium.',
        );
        wrapped.code = 'BROWSER_EXECUTABLE_MISSING';
        wrapped.cause = error;
        throw wrapped;
      }
      throw error;
    }

    const page = context.pages()[0] || await context.newPage();
    const lifecycle = bindContextLockLifecycle(context, lock);
    let closeRequested = false;
    return {
      context,
      page,
      profileDir: lock.profileDir,
      profileStatus: 'in_use',
      headless: Boolean(headless),
      ownerRole: lock.owner.ownerRole,
      closed: lifecycle.closed,
      async close() {
        if (closeRequested) return lifecycle.closed;
        closeRequested = true;
        try {
          await context.close();
        } finally {
          lifecycle.release('session_close');
        }
        return lifecycle.closed;
      },
    };
  } catch (error) {
    if (context) {
      try {
        await context.close();
      } catch (closeError) {}
    }
    lock.release();
    throw error;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function detect1688AccessState(page) {
  if (!page || page.isClosed()) {
    return { blocked: true, kind: 'browser_closed', title: '', url: '' };
  }

  const url = page.url();
  const title = await page.title().catch(() => '');
  const urlBlocked = /(?:login|passport|signin|captcha|verify|sec(?:urity)?)[./_-]/i.test(url) ||
    /(?:login|captcha|verify|security-check)/i.test(new URL(url || 'about:blank').pathname);

  const state = await page.evaluate(() => {
    const visible = (element) => {
      if (!element) return false;
      const style = window.getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 2 && rect.height > 2;
    };
    const strongSelectors = [
      'iframe[src*="captcha" i]',
      'iframe[src*="verify" i]',
      '[id*="captcha" i]',
      '[class*="captcha" i]',
      '[class*="nc-container" i]',
      '[id*="nocaptcha" i]',
      '[class*="verify-dialog" i]',
      '[class*="security-check" i]',
    ];
    const selectorHit = strongSelectors.some((selector) =>
      Array.from(document.querySelectorAll(selector)).some(visible));
    const bodyText = String(document.body && document.body.innerText || '').slice(0, 100000);
    const challengeText = /请完成(?:安全)?验证|安全验证|拖动.{0,12}滑块|滑块验证|请输入验证码|访问过于频繁|操作过于频繁|异常访问|账号存在风险|检测到异常|人机验证|验证码错误/i.test(bodyText);
    const loginText = /请登录后继续|登录后查看|账号登录|密码登录|短信登录/i.test(bodyText);
    const productMarker = Boolean(
      document.querySelector('[class*="offer" i], [id*="offer" i], [class*="detail" i], meta[property="og:title"]') ||
      Array.from(document.images).some((image) => (image.naturalWidth || 0) >= 400 && (image.naturalHeight || 0) >= 300)
    );
    return { selectorHit, challengeText, loginText, productMarker };
  }).catch(() => ({ selectorHit: false, challengeText: false, loginText: false, productMarker: false }));

  let kind = '';
  if (state.selectorHit || state.challengeText) kind = 'security_verification';
  else if (urlBlocked || (state.loginText && !state.productMarker)) kind = 'login_required';

  return {
    blocked: Boolean(kind),
    kind,
    title,
    url,
    hasProductMarker: Boolean(state.productMarker),
  };
}

async function waitForHumanVerification({
  page,
  timeoutMs = DEFAULT_HUMAN_VERIFICATION_TIMEOUT_MS,
  pollMs = DEFAULT_HUMAN_VERIFICATION_POLL_MS,
  screenshotPath = '',
  detect = detect1688AccessState,
}) {
  const firstState = await detect(page);
  if (!firstState.blocked) {
    return {
      required: false,
      resolved: true,
      status: 'not_required',
      kind: '',
      waitedMs: 0,
      screenshotPath: '',
    };
  }

  try {
    await page.bringToFront();
  } catch (error) {}

  const startedAt = Date.now();
  const deadline = startedAt + Math.max(1000, Number(timeoutMs) || DEFAULT_HUMAN_VERIFICATION_TIMEOUT_MS);
  while (Date.now() < deadline) {
    await sleep(Math.max(250, Number(pollMs) || DEFAULT_HUMAN_VERIFICATION_POLL_MS));
    const current = await detect(page);
    if (!current.blocked) {
      return {
        required: true,
        resolved: true,
        status: 'completed',
        kind: firstState.kind,
        waitedMs: Date.now() - startedAt,
        screenshotPath: '',
      };
    }
  }

  let savedScreenshotPath = '';
  if (screenshotPath && !page.isClosed()) {
    try {
      fs.mkdirSync(path.dirname(screenshotPath), { recursive: true });
      await page.screenshot({ path: screenshotPath, fullPage: false });
      savedScreenshotPath = screenshotPath;
    } catch (error) {}
  }

  return {
    required: true,
    resolved: false,
    status: 'timeout',
    kind: firstState.kind,
    waitedMs: Date.now() - startedAt,
    screenshotPath: savedScreenshotPath,
  };
}

module.exports = {
  DEFAULT_HUMAN_VERIFICATION_POLL_MS,
  DEFAULT_HUMAN_VERIFICATION_TIMEOUT_MS,
  ProfileBusyError,
  acquireProfileLock,
  assertNativeAbsolutePath,
  bindContextLockLifecycle,
  buildLaunchOptions,
  createBrowserSession,
  detect1688AccessState,
  findBrowserExecutable,
  isPortableAbsolutePath,
  normalizePathInput,
  pathFlavor,
  sleep,
  waitForHumanVerification,
};
