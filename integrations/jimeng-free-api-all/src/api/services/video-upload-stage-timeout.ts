export type VideoImageUploadStage =
  | "tos_apply_upload"
  | "tos_binary_upload"
  | "tos_commit_upload";

export type VideoImageUploadTimeoutValue = number | readonly number[];

export type VideoImageUploadTimeoutProfileMs = {
  apply?: VideoImageUploadTimeoutValue;
  binary?: VideoImageUploadTimeoutValue;
  commit?: VideoImageUploadTimeoutValue;
};

export type VideoImageUploadOptions = {
  attempt?: number;
  timeoutProfileMs?: VideoImageUploadTimeoutProfileMs;
  signal?: AbortSignal;
};

export const DEFAULT_VIDEO_IMAGE_UPLOAD_TIMEOUT_PROFILE_MS = {
  apply: [20_000, 40_000, 60_000],
  binary: [45_000, 90_000, 180_000],
  commit: [30_000, 60_000, 90_000],
} as const;

const STAGE_PROFILE_KEY: Record<VideoImageUploadStage, keyof VideoImageUploadTimeoutProfileMs> = {
  tos_apply_upload: "apply",
  tos_binary_upload: "binary",
  tos_commit_upload: "commit",
};

const STAGE_ERROR_PREFIX: Record<VideoImageUploadStage, string> = {
  tos_apply_upload: "申请上传权限失败",
  tos_binary_upload: "图片上传失败",
  tos_commit_upload: "提交上传失败",
};

type FetchLike = (
  url: string | Request,
  init?: RequestInit
) => Promise<Response>;

export type VideoImageUploadTimeoutEvent = {
  stage: VideoImageUploadStage;
  timeoutMs: number;
  host: string;
  attempt: number;
};

export class VideoImageUploadTimeoutError extends Error {
  readonly code = "ETIMEDOUT";
  readonly errno = "ETIMEDOUT";
  readonly retryable = true;
  readonly stage: VideoImageUploadStage;
  readonly timeoutMs: number;
  readonly host: string;
  readonly attempt: number;
  readonly cause: unknown;

  constructor(
    stage: VideoImageUploadStage,
    timeoutMs: number,
    host: string,
    attempt: number,
    cause: unknown
  ) {
    super(`${STAGE_ERROR_PREFIX[stage]}: timeout after ${timeoutMs}ms`);
    this.name = "VideoImageUploadTimeoutError";
    this.stage = stage;
    this.timeoutMs = timeoutMs;
    this.host = host;
    this.attempt = attempt;
    this.cause = cause;
  }
}

export function normalizeVideoImageUploadAttempt(attempt: unknown): number {
  const parsed = Number(attempt);
  if (!Number.isFinite(parsed)) return 1;
  return Math.max(1, Math.min(3, Math.floor(parsed)));
}

function normalizeTimeoutValue(value: unknown): number | undefined {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return undefined;
  return Math.max(1, Math.floor(parsed));
}

function selectTimeoutValue(value: VideoImageUploadTimeoutValue, attempt: number): number | undefined {
  if (!Array.isArray(value)) return normalizeTimeoutValue(value);
  if (value.length === 0) return undefined;
  const index = Math.min(attempt - 1, value.length - 1);
  return normalizeTimeoutValue(value[index]);
}

export function resolveVideoImageUploadTimeoutMs(
  stage: VideoImageUploadStage,
  attempt: unknown = 1,
  profile: VideoImageUploadTimeoutProfileMs = {}
): number {
  const normalizedAttempt = normalizeVideoImageUploadAttempt(attempt);
  const profileKey = STAGE_PROFILE_KEY[stage];
  const custom = profile[profileKey];
  const customValue = custom === undefined
    ? undefined
    : selectTimeoutValue(custom, normalizedAttempt);
  if (customValue !== undefined) return customValue;
  return DEFAULT_VIDEO_IMAGE_UPLOAD_TIMEOUT_PROFILE_MS[profileKey][normalizedAttempt - 1];
}

export function getSafeVideoImageUploadHost(url: string | Request): string {
  try {
    if (typeof url !== "string") return new URL(url.url).host || "unknown-host";
    return new URL(url).host || "unknown-host";
  } catch {
    return "invalid-host";
  }
}

export function summarizeVideoImageUploadErrorForLog(error: unknown): string {
  const record = error && typeof error === "object"
    ? error as Record<string, unknown>
    : {};
  const stage = String(record.stage || "image_upload_pre_submit")
    .replace(/[^a-z0-9_-]/gi, "")
    .slice(0, 64) || "image_upload_pre_submit";
  const code = String(record.code || record.errno || "unknown")
    .replace(/[^a-z0-9_-]/gi, "")
    .slice(0, 64) || "unknown";
  const parsedStatus = Number(record.status || record.statusCode);
  const status = Number.isInteger(parsedStatus) && parsedStatus >= 100 && parsedStatus <= 599
    ? String(parsedStatus)
    : "none";
  return `stage=${stage}, code=${code}, status=${status}`;
}

export async function fetchWithVideoImageUploadTimeout(
  fetcher: FetchLike,
  url: string | Request,
  init: RequestInit,
  stage: VideoImageUploadStage,
  timeoutMs: number,
  attempt: unknown = 1,
  onTimeout?: (event: VideoImageUploadTimeoutEvent) => void
): Promise<Response> {
  const normalizedTimeoutMs = normalizeTimeoutValue(timeoutMs);
  if (normalizedTimeoutMs === undefined) {
    throw new TypeError(`Invalid ${stage} timeout`);
  }

  const normalizedAttempt = normalizeVideoImageUploadAttempt(attempt);
  const host = getSafeVideoImageUploadHost(url);
  const controller = new AbortController();
  const externalSignal = init.signal || undefined;
  let abortOrigin: "external" | "timeout" | undefined;
  let timeoutCause: unknown;

  const abortFromExternalSignal = () => {
    if (abortOrigin !== undefined) return;
    abortOrigin = "external";
    controller.abort(externalSignal?.reason);
  };
  if (externalSignal?.aborted) {
    abortFromExternalSignal();
  } else {
    externalSignal?.addEventListener("abort", abortFromExternalSignal, { once: true });
  }

  const timer = setTimeout(() => {
    if (abortOrigin !== undefined) return;
    abortOrigin = "timeout";
    timeoutCause = new Error("upload stage deadline exceeded");
    controller.abort(timeoutCause);
  }, normalizedTimeoutMs);

  try {
    const response = await fetcher(url, { ...init, signal: controller.signal });
    if (abortOrigin === "timeout") {
      throw timeoutCause;
    }
    return response;
  } catch (error) {
    if (abortOrigin !== "timeout") throw error;
    const timeoutError = new VideoImageUploadTimeoutError(
      stage,
      normalizedTimeoutMs,
      host,
      normalizedAttempt,
      error
    );
    onTimeout?.({
      stage,
      timeoutMs: normalizedTimeoutMs,
      host,
      attempt: normalizedAttempt,
    });
    throw timeoutError;
  } finally {
    clearTimeout(timer);
    externalSignal?.removeEventListener("abort", abortFromExternalSignal);
  }
}
