import { createHash } from 'node:crypto';
import path from 'node:path';
import { mkdir, readdir, rename, rm, writeFile } from 'node:fs/promises';
import type { FastifyBaseLogger } from 'fastify';
import {
  AppError,
  inferOzonCategorySizing,
  OZON_DEFAULT_STORE_ID,
  ozonCategorySizeAttributeCandidates,
  type OzonCatalogEntry,
  type OzonCatalogDictionaryName,
  type OzonCatalogDictionaryResult,
  type OzonCatalogStatus,
  type OzonCatalogTrigger,
  type OzonCategoryAttribute,
  type OzonCategoryTemplate,
  type OzonCategoryTemplateInput
} from '@n8n-media-review/shared';
import {
  OzonRepository,
  type OzonCatalogEntryInput,
  type OzonCatalogDictionaryValueInput,
  type OzonCatalogOverview
} from '../../repositories/ozon.js';

type OzonLanguage = 'RU' | 'ZH_HANS';
type GlobalCatalogAdminRequest =
  | { action: 'categoryTree'; payload: { language: OzonLanguage } }
  | {
    action: 'categorySchema';
    descriptionCategoryId: number;
    typeId: number;
    locale: OzonLanguage;
  }
  | {
    action: 'attributeValues';
    payload: {
      description_category_id: number;
      type_id: number;
      attribute_id: number;
      language: OzonLanguage;
      last_value_id: number;
      limit: number;
    };
  };
type CatalogSource = {
  categoryTree(language: OzonLanguage): Promise<unknown>;
  categorySchema(descriptionCategoryId: number, typeId: number, language: OzonLanguage): Promise<unknown>;
  attributeValues?(
    descriptionCategoryId: number,
    typeId: number,
    attributeId: number,
    language: OzonLanguage,
    lastValueId: number
  ): Promise<unknown>;
};

type CatalogServiceOptions = {
  now?: () => Date;
  setTimer?: (callback: () => void, milliseconds: number) => NodeJS.Timeout;
  clearTimer?: (timer: NodeJS.Timeout) => void;
  source?: CatalogSource;
};

const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1_000;
const WEEK_MS = 7 * 24 * 60 * 60 * 1_000;
const STALE_MS = 8 * 24 * 60 * 60 * 1_000;
const FIELD_DICTIONARIES: ReadonlyArray<{
  directory: OzonCatalogDictionaryName;
  attributeId: number;
  dictionaryId: number;
}> = [
  { directory: 'countries', attributeId: 4389, dictionaryId: 1935 },
  { directory: 'seasons', attributeId: 4495, dictionaryId: 703 },
  { directory: 'kinds', attributeId: 9163, dictionaryId: 320 },
  { directory: 'colors', attributeId: 10096, dictionaryId: 1494 }
];

export class OzonCatalogService {
  private stopped = true;
  private scheduleTimer?: NodeJS.Timeout;
  private activePromise?: Promise<void>;
  private readonly now: () => Date;
  private readonly setTimer: (callback: () => void, milliseconds: number) => NodeJS.Timeout;
  private readonly clearTimer: (timer: NodeJS.Timeout) => void;
  private readonly snapshotsDirectory: string;
  private readonly source: CatalogSource;

  constructor(
    private readonly repository: OzonRepository,
    appDataDir: string,
    private readonly logger: FastifyBaseLogger,
    options: CatalogServiceOptions = {}
  ) {
    this.now = options.now || (() => new Date());
    this.setTimer = options.setTimer || ((callback, milliseconds) => setTimeout(callback, milliseconds));
    this.clearTimer = options.clearTimer || clearTimeout;
    this.snapshotsDirectory = path.join(appDataDir, 'ozon-catalog', 'snapshots');
    this.source = options.source || {
      categoryTree: (language) => this.callAdminApi({ action: 'categoryTree', payload: { language } }),
      categorySchema: (descriptionCategoryId, typeId, language) => this.callAdminApi({
        action: 'categorySchema', descriptionCategoryId, typeId, locale: language
      }),
      attributeValues: (descriptionCategoryId, typeId, attributeId, language, lastValueId) => this.callAdminApi({
        action: 'attributeValues',
        payload: {
          description_category_id: descriptionCategoryId,
          type_id: typeId,
          attribute_id: attributeId,
          language,
          last_value_id: lastValueId,
          limit: 1_000
        }
      })
    };
  }

