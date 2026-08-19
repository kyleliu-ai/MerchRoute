import type { FastifyBaseLogger } from 'fastify';
import { randomUUID } from 'node:crypto';
import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { IMAGE_EXTENSIONS } from '@n8n-media-review/shared';
import { PurchaseRepository, type WorkflowInput } from '../../repositories/purchases.js';
import { assertSafeDownloadRoot, isPathSafelyContained, type DownloadPathInspection } from '../../utils/download-path-safety.js';

export function isDownloadProfileBusyResult(workflowCode: string, payload: Record<string, unknown>): boolean {
  return ['E006', 'E007'].includes(workflowCode)
    && payload.status === 'profile_busy'
    && (payload.browserProfileBusy === true || Number(payload.httpStatus) === 409);
}

export function isE007ProfileBusyResult(workflowCode: string, payload: Record<string, unknown>): boolean {
  return workflowCode === 'E007' && isDownloadProfileBusyResult(workflowCode, payload);
}

type DownloadWorkerOptions = {
  leaseDurationMs?: number;
  heartbeatIntervalMs?: number;
  recoveryGraceMs?: number;
  recoveryRetryMinMs?: number;
  recoveryRetryMaxMs?: number;
  sleep?: (delayMs: number) => Promise<void>;
};

const DEFAULT_WORKER_OPTIONS = {
  leaseDurationMs: 90_000,
  heartbeatIntervalMs: 30_000,
  recoveryGraceMs: 180_000,
  recoveryRetryMinMs: 2_000,
  recoveryRetryMaxMs: 30_000
} as const;

export class DownloadWorker {
  private processing = false;
  private stopped = true;
  private timer?: NodeJS.Timeout;
  private readonly workerId = randomUUID();
  private readonly options: Required<DownloadWorkerOptions>;

