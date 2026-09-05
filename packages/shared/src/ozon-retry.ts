import { z } from 'zod';

export const ozonPublishRetryRequestSchema = z.object({
  storeId: z.string().uuid(),
  requestId: z.string().uuid(),
  planHash: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  confirmRebuild: z.boolean().default(false)
}).strict();
export type OzonPublishRetryRequest = z.infer<typeof ozonPublishRetryRequestSchema>;
export type OzonPublishRetryMode = 'RESUME' | 'READBACK' | 'REBUILD';
export type OzonPublishRetryStatus = 'CHECKING' | 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'BLOCKED';
export type OzonPublishRetryRecord = {
  id: string; requestId: string; sourceJobId: string; effectiveJobId?: string;
  storeId: string; sku: string; status: OzonPublishRetryStatus; mode: OzonPublishRetryMode;
  stage: string; message: string; previousError: string; errorCode: string;
  createdAt: string; updatedAt: string;
};
export type OzonPublishRetryPlan = {
  canRetry: boolean; blockedReason?: string; planHash: string;
  sourceJobId: string; storeId: string; sku: string; storeName: string;
  mode: OzonPublishRetryMode; stage: string; requiresConfirmation: boolean;
  previousError: string; offerIds: string[];
  changes: Array<{ label: string; previous: string; current: string }>;
  latest?: OzonPublishRetryRecord;
};
export const OZON_RETRY_EXPLANATION = '核对当前店铺原任务及 OZON 实际结果，继续未完成的上品步骤；需要重建资料时会先确认。';
