import _ from "lodash";
import crypto from "crypto";
import fs from "fs";
import path from "path";
import { ProxyAgent as UndiciProxyAgent } from "undici";
import { ProxyAgent as UndiciProxyAgent } from "undici";
import APIException from "@/lib/exceptions/APIException.ts";
import EX from "@/api/consts/exceptions.ts";
import util from "@/lib/util.ts";
import { getCredit, receiveCredit, request, DEFAULT_ASSISTANT_ID as CORE_ASSISTANT_ID, WEB_ID, acquireToken, parseRegionFromToken, getAssistantId } from "./core.ts";
import logger from "@/lib/logger.ts";
import browserService from "@/lib/browser-service.ts";
import {
  fetchWithVideoImageUploadTimeout,
  resolveVideoImageUploadTimeoutMs,
  summarizeVideoImageUploadErrorForLog,
  type VideoImageUploadOptions,
} from "../services/video-upload-stage-timeout.ts";
import {
  runGlobalImageGeneration,
  runGlobalImageUploadAttempt,
} from "../services/global-image-operation-gates.ts";

const DEFAULT_ASSISTANT_ID = 513695;
export const DEFAULT_MODEL = "jimeng-video-3.0";
const DEFAULT_DRAFT_VERSION = "3.2.8";

const MODEL_DRAFT_VERSIONS: { [key: string]: string } = {
  "jimeng-video-3.5-pro": "3.3.4",
  "jimeng-video-3.0-pro": "3.2.8",
  "jimeng-video-3.0": "3.2.8",
  // Seedance 模型（与上游 iptag/jimeng-api 保持一致）
  "jimeng-video-seedance-2.0": "3.3.9",
  "seedance-2.0": "3.3.9",
  "seedance-2.0-pro": "3.3.9",
  // Seedance 2.0-fast 模型（v1.9.3 新增）
  "jimeng-video-seedance-2.0-fast": "3.3.9",
  "seedance-2.0-fast": "3.3.9",
  // Seedance 2.0 Fast VIP Vision 模型（文生视频，model_req_key=dreamina_seedance_40_vision）
  "jimeng-video-seedance-2.0-fast-vip": "3.3.12",
  "seedance-2.0-fast-vip": "3.3.12",
  // Seedance 2.0 VIP Vision 模型（主模态能力，model_req_key=dreamina_seedance_40_pro_vision）
  "jimeng-video-seedance-2.0-vip": "3.3.12",
  "seedance-2.0-vip": "3.3.12",
};

const MODEL_MAP = {
  "jimeng-video-3.5-pro": "dreamina_ic_generate_video_model_vgfm_3.5_pro",
  "jimeng-video-3.0-pro": "dreamina_ic_generate_video_model_vgfm_3.0_pro",
  "jimeng-video-3.0": "dreamina_ic_generate_video_model_vgfm_3.0_fast",
  // Seedance 多图智能视频生成模型（jimeng-video-seedance-2.0 为上游标准名称）
  "jimeng-video-seedance-2.0": "dreamina_seedance_40_pro",
  "seedance-2.0": "dreamina_seedance_40_pro",
  "seedance-2.0-pro": "dreamina_seedance_40_pro",
  // Seedance 2.0-fast 快速生成模型（v1.9.3 新增，内部模型为 dreamina_seedance_40）
  "jimeng-video-seedance-2.0-fast": "dreamina_seedance_40",
  "seedance-2.0-fast": "dreamina_seedance_40",
  // Seedance 2.0 Fast VIP Vision 文生视频模型（内部模型为 dreamina_seedance_40_vision）
  "jimeng-video-seedance-2.0-fast-vip": "dreamina_seedance_40_vision",
  "seedance-2.0-fast-vip": "dreamina_seedance_40_vision",
  // Seedance 2.0 VIP Vision 文生视频模型（内部模型为 dreamina_seedance_40_pro_vision）
  "jimeng-video-seedance-2.0-vip": "dreamina_seedance_40_pro_vision",
  "seedance-2.0-vip": "dreamina_seedance_40_pro_vision",
};

// Seedance 模型的 benefit_type 映射
const SEEDANCE_BENEFIT_TYPE_MAP: { [key: string]: string } = {
  "jimeng-video-seedance-2.0": "dreamina_video_seedance_20_pro",
  "seedance-2.0": "dreamina_video_seedance_20_pro",
  "seedance-2.0-pro": "dreamina_video_seedance_20_pro",
  // Seedance 2.0-fast（v1.9.3 新增，注意：无 "video_" 前缀）
  "jimeng-video-seedance-2.0-fast": "dreamina_seedance_20_fast",
  "seedance-2.0-fast": "dreamina_seedance_20_fast",
  // Seedance 2.0 Fast VIP Vision（benefit_type 与国际版一致：seedance_20_fast_720p_output）
  "jimeng-video-seedance-2.0-fast-vip": "seedance_20_fast_720p_output",
  "seedance-2.0-fast-vip": "seedance_20_fast_720p_output",
  // Seedance 2.0 VIP Vision（主模态能力，benefit_type：seedance_20_pro_720p_output）
  "jimeng-video-seedance-2.0-vip": "seedance_20_pro_720p_output",
  "seedance-2.0-vip": "seedance_20_pro_720p_output",
};

const INTERNATIONAL_VIDEO_MODEL_MAP: Record<string, string> = {
  "jimeng-video-3.5-pro": "dreamina_ic_generate_video_model_vgfm_3.5_pro",
  "jimeng-video-3.0-pro": "dreamina_ic_generate_video_model_vgfm_3.0_pro",
  "jimeng-video-3.0": "dreamina_ic_generate_video_model_vgfm_3.0",
};

const INTERNATIONAL_SEEDANCE_MODEL_MAP: Record<string, string> = {
  "jimeng-video-seedance-2.0": "dreamina_seedance_40_pro",
  "seedance-2.0-pro": "dreamina_seedance_40_pro",
  "jimeng-video-seedance-2.0-fast": "dreamina_seedance_40",
  "seedance-2.0-fast": "dreamina_seedance_40",
  "jimeng-video-seedance-2.0-fast-vip": "dreamina_seedance_40_vision",
  "seedance-2.0-fast-vip": "dreamina_seedance_40_vision",
  "jimeng-video-seedance-2.0-vip": "dreamina_seedance_40_pro_vision",
  "seedance-2.0-vip": "dreamina_seedance_40_pro_vision",
};

const INTERNATIONAL_SEEDANCE_BENEFIT_TYPE_MAP: Record<string, string> = {
  "jimeng-video-seedance-2.0": "seedance_20_pro_720p_output",
  "seedance-2.0-pro": "seedance_20_pro_720p_output",
  "jimeng-video-seedance-2.0-fast": "seedance_20_fast_720p_output",
  "seedance-2.0-fast": "seedance_20_fast_720p_output",
  "jimeng-video-seedance-2.0-fast-vip": "seedance_20_fast_720p_output",
  "seedance-2.0-fast-vip": "seedance_20_fast_720p_output",
  "jimeng-video-seedance-2.0-vip": "seedance_20_pro_720p_output",
  "seedance-2.0-vip": "seedance_20_pro_720p_output",
};

function getVideoBenefitType(model: string): string {
  if (model.includes("3.5_pro")) {
    return "dreamina_video_seedance_15_pro";
  }
  if (model.includes("3.5")) {
    return "dreamina_video_seedance_15";
  }
  return "basic_video_operation_vgfm_v_three";
}

function getInternationalVideoDraftVersion(_model: string): string {
  if (Object.prototype.hasOwnProperty.call(INTERNATIONAL_VIDEO_MODEL_MAP, _model)) {
    return "3.3.12";
  }
  return MODEL_DRAFT_VERSIONS[_model] || DEFAULT_DRAFT_VERSION;
}

// 判断是否为 Seedance 模型
export function isSeedanceModel(model: string): boolean {
  return model.startsWith("seedance-") || model.startsWith("jimeng-video-seedance-");
}

export function isInternationalVideoModel(model: string): boolean {
  return Object.prototype.hasOwnProperty.call(INTERNATIONAL_VIDEO_MODEL_MAP, model)
    || Object.prototype.hasOwnProperty.call(INTERNATIONAL_SEEDANCE_MODEL_MAP, model);
}

function getInternationalVideoModel(model: string): string {
  return INTERNATIONAL_VIDEO_MODEL_MAP[model] || INTERNATIONAL_SEEDANCE_MODEL_MAP[model];
}

export function isInternationalSeedanceModel(model: string): boolean {
  return Object.prototype.hasOwnProperty.call(INTERNATIONAL_SEEDANCE_MODEL_MAP, model);
}

// ========== Seedance 多类型素材支持 ==========

// 素材类型
type SeedanceMaterialType = "image" | "video" | "audio";

// 上传结果统一接口
interface UploadedMaterial {
  type: SeedanceMaterialType;
  // 图片
  uri?: string;
  // 视频/音频（VOD）
  vid?: string;
  // 通用
  width?: number;
  height?: number;
  duration?: number;
  fps?: number;
  name?: string;
}

// MIME 类型 → 素材类型映射
const MIME_TO_MATERIAL_TYPE: Record<string, SeedanceMaterialType> = {
  "image/jpeg": "image", "image/png": "image", "image/webp": "image",
  "image/gif": "image", "image/bmp": "image",
  "video/mp4": "video", "video/quicktime": "video", "video/x-m4v": "video",
  "audio/mpeg": "audio", "audio/wav": "audio", "audio/x-wav": "audio",
  "audio/mp3": "audio",
};

// 扩展名 → 素材类型映射（兜底）
const EXT_TO_MATERIAL_TYPE: Record<string, SeedanceMaterialType> = {
  ".jpg": "image", ".jpeg": "image", ".png": "image", ".webp": "image",
  ".gif": "image", ".bmp": "image",
  ".mp4": "video", ".mov": "video", ".m4v": "video",
  ".mp3": "audio", ".wav": "audio",
};

// materialTypes 编码映射
const MATERIAL_TYPE_CODE: Record<SeedanceMaterialType, number> = {
  image: 1, video: 2, audio: 3,
};

/**
 * 检测上传文件的素材类型
 * 优先通过 MIME 类型判断，兜底通过文件扩展名
 */
function detectMaterialType(file: any): SeedanceMaterialType {
  // 优先通过 MIME 类型判断
  const mime = (file.mimetype || file.mimeType || "").toLowerCase();
  if (mime && MIME_TO_MATERIAL_TYPE[mime]) return MIME_TO_MATERIAL_TYPE[mime];
  // 兜底：通过文件扩展名判断
  const filename = (file.originalFilename || file.newFilename || "").toLowerCase();
  const dotIdx = filename.lastIndexOf(".");
  if (dotIdx >= 0) {
    const ext = filename.substring(dotIdx);
    if (EXT_TO_MATERIAL_TYPE[ext]) return EXT_TO_MATERIAL_TYPE[ext];
  }
  // 默认视为图片（向后兼容）
  return "image";
}

/**
 * 从 URL 检测素材类型
 * 通过 URL 路径的扩展名判断
 */
function detectMaterialTypeFromUrl(url: string): SeedanceMaterialType {
  try {
    const pathname = new URL(url).pathname.toLowerCase();
    const dotIdx = pathname.lastIndexOf(".");
    if (dotIdx >= 0) {
      const ext = pathname.substring(dotIdx);
      if (EXT_TO_MATERIAL_TYPE[ext]) return EXT_TO_MATERIAL_TYPE[ext];
    }
  } catch {}
  // 默认视为图片（向后兼容）
  return "image";
}

// 视频支持的分辨率和比例配置
const VIDEO_RESOLUTION_OPTIONS: {
  [resolution: string]: {
    [ratio: string]: { width: number; height: number };
  };
} = {
  "480p": {
    "1:1": { width: 480, height: 480 },
    "4:3": { width: 640, height: 480 },
    "3:4": { width: 480, height: 640 },
    "16:9": { width: 854, height: 480 },
    "9:16": { width: 480, height: 854 },
  },
  "720p": {
    "1:1": { width: 720, height: 720 },
    "4:3": { width: 960, height: 720 },
    "3:4": { width: 720, height: 960 },
    "16:9": { width: 1280, height: 720 },
    "9:16": { width: 720, height: 1280 },
  },
  "1080p": {
    "1:1": { width: 1080, height: 1080 },
    "4:3": { width: 1440, height: 1080 },
    "3:4": { width: 1080, height: 1440 },
    "16:9": { width: 1920, height: 1080 },
    "9:16": { width: 1080, height: 1920 },
  },
};

// 解析视频分辨率参数
function resolveVideoResolution(
  resolution: string = "720p",
  ratio: string = "1:1"
): { width: number; height: number } {
  const resolutionGroup = VIDEO_RESOLUTION_OPTIONS[resolution];
  if (!resolutionGroup) {
    const supportedResolutions = Object.keys(VIDEO_RESOLUTION_OPTIONS).join(", ");
    throw new Error(`不支持的视频分辨率 "${resolution}"。支持的分辨率: ${supportedResolutions}`);
  }

  const ratioConfig = resolutionGroup[ratio];
  if (!ratioConfig) {
    const supportedRatios = Object.keys(resolutionGroup).join(", ");
    throw new Error(`在 "${resolution}" 分辨率下，不支持的比例 "${ratio}"。支持的比例: ${supportedRatios}`);
  }

  return {
    width: ratioConfig.width,
    height: ratioConfig.height,
  };
}

export function getModel(model: string) {
  return MODEL_MAP[model] || MODEL_MAP[DEFAULT_MODEL];
}

// ========== 区域感知的上传配置 ==========

// 国际区域（非 US）使用的 ImageX 上传地址
const BASE_URL_IMAGEX_SG = "https://imagex-normal-sg.capcutapi.com";
// US 区域使用的 ImageX 上传地址
const BASE_URL_IMAGEX_US = "https://imagex16-normal-us-ttp.capcutapi.us";

function getUploadAWSRegion(regionInfo: import("./core.ts").RegionInfo): string {
  if (regionInfo.isUS) return "us-east-1";
  // 所有非 US 的国际地区统一使用新加坡的 ap-southeast-1
  if (regionInfo.isInternational) return "ap-southeast-1";
  return "cn-north-1";
}

function getImageXHost(regionInfo: import("./core.ts").RegionInfo): string {
  if (regionInfo.isCN) return "https://imagex.bytedanceapi.com";
  if (regionInfo.isUS) return BASE_URL_IMAGEX_US;
  // 所有非 US 的国际地区统一使用新加坡服务器
  return BASE_URL_IMAGEX_SG;
}

function getUploadOrigin(regionInfo: import("./core.ts").RegionInfo): string {
  if (regionInfo.isUS) return "https://dreamina-api.us.capcut.com";
  if (regionInfo.isInternational) return "https://mweb-api-sg.capcut.com";
  return "https://jimeng.jianying.com";
}

function getUploadReferer(regionInfo: import("./core.ts").RegionInfo): string {
  const origin = getUploadOrigin(regionInfo);
  return `${origin}/ai-tool/video/generate`;
}

function resolveServiceId(tokenResult: any, regionInfo: import("./core.ts").RegionInfo): string {
  // 国际版使用 space_name 作为 service_id，CN 版使用 service_id
  const rawServiceId = regionInfo.isInternational ? tokenResult.space_name : tokenResult.service_id;
  if (rawServiceId) return rawServiceId;
  // fallback: 国际版用 wopfjsm1ax，CN 用 tb4s082cfz
  return regionInfo.isInternational ? "wopfjsm1ax" : "tb4s082cfz";
}

// 代理感知的 fetch dispatcher（undici ProxyAgent）
let _proxyDispatcher: any = undefined;
function getProxyDispatcher(): any {
  if (_proxyDispatcher !== undefined) return _proxyDispatcher;
  const proxyUrl = process.env.HTTPS_PROXY || process.env.https_proxy
    || process.env.HTTP_PROXY || process.env.http_proxy
    || process.env.ALL_PROXY || process.env.all_proxy;
  if (proxyUrl) {
    try {
      _proxyDispatcher = new UndiciProxyAgent(proxyUrl);
      logger.info(`上传代理已启用: ${proxyUrl}`);
    } catch (e) {
      logger.warn(`创建代理 dispatcher 失败: ${e.message}`);
      _proxyDispatcher = null;
    }
  } else {
    _proxyDispatcher = null;
  }
  return _proxyDispatcher;
}

/**
 * 代理感知的 fetch 封装
 * 自动为国际区域的上传请求添加代理支持
 */
async function proxyFetch(url: string | Request, init?: RequestInit): Promise<Response> {
  const dispatcher = getProxyDispatcher();
  if (dispatcher && init) {
    (init as any).dispatcher = dispatcher;
  } else if (dispatcher && !init) {
    init = { dispatcher } as any;
  }
  return fetch(url as string, init);
}

/**
 * 国内专用 fetch（不走代理）
 * CN 上传目标（imagex.bytedanceapi.com）不需要代理，走代理反而会失败
 */
async function cnFetch(url: string | Request, init?: RequestInit): Promise<Response> {
  return fetch(url as string, init);
}

/**
 * 区域感知 fetch：国际上传走代理，国内直连
 */
function regionFetch(regionInfo: import("./core.ts").RegionInfo | undefined): (url: string | Request, init?: RequestInit) => Promise<Response> {
  return regionInfo?.isInternational ? proxyFetch : cnFetch;
}

