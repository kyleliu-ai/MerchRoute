import { createHash } from 'node:crypto';
import path from 'node:path';
import { mkdir, readdir, rename, rm, writeFile } from 'node:fs/promises';
import type { FastifyBaseLogger } from 'fastify';
import { AppError, type WbColorIdentity } from '@n8n-media-review/shared';
import {
  WbRepository,
  type WbCatalogColorInput,
  type WbCatalogDictionaryName,
  type WbCatalogDictionaryValueInput,
  type WbCatalogLock,
  type WbCatalogOverview,
  type WbCatalogParentInput,
  type WbCatalogRun,
  type WbCatalogSubjectInput,
  type WbCatalogTrigger
} from '../../repositories/wb.js';
import { N8nWbClient, type WbLocale } from '../wb-publishing/n8n-client.js';

type CatalogStatus = 'EMPTY' | 'SYNCING' | 'READY' | 'STALE' | 'FAILED';
type CatalogErrorCode = 'BRIDGE_NOT_CONFIGURED' | 'WB_AUTH_FAILED' | 'WB_RATE_LIMITED' | 'WB_NETWORK_ERROR' | 'WB_SYNC_FAILED';

type CatalogServiceOptions = {
  now?: () => Date;
  sleep?: (milliseconds: number) => Promise<void>;
  setTimer?: (callback: () => void, milliseconds: number) => NodeJS.Timeout;
  clearTimer?: (timer: NodeJS.Timeout) => void;
  requestIntervalMs?: number;
  onCatalogReady?: (colors: WbColorIdentity[]) => Promise<void>;
};

export type WbCatalogStatus = {
  status: CatalogStatus;
  subjectCount: number;
  parentCount: number;
  colorCount: number;
  dictionaryCounts: Record<WbCatalogDictionaryName, number>;
  lastSuccessfulAt?: string;
  lastError?: string;
  lastErrorCode?: CatalogErrorCode;
  currentRun?: {
    runId: string;
    trigger: WbCatalogTrigger;
    status: 'RUNNING';
    startedAt: string;
    processedParents: number;
    totalParents: number;
    processedSubjects: number;
  };
  nextScheduledAt: string;
  isStale: boolean;
};

const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1_000;
const WEEK_MS = 7 * 24 * 60 * 60 * 1_000;
const STALE_MS = 8 * 24 * 60 * 60 * 1_000;
const PAGE_SIZE = 1_000;
const MAX_PAGES_PER_PARENT = 1_000;
const FIELD_DICTIONARIES = ['countries', 'seasons', 'kinds', 'colors'] as const satisfies readonly WbCatalogDictionaryName[];

export class WbCatalogService {
  private stopped = true;
  private scheduleTimer?: NodeJS.Timeout;
  private activePromise?: Promise<void>;
  private lastRequestAt = 0;
  private readonly now: () => Date;
  private readonly sleep: (milliseconds: number) => Promise<void>;
  private readonly setTimer: (callback: () => void, milliseconds: number) => NodeJS.Timeout;
  private readonly clearTimer: (timer: NodeJS.Timeout) => void;
  private readonly requestIntervalMs: number;
  private readonly snapshotsDirectory: string;
  private readonly onCatalogReady?: (colors: WbColorIdentity[]) => Promise<void>;

  constructor(
    private readonly repository: WbRepository,
    private readonly n8n: N8nWbClient,
    appDataDir: string,
    private readonly logger: FastifyBaseLogger,
    options: CatalogServiceOptions = {}
  ) {
    this.now = options.now || (() => new Date());
    this.sleep = options.sleep || ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
    this.setTimer = options.setTimer || ((callback, milliseconds) => setTimeout(callback, milliseconds));
    this.clearTimer = options.clearTimer || clearTimeout;
    this.requestIntervalMs = Math.max(0, options.requestIntervalMs ?? 650);
    this.snapshotsDirectory = path.join(appDataDir, 'wb-catalog', 'snapshots');
    this.onCatalogReady = options.onCatalogReady;
  }

