import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { AsyncImageBatchCoordinator } from "../src/api/services/async-image-batch-coordinator.ts";
import {
  ImageTaskLedger,
  adoptRecoverableAsyncReservations,
  buildImageTaskRequestHash,
  fingerprintToken,
  reserveIdempotentBatchForAsync,
} from "../src/api/services/image-task-ledger.ts";
import {
  ImageUploadStore,
  ImageUploadStoreError,
  expectedE002UploadKey,
} from "../src/api/services/image-upload-store.ts";

const common = {
  model: "jimeng-4.5",
  ratio: "1:1",
  resolution: "2k",
};

function sourceImages() {
  return [
    { sourceFileName: "01.png", fileSize: 4, mimeType: "image/png" },
    { sourceFileName: "02.webp", fileSize: 5, mimeType: "image/webp" },
  ];
}

function tasks(submissionId: string, attempt = 0, views = ["front", "side", "top", "back", "bottom"]) {
  return views.map((view, index) => ({
    taskId: String(index + 1).padStart(2, "0"),
    view,
    sourceSubmissionId: submissionId,
    retryAttempt: attempt,
    idempotencyKey: `E002:v1:${submissionId}:${view}:attempt-${attempt}`,
    prompt: `generate ${view}`,
  }));
}

function fixture(t: test.TestContext, now?: () => Date) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jimeng-coordinator-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const ledger = new ImageTaskLedger({ storeDir: dir, now });
  const uploadStore = new ImageUploadStore({ storeDir: dir, now });
  return { dir, ledger, uploadStore };
}

async function prepare(input: {
  ledger: ImageTaskLedger;
  uploadStore: ImageUploadStore;
  submissionId: string;
  attempt?: number;
  views?: string[];
  token?: string;
}) {
  const token = input.token || "token-a";
  const attempt = input.attempt || 0;
  const batchKey = `E002:v1:${input.submissionId}:attempt-${attempt}`;
  const uploadKey = expectedE002UploadKey(input.submissionId);
  const taskList = tasks(input.submissionId, attempt, input.views);
  const reserved = await reserveIdempotentBatchForAsync({
    ledger: input.ledger,
    batchKey,
    tasks: taskList,
    common,
    sourceImages: sourceImages(),
    tokenFingerprint: fingerprintToken(token),
    uploadKey,
  });
  let sourceReads = 0;
  const accepted = await input.uploadStore.acceptSources({
    uploadKey,
    sourceSubmissionId: input.submissionId,
    sourceImages: sourceImages(),
    tokenFingerprint: fingerprintToken(token),
    readSource: async (index) => {
      sourceReads++;
      return Buffer.from(index === 0 ? "aaaa" : "bbbbb");
    },
  });
  return { token, batchKey, uploadKey, taskList, reserved, accepted, sourceReads };
}

test("后台 worker 上传并发不超过 2，上传 ready 后五任务并发 5 提交", async (t) => {
  const { ledger, uploadStore } = fixture(t);
  const prepared = await prepare({ ledger, uploadStore, submissionId: "SUB-five" });
  let uploadActive = 0;
  let uploadMax = 0;
  let submitActive = 0;
  let submitMax = 0;
  let submitCount = 0;
  const coordinator = new AsyncImageBatchCoordinator({ ledger, uploadStore, log: { info() {}, error() {} } });
  const started = coordinator.start({
    batchKey: prepared.batchKey,
    uploadKey: prepared.uploadKey,
    token: prepared.token,
    tokenFingerprint: fingerprintToken(prepared.token),
    common,
    reservations: prepared.reserved.reservations,
    cacheHit: prepared.accepted.cacheHit,
    uploadOne: async ({ imageIndex }) => {
      uploadActive++;
      uploadMax = Math.max(uploadMax, uploadActive);
      await new Promise((resolve) => setTimeout(resolve, 20));
      uploadActive--;
      return `tos-${imageIndex}`;
    },
    submitTask: async ({ task }) => {
      submitCount++;
      submitActive++;
      submitMax = Math.max(submitMax, submitActive);
      await new Promise((resolve) => setTimeout(resolve, 20));
      submitActive--;
      return { historyId: `history-${task.view}` };
    },
  });
  assert.equal(started.started, true);
  await started.promise;
  assert.equal(uploadMax, 2);
  assert.equal(submitMax, 5);
  assert.equal(submitCount, 5);
  assert.equal(uploadStore.get(prepared.uploadKey)?.status, "ready");
  const snapshot = coordinator.snapshot({
    batchKey: prepared.batchKey,
    uploadKey: prepared.uploadKey,
    taskKeys: prepared.taskList.map((task) => task.idempotencyKey),
  });
  assert.equal(snapshot.submittedCount, 5);
  assert.equal(snapshot.unknownCount, 0);
  assert.ok(snapshot.tasks.every((task) => task.status === "processing" && task.historyId));
});

