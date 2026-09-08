import _ from "lodash";

import APIException from "@/lib/exceptions/APIException.ts";
import EX from "@/api/consts/exceptions.ts";
import util from "@/lib/util.ts";
import { getCredit, receiveCredit, request, parseRegionFromToken, getAssistantId } from "./core.ts";
import logger from "@/lib/logger.ts";
import { DEFAULT_IMAGE_MODEL, imageCompositionOutputCount, resolveImageModel, resolveResolution, validateImageRequest } from "../services/image-model.ts";
import { buildImageCompositionRequest } from "../services/image-composition-request.ts";
import { imageCompletionPolicy } from '../services/image-completion-policy.mjs';
import { uploadImageBufferForVideo } from "./videos.ts";
import {
  IMAGE_COMPOSITION_HISTORY_RETRY_DELAYS_MS,
  classifyImageCompositionSnapshot,
  extractImageCompositionUrls,
  getImageCompositionHistoryRetryDelayMs,
  isTransientImageCompositionHistoryError,
} from "../services/image-composition-status.ts";
import {
  uploadImageInputsWithRetry,
} from "../services/image-input-upload-retry.ts";

const DEFAULT_ASSISTANT_ID = 513695;
export const DEFAULT_MODEL = DEFAULT_IMAGE_MODEL;
const DRAFT_VERSION = "3.3.4";
const DRAFT_MIN_VERSION = "3.0.2";
function getImageAssistantId(refreshToken: string): number {
  return getAssistantId(parseRegionFromToken(refreshToken));
}

// One authoritative model map; unknown names must never silently become 4.5.
export function getModel(model: string) {
  return resolveImageModel(model).config.internalModel;
}

export async function downloadImageInputToBuffer(
  image: string | Buffer,
  signal?: AbortSignal
): Promise<Buffer> {
  if (signal?.aborted) throw signal.reason || new Error("source image download cancelled");
  if (Buffer.isBuffer(image)) {
    const copy = Buffer.from(image);
    if (signal?.aborted) throw signal.reason || new Error("source image download cancelled");
    return copy;
  }
  const imageResponse = await fetch(image, { signal });
  if (!imageResponse.ok) {
    throw Object.assign(
      new Error(`下载图片失败: ${imageResponse.status}`),
      { status: imageResponse.status, stage: "source_image_download" }
    );
  }
  const bytes = Buffer.from(await imageResponse.arrayBuffer());
  if (signal?.aborted) throw signal.reason || new Error("source image download cancelled");
  if (bytes.length === 0) throw new Error("下载图片失败: 响应内容为空");
  return bytes;
}

export async function uploadImageBufferForAsyncTask(
  buffer: Buffer,
  refreshToken: string,
  options: { attempt?: number; signal?: AbortSignal } = {}
): Promise<string> {
  return uploadImageBufferForVideo(
    buffer,
    refreshToken,
    parseRegionFromToken(refreshToken),
    { attempt: options.attempt, signal: options.signal }
  );
}

async function uploadImageFromUrl(
  imageUrl: string,
  refreshToken: string,
  options: { attempt?: number; signal?: AbortSignal } = {}
): Promise<string> {
  const regionInfo = parseRegionFromToken(refreshToken);
  const imageBuffer = await downloadImageInputToBuffer(imageUrl, options.signal);
  return uploadImageBufferForVideo(imageBuffer, refreshToken, regionInfo, {
    attempt: options.attempt,
    signal: options.signal,
  });
}

// 从Buffer上传图片
async function uploadImageBuffer(
  buffer: Buffer,
  refreshToken: string,
  options: { attempt?: number; signal?: AbortSignal } = {}
): Promise<string> {
  return uploadImageBufferForAsyncTask(buffer, refreshToken, options);
}

export async function uploadImageInputs(
  imageUrls: (string | Buffer)[],
  refreshToken: string,
  sourceImages: Array<Record<string, unknown> | string> = []
): Promise<string[]> {
  const sourceFileNames = sourceImages.map((sourceImage) => {
    if (typeof sourceImage === "string") return sourceImage;
    return String(sourceImage?.sourceFileName || sourceImage?.fileName || "").trim();
  });

  return uploadImageInputsWithRetry({
    inputs: imageUrls,
    sourceFileNames,
    uploadOne: async (image, _index, attempt) => typeof image === "string"
      ? uploadImageFromUrl(image, refreshToken, { attempt })
      : uploadImageBuffer(image, refreshToken, { attempt }),
    onRetry: (event) => {
      const reason = event.statusCode
        ? `HTTP ${event.statusCode}`
        : (event.networkCode || "network error");
      logger.warn(
        `异步批次参考图 ${event.imageIndex}/${event.imageCount} 上传遇到可重试错误（${reason}），` +
        `${event.delayMs}ms 后进行第 ${event.nextAttempt}/3 次尝试`
      );
    },
    onSuccess: (event) => {
      logger.info(
        `异步批次参考图 ${event.imageIndex}/${event.imageCount} 上传成功` +
        `${event.attemptCount > 1 ? `（第 ${event.attemptCount} 次尝试）` : ""}`
      );
    },
  });
}

