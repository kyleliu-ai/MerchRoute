import { z } from 'zod';

export const wbPublishRetryRequestSchema = z.object({
  storeId: z.string().uuid(),
  runId: z.string().uuid(),
  requestId: z.string().uuid(),
  expectedStateToken: z.string().regex(/^[a-f0-9]{64}$/)
}).strict();
export type WbPublishRetryRequest = z.infer<typeof wbPublishRetryRequestSchema>;
export type WbPublishRetryStatus = 'CHECKING' | 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'BLOCKED';
export type WbPublishRetryRecord = {
  id: string;
  requestId: string;
  retryNo: number;
  status: WbPublishRetryStatus;
  stage: string;
  message: string;
  previousErrorCode: string;
  previousErrorMessage: string;
  errorCode: string;
  createdAt: string;
  updatedAt: string;
  finishedAt?: string;
};
export type WbPublishRetryDetail = {
  canRetry: boolean;
  reason: string;
  expectedStateToken: string;
  latest?: WbPublishRetryRecord;
};
export const WB_RETRY_EXPLANATION = '核对原任务及 WB 实际结果后，继续未完成的上品步骤；使用原任务资料。';
export const WB_RETRY_STAGE_LABELS: Record<string, string> = {
  CHECKING: '正在检查重试条件', CHECKING_PREPARATION: '检查上品资料',
  VALIDATING: '检查原上品资料', BARCODE_ALLOCATING: '继续准备原商品条码',
  CARD_CREATE_READY: '正在重试创建商品卡', CARD_SUBMITTING: '核对商品卡创建结果',
  CARD_RECONCILING: '核对商品卡', MEDIA_RECONCILING: '继续上传媒体',
  PRICE_RECONCILING: '继续设置价格', STOCK_RECONCILING: '继续设置库存',
  FINALIZING: '完成目录收尾'
};