test("同 batchKey singleflight，不重复上传或提交", async (t) => {
  const { ledger, uploadStore } = fixture(t);
  const prepared = await prepare({ ledger, uploadStore, submissionId: "SUB-singleflight", views: ["front"] });
  let uploads = 0;
  let submits = 0;
  const coordinator = new AsyncImageBatchCoordinator({ ledger, uploadStore, log: { info() {}, error() {} } });
  const input = {
    batchKey: prepared.batchKey,
    uploadKey: prepared.uploadKey,
    token: prepared.token,
    tokenFingerprint: fingerprintToken(prepared.token),
    common,
    reservations: prepared.reserved.reservations,
    cacheHit: false,
    uploadOne: async ({ imageIndex }: { imageIndex: number }) => {
      uploads++;
      await new Promise((resolve) => setTimeout(resolve, 10));
      return `tos-${imageIndex}`;
    },
    submitTask: async () => {
      submits++;
      return { historyId: "history-once" };
    },
  };
  const first = coordinator.start(input);
  const second = coordinator.start(input);
  assert.equal(first.started, true);
  assert.equal(second.started, false);
  assert.equal(first.promise, second.promise);
  await first.promise;
  assert.equal(uploads, 2);
  assert.equal(submits, 1);
});

test("attempt-1 复用同 uploadKey 的持久 TOS IDs，实现零 TOS 上传", async (t) => {
  const { ledger, uploadStore } = fixture(t);
  const initial = await prepare({ ledger, uploadStore, submissionId: "SUB-retry-cache", views: ["front"] });
  let uploads = 0;
  const coordinator = new AsyncImageBatchCoordinator({ ledger, uploadStore, log: { info() {}, error() {} } });
  const run = async (prepared: Awaited<ReturnType<typeof prepare>>) => coordinator.start({
    batchKey: prepared.batchKey,
    uploadKey: prepared.uploadKey,
    token: prepared.token,
    tokenFingerprint: fingerprintToken(prepared.token),
    common,
    reservations: prepared.reserved.reservations,
    cacheHit: prepared.accepted.cacheHit,
    uploadOne: async ({ imageIndex }) => {
      uploads++;
      return `tos-stable-${imageIndex}`;
    },
    submitTask: async ({ task }) => ({ historyId: `history-${task.retryAttempt}` }),
  }).promise;
  await run(initial);
  assert.equal(uploads, 2);

  const retry = await prepare({
    ledger,
    uploadStore,
    submissionId: "SUB-retry-cache",
    attempt: 1,
    views: ["front"],
  });
  assert.equal(retry.accepted.cacheHit, true);
  await run(retry);
  assert.equal(uploads, 2);
  assert.equal(ledger.get(retry.taskList[0].idempotencyKey)?.historyId, "history-1");
});