// AWS4-HMAC-SHA256 签名生成函数（从 images.ts 复制）
function createSignature(
  method: string,
  url: string,
  headers: { [key: string]: string },
  accessKeyId: string,
  secretAccessKey: string,
  sessionToken?: string,
  payload: string = '',
  awsRegion: string = 'cn-north-1',
  serviceName: string = 'imagex'
) {
  const urlObj = new URL(url);
  const pathname = urlObj.pathname || '/';
  const search = urlObj.search;

  // 创建规范请求
  const timestamp = headers['x-amz-date'];
  const date = timestamp.substr(0, 8);
  const region = awsRegion;
  const service = serviceName;

  // 规范化查询参数
  const queryParams: Array<[string, string]> = [];
  const searchParams = new URLSearchParams(search);
  searchParams.forEach((value, key) => {
    queryParams.push([key, value]);
  });

  // 按键名排序
  queryParams.sort(([a], [b]) => {
    if (a < b) return -1;
    if (a > b) return 1;
    return 0;
  });

  const canonicalQueryString = queryParams
    .map(([key, value]) => `${key}=${value}`)
    .join('&');

  // 规范化头部
  const headersToSign: { [key: string]: string } = {
    'x-amz-date': timestamp
  };

  if (sessionToken) {
    headersToSign['x-amz-security-token'] = sessionToken;
  }

  let payloadHash = crypto.createHash('sha256').update('').digest('hex');
  if (method.toUpperCase() === 'POST' && payload) {
    payloadHash = crypto.createHash('sha256').update(payload, 'utf8').digest('hex');
    headersToSign['x-amz-content-sha256'] = payloadHash;
  }

  const signedHeaders = Object.keys(headersToSign)
    .map(key => key.toLowerCase())
    .sort()
    .join(';');

  const canonicalHeaders = Object.keys(headersToSign)
    .sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()))
    .map(key => `${key.toLowerCase()}:${headersToSign[key].trim()}\n`)
    .join('');

  const canonicalRequest = [
    method.toUpperCase(),
    pathname,
    canonicalQueryString,
    canonicalHeaders,
    signedHeaders,
    payloadHash
  ].join('\n');

  // 创建待签名字符串
  const credentialScope = `${date}/${region}/${service}/aws4_request`;
  const stringToSign = [
    'AWS4-HMAC-SHA256',
    timestamp,
    credentialScope,
    crypto.createHash('sha256').update(canonicalRequest, 'utf8').digest('hex')
  ].join('\n');

  // 生成签名
  const kDate = crypto.createHmac('sha256', `AWS4${secretAccessKey}`).update(date).digest();
  const kRegion = crypto.createHmac('sha256', kDate).update(region).digest();
  const kService = crypto.createHmac('sha256', kRegion).update(service).digest();
  const kSigning = crypto.createHmac('sha256', kService).update('aws4_request').digest();
  const signature = crypto.createHmac('sha256', kSigning).update(stringToSign, 'utf8').digest('hex');

  return `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
}

// 计算文件的CRC32值（从 images.ts 复制）
function calculateCRC32(buffer: ArrayBuffer): string {
  const crcTable = [];
  for (let i = 0; i < 256; i++) {
    let crc = i;
    for (let j = 0; j < 8; j++) {
      crc = (crc & 1) ? (0xEDB88320 ^ (crc >>> 1)) : (crc >>> 1);
    }
    crcTable[i] = crc;
  }

  let crc = 0 ^ (-1);
  const bytes = new Uint8Array(buffer);
  for (let i = 0; i < bytes.length; i++) {
    crc = (crc >>> 8) ^ crcTable[(crc ^ bytes[i]) & 0xFF];
  }
  return ((crc ^ (-1)) >>> 0).toString(16).padStart(8, '0');
}

// 视频专用图片上传功能（基于 images.ts 的 uploadImageFromUrl）
async function uploadImageForVideo(imageUrl: string, refreshToken: string, regionInfo?: import("./core.ts").RegionInfo): Promise<string> {
  const response = await fetch(imageUrl);
  if (!response.ok) throw Object.assign(new Error(`下载图片失败: HTTP ${response.status}`), {
    stage: "source_image_download",
    status: response.status,
  });
  const buffer = Buffer.from(await response.arrayBuffer());
  return uploadImageBufferForVideo(buffer, refreshToken, regionInfo);
}
// 从Buffer上传视频图片
export async function uploadImageBufferForVideo(buffer: Buffer, refreshToken: string, regionInfo?: import("./core.ts").RegionInfo, uploadOptions: VideoImageUploadOptions = {}): Promise<string> {
  return runGlobalImageUploadAttempt({ token: refreshToken, signal: uploadOptions.signal, work: async () => {
  try {
    logger.info(`开始从Buffer上传视频图片，大小: ${buffer.length}字节`);

    const ri = regionInfo || parseRegionFromToken(refreshToken);
    const rf = regionFetch(ri);
    const awsRegion = getUploadAWSRegion(ri);
    const imageXHost = getImageXHost(ri);
    const uploadOrigin = getUploadOrigin(ri);
    const uploadReferer = getUploadReferer(ri);

    // 第一步：获取上传令牌
    let tokenResult;
    try {
      tokenResult = await request("post", "/mweb/v1/get_upload_token", refreshToken, {
        data: {
          scene: 2,
        },
        signal: uploadOptions.signal,
      });
    } catch (error) {
      // Axios wraps an AbortSignal cancellation. Preserve the caller's
      // fail-closed deadline reason so the coordinator records the exact
      // upload_deadline_exceeded code and never treats it as retryable.
      if (uploadOptions.signal?.aborted) {
        throw uploadOptions.signal.reason || error;
      }
      throw error;
    }

    const { access_key_id, secret_access_key, session_token, service_id, space_name } = tokenResult;
    if (!access_key_id || !secret_access_key || !session_token) {
      throw new Error("获取上传令牌失败");
    }

    const actualServiceId = resolveServiceId(tokenResult, ri);
    logger.info(`获取上传令牌成功: service_id=${actualServiceId}`);

    const fileSize = buffer.length;
    const crc32 = calculateCRC32(buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength));

    logger.info(`Buffer大小: ${fileSize}字节, CRC32=${crc32}`);

    // 第二步：申请图片上传权限
    const now = new Date();
    const timestamp = now.toISOString().replace(/[:\-]/g, '').replace(/\.\d{3}Z$/, 'Z');

    const randomStr = Math.random().toString(36).substring(2, 12);
    const applyUrl = `${imageXHost}/?Action=ApplyImageUpload&Version=2018-08-01&ServiceId=${actualServiceId}&FileSize=${fileSize}&s=${randomStr}${ri.isInternational ? '&device_platform=web' : ''}`;

    const requestHeaders = {
      'x-amz-date': timestamp,
      'x-amz-security-token': session_token
    };

    const authorization = createSignature('GET', applyUrl, requestHeaders, access_key_id, secret_access_key, session_token, '', awsRegion, 'imagex');

    const applyResponse = await fetchWithVideoImageUploadTimeout(
      rf,
      applyUrl,
      {
      method: 'GET',
      headers: {
        'accept': '*/*',
        'accept-language': 'zh-CN,zh;q=0.9',
        'authorization': authorization,
        'origin': uploadOrigin,
        'referer': uploadReferer,
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36',
        'x-amz-date': timestamp,
        'x-amz-security-token': session_token,
      },
        signal: uploadOptions.signal,
      },
      "tos_apply_upload",
      resolveVideoImageUploadTimeoutMs("tos_apply_upload", uploadOptions.attempt, uploadOptions.timeoutProfileMs),
      uploadOptions.attempt,
      (event) => logger.warn(
        `视频图片上传阶段超时: stage=${event.stage}, timeout_ms=${event.timeoutMs}, ` +
        `attempt=${event.attempt}, host=${event.host}`
      )
    );

    if (!applyResponse.ok) {
      await applyResponse.body?.cancel().catch(() => undefined);
      throw Object.assign(new Error(`申请上传权限失败: HTTP ${applyResponse.status}`), {
        stage: "tos_apply_upload",
        status: applyResponse.status,
        statusCode: applyResponse.status,
      });
    }

    const applyResult = await applyResponse.json();

    if (applyResult?.ResponseMetadata?.Error) {
      throw Object.assign(new Error("申请上传权限失败: upstream error"), {
        stage: "tos_apply_upload",
      });
    }

    const uploadAddress = applyResult?.Result?.UploadAddress;
    if (!uploadAddress || !uploadAddress.StoreInfos || !uploadAddress.UploadHosts) {
      throw Object.assign(new Error("申请上传权限失败: missing upload address"), {
        stage: "tos_apply_upload",
      });
    }

    const storeInfo = uploadAddress.StoreInfos[0];
    const uploadHost = uploadAddress.UploadHosts[0];
    const auth = storeInfo.Auth;

    const uploadUrl = `https://${uploadHost}/upload/v1/${storeInfo.StoreUri}`;

    // 第三步：上传图片文件
    const uploadResponse = await fetchWithVideoImageUploadTimeout(
      rf,
      uploadUrl,
      {
      method: 'POST',
      headers: {
        'Accept': '*/*',
        'Authorization': auth,
        'Content-CRC32': crc32,
        'Content-Disposition': 'attachment; filename="undefined"',
        'Content-Type': 'application/octet-stream',
        'Origin': uploadOrigin,
        'Referer': uploadReferer,
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36',
      },
      body: buffer,
        signal: uploadOptions.signal,
      },
      "tos_binary_upload",
      resolveVideoImageUploadTimeoutMs("tos_binary_upload", uploadOptions.attempt, uploadOptions.timeoutProfileMs),
      uploadOptions.attempt,
      (event) => logger.warn(
        `视频图片上传阶段超时: stage=${event.stage}, timeout_ms=${event.timeoutMs}, ` +
        `attempt=${event.attempt}, host=${event.host}`
      )
    );

    if (!uploadResponse.ok) {
      await uploadResponse.body?.cancel().catch(() => undefined);
      throw Object.assign(new Error(`图片上传失败: HTTP ${uploadResponse.status}`), {
        stage: "tos_binary_upload",
        status: uploadResponse.status,
        statusCode: uploadResponse.status,
      });
    }

    logger.info(`Buffer图片文件上传成功`);

    // 第四步：提交上传
    const commitUrl = `${imageXHost}/?Action=CommitImageUpload&Version=2018-08-01&ServiceId=${actualServiceId}`;

    const commitTimestamp = new Date().toISOString().replace(/[:\-]/g, '').replace(/\.\d{3}Z$/, 'Z');
    const commitPayload = JSON.stringify({
      SessionKey: uploadAddress.SessionKey,
      SuccessActionStatus: "200"
    });

    const payloadHash = crypto.createHash('sha256').update(commitPayload, 'utf8').digest('hex');

    const commitRequestHeaders = {
      'x-amz-date': commitTimestamp,
      'x-amz-security-token': session_token,
      'x-amz-content-sha256': payloadHash
    };

    const commitAuthorization = createSignature('POST', commitUrl, commitRequestHeaders, access_key_id, secret_access_key, session_token, commitPayload, awsRegion, 'imagex');

    const commitResponse = await fetchWithVideoImageUploadTimeout(
      rf,
      commitUrl,
      {
      method: 'POST',
      headers: {
        'accept': '*/*',
        'authorization': commitAuthorization,
        'content-type': 'application/json',
        'origin': uploadOrigin,
        'referer': uploadReferer,
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36',
        'x-amz-date': commitTimestamp,
        'x-amz-security-token': session_token,
        'x-amz-content-sha256': payloadHash,
      },
      body: commitPayload,
        signal: uploadOptions.signal,
      },
      "tos_commit_upload",
      resolveVideoImageUploadTimeoutMs("tos_commit_upload", uploadOptions.attempt, uploadOptions.timeoutProfileMs),
      uploadOptions.attempt,
      (event) => logger.warn(
        `视频图片上传阶段超时: stage=${event.stage}, timeout_ms=${event.timeoutMs}, ` +
        `attempt=${event.attempt}, host=${event.host}`
      )
    );

    if (!commitResponse.ok) {
      await commitResponse.body?.cancel().catch(() => undefined);
      throw Object.assign(new Error(`提交上传失败: HTTP ${commitResponse.status}`), {
        stage: "tos_commit_upload",
        status: commitResponse.status,
        statusCode: commitResponse.status,
      });
    }

    const commitResult = await commitResponse.json();

    if (commitResult?.ResponseMetadata?.Error) {
      throw Object.assign(new Error("提交上传失败: upstream error"), {
        stage: "tos_commit_upload",
      });
    }

    if (!commitResult?.Result?.Results || commitResult.Result.Results.length === 0) {
      throw Object.assign(new Error("提交上传失败: missing commit result"), {
        stage: "tos_commit_upload",
      });
    }

    const uploadResult = commitResult.Result.Results[0];
    if (uploadResult.UriStatus !== 2000) {
      throw Object.assign(new Error(`图片上传状态异常: UriStatus=${uploadResult.UriStatus}`), { stage: "tos_commit_upload" });
    }

    const fullImageUri = uploadResult.Uri;

    const pluginResult = commitResult.Result?.PluginResult?.[0];
    if (pluginResult && pluginResult.ImageUri) {
      logger.info("Buffer视频图片上传完成");
      return pluginResult.ImageUri;
    }

    logger.info("Buffer视频图片上传完成");
    return fullImageUri;

  } catch (error) {
    logger.error(`Buffer视频图片上传失败: ${summarizeVideoImageUploadErrorForLog(error)}`);
    throw error;
  }
  }});
}

/**
 * 解析音频文件时长（毫秒）
 * 支持 WAV 格式精确解析，其他格式按 128kbps 估算
 */
function parseAudioDuration(buffer: Buffer): number {
  try {
    // WAV: RIFF header check
    if (buffer.length >= 44 &&
        buffer[0] === 0x52 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x46 &&
        buffer[8] === 0x57 && buffer[9] === 0x41 && buffer[10] === 0x56 && buffer[11] === 0x45) {
      const byteRate = buffer.readUInt32LE(28);
      if (byteRate > 0) {
        // 查找 data chunk 获取精确大小
        let offset = 12;
        while (offset < buffer.length - 8) {
          const chunkId = buffer.toString('ascii', offset, offset + 4);
          const chunkSize = buffer.readUInt32LE(offset + 4);
          if (chunkId === 'data') {
            return Math.round(chunkSize / byteRate * 1000);
          }
          offset += 8 + chunkSize;
        }
        // 兜底：用文件大小估算
        return Math.round((buffer.length - 44) / byteRate * 1000);
      }
    }
    // 非 WAV：按 128kbps 估算
    return Math.round(buffer.length / (128 * 1000 / 8) * 1000);
  } catch {
    return 0;
  }
}

/**
 * 上传视频/音频文件
 * 通过 ByteDance VOD (视频点播) API 上传
 * 流程: get_upload_token(scene=1) → ApplyUploadInner → Upload → CommitUploadInner
 *
 * @param buffer 文件 Buffer
 * @param mediaType "video" 或 "audio"
 * @param refreshToken 刷新令牌
 * @param filename 原始文件名（可选）
 * @returns { vid, width?, height?, duration?, fps? }
 */
async function uploadMediaForVideo(
  buffer: Buffer,
  mediaType: "video" | "audio",
  refreshToken: string,
  filename?: string,
  regionInfo?: import("./core.ts").RegionInfo
): Promise<{ vid: string; width?: number; height?: number; duration?: number; fps?: number }> {
  const label = mediaType === "audio" ? "音频" : "视频";
  const fileSize = buffer.length;
  logger.info(`开始上传${label}文件，大小: ${fileSize} 字节`);

  const ri = regionInfo || parseRegionFromToken(refreshToken);
  const rf = regionFetch(ri);
  const awsRegion = getUploadAWSRegion(ri);
  const uploadOrigin = getUploadOrigin(ri);
  const uploadReferer = getUploadReferer(ri);

  // 第一步：获取 VOD 上传令牌（scene=1）
  const tokenResult = await request("post", "/mweb/v1/get_upload_token", refreshToken, {
    data: { scene: 1 },
  });

  const { access_key_id, secret_access_key, session_token, space_name } = tokenResult;
  if (!access_key_id || !secret_access_key || !session_token) {
    throw new Error(`获取${label}上传令牌失败`);
  }

  const spaceName = space_name || "dreamina";
  logger.info(`获取${label}上传令牌成功`);

  // 第二步：申请 VOD 上传权限（ApplyUploadInner）
  const now = new Date();
  const timestamp = now.toISOString().replace(/[:\-]/g, '').replace(/\.\d{3}Z$/, 'Z');
  const randomStr = Math.random().toString(36).substring(2, 12);

  const vodHost = "https://vod.bytedanceapi.com";
  const applyUrl = `${vodHost}/?Action=ApplyUploadInner&Version=2020-11-19&SpaceName=${spaceName}&FileType=video&IsInner=1&FileSize=${fileSize}&s=${randomStr}`;

  const requestHeaders: Record<string, string> = {
    'x-amz-date': timestamp,
    'x-amz-security-token': session_token,
  };

  const authorization = createSignature(
    'GET', applyUrl, requestHeaders,
    access_key_id, secret_access_key, session_token,
    '', awsRegion, 'vod'
  );

  logger.info(`申请${label}上传权限: ${applyUrl}`);

  const applyResponse = await rf(applyUrl, {
    method: 'GET',
    headers: {
      'accept': '*/*',
      'accept-language': 'zh-CN,zh;q=0.9',
      'authorization': authorization,
      'origin': uploadOrigin,
      'referer': uploadReferer,
      'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36',
      'x-amz-date': timestamp,
      'x-amz-security-token': session_token,
    },
  });

  if (!applyResponse.ok) {
    const errorText = await applyResponse.text();
    throw new Error(`申请${label}上传权限失败: ${applyResponse.status} - ${errorText}`);
  }

  const applyResult: any = await applyResponse.json();
  if (applyResult?.ResponseMetadata?.Error) {
    throw new Error(`申请${label}上传权限失败: ${JSON.stringify(applyResult.ResponseMetadata.Error)}`);
  }

  const uploadNodes = applyResult?.Result?.InnerUploadAddress?.UploadNodes;
  if (!uploadNodes || uploadNodes.length === 0) {
    throw new Error(`获取${label}上传节点失败: ${JSON.stringify(applyResult)}`);
  }

  const uploadNode = uploadNodes[0];
  const storeInfo = uploadNode.StoreInfos?.[0];
  if (!storeInfo) {
    throw new Error(`获取${label}上传存储信息失败: ${JSON.stringify(uploadNode)}`);
  }

  const uploadHost = uploadNode.UploadHost;
  const storeUri = storeInfo.StoreUri;
  const auth = storeInfo.Auth;
  const sessionKey = uploadNode.SessionKey;
  const vid = uploadNode.Vid;

  logger.info(`获取${label}上传节点成功: host=${uploadHost}, vid=${vid}`);

  // 第三步：上传文件
  const uploadUrl = `https://${uploadHost}/upload/v1/${storeUri}`;
  const crc32 = calculateCRC32(buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength));

  logger.info(`开始上传${label}文件: ${uploadUrl}, CRC32=${crc32}`);

  const uploadResponse = await rf(uploadUrl, {
    method: 'POST',
    headers: {
      'Accept': '*/*',
      'Authorization': auth,
      'Content-CRC32': crc32,
      'Content-Type': 'application/octet-stream',
      'Origin': uploadOrigin,
      'Referer': uploadReferer,
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36',
    },
    body: buffer,
  });

  if (!uploadResponse.ok) {
    const errorText = await uploadResponse.text();
    throw new Error(`${label}文件上传失败: ${uploadResponse.status} - ${errorText}`);
  }

  const uploadData: any = await uploadResponse.json();
  if (uploadData?.code !== 2000) {
    throw new Error(`${label}文件上传失败: code=${uploadData?.code}, message=${uploadData?.message}`);
  }

  logger.info(`${label}文件上传成功: crc32=${uploadData.data?.crc32}`);

  // 第四步：确认上传（CommitUploadInner）
  const commitUrl = `${vodHost}/?Action=CommitUploadInner&Version=2020-11-19&SpaceName=${spaceName}`;
  const commitTimestamp = new Date().toISOString().replace(/[:\-]/g, '').replace(/\.\d{3}Z$/, 'Z');
  const commitPayload = JSON.stringify({
    SessionKey: sessionKey,
    Functions: [],
  });

  const payloadHash = crypto.createHash('sha256').update(commitPayload, 'utf8').digest('hex');

  const commitRequestHeaders: Record<string, string> = {
    'x-amz-date': commitTimestamp,
    'x-amz-security-token': session_token,
    'x-amz-content-sha256': payloadHash,
  };

  const commitAuthorization = createSignature(
    'POST', commitUrl, commitRequestHeaders,
    access_key_id, secret_access_key, session_token,
    commitPayload, awsRegion, 'vod'
  );

  logger.info(`提交${label}上传确认: ${commitUrl}`);

  const commitResponse = await rf(commitUrl, {
    method: 'POST',
    headers: {
      'accept': '*/*',
      'authorization': commitAuthorization,
      'content-type': 'application/json',
      'origin': uploadOrigin,
      'referer': uploadReferer,
      'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36',
      'x-amz-date': commitTimestamp,
      'x-amz-security-token': session_token,
      'x-amz-content-sha256': payloadHash,
    },
    body: commitPayload,
  });

  if (!commitResponse.ok) {
    const errorText = await commitResponse.text();
    throw new Error(`提交${label}上传失败: ${commitResponse.status} - ${errorText}`);
  }

  const commitResult: any = await commitResponse.json();
  if (commitResult?.ResponseMetadata?.Error) {
    throw new Error(`提交${label}上传失败: ${JSON.stringify(commitResult.ResponseMetadata.Error)}`);
  }

  if (!commitResult?.Result?.Results || commitResult.Result.Results.length === 0) {
    throw new Error(`提交${label}上传响应缺少结果: ${JSON.stringify(commitResult)}`);
  }

  const result = commitResult.Result.Results[0];
  if (!result.Vid) {
    throw new Error(`提交${label}上传响应缺少 Vid: ${JSON.stringify(result)}`);
  }

  // 从 VOD 返回的元数据中获取信息（音频有 Duration）
  const videoMeta = result.VideoMeta || {};
  let duration = videoMeta.Duration ? Math.round(videoMeta.Duration * 1000) : 0;

  // 如果 VOD 未返回时长，用本地解析兜底
  if (duration <= 0 && mediaType === "audio") {
    duration = parseAudioDuration(buffer);
    logger.info(`VOD 未返回${label}时长，本地解析: ${duration}ms`);
  }

  logger.info(`${label}上传完成: vid=${result.Vid}, duration=${duration}ms`);

  return {
    vid: result.Vid,
    width: videoMeta.Width || 0,
    height: videoMeta.Height || 0,
    duration,
    fps: videoMeta.Fps || 0,
  };
}

