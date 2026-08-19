import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ShippingRepository } from './shipping.js';

const connectionString = process.env.DATABASE_URL;
const schema = `shipping_test_${randomUUID().replaceAll('-', '')}`;
let admin: Pool;
let repository: ShippingRepository;
let isolatedConnectionString: string;

describe.runIf(Boolean(connectionString))('shipping repository PostgreSQL integration', () => {
  beforeAll(async () => {
    admin = new Pool({ connectionString, max: 1 });
    await admin.query(`CREATE SCHEMA ${schema}`);
    const isolatedUrl = new URL(connectionString!);
    isolatedUrl.searchParams.set('options', `-c search_path=${schema}`);
    isolatedConnectionString = isolatedUrl.toString();
    repository = new ShippingRepository(isolatedConnectionString);
    await repository.initialize();
  });

  afterAll(async () => {
    await repository?.close();
    await admin?.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin?.end();
  });

  it('seeds idempotently, clones, publishes and calculates with the new immutable version', async () => {
    const initialTemplates = await repository.listTemplates();
    expect(initialTemplates).toHaveLength(3);
    expect(initialTemplates.every((template) => template.publishedVersion?.versionNo === 2)).toBe(true);
    const initialWb = initialTemplates.find((item) => item.templateType === 'WB')!;
    const initialWbDetails = await repository.getTemplate(initialWb.id);
    expect(initialWbDetails.versions).toHaveLength(2);
    expect(initialWbDetails.versions).toEqual(expect.arrayContaining([
      expect.objectContaining({ versionNo: 1, status: 'ARCHIVED' }),
      expect.objectContaining({ versionNo: 2, status: 'PUBLISHED', sourceReference: expect.objectContaining({ file: 'CEL产品资费表 V7.24(15).xlsx' }) })
    ]));
    await repository.close();
    repository = new ShippingRepository(isolatedConnectionString);
    await repository.initialize();
    expect((await repository.listTemplates())).toHaveLength(3);
    expect((await repository.getTemplate(initialWb.id)).versions).toHaveLength(2);
    await repository.createCarrier({ code: 'UNI', displayName: 'UNI 物流' });
    const wb = (await repository.listTemplates()).find((item) => item.templateType === 'WB')!;
    const cloned = await repository.cloneTemplate(wb.id, { carrierCode: 'UNI', name: 'UNI WB 测试模板' });
    const draft = cloned.versions.find((version: any) => version.status === 'DRAFT')!;
    const definition = structuredClone(draft.definition);
    definition.services.find((service: any) => service.code === 'CEL_WB_ECONOMY').rules[0].pricing.ratePerKg = '60';
    await repository.saveDraft(cloned.id, definition);
    const published = await repository.publishTemplate(cloned.id);
    expect(published.versions.find((version: any) => version.status === 'PUBLISHED')).toMatchObject({ versionNo: 1 });
    const result = await repository.calculate({ platformCode: 'WB', templateType: 'WB', carrierCode: 'UNI', actualWeightGrams: '200', lengthCm: '10', widthCm: '10', heightCm: '10' });
    expect(result.summary.cheapestFreightAmount).toBe('14.00');
    expect(result.template.carrierCode).toBe('UNI');
    expect(result.template.versionId).toBe(published.versions.find((version: any) => version.status === 'PUBLISHED').id);
  });
});
