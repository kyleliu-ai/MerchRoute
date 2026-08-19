import _ from "lodash";

import APIException from "@/lib/exceptions/APIException.ts";
import EX from "@/api/consts/exceptions.ts";
import util from "@/lib/util.ts";
import { getCredit, receiveCredit, request, parseRegionFromToken, getAssistantId } from "./core.ts";
import logger from "@/lib/logger.ts";
import { getModelConfig } from "@/lib/configs/model-config.ts";
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
export const DEFAULT_MODEL = "jimeng-4.5";
const DRAFT_VERSION = "3.3.4";
const DRAFT_MIN_VERSION = "3.0.2";
function getImageAssistantId(refreshToken: string): number {
  return getAssistantId(parseRegionFromToken(refreshToken));
}

// 支持的图片比例和分辨率配置
const RESOLUTION_OPTIONS: {
  [resolution: string]: {
    [ratio: string]: { width: number; height: number; ratio: number };
  };
} = {
  "1k": {
    "1:1": { width: 1024, height: 1024, ratio: 1 },
    "4:3": { width: 768, height: 1024, ratio: 4 },
    "3:4": { width: 1024, height: 768, ratio: 2 },
    "16:9": { width: 1024, height: 576, ratio: 3 },
    "9:16": { width: 576, height: 1024, ratio: 5 },
    "3:2": { width: 1024, height: 682, ratio: 7 },
    "2:3": { width: 682, height: 1024, ratio: 6 },
    "21:9": { width: 1195, height: 512, ratio: 8 },
  },
  "2k": {
    "1:1": { width: 2048, height: 2048, ratio: 1 },
    "4:3": { width: 2304, height: 1728, ratio: 4 },
    "3:4": { width: 1728, height: 2304, ratio: 2 },
    "16:9": { width: 2560, height: 1440, ratio: 3 },
    "9:16": { width: 1440, height: 2560, ratio: 5 },
    "3:2": { width: 2496, height: 1664, ratio: 7 },
    "2:3": { width: 1664, height: 2496, ratio: 6 },
    "21:9": { width: 3024, height: 1296, ratio: 8 },
  },
  "4k": {
    "1:1": { width: 4096, height: 4096, ratio: 101 },
    "4:3": { width: 4608, height: 3456, ratio: 104 },
    "3:4": { width: 3456, height: 4608, ratio: 102 },
    "16:9": { width: 5120, height: 2880, ratio: 103 },
    "9:16": { width: 2880, height: 5120, ratio: 105 },
    "3:2": { width: 4992, height: 3328, ratio: 107 },
    "2:3": { width: 3328, height: 4992, ratio: 106 },
    "21:9": { width: 6048, height: 2592, ratio: 108 },
  },
};

// 解析分辨率参数
function resolveResolution(
  resolution: string = "2k",
  ratio: string = "1:1"
): { width: number; height: number; imageRatio: number; resolutionType: string } {
  const resolutionGroup = RESOLUTION_OPTIONS[resolution];
  if (!resolutionGroup) {
    const supportedResolutions = Object.keys(RESOLUTION_OPTIONS).join(", ");
    throw new Error(`不支持的分辨率 "${resolution}"。支持的分辨率: ${supportedResolutions}`);
  }

  const ratioConfig = resolutionGroup[ratio];
  if (!ratioConfig) {
    const supportedRatios = Object.keys(resolutionGroup).join(", ");
    throw new Error(`在 "${resolution}" 分辨率下，不支持的比例 "${ratio}"。支持的比例: ${supportedRatios}`);
  }

  return {
    width: ratioConfig.width,
    height: ratioConfig.height,
    imageRatio: ratioConfig.ratio,
    resolutionType: resolution,
  };
}

// 模型特定的版本配置
const MODEL_DRAFT_VERSIONS: { [key: string]: string } = {
  "jimeng-5.0": "3.3.9",
  "jimeng-4.6": "3.3.9",
  "jimeng-4.5": "3.3.4",
  "jimeng-4.1": "3.3.4",
  "jimeng-4.0": "3.3.4",
  "jimeng-3.1": "3.0.2",
  "jimeng-3.0": "3.0.2",
  "jimeng-2.1": "3.0.2",
  "jimeng-2.0-pro": "3.0.2",
  "jimeng-2.0": "3.0.2",
  "jimeng-1.4": "3.0.2",
  "jimeng-xl-pro": "3.0.2",
};

