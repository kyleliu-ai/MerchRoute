import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import {
  ImageInputUploadError,
  getImageInputUploadFailureStage,
  getImageUploadErrorStatusCode,
  getImageUploadNetworkCode,
  isRetryableImageUploadError,
  sanitizeImageUploadError,
} from "./image-input-upload-retry.ts";

export const IMAGE_TASK_STORE_SCHEMA_VERSION = 2;
export const DEFAULT_GENERATION_CONCURRENCY = 5;
export const MAX_GENERATION_CONCURRENCY = 5;
export const DEFAULT_STATUS_CONCURRENCY = 4;
export const MAX_STATUS_CONCURRENCY = 4;

export type ImageTaskStatus =
  | "reserved"
  | "submission_unknown"
  | "processing"
  | "success"
  | "failed";

export type SourceImageMetadata = Record<string, unknown> | string;

export type ImageTaskRecord = {
  taskId: string;
  idempotencyKey: string;
  requestHash: string;
  historyId: string;
  tokenFingerprint: string;
  status: ImageTaskStatus;
  rawStatus?: number;
  failCode?: string;
  errorMessage?: string;
  count: number;
  imageUrls: string[];
  createdAt: string;
  updatedAt: string;
  context: Record<string, unknown>;
};

export type PublicImageTaskRecord = Omit<ImageTaskRecord, "tokenFingerprint"> & {
  reused: boolean;
};

export type AsyncBatchReservation = {
  created: boolean;
  needsSubmission: boolean;
  releaseOnPreSubmit: boolean;
  requestHash: string;
  task: Record<string, any>;
  record: ImageTaskRecord;
};

type StoreEnvelope = {
  schemaVersion: number;
  records: ImageTaskRecord[];
};

type ReservationInput = {
  taskId: string;
  idempotencyKey: string;
  requestHash: string;
  tokenFingerprint: string;
  context: Record<string, unknown>;
};

type ReservationResult = {
  created: boolean;
  record: ImageTaskRecord;
};

type SubmitBatchInput = {
  ledger: ImageTaskLedger;
  batchKey: string;
  tasks: Record<string, any>[];
  common?: Record<string, any>;
  images: (string | Buffer)[];
  sourceImages: SourceImageMetadata[];
  tokens: string[];
  concurrency?: number;
  uploadImages: (
    images: (string | Buffer)[],
    token: string,
    sourceImages: SourceImageMetadata[]
  ) => Promise<string[]>;
  submitTask: (input: {
    task: Record<string, any>;
    common: Record<string, any>;
    uploadedImageIds: string[];
    token: string;
  }) => Promise<{ historyId: string; status?: "processing" }>;
};

type QueryBatchInput = {
  ledger: ImageTaskLedger;
  batchKey?: string;
  phase?: string;
  pollCount?: number;
  maxPollCount?: number;
  tasks: Record<string, any>[];
  tokens: string[];
  concurrency?: number;
  queryTask: (historyId: string, token: string) => Promise<{
    historyId: string;
    status: "processing" | "success" | "failed";
    rawStatus?: number;
    failCode?: string;
    count?: number;
    imageUrls?: string[];
  }>;
};

export class ImageTaskLedgerError extends Error {
  readonly code: string;
  readonly details?: Record<string, unknown>;

  constructor(code: string, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = "ImageTaskLedgerError";
    this.code = code;
    this.details = details;
  }
}

export function imageTaskLedgerErrorResponse(error: unknown): Record<string, unknown> | undefined {
  if (!(error instanceof ImageTaskLedgerError)) return undefined;
  const details = error.details || {};
  const isUploadPreSubmit = error.code === "image_upload_pre_submit";
  const isReleaseUnconfirmed = error.code === "reservation_release_unconfirmed";
  const stage = typeof details.stage === "string" ? details.stage : undefined;
  const retryable = details.retryable === true;
  const reservationState = isUploadPreSubmit
    ? (details.reservationsReleased === true ? "released" : "unconfirmed")
    : isReleaseUnconfirmed
      ? "unconfirmed"
      : undefined;

  return {
    ok: false,
    code: error.code,
    message: error.message,
    stage,
    retryable,
    automaticRetriesExhausted: details.automaticRetriesExhausted === true,
    submittedCount: 0,
    unknownCount: 0,
    reservationState,
    details,
    taskCount: 0,
    tasks: [],
  };
}

function cloneRecord(record: ImageTaskRecord): ImageTaskRecord {
  return JSON.parse(JSON.stringify(record));
}

function normalizeInteger(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) ? parsed : fallback;
}

function normalizeFiniteNumber(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function stableValue(value: unknown): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : String(value);
  if (Array.isArray(value)) return value.map(stableValue);
  if (typeof value === "object") {
    const object = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(object)
        .sort()
        .filter((key) => object[key] !== undefined)
        .map((key) => [key, stableValue(object[key])])
    );
  }
  return String(value);
}

function portableBasename(value: string): string {
  const normalized = value.replace(/\\/g, "/");
  return normalized.slice(normalized.lastIndexOf("/") + 1);
}

function firstNonEmptyString(...values: unknown[]): string {
  for (const value of values) {
    const normalized = String(value ?? "").trim();
    if (normalized) return normalized;
  }
  return "";
}

