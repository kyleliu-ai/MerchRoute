#!/usr/bin/env node
'use strict';

const readline = require('readline');

const {
  ProfileBusyError,
  createBrowserSession,
  detect1688AccessState,
  normalizePathInput,
} = require('./1688-browser-session.cjs');

const DEFAULT_URL = 'https://www.1688.com/';
const DEFAULT_PROFILE_DIR = 'D:/n8n-browser-profile/1688';
const DEFAULT_CHROME_EXECUTABLE_PATH = 'C:/Program Files/Google/Chrome/Application/chrome.exe';

function tryDecodeBase64Json(value) {
  try {
    const parsed = JSON.parse(Buffer.from(String(value || ''), 'base64').toString('utf8'));
    return parsed && !Array.isArray(parsed) && typeof parsed === 'object' ? parsed : null;
  } catch (error) {
    return null;
  }
}

function parseLoginArgs(argv = process.argv.slice(2)) {
  const encoded = tryDecodeBase64Json(argv[0]);
  const params = encoded || {
    productUrl: argv[0],
    browserUserDataDir: argv[1],
    browserExecutablePath: argv[2],
  };
  return {
    productUrl: String(params.productUrl || DEFAULT_URL).trim(),
    browserUserDataDir: normalizePathInput(params.browserUserDataDir || DEFAULT_PROFILE_DIR),
    browserExecutablePath: normalizePathInput(params.browserExecutablePath || DEFAULT_CHROME_EXECUTABLE_PATH),
  };
}

function validate1688Url(value) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch (error) {
    throw new Error('productUrl must be a valid absolute URL.');
  }
  const hostname = parsed.hostname.toLowerCase().replace(/\.$/, '');
  if (!['http:', 'https:'].includes(parsed.protocol) || (hostname !== '1688.com' && !hostname.endsWith('.1688.com'))) {
    throw new Error('productUrl must be an HTTP(S) URL on 1688.com or one of its subdomains.');
  }
  if (parsed.username || parsed.password) throw new Error('productUrl must not contain embedded credentials.');
  parsed.hash = '';
  return parsed.toString();
}

function createEnterPrompt({ input = process.stdin, output = process.stderr } = {}) {
  let settled = false;
  let resolvePrompt;
  const terminal = readline.createInterface({ input, output });
  const promise = new Promise((resolve) => {
    resolvePrompt = resolve;
    terminal.question('\n登录或验证完成后，请回到此终端按 Enter，脚本将关闭 Chrome 并保存 Profile。\n', () => {
      if (settled) return;
      settled = true;
      terminal.close();
      resolve({ kind: 'enter' });
    });
  });
  return {
    promise,
    cancel() {
      if (settled) return;
      settled = true;
      terminal.close();
      resolvePrompt({ kind: 'cancelled' });
    },
  };
}

async function waitForLoginCompletion(session, prompt) {
  const outcome = await Promise.race([
    prompt.promise,
    session.closed.then(() => ({ kind: 'browser_closed' })),
  ]);
  if (outcome.kind === 'browser_closed') prompt.cancel();
  return outcome;
}

function loginResult(overrides = {}) {
  return {
    success: false,
    status: 'not_started',
    httpStatus: 500,
    platform: '1688',
    browserChannel: 'chrome',
    browserRunMode: 'headed',
    profileStatus: 'not_started',
    browserProfileBusy: false,
    errors: [],
    warnings: [],
    ...overrides,
  };
}