// 获取模型对应的draft版本
function getDraftVersion(model: string): string {
  try {
    const config = getModelConfig(model);
    return config.draftVersion;
  } catch (e) {
    // 如果配置中没有，使用旧的映射
    return MODEL_DRAFT_VERSIONS[model] || DRAFT_VERSION;
  }
}
const MODEL_MAP = {
  "jimeng-5.0": "high_aes_general_v50",
  "jimeng-4.6": "high_aes_general_v42",
  "jimeng-4.5": "high_aes_general_v40l",
  "jimeng-4.1": "high_aes_general_v41",
  "jimeng-4.0": "high_aes_general_v40",
  "jimeng-3.1": "high_aes_general_v30l_art_fangzhou:general_v3.0_18b",
  "jimeng-3.0": "high_aes_general_v30l:general_v3.0_18b",
  "jimeng-2.1": "high_aes_general_v21_L:general_v2.1_L",
  "jimeng-2.0-pro": "high_aes_general_v20_L:general_v2.0_L",
  "jimeng-2.0": "high_aes_general_v20:general_v2.0",
  "jimeng-1.4": "high_aes_general_v14:general_v1.4",
  "jimeng-xl-pro": "text2img_xl_sft",
};

// 向后兼容的函数
export function getModel(model: string) {
  try {
    const config = getModelConfig(model);
    return config.internalModel;
  } catch (e) {
    // 如果配置中没有，使用旧的映射
    return MODEL_MAP[model] || MODEL_MAP[DEFAULT_MODEL];
  }
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

  const model = getModel(_model);
  const imageCount = uploadedImageIds.length;
  const { width, height, imageRatio, resolutionType } = resolveResolution(resolution, ratio);
  const { totalCredit } = await getCredit(refreshToken);
  if (totalCredit <= 0) await receiveCredit(refreshToken);
  const assistantId = getImageAssistantId(refreshToken);
  const componentId = util.uuid();
  const requestedSubmitId = String(options.remoteSubmitId || "").trim();
  if (requestedSubmitId && !/^[A-Za-z0-9:_-]{8,128}$/.test(requestedSubmitId)) {
    throw new APIException(EX.API_REQUEST_PARAMS_INVALID, "remoteSubmitId 格式无效");
  }
  const submitId = requestedSubmitId || util.uuid();
  const sceneOption = {
    type: "image",
    scene: "ImageBasicGenerate",
    modelReqKey: _model,
    resolutionType,
    abilityList: uploadedImageIds.map(() => ({
      abilityName: "byte_edit",
      strength: sampleStrength,
      source: { imageUrl: `blob:https://jimeng.jianying.com/${util.uuid()}` },
    })),
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
      onBeforeRemoteSubmit: options.onBeforeRemoteSubmit,
      data: {
        extend: { root_model: model },
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
          min_version: "3.2.9",
          min_features: [],
          is_from_tsn: true,
          version: "3.2.9",
          main_component_id: componentId,
          component_list: [{
            type: "image_base_component",
            id: componentId,
            min_version: "3.0.2",
            min_features: [],
            aigc_mode: "workbench",
            metadata: {
              type: "",
              id: util.uuid(),
              created_platform: 3,
              created_platform_version: "",
              created_time_in_ms: Date.now().toString(),
              created_did: "",
            },
            generate_type: "blend",
            abilities: {
              type: "",
              id: util.uuid(),
              blend: {
                type: "",
                id: util.uuid(),
                min_version: "3.2.9",
                min_features: [],
                core_param: {
                  type: "",
                  id: util.uuid(),
                  model,
                  prompt: `${"#".repeat(imageCount * 2)}${prompt}`,
                  sample_strength: sampleStrength,
                  image_ratio: imageRatio,
                  large_image_info: {
                    type: "",
                    id: util.uuid(),
                    height,
                    width,
                    resolution_type: resolutionType,
                  },
                  intelligent_ratio: intelligentRatio,
                },
                ability_list: uploadedImageIds.map((imageId) => ({
                  type: "",
                  id: util.uuid(),
                  name: "byte_edit",
                  image_uri_list: [imageId],
                  image_list: [{
                    type: "image",
                    id: util.uuid(),
                    source_from: "upload",
                    platform_type: 1,
                    name: "",
                    image_uri: imageId,
                    width: 0,
                    height: 0,
                    format: "",
                    uri: imageId,
                  }],
                  strength: sampleStrength,
                })),
                prompt_placeholder_info_list: uploadedImageIds.map((_, index) => ({
                  type: "",
                  id: util.uuid(),
                  ability_index: index,
                })),
                postedit_param: { type: "", id: util.uuid(), generate_type: 0 },
              },
            },
          }],
        }),
        http_common_info: { aid: assistantId },
      },
    } as any
  );

  const historyId = aigc_data?.history_record_id;
  if (!historyId) {
    throw new APIException(EX.API_IMAGE_GENERATION_FAILED, "记录ID不存在");
  }
  logger.info(`异步图生图任务已提交，history_id: ${historyId}`);
  return { historyId: String(historyId), status: "processing" };
}

