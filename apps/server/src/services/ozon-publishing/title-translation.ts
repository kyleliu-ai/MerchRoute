import { createHash } from 'node:crypto';
import {
  AppError,
  OZON_TITLE_MAX_LENGTH,
  OZON_TITLE_TRANSLATION_WEBHOOK_PATH,
  OZON_TITLE_TRANSLATION_WORKFLOW_ID,
  isExecutableOzonContentPolicyVersion,
  type OzonContentPolicyVersion,
  validateOzonTitle
} from '@n8n-media-review/shared';

export type OzonTitleTranslationResult = {
  contentTranslate: string;
  model?: string;
  usage?: unknown;
  finishReason?: string;
  cached: boolean;
};

export type OzonTitleTranslationInput = {
  content: string;
  language: string;
  maxLength: number;
  workflowId: string;
  requestId: string;
  contentPolicyVersion: OzonContentPolicyVersion;
  /** Trusted first-party catalog context. Never populated from model output. */
  productTypeRu?: string;
  brand?: string;
  model?: string;
  importantCharacteristics?: string[];
};

export interface OzonTitleTranslator {
  readonly configured: boolean;
  translate(input: OzonTitleTranslationInput): Promise<OzonTitleTranslationResult>;
}

export class OzonTitleTranslationClient implements OzonTitleTranslator {
  private readonly baseUrl = (process.env.OZON_AUTOMATION_BASE_URL || process.env.WB_AUTOMATION_BASE_URL)?.trim().replace(/\/+$/, '');
  private readonly automationKey = (process.env.OZON_AUTOMATION_KEY || process.env.WB_AUTOMATION_KEY)?.trim();
  private readonly url = process.env.OZON_TITLE_TRANSLATION_WEBHOOK_URL?.trim()
    || (this.baseUrl ? `${this.baseUrl}${OZON_TITLE_TRANSLATION_WEBHOOK_PATH}` : undefined);
  private readonly workflowId = process.env.OZON_TITLE_TRANSLATION_WORKFLOW_ID?.trim()
    || OZON_TITLE_TRANSLATION_WORKFLOW_ID;
  private readonly cache = new Map<string, OzonTitleTranslationResult>();
  private readonly inFlight = new Map<string, Promise<OzonTitleTranslationResult>>();

  get configured(): boolean { return Boolean(this.url && this.automationKey); }

  supportsWorkflow(workflowId: string): boolean { return String(workflowId || '').trim() === this.workflowId; }

  async translate(input: OzonTitleTranslationInput): Promise<OzonTitleTranslationResult> {
    const content = String(input.content || '').trim();
    const language = String(input.language || '').trim();
    const requestId = String(input.requestId || '').trim();
    const contentPolicyVersion = String(input.contentPolicyVersion || '').trim();
    if (!content || !requestId || !language || Array.from(language).length > 64 || /[\r\n]/.test(language)
      || !Number.isInteger(input.maxLength) || input.maxLength < 1 || input.maxLength > OZON_TITLE_MAX_LENGTH
      || !isExecutableOzonContentPolicyVersion(contentPolicyVersion)) {
      throw new AppError('CONFIG_INVALID', 'OZON 标题翻译参数无效', {
        errorCode: 'OZON_TITLE_TRANSLATION_INPUT_INVALID', retryable: false,
        details: {
          maxLength: input.maxLength,
          maxAllowed: OZON_TITLE_MAX_LENGTH,
          contentPolicyVersion: contentPolicyVersion || undefined
        }
      });
    }
    if (!this.supportsWorkflow(input.workflowId)) {
      throw new AppError('CONFIG_INVALID', 'OZON 标题翻译工作流 ID 没有对应的 webhook 映射', { workflowId: input.workflowId }, 409);
    }
    if (!this.url || !this.automationKey) throw new AppError('CONFIG_INVALID', '未配置 OZON 标题翻译 n8n 地址或自动化密钥', undefined, 503);
    const context = normalizeTrustedContext(input);
    const cacheKey = createHash('sha256').update(JSON.stringify({
      content,
      language,
      maxLength: input.maxLength,
      workflowId: input.workflowId,
      contentPolicyVersion,
      ...context
    })).digest('hex');
    const cached = this.cache.get(cacheKey);
    if (cached) return { ...cached, cached: true };
    const existing = this.inFlight.get(cacheKey);
    if (existing) return existing;
    const operation = this.request({
      ...input,
      ...context,
      content,
      language,
      requestId,
      contentPolicyVersion: contentPolicyVersion as OzonContentPolicyVersion
    });
    this.inFlight.set(cacheKey, operation);
    try {
      const result = await operation;
      this.cache.set(cacheKey, result);
      return result;
    } finally {
      if (this.inFlight.get(cacheKey) === operation) this.inFlight.delete(cacheKey);
    }
  }

