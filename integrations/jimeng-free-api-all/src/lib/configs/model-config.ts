/**
 * 模型配置文件
 * 定义不同模型的特定参数和配置
 */

export interface ModelConfig {
  // 模型内部名称
  internalModel: string;
  // draft版本
  draftVersion: string;
  // 支持的功能
  features: {
    // 是否支持多图生成
    multiImage: boolean;
    // 是否支持图生图
    imageToImage: boolean;
    // 是否支持视频生成
    videoGeneration: boolean;
  };
  // 默认参数
  defaultParams: {
    // 默认宽度
    width: number;
    // 默认高度
    height: number;
    // 支持的分辨率列表
    resolutions: Array<{ width: number; height: number }>;
    // 采样强度范围
    sampleStrengthRange: [number, number];
  };
  // 特殊配置
  specialConfig?: {
    // 是否需要特定的头部信息
    specialHeaders?: Record<string, string>;
    // 是否有特殊的参数要求
    extraParams?: Record<string, any>;
  };
}

// 模型配置映射
export const MODEL_CONFIGS: Record<string, ModelConfig> = {
  "jimeng-5.0": {
    internalModel: "high_aes_general_v50",
    draftVersion: "3.3.9",
    features: {
      multiImage: true,
      imageToImage: true,
      videoGeneration: false,
    },
    defaultParams: {
      width: 2048,
      height: 2048,
      resolutions: [
        { width: 1024, height: 1024 },
        { width: 768, height: 1024 },
        { width: 1024, height: 768 },
        { width: 1024, height: 576 },
        { width: 576, height: 1024 },
        { width: 1024, height: 682 },
        { width: 682, height: 1024 },
        { width: 1195, height: 512 },
        { width: 2048, height: 2048 },
        { width: 2304, height: 1728 },
        { width: 1728, height: 2304 },
        { width: 2560, height: 1440 },
        { width: 1440, height: 2560 },
        { width: 2496, height: 1664 },
        { width: 1664, height: 2496 },
        { width: 3024, height: 1296 },
      ],
      sampleStrengthRange: [0.1, 1.0],
    },
  },
  "jimeng-4.6": {
    internalModel: "high_aes_general_v42",
    draftVersion: "3.3.9",
    features: {
      multiImage: true,
      imageToImage: true,
      videoGeneration: false,
    },
    defaultParams: {
      width: 2048,
      height: 2048,
      resolutions: [
        { width: 1024, height: 1024 },
        { width: 768, height: 1024 },
        { width: 1024, height: 768 },
        { width: 1024, height: 576 },
        { width: 576, height: 1024 },
        { width: 1024, height: 682 },
        { width: 682, height: 1024 },
        { width: 1195, height: 512 },
        { width: 2048, height: 2048 },
        { width: 2304, height: 1728 },
        { width: 1728, height: 2304 },
        { width: 2560, height: 1440 },
        { width: 1440, height: 2560 },
        { width: 2496, height: 1664 },
        { width: 1664, height: 2496 },
        { width: 3024, height: 1296 },
      ],
      sampleStrengthRange: [0.1, 1.0],
    },
  },
  "jimeng-video-3.5-pro": {
    internalModel: "dreamina_ic_generate_video_model_vgfm_3.5_pro",
    draftVersion: "3.3.4",
    features: {
      multiImage: false,
      imageToImage: true,
      videoGeneration: true,
    },
    defaultParams: {
      width: 1280,
      height: 720,
      resolutions: [
        { width: 1280, height: 720 },
        { width: 720, height: 1280 },
        { width: 1080, height: 1080 },
        { width: 1920, height: 1080 },
        { width: 1080, height: 1920 },
      ],
      sampleStrengthRange: [0.1, 1.0],
    },
  },
  "jimeng-4.5": {
    internalModel: "high_aes_general_v40l",
    draftVersion: "3.3.4",
    features: {
      multiImage: true,
      imageToImage: true,
      videoGeneration: false,
    },
    defaultParams: {
      width: 2048,
      height: 2048,
      resolutions: [
        { width: 1024, height: 1024 },
        { width: 768, height: 1024 },
        { width: 1024, height: 768 },
        { width: 1024, height: 576 },
        { width: 576, height: 1024 },
        { width: 1024, height: 682 },
        { width: 682, height: 1024 },
        { width: 1195, height: 512 },
        { width: 2048, height: 2048 },
        { width: 2304, height: 1728 },
        { width: 1728, height: 2304 },
        { width: 2560, height: 1440 },
        { width: 1440, height: 2560 },
        { width: 2496, height: 1664 },
        { width: 1664, height: 2496 },
        { width: 3024, height: 1296 },
      ],
      sampleStrengthRange: [0.1, 1.0],
    },
  },
  "jimeng-4.1": {
    internalModel: "high_aes_general_v41",
    draftVersion: "3.3.4",
    features: {
      multiImage: true,
      imageToImage: true,
      videoGeneration: false,
    },
    defaultParams: {
      width: 2048,
      height: 2048,
      resolutions: [
        { width: 1024, height: 1024 },
        { width: 768, height: 1024 },
        { width: 1024, height: 768 },
        { width: 1024, height: 576 },
        { width: 576, height: 1024 },
        { width: 1024, height: 682 },
        { width: 682, height: 1024 },
        { width: 1195, height: 512 },
        { width: 2048, height: 2048 },
        { width: 2304, height: 1728 },
        { width: 1728, height: 2304 },
        { width: 2560, height: 1440 },
        { width: 1440, height: 2560 },
        { width: 2496, height: 1664 },
        { width: 1664, height: 2496 },
        { width: 3024, height: 1296 },
      ],
      sampleStrengthRange: [0.1, 1.0],
    },
  },
  "jimeng-4.0": {
    internalModel: "high_aes_general_v40",
    draftVersion: "3.3.4",
    features: {
      multiImage: true,
      imageToImage: true,
      videoGeneration: false,
    },
    defaultParams: {
      width: 2048,
      height: 2048,
      resolutions: [
        { width: 1024, height: 1024 },
        { width: 768, height: 1024 },
        { width: 1024, height: 768 },
        { width: 1024, height: 576 },
        { width: 576, height: 1024 },
        { width: 1024, height: 682 },
        { width: 682, height: 1024 },
        { width: 1195, height: 512 },
        { width: 2048, height: 2048 },
        { width: 2304, height: 1728 },
        { width: 1728, height: 2304 },
        { width: 2560, height: 1440 },
        { width: 1440, height: 2560 },
        { width: 2496, height: 1664 },
        { width: 1664, height: 2496 },
        { width: 3024, height: 1296 },
      ],
      sampleStrengthRange: [0.1, 1.0],
    },
  },
  "jimeng-3.1": {
    internalModel: "high_aes_general_v30l_art_fangzhou:general_v3.0_18b",
    draftVersion: "3.0.2",
    features: {
      multiImage: false,
      imageToImage: true,
      videoGeneration: false,
    },
    defaultParams: {
      width: 1024,
      height: 1024,
      resolutions: [
        { width: 512, height: 512 },
        { width: 768, height: 768 },
        { width: 1024, height: 1024 },
      ],
      sampleStrengthRange: [0.1, 0.8],
    },
  },
  "jimeng-3.0": {
    internalModel: "high_aes_general_v30l:general_v3.0_18b",
    draftVersion: "3.0.2",
    features: {
      multiImage: false,
      imageToImage: true,
      videoGeneration: false,
    },
    defaultParams: {
      width: 1024,
      height: 1024,
      resolutions: [
        { width: 512, height: 512 },
        { width: 768, height: 768 },
        { width: 1024, height: 1024 },
      ],
      sampleStrengthRange: [0.1, 0.8],
    },
  },
  "jimeng-2.1": {
    internalModel: "high_aes_general_v21_L:general_v2.1_L",
    draftVersion: "3.0.2",
    features: {
      multiImage: false,
      imageToImage: true,
      videoGeneration: false,
    },
    defaultParams: {
      width: 512,
      height: 512,
      resolutions: [
        { width: 512, height: 512 },
        { width: 768, height: 768 },
      ],
      sampleStrengthRange: [0.1, 0.7],
    },
  },
  "jimeng-2.0-pro": {
    internalModel: "high_aes_general_v20_L:general_v2.0_L",
    draftVersion: "3.0.2",
    features: {
      multiImage: false,
      imageToImage: true,
      videoGeneration: false,
    },
    defaultParams: {
      width: 512,
      height: 512,
      resolutions: [
        { width: 512, height: 512 },
        { width: 768, height: 768 },
      ],
      sampleStrengthRange: [0.1, 0.7],
    },
  },
  "jimeng-2.0": {
    internalModel: "high_aes_general_v20",
    draftVersion: "3.0.2",
    features: {
      multiImage: false,
      imageToImage: true,
      videoGeneration: false,
    },
    defaultParams: {
      width: 512,
      height: 512,
      resolutions: [
        { width: 512, height: 512 },
        { width: 768, height: 768 },
      ],
      sampleStrengthRange: [0.1, 0.7],
    },
  },
  "jimeng-1.4": {
    internalModel: "high_aes_general_v14:general_v1.4",
    draftVersion: "3.0.2",
    features: {
      multiImage: false,
      imageToImage: true,
      videoGeneration: false,
    },
    defaultParams: {
      width: 512,
      height: 512,
      resolutions: [
        { width: 512, height: 512 },
        { width: 768, height: 768 },
      ],
      sampleStrengthRange: [0.1, 0.6],
    },
  },
  "jimeng-xl-pro": {
    internalModel: "text2img_xl_sft",
    draftVersion: "3.0.2",
    features: {
      multiImage: false,
      imageToImage: true,
      videoGeneration: false,
    },
    defaultParams: {
      width: 1024,
      height: 1024,
      resolutions: [
        { width: 1024, height: 1024 },
        { width: 1280, height: 720 },
        { width: 720, height: 1280 },
      ],
      sampleStrengthRange: [0.1, 0.8],
    },
  },
};