  async start(): Promise<void> {
    if (!this.repository.configured || !this.stopped) return;
    this.stopped = false;
    await mkdir(this.snapshotsDirectory, { recursive: true });
    const recovered = await this.repository.recoverAbandonedCatalogRuns();
    const overview = await this.repository.catalogOverview();
    if (recovered > 0 || overview.entryCount === 0 || overview.latestRun?.status === 'FAILED') {
      const created = await this.repository.beginCatalogRun('STARTUP');
      if (created.created) this.launch(created.run.runId);
    }
    this.scheduleNextWeeklyRun();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.scheduleTimer) {
      this.clearTimer(this.scheduleTimer);
      this.scheduleTimer = undefined;
    }
    await this.activePromise;
  }

  async status(): Promise<OzonCatalogStatus> {
    return this.statusFromOverview(await this.repository.catalogOverview());
  }

  async search(queryInput: string, limitInput?: number): Promise<{ items: OzonCatalogEntry[]; catalog: OzonCatalogStatus }> {
    const query = String(queryInput || '').trim();
    if (!/\p{Script=Han}/u.test(query)) throw new AppError('CONFIG_INVALID', '请输入包含中文字符的 OZON 类目名称');
    const limit = limitInput === undefined ? 30 : Number(limitInput);
    if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw new AppError('CONFIG_INVALID', 'limit 必须是 1 到 50 的整数');
    const overview = await this.repository.catalogOverview();
    if (overview.entryCount === 0) {
      throw new AppError('CATALOG_NOT_INITIALIZED', 'OZON 本地中文类目目录尚未初始化，请先执行立即同步', {
        lastErrorCode: overview.latestRun?.errorCode,
        lastError: overview.latestRun?.errorMessage
      }, 409);
    }
    return { items: await this.repository.searchCatalogEntries(query, limit), catalog: this.statusFromOverview(overview) };
  }

  async triggerManual(): Promise<{ runId: string; status: 'RUNNING'; accepted: boolean }> {
    return this.begin('MANUAL');
  }

  async dictionary(
    directoryInput: string,
    queryInput = '',
    dictionaryIdInput?: number,
    limitInput?: number
  ): Promise<OzonCatalogDictionaryResult> {
    const directory = FIELD_DICTIONARIES.find((item) => item.directory === directoryInput)?.directory;
    if (!directory) throw new AppError('CONFIG_INVALID', 'OZON 字段字典仅支持 countries、seasons、kinds、colors');
    const dictionaryId = dictionaryIdInput === undefined ? undefined : Number(dictionaryIdInput);
    if (dictionaryId !== undefined && (!Number.isInteger(dictionaryId) || dictionaryId < 1)) {
      throw new AppError('CONFIG_INVALID', 'dictionaryId 必须是正整数');
    }
    const limit = limitInput === undefined ? 1_000 : Number(limitInput);
    if (!Number.isInteger(limit) || limit < 1 || limit > 2_000) throw new AppError('CONFIG_INVALID', 'limit 必须是 1 到 2000 的整数');
    const overview = await this.repository.catalogOverview();
    if ((overview.dictionaryCounts[directory] || 0) === 0) {
      throw new AppError('CATALOG_NOT_INITIALIZED', `OZON ${dictionaryLabel(directory)}字典尚未同步，请先执行立即同步`, undefined, 409);
    }
    return {
      directory,
      ...(dictionaryId ? { dictionaryId } : {}),
      items: await this.repository.searchCatalogDictionary(directory, {
        dictionaryId,
        query: String(queryInput || '').trim(),
        limit
      }),
      catalog: this.statusFromOverview(overview)
    };
  }

  async createCategory(catalogEntryId: string): Promise<OzonCategoryTemplate> {
    const entry = await this.repository.getCatalogEntry(catalogEntryId);
    const snapshot = await this.buildTemplateSnapshot(entry);
    return this.repository.createCategory(snapshot);
  }

  async refreshCategory(categoryKey: string): Promise<OzonCategoryTemplate> {
    const category = await this.repository.getCategory(categoryKey);
    const entry = await this.repository.getCatalogEntry(`${category.descriptionCategoryId}:${category.typeId}`);
    const snapshot = await this.buildTemplateSnapshot(entry);
    const currentAttributes = (category.draftVersion || category.publishedVersion)?.snapshot.attributes || [];
    const currentSnapshot = (category.draftVersion || category.publishedVersion)?.snapshot;
    snapshot.media = currentSnapshot?.media
      || { defaultVideoUploadMode: 'COMPRESSED_COPY' };
    const currentSizeKey = currentSnapshot?.sizing?.sizeMode === 'sized'
      ? currentSnapshot.sizing.sizeAttributeKey
      : undefined;
    const currentSizeCandidateStillExists = currentSizeKey
      && ozonCategorySizeAttributeCandidates(snapshot.attributes)
        .some((attribute) => `${attribute.id}:${attribute.complexId}` === currentSizeKey);
    if (currentSizeCandidateStillExists) snapshot.sizing = currentSnapshot!.sizing;
    snapshot.attributes = reconcileOzonAttributeOrder(currentAttributes, snapshot.attributes);
    return this.repository.saveCategoryDraft(categoryKey, { ...snapshot, categoryKey });
  }

  private async begin(trigger: OzonCatalogTrigger, scheduleKey?: string): Promise<{ runId: string; status: 'RUNNING'; accepted: boolean }> {
    const created = await this.repository.beginCatalogRun(trigger, scheduleKey);
    if (created.created) this.launch(created.run.runId);
    return { runId: created.run.runId, status: 'RUNNING', accepted: created.created };
  }

  private launch(runId: string): void {
    const promise = this.synchronize(runId).catch((error) => this.handleFailure(runId, error));
    const tracked = promise.finally(() => {
      if (this.activePromise === tracked) this.activePromise = undefined;
    });
    this.activePromise = tracked;
  }

  private async synchronize(runId: string): Promise<void> {
    await mkdir(this.snapshotsDirectory, { recursive: true });
    const [rawRu, rawZh] = await Promise.all([
      this.source.categoryTree('RU'),
      this.source.categoryTree('ZH_HANS')
    ]);
    const ruRows = flattenCategoryTree(rawRu, 'RU');
    const zhRows = flattenCategoryTree(rawZh, 'ZH_HANS');
    if (!ruRows.length) throw new CatalogSyncError('OZON_SYNC_FAILED', 'OZON 俄文类目树为空，已拒绝覆盖本地快照');
    if (!zhRows.length) throw new CatalogSyncError('OZON_SYNC_FAILED', 'OZON 中文类目树为空，已拒绝覆盖本地快照');
    const merged = mergeCategoryTrees(ruRows, zhRows);
    if (!merged.entries.length) throw new CatalogSyncError('OZON_SYNC_FAILED', 'OZON 中俄类目树没有可合并的有效叶子类目');
    const dictionaryValues = this.source.attributeValues
      ? await this.synchronizeFieldDictionaries(selectDictionarySourceEntry(merged.entries))
      : [];
    await this.repository.updateCatalogRunProgress(runId, {
      processedEntries: merged.entries.length,
      totalEntries: ruRows.length,
      chineseMissingCount: merged.chineseMissingCount
    });
    const generatedAt = this.now().toISOString();
    const snapshot = {
      schemaVersion: 1,
      runId,
      generatedAt,
      locales: ['RU', 'ZH_HANS'],
      entries: merged.entries,
      dictionaries: dictionaryValues,
      chineseMissingCount: merged.chineseMissingCount,
      source: { RU: rawRu, ZH_HANS: rawZh }
    };
    const sourceHash = `sha256:${createHash('sha256').update(stableJson({
      ...snapshot.source,
      dictionaries: dictionaryValues
    })).digest('hex')}`;
    const fileName = `categories-ru-zh-${generatedAt.replace(/[:.]/g, '-')}-${runId}.json`;
    const finalPath = path.join(this.snapshotsDirectory, fileName);
    const temporaryPath = `${finalPath}.staging`;
    await writeFile(temporaryPath, `${JSON.stringify({ ...snapshot, sourceHash }, null, 2)}\n`, 'utf8');
    await rename(temporaryPath, finalPath);
    try {
      await this.repository.completeCatalogRun(runId, merged.entries, dictionaryValues, finalPath, sourceHash, merged.chineseMissingCount);
    } catch (error) {
      await rm(finalPath, { force: true }).catch(() => undefined);
      throw error;
    }
    await this.pruneSnapshots();
  }

  private async buildTemplateSnapshot(entry: OzonCatalogEntry): Promise<OzonCategoryTemplateInput> {
    const [schemaRuRaw, schemaZhRaw] = await Promise.all([
      this.source.categorySchema(entry.descriptionCategoryId, entry.typeId, 'RU'),
      this.source.categorySchema(entry.descriptionCategoryId, entry.typeId, 'ZH_HANS')
    ]);
    const schemaRu = extractCategorySchema(schemaRuRaw, 'RU');
    const schemaZh = extractCategorySchema(schemaZhRaw, 'ZH_HANS');
    const attributes = prioritizeRequiredOzonAttributes(mergeAttributes(schemaRu.attributes, schemaZh.attributes));
    if (!attributes.length) throw new AppError('VERIFY_FAILED', 'OZON 类目属性接口未返回有效属性，未创建模板', {
      catalogEntryId: entry.catalogEntryId
    }, 502);
    const dictionarySnapshot: Record<string, Array<{ id: number; value: string; info?: string; valueRu?: string; valueZh?: string }>> = {};
    await Promise.all(attributes.map(async (attribute) => {
      const directory = directoryForAttribute(attribute);
      if (!directory || !attribute.dictionaryId) return;
      const values = await this.repository.searchCatalogDictionary(directory, {
        dictionaryId: attribute.dictionaryId,
        limit: 2_000
      });
      if (!values.length) return;
      dictionarySnapshot[String(attribute.id)] = values.map((value) => ({
        id: value.valueId,
        value: bilingualDictionaryLabel(value.nameZh, value.nameRu),
        valueRu: value.nameRu,
        valueZh: value.nameZh,
        ...(value.infoZh || value.infoRu ? { info: value.infoZh || value.infoRu } : {})
      }));
    }));
    const sizeDictionarySnapshot = await this.readSizeDictionarySnapshot(entry, attributes);
    return {
      categoryKey: `ozon_${entry.descriptionCategoryId}_${entry.typeId}`,
      nameRu: entry.typeNameRu || entry.categoryNameRu,
      nameZh: entry.typeNameZh || entry.categoryNameZh,
      descriptionCategoryId: entry.descriptionCategoryId,
      typeId: entry.typeId,
      attributes,
      dictionarySnapshot: { ...schemaRu.dictionarySnapshot, ...dictionarySnapshot, ...sizeDictionarySnapshot },
      media: { defaultVideoUploadMode: 'COMPRESSED_COPY' },
      sizing: inferOzonCategorySizing(attributes),
      sourceSnapshot: { catalogEntry: entry, RU: schemaRuRaw, ZH_HANS: schemaZhRaw },
      confirmedBy: ''
    };
  }

  private async readSizeDictionarySnapshot(
    entry: Pick<OzonCatalogEntry, 'descriptionCategoryId' | 'typeId'>,
    attributes: OzonCategoryAttribute[]
  ): Promise<Record<string, Array<{ id: number; value: string; info?: string; valueRu?: string; valueZh?: string }>>> {
    const dictionaryAttributes = ozonCategorySizeAttributeCandidates(attributes)
      .filter((attribute) => attribute.dictionaryId > 0);
    if (!dictionaryAttributes.length) return {};
    if (!this.source.attributeValues) {
      throw new AppError('VERIFY_FAILED', '字典型 OZON 尺码属性无法读取属性值，已拒绝覆盖类目模板', {
        attributeIds: dictionaryAttributes.map((attribute) => attribute.id)
      }, 502);
    }
    try {
      const entries = await Promise.all(dictionaryAttributes.map(async (attribute) => {
        const [ru, zh] = await Promise.all([
          this.readAllAttributeValues(entry, attribute.id, 'RU'),
          this.readAllAttributeValues(entry, attribute.id, 'ZH_HANS')
        ]);
        return [String(attribute.id), mergeCategoryDictionaryValues(attribute, ru, zh)] as const;
      }));
      return Object.fromEntries(entries);
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError('VERIFY_FAILED', 'OZON 尺码字典同步失败，已保留上一版类目模板', {
        attributeIds: dictionaryAttributes.map((attribute) => attribute.id),
        cause: error instanceof Error ? error.message : String(error)
      }, 502);
    }
  }

  private async synchronizeFieldDictionaries(sourceEntry: OzonCatalogEntryInput): Promise<OzonCatalogDictionaryValueInput[]> {
    if (!this.source.attributeValues) return [];
    const result = await Promise.all(FIELD_DICTIONARIES.map(async (definition) => {
      const [ru, zh] = await Promise.all([
        this.readAllAttributeValues(sourceEntry, definition.attributeId, 'RU'),
        this.readAllAttributeValues(sourceEntry, definition.attributeId, 'ZH_HANS')
      ]);
      return mergeAttributeValues(definition, ru, zh);
    }));
    return result.flat();
  }

  private async readAllAttributeValues(
    sourceEntry: Pick<OzonCatalogEntryInput, 'descriptionCategoryId' | 'typeId'>,
    attributeId: number,
    language: OzonLanguage
  ): Promise<LocalizedAttributeValue[]> {
    if (!this.source.attributeValues) return [];
    const values: LocalizedAttributeValue[] = [];
    let lastValueId = 0;
    for (let page = 0; page < 50; page += 1) {
      const raw = await this.source.attributeValues(
        sourceEntry.descriptionCategoryId,
        sourceEntry.typeId,
        attributeId,
        language,
        lastValueId
      );
      const parsed = extractAttributeValuePage(raw);
      values.push(...parsed.items);
      if (!parsed.hasNext) return values;
      const nextLastValueId = parsed.items.at(-1)?.id;
      if (!nextLastValueId || nextLastValueId === lastValueId) {
        throw new CatalogSyncError('OZON_SYNC_FAILED', `OZON ${language} 属性 ${attributeId} 字典分页游标无效`);
      }
      lastValueId = nextLastValueId;
    }
    throw new CatalogSyncError('OZON_SYNC_FAILED', `OZON ${language} 属性 ${attributeId} 字典分页超过安全上限`);
  }

  private statusFromOverview(overview: OzonCatalogOverview): OzonCatalogStatus {
    const lastSuccessfulMs = overview.lastSuccessfulAt ? Date.parse(overview.lastSuccessfulAt) : Number.NaN;
    const isStale = Number.isFinite(lastSuccessfulMs) && this.now().getTime() - lastSuccessfulMs > STALE_MS;
    const latestFailed = overview.latestRun?.status === 'FAILED';
    const status = overview.currentRun ? 'SYNCING'
      : overview.entryCount === 0 ? latestFailed ? 'FAILED' : 'EMPTY'
        : latestFailed ? 'FAILED' : isStale ? 'STALE' : 'READY';
    return {
      status,
      entryCount: overview.entryCount,
      chineseMissingCount: overview.chineseMissingCount,
      dictionaryCounts: overview.dictionaryCounts,
      ...(overview.lastSuccessfulAt ? { lastSuccessfulAt: overview.lastSuccessfulAt } : {}),
      ...(latestFailed && overview.latestRun?.errorMessage ? { lastError: overview.latestRun.errorMessage } : {}),
      ...(latestFailed && overview.latestRun?.errorCode ? { lastErrorCode: overview.latestRun.errorCode } : {}),
      ...(overview.currentRun ? { currentRun: overview.currentRun } : {}),
      ...(overview.latestRun ? { latestRun: overview.latestRun } : {}),
      nextScheduledAt: nextOzonCatalogRun(this.now()).toISOString(),
      isStale
    };
  }

  private scheduleNextWeeklyRun(): void {
    if (this.stopped) return;
    if (this.scheduleTimer) this.clearTimer(this.scheduleTimer);
    const target = nextOzonCatalogRun(this.now());
    const delay = Math.max(1, target.getTime() - this.now().getTime());
    this.scheduleTimer = this.setTimer(() => {
      this.scheduleTimer = undefined;
      if (this.stopped) return;
      void this.begin('SCHEDULED', ozonCatalogWeekKey(target)).catch((error) => this.logger.error({ err: error }, 'OZON 类目周计划启动失败'));
      this.scheduleNextWeeklyRun();
    }, delay);
    this.scheduleTimer.unref?.();
  }

  private async handleFailure(runId: string, error: unknown): Promise<void> {
    const failure = classifyCatalogError(error);
    await this.repository.failCatalogRun(runId, failure.code, failure.message).catch((markError) => {
      this.logger.error({ err: markError, runId, originalError: error }, '无法标记 OZON 类目同步失败');
    });
    this.logger.error({ err: error, runId, errorCode: failure.code }, 'OZON 本地类目目录同步失败');
  }

  private async pruneSnapshots(): Promise<void> {
    const retained = new Set((await this.repository.listSuccessfulCatalogSnapshotPaths(7)).map((filePath) => path.resolve(filePath)));
    const names = (await readdir(this.snapshotsDirectory)).filter((name) => name.endsWith('.json'));
    await Promise.all(names.map((name) => path.join(this.snapshotsDirectory, name))
      .filter((filePath) => !retained.has(path.resolve(filePath)))
      .map((filePath) => rm(filePath, { force: true })));
  }

  private async callAdminApi(body: GlobalCatalogAdminRequest): Promise<unknown> {
    const settings = await this.repository.getSettings();
    if (!settings.adminApiWebhookUrl) throw new AppError('CONFIG_INVALID', '尚未配置 OZON 类目与系统配置 Webhook', undefined, 409);
    const response = await fetch(settings.adminApiWebhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...body, storeId: OZON_DEFAULT_STORE_ID }),
      signal: AbortSignal.timeout(90_000)
    });
    const text = await response.text();
    let data: Record<string, unknown> = {};
    if (text) {
      try { data = JSON.parse(text) as Record<string, unknown>; }
      catch { data = { message: text.slice(0, 500) }; }
    }
    if (!response.ok || data.ok === false) {
      throw new AppError('VERIFY_FAILED', String(data.message || `n8n Webhook 返回 HTTP ${response.status}`), {
        httpStatus: response.status
      }, 502);
    }
    return data;
  }
}