test("初次上传完成 16 分钟后仍在 2h TTL 内，attempt-1 跳过旧上传 deadline", async (t) => {
  let nowMs = Date.parse("2026-08-12T00:00:00.000Z");
  const now = () => new Date(nowMs);
  const { ledger, uploadStore } = fixture(t, now);
  const initial = await prepare({ ledger, uploadStore, submissionId: "SUB-cache-after-deadline", views: ["front"] });
  let uploads = 0;
  const coordinator = new AsyncImageBatchCoordinator({ ledger, uploadStore, log: { info() {}, error() {} } });
  const execute = (prepared: Awaited<ReturnType<typeof prepare>>) => coordinator.start({
    batchKey: prepared.batchKey, uploadKey: prepared.uploadKey, token: prepared.token,
    tokenFingerprint: fingerprintToken(prepared.token), common,
    reservations: prepared.reserved.reservations, cacheHit: prepared.accepted.cacheHit,
    uploadOne: async ({ imageIndex }) => { uploads++; return `tos-${imageIndex}`; },
    submitTask: async ({ task }) => ({ historyId: `history-${task.retryAttempt}` }),
  }).promise;
  await execute(initial);
  assert.equal(uploads, 2);
  nowMs += 16 * 60 * 1000;
  const retry = await prepare({
    ledger, uploadStore, submissionId: "SUB-cache-after-deadline", attempt: 1, views: ["front"],
  });
  assert.equal(retry.accepted.cacheHit, true);
  await execute(retry);
  assert.equal(uploads, 2);
  assert.equal(ledger.get(retry.taskList[0].idempotencyKey)?.historyId, "history-1");
});

test("上传明确失败时不调用生成，并释放且回读确认 reservation", async (t) => {
  const { ledger, uploadStore } = fixture(t);
  const prepared = await prepare({ ledger, uploadStore, submissionId: "SUB-upload-fail", views: ["front"] });
  let submits = 0;
  const coordinator = new AsyncImageBatchCoordinator({ ledger, uploadStore, log: { info() {}, error() {} } });
  const job = coordinator.start({
    batchKey: prepared.batchKey,
    uploadKey: prepared.uploadKey,
    token: prepared.token,
    tokenFingerprint: fingerprintToken(prepared.token),
    common,
    reservations: prepared.reserved.reservations,
    cacheHit: false,
    uploadOne: async () => {
      throw Object.assign(new Error("图片上传失败: HTTP 400"), { status: 400 });
    },
    submitTask: async () => {
      submits++;
      return { historyId: "must-not-submit" };
    },
  });
  await assert.rejects(job.promise, /400/);
  assert.equal(submits, 0);
  assert.equal(ledger.get(prepared.taskList[0].idempotencyKey), undefined);
  assert.equal(uploadStore.get(prepared.uploadKey)?.status, "failed_pre_submit");
});

test("总墙钟 deadline 中止在途上传，绝不提交生成", async (t) => {
  let nowMs = Date.parse("2026-08-12T00:00:00.000Z");
  const now = () => new Date(nowMs);
  const { ledger, uploadStore } = fixture(t, now);
  const prepared = await prepare({ ledger, uploadStore, submissionId: "SUB-deadline-worker", views: ["front"] });
  let submits = 0;
  const coordinator = new AsyncImageBatchCoordinator({ ledger, uploadStore, log: { info() {}, error() {} } });
  const job = coordinator.start({
    batchKey: prepared.batchKey,
    uploadKey: prepared.uploadKey,
    token: prepared.token,
    tokenFingerprint: fingerprintToken(prepared.token),
    common,
    reservations: prepared.reserved.reservations,
    cacheHit: false,
    uploadOne: async () => {
      nowMs += 15 * 60 * 1000 + 1;
      throw new ImageUploadStoreError("upload_deadline_exceeded", "deadline");
    },
    submitTask: async () => {
      submits++;
      return { historyId: "must-not-submit" };
    },
  });
  await assert.rejects(job.promise, /deadline/i);
  assert.equal(submits, 0);
  assert.equal(ledger.get(prepared.taskList[0].idempotencyKey), undefined);
  assert.equal(uploadStore.get(prepared.uploadKey)?.failureCode, "upload_deadline_exceeded");
});

