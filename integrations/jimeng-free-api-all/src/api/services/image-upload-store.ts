import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const IMAGE_UPLOAD_STORE_SCHEMA_VERSION = 1;
export const IMAGE_UPLOAD_REUSE_TTL_MS = 2 * 60 * 60 * 1000;
export const IMAGE_UPLOAD_BATCH_DEADLINE_MS = 15 * 60 * 1000;

export type ImageUploadSetStatus =
  | "receiving"
  | "queued"
  | "uploading"
  | "ready"
  | "failed_pre_submit";

export type ImageUploadItemStatus =
  | "awaiting_source"
  | "received"
  | "uploading"
  | "uploaded";

export type ImageUploadSourceMetadata = Record<string, unknown> | string;

export type ImageUploadItemRecord = {
  index: number;
  sourceFileName: string;
  sourceMetadataHash: string;
  spoolFileName: string;
  status: ImageUploadItemStatus;
  contentHash: string;
  byteLength: number;
  uploadedImageId: string;
  attempts: number;
  retryCount: number;
  lastStage?: string;
  lastErrorCode?: string;
  updatedAt: string;
};

export type ImageUploadSetRecord = {
  uploadKey: string;
  sourceSubmissionId: string;
  sourceMetadataHash: string;
  tokenFingerprint: string;
  status: ImageUploadSetStatus;
  imageCount: number;
  images: ImageUploadItemRecord[];
  acceptedAt: string;
  updatedAt: string;
  reusableUntil: string;
  deadlineAt: string;
  uploadStartedAt?: string;
  uploadCompletedAt?: string;
  failureCode?: string;
  failureStage?: string;
  errorMessage?: string;
};

export type PublicImageUploadState = {
  uploadKey: string;
  batchStatus: ImageUploadSetStatus;
  nextPollAfterSeconds: number;
  cacheHit: boolean;
  uploadDurationMs: number;
  uploadProgress: {
    total: number;
    completed: number;
    retryCount: number;
  };
  failureCode?: string;
  failureStage?: string;
  errorMessage?: string;
};

type StoreEnvelope = {
  schemaVersion: number;
  records: ImageUploadSetRecord[];
};

export class ImageUploadStoreError extends Error {
  readonly code: string;
  readonly details?: Record<string, unknown>;

  constructor(code: string, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = "ImageUploadStoreError";
    this.code = code;
    this.details = details;
  }
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value));
}

function firstNonEmptyString(...values: unknown[]): string {
  for (const value of values) {
    const normalized = String(value ?? "").trim();
    if (normalized) return normalized;
  }
  return "";
}

function stableValue(value: unknown): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : String(value);
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
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

function sha256(value: string | Buffer): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function safeMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error ?? "unknown error");
  return raw
    .replace(/https?:\/\/[^\s"'<>]+/gi, "<redacted-url>")
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer <redacted>")
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 500);
}

function portableBasename(value: string): string {
  const normalized = value.replace(/\\/g, "/");
  return normalized.slice(normalized.lastIndexOf("/") + 1);
}

function normalizeSourceMetadata(
  entries: ImageUploadSourceMetadata[]
): Array<Record<string, unknown>> {
  if (!Array.isArray(entries) || entries.length < 1 || entries.length > 10) {
    throw new ImageUploadStoreError(
      "invalid_source_images",
      "sourceImages 必须包含 1-10 条稳定源图元数据"
    );
  }
  return entries.map((entry, index) => {
    const raw = typeof entry === "string" ? { sourceFileName: entry } : entry;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw new ImageUploadStoreError(
        "invalid_source_image_metadata",
        `sourceImages[${index}] 不是有效对象`
      );
    }
    const sourceFileName = portableBasename(firstNonEmptyString(
      raw.sourceFileName,
      raw.fileName,
      raw.filename,
      raw.name,
      raw.sourceFilePath,
      raw.filePath,
      raw.path
    ));
    const declaredContentHash = firstNonEmptyString(
      raw.sha256,
      raw.contentHash,
      raw.fileHash,
      raw.hash
    ).toLowerCase();
    if (!sourceFileName && !declaredContentHash) {
      throw new ImageUploadStoreError(
        "unstable_source_image_metadata",
        `sourceImages[${index}] 缺少稳定文件名或内容哈希`
      );
    }
    const fileSize = Number(raw.fileSize ?? raw.bytes ?? raw.size);
    return {
      orderedIndex: index,
      originalIndex: Number.isInteger(Number(raw.originalIndex ?? raw.inputIndex))
        ? Number(raw.originalIndex ?? raw.inputIndex)
        : index,
      ...(sourceFileName ? { sourceFileName } : {}),
      ...(declaredContentHash ? { declaredContentHash } : {}),
      ...(Number.isFinite(fileSize) && fileSize >= 0 ? { fileSize } : {}),
      mimeType: firstNonEmptyString(raw.mimeType, raw.mime, raw.contentType).toLowerCase(),
      fileExtension: firstNonEmptyString(
        raw.fileExtension,
        raw.extension,
        sourceFileName.includes(".") ? sourceFileName.slice(sourceFileName.lastIndexOf(".") + 1) : ""
      ).replace(/^\./, "").toLowerCase(),
    };
  });
}

