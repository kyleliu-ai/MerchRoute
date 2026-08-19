import {
  ImageTaskLedger,
  mapWithConcurrency,
  releaseAsyncReservationsAndConfirm,
  setAsyncBatchMetrics,
  setAsyncReservationsPhase,
} from "./image-task-ledger.ts";
import type {
  AsyncBatchReservation,
  PublicImageTaskRecord,
} from "./image-task-ledger.ts";
import {
  ImageUploadStore,
  ImageUploadStoreError,
} from "./image-upload-store.ts";
import type {
  ImageUploadSetRecord,
  PublicImageUploadState,
} from "./image-upload-store.ts";
import {
  getImageInputUploadFailureStage,
  getImageUploadErrorStatusCode,
  getImageUploadNetworkCode,
  isRetryableImageUploadError,
  sanitizeImageUploadError,
} from "./image-input-upload-retry.ts";
import { globalImageOperationGateSnapshot } from "./global-image-operation-gates.ts";

type UploadOne = (input: {
  bytes: Buffer;
  token: string;
  imageIndex: number;
  attempt: number;
  signal: AbortSignal;
}) => Promise<string>;

type SubmitTask = (input: {
  task: Record<string, any>;
  common: Record<string, any>;
  uploadedImageIds: string[];
  token: string;
  remoteSubmitId: string;
  onBeforeRemoteSubmit: () => Promise<void>;
}) => Promise<{ historyId: string }>;

export type AsyncBatchJobInput = {
  batchKey: string;
  uploadKey: string;
  token: string;
  tokenFingerprint: string;
  common: Record<string, any>;
  reservations: AsyncBatchReservation[];
  cacheHit: boolean;
  uploadOne: UploadOne;
  submitTask: SubmitTask;
};

type ActiveJob = {
  input: AsyncBatchJobInput;
  controller: AbortController;
  promise: Promise<void>;
};

export type AsyncBatchSnapshot = PublicImageUploadState & {
  batchKey: string;
  ok: boolean;
  code?: string;
  taskCount: number;
  submittedCount: number;
  unknownCount: number;
  reusedCount: number;
  tasks: PublicImageTaskRecord[];
};

function publicTask(record: ReturnType<ImageTaskLedger["get"]>, reused: boolean): PublicImageTaskRecord {
  if (!record) throw new Error("missing task record");
  const { tokenFingerprint: _tokenFingerprint, ...safe } = record;
  return { ...safe, reused };
}

function safeLogFields(input: Record<string, unknown>): string {
  return Object.entries(input)
    .filter(([, value]) => value !== undefined && value !== "")
    .map(([key, value]) => `${key}=${String(value).replace(/\s+/g, " ").slice(0, 160)}`)
    .join(" ");
}

export class AsyncImageBatchCoordinator {
  private readonly ledger: ImageTaskLedger;
  private readonly uploadStore: ImageUploadStore;
  private readonly log: {
    info: (message: string) => void;
    error: (message: string) => void;
  };
  private readonly activeJobs = new Map<string, ActiveJob>();
  private readonly uploadLocks = new Map<string, Promise<void>>();

  constructor(options: {
    ledger: ImageTaskLedger;
    uploadStore: ImageUploadStore;
    log?: {
      info: (message: string) => void;
      error: (message: string) => void;
    };
  }) {
    this.ledger = options.ledger;
    this.uploadStore = options.uploadStore;
    this.log = options.log || console;
  }

  start(input: AsyncBatchJobInput): { started: boolean; promise: Promise<void> } {
    const existing = this.activeJobs.get(input.batchKey);
    if (existing) {
      const identity = (value: AsyncBatchJobInput) => value.reservations
        .map((entry) => `${entry.record.idempotencyKey}:${entry.requestHash}`)
        .sort()
        .join("|");
      if (
        existing.input.uploadKey !== input.uploadKey ||
        existing.input.tokenFingerprint !== input.tokenFingerprint ||
        identity(existing.input) !== identity(input)
      ) {
        throw new ImageUploadStoreError(
          "batch_conflict",
          `batchKey ${input.batchKey} 已被另一组任务占用，禁止静默加入后台作业`
        );
      }
      return { started: false, promise: existing.promise };
    }
    const controller = new AbortController();
    const usesReusableReadyCache = this.uploadStore.isReusableReady(input.uploadKey);
    const deadlineMs = usesReusableReadyCache
      ? undefined
      : this.uploadStore.remainingDeadlineMs(input.uploadKey);
    const deadlineTimer = deadlineMs === undefined
      ? undefined
      : setTimeout(() => controller.abort(new ImageUploadStoreError(
        "upload_deadline_exceeded",
        "参考图上传超过 15 分钟总墙钟上限",
        { uploadKey: input.uploadKey, stage: "upload_deadline" }
      )), Math.max(1, deadlineMs));
    const promise = this.run(input, controller.signal).finally(() => {
      if (deadlineTimer) clearTimeout(deadlineTimer);
      const current = this.activeJobs.get(input.batchKey);
      if (current?.promise === promise) this.activeJobs.delete(input.batchKey);
    });
    this.activeJobs.set(input.batchKey, { input, controller, promise });
    // The route intentionally does not await paid generation work.
    void promise.catch((error) => {
      this.log.error(`异步图片批次后台作业终止 ${safeLogFields({
        batchKey: input.batchKey,
        uploadKey: input.uploadKey,
        code: (error as any)?.code,
        message: sanitizeImageUploadError(error),
      })}`);
    });
    return { started: true, promise };
  }

