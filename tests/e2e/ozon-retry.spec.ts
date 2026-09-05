import { expect, test, type Page } from '@playwright/test';
import { createDefaultConfig } from '@n8n-media-review/shared';

const jobId = '11111111-1111-4111-8111-111111111111';
const storeId = '22222222-2222-4222-8222-222222222222';
const nextId = '33333333-3333-4333-8333-333333333333';
const job = { id: jobId, sku: '9900171', source: 'AUTO', state: 'NEEDS_ATTENTION', storeId, storeAlias: 'fixture',
  publicationId: '44444444-4444-4444-8444-444444444444', taskKind: 'STORE_PUBLICATION', rowVersion: 2,
  offerIds: ['9900171-01'], stageStates: { import: 'FAILED' }, lastErrorMessage: '上品暂时失败', retryCount: 0,
  payload: {}, events: [], createdAt: '2026-09-05T00:00:00Z', updatedAt: '2026-09-05T00:00:00Z' };

async function setup(page: Page, mode = 'RESUME', failFirst = false) {
  const requests: any[] = []; let latest: any; let polls = 0;
  const settings = { enabled: true, rowVersion: 1, rootDirectory: '/test-only', publicationReadbackEnabled: true };
  const readiness = { ready: true, mediaReady: true, databaseReady: true, issues: [], mediaIssues: [], settings };
  await page.route('**/*', route => new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort());
  await page.route('**/api/v1/**', async route => {
    const url = new URL(route.request().url()), pathname = url.pathname;
    const json = (value: any) => route.fulfill({ json: value });
    if (pathname.endsWith('/retry-plan')) {
      if (latest) polls++;
      return json({ plan: { canRetry: !latest, blockedReason: latest ? '已有重试正在执行' : undefined,
        planHash: 'sha256:' + 'a'.repeat(64), sourceJobId: jobId, storeId, storeName: '测试店铺', sku: job.sku,
        mode, requiresConfirmation: mode === 'REBUILD', stage: '核对平台结果后继续', previousError: '上品暂时失败', offerIds: job.offerIds,
        changes: [{ label: '预设版本', previous: '1', current: '2' }], latest: latest && { ...latest, ...(polls > 1 ? { status: 'RUNNING', message: '正在继续设置库存', effectiveJobId: nextId } : {}) } } });
    }
    if (pathname.endsWith('/retry') && route.request().method() === 'POST') {
      requests.push(route.request().postDataJSON());
      latest = { id: 'retry', requestId: requests[0].requestId, sourceJobId: jobId, storeId, sku: job.sku, mode, status: 'CHECKING', stage: 'CHECKING', message: '正在检查重试条件', previousError: '上品暂时失败', errorCode: '', createdAt: '2026-09-05T00:00:00Z', updatedAt: '2026-09-05T00:00:00Z' };
      if (failFirst && requests.length === 1) return route.abort('connectionfailed');
      return route.fulfill({ status: 202, json: { retry: latest, idempotent: requests.length > 1 } });
    }
    if (route.request().method() !== 'GET') return route.fulfill({ status: 403, json: { error: { message: 'Unexpected write' } } });
    if (pathname === '/api/v1/config') return json({ config: createDefaultConfig(), readiness: { complete: true, stages: [] } });
    if (pathname === '/api/v1/stages') return json({ stages: [] });
    if (pathname === '/api/v1/ozon/automation/jobs') return json({ items: [job], total: 1, page: 1, pageSize: 30 });
    if (pathname === '/api/v1/ozon/automation/status') return json({ readiness, counts: { NEEDS_ATTENTION: 1 }, managementEnabled: true, acceptingNewJobs: true, worker: { running: false } });
    if (pathname === '/api/v1/ozon/stores') return json({ items: [{ id: storeId, displayName: '测试店铺', storeAlias: 'fixture',
      taskLoad: { running: 0, queued: 0 }, enabled: true, autoPublishEnabled: true, autoPublishMode: 'CREATE_ONLY',
      defaultPresetId: '55555555-5555-4555-8555-555555555555', warehouseId: '12345', warehouseName: '测试仓库', fulfillmentMode: 'FBS', accountCurrency: 'RUB', maxDailyStyles: 100,
      seller: { id: 'test-seller', name: '测试卖家' }, permissions: [], limits: { daily: 1000 }, warehouses: [], configVersion: 1, rowVersion: 1,
      credential: { state: 'ACTIVE', bindingMode: 'VAULT', configured: true, activeVersionId: '66666666-6666-4666-8666-666666666666', version: 1 },
      preflight: { status: 'PASSED', currencyVerified: true, currencyVerification: 'VERIFIED', expiresAt: '2099-01-01T00:00:00Z' },
      readiness: { ready: true, score: 100, blockers: [] }, network: { status: 'READY' } }], total: 1 });
    if (pathname.endsWith('/system')) return json(readiness);
    if (pathname.endsWith('/settings')) return json({ settings });
    if (pathname.endsWith('/' + jobId) || pathname.endsWith('/' + nextId)) return json({ job: { ...job, id: pathname.split('/').at(-1) } });
    if (pathname === '/api/v1/ozon/listings/' + job.sku) return json({ listing: { sku: job.sku, managementSource: 'AUTO', status: 'READY', data: { offers: [] } } });
    return json({ items: [], total: 0, unreadCount: 0 });
  });
  await page.goto('/listing/ozon?view=auto&job=' + jobId + '&store=' + storeId, { waitUntil: 'domcontentloaded' });
  await expect(page.getByRole('button', { name: '重试上品', exact: true })).toBeEnabled();
  return requests;
}