export async function submitImageCompositionFromUploadedIds(
  _model: string,
  prompt: string,
  uploadedImageIds: string[],
  {
    ratio = "1:1",
    resolution = "2k",
    sampleStrength = 0.5,
    intelligentRatio = false,
  }: {
    ratio?: string;
    resolution?: string;
    sampleStrength?: number;
    intelligentRatio?: boolean;
  },
  refreshToken: string,
  options: {
    remoteSubmitId?: string;
    onBeforeRemoteSubmit?: () => Promise<void> | void;
  } = {}
): Promise<{ historyId: string; status: "processing" }> {
  if (!uploadedImageIds.length) {
    throw new APIException(EX.API_IMAGE_GENERATION_FAILED, "至少需要一张参考图");
  }

  validateImageRequest({ model: _model, ratio, resolution, operation: 'composition', imageCount: uploadedImageIds.length });
  const requestedSubmitId = String(options.remoteSubmitId || "").trim();
  if (requestedSubmitId && !/^[A-Za-z0-9:_-]{8,128}$/.test(requestedSubmitId)) {
    throw new APIException(EX.API_REQUEST_PARAMS_INVALID, "remoteSubmitId 格式无效");
  }
  const { totalCredit } = await getCredit(refreshToken);
  if (totalCredit <= 0) await receiveCredit(refreshToken);
  const { aigc_data } = await request("post", "/mweb/v1/aigc_draft/generate", refreshToken, {
    ...buildImageCompositionRequest({
      model: _model, prompt, uploadedImageIds, ratio, resolution, sampleStrength, intelligentRatio,
      assistantId: getImageAssistantId(refreshToken), profile: 'async', remoteSubmitId: requestedSubmitId,
    }, { uuid: () => util.uuid(), now: () => Date.now() }),
    onBeforeRemoteSubmit: options.onBeforeRemoteSubmit,
  } as any);

  const historyId = aigc_data?.history_record_id;
  if (!historyId) {
    throw new APIException(EX.API_IMAGE_GENERATION_FAILED, "记录ID不存在");
  }
  logger.info(`异步图生图任务已提交，history_id: ${historyId}`);
  return { historyId: String(historyId), status: "processing" };
}

export async function queryImageCompositionTask(
  historyId: string,
  refreshToken: string,
  context: Readonly<Record<string, unknown>> = {}
): Promise<{
  historyId: string;
  status: "processing" | "success" | "failed";
  rawStatus: number;
  failCode: string;
  count: number;
  imageUrls: string[];
}> {
  const assistantId = getImageAssistantId(refreshToken);
  const result = await request("post", "/mweb/v1/get_history_by_ids", refreshToken, {
    data: {
      history_ids: [historyId],
      image_info: {
        width: 2048,
        height: 2048,
        format: "webp",
        image_scene_list: [
          { scene: "smart_crop", width: 360, height: 360, uniq_key: "smart_crop-w:360-h:360", format: "webp" },
          { scene: "smart_crop", width: 480, height: 480, uniq_key: "smart_crop-w:480-h:480", format: "webp" },
          { scene: "smart_crop", width: 720, height: 720, uniq_key: "smart_crop-w:720-h:720", format: "webp" },
          { scene: "smart_crop", width: 720, height: 480, uniq_key: "smart_crop-w:720-h:480", format: "webp" },
          { scene: "normal", width: 2400, height: 2400, uniq_key: "2400", format: "webp" },
          { scene: "normal", width: 1080, height: 1080, uniq_key: "1080", format: "webp" },
          { scene: "normal", width: 720, height: 720, uniq_key: "720", format: "webp" },
          { scene: "normal", width: 480, height: 480, uniq_key: "480", format: "webp" },
          { scene: "normal", width: 360, height: 360, uniq_key: "360", format: "webp" },
        ],
      },
      http_common_info: { aid: assistantId },
    },
  });

  const record = result?.[historyId];
  if (!record) {
    return { historyId, status: "processing", rawStatus: 0, failCode: "", count: 0, imageUrls: [] };
  }
  const rawStatus = Number(record.status || 0);
  const failCode = String(record.fail_code || "");
  let snapshot = classifyImageCompositionSnapshot(rawStatus, record.item_list || [], 4, {
    failCode, referenceImages: Array.isArray(context.referenceImages) ? context.referenceImages as string[] : [],
    retryAttempt: Number(context.retryAttempt || 0),
  });
  if (!context.policyVersion) {
    // Frozen compatibility for pre-policy history, never rewrite old records
    // merely because a new candidate is deployed.
    const legacyUrls = extractImageCompositionUrls(record.item_list || []);
    const single = (context.imageModel ?? context.model) === 'jimeng-4.7';
    const legacySuccess = rawStatus !== 30 && (single ? rawStatus === 50 && legacyUrls.length >= 1 : legacyUrls.length >= 4)
      || rawStatus === 10 && legacyUrls.length > 0;
    snapshot = {...snapshot, state: rawStatus === 30 ? 'failed' : legacySuccess ? 'success' : 'processing', imageUrls:legacyUrls, count:legacyUrls.length};
  }
  return {
    historyId,
    status: snapshot.state,
    rawStatus: snapshot.rawStatus,
    failCode,
    count: snapshot.count,
    imageUrls: context.policyVersion ? extractImageCompositionUrls(record.item_list || []) : snapshot.imageUrls,
  };
}

