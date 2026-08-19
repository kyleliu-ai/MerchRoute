import assert from "node:assert/strict";
import test from "node:test";

import {
  redactSensitiveLogValue,
  summarizeSensitiveResponseForLog,
} from "../src/api/services/sensitive-log-redaction.ts";

test("响应摘要递归脱敏上传令牌字段，保留 service_id 和脱敏后的 host", () => {
  const source = {
    ret: "0",
    logid: "safe-log-id",
    data: {
      access_key_id: "AK-SECRET",
      SecretAccessKey: "SK-SECRET",
      SESSION_TOKEN: "SESSION-SECRET",
      service_id: "tb4s082cfz",
      nested: {
        authorization: "Bearer nested-secret",
      },
      image_uri: "tos-cn-i-abc123/VERY-SENSITIVE-UPLOAD-ID",
      image_uri_list: ["tos-cn-i-abc123/SECOND-SENSITIVE-UPLOAD-ID"],
      uploadedImageId: "tos-cn-i-abc123/THIRD-SENSITIVE-UPLOAD-ID",
      jsonString: JSON.stringify({ refresh_token: "REFRESH-SECRET", ok: true }),
      uploadUrl: "https://upload.example.invalid/path?X-Bogus=BOGUS-SECRET&x-amz-signature=SIGNED-SECRET&part=1",
    },
  };

  const redacted = redactSensitiveLogValue(source) as Record<string, any>;
  assert.equal(redacted.data.access_key_id, "<redacted>");
  assert.equal(redacted.data.SecretAccessKey, "<redacted>");
  assert.equal(redacted.data.SESSION_TOKEN, "<redacted>");
  assert.equal(redacted.data.service_id, "tb4s082cfz");
  assert.equal(redacted.data.nested.authorization, "<redacted>");
  assert.equal(redacted.data.image_uri, "<redacted>");
  assert.equal(redacted.data.image_uri_list, "<redacted>");
  assert.equal(redacted.data.uploadedImageId, "<redacted>");
  assert.deepEqual(JSON.parse(redacted.data.jsonString), { refresh_token: "<redacted>", ok: true });
  assert.match(redacted.data.uploadUrl, /^https:\/\/upload\.example\.invalid\/path\?/);
  assert.match(redacted.data.uploadUrl, /X-Bogus=<redacted>/);
  assert.match(redacted.data.uploadUrl, /x-amz-signature=<redacted>/);
  assert.doesNotMatch(redacted.data.uploadUrl, /BOGUS-SECRET|SIGNED-SECRET/);

  const summary = summarizeSensitiveResponseForLog(source);
  assert.doesNotMatch(summary, /AK-SECRET|SK-SECRET|SESSION-SECRET|REFRESH-SECRET|BOGUS-SECRET|SIGNED-SECRET|nested-secret|VERY-SENSITIVE|SECOND-SENSITIVE|THIRD-SENSITIVE/);
  assert.match(summary, /tb4s082cfz/);
});

test("未知字段中的完整 TOS 图片 ID 也会按值模式脱敏", () => {
  const summary = summarizeSensitiveResponseForLog({
    diagnostic: "uploaded tos-cn-i-prod/0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ",
    model: "jimeng-4.5",
    prompt: "keep this diagnostic text",
  }, 2000);
  assert.doesNotMatch(summary, /0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ/);
  assert.match(summary, /<redacted>/);
  assert.match(summary, /jimeng-4\.5|keep this diagnostic text/);
});

test("嵌套数组、JSON 字符串及循环引用均可安全摘要", () => {
  const circular: Record<string, unknown> = {
    values: [{ ApiKey: "API-SECRET" }, JSON.stringify({ cookie: "COOKIE-SECRET" })],
  };
  circular.self = circular;
  const summary = summarizeSensitiveResponseForLog(circular, 2000);
  assert.doesNotMatch(summary, /API-SECRET|COOKIE-SECRET/);
  assert.match(summary, /<redacted>/);
  assert.match(summary, /<circular>/);
});

test("响应摘要继续保持 500 字符上限", () => {
  const summary = summarizeSensitiveResponseForLog({ safe: "x".repeat(1000) });
  assert.equal(summary.length, 503);
  assert.ok(summary.endsWith("..."));
});