/**
 * 通过 get_local_item_list API 获取高质量视频下载URL
 * 浏览器下载视频时使用此API获取高码率版本（~6297 vs 预览版 ~1152）
 *
 * @param itemId 视频项目ID
 * @param refreshToken 刷新令牌
 * @returns 高质量视频URL，失败时返回 null
 */
async function fetchHighQualityVideoUrl(itemId: string, refreshToken: string): Promise<string | null> {
  try {
    logger.info(`尝试获取高质量视频下载URL，item_id: ${itemId}`);

    const regionInfo = parseRegionFromToken(refreshToken);
    const isInternational = regionInfo.isInternational || regionInfo.isUS;

    const result = await request("post", "/mweb/v1/get_local_item_list", refreshToken, {
      data: {
        item_id_list: [itemId],
        pack_item_opt: {
          scene: 1,
          need_data_integrity: true,
        },
        is_for_video_download: true,
      },
    });

    const responseStr = JSON.stringify(result);
    logger.info(`get_local_item_list 响应大小: ${responseStr.length} 字符`);

    // 提取视频URL（按优先级尝试多种策略）
    let videoUrl: string | null = null;

    // 策略1: 从结构化字段中提取视频URL
    const itemList = result.item_list || result.local_item_list || [];
    if (itemList.length > 0) {
      const item = itemList[0];
      videoUrl =
        item?.common_attr?.transcoded_video?.origin?.video_url ||
        item?.result_url ||
        item?.video?.transcoded_video?.origin?.video_url ||
        item?.video?.download_url ||
        item?.video?.play_url ||
        item?.video?.url;
      if (videoUrl) {
        logger.info(`从get_local_item_list结构化字段获取到高清视频URL`);
      }
    }

    // 策略2: 正则匹配 dreamnia.jimeng.com 高质量URL
    if (!videoUrl) {
      const hqUrlMatch = responseStr.match(/https:\/\/v[0-9]+-dreamnia\.jimeng\.com\/[^"\s\\]+/);
      if (hqUrlMatch && hqUrlMatch[0]) {
        videoUrl = hqUrlMatch[0];
        logger.info(`正则提取到高质量视频URL (dreamnia)`);
      }
    }

    // 策略3: 匹配任何 jimeng.com 域名的视频URL
    if (!videoUrl) {
      const jimengUrlMatch = responseStr.match(/https:\/\/v[0-9]+-[^"\\]*\.jimeng\.com\/[^"\s\\]+/);
      if (jimengUrlMatch && jimengUrlMatch[0]) {
        videoUrl = jimengUrlMatch[0];
        logger.info(`正则提取到jimeng视频URL`);
      }
    }

    // 策略4: 匹配任何视频URL（兜底）
    if (!videoUrl) {
      const anyVideoUrlMatch = responseStr.match(/https:\/\/[^"\s\\]+\.(?:vlabvod|jimeng|capcut)\.com\/[^"\s\\]+/);
      if (anyVideoUrlMatch && anyVideoUrlMatch[0]) {
        videoUrl = anyVideoUrlMatch[0];
        logger.info(`从get_local_item_list提取到视频URL`);
      }
    }

    // 策略5: 匹配国际版 CapCut CDN
    if (!videoUrl) {
      const capcutUrlMatch = responseStr.match(/https:\/\/[^"\s\\]*capcut\.com\/[^"\s\\]+/);
      if (capcutUrlMatch && capcutUrlMatch[0]) {
        videoUrl = capcutUrlMatch[0];
        logger.info(`正则提取到国际版 CapCut 视频URL`);
      }
    }

    if (!videoUrl) {
      logger.warn(`未能从get_local_item_list响应中提取到视频URL`);
      return null;
    }

    // 国际版用户：调用权益API处理VIP去水印权益
    // 真实浏览器流程：get_local_item_list → benefit_metadata → batch_get_user_benefit → 下载
    // VIP用户的视频URL由服务端根据session的VIP状态决定，lr=display_watermark_aigc 实际为无水印版本
    if (isInternational) {
      try {
        await request("post", "/commerce/v3/resource/benefit_metadata", refreshToken, {
          data: {
            query_list: [
              { resource_type: "aigc", resource_id: "get_all", benefit_type_list: [] },
              { resource_type: "normal_func", resource_id: "get_all", benefit_type_list: [] },
            ],
          },
        });
        logger.info(`国际版权益API benefit_metadata 调用完成`);
      } catch (e) {
        logger.warn(`国际版权益API benefit_metadata 调用失败: ${e.message}`);
      }

      try {
        await request("post", "/commerce/v3/benefits/batch_get_user_benefit", refreshToken, {
          data: {
            query_list: [
              { resource_type: "aigc", resource_id: "get_all", benefit_type_list: [] },
              { resource_type: "normal_func", resource_id: "get_all", benefit_type_list: [] },
            ],
          },
        });
        logger.info(`国际版权益API batch_get_user_benefit 调用完成`);
      } catch (e) {
        logger.warn(`国际版权益API batch_get_user_benefit 调用失败: ${e.message}`);
      }
    }

    // 检测水印状态并记录日志
    if (videoUrl.includes("display_watermark_busi_aigc")) {
      logger.warn(`视频URL包含免费账号水印标识 (display_watermark_busi_aigc)，视频将带有水印`);
    } else if (videoUrl.includes("display_watermark_aigc")) {
      logger.info(`视频URL包含VIP账号标识 (display_watermark_aigc)，VIP用户此URL为无水印版本`);
    }

    logger.info(`获取到视频URL: ${videoUrl}`);
    return videoUrl;
  } catch (error) {
    logger.warn(`获取高质量视频下载URL失败: ${error.message}`);
    return null;
  }
}

/**
 * 生成视频
 *
 * @param _model 模型名称
 * @param prompt 提示词
 * @param options 选项
 * @param refreshToken 刷新令牌
 * @returns 视频URL
 */
export async function generateVideo(
  _model: string,
  prompt: string,
  {
    ratio = "1:1",
    resolution = "720p",
    duration = 5,
    filePaths = [],
    files = [],
  }: {
    ratio?: string;
    resolution?: string;
    duration?: number;
    filePaths?: string[];
    files?: any[];
  },
  refreshToken: string
) {
  const model = getModel(_model);

  // 解析分辨率参数获取实际的宽高
  const { width, height } = resolveVideoResolution(resolution, ratio);

  logger.info(`使用模型: ${_model} 映射模型: ${model} ${width}x${height} (${ratio}@${resolution}) 时长: ${duration}秒`);

  // 检查积分
  const { totalCredit } = await getCredit(refreshToken);
  if (totalCredit <= 0)
    await receiveCredit(refreshToken);

  // 处理首帧和尾帧图片
  let first_frame_image = undefined;
  let end_frame_image = undefined;

  // 处理上传的文件（multipart/form-data）
  if (files && files.length > 0) {
    let uploadIDs: string[] = [];
    logger.info(`开始处理 ${files.length} 个上传文件用于视频生成`);

    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      if (!file || !file.filepath) {
        logger.warn(`第 ${i + 1} 个文件无效，跳过`);
        continue;
      }

      try {
        logger.info(`开始上传第 ${i + 1} 个文件: ${file.originalFilename || file.filepath}`);

        // 读取文件内容并上传
        const buffer = fs.readFileSync(file.filepath);
        const imageUri = await uploadImageBufferForVideo(buffer, refreshToken);

        if (imageUri) {
          uploadIDs.push(imageUri);
          logger.info(`第 ${i + 1} 个文件上传成功`);
        } else {
          logger.error(`第 ${i + 1} 个文件上传失败: 未获取到 image_uri`);
        }
      } catch (error) {
        logger.error(`第 ${i + 1} 个文件上传失败: ${error.message}`);

        if (i === 0) {
          logger.error(`首帧文件上传失败，停止视频生成以避免浪费积分`);
          throw new APIException(EX.API_REQUEST_FAILED, `首帧文件上传失败: ${error.message}`);
        } else {
          logger.warn(`第 ${i + 1} 个文件上传失败，将跳过此文件继续处理`);
        }
      }
    }

    logger.info(`文件上传完成，成功上传 ${uploadIDs.length} 个文件`);

    if (uploadIDs.length === 0) {
      logger.error(`所有文件上传失败，停止视频生成以避免浪费积分`);
      throw new APIException(EX.API_REQUEST_FAILED, '所有文件上传失败，请检查文件是否有效');
    }

    // 构建首帧图片对象
    if (uploadIDs[0]) {
      first_frame_image = {
        format: "",
        height: height,
        id: util.uuid(),
        image_uri: uploadIDs[0],
        name: "",
        platform_type: 1,
        source_from: "upload",
        type: "image",
        uri: uploadIDs[0],
        width: width,
      };
      logger.info("已设置首帧图片");
    }

    // 构建尾帧图片对象
    if (uploadIDs[1]) {
      end_frame_image = {
        format: "",
        height: height,
        id: util.uuid(),
        image_uri: uploadIDs[1],
        name: "",
        platform_type: 1,
        source_from: "upload",
        type: "image",
        uri: uploadIDs[1],
        width: width,
      };
      logger.info("已设置尾帧图片");
    }
  } else if (filePaths && filePaths.length > 0) {
    let uploadIDs: string[] = [];
    logger.info(`开始上传 ${filePaths.length} 张图片用于视频生成`);

    for (let i = 0; i < filePaths.length; i++) {
      const filePath = filePaths[i];
      if (!filePath) {
        logger.warn(`第 ${i + 1} 张图片路径为空，跳过`);
        continue;
      }

      try {
        logger.info(`开始上传第 ${i + 1} 张图片: ${filePath}`);

        // 使用Amazon S3上传方式
        const imageUri = await uploadImageForVideo(filePath, refreshToken);

        if (imageUri) {
          uploadIDs.push(imageUri);
          logger.info(`第 ${i + 1} 张图片上传成功`);
        } else {
          logger.error(`第 ${i + 1} 张图片上传失败: 未获取到 image_uri`);
        }
      } catch (error) {
        logger.error(`第 ${i + 1} 张图片上传失败: ${error.message}`);

        // 图片上传失败时，停止视频生成避免浪费积分
        if (i === 0) {
          logger.error(`首帧图片上传失败，停止视频生成以避免浪费积分`);
          throw new APIException(EX.API_REQUEST_FAILED, `首帧图片上传失败: ${error.message}`);
        } else {
          logger.warn(`第 ${i + 1} 张图片上传失败，将跳过此图片继续处理`);
        }
      }
    }

    logger.info(`图片上传完成，成功上传 ${uploadIDs.length} 张图片`);

    // 如果没有成功上传任何图片，停止视频生成
    if (uploadIDs.length === 0) {
      logger.error(`所有图片上传失败，停止视频生成以避免浪费积分`);
      throw new APIException(EX.API_REQUEST_FAILED, '所有图片上传失败，请检查图片URL是否有效');
    }

    // 构建首帧图片对象
    if (uploadIDs[0]) {
      first_frame_image = {
        format: "",
        height: height,
        id: util.uuid(),
        image_uri: uploadIDs[0],
        name: "",
        platform_type: 1,
        source_from: "upload",
        type: "image",
        uri: uploadIDs[0],
        width: width,
      };
      logger.info("已设置首帧图片");
    }

    // 构建尾帧图片对象
    if (uploadIDs[1]) {
      end_frame_image = {
        format: "",
        height: height,
        id: util.uuid(),
        image_uri: uploadIDs[1],
        name: "",
        platform_type: 1,
        source_from: "upload",
        type: "image",
        uri: uploadIDs[1],
        width: width,
      };
      logger.info("已设置尾帧图片");
    } else if (filePaths.length > 1) {
      logger.warn(`第二张图片上传失败或未提供，将仅使用首帧图片`);
    }
  } else {
    logger.info(`未提供图片文件，将进行纯文本视频生成`);
  }

  const componentId = util.uuid();
  const metricsExtra = JSON.stringify({
    "enterFrom": "click",
    "isDefaultSeed": 1,
    "promptSource": "custom",
    "isRegenerate": false,
    "originSubmitId": util.uuid(),
  });

  // 获取当前模型的 draft 版本
  const draftVersion = MODEL_DRAFT_VERSIONS[_model] || DEFAULT_DRAFT_VERSION;

  // 计算视频宽高比
  const gcd = (a: number, b: number): number => b === 0 ? a : gcd(b, a % b);
  const divisor = gcd(width, height);
  const aspectRatio = `${width / divisor}:${height / divisor}`;

  // 构建请求参数
  const { aigc_data } = await request(
    "post",
    "/mweb/v1/aigc_draft/generate",
    refreshToken,
    {
      params: {
        aigc_features: "app_lip_sync",
        web_version: "6.6.0",
        da_version: draftVersion,
      },
      data: {
        "extend": {
          "root_model": end_frame_image ? MODEL_MAP['jimeng-video-3.0'] : model,
          "m_video_commerce_info": {
            benefit_type: "basic_video_operation_vgfm_v_three",
            resource_id: "generate_video",
            resource_id_type: "str",
            resource_sub_type: "aigc"
          },
          "m_video_commerce_info_list": [{
            benefit_type: "basic_video_operation_vgfm_v_three",
            resource_id: "generate_video",
            resource_id_type: "str",
            resource_sub_type: "aigc"
          }]
        },
        "submit_id": util.uuid(),
        "metrics_extra": metricsExtra,
        "draft_content": JSON.stringify({
          "type": "draft",
          "id": util.uuid(),
          "min_version": "3.0.5",
          "is_from_tsn": true,
          "version": draftVersion,
          "main_component_id": componentId,
          "component_list": [{
            "type": "video_base_component",
            "id": componentId,
            "min_version": "1.0.0",
            "metadata": {
              "type": "",
              "id": util.uuid(),
              "created_platform": 3,
              "created_platform_version": "",
              "created_time_in_ms": Date.now(),
              "created_did": ""
            },
            "generate_type": "gen_video",
            "aigc_mode": "workbench",
            "abilities": {
              "type": "",
              "id": util.uuid(),
              "gen_video": {
                "id": util.uuid(),
                "type": "",
                "text_to_video_params": {
                  "type": "",
                  "id": util.uuid(),
                  "model_req_key": model,
                  "priority": 0,
                  "seed": Math.floor(Math.random() * 100000000) + 2500000000,
                  "video_aspect_ratio": aspectRatio,
                  "video_gen_inputs": [{
                    duration_ms: duration * 1000,
                    first_frame_image: first_frame_image,
                    end_frame_image: end_frame_image,
                    fps: 24,
                    id: util.uuid(),
                    min_version: "3.0.5",
                    prompt: prompt,
                    resolution: resolution,
                    type: "",
                    video_mode: 2
                  }]
                },
                "video_task_extra": metricsExtra,
              }
            }
          }],
        }),
        http_common_info: {
          aid: DEFAULT_ASSISTANT_ID,
        },
      },
    }
  );

  const historyId = aigc_data.history_record_id;
  if (!historyId)
    throw new APIException(EX.API_IMAGE_GENERATION_FAILED, "记录ID不存在");

  // 轮询获取结果
  let status = 20, failCode, item_list = [];
  let retryCount = 0;
  const maxRetries = 120; // 支持较长的视频生成时间（约20分钟以上）

  // 首次查询前等待更长时间，让服务器有时间处理请求
  await new Promise((resolve) => setTimeout(resolve, 5000));

  logger.info(`开始轮询视频生成结果，历史ID: ${historyId}，最大重试次数: ${maxRetries}`);
  logger.info(`即梦官网API地址: https://jimeng.jianying.com/mweb/v1/get_history_by_ids`);
  logger.info(`视频生成请求已发送，请同时在即梦官网查看: https://jimeng.jianying.com/ai-tool/video/generate`);

  while (status === 20 && retryCount < maxRetries) {
    try {
      // 构建请求URL和参数
      const requestUrl = "/mweb/v1/get_history_by_ids";
      const requestData = {
        history_ids: [historyId],
      };

      // 尝试两种不同的API请求方式
      let result;
      let useAlternativeApi = retryCount > 10 && retryCount % 2 === 0; // 在重试10次后，每隔一次尝试备用API

      if (useAlternativeApi) {
        // 备用API请求方式
        logger.info(`尝试备用API请求方式，URL: ${requestUrl}, 历史ID: ${historyId}, 重试次数: ${retryCount + 1}/${maxRetries}`);
        const alternativeRequestData = {
          history_record_ids: [historyId],
        };
        result = await request("post", "/mweb/v1/get_history_records", refreshToken, {
          data: alternativeRequestData,
        });
        logger.info(`备用API响应摘要: ${JSON.stringify(result).substring(0, 500)}...`);
      } else {
        // 标准API请求方式
        logger.info(`发送请求获取视频生成结果，URL: ${requestUrl}, 历史ID: ${historyId}, 重试次数: ${retryCount + 1}/${maxRetries}`);
        result = await request("post", requestUrl, refreshToken, {
          data: requestData,
        });
        const responseStr = JSON.stringify(result);
        logger.info(`标准API响应摘要: ${responseStr.substring(0, 300)}...`);
      }


      // 检查结果是否有效
      let historyData;

      if (useAlternativeApi && result.history_records && result.history_records.length > 0) {
        // 处理备用API返回的数据格式
        historyData = result.history_records[0];
        logger.info(`从备用API获取到历史记录`);
      } else if (result.history_list && result.history_list.length > 0) {
        // 处理标准API返回的数据格式
        historyData = result.history_list[0];
        logger.info(`从标准API获取到历史记录`);
      } else if (result[historyId]) {
        // get_history_by_ids 返回数据以 historyId 为键（如 result["8918159809292"]）
        historyData = result[historyId];
        logger.info(`从historyId键获取到历史记录`);
      } else {
        // 所有API都没有返回有效数据
        logger.warn(`历史记录不存在，重试中 (${retryCount + 1}/${maxRetries})... 历史ID: ${historyId}`);
        logger.info(`请同时在即梦官网检查视频是否已生成: https://jimeng.jianying.com/ai-tool/video/generate`);

        retryCount++;
        // 增加重试间隔时间，但设置上限为30秒
        const waitTime = Math.min(2000 * (retryCount + 1), 30000);
        logger.info(`等待 ${waitTime}ms 后进行第 ${retryCount + 1} 次重试`);
        await new Promise((resolve) => setTimeout(resolve, waitTime));
        continue;
      }

      // 记录获取到的结果详情
      logger.info(`获取到历史记录结果: ${JSON.stringify(historyData)}`);


      // 从历史数据中提取状态和结果
      status = historyData.status;
      failCode = historyData.fail_code;
      item_list = historyData.item_list || [];

      logger.info(`视频生成状态: ${status}, 失败代码: ${failCode || '无'}, 项目列表长度: ${item_list.length}`);

      // 如果有视频URL，提前记录
      let tempVideoUrl = item_list?.[0]?.video?.transcoded_video?.origin?.video_url;
      if (!tempVideoUrl) {
        // 尝试从其他可能的路径获取
        tempVideoUrl = item_list?.[0]?.video?.play_url ||
                      item_list?.[0]?.video?.download_url ||
                      item_list?.[0]?.video?.url;
      }

      if (tempVideoUrl) {
        logger.info(`检测到视频URL: ${tempVideoUrl}`);
      }

      if (status === 30) {
        const error = failCode === 2038
          ? new APIException(EX.API_CONTENT_FILTERED, "内容被过滤")
          : new APIException(EX.API_IMAGE_GENERATION_FAILED, `生成失败，错误码: ${failCode}`);
        // 添加历史ID到错误对象，以便在chat.ts中显示
        error.historyId = historyId;
        throw error;
      }

      // 如果状态仍在处理中，等待后继续
      if (status === 20) {
        const waitTime = 2000 * (Math.min(retryCount + 1, 5)); // 随着重试次数增加等待时间，但最多10秒
        logger.info(`视频生成中，状态码: ${status}，等待 ${waitTime}ms 后继续查询`);
        await new Promise((resolve) => setTimeout(resolve, waitTime));
      }
    } catch (error) {
      logger.error(`轮询视频生成结果出错: ${error.message}`);
      retryCount++;
      await new Promise((resolve) => setTimeout(resolve, 2000 * (retryCount + 1)));
    }
  }

  // 如果达到最大重试次数仍未成功
  if (retryCount >= maxRetries && status === 20) {
    logger.error(`视频生成超时，已尝试 ${retryCount} 次，总耗时约 ${Math.floor(retryCount * 2000 / 1000 / 60)} 分钟`);
    const error = new APIException(EX.API_IMAGE_GENERATION_FAILED, "获取视频生成结果超时，请稍后在即梦官网查看您的视频");
    // 添加历史ID到错误对象，以便在chat.ts中显示
    error.historyId = historyId;
    throw error;
  }

  // 尝试通过 get_local_item_list 获取高质量视频下载URL
  const itemId = item_list?.[0]?.item_id
    || item_list?.[0]?.id
    || item_list?.[0]?.local_item_id
    || item_list?.[0]?.common_attr?.id;

  if (itemId) {
    try {
      const hqVideoUrl = await fetchHighQualityVideoUrl(String(itemId), refreshToken);
      if (hqVideoUrl) {
        logger.info(`视频生成成功（高质量），URL: ${hqVideoUrl}`);
        return hqVideoUrl;
      }
    } catch (error) {
      logger.warn(`获取高质量视频URL失败，将使用预览URL作为回退: ${error.message}`);
    }
  } else {
    logger.warn(`未能从item_list中提取item_id，将使用预览URL。item_list[0]键: ${item_list?.[0] ? Object.keys(item_list[0]).join(', ') : '无'}`);
  }

  // 回退：提取预览视频URL
  let videoUrl = item_list?.[0]?.video?.transcoded_video?.origin?.video_url;

  // 如果通过常规路径无法获取视频URL，尝试其他可能的路径
  if (!videoUrl) {
    // 尝试从item_list中的其他可能位置获取
    if (item_list?.[0]?.video?.play_url) {
      videoUrl = item_list[0].video.play_url;
      logger.info(`从play_url获取到视频URL: ${videoUrl}`);
    } else if (item_list?.[0]?.video?.download_url) {
      videoUrl = item_list[0].video.download_url;
      logger.info(`从download_url获取到视频URL: ${videoUrl}`);
    } else if (item_list?.[0]?.video?.url) {
      videoUrl = item_list[0].video.url;
      logger.info(`从url获取到视频URL: ${videoUrl}`);
    } else {
      // 如果仍然找不到，记录错误并抛出异常
      logger.error(`未能获取视频URL，item_list: ${JSON.stringify(item_list)}`);
      const error = new APIException(EX.API_IMAGE_GENERATION_FAILED, "未能获取视频URL，请稍后在即梦官网查看");
      // 添加历史ID到错误对象，以便在chat.ts中显示
      error.historyId = historyId;
      throw error;
    }
  }

  logger.info(`视频生成成功，URL: ${videoUrl}`);
  return videoUrl;
}

/**
 * Seedance 2.0 多图智能视频生成
 * 支持多张图片与文本混合生成视频
 *
 * @param _model 模型名称
 * @param prompt 提示词（支持 @1 @2 等引用图片占位符）
 * @param options 选项
 * @param refreshToken 刷新令牌
 * @returns 视频URL
 */
export async function generateSeedanceVideo(
  _model: string,
  prompt: string,
  {
    ratio = "4:3",
    resolution = "720p",
    duration = 4,
    filePaths = [],
    files = [],
  }: {
    ratio?: string;
    resolution?: string;
    duration?: number;
    filePaths?: string[];
    files?: any[];
  },
  refreshToken: string
) {
  const model = getModel(_model);
  const benefitType = SEEDANCE_BENEFIT_TYPE_MAP[_model] || "dreamina_video_seedance_20_pro";

  // Seedance 2.0 默认时长为4秒
  const actualDuration = duration || 4;

  // 解析分辨率参数获取实际的宽高
  const { width, height } = resolveVideoResolution(resolution, ratio);

  logger.info(`Seedance 2.0 生成: 模型=${_model} 映射=${model} ${width}x${height} (${ratio}@${resolution}) 时长=${actualDuration}秒`);

  // 检查积分
  const { totalCredit } = await getCredit(refreshToken);
  if (totalCredit <= 0)
    await receiveCredit(refreshToken);

  // 上传所有文件（支持图片/视频/音频）
  let uploadedMaterials: UploadedMaterial[] = [];

  // 处理上传的文件（multipart/form-data）
  if (files && files.length > 0) {
    logger.info(`Seedance: 开始处理 ${files.length} 个上传文件`);

    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      if (!file || !file.filepath) {
        logger.warn(`Seedance: 第 ${i + 1} 个文件无效，跳过`);
        continue;
      }

      const materialType = detectMaterialType(file);
      try {
        logger.info(`Seedance: 开始上传第 ${i + 1} 个文件 (${materialType}): ${file.originalFilename || file.filepath}`);
        const buffer = fs.readFileSync(file.filepath);

        if (materialType === "image") {
          const imageUri = await uploadImageBufferForVideo(buffer, refreshToken);
          if (imageUri) {
            uploadedMaterials.push({ type: "image", uri: imageUri, width, height });
            logger.info(`Seedance: 第 ${i + 1} 个图片上传成功`);
          }
        } else {
          // 视频或音频 → VOD 上传
          const vodResult = await uploadMediaForVideo(buffer, materialType, refreshToken, file.originalFilename);
          uploadedMaterials.push({
            type: materialType,
            vid: vodResult.vid,
            width: vodResult.width,
            height: vodResult.height,
            duration: vodResult.duration,
            fps: vodResult.fps,
            name: file.originalFilename || "",
          });
          logger.info(`Seedance: 第 ${i + 1} 个${materialType === "video" ? "视频" : "音频"}上传成功: ${vodResult.vid}`);
        }
      } catch (error) {
        logger.error(`Seedance: 第 ${i + 1} 个文件上传失败: ${error.message}`);
        if (i === 0) {
          throw new APIException(EX.API_REQUEST_FAILED, `首个文件上传失败: ${error.message}`);
        }
      }
    }
  } else if (filePaths && filePaths.length > 0) {
    logger.info(`Seedance: 开始上传 ${filePaths.length} 个文件`);

    for (let i = 0; i < filePaths.length; i++) {
      const filePath = filePaths[i];
      if (!filePath) continue;

      const materialType = detectMaterialTypeFromUrl(filePath);
      try {
        logger.info(`Seedance: 开始上传第 ${i + 1} 个文件 (${materialType}): ${filePath}`);

        if (materialType === "image") {
          const imageUri = await uploadImageForVideo(filePath, refreshToken);
          if (imageUri) {
            uploadedMaterials.push({ type: "image", uri: imageUri, width, height });
            logger.info(`Seedance: 第 ${i + 1} 个图片上传成功`);
          }
        } else {
          // 视频或音频 URL → 下载后 VOD 上传
          const response = await fetch(filePath);
          if (!response.ok) throw new Error(`下载文件失败: ${response.status}`);
          const arrayBuffer = await response.arrayBuffer();
          const buffer = Buffer.from(arrayBuffer);
          const vodResult = await uploadMediaForVideo(buffer, materialType, refreshToken);
          uploadedMaterials.push({
            type: materialType,
            vid: vodResult.vid,
            width: vodResult.width,
            height: vodResult.height,
            duration: vodResult.duration,
            fps: vodResult.fps,
          });
          logger.info(`Seedance: 第 ${i + 1} 个${materialType === "video" ? "视频" : "音频"}上传成功: ${vodResult.vid}`);
        }
      } catch (error) {
        logger.error(`Seedance: 第 ${i + 1} 个文件上传失败: ${error.message}`);
        if (i === 0) {
          throw new APIException(EX.API_REQUEST_FAILED, `首个文件上传失败: ${error.message}`);
        }
      }
    }
  }

  if (uploadedMaterials.length === 0) {
    throw new APIException(EX.API_REQUEST_FAILED, 'Seedance 2.0 需要至少一个文件（图片/视频/音频）');
  }

  logger.info(`Seedance: 成功上传 ${uploadedMaterials.length} 个文件`);

  // 动态 benefit_type：包含视频素材时追加 _with_video 后缀
  const hasVideoMaterial = uploadedMaterials.some(m => m.type === "video");
  const finalBenefitType = hasVideoMaterial ? `${benefitType}_with_video` : benefitType;

  // 构建 material_list（支持图片/视频/音频）
  const materialList = uploadedMaterials.map((mat) => {
    const base = { type: "", id: util.uuid() };
    if (mat.type === "image") {
      return {
        ...base,
        material_type: "image",
        image_info: {
          type: "image",
          id: util.uuid(),
          source_from: "upload",
          platform_type: 1,
          name: "",
          image_uri: mat.uri,
          aigc_image: { type: "", id: util.uuid() },
          width: mat.width,
          height: mat.height,
          format: "",
          uri: mat.uri,
        }
      };
    } else if (mat.type === "video") {
      return {
        ...base,
        material_type: "video",
        video_info: {
          type: "video",
          id: util.uuid(),
          source_from: "upload",
          name: mat.name || "",
          vid: mat.vid,
          fps: mat.fps || 0,
          width: mat.width || 0,
          height: mat.height || 0,
          duration: mat.duration || 0,
        }
      };
    } else {
      // audio
      return {
        ...base,
        material_type: "audio",
        audio_info: {
          type: "audio",
          id: util.uuid(),
          source_from: "upload",
          vid: mat.vid,
          duration: mat.duration || 0,
          name: mat.name || "",
        }
      };
    }
  });

  // 解析 prompt 中的素材占位符（@1, @2 等）并构建 meta_list
  const metaList = buildMetaListFromPrompt(prompt, uploadedMaterials);

  const componentId = util.uuid();
  const submitId = util.uuid();
  const draftVersion = MODEL_DRAFT_VERSIONS[_model] || "3.3.9";

  // 计算视频宽高比
  const gcd = (a: number, b: number): number => b === 0 ? a : gcd(b, a % b);
  const divisor = gcd(width, height);
  const aspectRatio = `${width / divisor}:${height / divisor}`;

  const metricsExtra = JSON.stringify({
    isDefaultSeed: 1,
    originSubmitId: submitId,
    isRegenerate: false,
    enterFrom: "click",
    position: "page_bottom_box",
    functionMode: "omni_reference",
    sceneOptions: JSON.stringify([{
      type: "video",
      scene: "BasicVideoGenerateButton",
      modelReqKey: model,
      videoDuration: actualDuration,
      reportParams: {
        enterSource: "generate",
        vipSource: "generate",
        extraVipFunctionKey: model,
        useVipFunctionDetailsReporterHoc: true
      },
      materialTypes: [...new Set(uploadedMaterials.map(m => MATERIAL_TYPE_CODE[m.type]))]
    }])
  });

  // 构建 Seedance 2.0 专用请求（通过浏览器代理，绕过 shark a_bogus 检测）
  const token = await acquireToken(refreshToken);
  const generateQueryParams = new URLSearchParams({
    aid: String(CORE_ASSISTANT_ID),
    device_platform: "web",
    region: "cn",
    webId: String(WEB_ID),
    da_version: draftVersion,
    web_component_open_flag: "1",
    commerce_with_input_video: "1",
    web_version: "7.5.0",
    aigc_features: "app_lip_sync",
  });
  const generateUrl = `https://jimeng.jianying.com/mweb/v1/aigc_draft/generate?${generateQueryParams.toString()}`;
  const generateBody = {
    extend: {
      root_model: model,
      workspace_id: 0,
      m_video_commerce_info: {
        benefit_type: finalBenefitType,
        resource_id: "generate_video",
        resource_id_type: "str",
        resource_sub_type: "aigc"
      },
      m_video_commerce_info_list: [{
        benefit_type: finalBenefitType,
        resource_id: "generate_video",
        resource_id_type: "str",
        resource_sub_type: "aigc"
      }]
    },
    submit_id: submitId,
    metrics_extra: metricsExtra,
    draft_content: JSON.stringify({
      type: "draft",
      id: util.uuid(),
      min_version: draftVersion,
      min_features: ["AIGC_Video_UnifiedEdit"],
      is_from_tsn: true,
      version: draftVersion,
      main_component_id: componentId,
      component_list: [{
        type: "video_base_component",
        id: componentId,
        min_version: "1.0.0",
        aigc_mode: "workbench",
        metadata: {
          type: "",
          id: util.uuid(),
          created_platform: 3,
          created_platform_version: "",
          created_time_in_ms: String(Date.now()),
          created_did: ""
        },
        generate_type: "gen_video",
        abilities: {
          type: "",
          id: util.uuid(),
          gen_video: {
            type: "",
            id: util.uuid(),
            text_to_video_params: {
              type: "",
              id: util.uuid(),
              video_gen_inputs: [{
                type: "",
                id: util.uuid(),
                min_version: draftVersion,
                prompt: "",  // Seedance 2.0 prompt 在 meta_list 中
                video_mode: 2,
                fps: 24,
                duration_ms: actualDuration * 1000,
                idip_meta_list: [],
                unified_edit_input: {
                  type: "",
                  id: util.uuid(),
                  material_list: materialList,
                  meta_list: metaList
                }
              }],
              video_aspect_ratio: aspectRatio,
              seed: Math.floor(Math.random() * 1000000000),
              model_req_key: model,
              priority: 0
            },
            video_task_extra: metricsExtra
          }
        },
        process_type: 1
      }]
    }),
    http_common_info: {
      aid: CORE_ASSISTANT_ID,
    },
  };

  logger.info(`Seedance: 通过浏览器代理发送 generate 请求...`);
  const generateResult = await runGlobalImageGeneration(submitId, () => browserService.fetch(
    token,
    generateUrl,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(generateBody),
    }
  ));

  // 检查浏览器代理返回的结果
  const { ret, errmsg, data: generateData } = generateResult;
  if (ret !== undefined && Number(ret) !== 0) {
    if (Number(ret) === 5000) {
      throw new APIException(EX.API_IMAGE_GENERATION_INSUFFICIENT_POINTS, `[无法生成视频]: 即梦积分可能不足，${errmsg}`);
    }
    throw new APIException(EX.API_REQUEST_FAILED, `[请求jimeng失败]: ${errmsg}`);
  }
  const aigc_data = generateData?.aigc_data || generateResult.aigc_data;

  const historyId = aigc_data.history_record_id;
  if (!historyId)
    throw new APIException(EX.API_IMAGE_GENERATION_FAILED, "记录ID不存在");

  // 轮询获取结果（与普通视频相同的逻辑）
  let status = 20, failCode, item_list = [];
  let retryCount = 0;
  const maxRetries = 120;

  await new Promise((resolve) => setTimeout(resolve, 5000));

  logger.info(`Seedance: 开始轮询视频生成结果，历史ID: ${historyId}`);

  while (status === 20 && retryCount < maxRetries) {
    try {
      const result = await request("post", "/mweb/v1/get_history_by_ids", refreshToken, {
        data: { history_ids: [historyId] },
      });

      const responseStr = JSON.stringify(result);
      logger.info(`Seedance: 轮询响应摘要: ${responseStr.substring(0, 300)}...`);

      // get_history_by_ids 返回的数据可能以 historyId 为键（如 result["8918159809292"]），
      // 也可能在 result.history_list 数组中
      let historyData = result.history_list?.[0] || result[historyId];

      if (!historyData) {
        retryCount++;
        const waitTime = Math.min(2000 * (retryCount + 1), 30000);
        await new Promise((resolve) => setTimeout(resolve, waitTime));
        continue;
      }
      status = historyData.status;
      failCode = historyData.fail_code;
      item_list = historyData.item_list || [];

      logger.info(`Seedance: 状态=${status}, 失败码=${failCode || '无'}`);

      if (status === 30) {
        const error = failCode === 2038
          ? new APIException(EX.API_CONTENT_FILTERED, "内容被过滤")
          : new APIException(EX.API_IMAGE_GENERATION_FAILED, `生成失败，错误码: ${failCode}`);
        error.historyId = historyId;
        throw error;
      }

      if (status === 20) {
        const waitTime = 2000 * Math.min(retryCount + 1, 5);
        await new Promise((resolve) => setTimeout(resolve, waitTime));
      }

      retryCount++;
    } catch (error) {
      if (error instanceof APIException) throw error;
      logger.error(`Seedance: 轮询出错: ${error.message}`);
      retryCount++;
      await new Promise((resolve) => setTimeout(resolve, 2000 * (retryCount + 1)));
    }
  }

  if (retryCount >= maxRetries && status === 20) {
    const error = new APIException(EX.API_IMAGE_GENERATION_FAILED, "视频生成超时");
    error.historyId = historyId;
    throw error;
  }

  // 尝试通过 get_local_item_list 获取高质量视频下载URL
  const seedanceItemId = item_list?.[0]?.item_id
    || item_list?.[0]?.id
    || item_list?.[0]?.local_item_id
    || item_list?.[0]?.common_attr?.id;

  if (seedanceItemId) {
    try {
      const hqVideoUrl = await fetchHighQualityVideoUrl(String(seedanceItemId), refreshToken);
      if (hqVideoUrl) {
        logger.info(`Seedance: 视频生成成功（高质量），URL: ${hqVideoUrl}`);
        return hqVideoUrl;
      }
    } catch (error) {
      logger.warn(`Seedance: 获取高质量视频URL失败，将使用预览URL作为回退: ${error.message}`);
    }
  } else {
    logger.warn(`Seedance: 未能从item_list中提取item_id，将使用预览URL。item_list[0]键: ${item_list?.[0] ? Object.keys(item_list[0]).join(', ') : '无'}`);
  }

  // 回退：提取预览视频URL
  let videoUrl = item_list?.[0]?.video?.transcoded_video?.origin?.video_url
    || item_list?.[0]?.video?.play_url
    || item_list?.[0]?.video?.download_url
    || item_list?.[0]?.video?.url;

  if (!videoUrl) {
    const error = new APIException(EX.API_IMAGE_GENERATION_FAILED, "未能获取视频URL");
    error.historyId = historyId;
    throw error;
  }

  logger.info(`Seedance: 视频生成成功，URL: ${videoUrl}`);
  return videoUrl;
}

