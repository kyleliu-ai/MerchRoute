import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Pool, type PoolClient } from 'pg';
import { AppError, type OzonColorIdentity, type PricingProductQueryInput, type PricingProductSnapshot, type ProductVariant, type WbColorIdentity } from '@n8n-media-review/shared';
import { assertSafeDownloadRoot } from '../utils/download-path-safety.js';

export type DownloadJobStatus = 'QUEUED' | 'WAITING_RESOURCE' | 'RUNNING' | 'SUCCEEDED' | 'FAILED';
export type DownloadRecoveryMode = 'MANUAL' | 'IDEMPOTENT_REPLAY';
const DOWNLOAD_RESOURCE_RETRY_DELAYS_MS = [15_000, 30_000, 60_000, 120_000, 300_000] as const;
const DOWNLOAD_RESOURCE_RETRY_MAX_ATTEMPTS = 12;
const DOWNLOAD_RESOURCE_RETRY_BUDGET_MS = 30 * 60_000;

export function downloadResourceRetryDelayMs(retryCount: number): number {
  const index = Math.max(0, Math.min(DOWNLOAD_RESOURCE_RETRY_DELAYS_MS.length - 1, retryCount - 1));
  return DOWNLOAD_RESOURCE_RETRY_DELAYS_MS[index]!;
}
export type PurchaseInput = {
  productName: string;
  downloadWorkflowCode?: string;
  purchasePrice: string;
  retailPrice?: string | null;
  courierFee?: string | null;
  currency?: string;
  grossWeightGrams?: string | null;
  lengthCm?: string | null;
  widthCm?: string | null;
  heightCm?: string | null;
  netWeightGrams?: string | null;
  productHeightCm?: string | null;
  productDepthCm?: string | null;
  productWidthCm?: string | null;
  transportMode?: string;
  providerUrl: string;
};
export type LocalImportStatus = 'COPYING' | 'IMPORTED' | 'SKIPPED_DUPLICATE' | 'COPY_FAILED_RETRYABLE';
export type LocalImportSourceInput = {
  platform: string;
  relativePath: string;
  normalizedPathKey: string;
  isPrimary: boolean;
  externalSku?: string;
  informationFileRelativePath?: string;
  informationFileSha256?: string;
  providerUrl?: string;
  targetSubdirectory: string;
  copyManifest: Record<string, unknown>;
};
export type ReserveLocalImportInput = {
  idempotencyKey: string;
  previewHash: string;
  sourceConfigSnapshot: Record<string, unknown>;
  targetConfigSnapshot: Record<string, unknown>;
  purchase: PurchaseInput;
  providerUrls: string[];
  sources: LocalImportSourceInput[];
};
export type LocalImportRecord = {
  id: string;
  idempotencyKey: string;
  sku?: string;
  duplicateSku?: string;
  status: LocalImportStatus;
  sourcePlatform?: string;
  importWorkflowLabel?: string;
  sourceConfigSnapshot: Record<string, unknown>;
  targetConfigSnapshot: Record<string, unknown>;
  previewHash: string;
  retryCount: number;
  errorCode?: string;
  errorMessage?: string;
  targetFolder?: string;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
  sources: Array<LocalImportSourceInput & { id: string }>;
  purchase?: ReturnType<typeof toLocalImportPurchase>;
};
export type LocalImportListItem = Omit<LocalImportRecord, 'sources'> & { sourceDirectoryCount: number };
export type LocalImportQuery = {
  page?: number;
  pageSize?: number;
  query?: string;
  platform?: string;
  status?: string;
  createdFrom?: string;
  createdTo?: string;
};
export type PurchaseEntryOriginSourceType = 'LOCAL_IMPORT' | 'URL_DOWNLOAD' | 'OTHER';
export type PurchaseEntryOrigin = {
  methodKey: string;
  label: string;
  platform?: string;
  workflowCode?: string;
  sourceType: PurchaseEntryOriginSourceType;
  sourceId?: string;
  recordedAt: string;
};
export type PurchaseListQuery = {
  page?: number;
  pageSize?: number;
  query?: string;
  status?: string;
  workflowCode?: string;
  createdFrom?: string;
  createdTo?: string;
  source?: string;
  entryMethodKey?: string;
  sort?: string;
};
export type WorkflowInput = {
  code: string;
  displayName: string;
  webhookUrl: string;
  parentOutputDir: string;
  timeoutMs?: number;
  enabled?: boolean;
  isDefault?: boolean;
  recoveryMode?: DownloadRecoveryMode;
};
export type DownloadBatchItemInput = { sku: string; workflowCode: string };
export type NotificationQuery = {
  page?: number;
  pageSize?: number;
  state?: 'ALL' | 'UNREAD' | 'UNRESOLVED';
  severity?: 'INFO' | 'SUCCESS' | 'WARNING' | 'ERROR';
  category?: string;
  sourceType?: string;
  eventType?: string;
  createdFrom?: string;
  createdTo?: string;
};
export type TaskNotificationSeverity = 'INFO' | 'SUCCESS' | 'WARNING' | 'ERROR';
export type TaskNotificationUpsertInput = {
  dedupeKey: string;
  category: string;
  eventType: string;
  severity: TaskNotificationSeverity;
  title: string;
  message: string;
  sourceType: string;
  sourceId: string;
  sku?: string;
  productName?: string;
  workflowCode?: string;
  details?: Record<string, unknown>;
};
export type TaskNotificationResolveInput = {
  dedupeKey?: string;
  sourceType?: string;
  sourceId?: string;
  eventType?: string;
  details?: Record<string, unknown>;
};
type SqlRow = Record<string, any>;
type JsonRecord = Record<string, unknown>;
type DownloadWebhookRequest = {
  downloadJobId: string;
  productName: string;
  SKU: string;
  productUrl: string;
  parentOutputDir: string;
};
export type ProductIdentityRecord = { sku: string; productName: string; variants: ProductVariant[] };
export type ColoredProductVariantInput = {
  name: string;
  wbColor: WbColorIdentity;
  ozonColor?: OzonColorIdentity;
  clearOzonColor?: boolean;
};

const PRODUCT_VARIANT_COLOR_COLUMNS = `id,name,normalized_name,sort_order,
  wb_color_key,wb_color_name_ru,wb_color_name_zh,
  ozon_color_item_key,ozon_color_dictionary_id,ozon_color_value_id,
  ozon_color_name_ru,ozon_color_name_zh,ozon_color_source`;

export class PurchaseRepository {
  private pool?: Pool;

  constructor(private readonly connectionString?: string) {}

  get configured(): boolean { return Boolean(this.pool); }

  async getProductIdentityBySku(sku: string): Promise<ProductIdentityRecord | undefined> {
    const normalizedSku = String(sku || '').trim();
    if (!/^\d{7}$/.test(normalizedSku)) return undefined;
    const result = await this.query<{ sku: string; product_name: string }>('SELECT sku, product_name FROM products WHERE sku = $1', [normalizedSku]);
    return result.rows[0] ? { sku: result.rows[0].sku, productName: result.rows[0].product_name, variants: await this.listProductVariants(normalizedSku) } : undefined;
  }

  async listProductVariants(sku: string): Promise<ProductVariant[]> {
    const result = await this.query<SqlRow>(`SELECT ${PRODUCT_VARIANT_COLOR_COLUMNS} FROM product_variants WHERE sku=$1 ORDER BY sort_order ASC,created_at ASC`, [String(sku || '').trim()]);
    return result.rows.map(toProductVariant);
  }

  async ensureProductVariants(sku: string, names: string[]): Promise<ProductVariant[]> {
    const normalizedSku = String(sku || '').trim();
    if (!/^\d{7}$/.test(normalizedSku)) throw new AppError('CONFIG_INVALID', 'SKU 必须是 7 位数字字符串', { sku });
    const validated = names.map(validateProductVariantName);
    const keys = validated.map(normalizeProductVariantKey);
    if (new Set(keys).size !== keys.length) throw new AppError('CONFIG_INVALID', '同一审核任务中的变体名不能重复');
    return this.transaction(async (client) => {
      const product = await client.query<{ sku: string }>('SELECT sku FROM products WHERE sku=$1 FOR UPDATE', [normalizedSku]);
      if (!product.rows[0]) throw new AppError('PRODUCT_NOT_FOUND', '采购产品不存在', { sku: normalizedSku }, 404);
      const current = await client.query<SqlRow>(`SELECT ${PRODUCT_VARIANT_COLOR_COLUMNS} FROM product_variants WHERE sku=$1 ORDER BY sort_order ASC,created_at ASC FOR UPDATE`, [normalizedSku]);
      const byKey = new Map(current.rows.map((row) => [row.normalized_name, row]));
      let nextOrder = current.rows.reduce((max, row) => Math.max(max, Number(row.sort_order)), -1) + 1;
      for (const [index, name] of validated.entries()) {
        const key = keys[index]!;
        if (byKey.has(key)) continue;
        const id = randomUUID();
        await client.query('INSERT INTO product_variants(id,sku,name,normalized_name,sort_order) VALUES($1,$2,$3,$4,$5)', [id, normalizedSku, name, key, nextOrder]);
        byKey.set(key, { id, name, normalized_name: key, sort_order: nextOrder, wb_color_key: null, wb_color_name_ru: null, wb_color_name_zh: null });
        nextOrder += 1;
      }
      return validated.map((_name, index) => {
        const row = byKey.get(keys[index]!)!;
        return toProductVariant(row);
      });
    });
  }

  async ensureColoredProductVariants(sku: string, inputs: ColoredProductVariantInput[]): Promise<ProductVariant[]> {
    const normalizedSku = String(sku || '').trim();
    if (!/^\d{7}$/.test(normalizedSku)) throw new AppError('CONFIG_INVALID', 'SKU 必须是 7 位数字字符串', { sku });
    if (!inputs.length) throw new AppError('CONFIG_INVALID', '至少需要一个带 WB 颜色的产品变体');
    const validated = inputs.map((input) => ({
      name: validateProductVariantName(input.name),
      wbColor: validateWbColorIdentity(input.wbColor),
      ...(input.ozonColor ? { ozonColor: validateOzonColorIdentity(input.ozonColor) } : {}),
      clearOzonColor: Boolean(input.clearOzonColor)
    }));
    const nameKeys = validated.map((input) => normalizeProductVariantKey(input.name));
    const colorKeys = validated.map((input) => input.wbColor.colorKey);
    if (new Set(nameKeys).size !== nameKeys.length) throw new AppError('CONFIG_INVALID', '同一审核任务中的变体名不能重复');
    if (new Set(colorKeys).size !== colorKeys.length) throw new AppError('CONFIG_INVALID', '同一审核任务中的 WB 颜色不能重复');
    return this.transaction(async (client) => {
      const product = await client.query<{ sku: string }>('SELECT sku FROM products WHERE sku=$1 FOR UPDATE', [normalizedSku]);
      if (!product.rows[0]) throw new AppError('PRODUCT_NOT_FOUND', '采购产品不存在', { sku: normalizedSku }, 404);
      const current = await client.query<SqlRow>(`SELECT ${PRODUCT_VARIANT_COLOR_COLUMNS} FROM product_variants WHERE sku=$1 ORDER BY sort_order ASC,created_at ASC FOR UPDATE`, [normalizedSku]);
      const byName = new Map(current.rows.map((row) => [String(row.normalized_name), row]));
      const byColor = new Map(current.rows.filter((row) => row.wb_color_key).map((row) => [String(row.wb_color_key), row]));
      let nextOrder = current.rows.reduce((max, row) => Math.max(max, Number(row.sort_order)), -1) + 1;
      const result: ProductVariant[] = [];
      for (const [index, input] of validated.entries()) {
        let row = byColor.get(input.wbColor.colorKey);
        if (!row) {
          const named = byName.get(nameKeys[index]!);
          if (named?.wb_color_key && named.wb_color_key !== input.wbColor.colorKey) {
            throw new AppError('CONFIG_INVALID', `产品变体名“${input.name}”已关联其他 WB 颜色`, { variantId: named.id });
          }
          if (named) {
            await client.query(`UPDATE product_variants SET wb_color_key=$2,wb_color_name_ru=$3,wb_color_name_zh=$4,updated_at=NOW() WHERE id=$1`, [
              named.id, input.wbColor.colorKey, input.wbColor.nameRu, input.wbColor.nameZh
            ]);
            row = { ...named, wb_color_key: input.wbColor.colorKey, wb_color_name_ru: input.wbColor.nameRu, wb_color_name_zh: input.wbColor.nameZh };
          } else {
            const id = randomUUID();
            await client.query(`INSERT INTO product_variants(id,sku,name,normalized_name,sort_order,wb_color_key,wb_color_name_ru,wb_color_name_zh)
              VALUES($1,$2,$3,$4,$5,$6,$7,$8)`, [id, normalizedSku, input.name, nameKeys[index], nextOrder, input.wbColor.colorKey, input.wbColor.nameRu, input.wbColor.nameZh]);
            row = { id, name: input.name, normalized_name: nameKeys[index], sort_order: nextOrder, wb_color_key: input.wbColor.colorKey, wb_color_name_ru: input.wbColor.nameRu, wb_color_name_zh: input.wbColor.nameZh };
            byName.set(nameKeys[index]!, row);
            nextOrder += 1;
          }
          byColor.set(input.wbColor.colorKey, row);
        } else if (row.wb_color_name_ru !== input.wbColor.nameRu || row.wb_color_name_zh !== input.wbColor.nameZh) {
          await client.query('UPDATE product_variants SET wb_color_name_ru=$2,wb_color_name_zh=$3,updated_at=NOW() WHERE id=$1', [row.id, input.wbColor.nameRu, input.wbColor.nameZh]);
          row = { ...row, wb_color_name_ru: input.wbColor.nameRu, wb_color_name_zh: input.wbColor.nameZh };
          byColor.set(input.wbColor.colorKey, row);
        }
        if (input.ozonColor) {
          await client.query(`UPDATE product_variants SET
            ozon_color_item_key=$2,ozon_color_dictionary_id=$3,ozon_color_value_id=$4,
            ozon_color_name_ru=$5,ozon_color_name_zh=$6,ozon_color_source=$7,updated_at=NOW()
            WHERE id=$1`, [
            row.id, input.ozonColor.itemKey, input.ozonColor.dictionaryId, input.ozonColor.valueId,
            input.ozonColor.nameRu, input.ozonColor.nameZh, input.ozonColor.source
          ]);
          row = {
            ...row,
            ozon_color_item_key: input.ozonColor.itemKey,
            ozon_color_dictionary_id: input.ozonColor.dictionaryId,
            ozon_color_value_id: input.ozonColor.valueId,
            ozon_color_name_ru: input.ozonColor.nameRu,
            ozon_color_name_zh: input.ozonColor.nameZh,
            ozon_color_source: input.ozonColor.source
          };
        } else if (input.clearOzonColor) {
          await client.query(`UPDATE product_variants SET
            ozon_color_item_key=NULL,ozon_color_dictionary_id=NULL,ozon_color_value_id=NULL,
            ozon_color_name_ru=NULL,ozon_color_name_zh=NULL,ozon_color_source=NULL,updated_at=NOW()
            WHERE id=$1`, [row.id]);
          row = {
            ...row,
            ozon_color_item_key: null,
            ozon_color_dictionary_id: null,
            ozon_color_value_id: null,
            ozon_color_name_ru: null,
            ozon_color_name_zh: null,
            ozon_color_source: null
          };
        }
        result.push(toProductVariant(row));
      }
      return result;
    });
  }

  async backfillProductVariantColors(colors: WbColorIdentity[]): Promise<number> {
    if (!this.configured || !colors.length) return 0;
    const matches = exactColorNameIndex(colors);
    return this.transaction(async (client) => {
      const rows = await client.query<SqlRow>('SELECT id,sku,name FROM product_variants WHERE wb_color_key IS NULL ORDER BY created_at ASC FOR UPDATE');
      let updated = 0;
      for (const row of rows.rows) {
        const color = matches.get(normalizeColorName(String(row.name)));
        if (!color) continue;
        const result = await client.query(`UPDATE product_variants v SET wb_color_key=$2,wb_color_name_ru=$3,wb_color_name_zh=$4,updated_at=NOW()
          WHERE v.id=$1 AND v.wb_color_key IS NULL AND NOT EXISTS(
            SELECT 1 FROM product_variants other WHERE other.sku=v.sku AND other.wb_color_key=$2 AND other.id<>v.id
          )`, [row.id, color.colorKey, color.nameRu, color.nameZh]);
        updated += result.rowCount || 0;
      }
      return updated;
    });
  }

  async findProductIdentityByDownloadOutputDir(outputDir: string): Promise<ProductIdentityRecord | undefined> {
    const normalized = normalizeProductDirectory(outputDir);
    if (!normalized) return undefined;
    const result = await this.query<{ sku: string; product_name: string }>(`
      SELECT p.sku, p.product_name
      FROM download_jobs j
      JOIN products p ON p.sku = j.sku
      WHERE j.status = 'SUCCEEDED'
        AND LOWER(RTRIM(REPLACE(j.output_dir, CHR(92), '/'), '/')) = LOWER($1)
      ORDER BY j.finished_at DESC NULLS LAST, j.created_at DESC
      LIMIT 1`, [normalized]);
    return result.rows[0] ? { sku: result.rows[0].sku, productName: result.rows[0].product_name, variants: await this.listProductVariants(result.rows[0].sku) } : undefined;
  }

  async findProductIdentitiesByFolderName(folderName: string): Promise<ProductIdentityRecord[]> {
    const normalized = String(folderName || '').trim();
    if (!normalized) return [];
    const result = await this.query<{ sku: string; product_name: string; name_length: number }>(`
      SELECT sku, product_name, CHAR_LENGTH(product_name) AS name_length
      FROM products
      WHERE LOWER($1) LIKE LOWER(product_name) || '%'
      ORDER BY name_length DESC, sku ASC`, [normalized]);
    const longest = Number(result.rows[0]?.name_length || 0);
    const matches = result.rows.filter((row) => Number(row.name_length) === longest);
    return Promise.all(matches.map(async (row) => ({ sku: row.sku, productName: row.product_name, variants: await this.listProductVariants(row.sku) })));
  }

  async initialize(defaultWorkflow?: WorkflowInput): Promise<void> {
    if (!this.connectionString) return;
    this.pool = new Pool({ connectionString: this.connectionString, max: 6, idleTimeoutMillis: 30_000 });
    try {
      await this.pool.query('SELECT 1');
      await this.migrate();
      if (defaultWorkflow) await this.seedDefaultWorkflow(defaultWorkflow);
    } catch (error) {
      await this.pool.end().catch(() => undefined);
      this.pool = undefined;
      throw error;
    }
  }

  async initializeExistingSchema(): Promise<void> {
    if (!this.connectionString || this.pool) return;
    this.pool = new Pool({ connectionString: this.connectionString, max: 2, idleTimeoutMillis: 30_000 });
    try {
      await this.pool.query('SELECT 1 FROM products LIMIT 1');
      await this.pool.query('SELECT 1 FROM product_variants LIMIT 1');
    } catch (error) {
      await this.pool.end().catch(() => undefined);
      this.pool = undefined;
      throw error;
    }
  }

