const fs = require("node:fs");

function count(source, needle) {
  return source.split(needle).length - 1;
}

function replaceOnce(source, needle, replacement, label) {
  const found = count(source, needle);
  if (found !== 1) throw new Error(`${label} expected 1 match, found ${found}`);
  return source.replace(needle, replacement);
}

function patchCore(source) {
  let output = source.replace(/\r\n/g, "\n");
  const importLine = [
    'import {',
    '  runGlobalImageGeneration,',
    '  runGlobalImageStatus,',
    '} from "@/api/services/global-image-operation-gates.ts";',
  ].join("\n");
  const rawSetup = [
    '  // 添加重试逻辑',
    '  let retries = 0;',
    '  const maxRetries = 3; // 最大重试次数',
    '  let lastError = null;',
  ].join("\n");
  const patchedSetup = [
    '  const isImageGenerationSubmit = uri === "/mweb/v1/aigc_draft/generate";',
    '  const isImageStatusQuery = uri === "/mweb/v1/get_history_by_ids";',
    '  const operationOwnerKey = String(',
    '    (options as any)?.data?.submit_id ||',
    '    (options as any)?.data?.history_ids?.[0] ||',
    '    `${uri}:${deviceTime}`',
    '  );',
    '  const beforeRemoteSubmit = typeof (options as any).onBeforeRemoteSubmit === "function"',
    '    ? (options as any).onBeforeRemoteSubmit as () => Promise<void> | void',
    '    : undefined;',
    '  let remoteSubmitBoundaryPersisted = false;',
    '  const runImageOperation = async <T>(work: () => Promise<T>): Promise<T> => {',
    '    if (isImageGenerationSubmit) {',
    '      return runGlobalImageGeneration(operationOwnerKey, async () => {',
    '        if (beforeRemoteSubmit && !remoteSubmitBoundaryPersisted) {',
    '          await beforeRemoteSubmit();',
    '          remoteSubmitBoundaryPersisted = true;',
    '        }',
    '        return work();',
    '      });',
    '    }',
    '    if (isImageStatusQuery) return runGlobalImageStatus(operationOwnerKey, work);',
    '    return work();',
    '  };',
    '',
    '  // A generate transport failure is UNKNOWN. Never replay the paid POST',
    '  // inside the generic request helper; the ledger/status path owns recovery.',
    '  let retries = 0;',
    '  const maxRetries = isImageGenerationSubmit ? 0 : 3;',
    '  let lastError = null;',
  ].join("\n");
  const rawAxios = [
    '      const response = await axios.request({',
    '        method,',
    '        url: signedUrl,',
    '        params: signedParams,',
    '        headers: signedHeaders,',
    '        timeout: 45000, // 增加超时时间到45秒',
    '        validateStatus: () => true, // 允许任何状态码',
    '        ..._.omit(options, "params", "headers"),',
    '      });',
  ].join("\n");
  const patchedAxios = [
    '      const response = await runImageOperation(() => axios.request({',
    '        method,',
    '        url: signedUrl,',
    '        params: signedParams,',
    '        headers: signedHeaders,',
    '        timeout: 45000, // 增加超时时间到45秒',
    '        validateStatus: () => true, // 允许任何状态码',
    '        ..._.omit(options, "params", "headers", "onBeforeRemoteSubmit"),',
    '      }));',
  ].join("\n");
  const importCount = count(output, importLine);
  const importPathCount = count(output, "global-image-operation-gates.ts");
  const rawSetupCount = count(output, rawSetup);
  const patchedSetupCount = count(output, patchedSetup);
  const rawAxiosCount = count(output, rawAxios);
  const patchedAxiosCount = count(output, patchedAxios);
  const rawState = importCount === 0 && importPathCount === 0 &&
    rawSetupCount === 1 && patchedSetupCount === 0 &&
    rawAxiosCount === 1 && patchedAxiosCount === 0;
  const patchedState = importCount === 1 && importPathCount === 1 &&
    rawSetupCount === 0 && patchedSetupCount === 1 &&
    rawAxiosCount === 0 && patchedAxiosCount === 1;
  if (patchedState) return output;
  if (!rawState) {
    throw new Error(
      `mixed core global operation gate state: import=${importCount}/${importPathCount}, ` +
      `setup=${rawSetupCount}/${patchedSetupCount}, axios=${rawAxiosCount}/${patchedAxiosCount}`
    );
  }

  output = replaceOnce(
    output,
    'import { summarizeSensitiveResponseForLog } from "@/api/services/sensitive-log-redaction.ts";',
    'import { summarizeSensitiveResponseForLog } from "@/api/services/sensitive-log-redaction.ts";\n' + importLine,
    "core gate import"
  );
  output = replaceOnce(output, rawSetup, patchedSetup, "core gate setup");
  output = replaceOnce(output, rawAxios, patchedAxios, "core axios operation gate");

  if (count(output, importLine) !== 1 || count(output, patchedSetup) !== 1 || count(output, patchedAxios) !== 1) {
    throw new Error("core global operation gate verification failed");
  }
  return output;
}