type FlatCategory = {
  descriptionCategoryId: number;
  typeId: number;
  categoryName: string;
  typeName: string;
  path: string[];
  disabled: boolean;
};

export function flattenCategoryTree(input: unknown, language: OzonLanguage): FlatCategory[] {
  const result = unwrapTree(input);
  if (!Array.isArray(result)) return [];
  const rows: FlatCategory[] = [];
  const visit = (nodes: unknown[], context: { descriptionCategoryId?: number; categoryName?: string; path: string[]; disabled: boolean }) => {
    for (const value of nodes) {
      const node = asObject(value);
      const categoryName = stringValue(node.category_name) || context.categoryName || '';
      const ownCategoryId = positiveInteger(node.description_category_id) || context.descriptionCategoryId;
      const disabled = context.disabled || Boolean(node.disabled);
      const pathWithCategory = stringValue(node.category_name) && stringValue(node.category_name) !== context.path.at(-1)
        ? [...context.path, stringValue(node.category_name)!]
        : context.path;
      const typeId = positiveInteger(node.type_id);
      const typeName = stringValue(node.type_name);
      if (ownCategoryId && typeId && typeName) {
        rows.push({
          descriptionCategoryId: ownCategoryId,
          typeId,
          categoryName,
          typeName,
          path: [...pathWithCategory, typeName],
          disabled
        });
      }
      const children = Array.isArray(node.children) ? node.children : [];
      if (children.length) visit(children, { descriptionCategoryId: ownCategoryId, categoryName, path: pathWithCategory, disabled });
    }
  };
  visit(result, { path: [], disabled: false });
  const unique = new Map<string, FlatCategory>();
  for (const row of rows) {
    const key = `${row.descriptionCategoryId}:${row.typeId}`;
    if (unique.has(key)) throw new CatalogSyncError('OZON_SYNC_FAILED', `OZON ${language} 类目树包含重复叶子 ${key}`);
    unique.set(key, row);
  }
  return [...unique.values()];
}