  async close(): Promise<void> { await this.pool?.end(); }

  async listPurchases(input: PurchaseListQuery) {
    const page = Math.max(1, input.page || 1);
    const pageSize = Math.min(100, Math.max(10, input.pageSize || 50));
    const values: unknown[] = [];
    const where: string[] = [];
    if (input.source && input.source !== 'URL_DOWNLOAD') throw new AppError('CONFIG_INVALID', '采购来源筛选无效');
    if (input.source === 'URL_DOWNLOAD') where.push('NOT EXISTS (SELECT 1 FROM local_imports li WHERE li.sku = p.sku)');
    const entryMethodKey = String(input.entryMethodKey || '').trim();
    if (entryMethodKey.length > 200) throw new AppError('CONFIG_INVALID', '录入方式筛选值过长');
    if (entryMethodKey) {
      values.push(entryMethodKey);
      where.push(`COALESCE(origin.method_key,'OTHER:UNREGISTERED') = $${values.length}`);
    }
    if (input.sort && input.sort !== 'RECORDED_DESC') throw new AppError('CONFIG_INVALID', '采购商品排序方式无效');
    if (input.query?.trim()) {
      values.push(`%${input.query.trim()}%`);
      where.push(`(p.sku ILIKE $${values.length} OR p.product_name ILIKE $${values.length})`);
    }
    if (input.status) { values.push(input.status); where.push(`latest_job.status = $${values.length}`); }
    if (input.workflowCode) { values.push(input.workflowCode); where.push(`latest_job.workflow_code = $${values.length}`); }
    const createdFrom = input.createdFrom ? normalizePurchaseDate(input.createdFrom, '新建日期起始时间') : undefined;
    const createdTo = input.createdTo ? normalizePurchaseDate(input.createdTo, '新建日期结束时间') : undefined;
    if (createdFrom && createdTo && createdFrom >= createdTo) throw new AppError('CONFIG_INVALID', '新建日期结束时间必须晚于起始时间');
    if (createdFrom) { values.push(createdFrom); where.push(`p.created_at >= $${values.length}`); }
    if (createdTo) { values.push(createdTo); where.push(`p.created_at < $${values.length}`); }
    const filter = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const count = await this.query<{ total: string }>(`
      SELECT COUNT(*)::text AS total
      FROM products p
      LEFT JOIN product_entry_origins origin ON origin.sku = p.sku
      LEFT JOIN LATERAL (
        SELECT status, workflow_code FROM download_jobs WHERE sku = p.sku ORDER BY created_at DESC LIMIT 1
      ) latest_job ON true
      ${filter}`, values);
    values.push(pageSize, (page - 1) * pageSize);
    const rows = await this.query<SqlRow>(`
      SELECT p.sku, p.product_name, p.created_at, p.updated_at,
        COALESCE((SELECT jsonb_agg(v.name ORDER BY v.sort_order ASC, v.created_at ASC) FROM product_variants v WHERE v.sku=p.sku),'[]'::jsonb) AS variants,
        COALESCE(origin.method_key,'OTHER:UNREGISTERED') AS entry_method_key,
        COALESCE(origin.method_label,'其它方式') AS entry_method_label,
        origin.platform AS entry_platform,origin.workflow_code AS entry_workflow_code,
        COALESCE(origin.source_type,'OTHER') AS entry_source_type,origin.source_id AS entry_source_id,
        p.created_at AS entry_recorded_at,
        pv.id AS procurement_version_id, pv.download_workflow_code, pv.purchase_price, pv.retail_price, pv.courier_fee, pv.currency,
        pv.gross_weight_g, pv.length_cm, pv.width_cm, pv.height_cm,
        pv.net_weight_g, pv.product_height_cm, pv.product_depth_cm, pv.product_width_cm,
        pv.transport_mode, pv.provider_url,
        latest_job.id AS job_id, latest_job.status AS job_status, latest_job.workflow_code AS job_workflow_code,
        latest_job.output_dir AS job_output_dir, latest_job.created_at AS job_created_at, latest_job.finished_at AS job_finished_at,
        latest_job.error_message AS job_error_message, latest_job.next_attempt_at AS job_next_attempt_at,
        latest_job.retry_reason AS job_retry_reason, latest_job.resource_retry_count AS job_resource_retry_count,
        CASE
          WHEN origin.source_type='LOCAL_IMPORT' THEN local_import.target_folder
          WHEN origin.source_type='URL_DOWNLOAD' THEN latest_success.output_dir
          ELSE latest_success.output_dir
        END AS local_media_folder
      FROM products p
      LEFT JOIN product_entry_origins origin ON origin.sku = p.sku
      JOIN LATERAL (
        SELECT * FROM procurement_versions WHERE sku = p.sku ORDER BY version_no DESC LIMIT 1
      ) pv ON true
      LEFT JOIN local_imports local_import ON origin.source_type='LOCAL_IMPORT' AND local_import.id::text=origin.source_id
      LEFT JOIN LATERAL (
        SELECT * FROM download_jobs WHERE sku = p.sku ORDER BY created_at DESC LIMIT 1
      ) latest_job ON true
      LEFT JOIN LATERAL (
        SELECT output_dir FROM download_jobs
        WHERE sku=p.sku AND status='SUCCEEDED' AND output_dir IS NOT NULL AND BTRIM(output_dir)<>''
        ORDER BY finished_at DESC NULLS LAST,created_at DESC LIMIT 1
      ) latest_success ON true
      ${filter}
      ORDER BY ${input.sort === 'RECORDED_DESC' ? 'p.created_at' : 'p.updated_at'} DESC, p.sku DESC
      LIMIT $${values.length - 1} OFFSET $${values.length}`, values);
    const facets = await this.query<SqlRow>(`
      SELECT COALESCE(origin.method_key,'OTHER:UNREGISTERED') value,
        COALESCE(origin.method_label,'其它方式') label,origin.platform,origin.workflow_code,
        COALESCE(origin.source_type,'OTHER') source_type,COUNT(*)::int count
      FROM products p
      LEFT JOIN product_entry_origins origin ON origin.sku=p.sku
      WHERE EXISTS(SELECT 1 FROM procurement_versions pv WHERE pv.sku=p.sku)
      GROUP BY 1,2,3,4,5
      ORDER BY LOWER(COALESCE(origin.method_label,'其它方式')),COALESCE(origin.method_key,'OTHER:UNREGISTERED')`);
    return {
      items: rows.rows.map(toPurchaseSummary), total: Number(count.rows[0]?.total || 0), page, pageSize,
      facets: { entryMethods: facets.rows.map(toPurchaseEntryMethodFacet) }
    };
  }

  async findPricingProducts(lookup: PricingProductQueryInput['lookup']): Promise<PricingProductSnapshot[]> {
    const value = lookup.kind === 'SKU' ? lookup.sku : escapeLikePattern(lookup.productName.trim());
    const condition = lookup.kind === 'SKU' ? 'p.sku = $1' : `LOWER(p.product_name) LIKE '%' || LOWER($1) || '%' ESCAPE '\\'`;
    const rows = await this.query<SqlRow>(`
      SELECT p.sku, p.product_name, p.updated_at,
        pv.id AS procurement_version_id, pv.version_no, pv.purchase_price, pv.courier_fee, pv.currency,
        pv.gross_weight_g, pv.length_cm, pv.width_cm, pv.height_cm,
        pv.net_weight_g, pv.product_height_cm, pv.product_depth_cm, pv.product_width_cm,
        pv.created_at AS procurement_created_at
      FROM products p
      JOIN LATERAL (
        SELECT * FROM procurement_versions WHERE sku = p.sku ORDER BY version_no DESC LIMIT 1
      ) pv ON true
      WHERE ${condition}
      ORDER BY p.updated_at DESC, p.sku ASC
      LIMIT 501`, [value]);
    if (rows.rows.length > 500) throw new AppError('TOO_MANY_MATCHES', '匹配产品超过 500 个，请缩小关键词范围或改用 SKU', { matchedAtLeast: rows.rows.length }, 409);
    return rows.rows.map(toPricingProductSnapshot);
  }

  async getPurchase(sku: string) {
    const product = await this.query<SqlRow>('SELECT sku, product_name, created_at, updated_at FROM products WHERE sku = $1', [sku]);
    if (!product.rows[0]) throw new AppError('NOT_FOUND', '采购产品不存在', { sku }, 404);
    const versions = await this.query<SqlRow>(`
      SELECT id, version_no, download_workflow_code, purchase_price, retail_price, courier_fee, currency,
        gross_weight_g, length_cm, width_cm, height_cm,
        net_weight_g, product_height_cm, product_depth_cm, product_width_cm,
        transport_mode, provider_url, created_at
      FROM procurement_versions WHERE sku = $1 ORDER BY version_no DESC`, [sku]);
    const jobs = await this.query<SqlRow>(`
      SELECT id, sku, workflow_code, workflow_snapshot, request_body, status, attempt, result_json, error_message, output_dir,
        batch_id, batch_position, queue_sequence, notification_thread_id, next_attempt_at, retry_reason,
        resource_retry_count, resource_wait_started_at, created_at, started_at, finished_at
      FROM download_jobs WHERE sku = $1 ORDER BY created_at DESC`, [sku]);
    return { ...toProduct(product.rows[0]), variants: (await this.listProductVariants(sku)).map((item) => item.name), procurementVersions: versions.rows.map(toProcurementVersion), downloadJobs: jobs.rows.map(toJob) };
  }

  async createPurchase(input: PurchaseInput) {
    validatePurchase(input);
    return this.transaction(async (client) => {
      await lockPurchaseUrlRegistry(client);
      const downloadWorkflowCode = await resolveActivePurchaseWorkflow(client, input.downloadWorkflowCode);
      await client.query('INSERT INTO purchase_sku_counter (singleton, last_value) VALUES (true, 0) ON CONFLICT (singleton) DO NOTHING');
      const counter = await client.query<{ last_value: number }>('SELECT last_value FROM purchase_sku_counter WHERE singleton = true FOR UPDATE');
      await assertPurchaseUrlAvailable(client, input.providerUrl);
      const next = Number(counter.rows[0]?.last_value || 0) + 1;
      if (next > 9_999_999) throw new AppError('SKU_EXHAUSTED', 'SKU 已达到 7 位编号上限', undefined, 409);
      const sku = String(next).padStart(7, '0');
      await client.query('UPDATE purchase_sku_counter SET last_value = $1 WHERE singleton = true', [next]);
      await client.query('INSERT INTO products (sku, product_name) VALUES ($1, $2)', [sku, input.productName.trim()]);
      await registerPurchaseUrl(client, input.providerUrl, sku);
      await client.query('INSERT INTO product_variants(id,sku,name,normalized_name,sort_order) VALUES($1,$2,$3,$4,0)', [randomUUID(), sku, '默认变体', normalizeProductVariantKey('默认变体')]);
      const procurementVersionId = await insertProcurementVersion(client, sku, input, 1, downloadWorkflowCode);
      await insertUrlDownloadEntryOrigin(client, sku, downloadWorkflowCode, procurementVersionId);
      return this.getPurchaseWithClient(client, sku);
    });
  }

  async reserveLocalImport(input: ReserveLocalImportInput): Promise<{ import: LocalImportRecord; created: boolean }> {
    const purchase = { ...input.purchase, currency: 'CNY' };
    validatePurchase(purchase);
    const idempotencyKey = String(input.idempotencyKey || '').trim();
    if (!idempotencyKey || idempotencyKey.length > 200) throw new AppError('CONFIG_INVALID', '幂等键长度必须在 1 到 200 个字符之间');
    if (!/^[a-f0-9]{64}$/i.test(input.previewHash)) throw new AppError('CONFIG_INVALID', '预览哈希无效');
    if (!input.sources.length) throw new AppError('CONFIG_INVALID', '至少需要一个媒体来源目录');
    const sourcePlatforms = [...new Set(input.sources.map((source) => String(source.platform || '').trim()).filter(Boolean))];
    const normalizedPlatforms = new Set(sourcePlatforms.map((platform) => platform.toLocaleLowerCase('en-US')));
    if (sourcePlatforms.length === 0 || normalizedPlatforms.size !== 1) throw new AppError('LOCAL_IMPORT_CROSS_PLATFORM', '一次导入只能登记同一个来源平台', undefined, 409);
    const sourcePlatform = sourcePlatforms[0]!;
    if (sourcePlatform.length > 100) throw new AppError('CONFIG_INVALID', '来源平台名称不能超过 100 个字符');
    const importWorkflowLabel = `本地导入-${sourcePlatform}`;
    const providerUrls = [...new Set(input.providerUrls.map(normalizeProviderUrlKey).filter(Boolean))];
    if (!providerUrls.length || !providerUrls.includes(normalizeProviderUrlKey(purchase.providerUrl))) {
      throw new AppError('CONFIG_INVALID', '主目录商品 URL 必须包含在本次来源 URL 中');
    }
    return this.transaction(async (client) => {
      await client.query(`SELECT pg_advisory_xact_lock(hashtext('merchroute_local_import:' || $1))`, [idempotencyKey]);
      const existing = await client.query<{ id: string }>('SELECT id FROM local_imports WHERE idempotency_key=$1 FOR UPDATE', [idempotencyKey]);
      if (existing.rows[0]) return { import: await getLocalImportWithClient(client, existing.rows[0].id), created: false };
      await lockPurchaseUrlRegistry(client);
      const conflicts = await client.query<{ sku: string; provider_url_key: string }>(
        'SELECT sku,provider_url_key FROM purchase_provider_urls WHERE provider_url_key=ANY($1::text[]) ORDER BY sku,provider_url_key FOR UPDATE',
        [providerUrls]
      );
      if (conflicts.rows[0]) {
        const owners = [...new Set(conflicts.rows.map((row) => row.sku))];
        const id = randomUUID();
        await client.query(`INSERT INTO local_imports(
          id,idempotency_key,duplicate_sku,status,source_platform,import_workflow_label,
          source_config_snapshot,target_config_snapshot,preview_hash,completed_at
        ) VALUES($1,$2,$3,'SKIPPED_DUPLICATE',$4,$5,$6::jsonb,$7::jsonb,$8,NOW())`, [
          id, idempotencyKey, owners[0], sourcePlatform, importWorkflowLabel,
          JSON.stringify(input.sourceConfigSnapshot), JSON.stringify(input.targetConfigSnapshot), input.previewHash.toLowerCase()
        ]);
        return { import: await getLocalImportWithClient(client, id), created: true };
      }
      await client.query('INSERT INTO purchase_sku_counter (singleton,last_value) VALUES(true,0) ON CONFLICT(singleton) DO NOTHING');
      const counter = await client.query<{ last_value: number }>('SELECT last_value FROM purchase_sku_counter WHERE singleton=true FOR UPDATE');
      const next = Number(counter.rows[0]?.last_value || 0) + 1;
      if (next > 9_999_999) throw new AppError('SKU_EXHAUSTED', 'SKU 已达到 7 位编号上限', undefined, 409);
      const sku = String(next).padStart(7, '0');
      const id = randomUUID();
      await client.query('UPDATE purchase_sku_counter SET last_value=$1 WHERE singleton=true', [next]);
      await client.query('INSERT INTO products(sku,product_name) VALUES($1,$2)', [sku, purchase.productName.trim()]);
      await client.query('INSERT INTO product_variants(id,sku,name,normalized_name,sort_order) VALUES($1,$2,$3,$4,0)', [randomUUID(), sku, '默认变体', normalizeProductVariantKey('默认变体')]);
      for (const url of providerUrls) await registerPurchaseUrl(client, url, sku);
      await insertProcurementVersion(client, sku, purchase, 1, null);
      await client.query(`INSERT INTO local_imports(
        id,idempotency_key,sku,status,source_platform,import_workflow_label,
        source_config_snapshot,target_config_snapshot,preview_hash
      ) VALUES($1,$2,$3,'COPYING',$4,$5,$6::jsonb,$7::jsonb,$8)`, [
        id, idempotencyKey, sku, sourcePlatform, importWorkflowLabel,
        JSON.stringify(input.sourceConfigSnapshot), JSON.stringify(input.targetConfigSnapshot), input.previewHash.toLowerCase()
      ]);
      await insertLocalImportEntryOrigin(client, sku, sourcePlatform, id);
      for (const source of input.sources) {
        await client.query(`INSERT INTO product_media_sources(
          id,local_import_id,sku,platform,relative_path,normalized_path_key,is_primary,external_sku,
          information_file_relative_path,information_file_sha256,provider_url,target_subdirectory,copy_manifest
        ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb)`, [
          randomUUID(), id, sku, source.platform, source.relativePath, source.normalizedPathKey, source.isPrimary,
          source.externalSku || null, source.informationFileRelativePath || null, source.informationFileSha256 || null,
          source.providerUrl || null, source.targetSubdirectory, JSON.stringify(source.copyManifest)
        ]);
      }
      return { import: await getLocalImportWithClient(client, id), created: true };
    });
  }

  async getLocalImport(id: string): Promise<LocalImportRecord> {
    return getLocalImportWithClient(this.requirePool(), id);
  }

