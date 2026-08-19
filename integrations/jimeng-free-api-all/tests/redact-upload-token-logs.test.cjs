const assert = require('node:assert/strict');
const test = require('node:test');

const { patchSensitiveUpstreamLogs } = require('../patches/scripts/redact-upload-token-logs.cjs');

function coreFixture() {
  return [
    'import { getXGnarly } from "@/lib/x-gnarly.ts";',
    'logger.info(`已添加 X-Bogus 和 X-Gnarly 签名，URL: ${signedUrl.substring(0, 200)}`);',
    'logger.info(`请求数据: ${JSON.stringify(options.data || {})}`);',
    'const responseDataSummary = JSON.stringify(response.data).substring(0, 500) + ',
    '  (JSON.stringify(response.data).length > 500 ? "..." : "");',
    'logger.info(`响应数据摘要: ${responseDataSummary}`);',
    'logger.error(`响应数据: ${JSON.stringify(lastError.response.data)}`);',
    'logger.info(`开始上传文件到: ${uploadProofUrl}`);',
    'logger.error(`上传文件失败: 状态码 ${uploadResult?.status}, 响应: ${JSON.stringify(uploadResult?.data)}`);',
    'logger.error(`上传凭证中缺少 image_uri: ${JSON.stringify(proof_info)}`);',
    'logger.info(`文件上传成功: ${proof_info.image_uri}`);',
    'logger.error(`文件上传过程中发生错误: ${error.message}`);',
  ].join('\n');
}

function videosFixture() {
  return [
    'logger.info(`获取上传令牌成功: service_id=${actualServiceId}`);',
    'logger.info(`获取上传令牌成功: service_id=${actualServiceId}`);',
    'logger.info(`获取${label}上传令牌成功: spaceName=${spaceName}`);',
    'logger.info(`视频图片上传完成: ${pluginResult.ImageUri}`);',
    'logger.info(`视频图片上传完成: ${fullImageUri}`);',
    'logger.error(`视频图片上传失败: ${error.message}`);',
    'logger.info(`第 ${i + 1} 个文件上传成功: ${imageUri}`);',
    'logger.info(`第 ${i + 1} 张图片上传成功: ${imageUri}`);',
    'logger.info(`Seedance: 第 ${i + 1} 个图片上传成功: ${imageUri}`);',
    'logger.info(`Seedance: 第 ${i + 1} 个图片上传成功: ${imageUri}`);',
    'logger.info(`设置首帧图片: ${uploadIDs[0]}`);',
    'logger.info(`设置首帧图片: ${uploadIDs[0]}`);',
    'logger.info(`设置尾帧图片: ${uploadIDs[1]}`);',
    'logger.info(`设置尾帧图片: ${uploadIDs[1]}`);',
  ].join('\n');
}

function previouslyPatchedCoreFixture() {
  return [
    'import { getXGnarly } from "@/lib/x-gnarly.ts";',
    'import { summarizeSensitiveResponseForLog } from "@/api/services/sensitive-log-redaction.ts";',
    'logger.info("已添加 X-Bogus 和 X-Gnarly 签名");',
    'logger.info(`请求数据: ${JSON.stringify(options.data || {})}`);',
    'const responseDataSummary = summarizeSensitiveResponseForLog(response.data);',
    'logger.info(`响应数据摘要: ${responseDataSummary}`);',
    'logger.error(`响应数据: ${JSON.stringify(lastError.response.data)}`);',
    'logger.info(`开始上传文件到: ${uploadProofUrl}`);',
    'logger.error(`上传文件失败: 状态码 ${uploadResult?.status}, 响应: ${JSON.stringify(uploadResult?.data)}`);',
    'logger.error(`上传凭证中缺少 image_uri: ${JSON.stringify(proof_info)}`);',
    'logger.info(`文件上传成功: ${proof_info.image_uri}`);',
    'logger.error(`文件上传过程中发生错误: ${error.message}`);',
  ].join('\n');
}