// 图片合成功能：先上传图片，然后进行图生图
export async function generateImageComposition(
  _model: string,
  prompt: string,
  imageUrls: (string | Buffer)[],
  {
    ratio = "1:1",
    resolution = "2k",
    sampleStrength = 0.5,
    negativePrompt = "",
    intelligentRatio = false,
  }: {
    ratio?: string;
    resolution?: string;
    sampleStrength?: number;
    negativePrompt?: string;
    intelligentRatio?: boolean;
  },
  refreshToken: string
) {
  validateImageRequest({ model: _model, ratio, resolution, operation: 'composition', imageCount: imageUrls.length });
  const model = getModel(_model);
  const imageCount = imageUrls.length;

  // 解析分辨率
  const resolutionResult = resolveResolution(resolution, ratio);
  const { width, height, imageRatio, resolutionType } = resolutionResult;

  logger.info(`使用模型: ${_model} 映射模型: ${model} 图生图功能 ${imageCount}张图片 ${width}x${height} (${ratio}@${resolution}) 精细度: ${sampleStrength}`);

  const { totalCredit } = await getCredit(refreshToken);
  if (totalCredit <= 0)
    await receiveCredit(refreshToken);

  const assistantId = getImageAssistantId(refreshToken);

  // 上传所有输入图片
  const uploadedImageIds: string[] = [];
  for (let i = 0; i < imageUrls.length; i++) {
    try {
      const image = imageUrls[i];
      let imageId: string;
      if (typeof image === 'string') {
        logger.info(`正在处理第 ${i + 1}/${imageCount} 张图片 (URL)...`);
        imageId = await uploadImageFromUrl(image, refreshToken);
      } else {
        logger.info(`正在处理第 ${i + 1}/${imageCount} 张图片 (Buffer)...`);
        imageId = await uploadImageBuffer(image, refreshToken);
      }
      uploadedImageIds.push(imageId);
      logger.info(`图片 ${i + 1}/${imageCount} 上传成功`);
    } catch (error) {
      logger.error(`图片 ${i + 1}/${imageCount} 上传失败: ${error.message}`);
      throw new APIException(EX.API_IMAGE_GENERATION_FAILED, `图片上传失败: ${error.message}`);
    }
  }

  logger.info(`所有图片上传完成，开始图生图: imageCount=${uploadedImageIds.length}`);

  const { aigc_data } = await request("post", "/mweb/v1/aigc_draft/generate", refreshToken,
    buildImageCompositionRequest({
      model: _model, prompt, uploadedImageIds, ratio, resolution, sampleStrength, intelligentRatio,
      assistantId, profile: 'sync',
    }, { uuid: () => util.uuid(), now: () => Date.now() })
  );

  const historyId = aigc_data?.history_record_id;
  if (!historyId)
    throw new APIException(EX.API_IMAGE_GENERATION_FAILED, "记录ID不存在");

  logger.info(`图生图任务已提交，history_id: ${historyId}，等待生成完成...`);
  const pollingStartedAt = Date.now();

  let status = 20, failCode, item_list = [];
  let pollCount = 0;
  const maxPollCount = 600; // 最多轮询10分钟
  let terminalReason = "max_poll_count";
  let consecutiveHistoryQueryFailures = 0;
  let totalHistoryQueryRetries = 0;

  const waitForSameHistoryRetry = async (reason: "get_history_failed" | "missing_history_record") => {
    const nextFailureCount = consecutiveHistoryQueryFailures + 1;
    if (nextFailureCount > IMAGE_COMPOSITION_HISTORY_RETRY_DELAYS_MS.length) return false;
    consecutiveHistoryQueryFailures = nextFailureCount;
    totalHistoryQueryRetries++;
    const delayMs = getImageCompositionHistoryRetryDelayMs(nextFailureCount);
    logger.warn(
      `图生图历史查询瞬时失败，将重查同一任务: historyId=${historyId}, ` +
      `reason=${reason}, consecutive=${nextFailureCount}/${IMAGE_COMPOSITION_HISTORY_RETRY_DELAYS_MS.length}, ` +
      `delayMs=${delayMs}`
    );
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    return true;
  };

  while (pollCount < maxPollCount) {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    pollCount++;

    if (pollCount % 30 === 0) {
      logger.info(`图生图进度: 第 ${pollCount} 次轮询 (history_id: ${historyId})，当前状态: ${status}，已生成: ${item_list.length} 张图片...`);
    }

    let result: any;
    while (true) {
      try {
        result = await request("post", "/mweb/v1/get_history_by_ids", refreshToken, {
          data: {
            history_ids: [historyId],
            image_info: {
          width: 2048,
          height: 2048,
          format: "webp",
          image_scene_list: [
            {
              scene: "smart_crop",
              width: 360,
              height: 360,
              uniq_key: "smart_crop-w:360-h:360",
              format: "webp",
            },
            {
              scene: "smart_crop",
              width: 480,
              height: 480,
              uniq_key: "smart_crop-w:480-h:480",
              format: "webp",
            },
            {
              scene: "smart_crop",
              width: 720,
              height: 720,
              uniq_key: "smart_crop-w:720-h:720",
              format: "webp",
            },
            {
              scene: "smart_crop",
              width: 720,
              height: 480,
              uniq_key: "smart_crop-w:720-h:480",
              format: "webp",
            },
            {
              scene: "normal",
              width: 2400,
              height: 2400,
              uniq_key: "2400",
              format: "webp",
            },
            {
              scene: "normal",
              width: 1080,
              height: 1080,
              uniq_key: "1080",
              format: "webp",
            },
            {
              scene: "normal",
              width: 720,
              height: 720,
              uniq_key: "720",
              format: "webp",
            },
            {
              scene: "normal",
              width: 480,
              height: 480,
              uniq_key: "480",
              format: "webp",
            },
            {
              scene: "normal",
              width: 360,
              height: 360,
              uniq_key: "360",
              format: "webp",
            },
          ],
            },
            http_common_info: {
              aid: assistantId,
            },
          },
        });
      } catch (error) {
        if (!isTransientImageCompositionHistoryError(error)) throw error;
        if (await waitForSameHistoryRetry("get_history_failed")) continue;
        logger.error(
          `图生图历史查询连续失败，停止同一任务轮询: historyId=${historyId}, ` +
          `retries=${totalHistoryQueryRetries}`
        );
        throw error;
      }

      if (!result || !result[historyId]) {
        if (await waitForSameHistoryRetry("missing_history_record")) continue;
        throw new APIException(EX.API_IMAGE_GENERATION_FAILED, "记录不存在");
      }

      consecutiveHistoryQueryFailures = 0;
      break;
    }

    status = Number(result[historyId].status || 0);
    failCode = String(result[historyId].fail_code || "");
    item_list = result[historyId].item_list || [];
    const snapshot = classifyImageCompositionSnapshot(status, item_list, 4, {
      failCode, referenceImages: imageUrls.filter((value): value is string => typeof value === 'string'),
    });
    status = snapshot.rawStatus;

    if (snapshot.state === "failed") {
      terminalReason = snapshot.reason;
      break;
    }

    if (snapshot.state === "success") {
      terminalReason = snapshot.reason;
      break;
    }

    // 记录详细状态
    if (pollCount % 60 === 0) {
      logger.info(`图生图详细状态: status=${status}, item_list.length=${item_list.length}, failCode=${failCode || 'none'}`);
    }

    // 如果状态是完成但图片数量为0，记录并继续等待
    if (status === 10 && item_list.length === 0 && pollCount % 30 === 0) {
      logger.info(`图生图状态已完成但无图片生成: 状态=${status}, 继续等待...`);
    }
  }

  if (pollCount >= maxPollCount) {
    logger.warn(`图生图超时: 轮询了 ${pollCount} 次，当前状态: ${status}，有效图片数: ${extractImageCompositionUrls(item_list).length}`);
  }

  const uniqueUrls = imageCompletionPolicy.evaluate({rawStatus: status, failCode,
    imageUrls: extractImageCompositionUrls(item_list),
    referenceImages: imageUrls.filter((value): value is string => typeof value === 'string'), deadlineReached: true}).imageUrls;
  logger.info(
    `图生图终态: historyId=${historyId}, rawStatus=${status}, ` +
    `有效图片数=${uniqueUrls.length}, reason=${terminalReason}, ` +
    `pollCount=${pollCount}, historyQueryRetries=${totalHistoryQueryRetries}, ` +
    `elapsedMs=${Date.now() - pollingStartedAt}`
  );

  if (status === 30 && uniqueUrls.length === 0) {
    if (failCode === '2038')
      throw new APIException(EX.API_CONTENT_FILTERED);
    else
      throw new APIException(EX.API_IMAGE_GENERATION_FAILED, `图生图失败，错误代码: ${failCode}`);
  }

  logger.info(`图生图结果: 成功生成 ${uniqueUrls.length} 张图片`);
  return uniqueUrls;
}