  async listLocalImports(input: LocalImportQuery) {
    const page = Math.max(1, input.page || 1);
    const pageSize = Math.min(100, Math.max(1, input.pageSize || 50));
    const values: unknown[] = [];
    const where: string[] = [];
    const query = String(input.query || '').trim();
    if (query) {
      values.push(`%${query}%`);
      where.push(`(COALESCE(li.sku,li.duplicate_sku)::text ILIKE $${values.length} OR p.product_name ILIKE $${values.length})`);
    }
    const platform = String(input.platform || '').trim();
    if (platform) {
      values.push(platform);
      where.push(`LOWER(COALESCE(li.source_platform,''))=LOWER($${values.length})`);
    }
    const status = String(input.status || '').trim().toUpperCase();
    if (status) {
      if (!new Set<LocalImportStatus>(['COPYING', 'IMPORTED', 'SKIPPED_DUPLICATE', 'COPY_FAILED_RETRYABLE']).has(status as LocalImportStatus)) {
        throw new AppError('CONFIG_INVALID', '本地导入状态筛选无效');
      }
      values.push(status);
      where.push(`li.status=$${values.length}`);
    }
    const createdFrom = input.createdFrom ? normalizePurchaseDate(input.createdFrom, '导入日期起始时间') : undefined;
    const createdTo = input.createdTo ? normalizePurchaseDate(input.createdTo, '导入日期结束时间') : undefined;
    if (createdFrom && createdTo && createdFrom >= createdTo) throw new AppError('CONFIG_INVALID', '导入日期结束时间必须晚于起始时间');
    if (createdFrom) { values.push(createdFrom); where.push(`li.created_at >= $${values.length}`); }
    if (createdTo) { values.push(createdTo); where.push(`li.created_at < $${values.length}`); }
    const filter = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const count = await this.query<{ total: string }>(`
      SELECT COUNT(*)::text total FROM local_imports li
      LEFT JOIN products p ON p.sku=COALESCE(li.sku,li.duplicate_sku)
      ${filter}`, values);
    const listValues = [...values, pageSize, (page - 1) * pageSize];
    const rows = await this.query<SqlRow>(`
      SELECT li.id,li.idempotency_key,li.sku,li.duplicate_sku,li.status,li.source_platform,li.import_workflow_label,
        li.source_config_snapshot,li.target_config_snapshot,li.preview_hash,li.retry_count,li.error_code,li.error_message,
        li.target_folder,li.created_at AS import_created_at,li.updated_at AS import_updated_at,li.completed_at,
        (SELECT COUNT(*)::int FROM product_media_sources pms WHERE pms.local_import_id=li.id) AS source_directory_count,
        p.sku AS product_sku,p.product_name,p.created_at AS product_created_at,p.updated_at AS product_updated_at,
        COALESCE((SELECT jsonb_agg(v.name ORDER BY v.sort_order,v.created_at) FROM product_variants v WHERE v.sku=p.sku),'[]'::jsonb) AS variants,
        pv.id AS procurement_version_id,pv.version_no,pv.download_workflow_code,pv.purchase_price,pv.retail_price,pv.courier_fee,pv.currency,
        pv.gross_weight_g,pv.length_cm,pv.width_cm,pv.height_cm,pv.net_weight_g,pv.product_height_cm,pv.product_depth_cm,
        pv.product_width_cm,pv.transport_mode,pv.provider_url,pv.created_at AS procurement_created_at
      FROM local_imports li
      LEFT JOIN products p ON p.sku=COALESCE(li.sku,li.duplicate_sku)
      LEFT JOIN LATERAL (SELECT * FROM procurement_versions WHERE sku=p.sku ORDER BY version_no DESC LIMIT 1) pv ON true
      ${filter}
      ORDER BY li.created_at DESC,li.id DESC
      LIMIT $${listValues.length - 1} OFFSET $${listValues.length}`, listValues);
    const facets = await this.query<{ platform: string; total: string }>(`
      SELECT source_platform platform,COUNT(*)::text total FROM local_imports
      WHERE source_platform IS NOT NULL AND BTRIM(source_platform)<>''
      GROUP BY source_platform ORDER BY LOWER(source_platform),source_platform`);
    return {
      items: rows.rows.map(toLocalImportListItem), total: Number(count.rows[0]?.total || 0), page, pageSize,
      facets: { platforms: facets.rows.map((row) => ({ value: row.platform, count: Number(row.total) })) }
    };
  }

  async updateLocalImportPurchase(id: string, input: Omit<PurchaseInput, 'downloadWorkflowCode'>): Promise<LocalImportRecord> {
    const purchaseInput: PurchaseInput = { ...input, downloadWorkflowCode: undefined, currency: 'CNY' };
    validatePurchase(purchaseInput);
    return this.transaction(async (client) => {
      await lockPurchaseUrlRegistry(client);
      const record = await client.query<{ sku: string | null }>('SELECT sku FROM local_imports WHERE id=$1 FOR UPDATE', [id]);
      if (!record.rows[0]) throw new AppError('NOT_FOUND', '本地导入记录不存在', { id }, 404);
      const sku = record.rows[0].sku;
      if (!sku) throw new AppError('LOCAL_IMPORT_NOT_EDITABLE', 'URL 重复跳过记录没有新建内部 SKU，不能编辑采购信息', { id }, 409);
      const current = await client.query<{ version_no: number; download_workflow_code: string | null }>(
        'SELECT version_no,download_workflow_code FROM procurement_versions WHERE sku=$1 ORDER BY version_no DESC LIMIT 1 FOR UPDATE', [sku]
      );
      if (!current.rows[0]) throw new AppError('NOT_FOUND', '采购产品不存在', { sku }, 404);
      await assertPurchaseUrlAvailable(client, purchaseInput.providerUrl, sku);
      await client.query('UPDATE products SET product_name=$2,updated_at=NOW() WHERE sku=$1', [sku, purchaseInput.productName.trim()]);
      await registerPurchaseUrl(client, purchaseInput.providerUrl, sku);
      await insertProcurementVersion(client, sku, purchaseInput, Number(current.rows[0].version_no) + 1, current.rows[0].download_workflow_code);
      return getLocalImportWithClient(client, id);
    });
  }

  async completeLocalImport(id: string, targetFolder: string): Promise<LocalImportRecord> {
    await this.query(`UPDATE local_imports SET status='IMPORTED',target_folder=$2,error_code=NULL,error_message=NULL,
      completed_at=NOW(),updated_at=NOW() WHERE id=$1`, [id, targetFolder]);
    return this.getLocalImport(id);
  }

  async failLocalImport(id: string, errorCode: string, errorMessage: string): Promise<LocalImportRecord> {
    await this.query(`UPDATE local_imports SET status='COPY_FAILED_RETRYABLE',retry_count=retry_count+1,
      error_code=$2,error_message=$3,updated_at=NOW() WHERE id=$1`, [id, errorCode, errorMessage.slice(0, 4000)]);
    return this.getLocalImport(id);
  }

  async markLocalImportCopying(id: string): Promise<LocalImportRecord> {
    await this.query(`UPDATE local_imports SET status='COPYING',error_code=NULL,error_message=NULL,updated_at=NOW()
      WHERE id=$1 AND status='COPY_FAILED_RETRYABLE'`, [id]);
    return this.getLocalImport(id);
  }

  async updatePurchase(sku: string, input: PurchaseInput) {
    validatePurchase(input);
    return this.transaction(async (client) => {
      await lockPurchaseUrlRegistry(client);
      const downloadWorkflowCode = await resolveActivePurchaseWorkflow(client, input.downloadWorkflowCode);
      const current = await client.query<{ version_no: number }>('SELECT version_no FROM procurement_versions WHERE sku = $1 ORDER BY version_no DESC LIMIT 1 FOR UPDATE', [sku]);
      if (!current.rows[0]) throw new AppError('NOT_FOUND', '采购产品不存在', { sku }, 404);
      await assertPurchaseUrlAvailable(client, input.providerUrl, sku);
      await client.query('UPDATE products SET product_name = $2, updated_at = NOW() WHERE sku = $1', [sku, input.productName.trim()]);
      await registerPurchaseUrl(client, input.providerUrl, sku);
      await insertProcurementVersion(client, sku, input, Number(current.rows[0].version_no) + 1, downloadWorkflowCode);
      return this.getPurchaseWithClient(client, sku);
    });
  }

  async listWorkflows(includeDisabled = true) {
    const rows = await this.query<SqlRow>(`SELECT code, display_name, webhook_url, parent_output_dir, timeout_ms, enabled, is_default, recovery_mode, created_at, updated_at
      FROM download_workflows ${includeDisabled ? '' : 'WHERE enabled = true'} ORDER BY is_default DESC, code ASC`);
    return rows.rows.map(toWorkflow);
  }

  async saveWorkflow(input: WorkflowInput) {
    validateWorkflow(input);
    await assertSafeDownloadRoot(input.parentOutputDir);
    return this.transaction(async (client) => {
      await lockDownloadProjection(client);
      if (input.isDefault) await client.query('UPDATE download_workflows SET is_default = false, updated_at = NOW() WHERE code <> $1', [input.code]);
      await client.query(`INSERT INTO download_workflows (code, display_name, webhook_url, parent_output_dir, timeout_ms, enabled, is_default, recovery_mode)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
        ON CONFLICT (code) DO UPDATE SET display_name = EXCLUDED.display_name, webhook_url = EXCLUDED.webhook_url,
          parent_output_dir = EXCLUDED.parent_output_dir, timeout_ms = EXCLUDED.timeout_ms, enabled = EXCLUDED.enabled,
          is_default = EXCLUDED.is_default, recovery_mode = EXCLUDED.recovery_mode, updated_at = NOW()`, [
        input.code.trim().toUpperCase(), input.displayName.trim(), input.webhookUrl.trim(), input.parentOutputDir.trim(),
        input.timeoutMs || 900_000, input.enabled ?? true, input.isDefault ?? false, input.recoveryMode || 'MANUAL'
      ]);
      const defaults = await client.query<{ count: string }>('SELECT COUNT(*)::text AS count FROM download_workflows WHERE enabled = true AND is_default = true');
      if (Number(defaults.rows[0]?.count || 0) !== 1) throw new AppError('CONFIG_INVALID', '必须保留一个已启用的默认下载工作流', undefined, 409);
      const saved = await client.query<SqlRow>('SELECT code, display_name, webhook_url, parent_output_dir, timeout_ms, enabled, is_default, recovery_mode, created_at, updated_at FROM download_workflows WHERE code = $1', [input.code.trim().toUpperCase()]);
      return toWorkflow(saved.rows[0]!);
    });
  }

  async syncWorkflows(inputs: WorkflowInput[]): Promise<void> {
    validateWorkflowSet(inputs);
    await assertSafeWorkflowSet(inputs);
    await this.transaction(async (client) => {
      await lockDownloadProjection(client);
      await writeWorkflowProjection(client, inputs);
      await assertWorkflowProjection(client, inputs);
      await backfillMissingPurchaseWorkflowsWithClient(client);
    });
  }

  async countWorkflowJobs(code: string): Promise<number> {
    const result = await this.query<{ count: string }>('SELECT COUNT(*)::text AS count FROM download_jobs WHERE workflow_code = $1', [code]);
    return Number(result.rows[0]?.count || 0);
  }

  async enqueueDownload(sku: string, requestedWorkflowCode?: string, expectedWorkflows?: WorkflowInput[]) {
    if (expectedWorkflows) {
      validateWorkflowSet(expectedWorkflows);
      await assertSafeWorkflowSet(expectedWorkflows);
    }
    return this.transaction(async (client) => {
      if (expectedWorkflows) await prepareWorkflowProjection(client, expectedWorkflows);
      else await lockDownloadEnqueue(client);
      const jobId = await insertDownloadJob(client, sku, requestedWorkflowCode, { strict: true }, expectedWorkflows);
      return this.getJobWithClient(client, jobId);
    });
  }

  async enqueueDownloadBatch(items: DownloadBatchItemInput[], expectedWorkflows?: WorkflowInput[]) {
    validateBatchItems(items);
    if (expectedWorkflows) {
      validateWorkflowSet(expectedWorkflows);
      await assertSafeWorkflowSet(expectedWorkflows);
    }
    return this.transaction(async (client) => {
      if (expectedWorkflows) await prepareWorkflowProjection(client, expectedWorkflows);
      else await lockDownloadEnqueue(client);
      const batchId = randomUUID();
      const queuedIds: string[] = [];
      const skipped: Array<{ sku: string; workflowCode: string; reason: string; message: string }> = [];
      await client.query(`INSERT INTO download_batches (id, total_requested, queued_count, skipped_count, skipped_items)
        VALUES ($1,$2,0,0,'[]'::jsonb)`, [batchId, items.length]);
      for (const [position, item] of items.entries()) {
        try {
          const jobId = await insertDownloadJob(client, item.sku, item.workflowCode, { strict: false, batchId, batchPosition: position + 1 }, expectedWorkflows);
          queuedIds.push(jobId);
        } catch (error) {
          if (!(error instanceof AppError) || !['DOWNLOAD_ALREADY_QUEUED', 'DOWNLOAD_WORKFLOW_UNAVAILABLE'].includes(error.code)) throw error;
          skipped.push({ sku: item.sku, workflowCode: item.workflowCode, reason: error.code, message: error.message });
        }
      }
      await client.query(`UPDATE download_batches SET queued_count = $2, skipped_count = $3, skipped_items = $4::jsonb WHERE id = $1`, [
        batchId, queuedIds.length, skipped.length, JSON.stringify(skipped)
      ]);
      if (queuedIds.length === 0) await finalizeBatchIfComplete(client, batchId);
      const queued = [];
      for (const id of queuedIds) queued.push(await this.getJobWithClient(client, id));
      return { batchId, queued, skipped };
    });
  }

  async getJob(id: string) { return this.getJobWithClient(undefined, id); }

  async getDownloadBatch(id: string) {
    const batch = await this.query<SqlRow>('SELECT * FROM download_batches WHERE id = $1', [id]);
    if (!batch.rows[0]) throw new AppError('NOT_FOUND', '下载批次不存在', { id }, 404);
    const jobs = await this.query<SqlRow>(`SELECT id, sku, workflow_code, workflow_snapshot, request_body, status, attempt, result_json,
      error_message, output_dir, batch_position, queue_sequence, next_attempt_at, retry_reason, resource_retry_count,
      resource_wait_started_at, created_at, started_at, finished_at
      FROM download_jobs WHERE batch_id = $1 ORDER BY batch_position ASC`, [id]);
    const counts = { QUEUED: 0, WAITING_RESOURCE: 0, RUNNING: 0, SUCCEEDED: 0, FAILED: 0 };
    for (const row of jobs.rows) counts[row.status as keyof typeof counts] += 1;
    const row = batch.rows[0];
    return {
      id: row.id, totalRequested: Number(row.total_requested), queuedCount: Number(row.queued_count), skippedCount: Number(row.skipped_count),
      skippedItems: row.skipped_items || [], status: row.finished_at ? 'COMPLETED' : 'RUNNING', counts,
      createdAt: row.created_at, finishedAt: row.finished_at, items: jobs.rows.map(toJob)
    };
  }

  async listNotifications(input: NotificationQuery) {
    const page = Math.max(1, input.page || 1);
    const pageSize = Math.min(100, Math.max(1, input.pageSize || 20));
    const values: unknown[] = [];
    const where: string[] = [];
    if (input.state === 'UNREAD') where.push('read_at IS NULL');
    if (input.state === 'UNRESOLVED') where.push("severity = 'ERROR' AND resolved_at IS NULL");
    if (input.severity) { values.push(input.severity); where.push(`severity = $${values.length}`); }
    if (input.category?.trim()) { values.push(input.category.trim()); where.push(`category = $${values.length}`); }
    if (input.sourceType?.trim()) { values.push(input.sourceType.trim()); where.push(`source_type = $${values.length}`); }
    if (input.eventType?.trim()) { values.push(input.eventType.trim()); where.push(`event_type = $${values.length}`); }
    if (input.createdFrom) { values.push(normalizeNotificationDate(input.createdFrom, '开始时间')); where.push(`created_at >= $${values.length}::timestamptz`); }
    if (input.createdTo) { values.push(normalizeNotificationDate(input.createdTo, '结束时间')); where.push(`created_at <= $${values.length}::timestamptz`); }
    const filter = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const count = await this.query<{ total: string }>(`SELECT COUNT(*)::text AS total FROM task_notifications ${filter}`, values);
    values.push(pageSize, (page - 1) * pageSize);
    const rows = await this.query<SqlRow>(`SELECT * FROM task_notifications ${filter} ORDER BY created_at DESC LIMIT $${values.length - 1} OFFSET $${values.length}`, values);
    return { items: rows.rows.map(toNotification), total: Number(count.rows[0]?.total || 0), page, pageSize };
  }

  async notificationSummary() {
    const result = await this.query<SqlRow>(`SELECT
      COUNT(*) FILTER (WHERE read_at IS NULL)::text AS unread_count,
      COUNT(*) FILTER (WHERE severity = 'ERROR' AND resolved_at IS NULL)::text AS unresolved_error_count
      FROM task_notifications`);
    return { unreadCount: Number(result.rows[0]?.unread_count || 0), unresolvedErrorCount: Number(result.rows[0]?.unresolved_error_count || 0) };
  }

  /**
   * Creates one notification per stable dedupe key and refreshes its display
   * payload when the producer has newer information. A duplicate write never
   * makes an already-read notification unread and never reopens a resolved
   * notification.
   */
  async upsertNotification(input: TaskNotificationUpsertInput) {
    const normalized = normalizeNotificationUpsert(input);
    const inserted = await this.query<SqlRow>(`INSERT INTO task_notifications (
      id, dedupe_key, category, event_type, severity, title, message,
      source_type, source_id, sku, product_name, workflow_code, details
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb)
    ON CONFLICT (dedupe_key) DO UPDATE SET
      category = EXCLUDED.category,
      event_type = EXCLUDED.event_type,
      severity = EXCLUDED.severity,
      title = EXCLUDED.title,
      message = EXCLUDED.message,
      sku = EXCLUDED.sku,
      product_name = EXCLUDED.product_name,
      workflow_code = EXCLUDED.workflow_code,
      details = EXCLUDED.details,
      updated_at = NOW()
    WHERE task_notifications.source_type = EXCLUDED.source_type
      AND task_notifications.source_id = EXCLUDED.source_id
      AND (task_notifications.category, task_notifications.event_type, task_notifications.severity,
        task_notifications.title, task_notifications.message, task_notifications.sku,
        task_notifications.product_name, task_notifications.workflow_code, task_notifications.details)
      IS DISTINCT FROM (EXCLUDED.category, EXCLUDED.event_type, EXCLUDED.severity,
        EXCLUDED.title, EXCLUDED.message, EXCLUDED.sku,
        EXCLUDED.product_name, EXCLUDED.workflow_code, EXCLUDED.details)
    RETURNING *`, [
      randomUUID(), normalized.dedupeKey, normalized.category, normalized.eventType, normalized.severity,
      normalized.title, normalized.message, normalized.sourceType, normalized.sourceId, normalized.sku || null,
      normalized.productName || null, normalized.workflowCode || null, JSON.stringify(normalized.details)
    ]);
    if (inserted.rows[0]) return toNotification(inserted.rows[0]);

    const existing = await this.query<SqlRow>('SELECT * FROM task_notifications WHERE dedupe_key = $1', [normalized.dedupeKey]);
    const row = existing.rows[0];
    if (!row) throw new AppError('DATABASE_WRITE_FAILED', '通知写入后无法回读', { dedupeKey: normalized.dedupeKey }, 500);
    if (row.source_type !== normalized.sourceType || row.source_id !== normalized.sourceId) {
      throw new AppError('CONFIG_INVALID', '通知去重键已被其他来源占用', {
        dedupeKey: normalized.dedupeKey,
        existingSourceType: row.source_type,
        existingSourceId: row.source_id
      }, 409);
    }
    return toNotification(row);
  }

  /** Resolves notification threads either by one dedupe key or by source identity. */
  async resolveNotifications(input: TaskNotificationResolveInput) {
    const normalized = normalizeNotificationResolve(input);
    const values: unknown[] = [];
    const where: string[] = ['resolved_at IS NULL'];
    if (normalized.dedupeKey) {
      values.push(normalized.dedupeKey);
      where.push(`dedupe_key = $${values.length}`);
    } else {
      values.push(normalized.sourceType, normalized.sourceId);
      where.push(`source_type = $${values.length - 1}`);
      where.push(`source_id = $${values.length}`);
    }
    if (normalized.eventType) {
      values.push(normalized.eventType);
      where.push(`event_type = $${values.length}`);
    }
    values.push(JSON.stringify(normalized.details));
    const detailsParameter = values.length;
    const rows = await this.query<SqlRow>(`UPDATE task_notifications SET
      details = details || $${detailsParameter}::jsonb,
      read_at = COALESCE(read_at, NOW()),
      resolved_at = NOW(),
      updated_at = NOW()
      WHERE ${where.join(' AND ')}
      RETURNING *`, values);
    return { updated: rows.rowCount || 0, items: rows.rows.map(toNotification) };
  }