  constructor(
    private readonly purchases: PurchaseRepository,
    private readonly logger: FastifyBaseLogger,
    private readonly authoritativeWorkflows: () => WorkflowInput[] = () => [],
    options: DownloadWorkerOptions = {}
  ) {
    this.options = {
      ...DEFAULT_WORKER_OPTIONS,
      ...options,
      sleep: options.sleep || ((delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs)))
    };
  }

  start() {
    if (!this.purchases.configured || !this.stopped) return;
    this.stopped = false;
    this.timer = setInterval(() => { void this.processNext(); }, 2_000);
    void this.processNext();
  }

  stop() {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  async processNext() {
    if (this.processing || this.stopped || !this.purchases.configured) return;
    this.processing = true;
    try {
      while (!this.stopped) {
        const job = await this.purchases.claimNextJob(this.workerId, this.options.leaseDurationMs);
        if (!job) break;
        const leaseToken = job.leaseToken;
        const leaseState = { lost: false, renewing: false };
        const heartbeat = setInterval(() => {
          if (leaseState.renewing || leaseState.lost) return;
          leaseState.renewing = true;
          void this.purchases.renewJobLease(job.id, this.workerId, leaseToken, this.options.leaseDurationMs)
            .then((renewed) => { if (!renewed) leaseState.lost = true; })
            .catch((error) => {
              this.logger.error({ err: error, jobId: job.id }, '下载任务租约续期失败');
            })
            .finally(() => { leaseState.renewing = false; });
        }, this.options.heartbeatIntervalMs);
        heartbeat.unref?.();
        try {
          const snapshot = job.workflowSnapshot as { webhookUrl?: string; timeoutMs?: number; parentOutputDir?: string; recoveryMode?: 'MANUAL' | 'IDEMPOTENT_REPLAY' };
          if (String((job.requestBody as Record<string, unknown>).downloadJobId || '') !== job.id) {
            await this.purchases.completeJob(job.id, {
              success: false,
              status: 'invalid_download_job_id',
              httpStatus: 409,
              errors: ['下载任务缺少与数据库任务 ID 一致的 downloadJobId，已阻止调用 Webhook']
            }, leaseToken);
            continue;
          }
          const destinationFailure = await this.validateDestination(job.workflowCode, job.requestBody, snapshot).catch((error) => ({
            success: false,
            status: 'unsafe_download_destination',
            httpStatus: 409,
            parentOutputDir: String((job.requestBody as Record<string, unknown>)?.parentOutputDir || ''),
            errors: [error instanceof Error ? error.message : '下载保存目录校验失败']
          }));
          if (destinationFailure) {
            this.logger.error({ jobId: job.id, sku: job.sku, workflowCode: job.workflowCode, result: destinationFailure }, '已拦截不安全的下载目录');
            await this.purchases.completeJob(job.id, destinationFailure, leaseToken);
            continue;
          }
          let payload = await this.invokeUntilTerminal(job, snapshot, leaseToken, leaseState);
          if (leaseState.lost) {
            this.logger.info({ jobId: job.id, sku: job.sku }, '下载任务租约已转移，忽略当前 Worker 的迟到响应');
            continue;
          }
          if (payload.success !== false) {
            const outputFailure = await validateDownloadOutput(String((job.requestBody as Record<string, unknown>).parentOutputDir || ''), payload);
            if (outputFailure) payload = outputFailure;
          }
          if (isDownloadProfileBusyResult(job.workflowCode, payload)) {
            const waiting = await this.purchases.deferResourceJob(job.id, payload, leaseToken);
            if (waiting.status === 'WAITING_RESOURCE') {
              this.logger.info({ jobId: job.id, sku: job.sku, workflowCode: job.workflowCode, nextAttemptAt: waiting.nextAttemptAt, resourceRetryCount: waiting.resourceRetryCount }, '专用下载浏览器被占用，下载任务等待重试');
            } else {
              this.logger.info({ jobId: job.id, sku: job.sku, status: waiting.status }, '下载任务租约已转移，忽略资源等待迟到响应');
            }
          } else {
            const applied = await this.purchases.completeJob(job.id, payload, leaseToken);
            if (!applied) this.logger.info({ jobId: job.id, sku: job.sku }, '下载任务租约已转移，忽略结算迟到响应');
          }
        } catch (error) {
          const failureMessage = error instanceof Error ? error.message : '下载工作流调用失败';
          this.logger.error({ err: error, jobId: job.id }, '下载工作流调用失败');
          try { await this.purchases.failJob(job.id, failureMessage, leaseToken); }
          catch (markError) { this.logger.error({ err: markError, jobId: job.id }, '无法标记下载任务失败'); }
        } finally {
          clearInterval(heartbeat);
        }
      }
    } catch (error) {
      this.logger.error({ err: error }, '下载队列处理失败');
    } finally {
      this.processing = false;
    }
  }

  private async invokeUntilTerminal(
    job: Awaited<ReturnType<PurchaseRepository['claimNextJob']>> & {},
    snapshot: { webhookUrl?: string; timeoutMs?: number; recoveryMode?: 'MANUAL' | 'IDEMPOTENT_REPLAY' },
    leaseToken: string,
    leaseState: { lost: boolean }
  ): Promise<Record<string, unknown>> {
    const timeoutMs = Number(snapshot.timeoutMs || 900_000);
    const recoveryMode = job.recoveryMode || snapshot.recoveryMode || 'MANUAL';
    const startedAt = job.startedAt ? new Date(job.startedAt).getTime() : Date.now();
    const deadline = startedAt + timeoutMs + this.options.recoveryGraceMs;
    let retryDelayMs = this.options.recoveryRetryMinMs;
    let requestCount = 0;
    let lastTransportError = '';

    while (!leaseState.lost) {
      requestCount += 1;
      try {
        const remainingMs = Math.max(1_000, deadline - Date.now());
        const response = await fetch(String(snapshot.webhookUrl || ''), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(job.requestBody),
          signal: AbortSignal.timeout(Math.min(timeoutMs, remainingMs))
        });
        const payload = parseWebhookPayload(await response.text(), response.status);
        if (recoveryMode === 'IDEMPOTENT_REPLAY' && payload.downloadJobId !== job.id) {
          return {
            success: false,
            status: 'idempotency_protocol_error',
            idempotencyState: 'failed',
            errors: [`Webhook 回执 downloadJobId 与当前任务不一致：expected=${job.id}`]
          };
        }
        if (recoveryMode === 'IDEMPOTENT_REPLAY') {
          const idempotencyState = payload.idempotencyState;
          const validState = response.status === 202
            ? idempotencyState === 'running'
            : ['succeeded', 'failed', 'retryable'].includes(String(idempotencyState || ''));
          const consistentOutcome = idempotencyState === 'succeeded'
            ? payload.success === true && response.ok && response.status !== 202
            : idempotencyState === 'failed' || idempotencyState === 'retryable'
              ? payload.success === false && !response.ok
              : response.status === 202 && idempotencyState === 'running' && payload.success === false;
          const completeEnvelope = typeof payload.idempotencyReplay === 'boolean'
            && typeof payload.ownerN8nExecutionId === 'string' && payload.ownerN8nExecutionId.trim().length > 0
            && typeof payload.requestN8nExecutionId === 'string' && payload.requestN8nExecutionId.trim().length > 0;
          if (!validState || !consistentOutcome || !completeEnvelope) {
            return {
              success: false,
              status: 'idempotency_protocol_error',
              idempotencyState: 'failed',
              errors: [`Webhook 幂等回执状态不完整或自相矛盾：HTTP ${response.status}`]
            };
          }
        }
        if (response.status === 202 && payload.idempotencyState === 'running') {
          if (recoveryMode !== 'IDEMPOTENT_REPLAY') {
            return {
              ...payload,
              success: false,
              status: 'idempotency_replay_disabled',
              errors: ['工作流仍在执行，但当前下载配置未启用幂等重放']
            };
          }
          await this.markRecovering(job.id, leaseToken, leaseState);
          if (Date.now() >= deadline) return recoveryTimeoutPayload(lastTransportError);
          const retryAfterMs = clampRetryDelay(payload.retryAfterMs, this.options.recoveryRetryMinMs, this.options.recoveryRetryMaxMs);
          await this.options.sleep(retryAfterMs);
          continue;
        }
        if (response.status === 202) {
          return {
            ...payload,
            success: false,
            status: 'invalid_idempotency_response',
            errors: ['Webhook 返回 HTTP 202，但缺少 idempotencyState=running']
          };
        }
        if (!response.ok) {
          return {
            ...payload,
            success: false,
            errors: [`HTTP ${response.status}`, ...(Array.isArray(payload.errors) ? payload.errors : [])]
          };
        }
        return payload;
      } catch (error) {
        lastTransportError = error instanceof Error ? error.message : String(error);
        if (recoveryMode !== 'IDEMPOTENT_REPLAY') throw error;
        await this.markRecovering(job.id, leaseToken, leaseState);
        if (leaseState.lost) break;
        if (Date.now() >= deadline) return recoveryTimeoutPayload(lastTransportError);
        this.logger.info({ jobId: job.id, requestCount, retryDelayMs, err: error }, '下载 Webhook 连接状态不确定，使用相同 downloadJobId 核验');
        await this.options.sleep(retryDelayMs);
        retryDelayMs = Math.min(this.options.recoveryRetryMaxMs, Math.max(this.options.recoveryRetryMinMs, retryDelayMs * 2));
      }
    }
    return recoveryTimeoutPayload('下载任务租约已转移');
  }

  private async markRecovering(id: string, leaseToken: string, leaseState: { lost: boolean }): Promise<void> {
    const applied = await this.purchases.markJobRecovering(id, this.workerId, leaseToken);
    if (!applied) leaseState.lost = true;
  }

  private async validateDestination(
    workflowCode: string,
    requestBody: Record<string, unknown>,
    snapshot: { parentOutputDir?: string }
  ): Promise<Record<string, unknown> | undefined> {
    const requestedPath = String(requestBody.parentOutputDir || '');
    const snapshotPath = String(snapshot.parentOutputDir || '');
    const authoritative = this.authoritativeWorkflows().find((item) => item.code.trim().toUpperCase() === workflowCode.trim().toUpperCase());
    if (!authoritative || authoritative.enabled === false) throw new Error(`工作流 ${workflowCode} 不在当前已启用的系统设置中`);
    const [requested, snapshotted, configured] = await Promise.all([
      assertSafeDownloadRoot(requestedPath),
      assertSafeDownloadRoot(snapshotPath),
      assertSafeDownloadRoot(authoritative.parentOutputDir)
    ]);
    if (!sameDownloadPath(requested, snapshotted) || !sameDownloadPath(requested, configured)) {
      throw new Error('任务下载目录与工作流快照或当前系统设置不一致');
    }
    return undefined;
  }
}