  private async request(input: OzonTitleTranslationInput): Promise<OzonTitleTranslationResult> {
    let endpoint: URL;
    try {
      endpoint = new URL(this.url!);
      if (endpoint.protocol !== 'http:' && endpoint.protocol !== 'https:') throw new Error('unsupported protocol');
    } catch {
      throw new AppError('CONFIG_INVALID', 'OZON 标题翻译 webhook 地址无效', {
        errorCode: 'OZON_TITLE_TRANSLATION_URL_INVALID', retryable: false, details: { url: this.url }
      }, 422);
    }
    // A listening n8n port is not a ready webhook registry (notably during startup).
    // Preserve reverse-proxy prefixes; custom non-n8n endpoints keep their contract.
    const webhookIndex = endpoint.pathname.indexOf('/webhook/');
    const readinessUrl = webhookIndex >= 0
      ? new URL(`${endpoint.pathname.slice(0, webhookIndex)}/healthz/readiness`, endpoint.origin)
      : undefined;
    if (readinessUrl) await this.assertN8nReady(readinessUrl);
    let response: Response;
    let rawText: string;
    try {
      response = await fetch(this.url!, {
        method: 'POST',
        redirect: 'error',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json',
          'X-WB-Automation-Key': this.automationKey!
        },
        body: JSON.stringify({
          content: input.content,
          language: input.language,
          maxLength: input.maxLength,
          requestId: input.requestId,
          contentPolicyVersion: input.contentPolicyVersion,
          ...(input.productTypeRu ? { productTypeRu: input.productTypeRu } : {}),
          ...(input.brand ? { brand: input.brand } : {}),
          ...(input.model ? { model: input.model } : {}),
          ...(input.importantCharacteristics?.length ? { importantCharacteristics: input.importantCharacteristics } : {})
        }),
        signal: AbortSignal.timeout(90_000)
      });
      rawText = await response.text();
    } catch (error) {
      const retryable = isRetryableNetworkError(error);
      throw new AppError(retryable ? 'VERIFY_FAILED' : 'CONFIG_INVALID', retryable
        ? 'OZON 标题翻译工作流请求失败'
        : 'OZON 标题翻译工作流请求配置或协议无效', {
        errorCode: retryable ? 'OZON_TITLE_TRANSLATION_NETWORK_ERROR' : 'OZON_TITLE_TRANSLATION_REQUEST_INVALID',
        retryable, operation: 'OZON_TITLE_TRANSLATION',
        details: { reason: error instanceof Error ? error.message : String(error) }
      }, retryable ? 502 : 422);
    }
    if (response.status === 404) {
      // Close the readiness -> POST restart race. A healthy server with a missing
      // endpoint is configuration drift, not a reason for endless retries.
      if (readinessUrl) await this.assertN8nReady(readinessUrl);
      throw new AppError('CONFIG_INVALID', 'OZON 标题翻译 Webhook 未注册或地址错误（HTTP 404）', {
        errorCode: 'OZON_TITLE_TRANSLATION_ENDPOINT_NOT_FOUND', retryable: false,
        details: { httpStatus: 404, workflowId: this.workflowId }
      }, 404);
    }
    if (response.status === 401 || response.status === 403) {
      throw new AppError('CONFIG_INVALID', 'OZON 标题翻译工作流鉴权失败', {
        errorCode: 'OZON_TITLE_TRANSLATION_AUTH_INVALID', retryable: false,
        details: { httpStatus: response.status }
      }, response.status);
    }
    let raw: unknown = {};
    try { raw = rawText ? JSON.parse(rawText) : {}; }
    catch {
      const retryable = response.status === 429 || response.status >= 500;
      throw new AppError(retryable ? 'VERIFY_FAILED' : 'CONFIG_INVALID', 'OZON 标题翻译工作流返回了非 JSON 内容', {
        errorCode: 'OZON_TITLE_TRANSLATION_NON_JSON', retryable, operation: 'OZON_TITLE_TRANSLATION', details: { httpStatus: response.status }
      }, retryable ? 502 : response.status);
    }
    const root = asObject(raw);
    const data = asObject(root.data);
    if (!response.ok) {
      const retryable = response.status === 429 || response.status >= 500;
      const errorCode = stableErrorCode(root.errorCode ?? root.code ?? data.errorCode ?? data.code ?? root.error ?? data.error)
        || 'OZON_TITLE_TRANSLATION_HTTP_ERROR';
      const details = objectValue(root.details ?? data.details);
      const message = stringValue(root.message ?? data.message ?? root.error ?? data.error)
        || `OZON 标题翻译工作流失败（HTTP ${response.status}）`;
      throw new AppError(retryable ? 'VERIFY_FAILED' : 'CONFIG_INVALID', message, {
        errorCode, retryable, operation: 'OZON_TITLE_TRANSLATION', details: { ...details, httpStatus: response.status }
      }, retryable ? 502 : response.status);
    }
    const contentTranslate = String(root.contentTranslate ?? data.contentTranslate ?? '');
    if (!contentTranslate) throw new AppError('CONFIG_INVALID', 'OZON 标题翻译工作流未返回 contentTranslate', {
      errorCode: 'OZON_TITLE_TRANSLATION_EMPTY_OUTPUT', retryable: false, details: {}
    }, 422);
    const title = validateOzonTitle(contentTranslate, input.contentPolicyVersion);
    if (!title.valid || title.length > input.maxLength) {
      throw new AppError('CONFIG_INVALID', `OZON 翻译标题必须是 ${input.maxLength} 字符以内的单行文本`, {
        errorCode: 'OZON_TITLE_TRANSLATION_INVALID_OUTPUT', retryable: false,
        details: { maxLength: input.maxLength, actualLength: title.length, issues: title.issues }
      }, 422);
    }
    return {
      contentTranslate,
      ...(typeof (root.model ?? data.model) === 'string' ? { model: String(root.model ?? data.model) } : {}),
      ...(root.usage !== undefined || data.usage !== undefined ? { usage: root.usage ?? data.usage } : {}),
      ...(typeof (root.finishReason ?? data.finishReason) === 'string' ? { finishReason: String(root.finishReason ?? data.finishReason) } : {}),
      cached: false
    };
  }

  private async assertN8nReady(url: URL): Promise<void> {
    let response: Response;
    let rawText: string;
    try {
      // This endpoint is read-only. Never send the automation secret to it.
      response = await fetch(url.href, {
        method: 'GET', redirect: 'error', headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(5_000)
      });
      rawText = await response.text();
    } catch (error) {
      const retryable = isRetryableNetworkError(error);
      throw new AppError(retryable ? 'VERIFY_FAILED' : 'CONFIG_INVALID', retryable
        ? 'n8n 标题翻译服务暂未就绪，请稍后重试'
        : 'n8n 标题翻译就绪检查地址或协议无效', {
        errorCode: retryable ? 'OZON_TITLE_TRANSLATION_NOT_READY' : 'OZON_TITLE_TRANSLATION_READINESS_INVALID',
        retryable
      }, retryable ? 503 : 422);
    }
    if (response.status === 429 || response.status >= 500) {
      throw new AppError('VERIFY_FAILED', 'n8n 正在启动或标题翻译服务暂不可用，请稍后重试', {
        errorCode: 'OZON_TITLE_TRANSLATION_NOT_READY', retryable: true,
        details: { httpStatus: response.status }
      }, 503);
    }
    let payload: unknown;
    try { payload = JSON.parse(rawText); } catch { /* Fail closed on HTML or an unexpected proxy response. */ }
    if (response.status !== 200 || asObject(payload).status !== 'ok') {
      throw new AppError('CONFIG_INVALID', 'n8n 标题翻译就绪检查未返回有效状态，请检查服务地址', {
        errorCode: 'OZON_TITLE_TRANSLATION_READINESS_INVALID', retryable: false,
        details: { httpStatus: response.status }
      }, 422);
    }
  }
}