  async updateNotification(id: string, input: { read?: boolean; resolved?: boolean }) {
    const row = await this.query<SqlRow>(`UPDATE task_notifications SET
      read_at = CASE WHEN $2::boolean IS NULL THEN read_at WHEN $2 THEN COALESCE(read_at, NOW()) ELSE NULL END,
      resolved_at = CASE WHEN $3::boolean IS NULL THEN resolved_at WHEN $3 THEN COALESCE(resolved_at, NOW()) ELSE NULL END,
      updated_at = NOW()
      WHERE id = $1 RETURNING *`, [id, input.read ?? null, input.resolved ?? null]);
    if (!row.rows[0]) throw new AppError('NOT_FOUND', '通知不存在', { id }, 404);
    if (input.resolved) await this.query('UPDATE task_notifications SET read_at = COALESCE(read_at, NOW()) WHERE id = $1', [id]);
    const refreshed = await this.query<SqlRow>('SELECT * FROM task_notifications WHERE id = $1', [id]);
    return toNotification(refreshed.rows[0]!);
  }

  async markAllNotificationsRead() {
    const result = await this.query(`UPDATE task_notifications SET read_at = NOW(), updated_at = NOW() WHERE read_at IS NULL`);
    return { updated: result.rowCount || 0 };
  }

  async retryNotification(id: string, expectedWorkflows?: WorkflowInput[]) {
    if (expectedWorkflows) {
      validateWorkflowSet(expectedWorkflows);
      await assertSafeWorkflowSet(expectedWorkflows);
    }
    return this.transaction(async (client) => {
      if (expectedWorkflows) await prepareWorkflowProjection(client, expectedWorkflows);
      else await lockDownloadEnqueue(client);
      const notification = await client.query<SqlRow>(`SELECT * FROM task_notifications WHERE id = $1 FOR UPDATE`, [id]);
      const row = notification.rows[0];
      if (!row || row.event_type !== 'DOWNLOAD_JOB_FAILED') throw new AppError('NOT_FOUND', '可重试的失败通知不存在', { id }, 404);
      if (!row.sku || !row.workflow_code) throw new AppError('CONFIG_INVALID', '通知缺少 SKU 或工作流代码，无法重试', { id }, 409);
      let jobId: string;
      try {
        jobId = await insertDownloadJob(client, row.sku, row.workflow_code, { strict: true, notificationThreadId: id }, expectedWorkflows);
      } catch (error) {
        if (error instanceof AppError && error.code === 'DOWNLOAD_WORKFLOW_UNAVAILABLE') {
          throw new AppError(error.code, '原下载工作流已停用或不存在，请前往采购管理重新选择工作流', error.details, 409);
        }
        throw error;
      }
      const details = asRecord(row.details);
      const retryHistory = Array.isArray(details.retryHistory) ? [...details.retryHistory] : [];
      retryHistory.push({ jobId, status: 'QUEUED', queuedAt: new Date().toISOString() });
      await client.query(`UPDATE task_notifications SET details = $2::jsonb, read_at = NOW(), resolved_at = NULL, updated_at = NOW() WHERE id = $1`, [
        id, JSON.stringify({ ...details, retryHistory, latestRetryJobId: jobId })
      ]);
      return this.getJobWithClient(client, jobId);
    });
  }

  async claimNextJob(workerId = 'repository-direct', leaseDurationMs = 90_000) {
    const normalizedWorkerId = String(workerId || '').trim();
    if (!normalizedWorkerId || leaseDurationMs < 5_000 || leaseDurationMs > 3_600_000) {
      throw new AppError('CONFIG_INVALID', '下载 Worker 租约参数无效');
    }
    return this.transaction(async (client) => {
      await client.query(`SELECT pg_advisory_xact_lock(hashtext('pixroute_download_worker_global'))`);
      const running = await client.query<SqlRow>(`SELECT j.*, p.product_name,
        COALESCE(j.workflow_snapshot->>'recoveryMode', 'MANUAL') AS recovery_mode
        FROM download_jobs j
        JOIN products p ON p.sku=j.sku
        WHERE j.status='RUNNING'
        ORDER BY j.started_at ASC NULLS FIRST, j.queue_sequence ASC
        LIMIT 1 FOR UPDATE OF j`);
      const active = running.rows[0];
      if (active) {
        const leaseExpiresAt = active.lease_expires_at ? new Date(active.lease_expires_at).getTime() : 0;
        if (leaseExpiresAt > Date.now()) return undefined;
        if (active.recovery_mode === 'IDEMPOTENT_REPLAY') {
          const leaseToken = randomUUID();
          const recovered = await client.query<SqlRow>(`UPDATE download_jobs SET
            lease_owner=$2, lease_token=$3, heartbeat_at=NOW(),
            lease_expires_at=NOW()+($4::text || ' milliseconds')::interval,
            attempt=attempt+1, retry_reason='restart_recovery',
            error_message='MerchRoute 重启后正在核验原下载执行', finished_at=NULL
            WHERE id=$1 AND status='RUNNING'
            RETURNING *`, [active.id, normalizedWorkerId, leaseToken, leaseDurationMs]);
          return toClaimedJob({ ...recovered.rows[0]!, recovery_mode: active.recovery_mode });
        }

        const errorMessage = '下载服务在任务完成前中断，且当前工作流未启用幂等重放；任务已停止，请人工核验后重试。';
        const interruptedResult = {
          success: false,
          status: 'worker_interrupted_unconfirmed',
          errors: [errorMessage]
        };
        await client.query(`UPDATE download_jobs SET status='FAILED', result_json=$2::jsonb,
          error_message=$3, retry_reason='worker_interrupted_unconfirmed', next_attempt_at=NULL,
          lease_owner=NULL, lease_token=NULL, heartbeat_at=NULL, lease_expires_at=NULL, finished_at=NOW()
          WHERE id=$1 AND status='RUNNING'`, [active.id, JSON.stringify(interruptedResult), errorMessage]);
        await upsertFailureNotification(client, active, interruptedResult, errorMessage);
        if (active.batch_id) await finalizeBatchIfComplete(client, active.batch_id);
      }

      const next = await client.query<SqlRow>(`SELECT j.id,
        COALESCE(j.workflow_snapshot->>'recoveryMode', 'MANUAL') AS recovery_mode
        FROM download_jobs j JOIN download_workflows w ON w.code=j.workflow_code
        WHERE j.status='QUEUED' OR (j.status='WAITING_RESOURCE' AND j.next_attempt_at<=NOW())
        ORDER BY COALESCE(j.next_attempt_at,j.created_at) ASC,j.queue_sequence ASC
        LIMIT 1 FOR UPDATE OF j SKIP LOCKED`);
      if (!next.rows[0]) return undefined;
      const leaseToken = randomUUID();
      const claimed = await client.query<SqlRow>(`UPDATE download_jobs SET status='RUNNING',
        started_at=COALESCE(started_at,NOW()), attempt=attempt+1, next_attempt_at=NULL, retry_reason=NULL,
        lease_owner=$2, lease_token=$3, heartbeat_at=NOW(),
        lease_expires_at=NOW()+($4::text || ' milliseconds')::interval, finished_at=NULL
        WHERE id=$1
        RETURNING *`, [next.rows[0].id, normalizedWorkerId, leaseToken, leaseDurationMs]);
      return toClaimedJob({ ...claimed.rows[0]!, recovery_mode: next.rows[0].recovery_mode });
    });
  }

  async renewJobLease(id: string, workerId: string, leaseToken: string, leaseDurationMs = 90_000): Promise<boolean> {
    const renewed = await this.query(`UPDATE download_jobs SET heartbeat_at=NOW(),
      lease_expires_at=NOW()+($4::text || ' milliseconds')::interval
      WHERE id=$1 AND status='RUNNING' AND lease_owner=$2 AND lease_token=$3::uuid`, [id, workerId, leaseToken, leaseDurationMs]);
    return (renewed.rowCount || 0) === 1;
  }

  async markJobRecovering(id: string, workerId: string, leaseToken: string, reason = 'restart_recovery'): Promise<boolean> {
    const updated = await this.query(`UPDATE download_jobs SET retry_reason=$4,
      error_message='MerchRoute 正在核验原下载执行', heartbeat_at=NOW()
      WHERE id=$1 AND status='RUNNING' AND lease_owner=$2 AND lease_token=$3::uuid`, [id, workerId, leaseToken, reason]);
    return (updated.rowCount || 0) === 1;
  }

  async completeJob(id: string, result: JsonRecord, leaseToken: string) {
    const outputDir = typeof result.outputDir === 'string' ? result.outputDir : undefined;
    const success = result.success !== false;
    return this.finishJob(id, success, result, leaseToken, outputDir, success ? undefined : messageFromResult(result));
  }

  async deferResourceJob(id: string, result: JsonRecord, leaseToken: string) {
    return this.transaction(async (client) => {
      const locked = await client.query<SqlRow>(`SELECT j.*, p.product_name FROM download_jobs j
        JOIN products p ON p.sku = j.sku WHERE j.id = $1 FOR UPDATE`, [id]);
      const job = locked.rows[0];
      if (!job) throw new AppError('NOT_FOUND', '下载任务不存在', { id }, 404);
      if (job.status === 'SUCCEEDED' || job.status === 'FAILED') return this.getJobWithClient(client, id);
      if (job.status !== 'RUNNING' || job.lease_token !== leaseToken) return this.getJobWithClient(client, id);

      const now = new Date();
      const waitStartedAt = job.resource_wait_started_at ? new Date(job.resource_wait_started_at) : now;
      const resourceRetryCount = Number(job.resource_retry_count || 0) + 1;
      const exhausted = resourceRetryCount >= DOWNLOAD_RESOURCE_RETRY_MAX_ATTEMPTS
        || now.getTime() - waitStartedAt.getTime() >= DOWNLOAD_RESOURCE_RETRY_BUDGET_MS;
      const outputDir = typeof result.outputDir === 'string' ? result.outputDir : job.output_dir || null;

      if (exhausted) {
        const errorMessage = '专用下载浏览器在 30 分钟或 12 次重试内仍未释放；请关闭登录窗口或在登录终端按 Enter 后重新下载。';
        const errors = Array.isArray(result.errors) ? result.errors.map(String) : [];
        const exhaustedResult = {
          ...result,
          success: false,
          status: 'profile_busy_retry_exhausted',
          resourceRetryCount,
          resourceWaitStartedAt: waitStartedAt.toISOString(),
          errors: [...new Set([...errors, errorMessage])]
        };
        await client.query(`UPDATE download_jobs SET status='FAILED', result_json=$2::jsonb, output_dir=$3,
          error_message=$4, retry_reason='profile_busy', resource_retry_count=$5, resource_wait_started_at=$6,
          next_attempt_at=NULL, lease_owner=NULL, lease_token=NULL, heartbeat_at=NULL, lease_expires_at=NULL,
          finished_at=NOW() WHERE id=$1 AND lease_token=$7::uuid`, [
          id, JSON.stringify(exhaustedResult), outputDir, errorMessage, resourceRetryCount, waitStartedAt, leaseToken
        ]);
        const failedJob = { ...job, result_json: exhaustedResult, output_dir: outputDir, error_message: errorMessage };
        await upsertFailureNotification(client, failedJob, exhaustedResult, errorMessage);
        if (job.batch_id) await finalizeBatchIfComplete(client, job.batch_id);
        return this.getJobWithClient(client, id);
      }

      const delayMs = downloadResourceRetryDelayMs(resourceRetryCount);
      const nextAttemptAt = new Date(now.getTime() + delayMs);
      const waitMessage = `专用下载浏览器正在用于登录或另一条下载任务；释放后系统将使用同一任务自动重试（第 ${resourceRetryCount} 次等待）。`;
      const waitingResult = {
        ...result,
        success: false,
        status: 'profile_busy',
        resourceRetryCount,
        resourceWaitStartedAt: waitStartedAt.toISOString(),
        nextAttemptAt: nextAttemptAt.toISOString()
      };
      await client.query(`UPDATE download_jobs SET status='WAITING_RESOURCE', result_json=$2::jsonb, output_dir=$3,
        error_message=$4, next_attempt_at=$5, retry_reason='profile_busy', resource_retry_count=$6,
        resource_wait_started_at=$7, lease_owner=NULL, lease_token=NULL, heartbeat_at=NULL, lease_expires_at=NULL,
        finished_at=NULL WHERE id=$1 AND lease_token=$8::uuid`, [
        id, JSON.stringify(waitingResult), outputDir, waitMessage, nextAttemptAt, resourceRetryCount, waitStartedAt, leaseToken
      ]);
      return this.getJobWithClient(client, id);
    });
  }

  async failJob(id: string, message: string, leaseToken: string) {
    return this.finishJob(id, false, {}, leaseToken, undefined, message.slice(0, 1500));
  }

  private async finishJob(id: string, success: boolean, result: JsonRecord, leaseToken: string, outputDir?: string, errorMessage?: string): Promise<boolean> {
    return this.transaction(async (client) => {
      const locked = await client.query<SqlRow>(`SELECT j.*, p.product_name FROM download_jobs j JOIN products p ON p.sku = j.sku WHERE j.id = $1 FOR UPDATE`, [id]);
      const job = locked.rows[0];
      if (!job) throw new AppError('NOT_FOUND', '下载任务不存在', { id }, 404);
      if (job.status === 'SUCCEEDED' || job.status === 'FAILED') return false;
      if (job.status !== 'RUNNING' || job.lease_token !== leaseToken) return false;
      await client.query(`UPDATE download_jobs SET status = $2, result_json = $3::jsonb, output_dir = $4, error_message = $5,
        next_attempt_at = NULL, retry_reason = NULL, lease_owner=NULL, lease_token=NULL, heartbeat_at=NULL,
        lease_expires_at=NULL, finished_at = NOW() WHERE id = $1 AND lease_token=$6::uuid`, [
        id, success ? 'SUCCEEDED' : 'FAILED', Object.keys(result).length ? JSON.stringify(result) : null, outputDir || null, success ? null : errorMessage || '下载工作流调用失败', leaseToken
      ]);
      if (success && job.notification_thread_id) await resolveRetryNotification(client, job.notification_thread_id, job, result);
      if (!success) await upsertFailureNotification(client, job, result, errorMessage || '下载工作流调用失败');
      if (job.batch_id) await finalizeBatchIfComplete(client, job.batch_id);
      return true;
    });
  }

  private async getPurchaseWithClient(client: PoolClient, sku: string) {
    const product = await client.query<SqlRow>('SELECT sku, product_name, created_at, updated_at FROM products WHERE sku = $1', [sku]);
    const versions = await client.query<SqlRow>(`SELECT id, version_no, download_workflow_code, purchase_price, retail_price, courier_fee, currency,
      gross_weight_g, length_cm, width_cm, height_cm,
      net_weight_g, product_height_cm, product_depth_cm, product_width_cm,
      transport_mode, provider_url, created_at
      FROM procurement_versions WHERE sku = $1 ORDER BY version_no DESC`, [sku]);
    const variants = await client.query<{ name: string }>('SELECT name FROM product_variants WHERE sku=$1 ORDER BY sort_order ASC,created_at ASC', [sku]);
    return { ...toProduct(product.rows[0]!), variants: variants.rows.map((item) => item.name), procurementVersions: versions.rows.map(toProcurementVersion), downloadJobs: [] };
  }

  private async getJobWithClient(client: PoolClient | undefined, id: string) {
    const executor = client || this.requirePool();
    const result = await executor.query<SqlRow>(`SELECT id, sku, workflow_code, workflow_snapshot, request_body, status, attempt, result_json,
      error_message, output_dir, batch_id, batch_position, queue_sequence, notification_thread_id, next_attempt_at, retry_reason,
      resource_retry_count, resource_wait_started_at, created_at, started_at, finished_at
      FROM download_jobs WHERE id = $1`, [id]);
    if (!result.rows[0]) throw new AppError('NOT_FOUND', '下载任务不存在', { id }, 404);
    return toJob(result.rows[0]);
  }

  private requirePool(): Pool { if (!this.pool) throw new AppError('DATABASE_UNAVAILABLE', '采购管理尚未配置 PostgreSQL DATABASE_URL', undefined, 503); return this.pool; }
  private query<T extends SqlRow = SqlRow>(text: string, values?: unknown[]) { return this.requirePool().query<T>(text, values); }
  private async transaction<T>(action: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.requirePool().connect();
    try { await client.query('BEGIN'); const result = await action(client); await client.query('COMMIT'); return result; }
    catch (error) { await client.query('ROLLBACK').catch(() => undefined); throw error; }
    finally { client.release(); }
  }

