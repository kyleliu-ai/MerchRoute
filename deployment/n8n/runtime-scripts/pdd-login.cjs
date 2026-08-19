#!/usr/bin/env node
'use strict';

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');

const DEFAULT_PRODUCT_URL = 'https://mobile.yangkeduo.com/';
const DEFAULT_CHROME_USER_DATA_DIR = 'D:/n8n-browser-profile/pdd';
const DEFAULT_CHROME_EXECUTABLE_PATH = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const DEFAULT_PROFILE_DIRECTORY = 'Default';

const productUrl = validatePddUrl(process.argv[2] || DEFAULT_PRODUCT_URL);
const userDataDir = normalizePathInput(process.argv[3] || DEFAULT_CHROME_USER_DATA_DIR);
const executablePath = normalizePathInput(process.argv[4] || DEFAULT_CHROME_EXECUTABLE_PATH);
const profileDirectory = sanitizeProfileDirectory(process.argv[5] || DEFAULT_PROFILE_DIRECTORY)
  || DEFAULT_PROFILE_DIRECTORY;

function normalizePathInput(value) {
  return String(value || '')
    .trim()
    .replace(/^"(.*)"$/, '$1')
    .replace(/^'(.*)'$/, '$1')
    .replace(/\\/g, '/');
}

function sanitizeProfileDirectory(value) {
  const text = String(value || '').trim();
  if (!text || /[\\/:*?"<>|\x00-\x1F]/.test(text) || text === '.' || text === '..') return '';
  return text.slice(0, 80);
}

function validatePddUrl(value) {
  let parsed;
  try {
    parsed = new URL(String(value || '').trim());
  } catch (error) {
    throw new Error('URL 必须是有效的拼多多 HTTP(S) 地址。');
  }
  const hostname = parsed.hostname.toLowerCase().replace(/\.$/, '');
  if (!['http:', 'https:'].includes(parsed.protocol) || (hostname !== 'yangkeduo.com' && !hostname.endsWith('.yangkeduo.com'))) {
    throw new Error('URL 必须属于 yangkeduo.com。');
  }
  if (parsed.username || parsed.password) throw new Error('URL 不能包含用户名或密码。');
  parsed.hash = '';
  return parsed.toString();
}

function waitForEnter() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question('\n登录完成并手动关闭此专用 Chrome 窗口后，按 Enter 继续...\n', () => {
      rl.close();
      resolve();
    });
  });
}

async function main() {
  if (!fs.existsSync(executablePath)) {
    throw new Error(`Google Chrome executable was not found: ${executablePath}`);
  }
  fs.mkdirSync(userDataDir, { recursive: true });

  const args = [
    `--user-data-dir=${userDataDir}`,
    `--profile-directory=${profileDirectory}`,
    '--new-window',
    productUrl,
  ];

  console.log('即将用普通 Google Chrome 打开拼多多登录页。');
  console.log('不会使用 Playwright，不会开启远程调试，不会自动填写或绕过验证码。');
  console.log('Chrome 程序:', executablePath);
  console.log('用户数据目录:', userDataDir);
  console.log('Profile:', profileDirectory);
  console.log('URL:', productUrl);
  console.log('');
  console.log('请勿同时使用另一个窗口打开此 pdd 专用 Profile。登录完成后请手动关闭本窗口。');

  const child = spawn(executablePath, args, {
    detached: true,
    stdio: 'ignore',
    windowsHide: false,
  });
  child.unref();

  await waitForEnter();

  const cookieDb = path.join(userDataDir, profileDirectory, 'Network', 'Cookies');
  console.log('');
  console.log(fs.existsSync(cookieDb)
    ? `已检测到 Cookie 数据库: ${cookieDb}`
    : `尚未检测到 Cookie 数据库: ${cookieDb}`);
  console.log('现在可以重新运行 E006。');
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error.stack || error.message || String(error));
    process.exit(1);
  });
}

module.exports = {
  DEFAULT_CHROME_EXECUTABLE_PATH,
  DEFAULT_CHROME_USER_DATA_DIR,
  DEFAULT_PROFILE_DIRECTORY,
  normalizePathInput,
  sanitizeProfileDirectory,
  validatePddUrl,
};