function previouslyPatchedVideosFixture() {
  return [
    'logger.info(`获取上传令牌成功: service_id=${actualServiceId}`);',
    'logger.info(`获取上传令牌成功: service_id=${actualServiceId}`);',
    'logger.info(`获取${label}上传令牌成功`);',
    'logger.info(`视频图片上传完成: ${pluginResult.ImageUri}`);',
    'logger.info(`视频图片上传完成: ${fullImageUri}`);',
    'logger.error(`视频图片上传失败: ${error.message}`);',
    'logger.info(`第 ${i + 1} 个文件上传成功: ${imageUri}`);',
    'logger.info(`第 ${i + 1} 张图片上传成功: ${imageUri}`);',
    'logger.info(`Seedance: 第 ${i + 1} 个图片上传成功: ${imageUri}`);',
    'logger.info(`Seedance: 第 ${i + 1} 个图片上传成功: ${imageUri}`);',
    'logger.info(`设置首帧图片: ${uploadIDs[0]}`);',
    'logger.info(`设置首帧图片: ${uploadIDs[0]}`);',
    'logger.info(`设置尾帧图片: ${uploadIDs[1]}`);',
    'logger.info(`设置尾帧图片: ${uploadIDs[1]}`);',
  ].join('\n');
}

test('构建补丁将 core 响应摘要接入递归脱敏，并保留允许记录的 service_id', () => {
  const output = patchSensitiveUpstreamLogs(coreFixture(), videosFixture());
  assert.match(output.coreSource, /summarizeSensitiveResponseForLog/);
  assert.doesNotMatch(output.coreSource, /JSON\.stringify\(response\.data\).*substring/s);
  assert.doesNotMatch(output.coreSource, /响应数据:\s*\$\{JSON\.stringify\(lastError\.response\.data\)/);
  assert.match(output.coreSource, /响应数据摘要:.*summarizeSensitiveResponseForLog\(lastError\.response\.data\)/);
  assert.doesNotMatch(output.coreSource, /signedUrl\.substring|签名，URL:/);
  assert.doesNotMatch(output.coreSource, /请求数据:\s*\$\{JSON\.stringify/);
  assert.doesNotMatch(output.coreSource, /响应数据:\s*\$\{JSON\.stringify\(lastError\.response\.data\)/);
  assert.match(output.coreSource, /响应数据摘要:.*summarizeSensitiveResponseForLog\(lastError\.response\.data\)/);
  assert.match(output.coreSource, /请求数据摘要:.*summarizeSensitiveResponseForLog/);
  assert.match(output.coreSource, /logger\.info\("已添加 X-Bogus 和 X-Gnarly 签名"\)/);
  assert.doesNotMatch(output.coreSource, /uploadProofUrl|JSON\.stringify\((?:uploadResult\?\.data|proof_info)\)|proof_info\.image_uri.*`/);
  assert.match(output.coreSource, /logger\.info\("开始上传文件"\)/);
  assert.match(output.coreSource, /logger\.info\("文件上传成功"\)/);
  assert.equal((output.videosSource.match(/service_id=/g) || []).length, 2);
  assert.doesNotMatch(output.videosSource, /spaceName=/);
  assert.doesNotMatch(output.videosSource, /\$\{(?:pluginResult\.ImageUri|fullImageUri|imageUri|uploadIDs\[[01]\])\}/);
});

test('上一版已脱敏源码只增补请求摘要且不会重复 import', () => {
  const output = patchSensitiveUpstreamLogs(
    previouslyPatchedCoreFixture(),
    previouslyPatchedVideosFixture()
  );
  assert.equal((output.coreSource.match(/sensitive-log-redaction\.ts/g) || []).length, 1);
  assert.doesNotMatch(output.coreSource, /请求数据:\s*\$\{JSON\.stringify/);
  assert.match(output.coreSource, /请求数据摘要:.*summarizeSensitiveResponseForLog/);
  assert.doesNotMatch(output.videosSource, /spaceName=/);
  assert.doesNotMatch(output.videosSource, /\$\{(?:pluginResult\.ImageUri|fullImageUri|imageUri|uploadIDs\[[01]\])\}/);
});

test('上游 core 泄漏点模式漂移时构建失败，避免脱敏补丁静默失效', () => {
  assert.throws(
    () => patchSensitiveUpstreamLogs('import x from "x";', videosFixture()),
    /core sensitive-log import anchor expected 1 matches, found 0/
  );
});
