const fs = require('node:fs');

function replaceExactCount(source, pattern, replacement, expectedCount, label) {
  const matches = [...source.matchAll(pattern)];
  if (matches.length !== expectedCount) {
    throw new Error(`${label} expected ${expectedCount} matches, found ${matches.length}`);
  }
  return source.replace(pattern, replacement);
}

function replaceRawOrVerifyPatched(source, rawPattern, patchedPattern, replacement, label) {
  const rawCount = [...source.matchAll(rawPattern)].length;
  const patchedCount = [...source.matchAll(patchedPattern)].length;
  if (rawCount === 1 && patchedCount === 0) return source.replace(rawPattern, replacement);
  if (rawCount === 0 && patchedCount === 1) return source;
  throw new Error(`${label} expected exactly one raw or patched state, found raw=${rawCount}, patched=${patchedCount}`);
}

function replaceAllRawOrVerifyPatched(
  source,
  rawPattern,
  patchedPattern,
  replacement,
  expectedCount,
  label
) {
  const rawCount = [...source.matchAll(rawPattern)].length;
  const patchedCount = [...source.matchAll(patchedPattern)].length;
  if (rawCount === expectedCount && patchedCount === 0) return source.replace(rawPattern, replacement);
  if (rawCount === 0 && patchedCount === expectedCount) return source;
  throw new Error(
    `${label} expected ${expectedCount} raw or patched matches, found raw=${rawCount}, patched=${patchedCount}`
  );
}

