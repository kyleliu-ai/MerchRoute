'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { decodePayload, profileLockSuffix } = require('../browser-profile-smoke.cjs');

test('dedicated PDD and 1688 profiles use different downloader lock contracts', () => {
  assert.equal(profileLockSuffix('pdd'), '.pdd.lock');
  assert.equal(profileLockSuffix('1688'), '.e007.lock');
  assert.notEqual(profileLockSuffix('pdd'), profileLockSuffix('1688'));
});

test('profile smoke payload is transported without shell interpolation', () => {
  const input = { profileId: '1688', userDataDir: '/Users/example/Application Support/MerchRoute/browser-profiles/1688' };
  const encoded = Buffer.from(JSON.stringify(input), 'utf8').toString('base64');
  assert.deepEqual(decodePayload(encoded), input);
});

test('unknown profile identities fail closed', () => {
  assert.throws(() => profileLockSuffix('default'), /pdd or 1688/);
});
