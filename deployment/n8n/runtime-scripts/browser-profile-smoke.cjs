#!/usr/bin/env node
'use strict';

const {
  acquireProfileLock,
  assertNativeAbsolutePath,
  buildLaunchOptions,
  findBrowserExecutable,
} = require('./1688-browser-session.cjs');

const PROFILE_IDS = new Set(['pdd', '1688']);

function decodePayload(value) {
  const text = Buffer.from(String(value || ''), 'base64').toString('utf8');
  const parsed = JSON.parse(text);
  if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') throw new Error('Smoke payload must be an object.');
  return parsed;
}

function profileLockSuffix(profileId) {
  if (profileId === 'pdd') return '.pdd.lock';
  if (profileId === '1688') return '.e007.lock';
  throw new Error('profileId must be pdd or 1688.');
}

function normalizeSmokeParams(input) {
  const profileId = String(input?.profileId || '').trim().toLowerCase();
  if (!PROFILE_IDS.has(profileId)) throw new Error('profileId must be pdd or 1688.');
  const userDataDir = assertNativeAbsolutePath(input?.userDataDir, 'userDataDir');
  const browserExecutablePath = findBrowserExecutable(input?.browserExecutablePath || '');
  if (!browserExecutablePath) throw new Error('Google Chrome executable was not found.');
  return { profileId, userDataDir, browserExecutablePath };
}

async function runSmoke(input) {
  const params = normalizeSmokeParams(input);
  const { chromium } = require('playwright');
  const lock = acquireProfileLock(params.userDataDir, {
    lockSuffix: profileLockSuffix(params.profileId),
    ownerRole: 'deployment-headless-smoke',
    profileLabel: params.profileId,
  });
  let context;
  try {
    context = await chromium.launchPersistentContext(lock.profileDir, {
      ...buildLaunchOptions({ browserExecutablePath: params.browserExecutablePath, headless: true }),
      args: ['--profile-directory=Default'],
    });
    const page = context.pages()[0] || await context.newPage();
    await page.goto('data:text/html,<title>MerchRoute%20Profile%20Smoke</title>', { waitUntil: 'load', timeout: 15_000 });
    const title = await page.title();
    if (title !== 'MerchRoute Profile Smoke') throw new Error('Offline headless page did not load as expected.');
    return {
      success: true,
      status: 'headless_profile_reuse_verified',
      profileId: params.profileId,
      headless: true,
      offline: true,
      cookieValuesRead: false,
    };
  } finally {
    if (context) await context.close().catch(() => undefined);
    lock.release();
  }
}

if (require.main === module) {
  Promise.resolve()
    .then(() => runSmoke(decodePayload(process.argv[2])))
    .then((result) => process.stdout.write(`${JSON.stringify(result)}\n`))
    .catch((error) => {
      process.stdout.write(`${JSON.stringify({
        success: false,
        status: error?.code || 'headless_profile_reuse_failed',
        headless: true,
        offline: true,
        cookieValuesRead: false,
      })}\n`);
      process.exitCode = 1;
    });
}

module.exports = {
  decodePayload,
  normalizeSmokeParams,
  profileLockSuffix,
  runSmoke,
};
