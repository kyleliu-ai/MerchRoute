import { getModelConfig } from '../../lib/configs/model-config.ts';
import { imageCompletionPolicy } from './image-completion-policy.mjs';

export const DEFAULT_IMAGE_MODEL = 'jimeng-4.5';
export type ImageOperation = 'generation' | 'composition';
// Business target is independent of the upstream protocol's native count.
export function imageCompositionOutputCount(_model: unknown): number {
  return imageCompletionPolicy.targetImageCount;
}
export class ImageModelError extends Error {
  constructor(public readonly code: string, message: string) { super(message); this.name = 'ImageModelError'; }
}
export function imageModelErrorResponse(error: unknown) {
  if (!(error instanceof ImageModelError)) return undefined;
  return { ok: false, accepted: false, code: error.code, message: error.message,
    batchStatus: 'rejected', taskCount: 0, submittedCount: 0, tasks: [] };
}
export function resolveImageModel(value?: unknown) {
  const name = value === undefined || value === 'jimeng' ? DEFAULT_IMAGE_MODEL : value;
  if (typeof name !== 'string' || !name.trim()) {
    throw new ImageModelError('unsupported_image_model', '图片模型必须是受支持的非空名称');
  }
  let config;
  try { config = getModelConfig(name); } catch {
    throw new ImageModelError('unsupported_image_model', '不支持该图片模型');
  }
  if (config.features.videoGeneration) throw new ImageModelError('unsupported_image_model', '视频模型不能用于图片请求');
  return { name, config };
}
export function inheritedImageField(task: Record<string, any>, common: Record<string, any>, field: string) {
  return task[field] !== undefined ? task[field] : common[field];
}
export function validateImageRequest(input: {
  model?: unknown; ratio?: unknown; resolution?: unknown; operation: ImageOperation; imageCount?: number;
}) {
  const resolved = resolveImageModel(input.model);
  const ratio = input.ratio === undefined ? '1:1' : input.ratio;
  const resolution = input.resolution === undefined ? '2k' : input.resolution;
  const policy = resolved.config.imagePolicy;
  if ((policy && !policy.operations.includes(input.operation)) ||
      (input.operation === 'composition' && (input.imageCount ?? 0) < 1)) {
    throw new ImageModelError('unsupported_model_operation', '该模型不支持本次操作或缺少参考图');
  }
  if (typeof resolution !== 'string' || typeof ratio !== 'string' ||
      (policy && (!policy.resolutions.includes(resolution) || !policy.ratios.includes(ratio)))) {
    throw new ImageModelError('unsupported_model_resolution', '该模型不支持本次分辨率或比例');
  }
  let size;
  try { size = resolveResolution(resolution, ratio); } catch {
    throw new ImageModelError('unsupported_model_resolution', '不支持本次分辨率或比例');
  }
  return { ...resolved, ...size };
}
export function validateImageBatch(tasks: Record<string, any>[], common: Record<string, any>, imageCount: number) {
  // Validate every task before callers reserve a ledger slot or touch sources.
  for (const task of tasks) {
    if (!task || typeof task !== 'object') continue; // Existing ledger owns structural errors.
    validateImageRequest({
      model: inheritedImageField(task, common, 'model'),
      ratio: inheritedImageField(task, common, 'ratio'),
      resolution: inheritedImageField(task, common, 'resolution'),
      operation: 'composition', imageCount,
    });
  }
}

// 支持的图片比例和分辨率配置
export const RESOLUTION_OPTIONS: {
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
export function resolveResolution(
  resolution: string = "2k",
  ratio: string = "1:1"
): { width: number; height: number; imageRatio: number; resolutionType: string } {
  const resolutionGroup = RESOLUTION_OPTIONS[resolution];
  if (!Object.hasOwn(RESOLUTION_OPTIONS, resolution)) {
    const supportedResolutions = Object.keys(RESOLUTION_OPTIONS).join(", ");
    throw new Error(`不支持的分辨率 "${resolution}"。支持的分辨率: ${supportedResolutions}`);
  }

  const ratioConfig = resolutionGroup[ratio];
  if (!Object.hasOwn(resolutionGroup, ratio)) {
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