export function mergeCategoryTrees(ruRows: FlatCategory[], zhRows: FlatCategory[]): { entries: OzonCatalogEntryInput[]; chineseMissingCount: number } {
  const zhByKey = new Map(zhRows.map((row) => [`${row.descriptionCategoryId}:${row.typeId}`, row]));
  const entries: OzonCatalogEntryInput[] = [];
  let chineseMissingCount = 0;
  for (const ru of ruRows) {
    if (ru.disabled) continue;
    const zh = zhByKey.get(`${ru.descriptionCategoryId}:${ru.typeId}`);
    const categoryNameZh = zh && !zh.disabled ? zh.categoryName : '';
    const typeNameZh = zh && !zh.disabled ? zh.typeName : '';
    if (!categoryNameZh || !typeNameZh) chineseMissingCount += 1;
    entries.push({
      descriptionCategoryId: ru.descriptionCategoryId,
      typeId: ru.typeId,
      categoryNameZh,
      typeNameZh,
      categoryNameRu: ru.categoryName,
      typeNameRu: ru.typeName,
      pathZh: zh && !zh.disabled ? zh.path : [],
      pathRu: ru.path,
      displayPathZh: zh && !zh.disabled ? zh.path.join(' → ') : '',
      displayPathRu: ru.path.join(' → ')
    });
  }
  return { entries, chineseMissingCount };
}

