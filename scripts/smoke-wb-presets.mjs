const baseUrl = String(process.env.MERCHROUTE_BASE_URL || process.env.MERCHROUTE_RUNTIME_BASE_URL || 'http://127.0.0.1:43173').replace(/\/$/, '');
const prefix = `Codex验收临时预设-${Date.now()}`;
const createdIds = new Set();
let baselineDefaultId;

async function request(method, pathname, body, expectedStatus) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    method,
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(30_000)
  });
  const raw = await response.text();
  let data = {};
  try { data = raw ? JSON.parse(raw) : {}; } catch { data = { raw }; }
  if (expectedStatus !== undefined) {
    if (response.status !== expectedStatus) throw new Error(`${method} ${pathname} 期望 ${expectedStatus}，实际 ${response.status}: ${raw.slice(0, 800)}`);
    return { status: response.status, data };
  }
  if (!response.ok) throw new Error(`${method} ${pathname} -> ${response.status}: ${raw.slice(0, 800)}`);
  return { status: response.status, data };
}

async function cleanup() {
  let current = await request('GET', '/api/v1/wb/presets').catch(() => ({ data: { items: [] } }));
  for (const preset of current.data.items || []) {
    if (!createdIds.has(preset.id) && !String(preset.name || '').startsWith(prefix)) continue;
    await request('DELETE', `/api/v1/wb/presets/${encodeURIComponent(preset.id)}?rowVersion=${preset.rowVersion}`).catch(() => undefined);
  }
  if (baselineDefaultId) {
    current = await request('GET', '/api/v1/wb/presets').catch(() => ({ data: { items: [] } }));
    const baseline = (current.data.items || []).find((preset) => preset.id === baselineDefaultId);
    if (baseline && !baseline.isDefault) await request('POST', `/api/v1/wb/presets/${encodeURIComponent(baseline.id)}/default`, { rowVersion: baseline.rowVersion });
  }
}

