import { PassThrough } from "stream";
import path from "path";
import _ from "lodash";
import mime from "mime";
import axios, { AxiosRequestConfig, AxiosResponse } from "axios";

import { HttpsProxyAgent } from "https-proxy-agent";
import { SocksProxyAgent } from "socks-proxy-agent";
import APIException from "@/lib/exceptions/APIException.ts";
import EX from "@/api/consts/exceptions.ts";
import { createParser } from "eventsource-parser";
import logger from "@/lib/logger.ts";
import util from "@/lib/util.ts";
import { signXBogus } from "@/lib/x-bogus.ts";
import { getXGnarly } from "@/lib/x-gnarly.ts";
import { summarizeSensitiveResponseForLog } from "@/api/services/sensitive-log-redaction.ts";
import {
  runGlobalImageGeneration,
  runGlobalImageStatus,
} from "@/api/services/global-image-operation-gates.ts";

// 模型名称
const MODEL_NAME = "jimeng";
// 默认的AgentID
export const DEFAULT_ASSISTANT_ID = 513695;
export const DEFAULT_ASSISTANT_ID_INTERNATIONAL = 513641;
// 版本号
const VERSION_CODE = "8.4.0";
// 平台代码
const PLATFORM_CODE = "7";
// 设备ID
const DEVICE_ID = Math.random() * 999999999999999999 + 7000000000000000000;
// WebID
export const WEB_ID = Math.random() * 999999999999999999 + 7000000000000000000;
// 用户ID
export const USER_ID = util.uuid(false);
// 最大重试次数
const MAX_RETRY_COUNT = 3;
// 重试延迟
const RETRY_DELAY = 5000;
const BASE_URL_CN = "https://jimeng.jianying.com";
const BASE_URL_US_COMMERCE = "https://commerce.us.capcut.com";
const BASE_URL_HK_COMMERCE = "https://commerce-api-sg.capcut.com";
const BASE_URL_DREAMINA_US = "https://dreamina-api.us.capcut.com";
const BASE_URL_DREAMINA_HK = "https://mweb-api-sg.capcut.com";
const DA_VERSION = "3.3.9";
const WEB_VERSION = "7.5.0";
// 伪装headers
const FAKE_HEADERS = {
  Accept: "application/json, text/plain, */*",
  "Accept-Encoding": "gzip, deflate, br, zstd",
  "Accept-language": "zh-CN,zh;q=0.9",
  "App-Sdk-Version": "48.0.0",
  "Cache-control": "no-cache",
  Appid: DEFAULT_ASSISTANT_ID,
  Appvr: VERSION_CODE,
  Lan: "zh-Hans",
  Loc: "cn",
  Origin: "https://jimeng.jianying.com",
  Pragma: "no-cache",
  Priority: "u=1, i",
  Referer: "https://jimeng.jianying.com",
  Pf: PLATFORM_CODE,
  "Sec-Ch-Ua":
    '"Google Chrome";v="132", "Chromium";v="132", "Not_A Brand";v="8"',
  "Sec-Ch-Ua-Mobile": "?0",
  "Sec-Ch-Ua-Platform": '"Windows"',
  "Sec-Fetch-Dest": "empty",
  "Sec-Fetch-Mode": "cors",
  "Sec-Fetch-Site": "same-origin",
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36",
};
// 文件最大大小
const FILE_MAX_SIZE = 100 * 1024 * 1024;