type LocalizedAttributeValue = {
  id: number;
  value: string;
  info: string;
};

function selectDictionarySourceEntry(entries: OzonCatalogEntryInput[]): OzonCatalogEntryInput {
  // The OZON T-shirt type exposes the complete adult/child gender dictionary,
  // while narrower apparel types (for example dresses) return only applicable values.
  const exact = entries.find((entry) => entry.descriptionCategoryId === 200000933 && entry.typeId === 93244);
  const tshirt = entries.find((entry) => entry.typeNameRu.toLocaleLowerCase('ru-RU') === 'футболка')
    || entries.find((entry) => entry.typeNameZh === 'T恤');
  const dress = entries.find((entry) => entry.typeNameRu.toLocaleLowerCase('ru-RU') === 'платье')
    || entries.find((entry) => entry.typeNameZh === '连衣裙');
  const source = exact || tshirt || dress;
  if (!source) {
    throw new CatalogSyncError('OZON_SYNC_FAILED', 'OZON 类目树中未找到可读取四类字段字典的服装基准类目');
  }
  return source;
}

function extractAttributeValuePage(input: unknown): { items: LocalizedAttributeValue[]; hasNext: boolean } {
  const root = asObject(input);
  const payload = asObject(root.result ?? root.body ?? input);
  const nested = asObject(payload.result);
  const rawItems = Array.isArray(payload.result) ? payload.result
    : Array.isArray(payload.items) ? payload.items
      : Array.isArray(nested.result) ? nested.result
        : Array.isArray(nested.items) ? nested.items
          : [];
  const items = rawItems.map((value) => {
    const row = asObject(value);
    const id = positiveInteger(row.id);
    const name = stringValue(row.value);
    if (!id || !name) return undefined;
    return { id, value: name, info: String(row.info || '').trim() };
  }).filter((value): value is LocalizedAttributeValue => Boolean(value));
  const hasNext = Boolean(payload.has_next ?? payload.hasNext ?? nested.has_next ?? nested.hasNext);
  return { items, hasNext };
}