  private async migrate() {
    await this.query(`CREATE TABLE IF NOT EXISTS purchase_schema_migrations (id TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
    const applied = await this.query<{ id: string }>('SELECT id FROM purchase_schema_migrations WHERE id = $1', ['001_purchase_management']);
    if (!applied.rows[0]) {
      await this.transaction(async (client) => {
        await client.query(`CREATE TABLE products (
          sku CHAR(7) PRIMARY KEY CHECK (sku ~ '^[0-9]{7}$'), product_name TEXT NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
        await client.query(`CREATE TABLE purchase_sku_counter (singleton BOOLEAN PRIMARY KEY DEFAULT true CHECK (singleton), last_value INTEGER NOT NULL CHECK (last_value >= 0))`);
        await client.query(`CREATE TABLE procurement_versions (
          id UUID PRIMARY KEY, sku CHAR(7) NOT NULL REFERENCES products(sku) ON DELETE CASCADE, version_no INTEGER NOT NULL,
          purchase_price NUMERIC(14,4) NOT NULL, courier_fee NUMERIC(14,4) NOT NULL DEFAULT 0, currency CHAR(3) NOT NULL DEFAULT 'CNY',
          gross_weight_g NUMERIC(14,3), length_cm NUMERIC(14,3), width_cm NUMERIC(14,3), height_cm NUMERIC(14,3),
          transport_mode TEXT, provider_url TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), UNIQUE (sku, version_no))`);
        await client.query(`CREATE TABLE download_workflows (
          code TEXT PRIMARY KEY CHECK (code ~ '^E[0-9]{3}$'), display_name TEXT NOT NULL, webhook_url TEXT NOT NULL,
          parent_output_dir TEXT NOT NULL, timeout_ms INTEGER NOT NULL DEFAULT 900000 CHECK (timeout_ms BETWEEN 5000 AND 3600000),
          enabled BOOLEAN NOT NULL DEFAULT true, is_default BOOLEAN NOT NULL DEFAULT false,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
        await client.query(`CREATE UNIQUE INDEX download_workflows_one_default ON download_workflows ((is_default)) WHERE is_default = true AND enabled = true`);
        await client.query(`CREATE TABLE download_jobs (
          id UUID PRIMARY KEY, sku CHAR(7) NOT NULL REFERENCES products(sku) ON DELETE CASCADE, procurement_version_id UUID NOT NULL REFERENCES procurement_versions(id),
          workflow_code TEXT NOT NULL REFERENCES download_workflows(code), workflow_snapshot JSONB NOT NULL, request_body JSONB NOT NULL,
          status TEXT NOT NULL DEFAULT 'QUEUED' CHECK (status IN ('QUEUED','WAITING_RESOURCE','RUNNING','SUCCEEDED','FAILED')), attempt INTEGER NOT NULL DEFAULT 0,
          result_json JSONB, error_message TEXT, output_dir TEXT, next_attempt_at TIMESTAMPTZ, retry_reason TEXT,
          resource_retry_count INTEGER NOT NULL DEFAULT 0, resource_wait_started_at TIMESTAMPTZ,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), started_at TIMESTAMPTZ, finished_at TIMESTAMPTZ)`);
        await client.query(`CREATE UNIQUE INDEX download_jobs_one_active_per_sku ON download_jobs (sku) WHERE status IN ('QUEUED','WAITING_RESOURCE','RUNNING')`);
        await client.query('CREATE INDEX procurement_versions_sku_version ON procurement_versions (sku, version_no DESC)');
        await client.query('CREATE INDEX download_jobs_sku_created ON download_jobs (sku, created_at DESC)');
        await client.query(`INSERT INTO purchase_schema_migrations (id) VALUES ('001_purchase_management')`);
      });
    }
    const pricingLookupIndex = await this.query<{ id: string }>('SELECT id FROM purchase_schema_migrations WHERE id = $1', ['002_pricing_product_lookup']);
    if (!pricingLookupIndex.rows[0]) {
      await this.transaction(async (client) => {
        await client.query('CREATE INDEX IF NOT EXISTS products_product_name_lower ON products (LOWER(product_name))');
        await client.query(`INSERT INTO purchase_schema_migrations (id) VALUES ('002_pricing_product_lookup')`);
      });
    }
    const fuzzyLookupIndex = await this.query<{ id: string }>('SELECT id FROM purchase_schema_migrations WHERE id = $1', ['003_pricing_product_name_contains']);
    if (!fuzzyLookupIndex.rows[0]) {
      await this.transaction(async (client) => {
        await client.query('CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA public');
        await client.query('CREATE INDEX IF NOT EXISTS products_product_name_trgm ON products USING GIN (LOWER(product_name) public.gin_trgm_ops)');
        await client.query('DROP INDEX IF EXISTS products_product_name_lower');
        await client.query(`INSERT INTO purchase_schema_migrations (id) VALUES ('003_pricing_product_name_contains') ON CONFLICT (id) DO NOTHING`);
      });
    }
    const queueNotifications = await this.query<{ id: string }>('SELECT id FROM purchase_schema_migrations WHERE id = $1', ['004_download_queue_notifications']);
    if (!queueNotifications.rows[0]) {
      await this.transaction(async (client) => {
        await client.query(`CREATE SEQUENCE IF NOT EXISTS download_jobs_queue_sequence_seq`);
        await client.query(`ALTER TABLE download_jobs ADD COLUMN IF NOT EXISTS queue_sequence BIGINT`);
        await client.query(`ALTER TABLE download_jobs ALTER COLUMN queue_sequence SET DEFAULT nextval('download_jobs_queue_sequence_seq')`);
        await client.query(`UPDATE download_jobs SET queue_sequence = nextval('download_jobs_queue_sequence_seq') WHERE queue_sequence IS NULL`);
        await client.query(`ALTER TABLE download_jobs ALTER COLUMN queue_sequence SET NOT NULL`);
        await client.query(`ALTER SEQUENCE download_jobs_queue_sequence_seq OWNED BY download_jobs.queue_sequence`);
        await client.query(`SELECT setval('download_jobs_queue_sequence_seq', GREATEST(COALESCE((SELECT MAX(queue_sequence) FROM download_jobs), 0), 1), COALESCE((SELECT MAX(queue_sequence) FROM download_jobs), 0) > 0)`);
        await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS download_jobs_queue_sequence_unique ON download_jobs (queue_sequence)`);
        await client.query(`CREATE TABLE download_batches (
          id UUID PRIMARY KEY, total_requested INTEGER NOT NULL CHECK (total_requested BETWEEN 1 AND 200),
          queued_count INTEGER NOT NULL DEFAULT 0, skipped_count INTEGER NOT NULL DEFAULT 0, skipped_items JSONB NOT NULL DEFAULT '[]'::jsonb,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), finished_at TIMESTAMPTZ)`);
        await client.query(`ALTER TABLE download_jobs ADD COLUMN IF NOT EXISTS batch_id UUID REFERENCES download_batches(id) ON DELETE SET NULL`);
        await client.query(`ALTER TABLE download_jobs ADD COLUMN IF NOT EXISTS batch_position INTEGER`);
        await client.query(`ALTER TABLE download_jobs ADD COLUMN IF NOT EXISTS notification_thread_id UUID`);
        await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS download_jobs_batch_position_unique ON download_jobs (batch_id, batch_position) WHERE batch_id IS NOT NULL`);
        await client.query(`CREATE INDEX IF NOT EXISTS download_jobs_batch_status ON download_jobs (batch_id, status)`);
        await client.query(`CREATE TABLE task_notifications (
          id UUID PRIMARY KEY, dedupe_key TEXT NOT NULL UNIQUE, category TEXT NOT NULL, event_type TEXT NOT NULL,
          severity TEXT NOT NULL CHECK (severity IN ('INFO','SUCCESS','WARNING','ERROR')), title TEXT NOT NULL, message TEXT NOT NULL,
          source_type TEXT NOT NULL, source_id TEXT NOT NULL, batch_id UUID, sku CHAR(7), product_name TEXT, workflow_code TEXT,
          details JSONB NOT NULL DEFAULT '{}'::jsonb, read_at TIMESTAMPTZ, resolved_at TIMESTAMPTZ,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
        await client.query(`CREATE INDEX task_notifications_created ON task_notifications (created_at DESC)`);
        await client.query(`CREATE INDEX task_notifications_unread ON task_notifications (created_at DESC) WHERE read_at IS NULL`);
        await client.query(`CREATE INDEX task_notifications_unresolved_errors ON task_notifications (created_at DESC) WHERE severity = 'ERROR' AND resolved_at IS NULL`);
        await client.query(`INSERT INTO purchase_schema_migrations (id) VALUES ('004_download_queue_notifications')`);
      });
    }
    const productVariants = await this.query<{ id: string }>('SELECT id FROM purchase_schema_migrations WHERE id=$1', ['005_product_variants']);
    if (!productVariants.rows[0]) {
      await this.transaction(async (client) => {
        await client.query(`CREATE TABLE IF NOT EXISTS product_variants (
          id UUID PRIMARY KEY, sku CHAR(7) NOT NULL REFERENCES products(sku) ON DELETE CASCADE,
          name TEXT NOT NULL, normalized_name TEXT NOT NULL, sort_order INTEGER NOT NULL DEFAULT 0 CHECK(sort_order>=0),
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          UNIQUE(sku,normalized_name))`);
        const products = await client.query<{ sku: string }>('SELECT sku FROM products ORDER BY sku');
        for (const product of products.rows) {
          await client.query(`INSERT INTO product_variants(id,sku,name,normalized_name,sort_order)
            VALUES($1,$2,$3,$4,0) ON CONFLICT(sku,normalized_name) DO NOTHING`, [randomUUID(), product.sku, '默认变体', normalizeProductVariantKey('默认变体')]);
        }
        await client.query('CREATE INDEX IF NOT EXISTS product_variants_sku_sort ON product_variants(sku,sort_order,created_at)');
        await client.query(`INSERT INTO purchase_schema_migrations(id) VALUES('005_product_variants')`);
      });
    }
    const providerUrlRegistry = await this.query<{ id: string }>('SELECT id FROM purchase_schema_migrations WHERE id=$1', ['006_purchase_provider_url_registry']);
    if (!providerUrlRegistry.rows[0]) {
      await this.transaction(async (client) => {
        const duplicate = await client.query<{ provider_url_key: string; skus: string[] }>(`
          SELECT BTRIM(provider_url) AS provider_url_key, ARRAY_AGG(DISTINCT sku ORDER BY sku) AS skus
          FROM procurement_versions
          GROUP BY BTRIM(provider_url)
          HAVING COUNT(DISTINCT sku) > 1
          LIMIT 1`);
        if (duplicate.rows[0]) {
          throw new AppError('DATABASE_WRITE_FAILED', '现有采购数据包含跨 SKU 重复的产品 URL，无法启用 URL 去重', duplicate.rows[0], 409);
        }
        await client.query(`CREATE TABLE purchase_provider_urls (
          provider_url_key TEXT PRIMARY KEY CHECK (LENGTH(provider_url_key) > 0),
          sku CHAR(7) NOT NULL REFERENCES products(sku) ON DELETE CASCADE,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
        await client.query(`INSERT INTO purchase_provider_urls(provider_url_key,sku,created_at)
          SELECT DISTINCT ON (BTRIM(provider_url)) BTRIM(provider_url),sku,created_at
          FROM procurement_versions
          ORDER BY BTRIM(provider_url),created_at ASC`);
        await client.query('CREATE INDEX purchase_provider_urls_sku ON purchase_provider_urls(sku)');
        await client.query(`INSERT INTO purchase_schema_migrations(id) VALUES('006_purchase_provider_url_registry')`);
      });
    }
    const productVariantColors = await this.query<{ id: string }>('SELECT id FROM purchase_schema_migrations WHERE id=$1', ['007_product_variant_wb_colors']);
    if (!productVariantColors.rows[0]) {
      await this.transaction(async (client) => {
        await client.query('ALTER TABLE product_variants ADD COLUMN IF NOT EXISTS wb_color_key TEXT');
        await client.query('ALTER TABLE product_variants ADD COLUMN IF NOT EXISTS wb_color_name_ru TEXT');
        await client.query('ALTER TABLE product_variants ADD COLUMN IF NOT EXISTS wb_color_name_zh TEXT');
        await client.query(`ALTER TABLE product_variants ADD CONSTRAINT product_variants_wb_color_key_format
          CHECK (wb_color_key IS NULL OR wb_color_key ~ '^[a-f0-9]{64}$')`);
        await client.query(`CREATE UNIQUE INDEX product_variants_sku_wb_color_unique
          ON product_variants(sku,wb_color_key) WHERE wb_color_key IS NOT NULL`);
        await client.query(`INSERT INTO purchase_schema_migrations(id) VALUES('007_product_variant_wb_colors')`);
      });
    }
    const notificationSourceLookup = await this.query<{ id: string }>('SELECT id FROM purchase_schema_migrations WHERE id=$1', ['008_task_notification_source_lookup']);
    if (!notificationSourceLookup.rows[0]) {
      await this.transaction(async (client) => {
        await client.query(`CREATE INDEX IF NOT EXISTS task_notifications_source_lookup
          ON task_notifications(source_type,source_id,event_type,created_at DESC)`);
        await client.query(`INSERT INTO purchase_schema_migrations(id) VALUES('008_task_notification_source_lookup')`);
      });
    }
    const purchaseDefaultDownloadWorkflow = await this.query<{ id: string }>('SELECT id FROM purchase_schema_migrations WHERE id=$1', ['009_purchase_default_download_workflow']);
    if (!purchaseDefaultDownloadWorkflow.rows[0]) {
      await this.transaction(async (client) => {
        await client.query(`ALTER TABLE procurement_versions ADD COLUMN IF NOT EXISTS download_workflow_code TEXT REFERENCES download_workflows(code)`);
        await client.query(`UPDATE procurement_versions SET download_workflow_code = COALESCE(
          (SELECT code FROM download_workflows WHERE code='E006' LIMIT 1),
          (SELECT code FROM download_workflows WHERE enabled=true AND is_default=true ORDER BY code LIMIT 1)
        ) WHERE download_workflow_code IS NULL`);
        await client.query('CREATE INDEX IF NOT EXISTS procurement_versions_download_workflow ON procurement_versions(download_workflow_code)');
        await client.query(`CREATE INDEX IF NOT EXISTS products_created_at ON products(created_at)`);
        await client.query(`INSERT INTO purchase_schema_migrations(id) VALUES('009_purchase_default_download_workflow')`);
      });
    }
    const purchaseProductMeasurements = await this.query<{ id: string }>('SELECT id FROM purchase_schema_migrations WHERE id=$1', ['010_purchase_product_measurements']);
    if (!purchaseProductMeasurements.rows[0]) {
      await this.transaction(async (client) => {
        await client.query(`ALTER TABLE procurement_versions
          ADD COLUMN IF NOT EXISTS product_height_cm NUMERIC(14,3),
          ADD COLUMN IF NOT EXISTS product_depth_cm NUMERIC(14,3),
          ADD COLUMN IF NOT EXISTS product_width_cm NUMERIC(14,3),
          ADD COLUMN IF NOT EXISTS net_weight_g NUMERIC(14,3)`);
        await client.query(`INSERT INTO purchase_schema_migrations(id) VALUES('010_purchase_product_measurements')`);
      });
    }
    const downloadResourceWaiting = await this.query<{ id: string }>('SELECT id FROM purchase_schema_migrations WHERE id=$1', ['011_download_resource_waiting']);
    if (!downloadResourceWaiting.rows[0]) {
      await this.transaction(async (client) => {
        await client.query(`ALTER TABLE download_jobs
          ADD COLUMN IF NOT EXISTS next_attempt_at TIMESTAMPTZ,
          ADD COLUMN IF NOT EXISTS retry_reason TEXT,
          ADD COLUMN IF NOT EXISTS resource_retry_count INTEGER NOT NULL DEFAULT 0,
          ADD COLUMN IF NOT EXISTS resource_wait_started_at TIMESTAMPTZ`);
        await client.query(`ALTER TABLE download_jobs DROP CONSTRAINT IF EXISTS download_jobs_status_check`);
        await client.query(`ALTER TABLE download_jobs ADD CONSTRAINT download_jobs_status_check
          CHECK (status IN ('QUEUED','WAITING_RESOURCE','RUNNING','SUCCEEDED','FAILED'))`);
        await client.query(`DROP INDEX IF EXISTS download_jobs_one_active_per_sku`);
        await client.query(`CREATE UNIQUE INDEX download_jobs_one_active_per_sku ON download_jobs (sku)
          WHERE status IN ('QUEUED','WAITING_RESOURCE','RUNNING')`);
        await client.query(`CREATE INDEX IF NOT EXISTS download_jobs_resource_retry_due
          ON download_jobs(next_attempt_at, queue_sequence) WHERE status='WAITING_RESOURCE'`);
        await client.query(`INSERT INTO purchase_schema_migrations(id) VALUES('011_download_resource_waiting')`);
      });
    }
    const productVariantOzonColors = await this.query<{ id: string }>('SELECT id FROM purchase_schema_migrations WHERE id=$1', ['012_product_variant_ozon_colors']);
    if (!productVariantOzonColors.rows[0]) {
      await this.transaction(async (client) => {
        await client.query(`ALTER TABLE product_variants
          ADD COLUMN IF NOT EXISTS ozon_color_item_key TEXT,
          ADD COLUMN IF NOT EXISTS ozon_color_dictionary_id BIGINT,
          ADD COLUMN IF NOT EXISTS ozon_color_value_id BIGINT,
          ADD COLUMN IF NOT EXISTS ozon_color_name_ru TEXT,
          ADD COLUMN IF NOT EXISTS ozon_color_name_zh TEXT,
          ADD COLUMN IF NOT EXISTS ozon_color_source TEXT`);
        await client.query(`ALTER TABLE product_variants ADD CONSTRAINT product_variants_ozon_color_complete
          CHECK (
            (ozon_color_item_key IS NULL AND ozon_color_dictionary_id IS NULL AND ozon_color_value_id IS NULL
              AND ozon_color_name_ru IS NULL AND ozon_color_name_zh IS NULL AND ozon_color_source IS NULL)
            OR
            (ozon_color_item_key IS NOT NULL AND ozon_color_dictionary_id > 0 AND ozon_color_value_id > 0
              AND LENGTH(BTRIM(ozon_color_name_ru)) > 0 AND LENGTH(BTRIM(ozon_color_name_zh)) > 0
              AND ozon_color_source IN ('AUTO_EXACT_RU','MANUAL_E001','MANUAL_OZON'))
          )`);
        await client.query(`CREATE INDEX IF NOT EXISTS product_variants_ozon_color_value
          ON product_variants(ozon_color_dictionary_id,ozon_color_value_id)
          WHERE ozon_color_value_id IS NOT NULL`);
        await client.query(`INSERT INTO purchase_schema_migrations(id) VALUES('012_product_variant_ozon_colors')`);
      });
    }
    const downloadJobLeases = await this.query<{ id: string }>('SELECT id FROM purchase_schema_migrations WHERE id=$1', ['013_download_job_leases']);
    if (!downloadJobLeases.rows[0]) {
      await this.transaction(async (client) => {
        await client.query(`ALTER TABLE download_workflows
          ADD COLUMN IF NOT EXISTS recovery_mode TEXT NOT NULL DEFAULT 'MANUAL'`);
        await client.query(`ALTER TABLE download_workflows DROP CONSTRAINT IF EXISTS download_workflows_recovery_mode_check`);
        await client.query(`ALTER TABLE download_workflows ADD CONSTRAINT download_workflows_recovery_mode_check
          CHECK (recovery_mode IN ('MANUAL','IDEMPOTENT_REPLAY'))`);
        await client.query(`ALTER TABLE download_jobs
          ADD COLUMN IF NOT EXISTS lease_owner TEXT,
          ADD COLUMN IF NOT EXISTS lease_token UUID,
          ADD COLUMN IF NOT EXISTS heartbeat_at TIMESTAMPTZ,
          ADD COLUMN IF NOT EXISTS lease_expires_at TIMESTAMPTZ`);
        await client.query(`UPDATE download_jobs SET request_body=request_body || jsonb_build_object('downloadJobId',id::text)
          WHERE status IN ('QUEUED','WAITING_RESOURCE','RUNNING')
            AND request_body->>'downloadJobId' IS DISTINCT FROM id::text`);
        await client.query(`UPDATE download_jobs j SET workflow_snapshot=j.workflow_snapshot || jsonb_build_object(
          'recoveryMode',COALESCE(w.recovery_mode,'MANUAL'))
          FROM download_workflows w WHERE w.code=j.workflow_code
            AND j.status IN ('QUEUED','WAITING_RESOURCE','RUNNING')
            AND NOT (j.workflow_snapshot ? 'recoveryMode')`);
        const legacyRunning = await client.query<SqlRow>(`SELECT j.*, p.product_name
          FROM download_jobs j JOIN products p ON p.sku=j.sku
          WHERE j.status='RUNNING' FOR UPDATE OF j`);
        const interruptedError = '迁移到租约模型时发现未受保护的旧 RUNNING 任务；请人工核验后重试。';
        const interruptedResult = {
          success: false,
          status: 'worker_interrupted_unconfirmed',
          errors: ['迁移到租约模型时发现未受保护的旧 RUNNING 任务；已安全停止，未自动重发。']
        };
        await client.query(`UPDATE download_jobs SET status='FAILED',
          result_json=$1::jsonb,
          error_message=$2,
          retry_reason='worker_interrupted_unconfirmed', next_attempt_at=NULL, finished_at=NOW()
          WHERE status='RUNNING'`, [JSON.stringify(interruptedResult), interruptedError]);
        for (const job of legacyRunning.rows) {
          await upsertFailureNotification(client, job, interruptedResult, interruptedError);
        }
        for (const batchId of new Set(legacyRunning.rows.map((job) => String(job.batch_id || '')).filter(Boolean))) {
          await finalizeBatchIfComplete(client, batchId);
        }
        await client.query(`CREATE INDEX IF NOT EXISTS download_jobs_running_lease_due
          ON download_jobs(lease_expires_at,queue_sequence) WHERE status='RUNNING'`);
        await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS download_jobs_one_global_running
          ON download_jobs ((1)) WHERE status='RUNNING'`);
        await client.query(`ALTER TABLE download_jobs DROP CONSTRAINT IF EXISTS download_jobs_running_lease_complete`);
        await client.query(`ALTER TABLE download_jobs ADD CONSTRAINT download_jobs_running_lease_complete CHECK (
          status<>'RUNNING' OR (lease_owner IS NOT NULL AND lease_token IS NOT NULL AND heartbeat_at IS NOT NULL AND lease_expires_at IS NOT NULL)
        )`);
        await client.query(`INSERT INTO purchase_schema_migrations(id) VALUES('013_download_job_leases')`);
      });
    }
    const localImports = await this.query<{ id: string }>('SELECT id FROM purchase_schema_migrations WHERE id=$1', ['014_local_imports']);
    if (!localImports.rows[0]) {
      await this.transaction(async (client) => {
        await client.query(`CREATE TABLE IF NOT EXISTS local_imports(
          id UUID PRIMARY KEY,idempotency_key TEXT NOT NULL UNIQUE,sku CHAR(7) REFERENCES products(sku) ON DELETE RESTRICT,
          duplicate_sku CHAR(7) REFERENCES products(sku) ON DELETE RESTRICT,
          status TEXT NOT NULL CHECK(status IN('COPYING','IMPORTED','SKIPPED_DUPLICATE','COPY_FAILED_RETRYABLE')),
          source_config_snapshot JSONB NOT NULL,target_config_snapshot JSONB NOT NULL,preview_hash CHAR(64) NOT NULL,
          retry_count INTEGER NOT NULL DEFAULT 0 CHECK(retry_count>=0),error_code TEXT,error_message TEXT,target_folder TEXT,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),completed_at TIMESTAMPTZ,
          CHECK((status='SKIPPED_DUPLICATE' AND sku IS NULL AND duplicate_sku IS NOT NULL) OR (status<>'SKIPPED_DUPLICATE' AND sku IS NOT NULL AND duplicate_sku IS NULL))
        )`);
        await client.query(`CREATE TABLE IF NOT EXISTS product_media_sources(
          id UUID PRIMARY KEY,local_import_id UUID NOT NULL REFERENCES local_imports(id) ON DELETE CASCADE,
          sku CHAR(7) NOT NULL REFERENCES products(sku) ON DELETE CASCADE,platform TEXT NOT NULL,relative_path TEXT NOT NULL,
          normalized_path_key TEXT NOT NULL,is_primary BOOLEAN NOT NULL DEFAULT false,external_sku TEXT,
          information_file_relative_path TEXT,information_file_sha256 CHAR(64),provider_url TEXT,target_subdirectory TEXT NOT NULL,
          copy_manifest JSONB NOT NULL,created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          UNIQUE(local_import_id,normalized_path_key)
        )`);
        await client.query('CREATE INDEX IF NOT EXISTS local_imports_sku ON local_imports(sku,created_at DESC)');
        await client.query('CREATE INDEX IF NOT EXISTS product_media_sources_sku ON product_media_sources(sku,created_at)');
        await client.query(`INSERT INTO purchase_schema_migrations(id) VALUES('014_local_imports')`);
      });
    }
    const localImportQuery = await this.query<{ id: string }>('SELECT id FROM purchase_schema_migrations WHERE id=$1', ['015_local_import_query']);
    if (!localImportQuery.rows[0]) {
      await this.transaction(async (client) => {
        await client.query('ALTER TABLE local_imports ADD COLUMN IF NOT EXISTS source_platform TEXT');
        await client.query('ALTER TABLE local_imports ADD COLUMN IF NOT EXISTS import_workflow_label TEXT');
        await client.query(`UPDATE local_imports li SET source_platform=source.platform
          FROM (
            SELECT DISTINCT ON (local_import_id) local_import_id,platform
            FROM product_media_sources
            ORDER BY local_import_id,is_primary DESC,created_at,id
          ) source
          WHERE source.local_import_id=li.id AND (li.source_platform IS NULL OR BTRIM(li.source_platform)='')`);
        await client.query(`UPDATE local_imports SET import_workflow_label='本地导入-' || source_platform
          WHERE source_platform IS NOT NULL AND BTRIM(source_platform)<>''
            AND (import_workflow_label IS NULL OR BTRIM(import_workflow_label)='')`);
        await client.query('CREATE INDEX IF NOT EXISTS local_imports_platform_created ON local_imports(source_platform,created_at DESC,id DESC)');
        await client.query('CREATE INDEX IF NOT EXISTS local_imports_status_created ON local_imports(status,created_at DESC,id DESC)');
        await client.query('CREATE INDEX IF NOT EXISTS local_imports_created ON local_imports(created_at DESC,id DESC)');
        await client.query(`INSERT INTO purchase_schema_migrations(id) VALUES('015_local_import_query')`);
      });
    }
    const procurementRetailPrice = await this.query<{ id: string }>('SELECT id FROM purchase_schema_migrations WHERE id=$1', ['016_procurement_retail_price']);
    if (!procurementRetailPrice.rows[0]) {
      await this.transaction(async (client) => {
        await client.query('ALTER TABLE procurement_versions ADD COLUMN IF NOT EXISTS retail_price NUMERIC(14,4)');
        await client.query('ALTER TABLE procurement_versions DROP CONSTRAINT IF EXISTS procurement_versions_retail_price_nonnegative');
        await client.query(`ALTER TABLE procurement_versions ADD CONSTRAINT procurement_versions_retail_price_nonnegative
          CHECK (retail_price IS NULL OR retail_price >= 0)`);
        await client.query(`INSERT INTO purchase_schema_migrations(id) VALUES('016_procurement_retail_price')`);
      });
    }
    const productEntryOrigins = await this.query<{ id: string }>('SELECT id FROM purchase_schema_migrations WHERE id=$1', ['017_product_entry_origins']);
    if (!productEntryOrigins.rows[0]) {
      await this.transaction(async (client) => {
        await client.query(`CREATE TABLE IF NOT EXISTS product_entry_origins(
          sku CHAR(7) PRIMARY KEY REFERENCES products(sku) ON DELETE CASCADE,
          method_key TEXT NOT NULL,method_label TEXT NOT NULL,platform TEXT,workflow_code TEXT,
          source_type TEXT NOT NULL CHECK(source_type IN('LOCAL_IMPORT','URL_DOWNLOAD','OTHER')),
          source_id TEXT,recorded_at TIMESTAMPTZ NOT NULL,created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          CHECK(LENGTH(BTRIM(method_key))>0),CHECK(LENGTH(BTRIM(method_label))>0)
        )`);
        await client.query(`INSERT INTO product_entry_origins(
          sku,method_key,method_label,platform,workflow_code,source_type,source_id,recorded_at
        )
        SELECT p.sku,
          'LOCAL_IMAGE_IMPORT:' || COALESCE(NULLIF(REGEXP_REPLACE(UPPER(BTRIM(li.source_platform)),'[[:space:]]+','_','g'),''),'UNKNOWN'),
          CASE WHEN NULLIF(BTRIM(li.source_platform),'') IS NULL THEN '本地图片导入-未知平台' ELSE '本地图片导入-' || BTRIM(li.source_platform) END,
          NULLIF(BTRIM(li.source_platform),''),NULL,'LOCAL_IMPORT',li.id::text,p.created_at
        FROM products p
        JOIN LATERAL (
          SELECT id,source_platform FROM local_imports WHERE sku=p.sku ORDER BY created_at ASC,id ASC LIMIT 1
        ) li ON true
        ON CONFLICT(sku) DO NOTHING`);
        await client.query(`INSERT INTO product_entry_origins(
          sku,method_key,method_label,platform,workflow_code,source_type,source_id,recorded_at
        )
        SELECT p.sku,
          CASE WHEN pv.download_workflow_code IS NULL THEN 'OTHER:LEGACY' ELSE 'URL_DOWNLOAD:' || UPPER(BTRIM(pv.download_workflow_code)) END,
          CASE
            WHEN pv.download_workflow_code='E006' THEN 'PDD下载E006'
            WHEN pv.download_workflow_code='E007' THEN '1688下载E007'
            WHEN pv.download_workflow_code IS NULL THEN '其它方式'
            WHEN POSITION(pv.download_workflow_code IN COALESCE(w.display_name,''))>0 THEN BTRIM(w.display_name)
            ELSE COALESCE(NULLIF(BTRIM(w.display_name),''),'产品URL下载') || pv.download_workflow_code
          END,
          CASE WHEN pv.download_workflow_code='E006' THEN 'PDD' WHEN pv.download_workflow_code='E007' THEN '1688' ELSE NULL END,
          pv.download_workflow_code,CASE WHEN pv.download_workflow_code IS NULL THEN 'OTHER' ELSE 'URL_DOWNLOAD' END,
          pv.id::text,p.created_at
        FROM products p
        LEFT JOIN LATERAL (
          SELECT id,download_workflow_code FROM procurement_versions WHERE sku=p.sku ORDER BY version_no ASC LIMIT 1
        ) pv ON true
        LEFT JOIN download_workflows w ON w.code=pv.download_workflow_code
        WHERE NOT EXISTS(SELECT 1 FROM product_entry_origins origin WHERE origin.sku=p.sku)
        ON CONFLICT(sku) DO NOTHING`);
        await client.query('CREATE INDEX IF NOT EXISTS product_entry_origins_method_recorded ON product_entry_origins(method_key,recorded_at DESC,sku DESC)');
        await client.query('CREATE INDEX IF NOT EXISTS product_entry_origins_source ON product_entry_origins(source_type,source_id)');
        await client.query(`INSERT INTO purchase_schema_migrations(id) VALUES('017_product_entry_origins')`);
      });
    }
  }

  private async seedDefaultWorkflow(input: WorkflowInput) {
    validateWorkflow(input);
    await assertSafeDownloadRoot(input.parentOutputDir);
    await this.query(`INSERT INTO download_workflows (code, display_name, webhook_url, parent_output_dir, timeout_ms, enabled, is_default, recovery_mode)
      VALUES ($1,$2,$3,$4,$5,true,true,$6) ON CONFLICT (code) DO NOTHING`, [input.code, input.displayName, input.webhookUrl, input.parentOutputDir, input.timeoutMs || 900_000, input.recoveryMode || 'MANUAL']);
    await this.backfillMissingPurchaseWorkflows();
  }

  private async backfillMissingPurchaseWorkflows() {
    await this.query(`UPDATE procurement_versions SET download_workflow_code = COALESCE(
      (SELECT code FROM download_workflows WHERE code='E006' LIMIT 1),
      (SELECT code FROM download_workflows WHERE enabled=true AND is_default=true ORDER BY code LIMIT 1)
    ) WHERE download_workflow_code IS NULL
      AND NOT EXISTS(SELECT 1 FROM local_imports li WHERE li.sku=procurement_versions.sku)`);
  }
}