// 支持的国际区域前缀 → (region, lan, loc) 映射
const INTERNATIONAL_REGION_MAP: Record<string, { region: string; lan: string; loc: string }> = {
  hk: { region: "HK", lan: "en", loc: "hk" },
  jp: { region: "JP", lan: "ja", loc: "jp" },
  sg: { region: "SG", lan: "en", loc: "sg" },
  al: { region: "AL", lan: "en", loc: "al" },
  az: { region: "AZ", lan: "en", loc: "az" },
  bh: { region: "BH", lan: "en", loc: "bh" },
  ca: { region: "CA", lan: "en", loc: "ca" },
  cl: { region: "CL", lan: "en", loc: "cl" },
  de: { region: "DE", lan: "en", loc: "de" },
  gb: { region: "GB", lan: "en", loc: "gb" },
  gy: { region: "GY", lan: "en", loc: "gy" },
  il: { region: "IL", lan: "en", loc: "il" },
  iq: { region: "IQ", lan: "en", loc: "iq" },
  it: { region: "IT", lan: "en", loc: "it" },
  jo: { region: "JO", lan: "en", loc: "jo" },
  kg: { region: "KG", lan: "en", loc: "kg" },
  om: { region: "OM", lan: "en", loc: "om" },
  pk: { region: "PK", lan: "en", loc: "pk" },
  pt: { region: "PT", lan: "en", loc: "pt" },
  sa: { region: "SA", lan: "en", loc: "sa" },
  se: { region: "SE", lan: "en", loc: "se" },
  tr: { region: "TR", lan: "en", loc: "tr" },
  tz: { region: "TZ", lan: "en", loc: "tz" },
  uz: { region: "UZ", lan: "en", loc: "uz" },
  ve: { region: "VE", lan: "en", loc: "ve" },
  xk: { region: "XK", lan: "en", loc: "xk" },
};

export interface RegionInfo {
  isUS: boolean;
  regionCode: string; // 2-letter uppercase region code (CN for domestic, uppercase prefix for international)
  isInternational: boolean;
  isCN: boolean;
}

export interface TokenWithProxy {
  token: string;
  proxyUrl: string | null;
}

export function parseRegionFromToken(refreshToken: string): RegionInfo {
  const token = refreshToken.toLowerCase();
  const isUS = token.startsWith("us-");
  // 尝试匹配 2 字母国际区域前缀 (xx-)
  const prefixMatch = token.match(/^([a-z]{2})-/);
  let regionCode = "CN";
  let isInternational = false;
  if (prefixMatch && INTERNATIONAL_REGION_MAP[prefixMatch[1]]) {
    regionCode = INTERNATIONAL_REGION_MAP[prefixMatch[1]].region;
    isInternational = true;
  }
  if (isUS) {
    regionCode = "US";
    isInternational = true;
  }

  return {
    isUS,
    regionCode,
    isInternational,
    isCN: !isInternational,
  };
}

export function getAssistantId(regionInfo: RegionInfo): number {
  if (regionInfo.isInternational) return DEFAULT_ASSISTANT_ID_INTERNATIONAL;
  return DEFAULT_ASSISTANT_ID;
}

export function generateCookie(refreshToken: string) {
  const regionInfo = parseRegionFromToken(refreshToken);
  const token = regionInfo.isInternational ? refreshToken.substring(3) : refreshToken;

  return [
    `_tea_web_id=${WEB_ID}`,
    `is_staff_user=false`,
    ...(regionInfo.isCN ? [`store-region=cn-gd`, `store-region-src=uid`] : []),
    `sid_guard=${token}%7C${util.unixTimestamp()}%7C5184000%7CMon%2C+03-Feb-2025+08%3A17%3A09+GMT`,
    `uid_tt=${USER_ID}`,
    `uid_tt_ss=${USER_ID}`,
    `sid_tt=${token}`,
    `sessionid=${token}`,
    `sessionid_ss=${token}`,
    `sid_tt=${token}`
  ].join("; ");
}

/**
 * 获取浏览器格式的cookie数组（用于Playwright context.addCookies）
 */