function mergeAttributeValues(
  definition: (typeof FIELD_DICTIONARIES)[number],
  ru: LocalizedAttributeValue[],
  zh: LocalizedAttributeValue[]
): OzonCatalogDictionaryValueInput[] {
  if (!ru.length || !zh.length) {
    throw new CatalogSyncError('OZON_SYNC_FAILED', `OZON ${dictionaryLabel(definition.directory)}中俄字典为空，已拒绝覆盖上一版`);
  }
  const zhById = new Map(zh.map((value) => [value.id, value]));
  const missingChinese = ru.filter((value) => !zhById.get(value.id)?.value);
  if (missingChinese.length) {
    throw new CatalogSyncError(
      'OZON_SYNC_FAILED',
      `OZON ${dictionaryLabel(definition.directory)}字典有 ${missingChinese.length} 个值缺少中文，已拒绝覆盖上一版`
    );
  }
  return ru.map((value, position) => {
    const localized = zhById.get(value.id)!;
    return {
      directory: definition.directory,
      attributeId: definition.attributeId,
      dictionaryId: definition.dictionaryId,
      valueId: value.id,
      nameRu: value.value,
      nameZh: localized.value,
      ...(value.info ? { infoRu: value.info } : {}),
      ...(localized.info ? { infoZh: localized.info } : {}),
      position
    };
  });
}

