import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  IMAGE_UPLOAD_BATCH_DEADLINE_MS,
  IMAGE_UPLOAD_REUSE_TTL_MS,
  ImageUploadStore,
  ImageUploadStoreError,
  buildImageUploadSourceMetadataHash,
  expectedE002UploadKey,
  validateE002UploadKey,
} from "../src/api/services/image-upload-store.ts";

function fixture(t: test.TestContext, startMs = Date.parse("2026-08-12T00:00:00.000Z")) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jimeng-upload-store-"));
  let nowMs = startMs;
  const now = () => new Date(nowMs);
  const store = new ImageUploadStore({ storeDir: dir, now });
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return {
    dir,
    store,
    now,
    advance(ms: number) {
      nowMs += ms;
    },
  };
}

function sourceImages() {
  return [
    { sourceFileName: "01 正面.png", fileSize: 4, mimeType: "image/png" },
    { sourceFileName: "02 侧面.webp", fileSize: 5, mimeType: "image/webp" },
  ];
}

function identity(submissionId = "SUB-upload-store") {
  return {
    sourceSubmissionId: submissionId,
    uploadKey: expectedE002UploadKey(submissionId),
    sourceImages: sourceImages(),
    tokenFingerprint: "token-fingerprint-only",
  };
}

test("uploadKey 必须严格绑定 sourceSubmissionId", () => {
  assert.equal(
    validateE002UploadKey(
      "E002:v1:SUB-1:source-images",
      "SUB-1"
    ),
    "E002:v1:SUB-1:source-images"
  );
  assert.throws(
    () => validateE002UploadKey("E002:v1:SUB-1:attempt-0", "SUB-1"),
    (error: unknown) => error instanceof ImageUploadStoreError && error.code === "invalid_upload_key"
  );
});

test("稳定源图指纹忽略对象键顺序但保留有序图片身份", () => {
  const first = buildImageUploadSourceMetadataHash(sourceImages());
  const aliases = buildImageUploadSourceMetadataHash([
    { mime: "IMAGE/PNG", bytes: 4, fileName: "01 正面.png", inputIndex: 0 },
    { contentType: "image/webp", fileName: "02 侧面.webp", bytes: 5, inputIndex: 1 },
  ]);
  assert.equal(first, aliases);
  assert.notEqual(first, buildImageUploadSourceMetadataHash([...sourceImages()].reverse()));
});

test("源图先原子落盘并记录 SHA256，台账不保存 URL 或明文 token", async (t) => {
  const { dir, store } = fixture(t);
  const sourceUrls = [
    "https://signed.invalid/a?token=secret-one",
    "https://signed.invalid/b?token=secret-two",
  ];
  const bytes = [Buffer.from("aaaa"), Buffer.from("bbbbb")];
  const accepted = await store.acceptSources({
    ...identity(),
    readSource: async (index) => {
      assert.match(sourceUrls[index], /^https:/);
      return bytes[index];
    },
  });

  assert.equal(accepted.record.status, "queued");
  assert.equal(accepted.cacheHit, false);
  assert.deepEqual(store.getSourceBuffer(identity().uploadKey, 0), bytes[0]);
  assert.deepEqual(store.getSourceBuffer(identity().uploadKey, 1), bytes[1]);
  assert.match(accepted.record.images[0].contentHash, /^[a-f0-9]{64}$/);

  const persisted = fs.readFileSync(path.join(dir, "image-upload-store.json"), "utf8");
  assert.doesNotMatch(persisted, /signed\.invalid|secret-one|secret-two|Bearer/i);
  assert.doesNotMatch(persisted, /refresh[_-]?token/i);
  assert.match(persisted, /token-fingerprint-only/);
  assert.equal(fs.readdirSync(path.join(dir, "source-cache")).length, 1);
});

test("同 uploadKey 的并发接收只物化每张源图一次", async (t) => {
  const { store } = fixture(t);
  let reads = 0;
  const readSource = async (index: number) => {
    reads++;
    await new Promise((resolve) => setTimeout(resolve, 10));
    return Buffer.from(index === 0 ? "aaaa" : "bbbbb");
  };
  const [first, second] = await Promise.all([
    store.acceptSources({ ...identity("SUB-concurrent"), readSource }),
    store.acceptSources({ ...identity("SUB-concurrent"), readSource }),
  ]);
  assert.equal(reads, 2);
  assert.equal(first.record.status, "queued");
  assert.equal(second.record.status, "queued");
});

