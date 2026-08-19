import assert from "node:assert/strict";
import test from "node:test";

import {
  IMAGE_INPUT_UPLOAD_MAX_ATTEMPTS,
  ImageInputUploadError,
  getImageInputUploadFailureStage,
  getImageInputUploadRetryDelayMs,
  isRetryableImageUploadError,
  sanitizeImageUploadError,
  uploadImageInputsWithRetry,
} from "../src/api/services/image-input-upload-retry.ts";

test("仅网络错误及指定 HTTP 状态进入上传重试", () => {
  for (const status of [408, 429, 500, 502, 503, 504]) {
    assert.equal(isRetryableImageUploadError(new Error(`upload failed: HTTP ${status}`)), true);
  }
  for (const status of [400, 401, 403, 404, 501]) {
    assert.equal(isRetryableImageUploadError(new Error(`upload failed: HTTP ${status}`)), false);
  }
  assert.equal(isRetryableImageUploadError(Object.assign(new Error("socket closed"), { code: "ECONNRESET" })), true);
  assert.equal(isRetryableImageUploadError(Object.assign(new Error("dns temporary failure"), { code: "EAI_AGAIN" })), true);
  assert.equal(getImageInputUploadFailureStage(new Error("下载图片失败: 504")), "source_image_download");
  assert.equal(getImageInputUploadFailureStage(new Error("图片上传失败: 504")), "tos_binary_upload");
});

test("退避为 2s/5s 加最多 1s jitter", () => {
  assert.equal(getImageInputUploadRetryDelayMs(1, () => 0), 2000);
  assert.equal(getImageInputUploadRetryDelayMs(1, () => 1), 3000);
  assert.equal(getImageInputUploadRetryDelayMs(2, () => 0), 5000);
  assert.equal(getImageInputUploadRetryDelayMs(2, () => 1), 6000);
});

test("第二张图片临时 504 时只重试第二张，前序成功图片不重传", async () => {
  const calls = new Map<string, number>();
  const sleeps: number[] = [];
  const randomValues = [0, 1];
  const result = await uploadImageInputsWithRetry({
    inputs: ["first", "second", "third"],
    sourceFileNames: ["01.png", "02.png", "03.png"],
    random: () => randomValues.shift() ?? 0,
    sleep: async (delayMs) => {
      sleeps.push(delayMs);
    },
    uploadOne: async (input) => {
      calls.set(input, (calls.get(input) || 0) + 1);
      if (input === "second" && (calls.get(input) || 0) < 3) {
        throw Object.assign(new Error("图片上传失败: 504 Gateway Time-out"), { status: 504 });
      }
      return `uploaded-${input}`;
    },
  });

  assert.deepEqual(result, ["uploaded-first", "uploaded-second", "uploaded-third"]);
  assert.deepEqual(Object.fromEntries(calls), { first: 1, second: 3, third: 1 });
  assert.deepEqual(sleeps, [2000, 6000]);
});

test("可重试网络错误最多尝试三次并返回结构化 pre-submit 错误", async () => {
  let calls = 0;
  await assert.rejects(
    uploadImageInputsWithRetry({
      inputs: ["image"],
      sourceFileNames: ["失败图片.png"],
      random: () => 0,
      sleep: async () => undefined,
      uploadOne: async () => {
        calls++;
        throw Object.assign(new Error("socket reset"), { code: "ECONNRESET" });
      },
    }),
    (error: unknown) => {
      assert.ok(error instanceof ImageInputUploadError);
      assert.equal(error.code, "image_upload_pre_submit");
      assert.equal(error.details.phase, "image_upload_pre_submit");
      assert.equal(error.details.stage, "image_upload_pre_submit");
      assert.equal(error.details.imageIndex, 1);
      assert.equal(error.details.fileName, "失败图片.png");
      assert.equal(error.details.sourceFileName, "失败图片.png");
      assert.equal(error.details.attempts, IMAGE_INPUT_UPLOAD_MAX_ATTEMPTS);
      assert.equal(error.details.attemptCount, IMAGE_INPUT_UPLOAD_MAX_ATTEMPTS);
      assert.equal(error.details.retryable, true);
      assert.equal(error.details.automaticRetriesExhausted, true);
      assert.equal(error.details.retryExhausted, true);
      assert.equal(error.details.networkCode, "ECONNRESET");
      return true;
    }
  );
  assert.equal(calls, 3);
});

test("非重试状态只尝试一次，错误摘要不泄露 URL 或 Bearer", async () => {
  const unsafe = new Error("HTTP 400 https://signed.invalid/a?token=secret Bearer abc.def");
  assert.doesNotMatch(sanitizeImageUploadError(unsafe), /signed\.invalid|abc\.def/);
  let calls = 0;
  await assert.rejects(
    uploadImageInputsWithRetry({
      inputs: ["image"],
      sleep: async () => undefined,
      uploadOne: async () => {
        calls++;
        throw unsafe;
      },
    }),
    (error: unknown) =>
      error instanceof ImageInputUploadError &&
      error.details.retryable === false &&
      error.details.attemptCount === 1
  );
  assert.equal(calls, 1);
});