  async start(): Promise<void> {
    if (!this.repository.configured || !this.stopped) return;
    this.stopped = false;
    const lock = await this.repository.acquireCatalogSyncLock();
    if (lock) {
      try {
        await this.pruneSnapshots().catch((error) => this.logger.warn({ err: error }, 'WB 目录快照启动清理失败'));
        const recovered = await this.repository.recoverAbandonedCatalogRuns();
        const overview = await this.repository.catalogOverview();
        const shouldRecover = recovered > 0 || overview.subjectCount === 0 || !fieldDictionariesReady(overview) || overview.latestRun?.status === 'FAILED';
        if (shouldRecover) {
          const created = await this.repository.beginCatalogRun('STARTUP');
          if (created.created) this.launch(created.run, lock);
          else await lock.release();
        } else await lock.release();
      } catch (error) {
        await lock.release().catch(() => undefined);
        this.logger.error({ err: error }, 'WB 目录启动补偿检查失败');
      }
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

  async status(): Promise<WbCatalogStatus> {
    return this.statusFromOverview(await this.repository.catalogOverview());
  }

  async search(queryInput: string, limitInput?: number) {
    const query = String(queryInput || '').trim();
    if (!query || (!/^\d+$/.test(query) && [...query].length < 2)) {
      throw new AppError('CONFIG_INVALID', 'WB 类目搜索词至少需要 2 个字符，或输入完整 subject ID');
    }
    const limit = limitInput === undefined ? 30 : Number(limitInput);
    if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw new AppError('CONFIG_INVALID', 'limit 必须是 1 到 50 的整数');
    const overview = await this.repository.catalogOverview();
    if (overview.subjectCount === 0) {
      throw new AppError('CATALOG_NOT_INITIALIZED', 'WB 本地类目目录尚未初始化，请先执行立即同步', {
        lastErrorCode: overview.latestRun?.errorCode, lastError: overview.latestRun?.errorMessage
      }, 409);
    }
    return { items: await this.repository.searchCatalogSubjects(query, limit), catalog: this.statusFromOverview(overview) };
  }

  async colors(queryInput = '', limitInput?: number) {
    const query = String(queryInput || '').trim();
    const limit = limitInput === undefined ? 1_000 : Number(limitInput);
    if (!Number.isInteger(limit) || limit < 1 || limit > 1_000) throw new AppError('CONFIG_INVALID', 'limit 必须是 1 到 1000 的整数');
    const overview = await this.repository.catalogOverview();
    if (overview.colorCount === 0) {
      throw new AppError('CATALOG_NOT_INITIALIZED', 'WB 本地颜色目录尚未初始化，请先执行立即同步', {
        lastErrorCode: overview.latestRun?.errorCode, lastError: overview.latestRun?.errorMessage
      }, 409);
    }
    return { items: await this.repository.searchCatalogColors(query, limit), catalog: this.statusFromOverview(overview) };
  }

  async dictionary(directoryInput: string, queryInput = '', limitInput?: number) {
    const directory = String(directoryInput || '').trim() as WbCatalogDictionaryName;
    if (!FIELD_DICTIONARIES.includes(directory)) throw new AppError('CONFIG_INVALID', `不支持的 WB 本地字典：${directoryInput}`);
    const query = String(queryInput || '').trim();
    const limit = limitInput === undefined ? 1_000 : Number(limitInput);
    if (!Number.isInteger(limit) || limit < 1 || limit > 1_000) throw new AppError('CONFIG_INVALID', 'limit 必须是 1 到 1000 的整数');
    const overview = await this.repository.catalogOverview();
    if ((overview.dictionaryCounts[directory] || 0) === 0) {
      throw new AppError('CATALOG_NOT_INITIALIZED', `WB 本地 ${directory} 字典尚未初始化，请先执行立即同步`, {
        directory, lastErrorCode: overview.latestRun?.errorCode, lastError: overview.latestRun?.errorMessage
      }, 409);
    }
    const items = directory === 'colors'
      ? (await this.repository.searchCatalogColors(query, limit)).map((item) => ({
          itemKey: item.colorKey, nameRu: item.nameRu, nameZh: item.nameZh,
          fullNameRu: '', fullNameZh: '', parentNameRu: item.parentNameRu, parentNameZh: item.parentNameZh
        }))
      : await this.repository.searchCatalogDictionary(directory, query, limit);
    return { directory, items, catalog: this.statusFromOverview(overview) };
  }

  async triggerManual(): Promise<{ runId: string; status: 'RUNNING'; accepted: boolean }> {
    return this.begin('MANUAL');
  }

  private async begin(trigger: WbCatalogTrigger, scheduleKey?: string): Promise<{ runId: string; status: 'RUNNING'; accepted: boolean }> {
    if (!this.repository.configured) throw new AppError('DATABASE_UNAVAILABLE', 'WB 本地目录需要 PostgreSQL DATABASE_URL', undefined, 503);
    const lock = await this.repository.acquireCatalogSyncLock();
    if (!lock) {
      const current = await this.repository.getRunningCatalogRun();
      if (current) return { runId: current.runId, status: 'RUNNING', accepted: false };
      throw new AppError('TASK_LOCKED', 'WB 目录同步锁正在被其他服务实例占用', undefined, 409);
    }
    try {
      // The session-level advisory lock can only be acquired after every live
      // catalog worker has released it. Any RUNNING row left at this point is
      // therefore abandoned (for example, after another instance crashed).
      await this.repository.recoverAbandonedCatalogRuns();
      const created = await this.repository.beginCatalogRun(trigger, scheduleKey);
      if (!created.created) {
        await lock.release();
        return { runId: created.run.runId, status: 'RUNNING', accepted: false };
      }
      this.launch(created.run, lock);
      return { runId: created.run.runId, status: 'RUNNING', accepted: true };
    } catch (error) {
      await lock.release().catch(() => undefined);
      throw error;
    }
  }

  private launch(run: WbCatalogRun, lock: WbCatalogLock): void {
    const promise = this.execute(run)
      .catch((error) => this.handleRunFailure(run.runId, error))
      .finally(async () => {
        // Keep the advisory lock through the final request cooldown so another
        // A MerchRoute instance cannot start a WB request inside the 650 ms slot.
        await this.waitForRequestCooldown().catch((error) => this.logger.warn({ err: error, runId: run.runId }, 'WB 目录请求冷却等待失败'));
        await lock.release().catch((error) => this.logger.error({ err: error, runId: run.runId }, 'WB 目录同步锁释放失败'));
        if (this.activePromise === promise) this.activePromise = undefined;
      });
    this.activePromise = promise;
  }

  private async execute(run: WbCatalogRun): Promise<void> {
    if (!this.n8n.catalogConfigured) throw new CatalogSyncError('BRIDGE_NOT_CONFIGURED', '未配置 n8n WB 桥接地址或 WB_AUTOMATION_KEY');
    await mkdir(this.snapshotsDirectory, { recursive: true });
    const colorRowsRu = normalizeColors(await this.requestWithRetry(() => this.n8n.getDirectory('colors', { locale: 'ru' })), 'ru');
    const colorRowsZh = normalizeColors(await this.requestWithRetry(() => this.n8n.getDirectory('colors', { locale: 'zh' })), 'zh');
    const colors = mergeColors(colorRowsRu, colorRowsZh);
    if (!colors.length) throw new CatalogSyncError('WB_SYNC_FAILED', 'WB 颜色接口返回空目录，已拒绝覆盖本地颜色快照');
    const countries = mergeCountries(
      normalizeCountries(await this.requestWithRetry(() => this.n8n.getDirectory('countries', { locale: 'ru' })), 'ru'),
      normalizeCountries(await this.requestWithRetry(() => this.n8n.getDirectory('countries', { locale: 'zh' })), 'zh')
    );
    const seasons = mergeFlatDictionary(
      'seasons',
      normalizeFlatDictionary(await this.requestWithRetry(() => this.n8n.getDirectory('seasons', { locale: 'ru' })), 'seasons', 'ru'),
      normalizeFlatDictionary(await this.requestWithRetry(() => this.n8n.getDirectory('seasons', { locale: 'zh' })), 'seasons', 'zh')
    );
    const kinds = mergeFlatDictionary(
      'kinds',
      normalizeFlatDictionary(await this.requestWithRetry(() => this.n8n.getDirectory('kinds', { locale: 'ru' })), 'kinds', 'ru'),
      normalizeFlatDictionary(await this.requestWithRetry(() => this.n8n.getDirectory('kinds', { locale: 'zh' })), 'kinds', 'zh')
    );
    const dictionaryValues = [...countries, ...seasons, ...kinds];
    const parentRowsRu = normalizeParents(await this.requestWithRetry(() => this.n8n.getParentCategories('ru')), 'ru');
    const parentRowsZh = normalizeParents(await this.requestWithRetry(() => this.n8n.getParentCategories('zh')), 'zh');
    if (!parentRowsZh.length) throw new CatalogSyncError('WB_SYNC_FAILED', 'WB 中文父类目接口返回空目录，已拒绝覆盖本地快照');
    const parents = mergeParents(parentRowsRu, parentRowsZh);
    if (!parents.length) throw new CatalogSyncError('WB_SYNC_FAILED', 'WB 父类目接口返回空目录，已拒绝覆盖本地快照');
    await this.repository.updateCatalogRunProgress(run.runId, { totalParents: parents.length });

    const subjectsById = new Map<number, WbCatalogSubjectInput>();
    let zhSubjectCount = 0;
    for (const [parentIndex, parent] of parents.entries()) {
      const localized = new Map<WbLocale, Map<number, LocalizedSubject>>();
      for (const locale of ['ru', 'zh'] as const) {
        const byId = new Map<number, LocalizedSubject>();
        for (let page = 0; page < MAX_PAGES_PER_PARENT; page += 1) {
          const offset = page * PAGE_SIZE;
          const response = await this.requestWithRetry(() => this.n8n.searchSubjects({ parentID: parent.parentId, limit: PAGE_SIZE, offset, locale }));
          const subjects = normalizeSubjects(response, { parentId: parent.parentId, parentName: locale === 'ru' ? parent.nameRu : '' }, locale);
          for (const subject of subjects) {
            const existing = byId.get(subject.subjectId);
            if (existing && stableJson(existing) !== stableJson(subject)) {
              throw new CatalogSyncError('WB_SYNC_FAILED', `subjectID ${subject.subjectId} 在 WB ${locale} 分页结果中存在冲突`);
            }
            byId.set(subject.subjectId, subject);
          }
          await this.repository.updateCatalogRunProgress(run.runId, { processedSubjects: Math.max(subjectsById.size, byId.size) });
          if (subjects.length < PAGE_SIZE) break;
          if (page === MAX_PAGES_PER_PARENT - 1) throw new CatalogSyncError('WB_SYNC_FAILED', `父类目 ${parent.parentId} 的 ${locale} 分页超过安全上限`);
        }
        if (locale === 'zh') zhSubjectCount += byId.size;
        localized.set(locale, byId);
      }
      for (const subject of mergeSubjects(localized.get('ru')!, localized.get('zh')!, parent)) {
        const existing = subjectsById.get(subject.subjectId);
        if (existing && stableJson(existing) !== stableJson(subject)) {
          throw new CatalogSyncError('WB_SYNC_FAILED', `subjectID ${subject.subjectId} 在不同父类目中存在冲突`);
        }
        subjectsById.set(subject.subjectId, subject);
      }
      await this.repository.updateCatalogRunProgress(run.runId, { processedParents: parentIndex + 1, processedSubjects: subjectsById.size });
    }
    if (zhSubjectCount === 0) throw new CatalogSyncError('WB_SYNC_FAILED', 'WB 中文 subject 接口未返回任何目录，已拒绝覆盖本地快照');
    const subjects = [...subjectsById.values()].sort((left, right) => left.subjectId - right.subjectId);
    if (!subjects.length) throw new CatalogSyncError('WB_SYNC_FAILED', 'WB subject 接口返回空目录，已拒绝覆盖本地快照');
    const sortedParents = [...parents].sort((left, right) => left.parentId - right.parentId);
    const dictionaries = { countries, seasons, kinds, colors };
    const sourceHash = `sha256:${createHash('sha256').update(stableJson({ parents: sortedParents, subjects, dictionaries })).digest('hex')}`;
    const generatedAt = this.now().toISOString();
    const fileName = `subjects-ru-zh-${generatedAt.replace(/[:.]/g, '-')}-${run.runId}.json`;
    const finalPath = path.join(this.snapshotsDirectory, fileName);
    const temporaryPath = `${finalPath}.tmp`;
    const snapshot = { schemaVersion: 4, runId: run.runId, generatedAt, locales: ['ru', 'zh'], sourceHash, parents: sortedParents, subjects, dictionaries };
    try {
      await writeFile(temporaryPath, `${JSON.stringify(snapshot, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
      await rename(temporaryPath, finalPath);
      await this.repository.completeCatalogRun(run.runId, sortedParents, subjects, colors, dictionaryValues, finalPath, sourceHash);
    } catch (error) {
      await Promise.all([rm(temporaryPath, { force: true }), rm(finalPath, { force: true })].map((operation) => operation.catch(() => undefined)));
      throw error;
    }
    if (this.onCatalogReady) {
      await this.onCatalogReady(colors.map((color) => ({ colorKey: color.colorKey, nameRu: color.nameRu, nameZh: color.nameZh })))
        .catch((error) => this.logger.warn({ err: error, runId: run.runId }, 'WB 颜色身份历史回填失败'));
    }
    await this.pruneSnapshots().catch((error) => this.logger.warn({ err: error }, 'WB 目录旧快照清理失败'));
    this.logger.info({
      runId: run.runId, parentCount: sortedParents.length, subjectCount: subjects.length,
      dictionaryCounts: { countries: countries.length, seasons: seasons.length, kinds: kinds.length, colors: colors.length }, sourceHash
    }, 'WB 本地类目与字段字典同步完成');
  }

  private async requestWithRetry<T>(operation: () => Promise<T>): Promise<T> {
    let attempt = 0;
    while (true) {
      attempt += 1;
      await this.waitForRequestSlot();
      try { return await operation(); }
      catch (error) {
        const failure = classifyCatalogError(error);
        if (failure.code === 'BRIDGE_NOT_CONFIGURED' || failure.code === 'WB_AUTH_FAILED') throw failure;
        const retryableRateLimit = failure.code === 'WB_RATE_LIMITED' && attempt < 5;
        const retryableNetwork = failure.code === 'WB_NETWORK_ERROR' && attempt < 4;
        if (!retryableRateLimit && !retryableNetwork) throw failure;
        const fallbackDelay = this.requestIntervalMs * Math.max(1, 2 ** (attempt - 1));
        await this.sleep(Math.max(this.requestIntervalMs, failure.retryAfterMs || fallbackDelay));
      }
    }
  }

  private async waitForRequestSlot(): Promise<void> {
    const remaining = this.requestIntervalMs - (this.now().getTime() - this.lastRequestAt);
    if (remaining > 0) await this.sleep(remaining);
    this.lastRequestAt = this.now().getTime();
  }

  private async waitForRequestCooldown(): Promise<void> {
    if (!this.lastRequestAt) return;
    const remaining = this.requestIntervalMs - (this.now().getTime() - this.lastRequestAt);
    if (remaining > 0) await this.sleep(remaining);
  }

  private async handleRunFailure(runId: string, error: unknown): Promise<void> {
    const failure = classifyCatalogError(error);
    await this.repository.failCatalogRun(runId, failure.code, failure.message).catch((markError) => {
      this.logger.error({ err: markError, runId, originalError: error }, '无法标记 WB 目录同步失败');
    });
    this.logger.error({ err: error, runId, errorCode: failure.code }, 'WB 本地类目目录同步失败');
  }

  private statusFromOverview(overview: WbCatalogOverview): WbCatalogStatus {
    const lastSuccessfulMs = overview.lastSuccessfulAt ? Date.parse(overview.lastSuccessfulAt) : Number.NaN;
    const isStale = Number.isFinite(lastSuccessfulMs) && this.now().getTime() - lastSuccessfulMs > STALE_MS;
    const latestFailed = overview.latestRun?.status === 'FAILED';
    const status: CatalogStatus = overview.currentRun ? 'SYNCING'
      : overview.subjectCount === 0 || !fieldDictionariesReady(overview) ? latestFailed ? 'FAILED' : 'EMPTY'
        : latestFailed ? 'FAILED' : isStale ? 'STALE' : 'READY';
    return {
      status, subjectCount: overview.subjectCount, parentCount: overview.parentCount, colorCount: overview.colorCount,
      dictionaryCounts: overview.dictionaryCounts,
      ...(overview.lastSuccessfulAt ? { lastSuccessfulAt: overview.lastSuccessfulAt } : {}),
      ...(latestFailed && overview.latestRun?.errorMessage ? { lastError: overview.latestRun.errorMessage } : {}),
      ...(latestFailed && isCatalogErrorCode(overview.latestRun?.errorCode) ? { lastErrorCode: overview.latestRun.errorCode } : {}),
      ...(overview.currentRun ? { currentRun: currentRunView(overview.currentRun) } : {}),
      nextScheduledAt: nextMondayAtTen(this.now()).toISOString(), isStale
    };
  }

  private scheduleNextWeeklyRun(): void {
    if (this.stopped) return;
    if (this.scheduleTimer) this.clearTimer(this.scheduleTimer);
    const target = nextMondayAtTen(this.now());
    const delay = Math.max(1, target.getTime() - this.now().getTime());
    this.scheduleTimer = this.setTimer(() => {
      this.scheduleTimer = undefined;
      if (this.stopped) return;
      void this.begin('SCHEDULED', shanghaiWeekKey(target)).catch((error) => this.logger.error({ err: error }, 'WB 目录周计划启动失败'));
      this.scheduleNextWeeklyRun();
    }, delay);
    this.scheduleTimer.unref?.();
  }

  private async pruneSnapshots(): Promise<void> {
    await mkdir(this.snapshotsDirectory, { recursive: true });
    const retained = new Set((await this.repository.listSuccessfulCatalogSnapshotPaths(7)).map((filePath) => path.resolve(filePath)));
    const names = (await readdir(this.snapshotsDirectory)).filter((name) => name.endsWith('.json'));
    await Promise.all(names
      .map((name) => path.join(this.snapshotsDirectory, name))
      .filter((filePath) => !retained.has(path.resolve(filePath)))
      .map((filePath) => rm(filePath, { force: true })));
  }
}

class CatalogSyncError extends Error {
  constructor(public readonly code: CatalogErrorCode, message: string, public readonly retryAfterMs?: number) {
    super(message);
    this.name = 'CatalogSyncError';
  }
}

export function classifyCatalogError(error: unknown): CatalogSyncError {
  if (error instanceof CatalogSyncError) return error;
  const message = error instanceof Error ? error.message : String(error || 'WB 目录同步失败');
  const details = error instanceof AppError ? error.details : undefined;
  const detailsText = safeJson(details).toLocaleLowerCase('en-US');
  const status = findNumericField(details, 'httpStatus') || statusFromText(message) || findNumericField(details, 'statusCode');
  const retryAfterMs = findNumericField(details, 'retryAfterMs');
  if (/未配置.*(?:WB|n8n)|桥接地址或密钥/i.test(message)) return new CatalogSyncError('BRIDGE_NOT_CONFIGURED', message);
  const errorText = `${message} ${detailsText}`;
  if (/(?:wb_auth_error|wb_auth_failed)/i.test(errorText)) {
    return new CatalogSyncError('WB_AUTH_FAILED', message);
  }
  if ([401, 403].some((code) => containsNumericField(details, 'httpStatus', code) || containsNumericField(details, 'statusCode', code))
    || /(?:unauthorized|forbidden)/i.test(errorText)) {
    return new CatalogSyncError('BRIDGE_NOT_CONFIGURED', 'n8n WB 桥接认证失败，请检查 WB_AUTOMATION_KEY');
  }
  if (/(?:invalid.?token|WB Token|WB.*认证|WB.*授权)/i.test(errorText)) return new CatalogSyncError('WB_AUTH_FAILED', message);
  if (containsNumericField(details, 'httpStatus', 429) || containsNumericField(details, 'statusCode', 429)
    || status === 429 || /(?:wb_rate_limited|rate.?limit|too many requests|限频)/i.test(`${message} ${detailsText}`)) {
    return new CatalogSyncError('WB_RATE_LIMITED', message, retryAfterMs);
  }
  if ((status !== undefined && status >= 500) || Boolean(details?.deliveryUnknown) || /(?:network|fetch failed|timeout|网络)/i.test(message)) {
    return new CatalogSyncError('WB_NETWORK_ERROR', message, retryAfterMs);
  }
  return new CatalogSyncError('WB_SYNC_FAILED', message, retryAfterMs);
}

export function nextMondayAtTen(now: Date): Date {
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

export function shanghaiWeekKey(input: Date): string {
  const local = new Date(input.getTime() + SHANGHAI_OFFSET_MS);
  const day = local.getUTCDay();
  const mondayOffset = day === 0 ? -6 : 1 - day;
  const monday = new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate() + mondayOffset));
  return monday.toISOString().slice(0, 10);
}

type LocalizedParent = { parentId: number; name: string; isVisible: boolean };
type LocalizedSubject = { subjectId: number; subjectName: string; parentId: number; parentName: string };
type LocalizedColor = { name: string; parentName: string };
type LocalizedCountry = { wbId: number; name: string; fullName: string };

function normalizeColors(input: unknown, locale: WbLocale): LocalizedColor[] {
  const rows = extractArray(input).map((value, index) => {
    const row = asObject(value);
    const name = stringValue(row.name);
    const parentName = typeof row.parentName === 'string' ? row.parentName.trim() : '';
    if (!name) throw new CatalogSyncError('WB_SYNC_FAILED', `WB ${locale} 颜色目录第 ${index + 1} 行缺少 name`);
    return { name, parentName };
  });
  // WB 的中文翻译不是唯一标识：不同俄文颜色可能被翻译成相同中文名称。
  // 颜色身份以俄文目录为准，中文目录仅用于展示和搜索。
  if (locale === 'ru') {
    const unique = new Set(rows.map((row) => `${row.parentName}\u0000${row.name}`));
    if (unique.size !== rows.length) throw new CatalogSyncError('WB_SYNC_FAILED', 'WB ru 颜色目录存在重复颜色');
  }
  return rows;
}

function mergeColors(ruRows: LocalizedColor[], zhRows: LocalizedColor[]): WbCatalogColorInput[] {
  if (!ruRows.length || ruRows.length !== zhRows.length) {
    throw new CatalogSyncError('WB_SYNC_FAILED', `WB 中俄颜色目录数量不一致（ru=${ruRows.length}, zh=${zhRows.length}），已拒绝按位置配对`);
  }
  return ruRows.map((ru, position) => {
    const zh = zhRows[position]!;
    const colorKey = createHash('sha256').update(`${ru.parentName}\u0000${ru.name}`).digest('hex');
    return { colorKey, position, nameRu: ru.name, nameZh: zh.name, parentNameRu: ru.parentName, parentNameZh: zh.parentName };
  });
}

function normalizeCountries(input: unknown, locale: WbLocale): LocalizedCountry[] {
  const byId = new Map<number, LocalizedCountry>();
  for (const [index, value] of extractArray(input).entries()) {
    const row = asObject(value);
    const wbId = positiveInteger(row.id);
    const name = stringValue(row.name) || '';
    const fullName = stringValue(row.fullName) || '';
    if (!wbId || !name) throw new CatalogSyncError('WB_SYNC_FAILED', `WB ${locale} countries 第 ${index + 1} 行缺少有效 id 或 name`);
    const item = { wbId, name, fullName };
    const existing = byId.get(wbId);
    if (existing && stableJson(existing) !== stableJson(item)) throw new CatalogSyncError('WB_SYNC_FAILED', `WB ${locale} countries 的 ID ${wbId} 存在冲突`);
    byId.set(wbId, item);
  }
  return [...byId.values()];
}

function mergeCountries(ruRows: LocalizedCountry[], zhRows: LocalizedCountry[]): WbCatalogDictionaryValueInput[] {
  if (!ruRows.length || ruRows.length !== zhRows.length) {
    throw new CatalogSyncError('WB_SYNC_FAILED', `WB 中俄 countries 数量不一致（ru=${ruRows.length}, zh=${zhRows.length}）`);
  }
  const zhById = new Map(zhRows.map((row) => [row.wbId, row]));
  return ruRows.map((ru, position) => {
    const zh = zhById.get(ru.wbId);
    if (!zh) throw new CatalogSyncError('WB_SYNC_FAILED', `WB 中文 countries 缺少国家 ID ${ru.wbId}`);
    return {
      directory: 'countries', valueKey: String(ru.wbId), position, wbId: ru.wbId,
      nameRu: ru.name, nameZh: zh.name, fullNameRu: ru.fullName, fullNameZh: zh.fullName
    };
  });
}

function normalizeFlatDictionary(input: unknown, directory: 'seasons' | 'kinds', locale: WbLocale): string[] {
  const rows = extractArray(input).map((value, index) => {
    const name = stringValue(value);
    if (!name) throw new CatalogSyncError('WB_SYNC_FAILED', `WB ${locale} ${directory} 第 ${index + 1} 行不是有效字符串`);
    return name;
  });
  if (locale === 'ru' && new Set(rows).size !== rows.length) throw new CatalogSyncError('WB_SYNC_FAILED', `WB ru ${directory} 存在重复值`);
  return rows;
}

function mergeFlatDictionary(
  directory: 'seasons' | 'kinds', ruRows: string[], zhRows: string[]
): WbCatalogDictionaryValueInput[] {
  if (!ruRows.length || ruRows.length !== zhRows.length) {
    throw new CatalogSyncError('WB_SYNC_FAILED', `WB 中俄 ${directory} 数量不一致（ru=${ruRows.length}, zh=${zhRows.length}）`);
  }
  return ruRows.map((nameRu, position) => ({
    directory,
    valueKey: createHash('sha256').update(`${directory}\u0000${nameRu}`).digest('hex'),
    position,
    nameRu,
    nameZh: zhRows[position]!,
    fullNameRu: '',
    fullNameZh: ''
  }));
}

function fieldDictionariesReady(overview: WbCatalogOverview): boolean {
  return FIELD_DICTIONARIES.every((directory) => (overview.dictionaryCounts[directory] || 0) > 0);
}

function normalizeParents(input: unknown, locale: WbLocale): LocalizedParent[] {
  const map = new Map<number, LocalizedParent>();
  for (const value of extractArray(input)) {
    const row = asObject(value);
    const parentId = positiveInteger(row.id ?? row.parentID ?? row.parentId);
    const name = stringValue(row.name ?? row.parentName ?? (locale === 'ru' ? row.nameRu : row.nameZh)) || '';
    if (!parentId || (locale === 'ru' && !name)) {
      throw new CatalogSyncError('WB_SYNC_FAILED', `WB ${locale} 父类目响应缺少有效 id${locale === 'ru' ? ' 或俄文名称' : ''}`);
    }
    const item = { parentId, name, isVisible: row.isVisible !== false };
    const existing = map.get(parentId);
    if (existing && stableJson(existing) !== stableJson(item)) throw new CatalogSyncError('WB_SYNC_FAILED', `父类目 ID ${parentId} 在 WB ${locale} 响应中存在冲突`);
    map.set(parentId, item);
  }
  return [...map.values()];
}

function mergeParents(ruRows: LocalizedParent[], zhRows: LocalizedParent[]): WbCatalogParentInput[] {
  const zhById = new Map(zhRows.map((row) => [row.parentId, row]));
  return ruRows.map((ru) => ({
    parentId: ru.parentId,
    nameRu: ru.name,
    nameZh: zhById.get(ru.parentId)?.name || '',
    isVisible: ru.isVisible
  }));
}

function normalizeSubjects(
  input: unknown,
  fallbackParent: { parentId: number; parentName: string },
  locale: WbLocale
): LocalizedSubject[] {
  return extractArray(input).map((value) => {
    const row = asObject(value);
    const subjectId = positiveInteger(row.subjectID ?? row.subjectId ?? row.id);
    const subjectName = stringValue(row.subjectName ?? row.name ?? (locale === 'ru' ? row.nameRu : row.nameZh)) || '';
    const parentId = positiveInteger(row.parentID ?? row.parentId) || fallbackParent.parentId;
    const parentName = stringValue(row.parentName) || fallbackParent.parentName;
    if (!subjectId || (locale === 'ru' && !subjectName) || parentId !== fallbackParent.parentId) {
      throw new CatalogSyncError('WB_SYNC_FAILED', `父类目 ${fallbackParent.parentId} 的 ${locale} subject 分页响应格式无效`);
    }
    return { subjectId, subjectName, parentId, parentName };
  });
}

function mergeSubjects(
  ruById: Map<number, LocalizedSubject>,
  zhById: Map<number, LocalizedSubject>,
  parent: WbCatalogParentInput
): WbCatalogSubjectInput[] {
  return [...ruById.values()].map((ru) => {
    const zh = zhById.get(ru.subjectId);
    return {
      subjectId: ru.subjectId,
      subjectNameRu: ru.subjectName,
      subjectNameZh: zh?.subjectName || '',
      parentId: ru.parentId,
      parentNameRu: ru.parentName || parent.nameRu,
      parentNameZh: zh?.parentName || ''
    };
  });
}

function extractArray(input: unknown): unknown[] {
  if (Array.isArray(input)) return input;
  const row = asObject(input);
  for (const key of ['items', 'data', 'result', 'subjects', 'parents']) {
    const candidate = row[key];
    if (Array.isArray(candidate)) return candidate;
    if (candidate && typeof candidate === 'object') {
      const nested = extractArray(candidate);
      if (nested.length) return nested;
    }
  }
  return [];
}

function currentRunView(run: WbCatalogRun): WbCatalogStatus['currentRun'] {
  return {
    runId: run.runId, trigger: run.trigger, status: 'RUNNING', startedAt: run.startedAt,
    processedParents: run.processedParents, totalParents: run.totalParents, processedSubjects: run.processedSubjects
  };
}

function isCatalogErrorCode(value: unknown): value is CatalogErrorCode {
  return ['BRIDGE_NOT_CONFIGURED', 'WB_AUTH_FAILED', 'WB_RATE_LIMITED', 'WB_NETWORK_ERROR', 'WB_SYNC_FAILED'].includes(String(value));
}

function findNumericField(input: unknown, key: string): number | undefined {
  if (!input || typeof input !== 'object') return undefined;
  if (Array.isArray(input)) {
    for (const item of input) {
      const found = findNumericField(item, key);
      if (found !== undefined) return found;
    }
    return undefined;
  }
  const row = input as Record<string, unknown>;
  const direct = Number(row[key]);
  if (Number.isFinite(direct) && direct > 0) return direct;
  for (const value of Object.values(row)) {
    const found = findNumericField(value, key);
    if (found !== undefined) return found;
  }
  return undefined;
}

function containsNumericField(input: unknown, key: string, expected: number): boolean {
  if (!input || typeof input !== 'object') return false;
  if (Array.isArray(input)) return input.some((item) => containsNumericField(item, key, expected));
  const row = input as Record<string, unknown>;
  if (Number(row[key]) === expected) return true;
  return Object.values(row).some((value) => containsNumericField(value, key, expected));
}

function safeJson(input: unknown): string {
  try { return JSON.stringify(input) || ''; }
  catch { return ''; }
}

function statusFromText(message: string): number | undefined {
  const match = /HTTP\s+(\d{3})/i.exec(message);
  return match ? Number(match[1]) : undefined;
}

function positiveInteger(value: unknown): number | undefined {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(',')}}`;
  return JSON.stringify(value);
}