function parseWebhookPayload(text: string, statusCode: number): Record<string, unknown> {
  try {
    const parsed = JSON.parse(text) as unknown;
    return Array.isArray(parsed) && parsed[0] && typeof parsed[0] === 'object'
      ? parsed[0] as Record<string, unknown>
      : parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : {};
  } catch {
    return { success: false, errors: [text.slice(0, 1000) || `Webhook returned HTTP ${statusCode}`] };
  }
}

function clampRetryDelay(value: unknown, minimum: number, maximum: number): number {
  const numeric = Number(value);
  return Math.max(minimum, Math.min(maximum, Number.isFinite(numeric) ? numeric : minimum));
}

function recoveryTimeoutPayload(lastTransportError: string): Record<string, unknown> {
  const message = '超过工作流超时与恢复宽限时间，仍无法确认原下载执行结果；系统未创建新的下载任务。';
  return {
    success: false,
    status: 'idempotency_recovery_timeout',
    idempotencyState: 'failed',
    errors: [...new Set([message, ...(lastTransportError ? [lastTransportError] : [])])]
  };
}

async function validateDownloadOutput(parentOutputDir: string, payload: Record<string, unknown>): Promise<Record<string, unknown> | undefined> {
  const outputDir = typeof payload.outputDir === 'string' ? payload.outputDir.trim() : '';
  let message = '';
  try {
    await assertSafeDownloadRoot(parentOutputDir);
    await assertSafeDownloadRoot(outputDir);
    if (!outputDir || !await isPathSafelyContained(parentOutputDir, outputDir)) {
      message = '下载结果目录不是配置保存目录的真实子目录';
    } else if (!await directoryContainsImage(outputDir)) {
      message = '下载结果目录不存在或不包含有效图片';
    }
  } catch (error) {
    message = error instanceof Error ? error.message : '下载结果目录校验失败';
  }
  if (!message) return undefined;
  return {
    ...payload,
    success: false,
    status: 'download_output_unavailable',
    httpStatus: 500,
    errors: [...new Set([...(Array.isArray(payload.errors) ? payload.errors.map(String) : []), message])]
  };
}

async function directoryContainsImage(root: string): Promise<boolean> {
  if (!(await stat(root).catch(() => undefined))?.isDirectory()) return false;
  const queue = [root];
  let inspected = 0;
  while (queue.length && inspected < 20_000) {
    const current = queue.shift()!;
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      inspected += 1;
      if (entry.isDirectory()) queue.push(path.join(current, entry.name));
      else if (entry.isFile() && IMAGE_EXTENSIONS.includes(path.extname(entry.name).toLocaleLowerCase('en-US') as typeof IMAGE_EXTENSIONS[number])) return true;
    }
  }
  return false;
}

function sameDownloadPath(left: DownloadPathInspection, right: DownloadPathInspection): boolean {
  if (left.flavor !== right.flavor) return false;
  const normalize = (value: string) => left.flavor === 'win32' ? value.toLocaleLowerCase('en-US') : value;
  if (normalize(left.normalizedPath) !== normalize(right.normalizedPath)) return false;
  return !left.realPath || !right.realPath || normalize(left.realPath) === normalize(right.realPath);
}