/**
 * 解析 prompt 中的素材占位符并构建 meta_list
 * 支持格式: "使用 @1 图片，@2 图片做动画" -> [text, material(0), text, material(1), text]
 * meta_type 根据素材实际类型动态匹配（image/video/audio）
 */
function getCanonicalMaterialEntries(materialRegistry: Map<string, any>) {
  return [...new Map([...materialRegistry].filter(([key, value]) => key === value.fieldName)).values()]
    .sort((a, b) => a.idx - b.idx);
}

async function pollHistoryForVideoUrl(historyId: string, refreshToken: string): Promise<string> {
  const regionInfo = parseRegionFromToken(refreshToken);
  let status = 20, failCode, item_list = [];
  let retryCount = 0;
  const maxRetries = 120;

  await new Promise((resolve) => setTimeout(resolve, 5000));

  while (status === 20 && retryCount < maxRetries) {
    try {
      const result = await request("post", "/mweb/v1/get_history_by_ids", refreshToken, {
        data: {
          history_ids: [historyId],
          ...(regionInfo.isInternational ? { http_common_info: { aid: getAssistantId(regionInfo) } } : {}),
        },
      });

      const historyData = result.history_list?.[0] || result[historyId] || result.data?.history_list?.[0];
      if (!historyData) {
        retryCount++;
        const waitTime = Math.min(2000 * (retryCount + 1), 30000);
        await new Promise((resolve) => setTimeout(resolve, waitTime));
        continue;
      }

      status = historyData.status;
      failCode = historyData.fail_code;
      item_list = historyData.item_list || historyData.items || [];

      if (status === 30 || status === 3) {
        const error = failCode === 2038
          ? new APIException(EX.API_CONTENT_FILTERED, "内容被过滤")
          : new APIException(EX.API_IMAGE_GENERATION_FAILED, `生成失败，错误码: ${failCode}`);
        error.historyId = historyId;
        throw error;
      }

      if (status === 20 || status === 1) {
        const waitTime = 2000 * Math.min(retryCount + 1, 5);
        await new Promise((resolve) => setTimeout(resolve, waitTime));
      }

      retryCount++;
    } catch (error) {
      if (error instanceof APIException) throw error;
      retryCount++;
      await new Promise((resolve) => setTimeout(resolve, 2000 * (retryCount + 1)));
    }
  }

  if (retryCount >= maxRetries && (status === 20 || status === 1)) {
    const error = new APIException(EX.API_IMAGE_GENERATION_FAILED, "视频生成超时");
    error.historyId = historyId;
    throw error;
  }

  const itemId = item_list?.[0]?.item_id || item_list?.[0]?.id || item_list?.[0]?.local_item_id || item_list?.[0]?.common_attr?.id;
  if (itemId) {
    try {
      const hqVideoUrl = await fetchHighQualityVideoUrl(String(itemId), refreshToken);
      if (hqVideoUrl) return hqVideoUrl;
    } catch (error) {
      logger.warn(`获取高质量视频URL失败，将使用预览URL作为回退: ${error.message}`);
    }
  }

  const videoUrl = item_list?.[0]?.common_attr?.transcoded_video?.origin?.video_url
    || item_list?.[0]?.result_url
    || item_list?.[0]?.video?.transcoded_video?.origin?.video_url
    || item_list?.[0]?.video?.play_url
    || item_list?.[0]?.video?.download_url
    || item_list?.[0]?.video?.url;

  if (!videoUrl) {
    const error = new APIException(EX.API_IMAGE_GENERATION_FAILED, "未能获取视频URL");
    error.historyId = historyId;
    throw error;
  }

  return videoUrl;
}

