'use strict';

const NAVIGATION_CONTEXT_ERROR = /Execution context was destroyed|Cannot find context with specified id|Inspected target navigated or closed|frame was detached|Frame was detached/i;

function isNavigationContextError(error) {
  return NAVIGATION_CONTEXT_ERROR.test(String(error && (error.message || error.stack) || error));
}

async function waitForNavigationToSettle(page, options = {}) {
  const loadTimeoutMs = Number.isFinite(options.loadTimeoutMs) ? options.loadTimeoutMs : 10000;
  const stableMs = Number.isFinite(options.stableMs) ? options.stableMs : 300;
  await page.waitForLoadState('domcontentloaded', { timeout: loadTimeoutMs }).catch(() => undefined);
  if (stableMs > 0) await new Promise((resolve) => setTimeout(resolve, stableMs));
}

async function evaluateWithNavigationRetry(page, pageFunction, arg, options = {}) {
  const maxAttempts = Number.isInteger(options.maxAttempts) ? Math.max(1, options.maxAttempts) : 3;
  let lastError;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await page.evaluate(pageFunction, arg);
    } catch (error) {
      if (!isNavigationContextError(error)) throw error;
      lastError = error;
      if (attempt >= maxAttempts) break;
      if (typeof options.onRetry === 'function') {
        options.onRetry({ attempt, error });
      }
      await waitForNavigationToSettle(page, options);
    }
  }

  const error = new Error(`navigation_not_settled: page did not settle after ${maxAttempts} attempts: ${String(lastError && lastError.message || lastError)}`);
  error.code = 'navigation_not_settled';
  error.retryCount = Math.max(0, maxAttempts - 1);
  error.cause = lastError;
  throw error;
}

module.exports = {
  evaluateWithNavigationRetry,
  isNavigationContextError,
  waitForNavigationToSettle,
};