// 多图生成函数（支持jimeng-4.0及以上版本）
async function generateMultiImages(
  _model: string,
  prompt: string,
  {
    ratio = "1:1",
    resolution = "2k",
    sampleStrength = 0.5,
    negativePrompt = "",
    intelligentRatio = false,
  }: {
    ratio?: string;
    resolution?: string;
    sampleStrength?: number;
    negativePrompt?: string;
    intelligentRatio?: boolean;
  },
  refreshToken: string
) {
  validateImageRequest({ model: _model, ratio, resolution, operation: 'generation' });
  const model = getModel(_model);
  const assistantId = getImageAssistantId(refreshToken);

  // 解析分辨率
  const resolutionResult = resolveResolution(resolution, ratio);
  const { width, height, imageRatio, resolutionType } = resolutionResult;

  // 从prompt中提取图片数量，默认为4张
  const targetImageCount = prompt.match(/(\d+)张/) ? parseInt(prompt.match(/(\d+)张/)[1]) : 4;

  logger.info(`使用 ${_model} 多图生成: ${targetImageCount}张图片 ${width}x${height} (${ratio}@${resolution}) 精细度: ${sampleStrength}`);

  const componentId = util.uuid();
  const submitId = util.uuid();

  // 构建多图模式的 sceneOptions（不包含 benefitCount 以避免扣积分）
  const sceneOption = {
    type: "image",
    scene: "ImageMultiGenerate",
    modelReqKey: _model,
    resolutionType,
    abilityList: [],
    reportParams: {
      enterSource: "generate",
      vipSource: "generate",
      extraVipFunctionKey: `${_model}-${resolutionType}`,
      useVipFunctionDetailsReporterHoc: true,
    },
  };

  const { aigc_data } = await request(
    "post",
    "/mweb/v1/aigc_draft/generate",
    refreshToken,
    {
      data: {
        extend: {
          root_model: model,
        },
        submit_id: submitId,
        metrics_extra: JSON.stringify({
          promptSource: "custom",
          generateCount: 1,
          enterFrom: "click",
          sceneOptions: JSON.stringify([sceneOption]),
          generateId: submitId,
          isRegenerate: false,
          templateId: "",
          templateSource: "",
          lastRequestId: "",
          originRequestId: "",
        }),
        draft_content: JSON.stringify({
          type: "draft",
          id: util.uuid(),
          min_version: DRAFT_MIN_VERSION,
          min_features: [],
          is_from_tsn: true,
          version: DRAFT_VERSION,
          main_component_id: componentId,
          component_list: [
            {
              type: "image_base_component",
              id: componentId,
              min_version: DRAFT_MIN_VERSION,
              aigc_mode: "workbench",
              metadata: {
                type: "",
                id: util.uuid(),
                created_platform: 3,
                created_platform_version: "",
                created_time_in_ms: Date.now().toString(),
                created_did: "",
              },
              generate_type: "generate",
              abilities: {
                type: "",
                id: util.uuid(),
                generate: {
                  type: "",
                  id: util.uuid(),
                  core_param: {
                    type: "",
                    id: util.uuid(),
                    model,
                    prompt,
                    negative_prompt: negativePrompt,
                    seed: Math.floor(Math.random() * 100000000) + 2500000000,
                    sample_strength: sampleStrength,
                    image_ratio: imageRatio,
                    large_image_info: {
                      type: "",
                      id: util.uuid(),
                      min_version: DRAFT_MIN_VERSION,
                      height,
                      width,
                      resolution_type: resolutionType,
                    },
                    intelligent_ratio: intelligentRatio,
                  },
                  gen_option: {
                    type: "",
                    id: util.uuid(),
                    generate_all: false,
                  },
                },
              },
            },
          ],
        }),
        http_common_info: {
          aid: assistantId,
        },
      },
    }
  );

  const historyId = aigc_data?.history_record_id;
  if (!historyId)
    throw new APIException(EX.API_IMAGE_GENERATION_FAILED, "记录ID不存在");

  logger.info(`多图生成任务已提交，submit_id: ${submitId}, history_id: ${historyId}，等待生成 ${targetImageCount} 张图片...`);

  // 直接使用 history_id 轮询生成结果（增加轮询时间）
  let status = 20, failCode, item_list = [];
  let pollCount = 0;
  const maxPollCount = 600; // 最多轮询10分钟（600次 * 1秒）

  while (pollCount < maxPollCount) {
    await new Promise((resolve) => setTimeout(resolve, 1000)); // 每1秒轮询一次
    pollCount++;

    if (pollCount % 30 === 0) {
      logger.info(`多图生成进度: 第 ${pollCount} 次轮询 (history_id: ${historyId})，当前状态: ${status}，已生成: ${item_list.length}/${targetImageCount} 张图片...`);
    }

    const result = await request("post", "/mweb/v1/get_history_by_ids", refreshToken, {
      data: {
        history_ids: [historyId],
        image_info: {
          width: 2048,
          height: 2048,
          format: "webp",
          image_scene_list: [
            {
              scene: "smart_crop",
              width: 360,
              height: 360,
              uniq_key: "smart_crop-w:360-h:360",
              format: "webp",
            },
            {
              scene: "smart_crop",
              width: 480,
              height: 480,
              uniq_key: "smart_crop-w:480-h:480",
              format: "webp",
            },
            {
              scene: "smart_crop",
              width: 720,
              height: 720,
              uniq_key: "smart_crop-w:720-h:720",
              format: "webp",
            },
            {
              scene: "smart_crop",
              width: 720,
              height: 480,
              uniq_key: "smart_crop-w:720-h:480",
              format: "webp",
            },
            {
              scene: "normal",
              width: 2400,
              height: 2400,
              uniq_key: "2400",
              format: "webp",
            },
            {
              scene: "normal",
              width: 1080,
              height: 1080,
              uniq_key: "1080",
              format: "webp",
            },
            {
              scene: "normal",
              width: 720,
              height: 720,
              uniq_key: "720",
              format: "webp",
            },
            {
              scene: "normal",
              width: 480,
              height: 480,
              uniq_key: "480",
              format: "webp",
            },
            {
              scene: "normal",
              width: 360,
              height: 360,
              uniq_key: "360",
              format: "webp",
            },
          ],
        },
        http_common_info: {
          aid: assistantId,
        },
      },
    });

    if (!result[historyId])
      throw new APIException(EX.API_IMAGE_GENERATION_FAILED, "记录不存在");

    status = result[historyId].status;
    failCode = result[historyId].fail_code;
    item_list = result[historyId].item_list || [];

    // All image models use the same valid-output/terminal-state policy.
    if (classifyImageCompositionSnapshot(status, item_list, 4, {failCode: String(failCode || '')}).terminal) {
      logger.info(`多图生成完成: 状态=${status}, 已生成 ${item_list.length} 张图片`);
      break;
    }

    // 记录详细状态
    if (pollCount % 60 === 0) {
      logger.info(`jimeng-4.0 详细状态: status=${status}, item_list.length=${item_list.length}, failCode=${failCode || 'none'}`);
    }

    // 如果状态是完成但图片数量不够，记录并继续等待
    if (status === 10 && item_list.length < targetImageCount && pollCount % 30 === 0) {
      logger.info(`jimeng-4.0 状态已完成但图片数量不足: 状态=${status}, 已生成 ${item_list.length}/${targetImageCount} 张图片，继续等待...`);
    }
  }

  if (pollCount >= maxPollCount) {
    logger.warn(`多图生成超时: 轮询了 ${pollCount} 次，当前状态: ${status}，已生成图片数: ${item_list.length}`);
  }

  if (status === 30 && classifyImageCompositionSnapshot(status, item_list, 4, {failCode: String(failCode || '')}).state !== 'success') {
    if (failCode === '2038')
      throw new APIException(EX.API_CONTENT_FILTERED);
    else
      throw new APIException(EX.API_IMAGE_GENERATION_FAILED, `生成失败，错误代码: ${failCode}`);
  }

  const imageUrls = imageCompletionPolicy.evaluate({rawStatus: Number(status), failCode,
    imageUrls: extractImageCompositionUrls(item_list), deadlineReached: true}).imageUrls;

  logger.info(`多图生成结果: 成功生成 ${imageUrls.length} 张图片`);
  return imageUrls;
}