  async reconcileFailedUploadReservations(input: {
    uploadKey: string;
    reservations: AsyncBatchReservation[];
  }): Promise<void> {
    const upload = this.uploadStore.get(input.uploadKey);
    if (!upload || upload.status !== "failed_pre_submit") return;
    const adopted = input.reservations.map((reservation) => {
      const current = this.ledger.get(reservation.record.idempotencyKey);
      const phase = String(current?.context?.asyncPhase || "");
      const safelyReleasable = current?.status === "reserved" &&
        ["receiving", "queued", "uploading", "ready"].includes(phase);
      return {
        ...reservation,
        needsSubmission: false,
        releaseOnPreSubmit: safelyReleasable,
        record: current || reservation.record,
      };
    });
    await releaseAsyncReservationsAndConfirm(
      this.ledger,
      adopted,
      upload.failureStage || "upload_deadline",
      {
        code: upload.failureCode || "image_upload_pre_submit",
        uploadKey: upload.uploadKey,
        automaticRetriesExhausted: true,
      }
    );
  }

  hasActiveBatch(batchKey: string): boolean {
    return this.activeJobs.has(String(batchKey || "").trim());
  }

  activeUploadKeys(): string[] {
    return [...new Set([...this.activeJobs.values()].map((job) => job.input.uploadKey))];
  }

  generationGateSnapshot(): { active: number; queued: number; limit: number } {
    return globalImageOperationGateSnapshot().generation;
  }

  cancel(batchKey: string, reason: unknown = new Error("batch cancelled")): boolean {
    const active = this.activeJobs.get(String(batchKey || "").trim());
    if (!active) return false;
    active.controller.abort(reason);
    return true;
  }

  snapshot(input: {
    batchKey: string;
    uploadKey: string;
    taskKeys: string[];
    cacheHit?: boolean;
    reusedKeys?: Iterable<string>;
  }): AsyncBatchSnapshot {
    const upload = this.uploadStore.publicState(input.uploadKey, input.cacheHit === true);
    const reusedKeys = new Set([...(input.reusedKeys || [])].map(String));
    const tasks = input.taskKeys.flatMap((idempotencyKey) => {
      const record = this.ledger.get(idempotencyKey);
      return record ? [publicTask(record, reusedKeys.has(idempotencyKey))] : [];
    });
    const persistedMetrics = tasks
      .map((task) => task.context || {})
      .find((context) => typeof context.asyncBatchCacheHit === "boolean");
    if (persistedMetrics) {
      upload.cacheHit = persistedMetrics.asyncBatchCacheHit === true;
      upload.uploadDurationMs = Math.max(
        0,
        Math.trunc(Number(persistedMetrics.asyncBatchUploadDurationMs) || 0)
      );
    }
    const unknownCount = tasks.filter((task) => task.status === "submission_unknown").length;
    const submittedCount = tasks.filter((task) => Boolean(task.historyId)).length;
    const uploadFailure = upload.batchStatus === "failed_pre_submit";
    return {
      ...upload,
      batchKey: input.batchKey,
      ok: !uploadFailure && unknownCount === 0,
      code: uploadFailure
        ? (upload.failureCode || "image_upload_pre_submit")
        : (unknownCount > 0 ? "submission_unknown" : undefined),
      taskCount: tasks.length,
      submittedCount,
      unknownCount,
      reusedCount: tasks.filter((task) => task.reused).length,
      tasks,
    };
  }

  private async run(input: AsyncBatchJobInput, signal: AbortSignal): Promise<void> {
    return this.withUploadLock(input.uploadKey, () => this.runUnderUploadLock(input, signal));
  }

