const assert = require('node:assert/strict');
const test = require('node:test');

const {
  patchVideoUploadStageTimeouts,
} = require('../patches/scripts/add-video-upload-stage-timeouts.cjs');

function videosFixture() {
  return `import browserService from "@/lib/browser-service.ts";

// 从Buffer上传视频图片
export async function uploadImageBufferForVideo(buffer: Buffer, refreshToken: string, regionInfo?: import("./core.ts").RegionInfo): Promise<string> {
  try {
    const rf = regionFetch(regionInfo);
    const tokenResult = await request("post", "/mweb/v1/get_upload_token", refreshToken, {
      data: {
        scene: 2,
      },
    });
    const applyUrl = "https://imagex.example.test/?signature=secret";
    const applyResponse = await rf(applyUrl, {
      method: 'GET',
      headers: {
        'authorization': 'signed-secret',
      },
    });

    if (!applyResponse.ok) {
      const errorText = await applyResponse.text();
      throw new Error(\`申请上传权限失败: \${applyResponse.status} - \${errorText}\`);
    }

    const applyResult = await applyResponse.json();

    if (applyResult?.ResponseMetadata?.Error) {
      throw new Error(\`申请上传权限失败: \${JSON.stringify(applyResult.ResponseMetadata.Error)}\`);
    }

    const uploadAddress = applyResult?.Result?.UploadAddress;
    if (!uploadAddress || !uploadAddress.StoreInfos || !uploadAddress.UploadHosts) {
      throw new Error(\`获取上传地址失败: \${JSON.stringify(applyResult)}\`);
    }

    const uploadUrl = "https://tos.example.test/upload/v1/private";
    const uploadResponse = await rf(uploadUrl, {
      method: 'POST',
      headers: {
        'Authorization': 'upload-secret',
      },
      body: buffer,
    });

    if (!uploadResponse.ok) {
      const errorText = await uploadResponse.text();
      throw new Error(\`图片上传失败: \${uploadResponse.status} - \${errorText}\`);
    }

    const commitUrl = "https://imagex.example.test/?commit-secret";
    const commitResponse = await rf(commitUrl, {
      method: 'POST',
      headers: {
        'authorization': 'commit-secret',
      },
      body: "payload",
    });

    if (!commitResponse.ok) {
      const errorText = await commitResponse.text();
      throw new Error(\`提交上传失败: \${commitResponse.status} - \${errorText}\`);
    }

    const commitResult = await commitResponse.json();

    if (commitResult?.ResponseMetadata?.Error) {
      throw new Error(\`提交上传失败: \${JSON.stringify(commitResult.ResponseMetadata.Error)}\`);
    }

    if (!commitResult?.Result?.Results || commitResult.Result.Results.length === 0) {
      throw new Error(\`提交上传响应缺少结果: \${JSON.stringify(commitResult)}\`);
    }

    const uploadResult = commitResult.Result.Results[0];
    if (uploadResult.UriStatus !== 2000) {
      throw new Error(\`图片上传状态异常: UriStatus=\${uploadResult.UriStatus}\`);
    }

    const fullImageUri = uploadResult.Uri;
    const pluginResult = commitResult.Result?.PluginResult?.[0];
    if (pluginResult && pluginResult.ImageUri) {
      logger.info(\`Buffer视频图片上传完成: \${pluginResult.ImageUri}\`);
      return pluginResult.ImageUri;
    }

    logger.info(\`Buffer视频图片上传完成: \${fullImageUri}\`);
    return fullImageUri;
  } catch (error) {
    logger.error(\`Buffer视频图片上传失败: \${error.message}\`);
    throw error;
  }
}

/**
 * 解析音频文件时长（毫秒）
 */
function parseAudioDuration() {}
`;
}

