import fs from "fs";
import _ from "lodash";

import Request from "@/lib/request/Request.ts";
import {
  generateImages,
  generateImageComposition,
  downloadImageInputToBuffer,
  uploadImageInputs,
  uploadImageBufferForAsyncTask,
  submitImageCompositionFromUploadedIds,
  queryImageCompositionTask,
} from "@/api/controllers/images.ts";
import { tokenSplit } from "@/api/controllers/core.ts";
import util from "@/lib/util.ts";
import {
  ImageTaskLedger,
  ImageTaskLedgerError,
  adoptRecoverableAsyncReservations,
  fingerprintToken,
  imageTaskLedgerErrorResponse,
  queryIdempotentBatch,
  releaseAsyncReservationsAndConfirm,
  reserveIdempotentBatchForAsync,
  stableIndex,
  submitIdempotentBatch,
} from "@/api/services/image-task-ledger.ts";
import { AsyncImageBatchCoordinator } from "@/api/services/async-image-batch-coordinator.ts";
import {
  ImageUploadStore,
  ImageUploadStoreError,
} from "@/api/services/image-upload-store.ts";
import { sanitizeImageUploadError } from "@/api/services/image-input-upload-retry.ts";

const IMAGE_TASK_STORE_DIR = process.env.IMAGE_TASK_STORE_DIR || "/app/data";
const imageTaskLedger = new ImageTaskLedger({ storeDir: IMAGE_TASK_STORE_DIR });
const imageUploadStore = new ImageUploadStore({ storeDir: IMAGE_TASK_STORE_DIR });
const asyncBatchCoordinator = new AsyncImageBatchCoordinator({
  ledger: imageTaskLedger,
  uploadStore: imageUploadStore,
});

function ledgerErrorResponse(error: unknown) {
  const response = imageTaskLedgerErrorResponse(error);
  if (response) return response;
  if (error instanceof ImageUploadStoreError) {
    return {
      ok: false,
      accepted: false,
      code: error.code,
      batchStatus: "rejected",
      message: sanitizeImageUploadError(error),
      details: error.details || {},
      tasks: [],
    };
  }
  throw error;
}

function firstString(...values: unknown[]): string {
  for (const value of values) {
    const text = String(value ?? "").trim();
    if (text) return text;
  }
  return "";
}

function publicStoredTasks(taskKeys: string[]) {
  return taskKeys.flatMap((key) => {
    const record = imageTaskLedger.get(key);
    if (!record) return [];
    const { tokenFingerprint: _tokenFingerprint, ...safe } = record;
    return [{ ...safe, reused: true }];
  });
}

export function resolveAffinityToken(uploadKey: string, tokens: string[], taskKeys: string[] = []) {
  if (!tokens.length) throw new ImageTaskLedgerError("missing_token", "未配置可用的 refresh_token");
  const storedFingerprint = firstString(
    imageUploadStore.get(uploadKey)?.tokenFingerprint,
    ...taskKeys.map((key) => imageTaskLedger.get(key)?.tokenFingerprint),
    ...imageTaskLedger.findByUploadKey(uploadKey).map((record) => record.tokenFingerprint)
  );
  if (storedFingerprint) {
    const storedToken = tokens.find((candidate) => fingerprintToken(candidate) === storedFingerprint);
    if (!storedToken) {
      throw new ImageTaskLedgerError(
        "token_fingerprint_unavailable",
        "原参考图上传 token 已不在当前 Authorization 中"
      );
    }
    return { token: storedToken, tokenFingerprint: storedFingerprint };
  }
  const token = tokens[stableIndex(uploadKey, tokens.length)];
  return { token, tokenFingerprint: fingerprintToken(token) };
}

export function deriveBatchStatus(tasks: Array<Record<string, any>>, uploadStatus?: string): string {
  if (uploadStatus === "failed_pre_submit") return "failed_pre_submit";
  if (tasks.some((task) => task.status === "reserved")) return uploadStatus || "queued";
  if (tasks.some((task) => task.status === "processing")) return "processing";
  return "terminal";
}

