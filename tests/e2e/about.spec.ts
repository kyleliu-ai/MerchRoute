import { expect, test, type Page } from '@playwright/test';

const SYNCED = {
  repositoryUrl: 'https://github.com/kyleliu-ai/MerchRoute',
  scopeVersion: 1,
  current: {
    productVersion: '0.1.0',
    configVersion: 'v003',
    commitSha: '19e9886d0b4562dd70e46a4431f0da835b61e72c',
    builtAt: '2026-09-01T05:30:00.000Z',
    dirty: false
  },
  available: {
    source: 'main',
    label: 'main',
    commitSha: `38c6cbb${'1'.repeat(33)}`,
    publishedAt: '2026-09-01T04:00:00.000Z',
    url: `https://github.com/kyleliu-ai/MerchRoute/commit/38c6cbb${'1'.repeat(33)}`,
    compareUrl: `https://github.com/kyleliu-ai/MerchRoute/compare/19e9886d0b4562dd70e46a4431f0da835b61e72c...38c6cbb${'1'.repeat(33)}`
  },
  syncStatus: 'SYNCED',
  runtimeStatus: 'CURRENT',
  contentComparison: {
    runtime: { status: 'MATCH', differenceCount: 0 },
    documentation: { status: 'DIFFERENT', differenceCount: 2 },
    verification: { status: 'MATCH', differenceCount: 0 }
  },
  historyComparison: { status: 'DIVERGED', localOnlyCommits: 3, remoteOnlyCommits: 8 },
  checkedAt: '2026-09-01T06:00:00.000Z'
};

