'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  evaluateWithNavigationRetry,
  isNavigationContextError,
} = require('../playwright-navigation-retry.cjs');

function fakePage(evaluateResults) {
  const calls = { evaluate: 0, waitForLoadState: 0 };
  return {
    calls,
    async evaluate() {
      const result = evaluateResults[calls.evaluate++];
      if (result instanceof Error) throw result;
      return result;
    },
    async waitForLoadState(state, options) {
      calls.waitForLoadState += 1;
      assert.equal(state, 'domcontentloaded');
      assert.equal(options.timeout, 10000);
    },
  };
}

test('retries page evaluation after navigation and waits for DOM readiness', async () => {
  const page = fakePage([
    new Error('page.evaluate: Execution context was destroyed, most likely because of a navigation'),
    { ok: true },
  ]);
  let retries = 0;
  const result = await evaluateWithNavigationRetry(page, () => true, undefined, {
    maxAttempts: 3,
    loadTimeoutMs: 10000,
    stableMs: 0,
    onRetry: () => { retries += 1; },
  });
  assert.deepEqual(result, { ok: true });
  assert.equal(page.calls.evaluate, 2);
  assert.equal(page.calls.waitForLoadState, 1);
  assert.equal(retries, 1);
});

test('does not retry ordinary page evaluation errors', async () => {
  const page = fakePage([new Error('ReferenceError: missingVariable is not defined')]);
  await assert.rejects(
    evaluateWithNavigationRetry(page, () => true, undefined, { stableMs: 0 }),
    /missingVariable/,
  );
  assert.equal(page.calls.evaluate, 1);
  assert.equal(page.calls.waitForLoadState, 0);
});

test('returns navigation_not_settled after three failed attempts', async () => {
  const page = fakePage(Array.from({ length: 3 }, () => new Error('Cannot find context with specified id')));
  await assert.rejects(
    evaluateWithNavigationRetry(page, () => true, undefined, { maxAttempts: 3, stableMs: 0 }),
    (error) => error.code === 'navigation_not_settled' && error.retryCount === 2,
  );
  assert.equal(page.calls.evaluate, 3);
  assert.equal(page.calls.waitForLoadState, 2);
});

test('recognizes only known navigation context errors', () => {
  assert.equal(isNavigationContextError(new Error('Frame was detached')), true);
  assert.equal(isNavigationContextError(new Error('Target page, context or browser has been closed')), false);
});
