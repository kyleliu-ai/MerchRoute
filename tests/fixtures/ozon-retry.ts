import { randomUUID } from 'node:crypto';
import { OZON_DEFAULT_STORE_ID, ozonProductSchema } from '@n8n-media-review/shared';
import { retryHash, type OzonRetrySnapshot } from '../../apps/server/src/repositories/ozon-retry.js';

export function retryFixture(sku = '9900171'): OzonRetrySnapshot {
  const jobId = randomUUID(), publicationId = randomUUID(), versionId = randomUUID(), credentialId = randomUUID();
  const hash = 'sha256:' + 'a'.repeat(64);
  const product = ozonProductSchema.parse({
    schemaVersion: 1, storeAlias: 'default', productCode: sku, productName: '测试商品', revision: 1,
    contentPolicyVersion: 'merchroute-ozon-content-v4', materialHash: hash, materialHashVersion: 'ozon-shared-material-v1',
    fulfillmentMode: 'FBS', warehouseId: '12345', currency: 'RUB', vat: '0.2',
    category: { categoryKey: 'ozon_1_2', descriptionCategoryId: 1, typeId: 2, templateVersion: 1, schemaHash: hash },
    titleRu: 'Женская сумка через плечо', descriptionRu: 'Описание товара', brand: '',
    dimensions: { length: 300, width: 200, height: 120, weight: 700 }, sharedAttributes: [],
    offers: ['01', '02'].map(code => ({ variantId: randomUUID(), variantCode: code, offerId: sku + '-' + code, price: 400, stock: 1,
      media: [ { assetId: 'image', relativePath: 'images/01.png', kind: 'image', sortOrder: 0, isPrimary: true },
        { assetId: 'video', relativePath: 'videos/main.mp4', kind: 'video', sortOrder: 1 } ] }))
  });
  const offerIds = product.offers.map(o => o.offerId);
  const offerHash = retryHash({ storeId: OZON_DEFAULT_STORE_ID, generatedVersionId: versionId, offerIds: [...offerIds].sort() });
  const data = { offers: product.offers };
  return {
    job: { id: jobId, sku, state: 'NEEDS_ATTENTION', source: 'AUTO', task_kind: 'STORE_PUBLICATION',
      publication_id: publicationId, store_id: OZON_DEFAULT_STORE_ID, task_id: 'default__' + sku + '__r1',
      credential_version_id: credentialId, credential_binding_mode: 'VAULT', store_config_version: 1,
      materialization_hash: hash, offer_contract_hash: offerHash, offer_ids: offerIds, row_version: 1,
      payload: { schemaVersion: 4, mode: 'MULTISTORE_PUBLICATION', contentPolicyVersion: product.contentPolicyVersion,
        materialHash: hash, materialHashVersion: product.materialHashVersion, publicationMode: 'CREATE_ONLY',
        presetRowVersion: 1, planHash: hash, generatedVersionId: versionId, offerContractHash: offerHash },
      stage_states: { import: 'FAILED' }, last_error_message: '暂时不可用' },
    publication: { id: publicationId, sku, planned_job_id: jobId, store_id: OZON_DEFAULT_STORE_ID, generated_version_id: versionId,
      revision: 1, status: 'NEEDS_ATTENTION', task_id: 'default__' + sku + '__r1', store_alias_snapshot: 'default',
      materialized_product_snapshot: product, materialization_hash: hash, plan_hash: hash, request_id: randomUUID(),
      material_hash: hash, material_hash_version: product.materialHashVersion, content_policy_version: product.contentPolicyVersion,
      store_config_version: 1, credential_binding_mode: 'VAULT', credential_version_id: credentialId, publication_mode: 'CREATE_ONLY', preset_row_version: 1,
      warehouse_id: '12345', fulfillment_mode: 'FBS', account_currency: 'RUB', offer_ids: offerIds, offer_contract_hash: offerHash, row_version: 1 },
    store: { id: OZON_DEFAULT_STORE_ID, store_alias: 'default', display_name: '测试店铺', enabled: true, auto_publish_enabled: true,
      config_version: 1, active_credential_version_id: credentialId, preflight_status: 'PASSED', preflight_expires_at: new Date(Date.now() + 86_400_000) },
    version: { id: versionId, sku, revision: 1, snapshot: { sku, revision: 1, rowVersion: 1, managementSource: 'AUTO', data },
      content_policy_version: product.contentPolicyVersion, material_hash: hash, material_hash_version: product.materialHashVersion,
      source_media_identity_hash: hash },
    listing: { sku, row_version: 1, revision: 1, management_source: 'AUTO', data },
    settings: { enabled: true, root_directory: '/isolated-fixture', row_version: 1 }, gateways: [],
    credentials: [{ id: credentialId, store_id: OZON_DEFAULT_STORE_ID, status: 'ACTIVE', validated_at: new Date() }]
  };
}