export function isRetryableOzonTitleTranslationError(error: unknown): error is AppError {
  return error instanceof AppError && error.code === 'VERIFY_FAILED' && error.details?.retryable === true
    && (error.details?.operation === 'OZON_TITLE_TRANSLATION'
      || String(error.details?.errorCode || '').startsWith('OZON_TITLE_TRANSLATION_'));
}

function asObject(value: unknown): Record<string, any> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : {};
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function stringValue(value: unknown): string | undefined {
  const result = typeof value === 'string' ? value.trim() : '';
  return result || undefined;
}

function stableErrorCode(value: unknown): string | undefined {
  const code = stringValue(value);
  return code && /^[A-Z][A-Z0-9_]{2,127}$/.test(code) ? code : undefined;
}

function isRetryableNetworkError(error: unknown): boolean {
  if (error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError')) return true;
  const cause = error && typeof error === 'object' && 'cause' in error
    ? (error as { cause?: unknown }).cause
    : undefined;
  const code = cause && typeof cause === 'object' && 'code' in cause
    ? String((cause as { code?: unknown }).code || '')
    : '';
  return /^(?:ECONNRESET|ECONNREFUSED|ECONNABORTED|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH|ENOTFOUND|EAI_AGAIN|EPIPE|UND_ERR_CONNECT_TIMEOUT|UND_ERR_HEADERS_TIMEOUT|UND_ERR_BODY_TIMEOUT|UND_ERR_SOCKET)$/u.test(code);
}

function normalizeTrustedContext(input: OzonTitleTranslationInput): Pick<OzonTitleTranslationInput, 'productTypeRu' | 'brand' | 'model' | 'importantCharacteristics'> {
  const text = (value: unknown, field: string): string | undefined => {
    if (value === undefined || value === null || value === '') return undefined;
    const result = String(value);
    if (/\r|\n/.test(result) || Array.from(result).length > 256) {
      throw new AppError('CONFIG_INVALID', 'OZON 标题翻译可信上下文字段无效', {
        errorCode: 'OZON_TITLE_TRANSLATION_CONTEXT_INVALID', retryable: false, details: { field }
      });
    }
    return result;
  };
  if (input.importantCharacteristics !== undefined && !Array.isArray(input.importantCharacteristics)) {
    throw new AppError('CONFIG_INVALID', 'OZON 标题翻译可信上下文字段无效', {
      errorCode: 'OZON_TITLE_TRANSLATION_CONTEXT_INVALID', retryable: false, details: { field: 'importantCharacteristics' }
    });
  }
  const importantCharacteristics = input.importantCharacteristics === undefined
    ? undefined
    : input.importantCharacteristics.map((value, index) => text(value, `importantCharacteristics.${index}`)).filter((value): value is string => Boolean(value));
  if (importantCharacteristics && importantCharacteristics.length > 12) {
    throw new AppError('CONFIG_INVALID', 'OZON 标题翻译可信上下文字段无效', {
      errorCode: 'OZON_TITLE_TRANSLATION_CONTEXT_INVALID', retryable: false, details: { field: 'importantCharacteristics' }
    });
  }
  const productTypeRu = text(input.productTypeRu, 'productTypeRu');
  const brand = text(input.brand, 'brand');
  const model = text(input.model, 'model');
  return {
    ...(productTypeRu ? { productTypeRu } : {}),
    ...(brand ? { brand } : {}),
    ...(model ? { model } : {}),
    ...(importantCharacteristics?.length ? { importantCharacteristics } : {})
  };
}
