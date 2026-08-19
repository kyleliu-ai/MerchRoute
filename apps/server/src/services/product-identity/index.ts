import {
  AppError,
  withWorkflowProductIdentity,
  withWorkflowTaskIdentity,
  type PendingSubmission,
  type ProductIdentity,
  type ProductIdentitySource,
  type TaskDetail,
  type WorkflowParameters
} from '@n8n-media-review/shared';
import type { PurchaseRepository, ProductIdentityRecord } from '../../repositories/purchases.js';
import type { StateStore } from '../../repositories/store.js';

type IdentityTask = Pick<TaskDetail, 'taskId' | 'stageId' | 'sourceFolder' | 'sourceFolderName' | 'taskContext'>;

export class ProductIdentityService {
  constructor(private readonly purchases: PurchaseRepository, private readonly store: StateStore) {}

  async resolveTask(task: IdentityTask): Promise<ProductIdentity> {
    const review = this.store.read().reviews.find((item) => item.taskId === task.taskId);
    if (!this.purchases.configured) return this.databaseUnavailable(review?.productSku, review?.productNameSnapshot);
    try {
      if (review?.productSku) {
        const confirmed = await this.purchases.getProductIdentityBySku(review.productSku);
        if (confirmed) return this.resolved(confirmed, review.productIdentitySource || 'USER_CONFIRMED');
      }

      if (task.taskContext?.SKU) {
        const contextual = await this.purchases.getProductIdentityBySku(task.taskContext.SKU);
        if (contextual) return this.resolved(contextual, 'TASK_CONTEXT');
      }

      const downloaded = await this.purchases.findProductIdentityByDownloadOutputDir(task.sourceFolder);
      if (downloaded) return this.resolved(downloaded, 'DOWNLOAD_OUTPUT_DIR');

      const prefixedSku = task.sourceFolderName.match(/^(\d{7})(?!\d)/)?.[1];
      if (prefixedSku) {
        const prefixed = await this.purchases.getProductIdentityBySku(prefixedSku);
        if (prefixed) return this.resolved(prefixed, 'SKU_PREFIX');
      }

      const nameMatches = await this.purchases.findProductIdentitiesByFolderName(task.sourceFolderName);
      if (nameMatches.length === 1) return this.resolved(nameMatches[0]!, 'PRODUCT_NAME_PREFIX');
      if (nameMatches.length > 1) {
        return { status: 'AMBIGUOUS', candidates: nameMatches, message: '目录名称匹配到多个采购产品，请人工选择 SKU' };
      }
      return { status: 'UNRESOLVED', message: '无法从下载记录或目录名称唯一识别采购 SKU，请人工选择' };
    } catch {
      return this.databaseUnavailable(review?.productSku, review?.productNameSnapshot);
    }
  }

  async assignTask(task: IdentityTask, sku: string): Promise<ProductIdentity> {
    if (!/^\d{7}$/.test(String(sku || '').trim())) throw new AppError('CONFIG_INVALID', 'SKU 必须是 7 位数字字符串', { sku });
    if (this.store.read().pendingSubmissions.some((item) => item.taskId === task.taskId && item.status === 'PACKAGING')) {
      throw new AppError('TASK_LOCKED', '任务已进入打包状态，不能重新关联产品身份', { taskId: task.taskId }, 409);
    }
    const product = await this.requireProduct(sku);
    const now = new Date().toISOString();
    await this.store.update((db) => {
      let review = db.reviews.find((item) => item.taskId === task.taskId);
      if (!review) {
        review = {
          taskId: task.taskId, stageId: task.stageId, sourceFolder: task.sourceFolder, sourceFolderName: task.sourceFolderName,
          selectedRelativePaths: [], selectedTargetStageIds: [], status: 'DRAFT', createdAt: now, updatedAt: now
        };
        db.reviews.push(review);
      }
      Object.assign(review, { productSku: product.sku, productNameSnapshot: product.productName, productIdentitySource: 'USER_CONFIRMED', updatedAt: now });
      for (const pending of db.pendingSubmissions.filter((item) => item.taskId === task.taskId)) {
        pending.productSku = product.sku;
        pending.productNameSnapshot = product.productName;
        pending.n8nTaskParameters = pending.variantName ? this.injectVariant(pending.n8nTaskParameters, product, pending.variantName) : this.inject(pending.n8nTaskParameters, product);
        pending.updatedAt = now;
      }
    });
    return this.resolved(product, 'USER_CONFIRMED');
  }

  async requireResolvedTask(task: IdentityTask): Promise<{ identity: ProductIdentityRecord; source: ProductIdentitySource }> {
    const identity = await this.resolveTask(task);
    if (identity.status === 'DATABASE_UNAVAILABLE') throw new AppError('DATABASE_UNAVAILABLE', 'PostgreSQL 不可用，无法校验产品身份', undefined, 503);
    if (identity.status !== 'RESOLVED' || !identity.sku || !identity.productName || !identity.source) {
      throw new AppError('PRODUCT_IDENTITY_REQUIRED', identity.message || '请先关联采购 SKU', { status: identity.status, candidates: identity.candidates }, 409);
    }
    const product = await this.requireProduct(identity.sku);
    return { identity: product, source: identity.source };
  }