export function getCookiesForBrowser(refreshToken: string) {
  const domain = ".jianying.com";
  return [
    { name: "_tea_web_id", value: String(WEB_ID), domain, path: "/" },
    { name: "is_staff_user", value: "false", domain, path: "/" },
    { name: "store-region", value: "cn-gd", domain, path: "/" },
    { name: "store-region-src", value: "uid", domain, path: "/" },
    { name: "uid_tt", value: USER_ID, domain, path: "/" },
    { name: "uid_tt_ss", value: USER_ID, domain, path: "/" },
    { name: "sid_tt", value: refreshToken, domain, path: "/" },
    { name: "sessionid", value: refreshToken, domain, path: "/" },
    { name: "sessionid_ss", value: refreshToken, domain, path: "/" },
  ];
}

/**
 * 获取国际版浏览器格式的cookie数组（用于Playwright context.addCookies）
 */
export function getCookiesForBrowserInternational(refreshToken: string) {
  const regionInfo = parseRegionFromToken(refreshToken);
  const token = regionInfo.isInternational ? refreshToken.substring(3) : refreshToken;
  const domain = ".capcut.com";

  return [
    { name: "_tea_web_id", value: String(WEB_ID), domain, path: "/" },
    { name: "is_staff_user", value: "false", domain, path: "/" },
    { name: "uid_tt", value: USER_ID, domain, path: "/" },
    { name: "uid_tt_ss", value: USER_ID, domain, path: "/" },
    { name: "sid_tt", value: token, domain, path: "/" },
    { name: "sessionid", value: token, domain, path: "/" },
    { name: "sessionid_ss", value: token, domain, path: "/" },
    { name: "sid_guard", value: `${token}%7C${util.unixTimestamp()}%7C5184000%7CMon%2C+03-Feb-2025+08%3A17%3A09+GMT`, domain, path: "/" },
  ];
}

/**
 * 获取积分信息
 *
 * @param refreshToken 用于刷新access_token的refresh_token
 */
export async function getCredit(refreshToken: string) {
  const {
    credit: { gift_credit, purchase_credit, vip_credit }
  } = await request("POST", "/commerce/v1/benefits/user_credit", refreshToken, {
    data: {},
    headers: {
      // Cookie: 'x-web-secsdk-uid=ef44bd0d-0cf6-448c-b517-fd1b5a7267ba; s_v_web_id=verify_m4b1lhlu_DI8qKRlD_7mJJ_4eqx_9shQ_s8eS2QLAbc4n; passport_csrf_token=86f3619c0c4a9c13f24117f71dc18524; passport_csrf_token_default=86f3619c0c4a9c13f24117f71dc18524; n_mh=9-mIeuD4wZnlYrrOvfzG3MuT6aQmCUtmr8FxV8Kl8xY; sid_guard=aabbddddddddddddddd%7C1733386629%7C5184000%7CMon%2C+03-Feb-2025+08%3A17%3A09+GMT; uid_tt=59a46c7d3f34bda9588b93590cca2e12; uid_tt_ss=59a46c7d3f34bda9588b93590cca2e12; sid_tt=aabbddddddddddddddd; sessionid=aabbddddddddddddddd; sessionid_ss=aabbddddddddddddddd; is_staff_user=false; sid_ucp_v1=1.0.0-KGRiOGY2ODQyNWU1OTk3NzRhYTE2ZmZhYmFjNjdmYjY3NzRmZGRiZTgKHgjToPCw0cwbEIXDxboGGJ-tHyAMMITDxboGOAhAJhoCaGwiIGE3ZWI3NDVhZWM0NGJiMzE4NmRiYzIwODNlYTllMWE2; ssid_ucp_v1=1.0.0-KGRiOGY2ODQyNWU1OTk3NzRhYTE2ZmZhYmFjNjdmYjY3NzRmZGRiZTgKHgjToPCw0cwbEIXDxboGGJ-tHyAMMITDxboGOAhAJhoCaGwiIGE3ZWI3NDVhZWM0NGJiMzE4NmRiYzIwODNlYTllMWE2; store-region=cn-gd; store-region-src=uid; user_spaces_idc={"7444764277623653426":"lf"}; ttwid=1|cxHJViEev1mfkjntdMziir8SwbU8uPNVSaeh9QpEUs8|1733966961|d8d52f5f56607427691be4ac44253f7870a34d25dd05a01b4d89b8a7c5ea82ad; _tea_web_id=7444838473275573797; fpk1=fa6c6a4d9ba074b90003896f36b6960066521c1faec6a60bdcb69ec8ddf85e8360b4c0704412848ec582b2abca73d57a; odin_tt=efe9dc150207879b88509e651a1c4af4e7ffb4cfcb522425a75bd72fbf894eda570bbf7ffb551c8b1de0aa2bfa0bd1be6c4157411ecdcf4464fcaf8dd6657d66',
      Referer: "https://jimeng.jianying.com/ai-tool/image/generate",
      // "Device-Time": 1733966964,
      // Sign: "f3dbb824b378abea7c03cbb152b3a365"
    }
  });
  logger.info(`\n积分信息: \n赠送积分: ${gift_credit}, 购买积分: ${purchase_credit}, VIP积分: ${vip_credit}`);
  return {
    giftCredit: gift_credit,
    purchaseCredit: purchase_credit,
    vipCredit: vip_credit,
    totalCredit: gift_credit + purchase_credit + vip_credit
  }
}

