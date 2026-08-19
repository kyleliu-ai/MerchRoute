import path from 'node:path';
import { access, mkdir, readFile } from 'node:fs/promises';
import { chromium } from '@playwright/test';
import sharp from 'sharp';

const projectRoot = path.resolve(import.meta.dirname, '..');
const e2eRoot = path.join(projectRoot, '.e2e-data');
const baseUrl = process.env.MERCHROUTE_SCREENSHOT_BASE_URL || 'http://127.0.0.1:4183';
const outputDir = path.join(projectRoot, 'docs', 'assets', 'ui');

const views = [
  { file: 'overview.webp', route: '/', readyText: '产品图片审核与投递' },
  { file: 'procurement.webp', route: '/purchases', readyText: '采购管理' },
  { file: 'media-review.webp', route: '/review/E003', readyText: '重新扫描' },
  { file: 'wb-listing.webp', route: '/listing/wb?view=auto', readyText: 'WB上品' },
  { file: 'ozon-listing.webp', route: '/listing/ozon?view=auto', readyText: 'OZON 上品' },
  { file: 'pricing.webp', route: '/pricing', readyText: '商品售价计算' },
  { file: 'shipping.webp', route: '/shipping', readyText: '运费计算' },
  { file: 'settings.webp', route: '/settings', readyText: '系统设置' },
  { file: 'notifications.webp', route: '/notifications', readyText: '消息中心' },
];

await assertIsolatedE2eServer();
await mkdir(outputDir, { recursive: true });

const browser = await chromium.launch({ headless: true });
try {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 960 },
    deviceScaleFactor: 1,
    colorScheme: 'light',
    locale: 'zh-CN',
    timezoneId: 'Asia/Shanghai',
  });
  const page = await context.newPage();
  await page.route('**/api/v1/**', async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === '/api/v1/media-index/events') {
      await route.fulfill({ status: 204, body: '' });
      return;
    }
    const response = await route.fetch();
    const contentType = response.headers()['content-type'] || '';
    if (!contentType.includes('application/json')) {
      await route.fulfill({ response });
      return;
    }
    const body = sanitizeJson(await response.json());
    await route.fulfill({
      response,
      contentType: 'application/json',
      body: JSON.stringify(body),
    });
  });

  for (const view of views) {
    await page.goto(new URL(view.route, baseUrl).toString(), { waitUntil: 'domcontentloaded' });
    await page.getByText(view.readyText, { exact: true }).first().waitFor({ state: 'visible' });
    await page.waitForLoadState('networkidle').catch(() => undefined);
    await page.addStyleTag({ content: [
      '*, *::before, *::after { animation: none !important; transition: none !important; }',
      'body { caret-color: transparent !important; }',
    ].join('\n') });
    await page.evaluate(() => globalThis.scrollTo(0, 0));
    await page.waitForTimeout(250);
    const png = await page.screenshot({ fullPage: false, animations: 'disabled' });
    const target = path.join(outputDir, view.file);
    const result = await sharp(png).webp({ quality: 84, effort: 5 }).toFile(target);
    process.stdout.write(`${path.relative(projectRoot, target)} ${result.size} bytes\n`);
  }
  await context.close();
} finally {
  await browser.close();
}

async function assertIsolatedE2eServer() {
  await access(path.join(e2eRoot, 'database-schema.txt'));
  await access(path.join(e2eRoot, 'database-url.txt'));
  const schema = (await readFile(path.join(e2eRoot, 'database-schema.txt'), 'utf8')).trim();
  if (!/^[a-z][a-z0-9_]+$/.test(schema)) throw new Error('E2E database schema marker is invalid');
  const health = await fetch(new URL('/api/v1/health', baseUrl));
  if (!health.ok) throw new Error(`E2E server health check failed: HTTP ${health.status}`);
  if (new URL(baseUrl).port !== '4183') throw new Error('README screenshots may only use the isolated E2E port 4183');
}

function sanitizeJson(value) {
  if (Array.isArray(value)) return value.map(sanitizeJson);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, sanitizeJson(child)]));
  }
  if (typeof value !== 'string') return value;
  const windowsRoot = projectRoot.replaceAll('/', '\\');
  const posixRoot = projectRoot.replaceAll('\\', '/');
  return value
    .replaceAll(`${windowsRoot}\\.e2e-data\\roots`, 'D:\\MerchRouteData')
    .replaceAll(`${windowsRoot}\\.e2e-data\\downloads`, 'D:\\MerchRouteData\\downloads')
    .replaceAll(`${posixRoot}/.e2e-data/roots`, '/Users/demo/Documents/MerchRouteData')
    .replaceAll(`${posixRoot}/.e2e-data/downloads`, '/Users/demo/Documents/MerchRouteData/downloads')
    .replaceAll(windowsRoot, 'C:\\MerchRoute')
    .replaceAll(posixRoot, '/Users/demo/Developer/MerchRoute');
}