async function lockDownloadEnqueue(client: PoolClient) {
  await lockDownloadProjection(client);
}

async function getLocalImportWithClient(client: Pick<PoolClient, 'query'>, id: string): Promise<LocalImportRecord> {
  const result = await client.query<SqlRow>(`SELECT li.id,li.idempotency_key,li.sku,li.duplicate_sku,li.status,
    li.source_platform,li.import_workflow_label,li.source_config_snapshot,li.target_config_snapshot,li.preview_hash,
    li.retry_count,li.error_code,li.error_message,li.target_folder,li.created_at AS import_created_at,
    li.updated_at AS import_updated_at,li.completed_at,
    p.sku AS product_sku,p.product_name,p.created_at AS product_created_at,p.updated_at AS product_updated_at,
    COALESCE((SELECT jsonb_agg(v.name ORDER BY v.sort_order,v.created_at) FROM product_variants v WHERE v.sku=p.sku),'[]'::jsonb) AS variants,
    pv.id AS procurement_version_id,pv.version_no,pv.download_workflow_code,pv.purchase_price,pv.retail_price,pv.courier_fee,pv.currency,
    pv.gross_weight_g,pv.length_cm,pv.width_cm,pv.height_cm,pv.net_weight_g,pv.product_height_cm,pv.product_depth_cm,
    pv.product_width_cm,pv.transport_mode,pv.provider_url,pv.created_at AS procurement_created_at
    FROM local_imports li
    LEFT JOIN products p ON p.sku=COALESCE(li.sku,li.duplicate_sku)
    LEFT JOIN LATERAL (SELECT * FROM procurement_versions WHERE sku=p.sku ORDER BY version_no DESC LIMIT 1) pv ON true
    WHERE li.id=$1`, [id]);
  const row = result.rows[0];
  if (!row) throw new AppError('NOT_FOUND', '本地导入记录不存在', { id }, 404);
  const sources = row.sku ? await client.query<SqlRow>(`SELECT id,platform,relative_path,normalized_path_key,is_primary,
    external_sku,information_file_relative_path,information_file_sha256,provider_url,target_subdirectory,copy_manifest
    FROM product_media_sources WHERE local_import_id=$1 ORDER BY is_primary DESC,created_at,id`, [id]) : { rows: [] };
  return toLocalImportRecord(row, sources.rows.map((source) => ({
      id: source.id, platform: source.platform, relativePath: source.relative_path, normalizedPathKey: source.normalized_path_key,
      isPrimary: source.is_primary, externalSku: source.external_sku || undefined,
      informationFileRelativePath: source.information_file_relative_path || undefined,
      informationFileSha256: source.information_file_sha256 || undefined, providerUrl: source.provider_url || undefined,
      targetSubdirectory: source.target_subdirectory, copyManifest: source.copy_manifest
    })));
}

function toLocalImportRecord(row: SqlRow, sources: LocalImportRecord['sources']): LocalImportRecord {
  return {
    id: row.id, idempotencyKey: row.idempotency_key, sku: row.sku || undefined, duplicateSku: row.duplicate_sku || undefined,
    status: row.status, sourcePlatform: row.source_platform || undefined, importWorkflowLabel: row.import_workflow_label || undefined,
    sourceConfigSnapshot: row.source_config_snapshot, targetConfigSnapshot: row.target_config_snapshot,
    previewHash: row.preview_hash, retryCount: Number(row.retry_count), errorCode: row.error_code || undefined,
    errorMessage: row.error_message || undefined, targetFolder: row.target_folder || undefined,
    createdAt: new Date(row.import_created_at).toISOString(), updatedAt: new Date(row.import_updated_at).toISOString(),
    completedAt: row.completed_at ? new Date(row.completed_at).toISOString() : undefined,
    sources, purchase: row.product_sku ? toLocalImportPurchase(row) : undefined
  };
}

function toLocalImportListItem(row: SqlRow): LocalImportListItem {
  const item = toLocalImportRecord(row, []);
  Reflect.deleteProperty(item, 'sources');
  return { ...item, sourceDirectoryCount: Number(row.source_directory_count || 0) };
}

function toLocalImportPurchase(row: SqlRow) {
  return {
    sku: String(row.product_sku), productName: String(row.product_name), variants: Array.isArray(row.variants) ? row.variants : [],
    createdAt: new Date(row.product_created_at).toISOString(), updatedAt: new Date(row.product_updated_at).toISOString(),
    procurement: {
      id: row.procurement_version_id, versionNo: Number(row.version_no), downloadWorkflowCode: row.download_workflow_code || undefined,
      purchasePrice: row.purchase_price, retailPrice: row.retail_price, courierFee: row.courier_fee, currency: row.currency,
      grossWeightGrams: row.gross_weight_g, lengthCm: row.length_cm, widthCm: row.width_cm, heightCm: row.height_cm,
      netWeightGrams: row.net_weight_g, productHeightCm: row.product_height_cm, productDepthCm: row.product_depth_cm,
      productWidthCm: row.product_width_cm, transportMode: row.transport_mode, providerUrl: row.provider_url,
      createdAt: row.procurement_created_at ? new Date(row.procurement_created_at).toISOString() : undefined
    }
  };
}

async function lockDownloadProjection(client: PoolClient) {
  await client.query(`SELECT pg_advisory_xact_lock(hashtext('pixroute_download_config_projection'))`);
}

function validateWorkflowSet(inputs: WorkflowInput[]): void {
  for (const input of inputs) validateWorkflow(input);
  const enabled = inputs.filter((input) => input.enabled !== false);
  if (enabled.length && enabled.filter((input) => input.isDefault).length !== 1) {
    throw new AppError('CONFIG_INVALID', '启用下载工作流时必须且只能设置一个默认下载工作流', undefined, 409);
  }
}

async function assertSafeWorkflowSet(inputs: WorkflowInput[]): Promise<void> {
  await Promise.all(inputs.map((input) => assertSafeDownloadRoot(input.parentOutputDir)));
}

async function writeWorkflowProjection(client: PoolClient, inputs: WorkflowInput[]): Promise<void> {
  await client.query('UPDATE download_workflows SET enabled = false, is_default = false, updated_at = NOW()');
  for (const input of inputs) {
    await client.query(`INSERT INTO download_workflows (code, display_name, webhook_url, parent_output_dir, timeout_ms, enabled, is_default, recovery_mode)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
      ON CONFLICT (code) DO UPDATE SET display_name = EXCLUDED.display_name, webhook_url = EXCLUDED.webhook_url,
        parent_output_dir = EXCLUDED.parent_output_dir, timeout_ms = EXCLUDED.timeout_ms, enabled = EXCLUDED.enabled,
        is_default = EXCLUDED.is_default, recovery_mode = EXCLUDED.recovery_mode, updated_at = NOW()`, [
      input.code.trim().toUpperCase(), input.displayName.trim(), input.webhookUrl.trim(), input.parentOutputDir.trim(),
      input.timeoutMs || 900_000, input.enabled ?? true, input.isDefault ?? false, input.recoveryMode || 'MANUAL'
    ]);
  }
}

