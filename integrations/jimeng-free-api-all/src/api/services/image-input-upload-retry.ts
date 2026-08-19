export const IMAGE_INPUT_UPLOAD_MAX_ATTEMPTS = 3;
export const IMAGE_INPUT_UPLOAD_RETRY_DELAYS_MS = [2000, 5000] as const;
export const IMAGE_INPUT_UPLOAD_JITTER_MAX_MS = 1000;

export type ImageInputUploadStage =
  | "source_image_download"
  | "tos_apply_upload"
  | "tos_binary_upload"
  | "tos_commit_upload"
  | "image_upload_pre_submit";

const RETRYABLE_HTTP_STATUS_CODES = new Set([408, 429, 500, 502, 503, 504]);
const RETRYABLE_NETWORK_CODES = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "EHOSTUNREACH",
  "ENETDOWN",
  "ENETRESET",
  "ENETUNREACH",
  "EPIPE",
  "ETIMEDOUT",
  "EAI_AGAIN",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_SOCKET",
]);

export type ImageInputUploadFailureDetails = {
  phase: "image_upload_pre_submit";
  stage: ImageInputUploadStage;
  imageIndex: number;
  imageCount: number;
  fileName: string;
  sourceFileName: string;
  attempts: number;
  attemptCount: number;
  retryable: boolean;
  automaticRetriesExhausted: boolean;
  retryExhausted: boolean;
  status?: number;
  statusCode?: number;
  networkCode?: string;
  cause: string;
};

export type ImageInputUploadRetryEvent = {
  imageIndex: number;
  imageCount: number;
  sourceFileName: string;
  failedAttempt: number;
  nextAttempt: number;
  delayMs: number;
  statusCode?: number;
  networkCode?: string;
  cause: string;
};

export class ImageInputUploadError extends Error {
  readonly code = "image_upload_pre_submit";
  readonly details: ImageInputUploadFailureDetails;
  readonly cause: unknown;

  constructor(message: string, details: ImageInputUploadFailureDetails, cause: unknown) {
    super(message);
    this.name = "ImageInputUploadError";
    this.details = details;
    this.cause = cause;
  }
}

function errorObjects(error: unknown): Record<string, any>[] {
  const values: Record<string, any>[] = [];
  const visited = new Set<unknown>();
  let current: unknown = error;
  while (current && !visited.has(current) && values.length < 6) {
    visited.add(current);
    if (typeof current === "object") {
      const record = current as Record<string, any>;
      values.push(record);
      current = record.cause;
    } else {
      break;
    }
  }
  return values;
}

function rawErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === "string") return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