function mergeCategoryDictionaryValues(
  attribute: Pick<OzonCategoryAttribute, 'id' | 'name' | 'nameRu' | 'nameZh'>,
  ru: LocalizedAttributeValue[],
  zh: LocalizedAttributeValue[]
): Array<{ id: number; value: string; info?: string; valueRu?: string; valueZh?: string }> {
  const label = attribute.nameZh || attribute.nameRu || attribute.name;
  if (!ru.length || !zh.length) {
    throw new CatalogSyncError('OZON_SYNC_FAILED', `OZON 尺码属性 ${label} (#${attribute.id}) 中俄字典为空`);
  }
  const uniqueRu = uniqueLocalizedAttributeValues(ru, attribute.id, 'RU');
  const uniqueZh = uniqueLocalizedAttributeValues(zh, attribute.id, 'ZH_HANS');
  const zhById = new Map(uniqueZh.map((value) => [value.id, value]));
  const missingChinese = uniqueRu.filter((value) => !zhById.get(value.id)?.value);
  if (missingChinese.length) {
    throw new CatalogSyncError(
      'OZON_SYNC_FAILED',
      `OZON 尺码属性 ${label} (#${attribute.id}) 有 ${missingChinese.length} 个值缺少中文`
    );
  }
  return uniqueRu.map((value) => {
    const localized = zhById.get(value.id)!;
    return {
      id: value.id,
      value: bilingualDictionaryLabel(localized.value, value.value),
      valueRu: value.value,
      valueZh: localized.value,
      ...(localized.info || value.info ? { info: localized.info || value.info } : {})
    };
  });
}

function uniqueLocalizedAttributeValues(
  values: LocalizedAttributeValue[],
  attributeId: number,
  language: OzonLanguage
): LocalizedAttributeValue[] {
  const seen = new Set<number>();
  for (const value of values) {
    if (seen.has(value.id)) {
      throw new CatalogSyncError('OZON_SYNC_FAILED', `OZON ${language} 属性 ${attributeId} 字典包含重复值 ID ${value.id}`);
    }
    seen.add(value.id);
  }
  return values;
}

function directoryForAttribute(attribute: Pick<OzonCategoryAttribute, 'id' | 'dictionaryId'>): OzonCatalogDictionaryName | undefined {
  return FIELD_DICTIONARIES.find((definition) =>
    definition.attributeId === attribute.id && definition.dictionaryId === attribute.dictionaryId
  )?.directory;
}

function dictionaryLabel(directory: OzonCatalogDictionaryName): string {
  return { countries: '原产国', seasons: '季节', kinds: '性别', colors: '商品颜色' }[directory];
}

function bilingualDictionaryLabel(nameZh: string, nameRu: string): string {
  return nameZh && nameRu && nameZh !== nameRu ? `${nameZh} / ${nameRu}` : nameZh || nameRu;
}

export function nextOzonCatalogRun(now: Date): Date {
  const local = new Date(now.getTime() + SHANGHAI_OFFSET_MS);
  const day = local.getUTCDay();
  let daysUntilMonday = (8 - day) % 7;
  let candidate = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate() + daysUntilMonday, 10) - SHANGHAI_OFFSET_MS;
  if (candidate < now.getTime()) {
    daysUntilMonday = daysUntilMonday === 0 ? 7 : daysUntilMonday;
    candidate = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate() + daysUntilMonday, 10) - SHANGHAI_OFFSET_MS;
    if (candidate < now.getTime()) candidate += WEEK_MS;
  }
  return new Date(candidate);
}

export function ozonCatalogWeekKey(input: Date): string {
  const local = new Date(input.getTime() + SHANGHAI_OFFSET_MS);
  const day = local.getUTCDay();
  const mondayOffset = day === 0 ? -6 : 1 - day;
  return new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate() + mondayOffset)).toISOString().slice(0, 10);
}

function extractCategorySchema(input: unknown, language: OzonLanguage): { attributes: OzonCategoryAttribute[]; dictionarySnapshot: Record<string, Array<{ id: number; value: string; info?: string }>> } {
  const root = asObject(input);
  const body = asObject(root.body);
  const category = asObject(root.category || body.category);
  const rawAttributes = Array.isArray(category.attributes) ? category.attributes
    : Array.isArray(root.result) ? root.result
      : Array.isArray(body.result) ? body.result
        : Array.isArray(root.attributes) ? root.attributes
          : [];
  const dictionarySnapshot = category.dictionarySnapshot ?? root.dictionarySnapshot ?? body.dictionarySnapshot;
  return {
    attributes: rawAttributes.map((attribute) => normalizeAttribute(attribute, language)).filter((value): value is OzonCategoryAttribute => Boolean(value)),
    dictionarySnapshot: isObject(dictionarySnapshot) ? dictionarySnapshot as Record<string, Array<{ id: number; value: string; info?: string }>> : {}
  };
}