test('构建补丁接通上传令牌取消并仅包装 Apply/Binary/Commit 三段 fetch', () => {
  const output = patchVideoUploadStageTimeouts(videosFixture());
  assert.equal((output.match(/fetchWithVideoImageUploadTimeout\(/g) || []).length, 3);
  assert.match(output, /uploadOptions: VideoImageUploadOptions = \{\}/);
  assert.match(output, /resolveVideoImageUploadTimeoutMs\("tos_apply_upload"/);
  assert.match(output, /resolveVideoImageUploadTimeoutMs\("tos_binary_upload"/);
  assert.match(output, /resolveVideoImageUploadTimeoutMs\("tos_commit_upload"/);
  assert.equal((output.match(/signal: uploadOptions\.signal/g) || []).length, 4);
  assert.match(
    output,
    /get_upload_token", refreshToken, \{[\s\S]*?signal: uploadOptions\.signal,[\s\S]*?if \(uploadOptions\.signal\?\.aborted\)/
  );
  assert.match(output, /throw uploadOptions\.signal\.reason \|\| error/);
  assert.doesNotMatch(output, /await rf\((?:applyUrl|uploadUrl|commitUrl),/);
});

test('补丁移除上游正文、完整上传 ID 和原始错误消息日志', () => {
  const output = patchVideoUploadStageTimeouts(videosFixture());
  assert.doesNotMatch(output, /const errorText = await/);
  assert.doesNotMatch(output, /JSON\.stringify\((?:applyResult|commitResult)/);
  assert.doesNotMatch(output, /Buffer视频图片上传完成: \$\{/);
  assert.doesNotMatch(output, /Buffer视频图片上传失败: \$\{error\.message\}/);
  assert.match(output, /host=\$\{event\.host\}/);
  assert.doesNotMatch(output, /event\.url|event\.path/);
});

test('已完整打过 stage-timeout 的 base 可安全重用且不会重复 import/wrapper', () => {
  const once = patchVideoUploadStageTimeouts(videosFixture());
  const twice = patchVideoUploadStageTimeouts(once);
  assert.equal(twice, once);
  assert.equal((twice.match(/video-upload-stage-timeout\.ts/g) || []).length, 1);
  assert.equal((twice.match(/fetchWithVideoImageUploadTimeout\(/g) || []).length, 3);
  assert.equal((twice.match(/signal: uploadOptions\.signal/g) || []).length, 4);
});

test('外层全局上传门控存在时 stage-timeout 重跑仍保持幂等', () => {
  const once = patchVideoUploadStageTimeouts(videosFixture());
  const signature = 'export async function uploadImageBufferForVideo(buffer: Buffer, refreshToken: string, regionInfo?: import("./core.ts").RegionInfo, uploadOptions: VideoImageUploadOptions = {}): Promise<string> {';
  let globallyGated = once.replace(
    `${signature}\n  try {`,
    `${signature}\n  return runGlobalImageUploadAttempt({ token: refreshToken, signal: uploadOptions.signal, work: async () => {\n  try {`
  );
  globallyGated = globallyGated.replace(
    '\n}\n\n/**\n * 解析音频文件时长（毫秒）',
    '\n  }});\n}\n\n/**\n * 解析音频文件时长（毫秒）'
  );
  assert.equal(patchVideoUploadStageTimeouts(globallyGated), globallyGated);
  assert.equal((globallyGated.match(/signal: uploadOptions\.signal/g) || []).length, 5);
});

test('部分打补丁的混合状态失败关闭', () => {
  const once = patchVideoUploadStageTimeouts(videosFixture());
  assert.throws(
    () => patchVideoUploadStageTimeouts(once.replace(
      /const uploadResponse = await fetchWithVideoImageUploadTimeout\(/,
      'const uploadResponse = await rf('
    )),
    /mixed video upload timeout patch state|failed safety verification/
  );
});

test('关键源码锚点漂移时失败关闭，不生成半补丁源码', () => {
  assert.throws(
    () => patchVideoUploadStageTimeouts(videosFixture().replace(
      'import browserService from "@/lib/browser-service.ts";',
      'import renamedBrowserService from "@/lib/browser-service.ts";'
    )),
    /videos timeout-helper import anchor expected 1 matches, found 0/
  );
  assert.throws(
    () => patchVideoUploadStageTimeouts(videosFixture().replace(
      'const uploadResponse = await rf(uploadUrl, {',
      'const uploadResponse = await customFetch(uploadUrl, {'
    )),
    /tos_binary_upload fetch anchor expected 1 matches, found 0/
  );
  assert.throws(
    () => patchVideoUploadStageTimeouts(videosFixture().replace(
      'const tokenResult = await request("post", "/mweb/v1/get_upload_token", refreshToken, {',
      'const tokenResult = await customRequest("post", "/mweb/v1/get_upload_token", refreshToken, {'
    )),
    /upload token AbortSignal anchor expected 1 matches, found 0/
  );
});