export function normalizeSourceImageMetadata(
  sourceImages: SourceImageMetadata[]
): Record<string, unknown>[] {
  if (!Array.isArray(sourceImages) || sourceImages.length === 0 || sourceImages.length > 10) {
    throw new ImageTaskLedgerError(
      "invalid_source_images",
      "sourceImages 必须包含 1-10 条稳定源图元数据"
    );
  }

  return sourceImages.map((entry, orderedIndex) => {
    const metadata = typeof entry === "string" ? { sourceFileName: entry } : entry;
    if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
      throw new ImageTaskLedgerError(
        "invalid_source_image_metadata",
        `sourceImages[${orderedIndex}] 不是有效对象`
      );
    }

    const raw = metadata as Record<string, unknown>;
    const pathLike = firstNonEmptyString(
      raw.sourceFileName,
      raw.fileName,
      raw.filename,
      raw.name,
      raw.sourceFilePath,
      raw.filePath,
      raw.path
    );
    const contentHash = firstNonEmptyString(raw.sha256, raw.contentHash, raw.fileHash, raw.hash);
    const sourceFileName = pathLike && !/^https?:\/\//i.test(pathLike)
      ? portableBasename(pathLike)
      : "";

    if (!sourceFileName && !contentHash) {
      throw new ImageTaskLedgerError(
        "unstable_source_image_metadata",
        `sourceImages[${orderedIndex}] 必须包含稳定文件名或内容哈希，不能只提供临时 URL`
      );
    }

    const normalized: Record<string, unknown> = {
      orderedIndex,
      originalIndex: normalizeInteger(raw.originalIndex ?? raw.inputIndex, orderedIndex),
    };
    if (sourceFileName) normalized.sourceFileName = sourceFileName;
    if (contentHash) normalized.contentHash = contentHash.toLowerCase();

    const fileSize = normalizeFiniteNumber(raw.fileSize ?? raw.size ?? raw.bytes, -1);
    if (fileSize >= 0) normalized.fileSize = fileSize;
    const mimeType = firstNonEmptyString(raw.mimeType, raw.mime, raw.contentType);
    if (mimeType) normalized.mimeType = mimeType.toLowerCase();
    const fileExtension = firstNonEmptyString(
      raw.fileExtension,
      raw.extension,
      sourceFileName.includes(".") ? sourceFileName.slice(sourceFileName.lastIndexOf(".") + 1) : ""
    ).replace(/^\./, "").toLowerCase();
    if (fileExtension) normalized.fileExtension = fileExtension;
    const width = normalizeFiniteNumber(raw.width, -1);
    const height = normalizeFiniteNumber(raw.height, -1);
    if (width >= 0) normalized.width = width;
    if (height >= 0) normalized.height = height;
    return normalized;
  });
}

function taskContextValue(task: Record<string, any>, key: string): unknown {
  return task[key] ?? task.context?.[key];
}

export function buildImageTaskRequestHash(input: {
  task: Record<string, any>;
  common?: Record<string, any>;
  sourceImages: SourceImageMetadata[];
}): string {
  const task = input.task || {};
  const common = input.common || {};
  const sourceSubmissionId = firstNonEmptyString(
    taskContextValue(task, "sourceSubmissionId"),
    common.sourceSubmissionId
  );
  if (!sourceSubmissionId) {
    throw new ImageTaskLedgerError(
      "missing_source_submission_id",
      "异步生成必须提供 sourceSubmissionId"
    );
  }

  const payload = {
    schema: "E002-image-generation-v1",
    sourceSubmissionId,
    taskId: firstNonEmptyString(taskContextValue(task, "taskId")),
    view: firstNonEmptyString(taskContextValue(task, "view")),
    retryAttempt: normalizeInteger(taskContextValue(task, "retryAttempt"), 0),
    prompt: firstNonEmptyString(task.prompt),
    generation: {
      model: firstNonEmptyString(task.model, common.model, "jimeng-4.5"),
      ratio: firstNonEmptyString(task.ratio, common.ratio, "1:1"),
      resolution: firstNonEmptyString(task.resolution, common.resolution, "2k"),
      sampleStrength: normalizeFiniteNumber(
        task.sampleStrength ?? task.sample_strength ?? common.sampleStrength ?? common.sample_strength,
        0.5
      ),
      intelligentRatio: Boolean(
        task.intelligentRatio ?? task.intelligent_ratio ?? common.intelligentRatio ?? common.intelligent_ratio ?? false
      ),
    },
    sourceImages: normalizeSourceImageMetadata(input.sourceImages),
  };
  return crypto.createHash("sha256").update(JSON.stringify(stableValue(payload))).digest("hex");
}

export function fingerprintToken(token: string): string {
  const normalized = String(token || "").trim();
  if (!normalized) {
    throw new ImageTaskLedgerError("missing_token", "refresh_token 不能为空");
  }
  return crypto.createHash("sha256").update(normalized).digest("hex");
}

export function stableIndex(value: string, size: number): number {
  if (size <= 0) throw new ImageTaskLedgerError("missing_token", "未配置可用的 refresh_token");
  let hash = 2166136261;
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return Math.abs(hash >>> 0) % size;
}

export function normalizeGenerationConcurrency(value: unknown): number {
  const parsed = normalizeInteger(value, DEFAULT_GENERATION_CONCURRENCY);
  return Math.min(MAX_GENERATION_CONCURRENCY, Math.max(1, parsed));
}

export function normalizeStatusConcurrency(value: unknown): number {
  const parsed = normalizeInteger(value, DEFAULT_STATUS_CONCURRENCY);
  return Math.min(MAX_STATUS_CONCURRENCY, Math.max(1, parsed));
}