export function buildImageUploadSourceMetadataHash(
  sourceImages: ImageUploadSourceMetadata[]
): string {
  return sha256(JSON.stringify(stableValue(normalizeSourceMetadata(sourceImages))));
}

export function expectedE002UploadKey(sourceSubmissionId: string): string {
  const normalized = String(sourceSubmissionId || "").trim();
  if (!normalized) {
    throw new ImageUploadStoreError(
      "missing_source_submission_id",
      "uploadKey 必须对应非空 sourceSubmissionId"
    );
  }
  return `E002:v1:${normalized}:source-images`;
}

export function validateE002UploadKey(uploadKey: string, sourceSubmissionId: string): string {
  const normalized = String(uploadKey || "").trim();
  const expected = expectedE002UploadKey(sourceSubmissionId);
  if (normalized !== expected) {
    throw new ImageUploadStoreError(
      "invalid_upload_key",
      `uploadKey 必须严格为 ${expected}`,
      { expectedUploadKey: expected }
    );
  }
  return normalized;
}

function parseIso(value: unknown, field: string): number {
  const parsed = Date.parse(String(value || ""));
  if (!Number.isFinite(parsed)) {
    throw new ImageUploadStoreError("store_corrupt", `上传台账字段 ${field} 不是有效时间`);
  }
  return parsed;
}

function validateRecord(value: unknown): ImageUploadSetRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ImageUploadStoreError("store_corrupt", "上传台账包含非对象记录");
  }
  const raw = value as Record<string, any>;
  const statuses: ImageUploadSetStatus[] = [
    "receiving",
    "queued",
    "uploading",
    "ready",
    "failed_pre_submit",
  ];
  const imageStatuses: ImageUploadItemStatus[] = [
    "awaiting_source",
    "received",
    "uploading",
    "uploaded",
  ];
  const uploadKey = firstNonEmptyString(raw.uploadKey);
  const sourceSubmissionId = firstNonEmptyString(raw.sourceSubmissionId);
  const status = firstNonEmptyString(raw.status) as ImageUploadSetStatus;
  if (!uploadKey || !sourceSubmissionId || !statuses.includes(status)) {
    throw new ImageUploadStoreError("store_corrupt", "上传台账记录缺少必要字段");
  }
  validateE002UploadKey(uploadKey, sourceSubmissionId);
  const images = Array.isArray(raw.images)
    ? raw.images.map((entry: Record<string, any>, index: number): ImageUploadItemRecord => {
        const imageStatus = firstNonEmptyString(entry?.status) as ImageUploadItemStatus;
        if (!entry || !imageStatuses.includes(imageStatus) || Number(entry.index) !== index) {
          throw new ImageUploadStoreError("store_corrupt", `${uploadKey} 图片记录顺序或状态无效`);
        }
        const spoolFileName = firstNonEmptyString(entry.spoolFileName);
        if (!/^image-\d{3}\.cache$/.test(spoolFileName)) {
          throw new ImageUploadStoreError("store_corrupt", `${uploadKey} 缓存文件名无效`);
        }
        const uploadedImageId = firstNonEmptyString(entry.uploadedImageId);
        if (imageStatus === "uploaded" && !uploadedImageId) {
          throw new ImageUploadStoreError("store_corrupt", `${uploadKey} 已上传图片缺少 uploadedImageId`);
        }
        return {
          index,
          sourceFileName: firstNonEmptyString(entry.sourceFileName),
          sourceMetadataHash: firstNonEmptyString(entry.sourceMetadataHash),
          spoolFileName,
          status: imageStatus,
          contentHash: firstNonEmptyString(entry.contentHash),
          byteLength: Math.max(0, Number(entry.byteLength) || 0),
          uploadedImageId,
          attempts: Math.max(0, Number(entry.attempts) || 0),
          retryCount: Math.max(0, Number(entry.retryCount) || 0),
          lastStage: entry.lastStage === undefined ? undefined : String(entry.lastStage),
          lastErrorCode: entry.lastErrorCode === undefined ? undefined : String(entry.lastErrorCode),
          updatedAt: firstNonEmptyString(entry.updatedAt, raw.updatedAt),
        };
      })
    : [];
  const imageCount = Number(raw.imageCount);
  if (!Number.isInteger(imageCount) || imageCount < 1 || imageCount > 10 || images.length !== imageCount) {
    throw new ImageUploadStoreError("store_corrupt", `${uploadKey} 图片数量无效`);
  }
  parseIso(raw.acceptedAt, "acceptedAt");
  parseIso(raw.updatedAt, "updatedAt");
  parseIso(raw.reusableUntil, "reusableUntil");
  parseIso(raw.deadlineAt, "deadlineAt");
  if (status === "ready" && images.some((image) => image.status !== "uploaded")) {
    throw new ImageUploadStoreError("store_corrupt", `${uploadKey} ready 状态与图片记录不一致`);
  }
  return {
    uploadKey,
    sourceSubmissionId,
    sourceMetadataHash: firstNonEmptyString(raw.sourceMetadataHash),
    tokenFingerprint: firstNonEmptyString(raw.tokenFingerprint),
    status,
    imageCount,
    images,
    acceptedAt: String(raw.acceptedAt),
    updatedAt: String(raw.updatedAt),
    reusableUntil: String(raw.reusableUntil),
    deadlineAt: String(raw.deadlineAt),
    uploadStartedAt: raw.uploadStartedAt === undefined ? undefined : String(raw.uploadStartedAt),
    uploadCompletedAt: raw.uploadCompletedAt === undefined ? undefined : String(raw.uploadCompletedAt),
    failureCode: raw.failureCode === undefined ? undefined : String(raw.failureCode),
    failureStage: raw.failureStage === undefined ? undefined : String(raw.failureStage),
    errorMessage: raw.errorMessage === undefined ? undefined : String(raw.errorMessage),
  };
}