test("重启后 uploading 回收为 received，恢复 worker 只补传未确认图片", async (t) => {
  const { dir, ledger, uploadStore } = fixture(t);
  const prepared = await prepare({ ledger, uploadStore, submissionId: "SUB-recovery", views: ["front"] });
  await uploadStore.markUploadStarted(prepared.uploadKey, 0);
  await uploadStore.markImageUploaded(prepared.uploadKey, 0, "tos-first-persisted");
  await uploadStore.markUploadStarted(prepared.uploadKey, 1);
  await ledger.setReservedAsyncPhase(
    prepared.taskList[0].idempotencyKey,
    prepared.reserved.reservations[0].requestHash,
    "uploading"
  );

  const restartedLedger = new ImageTaskLedger({ storeDir: dir });
  const restartedUploadStore = new ImageUploadStore({ storeDir: dir });
  assert.equal(restartedLedger.get(prepared.taskList[0].idempotencyKey)?.status, "reserved");
  assert.equal(restartedUploadStore.get(prepared.uploadKey)?.images[1].status, "received");
  let uploads = 0;
  const coordinator = new AsyncImageBatchCoordinator({
    ledger: restartedLedger,
    uploadStore: restartedUploadStore,
    log: { info() {}, error() {} },
  });
  const replay = await reserveIdempotentBatchForAsync({
    ledger: restartedLedger,
    batchKey: prepared.batchKey,
    tasks: prepared.taskList,
    common,
    sourceImages: sourceImages(),
    tokenFingerprint: fingerprintToken(prepared.token),
    uploadKey: prepared.uploadKey,
  });
  assert.equal(replay.reservations[0].created, false);
  const reservations = adoptRecoverableAsyncReservations(restartedLedger, replay.reservations);
  assert.equal(reservations[0].needsSubmission, true);
  assert.equal(reservations[0].releaseOnPreSubmit, true);
  const job = coordinator.start({
    batchKey: prepared.batchKey,
    uploadKey: prepared.uploadKey,
    token: prepared.token,
    tokenFingerprint: fingerprintToken(prepared.token),
    common,
    reservations,
    cacheHit: false,
    uploadOne: async ({ imageIndex }) => {
      uploads++;
      return `tos-recovered-${imageIndex}`;
    },
    submitTask: async () => ({ historyId: "history-recovered" }),
  });
  await job.promise;
  assert.equal(uploads, 1);
  assert.equal(
    restartedUploadStore.get(prepared.uploadKey)?.images[0].uploadedImageId,
    "tos-first-persisted"
  );
  assert.equal(
    restartedLedger.get(prepared.taskList[0].idempotencyKey)?.historyId,
    "history-recovered"
  );
});

test("重启认领的 safe reservation 上传失败后会释放且回读清零", async (t) => {
  const { dir, ledger, uploadStore } = fixture(t);
  const prepared = await prepare({ ledger, uploadStore, submissionId: "SUB-recovery-fail", views: ["front"] });
  await ledger.setReservedAsyncPhase(
    prepared.taskList[0].idempotencyKey,
    prepared.reserved.reservations[0].requestHash,
    "uploading"
  );
  const restartedLedger = new ImageTaskLedger({ storeDir: dir });
  const restartedStore = new ImageUploadStore({ storeDir: dir });
  const replay = await reserveIdempotentBatchForAsync({
    ledger: restartedLedger,
    batchKey: prepared.batchKey,
    tasks: prepared.taskList,
    common,
    sourceImages: sourceImages(),
    tokenFingerprint: fingerprintToken(prepared.token),
    uploadKey: prepared.uploadKey,
  });
  const reservations = adoptRecoverableAsyncReservations(restartedLedger, replay.reservations);
  const coordinator = new AsyncImageBatchCoordinator({ ledger: restartedLedger, uploadStore: restartedStore, log: { info() {}, error() {} } });
  const job = coordinator.start({
    batchKey: prepared.batchKey,
    uploadKey: prepared.uploadKey,
    token: prepared.token,
    tokenFingerprint: fingerprintToken(prepared.token),
    common,
    reservations,
    cacheHit: false,
    uploadOne: async () => { throw Object.assign(new Error("HTTP 400"), { status: 400 }); },
    submitTask: async () => ({ historyId: "must-not-submit" }),
  });
  await assert.rejects(job.promise, /400/);
  assert.equal(restartedLedger.get(prepared.taskList[0].idempotencyKey), undefined);
  assert.equal(new ImageTaskLedger({ storeDir: dir }).get(prepared.taskList[0].idempotencyKey), undefined);
});

