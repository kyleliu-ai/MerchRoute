import { AppError, wbNetworkRecoverySchema } from '@n8n-media-review/shared';
import { z } from 'zod';
import type { WbRepository } from '../repositories/wb.js';
import type { WbAutoPublishRepository } from '../repositories/wb-auto-publish.js';

const rowVersionSchema = z.string().trim().regex(/^\d+$/, 'rowVersion 必须是候选查询返回的 PostgreSQL 行版本');

const manualRecoveryItemSchema = z.object({
  kind: z.literal('MANUAL'),
  identity: z.object({
    versionId: z.string().uuid(),
    taskId: z.string().trim().min(1)
  }).strict(),
  rowVersion: rowVersionSchema,
  proposedRecovery: wbNetworkRecoverySchema
}).strict();

const autoRecoveryItemSchema = z.object({
  kind: z.literal('AUTO'),
  identity: z.object({
    storeId: z.string().uuid().optional(),
    sku: z.string().regex(/^\d{7}$/),
    runId: z.string().uuid(),
    runNo: z.number().int().positive(),
    taskId: z.string().trim().min(1).nullable()
  }).strict(),
  rowVersion: rowVersionSchema,
  proposedRecovery: wbNetworkRecoverySchema
}).strict();

const runtimeRecoveryItemSchema = z.object({
  kind: z.literal('RUNTIME'),
  identity: z.object({
    taskId: z.string().trim().min(1),
    idempotencyKey: z.string().trim().min(1),
    productCode: z.string().trim().min(1),
    revision: z.number().int().nonnegative(),
    payloadSignature: z.string().trim().min(1),
    workRelpath: z.string().trim().min(1)
  }).strict(),
  rowVersion: z.number().int().positive()
}).strict();

const recoveryRequestSchema = z.object({
  dryRun: z.boolean().default(true),
  apply: z.boolean().default(false),
  limit: z.number().int().min(1).max(500).default(100),
  items: z.array(z.discriminatedUnion('kind', [runtimeRecoveryItemSchema, manualRecoveryItemSchema, autoRecoveryItemSchema])).max(100).optional()
}).strict();

export type WbNetworkRecoveryRequest = z.input<typeof recoveryRequestSchema>;

type Dependencies = {
  wb: Pick<WbRepository,
    'listHistoricalRuntimeNetworkFailureCandidates' | 'recoverHistoricalRuntimeNetworkFailure'
    | 'listHistoricalNetworkListingCandidates' | 'recoverHistoricalNetworkListing'>;
  auto: Pick<WbAutoPublishRepository, 'listHistoricalNetworkFailureCandidates' | 'recoverHistoricalNetworkFailure'>;
};

export async function handleWbNetworkRecoveryRequest(dependencies: Dependencies, input: unknown) {
  const parsed = recoveryRequestSchema.safeParse(input || {});
  if (!parsed.success) {
    throw new AppError('CONFIG_INVALID', 'WB 历史网络恢复请求格式无效', { issues: parsed.error.issues });
  }
  const request = parsed.data;
  if (request.apply && request.dryRun) {
    throw new AppError('CONFIG_INVALID', 'apply=true 时必须显式设置 dryRun=false，避免误写历史任务');
  }
  if (!request.apply && request.dryRun === false) {
    throw new AppError('CONFIG_INVALID', 'dryRun=false 时必须显式设置 apply=true');
  }
  if (!request.apply) {
    const [runtime, manual, auto] = await Promise.all([
      dependencies.wb.listHistoricalRuntimeNetworkFailureCandidates(request.limit),
      dependencies.wb.listHistoricalNetworkListingCandidates(request.limit),
      dependencies.auto.listHistoricalNetworkFailureCandidates(request.limit)
    ]);
    return {
      dryRun: true,
      applied: false,
      candidateCount: runtime.length + manual.length + auto.length,
      candidates: { runtime, manual, auto }
    };
  }
  if (!request.items?.length) {
    throw new AppError('CONFIG_INVALID', 'apply 模式必须逐项提供候选查询返回的 identity、rowVersion 与 proposedRecovery；不会自动扫描后写入');
  }

  const results = [];
  const orderedItems = [...request.items].sort((left, right) =>
    Number(right.kind === 'RUNTIME') - Number(left.kind === 'RUNTIME'));
  for (const item of orderedItems) {
    try {
      if (item.kind === 'RUNTIME') {
        const recovered = await dependencies.wb.recoverHistoricalRuntimeNetworkFailure(item.identity.taskId, {
          ...item.identity,
          rowVersion: item.rowVersion
        });
        results.push({
          kind: item.kind,
          identity: item.identity,
          previousRowVersion: item.rowVersion,
          status: 'RECOVERED' as const,
          rowVersion: recovered.rowVersion,
          evidence: recovered.evidence,
          job: recovered.job
        });
      } else if (item.kind === 'MANUAL') {
        const recovered = await dependencies.wb.recoverHistoricalNetworkListing(
          item.identity.versionId,
          item.identity.taskId,
          item.rowVersion,
          item.proposedRecovery
        );
        results.push({
          kind: item.kind,
          identity: item.identity,
          previousRowVersion: item.rowVersion,
          status: 'RECOVERED' as const,
          rowVersion: recovered.rowVersion,
          evidence: recovered.evidence,
          listing: recovered.listing
        });
      } else {
        const recovered = await dependencies.auto.recoverHistoricalNetworkFailure(item.identity.sku, {
          storeId: item.identity.storeId,
          runId: item.identity.runId,
          runNo: item.identity.runNo,
          taskId: item.identity.taskId,
          rowVersion: item.rowVersion
        }, item.proposedRecovery);
        results.push({
          kind: item.kind,
          identity: item.identity,
          previousRowVersion: item.rowVersion,
          status: 'RECOVERED' as const,
          rowVersion: recovered.rowVersion,
          evidence: recovered.evidence,
          job: recovered.job
        });
      }
    } catch (error) {
      const appError = error instanceof AppError ? error : undefined;
      results.push({
        kind: item.kind,
        identity: item.identity,
        previousRowVersion: item.rowVersion,
        status: appError && ['VERSION_CONFLICT', 'TASK_LOCKED', 'RUNTIME_RECOVERY_REQUIRED', 'RECOVERY_UNSAFE'].includes(appError.code)
          ? 'CONFLICT' as const : 'ERROR' as const,
        code: appError?.code || 'RECOVERY_FAILED',
        message: error instanceof Error ? error.message : 'WB 历史网络任务恢复失败',
        ...(appError?.details ? { details: appError.details } : {})
      });
    }
  }
  return {
    dryRun: false,
    applied: true,
    requestedCount: request.items.length,
    recoveredCount: results.filter((item) => item.status === 'RECOVERED').length,
    conflictCount: results.filter((item) => item.status === 'CONFLICT').length,
    errorCount: results.filter((item) => item.status === 'ERROR').length,
    results
  };
}