async function backfillMissingPurchaseWorkflowsWithClient(client: PoolClient): Promise<void> {
  await client.query(`UPDATE procurement_versions SET download_workflow_code = COALESCE(
    (SELECT code FROM download_workflows WHERE code='E006' LIMIT 1),
    (SELECT code FROM download_workflows WHERE enabled=true AND is_default=true ORDER BY code LIMIT 1)
  ) WHERE download_workflow_code IS NULL
    AND NOT EXISTS(SELECT 1 FROM local_imports li WHERE li.sku=procurement_versions.sku)`);
}

async function assertWorkflowProjection(client: PoolClient, inputs: WorkflowInput[]): Promise<void> {
  const result = await client.query<SqlRow>(`SELECT code,display_name,webhook_url,parent_output_dir,timeout_ms,enabled,is_default,recovery_mode
    FROM download_workflows ORDER BY code FOR UPDATE`);
  const expectedCodes = new Set(inputs.map((input) => input.code.trim().toUpperCase()));
  const rows = new Map(result.rows.map((row) => [String(row.code), row]));
  const mismatches: Array<Record<string, unknown>> = [];
  for (const input of inputs) {
    const code = input.code.trim().toUpperCase();
    const row = rows.get(code);
    if (!row || !workflowProjectionMatches(row, input)) {
      mismatches.push({ code, expectedParentOutputDir: input.parentOutputDir, actualParentOutputDir: row?.parent_output_dir || null });
    }
  }
  for (const row of result.rows) {
    if (!expectedCodes.has(String(row.code)) && (row.enabled === true || row.is_default === true)) {
      mismatches.push({ code: row.code, reason: 'unexpected_active_workflow' });
    }
  }
  if (mismatches.length) {
    throw new AppError('DOWNLOAD_CONFIG_OUT_OF_SYNC', '下载工作流数据库投影与系统设置不一致', { mismatches }, 503);
  }
}

async function prepareWorkflowProjection(client: PoolClient, inputs?: WorkflowInput[]): Promise<void> {
  if (!inputs) return;
  await lockDownloadProjection(client);
  try {
    await assertWorkflowProjection(client, inputs);
  } catch (error) {
    if (!(error instanceof AppError) || error.code !== 'DOWNLOAD_CONFIG_OUT_OF_SYNC') throw error;
    await writeWorkflowProjection(client, inputs);
    await assertWorkflowProjection(client, inputs);
  }
}

function workflowProjectionMatches(row: SqlRow, input: WorkflowInput): boolean {
  return String(row.code) === input.code.trim().toUpperCase()
    && String(row.display_name) === input.displayName.trim()
    && String(row.webhook_url) === input.webhookUrl.trim()
    && workflowPathKey(String(row.parent_output_dir)) === workflowPathKey(input.parentOutputDir)
    && Number(row.timeout_ms) === Number(input.timeoutMs || 900_000)
    && Boolean(row.enabled) === (input.enabled ?? true)
    && Boolean(row.is_default) === (input.isDefault ?? false)
    && String(row.recovery_mode || 'MANUAL') === (input.recoveryMode || 'MANUAL');
}

function workflowPathKey(value: string): string {
  const normalized = String(value || '').trim().replaceAll('\\', '/').replace(/\/+$/, '');
  return /^[A-Za-z]:\//.test(normalized) ? normalized.toLocaleLowerCase('en-US') : normalized;
}

async function lockPurchaseUrlRegistry(client: PoolClient) {
  await client.query(`SELECT pg_advisory_xact_lock(hashtext('merchroute_purchase_url_registry'))`);
}

async function assertPurchaseUrlAvailable(client: PoolClient, providerUrl: string, currentSku?: string) {
  const providerUrlKey = normalizeProviderUrlKey(providerUrl);
  const existing = await client.query<{ sku: string }>('SELECT sku FROM purchase_provider_urls WHERE provider_url_key=$1', [providerUrlKey]);
  const existingSku = existing.rows[0]?.sku;
  if (existingSku && existingSku !== currentSku) {
    throw new AppError('PRODUCT_URL_ALREADY_EXISTS', '产品已经录入', { sku: existingSku, providerUrl: providerUrlKey }, 409);
  }
}

async function registerPurchaseUrl(client: PoolClient, providerUrl: string, sku: string) {
  await client.query(`INSERT INTO purchase_provider_urls(provider_url_key,sku)
    VALUES($1,$2) ON CONFLICT(provider_url_key) DO NOTHING`, [normalizeProviderUrlKey(providerUrl), sku]);
}

function validateBatchItems(items: DownloadBatchItemInput[]) {
  if (!Array.isArray(items) || items.length < 1 || items.length > 200) throw new AppError('CONFIG_INVALID', '批量下载任务数量必须在 1 到 200 条之间');
  const seen = new Set<string>();
  for (const item of items) {
    const sku = String(item?.sku || '').trim();
    const workflowCode = String(item?.workflowCode || '').trim().toUpperCase();
    if (!/^\d{7}$/.test(sku)) throw new AppError('CONFIG_INVALID', `SKU ${sku || '（空）'} 必须是 7 位数字`);
    if (!/^E\d{3}$/.test(workflowCode)) throw new AppError('CONFIG_INVALID', `工作流代码 ${workflowCode || '（空）'} 格式无效`);
    if (seen.has(sku)) throw new AppError('CONFIG_INVALID', `批量任务中存在重复 SKU：${sku}`);
    seen.add(sku);
    item.sku = sku;
    item.workflowCode = workflowCode;
  }
}

function normalizeNotificationDate(value: string, label: string) {
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) throw new AppError('CONFIG_INVALID', `${label}格式无效`);
  return parsed.toISOString();
}

function normalizePurchaseDate(value: string, label: string) {
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) throw new AppError('CONFIG_INVALID', `${label}格式无效`);
  return parsed.toISOString();
}

function normalizeNotificationUpsert(input: TaskNotificationUpsertInput): Required<Omit<TaskNotificationUpsertInput, 'sku' | 'productName' | 'workflowCode'>> & {
  sku?: string; productName?: string; workflowCode?: string;
} {
  const normalized = {
    dedupeKey: requiredNotificationText(input.dedupeKey, 'dedupeKey', 512),
    category: requiredNotificationText(input.category, 'category', 128),
    eventType: requiredNotificationText(input.eventType, 'eventType', 128),
    severity: input.severity,
    title: requiredNotificationText(input.title, 'title', 500),
    message: requiredNotificationText(input.message, 'message', 5_000),
    sourceType: requiredNotificationText(input.sourceType, 'sourceType', 128),
    sourceId: requiredNotificationText(input.sourceId, 'sourceId', 512),
    sku: optionalNotificationText(input.sku, 'sku', 7),
    productName: optionalNotificationText(input.productName, 'productName', 500),
    workflowCode: optionalNotificationText(input.workflowCode, 'workflowCode', 128),
    details: normalizeNotificationDetails(input.details)
  };
  if (!['INFO', 'SUCCESS', 'WARNING', 'ERROR'].includes(normalized.severity)) {
    throw new AppError('CONFIG_INVALID', '通知 severity 必须是 INFO、SUCCESS、WARNING 或 ERROR');
  }
  if (normalized.sku && !/^\d{7}$/.test(normalized.sku)) {
    throw new AppError('CONFIG_INVALID', '通知 SKU 必须是 7 位数字字符串');
  }
  return normalized;
}

function normalizeNotificationResolve(input: TaskNotificationResolveInput): {
  dedupeKey?: string; sourceType?: string; sourceId?: string; eventType?: string; details: JsonRecord;
} {
  const dedupeKey = optionalNotificationText(input.dedupeKey, 'dedupeKey', 512);
  const sourceType = optionalNotificationText(input.sourceType, 'sourceType', 128);
  const sourceId = optionalNotificationText(input.sourceId, 'sourceId', 512);
  const eventType = optionalNotificationText(input.eventType, 'eventType', 128);
  if (!dedupeKey && (!sourceType || !sourceId)) {
    throw new AppError('CONFIG_INVALID', '解决通知时必须提供 dedupeKey，或同时提供 sourceType 和 sourceId');
  }
  return { dedupeKey, sourceType, sourceId, eventType, details: normalizeNotificationDetails(input.details) };
}

function requiredNotificationText(value: unknown, field: string, maxLength: number): string {
  const normalized = String(value ?? '').trim();
  if (!normalized || normalized.length > maxLength) {
    throw new AppError('CONFIG_INVALID', `通知 ${field} 长度必须在 1 到 ${maxLength} 个字符之间`);
  }
  return normalized;
}

function optionalNotificationText(value: unknown, field: string, maxLength: number): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  return requiredNotificationText(value, field, maxLength);
}

function normalizeNotificationDetails(value: unknown): JsonRecord {
  if (value === undefined) return {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new AppError('CONFIG_INVALID', '通知 details 必须是 JSON 对象');
  }
  try {
    return JSON.parse(JSON.stringify(value)) as JsonRecord;
  } catch {
    throw new AppError('CONFIG_INVALID', '通知 details 必须可以序列化为 JSON');
  }
}

function normalizeProductDirectory(value: string): string {
  return String(value || '').trim().replaceAll('\\', '/').replace(/\/+$/, '');
}

async function insertDownloadJob(client: PoolClient, sku: string, requestedWorkflowCode: string | undefined, options: {
  strict: boolean; batchId?: string; batchPosition?: number; notificationThreadId?: string;
}, expectedWorkflows?: WorkflowInput[]) {
  const normalizedSku = String(sku || '').trim();
  const workflowCode = requestedWorkflowCode?.trim().toUpperCase() || null;
  const expectedWorkflow = expectedWorkflows
    ? workflowCode
      ? expectedWorkflows.find((input) => input.code.trim().toUpperCase() === workflowCode && input.enabled !== false)
      : expectedWorkflows.find((input) => input.enabled !== false && input.isDefault)
    : undefined;
  if (expectedWorkflows && !expectedWorkflow) {
    throw new AppError('DOWNLOAD_WORKFLOW_UNAVAILABLE', '产品或下载工作流不存在、已停用', { sku: normalizedSku, workflowCode }, options.strict ? 404 : 409);
  }
  const expectedPathKey = expectedWorkflow ? workflowPathKey(expectedWorkflow.parentOutputDir) : null;
  const expectedWindowsPath = expectedWorkflow
    ? /^(?:[A-Za-z]:[\\/]|[\\/]{2}[^\\/]+[\\/][^\\/]+)/.test(expectedWorkflow.parentOutputDir.trim())
    : false;
  const existing = await client.query<{ id: string }>(`SELECT id FROM download_jobs WHERE sku = $1 AND status IN ('QUEUED','WAITING_RESOURCE','RUNNING') LIMIT 1 FOR UPDATE`, [normalizedSku]);
  if (existing.rows[0]) throw new AppError('DOWNLOAD_ALREADY_QUEUED', '该产品已有正在排队或下载中的任务', { jobId: existing.rows[0].id, sku: normalizedSku }, 409);
  const context = await client.query<SqlRow>(`
    SELECT p.sku, p.product_name, pv.id AS procurement_version_id, pv.provider_url,
      w.code, w.display_name, w.webhook_url, w.parent_output_dir, w.timeout_ms, w.recovery_mode
    FROM products p
    JOIN LATERAL (SELECT * FROM procurement_versions WHERE sku = p.sku ORDER BY version_no DESC LIMIT 1) pv ON true
    JOIN download_workflows w ON w.code = COALESCE($2, (SELECT code FROM download_workflows WHERE enabled = true AND is_default = true LIMIT 1))
      AND ($3::text IS NULL OR CASE WHEN $4::boolean
        THEN LOWER(TRIM(TRAILING '/' FROM REPLACE(w.parent_output_dir, CHR(92), '/'))) = $3
        ELSE TRIM(TRAILING '/' FROM w.parent_output_dir) = $3 END)
    WHERE p.sku = $1 AND w.enabled = true
    FOR UPDATE OF w`, [normalizedSku, workflowCode, expectedPathKey, expectedWindowsPath]);
  const row = context.rows[0];
  if (!row) {
    if (expectedWorkflow) {
      const product = await client.query<{ exists: boolean }>('SELECT EXISTS(SELECT 1 FROM products WHERE sku=$1) AS exists', [normalizedSku]);
      if (product.rows[0]?.exists) {
        throw new AppError('DOWNLOAD_CONFIG_OUT_OF_SYNC', '下载工作流数据库投影在入队时发生变化', {
          sku: normalizedSku,
          workflowCode: expectedWorkflow.code,
          expectedParentOutputDir: expectedWorkflow.parentOutputDir
        }, 503);
      }
    }
    throw new AppError('DOWNLOAD_WORKFLOW_UNAVAILABLE', '产品或下载工作流不存在、已停用', { sku: normalizedSku, workflowCode }, options.strict ? 404 : 409);
  }
  const jobId = randomUUID();
  const requestBody: DownloadWebhookRequest = { downloadJobId: jobId, productName: row.product_name, SKU: row.sku, productUrl: row.provider_url, parentOutputDir: row.parent_output_dir };
  const workflowSnapshot = {
    code: row.code,
    displayName: row.display_name,
    webhookUrl: row.webhook_url,
    parentOutputDir: row.parent_output_dir,
    timeoutMs: row.timeout_ms,
    recoveryMode: row.recovery_mode || 'MANUAL'
  };
  await client.query(`INSERT INTO download_jobs (
    id, sku, procurement_version_id, workflow_code, workflow_snapshot, request_body, batch_id, batch_position, notification_thread_id
  ) VALUES ($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7,$8,$9)`, [
    jobId, normalizedSku, row.procurement_version_id, row.code, JSON.stringify(workflowSnapshot), JSON.stringify(requestBody),
    options.batchId || null, options.batchPosition || null, options.notificationThreadId || null
  ]);
  return jobId;
}

async function upsertFailureNotification(client: PoolClient, job: SqlRow, result: JsonRecord, errorMessage: string) {
  const now = new Date().toISOString();
  const execution = {
    jobId: job.id, status: 'FAILED', errorMessage, failureCode: typeof result.status === 'string' ? result.status : 'WORKFLOW_ERROR',
    n8nExecutionId: typeof result.n8nExecutionId === 'string' ? result.n8nExecutionId : '', finishedAt: now
  };
  const baseDetails = {
    jobId: job.id, batchId: job.batch_id || null, sku: job.sku, productName: job.product_name, workflowCode: job.workflow_code,
    productUrl: job.request_body?.productUrl || '', parentOutputDir: job.request_body?.parentOutputDir || '', outputDir: result.outputDir || job.output_dir || '',
    failureCode: execution.failureCode, errorMessage, warnings: Array.isArray(result.warnings) ? result.warnings : [],
    n8nExecutionId: execution.n8nExecutionId, startedAt: job.started_at, finishedAt: now, retryHistory: [execution]
  };
  if (job.notification_thread_id) {
    const current = await client.query<SqlRow>('SELECT details FROM task_notifications WHERE id = $1 FOR UPDATE', [job.notification_thread_id]);
    const details = asRecord(current.rows[0]?.details);
    const retryHistory = Array.isArray(details.retryHistory) ? [...details.retryHistory, execution] : [execution];
    await client.query(`UPDATE task_notifications SET title = $2, message = $3, details = $4::jsonb, read_at = NULL, resolved_at = NULL, updated_at = NOW() WHERE id = $1`, [
      job.notification_thread_id, `下载失败 · ${job.sku} · ${job.workflow_code}`, errorMessage,
      JSON.stringify({ ...details, ...baseDetails, retryHistory })
    ]);
    return;
  }
  const notificationId = randomUUID();
  await client.query(`INSERT INTO task_notifications (
    id, dedupe_key, category, event_type, severity, title, message, source_type, source_id, batch_id, sku, product_name, workflow_code, details
  ) VALUES ($1,$2,'DOWNLOAD','DOWNLOAD_JOB_FAILED','ERROR',$3,$4,'DOWNLOAD_JOB',$5,$6,$7,$8,$9,$10::jsonb)
  ON CONFLICT (dedupe_key) DO NOTHING`, [
    notificationId, `DOWNLOAD_JOB_FAILED:${job.id}`, `下载失败 · ${job.sku} · ${job.workflow_code}`, errorMessage,
    job.id, job.batch_id || null, job.sku, job.product_name, job.workflow_code, JSON.stringify(baseDetails)
  ]);
  const created = await client.query<{ id: string }>('SELECT id FROM task_notifications WHERE dedupe_key = $1', [`DOWNLOAD_JOB_FAILED:${job.id}`]);
  if (created.rows[0]) await client.query('UPDATE download_jobs SET notification_thread_id = $2 WHERE id = $1', [job.id, created.rows[0].id]);
}

async function resolveRetryNotification(client: PoolClient, notificationId: string, job: SqlRow, result: JsonRecord) {
  const current = await client.query<SqlRow>('SELECT details FROM task_notifications WHERE id = $1 FOR UPDATE', [notificationId]);
  if (!current.rows[0]) return;
  const details = asRecord(current.rows[0].details);
  const retryHistory = Array.isArray(details.retryHistory) ? [...details.retryHistory] : [];
  retryHistory.push({ jobId: job.id, status: 'SUCCEEDED', outputDir: result.outputDir || '', n8nExecutionId: result.n8nExecutionId || '', finishedAt: new Date().toISOString() });
  await client.query(`UPDATE task_notifications SET details = $2::jsonb, read_at = COALESCE(read_at, NOW()), resolved_at = NOW(), updated_at = NOW() WHERE id = $1`, [
    notificationId, JSON.stringify({ ...details, retryHistory, resolvedByJobId: job.id, resolvedOutputDir: result.outputDir || '' })
  ]);
}

