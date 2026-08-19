import assert from "node:assert/strict";
import test from "node:test";

import {
  VideoImageUploadTimeoutError,
  fetchWithVideoImageUploadTimeout,
  getSafeVideoImageUploadHost,
  normalizeVideoImageUploadAttempt,
  resolveVideoImageUploadTimeoutMs,
  summarizeVideoImageUploadErrorForLog,
} from "../src/api/services/video-upload-stage-timeout.ts";
import {
  getImageInputUploadFailureStage,
  isRetryableImageUploadError,
} from "../src/api/services/image-input-upload-retry.ts";

test("渐进超时按 attempt 选择，越界 attempt 固定到 1..3", () => {
  assert.equal(resolveVideoImageUploadTimeoutMs("tos_apply_upload", 1), 20_000);
  assert.equal(resolveVideoImageUploadTimeoutMs("tos_apply_upload", 2), 40_000);
  assert.equal(resolveVideoImageUploadTimeoutMs("tos_apply_upload", 99), 60_000);
  assert.equal(resolveVideoImageUploadTimeoutMs("tos_binary_upload", 1), 45_000);
  assert.equal(resolveVideoImageUploadTimeoutMs("tos_binary_upload", 2), 90_000);
  assert.equal(resolveVideoImageUploadTimeoutMs("tos_binary_upload", 3), 180_000);
  assert.equal(resolveVideoImageUploadTimeoutMs("tos_commit_upload", 1), 30_000);
  assert.equal(resolveVideoImageUploadTimeoutMs("tos_commit_upload", 2), 60_000);
  assert.equal(resolveVideoImageUploadTimeoutMs("tos_commit_upload", 3), 90_000);
  assert.equal(normalizeVideoImageUploadAttempt(undefined), 1);
  assert.equal(normalizeVideoImageUploadAttempt(-2), 1);
  assert.equal(normalizeVideoImageUploadAttempt(4), 3);
});

test("调用方可覆盖单值或分次 timeout profile，无效覆盖回退默认值", () => {
  const profile = {
    apply: 7_000,
    binary: [11_000, 22_000, 33_000],
    commit: [] as number[],
  };
  assert.equal(resolveVideoImageUploadTimeoutMs("tos_apply_upload", 3, profile), 7_000);
  assert.equal(resolveVideoImageUploadTimeoutMs("tos_binary_upload", 2, profile), 22_000);
  assert.equal(resolveVideoImageUploadTimeoutMs("tos_commit_upload", 2, profile), 60_000);
});

test("阶段截止时间真实中止 fetch，并生成可被上传重试识别的 ETIMEDOUT", async () => {
  let receivedSignal: AbortSignal | undefined;
  const timeoutEvents: Array<Record<string, unknown>> = [];
  const fetcher = async (_url: string | Request, init?: RequestInit): Promise<Response> => {
    receivedSignal = init?.signal || undefined;
    return new Promise<Response>((_resolve, reject) => {
      receivedSignal?.addEventListener("abort", () => {
        reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
      }, { once: true });
    });
  };

  await assert.rejects(
    fetchWithVideoImageUploadTimeout(
      fetcher,
      "https://upload.example.test/upload/v1/signed-path?signature=secret",
      { method: "POST" },
      "tos_binary_upload",
      15,
      2,
      (event) => timeoutEvents.push(event)
    ),
    (error: unknown) => {
      assert.ok(error instanceof VideoImageUploadTimeoutError);
      assert.equal(error.code, "ETIMEDOUT");
      assert.equal(error.stage, "tos_binary_upload");
      assert.equal(error.timeoutMs, 15);
      assert.equal(error.attempt, 2);
      assert.equal(error.host, "upload.example.test");
      assert.match(error.message, /^图片上传失败: timeout after 15ms$/);
      assert.doesNotMatch(error.message, /signed-path|signature|secret/);
      return true;
    }
  );

  assert.equal(receivedSignal?.aborted, true);
  assert.deepEqual(timeoutEvents, [{
    stage: "tos_binary_upload",
    timeoutMs: 15,
    host: "upload.example.test",
    attempt: 2,
  }]);
});

test("调用方主动取消不伪装为阶段超时", async () => {
  const external = new AbortController();
  const fetcher = async (_url: string | Request, init?: RequestInit): Promise<Response> =>
    new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new Error("caller cancelled")), { once: true });
    });
  const pending = fetchWithVideoImageUploadTimeout(
    fetcher,
    "https://upload.example.test/upload/v1/private",
    { signal: external.signal },
    "tos_commit_upload",
    1_000
  );
  external.abort();
  await assert.rejects(pending, /caller cancelled/);
});

test("日志摘要和 host 只保留安全诊断字段", () => {
  const unsafe = Object.assign(
    new Error("https://upload.example.test/private?token=secret Bearer abc.def"),
    { stage: "tos_apply_upload", code: "ETIMEDOUT", status: 504 }
  );
  const summary = summarizeVideoImageUploadErrorForLog(unsafe);
  assert.equal(summary, "stage=tos_apply_upload, code=ETIMEDOUT, status=504");
  assert.doesNotMatch(summary, /upload\.example|secret|Bearer|abc\.def/);
  assert.equal(
    getSafeVideoImageUploadHost("https://tos.example.test/upload/v1/private?signature=secret"),
    "tos.example.test"
  );
});

test("三阶段超时均能被现有上传重试识别并保留准确 stage", () => {
  const cases = [
    ["tos_apply_upload", 20_000],
    ["tos_binary_upload", 45_000],
    ["tos_commit_upload", 30_000],
  ] as const;
  for (const [stage, timeoutMs] of cases) {
    const error = new VideoImageUploadTimeoutError(stage, timeoutMs, "safe.example.test", 1, new Error("abort"));
    assert.equal(isRetryableImageUploadError(error), true);
    assert.equal(getImageInputUploadFailureStage(error), stage);
  }
});