function patchCoreSensitiveResponseLogs(source) {
  const helperImport = 'import { summarizeSensitiveResponseForLog } from "@/api/services/sensitive-log-redaction.ts";';
  let output = source;
  const helperCount = output.split(helperImport).length - 1;
  if (helperCount === 0) {
    output = replaceExactCount(
      output,
      /import \{ getXGnarly \} from "@\/lib\/x-gnarly\.ts";/g,
      `import { getXGnarly } from "@/lib/x-gnarly.ts";\n${helperImport}`,
      1,
      'core sensitive-log import anchor'
    );
  } else if (helperCount !== 1) {
    throw new Error(`core sensitive-log import expected 0 or 1 matches, found ${helperCount}`);
  }
  output = replaceRawOrVerifyPatched(
    output,
    /logger\.info\(\s*`请求数据:\s*\$\{JSON\.stringify\(options\.data \|\| \{\}\)\}`\s*\);/g,
    /logger\.info\(\s*`请求数据摘要:\s*\$\{summarizeSensitiveResponseForLog\(options\.data \|\| \{\}\)\}`\s*\);/g,
    'logger.info(`请求数据摘要: ${summarizeSensitiveResponseForLog(options.data || {})}`);',
    'core request data log leak'
  );
  output = replaceRawOrVerifyPatched(
    output,
    /const responseDataSummary = JSON\.stringify\(response\.data\)\.substring\(0, 500\) \+\s*\r?\n\s*\(JSON\.stringify\(response\.data\)\.length > 500 \? "\.\.\." : ""\);/g,
    /const responseDataSummary = summarizeSensitiveResponseForLog\(response\.data\);/g,
    'const responseDataSummary = summarizeSensitiveResponseForLog(response.data);',
    'core response summary leak'
  );
  output = replaceRawOrVerifyPatched(
    output,
    /logger\.error\(\s*`响应数据:\s*\$\{JSON\.stringify\(lastError\.response\.data\)\}`\s*\);/g,
    /logger\.error\(\s*`响应数据摘要:\s*\$\{summarizeSensitiveResponseForLog\(lastError\.response\.data\)\}`\s*\);/g,
    'logger.error(`响应数据摘要: ${summarizeSensitiveResponseForLog(lastError.response.data)}`);',
    'core terminal error response leak'
  );
  output = replaceRawOrVerifyPatched(
    output,
    /logger\.info\(\s*`已添加 X-Bogus 和 X-Gnarly 签名，URL: \$\{signedUrl\.substring\(0, 200\)\}`\s*\);/g,
    /logger\.info\(\s*"已添加 X-Bogus 和 X-Gnarly 签名"\s*\);/g,
    'logger.info("已添加 X-Bogus 和 X-Gnarly 签名");',
    'core signed URL log leak'
  );
  output = replaceRawOrVerifyPatched(
    output,
    /logger\.info\(\s*`开始上传文件到:\s*\$\{uploadProofUrl\}`\s*\);/g,
    /logger\.info\(\s*"开始上传文件"\s*\);/g,
    'logger.info("开始上传文件");',
    'core upload proof URL log leak'
  );
  output = replaceRawOrVerifyPatched(
    output,
    /logger\.error\(\s*`上传文件失败:\s*状态码 \$\{uploadResult\?\.status\},\s*响应:\s*\$\{JSON\.stringify\(uploadResult\?\.data\)\}`\s*\);/g,
    /logger\.error\(\s*`上传文件失败:\s*状态码 \$\{uploadResult\?\.status\}`\s*\);/g,
    'logger.error(`上传文件失败: 状态码 ${uploadResult?.status}`);',
    'core upload response body log leak'
  );
  output = replaceRawOrVerifyPatched(
    output,
    /logger\.error\(\s*`上传凭证中缺少 image_uri:\s*\$\{JSON\.stringify\(proof_info\)\}`\s*\);/g,
    /logger\.error\(\s*"上传凭证中缺少 image_uri"\s*\);/g,
    'logger.error("上传凭证中缺少 image_uri");',
    'core proof_info log leak'
  );
  output = replaceRawOrVerifyPatched(
    output,
    /logger\.info\(\s*`文件上传成功:\s*\$\{proof_info\.image_uri\}`\s*\);/g,
    /logger\.info\(\s*"文件上传成功"\s*\);/g,
    'logger.info("文件上传成功");',
    'core image_uri success log leak'
  );
  output = replaceRawOrVerifyPatched(
    output,
    /logger\.error\(\s*`文件上传过程中发生错误:\s*\$\{error\.message\}`\s*\);/g,
    /logger\.error\(\s*"文件上传过程中发生错误"\s*\);/g,
    'logger.error("文件上传过程中发生错误");',
    'core upload raw error log leak'
  );
  if (/JSON\.stringify\(response\.data\).*substring\(0,\s*500\)/s.test(output)) {
    throw new Error('raw response.data summary logging remains in core.ts');
  }
  if (/响应数据:\s*\$\{JSON\.stringify\(lastError\.response\.data\)/.test(output)) {
    throw new Error('raw terminal error response logging remains in core.ts');
  }
  if (/请求数据:\s*\$\{JSON\.stringify\(options\.data/.test(output)) {
    throw new Error('raw request data logging remains in core.ts');
  }
  if (/signedUrl\.substring\(/.test(output)) {
    throw new Error('signed URL logging remains in core.ts');
  }
  const remainingCoreLeaks = [
    /上传ProofUrl|\$\{uploadProofUrl\}/,
    /JSON\.stringify\((?:uploadResult\?\.data|proof_info)\)/,
    /文件上传成功:\s*\$\{proof_info\.image_uri\}/,
  ];
  for (const pattern of remainingCoreLeaks) {
    if (pattern.test(output)) throw new Error(`core upload log redaction incomplete: ${pattern}`);
  }
  return output;
}

function patchVideoUploadTokenLogs(source) {
  let output = replaceRawOrVerifyPatched(
    source,
    /logger\.info\(\s*`获取\$\{label\}上传令牌成功:\s*spaceName=\$\{spaceName\}`\s*\);/g,
    /logger\.info\(\s*`获取\$\{label\}上传令牌成功`\s*\);/g,
    'logger.info(`获取${label}上传令牌成功`);',
    'spaceName upload-token log'
  );
  output = replaceAllRawOrVerifyPatched(
    output,
    /logger\.info\(\s*`视频图片上传完成:\s*\$\{(?:pluginResult\.ImageUri|fullImageUri)\}`\s*\);/g,
    /logger\.info\(\s*"视频图片上传完成"\s*\);/g,
    'logger.info("视频图片上传完成");',
    2,
    'video image URI completion logs'
  );
  output = replaceRawOrVerifyPatched(
    output,
    /logger\.error\(\s*`视频图片上传失败:\s*\$\{error\.message\}`\s*\);/g,
    /logger\.error\(\s*"视频图片上传失败"\s*\);/g,
    'logger.error("视频图片上传失败");',
    'video image raw error log'
  );
  output = replaceRawOrVerifyPatched(
    output,
    /logger\.info\(\s*`第 \$\{i \+ 1\} 个文件上传成功:\s*\$\{imageUri\}`\s*\);/g,
    /logger\.info\(\s*`第 \$\{i \+ 1\} 个文件上传成功`\s*\);/g,
    'logger.info(`第 ${i + 1} 个文件上传成功`);',
    'video file imageUri log'
  );
  output = replaceRawOrVerifyPatched(
    output,
    /logger\.info\(\s*`第 \$\{i \+ 1\} 张图片上传成功:\s*\$\{imageUri\}`\s*\);/g,
    /logger\.info\(\s*`第 \$\{i \+ 1\} 张图片上传成功`\s*\);/g,
    'logger.info(`第 ${i + 1} 张图片上传成功`);',
    'video URL imageUri log'
  );
  output = replaceAllRawOrVerifyPatched(
    output,
    /logger\.info\(\s*`Seedance:\s*第 \$\{i \+ 1\} 个图片上传成功:\s*\$\{imageUri\}`\s*\);/g,
    /logger\.info\(\s*`Seedance:\s*第 \$\{i \+ 1\} 个图片上传成功`\s*\);/g,
    'logger.info(`Seedance: 第 ${i + 1} 个图片上传成功`);',
    2,
    'Seedance imageUri logs'
  );
  output = replaceAllRawOrVerifyPatched(
    output,
    /logger\.info\(\s*`设置首帧图片:\s*\$\{uploadIDs\[0\]\}`\s*\);/g,
    /logger\.info\(\s*"已设置首帧图片"\s*\);/g,
    'logger.info("已设置首帧图片");',
    2,
    'first-frame upload ID logs'
  );
  output = replaceAllRawOrVerifyPatched(
    output,
    /logger\.info\(\s*`设置尾帧图片:\s*\$\{uploadIDs\[1\]\}`\s*\);/g,
    /logger\.info\(\s*"已设置尾帧图片"\s*\);/g,
    'logger.info("已设置尾帧图片");',
    2,
    'last-frame upload ID logs'
  );
  const unsafeLogLines = output.split(/\r?\n/).filter((line) =>
    /logger\.(?:debug|info|warn|error)/.test(line) &&
    /access_key_id|secret_access_key|session_token|refreshToken|spaceName=|\$\{(?:pluginResult\.ImageUri|fullImageUri|imageUri|uploadIDs\[[01]\])\}/.test(line) &&
    // The two Buffer-video completion lines are removed by the immediately
    // following fail-closed stage-timeout build patch. Do not duplicate that
    // function rewrite here or its exact anchors would be lost.
    !/Buffer视频图片上传完成/.test(line)
  );
  if (unsafeLogLines.length > 0) {
    throw new Error(`upload-token log redaction incomplete: ${unsafeLogLines.length} unsafe log line(s)`);
  }
  return output;
}

function patchSensitiveUpstreamLogs(coreSource, videosSource) {
  return {
    coreSource: patchCoreSensitiveResponseLogs(coreSource),
    videosSource: patchVideoUploadTokenLogs(videosSource),
  };
}

if (require.main === module) {
  const corePath = process.argv[2];
  const videosPath = process.argv[3];
  if (!corePath || !videosPath) throw new Error('target core.ts and videos.ts paths are required');
  const patched = patchSensitiveUpstreamLogs(
    fs.readFileSync(corePath, 'utf8'),
    fs.readFileSync(videosPath, 'utf8')
  );
  fs.writeFileSync(corePath, patched.coreSource, 'utf8');
  fs.writeFileSync(videosPath, patched.videosSource, 'utf8');
}

module.exports = {
  patchCoreSensitiveResponseLogs,
  patchSensitiveUpstreamLogs,
  patchVideoUploadTokenLogs,
};
