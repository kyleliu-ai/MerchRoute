const fs = require('node:fs');

function replaceExactCount(source, pattern, replacement, expectedCount, label) {
  const matches = [...source.matchAll(pattern)];
  if (matches.length !== expectedCount) {
    throw new Error(`${label} expected ${expectedCount} matches, found ${matches.length}`);
  }
  return source.replace(pattern, replacement);
}

function replaceExactText(source, search, replacement, expectedCount, label) {
  const count = source.split(search).length - 1;
  if (count !== expectedCount) {
    throw new Error(`${label} expected ${expectedCount} matches, found ${count}`);
  }
  return source.split(search).join(replacement);
}

function patchStageFetch(block, responseName, urlName, stage) {
  const pattern = new RegExp(
    `const ${responseName} = await rf\\(${urlName}, \\{([\\s\\S]*?)\\n    \\}\\);\\n\\n    if \\(!${responseName}\\.ok\\)`,
    'g'
  );
  return replaceExactCount(
    block,
    pattern,
    (_match, initBody) => [
      `const ${responseName} = await fetchWithVideoImageUploadTimeout(`,
      '      rf,',
      `      ${urlName},`,
      `      {${initBody}`,
      '        signal: uploadOptions.signal,',
      '      },',
      `      "${stage}",`,
      `      resolveVideoImageUploadTimeoutMs("${stage}", uploadOptions.attempt, uploadOptions.timeoutProfileMs),`,
      '      uploadOptions.attempt,',
      '      (event) => logger.warn(',
      '        `视频图片上传阶段超时: stage=${event.stage}, timeout_ms=${event.timeoutMs}, ` +',
      '        `attempt=${event.attempt}, host=${event.host}`',
      '      )',
      '    );',
      '',
      `    if (!${responseName}.ok)`,
    ].join('\n'),
    1,
    `${stage} fetch anchor`
  );
}

function patchHttpFailure(block, responseName, messagePrefix, stage) {
  const search = [
    `if (!${responseName}.ok) {`,
    `      const errorText = await ${responseName}.text();`,
    '      throw new Error(`' + messagePrefix + ': ${' + responseName + '.status} - ${errorText}`);',
    '    }',
  ].join('\n');
  return replaceExactText(
    block,
    search,
    [
      `if (!${responseName}.ok) {`,
      `      await ${responseName}.body?.cancel().catch(() => undefined);`,
      `      throw Object.assign(new Error(\`${messagePrefix}: HTTP \${${responseName}.status}\`), {`,
      `        stage: "${stage}",`,
      `        status: ${responseName}.status,`,
      `        statusCode: ${responseName}.status,`,
      '      });',
      '    }',
    ].join('\n'),
    1,
    `${stage} HTTP failure anchor`
  );
}