// 获取模型配置
export function getModelConfig(modelName: string): ModelConfig {
  const config = MODEL_CONFIGS[modelName];
  if (!config) {
    throw new Error(`Unsupported model: ${modelName}`);
  }
  return config;
}

// 获取所有支持的图像生成模型
export function getSupportedImageModels(): string[] {
  return Object.keys(MODEL_CONFIGS);
}

// 检查模型是否支持特定功能
export function doesModelSupport(modelName: string, feature: keyof ModelConfig['features']): boolean {
  const config = getModelConfig(modelName);
  return config.features[feature];
}

// 验证参数是否在模型支持的范围内
export function validateModelParams(modelName: string, params: {
  width?: number;
  height?: number;
  sampleStrength?: number;
}): { isValid: boolean; errors: string[] } {
  const config = getModelConfig(modelName);
  const errors: string[] = [];

  // 验证分辨率
  if (params.width && params.height) {
    const isValidResolution = config.defaultParams.resolutions.some(
      res => res.width === params.width && res.height === params.height
    );
    if (!isValidResolution) {
      errors.push(
        `Unsupported resolution ${params.width}x${params.height}. Supported resolutions: ${config.defaultParams.resolutions.map(r => `${r.width}x${r.height}`).join(', ')}`
      );
    }
  }

  // 验证采样强度
  if (params.sampleStrength !== undefined) {
    const [min, max] = config.defaultParams.sampleStrengthRange;
    if (params.sampleStrength < min || params.sampleStrength > max) {
      errors.push(`Sample strength must be between ${min} and ${max}`);
    }
  }

  return {
    isValid: errors.length === 0,
    errors
  };
}
