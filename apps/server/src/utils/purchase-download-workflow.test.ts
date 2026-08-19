import { describe, expect, it } from 'vitest';
import { AppError } from '@n8n-media-review/shared';
import { applyPurchaseUrlDownloadWorkflow } from './purchase-download-workflow.js';

describe('applyPurchaseUrlDownloadWorkflow', () => {
  it.each([
    ['PDD', 'https://mobile.yangkeduo.com/goods.html?goods_id=123456789', 'E006'],
    ['1688', 'https://detail.1688.com/offer/987654321.html', 'E007']
  ])('未传工作流时自动补入 %s 对应代码', (_platform, providerUrl, expected) => {
    const input = { providerUrl, productName: '测试产品' };

    expect(applyPurchaseUrlDownloadWorkflow(input)).toEqual({
      ...input,
      downloadWorkflowCode: expected
    });
    expect(input).not.toHaveProperty('downloadWorkflowCode');
  });

  it('匹配工作流代码时标准化为大写', () => {
    expect(applyPurchaseUrlDownloadWorkflow({
      providerUrl: 'https://detail.1688.com/offer/987654321.html',
      downloadWorkflowCode: ' e007 '
    })).toEqual({
      providerUrl: 'https://detail.1688.com/offer/987654321.html',
      downloadWorkflowCode: 'E007'
    });
  });

  it('工作流与 URL 错配时返回 409 及分类详情', () => {
    expect(() => applyPurchaseUrlDownloadWorkflow({
      providerUrl: 'https://mobile.yangkeduo.com/goods.html?goods_id=123456789',
      downloadWorkflowCode: 'e007'
    })).toThrowError(expect.objectContaining<Partial<AppError>>({
      code: 'DOWNLOAD_WORKFLOW_URL_MISMATCH',
      statusCode: 409,
      details: {
        expectedWorkflowCode: 'E006',
        actualWorkflowCode: 'E007',
        platform: 'PDD',
        productId: '123456789'
      }
    }));
  });

  it.each([
    '',
    'https://example.com/product?id=123',
    'https://mobile.yangkeduo.com/goods.html'
  ])('不支持的 URL 返回精确的 400 错误合同: %s', (providerUrl) => {
    expect(() => applyPurchaseUrlDownloadWorkflow({ providerUrl })).toThrowError(expect.objectContaining<Partial<AppError>>({
      code: 'PRODUCT_URL_UNSUPPORTED',
      message: '无法下载',
      statusCode: 400
    }));
  });

  it('缺少 providerUrl 时也使用不支持 URL 错误合同', () => {
    expect(() => applyPurchaseUrlDownloadWorkflow({} as { providerUrl: string })).toThrowError(expect.objectContaining<Partial<AppError>>({
      code: 'PRODUCT_URL_UNSUPPORTED',
      message: '无法下载',
      statusCode: 400
    }));
  });
});