test('retry is not a success toast and progresses to a linked continuation task', async ({ page }) => {
  const requests = await setup(page);
  await page.getByRole('button', { name: '重试上品', exact: true }).click();
  await expect(page.getByText('重试上品已受理，正在检查并接续执行；尚未完成上品')).toBeVisible();
  await expect(page.getByRole('button', { name: '重试上品', exact: true })).toBeDisabled();
  await expect(page.getByText('正在继续设置库存')).toBeVisible({ timeout: 12_000 });
  expect(requests).toHaveLength(1); expect(requests[0].storeId).toBe(storeId); expect(requests[0].confirmRebuild).toBe(false);
  await page.getByRole('button', { name: '打开接续任务' }).click();
  await expect(page).toHaveURL(new RegExp(nextId));
});
test('rebuilding requires an explicit confirmation and cancel creates nothing', async ({ page }) => {
  const requests = await setup(page, 'REBUILD');
  await page.getByRole('button', { name: '重试上品', exact: true }).click();
  await expect(page.getByRole('dialog', { name: '确认重建当前店铺上品资料' })).toBeVisible();
  await expect(page.getByText('原冻结值')).toBeVisible(); expect(requests).toHaveLength(0);
  await page.getByRole('dialog', { name: '确认重建当前店铺上品资料' }).getByRole('button', { name: /取\s*消/ }).click(); expect(requests).toHaveLength(0);
  await page.getByRole('button', { name: '重试上品', exact: true }).click();
  await page.getByRole('button', { name: '确认并重试上品' }).click();
  await expect.poll(() => requests.length).toBe(1); expect(requests[0].confirmRebuild).toBe(true);
});
test('lost response reuses the original retry request ID', async ({ page }) => {
  const requests = await setup(page, 'RESUME', true);
  await page.getByRole('button', { name: '重试上品', exact: true }).click();
  await page.getByRole('button', { name: '确认重试受理结果' }).click();
  await expect.poll(() => requests.length).toBe(2);
  expect(requests[1]).toEqual(requests[0]);
});
test('retry remains usable at a narrow viewport', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await setup(page);
  const button = page.getByRole('button', { name: '重试上品', exact: true });
  await expect(button).toBeInViewport();
  await button.click();
  await expect(page.getByText('重试上品已受理，正在检查并接续执行；尚未完成上品')).toBeVisible();
  await page.screenshot({ path: test.info().outputPath('retry-narrow.png') });
});