function mergeAttributes(ruAttributes: OzonCategoryAttribute[], zhAttributes: OzonCategoryAttribute[]): OzonCategoryAttribute[] {
  const zhByKey = new Map(zhAttributes.map((attribute) => [`${attribute.id}:${attribute.complexId}`, attribute]));
  return ruAttributes.map((attribute) => {
    const zh = zhByKey.get(`${attribute.id}:${attribute.complexId}`);
    return {
      ...attribute,
      nameRu: attribute.nameRu || attribute.name,
      nameZh: zh?.nameZh || zh?.name || '',
      description: attribute.description || zh?.description || '',
      groupName: attribute.groupName || zh?.groupName || ''
    };
  });
}

export function prioritizeRequiredOzonAttributes<T extends Pick<OzonCategoryAttribute, 'required'>>(attributes: T[]): T[] {
  return [
    ...attributes.filter((attribute) => attribute.required),
    ...attributes.filter((attribute) => !attribute.required)
  ];
}

export function reconcileOzonAttributeOrder(
  current: OzonCategoryAttribute[],
  latest: OzonCategoryAttribute[]
): OzonCategoryAttribute[] {
  const latestByKey = new Map(latest.map((attribute) => [`${attribute.id}:${attribute.complexId}`, attribute]));
  const seen = new Set<string>();
  const retained = current.flatMap((attribute) => {
    const key = `${attribute.id}:${attribute.complexId}`;
    const updated = latestByKey.get(key);
    if (!updated || seen.has(key)) return [];
    seen.add(key);
    return [updated];
  });
  const added = latest.filter((attribute) => !seen.has(`${attribute.id}:${attribute.complexId}`));
  return prioritizeRequiredOzonAttributes([...retained, ...added]);
}

function normalizeAttribute(value: unknown, language: OzonLanguage): OzonCategoryAttribute | undefined {
  const row = asObject(value);
  const id = positiveInteger(row.id);
  if (!id) return undefined;
  const dictionaryId = nonnegativeInteger(row.dictionaryId ?? row.dictionary_id);
  const rawType = String(row.type || 'Unknown');
  const type = ['String', 'Integer', 'Decimal', 'Boolean', 'Dictionary', 'Image', 'URL', 'Unknown'].includes(rawType)
    ? rawType as OzonCategoryAttribute['type']
    : dictionaryId ? 'Dictionary' : 'Unknown';
  const name = String(row.name || `Attribute ${id}`).trim();
  return {
    id,
    name,
    nameRu: language === 'RU' ? name : '',
    nameZh: language === 'ZH_HANS' ? name : '',
    description: String(row.description || '').trim(),
    type,
    required: Boolean(row.required ?? row.is_required),
    dictionaryId,
    maxCount: Math.max(1, Number(row.maxCount ?? row.max_value_count ?? 1)),
    groupId: nonnegativeInteger(row.groupId ?? row.group_id),
    groupName: String(row.groupName ?? row.group_name ?? '').trim(),
    complexId: nonnegativeInteger(row.complexId ?? row.attribute_complex_id ?? row.complex_id),
    isCollection: Boolean(row.isCollection ?? row.is_collection)
  };
}

function unwrapTree(input: unknown): unknown[] {
  const root = asObject(input);
  const first = root.result ?? root.body ?? input;
  if (Array.isArray(first)) return first;
  const body = asObject(first);
  if (Array.isArray(body.result)) return body.result;
  const nested = asObject(body.body);
  return Array.isArray(nested.result) ? nested.result : [];
}

class CatalogSyncError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'CatalogSyncError';
  }
}

function classifyCatalogError(error: unknown): CatalogSyncError {
  if (error instanceof CatalogSyncError) return error;
  const message = error instanceof Error ? error.message : String(error || 'OZON 类目同步失败');
  if (/尚未配置.*OZON|Webhook/i.test(message)) return new CatalogSyncError('BRIDGE_NOT_CONFIGURED', message);
  if (/401|403|credential|凭据|认证|授权/i.test(message)) return new CatalogSyncError('OZON_AUTH_FAILED', message);
  if (/429|rate.?limit|too many requests|限频/i.test(message)) return new CatalogSyncError('OZON_RATE_LIMITED', message);
  if (/fetch failed|timeout|network|网络|HTTP 5\d\d/i.test(message)) return new CatalogSyncError('OZON_NETWORK_ERROR', message);
  return new CatalogSyncError('OZON_SYNC_FAILED', message);
}

function asObject(value: unknown): Record<string, any> {
  return isObject(value) ? value as Record<string, any> : {};
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function stringValue(value: unknown): string | undefined {
  const text = String(value ?? '').trim();
  return text || undefined;
}

function positiveInteger(value: unknown): number | undefined {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function nonnegativeInteger(value: unknown): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (isObject(value)) return `{${Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`).join(',')}}`;
  return JSON.stringify(value);
}