test("任一图片最终失败会中止 sibling 并等待全部 settle 后再置失败", async (t) => {
  const { ledger, uploadStore } = fixture(t);
  const prepared = await prepare({ ledger, uploadStore, submissionId: "SUB-sibling-abort", views: ["front"] });
  let siblingAborted = false;
  let siblingSettled = false;
  const coordinator = new AsyncImageBatchCoordinator({ ledger, uploadStore, log: { info() {}, error() {} } });
  const job = coordinator.start({
    batchKey: prepared.batchKey,
    uploadKey: prepared.uploadKey,
    token: prepared.token,
    tokenFingerprint: fingerprintToken(prepared.token),
    common,
    reservations: prepared.reserved.reservations,
    cacheHit: false,
    uploadOne: async ({ imageIndex, signal }) => {
      if (imageIndex === 1) throw Object.assign(new Error("HTTP 400"), { status: 400 });
      try {
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(resolve, 5_000);
          signal.addEventListener("abort", () => {
            clearTimeout(timer);
            siblingAborted = true;
            reject(signal.reason);
          }, { once: true });
        });
        return "late-id";
      } finally {
        siblingSettled = true;
      }
    },
    submitTask: async () => ({ historyId: "must-not-submit" }),
  });
  await assert.rejects(job.promise, /400/);
  assert.equal(siblingAborted, true);
  assert.equal(siblingSettled, true);
  assert.equal(uploadStore.get(prepared.uploadKey)?.status, "failed_pre_submit");
});

test("混合复用任务与新任务上传失败时只清除新 safe reservations", async (t) => {
  const { ledger, uploadStore } = fixture(t);
  const submissionId = "SUB-mixed-release";
  const allTasks = tasks(submissionId);
  const uploadKey = expectedE002UploadKey(submissionId);
  const token = "token-a";
  const first = await reserveIdempotentBatchForAsync({
    ledger,
    batchKey: `E002:v1:${submissionId}:attempt-0`,
    tasks: allTasks.slice(0, 2),
    common,
    sourceImages: sourceImages(),
    tokenFingerprint: fingerprintToken(token),
    uploadKey,
  });
  for (const reservation of first.reservations) {
    await ledger.submitReserved(reservation.record.idempotencyKey, reservation.requestHash, async () => ({
      historyId: `history-${reservation.task.view}`,
    }));
  }
  const mixed = await reserveIdempotentBatchForAsync({
    ledger,
    batchKey: `E002:v1:${submissionId}:attempt-0`,
    tasks: allTasks,
    common,
    sourceImages: sourceImages(),
    tokenFingerprint: fingerprintToken(token),
    uploadKey,
  });
  await uploadStore.acceptSources({
    uploadKey,
    sourceSubmissionId: submissionId,
    sourceImages: sourceImages(),
    tokenFingerprint: fingerprintToken(token),
    readSource: async (index) => Buffer.from(index === 0 ? "aaaa" : "bbbbb"),
  });
  const coordinator = new AsyncImageBatchCoordinator({ ledger, uploadStore, log: { info() {}, error() {} } });
  const job = coordinator.start({
    batchKey: `E002:v1:${submissionId}:attempt-0`, uploadKey, token,
    tokenFingerprint: fingerprintToken(token), common,
    reservations: adoptRecoverableAsyncReservations(ledger, mixed.reservations), cacheHit: false,
    uploadOne: async () => { throw Object.assign(new Error("HTTP 400"), { status: 400 }); },
    submitTask: async () => ({ historyId: "must-not-submit" }),
  });
  await assert.rejects(job.promise, /400/);
  assert.equal(ledger.get(allTasks[0].idempotencyKey)?.historyId, "history-front");
  assert.equal(ledger.get(allTasks[1].idempotencyKey)?.historyId, "history-side");
  for (const task of allTasks.slice(2)) assert.equal(ledger.get(task.idempotencyKey), undefined);
});