function parseOmniPrompt(prompt: string, materialRegistry: Map<string, any>): any[] {
  const refNames = [...materialRegistry.keys()]
    .sort((a, b) => b.length - a.length)
    .map(n => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));

  if (refNames.length === 0) {
    return [{ meta_type: "text", text: prompt }];
  }

  const buildMaterialRef = (entry: any) => {
    if (entry.type === "image" && entry.imageUri) {
      return { uri: entry.imageUri };
    }
    if (entry.type === "video" && entry.videoResult?.vid) {
      return { vid: entry.videoResult.vid };
    }
    return { material_idx: entry.idx };
  };

  const pattern = new RegExp(`@(${refNames.join('|')})`, 'g');
  const meta_list: any[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(prompt)) !== null) {
    if (match.index > lastIndex) {
      const textSegment = prompt.slice(lastIndex, match.index);
      if (textSegment) {
        meta_list.push({ meta_type: "text", text: textSegment });
      }
    }
    const refName = match[1];
    const entry = materialRegistry.get(refName);
    if (entry) {
      meta_list.push({
        meta_type: entry.type,
        text: "",
        material_ref: buildMaterialRef(entry),
      });
    }
    lastIndex = pattern.lastIndex;
  }

  if (lastIndex < prompt.length) {
    meta_list.push({ meta_type: "text", text: prompt.slice(lastIndex) });
  }

  if (meta_list.length === 0) {
    meta_list.push({ meta_type: "text", text: prompt });
  }

  return meta_list;
}

function collectInternationalMaterialFields(filesMap: Record<string, any[]>, body: any) {
  const imageFields: string[] = [];
  const videoFields: string[] = [];

  for (const fieldName of Object.keys(filesMap || {})) {
    if (fieldName === "image_file" || fieldName.startsWith("image_file_")) imageFields.push(fieldName);
    if (fieldName === "video_file" || fieldName.startsWith("video_file_")) videoFields.push(fieldName);
  }

  for (let i = 1; i <= 9; i++) {
    const fieldName = `image_file_${i}`;
    if (typeof body?.[fieldName] === "string" && body[fieldName].startsWith("http") && !imageFields.includes(fieldName)) imageFields.push(fieldName);
  }
  for (let i = 1; i <= 3; i++) {
    const fieldName = `video_file_${i}`;
    if (typeof body?.[fieldName] === "string" && body[fieldName].startsWith("http") && !videoFields.includes(fieldName)) videoFields.push(fieldName);
  }
  if (typeof body?.image_file === "string" && body.image_file.startsWith("http") && !imageFields.includes("image_file")) imageFields.push("image_file");
  if (typeof body?.video_file === "string" && body.video_file.startsWith("http") && !videoFields.includes("video_file")) videoFields.push("video_file");

  return { imageFields, videoFields };
}

export async function uploadInternationalImageUrl(imageUrl: string, refreshToken: string, regionInfo: import("./core.ts").RegionInfo): Promise<string> {
  const response = await fetch(imageUrl);
  if (!response.ok) throw new Error(`下载图片失败: ${response.status}`);
  const buffer = Buffer.from(await response.arrayBuffer());
  return uploadImageBufferForVideo(buffer, refreshToken, regionInfo);
}

async function uploadInternationalVideoUrl(videoUrl: string, refreshToken: string, regionInfo: import("./core.ts").RegionInfo) {
  const response = await fetch(videoUrl);
  if (!response.ok) throw new Error(`下载视频失败: ${response.status}`);
  const buffer = Buffer.from(await response.arrayBuffer());
  return uploadMediaForVideo(buffer, "video", refreshToken, undefined, regionInfo);
}

async function generateInternationalVideoCore(
  _model: string,
  prompt: string = "",
  {
    ratio = "1:1",
    resolution = "720p",
    duration = 5,
    filePaths = [],
    files = [],
  }: {
    ratio?: string;
    resolution?: string;
    duration?: number;
    filePaths?: string[];
    files?: any[];
  },
  refreshToken: string,
  onHistoryId?: (historyId: string) => void
): Promise<{ url: string; historyId: string }> {
  if (!Object.prototype.hasOwnProperty.call(INTERNATIONAL_VIDEO_MODEL_MAP, _model)) {
    throw new APIException(EX.API_REQUEST_PARAMS_INVALID, `国际接口暂不支持模型: ${_model}`);
  }

  const regionInfo = parseRegionFromToken(refreshToken);
  if (regionInfo.isCN) {
    throw new APIException(EX.API_REQUEST_FAILED, "国际视频接口仅接受国际 token（hk-/jp-/sg-/al-/az-/bh-/ca-/cl-/de-/gb-/gy-/il-/iq-/it-/jo-/kg-/om-/pk-/pt-/sa-/se-/tr-/tz-/uz-/ve-/xk-）");
  }

  const model = getInternationalVideoModel(_model);
  const assistantId = getAssistantId(regionInfo);
  const { width, height } = resolveVideoResolution(resolution, ratio);
  const draftVersion = getInternationalVideoDraftVersion(_model);

  logger.info(`国际普通视频生成: 模型=${_model} 映射=${model} ${width}x${height} (${ratio}@${resolution}) 时长=${duration}秒`);

  const { totalCredit } = await getCredit(refreshToken);
  if (totalCredit <= 0) await receiveCredit(refreshToken);

  await request("post", "/mweb/v1/workspace/update", refreshToken, {
    params: {
      os: "windows",
      web_version: "7.5.0",
      da_version: draftVersion,
      aigc_features: "app_lip_sync",
    },
    data: { workspace_id: 0 },
    headers: { Referer: "https://dreamina.capcut.com/" },
  });

  let first_frame_image = undefined;
  let end_frame_image = undefined;

  if (files && files.length > 0) {
    const uploadIDs: string[] = [];
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      if (!file || !file.filepath) continue;
      try {
        const buffer = fs.readFileSync(file.filepath);
        const imageUri = await uploadImageBufferForVideo(buffer, refreshToken, regionInfo);
        if (imageUri) uploadIDs.push(imageUri);
      } catch (error) {
        if (i === 0) throw new APIException(EX.API_REQUEST_FAILED, `首帧文件上传失败: ${error.message}`);
      }
    }
    if (uploadIDs.length === 0) throw new APIException(EX.API_REQUEST_FAILED, "所有文件上传失败");
    if (uploadIDs[0]) {
      first_frame_image = { format: "", height, id: util.uuid(), image_uri: uploadIDs[0], name: "", platform_type: 1, source_from: "upload", type: "image", uri: uploadIDs[0], width };
    }
    if (uploadIDs[1]) {
      end_frame_image = { format: "", height, id: util.uuid(), image_uri: uploadIDs[1], name: "", platform_type: 1, source_from: "upload", type: "image", uri: uploadIDs[1], width };
    }
  } else if (filePaths && filePaths.length > 0) {
    const uploadIDs: string[] = [];
    for (let i = 0; i < filePaths.length; i++) {
      if (!filePaths[i]) continue;
      try {
        const imageUri = await uploadImageForVideo(filePaths[i], refreshToken, regionInfo);
        if (imageUri) uploadIDs.push(imageUri);
      } catch (error) {
        if (i === 0) throw new APIException(EX.API_REQUEST_FAILED, `首帧图片上传失败: ${error.message}`);
      }
    }
    if (uploadIDs.length === 0) throw new APIException(EX.API_REQUEST_FAILED, "所有图片上传失败");
    if (uploadIDs[0]) {
      first_frame_image = { format: "", height, id: util.uuid(), image_uri: uploadIDs[0], name: "", platform_type: 1, source_from: "upload", type: "image", uri: uploadIDs[0], width };
    }
    if (uploadIDs[1]) {
      end_frame_image = { format: "", height, id: util.uuid(), image_uri: uploadIDs[1], name: "", platform_type: 1, source_from: "upload", type: "image", uri: uploadIDs[1], width };
    }
  }

  const componentId = util.uuid();
  const submitId = util.uuid();
  const metricsExtra = JSON.stringify({
    promptSource: "custom",
    isDefaultSeed: 1,
    originSubmitId: submitId,
    isRegenerate: false,
    enterFrom: "click",
    position: "page_bottom_box",
    functionMode: "first_last_frames",
    sceneOptions: JSON.stringify([{
      type: "video",
      scene: "BasicVideoGenerateButton",
      resolution,
      modelReqKey: model,
      videoDuration: duration,
      reportParams: {
        enterSource: "generate",
        vipSource: "generate",
        extraVipFunctionKey: `${model}-${resolution}`,
        useVipFunctionDetailsReporterHoc: true,
      },
      materialTypes: [],
    }]),
  });
  const aspectRatio = ratio;

  const internationalVideoReferer = regionInfo.isUS
    ? "https://dreamina-api.us.capcut.com/ai-tool/generate?type=video"
    : "https://dreamina.capcut.com/ai-tool/generate?type=video";

  const { aigc_data } = await request("post", "/mweb/v1/aigc_draft/generate", refreshToken, {
    params: {
      aigc_features: "app_lip_sync",
      commerce_with_input_video: "1",
      web_version: "7.5.0",
      da_version: draftVersion,
    },
    data: {
      extend: {
        root_model: end_frame_image ? INTERNATIONAL_VIDEO_MODEL_MAP["jimeng-video-3.0"] : model,
        m_video_commerce_info: {
          benefit_type: getVideoBenefitType(model),
          resource_id: "generate_video",
          resource_id_type: "str",
          resource_sub_type: "aigc"
        },
        workspace_id: 0,
        m_video_commerce_info_list: [{
          benefit_type: getVideoBenefitType(model),
          resource_id: "generate_video",
          resource_id_type: "str",
          resource_sub_type: "aigc"
        }]
      },
      submit_id: submitId,
      metrics_extra: metricsExtra,
      draft_content: JSON.stringify({
        type: "draft",
        id: util.uuid(),
        min_version: "3.0.5",
        min_features: [],
        is_from_tsn: true,
        version: draftVersion,
        main_component_id: componentId,
        component_list: [{
          type: "video_base_component",
          id: componentId,
          min_version: "1.0.0",
          aigc_mode: "workbench",
          metadata: {
            type: "",
            id: util.uuid(),
            created_platform: 3,
            created_platform_version: "",
            created_time_in_ms: Date.now().toString(),
            created_did: ""
          },
          generate_type: "gen_video",
          abilities: {
            type: "",
            id: util.uuid(),
            gen_video: {
              id: util.uuid(),
              type: "",
              text_to_video_params: {
                type: "",
                id: util.uuid(),
                model_req_key: model,
                priority: 0,
                seed: Math.floor(Math.random() * 4294967296),
                video_aspect_ratio: aspectRatio,
                video_gen_inputs: [{
                  duration_ms: duration * 1000,
                  first_frame_image,
                  end_frame_image,
                  fps: 24,
                  id: util.uuid(),
                  min_version: "3.0.5",
                  prompt,
                  resolution,
                  type: "",
                  video_mode: 2,
                  idip_meta_list: [],
                }]
              },
              video_task_extra: metricsExtra,
            }
          },
          process_type: 1,
        }],
      }),
      http_common_info: { aid: assistantId },
    },
    headers: { Referer: "https://dreamina.capcut.com/" },
  });

  const historyId = aigc_data?.history_record_id;
  if (!historyId) throw new APIException(EX.API_IMAGE_GENERATION_FAILED, "记录ID不存在");

  if (onHistoryId) onHistoryId(historyId);
  const videoUrl = await pollHistoryForVideoUrl(historyId, refreshToken);
  return { url: videoUrl, historyId };
}