async function finalizeBatchIfComplete(client: PoolClient, batchId: string) {
  const batchResult = await client.query<SqlRow>('SELECT * FROM download_batches WHERE id = $1 FOR UPDATE', [batchId]);
  const batch = batchResult.rows[0];
  if (!batch || batch.finished_at) return;
  const countsResult = await client.query<SqlRow>(`SELECT
    COUNT(*) FILTER (WHERE status = 'QUEUED')::text AS queued,
    COUNT(*) FILTER (WHERE status = 'WAITING_RESOURCE')::text AS waiting_resource,
    COUNT(*) FILTER (WHERE status = 'RUNNING')::text AS running,
    COUNT(*) FILTER (WHERE status = 'SUCCEEDED')::text AS succeeded,
    COUNT(*) FILTER (WHERE status = 'FAILED')::text AS failed
    FROM download_jobs WHERE batch_id = $1`, [batchId]);
  const counts = countsResult.rows[0];
  if (!counts) return;
  if (Number(counts.queued || 0) + Number(counts.waiting_resource || 0) + Number(counts.running || 0) > 0) return;
  await client.query('UPDATE download_batches SET finished_at = NOW() WHERE id = $1', [batchId]);
  const succeeded = Number(counts.succeeded || 0);
  const failed = Number(counts.failed || 0);
  const skipped = Number(batch.skipped_count || 0);
  const severity = failed > 0 || skipped > 0 ? 'WARNING' : 'SUCCESS';
  const title = severity === 'SUCCESS' ? `批量下载已完成 · ${succeeded} 条成功` : `批量下载已结束 · ${failed} 条失败`;
  const message = `成功 ${succeeded} 条，失败 ${failed} 条，跳过 ${skipped} 条`;
  await client.query(`INSERT INTO task_notifications (
    id, dedupe_key, category, event_type, severity, title, message, source_type, source_id, batch_id, details
  ) VALUES ($1,$2,'DOWNLOAD','DOWNLOAD_BATCH_COMPLETED',$3,$4,$5,'DOWNLOAD_BATCH',$6,$7,$8::jsonb)
  ON CONFLICT (dedupe_key) DO NOTHING`, [
    randomUUID(), `DOWNLOAD_BATCH_COMPLETED:${batchId}`, severity, title, message, batchId, batchId,
    JSON.stringify({ batchId, totalRequested: Number(batch.total_requested), queuedCount: Number(batch.queued_count), skippedCount: skipped, succeeded, failed, skippedItems: batch.skipped_items || [] })
  ]);
}

function asRecord(value: unknown): JsonRecord { return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : {}; }

async function insertProcurementVersion(client: PoolClient, sku: string, input: PurchaseInput, versionNo: number, downloadWorkflowCode: string | null) {
  const id = randomUUID();
  await client.query(`INSERT INTO procurement_versions (
    id, sku, version_no, download_workflow_code, purchase_price, retail_price, courier_fee, currency,
    gross_weight_g, length_cm, width_cm, height_cm,
    net_weight_g, product_height_cm, product_depth_cm, product_width_cm,
    transport_mode, provider_url
  ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)`, [
    id, sku, versionNo, downloadWorkflowCode, input.purchasePrice.trim(), nullableDecimal(input.retailPrice),
    (input.courierFee || '0').trim(), (input.currency || 'CNY').trim().toUpperCase(),
    nullableDecimal(input.grossWeightGrams), nullableDecimal(input.lengthCm), nullableDecimal(input.widthCm), nullableDecimal(input.heightCm),
    nullableDecimal(input.netWeightGrams), nullableDecimal(input.productHeightCm), nullableDecimal(input.productDepthCm), nullableDecimal(input.productWidthCm),
    input.transportMode?.trim() || null, input.providerUrl.trim()
  ]);
  return id;
}

async function insertUrlDownloadEntryOrigin(client: PoolClient, sku: string, workflowCode: string, sourceId: string) {
  const workflow = await client.query<{ display_name: string }>('SELECT display_name FROM download_workflows WHERE code=$1', [workflowCode]);
  const metadata = urlDownloadEntryOriginMetadata(workflowCode, workflow.rows[0]?.display_name);
  await insertProductEntryOrigin(client, {
    sku, methodKey: `URL_DOWNLOAD:${workflowCode.toLocaleUpperCase('en-US')}`, methodLabel: metadata.label,
    platform: metadata.platform, workflowCode, sourceType: 'URL_DOWNLOAD', sourceId
  });
}

async function insertLocalImportEntryOrigin(client: PoolClient, sku: string, platform: string, sourceId: string) {
  const normalizedPlatform = platform.trim();
  await insertProductEntryOrigin(client, {
    sku, methodKey: `LOCAL_IMAGE_IMPORT:${entryOriginKeySegment(normalizedPlatform)}`,
    methodLabel: `本地图片导入-${normalizedPlatform || '未知平台'}`, platform: normalizedPlatform || undefined,
    sourceType: 'LOCAL_IMPORT', sourceId
  });
}

async function insertProductEntryOrigin(client: PoolClient, input: {
  sku: string;
  methodKey: string;
  methodLabel: string;
  platform?: string;
  workflowCode?: string;
  sourceType: PurchaseEntryOriginSourceType;
  sourceId?: string;
}) {
  await client.query(`INSERT INTO product_entry_origins(
    sku,method_key,method_label,platform,workflow_code,source_type,source_id,recorded_at
  ) SELECT $1,$2,$3,$4,$5,$6,$7,p.created_at FROM products p WHERE p.sku=$1
  ON CONFLICT(sku) DO NOTHING`, [
    input.sku, input.methodKey, input.methodLabel, input.platform || null, input.workflowCode || null,
    input.sourceType, input.sourceId || null
  ]);
}

function urlDownloadEntryOriginMetadata(workflowCode: string, displayName?: string) {
  if (workflowCode === 'E006') return { label: 'PDD下载E006', platform: 'PDD' };
  if (workflowCode === 'E007') return { label: '1688下载E007', platform: '1688' };
  const name = String(displayName || '').trim() || '产品URL下载';
  return { label: name.includes(workflowCode) ? name : `${name}${workflowCode}`, platform: undefined };
}

function entryOriginKeySegment(value: string) {
  return value.trim().toLocaleUpperCase('en-US').replace(/\s+/g, '_') || 'UNKNOWN';
}

function validatePurchase(input: PurchaseInput) {
  if (!input.productName?.trim()) throw new AppError('CONFIG_INVALID', '产品名称不能为空');
  if (input.downloadWorkflowCode !== undefined && !/^E\d{3}$/.test(input.downloadWorkflowCode.trim().toUpperCase())) throw new AppError('CONFIG_INVALID', '下载工作流代码格式无效');
  if (!isDecimal(input.purchasePrice)) throw new AppError('CONFIG_INVALID', '采购价必须是有效数字');
  if (input.retailPrice != null && input.retailPrice !== '' && !isDecimal(input.retailPrice)) throw new AppError('CONFIG_INVALID', '零售价格必须是有效数字');
  if (input.courierFee != null && input.courierFee !== '' && !isDecimal(input.courierFee)) throw new AppError('CONFIG_INVALID', '快递费必须是有效数字');
  for (const [field, value] of Object.entries({ grossWeightGrams: input.grossWeightGrams, lengthCm: input.lengthCm, widthCm: input.widthCm, heightCm: input.heightCm })) {
    if (value != null && value !== '' && (!isDecimal(value) || Number(value) < 0)) throw new AppError('CONFIG_INVALID', `${field} 必须是非负数字`);
  }
  for (const [field, value] of Object.entries({
    netWeightGrams: input.netWeightGrams,
    productHeightCm: input.productHeightCm,
    productDepthCm: input.productDepthCm,
    productWidthCm: input.productWidthCm
  })) {
    if (value != null && value !== '' && (!isDecimal(value) || Number(value) <= 0)) throw new AppError('CONFIG_INVALID', `${field} 必须是大于 0 的数字`);
  }
  if (!/^[A-Za-z]{3}$/.test(input.currency || 'CNY')) throw new AppError('CONFIG_INVALID', '币种必须是 3 位字母代码');
  try { new URL(input.providerUrl); } catch { throw new AppError('CONFIG_INVALID', '产品 URL 格式无效'); }
}

async function resolveActivePurchaseWorkflow(client: PoolClient, requestedCode?: string): Promise<string> {
  const workflowCode = requestedCode?.trim().toUpperCase();
  const workflow = await client.query<{ code: string }>(`SELECT code FROM download_workflows
    WHERE enabled=true AND code=COALESCE($1,(SELECT code FROM download_workflows WHERE enabled=true AND is_default=true ORDER BY code LIMIT 1))`, [workflowCode || null]);
  if (!workflow.rows[0]) throw new AppError('DOWNLOAD_WORKFLOW_UNAVAILABLE', '所选下载工作流不存在或已停用', { workflowCode: workflowCode || null }, 409);
  return workflow.rows[0].code;
}

function normalizeProviderUrlKey(value: string) { return value.trim(); }

export function validateProductVariantName(input: string): string {
  const value = String(input ?? '').trim().normalize('NFC');
  if (!value || value.length > 64) throw new AppError('CONFIG_INVALID', '变体名长度必须在 1 到 64 个字符之间');
  const containsControlCharacter = [...value].some((character) => character.charCodeAt(0) <= 31);
  if (value === '.' || value === '..' || /[<>:"/\\|?*]/.test(value) || containsControlCharacter || /[ .]$/.test(value)) {
    throw new AppError('CONFIG_INVALID', '变体名包含 Windows 路径不允许的字符或结尾');
  }
  return value;
}

export function normalizeProductVariantKey(input: string): string {
  return validateProductVariantName(input).toLocaleLowerCase('zh-CN');
}

function validateWorkflow(input: WorkflowInput) {
  if (!/^E\d{3}$/.test(input.code?.trim().toUpperCase())) throw new AppError('CONFIG_INVALID', '工作流代码必须是 E 加三位数字，例如 E006');
  if (!input.displayName?.trim()) throw new AppError('CONFIG_INVALID', '工作流显示名称不能为空');
  if (!isAbsolutePath(input.parentOutputDir)) throw new AppError('CONFIG_INVALID', '图片保存地址必须是绝对路径');
  let url: URL;
  try { url = new URL(input.webhookUrl); }
  catch { throw new AppError('CONFIG_INVALID', 'Webhook 地址格式无效'); }
  if (url.protocol !== 'http:' || !['localhost', '127.0.0.1', '::1', '[::1]'].includes(url.hostname)) throw new AppError('CONFIG_INVALID', 'Webhook 地址必须是本机 loopback HTTP 地址');
  if ((input.timeoutMs ?? 900_000) < 5_000 || (input.timeoutMs ?? 900_000) > 3_600_000) throw new AppError('CONFIG_INVALID', '超时必须在 5 秒到 60 分钟之间');
  if (input.isDefault && input.enabled === false) throw new AppError('CONFIG_INVALID', '默认工作流必须处于启用状态');
}

function isAbsolutePath(value: string) { return path.win32.isAbsolute(value?.trim()) || path.posix.isAbsolute(value?.trim()); }
function isDecimal(value: string) { return /^\d+(?:\.\d+)?$/.test(value?.trim()); }
function escapeLikePattern(value: string) { return value.replace(/[\\%_]/g, '\\$&'); }
function nullableDecimal(value?: string | null) { return value?.trim() ? value.trim() : null; }
function messageFromResult(result: JsonRecord) {
  const errors = Array.isArray(result.errors) ? result.errors.filter((item): item is string => typeof item === 'string') : [];
  return errors.join('；') || '下载工作流返回失败';
}
function validateWbColorIdentity(input: WbColorIdentity): WbColorIdentity {
  const colorKey = String(input?.colorKey || '').trim().toLocaleLowerCase('en-US');
  const nameRu = String(input?.nameRu || '').trim().normalize('NFC');
  const nameZh = String(input?.nameZh || '').trim().normalize('NFC');
  if (!/^[a-f0-9]{64}$/.test(colorKey) || !nameRu || !nameZh || nameRu.length > 256 || nameZh.length > 256) {
    throw new AppError('CONFIG_INVALID', 'WB 颜色身份格式无效');
  }
  return { colorKey, nameRu, nameZh };
}
function validateOzonColorIdentity(input: OzonColorIdentity): OzonColorIdentity {
  const itemKey = String(input?.itemKey || '').trim();
  const dictionaryId = Number(input?.dictionaryId);
  const valueId = Number(input?.valueId);
  const nameRu = String(input?.nameRu || '').trim().normalize('NFC');
  const nameZh = String(input?.nameZh || '').trim().normalize('NFC');
  const source = input?.source;
  if (!itemKey || !Number.isInteger(dictionaryId) || dictionaryId < 1 || !Number.isInteger(valueId) || valueId < 1
    || !nameRu || !nameZh || nameRu.length > 256 || nameZh.length > 256
    || !['AUTO_EXACT_RU', 'MANUAL_E001', 'MANUAL_OZON'].includes(source)) {
    throw new AppError('CONFIG_INVALID', 'OZON 颜色身份格式无效');
  }
  return { itemKey, dictionaryId, valueId, nameRu, nameZh, source };
}
function normalizeColorName(value: string): string { return value.trim().normalize('NFC').toLocaleLowerCase('ru-RU').replace(/ё/g, 'е'); }
function exactColorNameIndex(colors: WbColorIdentity[]): Map<string, WbColorIdentity> {
  const index = new Map<string, WbColorIdentity>();
  const ambiguous = new Set<string>();
  for (const input of colors) {
    const color = validateWbColorIdentity(input);
    for (const name of [color.nameRu, color.nameZh]) {
      const key = normalizeColorName(name);
      const existing = index.get(key);
      if (existing && existing.colorKey !== color.colorKey) ambiguous.add(key);
      else if (!existing) index.set(key, color);
    }
  }
  for (const key of ambiguous) index.delete(key);
  return index;
}
function toProductVariant(row: SqlRow): ProductVariant {
  return {
    variantId: String(row.id),
    name: String(row.name),
    ...(row.wb_color_key && row.wb_color_name_ru && row.wb_color_name_zh ? {
      wbColor: { colorKey: String(row.wb_color_key), nameRu: String(row.wb_color_name_ru), nameZh: String(row.wb_color_name_zh) }
    } : {}),
    ...(row.ozon_color_item_key && row.ozon_color_dictionary_id && row.ozon_color_value_id && row.ozon_color_name_ru && row.ozon_color_name_zh && row.ozon_color_source ? {
      ozonColor: {
        itemKey: String(row.ozon_color_item_key),
        dictionaryId: Number(row.ozon_color_dictionary_id),
        valueId: Number(row.ozon_color_value_id),
        nameRu: String(row.ozon_color_name_ru),
        nameZh: String(row.ozon_color_name_zh),
        source: row.ozon_color_source as OzonColorIdentity['source']
      }
    } : {})
  };
}
function toProduct(row: SqlRow) { return { sku: row.sku, productName: row.product_name, variants: Array.isArray(row.variants) ? row.variants : undefined, createdAt: row.created_at, updatedAt: row.updated_at }; }
function toProcurementVersion(row: SqlRow) { return {
  id: row.id || row.procurement_version_id, versionNo: Number(row.version_no), downloadWorkflowCode: row.download_workflow_code, purchasePrice: row.purchase_price, retailPrice: row.retail_price, courierFee: row.courier_fee, currency: row.currency,
  grossWeightGrams: row.gross_weight_g, lengthCm: row.length_cm, widthCm: row.width_cm, heightCm: row.height_cm,
  netWeightGrams: row.net_weight_g, productHeightCm: row.product_height_cm, productDepthCm: row.product_depth_cm, productWidthCm: row.product_width_cm,
  transportMode: row.transport_mode, providerUrl: row.provider_url, createdAt: row.created_at
}; }
function toPurchaseSummary(row: SqlRow) { return {
  ...toProduct(row), procurement: toProcurementVersion(row),
  entryOrigin: {
    methodKey: row.entry_method_key,
    label: row.entry_method_label,
    platform: row.entry_platform || undefined,
    workflowCode: row.entry_workflow_code || undefined,
    sourceType: row.entry_source_type as PurchaseEntryOriginSourceType,
    sourceId: row.entry_source_id || undefined,
    recordedAt: row.entry_recorded_at
  } satisfies PurchaseEntryOrigin,
  localMediaFolder: row.local_media_folder || undefined,
  latestDownloadJob: row.job_id ? {
  id: row.job_id, status: row.job_status, workflowCode: row.job_workflow_code, outputDir: row.job_output_dir, createdAt: row.job_created_at,
  finishedAt: row.job_finished_at, errorMessage: row.job_error_message, nextAttemptAt: row.job_next_attempt_at,
  retryReason: row.job_retry_reason, resourceRetryCount: Number(row.job_resource_retry_count || 0)
  } : undefined
}; }
function toPurchaseEntryMethodFacet(row: SqlRow) { return {
  value: String(row.value), label: String(row.label), platform: row.platform || undefined,
  workflowCode: row.workflow_code || undefined, sourceType: row.source_type as PurchaseEntryOriginSourceType,
  count: Number(row.count || 0)
}; }
function toPricingProductSnapshot(row: SqlRow): PricingProductSnapshot { return {
  sku: row.sku, productName: row.product_name, updatedAt: row.updated_at,
  procurement: {
    id: row.procurement_version_id, versionNo: Number(row.version_no), purchasePrice: row.purchase_price, courierFee: row.courier_fee,
    currency: row.currency, grossWeightGrams: row.gross_weight_g, lengthCm: row.length_cm, widthCm: row.width_cm,
    heightCm: row.height_cm, netWeightGrams: row.net_weight_g, productHeightCm: row.product_height_cm,
    productDepthCm: row.product_depth_cm, productWidthCm: row.product_width_cm, createdAt: row.procurement_created_at
  }
}; }
function toWorkflow(row: SqlRow) { return {
  code: row.code, displayName: row.display_name, webhookUrl: row.webhook_url, parentOutputDir: row.parent_output_dir,
  timeoutMs: Number(row.timeout_ms), enabled: Boolean(row.enabled), isDefault: Boolean(row.is_default),
  recoveryMode: (row.recovery_mode || 'MANUAL') as DownloadRecoveryMode, createdAt: row.created_at, updatedAt: row.updated_at
}; }
function toJob(row: SqlRow) { return {
  id: row.id, sku: row.sku, workflowCode: row.workflow_code, workflowSnapshot: row.workflow_snapshot, requestBody: row.request_body,
  status: row.status as DownloadJobStatus, attempt: Number(row.attempt || 0), result: row.result_json, errorMessage: row.error_message,
  outputDir: row.output_dir, batchId: row.batch_id, batchPosition: row.batch_position ? Number(row.batch_position) : undefined,
  queueSequence: row.queue_sequence ? Number(row.queue_sequence) : undefined, notificationThreadId: row.notification_thread_id,
  nextAttemptAt: row.next_attempt_at, retryReason: row.retry_reason, resourceRetryCount: Number(row.resource_retry_count || 0),
  resourceWaitStartedAt: row.resource_wait_started_at, createdAt: row.created_at, startedAt: row.started_at, finishedAt: row.finished_at
}; }
function toClaimedJob(row: SqlRow) { return {
  ...toJob(row),
  recoveryMode: (row.recovery_mode || row.workflow_snapshot?.recoveryMode || 'MANUAL') as DownloadRecoveryMode,
  leaseToken: String(row.lease_token || ''),
  leaseOwner: String(row.lease_owner || ''),
  heartbeatAt: row.heartbeat_at,
  leaseExpiresAt: row.lease_expires_at
}; }
function toNotification(row: SqlRow) { return {
  id: row.id, category: row.category, eventType: row.event_type, severity: row.severity, title: row.title, message: row.message,
  sourceType: row.source_type, sourceId: row.source_id, batchId: row.batch_id, sku: row.sku, productName: row.product_name,
  workflowCode: row.workflow_code, details: row.details || {}, readAt: row.read_at, resolvedAt: row.resolved_at,
  createdAt: row.created_at, updatedAt: row.updated_at
}; }