export function decorateAsyncResponse(
  base: Record<string, any>,
  uploadKey: string,
  cacheHint = false
): Record<string, any> {
  const tasks = Array.isArray(base.tasks) ? base.tasks : [];
  const metricContext = tasks
    .map((task) => task?.context || {})
    .find((context) => typeof context.asyncBatchCacheHit === "boolean");
  const uploadRecord = imageUploadStore.get(uploadKey);
  const upload = uploadRecord
    ? imageUploadStore.publicState(uploadKey, cacheHint)
    : {
        uploadKey,
        batchStatus: deriveBatchStatus(tasks),
        nextPollAfterSeconds: tasks.some((task) => ["reserved", "processing"].includes(task.status)) ? 5 : 0,
        cacheHit: false,
        uploadDurationMs: 0,
        uploadProgress: { total: 0, completed: 0, retryCount: 0 },
      };
  const cacheHit = typeof metricContext?.asyncBatchCacheHit === "boolean"
    ? metricContext.asyncBatchCacheHit === true
    : upload.cacheHit;
  const uploadDurationMs = typeof metricContext?.asyncBatchUploadDurationMs === "number"
    ? Math.max(0, Math.trunc(metricContext.asyncBatchUploadDurationMs))
    : upload.uploadDurationMs;
  const hasUnknown = tasks.some((task) => task.status === "submission_unknown");
  const batchStatus = firstString(base.batchStatus) || deriveBatchStatus(tasks, upload.batchStatus);
  return {
    ...upload,
    ...base,
    uploadKey,
    ok: hasUnknown ? false : base.ok,
    code: hasUnknown ? "submission_unknown" : base.code,
    batchStatus,
    nextPollAfterSeconds: ["terminal", "failed_pre_submit", "rejected"].includes(batchStatus)
      ? 0
      : Math.max(1, Number(upload.nextPollAfterSeconds) || 5),
    cacheHit,
    uploadDurationMs,
    upload,
  };
}

export function uploadFailureResponse(
  error: unknown,
  batchKey: string,
  uploadKey: string,
  _taskKeys: string[]
) {
  const uploadError = error instanceof ImageUploadStoreError ? error : undefined;
  const details = uploadError?.details || {};
  const uploadRecord = imageUploadStore.get(uploadKey);
  const preservedCodes = new Set([
    "batch_conflict",
    "invalid_upload_key",
    "store_corrupt",
    "upload_idempotency_conflict",
    "upload_cache_expired",
    "token_fingerprint_unavailable",
  ]);
  const actualCode = firstString(uploadError?.code, uploadRecord?.failureCode, "image_upload_pre_submit");
  const isPersistedPreSubmitFailure = uploadRecord?.status === "failed_pre_submit";
  const responseCode = preservedCodes.has(actualCode) && !isPersistedPreSubmitFailure
    ? actualCode
    : actualCode === "upload_deadline_exceeded"
      ? "upload_deadline_exceeded"
      : "image_upload_pre_submit";
  const stage = firstString(details.stage, uploadRecord?.failureStage, "image_upload_pre_submit");
  return decorateAsyncResponse({
    ok: false,
    accepted: false,
    code: responseCode,
    batchStatus: isPersistedPreSubmitFailure ? "failed_pre_submit" : "rejected",
    failureCode: actualCode,
    message: sanitizeImageUploadError(error),
    stage,
    automaticRetriesExhausted: isPersistedPreSubmitFailure,
    reservationState: "released",
    batchKey,
    taskCount: 0,
    submittedCount: 0,
    unknownCount: 0,
    tasks: [],
  }, uploadKey);
}