export function sanitizeImageUploadError(error: unknown): string {
  const message = rawErrorMessage(error)
    .replace(/https?:\/\/[^\s"'<>]+/gi, "<redacted-url>")
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer <redacted>")
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return (message || "unknown upload error").slice(0, 300);
}

export function getImageUploadErrorStatusCode(error: unknown): number | undefined {
  for (const record of errorObjects(error)) {
    const candidates = [record.status, record.statusCode, record.response?.status, record.cause?.status];
    for (const candidate of candidates) {
      const parsed = Number(candidate);
      if (Number.isInteger(parsed) && parsed >= 100 && parsed <= 599) return parsed;
    }
  }
  const match = rawErrorMessage(error).match(/\b(408|429|500|502|503|504)\b/);
  return match ? Number(match[1]) : undefined;
}

export function getImageUploadNetworkCode(error: unknown): string | undefined {
  for (const record of errorObjects(error)) {
    for (const candidate of [record.code, record.errno, record.cause?.code]) {
      const normalized = String(candidate || "").trim().toUpperCase();
      if (RETRYABLE_NETWORK_CODES.has(normalized)) return normalized;
    }
  }
  const message = rawErrorMessage(error).toUpperCase();
  return [...RETRYABLE_NETWORK_CODES].find((code) => message.includes(code));
}

export function getImageInputUploadFailureStage(error: unknown): ImageInputUploadStage {
  const message = rawErrorMessage(error);
  if (/下载图片失败|source[_ ]image[_ ]download/i.test(message)) return "source_image_download";
  if (/申请上传权限失败|ApplyImageUpload/i.test(message)) return "tos_apply_upload";
  if (/提交上传失败|图片上传状态异常|CommitImageUpload/i.test(message)) return "tos_commit_upload";
  if (/图片上传失败|Buffer视频图片上传失败|\/upload\/v1\//i.test(message)) return "tos_binary_upload";
  return "image_upload_pre_submit";
}

export function isRetryableImageUploadError(error: unknown): boolean {
  const statusCode = getImageUploadErrorStatusCode(error);
  if (statusCode !== undefined) return RETRYABLE_HTTP_STATUS_CODES.has(statusCode);
  if (getImageUploadNetworkCode(error)) return true;
  const message = rawErrorMessage(error).toLowerCase();
  return /fetch failed|network error|socket (?:closed|hang up)|timed?\s*out|connection reset|terminated/.test(message);
}

export function getImageInputUploadRetryDelayMs(
  failedAttempt: number,
  random: () => number = Math.random
): number {
  const baseDelay = IMAGE_INPUT_UPLOAD_RETRY_DELAYS_MS[Math.max(0, Math.min(
    IMAGE_INPUT_UPLOAD_RETRY_DELAYS_MS.length - 1,
    failedAttempt - 1
  ))];
  const randomValue = Math.max(0, Math.min(1, Number(random()) || 0));
  return baseDelay + Math.floor(randomValue * IMAGE_INPUT_UPLOAD_JITTER_MAX_MS);
}

export async function uploadImageInputsWithRetry<TInput, TOutput>(options: {
  inputs: readonly TInput[];
  sourceFileNames?: readonly string[];
  uploadOne: (input: TInput, imageIndex: number, attempt: number) => Promise<TOutput>;
  sleep?: (delayMs: number) => Promise<void>;
  random?: () => number;
  onRetry?: (event: ImageInputUploadRetryEvent) => void;
  onSuccess?: (event: {
    imageIndex: number;
    imageCount: number;
    sourceFileName: string;
    attemptCount: number;
    result: TOutput;
  }) => void;
}): Promise<TOutput[]> {
  const sleep = options.sleep || ((delayMs: number) => new Promise<void>((resolve) => setTimeout(resolve, delayMs)));
  const results: TOutput[] = [];
  const imageCount = options.inputs.length;

  for (let index = 0; index < imageCount; index++) {
    const imageIndex = index + 1;
    const sourceFileName = String(options.sourceFileNames?.[index] || "").trim();
    let completed = false;

    for (let attempt = 1; attempt <= IMAGE_INPUT_UPLOAD_MAX_ATTEMPTS; attempt++) {
      try {
        const result = await options.uploadOne(options.inputs[index], imageIndex, attempt);
        results.push(result);
        options.onSuccess?.({ imageIndex, imageCount, sourceFileName, attemptCount: attempt, result });
        completed = true;
        break;
      } catch (error) {
        const retryable = isRetryableImageUploadError(error);
        const stage = getImageInputUploadFailureStage(error);
        const statusCode = getImageUploadErrorStatusCode(error);
        const networkCode = getImageUploadNetworkCode(error);
        const cause = sanitizeImageUploadError(error);
        const retryExhausted = retryable && attempt >= IMAGE_INPUT_UPLOAD_MAX_ATTEMPTS;

        if (!retryable || retryExhausted) {
          const label = sourceFileName ? `（${sourceFileName}）` : "";
          throw new ImageInputUploadError(
            `参考图 ${imageIndex}/${imageCount}${label} 上传失败：${cause}`,
            {
              phase: "image_upload_pre_submit",
              stage,
              imageIndex,
              imageCount,
              fileName: sourceFileName,
              sourceFileName,
              attempts: attempt,
              attemptCount: attempt,
              retryable,
              automaticRetriesExhausted: retryExhausted,
              retryExhausted,
              status: statusCode,
              statusCode,
              networkCode,
              cause,
            },
            error
          );
        }

        const delayMs = getImageInputUploadRetryDelayMs(attempt, options.random);
        options.onRetry?.({
          imageIndex,
          imageCount,
          sourceFileName,
          failedAttempt: attempt,
          nextAttempt: attempt + 1,
          delayMs,
          statusCode,
          networkCode,
          cause,
        });
        await sleep(delayMs);
      }
    }

    if (!completed) {
      throw new Error(`参考图 ${imageIndex}/${imageCount} 上传流程未完成`);
    }
  }

  return results;
}