test("同 uploadKey 的源图或 token 指纹冲突时失败关闭", async (t) => {
  const { store } = fixture(t);
  const base = identity("SUB-conflict");
  await store.acceptSources({
    ...base,
    readSource: async (index) => Buffer.from(index === 0 ? "aaaa" : "bbbbb"),
  });

  await assert.rejects(
    store.acceptSources({
      ...base,
      tokenFingerprint: "different-fingerprint",
      readSource: async () => Buffer.from("never"),
    }),
    (error: unknown) =>
      error instanceof ImageUploadStoreError && error.code === "upload_idempotency_conflict"
  );
  await assert.rejects(
    store.acceptSources({
      ...base,
      sourceImages: [{ sourceFileName: "different.png", fileSize: 4 }],
      readSource: async () => Buffer.from("never"),
    }),
    (error: unknown) =>
      error instanceof ImageUploadStoreError && error.code === "upload_idempotency_conflict"
  );
});

test("逐图上传 ID 持久化，重启后只把未确认的 uploading 恢复为 received", async (t) => {
  const { dir, store, now } = fixture(t);
  const key = identity("SUB-restart").uploadKey;
  await store.acceptSources({
    ...identity("SUB-restart"),
    readSource: async (index) => Buffer.from(index === 0 ? "aaaa" : "bbbbb"),
  });
  await store.markUploadStarted(key, 0);
  await store.markImageUploaded(key, 0, "tos-uploaded-first");
  await store.markUploadStarted(key, 1);

  const restarted = new ImageUploadStore({ storeDir: dir, now });
  const record = restarted.get(key)!;
  assert.equal(record.status, "queued");
  assert.equal(record.images[0].status, "uploaded");
  assert.equal(record.images[0].uploadedImageId, "tos-uploaded-first");
  assert.equal(record.images[1].status, "received");
  assert.equal(record.images[1].uploadedImageId, "");
});

test("ready 上传集在两小时内供 attempt-1 复用且零源图重读", async (t) => {
  const { store, advance } = fixture(t);
  const data = identity("SUB-cache-hit");
  let reads = 0;
  await store.acceptSources({
    ...data,
    readSource: async (index) => {
      reads++;
      return Buffer.from(index === 0 ? "aaaa" : "bbbbb");
    },
  });
  for (const [index, id] of ["tos-a", "tos-b"].entries()) {
    await store.markUploadStarted(data.uploadKey, index);
    await store.markImageUploaded(data.uploadKey, index, id);
  }

  assert.deepEqual(store.getReusableUploadedIds(data), ["tos-a", "tos-b"]);
  const replay = await store.acceptSources({
    ...data,
    readSource: async () => {
      reads++;
      throw new Error("cache hit must not read source");
    },
  });
  assert.equal(replay.cacheHit, true);
  assert.equal(reads, 2);
  assert.equal(store.publicState(data.uploadKey, true).uploadDurationMs, 0);

  advance(IMAGE_UPLOAD_REUSE_TTL_MS + 1);
  assert.equal(store.getReusableUploadedIds(data), undefined);
  const expiredReplay = await store.acceptSources({
    ...data,
    readSource: async () => {
      reads++;
      throw new Error("verified local cache should be reused after ID expiry");
    },
  });
  assert.equal(expiredReplay.cacheHit, false);
  assert.equal(expiredReplay.record.status, "queued");
  assert.ok(expiredReplay.record.images.every((image) => image.status === "received"));
  assert.ok(expiredReplay.record.images.every((image) => image.uploadedImageId === ""));
  assert.equal(reads, 2);
});

test("过期 ready 上传集缺少源图缓存时明确 upload_cache_expired", async (t) => {
  const { dir, store, advance } = fixture(t);
  const data = identity("SUB-expired-missing");
  await store.acceptSources({
    ...data,
    readSource: async (index) => Buffer.from(index === 0 ? "aaaa" : "bbbbb"),
  });
  for (const [index, id] of ["tos-a", "tos-b"].entries()) {
    await store.markUploadStarted(data.uploadKey, index);
    await store.markImageUploaded(data.uploadKey, index, id);
  }
  advance(IMAGE_UPLOAD_REUSE_TTL_MS + 1);
  fs.rmSync(path.join(dir, "source-cache"), { recursive: true, force: true });
  await assert.rejects(
    store.acceptSources({
      ...data,
      readSource: async () => Buffer.from("must-not-download"),
    }),
    (error: unknown) =>
      error instanceof ImageUploadStoreError && error.code === "upload_cache_expired"
  );
});

