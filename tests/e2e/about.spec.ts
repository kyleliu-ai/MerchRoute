import { expect, test, type Page } from '@playwright/test';

const UPDATE_AVAILABLE = {
  repositoryUrl: 'https://github.com/kyleliu-ai/MerchRoute',
  current: { productVersion: '0.1.0', configVersion: 'v003', commitSha: '7bfb072f548d75744305a2faa38f23722c4b81cf' },
  available: {
    source: 'main',
    label: 'main',
    commitSha: '4d3e4705ad715b700f385c6fa0348644a4a625a9',
    publishedAt: '2026-08-31T08:00:00.000Z',
    url: 'https://github.com/kyleliu-ai/MerchRoute/commit/4d3e4705ad715b700f385c6fa0348644a4a625a9',
    compareUrl: 'https://github.com/kyleliu-ai/MerchRoute/compare/7bfb072f548d75744305a2faa38f23722c4b81cf...4d3e4705ad715b700f385c6fa0348644a4a625a9'
  },
  status: 'UPDATE_AVAILABLE',
  aheadBy: 5,
  checkedAt: '2026-08-31T10:00:00.000Z'
};

test.describe('关于 MerchRoute', () => {
  test('展示品牌、业务链路、能力与只读版本差异入口', async ({ page }) => {
    let checks = 0;
    await mockAboutVersion(page, () => { checks += 1; return UPDATE_AVAILABLE; });
    await page.goto('/about');

    await expect(page.getByRole('heading', { name: '铺货运营，从素材到上架一次跑通' })).toBeVisible();
    await expect(page.getByText('AI MARKETPLACE OPERATIONS PLATFORM')).toBeVisible();
    await expect(page.getByText('FROM SOURCE TO SHELF.', { exact: true })).toBeVisible();
    await expect(page.locator('.about-route strong')).toHaveText(['采购与素材', '主图与视频', '审核与投递', '售价与运费', 'WB / OZON 上品']);
    await expect(page.locator('.about-capability h3')).toHaveText([
      '采购与商品台账', 'AI 主图、套图与视频', '媒体审核与顺序', 'WB / OZON 自动上品', '售价与跨境运费', '任务消息与异常追踪'
    ]);
    await expect(page.locator('.about-positioning-item strong')).toHaveText(['本地优先・数据可控', '可审核・可追踪', 'Windows + macOS', '开源 MIT']);

    await expect(page.getByText('可更新 5 个提交')).toBeVisible();
    await expect(page.getByText('GitHub 目标版本包含当前构建之后的新内容')).toBeVisible();
    await expect(page.getByText('0.1.0', { exact: true })).toBeVisible();
    await expect(page.getByText('7bfb072')).toBeVisible();
    await expect(page.getByText('4d3e470')).toBeVisible();
    await expect(page.getByText('v003')).toBeVisible();

    const repository = page.getByRole('link', { name: '打开 GitHub 仓库' });
    await expect(repository).toHaveAttribute('href', 'https://github.com/kyleliu-ai/MerchRoute');
    await expect(repository).toHaveAttribute('target', '_blank');
    await expect(repository).toHaveAttribute('rel', /noopener/);
    const compare = page.getByRole('link', { name: '查看版本差异' });
    await expect(compare).toHaveAttribute('href', UPDATE_AVAILABLE.available.compareUrl);
    await expect(compare).toHaveAttribute('rel', /noreferrer/);
    await expect(page.getByText('不会自动更新、拉取或替换本地代码')).toBeVisible();

    await page.getByRole('button', { name: '重新检查版本' }).click();
    await expect.poll(() => checks).toBe(2);
  });

  test('320px 下业务链路纵向排列且页面不横向溢出', async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 720 });
    await mockAboutVersion(page, () => UPDATE_AVAILABLE);
    await page.goto('/about');
    await expect(page.getByRole('heading', { name: '铺货运营，从素材到上架一次跑通' })).toBeVisible();

    expect(await page.locator('.about-route').evaluate((element) => getComputedStyle(element).gridTemplateColumns)).not.toContain(' ');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  });

  test('GitHub 不可用时仍显示当前版本且不影响服务健康检查', async ({ page, request }) => {
    await mockAboutVersion(page, () => ({
      repositoryUrl: 'https://github.com/kyleliu-ai/MerchRoute',
      current: { productVersion: '0.1.0', configVersion: 'v003', commitSha: '7bfb072f548d75744305a2faa38f23722c4b81cf' },
      available: null,
      status: 'UNAVAILABLE',
      aheadBy: 0,
      checkedAt: '2026-08-31T10:00:00.000Z',
      error: 'GitHub 版本信息暂时不可用：请求超时'
    }));
    await page.goto('/about');

    await expect(page.getByText('暂时无法判断')).toBeVisible();
    await expect(page.getByText('0.1.0', { exact: true })).toBeVisible();
    await expect(page.getByText('GitHub 版本信息暂时不可用：请求超时')).toBeVisible();
    await expect(page.getByRole('button', { name: '查看版本差异' })).toBeDisabled();
    const health = await request.get('/api/v1/health');
    expect(health.ok()).toBe(true);
    expect((await health.json()).status).toBe('ok');
  });
});

async function mockAboutVersion(page: Page, body: () => unknown): Promise<void> {
  await page.route('**/api/v1/about/version', async (route) => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body()) });
  });
}