export class ImageUploadStore {
  readonly storeDir: string;
  readonly storePath: string;
  readonly cacheRoot: string;
  private readonly records = new Map<string, ImageUploadSetRecord>();
  private readonly locks = new Map<string, Promise<void>>();
  private readonly now: () => Date;

  constructor(options: { storeDir: string; now?: () => Date }) {
    this.storeDir = path.resolve(options.storeDir);
    this.storePath = path.join(this.storeDir, "image-upload-store.json");
    this.cacheRoot = path.join(this.storeDir, "source-cache");
    this.now = options.now || (() => new Date());
    this.loadAndReconcile();
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

  private loadAndReconcile(): void {
    if (!fs.existsSync(this.storePath)) return;
    try {
      const contents = fs.readFileSync(this.storePath, "utf8");
      if (!contents.trim()) throw new Error("empty store");
      const parsed = JSON.parse(contents) as StoreEnvelope;
      if (
        parsed?.schemaVersion !== IMAGE_UPLOAD_STORE_SCHEMA_VERSION ||
        !Array.isArray(parsed.records)
      ) {
        throw new Error("unsupported store schema");
      }
      for (const value of parsed.records) {
        const record = validateRecord(value);
        if (this.records.has(record.uploadKey)) throw new Error(`duplicate uploadKey: ${record.uploadKey}`);
        this.records.set(record.uploadKey, record);
      }
      if (this.reconcileAfterRestart()) this.persist();
    } catch (error) {
      const backupPath = this.backupCorruptStore();
      throw new ImageUploadStoreError(
        "store_corrupt",
        `参考图上传台账损坏，服务拒绝以空台账启动${backupPath ? `；备份：${backupPath}` : ""}`,
        { cause: safeMessage(error), backupPath }
      );
    }
  }

  private reconcileAfterRestart(): boolean {
    let changed = false;
    const nowMs = this.now().getTime();
    for (const record of this.records.values()) {
      if (record.status === "ready" || record.status === "failed_pre_submit") continue;
      if (nowMs >= Date.parse(record.deadlineAt)) {
        this.applyFailure(record, "upload_deadline_exceeded", "upload_deadline", "参考图上传超过 15 分钟总墙钟上限");
        changed = true;
        continue;
      }
      for (const image of record.images) {
        if (image.status === "uploaded") continue;
        const cachePath = this.cachePath(record.uploadKey, image.spoolFileName);
        if (image.status === "uploading") {
          image.status = fs.existsSync(cachePath) ? "received" : "awaiting_source";
          image.updatedAt = this.now().toISOString();
          changed = true;
        } else if (image.status === "received" && !fs.existsSync(cachePath)) {
          image.status = "awaiting_source";
          image.contentHash = "";
          image.byteLength = 0;
          image.updatedAt = this.now().toISOString();
          changed = true;
        } else if (image.status === "awaiting_source" && fs.existsSync(cachePath)) {
          const bytes = fs.readFileSync(cachePath);
          image.contentHash = sha256(bytes);
          image.byteLength = bytes.length;
          image.status = "received";
          image.updatedAt = this.now().toISOString();
          changed = true;
        }
      }
      const hasMissingSource = record.images.some((image) =>
        image.status === "awaiting_source"
      );
      record.status = hasMissingSource ? "receiving" : "queued";
      record.updatedAt = this.now().toISOString();
      changed = true;
    }
    return changed;
  }

  private persist(): void {
    fs.mkdirSync(this.storeDir, { recursive: true });
    const envelope: StoreEnvelope = {
      schemaVersion: IMAGE_UPLOAD_STORE_SCHEMA_VERSION,
      records: [...this.records.values()].sort((left, right) =>
        left.uploadKey.localeCompare(right.uploadKey)
      ),
    };
    const tempPath = path.join(
      this.storeDir,
      `.image-upload-store.${process.pid}.${crypto.randomUUID()}.tmp`
    );
    let descriptor: number | undefined;
    try {
      descriptor = fs.openSync(tempPath, "wx", 0o600);
      fs.writeFileSync(descriptor, `${JSON.stringify(envelope, null, 2)}\n`, "utf8");
      fs.fsyncSync(descriptor);
      fs.closeSync(descriptor);
      descriptor = undefined;
      fs.renameSync(tempPath, this.storePath);
      try {
        const directoryDescriptor = fs.openSync(this.storeDir, "r");
        fs.fsyncSync(directoryDescriptor);
        fs.closeSync(directoryDescriptor);
      } catch {
        // Windows and some filesystems do not permit fsync on directories.
      }
    } finally {
      if (descriptor !== undefined) fs.closeSync(descriptor);
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

  private recordDirectory(uploadKey: string): string {
    return path.join(this.cacheRoot, sha256(uploadKey));
  }

  private cachePath(uploadKey: string, spoolFileName: string): string {
    const directory = this.recordDirectory(uploadKey);
    const resolved = path.resolve(directory, spoolFileName);
    if (!resolved.startsWith(`${path.resolve(directory)}${path.sep}`)) {
      throw new ImageUploadStoreError("unsafe_cache_path", "源图缓存路径越界");
    }
    return resolved;
  }

  private writeSourceAtomically(targetPath: string, bytes: Buffer): void {
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    const tempPath = `${targetPath}.${process.pid}.${crypto.randomUUID()}.tmp`;
    let descriptor: number | undefined;
    try {
      descriptor = fs.openSync(tempPath, "wx", 0o600);
      fs.writeFileSync(descriptor, bytes);
      fs.fsyncSync(descriptor);
      fs.closeSync(descriptor);
      descriptor = undefined;
      fs.renameSync(tempPath, targetPath);
    } finally {
      if (descriptor !== undefined) fs.closeSync(descriptor);
      if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
    }
  }

  private assertIdentity(record: ImageUploadSetRecord, input: {
    sourceSubmissionId: string;
    sourceMetadataHash: string;
    tokenFingerprint: string;
  }): void {
    if (
      record.sourceSubmissionId !== input.sourceSubmissionId ||
      record.sourceMetadataHash !== input.sourceMetadataHash ||
      record.tokenFingerprint !== input.tokenFingerprint
    ) {
      throw new ImageUploadStoreError(
        "upload_idempotency_conflict",
        `uploadKey ${record.uploadKey} 的源图或 token 与首次请求不一致`,
        { uploadKey: record.uploadKey }
      );
    }
  }

  async acceptSources(input: {
    uploadKey: string;
    sourceSubmissionId: string;
    sourceImages: ImageUploadSourceMetadata[];
    tokenFingerprint: string;
    readSource: (index: number, signal: AbortSignal) => Promise<Buffer>;
    signal?: AbortSignal;
  }): Promise<{ record: ImageUploadSetRecord; cacheHit: boolean }> {
    const uploadKey = validateE002UploadKey(input.uploadKey, input.sourceSubmissionId);
    const normalizedMetadata = normalizeSourceMetadata(input.sourceImages);
    const sourceMetadataHash = buildImageUploadSourceMetadataHash(input.sourceImages);
    const tokenFingerprint = String(input.tokenFingerprint || "").trim();
    if (!tokenFingerprint) {
      throw new ImageUploadStoreError("missing_token_fingerprint", "参考图上传必须提供 token 指纹");
    }
    return this.withKeyLock(uploadKey, async () => {
      let record = this.records.get(uploadKey);
      if (record) {
        this.assertIdentity(record, {
          sourceSubmissionId: input.sourceSubmissionId,
          sourceMetadataHash,
          tokenFingerprint,
        });
        if (
          record.status === "ready" &&
          this.now().getTime() < Date.parse(record.reusableUntil)
        ) {
          return { record: clone(record), cacheHit: true };
        }
        if (record.status === "ready") {
          // Expired uploaded IDs must never be reported as a cache hit. The
          // caller is only allowed to reach this branch after reserving a new
          // task set; no remote generation POST has happened for that set yet.
          // Reuse the verified local source cache, but force every TOS ID to be
          // uploaded again under a fresh accepted/deadline window.
          const refreshedAt = this.now();
          for (const image of record.images) {
            const cachePath = this.cachePath(record.uploadKey, image.spoolFileName);
            if (!fs.existsSync(cachePath)) {
              throw new ImageUploadStoreError(
                "upload_cache_expired",
                `uploadKey ${record.uploadKey} 已过复用期且源图缓存缺失，禁止静默复用旧 TOS ID`
              );
            }
            const bytes = fs.readFileSync(cachePath);
            if (sha256(bytes) !== image.contentHash || bytes.length !== image.byteLength) {
              throw new ImageUploadStoreError(
                "upload_cache_expired",
                `uploadKey ${record.uploadKey} 已过复用期且源图缓存校验失败`
              );
            }
            image.status = "received";
            image.uploadedImageId = "";
            image.attempts = 0;
            image.retryCount = 0;
            image.lastStage = undefined;
            image.lastErrorCode = undefined;
            image.updatedAt = refreshedAt.toISOString();
          }
          record.status = "queued";
          record.acceptedAt = refreshedAt.toISOString();
          record.updatedAt = refreshedAt.toISOString();
          record.reusableUntil = new Date(
            refreshedAt.getTime() + IMAGE_UPLOAD_REUSE_TTL_MS
          ).toISOString();
          record.deadlineAt = new Date(
            refreshedAt.getTime() + IMAGE_UPLOAD_BATCH_DEADLINE_MS
          ).toISOString();
          record.uploadStartedAt = undefined;
          record.uploadCompletedAt = undefined;
          record.failureCode = undefined;
          record.failureStage = undefined;
          record.errorMessage = undefined;
          this.persist();
          return { record: clone(record), cacheHit: false };
        }
        if (record.status === "failed_pre_submit") {
          throw new ImageUploadStoreError(
            record.failureCode || "image_upload_pre_submit",
            record.errorMessage || "参考图上传已在生成提交前失败",
            { uploadKey, stage: record.failureStage }
          );
        }
        this.assertBeforeDeadline(record);
      } else {
        const acceptedAt = this.now();
        const acceptedIso = acceptedAt.toISOString();
        record = {
          uploadKey,
          sourceSubmissionId: String(input.sourceSubmissionId).trim(),
          sourceMetadataHash,
          tokenFingerprint,
          status: "receiving",
          imageCount: normalizedMetadata.length,
          images: normalizedMetadata.map((metadata, index) => ({
            index,
            sourceFileName: String(metadata.sourceFileName || ""),
            sourceMetadataHash: sha256(JSON.stringify(stableValue(metadata))),
            spoolFileName: `image-${String(index + 1).padStart(3, "0")}.cache`,
            status: "awaiting_source",
            contentHash: "",
            byteLength: 0,
            uploadedImageId: "",
            attempts: 0,
            retryCount: 0,
            updatedAt: acceptedIso,
          })),
          acceptedAt: acceptedIso,
          updatedAt: acceptedIso,
          reusableUntil: new Date(acceptedAt.getTime() + IMAGE_UPLOAD_REUSE_TTL_MS).toISOString(),
          deadlineAt: new Date(acceptedAt.getTime() + IMAGE_UPLOAD_BATCH_DEADLINE_MS).toISOString(),
        };
        this.records.set(uploadKey, record);
        try {
          this.persist();
        } catch (error) {
          this.records.delete(uploadKey);
          throw error;
        }
      }

      const deadlineController = new AbortController();
      const remainingMs = this.remainingDeadlineMs(record);
      const deadlineTimer = setTimeout(
        () => deadlineController.abort(new Error("upload_deadline_exceeded")),
        Math.max(1, remainingMs)
      );
      const onOuterAbort = () => deadlineController.abort(input.signal?.reason);
      input.signal?.addEventListener("abort", onOuterAbort, { once: true });
      try {
        for (const image of record.images) {
          if (image.status !== "awaiting_source") continue;
          this.assertBeforeDeadline(record);
          if (deadlineController.signal.aborted) {
            throw new ImageUploadStoreError(
              "upload_deadline_exceeded",
              "参考图接收超过 15 分钟总墙钟上限"
            );
          }
          const existingPath = this.cachePath(record.uploadKey, image.spoolFileName);
          let bytes: Buffer;
          if (fs.existsSync(existingPath)) {
            bytes = fs.readFileSync(existingPath);
          } else {
            bytes = await input.readSource(image.index, deadlineController.signal);
            if (!Buffer.isBuffer(bytes) || bytes.length === 0) {
              throw new ImageUploadStoreError(
                "invalid_source_image_bytes",
                `参考图 ${image.index + 1} 接收结果为空`
              );
            }
            this.writeSourceAtomically(existingPath, bytes);
          }
          image.contentHash = sha256(bytes);
          image.byteLength = bytes.length;
          image.status = "received";
          image.updatedAt = this.now().toISOString();
          record.updatedAt = image.updatedAt;
          this.persist();
        }
        record.status = record.images.every((image) => image.status === "uploaded")
          ? "ready"
          : "queued";
        record.updatedAt = this.now().toISOString();
        this.persist();
        return { record: clone(record), cacheHit: record.status === "ready" };
      } catch (error) {
        if (
          error instanceof ImageUploadStoreError &&
          error.code === "upload_deadline_exceeded"
        ) {
          this.applyFailure(record, error.code, "source_image_download", error.message);
          this.persist();
        }
        throw error;
      } finally {
        clearTimeout(deadlineTimer);
        input.signal?.removeEventListener("abort", onOuterAbort);
      }
    });
  }

  get(uploadKey: string): ImageUploadSetRecord | undefined {
    const record = this.records.get(String(uploadKey || "").trim());
    return record ? clone(record) : undefined;
  }

  getSourceBuffer(uploadKey: string, index: number): Buffer {
    const record = this.records.get(uploadKey);
    if (!record) throw new ImageUploadStoreError("missing_upload_set", `找不到 uploadKey ${uploadKey}`);
    const image = record.images[index];
    if (!image || !["received", "uploading", "uploaded"].includes(image.status)) {
      throw new ImageUploadStoreError("source_cache_unavailable", `参考图 ${index + 1} 尚未安全落盘`);
    }
    const cachePath = this.cachePath(uploadKey, image.spoolFileName);
    if (!fs.existsSync(cachePath)) {
      throw new ImageUploadStoreError("source_cache_missing", `参考图 ${index + 1} 缓存文件缺失`);
    }
    const bytes = fs.readFileSync(cachePath);
    if (sha256(bytes) !== image.contentHash || bytes.length !== image.byteLength) {
      throw new ImageUploadStoreError("source_cache_corrupt", `参考图 ${index + 1} 缓存校验失败`);
    }
    return bytes;
  }

  async markUploadStarted(uploadKey: string, index: number): Promise<ImageUploadSetRecord> {
    return this.withKeyLock(uploadKey, () => {
      const record = this.requireRecord(uploadKey);
      this.assertBeforeDeadline(record);
      const image = record.images[index];
      if (!image) throw new ImageUploadStoreError("invalid_image_index", `图片索引 ${index} 无效`);
      if (image.status === "uploaded") return clone(record);
      if (image.status !== "received") {
        throw new ImageUploadStoreError("source_cache_unavailable", `参考图 ${index + 1} 尚未安全落盘`);
      }
      const now = this.now().toISOString();
      image.status = "uploading";
      image.attempts += 1;
      image.updatedAt = now;
      record.status = "uploading";
      record.uploadStartedAt ||= now;
      record.updatedAt = now;
      this.persist();
      return clone(record);
    });
  }

  async recordRetry(uploadKey: string, index: number, input: {
    stage?: string;
    errorCode?: string;
  }): Promise<ImageUploadSetRecord> {
    return this.withKeyLock(uploadKey, () => {
      const record = this.requireRecord(uploadKey);
      const image = record.images[index];
      if (!image) throw new ImageUploadStoreError("invalid_image_index", `图片索引 ${index} 无效`);
      image.retryCount += 1;
      image.lastStage = firstNonEmptyString(input.stage) || undefined;
      image.lastErrorCode = firstNonEmptyString(input.errorCode) || undefined;
      image.updatedAt = this.now().toISOString();
      record.updatedAt = image.updatedAt;
      this.persist();
      return clone(record);
    });
  }

  async markImageUploaded(
    uploadKey: string,
    index: number,
    uploadedImageId: string
  ): Promise<ImageUploadSetRecord> {
    const normalizedId = String(uploadedImageId || "").trim();
    if (!normalizedId) throw new ImageUploadStoreError("missing_uploaded_image_id", "TOS 图片 ID 不能为空");
    return this.withKeyLock(uploadKey, () => {
      const record = this.requireRecord(uploadKey);
      this.assertBeforeDeadline(record);
      const image = record.images[index];
      if (!image) throw new ImageUploadStoreError("invalid_image_index", `图片索引 ${index} 无效`);
      if (image.status === "uploaded") {
        if (image.uploadedImageId !== normalizedId) {
          throw new ImageUploadStoreError(
            "uploaded_image_id_conflict",
            `参考图 ${index + 1} 的 TOS 图片 ID 与已持久化记录冲突`
          );
        }
        return clone(record);
      }
      if (image.status !== "uploading") {
        throw new ImageUploadStoreError("invalid_upload_transition", `参考图 ${index + 1} 未处于 uploading`);
      }
      const now = this.now().toISOString();
      image.status = "uploaded";
      image.uploadedImageId = normalizedId;
      image.lastStage = undefined;
      image.lastErrorCode = undefined;
      image.updatedAt = now;
      const allUploaded = record.images.every((entry) => entry.status === "uploaded");
      record.status = allUploaded ? "ready" : "uploading";
      record.updatedAt = now;
      if (allUploaded) {
        record.uploadCompletedAt = now;
        record.reusableUntil = new Date(
          this.now().getTime() + IMAGE_UPLOAD_REUSE_TTL_MS
        ).toISOString();
      }
      this.persist();
      return clone(record);
    });
  }

  async resetInterruptedImage(uploadKey: string, index: number): Promise<ImageUploadSetRecord> {
    return this.withKeyLock(uploadKey, () => {
      const record = this.requireRecord(uploadKey);
      // Once a batch has failed before submission, late sibling completions or
      // cancellation cleanup must never move it back to queued/uploading.
      if (record.status === "failed_pre_submit") return clone(record);
      const image = record.images[index];
      if (!image) throw new ImageUploadStoreError("invalid_image_index", `图片索引 ${index} 无效`);
      if (image.status === "uploading") image.status = "received";
      image.updatedAt = this.now().toISOString();
      record.status = record.images.some((entry) => entry.status === "uploading")
        ? "uploading"
        : "queued";
      record.updatedAt = image.updatedAt;
      this.persist();
      return clone(record);
    });
  }

  async failBeforeSubmit(uploadKey: string, input: {
    code: string;
    stage: string;
    message: string;
  }): Promise<ImageUploadSetRecord> {
    return this.withKeyLock(uploadKey, () => {
      const record = this.requireRecord(uploadKey);
      if (record.status === "ready") {
        throw new ImageUploadStoreError(
          "invalid_upload_transition",
          "ready 上传集不能被改写为 failed_pre_submit"
        );
      }
      this.applyFailure(record, input.code, input.stage, input.message);
      this.persist();
      return clone(record);
    });
  }

  getReusableUploadedIds(input: {
    uploadKey: string;
    sourceSubmissionId: string;
    sourceImages: ImageUploadSourceMetadata[];
    tokenFingerprint: string;
  }): string[] | undefined {
    const record = this.records.get(validateE002UploadKey(input.uploadKey, input.sourceSubmissionId));
    if (!record) return undefined;
    this.assertIdentity(record, {
      sourceSubmissionId: input.sourceSubmissionId,
      sourceMetadataHash: buildImageUploadSourceMetadataHash(input.sourceImages),
      tokenFingerprint: String(input.tokenFingerprint || "").trim(),
    });
    if (record.status !== "ready") return undefined;
    if (this.now().getTime() >= Date.parse(record.reusableUntil)) return undefined;
    const ids = record.images.map((image) => image.uploadedImageId);
    return ids.every(Boolean) ? ids : undefined;
  }

  remainingDeadlineMs(recordOrKey: ImageUploadSetRecord | string): number {
    const record = typeof recordOrKey === "string" ? this.requireRecord(recordOrKey) : recordOrKey;
    return Math.max(0, Date.parse(record.deadlineAt) - this.now().getTime());
  }

  isReusableReady(uploadKey: string): boolean {
    const record = this.records.get(String(uploadKey || "").trim());
    return Boolean(
      record &&
      record.status === "ready" &&
      this.now().getTime() < Date.parse(record.reusableUntil) &&
      record.images.every((image) => image.status === "uploaded" && Boolean(image.uploadedImageId))
    );
  }

  assertBeforeDeadline(recordOrKey: ImageUploadSetRecord | string): void {
    const record = typeof recordOrKey === "string" ? this.requireRecord(recordOrKey) : recordOrKey;
    if (this.remainingDeadlineMs(record) <= 0) {
      throw new ImageUploadStoreError(
        "upload_deadline_exceeded",
        "参考图上传超过 15 分钟总墙钟上限",
        { uploadKey: record.uploadKey, stage: "upload_deadline" }
      );
    }
  }

  publicState(uploadKey: string, cacheHit = false): PublicImageUploadState {
    const record = this.requireRecord(uploadKey);
    const completed = record.images.filter((image) => image.status === "uploaded").length;
    const retryCount = record.images.reduce((sum, image) => sum + image.retryCount, 0);
    const endAt = record.uploadCompletedAt
      ? Date.parse(record.uploadCompletedAt)
      : this.now().getTime();
    const startAt = record.uploadStartedAt
      ? Date.parse(record.uploadStartedAt)
      : Date.parse(record.acceptedAt);
    return {
      uploadKey: record.uploadKey,
      batchStatus: record.status,
      nextPollAfterSeconds: record.status === "ready" || record.status === "failed_pre_submit" ? 0 : 5,
      cacheHit,
      uploadDurationMs: cacheHit ? 0 : Math.max(0, endAt - startAt),
      uploadProgress: {
        total: record.imageCount,
        completed,
        retryCount,
      },
      failureCode: record.failureCode,
      failureStage: record.failureStage,
      errorMessage: record.errorMessage,
    };
  }

  cleanupExpired(options: { activeUploadKeys?: Iterable<string> } = {}): {
    removedUploadKeys: string[];
  } {
    const active = new Set(
      [...(options.activeUploadKeys || [])].map((value) => String(value || "").trim())
    );
    const nowMs = this.now().getTime();
    const removedUploadKeys: string[] = [];
    for (const [uploadKey, record] of this.records) {
      if (active.has(uploadKey)) continue;
      const expiryMs = Date.parse(record.reusableUntil);
      if (!Number.isFinite(expiryMs) || nowMs < expiryMs) continue;
      if (record.status !== "ready" && record.status !== "failed_pre_submit") continue;
      this.records.delete(uploadKey);
      removedUploadKeys.push(uploadKey);
      const directory = this.recordDirectory(uploadKey);
      if (fs.existsSync(directory)) fs.rmSync(directory, { recursive: true, force: true });
    }
    if (removedUploadKeys.length > 0) {
      try {
        this.persist();
      } catch (error) {
        throw new ImageUploadStoreError(
          "upload_cleanup_persist_failed",
          "清理过期参考图缓存后无法持久化台账，服务按失败关闭处理",
          { cause: safeMessage(error), removedUploadKeys }
        );
      }
    }
    return { removedUploadKeys };
  }

  private requireRecord(uploadKey: string): ImageUploadSetRecord {
    const record = this.records.get(String(uploadKey || "").trim());
    if (!record) throw new ImageUploadStoreError("missing_upload_set", `找不到 uploadKey ${uploadKey}`);
    return record;
  }

  private applyFailure(
    record: ImageUploadSetRecord,
    code: string,
    stage: string,
    message: string
  ): void {
    const nowDate = this.now();
    const now = nowDate.toISOString();
    record.status = "failed_pre_submit";
    record.failureCode = firstNonEmptyString(code, "image_upload_pre_submit");
    record.failureStage = firstNonEmptyString(stage, "image_upload_pre_submit");
    record.errorMessage = safeMessage(message);
    record.updatedAt = now;
    // Keep fail-closed evidence for a full two hours from the failure itself,
    // rather than from the earlier acceptedAt timestamp.
    record.reusableUntil = new Date(
      nowDate.getTime() + IMAGE_UPLOAD_REUSE_TTL_MS
    ).toISOString();
    for (const image of record.images) {
      if (image.status === "uploading") image.status = "received";
      image.updatedAt = now;
    }
  }
}