async function runLogin(argv = process.argv.slice(2)) {
  const params = parseLoginArgs(argv);
  let productUrl;
  try {
    productUrl = validate1688Url(params.productUrl);
  } catch (error) {
    return loginResult({ status: 'validation_error', httpStatus: 400, errors: [error.message] });
  }

  if (!process.stdin.isTTY) {
    return loginResult({
      status: 'interactive_terminal_required',
      httpStatus: 400,
      errors: ['1688-login.cjs must run in an interactive terminal.'],
    });
  }

  let session;
  let prompt;
  let interruptedSignal = '';
  const signalHandlers = new Map();
  try {
    session = await createBrowserSession({
      userDataDir: params.browserUserDataDir,
      browserExecutablePath: params.browserExecutablePath,
      headless: false,
      ownerRole: 'login',
    });
  } catch (error) {
    if (error instanceof ProfileBusyError || error.code === 'PROFILE_BUSY') {
      return loginResult({
        status: 'profile_busy',
        httpStatus: 409,
        profileStatus: 'busy',
        browserProfileBusy: true,
        errors: ['The dedicated 1688 Chrome profile is already in use.'],
      });
    }
    return loginResult({
      status: 'browser_launch_failed',
      httpStatus: 500,
      profileStatus: 'launch_failed',
      errors: [`Cannot start the visible persistent Chrome browser: ${error.message || String(error)}`],
    });
  }

  const result = loginResult({ profileStatus: 'in_use' });
  try {
    await session.page.goto(productUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await session.page.bringToFront().catch(() => {});
    process.stderr.write('\nE007 已打开 headed Chrome 专用 Profile。\n');
    process.stderr.write(`用户数据目录：${params.browserUserDataDir}\n`);
    process.stderr.write(`Chrome 程序：${params.browserExecutablePath}\n`);
    process.stderr.write('请仅手工完成登录或平台验证；脚本不会自动填写验证码或绕过安全验证。\n');
    prompt = createEnterPrompt();
    for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
      const handler = () => {
        interruptedSignal = signal;
        prompt.cancel();
        void session.close();
      };
      signalHandlers.set(signal, handler);
      process.once(signal, handler);
    }
    const completion = await waitForLoginCompletion(session, prompt);
    if (interruptedSignal || completion.kind === 'cancelled') {
      result.status = 'interrupted';
      result.httpStatus = 499;
      result.errors.push(`Manual login session was interrupted${interruptedSignal ? ` by ${interruptedSignal}` : ''}.`);
      process.exitCode = 130;
    } else if (completion.kind === 'browser_closed') {
      result.success = true;
      result.status = 'profile_saved_unverified';
      result.httpStatus = 200;
      result.warnings.push('Chrome was closed directly. Profile changes were saved, but the 1688 login state was not revalidated.');
    } else {
      const state = await detect1688AccessState(session.page);
      if (state.blocked) {
        result.status = 'verification_still_present';
        result.httpStatus = 409;
        result.errors.push('The page still shows login or security verification after manual confirmation.');
      } else {
        result.success = true;
        result.status = 'login_saved';
        result.httpStatus = 200;
      }
    }
  } catch (error) {
    result.status = 'login_page_error';
    result.httpStatus = 502;
    result.errors.push(`Could not complete the manual login session: ${error.message || String(error)}`);
  } finally {
    if (prompt) prompt.cancel();
    for (const [signal, handler] of signalHandlers) process.removeListener(signal, handler);
    try {
      await session.close();
      result.profileStatus = 'released';
    } catch (error) {
      result.profileStatus = 'released_with_close_warning';
      result.warnings.push('Chrome reported an error while closing; the profile lock was released.');
    }
  }
  return result;
}

if (require.main === module) {
  runLogin()
    .then((result) => process.stdout.write(`${JSON.stringify(result)}\n`))
    .catch((error) => process.stdout.write(`${JSON.stringify(loginResult({
      status: 'internal_error',
      httpStatus: 500,
      errors: [`Fatal login helper error: ${error.message || String(error)}`],
    }))}\n`));
}

module.exports = {
  DEFAULT_CHROME_EXECUTABLE_PATH,
  DEFAULT_PROFILE_DIR,
  createEnterPrompt,
  loginResult,
  parseLoginArgs,
  runLogin,
  tryDecodeBase64Json,
  validate1688Url,
  waitForLoginCompletion,
};