export async function generateInternationalVideo(
  _model: string,
  prompt: string = "",
  options: {
    ratio?: string;
    resolution?: string;
    duration?: number;
    filePaths?: string[];
    files?: any[];
  },
  refreshToken: string
) {
  const { url } = await generateInternationalVideoCore(_model, prompt, options, refreshToken);
  return url;
}
export async function generateInternationalSeedanceVideo(
  _model: string,
  prompt: string = "",
  {
    ratio = "4:3",
    resolution = "720p",
    duration = 4,
    filePaths = [],
    filesMap = {},
    body = {},
  }: {
    ratio?: string;
    resolution?: string;
    duration?: number;
    filePaths?: string[];
    filesMap?: Record<string, any[]>;
    body?: any;
  },
  refreshToken: string
) {
  if (!isInternationalSeedanceModel(_model)) {
    throw new APIException(EX.API_REQUEST_PARAMS_INVALID, `国际接口暂不支持模型: ${_model}`);
  }

  const regionInfo = parseRegionFromToken(refreshToken);
  if (regionInfo.isCN) throw new APIException(EX.API_REQUEST_FAILED, "国际 Seedance 接口仅接受国际 token（hk-/jp-/sg-/al-/az-/bh-/ca-/cl-/de-/gb-/gy-/iq-/it-/jo-/kg-/om-/pk-/sa-/se-/tr-/tz-/ve-）");
  if (regionInfo.isUS) throw new APIException(EX.API_REQUEST_FAILED, "US token 暂不支持国际 Seedance 2.0 / 2.0-fast");

  const actualDuration = Math.max(4, Math.min(15, duration));
  const { width, height } = resolveVideoResolution(resolution, ratio);
  const model = INTERNATIONAL_SEEDANCE_MODEL_MAP[_model];
  const assistantId = getAssistantId(regionInfo);
  const seed = Math.floor(Math.random() * 4294967296);
  const isFastModel = _model === "seedance-2.0-fast" || _model === "jimeng-video-seedance-2.0-fast";

  const { totalCredit } = await getCredit(refreshToken);
  if (totalCredit <= 0 && !isFastModel) {
    throw new APIException(
      EX.API_IMAGE_GENERATION_INSUFFICIENT_POINTS,
      "国际 Seedance 账户积分不足"
    );
  }
  if (totalCredit <= 0 && isFastModel) {
    logger.info("国际 Seedance-fast 当前积分为 0，仍继续尝试生成");
  }

  await request("post", "/mweb/v1/update_settings", refreshToken, {
    data: {
      custom_settings: {
        aigc_compliance_confirmed: true,
      },
    },
  });

  const materialRegistry: Map<string, any> = new Map();
  const promptHasExplicitRefs = /@(?:[A-Za-z_][A-Za-z0-9_]*|(?:图|image)?\d+)/.test(prompt || "");
  let materialIdx = 0;
  const canonicalKeys = new Set<string>(["image_file", "video_file"]);
  for (let i = 1; i <= 9; i++) canonicalKeys.add(`image_file_${i}`);
  for (let i = 1; i <= 3; i++) canonicalKeys.add(`video_file_${i}`);
  const registerAlias = (name: string, entry: any) => {
    if (name && !canonicalKeys.has(name) && !materialRegistry.has(name)) materialRegistry.set(name, entry);
  };

  const { imageFields, videoFields } = collectInternationalMaterialFields(filesMap, body);
  if (imageFields.length + videoFields.length + filePaths.length === 0) throw new APIException(EX.API_REQUEST_FAILED, "国际 Seedance 接口至少需要一个素材");
  if (imageFields.length + filePaths.length > 9) throw new APIException(EX.API_REQUEST_FAILED, "图片素材最多 9 个");
  if (videoFields.length > 3) throw new APIException(EX.API_REQUEST_FAILED, "视频素材最多 3 个");
  if (imageFields.length + videoFields.length + filePaths.length > 12) throw new APIException(EX.API_REQUEST_FAILED, "素材总数最多 12 个");

  for (const fieldName of imageFields) {
    const imageFile = filesMap?.[fieldName]?.[0];
    const imageUrl = body?.[fieldName];
    const imageUri = imageFile
      ? await uploadImageBufferForVideo(fs.readFileSync(imageFile.filepath), refreshToken, regionInfo)
      : await uploadInternationalImageUrl(imageUrl, refreshToken, regionInfo);
    const entry = { idx: materialIdx++, type: "image", fieldName, imageUri, imageWidth: width, imageHeight: height };
    materialRegistry.set(fieldName, entry);
    if (imageFile?.originalFilename) registerAlias(imageFile.originalFilename, entry);
  }

  let slotIndex = 1;
  for (const url of filePaths) {
    while (slotIndex <= 9 && materialRegistry.has(`image_file_${slotIndex}`)) slotIndex++;
    if (slotIndex > 9) break;
    const fieldName = `image_file_${slotIndex}`;
    const imageUri = await uploadInternationalImageUrl(url, refreshToken, regionInfo);
    materialRegistry.set(fieldName, { idx: materialIdx++, type: "image", fieldName, imageUri, imageWidth: width, imageHeight: height });
    slotIndex++;
  }

  for (const fieldName of videoFields) {
    const videoFile = filesMap?.[fieldName]?.[0];
    const videoUrl = body?.[fieldName];
    const vodResult = videoFile
      ? await uploadMediaForVideo(fs.readFileSync(videoFile.filepath), "video", refreshToken, videoFile.originalFilename, regionInfo)
      : await uploadInternationalVideoUrl(videoUrl, refreshToken, regionInfo);
    const entry = { idx: materialIdx++, type: "video", fieldName, videoResult: { vid: vodResult.vid, width: vodResult.width || 0, height: vodResult.height || 0, duration: vodResult.duration || 0, fps: vodResult.fps || 0 } };
    materialRegistry.set(fieldName, entry);
    if (videoFile?.originalFilename) registerAlias(videoFile.originalFilename, entry);
  }

  const orderedEntries = getCanonicalMaterialEntries(materialRegistry);
  const materialList = orderedEntries.map((entry) => {
    const base = { type: "", id: util.uuid() };
    if (entry.type === "image") {
      return {
        ...base,
        material_type: "image",
        image_info: {
          type: "image",
          id: util.uuid(),
          source_from: "upload",
          platform_type: 1,
          name: "",
          image_uri: entry.imageUri,
          aigc_image: { type: "", id: util.uuid() },
          width: entry.imageWidth || 0,
          height: entry.imageHeight || 0,
          format: "",
          uri: entry.imageUri,
        },
      };
    }
    return {
      ...base,
      material_type: "video",
      video_info: {
        type: "video",
        id: util.uuid(),
        source_from: "upload",
        name: "",
        vid: entry.videoResult.vid,
        fps: entry.videoResult.fps,
        width: entry.videoResult.width,
        height: entry.videoResult.height,
        duration: entry.videoResult.duration,
      },
    };
  });
  const materialTypes: number[] = [];
  for (const entry of orderedEntries) {
    if (entry.type === "image") {
      materialTypes.push(1);
    } else {
      materialTypes.push(2);
    }
  }

  const meta_list = parseOmniPrompt(prompt || "", materialRegistry);
  if (!promptHasExplicitRefs && meta_list.every((item) => item.meta_type === "text")) {
    for (const entry of orderedEntries) {
      meta_list.unshift({
        meta_type: entry.type,
        text: "",
        material_ref: entry.type === "image"
          ? { uri: entry.imageUri }
          : { vid: entry.videoResult?.vid },
      });
    }
  }
  const componentId = util.uuid();
  const submitId = util.uuid();
  const metricsExtra = JSON.stringify({ position: "page_bottom_box", isDefaultSeed: 1, originSubmitId: submitId, isRegenerate: false, enterFrom: "click", functionMode: "omni_reference", sceneOptions: JSON.stringify([{ type: "video", scene: "BasicVideoGenerateButton", modelReqKey: model, videoDuration: actualDuration, materialTypes }]) });

  const draftContent = JSON.stringify({
    type: "draft",
    id: util.uuid(),
    min_version: "3.3.9",
    min_features: ["AIGC_Video_UnifiedEdit"],
    is_from_tsn: true,
    version: "3.3.12",
    main_component_id: componentId,
    component_list: [{
      type: "video_base_component",
      id: componentId,
      min_version: "1.0.0",
      aigc_mode: "workbench",
      metadata: {
        type: "",
        id: util.uuid(),
        created_platform: 3,
        created_platform_version: "",
        created_time_in_ms: String(Date.now()),
        created_did: "",
      },
      generate_type: "gen_video",
      abilities: {
        type: "",
        id: util.uuid(),
        gen_video: {
          type: "",
          id: util.uuid(),
          text_to_video_params: {
            type: "",
            id: util.uuid(),
            video_gen_inputs: [{
              type: "",
              id: util.uuid(),
              min_version: "3.3.9",
              prompt: "",
              video_mode: 2,
              fps: 24,
              duration_ms: actualDuration * 1000,
              idip_meta_list: [],
              unified_edit_input: {
                type: "",
                id: util.uuid(),
                material_list: materialList,
                meta_list,
              },
            }],
            video_aspect_ratio: ratio,
            seed,
            model_req_key: model,
            priority: 0,
          },
          video_task_extra: metricsExtra,
        },
      },
      process_type: 1,
    }],
  });

  // 构建完整 URL（国际版 API 端点）
  const baseUrl = "https://mweb-api-sg.capcut.com";
  const generateQueryParams = new URLSearchParams({
    aid: String(assistantId),
    device_platform: "web",
    region: regionInfo.regionCode,
    os: "windows",
    commerce_with_input_video: "1",
    web_component_open_flag: "1",
    web_version: "7.5.0",
    aigc_features: "app_lip_sync",
    da_version: "3.3.12",
  });
  const generateUrl = `${baseUrl}/mweb/v1/aigc_draft/generate?${generateQueryParams.toString()}`;

  const generateBody = {
    submit_id: submitId,
    extend: {
      root_model: model,
      workspace_id: 0,
      m_video_commerce_info: {
        benefit_type: INTERNATIONAL_SEEDANCE_BENEFIT_TYPE_MAP[_model],
        resource_id: "generate_video",
        resource_id_type: "str",
        resource_sub_type: "aigc",
      },
      m_video_commerce_info_list: [{
        benefit_type: INTERNATIONAL_SEEDANCE_BENEFIT_TYPE_MAP[_model],
        resource_id: "generate_video",
        resource_id_type: "str",
        resource_sub_type: "aigc",
      }],
    },
    metrics_extra: metricsExtra,
    draft_content: draftContent,
    http_common_info: { aid: assistantId },
  };

  const token = await acquireToken(refreshToken);

  logger.info(`国际 Seedance generate payload: ${JSON.stringify(generateBody)}`);

  // 使用直接请求（带 MD5 签名 + X-Bogus/X-Gnarly 签名），通过 shark 安全验证
  logger.info(`国际 Seedance: 发送 generate 请求（使用 X-Bogus/X-Gnarly 签名）...`);
  const { aigc_data: generateData } = await request(
    "post",
    "/mweb/v1/aigc_draft/generate",
    refreshToken,
    {
      data: generateBody,
    }
  );

  const historyId = generateData?.history_record_id;
  if (!historyId) {
    throw new APIException(EX.API_IMAGE_GENERATION_FAILED, `记录ID不存在: ${JSON.stringify(generateData)}`);
  }

  logger.info(`国际 Seedance: 视频生成任务已提交，history_id: ${historyId}`);
  return pollHistoryForVideoUrl(historyId, refreshToken);
}

/**
 * 国际版 Seedance 视频生成（内部版，返回 historyId）
 * 将生成请求和轮询拆分，在获取到 historyId 后立即保存，以便重启恢复
 */
async function _generateInternationalSeedanceVideoWithHistoryId(
  _model: string,
  prompt: string,
  {
    ratio = "4:3",
    resolution = "720p",
    duration = 4,
    filePaths = [],
    filesMap = {},
    body = {},
  }: {
    ratio?: string;
    resolution?: string;
    duration?: number;
    filePaths?: string[];
    filesMap?: Record<string, any[]>;
    body?: any;
  },
  refreshToken: string,
  onHistoryId?: (historyId: string) => void
): Promise<{ url: string; historyId: string }> {
  const regionInfo = parseRegionFromToken(refreshToken);
  if (regionInfo.isCN) throw new APIException(EX.API_REQUEST_FAILED, "国际 Seedance 接口仅接受国际 token");
  if (regionInfo.isUS) throw new APIException(EX.API_REQUEST_FAILED, "US token 暂不支持国际 Seedance 2.0 / 2.0-fast");

  const actualDuration = Math.max(4, Math.min(15, duration));
  const { width, height } = resolveVideoResolution(resolution, ratio);
  const model = INTERNATIONAL_SEEDANCE_MODEL_MAP[_model];
  const assistantId = getAssistantId(regionInfo);
  const seed = Math.floor(Math.random() * 4294967296);
  const isFastModel = _model === "seedance-2.0-fast" || _model === "jimeng-video-seedance-2.0-fast";

  const { totalCredit } = await getCredit(refreshToken);
  if (totalCredit <= 0 && !isFastModel) {
    throw new APIException(EX.API_IMAGE_GENERATION_INSUFFICIENT_POINTS, "国际 Seedance 账户积分不足");
  }

  await request("post", "/mweb/v1/update_settings", refreshToken, {
    data: { custom_settings: { aigc_compliance_confirmed: true } },
  });

  // 素材上传逻辑（与 generateInternationalSeedanceVideo 一致）
  const materialRegistry: Map<string, any> = new Map();
  const promptHasExplicitRefs = /@(?:[A-Za-z_][A-Za-z0-9_]*|(?:图|image)?\d+)/.test(prompt || "");
  let materialIdx = 0;
  const canonicalKeys = new Set<string>(["image_file", "video_file"]);
  for (let i = 1; i <= 9; i++) canonicalKeys.add(`image_file_${i}`);
  for (let i = 1; i <= 3; i++) canonicalKeys.add(`video_file_${i}`);
  const registerAlias = (name: string, entry: any) => {
    if (name && !canonicalKeys.has(name) && !materialRegistry.has(name)) materialRegistry.set(name, entry);
  };

  const { imageFields, videoFields } = collectInternationalMaterialFields(filesMap, body);
  for (const fieldName of imageFields) {
    const imageFile = filesMap?.[fieldName]?.[0];
    const imageUrl = body?.[fieldName];
    const imageUri = imageFile
      ? await uploadImageBufferForVideo(fs.readFileSync(imageFile.filepath), refreshToken, regionInfo)
      : await uploadInternationalImageUrl(imageUrl, refreshToken, regionInfo);
    const entry = { idx: materialIdx++, type: "image", fieldName, imageUri, imageWidth: width, imageHeight: height };
    materialRegistry.set(fieldName, entry);
    if (imageFile?.originalFilename) registerAlias(imageFile.originalFilename, entry);
  }

  let slotIndex = 1;
  for (const url of filePaths) {
    while (slotIndex <= 9 && materialRegistry.has(`image_file_${slotIndex}`)) slotIndex++;
    if (slotIndex > 9) break;
    const fieldName = `image_file_${slotIndex}`;
    const imageUri = await uploadInternationalImageUrl(url, refreshToken, regionInfo);
    materialRegistry.set(fieldName, { idx: materialIdx++, type: "image", fieldName, imageUri, imageWidth: width, imageHeight: height });
    slotIndex++;
  }

  for (const fieldName of videoFields) {
    const videoFile = filesMap?.[fieldName]?.[0];
    const videoUrl = body?.[fieldName];
    const vodResult = videoFile
      ? await uploadMediaForVideo(fs.readFileSync(videoFile.filepath), "video", refreshToken, videoFile.originalFilename, regionInfo)
      : await uploadInternationalVideoUrl(videoUrl, refreshToken, regionInfo);
    const entry = { idx: materialIdx++, type: "video", fieldName, videoResult: { vid: vodResult.vid, width: vodResult.width || 0, height: vodResult.height || 0, duration: vodResult.duration || 0, fps: vodResult.fps || 0 } };
    materialRegistry.set(fieldName, entry);
    if (videoFile?.originalFilename) registerAlias(videoFile.originalFilename, entry);
  }

  const orderedEntries = getCanonicalMaterialEntries(materialRegistry);
  const materialList = orderedEntries.map((entry) => {
    const base = { type: "", id: util.uuid() };
    if (entry.type === "image") {
      return { ...base, material_type: "image", image_info: { type: "image", id: util.uuid(), source_from: "upload", platform_type: 1, name: "", image_uri: entry.imageUri, aigc_image: { type: "", id: util.uuid() }, width: entry.imageWidth || 0, height: entry.imageHeight || 0, format: "", uri: entry.imageUri } };
    }
    return { ...base, material_type: "video", video_info: { type: "video", id: util.uuid(), source_from: "upload", name: "", vid: entry.videoResult.vid, fps: entry.videoResult.fps, width: entry.videoResult.width, height: entry.videoResult.height, duration: entry.videoResult.duration } };
  });
  const materialTypes = orderedEntries.map(e => e.type === "image" ? 1 : 2);

  const meta_list = parseOmniPrompt(prompt || "", materialRegistry);
  if (!promptHasExplicitRefs && meta_list.every((item) => item.meta_type === "text")) {
    for (const entry of orderedEntries) {
      meta_list.unshift({
        meta_type: entry.type,
        text: "",
        material_ref: entry.type === "image" ? { uri: entry.imageUri } : { vid: entry.videoResult?.vid },
      });
    }
  }

  const componentId = util.uuid();
  const submitId = util.uuid();
  const metricsExtra = JSON.stringify({ position: "page_bottom_box", isDefaultSeed: 1, originSubmitId: submitId, isRegenerate: false, enterFrom: "click", functionMode: "omni_reference", sceneOptions: JSON.stringify([{ type: "video", scene: "BasicVideoGenerateButton", modelReqKey: model, videoDuration: actualDuration, materialTypes }]) });

  const draftContent = JSON.stringify({
    type: "draft", id: util.uuid(), min_version: "3.3.9", min_features: ["AIGC_Video_UnifiedEdit"], is_from_tsn: true, version: "3.3.12", main_component_id: componentId,
    component_list: [{ type: "video_base_component", id: componentId, min_version: "1.0.0", aigc_mode: "workbench", metadata: { type: "", id: util.uuid(), created_platform: 3, created_platform_version: "", created_time_in_ms: String(Date.now()), created_did: "" }, generate_type: "gen_video", abilities: { type: "", id: util.uuid(), gen_video: { type: "", id: util.uuid(), text_to_video_params: { type: "", id: util.uuid(), video_gen_inputs: [{ type: "", id: util.uuid(), min_version: "3.3.9", prompt: "", video_mode: 2, fps: 24, duration_ms: actualDuration * 1000, idip_meta_list: [], unified_edit_input: { type: "", id: util.uuid(), material_list: materialList, meta_list } }], video_aspect_ratio: ratio, seed, model_req_key: model, priority: 0 }, video_task_extra: metricsExtra } }, process_type: 1 }],
  });

  const generateBody = {
    submit_id: submitId,
    extend: { root_model: model, workspace_id: 0, m_video_commerce_info: { benefit_type: INTERNATIONAL_SEEDANCE_BENEFIT_TYPE_MAP[_model], resource_id: "generate_video", resource_id_type: "str", resource_sub_type: "aigc" }, m_video_commerce_info_list: [{ benefit_type: INTERNATIONAL_SEEDANCE_BENEFIT_TYPE_MAP[_model], resource_id: "generate_video", resource_id_type: "str", resource_sub_type: "aigc" }] },
    metrics_extra: metricsExtra,
    draft_content: draftContent,
    http_common_info: { aid: assistantId },
  };

  // 使用直接请求（带 MD5 签名 + X-Bogus/X-Gnarly 签名）
  logger.info(`异步任务-国际Seedance: 发送 generate 请求...`);
  const { aigc_data: generateData } = await request("post", "/mweb/v1/aigc_draft/generate", refreshToken, {
    params: {
      commerce_with_input_video: "1",
    },
    data: generateBody,
  });

  const historyId = generateData?.history_record_id;
  if (!historyId) throw new APIException(EX.API_IMAGE_GENERATION_FAILED, `记录ID不存在: ${JSON.stringify(generateData)}`);

  logger.info(`异步任务-国际Seedance: 生成请求已提交, historyId=${historyId}`);
  if (onHistoryId) onHistoryId(historyId);

  // 使用支持国际版的轮询函数
  const videoUrl = await pollHistoryForVideoUrl(historyId, refreshToken);
  return { url: videoUrl, historyId };
}

/**
 * 提交国际版异步视频生成任务
 */