async function failAndReleaseBeforeSubmit(input: {
  error: unknown;
  uploadKey: string;
  reservations: Awaited<ReturnType<typeof reserveIdempotentBatchForAsync>>["reservations"];
}) {
  const existing = imageUploadStore.get(input.uploadKey);
  const code = input.error instanceof ImageUploadStoreError
    ? input.error.code
    : "image_upload_pre_submit";
  const stage = firstString(
    input.error instanceof ImageUploadStoreError ? input.error.details?.stage : "",
    "source_image_download"
  );
  const mustNotPoisonSharedUpload = input.error instanceof ImageUploadStoreError && [
    "batch_conflict",
    "invalid_upload_key",
    "store_corrupt",
    "upload_idempotency_conflict",
    "upload_cache_expired",
  ].includes(input.error.code);
  if (
    !mustNotPoisonSharedUpload &&
    existing &&
    existing.status !== "ready" &&
    existing.status !== "failed_pre_submit"
  ) {
    await imageUploadStore.failBeforeSubmit(input.uploadKey, {
      code,
      stage,
      message: sanitizeImageUploadError(input.error),
    });
  }
  await releaseAsyncReservationsAndConfirm(imageTaskLedger, input.reservations, stage, {
    code,
    uploadKey: input.uploadKey,
    automaticRetriesExhausted: true,
  });
}

async function releaseNewReservationsForBatchConflict(
  reservations: Awaited<ReturnType<typeof reserveIdempotentBatchForAsync>>["reservations"],
  uploadKey: string
) {
  await releaseAsyncReservationsAndConfirm(
    imageTaskLedger,
    reservations.map((reservation) => ({
      ...reservation,
      releaseOnPreSubmit: reservation.created,
    })),
    "batch_conflict",
    { code: "batch_conflict", uploadKey }
  );
}

function submitAsyncTask(
  task: Record<string, any>,
  common: Record<string, any>,
  uploadedImageIds: string[],
  token: string,
  remoteSubmitId?: string,
  onBeforeRemoteSubmit?: () => Promise<void>
) {
  return submitImageCompositionFromUploadedIds(
    String(task.model || common.model || "jimeng-4.5"),
    String(task.prompt),
    uploadedImageIds,
    {
      ratio: String(task.ratio || common.ratio || "1:1"),
      resolution: String(task.resolution || common.resolution || "2k"),
      sampleStrength: Number(task.sampleStrength ?? common.sampleStrength ?? 0.5),
      intelligentRatio: Boolean(task.intelligentRatio ?? common.intelligentRatio ?? false),
    },
    token,
    { remoteSubmitId, onBeforeRemoteSubmit }
  );
}

