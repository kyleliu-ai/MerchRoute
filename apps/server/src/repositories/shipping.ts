import { randomUUID } from 'node:crypto';
import { Pool, type PoolClient, type QueryResultRow } from 'pg';
import {
  AppError,
  commercePlatformCodeSchema,
  shippingScenarioCodeSchema,
  shippingTemplateDefinitionSchema,
  type ShippingPlatformCode,
  type ShippingTemplateDefinitionV1,
  type ShippingTemplateType
} from '@n8n-media-review/shared';
import { calculateShipping, validateShippingDefinition } from '../services/shipping/calculator.js';
import { CEL_SHIPPING_SEEDS } from '../services/shipping/seed.js';

type SqlRow = Record<string, any>;
export type CarrierInput = { code: string; displayName: string; active?: boolean };
export type TemplateInput = { carrierCode: string; platformCode: ShippingPlatformCode; scenarioCode?: string; templateType?: ShippingTemplateType; name: string };

export class ShippingRepository {
  private pool?: Pool;

  constructor(private readonly connectionString?: string) {}

  get configured() { return Boolean(this.pool); }

  async initialize() {
    if (!this.connectionString) return;
    this.pool = new Pool({ connectionString: this.connectionString, max: 4, idleTimeoutMillis: 30_000 });
    try {
      await this.pool.query('SELECT 1');
      await this.migrate();
      await this.seedCelTemplates();
    } catch (error) {
      await this.pool.end().catch(() => undefined);
      this.pool = undefined;
      throw error;
    }
  }

  async close() { await this.pool?.end(); }

  async listCarriers(includeInactive = true) {
    const rows = await this.query<SqlRow>(`SELECT code, display_name, active, created_at, updated_at FROM shipping_carriers ${includeInactive ? '' : 'WHERE active = true'} ORDER BY active DESC, code`);
    return rows.rows.map(toCarrier);
  }

  async createCarrier(input: CarrierInput) {
    const code = validateCarrierCode(input.code);
    if (!input.displayName?.trim()) throw new AppError('CONFIG_INVALID', '承运商名称不能为空');
    try {
      const result = await this.query<SqlRow>(`INSERT INTO shipping_carriers (code, display_name, active) VALUES ($1,$2,$3)
        RETURNING code, display_name, active, created_at, updated_at`, [code, input.displayName.trim(), input.active ?? true]);
      return toCarrier(result.rows[0]!);
    } catch (error: any) {
      if (error?.code === '23505') throw new AppError('CONFIG_INVALID', '承运商代码已存在，代码不可复用', { code }, 409);
      throw error;
    }
  }

  async updateCarrier(codeValue: string, input: Partial<CarrierInput>) {
    const code = validateCarrierCode(codeValue);
    if (input.displayName !== undefined && !input.displayName.trim()) throw new AppError('CONFIG_INVALID', '承运商名称不能为空');
    const result = await this.query<SqlRow>(`UPDATE shipping_carriers SET display_name = COALESCE($2, display_name), active = COALESCE($3, active), updated_at = NOW()
      WHERE code = $1 RETURNING code, display_name, active, created_at, updated_at`, [code, input.displayName?.trim() || null, input.active ?? null]);
    if (!result.rows[0]) throw new AppError('NOT_FOUND', '承运商不存在', { code }, 404);
    return toCarrier(result.rows[0]);
  }

  async listTemplates() {
    const result = await this.query<SqlRow>(`
      SELECT t.id, t.name, t.platform_code, t.template_type, t.active, t.created_at, t.updated_at,
        c.code AS carrier_code, c.display_name AS carrier_name, c.active AS carrier_active,
        draft.id AS draft_version_id, draft.version_no AS draft_version_no, draft.updated_at AS draft_updated_at,
        published.id AS published_version_id, published.version_no AS published_version_no, published.published_at
      FROM shipping_templates t
      JOIN shipping_carriers c ON c.code = t.carrier_code
      LEFT JOIN LATERAL (SELECT id, version_no, updated_at FROM shipping_template_versions WHERE template_id = t.id AND status = 'DRAFT' LIMIT 1) draft ON true
      LEFT JOIN LATERAL (SELECT id, version_no, published_at FROM shipping_template_versions WHERE template_id = t.id AND status = 'PUBLISHED' LIMIT 1) published ON true
      ORDER BY t.active DESC, t.platform_code, t.template_type, c.code`);
    return result.rows.map(toTemplateSummary);
  }