export function submitInternationalAsyncVideoTask(
  model: string,
  prompt: string,
  options: {
    ratio?: string;
    resolution?: string;
    duration?: number;
    filePaths?: string[];
    files?: any[];
    filesMap?: Record<string, any[]>;
    body?: any;
  },
  refreshToken: string
): string {
  if (activeAsyncCount >= MAX_ASYNC_CONCURRENCY) {
    throw new APIException(EX.API_REQUEST_FAILED, `当前异步任务并发数已达上限 (${MAX_ASYNC_CONCURRENCY})，请稍后重试`);
  }

  if (!fs.existsSync(ASYNC_TASK_DIR)) {
    fs.mkdirSync(ASYNC_TASK_DIR, { recursive: true });
  }

  const taskId = util.uuid();
  const task: AsyncTask = {
    taskId,
    status: "processing",
    model,
    prompt,
    refreshToken,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  task._promise = new Promise<void>((resolve) => { task._resolve = resolve; });

  asyncTaskStore.set(taskId, task);
  saveTaskToFile(task);
  activeAsyncCount++;
  logger.info(`国际异步任务已创建: ${taskId}, 模型: ${model}, 当前并发: ${activeAsyncCount}/${MAX_ASYNC_CONCURRENCY}`);

  (async () => {
    try {
      let url: string;
      if (isInternationalSeedanceModel(model)) {
        const result = await _generateInternationalSeedanceVideoWithHistoryId(
          model, prompt, {
            ratio: options.ratio,
            resolution: options.resolution,
            duration: options.duration,
            filePaths: options.filePaths,
            filesMap: options.filesMap,
            body: options.body,
          }, refreshToken,
          (historyId) => {
            task.historyId = historyId;
            saveTaskToFile(task);
            logger.info(`国际异步任务: historyId 已保存, ${taskId} -> ${historyId}`);
          }
        );
        url = result.url;
      } else {
        const result = await generateInternationalVideoCore(
          model,
          prompt,
          {
            ratio: options.ratio,
            resolution: options.resolution,
            duration: options.duration,
            filePaths: options.filePaths,
            files: options.files,
          },
          refreshToken,
          (historyId) => {
            task.historyId = historyId;
            saveTaskToFile(task);
            logger.info(`国际异步任务-普通视频: historyId 已保存, ${taskId} -> ${historyId}`);
          }
        );
        url = result.url;
      }

      task.status = "succeeded";
      task.result = { url, revised_prompt: prompt };
      task.updatedAt = Date.now();
      saveTaskToFile(task);
      logger.info(`国际异步任务成功: ${taskId}, 视频URL: ${url}`);
    } catch (error: any) {
      const errorMsg = error?.message || "";
      if (errorMsg.includes("超时")) {
        task.updatedAt = Date.now();
        saveTaskToFile(task);
        logger.warn(`国际异步任务后台轮询超时，保持 processing 状态: ${taskId}, historyId=${task.historyId}`);
      } else {
        task.status = "failed";
        task.error = error instanceof APIException ? `[${error.code}] ${error.message}` : errorMsg || "未知错误";
        task.updatedAt = Date.now();
        saveTaskToFile(task);
        logger.error(`国际异步任务失败: ${taskId}, 错误: ${task.error}`);
      }
    } finally {
      activeAsyncCount--;
      if (task._resolve) task._resolve();
    }
  })();

  return taskId;
}

function buildMetaListFromPrompt(prompt: string, materials: Array<{ type: SeedanceMaterialType }>): Array<{meta_type: string, text?: string, material_ref?: {material_idx: number}}> {
  const metaList: Array<{meta_type: string, text?: string, material_ref?: {material_idx: number}}> = [];
  const materialCount = materials.length;

  // 匹配 @1, @2, @图1, @图2, @image1 等格式
  const placeholderRegex = /@(?:图|image)?(\d+)/gi;

  let lastIndex = 0;
  let match;

  while ((match = placeholderRegex.exec(prompt)) !== null) {
    // 添加占位符前的文本
    if (match.index > lastIndex) {
      const textBefore = prompt.substring(lastIndex, match.index);
      if (textBefore.trim()) {
        metaList.push({ meta_type: "text", text: textBefore });
      }
    }

    // 添加素材引用（使用对应素材的类型作为 meta_type）
    const materialIndex = parseInt(match[1]) - 1; // @1 对应 index 0
    if (materialIndex >= 0 && materialIndex < materialCount) {
      metaList.push({
        meta_type: materials[materialIndex].type,
        text: "",
        material_ref: { material_idx: materialIndex }
      });
    }

    lastIndex = match.index + match[0].length;
  }

  // 添加剩余的文本
  if (lastIndex < prompt.length) {
    const remainingText = prompt.substring(lastIndex);
    if (remainingText.trim()) {
      metaList.push({ meta_type: "text", text: remainingText });
    }
  }

  // 如果没有找到任何占位符，默认引用所有素材并附加整个prompt作为文本
  if (metaList.length === 0) {
    // 先添加所有素材引用
    for (let i = 0; i < materialCount; i++) {
      if (i === 0) {
        metaList.push({ meta_type: "text", text: "使用" });
      }
      metaList.push({
        meta_type: materials[i].type,
        text: "",
        material_ref: { material_idx: i }
      });
      if (i < materialCount - 1) {
        metaList.push({ meta_type: "text", text: "和" });
      }
    }
    // 添加描述文本
    if (prompt && prompt.trim()) {
      metaList.push({ meta_type: "text", text: `素材，${prompt}` });
    } else {
      metaList.push({ meta_type: "text", text: "素材生成视频" });
    }
  }

  return metaList;
}

/**
 * 独立的视频结果轮询函数
 * 用于继续轮询已有的 historyId，适用于任务恢复场景
 *
 * @param historyId 即梦平台的 history_record_id
 * @param refreshToken 刷新令牌
 * @param maxRetries 最大重试次数（默认120次）
 * @returns 视频URL
 */
async function pollVideoResult(
  historyId: string,
  refreshToken: string,
  maxRetries: number = 120
): Promise<string> {
  let status = 20, failCode, item_list = [];
  let retryCount = 0;

  logger.info(`轮询视频结果: historyId=${historyId}, maxRetries=${maxRetries}`);

  while (status === 20 && retryCount < maxRetries) {
    try {
      const result = await request("post", "/mweb/v1/get_history_by_ids", refreshToken, {
        data: { history_ids: [historyId] },
      });

      const responseStr = JSON.stringify(result);
      logger.info(`轮询响应摘要: ${responseStr.substring(0, 300)}...`);

      let historyData = result.history_list?.[0] || result[historyId];

      if (!historyData) {
        retryCount++;
        const waitTime = Math.min(2000 * (retryCount + 1), 30000);
        logger.info(`历史记录未找到，等待 ${waitTime}ms 后重试 (${retryCount}/${maxRetries})`);
        await new Promise((resolve) => setTimeout(resolve, waitTime));
        continue;
      }

      status = historyData.status;
      failCode = historyData.fail_code;
      item_list = historyData.item_list || [];

      logger.info(`轮询状态: status=${status}, failCode=${failCode || '无'}, items=${item_list.length}`);

      if (status === 30) {
        const error = failCode === 2038
          ? new APIException(EX.API_CONTENT_FILTERED, "内容被过滤")
          : new APIException(EX.API_IMAGE_GENERATION_FAILED, `生成失败，错误码: ${failCode}`);
        error.historyId = historyId;
        throw error;
      }

      if (status === 20) {
        const waitTime = 2000 * Math.min(retryCount + 1, 5);
        logger.info(`视频生成中，等待 ${waitTime}ms 后继续查询 (${retryCount + 1}/${maxRetries})`);
        await new Promise((resolve) => setTimeout(resolve, waitTime));
      }

      retryCount++;
    } catch (error) {
      if (error instanceof APIException) throw error;
      logger.error(`轮询出错: ${error.message}`);
      retryCount++;
      await new Promise((resolve) => setTimeout(resolve, 2000 * (retryCount + 1)));
    }
  }

  if (retryCount >= maxRetries && status === 20) {
    const error = new APIException(EX.API_IMAGE_GENERATION_FAILED, "视频生成超时");
    error.historyId = historyId;
    throw error;
  }

  // 尝试获取高质量视频URL
  const itemId = item_list?.[0]?.item_id
    || item_list?.[0]?.id
    || item_list?.[0]?.local_item_id
    || item_list?.[0]?.common_attr?.id;

  if (itemId) {
    try {
      const hqVideoUrl = await fetchHighQualityVideoUrl(String(itemId), refreshToken);
      if (hqVideoUrl) {
        logger.info(`视频生成成功（高质量），URL: ${hqVideoUrl}`);
        return hqVideoUrl;
      }
    } catch (error) {
      logger.warn(`获取高质量视频URL失败: ${error.message}`);
    }
  }

  // 回退：提取预览视频URL
  let videoUrl = item_list?.[0]?.video?.transcoded_video?.origin?.video_url
    || item_list?.[0]?.video?.play_url
    || item_list?.[0]?.video?.download_url
    || item_list?.[0]?.video?.url;

  if (!videoUrl) {
    const error = new APIException(EX.API_IMAGE_GENERATION_FAILED, "未能获取视频URL");
    error.historyId = historyId;
    throw error;
  }

  logger.info(`视频生成成功，URL: ${videoUrl}`);
  return videoUrl;
}

/**
 * 即时单次查询视频状态（不轮询）
 * 用于 on-demand 查询：当用户查询一个 processing 任务时，去即梦平台查一次
 * 如果视频已生成好，直接返回视频URL；否则返回 null
 *
 * @param historyId 即梦平台的 history_record_id
 * @param refreshToken 刷新令牌
 * @returns 视频URL（已完成）或 null（仍在处理中或失败）
 */
async function checkVideoStatusByHistoryId(
  historyId: string,
  refreshToken: string
): Promise<string | null> {
  try {
    const result = await request("post", "/mweb/v1/get_history_by_ids", refreshToken, {
      data: { history_ids: [historyId] },
    });

    let historyData = result.history_list?.[0] || result[historyId];
    if (!historyData) {
      logger.info(`即时查询: 未找到历史记录 historyId=${historyId}`);
      return null;
    }

    const status = historyData.status;
    const failCode = historyData.fail_code;
    const item_list = historyData.item_list || [];

    logger.info(`即时查询: historyId=${historyId}, status=${status}, failCode=${failCode || '无'}, items=${item_list.length}`);

    // status=20 表示还在处理中
    if (status === 20) {
      return null;
    }

    // status=30 表示生成失败
    if (status === 30) {
      logger.warn(`即时查询: 视频生成失败, historyId=${historyId}, failCode=${failCode}`);
      return null;
    }

    // status=10 或其他非20值，尝试提取视频URL
    // 尝试获取高质量视频URL
    const itemId = item_list?.[0]?.item_id
      || item_list?.[0]?.id
      || item_list?.[0]?.local_item_id
      || item_list?.[0]?.common_attr?.id;

    if (itemId) {
      try {
        const hqVideoUrl = await fetchHighQualityVideoUrl(String(itemId), refreshToken);
        if (hqVideoUrl) {
          logger.info(`即时查询: 获取高质量视频URL成功, historyId=${historyId}`);
          return hqVideoUrl;
        }
      } catch (error) {
        logger.warn(`即时查询: 获取高质量视频URL失败: ${error.message}`);
      }
    }

    // 回退：提取预览视频URL
    const videoUrl = item_list?.[0]?.video?.transcoded_video?.origin?.video_url
      || item_list?.[0]?.video?.play_url
      || item_list?.[0]?.video?.download_url
      || item_list?.[0]?.video?.url;

    if (videoUrl) {
      logger.info(`即时查询: 获取预览视频URL成功, historyId=${historyId}`);
      return videoUrl;
    }

    // item_list 非空但无法提取URL，可能还在处理中
    if (item_list.length === 0) {
      logger.info(`即时查询: item_list 为空，可能仍在处理, historyId=${historyId}`);
      return null;
    }

    logger.warn(`即时查询: item_list 非空但无法提取视频URL, historyId=${historyId}`);
    return null;
  } catch (error) {
    logger.error(`即时查询出错: historyId=${historyId}, ${error.message}`);
    return null;
  }
}

// ========== 异步视频生成任务管理 ==========

// 异步任务状态类型
type AsyncTaskStatus = "processing" | "succeeded" | "failed";

// 异步任务持久化接口（仅可序列化字段）
interface AsyncTaskData {
  taskId: string;
  status: AsyncTaskStatus;
  model: string;
  prompt: string;
  refreshToken: string;
  createdAt: number;
  updatedAt: number;
  historyId?: string;  // 即梦平台的 history_record_id，用于重启后继续轮询
  result?: {
    url?: string;
    b64_json?: string;
    revised_prompt?: string;
  };
  error?: string;
}

// 运行时任务接口（含内存中的 Promise 控制器）
interface AsyncTask extends AsyncTaskData {
  _resolve?: (value: void) => void;
  _promise?: Promise<void>;
}

function clearTaskRuntimeWaiters(task: AsyncTask): void {
  task._resolve = undefined;
  task._promise = undefined;
}

// 任务存储目录
const ASYNC_TASK_DIR = path.join(process.cwd(), "tmp", "async-tasks");

// 内存任务映射（从文件加载后使用）
const asyncTaskStore = new Map<string, AsyncTask>();

// 当前活跃异步任务数
let activeAsyncCount = 0;

// 最大并发数
const MAX_ASYNC_CONCURRENCY = 10;

// 任务过期时间（24小时，单位毫秒）
const TASK_EXPIRY_MS = 24 * 60 * 60 * 1000;

/**
 * 获取任务文件路径
 */
function taskFilePath(taskId: string): string {
  return path.join(ASYNC_TASK_DIR, `${taskId}.json`);
}

/**
 * 将任务数据持久化到文件
 */
function saveTaskToFile(task: AsyncTask): void {
  try {
    const data: AsyncTaskData = {
      taskId: task.taskId,
      status: task.status,
      model: task.model,
      prompt: task.prompt,
      refreshToken: task.refreshToken,
      createdAt: task.createdAt,
      updatedAt: task.updatedAt,
      historyId: task.historyId,
      result: task.result,
      error: task.error,
    };
    fs.writeFileSync(taskFilePath(task.taskId), JSON.stringify(data, null, 2), "utf-8");
  } catch (err) {
    logger.error(`保存任务文件失败: ${task.taskId}, ${err.message}`);
  }
}

/**
 * 从文件加载单个任务
 */
function loadTaskFromFile(filePath: string): AsyncTaskData | null {
  try {
    const raw = fs.readFileSync(filePath, "utf-8");
    return JSON.parse(raw) as AsyncTaskData;
  } catch (err) {
    logger.error(`加载任务文件失败: ${filePath}, ${err.message}`);
    return null;
  }
}

/**
 * 删除任务文件
 */
function deleteTaskFile(taskId: string): void {
  try {
    const fp = taskFilePath(taskId);
    if (fs.existsSync(fp)) {
      fs.unlinkSync(fp);
    }
  } catch (err) {
    logger.error(`删除任务文件失败: ${taskId}, ${err.message}`);
  }
}

/**
 * 启动时从文件恢复所有未完成任务
 * 恢复 processing 状态的任务并重新执行轮询
 */
function restoreTasksFromFiles(): void {
  try {
    if (!fs.existsSync(ASYNC_TASK_DIR)) {
      fs.mkdirSync(ASYNC_TASK_DIR, { recursive: true });
      return;
    }

    const files = fs.readdirSync(ASYNC_TASK_DIR).filter(f => f.endsWith(".json"));
    if (files.length === 0) return;

    logger.info(`发现 ${files.length} 个异步任务文件，开始恢复...`);

    for (const file of files) {
      const data = loadTaskFromFile(path.join(ASYNC_TASK_DIR, file));
      if (!data) continue;

      // 跳过已过期的任务
      if (Date.now() - data.updatedAt > TASK_EXPIRY_MS) {
        deleteTaskFile(data.taskId);
        logger.info(`恢复时清理过期任务: ${data.taskId}`);
        continue;
      }

      // 已成功/失败的任务直接加载到内存（不占用并发槽位）
      if (data.status !== "processing") {
        const task = data as AsyncTask;
        asyncTaskStore.set(data.taskId, task);
        logger.info(`恢复已完成任务: ${data.taskId}, 状态: ${data.status}`);
        continue;
      }

      // processing 状态的任务：恢复并重启轮询
      if (activeAsyncCount >= MAX_ASYNC_CONCURRENCY) {
        logger.warn(`恢复任务 ${data.taskId} 跳过：并发已满 ${activeAsyncCount}/${MAX_ASYNC_CONCURRENCY}`);
        // 仍加载到内存但不重启轮询，等有槽位时手动查询会触发
        const task = data as AsyncTask;
        asyncTaskStore.set(data.taskId, task);
        continue;
      }

      const task: AsyncTask = {
        ...data,
        _promise: undefined,
        _resolve: undefined,
      };
      // 创建 Promise 并将 resolve 绑定到 task._resolve
      task._promise = new Promise<void>((resolve) => {
        task._resolve = resolve;
      });
      asyncTaskStore.set(data.taskId, task);
      activeAsyncCount++;
      logger.info(`恢复并重启 processing 任务: ${data.taskId}, 当前并发: ${activeAsyncCount}/${MAX_ASYNC_CONCURRENCY}`);

      // 后台重新执行轮询
      restartPollingForTask(task);
    }

    logger.info(`任务恢复完成，当前活跃并发: ${activeAsyncCount}/${MAX_ASYNC_CONCURRENCY}`);
  } catch (err) {
    logger.error(`恢复任务文件出错: ${err.message}`);
  }
}

/**
 * 为恢复的 processing 任务重启轮询
 * 使用保存的 historyId 继续轮询，而不是重新提交生成请求
 * 超时后保持 processing 状态，等用户查询时做 on-demand 查询
 */
function restartPollingForTask(task: AsyncTask): void {
  (async () => {
    try {
      if (!task.historyId) {
        // 没有 historyId，无法恢复轮询，标记为失败
        task.status = "failed";
        task.error = "任务缺少 historyId，无法恢复轮询";
        task.updatedAt = Date.now();
        saveTaskToFile(task);
        logger.error(`恢复任务失败: ${task.taskId}, 缺少 historyId`);
        return;
      }

      logger.info(`恢复任务轮询: ${task.taskId}, historyId=${task.historyId}`);

      // 使用保存的 historyId 继续轮询
      const videoUrl = await pollVideoResult(task.historyId, task.refreshToken);

      task.status = "succeeded";
      task.result = { url: videoUrl, revised_prompt: task.prompt };
      task.updatedAt = Date.now();
      saveTaskToFile(task);
      logger.info(`恢复任务轮询成功: ${task.taskId}`);
    } catch (error: any) {
      // 超时错误：保持 processing 状态，不标记为 failed
      // 用户查询时会通过 on-demand 查询检查即梦平台的最新状态
      const errorMsg = error?.message || "";
      if (errorMsg.includes("超时")) {
        task.updatedAt = Date.now();
        saveTaskToFile(task); // 保存 historyId，保持 processing
        logger.warn(`恢复任务轮询超时，保持 processing 状态: ${task.taskId}, historyId=${task.historyId}，等待用户查询时 on-demand 检查`);
      } else {
        task.status = "failed";
        task.error = error instanceof APIException
          ? `[${error.code}] ${error.message}`
          : errorMsg || "未知错误";
        task.updatedAt = Date.now();
        saveTaskToFile(task);
        logger.error(`恢复任务轮询失败: ${task.taskId}, ${task.error}`);
      }
    } finally {
      activeAsyncCount--;
      if (task._resolve) task._resolve();
      clearTaskRuntimeWaiters(task);
    }
  })();
}

// 定期清理过期任务文件（每30分钟）
setInterval(() => {
  const now = Date.now();
  for (const [taskId, task] of asyncTaskStore) {
    if (now - task.updatedAt > TASK_EXPIRY_MS) {
      asyncTaskStore.delete(taskId);
      deleteTaskFile(taskId);
      logger.info(`异步任务已过期清理: ${taskId}`);
    }
  }
}, 30 * 60 * 1000);

// 启动时恢复任务
restoreTasksFromFiles();

/**
 * 普通视频生成（内部版，返回 historyId）
 * 将生成请求和轮询拆分，在获取到 historyId 后立即保存，以便重启恢复
 */
async function _generateVideoWithHistoryId(
  _model: string,
  prompt: string,
  options: {
    ratio?: string;
    resolution?: string;
    duration?: number;
    filePaths?: string[];
    files?: any[];
  },
  refreshToken: string,
  onHistoryId?: (historyId: string) => void
): Promise<{ url: string; historyId: string }> {
  const model = getModel(_model);
  const { ratio = "1:1", resolution = "720p", duration = 5, filePaths = [], files = [] } = options;
  const { width, height } = resolveVideoResolution(resolution, ratio);

  logger.info(`异步任务-普通视频: 模型=${_model} 映射=${model} ${width}x${height} (${ratio}@${resolution}) 时长=${duration}秒`);

  // 检查积分
  const { totalCredit } = await getCredit(refreshToken);
  if (totalCredit <= 0) await receiveCredit(refreshToken);

  // 处理首帧和尾帧图片
  let first_frame_image = undefined;
  let end_frame_image = undefined;

  if (files && files.length > 0) {
    let uploadIDs: string[] = [];
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      if (!file || !file.filepath) continue;
      try {
        const buffer = fs.readFileSync(file.filepath);
        const imageUri = await uploadImageBufferForVideo(buffer, refreshToken);
        if (imageUri) uploadIDs.push(imageUri);
      } catch (error) {
        if (i === 0) throw new APIException(EX.API_REQUEST_FAILED, `首帧文件上传失败: ${error.message}`);
      }
    }
    if (uploadIDs.length === 0) throw new APIException(EX.API_REQUEST_FAILED, '所有文件上传失败');
    if (uploadIDs[0]) {
      first_frame_image = { format: "", height, id: util.uuid(), image_uri: uploadIDs[0], name: "", platform_type: 1, source_from: "upload", type: "image", uri: uploadIDs[0], width };
    }
    if (uploadIDs[1]) {
      end_frame_image = { format: "", height, id: util.uuid(), image_uri: uploadIDs[1], name: "", platform_type: 1, source_from: "upload", type: "image", uri: uploadIDs[1], width };
    }
  } else if (filePaths && filePaths.length > 0) {
    let uploadIDs: string[] = [];
    for (let i = 0; i < filePaths.length; i++) {
      if (!filePaths[i]) continue;
      try {
        const imageUri = await uploadImageForVideo(filePaths[i], refreshToken);
        if (imageUri) uploadIDs.push(imageUri);
      } catch (error) {
        if (i === 0) throw new APIException(EX.API_REQUEST_FAILED, `首帧图片上传失败: ${error.message}`);
      }
    }
    if (uploadIDs.length === 0) throw new APIException(EX.API_REQUEST_FAILED, '所有图片上传失败');
    if (uploadIDs[0]) {
      first_frame_image = { format: "", height, id: util.uuid(), image_uri: uploadIDs[0], name: "", platform_type: 1, source_from: "upload", type: "image", uri: uploadIDs[0], width };
    }
    if (uploadIDs[1]) {
      end_frame_image = { format: "", height, id: util.uuid(), image_uri: uploadIDs[1], name: "", platform_type: 1, source_from: "upload", type: "image", uri: uploadIDs[1], width };
    }
  }

  const componentId = util.uuid();
  const metricsExtra = JSON.stringify({
    "enterFrom": "click", "isDefaultSeed": 1, "promptSource": "custom",
    "isRegenerate": false, "originSubmitId": util.uuid(),
  });
  const draftVersion = MODEL_DRAFT_VERSIONS[_model] || DEFAULT_DRAFT_VERSION;
  const gcd = (a: number, b: number): number => b === 0 ? a : gcd(b, a % b);
  const divisor = gcd(width, height);
  const aspectRatio = `${width / divisor}:${height / divisor}`;

  // 提交生成请求
  const { aigc_data } = await request("post", "/mweb/v1/aigc_draft/generate", refreshToken, {
    params: {
      aigc_features: "app_lip_sync", web_version: "6.6.0", da_version: draftVersion,
    },
    data: {
      "extend": {
        "root_model": end_frame_image ? MODEL_MAP['jimeng-video-3.0'] : model,
        "m_video_commerce_info": { benefit_type: "basic_video_operation_vgfm_v_three", resource_id: "generate_video", resource_id_type: "str", resource_sub_type: "aigc" },
        "m_video_commerce_info_list": [{ benefit_type: "basic_video_operation_vgfm_v_three", resource_id: "generate_video", resource_id_type: "str", resource_sub_type: "aigc" }]
      },
      "submit_id": util.uuid(),
      "metrics_extra": metricsExtra,
      "draft_content": JSON.stringify({
        "type": "draft", "id": util.uuid(), "min_version": "3.0.5", "is_from_tsn": true,
        "version": draftVersion, "main_component_id": componentId,
        "component_list": [{
          "type": "video_base_component", "id": componentId, "min_version": "1.0.0",
          "metadata": { "type": "", "id": util.uuid(), "created_platform": 3, "created_platform_version": "", "created_time_in_ms": Date.now(), "created_did": "" },
          "generate_type": "gen_video", "aigc_mode": "workbench",
          "abilities": {
            "type": "", "id": util.uuid(),
            "gen_video": {
              "id": util.uuid(), "type": "",
              "text_to_video_params": {
                "type": "", "id": util.uuid(), "model_req_key": model, "priority": 0,
                "seed": Math.floor(Math.random() * 100000000) + 2500000000,
                "video_aspect_ratio": aspectRatio,
                "video_gen_inputs": [{
                  duration_ms: duration * 1000, first_frame_image, end_frame_image,
                  fps: 24, id: util.uuid(), min_version: "3.0.5", prompt, resolution, type: "", video_mode: 2
                }]
              },
              "video_task_extra": metricsExtra,
            }
          }
        }],
      }),
      http_common_info: { aid: DEFAULT_ASSISTANT_ID },
    }
  });

  const historyId = aigc_data.history_record_id;
  if (!historyId) throw new APIException(EX.API_IMAGE_GENERATION_FAILED, "记录ID不存在");

  logger.info(`异步任务-普通视频: 生成请求已提交, historyId=${historyId}`);

  // 立即通知外部 historyId，确保即使后续轮询超时也能保存
  if (onHistoryId) onHistoryId(historyId);

  // 轮询获取结果（使用独立的轮询函数）
  const videoUrl = await pollVideoResult(historyId, refreshToken);
  return { url: videoUrl, historyId };
}