export default {
  prefix: "/v1/images",

  post: {
    "/tasks/batch": async (request: Request) => {
      request
        .validate("body.tasks", _.isArray)
        .validate("body.images", _.isArray)
        .validate("body.sourceImages", _.isArray)
        .validate("headers.authorization", _.isString);

      const tasks = request.body.tasks as Record<string, any>[];
      const images = request.body.images as (string | Buffer)[];
      const tokens = tokenSplit(request.headers.authorization);
      const common = request.body.common || {};
      try {
        const uploadKey = firstString(request.body.uploadKey);
        // Calls without uploadKey retain the original synchronous contract.
        if (uploadKey) {
          const batchKey = firstString(request.body.batchKey, tasks[0]?.idempotencyKey);
          const sourceSubmissionId = firstString(
            request.body.sourceSubmissionId,
            common.sourceSubmissionId,
            tasks[0]?.sourceSubmissionId
          );
          const taskKeys = tasks.map((task) => String(task.idempotencyKey || ""));
          const affinity = resolveAffinityToken(uploadKey, tokens, taskKeys);
          const reserved = await reserveIdempotentBatchForAsync({
            ledger: imageTaskLedger,
            batchKey,
            tasks,
            common,
            sourceImages: request.body.sourceImages,
            tokenFingerprint: affinity.tokenFingerprint,
            uploadKey,
          });
          const reservations = adoptRecoverableAsyncReservations(
            imageTaskLedger,
            reserved.reservations
          );
          const needsSubmission = reservations.some((entry) => entry.needsSubmission);
          if (!needsSubmission) {
            // The upload TTL may already have cleaned the cache. Existing
            // history/task records remain authoritative and must be reused.
            const storedTasks = publicStoredTasks(taskKeys);
            return decorateAsyncResponse({
              ok: storedTasks.every((task) => task.status !== "submission_unknown"),
              accepted: true,
              code: storedTasks.some((task) => task.status === "submission_unknown")
                ? "submission_unknown"
                : undefined,
              batchKey,
              taskCount: storedTasks.length,
              reusedCount: storedTasks.length,
              // This response created no remote jobs. Keep historical presence
              // separate so idempotent replay metrics never imply new spend.
              submittedCount: 0,
              existingHistoryCount: storedTasks.filter((task) => Boolean(task.historyId)).length,
              unknownCount: storedTasks.filter((task) => task.status === "submission_unknown").length,
              tasks: storedTasks,
            }, uploadKey);
          }

          let accepted;
          try {
            accepted = await imageUploadStore.acceptSources({
              uploadKey,
              sourceSubmissionId,
              sourceImages: request.body.sourceImages,
              tokenFingerprint: affinity.tokenFingerprint,
              readSource: (index, signal) => downloadImageInputToBuffer(images[index], signal),
            });
          } catch (error) {
            await failAndReleaseBeforeSubmit({ error, uploadKey, reservations });
            return uploadFailureResponse(error, batchKey, uploadKey, taskKeys);
          }

          let job;
          try {
            job = asyncBatchCoordinator.start({
              batchKey,
              uploadKey,
              token: affinity.token,
              tokenFingerprint: affinity.tokenFingerprint,
              common,
              reservations,
              cacheHit: accepted.cacheHit,
              uploadOne: ({ bytes, token, attempt, signal }) =>
                uploadImageBufferForAsyncTask(bytes, token, { attempt, signal }),
              submitTask: ({ task, common: taskCommon, uploadedImageIds, token, remoteSubmitId, onBeforeRemoteSubmit }) =>
                submitAsyncTask(task, taskCommon, uploadedImageIds, token, remoteSubmitId, onBeforeRemoteSubmit),
            });
          } catch (error) {
            if (error instanceof ImageUploadStoreError && error.code === "batch_conflict") {
              await releaseNewReservationsForBatchConflict(reservations, uploadKey);
              return uploadFailureResponse(error, batchKey, uploadKey, taskKeys);
            }
            throw error;
          }
          const snapshot = asyncBatchCoordinator.snapshot({
            batchKey,
            uploadKey,
            taskKeys,
            cacheHit: accepted.cacheHit,
            reusedKeys: reservations.filter((entry) => !entry.created).map((entry) => entry.record.idempotencyKey),
          });
          imageUploadStore.cleanupExpired({ activeUploadKeys: asyncBatchCoordinator.activeUploadKeys() });
          return decorateAsyncResponse({
            ...snapshot,
            accepted: true,
            backgroundStarted: job.started,
          }, uploadKey, accepted.cacheHit);
        }

        return await submitIdempotentBatch({
          ledger: imageTaskLedger,
          batchKey: String(request.body.batchKey || tasks[0]?.idempotencyKey || ""),
          tasks,
          common,
          images,
          sourceImages: request.body.sourceImages,
          tokens,
          concurrency: request.body.concurrency,
          uploadImages: uploadImageInputs,
          submitTask: async ({ task, common: taskCommon, uploadedImageIds, token }) =>
            submitImageCompositionFromUploadedIds(
              String(task.model || taskCommon.model || "jimeng-4.5"),
              String(task.prompt),
              uploadedImageIds,
              {
                ratio: String(task.ratio || taskCommon.ratio || "1:1"),
                resolution: String(task.resolution || taskCommon.resolution || "2k"),
                sampleStrength: Number(task.sampleStrength ?? taskCommon.sampleStrength ?? 0.5),
                intelligentRatio: Boolean(task.intelligentRatio ?? taskCommon.intelligentRatio ?? false),
              },
              token
            ),
        });
      } catch (error) {
        return ledgerErrorResponse(error);
      }
    },

    "/tasks/status": async (request: Request) => {
      request
        .validate("body.tasks", _.isArray)
        .validate("headers.authorization", _.isString);

      const requestedTasks = request.body.tasks as Record<string, any>[];
      const tokens = tokenSplit(request.headers.authorization);
      try {
        const recovery = request.body.recovery && typeof request.body.recovery === "object"
          ? request.body.recovery as Record<string, any>
          : undefined;
        const uploadKey = firstString(request.body.uploadKey, recovery?.uploadKey);
        if (uploadKey) {
          const batchKey = firstString(request.body.batchKey);
          const taskKeys = requestedTasks.map((task) => String(task.idempotencyKey || ""));
          const failedUploadAtEntry = imageUploadStore.get(uploadKey);
          if (failedUploadAtEntry?.status === "failed_pre_submit") {
            const safeRecords = imageTaskLedger.findByUploadKey(uploadKey);
            await asyncBatchCoordinator.reconcileFailedUploadReservations({
              uploadKey,
              reservations: safeRecords.map((record) => ({
                created: false,
                needsSubmission: false,
                releaseOnPreSubmit: record.status === "reserved",
                requestHash: record.requestHash,
                task: record.context as Record<string, any>,
                record,
              })),
            });
            return uploadFailureResponse(
              new ImageUploadStoreError(
                firstString(failedUploadAtEntry.failureCode, "image_upload_pre_submit"),
                firstString(failedUploadAtEntry.errorMessage, "参考图上传在生成提交前失败"),
                { stage: failedUploadAtEntry.failureStage }
              ),
              batchKey,
              uploadKey,
              taskKeys
            );
          }
          const reservedRecords = taskKeys
            .map((key) => imageTaskLedger.get(key))
            .filter((record) => record?.status === "reserved");
          if (reservedRecords.length > 0) {
            if (!recovery) {
              return decorateAsyncResponse({
                ok: false,
                code: "recovery_payload_required",
                message: "存在可恢复的异步任务，但 status 请求缺少 recovery",
                batchKey,
                taskCount: requestedTasks.length,
                tasks: publicStoredTasks(taskKeys),
              }, uploadKey);
            }
            const common = recovery.common || {};
            const sourceImages = recovery.sourceImages;
            const images = recovery.images as (string | Buffer)[];
            const sourceSubmissionId = firstString(
              recovery.sourceSubmissionId,
              common.sourceSubmissionId,
              reservedRecords[0]?.context?.sourceSubmissionId
            );
            const recoveryTasks = requestedTasks.map((requestedTask) => {
              const stored = imageTaskLedger.get(String(requestedTask.idempotencyKey || ""));
              return { ...(stored?.context || {}), ...requestedTask };
            });
            const affinity = resolveAffinityToken(uploadKey, tokens, taskKeys);
            const reReserved = await reserveIdempotentBatchForAsync({
              ledger: imageTaskLedger,
              batchKey,
              tasks: recoveryTasks,
              common,
              sourceImages,
              tokenFingerprint: affinity.tokenFingerprint,
              uploadKey,
            });
            const reservations = adoptRecoverableAsyncReservations(
              imageTaskLedger,
              reReserved.reservations
            );
            const failedUpload = imageUploadStore.get(uploadKey)?.status === "failed_pre_submit";
            if (failedUpload) {
              await asyncBatchCoordinator.reconcileFailedUploadReservations({ uploadKey, reservations });
              return uploadFailureResponse(
                new ImageUploadStoreError(
                  firstString(imageUploadStore.get(uploadKey)?.failureCode, "image_upload_pre_submit"),
                  firstString(imageUploadStore.get(uploadKey)?.errorMessage, "参考图上传在生成提交前失败"),
                  { stage: imageUploadStore.get(uploadKey)?.failureStage }
                ),
                batchKey,
                uploadKey,
                taskKeys
              );
            }

            let cacheHit = imageUploadStore.get(uploadKey)?.status === "ready";
            if (!imageUploadStore.get(uploadKey) || imageUploadStore.get(uploadKey)?.status === "receiving") {
              try {
                const accepted = await imageUploadStore.acceptSources({
                  uploadKey,
                  sourceSubmissionId,
                  sourceImages,
                  tokenFingerprint: affinity.tokenFingerprint,
                  readSource: (index, signal) => downloadImageInputToBuffer(images[index], signal),
                });
                cacheHit = accepted.cacheHit;
              } catch (error) {
                await failAndReleaseBeforeSubmit({ error, uploadKey, reservations });
                return uploadFailureResponse(error, batchKey, uploadKey, taskKeys);
              }
            }
            try {
              asyncBatchCoordinator.start({
                batchKey,
                uploadKey,
                token: affinity.token,
                tokenFingerprint: affinity.tokenFingerprint,
                common,
                reservations,
                cacheHit,
                uploadOne: ({ bytes, token, attempt, signal }) =>
                  uploadImageBufferForAsyncTask(bytes, token, { attempt, signal }),
                submitTask: ({ task, common: taskCommon, uploadedImageIds, token, remoteSubmitId, onBeforeRemoteSubmit }) =>
                  submitAsyncTask(task, taskCommon, uploadedImageIds, token, remoteSubmitId, onBeforeRemoteSubmit),
              });
            } catch (error) {
              if (error instanceof ImageUploadStoreError && error.code === "batch_conflict") {
                await releaseNewReservationsForBatchConflict(reservations, uploadKey);
                return uploadFailureResponse(error, batchKey, uploadKey, taskKeys);
              }
              throw error;
            }
          }
        }

        let status;
        try {
          status = await queryIdempotentBatch({
            ledger: imageTaskLedger,
            batchKey: String(request.body.batchKey || ""),
            phase: String(request.body.phase || "initial"),
            pollCount: Number(request.body.pollCount || 0),
            maxPollCount: Number(request.body.maxPollCount || 120),
            tasks: requestedTasks,
            tokens,
            concurrency: request.body.concurrency,
            queryTask: queryImageCompositionTask,
          });
        } catch (error) {
          const failedUpload = uploadKey ? imageUploadStore.get(uploadKey) : undefined;
          if (uploadKey && failedUpload?.status === "failed_pre_submit") {
            return uploadFailureResponse(error, String(request.body.batchKey || ""), uploadKey, []);
          }
          throw error;
        }
        imageUploadStore.cleanupExpired({ activeUploadKeys: asyncBatchCoordinator.activeUploadKeys() });
        return uploadKey ? decorateAsyncResponse(status, uploadKey) : status;
      } catch (error) {
        return ledgerErrorResponse(error);
      }
    },

    "/generations": async (request: Request) => {
      // 检查是否使用了不支持的参数
      const unsupportedParams = ['size', 'width', 'height'];
      const bodyKeys = Object.keys(request.body);
      const foundUnsupported = unsupportedParams.filter(param => bodyKeys.includes(param));

      if (foundUnsupported.length > 0) {
        throw new Error(`不支持的参数: ${foundUnsupported.join(', ')}。请使用 ratio 和 resolution 参数控制图像尺寸。`);
      }

      const contentType = request.headers['content-type'] || '';
      const isMultiPart = contentType.startsWith('multipart/form-data');

      // 根据请求类型进行不同的参数验证
      if (isMultiPart) {
        request
          .validate("body.model", v => _.isUndefined(v) || _.isString(v))
          .validate("body.prompt", _.isString)
          .validate("body.negative_prompt", v => _.isUndefined(v) || _.isString(v))
          .validate("body.ratio", v => _.isUndefined(v) || _.isString(v))
          .validate("body.resolution", v => _.isUndefined(v) || _.isString(v))
          .validate("body.intelligent_ratio", v => _.isUndefined(v) || (typeof v === 'string' && (v === 'true' || v === 'false')) || _.isBoolean(v))
          .validate("body.sample_strength", v => _.isUndefined(v) || (typeof v === 'string' && !isNaN(parseFloat(v))) || _.isFinite(v))
          .validate("body.response_format", v => _.isUndefined(v) || _.isString(v))
          .validate("headers.authorization", _.isString);
      } else {
        request
          .validate("body.model", v => _.isUndefined(v) || _.isString(v))
          .validate("body.prompt", _.isString)
          .validate("body.images", v => _.isUndefined(v) || _.isArray(v))
          .validate("body.negative_prompt", v => _.isUndefined(v) || _.isString(v))
          .validate("body.ratio", v => _.isUndefined(v) || _.isString(v))
          .validate("body.resolution", v => _.isUndefined(v) || _.isString(v))
          .validate("body.intelligent_ratio", v => _.isUndefined(v) || _.isBoolean(v))
          .validate("body.sample_strength", v => _.isUndefined(v) || _.isFinite(v))
          .validate("body.response_format", v => _.isUndefined(v) || _.isString(v))
          .validate("headers.authorization", _.isString);
      }

      // 处理图片数据（如果提供）
      let images: (string | Buffer)[] | null = null;
      if (isMultiPart) {
        const files = (request.files as any)?.images;
        if (files) {
          const imageFiles = Array.isArray(files) ? files : [files];
          if (imageFiles.length > 0) {
            if (imageFiles.length > 10) {
              throw new Error("最多支持10张输入图片");
            }
            images = imageFiles.map((file: any) => fs.readFileSync(file.filepath));
          }
        }
      } else {
        const bodyImages = request.body.images;
        if (bodyImages && Array.isArray(bodyImages) && bodyImages.length > 0) {
          if (bodyImages.length > 10) {
            throw new Error("最多支持10张输入图片");
          }
          bodyImages.forEach((image: any, index: number) => {
            if (!_.isString(image) && !_.isObject(image)) {
              throw new Error(`图片 ${index + 1} 格式不正确：应为URL字符串或包含url字段的对象`);
            }
            if (_.isObject(image) && !(image as any).url) {
              throw new Error(`图片 ${index + 1} 缺少url字段`);
            }
          });
          images = bodyImages.map((image: any) => _.isString(image) ? image : (image as any).url);
        }
      }

      // refresh_token切分
      const tokens = tokenSplit(request.headers.authorization);
      // 随机挑选一个refresh_token
      const token = _.sample(tokens);

      const {
        model,
        prompt,
        negative_prompt: negativePrompt,
        ratio,
        resolution,
        intelligent_ratio: intelligentRatio,
        sample_strength: sampleStrength,
        response_format,
      } = request.body;

      // 如果是 multipart/form-data，需要将字符串转换为数字和布尔值
      const finalSampleStrength = isMultiPart && typeof sampleStrength === 'string'
        ? parseFloat(sampleStrength)
        : sampleStrength;

      const finalIntelligentRatio = isMultiPart && typeof intelligentRatio === 'string'
        ? intelligentRatio === 'true'
        : intelligentRatio;

      const responseFormat = _.defaultTo(response_format, "url");

      // 根据是否有图片数据决定调用文生图还是图生图
      let imageUrls: string[];
      let resultData: any = {
        created: util.unixTimestamp(),
      };

      if (images && images.length > 0) {
        // 图生图模式
        imageUrls = await generateImageComposition(model, prompt, images, {
          ratio,
          resolution,
          sampleStrength: finalSampleStrength,
          negativePrompt,
          intelligentRatio: finalIntelligentRatio,
        }, token);
        resultData.input_images = images.length;
        resultData.composition_type = "multi_image_synthesis";
      } else {
        // 文生图模式
        imageUrls = await generateImages(model, prompt, {
          ratio,
          resolution,
          sampleStrength: finalSampleStrength,
          negativePrompt,
          intelligentRatio: finalIntelligentRatio,
        }, token);
      }

      let data = [];
      if (responseFormat == "b64_json") {
        data = (
          await Promise.all(imageUrls.map((url) => util.fetchFileBASE64(url)))
        ).map((b64) => ({ b64_json: b64 }));
      } else {
        data = imageUrls.map((url) => ({
          url,
        }));
      }

      resultData.data = data;
      return resultData;
    },

    // 图片合成路由（图生图）
    "/compositions": async (request: Request) => {
      // 检查是否使用了不支持的参数
      const unsupportedParams = ['size', 'width', 'height'];
      const bodyKeys = Object.keys(request.body);
      const foundUnsupported = unsupportedParams.filter(param => bodyKeys.includes(param));

      if (foundUnsupported.length > 0) {
        throw new Error(`不支持的参数: ${foundUnsupported.join(', ')}。请使用 ratio 和 resolution 参数控制图像尺寸。`);
      }

      const contentType = request.headers['content-type'] || '';
      const isMultiPart = contentType.startsWith('multipart/form-data');

      if (isMultiPart) {
        request
          .validate("body.model", v => _.isUndefined(v) || _.isString(v))
          .validate("body.prompt", _.isString)
          .validate("body.negative_prompt", v => _.isUndefined(v) || _.isString(v))
          .validate("body.ratio", v => _.isUndefined(v) || _.isString(v))
          .validate("body.resolution", v => _.isUndefined(v) || _.isString(v))
          .validate("body.intelligent_ratio", v => _.isUndefined(v) || (typeof v === 'string' && (v === 'true' || v === 'false')) || _.isBoolean(v))
          .validate("body.sample_strength", v => _.isUndefined(v) || (typeof v === 'string' && !isNaN(parseFloat(v))) || _.isFinite(v))
          .validate("body.response_format", v => _.isUndefined(v) || _.isString(v))
          .validate("headers.authorization", _.isString);
      } else {
        request
          .validate("body.model", v => _.isUndefined(v) || _.isString(v))
          .validate("body.prompt", _.isString)
          .validate("body.images", _.isArray)
          .validate("body.negative_prompt", v => _.isUndefined(v) || _.isString(v))
          .validate("body.ratio", v => _.isUndefined(v) || _.isString(v))
          .validate("body.resolution", v => _.isUndefined(v) || _.isString(v))
          .validate("body.intelligent_ratio", v => _.isUndefined(v) || _.isBoolean(v))
          .validate("body.sample_strength", v => _.isUndefined(v) || _.isFinite(v))
          .validate("body.response_format", v => _.isUndefined(v) || _.isString(v))
          .validate("headers.authorization", _.isString);
      }

      let images: (string | Buffer)[] = [];
      if (isMultiPart) {
        const files = (request.files as any)?.images;
        if (!files) {
          throw new Error("在form-data中缺少 'images' 字段");
        }
        const imageFiles = Array.isArray(files) ? files : [files];
        if (imageFiles.length === 0) {
          throw new Error("至少需要提供1张输入图片");
        }
        if (imageFiles.length > 10) {
          throw new Error("最多支持10张输入图片");
        }
        images = imageFiles.map((file: any) => fs.readFileSync(file.filepath));
      } else {
        const bodyImages = request.body.images;
        if (!bodyImages || bodyImages.length === 0) {
          throw new Error("至少需要提供1张输入图片");
        }
        if (bodyImages.length > 10) {
          throw new Error("最多支持10张输入图片");
        }
        bodyImages.forEach((image: any, index: number) => {
          if (!_.isString(image) && !_.isObject(image)) {
            throw new Error(`图片 ${index + 1} 格式不正确：应为URL字符串或包含url字段的对象`);
          }
          if (_.isObject(image) && !(image as any).url) {
            throw new Error(`图片 ${index + 1} 缺少url字段`);
          }
        });
        images = bodyImages.map((image: any) => _.isString(image) ? image : (image as any).url);
      }

      // refresh_token切分
      const tokens = tokenSplit(request.headers.authorization);
      // 随机挑选一个refresh_token
      const token = _.sample(tokens);

      const {
        model,
        prompt,
        negative_prompt: negativePrompt,
        ratio,
        resolution,
        intelligent_ratio: intelligentRatio,
        sample_strength: sampleStrength,
        response_format,
      } = request.body;

      // 如果是 multipart/form-data，需要将字符串转换为数字和布尔值
      const finalSampleStrength = isMultiPart && typeof sampleStrength === 'string'
        ? parseFloat(sampleStrength)
        : sampleStrength;

      const finalIntelligentRatio = isMultiPart && typeof intelligentRatio === 'string'
        ? intelligentRatio === 'true'
        : intelligentRatio;

      const responseFormat = _.defaultTo(response_format, "url");
      const resultUrls = await generateImageComposition(model, prompt, images, {
        ratio,
        resolution,
        sampleStrength: finalSampleStrength,
        negativePrompt,
        intelligentRatio: finalIntelligentRatio,
      }, token);

      let data = [];
      if (responseFormat == "b64_json") {
        data = (
          await Promise.all(resultUrls.map((url) => util.fetchFileBASE64(url)))
        ).map((b64) => ({ b64_json: b64 }));
      } else {
        data = resultUrls.map((url) => ({
          url,
        }));
      }

      return {
        created: util.unixTimestamp(),
        data,
        input_images: images.length,
        composition_type: "multi_image_synthesis",
      };
    },
  },
};