function patchVideos(source) {
  let output = source.replace(/\r\n/g, "\n");
  const importLine = [
    'import {',
    '  runGlobalImageGeneration,',
    '  runGlobalImageUploadAttempt,',
    '} from "../services/global-image-operation-gates.ts";',
  ].join("\n");
  const wrapperStart = 'export async function uploadImageBufferForVideo(buffer: Buffer, refreshToken: string, regionInfo?: import("./core.ts").RegionInfo, uploadOptions: VideoImageUploadOptions = {}): Promise<string> {\n  try {';
  const wrappedStart = 'export async function uploadImageBufferForVideo(buffer: Buffer, refreshToken: string, regionInfo?: import("./core.ts").RegionInfo, uploadOptions: VideoImageUploadOptions = {}): Promise<string> {\n  return runGlobalImageUploadAttempt({ token: refreshToken, signal: uploadOptions.signal, work: async () => {\n  try {';
  const gatePathCount = count(output, "global-image-operation-gates.ts");
  const exactImportCount = count(output, importLine);
  const wrappedUploadCount = count(output, wrappedStart);
  const wrappedGenerationCount = count(
    output,
    'await runGlobalImageGeneration(submitId, () => browserService.fetch'
  );
  const hasPatchedUrlUpload = output.includes(
    'return uploadImageBufferForVideo(buffer, refreshToken, regionInfo);\n}\n// 从Buffer上传视频图片'
  );
  const fullyPatched = gatePathCount === 1 && exactImportCount === 1 &&
    wrappedUploadCount === 1 && wrappedGenerationCount === 2 && hasPatchedUrlUpload;
  const fullyRaw = gatePathCount === 0 && exactImportCount === 0 &&
    wrappedUploadCount === 0 && wrappedGenerationCount === 0 && !hasPatchedUrlUpload;
  if (!fullyPatched && !fullyRaw) {
    throw new Error(
      `mixed videos global operation gate state: import=${exactImportCount}/${gatePathCount}, ` +
      `upload=${wrappedUploadCount}, generation=${wrappedGenerationCount}, url=${hasPatchedUrlUpload}`
    );
  }
  if (count(output, importLine) === 0) {
    output = replaceOnce(
      output,
      '} from "../services/video-upload-stage-timeout.ts";',
      '} from "../services/video-upload-stage-timeout.ts";\n' + importLine,
      "videos gate import"
    );
  }

  const urlUploadStart = output.indexOf('async function uploadImageForVideo(');
  const urlUploadEndMarker = '\n// 从Buffer上传视频图片';
  const urlUploadEnd = output.indexOf(urlUploadEndMarker, urlUploadStart);
  if (urlUploadStart >= 0 && urlUploadEnd >= 0) {
    const block = output.slice(urlUploadStart, urlUploadEnd);
    if (!block.includes('return uploadImageBufferForVideo(buffer, refreshToken, regionInfo);')) {
      const replacement = [
        'async function uploadImageForVideo(imageUrl: string, refreshToken: string, regionInfo?: import("./core.ts").RegionInfo): Promise<string> {',
        '  const response = await fetch(imageUrl);',
        '  if (!response.ok) throw Object.assign(new Error(`下载图片失败: HTTP ${response.status}`), {',
        '    stage: "source_image_download",',
        '    status: response.status,',
        '  });',
        '  const buffer = Buffer.from(await response.arrayBuffer());',
        '  return uploadImageBufferForVideo(buffer, refreshToken, regionInfo);',
        '}',
      ].join("\n");
      output = output.slice(0, urlUploadStart) + replacement + output.slice(urlUploadEnd);
    }
  } else {
    throw new Error("videos URL upload function boundary not found");
  }

  if (count(output, wrappedStart) === 0) {
    output = replaceOnce(output, wrapperStart, wrappedStart, "buffer upload gate start");
    const functionStart = output.indexOf(wrappedStart);
    const functionEnd = output.indexOf('\n}\n\n/**\n * 解析音频文件时长', functionStart);
    if (functionEnd < 0) throw new Error("buffer upload gate end not found");
    output = output.slice(0, functionEnd) + '\n  }});' + output.slice(functionEnd);
  }

  const browserFirstPattern = /const generateResult = await browserService\.fetch\(([\s\S]*?)\n  \);\n\n  \/\/ 检查浏览器代理返回的结果/g;
  if ((output.match(browserFirstPattern) || []).length === 1) {
    output = output.replace(
      browserFirstPattern,
      'const generateResult = await runGlobalImageGeneration(submitId, () => browserService.fetch($1\n  ));\n\n  // 检查浏览器代理返回的结果'
    );
  }
  const browserSecondPattern = /const generateResult = await browserService\.fetch\(token, generateUrl, \{([\s\S]*?)\n  \}\);\n\n  const \{ ret/g;
  if ((output.match(browserSecondPattern) || []).length === 1) {
    output = output.replace(
      browserSecondPattern,
      'const generateResult = await runGlobalImageGeneration(submitId, () => browserService.fetch(token, generateUrl, {$1\n  }));\n\n  const { ret'
    );
  }

  if (
    count(output, importLine) !== 1 ||
    count(output, wrappedStart) !== 1 ||
    count(output, 'return uploadImageBufferForVideo(buffer, refreshToken, regionInfo);') < 2 ||
    count(output, 'await runGlobalImageGeneration(submitId, () => browserService.fetch') !== 2
  ) {
    throw new Error("videos global operation gate verification failed");
  }
  return output;
}

if (require.main === module) {
  const [corePath, videosPath] = process.argv.slice(2);
  if (!corePath || !videosPath) {
    throw new Error("usage: node add-global-image-operation-gates.cjs <core.ts> <videos.ts>");
  }
  fs.writeFileSync(corePath, patchCore(fs.readFileSync(corePath, "utf8")), "utf8");
  fs.writeFileSync(videosPath, patchVideos(fs.readFileSync(videosPath, "utf8")), "utf8");
  console.log("global image operation gates applied and verified");
}

module.exports = { patchCore, patchVideos };
