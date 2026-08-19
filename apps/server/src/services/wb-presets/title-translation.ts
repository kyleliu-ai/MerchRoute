import { createHash } from 'node:crypto';
import { AppError } from '@n8n-media-review/shared';
import type { WbPresetRepository } from '../../repositories/wb-presets.js';

type TranslationInput = { content: string; language: string; maxLength: number; workflowId: string; requestId: string };
type TranslationResult = { contentTranslate: string; model?: string; usage?: unknown; finishReason?: string; cached: boolean };

export class WbTitleTranslationClient {
  private readonly baseUrl = process.env.WB_AUTOMATION_BASE_URL?.trim().replace(/\/+$/, '');
  private readonly automationKey = process.env.WB_AUTOMATION_KEY?.trim();
  private readonly url = process.env.WB_TITLE_TRANSLATION_WEBHOOK_URL?.trim() || (this.baseUrl ? `${this.baseUrl}/webhook/translation-title` : undefined);
  private readonly workflowId = process.env.WB_TITLE_TRANSLATION_WORKFLOW_ID?.trim() || 'W2lSSXE3NUaLW1tD';
  private readonly inFlight = new Map<string, Promise<TranslationResult>>();

  constructor(private readonly presets: WbPresetRepository) {}

  get configured(): boolean { return Boolean(this.url && this.automationKey); }
  supportsWorkflow(workflowId: string): boolean { return String(workflowId || '').trim() === this.workflowId; }

  async translate(input: TranslationInput): Promise<TranslationResult> {
    const content = String(input.content || '').trim();
    const language = String(input.language || '').trim();
    if (!content || !language || Array.from(language).length > 64 || /[\r\n]/.test(language) || !Number.isInteger(input.maxLength) || input.maxLength < 1 || input.maxLength > 60) {
      throw new AppError('CONFIG_INVALID', '标题翻译参数无效');
    }
    if (!this.supportsWorkflow(input.workflowId)) throw new AppError('CONFIG_INVALID', '标题翻译工作流 ID 没有对应的 webhook 映射', { workflowId: input.workflowId }, 409);
    if (!this.url || !this.automationKey) throw new AppError('CONFIG_INVALID', '未配置标题翻译 n8n 地址或 WB_AUTOMATION_KEY', undefined, 503);
    const inputHash = createHash('sha256').update(JSON.stringify({ content, language, maxLength: input.maxLength, workflowId: input.workflowId })).digest('hex');
    const cacheKey = `wb-title-v1:${inputHash}`;
    const cached = await this.presets.getTranslation(cacheKey);
    if (cached) return { ...validateResponse(cached, input.maxLength), cached: true };
    const existing = this.inFlight.get(cacheKey);
    if (existing) return existing;
    const request = this.fetchAndCache(input, { content, language, inputHash, cacheKey });
    this.inFlight.set(cacheKey, request);
    try { return await request; }
    finally { if (this.inFlight.get(cacheKey) === request) this.inFlight.delete(cacheKey); }
  }

  private async fetchAndCache(input: TranslationInput, normalized: { content: string; language: string; inputHash: string; cacheKey: string }): Promise<TranslationResult> {
    let response: Response;
    try {
      response = await fetch(this.url!, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json', 'X-WB-Automation-Key': this.automationKey! },
        body: JSON.stringify({ content: normalized.content, language: normalized.language, maxLength: input.maxLength, requestId: input.requestId }),
        signal: AbortSignal.timeout(90_000)
      });
    } catch (error) {
      throw new AppError('VERIFY_FAILED', '标题翻译工作流请求失败', { reason: error instanceof Error ? error.message : String(error) }, 502);
    }
    const rawText = await response.text();
    let raw: unknown = {};
    try { raw = rawText ? JSON.parse(rawText) : {}; }
    catch { throw new AppError('VERIFY_FAILED', '标题翻译工作流返回了非 JSON 内容', { httpStatus: response.status }, 502); }
    if (!response.ok) throw new AppError('VERIFY_FAILED', `标题翻译工作流失败（HTTP ${response.status}）`, { httpStatus: response.status, response: raw }, 502);
    const parsed = validateResponse(raw, input.maxLength);
    await this.presets.putTranslation(normalized.cacheKey, normalized.inputHash, parsed);
    return { ...parsed, cached: false };
  }
}

function validateResponse(input: unknown, maxLength: number): Omit<TranslationResult, 'cached'> {
  const root = asObject(input);
  const data = asObject(root.data);
  const candidate = root.contentTranslate ?? data.contentTranslate;
  const contentTranslate = typeof candidate === 'string' ? candidate.trim() : '';
  if (!contentTranslate) throw new AppError('VERIFY_FAILED', '标题翻译工作流未返回 contentTranslate', undefined, 502);
  if (/[\r\n]/.test(contentTranslate)) throw new AppError('VERIFY_FAILED', '标题翻译结果必须是单行文本', undefined, 502);
  if (Array.from(contentTranslate).length > maxLength) throw new AppError('VERIFY_FAILED', '标题翻译结果超过最大长度', { maxLength, actualLength: Array.from(contentTranslate).length }, 502);
  return {
    contentTranslate,
    ...(typeof (root.model ?? data.model) === 'string' ? { model: String(root.model ?? data.model) } : {}),
    ...(root.usage !== undefined || data.usage !== undefined ? { usage: root.usage ?? data.usage } : {}),
    ...(typeof (root.finishReason ?? data.finishReason) === 'string' ? { finishReason: String(root.finishReason ?? data.finishReason) } : {})
  };
}

function asObject(value: unknown): Record<string, any> { return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : {}; }