  async getTemplate(id: string) {
    const template = await this.query<SqlRow>(`SELECT t.*, c.display_name AS carrier_name, c.active AS carrier_active FROM shipping_templates t JOIN shipping_carriers c ON c.code = t.carrier_code WHERE t.id = $1`, [id]);
    if (!template.rows[0]) throw new AppError('NOT_FOUND', '运费模板不存在', { id }, 404);
    const versions = await this.query<SqlRow>(`SELECT id, version_no, status, definition, source_reference, created_at, updated_at, published_at
      FROM shipping_template_versions WHERE template_id = $1 ORDER BY version_no DESC`, [id]);
    return { ...toTemplateBase(template.rows[0]), versions: versions.rows.map(toVersion) };
  }

  async createTemplate(input: TemplateInput) {
    const platformCode = commercePlatformCodeSchema.parse(input.platformCode);
    const scenarioCode = shippingScenarioCodeSchema.parse(input.scenarioCode || input.templateType);
    if (!input.name?.trim()) throw new AppError('CONFIG_INVALID', '模板名称不能为空');
    const carrierCode = validateCarrierCode(input.carrierCode);
    return this.transaction(async (client) => {
      await requireActiveCarrier(client, carrierCode);
      const id = randomUUID();
      try {
        await client.query(`INSERT INTO shipping_templates (id, carrier_code, platform_code, template_type, name) VALUES ($1,$2,$3,$4,$5)`, [id, carrierCode, platformCode, scenarioCode, input.name.trim()]);
      } catch (error: any) {
        if (error?.code === '23505') throw new AppError('CONFIG_INVALID', '该承运商在此平台和场景下已有启用模板', undefined, 409);
        throw error;
      }
      await client.query(`INSERT INTO shipping_template_versions (id, template_id, version_no, status, definition) VALUES ($1,$2,1,'DRAFT',$3::jsonb)`, [randomUUID(), id, JSON.stringify(emptyDefinition())]);
      return this.getTemplateWithClient(client, id);
    });
  }

  async updateTemplate(id: string, input: { name?: string; active?: boolean }) {
    if (input.name !== undefined && !input.name.trim()) throw new AppError('CONFIG_INVALID', '模板名称不能为空');
    try {
      const result = await this.query<SqlRow>(`UPDATE shipping_templates SET name = COALESCE($2, name), active = COALESCE($3, active), updated_at = NOW()
        WHERE id = $1 RETURNING id`, [id, input.name?.trim() || null, input.active ?? null]);
      if (!result.rows[0]) throw new AppError('NOT_FOUND', '运费模板不存在', { id }, 404);
      return this.getTemplate(id);
    } catch (error: any) {
      if (error?.code === '23505') throw new AppError('CONFIG_INVALID', '启用后会与现有模板冲突', undefined, 409);
      throw error;
    }
  }

  async saveDraft(id: string, definitionInput: unknown) {
    const parsed = shippingTemplateDefinitionSchema.safeParse(definitionInput);
    if (!parsed.success) throw new AppError('CONFIG_INVALID', parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('；'), { issues: parsed.error.issues });
    const definition = parsed.data;
    return this.transaction(async (client) => {
      const template = await client.query<SqlRow>('SELECT id FROM shipping_templates WHERE id = $1 FOR UPDATE', [id]);
      if (!template.rows[0]) throw new AppError('NOT_FOUND', '运费模板不存在', { id }, 404);
      const draft = await client.query<SqlRow>(`SELECT id FROM shipping_template_versions WHERE template_id = $1 AND status = 'DRAFT' FOR UPDATE`, [id]);
      if (draft.rows[0]) {
        await client.query(`UPDATE shipping_template_versions SET definition = $2::jsonb, updated_at = NOW() WHERE id = $1`, [draft.rows[0].id, JSON.stringify(definition)]);
      } else {
        const latest = await client.query<SqlRow>('SELECT COALESCE(MAX(version_no),0) AS version_no FROM shipping_template_versions WHERE template_id = $1', [id]);
        await client.query(`INSERT INTO shipping_template_versions (id, template_id, version_no, status, definition) VALUES ($1,$2,$3,'DRAFT',$4::jsonb)`, [randomUUID(), id, Number(latest.rows[0]?.version_no || 0) + 1, JSON.stringify(definition)]);
      }
      return this.getTemplateWithClient(client, id);
    });
  }

