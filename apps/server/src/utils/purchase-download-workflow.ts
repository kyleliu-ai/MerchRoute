import { AppError, classifyPurchaseProductUrl, type PurchaseProductUrlClassification } from '@n8n-media-review/shared';

type PurchaseDownloadWorkflowInput = {
  providerUrl: string;
  downloadWorkflowCode?: string;
  retailPrice?: string | null;
};

export function applyPurchaseUrlDownloadWorkflow<T extends PurchaseDownloadWorkflowInput>(
  input: T
): T & { downloadWorkflowCode: PurchaseProductUrlClassification['workflowCode']; retailPrice: null } {
  const providerUrl = typeof input?.providerUrl === 'string' ? input.providerUrl : '';
  const classification = classifyPurchaseProductUrl(providerUrl);
  if (!classification) {
    throw new AppError('PRODUCT_URL_UNSUPPORTED', '无法下载', undefined, 400);
  }

  if (input.downloadWorkflowCode === undefined) {
    return { ...input, downloadWorkflowCode: classification.workflowCode, retailPrice: null };
  }

  const actualWorkflowCode = String(input.downloadWorkflowCode).trim().toUpperCase();
  if (actualWorkflowCode !== classification.workflowCode) {
    throw new AppError('DOWNLOAD_WORKFLOW_URL_MISMATCH', '产品 URL 与下载工作流不匹配', {
      expectedWorkflowCode: classification.workflowCode,
      actualWorkflowCode,
      platform: classification.platform,
      productId: classification.productId
    }, 409);
  }

  return { ...input, downloadWorkflowCode: classification.workflowCode, retailPrice: null };
}
