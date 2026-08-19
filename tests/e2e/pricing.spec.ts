import { expect, test, type Locator, type Page } from '@playwright/test';

test.describe('通用跨境电商售价计算', () => {
  test('售价查询读取最新采购版本并直接展示最低价在前的全部渠道', async ({ page }) => {
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write'], { origin: 'http://127.0.0.1:4183' });
    await page.goto('/pricing/query');
    await expect(page.getByRole('heading', { name: '售价查询' })).toBeVisible();
    const queryPanel = page.locator('.pricing-query-panel');
    const templateSelect = queryPanel.locator('.ant-select').nth(0);
    await templateSelect.click();
    await page.locator('.ant-select-dropdown:visible .ant-select-item-option').filter({ hasText: 'WB 平台默认定价' }).click();
    const shippingSelect = queryPanel.locator('.ant-select').nth(1);
    await expect(shippingSelect).not.toHaveClass(/ant-select-multiple/);
    await shippingSelect.click();
    await page.locator('.ant-select-dropdown:visible .ant-select-item-option').filter({ hasText: 'CEL 物流' }).click();
    const serviceField = queryPanel.locator('.pricing-field').filter({ hasText: '服务渠道' });
    const serviceSelect = serviceField.locator('.ant-select');
    await expect(serviceSelect).toHaveClass(/ant-select-multiple/);
    await expect.poll(() => serviceSelect.locator('.ant-select-selection-item').count()).toBeGreaterThan(1);
    await expect(page.locator('.pricing-query-rail')).toHaveCount(0);

    const destinationField = queryPanel.locator('.pricing-field').filter({ hasText: '目的国' });
    if (await destinationField.count()) {
      await destinationField.locator('.ant-select').click();
      await page.locator('.ant-select-dropdown:visible .ant-select-item-option').first().click();
    }
    await queryPanel.getByLabel('产品 SKU').fill('0000001');
    const requestPromise = page.waitForRequest((request) => request.url().endsWith('/api/v1/pricing/query') && request.method() === 'POST');
    const responsePromise = page.waitForResponse((response) => response.url().endsWith('/api/v1/pricing/query') && response.request().method() === 'POST');
    await queryPanel.getByRole('button', { name: '查询并计算价格' }).click();
    const requestBody = (await requestPromise).postDataJSON();
    const body = await (await responsePromise).json();
    const shippingDetail = await (await page.request.get(`/api/v1/shipping/templates/${requestBody.shippingTemplateIds[0]}`)).json();
    const publishedShipping = shippingDetail.template.versions.find((version: any) => version.status === 'PUBLISHED');
    expect(requestBody.shippingTemplateIds).toHaveLength(1);
    expect(requestBody.shippingServiceCodes).toEqual(publishedShipping.definition.services.map((service: any) => service.code));
    expect(body).toMatchObject({ total: 1, succeeded: 1, failed: 0 });
    expect(body.results[0].product.procurement.versionNo).toBeGreaterThan(0);

    const productCard = page.locator('.pricing-product-result');
    await expect(productCard).toContainText('0000001');
    await expect(productCard).toContainText(`最新采购版本 V${body.results[0].product.procurement.versionNo}`);
    await expect(productCard).toContainText('推荐渠道');
    await expect(productCard).not.toContainText('推荐目标售价');
    await expect(productCard.getByRole('button', { name: /展开价格详情/ })).toHaveCount(0);

    const optionCards = productCard.locator('.pricing-product-options .pricing-option');
    await expect(optionCards).toHaveCount(body.results[0].result.options.length);
    await expect(optionCards.first()).toHaveClass(/is-recommended/);
    await expect(optionCards.first()).toContainText('推荐最低售价');
    const product = body.results[0].product;
    const firstOption = body.results[0].result.options[0];
    const costCode = firstOption.amounts.targetSale.costCurrency.currencyCode;
    const saleCode = firstOption.amounts.targetSale.saleCurrency.currencyCode;
    const freightUnit = costCode === 'CNY' ? '元' : costCode;
    const facts = productCard.locator('.pricing-product-facts');
    await expectCopied(page, copyButton(productCard, 'SKU', product.sku), product.sku);
    await expectCopied(page, copyButton(productCard, '产品名', product.productName), product.productName);
    await expectCopied(page, copyButton(facts, '采购价', product.procurement.purchasePrice), product.procurement.purchasePrice);
    await expectCopied(page, copyButton(facts, '国内快递费', product.procurement.courierFee), product.procurement.courierFee);
    await expectCopied(page, copyButton(facts, '重量', product.procurement.grossWeightGrams), product.procurement.grossWeightGrams);
    const dimensions = [product.procurement.lengthCm, product.procurement.widthCm, product.procurement.heightCm].join(' × ');
    await expectCopied(page, copyButton(facts, '包装尺寸', dimensions), dimensions);
    const firstOptionCard = optionCards.first();
    const fixedCopy = copyButton(firstOptionCard, `固定成本 ${costCode}`, firstOption.costs.totalFixedCost.displayValue);
    await expectCopied(page, fixedCopy, firstOption.costs.totalFixedCost.displayValue);
    await expect(firstOptionCard).toContainText(`含运费 ${firstOption.costs.crossBorderFreight.displayValue} ${freightUnit}`);
    await expectCopied(page, copyButton(firstOptionCard, `含运费 ${freightUnit}`, firstOption.costs.crossBorderFreight.displayValue), firstOption.costs.crossBorderFreight.displayValue);
    const targetCostCopy = copyButton(firstOptionCard, `目标售价 ${costCode}`, firstOption.amounts.targetSale.costCurrency.displayValue);
    await expectCopied(page, targetCostCopy, firstOption.amounts.targetSale.costCurrency.displayValue);
    await expect(fixedCopy).not.toHaveClass(/is-copied/);
    await expectCopied(page, copyButton(firstOptionCard, `目标售价 ${saleCode}`, firstOption.amounts.targetSale.saleCurrency.displayValue), firstOption.amounts.targetSale.saleCurrency.displayValue);
    await expectCopied(page, copyButton(firstOptionCard, `上架价 ${costCode}`, firstOption.amounts.listing.costCurrency.displayValue), firstOption.amounts.listing.costCurrency.displayValue);
    await expectCopied(page, copyButton(firstOptionCard, `上架价 ${saleCode}`, firstOption.amounts.listing.saleCurrency.displayValue), firstOption.amounts.listing.saleCurrency.displayValue);
    await expectCopied(page, copyButton(firstOptionCard, `划线价 ${costCode}`, firstOption.amounts.strike.costCurrency.displayValue), firstOption.amounts.strike.costCurrency.displayValue);
    await expectCopied(page, copyButton(firstOptionCard, `划线价 ${saleCode}`, firstOption.amounts.strike.saleCurrency.displayValue), firstOption.amounts.strike.saleCurrency.displayValue);
    const prices = body.results[0].result.options.map((option: any) => Number(option.amounts.targetSale.saleCurrency.value));
    expect(prices).toEqual([...prices].sort((left, right) => left - right));
    expect(body.results[0].result.options.filter((option: any) => option.recommended)).toHaveLength(1);

    await optionCards.first().getByRole('button', { name: '查看固定成本组成' }).hover();
    const fixedPopover = page.locator('.pricing-breakdown-popover:visible');
    await expect(fixedPopover.locator('.pricing-breakdown-row.is-total')).toContainText(body.results[0].result.options[0].costs.totalFixedCost.displayValue);
    await expect(fixedPopover).toContainText('跨境运费');
    await page.getByRole('heading', { name: '售价查询' }).hover();
    await optionCards.first().getByRole('button', { name: '查看总比例成本组成' }).focus();
    await expect(page.locator('.pricing-breakdown-popover:visible').filter({ hasText: '总比例成本组成' })).toContainText('佣金率');

    const selectedServiceCode = body.results[0].result.options[0].shipping.serviceCode;
    const selectedService = publishedShipping.definition.services.find((service: any) => service.code === selectedServiceCode);
    for (const service of publishedShipping.definition.services.filter((item: any) => item.code !== selectedServiceCode)) {
      const tag = serviceSelect.locator(`.ant-select-selection-item[title="${service.name}"]`);
      if (await tag.count()) await tag.locator('.ant-select-selection-item-remove').click();
    }
    await expect(serviceSelect.locator('.ant-select-selection-item')).toHaveCount(1);
    await expect(serviceSelect.locator('.ant-select-selection-item')).toContainText(selectedService.name);
    await expect(page.locator('.pricing-product-result')).toHaveCount(0);
    const singleChannelResponsePromise = page.waitForResponse((response) => response.url().endsWith('/api/v1/pricing/query') && response.request().method() === 'POST');
    await queryPanel.getByRole('button', { name: '查询并计算价格' }).click();
    const singleChannelBody = await (await singleChannelResponsePromise).json();
    expect(singleChannelBody.results[0].result.options.every((option: any) => option.shipping.serviceCode === selectedServiceCode)).toBe(true);

    const exactName = body.results[0].product.productName;
    const containsResponse = await page.request.post('/api/v1/pricing/query', { data: { ...requestBody, lookup: { kind: 'PRODUCT_NAME', productName: `  ${exactName.slice(0, -1)}  ` } } });
    expect(containsResponse.ok()).toBe(true);
    expect((await containsResponse.json()).total).toBeGreaterThan(0);
    const missingResponse = await page.request.post('/api/v1/pricing/query', { data: { ...requestBody, lookup: { kind: 'PRODUCT_NAME', productName: '不存在的产品关键词' } } });
    expect(missingResponse.ok()).toBe(true);
    expect((await missingResponse.json()).total).toBe(0);

    await queryPanel.getByText('按产品名', { exact: true }).click();
    const keywordInput = queryPanel.getByLabel('产品名关键词');
    await expect(keywordInput).toHaveAttribute('placeholder', '输入产品名中的关键词，例如：布鞋');
    await keywordInput.fill('布鞋');
    const fuzzyResponsePromise = page.waitForResponse((response) => response.url().endsWith('/api/v1/pricing/query') && response.request().method() === 'POST');
    await queryPanel.getByRole('button', { name: '查询并计算价格' }).click();
    const fuzzyBody = await (await fuzzyResponsePromise).json();
    expect(fuzzyBody.total).toBeGreaterThanOrEqual(2);
    expect(fuzzyBody.results.map((item: any) => item.product.productName)).toEqual(expect.arrayContaining(['布鞋', '老北京布鞋']));
    await expect(page.locator('.pricing-product-result')).toHaveCount(fuzzyBody.total);
    for (const [index, row] of fuzzyBody.results.entries()) {
      if (row.ok) await expect(page.locator('.pricing-product-result').nth(index).locator('.pricing-option').first()).toHaveClass(/is-recommended/);
    }

    await keywordInput.fill('休闲鞋');
    await expect(page.locator('.pricing-product-result')).toHaveCount(0);
    await expect(serviceSelect.locator('.ant-select-selection-item')).toHaveCount(1);
  });

  test('售价查询切换运费模板时全选新渠道，并按已选渠道推导目的国', async ({ page }) => {
    await page.goto('/pricing/query');
    const queryPanel = page.locator('.pricing-query-panel');
    const pricingSelect = queryPanel.locator('.pricing-field').filter({ has: page.locator('label').filter({ hasText: /^定价模板$/ }) }).locator('.ant-select');
    await pricingSelect.click();
    await page.locator('.ant-select-dropdown:visible .ant-select-item-option').filter({ hasText: 'OZON平台默认定' }).click();
    const shippingSelect = queryPanel.locator('.ant-select').nth(1);
    const serviceSelect = queryPanel.locator('.ant-select').nth(2);

    await shippingSelect.click();
    await page.locator('.ant-select-dropdown:visible .ant-select-item-option').filter({ hasText: 'CEL OZON-rFBS V7.24' }).click();
    await expect(serviceSelect.locator('.ant-select-selection-item')).toHaveCount(4);
    await expect(serviceSelect).toContainText('CEL Express');
    await expect(serviceSelect).toContainText('CEL Standard');
    await expect(serviceSelect).toContainText('CEL Economy');
    await expect(serviceSelect).toContainText('CEL Express HK');
    await expect(queryPanel.locator('.pricing-field').filter({ hasText: '目的国' })).toHaveCount(0);

    await shippingSelect.click();
    await page.locator('.ant-select-dropdown:visible .ant-select-item-option').filter({ hasText: 'CEL OZON-CIS V7.24' }).click();
    await expect(serviceSelect.locator('.ant-select-selection-item')).toHaveCount(4);
    const destinationField = queryPanel.locator('.pricing-field').filter({ hasText: '目的国' });
    await expect(destinationField).toBeVisible();
    const kazakhstanTags = serviceSelect.locator('.ant-select-selection-item').filter({ hasText: '哈萨克斯坦' });
    await expect(kazakhstanTags).toHaveCount(2);
    while (await kazakhstanTags.count()) await kazakhstanTags.first().locator('.ant-select-selection-item-remove').click();
    await expect(serviceSelect.locator('.ant-select-selection-item')).toHaveCount(2);
    await destinationField.locator('.ant-select').click();
    const countryOptions = page.locator('.ant-select-dropdown:visible .ant-select-item-option');
    await expect(countryOptions).toHaveCount(1);
    await expect(countryOptions.first()).toContainText('白俄罗斯');
  });

  test('使用已发布的 WB 定价与运费版本完成单品试算', async ({ page }) => {
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write'], { origin: 'http://127.0.0.1:4183' });
    await page.goto('/pricing');
    await expect(page.getByRole('heading', { name: '商品售价计算' })).toBeVisible();
    const templateSelect = page.locator('.pricing-selector .ant-select').first();
    await templateSelect.click();
    await page.locator('.ant-select-dropdown:visible .ant-select-item-option').filter({ hasText: 'WB 平台默认定价' }).click();
    await expect(page.locator('.pricing-selector .ant-select').first().locator('.ant-select-selection-item')).toContainText('WB');
    const inputDeck = page.locator('.pricing-input-deck');
    const commissionInput = inputDeck.locator('.ant-form-item').filter({ hasText: '佣金率覆盖' }).locator('input');
    const marginInput = inputDeck.locator('.ant-form-item').filter({ hasText: '目标毛利率覆盖' }).locator('input');
    await expect(inputDeck.getByLabel('SKU')).toHaveCount(0);
    await expect(inputDeck.getByLabel('产品名')).toHaveCount(0);
    await expect(commissionInput).toHaveValue('15');
    await expect(marginInput).toHaveValue('30');
    await expect(inputDeck).toContainText('本次修改不会改变模板');

    const shippingSelect = page.locator('.pricing-selector .ant-select').nth(1);
    await shippingSelect.click();
    const shippingOption = page.locator('.ant-select-item-option').filter({ hasText: 'CEL 物流' });
    await expect(shippingOption).toBeVisible();
    await shippingOption.click();
    const calculationResponsePromise = page.waitForResponse((response) => response.url().endsWith('/api/v1/pricing/calculate') && response.request().method() === 'POST');
    await page.getByRole('button', { name: '计算全部可用渠道' }).click();
    const calculation = await (await calculationResponsePromise).json();

    const recommended = page.locator('.pricing-option.is-recommended');
    await expect(recommended).toBeVisible();
    await expect(recommended).toContainText('推荐最低售价');
    await expect(recommended).toContainText('2339.94');
    await expect(recommended).toContainText('RUB');
    await expect(recommended).toContainText(/定价 V\d+/);
    const recommendedResult = calculation.options.find((option: any) => option.recommended);
    const recommendedSale = recommendedResult.amounts.targetSale.saleCurrency;
    await expectCopied(page, copyButton(recommended, `目标售价 ${recommendedSale.currencyCode}`, recommendedSale.displayValue), recommendedSale.displayValue);

    const optionCards = page.locator('.pricing-option');
    expect(await optionCards.count()).toBeGreaterThan(1);
    for (let index = 0; index < 2; index += 1) {
      const card = optionCards.nth(index);
      await card.getByRole('button', { name: '查看固定成本组成' }).hover();
      const popover = page.locator('.pricing-breakdown-popover:visible');
      await expect(popover).toBeVisible();
      await expect(popover.locator('.pricing-breakdown-row').filter({ hasText: '跨境运费' })).toContainText(calculation.options[index].costs.crossBorderFreight.displayValue);
      await expect(popover.locator('.pricing-breakdown-row.is-total')).toContainText(calculation.options[index].costs.totalFixedCost.displayValue);
      if (index === 0) {
        await expect(popover).toContainText('采购价');
        await expect(popover).toContainText('国内快递费');
        await expect(popover).toContainText('跨境运费');
        await expect(popover).toContainText('代贴单费');
        await expect(popover).toContainText('CNY');
      }
      await page.getByRole('heading', { name: '商品售价计算' }).hover();
      await expect(popover).not.toBeVisible();
    }

    const fixedTrigger = recommended.getByRole('button', { name: '查看固定成本组成' });
    const rateTrigger = recommended.getByRole('button', { name: '查看总比例成本组成' });
    await rateTrigger.focus();
    const ratePopover = page.locator('.pricing-breakdown-popover').filter({ hasText: '总比例成本组成' });
    await expect(ratePopover).toBeVisible();
    await expect(ratePopover).toContainText('佣金率');
    await expect(ratePopover).toContainText('目标毛利率');
    for (const component of calculation.options[0].rates.percentageDeductions) {
      await expect(ratePopover).toContainText(component.name);
      await expect(ratePopover.locator('.pricing-breakdown-row').filter({ hasText: component.name })).toContainText(formatRate(component.rate));
    }
    await expect(ratePopover.locator('.pricing-breakdown-row.is-total')).toContainText(formatRate(calculation.options[0].rates.totalRate));
    await page.keyboard.press('Tab');
    await expect(ratePopover).not.toBeVisible();

    await page.getByRole('heading', { name: '商品售价计算' }).click();
    await expect(page.locator('.pricing-breakdown-popover:visible')).toHaveCount(0);
    await fixedTrigger.click();
    await expect(page.locator('.pricing-breakdown-popover:visible')).toContainText('固定成本组成');
    await page.getByRole('heading', { name: '商品售价计算' }).click();
    await expect(page.locator('.pricing-breakdown-popover:visible')).toHaveCount(0);
  });

  test('单品覆盖费率使用内部占位信息，支持 0% 并在切换模板时恢复新默认值', async ({ page }) => {
    await page.goto('/pricing');
    const templateSelect = page.locator('.pricing-selector .ant-select').first();
    await templateSelect.click();
    await page.locator('.ant-select-dropdown:visible .ant-select-item-option').filter({ hasText: 'WB 平台默认定价' }).click();
    const inputDeck = page.locator('.pricing-input-deck');
    const commissionInput = inputDeck.locator('.ant-form-item').filter({ hasText: '佣金率覆盖' }).locator('input');
    const marginInput = inputDeck.locator('.ant-form-item').filter({ hasText: '目标毛利率覆盖' }).locator('input');
    const weightInput = inputDeck.locator('.ant-form-item').filter({ hasText: '重量' }).locator('input');
    await expect(commissionInput).toHaveValue('15');
    await commissionInput.fill('20');
    await marginInput.fill('30');
    await weightInput.fill('600');
    await expect(commissionInput).toHaveValue('20');

    const shippingSelect = page.locator('.pricing-selector .ant-select').nth(1);
    await shippingSelect.click();
    const shippingOption = page.locator('.ant-select-item-option').filter({ hasText: 'CEL 物流' });
    await expect(shippingOption).toBeVisible();
    await shippingOption.click();
    const overrideRequestPromise = page.waitForRequest((request) => request.url().endsWith('/api/v1/pricing/calculate') && request.method() === 'POST');
    const overrideResponsePromise = page.waitForResponse((response) => response.url().endsWith('/api/v1/pricing/calculate') && response.request().method() === 'POST');
    await page.getByRole('button', { name: '计算全部可用渠道' }).click();
    const overrideBody = (await overrideRequestPromise).postDataJSON();
    await overrideResponsePromise;
    expect(overrideBody.item).toMatchObject({ sku: 'SINGLE-QUOTE', productName: '单品试算', commissionRate: '0.2', targetMarginRate: '0.3' });
    const overrideRateTrigger = page.locator('.pricing-option.is-recommended').getByRole('button', { name: '查看总比例成本组成' });
    await overrideRateTrigger.hover();
    let ratePopover = page.locator('.pricing-breakdown-popover:visible');
    await expect(ratePopover.locator('.pricing-breakdown-row').filter({ hasText: '佣金率' })).toContainText('20%');
    await commissionInput.hover();
    await expect(ratePopover).not.toBeVisible();

    await commissionInput.fill('0');
    const zeroRequestPromise = page.waitForRequest((request) => request.url().endsWith('/api/v1/pricing/calculate') && request.method() === 'POST');
    const zeroResponsePromise = page.waitForResponse((response) => response.url().endsWith('/api/v1/pricing/calculate') && response.request().method() === 'POST');
    await page.getByRole('button', { name: '计算全部可用渠道' }).click();
    const zeroBody = (await zeroRequestPromise).postDataJSON();
    await zeroResponsePromise;
    expect(zeroBody.item.commissionRate).toBe('0');
    await page.locator('.pricing-option.is-recommended').getByRole('button', { name: '查看总比例成本组成' }).hover();
    ratePopover = page.locator('.pricing-breakdown-popover:visible');
    await expect(ratePopover.locator('.pricing-breakdown-row').filter({ hasText: '佣金率' })).toContainText('0%');
    await commissionInput.hover();
    await expect(ratePopover).not.toBeVisible();

    const templateList = await (await page.request.get('/api/v1/pricing/templates')).json() as { items: Array<{ id: string; name: string; platformCode: string; active: boolean; publishedVersion?: unknown }> };
    const otherTemplate = templateList.items.find((item) => item.active && item.publishedVersion && item.platformCode !== 'WB');
    expect(otherTemplate).toBeTruthy();
    const otherDetail = await (await page.request.get(`/api/v1/pricing/templates/${otherTemplate!.id}`)).json() as { template: { versions: Array<{ status: string; definition: { defaultCommissionRate: string; defaultTargetMarginRate: string } }> } };
    const otherPublished = otherDetail.template.versions.find((version) => version.status === 'PUBLISHED')!;
    await templateSelect.click();
    await page.locator('.ant-select-dropdown:visible .ant-select-item-option').filter({ hasText: otherTemplate!.name }).click();
    await expect(commissionInput).toHaveValue(String(Number(otherPublished.definition.defaultCommissionRate) * 100));
    await expect(marginInput).toHaveValue(String(Number(otherPublished.definition.defaultTargetMarginRate) * 100));
    await expect(page.locator('.pricing-option')).toHaveCount(0);
  });

  test('模板没有已发布版本时阻止单品计算并给出提示', async ({ page }) => {
    await page.route(/\/api\/v1\/pricing\/templates\/[0-9a-f-]+$/i, async (route) => {
      const response = await route.fetch();
      const body = await response.json() as { template: { versions: Array<{ status: string }> } };
      body.template.versions = body.template.versions.filter((version) => version.status !== 'PUBLISHED');
      await route.fulfill({ status: response.status(), contentType: 'application/json', body: JSON.stringify(body) });
    });
    await page.goto('/pricing');
    await expect(page.getByText('当前定价模板没有已发布版本')).toBeVisible();
    await expect(page.getByRole('button', { name: '计算全部可用渠道' })).toBeDisabled();
  });

  test('模板详情加载失败时显示错误并阻止单品计算', async ({ page }) => {
    await page.route(/\/api\/v1\/pricing\/templates\/[0-9a-f-]+$/i, async (route) => route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: { code: 'TEST_ERROR', message: '模板读取失败' } }) }));
    await page.goto('/pricing');
    await expect(page.getByText('无法读取定价模板默认值')).toBeVisible();
    await expect(page.getByRole('button', { name: '计算全部可用渠道' })).toBeDisabled();
  });

  test('定价模板页提供动态基础资料、复制和版本管理入口', async ({ page }) => {
    await page.goto('/pricing/templates');
    await expect(page.getByRole('heading', { name: '定价模板' })).toBeVisible();
    await expect(page.getByRole('button', { name: '平台与币种' })).toBeVisible();
    await expect(page.getByRole('button', { name: '新建模板' })).toBeVisible();
    await expect(page.getByRole('button', { name: '复制' }).first()).toBeVisible();
    await expect(page.getByText(/V\d+ 已发布/).first()).toBeVisible();
  });

  test('成本组件代码可以连续输入且不会丢失焦点', async ({ page }) => {
    await page.goto('/pricing/templates');
    const wbRow = page.locator('.ant-table-tbody tr').filter({ hasText: 'WB 平台默认定价' });
    await expect(wbRow).toBeVisible();
    await wbRow.locator('td').last().locator('button').first().click();
    const drawer = page.locator('.ant-drawer:visible');
    await expect(drawer).toBeVisible();

    const fixedRow = drawer.locator('.pricing-component-list').nth(0).locator('.pricing-component-row').first();
    const fixedCode = fixedRow.locator('input').first();
    await fixedCode.fill('');
    await fixedCode.pressSequentially('FIXED_1');
    await expect(fixedCode).toBeFocused();
    await expect(fixedCode).toHaveValue('FIXED_1');
    await expect(fixedRow.locator('.ant-input-number-group-addon')).toHaveText('元');
    await fixedRow.locator('.ant-input-number-input').fill('3.5');

    const rateRow = drawer.locator('.pricing-component-list').nth(1).locator('.pricing-component-row').first();
    const rateCode = rateRow.locator('input').first();
    await rateCode.fill('');
    await rateCode.pressSequentially('RATE_1D');
    await expect(rateCode).toBeFocused();
    await expect(rateCode).toHaveValue('RATE_1D');
    await expect(rateRow.locator('.ant-input-number-group-addon')).toHaveText('%');
    await rateRow.locator('.ant-input-number-input').fill('10');

    let savedBody: { definition?: { fixedCosts?: Array<{ amount: string }>; percentageDeductions?: Array<{ rate: string }> } } | undefined;
    await page.route('**/api/v1/pricing/templates/*/draft', async (route) => {
      savedBody = route.request().postDataJSON();
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ template: {} }) });
    });
    await drawer.getByRole('button', { name: '保存草稿' }).click();
    await expect.poll(() => savedBody?.definition?.fixedCosts?.[0]?.amount).toBe('3.5');
    expect(savedBody?.definition?.percentageDeductions?.[0]?.rate).toBe('0.1');
  });

  test('计算接口不返回固定币种字段名', async ({ request }) => {
    const pricing = await (await request.get('/api/v1/pricing/templates')).json();
    const shipping = await (await request.get('/api/v1/shipping/templates')).json();
    const priceTemplate = pricing.items.find((item: { platformCode: string }) => item.platformCode === 'WB');
    const shippingTemplate = shipping.items.find((item: { platformCode: string; publishedVersion?: unknown }) => item.platformCode === 'WB' && item.publishedVersion);
    const response = await request.post('/api/v1/pricing/calculate', {
      data: {
        pricingTemplateId: priceTemplate.id,
        shippingTemplateIds: [shippingTemplate.id],
        item: { sku: '0000001', productName: '雪地靴', purchaseCost: '34.6', domesticFreight: '0', actualWeightGrams: '550', lengthCm: '10', widthCm: '10', heightCm: '10' }
      }
    });
    expect(response.ok()).toBe(true);
    const body = await response.json();
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain('saleRub');
    expect(serialized).not.toContain('priceCny');
    expect(body.pricingTemplate.versionNo).toBeGreaterThan(0);
    expect(body.options[0].shipping.template.versionNo).toBeGreaterThan(0);
  });
});

function formatRate(value: string) {
  return `${new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 3 }).format(Number(value) * 100)}%`;
}

async function expectCopied(page: Page, button: Locator, value: string) {
  await button.click();
  await expect(button).toHaveClass(/is-copied/);
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(value);
}

function copyButton(container: Page | Locator, label: string, value: string) {
  return container.getByRole('button', { name: new RegExp(`${escapeRegExp(label)}.*${escapeRegExp(value)}`) });
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
