import { expect, test } from '@playwright/test';

test('browser bundle gives each purchase filter a unique client-side Select ID', async ({ page }) => {
  await page.goto('/purchases/url-download');
  const filters = page.locator('.filter-bar').getByRole('combobox');
  await expect(filters).toHaveCount(3);
  await expect.poll(async () => {
    const ids = await filters.evaluateAll((elements) => elements.map((element) => element.id));
    return ids.every((id) => /^rc_select_\d+$/.test(id)) && new Set(ids).size === ids.length;
  }).toBe(true);
});