  async cloneTemplate(id: string, input: { carrierCode: string; name: string }) {
    const carrierCode = validateCarrierCode(input.carrierCode);
    if (!input.name?.trim()) throw new AppError('CONFIG_INVALID', '新模板名称不能为空');
    return this.transaction(async (client) => {
      await requireActiveCarrier(client, carrierCode);
      const source = await client.query<SqlRow>(`SELECT t.platform_code, t.template_type, v.definition, v.source_reference
        FROM shipping_templates t JOIN shipping_template_versions v ON v.template_id = t.id AND v.status = 'PUBLISHED' WHERE t.id = $1`, [id]);
      if (!source.rows[0]) throw new AppError('CONFIG_INVALID', '只能复制已有发布版本的模板', { id }, 409);
      const newId = randomUUID();
      try {
        await client.query(`INSERT INTO shipping_templates (id, carrier_code, platform_code, template_type, name) VALUES ($1,$2,$3,$4,$5)`, [newId, carrierCode, source.rows[0].platform_code, source.rows[0].template_type, input.name.trim()]);
      } catch (error: any) {
        if (error?.code === '23505') throw new AppError('CONFIG_INVALID', '目标承运商在此平台和场景下已有启用模板', undefined, 409);
        throw error;
      }
      await client.query(`INSERT INTO shipping_template_versions (id, template_id, version_no, status, definition, source_reference)
        VALUES ($1,$2,1,'DRAFT',$3::jsonb,$4::jsonb)`, [randomUUID(), newId, JSON.stringify(source.rows[0].definition), JSON.stringify({ clonedFromTemplateId: id, originalSource: source.rows[0].source_reference })]);
      return this.getTemplateWithClient(client, newId);
    });
  }

  async publishTemplate(id: string) {
    return this.transaction(async (client) => {
      const template = await client.query<SqlRow>('SELECT id, template_type, active FROM shipping_templates WHERE id = $1 FOR UPDATE', [id]);
      if (!template.rows[0]) throw new AppError('NOT_FOUND', '运费模板不存在', { id }, 404);
      if (!template.rows[0].active) throw new AppError('CONFIG_INVALID', '已归档模板不能发布', undefined, 409);
      const draft = await client.query<SqlRow>(`SELECT id, definition FROM shipping_template_versions WHERE template_id = $1 AND status = 'DRAFT' FOR UPDATE`, [id]);
      if (!draft.rows[0]) throw new AppError('CONFIG_INVALID', '没有可发布的草稿版本', undefined, 409);
      let definition: ShippingTemplateDefinitionV1;
      try { definition = validateShippingDefinition(draft.rows[0].definition, template.rows[0].template_type); }
      catch (error) { throw new AppError('CONFIG_INVALID', error instanceof Error ? error.message : '模板规则无效'); }
      await client.query(`UPDATE shipping_template_versions SET status = 'ARCHIVED', updated_at = NOW() WHERE template_id = $1 AND status = 'PUBLISHED'`, [id]);
      await client.query(`UPDATE shipping_template_versions SET status = 'PUBLISHED', definition = $2::jsonb, published_at = NOW(), updated_at = NOW() WHERE id = $1`, [draft.rows[0].id, JSON.stringify(definition)]);
      return this.getTemplateWithClient(client, id);
    });
  }

  async calculate(input: unknown) {
    const identity = input as Record<string, unknown>;
    const templateId = String(identity.shippingTemplateId || '');
    const platformCode = String(identity.platformCode || '').trim().toUpperCase();
    const templateType = String(identity.scenarioCode || identity.templateType || '').trim().toUpperCase();
    const carrierCode = String(identity.carrierCode || '').trim().toUpperCase();
    const result = await this.query<SqlRow>(`SELECT t.id AS template_id, t.name AS template_name, t.platform_code, t.template_type,
        c.code AS carrier_code, c.display_name AS carrier_name, v.id AS version_id, v.version_no, v.definition
      FROM shipping_templates t JOIN shipping_carriers c ON c.code = t.carrier_code
      JOIN shipping_template_versions v ON v.template_id = t.id AND v.status = 'PUBLISHED'
      WHERE t.active = true AND c.active = true AND (($1 <> '' AND t.id = NULLIF($1,'')::uuid) OR ($1 = '' AND t.platform_code = $2 AND t.template_type = $3 AND t.carrier_code = $4))`, [templateId, platformCode, templateType, carrierCode]);
    const row = result.rows[0];
    if (!row) throw new AppError('NOT_FOUND', '没有找到可用的已发布运费模板', { platformCode, templateType, carrierCode }, 404);
    return calculateShipping({
      templateId: row.template_id, versionId: row.version_id, versionNo: Number(row.version_no), platformCode: row.platform_code,
      scenarioCode: row.template_type, templateType: row.template_type, carrierCode: row.carrier_code, carrierName: row.carrier_name, templateName: row.template_name
    }, row.definition, input);
  }