export async function generateImages(
  _model: string,
  prompt: string,
  {
    ratio = "1:1",
    resolution = "2k",
    sampleStrength = 0.5,
    negativePrompt = "",
    intelligentRatio = false,
  }: {
    ratio?: string;
    resolution?: string;
    sampleStrength?: number;
    negativePrompt?: string;
    intelligentRatio?: boolean;
  },
  refreshToken: string
) {
  validateImageRequest({ model: _model, ratio, resolution, operation: 'generation' });
  const model = getModel(_model);
  const assistantId = getImageAssistantId(refreshToken);

  // 解析分辨率
  const resolutionResult = resolveResolution(resolution, ratio);
  const { width, height, imageRatio, resolutionType } = resolutionResult;

  logger.info(`使用模型: ${_model} 映射模型: ${model} ${width}x${height} (${ratio}@${resolution}) 精细度: ${sampleStrength}`);


  const { totalCredit } = await getCredit(refreshToken);
  if (totalCredit <= 0)
    await receiveCredit(refreshToken);

  // 检测是否为多图生成请求
  const isMultiImageRequest = (/jimeng-[45]\.[0-9]/.test(_model)) && (
    prompt.includes("连续") ||
    prompt.includes("绘本") ||
    prompt.includes("故事") ||
    /\d+张/.test(prompt)
  );

  // 如果是多图请求，使用专门的处理逻辑
  if (isMultiImageRequest) {
    return await generateMultiImages(_model, prompt, { ratio, resolution, sampleStrength, negativePrompt, intelligentRatio }, refreshToken);
  }

  const componentId = util.uuid();
  const submitId = util.uuid();

  // 构建 sceneOptions 用于 metrics_extra（不包含 benefitCount 以避免扣积分）
  const sceneOption = {
    type: "image",
    scene: "ImageBasicGenerate",
    modelReqKey: _model,
    resolutionType,
    abilityList: [],
    reportParams: {
      enterSource: "generate",
      vipSource: "generate",
      extraVipFunctionKey: `${_model}-${resolutionType}`,
      useVipFunctionDetailsReporterHoc: true,
    },
  };

  const { aigc_data } = await request(
    "post",
    "/mweb/v1/aigc_draft/generate",
    refreshToken,
    {
      data: {
        extend: {
          root_model: model,
        },
        submit_id: submitId,
        metrics_extra: JSON.stringify({
          promptSource: "custom",
          generateCount: 1,
          enterFrom: "click",
          sceneOptions: JSON.stringify([sceneOption]),
          generateId: submitId,
          isRegenerate: false,
        }),
        draft_content: JSON.stringify({
          type: "draft",
          id: util.uuid(),
          min_version: DRAFT_MIN_VERSION,
          min_features: [],
          is_from_tsn: true,
          version: DRAFT_VERSION,
          main_component_id: componentId,
          component_list: [
            {
              type: "image_base_component",
              id: componentId,
              min_version: DRAFT_MIN_VERSION,
              aigc_mode: "workbench",
              metadata: {
                type: "",
                id: util.uuid(),
                created_platform: 3,
                created_platform_version: "",
                created_time_in_ms: Date.now().toString(),
                created_did: "",
              },
              generate_type: "generate",
              abilities: {
                type: "",
                id: util.uuid(),
                generate: {
                  type: "",
                  id: util.uuid(),
                  core_param: {
                    type: "",
                    id: util.uuid(),
                    model,
                    prompt,
                    negative_prompt: negativePrompt,
                    seed: Math.floor(Math.random() * 100000000) + 2500000000,
                    sample_strength: sampleStrength,
                    image_ratio: imageRatio,
                    large_image_info: {
                      type: "",
                      id: util.uuid(),
                      min_version: DRAFT_MIN_VERSION,
                      height,
                      width,
                      resolution_type: resolutionType,
                    },
                    intelligent_ratio: intelligentRatio,
                  },
                  gen_option: {
                    type: "",
                    id: util.uuid(),
                    generate_all: false,
                  },
                },
              },
            },
          ],
        }),
        http_common_info: {
          aid: assistantId,
        },
      },
    }
  );
  const historyId = aigc_data.history_record_id;
  if (!historyId)
    throw new APIException(EX.API_IMAGE_GENERATION_FAILED, "记录ID不存在");

  logger.info(`文生图任务已提交，submit_id: ${submitId}, history_id: ${historyId}，等待生成完成...`);

  let status = 20, failCode, item_list = [];
  let pollCount = 0;
  const maxPollCount = 600; // 最多轮询10分钟

  while (pollCount < maxPollCount) {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    pollCount++;

    if (pollCount % 30 === 0) {
      logger.info(`文生图进度: 第 ${pollCount} 次轮询 (history_id: ${historyId})，当前状态: ${status}，已生成: ${item_list.length} 张图片...`);
    }

    const result = await request("post", "/mweb/v1/get_history_by_ids", refreshToken, {
      data: {
        history_ids: [historyId],
        image_info: {
          width: 2048,
          height: 2048,
          format: "webp",
          image_scene_list: [
            {
              scene: "smart_crop",
              width: 360,
              height: 360,
              uniq_key: "smart_crop-w:360-h:360",
              format: "webp",
            },
            {
              scene: "smart_crop",
              width: 480,
              height: 480,
              uniq_key: "smart_crop-w:480-h:480",
              format: "webp",
            },
            {
              scene: "smart_crop",
              width: 720,
              height: 720,
              uniq_key: "smart_crop-w:720-h:720",
              format: "webp",
            },
            {
              scene: "smart_crop",
              width: 720,
              height: 480,
              uniq_key: "smart_crop-w:720-h:480",
              format: "webp",
            },
            {
              scene: "smart_crop",
              width: 360,
              height: 240,
              uniq_key: "smart_crop-w:360-h:240",
              format: "webp",
            },
            {
              scene: "smart_crop",
              width: 240,
              height: 320,
              uniq_key: "smart_crop-w:240-h:320",
              format: "webp",
            },
            {
              scene: "smart_crop",
              width: 480,
              height: 640,
              uniq_key: "smart_crop-w:480-h:640",
              format: "webp",
            },
            {
              scene: "normal",
              width: 2400,
              height: 2400,
              uniq_key: "2400",
              format: "webp",
            },
            {
              scene: "normal",
              width: 1080,
              height: 1080,
              uniq_key: "1080",
              format: "webp",
            },
            {
              scene: "normal",
              width: 720,
              height: 720,
              uniq_key: "720",
              format: "webp",
            },
            {
              scene: "normal",
              width: 480,
              height: 480,
              uniq_key: "480",
              format: "webp",
            },
            {
              scene: "normal",
              width: 360,
              height: 360,
              uniq_key: "360",
              format: "webp",
            },
          ],
        },
        http_common_info: {
          aid: assistantId,
        },
      },
    });
    if (!result[historyId])
      throw new APIException(EX.API_IMAGE_GENERATION_FAILED, "记录不存在");

    status = result[historyId].status;
    failCode = result[historyId].fail_code;
    item_list = result[historyId].item_list || [];

    // Do not mistake a placeholder item for a generated image.
    if (classifyImageCompositionSnapshot(status, item_list, 4, {failCode: String(failCode || '')}).terminal) {
      logger.info(`文生图完成: 状态=${status}, 已生成 ${item_list.length} 张图片`);
      break;
    }

    // 记录详细状态
    if (pollCount % 60 === 0) {
      logger.info(`文生图详细状态: status=${status}, item_list.length=${item_list.length}, failCode=${failCode || 'none'}`);
    }

    // 如果状态是完成但图片数量为0，记录并继续等待
    if (status === 10 && item_list.length === 0 && pollCount % 30 === 0) {
      logger.info(`文生图状态已完成但无图片生成: 状态=${status}, 继续等待...`);
    }
  }

  if (pollCount >= maxPollCount) {
    logger.warn(`文生图超时: 轮询了 ${pollCount} 次，当前状态: ${status}，已生成图片数: ${item_list.length}`);
  }

  if (status === 30 && classifyImageCompositionSnapshot(status, item_list, 4, {failCode: String(failCode || '')}).state !== 'success') {
    if (failCode === '2038')
      throw new APIException(EX.API_CONTENT_FILTERED);
    else
      throw new APIException(EX.API_IMAGE_GENERATION_FAILED);
  }

  const imageUrls = imageCompletionPolicy.evaluate({rawStatus: Number(status), failCode,
    imageUrls: extractImageCompositionUrls(item_list), deadlineReached: true}).imageUrls;

  logger.info(`文生图结果: 成功生成 ${imageUrls.length} 张图片`);
  return imageUrls;
}

export default {
  generateImages,
  generateImageComposition,
};
