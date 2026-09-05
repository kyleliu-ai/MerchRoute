import { defineConfig, devices } from '@playwright/test';
export default defineConfig({
  testDir: './tests/e2e', testMatch: ['ozon-retry.spec.ts', 'ozon-listing.spec.ts'], workers: 1, timeout: 30_000,
  grep: /retry is not|rebuilding requires|lost response|retry remains|duplicate card|自动任务深链和显式入口|纯 legacy 自动任务|publication 自动任务/,
  use: { baseURL: 'http://127.0.0.1:4183', trace: 'retain-on-failure', screenshot: 'only-on-failure' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: { command: 'node scripts/serve-ozon-retry-test.mjs', url: 'http://127.0.0.1:4183', reuseExistingServer: false, timeout: 15_000 }
});
