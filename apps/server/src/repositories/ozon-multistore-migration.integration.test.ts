import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { OZON_DEFAULT_STORE_ID } from '@n8n-media-review/shared';
import { OzonStoreRepository } from './ozon-stores.js';
import { OzonRepository } from './ozon.js';

const connectionString = process.env.DATABASE_URL;
const schema = `ozon_multistore_restart_${randomUUID().replaceAll('-', '')}`;
let admin: Pool;
let isolatedConnectionString: string;
let stores: OzonStoreRepository;

describe.runIf(Boolean(connectionString))('OZON multistore legacy migration replay PostgreSQL', () => {
  beforeAll(async () => {
    admin = new Pool({ connectionString, max: 1 });
    await admin.query(`CREATE SCHEMA ${schema}`);
    await admin.query(`CREATE TABLE ${schema}.products (
      sku CHAR(7) PRIMARY KEY,product_name TEXT NOT NULL DEFAULT '',created_at TIMESTAMPTZ NOT NULL
    )`);
    await admin.query(`CREATE TABLE ${schema}.product_variants (
      id UUID PRIMARY KEY,sku CHAR(7) NOT NULL,name TEXT NOT NULL,normalized_name TEXT NOT NULL DEFAULT '',
      sort_order INTEGER NOT NULL DEFAULT 0,created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
    const isolatedUrl = new URL(connectionString!);
    isolatedUrl.searchParams.set('options', `-c search_path=${schema},public`);
    isolatedConnectionString = isolatedUrl.toString();

    const legacy = new OzonRepository(isolatedConnectionString);
    await legacy.initialize();
    await legacy.close();
    stores = new OzonStoreRepository(isolatedConnectionString);
    await stores.initialize();
  });

  afterAll(async () => {
    await stores?.close();
    await admin?.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin?.end();
  });

  it('restarts idempotently with split shared-preparation and store-publication active slots', async () => {
    const secondStore = await stores.createStore({
      storeAlias: 'store-two', displayName: 'Store Two', autoPublishEnabled: false,
      autoPublishMode: 'CREATE_ONLY', warehouseId: '', warehouseName: '', fulfillmentMode: 'FBS',
      accountCurrency: 'RUB', maxDailyStyles: 100
    });
    const sku = '0000119';
    const defaultPublicationId = randomUUID();
    const secondPublicationId = randomUUID();
    const sharedPreparationId = randomUUID();
    await admin.query(`INSERT INTO ${schema}.ozon_publish_jobs(
      id,sku,state,source,task_kind,store_alias,store_id,credential_binding_mode
    ) VALUES
      ($1,$4,'READY','AUTO','STORE_PUBLICATION','default',$5,'PURE_LEGACY'),
      ($2,$4,'READY','AUTO','STORE_PUBLICATION','store-two',$6,'PURE_LEGACY'),
      ($3,$4,'READY','AUTO','SHARED_PREPARATION','default',$5,'PURE_LEGACY')`, [
      defaultPublicationId, secondPublicationId, sharedPreparationId,
      sku, OZON_DEFAULT_STORE_ID, secondStore.id
    ]);

    for (let replay = 0; replay < 2; replay += 1) {
      const restarted = new OzonRepository(isolatedConnectionString);
      await expect(restarted.initialize()).resolves.toBeUndefined();
      await restarted.close();
    }

    const indexes = await admin.query<{ indexname: string; indexdef: string }>(`
      SELECT indexname,indexdef FROM pg_indexes
      WHERE schemaname=$1 AND indexname IN (
        'ozon_publish_jobs_one_active_per_sku',
        'ozon_publish_jobs_one_active_per_store_sku',
        'ozon_publish_jobs_one_active_shared_preparation',
        'ozon_publish_jobs_one_active_publication_per_store_sku'
      ) ORDER BY indexname`, [schema]);
    expect(indexes.rows.map((row) => row.indexname)).toEqual([
      'ozon_publish_jobs_one_active_publication_per_store_sku',
      'ozon_publish_jobs_one_active_shared_preparation'
    ]);
    const publicationIndex = indexes.rows.find((row) => row.indexname === 'ozon_publish_jobs_one_active_publication_per_store_sku')?.indexdef || '';
    const preparationIndex = indexes.rows.find((row) => row.indexname === 'ozon_publish_jobs_one_active_shared_preparation')?.indexdef || '';
    expect(publicationIndex).toMatch(/UNIQUE INDEX.*\(store_id, sku\)/);
    expect(publicationIndex).toContain('STORE_PUBLICATION');
    expect(publicationIndex).toContain('LEGACY');
    expect(preparationIndex).toMatch(/UNIQUE INDEX.*\(sku\)/);
    expect(preparationIndex).toContain('SHARED_PREPARATION');
    expect(publicationIndex).not.toContain('NEEDS_ATTENTION');
    expect(preparationIndex).not.toContain('NEEDS_ATTENTION');

    await expect(admin.query(`INSERT INTO ${schema}.ozon_publish_jobs(
      id,sku,state,source,task_kind,store_alias,store_id,credential_binding_mode
    ) VALUES($1,$2,'WAITING_MEDIA','AUTO','SHARED_PREPARATION','store-two',$3,'PURE_LEGACY')`, [
      randomUUID(), sku, secondStore.id
    ])).rejects.toMatchObject({ code: '23505' });

    await expect(admin.query(`INSERT INTO ${schema}.ozon_publish_jobs(
      id,sku,state,source,task_kind,store_alias,store_id,credential_binding_mode
    ) VALUES($1,$2,'WAITING_MEDIA','MANUAL','STORE_PUBLICATION','default',$3,'PURE_LEGACY')`, [
      randomUUID(), sku, OZON_DEFAULT_STORE_ID
    ])).rejects.toMatchObject({ code: '23505' });

    await admin.query(`UPDATE ${schema}.ozon_publish_jobs SET state='NEEDS_ATTENTION'
      WHERE id=ANY($1::uuid[])`, [[defaultPublicationId, sharedPreparationId]]);
    await expect(admin.query(`INSERT INTO ${schema}.ozon_publish_jobs(
      id,sku,state,source,task_kind,store_alias,store_id,credential_binding_mode
    ) VALUES
      ($1,$3,'READY','MANUAL','STORE_PUBLICATION','default',$4,'PURE_LEGACY'),
      ($2,$3,'READY','AUTO','SHARED_PREPARATION','default',$4,'PURE_LEGACY')`, [
      randomUUID(), randomUUID(), sku, OZON_DEFAULT_STORE_ID
    ])).resolves.toMatchObject({ rowCount: 2 });

    const needsAttentionReplay = new OzonRepository(isolatedConnectionString);
    await expect(needsAttentionReplay.initialize()).resolves.toBeUndefined();
    await needsAttentionReplay.close();

    await admin.query(`DROP INDEX ${schema}.ozon_publish_jobs_one_active_publication_per_store_sku`);
    await admin.query(`INSERT INTO ${schema}.ozon_publish_jobs(
      id,sku,state,source,task_kind,store_alias,store_id,credential_binding_mode
    ) VALUES($1,$2,'WAITING_MEDIA','MANUAL','STORE_PUBLICATION','default',$3,'PURE_LEGACY')`, [
      randomUUID(), sku, OZON_DEFAULT_STORE_ID
    ]);
    const corruptedReplay = new OzonRepository(isolatedConnectionString);
    await expect(corruptedReplay.initialize()).rejects.toThrow(/duplicate active store publications/);
    await corruptedReplay.close();
  });
});