/**
 * 接收今日积分
 *
 * @param refreshToken 用于刷新access_token的refresh_token
 */
export async function receiveCredit(refreshToken: string) {
  logger.info("正在收取今日积分...")
  const { cur_total_credits, receive_quota  } = await request("POST", "/commerce/v1/benefits/credit_receive", refreshToken, {
    data: {
      time_zone: "Asia/Shanghai"
    },
    headers: {
      Referer: "https://jimeng.jianying.com/ai-tool/image/generate"
    }
  });
  logger.info(`\n今日${receive_quota}积分收取成功\n剩余积分: ${cur_total_credits}`);
  return cur_total_credits;
}

/**
 * 请求jimeng
 *
 * @param method 请求方法
 * @param uri 请求路径
 * @param params 请求参数
 * @param headers 请求头
 */
export async function request(
  method: string,
  uri: string,
  refreshToken: string,
  options: AxiosRequestConfig = {}
) {
  const regionInfo = parseRegionFromToken(refreshToken);
  const rawToken = regionInfo.isInternational ? refreshToken.substring(3) : refreshToken;
  const token = await acquireToken(rawToken);
  const deviceTime = util.unixTimestamp();
  const sign = util.md5(
    `9e2c|${uri.slice(-7)}|${PLATFORM_CODE}|${VERSION_CODE}|${deviceTime}||11ac`
  );

  let baseUrl = BASE_URL_CN;
  let region = "cn";
  let lan = "zh-Hans";
  let loc = "cn";
  if (regionInfo.isUS) {
    baseUrl = uri.startsWith("/commerce/") ? BASE_URL_US_COMMERCE : BASE_URL_DREAMINA_US;
    region = "US";
    lan = "en";
    loc = "us";
  } else if (regionInfo.isInternational) {
    const prefix = refreshToken.substring(0, 2).toLowerCase();
    const regionCfg = INTERNATIONAL_REGION_MAP[prefix];
    baseUrl = uri.startsWith("/commerce/") ? BASE_URL_HK_COMMERCE : BASE_URL_DREAMINA_HK;
    region = regionCfg?.region || "HK";
    lan = regionCfg?.lan || "en";
    loc = regionCfg?.loc || "hk";
  }

  const origin = new URL(baseUrl).origin;
  const fullUrl = `${baseUrl}${uri}`;
  const requestParams = {
    aid: getAssistantId(regionInfo),
    device_platform: "web",
    region,
    ...(regionInfo.isInternational ? {} : { webId: WEB_ID }),
    da_version: DA_VERSION,
    os: "windows",
    web_component_open_flag: 1,
    web_version: WEB_VERSION,
    aigc_features: "app_lip_sync",
    ...(options.params || {}),
  };

  const headers = {
    ...FAKE_HEADERS,
    Appid: getAssistantId(regionInfo),
    Lan: lan,
    Loc: loc,
    Origin: origin,
    Referer: origin,
    Cookie: generateCookie(refreshToken),
    "Device-Time": deviceTime,
    Sign: sign,
    "Sign-Ver": "1",
    Tdid: "",
    ...(options.headers || {}),
  };

  // 国际版请求：添加 X-Bogus / X-Gnarly 签名以通过 shark 安全验证
  let signedParams = { ...requestParams };
  let signedHeaders = { ...headers };
  let signedUrl = fullUrl;
  if (regionInfo.isInternational || regionInfo.isUS) {
    const userAgent = FAKE_HEADERS["User-Agent"];
    // 构建查询字符串用于签名（保持和 axios 序列化一致的顺序）
    const qsParts = Object.entries(requestParams).map(([k, v]) => `${k}=${v}`);
    const queryString = qsParts.join("&");
    const bodyString = options.data ? JSON.stringify(options.data) : "";
    // 生成 X-Bogus（直接拼到 URL，避免 axios URL 编码破坏自定义 base64 字符）
    const signedQS = signXBogus(queryString, userAgent, bodyString);
    signedUrl = `${baseUrl}${uri}?${signedQS}`;
    // 不再通过 params 传递，改用直接拼 URL
    signedParams = {};
    // 生成 X-Gnarly（添加到请求头）
    const xGnarly = getXGnarly(queryString, bodyString, userAgent);
    signedHeaders["X-Gnarly"] = xGnarly;
    logger.info("已添加 X-Bogus 和 X-Gnarly 签名");
  }

  logger.info(`发送请求: ${method.toUpperCase()} ${fullUrl}`);
  logger.info(`请求参数: ${JSON.stringify(signedParams)}`);
  logger.info(`请求数据摘要: ${summarizeSensitiveResponseForLog(options.data || {})}`);

  const isImageGenerationSubmit = uri === "/mweb/v1/aigc_draft/generate";
  const isImageStatusQuery = uri === "/mweb/v1/get_history_by_ids";
  const operationOwnerKey = String(
    (options as any)?.data?.submit_id ||
    (options as any)?.data?.history_ids?.[0] ||
    `${uri}:${deviceTime}`
  );
  const beforeRemoteSubmit = typeof (options as any).onBeforeRemoteSubmit === "function"
    ? (options as any).onBeforeRemoteSubmit as () => Promise<void> | void
    : undefined;
  let remoteSubmitBoundaryPersisted = false;
  const runImageOperation = async <T>(work: () => Promise<T>): Promise<T> => {
    if (isImageGenerationSubmit) {
      return runGlobalImageGeneration(operationOwnerKey, async () => {
        if (beforeRemoteSubmit && !remoteSubmitBoundaryPersisted) {
          await beforeRemoteSubmit();
          remoteSubmitBoundaryPersisted = true;
        }
        return work();
      });
    }
    if (isImageStatusQuery) return runGlobalImageStatus(operationOwnerKey, work);
    return work();
  };

  // A generate transport failure is UNKNOWN. Never replay the paid POST
  // inside the generic request helper; the ledger/status path owns recovery.
  let retries = 0;
  const maxRetries = isImageGenerationSubmit ? 0 : 3;
  let lastError = null;

  while (retries <= maxRetries) {
    try {
      if (retries > 0) {
        logger.info(`第 ${retries} 次重试请求: ${method.toUpperCase()} ${fullUrl}`);
        // 重试前等待一段时间
        await new Promise(resolve => setTimeout(resolve, 1000 * retries));
      }

      const response = await runImageOperation(() => axios.request({
        method,
        url: signedUrl,
        params: signedParams,
        headers: signedHeaders,
        timeout: 45000, // 增加超时时间到45秒
        validateStatus: () => true, // 允许任何状态码
        ..._.omit(options, "params", "headers", "onBeforeRemoteSubmit"),
      }));

      // 记录响应状态和头信息
      logger.info(`响应状态: ${response.status} ${response.statusText}`);

      // 流式响应直接返回response
      if (options.responseType == "stream") return response;

      // 记录响应数据摘要
      const responseDataSummary = summarizeSensitiveResponseForLog(response.data);
      logger.info(`响应数据摘要: ${responseDataSummary}`);

      // 检查HTTP状态码
      if (response.status >= 400) {
        logger.warn(`HTTP错误: ${response.status} ${response.statusText}`);
        if (retries < maxRetries) {
          retries++;
          continue;
        }
      }

      return checkResult(response);
    }
    catch (error) {
      lastError = error;
      logger.error(`请求失败 (尝试 ${retries + 1}/${maxRetries + 1}): ${error.message}`);

      // 如果是网络错误或超时，尝试重试
      if ((error.code === 'ECONNABORTED' || error.code === 'ETIMEDOUT' ||
           error.message.includes('timeout') || error.message.includes('network')) &&
          retries < maxRetries) {
        retries++;
        continue;
      }

      // 其他错误直接抛出
      break;
    }
  }

  // 所有重试都失败了，抛出最后一个错误
  logger.error(`请求失败，已重试 ${retries} 次: ${lastError.message}`);
  if (lastError.response) {
    logger.error(`响应状态: ${lastError.response.status}`);
    logger.error(`响应数据摘要: ${summarizeSensitiveResponseForLog(lastError.response.data)}`);
  }
   throw lastError;
 }

 /**
  * 预检查文件URL有效性
  *
  * @param fileUrl 文件URL
  */
 export async function checkFileUrl(fileUrl: string) {
  if (util.isBASE64Data(fileUrl)) return;
  const result = await axios.head(fileUrl, {
    timeout: 15000,
    validateStatus: () => true,
  });
  if (result.status >= 400)
    throw new APIException(
      EX.API_FILE_URL_INVALID,
      `File ${fileUrl} is not valid: [${result.status}] ${result.statusText}`
    );
  // 检查文件大小
  if (result.headers && result.headers["content-length"]) {
    const fileSize = parseInt(result.headers["content-length"], 10);
    if (fileSize > FILE_MAX_SIZE)
      throw new APIException(
        EX.API_FILE_EXECEEDS_SIZE,
        `File ${fileUrl} is not valid`
      );
  }
}