  private async migrate() {
    await this.query(`CREATE TABLE IF NOT EXISTS shipping_schema_migrations (id TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
    const applied = await this.query('SELECT id FROM shipping_schema_migrations WHERE id = $1', ['001_shipping_templates']);
    if (applied.rows[0]) return;
    await this.transaction(async (client) => {
      await client.query(`CREATE TABLE shipping_carriers (
        code TEXT PRIMARY KEY CHECK (code ~ '^[A-Z0-9_-]{2,32}$'), display_name TEXT NOT NULL, active BOOLEAN NOT NULL DEFAULT true,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
      await client.query(`CREATE TABLE shipping_templates (
        id UUID PRIMARY KEY, carrier_code TEXT NOT NULL REFERENCES shipping_carriers(code), platform_code TEXT NOT NULL CHECK (platform_code IN ('OZON','WB','YANDEX')),
        template_type TEXT NOT NULL CHECK (template_type IN ('OZON_RFBS','OZON_CIS','WB')), name TEXT NOT NULL, active BOOLEAN NOT NULL DEFAULT true,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
      await client.query(`CREATE UNIQUE INDEX shipping_templates_one_active_identity ON shipping_templates (carrier_code, platform_code, template_type) WHERE active = true`);
      await client.query(`CREATE TABLE shipping_template_versions (
        id UUID PRIMARY KEY, template_id UUID NOT NULL REFERENCES shipping_templates(id) ON DELETE RESTRICT, version_no INTEGER NOT NULL CHECK (version_no > 0),
        status TEXT NOT NULL CHECK (status IN ('DRAFT','PUBLISHED','ARCHIVED')), definition JSONB NOT NULL, source_reference JSONB,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), published_at TIMESTAMPTZ,
        UNIQUE (template_id, version_no))`);
      await client.query(`CREATE UNIQUE INDEX shipping_template_versions_one_draft ON shipping_template_versions (template_id) WHERE status = 'DRAFT'`);
      await client.query(`CREATE UNIQUE INDEX shipping_template_versions_one_published ON shipping_template_versions (template_id) WHERE status = 'PUBLISHED'`);
      await client.query(`INSERT INTO shipping_schema_migrations (id) VALUES ('001_shipping_templates')`);
    });
  }

  private async seedCelTemplates() {
    await this.transaction(async (client) => {
      await client.query(`INSERT INTO shipping_carriers (code, display_name, active) VALUES ('CEL','CEL 物流',true) ON CONFLICT (code) DO NOTHING`);
      for (const seed of CEL_SHIPPING_SEEDS) {
        await client.query(`INSERT INTO shipping_templates (id, carrier_code, platform_code, template_type, name, active)
          VALUES ($1,'CEL',$2,$3,$4,true) ON CONFLICT (id) DO NOTHING`, [seed.id, seed.platformCode, seed.templateType, seed.name]);
        for (const historicalVersion of seed.historicalVersions) {
          await client.query(`INSERT INTO shipping_template_versions (id, template_id, version_no, status, definition, source_reference, published_at)
            VALUES ($1,$2,$3,'ARCHIVED',$4::jsonb,$5::jsonb,NOW()) ON CONFLICT DO NOTHING`, [historicalVersion.versionId, seed.id, historicalVersion.versionNo, JSON.stringify(historicalVersion.definition), JSON.stringify(historicalVersion.sourceReference)]);
        }
        const currentVersion = await client.query('SELECT id FROM shipping_template_versions WHERE id = $1 FOR UPDATE', [seed.versionId]);
        if (currentVersion.rows[0]) continue;
        const latestVersion = await client.query<SqlRow>('SELECT COALESCE(MAX(version_no),0) AS version_no FROM shipping_template_versions WHERE template_id = $1', [seed.id]);
        const versionNo = Math.max(seed.versionNo, Number(latestVersion.rows[0]?.version_no || 0) + 1);
        const definition = validateShippingDefinition(seed.definition, seed.templateType);
        await client.query(`UPDATE shipping_template_versions SET status = 'ARCHIVED', updated_at = NOW() WHERE template_id = $1 AND status = 'PUBLISHED'`, [seed.id]);
        await client.query(`INSERT INTO shipping_template_versions (id, template_id, version_no, status, definition, source_reference, published_at)
          VALUES ($1,$2,$3,'PUBLISHED',$4::jsonb,$5::jsonb,NOW())`, [seed.versionId, seed.id, versionNo, JSON.stringify(definition), JSON.stringify(seed.sourceReference)]);
        await client.query('UPDATE shipping_templates SET name = $2, updated_at = NOW() WHERE id = $1', [seed.id, seed.name]);
      }
    });
  }

  private async getTemplateWithClient(client: PoolClient, id: string) {
    const template = await client.query<SqlRow>(`SELECT t.*, c.display_name AS carrier_name, c.active AS carrier_active FROM shipping_templates t JOIN shipping_carriers c ON c.code = t.carrier_code WHERE t.id = $1`, [id]);
    const versions = await client.query<SqlRow>(`SELECT id, version_no, status, definition, source_reference, created_at, updated_at, published_at FROM shipping_template_versions WHERE template_id = $1 ORDER BY version_no DESC`, [id]);
    return { ...toTemplateBase(template.rows[0]!), versions: versions.rows.map(toVersion) };
  }

  private query<T extends QueryResultRow = QueryResultRow>(text: string, values: unknown[] = []) { return this.requirePool().query<T>(text, values); }
  private async transaction<T>(operation: (client: PoolClient) => Promise<T>) {
    const client = await this.requirePool().connect();
    try { await client.query('BEGIN'); const result = await operation(client); await client.query('COMMIT'); return result; }
    catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
  }
  private requirePool() { if (!this.pool) throw new AppError('DATABASE_UNAVAILABLE', '运费模板尚未配置 PostgreSQL DATABASE_URL', undefined, 503); return this.pool; }
}

function emptyDefinition(): ShippingTemplateDefinitionV1 { return { schemaVersion: '1', currency: 'CNY', services: [] }; }
function validateCarrierCode(value: string) {
  const code = value?.trim().toUpperCase();
  if (!/^[A-Z0-9_-]{2,32}$/.test(code)) throw new AppError('CONFIG_INVALID', '承运商代码必须为 2-32 位大写字母、数字、下划线或连字符');
  return code;
}
async function requireActiveCarrier(client: PoolClient, code: string) {
  const carrier = await client.query('SELECT code FROM shipping_carriers WHERE code = $1 AND active = true', [code]);
  if (!carrier.rows[0]) throw new AppError('CONFIG_INVALID', '承运商不存在或已停用', { code }, 404);
}
function toCarrier(row: SqlRow) { return { code: row.code, displayName: row.display_name, active: Boolean(row.active), createdAt: row.created_at, updatedAt: row.updated_at }; }
function toTemplateBase(row: SqlRow) { return { id: row.id, name: row.name, platformCode: row.platform_code, scenarioCode: row.template_type, templateType: row.template_type, active: Boolean(row.active), carrierCode: row.carrier_code, carrierName: row.carrier_name, carrierActive: Boolean(row.carrier_active), createdAt: row.created_at, updatedAt: row.updated_at }; }
function toVersion(row: SqlRow) { return { id: row.id, versionNo: Number(row.version_no), status: row.status, definition: row.definition, sourceReference: row.source_reference, createdAt: row.created_at, updatedAt: row.updated_at, publishedAt: row.published_at }; }
function toTemplateSummary(row: SqlRow) { return { ...toTemplateBase(row), draftVersion: row.draft_version_id ? { id: row.draft_version_id, versionNo: Number(row.draft_version_no), updatedAt: row.draft_updated_at } : undefined, publishedVersion: row.published_version_id ? { id: row.published_version_id, versionNo: Number(row.published_version_no), publishedAt: row.published_at } : undefined }; }