  async requirePendingIdentity(pending: Pick<PendingSubmission, 'id' | 'productSku'>): Promise<ProductIdentityRecord> {
    if (!pending.productSku) throw new AppError('PRODUCT_IDENTITY_REQUIRED', '待投递任务尚未关联采购 SKU', { pendingSubmissionId: pending.id }, 409);
    return this.requireProduct(pending.productSku);
  }

  inject(parameters: WorkflowParameters, identity: ProductIdentityRecord): WorkflowParameters {
    return withWorkflowProductIdentity(parameters || {}, identity.sku, identity.productName);
  }

  injectVariant(parameters: WorkflowParameters, identity: ProductIdentityRecord, variantName: string): WorkflowParameters {
    return withWorkflowTaskIdentity(parameters || {}, identity.sku, identity.productName, variantName);
  }

  async backfillLegacyPending(): Promise<void> {
    if (!this.purchases.configured) return;
    const snapshot = this.store.read();
    const updates = new Map<string, { identity: ProductIdentityRecord; source: ProductIdentitySource }>();
    for (const pending of snapshot.pendingSubmissions.filter((item) => !item.productSku)) {
      const review = snapshot.reviews.find((item) => item.taskId === pending.taskId);
      if (!review) continue;
      const resolved = await this.requireResolvedTask(review).catch(() => undefined);
      if (resolved) updates.set(pending.id, resolved);
    }
    if (!updates.size) return;
    await this.store.update((db) => {
      for (const pending of db.pendingSubmissions) {
        const update = updates.get(pending.id);
        if (!update) continue;
        pending.productSku = update.identity.sku;
        pending.productNameSnapshot = update.identity.productName;
        pending.n8nTaskParameters = pending.variantName ? this.injectVariant(pending.n8nTaskParameters, update.identity, pending.variantName) : this.inject(pending.n8nTaskParameters, update.identity);
        const review = db.reviews.find((item) => item.taskId === pending.taskId);
        if (review) Object.assign(review, { productSku: update.identity.sku, productNameSnapshot: update.identity.productName, productIdentitySource: update.source });
      }
    });
  }

  async backfillLegacyVariants(): Promise<void> {
    if (!this.purchases.configured) return;
    const snapshot = this.store.read();
    const bySku = new Map<string, ProductIdentityRecord>();
    for (const pending of snapshot.pendingSubmissions.filter((item) => item.productSku && !item.variantName)) {
      if (!bySku.has(pending.productSku!)) {
        const product = await this.requireProduct(pending.productSku!);
        const [variant] = await this.purchases.ensureProductVariants(product.sku, ['默认变体']);
        bySku.set(product.sku, { ...product, variants: variant ? [...product.variants.filter((item) => item.variantId !== variant.variantId), variant] : product.variants });
      }
    }
    if (!bySku.size) return;
    await this.store.update((db) => {
      for (const pending of db.pendingSubmissions) {
        if (!pending.productSku || pending.variantName) continue;
        const product = bySku.get(pending.productSku);
        const variant = product?.variants.find((item) => item.name === '默认变体');
        if (!product || !variant) continue;
        pending.variantId = variant.variantId;
        pending.variantName = variant.name;
        pending.n8nTaskParameters = this.injectVariant(pending.n8nTaskParameters, product, variant.name);
      }
    });
  }

  private async requireProduct(sku: string): Promise<ProductIdentityRecord> {
    if (!this.purchases.configured) throw new AppError('DATABASE_UNAVAILABLE', 'PostgreSQL 不可用，无法校验采购 SKU', undefined, 503);
    let product: ProductIdentityRecord | undefined;
    try {
      product = await this.purchases.getProductIdentityBySku(String(sku).trim());
    } catch {
      throw new AppError('DATABASE_UNAVAILABLE', 'PostgreSQL 不可用，无法校验采购 SKU', undefined, 503);
    }
    if (!product) throw new AppError('PRODUCT_NOT_FOUND', '采购产品已不存在，不能生成工作流参数文件', { sku }, 409);
    return product;
  }

  private resolved(identity: ProductIdentityRecord, source: ProductIdentitySource): ProductIdentity {
    return { status: 'RESOLVED', sku: identity.sku, productName: identity.productName, variants: identity.variants.map((item) => item.name), variantDetails: identity.variants, source };
  }

  private databaseUnavailable(sku?: string, productName?: string): ProductIdentity {
    return { status: 'DATABASE_UNAVAILABLE', sku, productName, message: 'PostgreSQL 不可用，暂时不能确认或投递产品身份' };
  }
}
