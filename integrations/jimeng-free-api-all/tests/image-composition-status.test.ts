import assert from "node:assert/strict";
import test from "node:test";

import {
  IMAGE_COMPOSITION_HISTORY_RETRY_DELAYS_MS,
  classifyImageCompositionSnapshot,
  extractImageCompositionUrls,
  getImageCompositionHistoryRetryDelayMs,
  isTransientImageCompositionHistoryError,
} from "../src/api/services/image-composition-status.ts";

function generatedItem(...urls: unknown[]) {
  return {
    image: {
      large_images: urls.map((image_url) => ({ image_url })),
    },
  };
}

test("status=50 且已有4个有效URL时立即成功", () => {
  const snapshot = classifyImageCompositionSnapshot(50, [
    generatedItem(
      "https://example.invalid/1.png",
      "https://example.invalid/2.png",
      "https://example.invalid/3.png",
      "https://example.invalid/4.png"
    ),
  ]);

  assert.equal(snapshot.state, "success");
  assert.equal(snapshot.terminal, true);
  assert.equal(snapshot.reason, "complete_image_urls");
  assert.equal(snapshot.count, 4);
});

test("status=30 立即按明确失败结束，即使响应里残留图片URL", () => {
  const snapshot = classifyImageCompositionSnapshot(30, [
    generatedItem("https://example.invalid/partial.png"),
  ]);

  assert.equal(snapshot.state, "failed");
  assert.equal(snapshot.terminal, true);
  assert.equal(snapshot.reason, "explicit_failure_status_30");
});

test("status=45或50但图片不足4张时保持处理中", () => {
  for (const rawStatus of [45, 50]) {
    const snapshot = classifyImageCompositionSnapshot(rawStatus, [
      generatedItem(
        "https://example.invalid/1.png",
        "https://example.invalid/2.png",
        "https://example.invalid/3.png"
      ),
    ]);
    assert.equal(snapshot.state, "processing");
    assert.equal(snapshot.terminal, false);
    assert.equal(snapshot.count, 3);
  }
});

test("status=10且已有部分有效URL时保留现有部分成功语义", () => {
  const snapshot = classifyImageCompositionSnapshot(10, [
    generatedItem("https://example.invalid/partial.png"),
  ]);

  assert.equal(snapshot.state, "success");
  assert.equal(snapshot.reason, "terminal_partial_image_urls");
  assert.equal(snapshot.count, 1);
});

test("status=10但没有有效URL时仍保持处理中", () => {
  const snapshot = classifyImageCompositionSnapshot(10, []);
  assert.equal(snapshot.state, "processing");
  assert.equal(snapshot.count, 0);
});

test("字符串状态可归一化，重复URL去重后不足4张仍保持处理中", () => {
  const success = classifyImageCompositionSnapshot("50", [
    generatedItem(
      "https://example.invalid/1.png",
      "https://example.invalid/2.png",
      "https://example.invalid/3.png",
      "https://example.invalid/4.png"
    ),
  ]);
  assert.equal(success.state, "success");
  assert.equal(success.rawStatus, 50);

  const duplicate = classifyImageCompositionSnapshot(50, [
    generatedItem(
      "https://example.invalid/same.png",
      "https://example.invalid/same.png",
      "https://example.invalid/same.png",
      "https://example.invalid/same.png"
    ),
  ]);
  assert.equal(duplicate.state, "processing");
  assert.equal(duplicate.count, 1);
});

test("非数字状态归一化为0，无效主位置会继续使用cover回退", () => {
  const snapshot = classifyImageCompositionSnapshot("unknown", [{
    image: { large_images: [{ image_url: "not-a-url" }] },
    common_attr: { cover_url: "https://example.invalid/fallback.png" },
  }]);

  assert.equal(snapshot.rawStatus, 0);
  assert.equal(snapshot.state, "processing");
  assert.deepEqual(snapshot.imageUrls, ["https://example.invalid/fallback.png"]);
});

test("URL提取支持三种响应位置，并过滤空值、无效值和重复URL", () => {
  const urls = extractImageCompositionUrls([
    generatedItem(
      "https://example.invalid/a.png",
      "https://example.invalid/a.png",
      "",
      "not-a-url"
    ),
    {
      aigc_image_params: {
        blend_params: {
          ability_list: [{
            large_image_list: [{ image_url: "https://example.invalid/b.png" }],
          }],
        },
      },
    },
    { common_attr: { cover_url: "https://example.invalid/c.png" } },
    { common_attr: { cover_url: null } },
  ]);

  assert.deepEqual(urls, [
    "https://example.invalid/a.png",
    "https://example.invalid/b.png",
    "https://example.invalid/c.png",
  ]);
});

test("仅把已提交任务的 get history failed 识别为可安全重查", () => {
  assert.equal(
    isTransientImageCompositionHistoryError(new Error("[请求jimeng失败]: get history failed")),
    true
  );
  assert.equal(
    isTransientImageCompositionHistoryError({ message: "GET HISTORY FAILED" }),
    true
  );
  assert.equal(
    isTransientImageCompositionHistoryError(new Error("[请求jimeng失败]: save history failed")),
    false
  );
  assert.equal(
    isTransientImageCompositionHistoryError(new Error("内容审核失败")),
    false
  );
});

test("同一 historyId 的查询退避固定为 1/2/4/5/5 秒", () => {
  assert.deepEqual([...IMAGE_COMPOSITION_HISTORY_RETRY_DELAYS_MS], [1000, 2000, 4000, 5000, 5000]);
  assert.equal(getImageCompositionHistoryRetryDelayMs(0), 1000);
  assert.equal(getImageCompositionHistoryRetryDelayMs(1), 1000);
  assert.equal(getImageCompositionHistoryRetryDelayMs(2), 2000);
  assert.equal(getImageCompositionHistoryRetryDelayMs(3), 4000);
  assert.equal(getImageCompositionHistoryRetryDelayMs(4), 5000);
  assert.equal(getImageCompositionHistoryRetryDelayMs(99), 5000);
});