/**
 * 上传文件
 *
 * @param refreshToken 用于刷新access_token的refresh_token
 * @param fileUrl 文件URL或BASE64数据
 * @param isVideoImage 是否是用于视频图像
 * @returns 上传结果，包含image_uri
 */
export async function uploadFile(
  refreshToken: string,
  fileUrl: string,
  isVideoImage: boolean = false
) {
  try {
    logger.info(`开始上传文件: ${fileUrl}, 视频图像模式: ${isVideoImage}`);

    // 预检查远程文件URL可用性
    await checkFileUrl(fileUrl);

    let filename, fileData, mimeType;
    // 如果是BASE64数据则直接转换为Buffer
    if (util.isBASE64Data(fileUrl)) {
      mimeType = util.extractBASE64DataFormat(fileUrl);
      const ext = mime.getExtension(mimeType);
      filename = `${util.uuid()}.${ext}`;
      fileData = Buffer.from(util.removeBASE64DataHeader(fileUrl), "base64");
      logger.info(`处理BASE64数据，文件名: ${filename}, 类型: ${mimeType}, 大小: ${fileData.length}字节`);
    }
    // 下载文件到内存，如果您的服务器内存很小，建议考虑改造为流直传到下一个接口上，避免停留占用内存
    else {
      filename = path.basename(fileUrl);
      logger.info(`开始下载远程文件: ${fileUrl}`);
      ({ data: fileData } = await axios.get(fileUrl, {
        responseType: "arraybuffer",
        // 100M限制
        maxContentLength: FILE_MAX_SIZE,
        // 60秒超时
        timeout: 60000,
      }));
      logger.info(`文件下载完成，文件名: ${filename}, 大小: ${fileData.length}字节`);
    }

    // 获取文件的MIME类型
    mimeType = mimeType || mime.getType(filename);
    logger.info(`文件MIME类型: ${mimeType}`);

    // 构建FormData
    const formData = new FormData();
    const blob = new Blob([fileData], { type: mimeType });
    formData.append('file', blob, filename);

    // 获取上传凭证
    logger.info(`请求上传凭证，场景: ${isVideoImage ? 'video_cover' : 'aigc_image'}`);
    const uploadProofUrl = 'https://imagex.bytedanceapi.com/';
    const proofResult = await request(
      'POST',
      '/mweb/v1/get_upload_image_proof',
      refreshToken,
      {
        data: {
          scene: isVideoImage ? 'video_cover' : 'aigc_image',
          file_name: filename,
          file_size: fileData.length,
        }
      }
    );

    if (!proofResult || !proofResult.proof_info) {
      logger.error(`获取上传凭证失败: ${JSON.stringify(proofResult)}`);
      throw new APIException(EX.API_REQUEST_FAILED, '获取上传凭证失败');
    }

    logger.info(`获取上传凭证成功`);

    // 上传文件
    const { proof_info } = proofResult;
    logger.info("开始上传文件");

    const uploadResult = await axios.post(
      uploadProofUrl,
      formData,
      {
        headers: {
          ...proof_info.headers,
          'Content-Type': 'multipart/form-data',
        },
        params: proof_info.query_params,
        timeout: 60000,
        validateStatus: () => true, // 允许任何状态码以便详细处理
      }
    );

    logger.info(`上传响应状态: ${uploadResult.status}`);

    if (!uploadResult || uploadResult.status !== 200) {
      logger.error(`上传文件失败: 状态码 ${uploadResult?.status}`);
      throw new APIException(EX.API_REQUEST_FAILED, `上传文件失败: 状态码 ${uploadResult?.status}`);
    }

    // 验证 proof_info.image_uri 是否存在
    if (!proof_info.image_uri) {
      logger.error("上传凭证中缺少 image_uri");
      throw new APIException(EX.API_REQUEST_FAILED, '上传凭证中缺少 image_uri');
    }

    logger.info("文件上传成功");

    // 返回上传结果
    return {
      image_uri: proof_info.image_uri,
      uri: proof_info.image_uri,
    }
  } catch (error) {
    logger.error("文件上传过程中发生错误");
    throw error;
  }
}