/**
 * Seedance 2.0 视频生成（内部版，返回 historyId）
 * 将生成请求和轮询拆分，在获取到 historyId 后立即保存，以便重启恢复
 */
async function _generateSeedanceVideoWithHistoryId(
  _model: string,
  prompt: string,
  options: {
    ratio?: string;
    resolution?: string;
    duration?: number;
    filePaths?: string[];
    files?: any[];
  },
  refreshToken: string,
  onHistoryId?: (historyId: string) => void
): Promise<{ url: string; historyId: string }> {
  const model = getModel(_model);
  const benefitType = SEEDANCE_BENEFIT_TYPE_MAP[_model] || "dreamina_video_seedance_20_pro";
  const { ratio = "4:3", resolution = "720p", duration = 4, filePaths = [], files = [] } = options;
  const actualDuration = duration || 4;
  const { width, height } = resolveVideoResolution(resolution, ratio);

  logger.info(`异步任务-Seedance: 模型=${_model} 映射=${model} ${width}x${height} (${ratio}@${resolution}) 时长=${actualDuration}秒`);

  // 检查积分
  const { totalCredit } = await getCredit(refreshToken);
  if (totalCredit <= 0) await receiveCredit(refreshToken);

  // 上传素材（复用 generateSeedanceVideo 中的逻辑）
  let uploadedMaterials: UploadedMaterial[] = [];

  if (files && files.length > 0) {
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      if (!file || !file.filepath) continue;
      const materialType = detectMaterialType(file);
      try {
        const buffer = fs.readFileSync(file.filepath);
        if (materialType === "image") {
          const imageUri = await uploadImageBufferForVideo(buffer, refreshToken);
          if (imageUri) uploadedMaterials.push({ type: "image", uri: imageUri, width, height });
        } else {
          const vodResult = await uploadMediaForVideo(buffer, materialType, refreshToken, file.originalFilename);
          uploadedMaterials.push({ type: materialType, vid: vodResult.vid, width: vodResult.width, height: vodResult.height, duration: vodResult.duration, fps: vodResult.fps, name: file.originalFilename || "" });
        }
      } catch (error) {
        if (i === 0) throw new APIException(EX.API_REQUEST_FAILED, `首个文件上传失败: ${error.message}`);
      }
    }
  } else if (filePaths && filePaths.length > 0) {
    for (let i = 0; i < filePaths.length; i++) {
      if (!filePaths[i]) continue;
      const materialType = detectMaterialTypeFromUrl(filePaths[i]);
      try {
        if (materialType === "image") {
          const imageUri = await uploadImageForVideo(filePaths[i], refreshToken);
          if (imageUri) uploadedMaterials.push({ type: "image", uri: imageUri, width, height });
        } else {
          const response = await fetch(filePaths[i]);
          if (!response.ok) throw new Error(`下载文件失败: ${response.status}`);
          const buffer = Buffer.from(await response.arrayBuffer());
          const vodResult = await uploadMediaForVideo(buffer, materialType, refreshToken);
          uploadedMaterials.push({ type: materialType, vid: vodResult.vid, width: vodResult.width, height: vodResult.height, duration: vodResult.duration, fps: vodResult.fps });
        }
      } catch (error) {
        if (i === 0) throw new APIException(EX.API_REQUEST_FAILED, `首个文件上传失败: ${error.message}`);
      }
    }
  }

  if (uploadedMaterials.length === 0) {
    throw new APIException(EX.API_REQUEST_FAILED, 'Seedance 2.0 需要至少一个文件');
  }

  // 构建请求参数（与 generateSeedanceVideo 相同）
  const hasVideoMaterial = uploadedMaterials.some(m => m.type === "video");
  const finalBenefitType = hasVideoMaterial ? `${benefitType}_with_video` : benefitType;

  const materialList = uploadedMaterials.map((mat) => {
    const base = { type: "", id: util.uuid() };
    if (mat.type === "image") {
      return { ...base, material_type: "image", image_info: { type: "image", id: util.uuid(), source_from: "upload", platform_type: 1, name: "", image_uri: mat.uri, aigc_image: { type: "", id: util.uuid() }, width: mat.width, height: mat.height, format: "", uri: mat.uri } };
    } else if (mat.type === "video") {
      return { ...base, material_type: "video", video_info: { type: "video", id: util.uuid(), source_from: "upload", name: mat.name || "", vid: mat.vid, fps: mat.fps || 0, width: mat.width || 0, height: mat.height || 0, duration: mat.duration || 0 } };
    } else {
      return { ...base, material_type: "audio", audio_info: { type: "audio", id: util.uuid(), source_from: "upload", vid: mat.vid, duration: mat.duration || 0, name: mat.name || "" } };
    }
  });

  const metaList = buildMetaListFromPrompt(prompt, uploadedMaterials);
  const componentId = util.uuid();
  const submitId = util.uuid();
  const draftVersion = MODEL_DRAFT_VERSIONS[_model] || "3.3.9";
  const gcd = (a: number, b: number): number => b === 0 ? a : gcd(b, a % b);
  const divisor = gcd(width, height);
  const aspectRatio = `${width / divisor}:${height / divisor}`;

  const metricsExtra = JSON.stringify({
    isDefaultSeed: 1, originSubmitId: submitId, isRegenerate: false, enterFrom: "click",
    position: "page_bottom_box", functionMode: "omni_reference",
    sceneOptions: JSON.stringify([{ type: "video", scene: "BasicVideoGenerateButton", modelReqKey: model, videoDuration: actualDuration, reportParams: { enterSource: "generate", vipSource: "generate", extraVipFunctionKey: model, useVipFunctionDetailsReporterHoc: true }, materialTypes: [...new Set(uploadedMaterials.map(m => MATERIAL_TYPE_CODE[m.type]))] }])
  });

  const token = await acquireToken(refreshToken);
  const generateQueryParams = new URLSearchParams({
    aid: String(CORE_ASSISTANT_ID), device_platform: "web", region: "cn",
    webId: String(WEB_ID), da_version: draftVersion, web_component_open_flag: "1",
    commerce_with_input_video: "1",
    web_version: "7.5.0", aigc_features: "app_lip_sync",
  });
  const generateUrl = `https://jimeng.jianying.com/mweb/v1/aigc_draft/generate?${generateQueryParams.toString()}`;
  const generateBody = {
    extend: {
      root_model: model,
      workspace_id: 0,
      m_video_commerce_info: { benefit_type: finalBenefitType, resource_id: "generate_video", resource_id_type: "str", resource_sub_type: "aigc" },
      m_video_commerce_info_list: [{ benefit_type: finalBenefitType, resource_id: "generate_video", resource_id_type: "str", resource_sub_type: "aigc" }]
    },
    submit_id: submitId, metrics_extra: metricsExtra,
    draft_content: JSON.stringify({
      type: "draft", id: util.uuid(), min_version: draftVersion, min_features: ["AIGC_Video_UnifiedEdit"],
      is_from_tsn: true, version: draftVersion, main_component_id: componentId,
      component_list: [{
        type: "video_base_component", id: componentId, min_version: "1.0.0", aigc_mode: "workbench",
        metadata: { type: "", id: util.uuid(), created_platform: 3, created_platform_version: "", created_time_in_ms: String(Date.now()), created_did: "" },
        generate_type: "gen_video",
        abilities: {
          type: "", id: util.uuid(),
          gen_video: {
            type: "", id: util.uuid(),
            text_to_video_params: {
              type: "", id: util.uuid(),
              video_gen_inputs: [{
                type: "", id: util.uuid(), min_version: draftVersion, prompt: "", video_mode: 2, fps: 24,
                duration_ms: actualDuration * 1000, idip_meta_list: [],
                unified_edit_input: { type: "", id: util.uuid(), material_list: materialList, meta_list: metaList }
              }],
              video_aspect_ratio: aspectRatio, seed: Math.floor(Math.random() * 1000000000), model_req_key: model, priority: 0
            },
            video_task_extra: metricsExtra
          }
        },
        process_type: 1
      }]
    }),
    http_common_info: { aid: CORE_ASSISTANT_ID },
  };

  logger.info(`异步任务-Seedance: 通过浏览器代理发送 generate 请求...`);
  const generateResult = await runGlobalImageGeneration(submitId, () => browserService.fetch(token, generateUrl, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify(generateBody),
  }));

  const { ret, errmsg, data: generateData } = generateResult;
  if (ret !== undefined && Number(ret) !== 0) {
    if (Number(ret) === 5000) {
      throw new APIException(EX.API_IMAGE_GENERATION_INSUFFICIENT_POINTS, `[无法生成视频]: 即梦积分可能不足，${errmsg}`);
    }
    throw new APIException(EX.API_REQUEST_FAILED, `[请求jimeng失败]: ${errmsg}`);
  }
  const aigc_data = generateData?.aigc_data || generateResult.aigc_data;
  const historyId = aigc_data.history_record_id;
  if (!historyId) throw new APIException(EX.API_IMAGE_GENERATION_FAILED, "记录ID不存在");

  logger.info(`异步任务-Seedance: 生成请求已提交, historyId=${historyId}`);

  // 立即通知外部 historyId，确保即使后续轮询超时也能保存
  if (onHistoryId) onHistoryId(historyId);

  // 轮询获取结果（使用独立的轮询函数）
  const videoUrl = await pollVideoResult(historyId, refreshToken);
  return { url: videoUrl, historyId };
}

/**
 * 提交异步视频生成任务
 * 调用生成接口后立即返回 taskId，后台执行轮询等待视频生成完成
 */
export function submitAsyncVideoTask(
  model: string,
  prompt: string,
  options: {
    ratio?: string;
    resolution?: string;
    duration?: number;
    filePaths?: string[];
    files?: any[];
  },
  refreshToken: string
): string {
  if (activeAsyncCount >= MAX_ASYNC_CONCURRENCY) {
    throw new APIException(
      EX.API_REQUEST_FAILED,
      `当前异步任务并发数已达上限 (${MAX_ASYNC_CONCURRENCY})，请稍后重试`
    );
  }

  // 确保任务目录存在
  if (!fs.existsSync(ASYNC_TASK_DIR)) {
    fs.mkdirSync(ASYNC_TASK_DIR, { recursive: true });
  }

  const taskId = util.uuid();
  const task: AsyncTask = {
    taskId,
    status: "processing",
    model,
    prompt,
    refreshToken,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  // 创建用于查询接口阻塞等待的 Promise
  task._promise = new Promise<void>((resolve) => {
    task._resolve = resolve;
  });

  asyncTaskStore.set(taskId, task);
  saveTaskToFile(task);
  activeAsyncCount++;
  logger.info(
    `异步任务已创建: ${taskId}, 模型: ${model}, 当前并发: ${activeAsyncCount}/${MAX_ASYNC_CONCURRENCY}`
  );

  // 后台执行视频生成（含轮询）
  (async () => {
    try {
      let videoUrl: string;
      if (isSeedanceModel(model)) {
        const seedanceDuration =
          options.duration === 5 ? 4 : options.duration;
        const seedanceRatio =
          options.ratio === "1:1" ? "4:3" : options.ratio;

        // 使用 Seedance 生成：先生成获取 historyId，通过回调立即保存，然后再轮询
        const { url } = await _generateSeedanceVideoWithHistoryId(
          model, prompt, {
            ratio: seedanceRatio,
            resolution: options.resolution,
            duration: seedanceDuration,
            filePaths: options.filePaths,
            files: options.files,
          }, refreshToken,
          // onHistoryId 回调：在获取到 historyId 后立即保存到 task 文件
          (historyId) => {
            task.historyId = historyId;
            saveTaskToFile(task);
            logger.info(`异步任务-Seedance: historyId 已保存, ${taskId} -> ${historyId}`);
          }
        );

        videoUrl = url;
      } else {
        // 普通视频生成：先生成获取 historyId，通过回调立即保存，然后再轮询
        const { url } = await _generateVideoWithHistoryId(
          model, prompt, {
            ratio: options.ratio,
            resolution: options.resolution,
            duration: options.duration,
            filePaths: options.filePaths,
            files: options.files,
          }, refreshToken,
          // onHistoryId 回调：在获取到 historyId 后立即保存到 task 文件
          (historyId) => {
            task.historyId = historyId;
            saveTaskToFile(task);
            logger.info(`异步任务-普通视频: historyId 已保存, ${taskId} -> ${historyId}`);
          }
        );

        videoUrl = url;
      }

      task.status = "succeeded";
      task.result = {
        url: videoUrl,
        revised_prompt: prompt,
      };
      task.updatedAt = Date.now();
      saveTaskToFile(task);
      logger.info(`异步任务成功: ${taskId}, 视频URL: ${videoUrl}`);
    } catch (error: any) {
      const errorMsg = error?.message || "";

      // 超时错误：保持 processing 状态，保存 historyId
      // 用户查询时会通过 on-demand 查询检查即梦平台最新状态
      if (errorMsg.includes("超时")) {
        task.updatedAt = Date.now();
        saveTaskToFile(task); // 保存 historyId，保持 processing
        logger.warn(`异步任务后台轮询超时，保持 processing 状态: ${taskId}, historyId=${task.historyId}，等待用户查询时 on-demand 检查`);
      } else {
        task.status = "failed";
        task.error = error instanceof APIException
          ? `[${error.code}] ${error.message}`
          : errorMsg || "未知错误";
        task.updatedAt = Date.now();
        saveTaskToFile(task);
        logger.error(`异步任务失败: ${taskId}, 错误: ${task.error}`);
      }
    } finally {
      activeAsyncCount--;
      // 通知查询接口任务已完成（succeeded/failed），或后台轮询已停止（超时保持processing）
      if (task._resolve) {
        task._resolve();
      }
      clearTaskRuntimeWaiters(task);
    }
  })();

  return taskId;
}

/**
 * 查询异步视频生成任务结果
 * - 如果后台轮询仍在进行中（有 _promise），阻塞等待完成
 * - 如果后台轮询已停止但任务仍为 processing（超时场景），做 on-demand 即时查询
 */
export async function queryAsyncVideoTask(
  taskId: string
): Promise<AsyncTask> {
  // 先从内存查找
  let task = asyncTaskStore.get(taskId);

  // 内存中没有，尝试从文件加载
  if (!task) {
    const fp = taskFilePath(taskId);
    if (!fs.existsSync(fp)) {
      throw new APIException(
        EX.API_REQUEST_PARAMS_INVALID,
        `任务ID不存在或已过期: ${taskId}`
      );
    }
    const data = loadTaskFromFile(fp);
    if (!data) {
      throw new APIException(
        EX.API_REQUEST_PARAMS_INVALID,
        `任务数据损坏: ${taskId}`
      );
    }
    task = data as AsyncTask;
    asyncTaskStore.set(taskId, task);
    logger.info(`从文件加载任务: ${taskId}, 状态: ${task.status}`);
  }

  // 已终态的任务直接返回
  if (task.status === "succeeded" || task.status === "failed") {
    return task;
  }

  // processing 状态的任务
  if (task.status === "processing") {
    // 如果后台轮询仍在进行中（有活跃的 Promise），阻塞等待
    if (task._promise) {
      logger.info(`查询接口等待后台轮询完成: ${taskId}`);
      await task._promise;
      if (task.status === "succeeded" || task.status === "failed") {
        return task;
      }
    }

    // 后台轮询已停止（超时或重启后的 processing 任务），做 on-demand 即时查询
    if (task.historyId) {
      logger.info(`on-demand 即时查询: ${taskId}, historyId=${task.historyId}`);
      const videoUrl = await checkVideoStatusByHistoryId(task.historyId, task.refreshToken);

      if (videoUrl) {
        // 视频已生成好！更新任务状态
        task.status = "succeeded";
        task.result = { url: videoUrl, revised_prompt: task.prompt };
        task.updatedAt = Date.now();
        saveTaskToFile(task);
        logger.info(`on-demand 查询发现视频已完成: ${taskId}, URL: ${videoUrl}`);
      } else {
        // 仍在处理中，保持 processing
        logger.info(`on-demand 查询: 视频仍在处理中, ${taskId}`);
      }
    } else {
      logger.warn(`processing 任务缺少 historyId，无法 on-demand 查询: ${taskId}`);
    }
  }

  return task;
}