  private async runUnderUploadLock(input: AsyncBatchJobInput, signal: AbortSignal): Promise<void> {
    let uploadedImageIds: string[];
    try {
      if (!this.uploadStore.isReusableReady(input.uploadKey)) {
        this.uploadStore.assertBeforeDeadline(input.uploadKey);
      }
      await setAsyncReservationsPhase(this.ledger, input.reservations, "uploading");
      const uploadResult = await this.ensureUploaded(input, signal);
      uploadedImageIds = uploadResult.uploadedImageIds;
      if (!uploadResult.cacheHit) this.uploadStore.assertBeforeDeadline(input.uploadKey);
      if (signal.aborted) throw signal.reason || new Error("upload batch cancelled");
      await setAsyncReservationsPhase(this.ledger, input.reservations, "ready");
      const upload = this.uploadStore.publicState(input.uploadKey, uploadResult.cacheHit);
      await setAsyncBatchMetrics(this.ledger, input.reservations, {
        cacheHit: uploadResult.cacheHit,
        uploadDurationMs: uploadResult.cacheHit ? 0 : upload.uploadDurationMs,
      });
    } catch (error) {
      const stage = error instanceof ImageUploadStoreError
        ? String(error.details?.stage || "upload_deadline")
        : getImageInputUploadFailureStage(error);
      const code = error instanceof ImageUploadStoreError
        ? error.code
        : "image_upload_pre_submit";
      const message = sanitizeImageUploadError(error);
      const uploadRecord = this.uploadStore.get(input.uploadKey);
      if (uploadRecord && uploadRecord.status !== "failed_pre_submit" && uploadRecord.status !== "ready") {
        await this.uploadStore.failBeforeSubmit(input.uploadKey, { code, stage, message });
      }
      // Only safe reservations owned/adopted by this worker are released.
      // Reused processing/terminal records never suppress cleanup of new ones.
      await releaseAsyncReservationsAndConfirm(
        this.ledger,
        input.reservations,
        stage,
        {
          code,
          uploadKey: input.uploadKey,
          automaticRetriesExhausted: true,
          reservationsReleased: false,
        }
      );
      throw error;
    }

    // Generation submission is deliberately outside the upload failure
    // handler. A transport timeout is submission_unknown and must never poison
    // a ready upload cache or trigger an automatic replay.
    await mapWithConcurrency(input.reservations, 5, async (reservation) => {
      if (!reservation.needsSubmission) return;
      const remoteSubmitId = String(
        this.ledger.get(reservation.record.idempotencyKey)?.context?.remoteSubmitId || ""
      );
      await this.ledger.submitReserved(
          reservation.record.idempotencyKey,
          reservation.requestHash,
          (onBeforeRemoteSubmit) => input.submitTask({
            task: reservation.task,
            common: input.common,
            uploadedImageIds,
            token: input.token,
            remoteSubmitId,
            onBeforeRemoteSubmit,
          })
        );
    });
  }