test("生成 preflight 较慢时等待原调用完成，不会先标 unknown 后再晚到付费提交", async (t) => {
  const { ledger, uploadStore } = fixture(t);
  const prepared = await prepare({ ledger, uploadStore, submissionId: "SUB-submit-timeout", views: ["front"] });
  let submits = 0;
  const coordinator = new AsyncImageBatchCoordinator({ ledger, uploadStore, log: { info() {}, error() {} } });
  let finishPreflight!: () => void;
  const preflight = new Promise<void>((resolve) => { finishPreflight = resolve; });
  let paidPostCount = 0;
  const job = coordinator.start({
    batchKey: prepared.batchKey, uploadKey: prepared.uploadKey, token: prepared.token,
    tokenFingerprint: fingerprintToken(prepared.token), common,
    reservations: prepared.reserved.reservations, cacheHit: false,
    uploadOne: async ({ imageIndex }) => `tos-${imageIndex}`,
    submitTask: async ({ onBeforeRemoteSubmit }) => {
      submits++;
      await preflight;
      await onBeforeRemoteSubmit();
      paidPostCount++;
      return { historyId: "history-after-preflight" };
    },
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(ledger.get(prepared.taskList[0].idempotencyKey)?.status, "reserved");
  assert.equal(ledger.get(prepared.taskList[0].idempotencyKey)?.context.asyncPhase, "ready");
  assert.equal(paidPostCount, 0);
  finishPreflight();
  await job.promise;
  assert.equal(ledger.get(prepared.taskList[0].idempotencyKey)?.status, "processing");
  assert.equal(uploadStore.get(prepared.uploadKey)?.status, "ready");
  const replay = await reserveIdempotentBatchForAsync({
    ledger, batchKey: prepared.batchKey, tasks: prepared.taskList, common,
    sourceImages: sourceImages(), tokenFingerprint: fingerprintToken(prepared.token), uploadKey: prepared.uploadKey,
  });
  assert.equal(adoptRecoverableAsyncReservations(ledger, replay.reservations)[0].needsSubmission, false);
  assert.equal(submits, 1);
  assert.equal(paidPostCount, 1);
});

test("attempt-1 cacheHit 与零上传耗时持久到 schema2 context 并跨重启保留", async (t) => {
  const { dir, ledger, uploadStore } = fixture(t);
  const initial = await prepare({ ledger, uploadStore, submissionId: "SUB-metrics", views: ["front"] });
  const coordinator = new AsyncImageBatchCoordinator({ ledger, uploadStore, log: { info() {}, error() {} } });
  const run = (prepared: Awaited<ReturnType<typeof prepare>>) => coordinator.start({
    batchKey: prepared.batchKey, uploadKey: prepared.uploadKey, token: prepared.token,
    tokenFingerprint: fingerprintToken(prepared.token), common,
    reservations: prepared.reserved.reservations, cacheHit: prepared.accepted.cacheHit,
    uploadOne: async ({ imageIndex }) => `tos-${imageIndex}`,
    submitTask: async ({ task }) => ({ historyId: `history-${task.retryAttempt}` }),
  }).promise;
  await run(initial);
  const retry = await prepare({ ledger, uploadStore, submissionId: "SUB-metrics", attempt: 1, views: ["front"] });
  await run(retry);
  const restarted = new ImageTaskLedger({ storeDir: dir });
  const context = restarted.get(retry.taskList[0].idempotencyKey)?.context;
  assert.equal(context?.asyncBatchCacheHit, true);
  assert.equal(context?.asyncBatchUploadDurationMs, 0);
});

test("同 batchKey 的任务集合不同时拒绝静默加入 active worker", async (t) => {
  const { ledger, uploadStore } = fixture(t);
  const first = await prepare({ ledger, uploadStore, submissionId: "SUB-batch-conflict", views: ["front"] });
  const coordinator = new AsyncImageBatchCoordinator({ ledger, uploadStore, log: { info() {}, error() {} } });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const base = {
    batchKey: first.batchKey, uploadKey: first.uploadKey, token: first.token,
    tokenFingerprint: fingerprintToken(first.token), common, cacheHit: false,
    uploadOne: async ({ imageIndex }: { imageIndex: number }) => { await gate; return `tos-${imageIndex}`; },
    submitTask: async () => ({ historyId: "history" }),
  };
  const running = coordinator.start({ ...base, reservations: first.reserved.reservations });
  const conflictingTask = tasks("SUB-batch-conflict", 0, ["side"])[0];
  const conflictReservation = {
    ...first.reserved.reservations[0],
    requestHash: buildImageTaskRequestHash({ task: conflictingTask, common, sourceImages: sourceImages() }),
    task: conflictingTask,
    record: { ...first.reserved.reservations[0].record, idempotencyKey: conflictingTask.idempotencyKey },
  };
  assert.throws(
    () => coordinator.start({ ...base, reservations: [conflictReservation] }),
    (error: unknown) => error instanceof ImageUploadStoreError && error.code === "batch_conflict"
  );
  release();
  await running.promise;
});

test("生成提交边界前失败保持 ready，边界后失败标记 submission_unknown", async (t) => {
  const { ledger, uploadStore } = fixture(t);
  const before = await prepare({ ledger, uploadStore, submissionId: "SUB-boundary-before", views: ["front"] });
  const coordinator = new AsyncImageBatchCoordinator({ ledger, uploadStore, log: { info() {}, error() {} } });
  const preflightFailure = coordinator.start({
    batchKey: before.batchKey, uploadKey: before.uploadKey, token: before.token,
    tokenFingerprint: fingerprintToken(before.token), common,
    reservations: before.reserved.reservations, cacheHit: false,
    uploadOne: async ({ imageIndex }) => `tos-${imageIndex}`,
    submitTask: async () => { throw new Error("credit preflight unavailable"); },
  });
  await assert.rejects(preflightFailure.promise, /preflight/);
  assert.equal(ledger.get(before.taskList[0].idempotencyKey)?.status, "reserved");
  assert.equal(ledger.get(before.taskList[0].idempotencyKey)?.context.asyncPhase, "ready");

  const after = await prepare({ ledger, uploadStore, submissionId: "SUB-boundary-after", views: ["front"] });
  const postFailure = coordinator.start({
    batchKey: after.batchKey, uploadKey: after.uploadKey, token: after.token,
    tokenFingerprint: fingerprintToken(after.token), common,
    reservations: after.reserved.reservations, cacheHit: false,
    uploadOne: async ({ imageIndex }) => `tos-${imageIndex}`,
    submitTask: async ({ onBeforeRemoteSubmit }) => {
      await onBeforeRemoteSubmit();
      throw new Error("generate response lost");
    },
  });
  await postFailure.promise;
  assert.equal(ledger.get(after.taskList[0].idempotencyKey)?.status, "submission_unknown");
  assert.equal(ledger.get(after.taskList[0].idempotencyKey)?.context.asyncPhase, "submitting");
});
