const assert = require("node:assert/strict");
const test = require("node:test");

const { patchCore, patchVideos } = require("../patches/scripts/add-global-image-operation-gates.cjs");

function coreFixture() {
  return [
    'import { summarizeSensitiveResponseForLog } from "@/api/services/sensitive-log-redaction.ts";',
    'export async function request(method, uri, refreshToken, options = {}) {',
    '  const deviceTime = 1;',
    '  const signedUrl = "https://example.test";',
    '  const signedParams = {};',
    '  const signedHeaders = {};',
    '  const fullUrl = signedUrl;',
    '  logger.info(`发送请求: ${method.toUpperCase()} ${fullUrl}`);',
    '  logger.info(`请求参数: ${JSON.stringify(signedParams)}`);',
    '  logger.info(`请求数据摘要: ${summarizeSensitiveResponseForLog(options.data || {})}`);',
    '',
    '  // 添加重试逻辑',
    '  let retries = 0;',
    '  const maxRetries = 3; // 最大重试次数',
    '  let lastError = null;',
    '  while (retries <= maxRetries) {',
    '    try {',
    '      const response = await axios.request({',
    '        method,',
    '        url: signedUrl,',
    '        params: signedParams,',
    '        headers: signedHeaders,',
    '        timeout: 45000, // 增加超时时间到45秒',
    '        validateStatus: () => true, // 允许任何状态码',
    '        ..._.omit(options, "params", "headers"),',
    '      });',
    '      return response;',
    '    } catch (error) { lastError = error; break; }',
    '  }',
    '  throw lastError;',
    '}',
  ].join("\n");
}

function videosFixture() {
  return [
    'import {',
    '  fetchWithVideoImageUploadTimeout,',
    '} from "../services/video-upload-stage-timeout.ts";',
    '',
    'async function uploadImageForVideo(imageUrl: string, refreshToken: string, regionInfo?: import("./core.ts").RegionInfo): Promise<string> {',
    '  return legacyDirectTosUpload(imageUrl, refreshToken);',
    '}',
    '',
    '// 从Buffer上传视频图片',
    'export async function uploadImageBufferForVideo(buffer: Buffer, refreshToken: string, regionInfo?: import("./core.ts").RegionInfo, uploadOptions: VideoImageUploadOptions = {}): Promise<string> {',
    '  try {',
    '    return "tos-id";',
    '  } catch (error) {',
    '    throw error;',
    '  }',
    '}',
    '',
    '/**',
    ' * 解析音频文件时长（毫秒）',
    ' */',
    'function parseAudioDuration() {}',
    '',
    'export async function uploadInternationalImageUrl(imageUrl, refreshToken, regionInfo) {',
    '  const buffer = Buffer.from("x");',
    '  return uploadImageBufferForVideo(buffer, refreshToken, regionInfo);',
    '}',
    '',
    'async function firstBrowserGenerate(token, generateUrl, generateBody, submitId) {',
    '  const generateResult = await browserService.fetch(',
    '    token,',
    '    generateUrl,',
    '    {',
    '      method: "POST",',
    '      body: JSON.stringify(generateBody),',
    '    }',
    '  );',
    '',
    '  // 检查浏览器代理返回的结果',
    '  return generateResult;',
    '}',
    '',
    'async function secondBrowserGenerate(token, generateUrl, generateBody, submitId) {',
    '  const generateResult = await browserService.fetch(token, generateUrl, {',
    '    method: "POST", body: JSON.stringify(generateBody),',
    '  });',
    '',
    '  const { ret } = generateResult;',
    '  return ret;',
    '}',
  ].join("\n");
}

test("构建补丁把全局 2/5/4 门控放到真实远端操作边界", () => {
  const core = patchCore(coreFixture());
  const videos = patchVideos(videosFixture());
  assert.match(core, /isImageGenerationSubmit/);
  assert.match(core, /maxRetries = isImageGenerationSubmit \? 0 : 3/);
  assert.match(core, /await beforeRemoteSubmit\(\)/);
  assert.match(core, /runGlobalImageStatus\(operationOwnerKey, work\)/);
  assert.match(core, /omit\(options, "params", "headers", "onBeforeRemoteSubmit"\)/);
  assert.match(videos, /return runGlobalImageUploadAttempt\(\{ token: refreshToken/);
  assert.equal((videos.match(/runGlobalImageGeneration\(submitId/g) || []).length, 2);
  assert.doesNotMatch(videos, /legacyDirectTosUpload/);
});

test("全局门控构建补丁可重复应用且不重复 import/wrapper", () => {
  const core = patchCore(coreFixture());
  const videos = patchVideos(videosFixture());
  assert.equal(patchCore(core), core);
  assert.equal(patchVideos(videos), videos);
  assert.equal((core.match(/global-image-operation-gates\.ts/g) || []).length, 1);
  assert.equal((videos.match(/global-image-operation-gates\.ts/g) || []).length, 1);
});

test("部分门控补丁状态失败关闭", () => {
  const partialCore = coreFixture().replace(
    'import { summarizeSensitiveResponseForLog } from "@/api/services/sensitive-log-redaction.ts";',
    'import { summarizeSensitiveResponseForLog } from "@/api/services/sensitive-log-redaction.ts";\n' +
      'import { runGlobalImageGeneration, runGlobalImageStatus } from "@/api/services/global-image-operation-gates.ts";'
  );
  assert.throws(() => patchCore(partialCore), /mixed core global operation gate state/);
});