function patchVideoUploadFunction(block) {
  let output = replaceExactText(
    block,
    'export async function uploadImageBufferForVideo(buffer: Buffer, refreshToken: string, regionInfo?: import("./core.ts").RegionInfo): Promise<string> {',
    'export async function uploadImageBufferForVideo(buffer: Buffer, refreshToken: string, regionInfo?: import("./core.ts").RegionInfo, uploadOptions: VideoImageUploadOptions = {}): Promise<string> {',
    1,
    'uploadImageBufferForVideo signature anchor'
  );

  output = replaceExactText(
    output,
    [
      'const tokenResult = await request("post", "/mweb/v1/get_upload_token", refreshToken, {',
      '      data: {',
      '        scene: 2,',
      '      },',
      '    });',
    ].join('\n'),
    [
      'let tokenResult;',
      '    try {',
      '      tokenResult = await request("post", "/mweb/v1/get_upload_token", refreshToken, {',
      '        data: {',
      '          scene: 2,',
      '        },',
      '        signal: uploadOptions.signal,',
      '      });',
      '    } catch (error) {',
      '      // Axios wraps an AbortSignal cancellation. Preserve the caller\'s',
      '      // fail-closed deadline reason so the coordinator records the exact',
      '      // upload_deadline_exceeded code and never treats it as retryable.',
      '      if (uploadOptions.signal?.aborted) {',
      '        throw uploadOptions.signal.reason || error;',
      '      }',
      '      throw error;',
      '    }',
    ].join('\n'),
    1,
    'upload token AbortSignal anchor'
  );

  output = patchStageFetch(output, 'applyResponse', 'applyUrl', 'tos_apply_upload');
  output = patchStageFetch(output, 'uploadResponse', 'uploadUrl', 'tos_binary_upload');
  output = patchStageFetch(output, 'commitResponse', 'commitUrl', 'tos_commit_upload');

  output = patchHttpFailure(output, 'applyResponse', '申请上传权限失败', 'tos_apply_upload');
  output = patchHttpFailure(output, 'uploadResponse', '图片上传失败', 'tos_binary_upload');
  output = patchHttpFailure(output, 'commitResponse', '提交上传失败', 'tos_commit_upload');

  output = replaceExactCount(
    output,
    /if \(applyResult\?\.ResponseMetadata\?\.Error\) \{\n\s+throw new Error\(`申请上传权限失败: \$\{JSON\.stringify\(applyResult\.ResponseMetadata\.Error\)\}`\);\n\s+\}/g,
    [
      'if (applyResult?.ResponseMetadata?.Error) {',
      '      throw Object.assign(new Error("申请上传权限失败: upstream error"), {',
      '        stage: "tos_apply_upload",',
      '      });',
      '    }',
    ].join('\n'),
    1,
    'apply metadata error anchor'
  );
  output = replaceExactCount(
    output,
    /if \(!uploadAddress \|\| !uploadAddress\.StoreInfos \|\| !uploadAddress\.UploadHosts\) \{\n\s+throw new Error\(`获取上传地址失败: \$\{JSON\.stringify\(applyResult\)\}`\);\n\s+\}/g,
    [
      'if (!uploadAddress || !uploadAddress.StoreInfos || !uploadAddress.UploadHosts) {',
      '      throw Object.assign(new Error("申请上传权限失败: missing upload address"), {',
      '        stage: "tos_apply_upload",',
      '      });',
      '    }',
    ].join('\n'),
    1,
    'apply upload-address error anchor'
  );
  output = replaceExactCount(
    output,
    /if \(commitResult\?\.ResponseMetadata\?\.Error\) \{\n\s+throw new Error\(`提交上传失败: \$\{JSON\.stringify\(commitResult\.ResponseMetadata\.Error\)\}`\);\n\s+\}/g,
    [
      'if (commitResult?.ResponseMetadata?.Error) {',
      '      throw Object.assign(new Error("提交上传失败: upstream error"), {',
      '        stage: "tos_commit_upload",',
      '      });',
      '    }',
    ].join('\n'),
    1,
    'commit metadata error anchor'
  );
  output = replaceExactCount(
    output,
    /if \(!commitResult\?\.Result\?\.Results \|\| commitResult\.Result\.Results\.length === 0\) \{\n\s+throw new Error\(`提交上传响应缺少结果: \$\{JSON\.stringify\(commitResult\)\}`\);\n\s+\}/g,
    [
      'if (!commitResult?.Result?.Results || commitResult.Result.Results.length === 0) {',
      '      throw Object.assign(new Error("提交上传失败: missing commit result"), {',
      '        stage: "tos_commit_upload",',
      '      });',
      '    }',
    ].join('\n'),
    1,
    'commit missing-result error anchor'
  );
  output = replaceExactCount(
    output,
    /throw new Error\(`图片上传状态异常: UriStatus=\$\{uploadResult\.UriStatus\}`\);/g,
    'throw Object.assign(new Error(`图片上传状态异常: UriStatus=${uploadResult.UriStatus}`), { stage: "tos_commit_upload" });',
    1,
    'commit UriStatus error anchor'
  );
  output = replaceExactCount(
    output,
    /logger\.info\(`Buffer视频图片上传完成: \$\{pluginResult\.ImageUri\}`\);/g,
    'logger.info("Buffer视频图片上传完成");',
    1,
    'plugin image URI log anchor'
  );
  output = replaceExactCount(
    output,
    /logger\.info\(`Buffer视频图片上传完成: \$\{fullImageUri\}`\);/g,
    'logger.info("Buffer视频图片上传完成");',
    1,
    'full image URI log anchor'
  );
  output = replaceExactCount(
    output,
    /\} catch \(error\) \{\n\s+logger\.error\(`Buffer视频图片上传失败: \$\{error\.message\}`\);\n\s+throw error;\n\s+\}/g,
    [
      '} catch (error) {',
      '    logger.error(`Buffer视频图片上传失败: ${summarizeVideoImageUploadErrorForLog(error)}`);',
      '    throw error;',
      '  }',
    ].join('\n'),
    1,
    'buffer upload catch-log anchor'
  );

  const unsafePatterns = [
    /await rf\((?:applyUrl|uploadUrl|commitUrl),/,
    /const errorText = await (?:applyResponse|uploadResponse|commitResponse)\.text\(\)/,
    /Buffer视频图片上传完成: \$\{(?:pluginResult\.ImageUri|fullImageUri)\}/,
    /Buffer视频图片上传失败: \$\{error\.message\}/,
    /JSON\.stringify\((?:applyResult|commitResult)/,
    /get_upload_token", refreshToken, \{\s*data: \{\s*scene: 2,\s*\},\s*\}\);/,
  ];
  for (const pattern of unsafePatterns) {
    if (pattern.test(output)) {
      throw new Error(`video upload timeout patch left unsafe or unbounded code: ${pattern}`);
    }
  }
  return output;
}

function patchVideoUploadStageTimeouts(source) {
  const normalized = source.replace(/\r\n/g, '\n');
  const helperImportNeedle = 'from "../services/video-upload-stage-timeout.ts";';
  const rawImportNeedle = 'import browserService from "@/lib/browser-service.ts";';
  const patchedSignatureNeedle = 'uploadOptions: VideoImageUploadOptions = {}';
  const helperImportCount = normalized.split(helperImportNeedle).length - 1;
  const patchedSignatureCount = normalized.split(patchedSignatureNeedle).length - 1;
  const wrapperCount = (normalized.match(/fetchWithVideoImageUploadTimeout\(/g) || []).length;
  if (helperImportCount === 1 && patchedSignatureCount === 1 && wrapperCount === 3) {
    const functionStart = normalized.indexOf('export async function uploadImageBufferForVideo(');
    const nextSection = normalized.indexOf('\n}\n\n/**\n * 解析音频文件时长（毫秒）', functionStart);
    if (functionStart < 0 || nextSection < 0) {
      throw new Error('already-patched uploadImageBufferForVideo boundary verification failed');
    }
    const patchedFunctionBlock = normalized.slice(functionStart, nextSection + 2);
    const unsafePatchedPatterns = [
      /await rf\((?:applyUrl|uploadUrl|commitUrl),/,
      /const errorText = await (?:applyResponse|uploadResponse|commitResponse)\.text\(\)/,
      /Buffer视频图片上传完成: \$\{(?:pluginResult\.ImageUri|fullImageUri)\}/,
      /Buffer视频图片上传失败: \$\{error\.message\}/,
      /get_upload_token", refreshToken, \{\s*data: \{\s*scene: 2,\s*\},\s*\}\);/,
    ];
    for (const pattern of unsafePatchedPatterns) {
      if (pattern.test(patchedFunctionBlock)) {
        throw new Error(`already-patched video upload source failed safety verification: ${pattern}`);
      }
    }
    const expectedSignalConnections = patchedFunctionBlock.includes('runGlobalImageUploadAttempt') ? 5 : 4;
    if ((patchedFunctionBlock.match(/signal: uploadOptions\.signal/g) || []).length !== expectedSignalConnections) {
      throw new Error(
        `already-patched video upload source must contain ${expectedSignalConnections} AbortSignal connections`
      );
    }
    return normalized;
  }
  if (helperImportCount !== 0 || patchedSignatureCount !== 0 || wrapperCount !== 0) {
    throw new Error(
      `mixed video upload timeout patch state: import=${helperImportCount}, signature=${patchedSignatureCount}, wrappers=${wrapperCount}`
    );
  }
  if ((normalized.split(rawImportNeedle).length - 1) !== 1) {
    throw new Error('videos timeout-helper import anchor expected 1 matches, found 0');
  }
  let output = replaceExactText(
    normalized,
    'import browserService from "@/lib/browser-service.ts";',
    [
      'import browserService from "@/lib/browser-service.ts";',
      'import {',
      '  fetchWithVideoImageUploadTimeout,',
      '  resolveVideoImageUploadTimeoutMs,',
      '  summarizeVideoImageUploadErrorForLog,',
      '  type VideoImageUploadOptions,',
      '} from "../services/video-upload-stage-timeout.ts";',
    ].join('\n'),
    1,
    'videos timeout-helper import anchor'
  );

  const functionStartNeedle = 'export async function uploadImageBufferForVideo(';
  const nextSectionNeedle = '\n}\n\n/**\n * 解析音频文件时长（毫秒）';
  const startMatches = output.split(functionStartNeedle).length - 1;
  if (startMatches !== 1) {
    throw new Error(`uploadImageBufferForVideo function expected 1 match, found ${startMatches}`);
  }
  const functionStart = output.indexOf(functionStartNeedle);
  const nextSection = output.indexOf(nextSectionNeedle, functionStart);
  if (nextSection < 0) {
    throw new Error('uploadImageBufferForVideo end anchor expected 1 match, found 0');
  }
  const laterSection = output.indexOf(nextSectionNeedle, nextSection + nextSectionNeedle.length);
  if (laterSection >= 0) {
    throw new Error('uploadImageBufferForVideo end anchor expected 1 match, found more than 1');
  }
  const functionEnd = nextSection + 2;
  const functionBlock = output.slice(functionStart, functionEnd);
  output = output.slice(0, functionStart) + patchVideoUploadFunction(functionBlock) + output.slice(functionEnd);

  if ((output.match(/fetchWithVideoImageUploadTimeout\(/g) || []).length !== 3) {
    throw new Error('expected exactly three timeout-wrapped video image upload fetch calls');
  }
  return output;
}

if (require.main === module) {
  const targetPath = process.argv[2];
  if (!targetPath) throw new Error('target videos.ts path is required');
  const patched = patchVideoUploadStageTimeouts(fs.readFileSync(targetPath, 'utf8'));
  fs.writeFileSync(targetPath, patched, 'utf8');
}

module.exports = {
  patchVideoUploadStageTimeouts,
};