test.describe('关于 MerchRoute', () => {
  test('内容一致时以指纹为主结论并将历史和文档差异降级为辅助信息', async ({ page }) => {
    let checks = 0;
    let refreshChecks = 0;
    await mockAboutVersion(page, (url) => {
      checks += 1;
      if (url.searchParams.get('refresh') === '1') refreshChecks += 1;
      return SYNCED;
    });
    await page.goto('/about');

    await expect(page.getByRole('heading', { name: '铺货运营，从素材到上架一次跑通' })).toBeVisible();
    await expect(page.getByText('AI MARKETPLACE OPERATIONS PLATFORM')).toBeVisible();
    await expect(page.getByText('FROM SOURCE TO SHELF.', { exact: true })).toBeVisible();
    await expect(page.locator('.about-route strong')).toHaveText(['采购与素材', '主图与视频', '审核与投递', '售价与运费', 'WB / OZON 上品']);
    await expect(page.locator('.about-capability h3')).toHaveText([
      '采购与商品台账', 'AI 主图、套图与视频', '媒体审核与顺序', 'WB / OZON 自动上品', '售价与跨境运费', '任务消息与异常追踪'
    ]);
    await expect(page.locator('.about-positioning-item strong')).toHaveText(['本地优先・数据可控', '可审核・可追踪', 'Windows + macOS', '开源 MIT']);

    await expect(page.getByText('运行与部署内容已同步')).toBeVisible();
    await expect(page.getByText('本机源码、n8n/部署资产和 GitHub 目标内容一致，无需再次同步。')).toBeVisible();
    await expect(page.getByText('当前运行构建已包含本机源码')).toBeVisible();
    await expect(page.getByText('提交历史不同：本机独有 3 个提交，GitHub 独有 8 个提交。该差异不影响当前内容一致性。')).toBeVisible();
    await expect(page.getByText('仓库辅助内容存在差异：文档 2 项。')).toBeVisible();
    await expect(page.getByText('可更新 8 个提交')).toHaveCount(0);
    await expect(page.getByText('版本分支已分叉')).toHaveCount(0);
    await expect(page.getByText('建议再次同步')).toHaveCount(0);
    await expect(page.getByText('0.1.0', { exact: true })).toBeVisible();
    await expect(page.getByText('19e9886')).toBeVisible();
    await expect(page.getByText('38c6cbb')).toBeVisible();
    await expect(page.getByText('v003')).toBeVisible();
    await expect(page.getByText('schema v1')).toBeVisible();

    const repository = page.getByRole('link', { name: '打开 GitHub 仓库' });
    await expect(repository).toHaveAttribute('href', 'https://github.com/kyleliu-ai/MerchRoute');
    await expect(repository).toHaveAttribute('target', '_blank');
    await expect(repository).toHaveAttribute('rel', /noopener/);
    const compare = page.getByRole('link', { name: '查看提交历史' });
    await expect(compare).toHaveAttribute('href', SYNCED.available.compareUrl);
    await expect(compare).toHaveAttribute('rel', /noreferrer/);
    await expect(page.getByText('不会自动更新、拉取或替换本地代码')).toBeVisible();

    await page.getByRole('button', { name: '重新检查版本' }).click();
    await expect.poll(() => checks).toBe(2);
    expect(refreshChecks).toBe(1);
  });

  test('320px 下业务链路纵向排列且页面不横向溢出', async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 720 });
    await mockAboutVersion(page, () => SYNCED);
    await page.goto('/about');
    await expect(page.getByRole('heading', { name: '铺货运营，从素材到上架一次跑通' })).toBeVisible();

    expect(await page.locator('.about-route').evaluate((element) => getComputedStyle(element).gridTemplateColumns)).not.toContain(' ');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  });

  test('GitHub 不可用时仍显示当前版本且不影响服务健康检查', async ({ page, request }) => {
    await mockAboutVersion(page, () => ({
      repositoryUrl: 'https://github.com/kyleliu-ai/MerchRoute',
      scopeVersion: 1,
      current: { productVersion: '0.1.0', configVersion: 'v003', commitSha: '19e9886d0b4562dd70e46a4431f0da835b61e72c' },
      available: null,
      syncStatus: 'UNAVAILABLE',
      runtimeStatus: 'UNKNOWN',
      contentComparison: {
        runtime: { status: 'UNAVAILABLE' },
        documentation: { status: 'UNAVAILABLE' },
        verification: { status: 'UNAVAILABLE' }
      },
      historyComparison: { status: 'UNKNOWN' },
      checkedAt: '2026-09-01T06:00:00.000Z',
      error: 'GitHub 内容暂时无法核验：请求超时'
    }));
    await page.goto('/about');

    await expect(page.getByText('暂时无法完整核验', { exact: true })).toBeVisible();
    await expect(page.getByText('0.1.0', { exact: true })).toBeVisible();
    await expect(page.getByText('GitHub 内容暂时无法核验：请求超时')).toBeVisible();
    await expect(page.getByRole('button', { name: '查看提交历史' })).toBeDisabled();
    const health = await request.get('/api/v1/health');
    expect(health.ok()).toBe(true);
    expect((await health.json()).status).toBe('ok');
  });

  test('可在内容同步状态中生成、验证、替换并停用只读 Token', async ({ page }) => {
    const submittedToken = `github_pat_${'a'.repeat(40)}`;
    let access = githubAccess('ANONYMOUS', 'NONE', 'UNVERIFIED');
    let savedBody: unknown;
    let versionChecks = 0;
    await mockAboutVersion(page, () => { versionChecks += 1; return SYNCED; });
    await page.route('**/api/v1/about/github-access', async (route) => {
      const method = route.request().method();
      if (method === 'PUT') {
        savedBody = route.request().postDataJSON();
        access = {
          ...githubAccess('AUTHENTICATED', 'MANAGED', 'VERIFIED'),
          checkedAt: '2026-09-01T08:00:00.000Z',
          rateLimit: { remaining: 4997, limit: 5000, resetAt: '2026-09-01T09:00:00.000Z' }
        };
      } else if (method === 'DELETE') {
        access = githubAccess('ANONYMOUS', 'NONE', 'UNVERIFIED');
      }
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ access }) });
    });
    await page.goto('/about');

    await page.getByRole('button', { name: '配置 Access Token' }).click();
    await expect(page.getByRole('heading', { name: 'GitHub 匿名请求' })).toBeVisible();
    const createLink = page.getByRole('link', { name: '生成 90 天只读 Token' });
    await expect(createLink).toHaveAttribute('href', /personal-access-tokens\/new\?/);
    await expect(createLink).toHaveAttribute('href', /expires_in=90/);
    await expect(createLink).toHaveAttribute('href', /contents=read/);
    await expect(createLink).toHaveAttribute('target', '_blank');
    await expect(page.getByRole('link', { name: '管理 GitHub Tokens' })).toHaveAttribute('href', 'https://github.com/settings/personal-access-tokens');

    const input = page.getByLabel('GitHub fine-grained Access Token');
    await input.fill(submittedToken);
    await page.getByRole('button', { name: '验证并保存' }).click();
    await expect(page.getByRole('heading', { name: '专用只读 Token 已验证' })).toBeVisible();
    await expect(page.getByText('4997 / 5000')).toBeVisible();
    await expect(input).toHaveValue('');
    expect(savedBody).toEqual({ token: submittedToken });
    await expect(page.getByText(submittedToken)).toHaveCount(0);
    await expect.poll(() => versionChecks).toBeGreaterThanOrEqual(2);

    await page.getByRole('button', { name: '停用 Token，切换匿名模式' }).click();
    await page.getByRole('button', { name: '停用并切换匿名模式' }).click();
    await expect(page.getByRole('heading', { name: 'GitHub 匿名请求' })).toBeVisible();
  });

  test('Token 失效回退时保留告警，320px 抽屉不横向溢出', async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 720 });
    await mockAboutVersion(page, () => SYNCED);
    await page.route('**/api/v1/about/github-access', async (route) => route.fulfill({ json: {
      access: { ...githubAccess('ANONYMOUS', 'MANAGED', 'INVALID'), anonymousFallback: true, canManage: true }
    } }));
    await page.goto('/about');
    await page.getByRole('button', { name: '配置 Access Token' }).click();
    await expect(page.getByRole('heading', { name: 'Access Token 已失效' })).toBeVisible();
    await expect(page.getByText('已自动回退匿名请求')).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  });
});

async function mockAboutVersion(page: Page, body: (url: URL) => unknown): Promise<void> {
  await page.route('**/api/v1/about/version*', async (route) => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body(new URL(route.request().url()))) });
  });
}

function githubAccess(mode: 'AUTHENTICATED' | 'ANONYMOUS', source: 'MANAGED' | 'ENVIRONMENT' | 'NONE', state: 'VERIFIED' | 'UNVERIFIED' | 'INVALID') {
  return { mode, source, state, anonymousFallback: false, canManage: true };
}