export async function mapWithConcurrency<T, R>(
  values: T[],
  concurrency: number,
  mapper: (value: T, index: number) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(values.length);
  let nextIndex = 0;
  const workerCount = Math.min(Math.max(1, concurrency), values.length);
  const workers = Array.from({ length: workerCount }, async () => {
    while (nextIndex < values.length) {
      const index = nextIndex++;
      results[index] = await mapper(values[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

function sanitizeContextValue(value: unknown, key = ""): unknown {
  if (/^(authorization|refreshToken|token|images|imageUrls|sourceUrls|url)$/i.test(key)) {
    return undefined;
  }
  if (Array.isArray(value)) {
    return value
      .map((entry) => sanitizeContextValue(entry))
      .filter((entry) => entry !== undefined);
  }
  if (value && typeof value === "object") {
    const clean: Record<string, unknown> = {};
    for (const [childKey, childValue] of Object.entries(value as Record<string, unknown>)) {
      const sanitized = sanitizeContextValue(childValue, childKey);
      if (sanitized !== undefined) clean[childKey] = sanitized;
    }
    return clean;
  }
  return value;
}

function safeErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error ?? "unknown error");
  return message.slice(0, 1000);
}

function validateLoadedRecord(value: unknown): ImageTaskRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ImageTaskLedgerError("store_corrupt", "任务台账包含非对象记录");
  }
  const raw = value as Record<string, any>;
  const idempotencyKey = firstNonEmptyString(raw.idempotencyKey);
  const taskId = firstNonEmptyString(raw.taskId);
  const status = firstNonEmptyString(raw.status) as ImageTaskStatus;
  const allowedStatuses: ImageTaskStatus[] = [
    "reserved",
    "submission_unknown",
    "processing",
    "success",
    "failed",
  ];
  if (!idempotencyKey || !taskId || !allowedStatuses.includes(status)) {
    throw new ImageTaskLedgerError("store_corrupt", "任务台账记录缺少必要字段");
  }
  const historyId = firstNonEmptyString(raw.historyId);
  if (["processing", "success", "failed"].includes(status) && !historyId) {
    throw new ImageTaskLedgerError("store_corrupt", `任务 ${idempotencyKey} 缺少 historyId`);
  }
  return {
    taskId,
    idempotencyKey,
    requestHash: firstNonEmptyString(raw.requestHash),
    historyId,
    tokenFingerprint: firstNonEmptyString(raw.tokenFingerprint),
    status,
    rawStatus: raw.rawStatus === undefined ? undefined : Number(raw.rawStatus),
    failCode: raw.failCode === undefined ? undefined : String(raw.failCode),
    errorMessage: raw.errorMessage === undefined ? undefined : String(raw.errorMessage),
    count: Math.max(0, normalizeInteger(raw.count, 0)),
    imageUrls: Array.isArray(raw.imageUrls) ? raw.imageUrls.map(String) : [],
    createdAt: firstNonEmptyString(raw.createdAt, new Date(0).toISOString()),
    updatedAt: firstNonEmptyString(raw.updatedAt, raw.createdAt, new Date(0).toISOString()),
    context: raw.context && typeof raw.context === "object" && !Array.isArray(raw.context)
      ? raw.context
      : {},
  };
}

export class ImageTaskLedger {
  readonly storeDir: string;
  readonly storePath: string;
  private readonly records = new Map<string, ImageTaskRecord>();
  private readonly locks = new Map<string, Promise<void>>();
  private readonly now: () => Date;

  constructor(options: { storeDir: string; now?: () => Date }) {
    this.storeDir = options.storeDir;
    this.storePath = path.join(this.storeDir, "image-task-store.json");
    this.now = options.now || (() => new Date());
    this.load();
  }

  private backupCorruptStore(): string {
    const stamp = this.now().toISOString().replace(/[:.]/g, "-");
    const backupPath = `${this.storePath}.corrupt-${stamp}-${process.pid}`;
    try {
      fs.copyFileSync(this.storePath, backupPath, fs.constants.COPYFILE_EXCL);
      return backupPath;
    } catch {
      return "";
    }
  }

  private load(): void {
    if (!fs.existsSync(this.storePath)) return;
    let parsed: unknown;
    try {
      const contents = fs.readFileSync(this.storePath, "utf8");
      if (!contents.trim()) throw new Error("empty store");
      parsed = JSON.parse(contents);
      const rawRecords = Array.isArray(parsed)
        ? parsed
        : (parsed as StoreEnvelope)?.schemaVersion === IMAGE_TASK_STORE_SCHEMA_VERSION &&
            Array.isArray((parsed as StoreEnvelope).records)
          ? (parsed as StoreEnvelope).records
          : null;
      if (!rawRecords) throw new Error("unsupported store schema");
      for (const rawRecord of rawRecords) {
        const record = validateLoadedRecord(rawRecord);
        if (this.records.has(record.idempotencyKey)) {
          throw new Error(`duplicate key: ${record.idempotencyKey}`);
        }
        this.records.set(record.idempotencyKey, record);
      }
    } catch (error) {
      const backupPath = this.backupCorruptStore();
      throw new ImageTaskLedgerError(
        "store_corrupt",
        `图片任务台账损坏，服务拒绝以空台账启动${backupPath ? `；备份：${backupPath}` : ""}`,
        { cause: safeErrorMessage(error), backupPath }
      );
    }

    let recoveredReservation = false;
    for (const record of this.records.values()) {
      if (record.status === "reserved") {
        const asyncPhase = firstNonEmptyString(record.context?.asyncPhase);
        const safelyRecoverablePhases = new Set(["receiving", "queued", "uploading", "ready"]);
        if (!safelyRecoverablePhases.has(asyncPhase)) {
          record.status = "submission_unknown";
          record.failCode = "service_restarted_during_submission";
          record.errorMessage = "服务在取得 historyId 前重启，无法确认远端是否已提交";
          record.updatedAt = this.now().toISOString();
          recoveredReservation = true;
        }
      }
    }
    if (recoveredReservation) this.persist();
  }

  private persist(): void {
    fs.mkdirSync(this.storeDir, { recursive: true });
    const envelope: StoreEnvelope = {
      schemaVersion: IMAGE_TASK_STORE_SCHEMA_VERSION,
      records: [...this.records.values()].sort((left, right) =>
        left.idempotencyKey.localeCompare(right.idempotencyKey)
      ),
    };
    const tempPath = path.join(
      this.storeDir,
      `.image-task-store.${process.pid}.${crypto.randomUUID()}.tmp`
    );
    let fileDescriptor: number | undefined;
    try {
      fileDescriptor = fs.openSync(tempPath, "wx", 0o600);
      fs.writeFileSync(fileDescriptor, `${JSON.stringify(envelope, null, 2)}\n`, "utf8");
      fs.fsyncSync(fileDescriptor);
      fs.closeSync(fileDescriptor);
      fileDescriptor = undefined;
      fs.renameSync(tempPath, this.storePath);
      try {
        const directoryDescriptor = fs.openSync(this.storeDir, "r");
        fs.fsyncSync(directoryDescriptor);
        fs.closeSync(directoryDescriptor);
      } catch {
        // Windows and some filesystems do not permit fsync on directories.
      }
    } finally {
      if (fileDescriptor !== undefined) fs.closeSync(fileDescriptor);
      if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
    }
  }

  private async withKeyLock<T>(key: string, callback: () => Promise<T> | T): Promise<T> {
    const previous = this.locks.get(key) || Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => current);
    this.locks.set(key, tail);
    await previous;
    try {
      return await callback();
    } finally {
      release();
      if (this.locks.get(key) === tail) this.locks.delete(key);
    }
  }

  async reserve(input: ReservationInput): Promise<ReservationResult> {
    return this.withKeyLock(input.idempotencyKey, () => {
      const existing = this.records.get(input.idempotencyKey);
      if (existing) {
        if (!existing.requestHash) {
          throw new ImageTaskLedgerError(
            "legacy_record_unverifiable",
            `幂等键 ${input.idempotencyKey} 来自旧台账且没有 requestHash，禁止自动复用或重提`
          );
        }
        if (existing.requestHash !== input.requestHash) {
          throw new ImageTaskLedgerError(
            "idempotency_conflict",
            `幂等键 ${input.idempotencyKey} 的生成参数与首次请求不一致`,
            { idempotencyKey: input.idempotencyKey }
          );
        }
        return { created: false, record: cloneRecord(existing) };
      }

      const now = this.now().toISOString();
      const record: ImageTaskRecord = {
        taskId: input.taskId,
        idempotencyKey: input.idempotencyKey,
        requestHash: input.requestHash,
        historyId: "",
        tokenFingerprint: input.tokenFingerprint,
        status: "reserved",
        count: 0,
        imageUrls: [],
        createdAt: now,
        updatedAt: now,
        context: sanitizeContextValue(input.context) as Record<string, unknown>,
      };
      this.records.set(input.idempotencyKey, record);
      try {
        this.persist();
      } catch (error) {
        this.records.delete(input.idempotencyKey);
        throw error;
      }
      return { created: true, record: cloneRecord(record) };
    });
  }

  async releaseReservation(idempotencyKey: string, requestHash: string): Promise<void> {
    await this.withKeyLock(idempotencyKey, () => {
      const record = this.records.get(idempotencyKey);
      if (!record || record.requestHash !== requestHash || record.status !== "reserved") return;
      this.records.delete(idempotencyKey);
      try {
        this.persist();
      } catch (error) {
        this.records.set(idempotencyKey, record);
        throw error;
      }
    });
  }

  confirmReservationReleased(idempotencyKey: string): boolean {
    if (this.records.has(idempotencyKey)) return false;
    if (!fs.existsSync(this.storePath)) return true;
    try {
      const contents = fs.readFileSync(this.storePath, "utf8");
      const parsed = JSON.parse(contents);
      const rawRecords = Array.isArray(parsed)
        ? parsed
        : parsed?.schemaVersion === IMAGE_TASK_STORE_SCHEMA_VERSION && Array.isArray(parsed?.records)
          ? parsed.records
          : null;
      if (!rawRecords) throw new Error("unsupported store schema");
      return !rawRecords.some((record: unknown) =>
        firstNonEmptyString((record as Record<string, unknown>)?.idempotencyKey) === idempotencyKey
      );
    } catch (error) {
      throw new ImageTaskLedgerError(
        "store_readback_failed",
        "图片任务台账释放后回读失败，禁止自动重试",
        { cause: safeErrorMessage(error) }
      );
    }
  }

  async submitReserved(
    idempotencyKey: string,
    requestHash: string,
    submit: (onBeforeRemoteSubmit: () => Promise<void>) => Promise<{ historyId: string }>
  ): Promise<{ reused: boolean; record: ImageTaskRecord }> {
    return this.withKeyLock(idempotencyKey, async () => {
      const record = this.records.get(idempotencyKey);
      if (!record) {
        throw new ImageTaskLedgerError("missing_reservation", `幂等键 ${idempotencyKey} 没有提交占位`);
      }
      if (record.requestHash !== requestHash) {
        throw new ImageTaskLedgerError("idempotency_conflict", `幂等键 ${idempotencyKey} 的 requestHash 冲突`);
      }
      if (record.status !== "reserved") return { reused: true, record: cloneRecord(record) };

      const asyncPhase = firstNonEmptyString(record.context?.asyncPhase);
      let remoteSubmitStarted = false;
      const onBeforeRemoteSubmit = async () => {
        if (remoteSubmitStarted) return;
        if (record.status !== "reserved") {
          throw new ImageTaskLedgerError(
            "reservation_state_conflict",
            `幂等键 ${idempotencyKey} 已不处于可提交状态`
          );
        }
        const previousContext = cloneRecord(record).context;
        if (asyncPhase) {
          record.context.asyncPhase = "submitting";
          record.context.submittingAt = this.now().toISOString();
          record.updatedAt = this.now().toISOString();
          try {
            // Point of no return: this callback is invoked only after a global
            // generation slot is acquired and immediately before the paid POST.
            this.persist();
          } catch (error) {
            record.context = previousContext;
            throw error;
          }
        }
        remoteSubmitStarted = true;
      };

      try {
        const submitted = await submit(onBeforeRemoteSubmit);
        const historyId = firstNonEmptyString(submitted?.historyId);
        if (!historyId) throw new Error("即梦提交响应缺少 historyId");
        record.historyId = historyId;
        record.status = "processing";
        if (asyncPhase) record.context.asyncPhase = "submitted";
        record.failCode = undefined;
        record.errorMessage = undefined;
        record.updatedAt = this.now().toISOString();
        this.persist();
      } catch (error) {
        if (asyncPhase && !remoteSubmitStarted) {
          // Credit/preflight/gate failures are safely recoverable. Keep the
          // reservation in ready state so a status recovery can resume it.
          record.context.asyncPhase = "ready";
          delete record.context.submittingAt;
          record.errorMessage = safeErrorMessage(error);
          record.updatedAt = this.now().toISOString();
          this.persist();
          throw error;
        }
        record.status = "submission_unknown";
        record.failCode = "submission_unknown";
        record.errorMessage = safeErrorMessage(error);
        record.updatedAt = this.now().toISOString();
        this.persist();
      }
      return { reused: false, record: cloneRecord(record) };
    });
  }

  get(idempotencyKey: string): ImageTaskRecord | undefined {
    const record = this.records.get(idempotencyKey);
    return record ? cloneRecord(record) : undefined;
  }

  findByUploadKey(uploadKey: string): ImageTaskRecord[] {
    const normalized = firstNonEmptyString(uploadKey);
    if (!normalized) return [];
    return [...this.records.values()]
      .filter((record) => firstNonEmptyString(record.context?.uploadKey) === normalized)
      .map(cloneRecord);
  }

  async setReservedAsyncPhase(
    idempotencyKey: string,
    requestHash: string,
    phase: "receiving" | "queued" | "uploading" | "ready"
  ): Promise<ImageTaskRecord> {
    return this.withKeyLock(idempotencyKey, () => {
      const record = this.records.get(idempotencyKey);
      if (!record) throw new ImageTaskLedgerError("missing_reservation", `幂等键 ${idempotencyKey} 没有提交占位`);
      if (record.requestHash !== requestHash) {
        throw new ImageTaskLedgerError("idempotency_conflict", `幂等键 ${idempotencyKey} 的 requestHash 冲突`);
      }
      if (record.status !== "reserved") return cloneRecord(record);
      record.context.asyncPhase = phase;
      record.updatedAt = this.now().toISOString();
      this.persist();
      return cloneRecord(record);
    });
  }

  async setAsyncBatchMetrics(
    idempotencyKey: string,
    requestHash: string,
    metrics: { cacheHit: boolean; uploadDurationMs: number }
  ): Promise<ImageTaskRecord> {
    return this.withKeyLock(idempotencyKey, () => {
      const record = this.records.get(idempotencyKey);
      if (!record) throw new ImageTaskLedgerError("missing_reservation", `幂等键 ${idempotencyKey} 没有任务记录`);
      if (record.requestHash !== requestHash) {
        throw new ImageTaskLedgerError("idempotency_conflict", `幂等键 ${idempotencyKey} 的 requestHash 冲突`);
      }
      record.context.asyncBatchCacheHit = metrics.cacheHit === true;
      record.context.asyncBatchUploadDurationMs = Math.max(
        0,
        Math.trunc(Number(metrics.uploadDurationMs) || 0)
      );
      record.updatedAt = this.now().toISOString();
      this.persist();
      return cloneRecord(record);
    });
  }

  async updateFromPoll(
    idempotencyKey: string,
    result: {
      historyId: string;
      status: "processing" | "success" | "failed";
      rawStatus?: number;
      failCode?: string;
      count?: number;
      imageUrls?: string[];
    }
  ): Promise<ImageTaskRecord> {
    return this.withKeyLock(idempotencyKey, () => {
      const record = this.records.get(idempotencyKey);
      if (!record) throw new ImageTaskLedgerError("missing_task_record", `找不到幂等键 ${idempotencyKey}`);
      if (!record.historyId || record.historyId !== String(result.historyId)) {
        throw new ImageTaskLedgerError("history_id_conflict", `幂等键 ${idempotencyKey} 的 historyId 不一致`);
      }
      record.status = result.status;
      record.rawStatus = result.rawStatus;
      record.failCode = result.failCode;
      record.count = Math.max(0, normalizeInteger(result.count, 0));
      record.imageUrls = Array.isArray(result.imageUrls) ? result.imageUrls.map(String) : [];
      record.updatedAt = this.now().toISOString();
      this.persist();
      return cloneRecord(record);
    });
  }

  resolveToken(record: ImageTaskRecord, tokens: string[]): string {
    if (!record.tokenFingerprint) {
      throw new ImageTaskLedgerError(
        "token_fingerprint_unavailable",
        `幂等键 ${record.idempotencyKey} 没有 token 指纹，禁止按数组下标猜测账号`
      );
    }
    const token = tokens.find((candidate) => fingerprintToken(candidate) === record.tokenFingerprint);
    if (!token) {
      throw new ImageTaskLedgerError(
        "token_fingerprint_unavailable",
        `幂等键 ${record.idempotencyKey} 对应的 refresh_token 已不在当前配置中`
      );
    }
    return token;
  }
}

function publicRecord(record: ImageTaskRecord, reused: boolean): PublicImageTaskRecord {
  const { tokenFingerprint: _tokenFingerprint, ...safe } = cloneRecord(record);
  return { ...safe, reused };
}

function validateBatchTasks(tasks: Record<string, any>[]): void {
  if (!Array.isArray(tasks) || tasks.length === 0 || tasks.length > 5) {
    throw new ImageTaskLedgerError("invalid_tasks", "tasks 必须包含 1-5 个任务");
  }
  const keys = new Set<string>();
  for (const task of tasks) {
    const idempotencyKey = firstNonEmptyString(task?.idempotencyKey);
    if (!idempotencyKey) throw new ImageTaskLedgerError("missing_idempotency_key", "每个任务都必须提供 idempotencyKey");
    if (keys.has(idempotencyKey)) {
      throw new ImageTaskLedgerError("duplicate_idempotency_key", `批次内幂等键重复：${idempotencyKey}`);
    }
    keys.add(idempotencyKey);
    if (!firstNonEmptyString(task?.taskId)) throw new ImageTaskLedgerError("missing_task_id", "每个任务都必须提供 taskId");
    if (!firstNonEmptyString(task?.prompt)) throw new ImageTaskLedgerError("missing_prompt", "每个任务都必须提供 prompt");
  }
}

type CreatedReservation = ReservationResult & {
  task: Record<string, any>;
  requestHash: string;
};

async function releaseReservationsAndConfirm(
  ledger: ImageTaskLedger,
  reservations: CreatedReservation[],
  stage: string,
  failureDetails: Record<string, unknown> = {}
): Promise<void> {
  const created = reservations.filter((entry) => entry.created);
  if (created.length === 0) return;

  const releaseErrors: Array<{ idempotencyKey: string; error: string }> = [];
  for (const entry of created) {
    try {
      await ledger.releaseReservation(entry.record.idempotencyKey, entry.requestHash);
    } catch (error) {
      releaseErrors.push({
        idempotencyKey: entry.record.idempotencyKey,
        error: safeErrorMessage(error),
      });
    }
  }

  const unconfirmedKeys: string[] = [];
  for (const entry of created) {
    try {
      if (!ledger.confirmReservationReleased(entry.record.idempotencyKey)) {
        unconfirmedKeys.push(entry.record.idempotencyKey);
      }
    } catch (error) {
      releaseErrors.push({
        idempotencyKey: entry.record.idempotencyKey,
        error: safeErrorMessage(error),
      });
    }
  }

  if (releaseErrors.length > 0 || unconfirmedKeys.length > 0) {
    throw new ImageTaskLedgerError(
      "reservation_release_unconfirmed",
      "参考图上传失败后无法确认幂等占位已释放，已按 fail-closed 停止自动重试",
      {
        ...failureDetails,
        stage,
        retryable: false,
        reservationsReleased: false,
        reservationState: "unconfirmed",
        reservationCount: created.length,
        unconfirmedKeys,
        releaseErrors,
      }
    );
  }
}

function imageUploadPreSubmitError(
  error: unknown,
  imageCount: number,
  reservationCount: number,
  reservationsReleased: boolean
): ImageTaskLedgerError {
  if (error instanceof ImageInputUploadError) {
    return new ImageTaskLedgerError(
      "image_upload_pre_submit",
      error.message,
      {
        ...error.details,
        reservationsReleased,
        reservationState: reservationsReleased ? "released" : "unconfirmed",
        reservationCount,
      }
    );
  }

  const cause = sanitizeImageUploadError(error);
  const statusCode = getImageUploadErrorStatusCode(error);
  const retryable = isRetryableImageUploadError(error);
  return new ImageTaskLedgerError(
    "image_upload_pre_submit",
    `参考图上传在创建 historyId 前失败：${cause}`,
    {
      phase: "image_upload_pre_submit",
      stage: getImageInputUploadFailureStage(error),
      imageIndex: 0,
      imageCount,
      fileName: "",
      sourceFileName: "",
      attempts: 1,
      attemptCount: 1,
      retryable,
      automaticRetriesExhausted: false,
      retryExhausted: false,
      status: statusCode,
      statusCode,
      networkCode: getImageUploadNetworkCode(error),
      cause,
      reservationsReleased,
      reservationState: reservationsReleased ? "released" : "unconfirmed",
      reservationCount,
    }
  );
}

export async function reserveIdempotentBatchForAsync(input: {
  ledger: ImageTaskLedger;
  batchKey: string;
  tasks: Record<string, any>[];
  common?: Record<string, any>;
  sourceImages: SourceImageMetadata[];
  tokenFingerprint: string;
  uploadKey: string;
}): Promise<{
  batchKey: string;
  reservations: AsyncBatchReservation[];
  tasks: PublicImageTaskRecord[];
  createdCount: number;
  reusedCount: number;
}> {
  validateBatchTasks(input.tasks);
  const normalizedSourceImages = normalizeSourceImageMetadata(input.sourceImages);
  const tokenFingerprint = firstNonEmptyString(input.tokenFingerprint);
  const uploadKey = firstNonEmptyString(input.uploadKey);
  if (!tokenFingerprint) throw new ImageTaskLedgerError("missing_token", "token 指纹不能为空");
  if (!uploadKey) throw new ImageTaskLedgerError("missing_upload_key", "异步上传必须提供 uploadKey");
  const common = input.common || {};
  const reservations: AsyncBatchReservation[] = [];
  try {
    for (const task of input.tasks) {
      const requestHash = buildImageTaskRequestHash({
        task,
        common,
        sourceImages: normalizedSourceImages,
      });
      const reservation = await input.ledger.reserve({
        taskId: String(task.taskId),
        idempotencyKey: String(task.idempotencyKey),
        requestHash,
        tokenFingerprint,
        context: {
          ...task,
          sourceImages: normalizedSourceImages,
          uploadKey,
          asyncPhase: "receiving",
          remoteSubmitId: crypto.randomUUID(),
        },
      });
      reservations.push({
        created: reservation.created,
        needsSubmission: reservation.record.status === "reserved",
        releaseOnPreSubmit: reservation.created,
        requestHash,
        task,
        record: reservation.record,
      });
    }
  } catch (error) {
    await releaseReservationsAndConfirm(
      input.ledger,
      reservations as CreatedReservation[],
      "async_reservation_setup"
    );
    throw error;
  }
  return {
    batchKey: firstNonEmptyString(input.batchKey, input.tasks[0]?.idempotencyKey),
    reservations,
    tasks: reservations.map((entry) => publicRecord(entry.record, !entry.created)),
    createdCount: reservations.filter((entry) => entry.created).length,
    reusedCount: reservations.filter((entry) => !entry.created).length,
  };
}

export async function setAsyncReservationsPhase(
  ledger: ImageTaskLedger,
  reservations: AsyncBatchReservation[],
  phase: "receiving" | "queued" | "uploading" | "ready"
): Promise<void> {
  for (const reservation of reservations) {
    if (!reservation.needsSubmission) continue;
    await ledger.setReservedAsyncPhase(
      reservation.record.idempotencyKey,
      reservation.requestHash,
      phase
    );
  }
}

export async function setAsyncBatchMetrics(
  ledger: ImageTaskLedger,
  reservations: AsyncBatchReservation[],
  metrics: { cacheHit: boolean; uploadDurationMs: number }
): Promise<void> {
  for (const reservation of reservations) {
    if (!ledger.get(reservation.record.idempotencyKey)) continue;
    await ledger.setAsyncBatchMetrics(
      reservation.record.idempotencyKey,
      reservation.requestHash,
      metrics
    );
  }
}

export async function releaseAsyncReservationsAndConfirm(
  ledger: ImageTaskLedger,
  reservations: AsyncBatchReservation[],
  stage: string,
  failureDetails: Record<string, unknown> = {}
): Promise<void> {
  await releaseReservationsAndConfirm(
    ledger,
    reservations.map((reservation) => ({
      ...reservation,
      created: reservation.releaseOnPreSubmit,
    })) as CreatedReservation[],
    stage,
    failureDetails
  );
}

export function adoptRecoverableAsyncReservations(
  ledger: ImageTaskLedger,
  reservations: AsyncBatchReservation[]
): AsyncBatchReservation[] {
  return reservations.map((reservation) => {
    const current = ledger.get(reservation.record.idempotencyKey);
    const phase = firstNonEmptyString(current?.context?.asyncPhase);
    const recoverable = current?.status === "reserved" &&
      ["receiving", "queued", "uploading", "ready"].includes(phase);
    return {
      ...reservation,
      needsSubmission: recoverable,
      releaseOnPreSubmit: reservation.created || recoverable,
      record: current || reservation.record,
    };
  });
}

export async function submitIdempotentBatch(input: SubmitBatchInput): Promise<{
  ok: boolean;
  code?: string;
  batchKey: string;
  taskCount: number;
  concurrency: number;
  reusedCount: number;
  submittedCount: number;
  unknownCount: number;
  tasks: PublicImageTaskRecord[];
}> {
  validateBatchTasks(input.tasks);
  if (!Array.isArray(input.images) || input.images.length === 0 || input.images.length > 10) {
    throw new ImageTaskLedgerError("invalid_images", "images 必须包含 1-10 张参考图");
  }
  if (!Array.isArray(input.tokens) || input.tokens.length === 0) {
    throw new ImageTaskLedgerError("missing_token", "未配置可用的 refresh_token");
  }
  const normalizedSourceImages = normalizeSourceImageMetadata(input.sourceImages);
  if (normalizedSourceImages.length !== input.images.length) {
    throw new ImageTaskLedgerError(
      "source_image_count_mismatch",
      "sourceImages 必须与 images 按顺序一一对应"
    );
  }
  const common = input.common || {};
  const batchKey = firstNonEmptyString(input.batchKey, input.tasks[0].idempotencyKey);
  const token = input.tokens[stableIndex(batchKey, input.tokens.length)];
  const tokenFingerprint = fingerprintToken(token);
  const concurrency = normalizeGenerationConcurrency(input.concurrency);

  const reservations: CreatedReservation[] = [];
  try {
    for (const task of input.tasks) {
      const requestHash = buildImageTaskRequestHash({ task, common, sourceImages: normalizedSourceImages });
      const context = {
        ...task,
        sourceImages: normalizedSourceImages,
      };
      const reservation = await input.ledger.reserve({
        taskId: String(task.taskId),
        idempotencyKey: String(task.idempotencyKey),
        requestHash,
        tokenFingerprint,
        context,
      });
      reservations.push({ ...reservation, task, requestHash });
    }
  } catch (error) {
    await releaseReservationsAndConfirm(input.ledger, reservations, "reservation_setup");
    throw error;
  }

  const newReservations = reservations.filter((entry) => entry.created);
  let uploadedImageIds: string[] = [];
  if (newReservations.length > 0) {
    try {
      uploadedImageIds = await input.uploadImages(input.images, token, normalizedSourceImages);
      if (!Array.isArray(uploadedImageIds) || uploadedImageIds.length !== input.images.length) {
        throw new Error(`参考图上传响应数量异常：期望 ${input.images.length}，实际 ${uploadedImageIds?.length || 0}`);
      }
    } catch (error) {
      const pendingError = imageUploadPreSubmitError(
        error,
        input.images.length,
        newReservations.length,
        false
      );
      await releaseReservationsAndConfirm(
        input.ledger,
        newReservations,
        String(pendingError.details?.stage || "image_upload_pre_submit"),
        pendingError.details
      );
      throw imageUploadPreSubmitError(error, input.images.length, newReservations.length, true);
    }
  }

  const submitted = await mapWithConcurrency(reservations, concurrency, async (entry) => {
    if (!entry.created) return { reused: true, record: entry.record };
    return input.ledger.submitReserved(
      entry.record.idempotencyKey,
      entry.requestHash,
      () => input.submitTask({
        task: entry.task,
        common,
        uploadedImageIds,
        token,
      })
    );
  });
  const tasks = submitted.map((entry) => publicRecord(entry.record, entry.reused));
  const unknownCount = tasks.filter((task) => task.status === "submission_unknown").length;
  return {
    ok: unknownCount === 0,
    code: unknownCount > 0 ? "submission_unknown" : undefined,
    batchKey,
    taskCount: tasks.length,
    concurrency,
    reusedCount: tasks.filter((task) => task.reused).length,
    submittedCount: tasks.filter((task) => !task.reused && task.historyId).length,
    unknownCount,
    tasks,
  };
}

export async function queryIdempotentBatch(input: QueryBatchInput): Promise<{
  ok: true;
  batchKey: string;
  phase: string;
  pollCount: number;
  maxPollCount: number;
  taskCount: number;
  successCount: number;
  failedCount: number;
  unknownCount: number;
  pendingCount: number;
  terminalCount: number;
  allTerminal: boolean;
  tasks: PublicImageTaskRecord[];
}> {
  if (!Array.isArray(input.tasks) || input.tasks.length === 0 || input.tasks.length > 5) {
    throw new ImageTaskLedgerError("invalid_tasks", "tasks 必须包含 1-5 个任务");
  }
  if (!Array.isArray(input.tokens) || input.tokens.length === 0) {
    throw new ImageTaskLedgerError("missing_token", "未配置可用的 refresh_token");
  }
  const concurrency = normalizeStatusConcurrency(input.concurrency);
  const tasks = await mapWithConcurrency(input.tasks, concurrency, async (requestedTask) => {
    const idempotencyKey = firstNonEmptyString(requestedTask.idempotencyKey);
    if (!idempotencyKey) throw new ImageTaskLedgerError("missing_idempotency_key", "状态查询缺少 idempotencyKey");
    const stored = input.ledger.get(idempotencyKey);
    if (!stored) throw new ImageTaskLedgerError("missing_task_record", `找不到幂等键 ${idempotencyKey}`);
    const requestedHistoryId = firstNonEmptyString(requestedTask.historyId);
    if (requestedHistoryId && stored.historyId && requestedHistoryId !== stored.historyId) {
      throw new ImageTaskLedgerError("history_id_conflict", `幂等键 ${idempotencyKey} 的 historyId 不一致`);
    }
    if (stored.status !== "processing") return publicRecord(stored, true);
    const token = input.ledger.resolveToken(stored, input.tokens);
    const result = await input.queryTask(stored.historyId, token);
    const updated = await input.ledger.updateFromPoll(idempotencyKey, result);
    return publicRecord(updated, true);
  });

  const successCount = tasks.filter((task) => task.status === "success").length;
  const failedCount = tasks.filter((task) => task.status === "failed").length;
  const unknownCount = tasks.filter((task) => task.status === "submission_unknown").length;
  const pendingCount = tasks.filter((task) =>
    task.status === "processing" || task.status === "reserved"
  ).length;
  const terminalCount = successCount + failedCount + unknownCount;
  return {
    // ok only describes whether this status request was handled successfully.
    // Task progress and terminal state are represented separately below.
    ok: true,
    batchKey: firstNonEmptyString(input.batchKey),
    phase: firstNonEmptyString(input.phase, "initial"),
    pollCount: Math.max(0, normalizeInteger(input.pollCount, 0)),
    maxPollCount: Math.max(1, normalizeInteger(input.maxPollCount, 120)),
    taskCount: tasks.length,
    successCount,
    failedCount,
    unknownCount,
    pendingCount,
    terminalCount,
    allTerminal: pendingCount === 0,
    tasks,
  };
}