export async function queryImageCompositionTask(
  historyId: string,
  refreshToken: string
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
  const snapshot = classifyImageCompositionSnapshot(rawStatus, record.item_list || []);
  return {
    historyId,
    status: snapshot.state,
    rawStatus: snapshot.rawStatus,
    failCode,
    count: snapshot.count,
    imageUrls: snapshot.imageUrls,
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
  const model = getModel(_model);
  const draftVersion = getDraftVersion(_model);
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

  const componentId = util.uuid();
  const submitId = util.uuid();

  // 构建图生图的 sceneOptions（不包含 benefitCount 以避免扣积分）
  // 注意：sceneOptions 需要是对象，在 metrics_extra 中会被 JSON.stringify
  const sceneOption = {
    type: "image",
    scene: "ImageBasicGenerate",
    modelReqKey: _model,
    resolutionType,
    abilityList: uploadedImageIds.map(() => ({
      abilityName: "byte_edit",
      strength: sampleStrength,
      source: {
        imageUrl: `blob:https://jimeng.jianying.com/${util.uuid()}`
      }
    })),
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
          isRegenerate: false
        }),
        draft_content: JSON.stringify({
          type: "draft",
          id: util.uuid(),
          min_version: "3.2.9",
          min_features: [],
          is_from_tsn: true,
          version: "3.2.9",
          main_component_id: componentId,
          component_list: [
            {
              type: "image_base_component",
              id: componentId,
              min_version: "3.0.2",
              aigc_mode: "workbench",
              metadata: {
                type: "",
                id: util.uuid(),
                created_platform: 3,
                created_platform_version: "",
                created_time_in_ms: Date.now().toString(),
                created_did: "",
              },
              generate_type: "blend",
              abilities: {
                type: "",
                id: util.uuid(),
                blend: {
                  type: "",
                  id: util.uuid(),
                  min_version: "3.2.9",
                  min_features: [],
                  core_param: {
                    type: "",
                    id: util.uuid(),
                    model,
                    prompt: `${'#'.repeat(imageCount * 2)}${prompt}`,
                    sample_strength: sampleStrength,
                    image_ratio: imageRatio,
                    large_image_info: {
                      type: "",
                      id: util.uuid(),
                      height,
                      width,
                      resolution_type: resolutionType
                    },
                    intelligent_ratio: intelligentRatio,
                  },
                  ability_list: uploadedImageIds.map((imageId) => ({
                    type: "",
                    id: util.uuid(),
                    name: "byte_edit",
                    image_uri_list: [imageId],
                    image_list: [{
                      type: "image",
                      id: util.uuid(),
                      source_from: "upload",
                      platform_type: 1,
                      name: "",
                      image_uri: imageId,
                      width: 0,
                      height: 0,
                      format: "",
                      uri: imageId
                    }],
                    strength: 0.5
                  })),
                  prompt_placeholder_info_list: uploadedImageIds.map((_, index) => ({
                    type: "",
                    id: util.uuid(),
                    ability_index: index
                  })),
                  postedit_param: {
                    type: "",
                    id: util.uuid(),
                    generate_type: 0
                  }
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
    const snapshot = classifyImageCompositionSnapshot(status, item_list);
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

  const uniqueUrls = extractImageCompositionUrls(item_list);
  logger.info(
    `图生图终态: historyId=${historyId}, rawStatus=${status}, ` +
    `有效图片数=${uniqueUrls.length}, reason=${terminalReason}, ` +
    `pollCount=${pollCount}, historyQueryRetries=${totalHistoryQueryRetries}, ` +
    `elapsedMs=${Date.now() - pollingStartedAt}`
  );

  if (status === 30) {
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

    // 检查是否已生成足够的图片
    if (item_list.length >= targetImageCount) {
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

  if (status === 30) {
    if (failCode === '2038')
      throw new APIException(EX.API_CONTENT_FILTERED);
    else
      throw new APIException(EX.API_IMAGE_GENERATION_FAILED, `生成失败，错误代码: ${failCode}`);
  }

  const imageUrls = item_list.map((item) => {
    const largeImages = item?.image?.large_images || [];
    if (largeImages.length === 0)
      return [item?.common_attr?.cover_url || null];
    return largeImages.map((img) => img.image_url);
  }).filter(url => url !== null);

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

    // 检查是否已生成图片
    if (item_list.length > 0) {
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

  if (status === 30) {
    if (failCode === '2038')
      throw new APIException(EX.API_CONTENT_FILTERED);
    else
      throw new APIException(EX.API_IMAGE_GENERATION_FAILED);
  }

  const imageUrls = item_list.map((item) => {
    const largeImages = item?.image?.large_images || [];
    if (largeImages.length === 0)
      return [item?.common_attr?.cover_url || null];
    return largeImages.map((img) => img.image_url);
  }).filter(url => url !== null);

  logger.info(`文生图结果: 成功生成 ${imageUrls.length} 张图片`);
  return imageUrls;
}

export default {
  generateImages,
  generateImageComposition,
};