test('duplicate card disables retry and supports read-only sync before stopping automation', async ({ page }) => {
  const publicationId = job.publicationId;
  const duplicateMessage = 'OZON 判定 9900171-01 与已有商品卡 0000143-01 类似或重复';
  let currentJob = {
    ...job,
    offerIds: ['9900171-01', '9900171-02'],
    importTaskId: '5570342576',
    lastErrorCode: 'OZON_IMPORT_PARTIAL_FAILED',
    lastErrorMessage: duplicateMessage,
    payload: {
      importFailures: [{
        offer_id: '9900171-01',
        errors: [{ code: 'SPU_ALREADY_EXISTS_IN_ANOTHER_ACCOUNT', message: duplicateMessage }]
      }]
    },
    ozonProductLinks: []
  };
  let publication = { id: publicationId, rowVersion: 9, status: 'NEEDS_ATTENTION' };
  const writes: Array<{ path: string; body: any }> = [];
  const settings = { enabled: true, rowVersion: 1, rootDirectory: '/test-only', publicationReadbackEnabled: true };
  const readiness = { ready: true, mediaReady: true, databaseReady: true, issues: [], mediaIssues: [], settings };
  await page.route('**/*', route => new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort());
  await page.route('**/api/v1/**', async route => {
    const url = new URL(route.request().url()), pathname = url.pathname;
    const method = route.request().method();
    const json = (value: any) => route.fulfill({ json: value });
    if (pathname.endsWith('/retry-plan')) return json({ plan: {
      canRetry: false,
      blockedReason: `商品卡重复：${duplicateMessage}。请在 OZON 后台处理后同步平台状态，或取消自动任务。`,
      blockerCode: 'OZON_DUPLICATE_PRODUCT_CARD',
      blockedOffers: [{
        offerId: '9900171-01', errorCodes: ['SPU_ALREADY_EXISTS_IN_ANOTHER_ACCOUNT'],
        platformMessage: duplicateMessage, conflictOfferIds: ['0000143-01']
      }],
      planHash: 'sha256:' + 'a'.repeat(64), sourceJobId: jobId, storeId, storeName: '测试店铺', sku: job.sku,
      mode: 'READBACK', requiresConfirmation: false, stage: '核对平台结果后继续', previousError: duplicateMessage,
      offerIds: currentJob.offerIds, changes: []
    } });
    if (pathname === `/api/v1/ozon/publications/${publicationId}/platform-status/refresh` && method === 'POST') {
      const body = route.request().postDataJSON();
      writes.push({ path: pathname, body });
      expect(body).toMatchObject({ rowVersion: 9 });
      expect(body.requestId).toMatch(/^[a-f0-9-]{36}$/);
      publication = { ...publication, rowVersion: 10 };
      currentJob = {
        ...currentJob,
        ozonProductLinks: [
          { offerId: '9900171-01', ozonProductId: '501', ozonSku: '9001', url: 'https://www.ozon.ru/product/9001/', displayState: 'ARCHIVED' },
          { offerId: '9900171-02', ozonProductId: '502', ozonSku: '9002', url: 'https://www.ozon.ru/product/9002/', displayState: 'ON_SALE' }
        ]
      };
      return json({ publication });
    }
    if (pathname === `/api/v1/ozon/publications/${publicationId}/stop-automation` && method === 'POST') {
      const body = route.request().postDataJSON();
      writes.push({ path: pathname, body });
      expect(body).toMatchObject({ rowVersion: 10 });
      expect(body.requestId).toMatch(/^[a-f0-9-]{36}$/);
      publication = { ...publication, rowVersion: 11, status: 'CANCELLED' };
      currentJob = { ...currentJob, state: 'CANCELLED' };
      return json({ publication });
    }
    if (method !== 'GET') return route.fulfill({ status: 500, json: { error: { message: `Unexpected write ${pathname}` } } });
    if (pathname === '/api/v1/config') return json({ config: createDefaultConfig(), readiness: { complete: true, stages: [] } });
    if (pathname === '/api/v1/stages') return json({ stages: [] });
    if (pathname === '/api/v1/ozon/automation/jobs') return json({ items: [currentJob], total: 1, page: 1, pageSize: 30 });
    if (pathname === `/api/v1/ozon/automation/jobs/${jobId}`) return json({ job: currentJob });
    if (pathname === '/api/v1/ozon/automation/status') return json({ readiness, counts: { [currentJob.state]: 1 }, managementEnabled: true, acceptingNewJobs: true, worker: { running: false } });
    if (pathname === '/api/v1/ozon/stores') return json({ items: [{
      id: storeId, displayName: '测试店铺', storeAlias: 'fixture', taskLoad: { running: 0, queued: 0 },
      enabled: true, autoPublishEnabled: true, autoPublishMode: 'CREATE_ONLY', warehouseId: '12345', warehouseName: '测试仓库',
      fulfillmentMode: 'FBS', accountCurrency: 'RUB', maxDailyStyles: 100, seller: { id: 'test-seller', name: '测试卖家' },
      permissions: [], limits: { daily: 1000 }, warehouses: [], configVersion: 1, rowVersion: 1,
      credential: { state: 'ACTIVE', bindingMode: 'VAULT', configured: true, activeVersionId: '66666666-6666-4666-8666-666666666666', version: 1 },
      preflight: { status: 'PASSED', currencyVerified: true, currencyVerification: 'VERIFIED', expiresAt: '2099-01-01T00:00:00Z' },
      readiness: { ready: true, score: 100, blockers: [] }, network: { status: 'READY' }
    }], total: 1 });
    if (pathname.endsWith('/system')) return json(readiness);
    if (pathname.endsWith('/settings')) return json({ settings });
    if (pathname === `/api/v1/ozon/publications/${publicationId}`) return json({ publication });
    if (pathname === `/api/v1/ozon/listings/${job.sku}`) return route.fulfill({ status: 404, json: { error: { code: 'NOT_FOUND', message: '尚未生成上品资料' } } });
    return json({ items: [], total: 0, unreadCount: 0 });
  });

  await page.goto('/listing/ozon?view=auto&job=' + jobId + '&store=' + storeId, { waitUntil: 'domcontentloaded' });
  const detail = page.getByRole('dialog', { name: /自动上品详情/ });
  await expect(detail.getByText('商品卡重复', { exact: true })).toBeVisible();
  await expect(detail).toContainText('0000143-01');
  await expect(detail.getByRole('button', { name: '重试上品', exact: true })).toBeDisabled();
  await expect(detail.getByRole('button', { name: '同步平台状态' })).toBeEnabled();
  await expect(detail.getByRole('button', { name: '取消自动任务' })).toBeEnabled();

  await detail.getByRole('button', { name: '同步平台状态' }).click();
  await expect(page.getByText(`SKU ${job.sku} 的 OZON 平台状态已同步；未执行上品或库存写入`, { exact: true })).toBeVisible();
  await expect(detail.getByText('部分可售', { exact: true }).first()).toBeVisible();
  await expect(detail).toContainText('9900171-01');
  await expect(detail).toContainText('已经归档');
  await expect(detail).toContainText('9900171-02');
  await expect(detail).toContainText('已可售');

  await detail.getByRole('button', { name: '取消自动任务' }).click();
  const confirm = page.locator('.ant-modal-confirm').filter({ hasText: `取消 SKU ${job.sku} 的自动上品任务？` });
  await expect(confirm).toContainText('不会调用 OZON 商品、媒体、价格或库存写接口');
  await confirm.getByRole('button', { name: '取消自动任务' }).click();
  await expect(page.getByText(`SKU ${job.sku} 的自动流程已取消；未调用 OZON 写接口`, { exact: true })).toBeVisible();
  await expect(detail.getByText('已取消', { exact: true }).first()).toBeVisible();
  await expect(detail.getByText('部分可售', { exact: true }).first()).toBeVisible();
  expect(writes.map((entry) => entry.path)).toEqual([
    `/api/v1/ozon/publications/${publicationId}/platform-status/refresh`,
    `/api/v1/ozon/publications/${publicationId}/stop-automation`
  ]);
});