test("cleanupExpired 只清理过期终态上传集并尊重活跃 worker", async (t) => {
  const { dir, store, advance } = fixture(t);
  const data = identity("SUB-cleanup");
  await store.acceptSources({
    ...data,
    readSource: async (index) => Buffer.from(index === 0 ? "aaaa" : "bbbbb"),
  });
  for (const [index, id] of ["tos-a", "tos-b"].entries()) {
    await store.markUploadStarted(data.uploadKey, index);
    await store.markImageUploaded(data.uploadKey, index, id);
  }
  advance(IMAGE_UPLOAD_REUSE_TTL_MS + 1);
  assert.deepEqual(store.cleanupExpired({ activeUploadKeys: [data.uploadKey] }).removedUploadKeys, []);
  assert.ok(store.get(data.uploadKey));
  const cleanup = store.cleanupExpired();
  assert.deepEqual(cleanup.removedUploadKeys, [data.uploadKey]);
  assert.equal(store.get(data.uploadKey), undefined);
  assert.equal(fs.existsSync(path.join(dir, "source-cache")), true);
  const persisted = JSON.parse(fs.readFileSync(path.join(dir, "image-upload-store.json"), "utf8"));
  assert.deepEqual(persisted.records, []);
});

test("15 分钟总墙钟在任何生成提交前终止并持久化 deadline 失败", async (t) => {
  const { store, advance } = fixture(t);
  const data = identity("SUB-deadline");
  await assert.rejects(
    store.acceptSources({
      ...data,
      readSource: async (index) => {
        if (index === 0) advance(IMAGE_UPLOAD_BATCH_DEADLINE_MS + 1);
        return Buffer.from(index === 0 ? "aaaa" : "bbbbb");
      },
    }),
    (error: unknown) =>
      error instanceof ImageUploadStoreError && error.code === "upload_deadline_exceeded"
  );
  const record = store.get(data.uploadKey)!;
  assert.equal(record.status, "failed_pre_submit");
  assert.equal(record.failureCode, "upload_deadline_exceeded");
  assert.equal(store.publicState(data.uploadKey).nextPollAfterSeconds, 0);
});

test("服务重启时已越过 deadline 的非终态上传集自动失败关闭", async (t) => {
  const { dir, store, now, advance } = fixture(t);
  const data = identity("SUB-deadline-restart");
  await store.acceptSources({
    ...data,
    readSource: async (index) => Buffer.from(index === 0 ? "aaaa" : "bbbbb"),
  });
  advance(IMAGE_UPLOAD_BATCH_DEADLINE_MS + 1);
  const restarted = new ImageUploadStore({ storeDir: dir, now });
  const record = restarted.get(data.uploadKey)!;
  assert.equal(record.status, "failed_pre_submit");
  assert.equal(record.failureCode, "upload_deadline_exceeded");
});

test("上传台账损坏时保留副本并拒绝以空库启动", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jimeng-upload-corrupt-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "image-upload-store.json"), "{broken", "utf8");
  assert.throws(
    () => new ImageUploadStore({ storeDir: dir }),
    (error: unknown) => error instanceof ImageUploadStoreError && error.code === "store_corrupt"
  );
  const backups = fs.readdirSync(dir).filter((name) => name.includes(".corrupt-"));
  assert.equal(backups.length, 1);
  assert.equal(fs.readFileSync(path.join(dir, backups[0]), "utf8"), "{broken");
});

test("公开状态提供稳定 wire contract 且不暴露 TOS 图片 ID", async (t) => {
  const { store } = fixture(t);
  const data = identity("SUB-public-state");
  await store.acceptSources({
    ...data,
    readSource: async (index) => Buffer.from(index === 0 ? "aaaa" : "bbbbb"),
  });
  await store.markUploadStarted(data.uploadKey, 0);
  await store.recordRetry(data.uploadKey, 0, { stage: "tos_binary_upload", errorCode: "504" });
  const state = store.publicState(data.uploadKey);
  assert.deepEqual(state.uploadProgress, { total: 2, completed: 0, retryCount: 1 });
  assert.equal(state.uploadKey, data.uploadKey);
  assert.equal(state.batchStatus, "uploading");
  assert.equal(state.nextPollAfterSeconds, 5);
  assert.equal(state.cacheHit, false);
  assert.doesNotMatch(JSON.stringify(state), /uploadedImageId|tos-/);
});