/**
 * 检查请求结果
 *
 * @param result 结果
 */
export function checkResult(result: AxiosResponse) {
  const { ret, errmsg, data } = result.data;
  if (ret === '' && errmsg === '') return data ?? result.data;
  if (!_.isFinite(Number(ret))) return result.data;
  if (ret === '0') return data;
  if (ret === '5000')
    throw new APIException(EX.API_IMAGE_GENERATION_INSUFFICIENT_POINTS, `[无法生成图像]: 即梦积分可能不足，${errmsg}`);
  throw new APIException(EX.API_REQUEST_FAILED, `[请求jimeng失败]: ${errmsg}`);
}

/**
 * Token切分
 *
 * @param authorization 认证字符串
 */
export function tokenSplit(authorization: string) {
  return authorization.replace("Bearer ", "").split(",");
}

export async function acquireToken(refreshToken: string) {
  return parseRegionFromToken(refreshToken).isInternational
    ? refreshToken.substring(3)
    : refreshToken;
}

/**
 * 获取Token存活状态
 */
export async function getTokenLiveStatus(refreshToken: string) {
  const result = await request(
    "POST",
    "/passport/account/info/v2",
    refreshToken,
    {
      params: {
        account_sdk_source: "web",
      },
    }
  );
  try {
    const { user_id } = checkResult(result);
    return !!user_id;
  } catch (err) {
    return false;
  }
}