  private async withUploadLock<T>(uploadKey: string, callback: () => Promise<T>): Promise<T> {
    const previous = this.uploadLocks.get(uploadKey) || Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => current);
    this.uploadLocks.set(uploadKey, tail);
    await previous;
    try {
      return await callback();
    } finally {
      release();
      if (this.uploadLocks.get(uploadKey) === tail) this.uploadLocks.delete(uploadKey);
    }
  }

  private async ensureUploaded(
    input: AsyncBatchJobInput,
    signal: AbortSignal
  ): Promise<{ uploadedImageIds: string[]; cacheHit: boolean }> {
    const cached = this.uploadStore.getReusableUploadedIds({
      uploadKey: input.uploadKey,
      sourceSubmissionId: this.uploadStore.get(input.uploadKey)!.sourceSubmissionId,
      sourceImages: input.reservations[0]?.record.context?.sourceImages || [],
      tokenFingerprint: input.tokenFingerprint,
    });
    if (cached) {
      this.log.info(`异步参考图缓存命中 ${safeLogFields({
        batchKey: input.batchKey,
        uploadKey: input.uploadKey,
        imageCount: cached.length,
        cacheHit: true,
      })}`);
      return { uploadedImageIds: cached, cacheHit: true };
    }

    const record = this.uploadStore.get(input.uploadKey);
    if (!record) throw new ImageUploadStoreError("missing_upload_set", `找不到 uploadKey ${input.uploadKey}`);
    const pending = record.images.filter((image) => image.status !== "uploaded");
    const siblingController = new AbortController();
    const abortFromParent = () => siblingController.abort(signal.reason);
    if (signal.aborted) abortFromParent();
    else signal.addEventListener("abort", abortFromParent, { once: true });
    let firstError: unknown;
    const promises = pending.map((image) => this.uploadSingleImage(
      input,
      image,
      siblingController.signal
    ).catch((error) => {
      firstError ||= error;
      siblingController.abort(error);
      throw error;
    }));
    try {
      await Promise.allSettled(promises);
    } finally {
      signal.removeEventListener("abort", abortFromParent);
    }
    if (firstError) throw firstError;
    const ready = this.uploadStore.get(input.uploadKey);
    if (!ready || ready.status !== "ready") {
      throw new ImageUploadStoreError(
        "image_upload_pre_submit",
        "参考图上传完成后未进入 ready 状态"
      );
    }
    return {
      uploadedImageIds: ready.images.map((image) => image.uploadedImageId),
      cacheHit: false,
    };
  }

  private async uploadSingleImage(
    input: AsyncBatchJobInput,
    initialImage: ImageUploadSetRecord["images"][number],
    signal: AbortSignal
  ): Promise<void> {
    const imageIndex = initialImage.index;
    for (let attempt = Math.max(1, initialImage.attempts + 1); attempt <= 3; attempt++) {
      this.uploadStore.assertBeforeDeadline(input.uploadKey);
      if (signal.aborted) throw signal.reason || new Error("upload cancelled");
      const startedAt = Date.now();
      await this.uploadStore.markUploadStarted(input.uploadKey, imageIndex);
      try {
        const uploadedImageId = await this.withAbortSignal(input.uploadOne({
            bytes: this.uploadStore.getSourceBuffer(input.uploadKey, imageIndex),
            token: input.token,
            imageIndex: imageIndex + 1,
            attempt,
            signal,
          }), signal);
        await this.uploadStore.markImageUploaded(input.uploadKey, imageIndex, uploadedImageId);
        this.log.info(`异步参考图上传完成 ${safeLogFields({
          batchKey: input.batchKey,
          uploadKey: input.uploadKey,
          imageIndex: imageIndex + 1,
          attempt,
          totalMs: Date.now() - startedAt,
          cacheHit: false,
          gateMode: globalImageOperationGateSnapshot().upload.token?.limit,
        })}`);
        return;
      } catch (error) {
        const retryable = isRetryableImageUploadError(error);
        const stage = getImageInputUploadFailureStage(error);
        const errorCode = String(
          getImageUploadErrorStatusCode(error) || getImageUploadNetworkCode(error) || "unknown"
        );
        if (retryable && attempt < 3) {
          await this.uploadStore.recordRetry(input.uploadKey, imageIndex, { stage, errorCode });
        }
        await this.uploadStore.resetInterruptedImage(input.uploadKey, imageIndex);
        if (!retryable || attempt >= 3) throw error;
        const delayMs = (attempt === 1 ? 2_000 : 5_000) + Math.floor(Math.random() * 1_001);
        await this.sleepWithinDeadline(input.uploadKey, delayMs, signal);
      }
    }
  }

  private async sleepWithinDeadline(
    uploadKey: string,
    delayMs: number,
    signal: AbortSignal
  ): Promise<void> {
    const remaining = this.uploadStore.remainingDeadlineMs(uploadKey);
    if (remaining <= delayMs) {
      throw new ImageUploadStoreError(
        "upload_deadline_exceeded",
        "参考图上传重试等待将超过 15 分钟总墙钟上限",
        { uploadKey, stage: "upload_deadline" }
      );
    }
    await new Promise<void>((resolve, reject) => {
      const finish = (callback: () => void) => {
        signal.removeEventListener("abort", abort);
        callback();
      };
      const timer = setTimeout(() => finish(resolve), delayMs);
      const abort = () => {
        clearTimeout(timer);
        finish(() => reject(signal.reason || new Error("upload cancelled")));
      };
      signal.addEventListener("abort", abort, { once: true });
    });
  }

  private async withAbortSignal<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
    if (signal.aborted) throw signal.reason || new Error("operation cancelled");
    return new Promise<T>((resolve, reject) => {
      const abort = () => {
        signal.removeEventListener("abort", abort);
        reject(signal.reason || new Error("operation cancelled"));
      };
      signal.addEventListener("abort", abort, { once: true });
      operation.then(
        (value) => {
          signal.removeEventListener("abort", abort);
          resolve(value);
        },
        (error) => {
          signal.removeEventListener("abort", abort);
          reject(error);
        }
      );
    });
  }
}