let result;
try {
  const before = (await request('GET', '/api/v1/wb/presets')).data.items || [];
  baselineDefaultId = before.find((preset) => preset.isDefault)?.id;
  const pricing = (await request('GET', '/api/v1/pricing/templates')).data.items || [];
  const shipping = (await request('GET', '/api/v1/shipping/templates')).data.items || [];
  const categories = (await request('GET', '/api/v1/wb/categories')).data.items || [];
  const pricingTemplate = pricing.find((item) => item.active && item.publishedVersion && String(item.platformCode).toUpperCase() === 'WB');
  const shippingTemplate = shipping.find((item) => item.active && item.carrierActive && item.publishedVersion && String(item.platformCode).toUpperCase() === 'WB');
  const categorySummary = categories.find((item) => item.categoryKey === 'adult_casual_sneakers' && item.active && item.publishedVersion && item.projection?.status === 'SYNCED');
  if (!pricingTemplate || !shippingTemplate || !categorySummary) throw new Error('缺少可用的 WB 定价、运费或类目依赖，无法执行安全烟雾测试');
  const shippingDetail = (await request('GET', `/api/v1/shipping/templates/${encodeURIComponent(shippingTemplate.id)}`)).data.template;
  const publishedShipping = shippingDetail.versions.filter((item) => item.status === 'PUBLISHED').sort((a, b) => b.versionNo - a.versionNo)[0];
  const service = publishedShipping?.definition?.services?.find((item) => item.code === 'CEL_WB_ECONOMY') || publishedShipping?.definition?.services?.[0];
  if (!service) throw new Error('运费模板没有可用服务渠道');
  const destinationCountryCodes = [...new Set((service.rules || []).flatMap((rule) => rule.destinationCountryCodes || []))];
  const category = (await request('GET', `/api/v1/wb/categories/${encodeURIComponent(categorySummary.categoryKey)}`)).data.category;
  const publishedCategory = category.versions.filter((item) => item.status === 'PUBLISHED').sort((a, b) => b.versionNo - a.versionNo)[0];
  const subjectId = Number(publishedCategory?.subjectId || category.subjectId);
  const tnvedRows = (await request('GET', `/api/v1/wb/catalog/directories/tnved?subjectId=${subjectId}&search=6404110000&locale=ru`)).data;
  const tnved = (Array.isArray(tnvedRows) ? tnvedRows : []).find((item) => String(item.tnved).replace(/\D/g, '') === '6404110000')?.tnved;
  if (!tnved) throw new Error('测试类目没有返回 TNVED 6404110000');

  const definition = {
    name: prefix,
    description: '自动化验收完成后删除',
    pricingTemplateId: pricingTemplate.id,
    shippingTemplateId: shippingTemplate.id,
    shippingServiceCode: service.code,
    ...(destinationCountryCodes.length ? { destinationCountryCode: destinationCountryCodes[0] } : {}),
    packaging: { grossWeightGrams: 750, lengthCm: 30, widthCm: 20, heightCm: 12 },
    categoryKey: categorySummary.categoryKey,
    discountPercent: 50,
    clubDiscount: null,
    tnved: String(tnved).replace(/\D/g, ''),
    brand: '',
    titleTranslation: { workflowId: 'W2lSSXE3NUaLW1tD', language: '俄文', maxLength: 60 },
    descriptionSource: 'E003',
    sharedCharacteristics: [
      { id: 204557, value: ['Женский'] },
      { id: 14177450, value: ['текстиль'] }
    ],
    variantCharacteristics: [{ id: 14177449, value: ['черный'] }],
    sizes: publishedCategory?.formConfig?.sizeMode === 'sizeless'
      ? [{ sizeId: crypto.randomUUID(), stock: 0 }]
      : [{ sizeId: crypto.randomUUID(), techSize: '38', wbSize: '38', insoleLengthCm: 24.5, stock: 0 }],
    isDefault: true
  };
  const legacyVideoMode = await request('POST', '/api/v1/wb/presets', {
    ...definition,
    name: `${prefix}-旧客户端`,
    videoUploadMode: 'ORIGINAL'
  }, 400);
  if (legacyVideoMode.data?.error?.code !== 'CONFIG_INVALID'
    || legacyVideoMode.data?.error?.details?.replacement !== 'category.formConfig.media.defaultVideoUploadMode') {
    throw new Error('旧客户端提交预设级 videoUploadMode 时没有返回明确迁移提示');
  }

  const created = (await request('POST', '/api/v1/wb/presets', definition)).data.preset;
  createdIds.add(created.id);
  if (!created.isDefault || created.readiness === 'BROKEN') throw new Error('首个健康预设没有成为默认或被错误标记为 BROKEN');
  if (Object.hasOwn(created, 'videoUploadMode')) throw new Error('预设 API 仍然回读已迁移的视频上传方式');
  if (created.sharedCharacteristics?.length !== 2 || created.variantCharacteristics?.length !== 1) throw new Error('类目 characteristic 默认值创建后没有完整回读');
  const duplicate = await request('POST', '/api/v1/wb/presets', { ...definition, name: prefix.toLocaleLowerCase('zh-CN') }, 409);
  if (duplicate.data?.error?.code !== 'CONFIG_INVALID') throw new Error('名称唯一冲突没有返回 CONFIG_INVALID');

  const updated = (await request('PUT', `/api/v1/wb/presets/${created.id}`, { ...definition, brand: 'SmokeBrand', rowVersion: created.rowVersion })).data.preset;
  const stale = await request('PUT', `/api/v1/wb/presets/${created.id}`, { ...definition, brand: 'StaleBrand', rowVersion: created.rowVersion }, 409);
  if (stale.data?.error?.code !== 'VERSION_CONFLICT') throw new Error('过期 rowVersion 没有返回 VERSION_CONFLICT');

  const cloned = (await request('POST', `/api/v1/wb/presets/${created.id}/clone`, { name: `${prefix}-副本` })).data.preset;
  createdIds.add(cloned.id);
  if (cloned.isDefault) throw new Error('复制件不应自动成为默认');
  if (Object.hasOwn(cloned, 'videoUploadMode')) throw new Error('复制预设 API 仍然回读已迁移的视频上传方式');
  if (cloned.sharedCharacteristics?.length !== 2 || cloned.variantCharacteristics?.length !== 1) throw new Error('复制预设时丢失了类目 characteristic 默认值');
  const missingDefaultVersion = await request('POST', `/api/v1/wb/presets/${cloned.id}/default`, {}, 400);
  if (missingDefaultVersion.data?.error?.code !== 'CONFIG_INVALID') throw new Error('设为默认缺少 rowVersion 时没有 fail-closed');
  const selected = (await request('POST', `/api/v1/wb/presets/${cloned.id}/default`, { rowVersion: cloned.rowVersion })).data.preset;
  if (!selected.isDefault) throw new Error('默认预设切换失败');
  const missingDeleteVersion = await request('DELETE', `/api/v1/wb/presets/${created.id}`, undefined, 400);
  if (missingDeleteVersion.data?.error?.code !== 'CONFIG_INVALID') throw new Error('删除缺少 rowVersion 时没有 fail-closed');

  const refreshedOriginal = (await request('GET', `/api/v1/wb/presets/${created.id}`)).data.preset;
  await request('DELETE', `/api/v1/wb/presets/${created.id}?rowVersion=${refreshedOriginal.rowVersion}`);
  createdIds.delete(created.id);
  const refreshedClone = (await request('GET', `/api/v1/wb/presets/${cloned.id}`)).data.preset;
  await request('DELETE', `/api/v1/wb/presets/${cloned.id}?rowVersion=${refreshedClone.rowVersion}`);
  createdIds.delete(cloned.id);
  const after = (await request('GET', '/api/v1/wb/presets')).data.items || [];
  const beforeIds = before.map((item) => item.id).sort();
  const afterIds = after.map((item) => item.id).sort();
  if (JSON.stringify(beforeIds) !== JSON.stringify(afterIds)) throw new Error('烟雾测试清理后预设集合没有恢复原状');
  result = {
    ok: true,
    beforeCount: before.length,
    afterCount: after.length,
    created: { readiness: created.readiness, wasDefault: created.isDefault },
    updated: { rowVersion: updated.rowVersion, brand: updated.brand },
    characteristicDefaults: { shared: created.sharedCharacteristics.length, variant: created.variantCharacteristics.length },
    cloned: { wasDefault: cloned.isDefault, shared: cloned.sharedCharacteristics.length, variant: cloned.variantCharacteristics.length },
    selectedDefault: selected.isDefault,
    safeguards: { legacyPresetVideoMode: 400, duplicateName: 409, staleUpdate: 409, missingDefaultRowVersion: 400, missingDeleteRowVersion: 400 },
    wbWriteEndpointsCalled: 0
  };
} finally {
  await cleanup();
}

console.log(JSON.stringify(result, null, 2));
